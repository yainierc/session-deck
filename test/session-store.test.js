/**
 * The two things the deck could not do to a session it did not launch: read
 * what its subagents said, and give it a name.
 *
 * Both work on files, addressed by session id, so the interesting failures
 * are about joining and about trust — a subagent claiming to be running when
 * nothing says it is, and a name in the sidebar that nobody typed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSessionStore,
  joinSubagents,
  readLabels,
  readSubagentMeta,
  shapeSubagentMessages,
  subagentDir,
} from '../src/session-store.js'

const SESSION = '11111111-2222-3333-4444-555555555555'
const AGENT = 'a553e920a8a11a9eb'

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deck-store-'))
}

/** A transcript plus the subagents directory Claude Code keeps beside it. */
function fixture({ lines = [], meta = null } = {}) {
  const dir = tmpdir()
  const file = path.join(dir, `${SESSION}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''))
  if (meta) {
    const agents = subagentDir(file)
    fs.mkdirSync(agents, { recursive: true })
    fs.writeFileSync(path.join(agents, `agent-${AGENT}.meta.json`), JSON.stringify(meta))
  }
  return file
}

const TASK_CALL = {
  type: 'assistant',
  uuid: 'a1',
  timestamp: '2026-09-21T11:45:27.000Z',
  message: {
    content: [{
      type: 'tool_use',
      id: 'toolu_012Mph',
      name: 'Task',
      input: { subagent_type: 'Explore', description: 'Map session-deck capabilities' },
    }],
  },
}

const TASK_RESULT = {
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-09-21T11:48:00.000Z',
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_012Mph', content: 'done' }] },
}

/** As Claude Code writes it beside the transcript. */
const META = {
  agentType: 'Explore',
  description: 'Map session-deck capabilities',
  toolUseId: 'toolu_012Mph',
  spawnDepth: 1,
}

/** The same thing after `readSubagentMeta`, which is what the join consumes. */
const READ_META = {
  type: 'Explore',
  description: 'Map session-deck capabilities',
  toolUseId: 'toolu_012Mph',
  depth: 1,
}

test('a subagent whose Task call has no result yet is running', () => {
  const joined = joinSubagents([AGENT], () => READ_META, ['toolu_012Mph'])
  assert.equal(joined.length, 1)
  assert.equal(joined[0].running, true)
  assert.equal(joined[0].description, 'Map session-deck capabilities')
  assert.equal(joined[0].type, 'Explore')
  assert.equal(joined[0].depth, 1)
})

test('a subagent whose Task call came back is not running', () => {
  const [joined] = joinSubagents([AGENT], () => READ_META, [])
  assert.equal(joined.running, false)
})

/*
 * The meta file is what ties an agent id to the Task call it came from. With
 * it gone the conversation is still readable — that is the whole point — but
 * "running" has nothing left to be true of, and a dot that guesses is worse
 * than no dot.
 */
test('a subagent with no meta file is readable but never claims to be running', () => {
  const [joined] = joinSubagents([AGENT], () => null, ['toolu_012Mph'])
  assert.equal(joined.agentId, AGENT)
  assert.equal(joined.running, false)
  assert.equal(joined.description, '')
})

test('the meta file is read from beside the transcript', () => {
  const file = fixture({ lines: [TASK_CALL], meta: META })
  const meta = readSubagentMeta(subagentDir(file), AGENT)
  assert.equal(meta.toolUseId, 'toolu_012Mph')
  assert.equal(meta.type, 'Explore')
  assert.equal(readSubagentMeta(subagentDir(file), 'b0b0b0b0b0'), null)
})

test('a subagent transcript reads as a conversation, with its tool calls counted', () => {
  const shaped = shapeSubagentMessages([
    { type: 'user', uuid: 's1', timestamp: '2026-09-21T11:45:27.000Z', message: { role: 'user', content: 'map the repo' } },
    { type: 'assistant', uuid: 's2', timestamp: '2026-09-21T11:45:30.000Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: {} }] } },
    { type: 'assistant', uuid: 's3', timestamp: '2026-09-21T11:46:00.000Z', message: { content: [{ type: 'text', text: '24 files, two of them matter' }] } },
  ])

  assert.equal(shaped.total, 2)
  assert.equal(shaped.tools, 1)
  assert.deepEqual(shaped.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(shaped.messages[1].text, '24 files, two of them matter')
})

test('only the last of several names counts, and an empty one clears it', () => {
  const file = fixture({
    lines: [
      TASK_CALL,
      { type: 'custom-title', customTitle: 'first go', sessionId: SESSION },
      { type: 'custom-title', customTitle: 'the invoice importer audit', sessionId: SESSION },
    ],
  })
  assert.equal(readLabels(file).title, 'the invoice importer audit')

  fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: '', sessionId: SESSION }) + '\n')
  assert.equal(readLabels(file).title, null)
})

/*
 * The name survives a re-read that only sees the new bytes. This is the whole
 * reason the tracker is incremental, and getting it wrong would show as a
 * name that vanishes from the sidebar a second after you set it.
 */
test('a name set long ago survives later writes it does not appear in', () => {
  const file = fixture({
    lines: [{ type: 'custom-title', customTitle: 'the invoice importer audit', sessionId: SESSION }],
  })
  assert.equal(readLabels(file).title, 'the invoice importer audit')

  fs.appendFileSync(file, JSON.stringify(TASK_CALL) + '\n')
  assert.equal(readLabels(file).title, 'the invoice importer audit')

  fs.appendFileSync(file, JSON.stringify({ type: 'tag', tag: 'invoices', sessionId: SESSION }) + '\n')
  const labels = readLabels(file)
  assert.equal(labels.title, 'the invoice importer audit')
  assert.equal(labels.tag, 'invoices')
})

/*
 * A session file says nothing about a name until somebody sets one. The AI
 * summary of the conversation is not that, and reading it as a name would
 * retitle every session in the sidebar to a sentence nobody typed.
 */
test('a session nobody named has no name of its own', () => {
  const file = fixture({ lines: [TASK_CALL, { type: 'summary', summary: 'Claude projects, new features' }] })
  assert.deepEqual(readLabels(file), { title: null, tag: null })
})

test('a transcript that is not there is not an error', () => {
  assert.deepEqual(readLabels(path.join(tmpdir(), 'gone.jsonl')), { title: null, tag: null })
  assert.deepEqual(readLabels(null), { title: null, tag: null })
})

test('the store lists a running subagent for a session it did not launch', async () => {
  const file = fixture({ lines: [TASK_CALL], meta: META })
  const store = createSessionStore({
    list: async () => [AGENT],
    locate: () => file,
  })

  const result = await store.subagents(SESSION)
  assert.equal(result.running, 1)
  assert.deepEqual(result.subagents.map((a) => a.description), ['Map session-deck capabilities'])
})

test('the same subagent is no longer running once its result is in', async () => {
  const file = fixture({ lines: [TASK_CALL, TASK_RESULT], meta: META })
  const store = createSessionStore({ list: async () => [AGENT], locate: () => file })
  const result = await store.subagents(SESSION)
  assert.equal(result.running, 0)
  assert.equal(result.subagents[0].running, false)
})

/*
 * An agent id ends up in a filename and this deck answers to a phone on the
 * LAN, so the shape of the id is a trust boundary, not a formality.
 */
test('ids that are not ids never reach the disk', async () => {
  const file = fixture({ lines: [TASK_CALL], meta: META })
  let asked = 0
  const store = createSessionStore({
    list: async () => { asked += 1; return [AGENT, '../../etc/passwd', ''] },
    read: async () => { asked += 1; return [] },
    locate: () => file,
  })

  const listed = await store.subagents(SESSION)
  assert.deepEqual(listed.subagents.map((a) => a.agentId), [AGENT])

  const traversal = await store.messages(SESSION, '../../../etc/passwd')
  assert.equal(traversal.missing, true)
  const badSession = await store.messages('not a session id', AGENT)
  assert.equal(badSession.missing, true)
  assert.equal(asked, 1, 'a rejected id never became a read')
})

test('renaming a session goes through by id, trimmed', async () => {
  const calls = []
  const store = createSessionStore({
    rename: async (sessionId, title) => calls.push([sessionId, title]),
    locate: () => null,
  })

  assert.deepEqual(await store.retitle(SESSION, '  the invoice importer audit  '), {
    ok: true,
    title: 'the invoice importer audit',
  })
  assert.deepEqual(calls, [[SESSION, 'the invoice importer audit']])

  const refused = await store.retitle('../elsewhere', 'nice try')
  assert.equal(refused.ok, false)
  assert.equal(calls.length, 1, 'a session id that is not one is never written to')
})

/*
 * Claude Code's name for a session has no empty state — the SDK refuses a
 * blank title. Saying so here is what keeps the panel from offering a box
 * that clears a name it cannot clear.
 */
test('an empty name is refused without asking the SDK', async () => {
  let asked = 0
  const store = createSessionStore({
    rename: async () => { asked += 1 },
    locate: () => null,
  })

  const refused = await store.retitle(SESSION, '   ')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /cannot be cleared/)
  assert.equal(asked, 0)
})

/* The SDK clears a tag with null and rejects an empty string for it. */
test('clearing a tag sends null, not an empty string', async () => {
  const calls = []
  const store = createSessionStore({
    tag: async (sessionId, value) => calls.push(value),
    locate: () => null,
  })

  await store.retag(SESSION, 'invoices')
  await store.retag(SESSION, '   ')
  assert.deepEqual(calls, ['invoices', null])
})

test('a failing SDK call is reported, not thrown', async () => {
  const store = createSessionStore({
    rename: async () => { throw new Error('session file is gone') },
    read: async () => { throw new Error('no such transcript') },
    locate: () => null,
  })

  assert.deepEqual(await store.retitle(SESSION, 'x'), { ok: false, error: 'session file is gone' })
  assert.equal((await store.messages(SESSION, AGENT)).missing, true)
})
