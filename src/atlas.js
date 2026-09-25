/**
 * atlas.js — file activity for every live session at once.
 *
 * The transcript socket follows one session: the one you are looking at. The
 * deck-wide map needs all of them, and the naive way to get that — re-read
 * every transcript on every poll — does not survive contact with reality.
 * These files reach tens of megabytes and there can be a dozen of them.
 *
 * So this keeps a byte offset per session and reads only what has been
 * appended since last time, exactly as the single-session tail does. A poll
 * for a session that has not written anything costs one stat() call.
 *
 * Pull, not push: the atlas is one screen of many, and broadcasting file
 * events to every connected client whether or not anybody is watching them
 * would be paying for it all the time.
 */
import fs from 'node:fs'
import { eventsFromLine } from './activity.js'

/** sessionId -> { file, offset, remainder, events, failed } */
const readers = new Map()

/**
 * How much history each session keeps here.
 *
 * Smaller than the single-session view's budget on purpose: a card in a grid
 * is a glance, not a study, and this is multiplied by every session running.
 */
const PER_SESSION = 120

function reader(sessionId, file) {
  let state = readers.get(sessionId)
  if (!state || state.file !== file) {
    state = { file, offset: 0, remainder: '', events: [], failed: new Set() }
    readers.set(sessionId, state)
  }
  return state
}

/** Read whatever has been appended since the last call. */
function pump(state) {
  let size
  try { size = fs.statSync(state.file).size } catch { return }

  // Truncated or rotated: start over rather than reading garbage.
  if (size < state.offset) {
    state.offset = 0
    state.remainder = ''
    state.events = []
    state.failed = new Set()
  }
  if (size === state.offset) return

  let chunk = ''
  let fd
  try {
    fd = fs.openSync(state.file, 'r')
    const length = size - state.offset
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, state.offset)
    chunk = buffer.toString('utf8')
  } catch {
    return
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
  }

  const lines = (state.remainder + chunk).split('\n')
  // The last line may be half-written; leave it for the next pass.
  state.remainder = lines.pop() ?? ''
  state.offset = size

  for (const line of lines) {
    if (!line.startsWith('{')) continue
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue
    let raw
    try { raw = JSON.parse(line) } catch { continue }

    const found = eventsFromLine(raw)
    for (const event of found.events) {
      // Only file events are worth the room here. The caption a command
      // would give you belongs to the single-session view.
      if (event.path) state.events.push(event)
    }
    for (const id of found.failed) state.failed.add(id)
  }

  if (state.events.length > PER_SESSION) {
    state.events = state.events.slice(-PER_SESSION)
  }
  for (const event of state.events) {
    if (state.failed.has(event.id)) event.failed = true
  }
}

/**
 * One entry per live session that has a transcript, newest activity first.
 *
 * Sessions are passed in rather than read here: the registry is somebody
 * else's job, and this way the atlas can never disagree with the sidebar
 * about what is running.
 */
export function activityFor(sessions, findFile) {
  const alive = new Set()
  const out = []

  for (const session of sessions) {
    if (!session.sessionId) continue
    const file = findFile(session.sessionId)
    if (!file) continue

    alive.add(session.sessionId)
    const state = reader(session.sessionId, file)
    pump(state)

    out.push({
      sessionId: session.sessionId,
      cwd: session.cwd,
      events: state.events,
    })
  }

  // A session that ended must not leave its buffer behind for ever.
  for (const sessionId of [...readers.keys()]) {
    if (!alive.has(sessionId)) readers.delete(sessionId)
  }

  return out
}
