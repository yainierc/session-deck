/**
 * sessions.js — live registry of Claude Code sessions.
 *
 * Claude Code publishes one JSON file per session at
 * ~/.claude/sessions/<pid>.json with its cwd, name, status and socket. We
 * only read it: nothing is invented and no private API is involved.
 */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { sessionsDir, isAlive, terminateProcess } from './platform.js'
import { resolveProjectRoot, subpathWithin } from './projects.js'

/** A session in 'waiting' is one that is blocked on you. */
export function needsAttention(session) {
  return session.status === 'waiting'
}

/**
 * The order the panel shows sessions in: the order they started, oldest
 * first, for ever.
 *
 * This used to be a sort by urgency — waiting first, then by whatever had
 * spoken most recently. It reads well in a screenshot and badly in use. A
 * session that stops to ask you something jumps to the top of the sidebar,
 * and answering it drops it back to where it was, so every single permission
 * prompt moves the list twice: once while you are walking towards the row,
 * and once under the cursor as you answer. With `updatedAt` as the
 * tie-breaker the rest of the list shuffled every couple of seconds too,
 * because a busy session touches its file constantly.
 *
 * What is blocked on you is now *said* instead of staged — the amber dot,
 * the per-project badge, "What needs you", and the toast that carries the ask
 * itself. None of those need the list to move, and a list that does not move
 * is one you can learn by position.
 *
 * `startedAt` is the only thing about a session that never changes, which is
 * exactly what makes it the right key. The tie-breaker is an identity rather
 * than anything live, so two sessions that started in the same millisecond —
 * or one adopted from a transcript that recorded its start as a date string
 * rather than a number — still land in a fixed order rather than swapping on
 * each poll.
 */
function startedMs(session) {
  const raw = session.startedAt
  const value = typeof raw === 'string' ? Date.parse(raw) : Number(raw)
  return Number.isFinite(value) ? value : 0
}

export function stableOrder(sessions) {
  return [...sessions].sort(
    (a, b) =>
      startedMs(a) - startedMs(b) ||
      String(a.sessionId || a.deckId || a.pid || '').localeCompare(
        String(b.sessionId || b.deckId || b.pid || ''),
      ),
  )
}

function readOne(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data.pid !== 'number') return null
    return data
  } catch {
    // Half-written file, or deleted between the listing and the read.
    return null
  }
}

/** Normalize the raw JSON into the shape the UI consumes. */
function normalize(raw) {
  const cwd = raw.cwd || ''
  // Group by repository, not by directory: a worktree or a session opened in
  // a subdirectory is the same project, and splitting them apart is exactly
  // what makes a list of sessions hard to read.
  const { root, isWorktree } = resolveProjectRoot(cwd)
  return {
    pid: raw.pid,
    sessionId: raw.sessionId || null,
    name: raw.name || `pid-${raw.pid}`,
    cwd,
    project: root ? path.basename(root) : 'no project',
    projectPath: root || cwd,
    subpath: subpathWithin(root, cwd),
    isWorktree,
    status: raw.status || 'unknown',
    waitingFor: raw.waitingFor || null,
    kind: raw.kind || 'interactive',
    entrypoint: raw.entrypoint || null,
    version: raw.version || null,
    startedAt: raw.startedAt || null,
    updatedAt: raw.updatedAt || null,
    statusUpdatedAt: raw.statusUpdatedAt || null,
    messagingSocketPath: raw.messagingSocketPath || null,
    alive: true,
  }
}

/** Read every session that is alive right now. */
export function readSessions() {
  const dir = sessionsDir()
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }

  const out = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const raw = readOne(path.join(dir, entry))
    if (!raw) continue
    // The file outlives the session, so the PID is the source of truth.
    if (!isAlive(raw.pid)) continue
    out.push(normalize(raw))
  }

  return stableOrder(out)
}

/**
 * Kill a session the deck is only watching.
 *
 * The registry is the guard, and it is the whole point of routing this
 * through here rather than exposing "kill a pid" over the socket: the deck
 * will only ever signal a process that is, at this moment, a live Claude Code
 * session publishing its own file. A pid that belongs to anything else on the
 * machine — or to a session that already exited and left its number to be
 * reused — is refused before any signal is sent.
 *
 * `expectSessionId` closes the last gap. The pid comes from a panel that may
 * have been looking at a stale list, and pids get recycled; when the caller
 * knows which session it meant, a mismatch means the row it clicked is gone
 * and something else answers to that number now.
 *
 * Nothing calls this on shutdown. Sessions the deck did not launch outlive
 * the deck by design — restarting the panel must never take somebody's
 * terminal with it — so this only ever runs because a person pressed the
 * button and confirmed.
 */
export async function killSession(pid, { expectSessionId = null } = {}) {
  if (!Number.isInteger(pid)) return { ok: false, error: 'not a session' }

  const session = readSessions().find((s) => s.pid === pid)
  if (!session) return { ok: false, error: 'that session is not running any more' }
  if (expectSessionId && session.sessionId && session.sessionId !== expectSessionId) {
    return { ok: false, error: 'that pid belongs to a different session now' }
  }

  const result = await terminateProcess(pid)
  if (!result.ok) return result

  // Only once the process is confirmed gone. A session still running is one
  // whose registration is still true, however hard we just hit it.
  const cleaned = result.gone ? forgetSession(pid) : []
  return { ...result, pid, name: session.name, cleaned }
}

/**
 * Remove what a killed session could not remove itself.
 *
 * A session that exits on its own deletes its registration; one that had to be
 * SIGKILLed never got the chance, and leaves its `<pid>.json` and the
 * `<pid>.<hash>.key` beside it behind for ever. `readSessions` hides them —
 * the pid is dead, so it is filtered out — and that is exactly what makes them
 * easy to leave lying around: invisible until the day the operating system
 * hands that number to something else and a session that does not exist
 * reappears in the panel.
 *
 * This is the one place the deck writes inside ~/.claude, and it is as narrow
 * as it can be made: files named after a pid the deck itself just killed, and
 * only after that pid is confirmed dead. While a process is alive its
 * registration is the truth and is never touched — so a recycled pid cannot
 * talk the deck into deleting a live session's file.
 */
export function forgetSession(pid) {
  if (!Number.isInteger(pid) || isAlive(pid)) return []

  const dir = sessionsDir()
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return [] }

  const removed = []
  for (const entry of entries) {
    // The dot is load-bearing: on `startsWith(String(pid))` alone, killing
    // pid 1240 would delete pid 12401's files too.
    if (!entry.startsWith(`${pid}.`)) continue
    try {
      fs.unlinkSync(path.join(dir, entry))
      removed.push(entry)
    } catch {
      // Already gone, or not ours to delete. Either way there is nothing to
      // report and nothing that should fail the kill it followed.
    }
  }
  return removed
}

/** Group sessions by project, derived from the cwd. */
export function groupByProject(sessions) {
  const byPath = new Map()
  for (const s of sessions) {
    const key = s.projectPath || 'no project'
    if (!byPath.has(key)) {
      byPath.set(key, { path: key, name: s.project, sessions: [], waiting: 0 })
    }
    const group = byPath.get(key)
    group.sessions.push(s)
    if (needsAttention(s)) group.waiting += 1
  }
  /*
   * By name, and never by how much is waiting. The count still rides along
   * for the badge — what changed is that it no longer decides where the
   * project sits, so a project does not climb the sidebar the moment
   * something in it asks and sink again when you answer.
   */
  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Watch the registry and emit events.
 *
 * Polls instead of relying on fs.watch alone: fs.watch behaves differently
 * on every platform (and sometimes does not fire at all on mounted or
 * network volumes), whereas reading ~10 small JSON files per second costs
 * nothing. fs.watch is used only as an accelerator so changes show up
 * instantly.
 *
 * Events:
 *   'sessions'  (full list)  — on every change
 *   'attention' (session)    — when one enters the waiting state
 *   'gone'      (session)    — when a session disappears
 */
export function watchSessions({ intervalMs = 1000 } = {}) {
  const emitter = new EventEmitter()
  let previous = new Map()
  let timer = null
  let watcher = null
  let stopped = false
  let lastSerialized = ''

  function tick() {
    if (stopped) return
    const sessions = readSessions()
    const serialized = JSON.stringify(sessions)
    const current = new Map(sessions.map((s) => [s.pid, s]))

    for (const [pid, session] of current) {
      const before = previous.get(pid)
      // We only fire on the transition into waiting, not while it stays
      // there: otherwise it would repeat the same notification every second.
      if (needsAttention(session) && (!before || !needsAttention(before))) {
        emitter.emit('attention', session)
      }
    }
    for (const [pid, session] of previous) {
      if (!current.has(pid)) emitter.emit('gone', session)
    }

    previous = current
    if (serialized !== lastSerialized) {
      lastSerialized = serialized
      emitter.emit('sessions', sessions)
    }
  }

  try {
    watcher = fs.watch(sessionsDir(), () => tick())
    watcher.on('error', () => {})
  } catch {
    // No watcher is fine: polling covers the case.
  }

  timer = setInterval(tick, intervalMs)
  // The first tick is deferred on purpose: watchSessions() returns the
  // emitter and the caller attaches its listeners AFTERWARDS, so emitting
  // synchronously here would drop the first event — precisely the alert for
  // sessions that were already waiting on you when you opened the panel.
  const firstTick = setImmediate(tick)

  emitter.stop = () => {
    stopped = true
    clearInterval(timer)
    clearImmediate(firstTick)
    try { watcher?.close() } catch {}
  }
  emitter.current = () => readSessions()
  return emitter
}
