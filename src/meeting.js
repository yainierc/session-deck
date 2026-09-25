/**
 * meeting.js — the conversations sessions have with each other.
 *
 * The atlas answers "what is everything doing". This answers a question no
 * view answered at all: "what are they saying to each other". Two sessions
 * working the same repo argue, concede, divide the work and escalate to you —
 * and until now every word of it was invisible unless you opened both
 * transcripts side by side and read by timestamp.
 *
 * It dials nothing. The peer channel is a unix socket per session with a
 * shared secret beside it, undocumented and free to change; reading it would
 * be a protocol reimplementation that breaks on the next CLI release. It does
 * not have to: both ends already write the conversation down.
 *
 *   The sender logs `SendMessage` as an ordinary tool call, carrying the full
 *   body and the `summary` the model wrote for it.
 *
 *   The receiver logs the arrival as an injected user turn wrapped in
 *   `<cross-session-message from=… from-name=… from-mode=…>`.
 *
 * Neither half is enough alone. The sender knows what it said and when it
 * said it, but addresses the peer by a name or a socket path that means
 * nothing once that process exits. The receiver knows who spoke — by name,
 * which is the only place a dead session's name survives, since the registry
 * file under ~/.claude/sessions is deleted with the process — but not the
 * summary. Joined on the body, the two halves give a turn that is complete
 * and, more usefully, an identity: this socket and this name were this
 * sessionId. Every later message to either token resolves for free.
 *
 * That join is why nothing here guesses. Pairing two sessions because their
 * messages interleave plausibly would be inference, and an inference that is
 * usually right is the worst thing to put on a supervision screen. A turn
 * that cannot be joined is reported as one-sided rather than completed by
 * imagination.
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * How far back the first scan reaches.
 *
 * There are ~900 MB of transcripts on a machine that has been running these
 * for a month, and reading all of it to answer one request is not a thing to
 * do. Two weeks covers the history anybody supervises while keeping the cold
 * pass to a few seconds; every later pass reads only what was appended.
 */
const DEFAULT_DAYS = 14

/**
 * The gap that ends a meeting.
 *
 * Two sessions that spoke this morning and again after lunch had two
 * conversations, not one with a hole in it. Three hours is long enough to
 * survive a session going quiet while it works — the longest real silence
 * inside a live thread here was 29 minutes — and short enough that yesterday
 * does not land in today's room.
 */
const IDLE_SPLIT_MS = 3 * 60 * 60 * 1000

/** How much of a body identifies it. */
const KEY_CHARS = 160

/** file path -> { offset, remainder, cwd, sends, deliveries } */
const scans = new Map()

/**
 * A recipient token that is a spawned subagent rather than a peer session.
 *
 * `SendMessage` addresses both with the same field. A subagent is a session's
 * own internal staff — it has no transcript of its own in this index, never
 * writes a `cross-session-message`, and putting it in the room would fill a
 * conversation between two colleagues with their private helpers.
 */
function isAgentId(to) {
  return /^[0-9a-f]{12,}$/i.test(to)
}

/**
 * What identifies a message body across the two transcripts that hold it.
 *
 * Whitespace is collapsed because the two sides do not always agree on it,
 * and only the head is used because a receiver may store a long body
 * truncated. Short enough to survive truncation, long enough that two
 * genuinely different messages do not collide.
 */
export function bodyKey(text) {
  if (typeof text !== 'string') return null
  const flat = text.replace(/\s+/g, ' ').trim().slice(0, KEY_CHARS)
  return flat.length >= 24 ? flat.toLowerCase() : null
}

/** Outbound peer messages on one already-parsed transcript line. */
export function sendsFromLine(raw) {
  const out = []
  if (raw?.type !== 'assistant') return out
  const blocks = raw?.message?.content
  if (!Array.isArray(blocks)) return out

  for (const block of blocks) {
    if (block?.type !== 'tool_use' || block.name !== 'SendMessage') continue
    const input = block.input
    if (!input || typeof input !== 'object') continue

    const to = typeof input.to === 'string' ? input.to : (input.recipient || '')
    const text = typeof input.message === 'string' ? input.message : (input.content || '')
    if (!to || !text) continue

    out.push({
      id: block.id,
      at: raw.timestamp || null,
      to,
      agent: isAgentId(to),
      summary: typeof input.summary === 'string' ? input.summary : null,
      text,
      key: bodyKey(text),
    })
  }
  return out
}

/**
 * The `<cross-session-message>` envelopes on one already-parsed line.
 *
 * Parsed with a regex rather than an XML reader on purpose: this is a tag
 * injected into prose, one of the 382 on this machine is missing its `from`
 * and 22 never close, and a strict parser would drop those rather than report
 * what they do say. Everything here is optional except the body.
 */
export function deliveriesFromLine(raw) {
  const out = []
  if (raw?.type !== 'user') return out

  const content = raw?.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') text += block.text
    }
  }
  if (!text.includes('<cross-session-message')) return out

  const open = /<cross-session-message([^>]*)>/g
  let match
  while ((match = open.exec(text))) {
    const attrs = match[1] || ''
    const attr = (name) => {
      const found = new RegExp(`${name}="([^"]*)"`).exec(attrs)
      return found ? found[1] : null
    }

    // Up to the close, or to the end when the envelope was never closed.
    const from = open.lastIndex
    const close = text.indexOf('</cross-session-message>', from)
    const body = (close === -1 ? text.slice(from) : text.slice(from, close)).trim()
    if (!body) continue

    out.push({
      at: raw.timestamp || null,
      fromToken: attr('from'),
      fromName: attr('from-name'),
      mode: attr('from-mode'),
      hops: attr('hop-chain'),
      text: body,
      key: bodyKey(body),
    })
  }
  return out
}

/**
 * Read whatever has been appended to one transcript since the last call.
 *
 * Same offset discipline as the atlas, for the same reason: these files reach
 * tens of megabytes and a poll that re-read them all would cost more than
 * everything else the deck does put together.
 */
function scan(file) {
  let state = scans.get(file)
  if (!state) {
    state = { offset: 0, remainder: '', cwd: null, sends: [], deliveries: [] }
    scans.set(file, state)
  }

  let size
  try { size = fs.statSync(file).size } catch { return state }

  // Truncated or rotated: start over rather than reading garbage.
  if (size < state.offset) {
    state.offset = 0
    state.remainder = ''
    state.cwd = null
    state.sends = []
    state.deliveries = []
  }
  if (size === state.offset) return state

  let chunk = ''
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const length = size - state.offset
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, state.offset)
    chunk = buffer.toString('utf8')
  } catch {
    return state
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
  }

  const lines = (state.remainder + chunk).split('\n')
  // The last line may be half-written; leave it for the next pass.
  state.remainder = lines.pop() ?? ''
  state.offset = size

  for (const line of lines) {
    if (!line.startsWith('{')) continue
    // The cheap test first: almost every line is neither, and JSON.parse on
    // a 40 KB transcript line is what makes a cold scan slow.
    const send = line.includes('SendMessage')
    const delivery = line.includes('cross-session-message')
    if (!send && !delivery) continue

    let raw
    try { raw = JSON.parse(line) } catch { continue }

    /*
     * Where the session was working, taken from the lines we were parsing
     * anyway. The registry knows this for a live session and forgets it the
     * moment the process exits, which is precisely when the room needs it:
     * a conversation between two sessions that both ended still happened
     * somewhere, and "unknown" is a worse answer than the one on the line.
     */
    if (typeof raw.cwd === 'string' && raw.cwd) state.cwd = raw.cwd

    if (send) for (const one of sendsFromLine(raw)) state.sends.push(one)
    if (delivery) for (const one of deliveriesFromLine(raw)) state.deliveries.push(one)
  }

  return state
}

/** Milliseconds, or null when a timestamp is missing or unparseable. */
function ms(at) {
  if (!at) return null
  const value = Date.parse(at)
  return Number.isNaN(value) ? null : value
}

/**
 * Which transcripts are worth opening.
 *
 * Live sessions always, however old their file: a session that has been
 * running for three weeks is exactly the one you are supervising. Everything
 * else by mtime.
 */
function candidates(index, sessions, days) {
  const live = new Set(sessions.map((s) => s.sessionId).filter(Boolean))
  const cutoff = Date.now() - days * 86400 * 1000
  const out = []

  // The index entry is `{ file, mtime }` — it already stat()ed every file to
  // build itself, so asking the disk again here would be paying twice.
  for (const [sessionId, entry] of index) {
    if (!entry?.file) continue
    if (!live.has(sessionId) && entry.mtime < cutoff) continue
    out.push({ sessionId, file: entry.file })
  }
  return out
}

/** A stable id for a room, so the view can keep it selected across polls. */
function roomId(participants, startedAt) {
  return crypto.createHash('sha1')
    .update([...participants].sort().join('|') + '@' + startedAt)
    .digest('hex')
    .slice(0, 12)
}

/**
 * Every conversation between sessions, newest first.
 *
 * `sessions` is the live registry — passed in rather than read here so the
 * room can never disagree with the sidebar about what is running — and
 * `findFile` resolves a sessionId to its transcript.
 */
export function meetingsFor(sessions, index, { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const files = candidates(index, sessions, days)

  /* ---- pass 1: read both halves out of every candidate transcript ---- */

  const sends = []       // { from, ...send }
  const deliveries = []  // { into, ...delivery }
  const cwdOf = new Map()

  for (const { sessionId, file } of files) {
    const state = scan(file)
    if (state.cwd) cwdOf.set(sessionId, state.cwd)
    for (const one of state.sends) {
      if (one.agent) continue // internal staff, not a colleague
      sends.push({ ...one, from: sessionId })
    }
    for (const one of state.deliveries) deliveries.push({ ...one, into: sessionId })
  }

  /* ---- pass 2: join the halves on the body ---- */

  // key -> deliveries waiting to be claimed, earliest first.
  const waiting = new Map()
  for (const one of deliveries) {
    if (!one.key) continue
    if (!waiting.has(one.key)) waiting.set(one.key, [])
    waiting.get(one.key).push(one)
  }
  for (const list of waiting.values()) list.sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0))

  /*
   * What a token means, learned from the join rather than assumed.
   *
   * A delivery names its sender; the send it matches names the sessionId. So
   * one joined message teaches us that a socket path and a display name are a
   * particular session — and that survives the process, which the registry
   * file does not.
   */
  const alias = new Map()
  const nameOf = new Map()

  // Seed with the live registry, which is authoritative while it lasts.
  for (const session of sessions) {
    if (!session.sessionId) continue
    if (session.name) {
      alias.set(session.name, session.sessionId)
      nameOf.set(session.sessionId, session.name)
    }
    if (session.messagingSocketPath) {
      alias.set(session.messagingSocketPath, session.sessionId)
      alias.set(`uds:${session.messagingSocketPath}`, session.sessionId)
    }
  }

  const turns = []
  for (const send of sends) {
    const sent = ms(send.at)
    let claimed = null

    const queue = send.key ? waiting.get(send.key) : null
    if (queue) {
      // The earliest arrival at or after the send. Delivery can lag by
      // minutes — the peer is mid-turn and the message queues — so "closest
      // in time" would sometimes pick an earlier, unrelated repeat.
      for (let i = 0; i < queue.length; i += 1) {
        const one = queue[i]
        if (one.into === send.from) continue
        const got = ms(one.at)
        if (sent !== null && got !== null && got < sent - 1000) continue
        claimed = one
        queue.splice(i, 1)
        break
      }
    }

    if (claimed) {
      /*
       * Both directions are learned here, and both are observations.
       *
       * The arrival names its sender, so the socket and display name it
       * carries belong to the session this send came from. And the address
       * the send used demonstrably reached the session that recorded the
       * arrival — that is what "it was delivered there" means. The second
       * one is what lets a later message to the same peer find its room
       * even when nobody wrote its arrival down.
       */
      if (claimed.fromToken) alias.set(claimed.fromToken, send.from)
      if (claimed.fromName) {
        alias.set(claimed.fromName, send.from)
        if (!nameOf.has(send.from)) nameOf.set(send.from, claimed.fromName)
      }
      alias.set(send.to, claimed.into)
    }

    turns.push({
      from: send.from,
      to: claimed ? claimed.into : null,
      toToken: send.to,
      at: send.at,
      deliveredAt: claimed ? claimed.at : null,
      summary: send.summary,
      text: send.text,
      mode: claimed ? claimed.mode : null,
      hops: claimed ? claimed.hops : null,
    })
  }

  /*
   * A second look at the turns nobody claimed.
   *
   * By now the alias map has learned tokens from every join anywhere in the
   * scan, so a message whose peer was silent at that moment can still be
   * addressed correctly — it simply has no delivery time.
   */
  for (const turn of turns) {
    if (turn.to) continue
    const resolved = alias.get(turn.toToken)
      || alias.get(turn.toToken.replace(/^uds:/, ''))
      || alias.get(`uds:${turn.toToken}`)
    if (resolved && resolved !== turn.from) turn.to = resolved
  }

  /* ---- pass 3: cut the turns into rooms ---- */

  // Only turns with both ends known can put two sessions in a room together.
  const paired = turns.filter((t) => t.to).sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0))

  const rooms = []
  const openRooms = new Map() // pair key -> room

  for (const turn of paired) {
    const pair = [turn.from, turn.to].sort().join('|')
    const at = ms(turn.at) ?? now
    let room = openRooms.get(pair)

    if (!room || at - room.lastMs > IDLE_SPLIT_MS) {
      room = {
        participants: [turn.from, turn.to].sort(),
        turns: [],
        lastMs: at,
      }
      openRooms.set(pair, room)
      rooms.push(room)
    }

    turn.gapBefore = room.turns.length ? at - room.lastMs : 0
    room.lastMs = at
    room.turns.push(turn)
  }

  /* ---- pass 4: dress them for the view ---- */

  const byId = new Map(sessions.map((s) => [s.sessionId, s]))

  const out = rooms.map((room) => {
    const first = room.turns[0]
    const last = room.turns[room.turns.length - 1]
    const people = room.participants.map((sessionId) => {
      const session = byId.get(sessionId) || null
      return {
        sessionId,
        name: session?.name || nameOf.get(sessionId) || sessionId.slice(0, 8),
        cwd: session?.cwd || cwdOf.get(sessionId) || null,
        status: session?.status || 'gone',
        waitingFor: session?.waitingFor || null,
        live: Boolean(session),
        spoke: room.turns.filter((t) => t.from === sessionId).length,
      }
    })

    return {
      id: roomId(room.participants, first.at || ''),
      participants: people,
      cwd: people.find((p) => p.cwd)?.cwd || null,
      startedAt: first.at,
      endedAt: last.at,
      turns: room.turns,
      live: people.some((p) => p.live),
    }
  })

  out.sort((a, b) => (ms(b.endedAt) ?? 0) - (ms(a.endedAt) ?? 0))
  return out
}

/** Drop cached scans for transcripts that are gone. Tests use it to reset. */
export function forgetScans() {
  scans.clear()
}
