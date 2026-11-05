/**
 * The progress list.
 *
 * Two things are being protected here. One is that the list is bounded
 * wherever it comes from: the tool's schema checks what the session sends,
 * but the same shape comes back out of handoff.json after a restart, and
 * that file is a file — editable, truncatable, and possibly written by an
 * older deck. The other is that the list the session sends *replaces* the
 * one before it. A protocol that merged would drift the moment a model
 * renumbered its own plan, and the drift would show up as a panel confidently
 * reporting the wrong step.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanTodos,
  countTodos,
  progressTool,
  MAX_ITEMS,
  MAX_TEXT,
  PROGRESS_TOOL,
} from '../src/progress.js'

test('a list from the session survives as itself', () => {
  const todos = cleanTodos([
    { text: 'Read how the deck spawns a session', status: 'completed' },
    { text: 'Add the tool', status: 'in_progress' },
    { text: 'Draw the strip', status: 'pending' },
  ])
  assert.equal(todos.length, 3)
  assert.deepEqual(countTodos(todos), { done: 1, total: 3 })
})

test('nothing usable gives an empty list rather than throwing', () => {
  // Every one of these is something handoff.json could hold after a bad
  // write or an older version of the deck.
  for (const bad of [null, undefined, 'items', 42, {}, [null], [42], [{}]]) {
    assert.deepEqual(cleanTodos(bad), [], `${JSON.stringify(bad)}`)
  }
})

test('a step with no text is dropped, a step with no status is kept', () => {
  const todos = cleanTodos([
    { text: '   ', status: 'completed' },
    { text: 'Ship it', status: 'nonsense' },
  ])
  // The empty one would have been a bullet with nothing beside it. The one
  // with an unreadable status is still a step the session said it had, and
  // dropping it would make the total — the one number the folded strip shows
  // — disagree with the plan.
  assert.deepEqual(todos, [{ text: 'Ship it', status: 'pending' }])
})

test('a step cannot be long enough to push the composer off the screen', () => {
  const [todo] = cleanTodos([{ text: 'x'.repeat(MAX_TEXT + 500), status: 'pending' }])
  assert.equal(todo.text.length, MAX_TEXT)
})

test('newlines in a step collapse, so one step stays one row', () => {
  const [todo] = cleanTodos([{ text: 'Read\n\n  the  spec', status: 'pending' }])
  assert.equal(todo.text, 'Read the spec')
})

test('a plan longer than the cap is cut, not refused', () => {
  const many = Array.from({ length: MAX_ITEMS + 20 }, (_, i) => ({
    text: `step ${i}`,
    status: 'pending',
  }))
  assert.equal(cleanTodos(many).length, MAX_ITEMS)
})

test('the tool hands over the list and answers with the count', async () => {
  const seen = []
  const tool = progressTool((todos) => seen.push(todos))

  const first = await tool.handler({
    items: [
      { text: 'One', status: 'completed' },
      { text: 'Two', status: 'in_progress' },
    ],
  })
  assert.equal(first.content[0].text, 'ok (1/2)')
  assert.equal(seen.length, 1)

  // The second call replaces the first. This is the whole contract: if these
  // merged, a session that dropped a step would keep it forever.
  await tool.handler({ items: [{ text: 'Only this one', status: 'completed' }] })
  assert.deepEqual(seen[1], [{ text: 'Only this one', status: 'completed' }])
})

test('the tool is addressed by the name the rest of the deck hides', () => {
  // transcripts.js keeps this exact string out of the activity line and
  // agent.js auto-allows it. A rename that only landed in one of the three
  // would start raising a permission card per tick.
  assert.equal(PROGRESS_TOOL, 'mcp__panel__progress')
})
