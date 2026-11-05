/*
 * The live subagent table. Each test is one way the stream can move, written
 * as the messages the CLI actually emits, because the shape of those messages
 * is the whole contract.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createLiveAgents } from '../src/live-agents.js'
import { createAgentManager } from '../src/agent.js'

const sys = (subtype, fields) => ({ type: 'system', subtype, ...fields })
const started = (id, extra = {}) =>
  sys('task_started', { task_id: id, task_type: 'local_agent', description: `task ${id}`, subagent_type: 'Explore', ...extra })

test('a started agent is listed with what it was asked to do', () => {
  const live = createLiveAgents({ now: () => 1000 })
  assert.deepEqual(live.apply(started('a', { tool_use_id: 'tu1' })), { urgent: true })
  assert.deepEqual(live.list(), [{
    taskId: 'a', toolUseId: 'tu1', description: 'task a', type: 'Explore', background: false,
    startedAt: 1000, tokens: null, toolUses: null, lastTool: null, summary: null,
  }])
})

test('a task that is not an agent is not counted', () => {
  const live = createLiveAgents()
  assert.equal(live.apply(sys('task_started', { task_id: 'sh', task_type: 'local_bash', description: 'npm test' })), null)
  assert.equal(live.apply(started('w', { ambient: true })), null)
  assert.equal(live.list().length, 0)
})

test('progress fills in the detail and can wait to be published', () => {
  const live = createLiveAgents()
  live.apply(started('a'))
  const r = live.apply(sys('task_progress', {
    task_id: 'a', usage: { total_tokens: 4200, tool_uses: 3, duration_ms: 900 }, last_tool_name: 'Grep', summary: 'Searching src/',
  }))
  assert.deepEqual(r, { urgent: false })
  const [row] = live.list()
  assert.equal(row.tokens, 4200)
  assert.equal(row.toolUses, 3)
  assert.equal(row.lastTool, 'Grep')
  assert.equal(row.summary, 'Searching src/')
})

test('progress for a task we never saw is ignored', () => {
  const live = createLiveAgents()
  assert.equal(live.apply(sys('task_progress', { task_id: 'x', usage: { total_tokens: 1, tool_uses: 1 } })), null)
})

test('an agent leaves on its update, or on its notification', () => {
  const live = createLiveAgents()
  live.apply(started('a'))
  live.apply(started('b'))
  assert.deepEqual(live.apply(sys('task_updated', { task_id: 'a', patch: { status: 'completed' } })), { urgent: true })
  assert.deepEqual(live.apply(sys('task_notification', { task_id: 'b', status: 'failed' })), { urgent: true })
  assert.equal(live.list().length, 0)
})

test('the end of a turn clears the foreground agents and keeps the background ones', () => {
  const live = createLiveAgents()
  live.apply(started('fg'))
  live.apply(started('bg', { is_backgrounded: true }))
  live.apply({ type: 'result', subtype: 'success' })
  assert.deepEqual(live.list().map((r) => r.taskId), ['bg'])
})

test('an agent sent to the background survives the turn', () => {
  const live = createLiveAgents()
  live.apply(started('a'))
  assert.deepEqual(live.apply(sys('task_updated', { task_id: 'a', patch: { is_backgrounded: true } })), { urgent: true })
  live.apply({ type: 'result', subtype: 'success' })
  assert.equal(live.list()[0].background, true)
})

test('a background agent missing from the level is over, even with its end lost', () => {
  const live = createLiveAgents()
  live.apply(started('a', { is_backgrounded: true }))
  live.apply(started('b', { is_backgrounded: true }))
  const r = live.apply(sys('background_tasks_changed', { tasks: [{ task_id: 'b', task_type: 'local_agent', description: '' }] }))
  assert.deepEqual(r, { urgent: true })
  assert.deepEqual(live.list().map((x) => x.taskId), ['b'])
})

test('the level does not touch a foreground agent, which is never in it', () => {
  const live = createLiveAgents()
  live.apply(started('fg'))
  assert.equal(live.apply(sys('background_tasks_changed', { tasks: [] })), null)
  assert.equal(live.list().length, 1)
})

test('clearing reports whether there was anything to clear', () => {
  const live = createLiveAgents()
  assert.equal(live.clear(), false)
  live.apply(started('a'))
  assert.equal(live.clear(), true)
  assert.equal(live.list().length, 0)
})

/** A query() whose stream is fed by hand, one message at a time. */
function feedableSdk() {
  const queue = []
  let wake = null
  let closed = false
  const push = (msg) => { queue.push(msg); wake?.() }
  const close = () => { closed = true; wake?.() }
  const start = () => ({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()
        if (closed) return
        await new Promise((r) => { wake = r })
        wake = null
      }
    },
    interrupt: async () => {},
    return: async () => {},
    setPermissionMode: async () => {},
  })
  return { start, push, close }
}

const tick = () => new Promise((r) => setImmediate(r))

test('a managed session publishes its running agents, and drops them when the process ends', async () => {
  const sdk = feedableSdk()
  const agents = createAgentManager({ start: sdk.start })
  const seen = []
  agents.emitter.on('changed', (s) => seen.push(s.agents.length))
  agents.launch({ cwd: '/tmp', prompt: 'look around' })

  sdk.push(started('a'))
  await tick()
  assert.equal(agents.list()[0].agents.length, 1)
  assert.equal(seen.at(-1), 1)

  sdk.close()
  await tick()
  assert.equal(agents.list()[0].agents.length, 0)
  assert.equal(seen.at(-1), 0)
})
