/**
 * session-store.js — the session files, addressed by id.
 *
 * The deck has always had two kinds of session: the ones it launched, whose
 * process it owns, and the ones it only watches. Almost every limitation the
 * panel had came from that split — you could drive one and only read the
 * other.
 *
 * Everything in here is on the other side of that line. It works on the
 * session's own files under ~/.claude, which the SDK addresses by session id,
 * so it works the same whether the deck started the session or found it. Two
 * things the README used to call impossible live here:
 *
 *   - reading what a subagent actually said (`getSubagentMessages`)
 *   - renaming a session the deck did not launch (`renameSession`)
 *
 * The SDK calls are parameters, like `query` is in agent.js, so a test can
 * exercise the joining and the shaping without a ~/.claude to read.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  listSubagents,
  getSubagentMessages,
  renameSession,
  tagSession,
} from '@anthropic-ai/claude-agent-sdk'
import { indexTranscripts, normalizeLine, subagentsFor } from './transcripts.js'

/**
 * An agent id goes into a filename, and this deck answers to a phone on the
 * LAN. Anything that is not the SDK's own id shape never reaches the disk.
 */
export const AGENT_ID = /^[a-z0-9]{6,64}$/i

/** A session id likewise — the SDK checks too, but not before we build paths. */
export const SESSION_ID = /^[0-9a-f-]{8,64}$/i

/** Nothing named this session, and nothing tagged it. */
const NO_LABELS = { title: null, tag: null }

/**
 * Where a session keeps its subagents' transcripts.
 *
 * The layout is the SDK's, documented on `listSubagents`:
 * `~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`.
 * We derive it from the parent transcript rather than rebuilding the project
 * slug, because the deck already knows which file a session writes to and
 * the slug rules are not ours.
 */
export function subagentDir(transcriptFile) {
  const dir = path.dirname(transcriptFile)
  const sessionId = path.basename(transcriptFile, '.jsonl')
  return path.join(dir, sessionId, 'subagents')
}

/**
 * What the sidecar file says about one subagent.
 *
 * The SDK hands out agent ids and messages, but not which Task call an agent
 * came from — and that is the one field that lets a running subagent in the
 * project view and its conversation be recognised as the same thing. It sits
 * next to the transcript in `agent-<id>.meta.json`, so we read it ourselves
 * and treat its absence as "unknown", never as an error.
 */
export function readSubagentMeta(dir, agentId) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8'))
    return {
      type: meta.agentType || null,
      description: meta.description || '',
      toolUseId: meta.toolUseId || null,
      depth: Number.isInteger(meta.spawnDepth) ? meta.spawnDepth : null,
    }
  } catch {
    return null
  }
}

/**
 * Join the three things that each know part of the answer: the SDK's list of
 * agent ids, the meta file beside each transcript, and the parent's Task
 * calls that no result has come back for yet.
 *
 * A subagent with no meta file still shows up — you can read it, which is the
 * point — it just cannot claim to be running, because there is no id left to
 * match it on and guessing would be worse than a missing dot.
 */
export function joinSubagents(agentIds, metaFor, runningToolUseIds = []) {
  const running = new Set(runningToolUseIds)
  return (agentIds || []).map((agentId) => {
    const meta = metaFor(agentId)
    return {
      agentId,
      type: meta?.type || null,
      description: meta?.description || '',
      depth: meta?.depth ?? null,
      // What the live count in the header knows an agent by.
      toolUseId: meta?.toolUseId || null,
      running: Boolean(meta?.toolUseId && running.has(meta.toolUseId)),
    }
  })
}

/**
 * The subagent's messages in the shape the panel already renders.
 *
 * Its tool calls are counted rather than listed, the same bargain the main
 * conversation makes: the chat is what was said, and "37 tool calls" is the
 * part of the rest that is worth a line.
 */
export function shapeSubagentMessages(sdkMessages, { limit = 200 } = {}) {
  const messages = []
  let tools = 0

  for (const raw of sdkMessages || []) {
    const line = normalizeLine(raw)
    if (!line) continue
    if (line.role === '_activity') {
      tools += 1
      continue
    }
    messages.push(line)
  }

  return {
    messages: limit > 0 ? messages.slice(-limit) : messages,
    total: messages.length,
    tools,
  }
}

/**
 * The name and tag a session carries, out of the session file itself.
 *
 * Deliberately not `getSessionInfo().customTitle`: that field falls back to
 * the model-written summary of the conversation, so trusting it would rename
 * every session in the sidebar to a sentence nobody typed. A name is a name
 * because somebody set it — us, `claude -n`, or `/rename` — and the only
 * honest record of that is the `custom-title` marker in the file.
 */
const TITLE_MARK = '"type":"custom-title"'
const TAG_MARK = '"type":"tag"'

/** file -> { size, mtimeMs, value } */
const labelCache = new Map()

/** The marker's own line, out of a chunk that contains far more than it. */
function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index)
  return text.slice(start, end === -1 ? undefined : end)
}

function lastValue(text, mark, field) {
  let at = text.lastIndexOf(mark)
  while (at !== -1) {
    try {
      const parsed = JSON.parse(lineAt(text, at))
      if (parsed?.type === (mark === TITLE_MARK ? 'custom-title' : 'tag')) {
        const value = String(parsed[field] ?? '').trim()
        return value || null
      }
    } catch {
      // A half-written last line, or the first line of a chunk that starts
      // mid-line. Keep looking further back.
    }
    // lastIndexOf treats a negative start as 0, so the first match has to end
    // the search explicitly or an unparseable line at index 0 spins forever.
    if (at === 0) break
    at = text.lastIndexOf(mark, at - 1)
  }
  return undefined
}

export function readLabels(file) {
  if (!file) return NO_LABELS

  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    labelCache.delete(file)
    return NO_LABELS
  }

  const previous = labelCache.get(file)
  if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
    return previous.value
  }

  /*
   * Both markers are appended, and transcripts only ever grow, so on a file
   * we have already read only the bytes added since can carry a new name.
   * That is what makes this affordable on every refresh: a rename costs a
   * read of what a session wrote in the last second, not a re-read of a
   * transcript that can be tens of megabytes.
   */
  const grew = previous && stat.size > previous.size
  const from = grew ? previous.size : 0

  let chunk = ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const length = stat.size - from
      if (length > 0) {
        const buffer = Buffer.allocUnsafe(length)
        const read = fs.readSync(fd, buffer, 0, length, from)
        chunk = buffer.toString('utf8', 0, read)
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return previous?.value || NO_LABELS
  }

  const base = grew ? previous.value : NO_LABELS
  const title = lastValue(chunk, TITLE_MARK, 'customTitle')
  const tag = lastValue(chunk, TAG_MARK, 'tag')
  const value = {
    // undefined means this chunk said nothing about it, which is not the same
    // answer as null — null is a name that was cleared.
    title: title === undefined ? base.title : title,
    tag: tag === undefined ? base.tag : tag,
  }

  labelCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value })
  return value
}

/**
 * Which file a session writes to, cached briefly.
 *
 * `indexTranscripts()` stats every transcript on disk, which is the wrong
 * price to pay once per second for every session in the sidebar. A session's
 * file does not move, so five seconds of staleness can only mean a session
 * born in the last five seconds — and one of those has no name to read yet.
 */
const INDEX_TTL = 5000
let index = null
let indexedAt = 0

export function transcriptFor(sessionId, { now = Date.now() } = {}) {
  if (!sessionId) return null
  if (!index || now - indexedAt > INDEX_TTL) {
    index = indexTranscripts()
    indexedAt = now
  }
  const file = index.get(sessionId)?.file
  if (file) return file

  // A session the cached index predates: pay for one real lookup rather than
  // report "no file" for a session that has just written its first line.
  index = indexTranscripts()
  indexedAt = now
  return index.get(sessionId)?.file || null
}

/**
 * The SDK-backed operations, with their SDK calls injectable.
 */
export function createSessionStore({
  list = listSubagents,
  read = getSubagentMessages,
  rename = renameSession,
  tag = tagSession,
  locate = transcriptFor,
} = {}) {
  /** Every subagent a session has ever launched, and which are still up. */
  async function subagents(sessionId) {
    if (!SESSION_ID.test(sessionId || '')) return { subagents: [], missing: true }

    const file = locate(sessionId)
    if (!file) return { subagents: [], missing: true }

    const ids = (await list(sessionId)).filter((id) => AGENT_ID.test(id))
    const dir = subagentDir(file)
    const { running } = subagentsFor(file)

    const joined = joinSubagents(
      ids,
      (agentId) => readSubagentMeta(dir, agentId),
      running.map((task) => task.id),
    )

    // Running first, then the rest as they were spawned: what is happening
    // now is what you opened this for.
    return {
      subagents: joined.sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0)),
      running: joined.filter((a) => a.running).length,
    }
  }

  /** One subagent's conversation. */
  async function messages(sessionId, agentId, { limit = 200 } = {}) {
    if (!SESSION_ID.test(sessionId || '') || !AGENT_ID.test(agentId || '')) {
      return { messages: [], total: 0, tools: 0, missing: true }
    }

    const file = locate(sessionId)
    const meta = file ? readSubagentMeta(subagentDir(file), agentId) : null

    let raw = []
    try {
      raw = await read(sessionId, agentId, {})
    } catch {
      // A subagent whose transcript is gone, or an id for another session.
      return { messages: [], total: 0, tools: 0, missing: true }
    }

    return { ...shapeSubagentMessages(raw, { limit }), meta }
  }

  /**
   * Set the name Claude Code itself shows for a session — its prompt box, its
   * `/resume` picker, and from now on the deck's sidebar.
   *
   * There is no unsetting it. Claude Code's own record of a name has no empty
   * state — the SDK refuses a blank title — so this refuses it here rather
   * than sending a call that comes back as an error, and the panel offers no
   * way to clear a name it cannot clear. The deck's own label, on launched
   * sessions, is the one that still goes back to the task line when emptied.
   */
  async function retitle(sessionId, title) {
    if (!SESSION_ID.test(sessionId || '')) return { ok: false, error: 'Unknown session' }
    const clean = String(title ?? '').trim().slice(0, 80)
    if (!clean) return { ok: false, error: 'A session needs a name; this one cannot be cleared' }
    try {
      await rename(sessionId, clean)
      return { ok: true, title: clean }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  /** Tag a session, or clear the tag with an empty value. */
  async function retag(sessionId, value) {
    if (!SESSION_ID.test(sessionId || '')) return { ok: false, error: 'Unknown session' }
    const clean = String(value ?? '').trim().slice(0, 40)
    try {
      // The SDK rejects an empty tag on purpose: null is how you clear one.
      await tag(sessionId, clean || null)
      return { ok: true, tag: clean || null }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  /** What this session is called and tagged, for the session list. */
  function labels(sessionId) {
    return readLabels(locate(sessionId))
  }

  return { subagents, messages, retitle, retag, labels }
}
