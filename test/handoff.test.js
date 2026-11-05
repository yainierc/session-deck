/**
 * Surviving a restart.
 *
 * The deck's sessions are children of its process, so updating the tool used
 * to end them for good: the conversation stayed on disk but the only thing
 * that knew which conversation belonged to which panel entry was a Map in
 * memory. These tests cover the two halves of the fix — the record written
 * down, and a session that comes back without a process and gets one when you
 * speak to it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-handoff-'))
process.env.SESSION_DECK_DIR = scratch

const handoff = await import('../src/handoff.js')
const { createAgentManager } = await import('../src/agent.js')

/**
 * A query() that spawns nothing, records the options it was handed, and stays
 * open the way a real session does between turns.
 */
function stubSdk() {
  const calls = []
  const start = ({ options }) => {
    calls.push(options)
    return {
      async *[Symbol.asyncIterator]() { await new Promise(() => {}) },
      interrupt: async () => {},
      return: async () => {},
      setPermissionMode: async () => {},
    }
  }
  return { start, calls }
}

test('a session with no id is not worth remembering', () => {
  // Nothing was written to disk under that id, so there is nothing to resume
  // into: offering it back would be offering an empty conversation.
  handoff.remember([{ deckId: 'a1', sessionId: null, cwd: scratch, status: 'working' }])
  assert.deepEqual(handoff.read(), [])
})

test('a stopped session does not come back', () => {
  handoff.remember([
    { deckId: 'a1', sessionId: 'f1', cwd: scratch, status: 'done', title: 'over' },
    { deckId: 'a2', sessionId: 'f2', cwd: scratch, status: 'detached', title: 'kept' },
  ])
  const records = handoff.read()
  assert.equal(records.length, 1)
  assert.equal(records[0].title, 'kept')
})

test('a record pointing at a folder that is gone is dropped', () => {
  const gone = path.join(scratch, 'worktree-that-was-removed')
  handoff.remember([{ deckId: 'a3', sessionId: 'f3', cwd: gone, status: 'detached' }])
  assert.deepEqual(handoff.read(), [])
})

test('one conversation never comes back as two entries', () => {
  handoff.remember([
    { deckId: 'a4', sessionId: 'same', cwd: scratch, status: 'idle' },
    { deckId: 'a5', sessionId: 'same', cwd: scratch, status: 'idle' },
  ])
  assert.equal(handoff.read().length, 1)
})

test('adopting a session starts nothing until you speak to it', () => {
  const { start, calls } = stubSdk()
  const agents = createAgentManager({ start })

  const { ok, deckId } = agents.adopt({ sessionId: 'abc-123', cwd: scratch, name: 'yesterday' })
  assert.equal(ok, true)

  // The whole point of resuming lazily: a restart with five sessions must not
  // reload five conversations nobody asked to see.
  assert.equal(calls.length, 0)

  const view = agents.list()[0]
  assert.equal(view.status, 'detached')
  assert.equal(view.detached, true)
  assert.equal(view.sessionId, 'abc-123')
  assert.equal(view.title, 'yesterday')

  // Now speak to it. That is what buys the process.
  const said = agents.say(deckId, 'carry on where we left off')
  assert.equal(said.ok, true)
  assert.equal(said.resumed, true)
  assert.equal(calls.length, 1)

  /*
   * The line the entire feature rests on. Without `resume` this is a brand new
   * conversation wearing an old name; with `forkSession` it would be a copy,
   * writing to a second transcript while the panel streams the first.
   */
  assert.equal(calls[0].resume, 'abc-123')
  assert.ok(!calls[0].forkSession)
  assert.equal(calls[0].cwd, scratch)
  assert.equal(agents.list()[0].status, 'working')
})

test('the same conversation is not adopted twice', () => {
  const { start } = stubSdk()
  const agents = createAgentManager({ start })
  const first = agents.adopt({ sessionId: 'dup', cwd: scratch })
  const second = agents.adopt({ sessionId: 'dup', cwd: scratch })
  assert.equal(second.already, true)
  assert.equal(second.deckId, first.deckId)
  assert.equal(agents.list().length, 1)
})

test('a suspended session stays on the list, resumable', async () => {
  const { start, calls } = stubSdk()
  const agents = createAgentManager({ start })
  const { deckId } = agents.launch({ cwd: scratch, prompt: 'do the thing' })

  // It needs an id before it can be resumed by one; a real session learns it
  // from the SDK's init message a beat after launch.
  assert.equal(calls.length, 1)

  await agents.suspend(deckId, { grace: 10 })

  const view = agents.list()[0]
  assert.equal(view.status, 'detached')
  // Still listed, and still the same panel entry: this is what tells the
  // handoff file to keep it, and what stops the restart from looking like a
  // session that ended.
  assert.equal(view.deckId, deckId)
})

test('a suspended session is woken by the next message, not left dead', async () => {
  const { start, calls } = stubSdk()
  const agents = createAgentManager({ start })
  const { deckId } = agents.launch({ cwd: scratch, prompt: 'first' })
  await agents.suspend(deckId, { grace: 10 })

  /*
   * The input stream a session was launched with is closed by the suspend, and
   * a closed stream is closed for good. Reusing it would hand the CLI a prompt
   * iterable that ends immediately, which reads as "this conversation is
   * over" — the session would spawn and exit without saying anything.
   */
  const said = agents.say(deckId, 'second')
  assert.equal(said.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(agents.list()[0].status, 'working')
})

test('choosing a mode before waking a session is not an error', () => {
  const { start } = stubSdk()
  const agents = createAgentManager({ start })
  const { deckId } = agents.adopt({ sessionId: 'mode-me', cwd: scratch })

  // There is no process to tell, but deciding how much it may do before you
  // let it start doing it is the sensible order — so it is recorded, and used
  // when it wakes.
  return agents.setMode(deckId, 'acceptEdits').then((r) => {
    assert.equal(r.ok, true)
    assert.equal(agents.list()[0].permissionMode, 'acceptEdits')
  })
})

test('letting go of a detached session ends it without a process to end', async () => {
  const { start } = stubSdk()
  const agents = createAgentManager({ start })
  const { deckId } = agents.adopt({ sessionId: 'drop-me', cwd: scratch })

  const result = await agents.stop(deckId)
  assert.equal(result.ok, true)
  assert.equal(agents.list()[0].status, 'done')

  // And 'done' is exactly what keeps it out of the next handoff.
  handoff.remember(agents.list())
  assert.equal(handoff.read().find((r) => r.sessionId === 'drop-me'), undefined)
})

test('a turn in flight is given the chance to finish before the deck goes', async () => {
  const { start } = stubSdk()
  const agents = createAgentManager({ start })
  const { deckId } = agents.launch({ cwd: scratch, prompt: 'a long one' })

  let settled = false
  const suspending = agents.suspend(deckId, { grace: 400 }).then(() => { settled = true })

  // Still working, so the suspend is waiting rather than cutting.
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(settled, false, 'suspend must not cut a turn that is still running')

  await suspending
  assert.equal(agents.list()[0].status, 'detached')
})

test('how a session was asked to think survives the restart too', () => {
  handoff.remember([{
    deckId: 'h1',
    sessionId: 'think-me',
    cwd: scratch,
    status: 'working',
    title: 'backend',
    model: 'sonnet',
    /*
     * The asked-for values, because there are no others: a session reports
     * back neither its effort nor its advisor, so there is no granted version
     * to prefer. Without these, waking one after a restart would start a
     * cheaper session wearing its name, and nothing on screen would say so.
     */
    requestedEffort: 'xhigh',
    requestedAdvisor: 'opus',
  }])

  const [record] = handoff.read().filter((r) => r.sessionId === 'think-me')
  assert.equal(record.model, 'sonnet')
  assert.equal(record.effort, 'xhigh')
  assert.equal(record.advisor, 'opus')
})

/**
 * The progress list across a restart.
 *
 * The session does not know the deck went down, so it will not re-send its
 * plan unasked: this file is the only thing that can put the strip back the
 * way it was. And it is a file, so it is also the place a bad shape can enter
 * from — which is why the round trip is asserted in both directions.
 */
test('the progress list survives the restart that the session slept through', () => {
  handoff.remember([
    {
      deckId: 'p1',
      sessionId: 's-progress',
      cwd: scratch,
      title: 'mid-task',
      status: 'working',
      todos: [
        { text: 'Mapped the service', status: 'completed' },
        { text: 'Writing the tool', status: 'in_progress' },
        { text: 'Draw the strip', status: 'pending' },
      ],
    },
  ])

  const [record] = handoff.read().filter((r) => r.deckId === 'p1')
  assert.deepEqual(record.todos, [
    { text: 'Mapped the service', status: 'completed' },
    { text: 'Writing the tool', status: 'in_progress' },
    { text: 'Draw the strip', status: 'pending' },
  ])
})

test('a record from an older deck, with no list, reads as an empty one', () => {
  // Every record written before this feature existed looks like this. None of
  // them may come back as `undefined`, which the strip would try to render.
  handoff.remember([
    { deckId: 'p2', sessionId: 's-old', cwd: scratch, title: 'older', status: 'idle' },
  ])
  const [record] = handoff.read().filter((r) => r.deckId === 'p2')
  assert.deepEqual(record.todos, [])
})

test('a hand-edited file cannot put nonsense on the screen', () => {
  handoff.remember([
    {
      deckId: 'p3',
      sessionId: 's-junk',
      cwd: scratch,
      title: 'junk',
      status: 'idle',
      todos: [{ text: 'Real step', status: 'completed' }, 'not an object', { status: 'pending' }],
    },
  ])
  const [record] = handoff.read().filter((r) => r.deckId === 'p3')
  assert.deepEqual(record.todos, [{ text: 'Real step', status: 'completed' }])
})
