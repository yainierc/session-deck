/**
 * What a batch of transcript lines says about what the session is doing.
 *
 * The live path reads a few lines at a time, so most batches say nothing about
 * it at all. That has to be distinguishable from "it finished and spoke", or
 * the panel has to choose between blinking the indicator off between file
 * events and never clearing it — and it used to choose never, leaving a
 * finished session showing the tool it ran an hour ago.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTranscript, tailTranscript, normalizeLine } from '../src/transcripts.js'

const ASSISTANT_TOOL = {
  type: 'assistant',
  uuid: 'a1',
  timestamp: '2026-09-14T20:30:00.000Z',
  message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
}

const ASSISTANT_TEXT = {
  type: 'assistant',
  uuid: 'a2',
  timestamp: '2026-09-14T20:31:00.000Z',
  message: { content: [{ type: 'text', text: 'done, the schema has 14 tables' }] },
}

/** News for the map — the call failed — but nothing about what comes next. */
const FAILED_RESULT = {
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-09-14T20:30:30.000Z',
  message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'no such file' }] },
}

function write(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-')), 'session.jsonl')
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return file
}

test('a whole read reports the tool it stopped on', () => {
  const file = write([ASSISTANT_TOOL])
  assert.equal(readTranscript(file).activity, 'Bash')
})

test('a whole read clears the tool once the session speaks again', () => {
  const file = write([ASSISTANT_TOOL, ASSISTANT_TEXT])
  assert.equal(readTranscript(file).activity, null)
  assert.equal(readTranscript(file).messages.length, 1)
})

test('a live batch says nothing rather than null when it has no news', async () => {
  const file = write([ASSISTANT_TOOL])
  const from = readTranscript(file).size

  const tail = tailTranscript(file, { fromSize: from, intervalMs: 20 })
  const updates = []
  tail.on('update', (update) => updates.push(update))

  // Stopped in a finally, not at the end: a failed assertion that leaves the
  // interval running holds the whole test run open.
  try {
    // A failed call is news — the map draws the cross — but it says nothing
    // about what the session does next, so it must not clear the indicator.
    fs.appendFileSync(file, JSON.stringify(FAILED_RESULT) + '\n')
    await waitFor(() => updates.length >= 1)
    assert.equal(updates[0].activity, undefined, 'no news is not "it stopped"')
    assert.deepEqual(updates[0].failed, ['t1'])

    // Speaking does clear it, and that null is the signal the panel needs.
    fs.appendFileSync(file, JSON.stringify(ASSISTANT_TEXT) + '\n')
    await waitFor(() => updates.length >= 2)
    assert.equal(updates[1].activity, null)
    assert.equal(updates[1].messages.length, 1)
  } finally {
    tail.stop()
  }
})

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve() }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('timed out waiting for the tail'))
      }
    }, 10)
  })
}

/**
 * An attached file in the panel.
 *
 * The content is in front of Claude, where it matters. Printed back in full
 * it buries the sentence you wrote under a whole spec — and a message that
 * was *only* a file would come back empty and be filed as activity, so the
 * panel would show an answer to a question you never appear to have asked.
 */
const USER_WITH_FILE = {
  type: 'user',
  uuid: 'u2',
  timestamp: '2026-09-14T20:32:00.000Z',
  message: {
    content: [
      { type: 'text', text: '<attached-file name="spec.md">\n# Spec\n\nlots and lots of lines\n</attached-file>' },
      { type: 'text', text: 'what is missing here?' },
    ],
  },
}

test('an attached file shows as its name, not as its contents', () => {
  const { messages } = readTranscript(write([USER_WITH_FILE]))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].text, '[spec.md] what is missing here?')
})

test('a file sent with no words is still a message in the panel', () => {
  const only = {
    ...USER_WITH_FILE,
    message: { content: [USER_WITH_FILE.message.content[0]] },
  }
  const { messages } = readTranscript(write([only]))
  assert.equal(messages.length, 1, 'not swallowed as activity')
  assert.equal(messages[0].text, '[spec.md]')
})

/* ---------------------------------------------------------------------------
 * How the session was actually thinking.
 *
 * Neither the effort nor the advisor arrives on the session's startup message,
 * so the panel could set a level and never confirm one, and had no way at all
 * to know whether an advisor was attached. A pairing the API refuses is
 * refused in silence — the request is simply not applied — so a session with
 * no advisor is indistinguishable from one with a good one. Every turn is
 * written down with both, which makes the transcript the only witness.
 * ------------------------------------------------------------------------ */

const turn = (uuid, extra) => ({
  type: 'assistant',
  uuid,
  timestamp: '2026-09-14T20:32:00.000Z',
  message: { content: [{ type: 'text', text: 'ok' }] },
  ...extra,
})

test('a whole read reports the effort and the advisor of the newest turn', () => {
  const file = write([turn('g1', { effort: 'low', advisorModel: 'claude-opus-5' })])
  assert.deepEqual(readTranscript(file).granted, { effort: 'low', advisor: 'claude-opus-5' })
})

test('an advisor that went away is not remembered from an older turn', () => {
  /*
   * The whole point. Merging across turns would keep reporting the advisor
   * from the turn it was last seen on, which is the same failure as the chip
   * showing a request instead of an outcome — arrived at from the other side.
   */
  const file = write([
    turn('g1', { effort: 'high', advisorModel: 'claude-opus-5' }),
    turn('g2', { effort: 'high' }),
  ])
  assert.deepEqual(readTranscript(file).granted, { effort: 'high', advisor: null })
})

test('a session that has not spoken has not said', () => {
  // Not `{ effort: null, advisor: null }`, which would be a claim. A whole-file
  // read of a transcript with no assistant turn in it knows nothing either way.
  const file = write([FAILED_RESULT])
  assert.equal(readTranscript(file).granted, null)
})

test('a live batch with no turn in it says nothing about the advisor', async () => {
  const file = write([ASSISTANT_TOOL])
  const tail = tailTranscript(file, { fromSize: fs.statSync(file).size, intervalMs: 20 })

  const seen = []
  tail.on('update', (update) => seen.push(update))

  // A user line: news for the conversation, nothing about how it is thinking.
  fs.appendFileSync(file, JSON.stringify(FAILED_RESULT) + '\n')
  await new Promise((r) => setTimeout(r, 80))

  // Then a turn, which does say.
  fs.appendFileSync(file, JSON.stringify(turn('g9', { effort: 'max' })) + '\n')
  await new Promise((r) => setTimeout(r, 80))
  tail.stop()

  assert.ok(seen.length >= 2, 'both batches were delivered')
  assert.equal('granted' in seen[0] && seen[0].granted !== undefined, false,
    'the first batch had no turn in it, so it claims nothing')
  assert.deepEqual(seen.at(-1).granted, { effort: 'max', advisor: null })
})


/**
 * The panel's own tool, kept out of the panel.
 *
 * A session ticking off its progress list is not doing a piece of work worth
 * announcing: the list it just wrote is already on screen. Left alone, the
 * activity line would read "working mcp__panel__progress" — the panel
 * reporting its own plumbing back to the person watching it.
 */
function assistantCalling(...tools) {
  return {
    type: 'assistant',
    uuid: 'u1',
    timestamp: '2026-10-13T10:00:00.000Z',
    message: {
      role: 'assistant',
      content: tools.map((name) => ({ type: 'tool_use', id: `t-${name}`, name, input: {} })),
    },
  }
}

test('ticking the progress list is not an activity worth showing', () => {
  assert.equal(normalizeLine(assistantCalling('mcp__panel__progress')), null)
})

test('a turn that ticks a box and starts a build still says it is building', () => {
  // Tools are called in parallel, so the progress call is skipped rather than
  // the search stopping at the first block — otherwise the one visible piece
  // of work in the message would be lost behind the bookkeeping.
  const line = normalizeLine(assistantCalling('mcp__panel__progress', 'Bash'))
  assert.equal(line.role, '_activity')
  assert.equal(line.tool, 'Bash')
})

test('an ordinary tool call is untouched', () => {
  const line = normalizeLine(assistantCalling('Read'))
  assert.equal(line.role, '_activity')
  assert.equal(line.tool, 'Read')
})
