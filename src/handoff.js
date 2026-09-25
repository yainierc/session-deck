/**
 * handoff.js — what the deck hands over to its own successor.
 *
 * A session the deck launches is a child of this process. Stopping the server
 * to pick up new code therefore ends it, and until now it ended for good: the
 * conversation stayed on disk under ~/.claude, but the only thing that knew
 * which conversation belonged to which panel entry was a Map in memory, and
 * that Map died with the process. Every restart turned work in flight into
 * an archive nobody could type into again.
 *
 * This file is that Map, written down. It holds the minimum needed to open a
 * session back up — the id the SDK resumes by, and the options it was running
 * under — and nothing about the conversation itself, which the transcript
 * already owns.
 *
 * It is written continuously rather than on the way out, because the exits
 * that lose the most work are the ones that never run a shutdown handler:
 * `kill -9`, a crash, a laptop that slept until the battery went. A record
 * this file wrote a minute ago survives all three.
 */
import fs from 'node:fs'
import path from 'node:path'
import { deckDir } from './platform.js'

/**
 * How long a record is worth keeping.
 *
 * Resuming is cheap but not free — it reloads the whole conversation into
 * context — and a session you have not touched in a week is one you moved on
 * from. The transcript stays either way; this only decides what the deck
 * offers to put back on screen.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** A ceiling on the file, so a long-running deck cannot grow it without end. */
const MAX_RECORDS = 60

function file() {
  return path.join(deckDir(), 'handoff.json')
}

/**
 * Keep only what we put there, in the shape we put it.
 *
 * This file is read at boot and everything in it becomes a session the panel
 * offers to resume, so a half-written record from an interrupted write must
 * not become a session with no id or a cwd of `undefined`.
 */
function clean(raw) {
  if (!raw || typeof raw !== 'object') return null
  const { deckId, sessionId, cwd } = raw
  if (typeof deckId !== 'string' || !deckId) return null
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (typeof cwd !== 'string' || !cwd) return null
  return {
    deckId,
    sessionId,
    cwd,
    title: typeof raw.title === 'string' ? raw.title : '',
    permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : 'default',
    model: typeof raw.model === 'string' ? raw.model : null,
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
    seenAt: Number.isFinite(raw.seenAt) ? raw.seenAt : null,
  }
}

/**
 * The sessions a previous deck was driving, newest first.
 *
 * Anything too old, unparseable, or pointing at a directory that no longer
 * exists is dropped here rather than at the call site: a worktree that got
 * deleted while the deck was down is the ordinary case, not an error, and a
 * session resumed into a missing cwd fails in a much less obvious way.
 */
export function read() {
  let data
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    // Missing or corrupt: no handoff is the normal state of a first start.
    return []
  }
  if (!Array.isArray(data?.sessions)) return []

  const cutoff = Date.now() - MAX_AGE_MS
  const seen = new Set()
  const records = []
  for (const raw of data.sessions) {
    const record = clean(raw)
    if (!record) continue
    if (record.seenAt && record.seenAt < cutoff) continue
    // One entry per conversation. The same session resumed twice would
    // otherwise come back as two panel entries fighting over one transcript.
    if (seen.has(record.sessionId)) continue
    if (!fs.existsSync(record.cwd)) continue
    seen.add(record.sessionId)
    records.push(record)
  }
  return records.sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0)).slice(0, MAX_RECORDS)
}

/**
 * Replace the file with this set of records.
 *
 * Written through a temporary file and renamed into place, because the write
 * that matters most is the one racing a shutdown: a half-flushed file is
 * exactly the thing `read()` above would have to throw away, and rename is
 * the operation the filesystem promises not to tear.
 */
export function write(records) {
  const dir = deckDir()
  const target = file()
  const tmp = `${target}.tmp-${process.pid}`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ sessions: records }, null, 2) + '\n')
    fs.renameSync(tmp, target)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch {}
    return false
  }
}

/**
 * Write down the sessions worth coming back to.
 *
 * `sessions` is the manager's own public list, so this is the one place that
 * decides what counts as resumable:
 *
 *   - no session id means the CLI never got far enough to write a transcript,
 *     and there is nothing on disk to resume into;
 *   - a session that was stopped on purpose, or that ended in an error, is
 *     finished. Offering it back would make the stop button look broken.
 */
export function remember(sessions) {
  const records = []
  for (const s of sessions) {
    if (!s.sessionId || !s.cwd) continue
    if (s.status === 'done' || s.status === 'error') continue
    records.push({
      deckId: s.deckId,
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title || '',
      permissionMode: s.permissionMode || 'default',
      model: s.model || null,
      startedAt: s.startedAt || null,
      seenAt: Date.now(),
    })
  }
  return write(records.slice(0, MAX_RECORDS))
}

/** Drop one record — what stopping a session for good means on disk. */
export function forget(deckId) {
  const left = read().filter((r) => r.deckId !== deckId)
  return write(left)
}
