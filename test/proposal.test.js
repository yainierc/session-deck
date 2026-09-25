/**
 * A roadmap drafted from a document somebody already wrote.
 *
 * Two things here matter more than the file handling. The first is that a
 * draft is one record at two points in its life — asked for, then answered —
 * so that a draft in flight is still visible after a restart. The second is
 * that a milestone with no provenance is reported as a fault with its name on
 * it, rather than accepted with an empty field: a draft nobody can check is
 * the exact failure this is built to avoid, and it must not pass quietly.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.SESSION_DECK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-proposal-'))

const proposal = await import('../src/proposal.js')

const PROJECT = '/tmp/some-project'

/** Stand in for the session: replace the seeded file with an answer. */
function answer(projectPath, body) {
  fs.writeFileSync(proposal.proposalFile(projectPath), JSON.stringify(body, null, 2))
}

const GOOD = {
  title: 'Answer whether a subscription was ever drained',
  what: 'Deliver a script that answers it per subscription.',
  why: 'PD-027 success measure, measured 2026-09-25: reads zero and is unreadable.',
  where: 'pipelines/scripts/',
  doneWhen: 'Running it prints a verdict per subscription.',
  watchOut: 'Do not use activeMessageCount as the verdict.',
}

test('a project nobody has asked about has no draft', () => {
  assert.equal(proposal.read('/tmp/never-asked'), null)
})

test('the request is on disk before anybody answers it', () => {
  const opened = proposal.open(PROJECT, { document: 'docs/plan.md', note: 'only track G', deckId: 'abc123' })
  assert.equal(opened.ok, true)

  const draft = proposal.read(PROJECT)
  assert.equal(draft.status, 'drafting')
  assert.equal(draft.document, 'docs/plan.md')
  assert.equal(draft.note, 'only track G')
  assert.equal(draft.deckId, 'abc123')
  // Nothing has been proposed yet, and the draft does not pretend otherwise.
  assert.equal(draft.milestones, undefined)
})

test('the five sections are composed into one task, in order, skipping what is absent', () => {
  const task = proposal.taskFrom({ ...GOOD, where: '' })
  assert.match(task, /^What: /)
  assert.ok(task.includes('Why / provenance: PD-027'))
  assert.ok(!task.includes('Where:'), 'an absent section leaves no empty heading behind')
  assert.ok(task.indexOf('Done when:') < task.indexOf('Watch out:'))
})

test('an answered draft reads as ready, with each milestone composed', () => {
  proposal.open(PROJECT, { document: 'docs/plan.md' })
  answer(PROJECT, { goal: 'Make it observable\n\nWhat this leaves out: the forms.', milestones: [GOOD] })

  const draft = proposal.read(PROJECT)
  assert.equal(draft.status, 'ready')
  assert.equal(draft.milestones.length, 1)
  assert.equal(draft.milestones[0].title, GOOD.title)
  assert.ok(draft.milestones[0].task.includes('Watch out: Do not use'))
  assert.deepEqual(draft.faults, [])
  // The document it came from survives into the answer.
  assert.equal(draft.document, 'docs/plan.md')
})

test('a milestone that cites nothing is named as a fault rather than accepted quietly', () => {
  proposal.open(PROJECT, { document: 'docs/plan.md' })
  answer(PROJECT, {
    goal: 'A goal',
    milestones: [GOOD, { ...GOOD, title: 'Tidy the thing', why: '   ', doneWhen: '' }],
  })

  const draft = proposal.read(PROJECT)
  assert.equal(draft.faults.length, 1)
  assert.match(draft.faults[0], /Milestone 2/)
  assert.match(draft.faults[0], /Tidy the thing/)
  assert.match(draft.faults[0], /why/)
  assert.match(draft.faults[0], /doneWhen/)
  // Reported, not dropped: a person decides what to do about it.
  assert.equal(draft.milestones.length, 2)
  assert.deepEqual(draft.milestones[1].missing, ['why', 'doneWhen'])
})

test('an answer that is not JSON leaves the draft where it was, not gone', () => {
  proposal.open(PROJECT, { document: 'docs/plan.md' })
  fs.writeFileSync(proposal.proposalFile(PROJECT), 'not json {{{')

  // The session wrote rubbish. What was asked for is still true, and still
  // on screen — losing the request because the answer was bad would lose the
  // one thing the session cannot give back.
  const draft = proposal.read(PROJECT)
  assert.equal(draft.status, 'drafting')
  assert.equal(draft.document, 'docs/plan.md')
})

test('an answer nobody asked for is not a draft', () => {
  proposal.clear(PROJECT)
  fs.writeFileSync(proposal.proposalFile(PROJECT), JSON.stringify({ goal: 'g', milestones: [GOOD] }))
  // Left behind by a draft that was discarded mid-flight. Offering it would
  // be offering work that was already refused.
  assert.equal(proposal.read(PROJECT), null)
  proposal.clear(PROJECT)
})

test('asking again clears the answer to the question before it', () => {
  proposal.open(PROJECT, { document: 'docs/old.md' })
  answer(PROJECT, { goal: 'stale', milestones: [GOOD] })
  assert.equal(proposal.read(PROJECT).status, 'ready')

  proposal.open(PROJECT, { document: 'docs/new.md' })
  const draft = proposal.read(PROJECT)
  assert.equal(draft.status, 'drafting', 'the old answer must not read as an answer to the new question')
  assert.equal(draft.document, 'docs/new.md')
})

test('discarding a draft leaves nothing behind', () => {
  proposal.open(PROJECT, { document: 'docs/plan.md' })
  proposal.clear(PROJECT)
  assert.equal(proposal.read(PROJECT), null)
  // And doing it twice is not an error.
  assert.equal(proposal.clear(PROJECT).ok, true)
})

test('two projects do not share a draft', () => {
  proposal.open(PROJECT, { document: 'docs/a.md' })
  proposal.open('/tmp/other-project', { document: 'docs/b.md' })
  assert.equal(proposal.read(PROJECT).document, 'docs/a.md')
  assert.equal(proposal.read('/tmp/other-project').document, 'docs/b.md')
  proposal.clear('/tmp/other-project')
})

test('the prompt names the document, the file to write and the note', () => {
  const prompt = proposal.promptFor({
    document: 'docs/implementation-plan/demo-readiness.md',
    note: 'only the observability track',
    file: '/tmp/deck/proposals/abc.json',
    project: 'GITHUB-Platform',
  })

  assert.ok(prompt.includes('docs/implementation-plan/demo-readiness.md'))
  assert.ok(prompt.includes('/tmp/deck/proposals/abc.json'))
  assert.ok(prompt.includes('only the observability track'))
  assert.ok(prompt.includes('GITHUB-Platform'))
  // The two rules the whole design rests on are stated, not implied.
  assert.match(prompt, /LEAVE THAT MILESTONE OUT/)
  assert.match(prompt, /does NOT cover/)
})

test('a prompt with no note does not invent a section for it', () => {
  const prompt = proposal.promptFor({ document: 'd.md', file: 'f.json', project: 'p' })
  assert.ok(!prompt.includes('From the person who asked'))
})
