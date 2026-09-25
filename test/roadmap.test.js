/**
 * A project's roadmaps.
 *
 * Two things here are worth testing more than the CRUD: that the state of a
 * roadmap is read off its milestones rather than stored (so it cannot
 * contradict them), and that the single-roadmap file the first version wrote
 * still opens. The second one is somebody's plan.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.SESSION_DECK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-roadmap-'))

const roadmap = await import('../src/roadmap.js')

const PROJECT = '/tmp/some-project'

/** The one roadmap a test just made, with a fresh read of it. */
function only(projectPath = PROJECT) {
  const { roadmaps } = roadmap.list(projectPath)
  assert.equal(roadmaps.length, 1, 'this helper is for tests with one roadmap')
  return roadmaps[0]
}

function milestones(id, projectPath = PROJECT) {
  return roadmap.get(projectPath, id).milestones
}

function titles(id, projectPath = PROJECT) {
  return milestones(id, projectPath).map((m) => m.title)
}

test('a project with no roadmaps has none, and nothing to open', () => {
  assert.deepEqual(roadmap.list('/tmp/never-touched').roadmaps, [])
  assert.equal(roadmap.get('/tmp/never-touched'), null)
})

test('a new roadmap is planned, and is what opens by default', () => {
  const made = roadmap.create(PROJECT, { goal: 'The deck runs a roadmap on its own' })
  assert.equal(made.ok, true)
  assert.equal(made.roadmap.state, 'planned')
  assert.equal(made.roadmap.landing, 'merge-per-milestone')

  const open = roadmap.get(PROJECT)
  assert.equal(open.id, made.roadmap.id)
  assert.equal(open.label, 'The deck runs a roadmap on its own', 'the first line of the goal is its name')
})

test('milestones keep the order they were added in', () => {
  const { id } = only()
  roadmap.add(PROJECT, id, { title: 'Roadmap screen', task: 'build the panel' })
  roadmap.add(PROJECT, id, { title: 'Start a milestone', task: 'worktree and branch' })
  roadmap.add(PROJECT, id, { title: 'Land the work', task: 'merge or PR' })
  assert.deepEqual(titles(id), ['Roadmap screen', 'Start a milestone', 'Land the work'])
})

test('moving a milestone moves it, and off the end does nothing rather than erroring', () => {
  const { id } = only()
  const last = milestones(id)[2].id
  assert.equal(roadmap.move(PROJECT, id, last, -2).ok, true)
  assert.deepEqual(titles(id), ['Land the work', 'Roadmap screen', 'Start a milestone'])

  const first = milestones(id)[0].id
  assert.equal(roadmap.move(PROJECT, id, first, -1).ok, true, 'refusing is worse than doing nothing')
  assert.deepEqual(titles(id), ['Land the work', 'Roadmap screen', 'Start a milestone'])

  roadmap.move(PROJECT, id, last, 2)
  assert.deepEqual(titles(id), ['Roadmap screen', 'Start a milestone', 'Land the work'])
})

/*
 * The state is read, not stored, so it cannot disagree with the milestones.
 * Marking one done by hand counts as having touched the roadmap, because
 * that is a perfectly ordinary way to use this — no worktree involved.
 */
test('a roadmap becomes in progress the moment a milestone is touched', () => {
  const { id } = only()
  assert.equal(only().state, 'planned')

  const first = milestones(id)[0].id
  roadmap.update(PROJECT, id, first, { status: 'done' })
  assert.equal(only().state, 'in-progress')

  roadmap.update(PROJECT, id, first, { status: 'todo' })
  assert.equal(only().state, 'planned', 'and back, because it is read every time')
})

test('finishing with a roadmap is a decision, not a count of done milestones', () => {
  const { id } = only()
  assert.equal(roadmap.complete(PROJECT, id).ok, true)
  assert.equal(only().state, 'completed')
  assert.ok(only().completedAt > 0)

  // Even with milestones left undone: a roadmap you are abandoning is
  // finished with too.
  assert.ok(milestones(id).some((m) => m.status !== 'done'))

  assert.equal(roadmap.reopen(PROJECT, id).ok, true)
  assert.equal(only().state, 'planned')
})

test('a completed roadmap is never what opens by default', () => {
  const { id } = only()
  roadmap.complete(PROJECT, id)
  assert.equal(roadmap.get(PROJECT), null, 'nothing left in flight or waiting')

  const second = roadmap.create(PROJECT, { goal: 'The next one' })
  assert.equal(roadmap.get(PROJECT).id, second.roadmap.id)

  // Ordered the way you read them: in flight, waiting, then the archive.
  assert.deepEqual(roadmap.list(PROJECT).roadmaps.map((r) => r.state), ['planned', 'completed'])

  roadmap.remove(PROJECT, second.roadmap.id)
  roadmap.reopen(PROJECT, id)
})

test('a milestone needs a title', () => {
  const { id } = only()
  assert.equal(roadmap.add(PROJECT, id, { title: '   ', task: 'something' }).ok, false)
  assert.equal(titles(id).length, 3)
  assert.equal(roadmap.update(PROJECT, id, milestones(id)[0].id, { title: '' }).ok, false)
})

test('status only moves between the ones that exist', () => {
  const { id } = only()
  const first = milestones(id)[0].id
  assert.equal(roadmap.update(PROJECT, id, first, { status: 'doing' }).ok, true)
  assert.equal(milestones(id)[0].status, 'doing')
  assert.equal(roadmap.update(PROJECT, id, first, { status: 'shipped' }).ok, false)
  assert.equal(milestones(id)[0].status, 'doing')
  roadmap.update(PROJECT, id, first, { status: 'todo' })
})

/*
 * Whatever runs these owns the branch, the worktree and the session. A
 * roadmap that could be told from a browser that a milestone ran on a branch
 * is a roadmap that can claim work nobody did.
 */
test('the fields the runner owns cannot be written from outside', () => {
  const { id } = only()
  const first = milestones(id)[0].id
  roadmap.update(PROJECT, id, first, {
    branch: 'roadmap/made-up',
    worktree: '/tmp/made-up',
    sessionId: '11111111-2222-3333-4444-555555555555',
    finishedAt: 1,
  })
  const m = milestones(id)[0]
  assert.equal(m.branch, null)
  assert.equal(m.worktree, null)
  assert.equal(m.sessionId, null)
  assert.equal(m.finishedAt, null)
})

test('begin and attachSession are the writers that can', () => {
  const { id } = only()
  const first = milestones(id)[0].id

  roadmap.begin(PROJECT, id, first, { branch: 'roadmap/x', worktree: '/tmp/x', base: 'master@abc1234' })
  let m = milestones(id)[0]
  assert.equal(m.branch, 'roadmap/x')
  assert.equal(m.base, 'master@abc1234')
  assert.equal(m.status, 'doing', 'started is in progress')

  roadmap.attachSession(PROJECT, id, first, { deckId: 'deck1' })
  roadmap.attachSession(PROJECT, id, first, { sessionId: '11111111-2222-3333-4444-555555555555' })
  m = milestones(id)[0]
  assert.equal(m.deckId, 'deck1', 'the deck id survives learning the session id')
  assert.equal(m.sessionId, '11111111-2222-3333-4444-555555555555')

  roadmap.detach(PROJECT, id, first)
  m = milestones(id)[0]
  assert.equal(m.branch, null)
  assert.equal(m.worktree, null)
  roadmap.update(PROJECT, id, first, { status: 'todo' })
})

test('the landing strategy is one of the two, and it persists', () => {
  const { id } = only()
  assert.equal(roadmap.setLanding(PROJECT, id, 'one-pr').ok, true)
  assert.equal(only().landing, 'one-pr')
  assert.equal(roadmap.setLanding(PROJECT, id, 'rebase-and-pray').ok, false)
  assert.equal(only().landing, 'one-pr')
  roadmap.setLanding(PROJECT, id, 'merge-per-milestone')
})

test('a roadmap with no goal still has a name', () => {
  const made = roadmap.create('/tmp/nameless', {})
  assert.equal(made.roadmap.label, 'Empty roadmap')
  roadmap.add('/tmp/nameless', made.roadmap.id, { title: 'Something', task: '' })
  assert.equal(roadmap.list('/tmp/nameless').roadmaps[0].label, '1 milestone, no goal written')
})

test('writes to a roadmap that is not there are refused, not invented', () => {
  assert.equal(roadmap.add(PROJECT, 'nosuch', { title: 'x' }).ok, false)
  assert.equal(roadmap.complete(PROJECT, 'nosuch').ok, false)
  assert.equal(roadmap.setGoal(PROJECT, 'nosuch', 'x').ok, false)
  assert.equal(roadmap.remove(PROJECT, 'nosuch').ok, false)
})

test('roadmaps are per project and survive a reread from disk', () => {
  const other = roadmap.create('/tmp/other-project', { goal: 'Another thing' })
  assert.deepEqual(titles(only().id), ['Roadmap screen', 'Start a milestone', 'Land the work'])
  assert.equal(roadmap.list('/tmp/other-project').roadmaps[0].label, 'Another thing')

  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.SESSION_DECK_DIR, 'roadmaps.json'), 'utf8'))
  assert.ok(onDisk.roadmaps[PROJECT].items.length >= 1)
  roadmap.remove('/tmp/other-project', other.roadmap.id)
})

/*
 * The same project answers to more than one path: /var is a symlink to
 * /private/var on macOS, home directories get symlinked, and a caller can
 * always pass either spelling. Keyed by the spelling, one project ends up
 * with two sets of roadmaps and neither of them looks wrong.
 */
test('a project reached by two paths has one set of roadmaps, not two', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-real-'))
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-link-')), 'project')
  fs.symlinkSync(real, link)

  roadmap.create(link, { goal: 'Written through the symlink' })
  assert.equal(roadmap.list(real).roadmaps.length, 1)

  roadmap.create(real, { goal: 'Written through the real path' })
  // Sorted here rather than compared in order: both were created in the same
  // millisecond, so which of them is "newest" is a coin toss and not
  // something this test is about.
  assert.deepEqual(
    roadmap.list(link).roadmaps.map((r) => r.label).sort(),
    ['Written through the real path', 'Written through the symlink'],
  )

  const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(process.env.SESSION_DECK_DIR, 'roadmaps.json'), 'utf8')).roadmaps)
  assert.equal(keys.filter((k) => k.includes('deck-real-') || k.includes('deck-link-')).length, 1)
})

/*
 * The first version of this file kept one roadmap per project. Somebody's
 * plan is in that shape, so it has to open — and it has to keep its goal, its
 * milestones and its landing choice, not just its existence.
 */
test('a roadmap written in the one-per-project shape still opens', () => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-legacy-'))
  const store = path.join(process.env.SESSION_DECK_DIR, 'roadmaps.json')
  const data = JSON.parse(fs.readFileSync(store, 'utf8'))

  data.roadmaps[fs.realpathSync(legacy)] = {
    path: fs.realpathSync(legacy),
    goal: 'The deck runs a roadmap on its own',
    landing: 'one-pr',
    updatedAt: 1758000000000,
    milestones: [
      { id: 'aaaa1111', title: 'Create worktree and branch', task: 'the first thing', status: 'done', branch: 'roadmap/create-worktree-and-branch', worktree: '/tmp/gone', base: 'master@abc', note: '', deckId: null, sessionId: null, startedAt: 1, finishedAt: null },
      { id: 'bbbb2222', title: 'Launch the session', task: 'the second thing', status: 'todo', branch: null, worktree: null, base: null, note: '', deckId: null, sessionId: null, startedAt: null, finishedAt: null },
    ],
  }
  fs.writeFileSync(store, JSON.stringify(data, null, 2) + '\n')

  const open = roadmap.get(legacy)
  assert.ok(open, 'it opens')
  assert.equal(open.goal, 'The deck runs a roadmap on its own')
  assert.equal(open.landing, 'one-pr', 'its landing choice survives')
  assert.equal(open.state, 'in-progress', 'and its state is read from what it holds')
  assert.deepEqual(open.milestones.map((m) => m.title), ['Create worktree and branch', 'Launch the session'])

  // And it is writable afterwards, which is the part a migration usually gets
  // wrong: reading the old shape is easy, saving over it is where it breaks.
  assert.equal(roadmap.add(legacy, open.id, { title: 'A third one', task: '' }).ok, true)
  assert.equal(roadmap.get(legacy, open.id).milestones.length, 3)
  assert.equal(roadmap.list(legacy).roadmaps.length, 1, 'still one roadmap, not two')
})
