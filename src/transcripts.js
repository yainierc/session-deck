/**
 * transcripts.js — reading the conversations.
 *
 * Every session writes a .jsonl under ~/.claude/projects/<encoded-cwd>/.
 * That directory name is NOT encoded the same way on Windows and Mac, so we
 * treat it as an opaque id here: the file is named <sessionId>.jsonl and the
 * real cwd comes from inside the lines themselves. Nothing depends on the OS.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { projectsDir } from './platform.js'
import { resolveProjectRoot } from './projects.js'
import { eventsFromLine } from './activity.js'
import { PROGRESS_TOOL } from './progress.js'

/** Lines that are internal control noise, not part of the conversation. */
const NOISE = new Set([
  'last-prompt', 'mode', 'permission-mode', 'atis-latch',
  'file-history-snapshot', 'ai-title', 'attachment',
])

/** Build an index of sessionId -> transcript path. */
export function indexTranscripts() {
  const root = projectsDir()
  const index = new Map()
  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return index
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const dirPath = path.join(root, dir.name)
    let files = []
    try { files = fs.readdirSync(dirPath) } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const sessionId = file.slice(0, -'.jsonl'.length)
      const full = path.join(dirPath, file)
      let mtime = 0
      try { mtime = fs.statSync(full).mtimeMs } catch {}
      const prev = index.get(sessionId)
      if (!prev || mtime > prev.mtime) index.set(sessionId, { file: full, mtime })
    }
  }
  return index
}

export function findTranscript(sessionId, index = indexTranscripts()) {
  return index.get(sessionId)?.file || null
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * Tags Claude Code injects as if they were your messages: command output,
 * internal reminders, task notifications. You did not write them, so they
 * are not part of "the last thing we talked about".
 */
const INTERNAL_TAG = /^<(command-message|command-name|command-args|local-command-caveat|local-command-stdout|local-command-stderr|task-notification|system-reminder|user-prompt-submit-hook)>/

function cleanUserText(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

/**
 * An attached text file, as buildContent wrote it into the message.
 *
 * The panel is for reading the conversation, and a spec you attached is not
 * conversation: printed in full it buries the sentence you wrote under it.
 * The name is what you need to see — the content is already where it matters,
 * in front of Claude.
 */
const ATTACHED_FILE = /<attached-file name="([^"]*)">[\s\S]*?<\/attached-file>/g

function stripAttachedFiles(text) {
  const names = []
  const rest = text.replace(ATTACHED_FILE, (_match, name) => {
    names.push(name)
    return ''
  })
  return { names, text: rest.trim() }
}

function imageCount(content) {
  if (!Array.isArray(content)) return 0
  return content.filter((b) => b && b.type === 'image').length
}

/**
 * The tool a message is a call to, for the "working ..." line — skipping the
 * one the panel draws itself.
 *
 * A session ticking off its progress list is not doing a piece of work worth
 * naming; the list it just wrote is already on screen, and announcing
 * "working mcp__panel__progress" above it would be the panel reporting its
 * own plumbing back to you.
 *
 * Skipped rather than stopping at the first block, because tools are called
 * in parallel: a turn that ticks a box and starts a build in the same message
 * must still say it is building.
 */
function firstToolName(content) {
  if (!Array.isArray(content)) return null
  const call = content.find((b) => b && b.type === 'tool_use' && b.name !== PROGRESS_TOOL)
  return call?.name || null
}

/**
 * Turn a raw line into something useful, or null.
 *
 * It deliberately returns two different things:
 *   - a conversation message (what you read in the panel)
 *   - an '_activity' marker when the line is only a tool call. That is not
 *     conversation — you do not want to read the `git status` it ran — but it
 *     does tell you what it is busy with right now.
 */
export function normalizeLine(raw) {
  if (!raw || NOISE.has(raw.type)) return null

  if (raw.type === 'user' || raw.type === 'assistant') {
    const message = raw.message || {}
    let text = textOf(message.content)

    if (raw.type === 'user') {
      // promptSource marks what was genuinely typed, but older sessions do
      // not carry it, so the real filter is the internal tags.
      if (raw.promptSource === 'system') return null
      text = cleanUserText(text)
      if (INTERNAL_TAG.test(text)) return null
      /*
       * An attached image carries no text of its own, so without this the
       * whole message falls through to the activity branch below and vanishes
       * from the panel — you would see Claude answer a question you never
       * appear to have asked.
       */
      const images = imageCount(message.content)
      if (images) {
        const label = images === 1 ? '[image]' : `[${images} images]`
        text = text ? `${label} ${text}` : label
      }
      /*
       * Same reason as the image label, and the same failure without it: a
       * message that was only an attached file would come back empty and be
       * filed as activity, so the panel would show an answer to a question
       * you never appear to have asked.
       */
      const attached = stripAttachedFiles(text)
      if (attached.names.length) {
        const label = attached.names.map((name) => `[${name}]`).join(' ')
        text = attached.text ? `${label} ${attached.text}` : label
      }
    }

    if (!text) {
      const tool = firstToolName(message.content)
      return tool ? { role: '_activity', tool, timestamp: raw.timestamp || null } : null
    }

    return {
      uuid: raw.uuid,
      role: raw.type,
      text,
      timestamp: raw.timestamp || null,
      cwd: raw.cwd || null,
      gitBranch: raw.gitBranch || null,
      isSidechain: Boolean(raw.isSidechain),
    }
  }

  if (raw.type === 'system' && raw.content) {
    return {
      uuid: raw.uuid,
      role: 'system',
      text: String(raw.content).slice(0, 2000),
      timestamp: raw.timestamp || null,
    }
  }
  return null
}

/**
 * Split the activity markers from the real messages.
 *
 * It also pulls out file events on the same pass. They are a different view
 * of the same lines — what it touched, rather than what it said — and reading
 * a multi-megabyte file twice to answer two questions would be silly.
 */
function collect(rawLines) {
  const messages = []
  const events = []
  const failed = []
  /*
   * undefined and null are different answers, and the difference is the whole
   * point of this variable:
   *
   *   undefined — these lines said nothing about what the session is doing
   *   null      — it stopped working and spoke
   *
   * The live path reads batches of a few lines at a time, so most of them say
   * nothing. Collapsing the two made the panel choose between blinking the
   * indicator off between file events and never clearing it at all — and it
   * chose never, which is why a session that had finished long ago went on
   * showing "working Bash" forever.
   */
  let activity

  /*
   * How the session was actually thinking, as opposed to what it was asked to.
   *
   * The startup message a session sends carries neither of these, so the panel
   * had no way to show the effort it was really running at — the chip could
   * set it and never confirm it — and no way at all to show whether an advisor
   * was attached. A pairing the API refuses is refused silently: the request
   * is simply not applied, and a session with no advisor is indistinguishable
   * from one that has a good one.
   *
   * Every assistant line carries both, so the file knows. Read from the newest
   * one and not merged across the batch: absent means off, so remembering the
   * last value that was set would report an advisor that has since gone away.
   *
   * `undefined` here has the same meaning it has for `activity` above: these
   * lines said nothing, so the panel keeps what it had.
   */
  let granted

  for (const line of rawLines) {
    if (!line.trim().startsWith('{')) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }

    if (parsed.type === 'assistant') {
      granted = {
        effort: typeof parsed.effort === 'string' ? parsed.effort : null,
        advisor: typeof parsed.advisorModel === 'string' ? parsed.advisorModel : null,
      }
    }

    const found = eventsFromLine(parsed)
    for (const event of found.events) events.push(event)
    for (const id of found.failed) failed.push(id)

    const item = normalizeLine(parsed)
    if (!item) continue
    if (item.role === '_activity') {
      activity = item.tool
      continue
    }
    // Anything that speaks replaces the activity: it finished working.
    activity = null
    messages.push(item)
  }

  return { messages, activity, granted, events, failed }
}

/** Read a whole transcript and return the last `limit` messages. */
export function readTranscript(file, { limit = 60, eventLimit = 400 } = {}) {
  let content = ''
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch {
    return { messages: [], size: 0, meta: {}, activity: null, granted: null, events: [] }
  }

  const lines = content.split('\n')
  const { messages, activity, granted, events, failed } = collect(lines)

  /*
   * The map is about shape and rhythm, not a complete audit: a long session
   * touches the same handful of files hundreds of times, and sending all of
   * it would cost more than it tells you.
   *
   * File events and commands are budgeted separately on purpose. A session
   * that runs a test suite in a loop produces far more commands than file
   * touches, and a single shared cap would let those commands push the file
   * history — the thing the map is actually about — out of the window. Only
   * the latest command is ever shown, so a handful is plenty.
   *
   * Failures are matched across the whole scan first, so a kept event never
   * loses the error that followed it.
   */
  const failures = new Set(failed)
  const fileEvents = events.filter((event) => event.path).slice(-eventLimit)
  const runEvents = events.filter((event) => !event.path).slice(-10)
  const recentEvents = [...fileEvents, ...runEvents].sort(
    (a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0),
  )
  for (const event of recentEvents) {
    if (failures.has(event.id)) event.failed = true
  }

  const meta = {}
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue
    try {
      const raw = JSON.parse(line)
      if (raw.cwd) meta.cwd = raw.cwd
      if (raw.gitBranch) meta.gitBranch = raw.gitBranch
      if (raw.version) meta.version = raw.version
    } catch {}
  }

  return {
    messages: messages.slice(-limit),
    total: messages.length,
    size: Buffer.byteLength(content),
    // A whole-file read always knows the answer: there is no "these lines did
    // not say" when the lines are all of them.
    activity: activity ?? null,
    // Same reasoning: a whole-file read has seen every turn there is, so "no
    // assistant line said anything" really is "this session has not spoken".
    granted: granted ?? null,
    events: recentEvents,
    eventsTruncated: events.filter((event) => event.path).length > fileEvents.length,
    meta,
  }
}

/**
 * Follow a transcript live. Remembers the byte offset and reads only what is
 * new, so we never re-read megabytes every time the session writes a line.
 */
export function tailTranscript(file, { fromSize = 0, intervalMs = 700 } = {}) {
  const emitter = new EventEmitter()
  let offset = fromSize
  let stopped = false
  let reading = false

  async function check() {
    if (stopped || reading) return
    let size
    try { size = fs.statSync(file).size } catch { return }

    // The file shrank: it was truncated or rotated. Start over.
    if (size < offset) {
      offset = 0
      emitter.emit('reset')
    }
    if (size === offset) return

    reading = true
    try {
      const stream = fs.createReadStream(file, { start: offset, end: size - 1, encoding: 'utf8' })
      let buffer = ''
      for await (const chunk of stream) buffer += chunk

      // The last line may be half-written, so we leave it for the next pass
      // instead of discarding it.
      const lines = buffer.split('\n')
      const tail = lines.pop() ?? ''
      offset = size - Buffer.byteLength(tail)

      const { messages, activity, granted, events, failed } = collect(lines)
      if (messages.length || activity !== undefined || granted !== undefined || events.length || failed.length) {
        emitter.emit('update', { messages, activity, granted, events, failed })
      }
    } catch {
      // Ignore and retry on the next tick.
    } finally {
      reading = false
    }
  }

  const timer = setInterval(check, intervalMs)
  emitter.stop = () => { stopped = true; clearInterval(timer) }
  return emitter
}

/**
 * The first `length` bytes of a file, or null if it cannot be read.
 *
 * Transcripts run to tens of megabytes and almost everything worth knowing
 * about a session is written near the top, so nothing here ever reads a whole
 * one. Returns a string that very likely ends mid-line: every caller parses
 * line by line and tolerates the last one being truncated.
 */
function readHead(file, length) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const want = Math.min(length, size)
    const buf = Buffer.alloc(want)
    fs.readSync(fd, buf, 0, want, 0)
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
  }
}

/** The last `length` bytes, with the truncated first line dropped. */
function readTail(file, length) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    if (size <= length) return null // the head already covers it
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, size - length)
    const text = buf.toString('utf8')
    // Starting mid-line is expected; that fragment is not JSON and would only
    // be thrown away by the parser anyway.
    return text.slice(text.indexOf('\n') + 1)
  } catch {
    return null
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
  }
}

/**
 * Recent projects, for the launcher's picker.
 *
 * The directory name is an encoded cwd we deliberately never parse, so we
 * read the real path from inside the newest transcript instead. Only the
 * head of the file is read: some transcripts are tens of megabytes and the
 * cwd appears on the first conversation line.
 */
export function recentProjects({ limit = 40, headBytes = 65536 } = {}) {
  const index = indexTranscripts()

  // Newest transcript per project directory.
  const byDir = new Map()
  for (const { file, mtime } of index.values()) {
    const dir = path.dirname(file)
    const prev = byDir.get(dir)
    if (!prev || mtime > prev.mtime) byDir.set(dir, { file, mtime })
  }

  const seen = new Map()
  for (const { file, mtime } of byDir.values()) {
    const head = readHead(file, headBytes)
    if (head === null) continue

    let cwd = null
    for (const line of head.split('\n')) {
      if (!line.trim().startsWith('{')) continue
      try {
        const raw = JSON.parse(line)
        if (raw.cwd) { cwd = raw.cwd; break }
      } catch {
        // A truncated last line is expected: we only read the head.
      }
    }
    if (!cwd) continue
    // Two project directories can point at the same cwd (a worktree and its
    // repo, or a path reused after a rename). Keep the most recent one.
    const prev = seen.get(cwd)
    if (!prev || mtime > prev.lastUsed) {
      seen.set(cwd, { path: cwd, name: path.basename(cwd), lastUsed: mtime })
    }
  }

  const out = [...seen.values()]
  out.sort((a, b) => b.lastUsed - a.lastUsed)
  return out.slice(0, limit)
}

/*
 * What a transcript says about itself, keyed by file and mtime.
 *
 * A finished transcript never changes, so reading one twice is wasted work;
 * one still being written grows, and the mtime in the key is what retires the
 * stale entry instead of serving it.
 */
const metaCache = new Map()
const META_HEAD = 65536
const META_TAIL = 16384

/** The first line of a string, trimmed and capped, for use as a label. */
function oneLine(text, max = 90) {
  const line = String(text || '').trim().split('\n')[0].trim()
  if (!line) return null
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line
}

function scanMeta(text, meta) {
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }
    if (!meta.cwd && raw.cwd) meta.cwd = raw.cwd
    if (!meta.branch && raw.gitBranch) meta.branch = raw.gitBranch
    if (!meta.startedAt && raw.timestamp) meta.startedAt = Date.parse(raw.timestamp) || null
    // Last one wins: the title is rewritten as the conversation finds its
    // subject, and the later guess is the better one.
    if (raw.type === 'ai-title' && raw.aiTitle) meta.title = String(raw.aiTitle)
    // The fallback, for a session that ended before it earned a title. Tool
    // results arrive as `user` lines too, but carry no text block, so they
    // fall out here rather than being mistaken for something you said.
    if (!meta.prompt && raw.type === 'user') meta.prompt = oneLine(textOf(raw.message?.content))
  }
}

function sessionMeta(file, mtime) {
  const hit = metaCache.get(file)
  if (hit && hit.mtime === mtime) return hit.meta

  const head = readHead(file, META_HEAD)
  if (head === null) return null
  const meta = { cwd: null, branch: null, startedAt: null, title: null, prompt: null }
  scanMeta(head, meta)
  // On a long transcript the newest title is nowhere near the top. One extra
  // seek buys the session's subject instead of its opening line.
  const tail = readTail(file, META_TAIL)
  if (tail) scanMeta(tail, meta)

  metaCache.set(file, { mtime, meta })
  return meta
}

/**
 * The sessions this project has had, most recent first.
 *
 * The live registry only knows processes that are still running, so a session
 * disappears the moment it ends. Its transcript does not, and this reads those
 * back — the same files the conversation already renders, listed by project
 * instead of by process.
 *
 * The work is arranged to touch as little as possible. Each directory under
 * ~/.claude/projects is one encoded cwd, so which project a directory belongs
 * to costs a single probe of its newest file, not one per session; only the
 * handful actually being returned are then read for their title and branch.
 * The alternative reads every transcript on the machine to show five rows.
 *
 * Matching is on the resolved repository root rather than the raw cwd, so a
 * worktree and a session opened three directories down both land under the
 * project they belong to — the same grouping the sidebar uses.
 */
export function sessionHistory(projectPath, { limit = 5 } = {}) {
  if (!projectPath) return { sessions: [], total: 0 }

  // sessionId -> file, grouped by the directory that holds it.
  const byDir = new Map()
  for (const [sessionId, { file, mtime }] of indexTranscripts()) {
    const dir = path.dirname(file)
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push({ sessionId, file, mtime })
  }

  const ours = []
  for (const entries of byDir.values()) {
    entries.sort((a, b) => b.mtime - a.mtime)
    // One probe per directory: every transcript in it shares a cwd.
    const probe = sessionMeta(entries[0].file, entries[0].mtime)
    if (!probe?.cwd) continue
    if (resolveProjectRoot(probe.cwd).root !== projectPath) continue
    ours.push(...entries)
  }

  ours.sort((a, b) => b.mtime - a.mtime)
  const sessions = ours.slice(0, limit).map(({ sessionId, file, mtime }) => {
    const meta = sessionMeta(file, mtime) || {}
    return {
      sessionId,
      title: meta.title || meta.prompt || null,
      branch: meta.branch || null,
      cwd: meta.cwd || null,
      startedAt: meta.startedAt || null,
      lastActivity: mtime,
    }
  })

  return { sessions, total: ours.length }
}

/**
 * Subagents a session has launched, and which of them are still running.
 *
 * A subagent is a Task/Agent tool call. It is finished once a tool_result
 * carrying its id comes back, so anything still unmatched is in flight.
 *
 * Only the parent's view is available: this build does not write the
 * subagent's own messages into the parent transcript (no sidechain lines),
 * so we can report what is running, not what it is saying.
 */
const subagentCache = new Map()

export function subagentsFor(file) {
  let stat
  try { stat = fs.statSync(file) } catch { return { running: [], done: 0 } }

  // Transcripts only ever grow, so size plus mtime is a sound cache key and
  // saves re-scanning tens of megabytes on every refresh.
  const key = `${stat.size}:${stat.mtimeMs}`
  const cached = subagentCache.get(file)
  if (cached?.key === key) return cached.value

  let content = ''
  try { content = fs.readFileSync(file, 'utf8') } catch { return { running: [], done: 0 } }

  const launched = new Map()
  const finished = new Set()

  for (const line of content.split('\n')) {
    if (!line.startsWith('{')) continue
    if (!line.includes('"Task"') && !line.includes('"Agent"') && !line.includes('tool_result')) continue

    let raw
    try { raw = JSON.parse(line) } catch { continue }
    const blocks = raw.message?.content
    if (!Array.isArray(blocks)) continue

    if (raw.type === 'assistant') {
      for (const b of blocks) {
        if (b.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent')) {
          launched.set(b.id, {
            id: b.id,
            type: b.input?.subagent_type || b.name,
            description: b.input?.description || '',
            startedAt: raw.timestamp || null,
          })
        }
      }
    } else if (raw.type === 'user') {
      for (const b of blocks) {
        if (b.type === 'tool_result' && b.tool_use_id) finished.add(b.tool_use_id)
      }
    }
  }

  const running = [...launched.values()].filter((t) => !finished.has(t.id))
  const value = { running, done: finished.size ? [...launched.keys()].filter((id) => finished.has(id)).length : 0 }
  subagentCache.set(file, { key, value })
  return value
}
