/**
 * What two transcripts say about the conversation their sessions had.
 *
 * The join is the whole design: the sender knows what it said, the receiver
 * knows who said it, and only together do they make a turn with both an
 * identity and a delivery time. So most of these are about what happens when
 * one half is missing, malformed, or lying about the clock — which is the
 * normal case, not the edge case.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { meetingsFor, sendsFromLine, deliveriesFromLine, forgetScans } from '../src/meeting.js'

const BODY = 'Heads-up: I found the fixtures you were missing, they are in test/data not the seed scripts.'

function send({ at, to, summary = 'a summary', text = BODY, name = 'SendMessage' }) {
  return {
    type: 'assistant',
    timestamp: at,
    cwd: '/repo',
    message: { content: [{ type: 'tool_use', id: 't' + at, name, input: { to, summary, message: text } }] },
  }
}

function delivery({ at, from, fromName, text = BODY, close = true }) {
  const tag = `<cross-session-message from="${from}" from-name="${fromName}" from-mode="prompting">`
  const body = `Another Claude session sent a message: ${tag}\n${text}\n${close ? '</cross-session-message>' : ''}`
  return { type: 'user', timestamp: at, cwd: '/repo', message: { role: 'user', content: [{ type: 'text', text: body }] } }
}

/** Write transcripts and return the index shape transcripts.js produces. */
function index(byId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-meet-'))
  const map = new Map()
  for (const [sessionId, lines] of Object.entries(byId)) {
    const file = path.join(dir, `${sessionId}.jsonl`)
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    map.set(sessionId, { file, mtime: Date.now() })
  }
  return map
}

test.beforeEach(() => forgetScans())

test('a send and its arrival become one turn with both clocks', () => {
  const map = index({
    alpha: [send({ at: '2026-09-14T19:36:02.000Z', to: 'peer-39' })],
    beta: [delivery({ at: '2026-09-14T19:42:54.000Z', from: 'uds:/tmp/cc-socks/11236.sock', fromName: 'peer-96' })],
  })

  const rooms = meetingsFor([], map, { days: 3650 })
  assert.equal(rooms.length, 1)
  const [turn] = rooms[0].turns
  assert.equal(turn.from, 'alpha')
  assert.equal(turn.to, 'beta')
  assert.equal(turn.at, '2026-09-14T19:36:02.000Z')
  // The gap between the two is the queue: the peer was mid-turn for six
  // minutes. Collapsing them would hide exactly that.
  assert.equal(turn.deliveredAt, '2026-09-14T19:42:54.000Z')
})

test("the sender's name survives the process that had it", () => {
  const map = index({
    alpha: [send({ at: '2026-09-14T19:36:02.000Z', to: 'peer-39' })],
    beta: [delivery({ at: '2026-09-14T19:36:03.000Z', from: 'uds:/tmp/cc-socks/11236.sock', fromName: 'shop-admin-96' })],
  })

  // Nothing is live: the registry that knew these names is gone.
  const [room] = meetingsFor([], map, { days: 3650 })
  const alpha = room.participants.find((p) => p.sessionId === 'alpha')
  assert.equal(alpha.name, 'shop-admin-96')
  assert.equal(alpha.live, false)
  // And the cwd came off the transcript lines, not the registry.
  assert.equal(room.cwd, '/repo')
})

test("a peer's socket is learned from the arrival that named it", () => {
  const fromBeta = 'A message in the other direction, with no words in common with the first one.'
  const orphan = 'A third message, addressed by socket, that nothing ever recorded arriving.'
  const map = index({
    alpha: [
      send({ at: '2026-09-14T19:36:02.000Z', to: 'peer-39' }),
      // Addressed by beta's socket, and delivered nowhere we can see.
      send({ at: '2026-09-14T19:50:00.000Z', to: 'uds:/tmp/cc-socks/50163.sock', text: orphan }),
      // Beta spoke, and alpha wrote down who it was. This is the only place
      // beta's socket is ever stated.
      delivery({ at: '2026-09-14T19:40:01.000Z', from: 'uds:/tmp/cc-socks/50163.sock', fromName: 'peer-39', text: fromBeta }),
    ],
    beta: [
      delivery({ at: '2026-09-14T19:36:03.000Z', from: 'uds:/tmp/cc-socks/11236.sock', fromName: 'peer-96' }),
      send({ at: '2026-09-14T19:40:00.000Z', to: 'peer-96', text: fromBeta }),
    ],
  })

  const [room] = meetingsFor([], map, { days: 3650 })
  assert.equal(room.turns.length, 3)

  const orphaned = room.turns.find((t) => t.text === orphan)
  assert.equal(orphaned.to, 'beta')
  assert.equal(orphaned.deliveredAt, null)
})

test('a message nobody received is kept, and says so', () => {
  const map = index({
    alpha: [
      send({ at: '2026-09-14T19:36:02.000Z', to: 'peer-39' }),
      send({ at: '2026-09-14T19:40:00.000Z', to: 'peer-39', text: 'A second message that never arrived anywhere at all, ever.' }),
    ],
    beta: [delivery({ at: '2026-09-14T19:36:03.000Z', from: 'uds:/x.sock', fromName: 'peer-96' })],
  })

  const [room] = meetingsFor([], map, { days: 3650 })
  assert.equal(room.turns.length, 2)
  assert.equal(room.turns[1].deliveredAt, null)
})

test('subagents are not colleagues and never enter a room', () => {
  const map = index({
    alpha: [send({ at: '2026-09-14T19:36:02.000Z', to: 'a75fb93e6f2906641' })],
    beta: [delivery({ at: '2026-09-14T19:36:03.000Z', from: 'uds:/x.sock', fromName: 'peer-96' })],
  })
  assert.equal(meetingsFor([], map, { days: 3650 }).length, 0)
})

test('an envelope that was never closed still reports its body', () => {
  const line = delivery({ at: '2026-09-14T19:36:03.000Z', from: 'uds:/x.sock', fromName: 'peer', close: false })
  const [one] = deliveriesFromLine(line)
  assert.equal(one.fromName, 'peer')
  assert.ok(one.text.startsWith('Heads-up'))
})

test('two arrivals on one line are two deliveries', () => {
  const one = delivery({ at: '2026-09-14T19:36:03.000Z', from: 'uds:/a.sock', fromName: 'a' })
  const two = delivery({ at: '2026-09-14T19:36:03.000Z', from: 'uds:/b.sock', fromName: 'b', text: 'Another message entirely, long enough to key.' })
  one.message.content[0].text += '\n' + two.message.content[0].text
  assert.equal(deliveriesFromLine(one).length, 2)
})

test('a tool that is not SendMessage is not a turn', () => {
  assert.equal(sendsFromLine(send({ at: '2026-09-14T19:36:02.000Z', to: 'peer', name: 'Bash' })).length, 0)
})

test('hours apart is two conversations, not one with a hole', () => {
  const later = 'An entirely separate afternoon message with nothing in common with the morning one.'
  const map = index({
    alpha: [
      send({ at: '2026-09-14T09:00:00.000Z', to: 'peer-39' }),
      send({ at: '2026-09-14T18:00:00.000Z', to: 'peer-39', text: later }),
    ],
    beta: [
      delivery({ at: '2026-09-14T09:00:01.000Z', from: 'uds:/x.sock', fromName: 'peer-96' }),
      delivery({ at: '2026-09-14T18:00:01.000Z', from: 'uds:/x.sock', fromName: 'peer-96', text: later }),
    ],
  })

  const rooms = meetingsFor([], map, { days: 3650 })
  assert.equal(rooms.length, 2)
  // Newest first, so the room the supervisor wants is the one on top.
  assert.equal(rooms[0].startedAt, '2026-09-14T18:00:00.000Z')
})

test('the silence before a turn is measured, and the first has none', () => {
  const second = 'A reply sent a quarter of an hour later, sharing no words with the first message.'
  const map = index({
    alpha: [send({ at: '2026-09-14T19:00:00.000Z', to: 'peer' })],
    beta: [
      delivery({ at: '2026-09-14T19:00:01.000Z', from: 'uds:/x.sock', fromName: 'peer-96' }),
      send({ at: '2026-09-14T19:15:00.000Z', to: 'peer-96', text: second }),
    ],
  })

  const [room] = meetingsFor([], map, { days: 3650 })
  assert.equal(room.turns[0].gapBefore, 0)
  assert.equal(room.turns[1].gapBefore, 15 * 60 * 1000)
})

test('a live session keeps the registry name over the remembered one', () => {
  const map = index({
    alpha: [send({ at: '2026-09-14T19:36:02.000Z', to: 'peer-39' })],
    beta: [delivery({ at: '2026-09-14T19:36:03.000Z', from: 'uds:/x.sock', fromName: 'stale-name' })],
  })
  const live = [{ sessionId: 'alpha', name: 'renamed-today', cwd: '/repo', status: 'busy' }]

  const [room] = meetingsFor(live, map, { days: 3650 })
  const alpha = room.participants.find((p) => p.sessionId === 'alpha')
  assert.equal(alpha.name, 'renamed-today')
  assert.equal(alpha.live, true)
  assert.equal(alpha.status, 'busy')
})
