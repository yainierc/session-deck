/**
 * Starting a milestone against a real repository.
 *
 * These drive git for real rather than faking it: the whole value of this
 * slice is that the worktree is actually there afterwards, and a mocked
 * `worktree add` would prove nothing about that. Everything happens in a
 * throwaway repo under the system temp directory.
 *
 * What is worth testing here is not the happy path — it is that a failure
 * leaves the roadmap exactly as it was. A milestone that claims a branch
 * nobody created is worse than one that failed to start.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.SESSION_DECK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-runner-'))

const roadmap = await import('../src/roadmap.js')
const {
  startMilestone, runMilestone, promptFor, cleanupPlan, completeRoadmap,
  worktreeRoot, takenNames, startedButGone,
} = await import('../src/roadmap-runner.js')

function run(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** A repository with one commit, which is the least a branch can come from. */
function repo({ commit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-repo-'))
  run(dir, ['init', '-b', 'master'])
  run(dir, ['config', 'user.email', 'deck@example.com'])
  run(dir, ['config', 'user.name', 'deck'])
  if (commit) {
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
    run(dir, ['add', '.'])
    run(dir, ['commit', '-m', 'first'])
  }
  return dir
}

/** A project with one roadmap, which is what these tests all want. */
function plan(projectPath, goal = '') {
  return roadmap.create(projectPath, { goal }).roadmap.id
}

function only(projectPath, roadmapId) {
  return roadmap.get(projectPath, roadmapId).milestones[0]
}

test('a title becomes a branch name a human can read', () => {
  assert.equal(roadmap.slugFor('Create worktree and branch per milestone'), 'create-worktree-and-branch-per-milestone')
  // The accented Spanish input below is deliberate: it pins the
  // accent-stripping behaviour of the slug function. Do not "clean it up"
  // into English — the accents and the ñ are the thing under test.
  assert.equal(roadmap.slugFor('Añadir métricas (v2)'), 'anadir-metricas-v2')
  assert.equal(roadmap.slugFor('  ...  '), 'milestone')
  assert.ok(roadmap.slugFor('x'.repeat(200)).length <= 40)
})

test('starting a milestone creates the worktree and the branch, and records both', async () => {
  const project = repo()
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'Create worktree and branch per milestone', task: 'the first slice' })
  const id = only(project, rid).id

  const started = await startMilestone(project, rid, id)
  assert.equal(started.ok, true, started.error)
  assert.equal(started.branch, 'roadmap/create-worktree-and-branch-per-milestone')

  const expected = path.join(worktreeRoot(project), 'create-worktree-and-branch-per-milestone')
  assert.equal(started.worktree, expected)
  assert.ok(fs.existsSync(path.join(expected, 'README.md')), 'the worktree has the repository in it')

  const branches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: project, encoding: 'utf8' })
  assert.match(branches, /roadmap\/create-worktree-and-branch-per-milestone/)

  const milestone = only(project, rid)
  assert.equal(milestone.branch, 'roadmap/create-worktree-and-branch-per-milestone')
  assert.equal(milestone.worktree, expected)
  assert.equal(milestone.status, 'doing', 'started is in progress')
  assert.match(milestone.base, /^master@[0-9a-f]+$/, 'what it was branched from is recorded')
  assert.ok(milestone.startedAt > 0)
})

test('starting the same milestone twice refuses, and says where the first one is', async () => {
  const project = repo()
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'Only once', task: '' })
  const id = only(project, rid).id

  assert.equal((await startMilestone(project, rid, id)).ok, true)
  const again = await startMilestone(project, rid, id)
  assert.equal(again.ok, false)
  assert.match(again.error, /Already started in .*only-once/)
})

/*
 * Two milestones with the same title, or a branch of that name already in the
 * repository, is the case the id is held in reserve for.
 */
test('a name already taken falls back to the milestone id', async () => {
  const project = repo()
  const rid = plan(project)
  run(project, ['branch', 'roadmap/same-name'])
  roadmap.add(project, rid, { title: 'Same name', task: '' })
  const id = only(project, rid).id

  const taken = await takenNames(project)
  assert.ok(taken.has('roadmap/same-name'))
  assert.deepEqual(roadmap.plannedNames(only(project, rid), taken), {
    branch: `roadmap/same-name-${id}`,
    name: `same-name-${id}`,
  })

  const started = await startMilestone(project, rid, id)
  assert.equal(started.ok, true, started.error)
  assert.equal(started.branch, `roadmap/same-name-${id}`)
})

test('a folder that is not a repository is said plainly', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plain-'))
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'No git', task: '' })
  const started = await startMilestone(project, rid, only(project, rid).id)
  assert.equal(started.ok, false)
  assert.match(started.error, /not a git repository/)
  assert.equal(only(project, rid).worktree, null, 'the roadmap is untouched')
})

test('a repository with no commits has nothing to branch from, and says so', async () => {
  const project = repo({ commit: false })
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'No commits', task: '' })
  const started = await startMilestone(project, rid, only(project, rid).id)
  assert.equal(started.ok, false)
  assert.match(started.error, /no commits yet/)
  assert.equal(only(project, rid).worktree, null)
})

/*
 * Git first, state second. When `worktree add` fails, the roadmap must look
 * exactly as it did — otherwise the panel shows a branch that does not exist
 * and the next Start refuses for the wrong reason.
 */
test('when git fails, the roadmap is not written at all', async () => {
  const project = repo()
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'Git fails', task: '' })
  const id = only(project, rid).id

  const started = await startMilestone(project, rid, id, {
    run: async (cwd, args) => {
      if (args[0] === 'worktree') return { ok: false, error: 'fatal: invalid reference: HEAD' }
      if (args[0] === 'rev-parse' && args[1] === '--short') return { ok: true, out: 'abc1234' }
      if (args[0] === 'rev-parse') return { ok: true, out: '.git' }
      return { ok: true, out: '' }
    },
  })

  assert.equal(started.ok, false)
  assert.match(started.error, /invalid reference/)
  const milestone = only(project, rid)
  assert.equal(milestone.branch, null)
  assert.equal(milestone.worktree, null)
  assert.equal(milestone.status, 'todo')
  assert.equal(milestone.startedAt, null)
})

test('a milestone that is not there cannot be started', async () => {
  const project = repo()
  const rid = plan(project)
  const started = await startMilestone(project, rid, 'nosuch1')
  assert.equal(started.ok, false)
  assert.match(started.error, /No such milestone/)
})

test('a directory already in the way is never landed on', async () => {
  const project = repo()
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'Obstacle', task: '' })
  fs.mkdirSync(path.join(worktreeRoot(project), 'obstacle'), { recursive: true })

  let ran = false
  const started = await startMilestone(project, rid, only(project, rid).id, {
    run: async (cwd, args) => {
      if (args[0] === 'worktree') { ran = true; return { ok: true, out: '' } }
      if (args[0] === 'rev-parse' && args[1] === '--short') return { ok: true, out: 'abc1234' }
      if (args[0] === 'rev-parse') return { ok: true, out: '.git' }
      // The directory is in `takenNames`, so the name moves on to the id —
      // which is why this test builds the collision by path, not by name.
      return { ok: true, out: '' }
    },
  })

  // The name check sees the directory and picks the id-suffixed one instead,
  // so this succeeds — the point being that it never lands on a path that
  // already has something in it.
  assert.equal(started.ok, true, started.error)
  assert.equal(ran, true)
  assert.match(started.worktree, new RegExp(`obstacle-${only(project, rid).id}$`))
})

/*
 * Deleting a worktree leaves its branch behind, so the two questions a
 * restart has to answer are "is the directory there" and "is the branch
 * still there" — and the answers lead to different git commands.
 */
test('a worktree deleted behind the deck is reported gone, not as work in hand', async () => {
  const project = repo()
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'The worktree was deleted', task: '' })
  const id = only(project, rid).id
  await startMilestone(project, rid, id)

  assert.equal(startedButGone(only(project, rid)), false)
  run(project, ['worktree', 'remove', only(project, rid).worktree])
  assert.equal(startedButGone(only(project, rid)), true)
})

test('starting again checks the same branch back out instead of making a second one', async () => {
  const project = repo()
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'The branch comes back', task: '' })
  const id = only(project, rid).id

  const first = await startMilestone(project, rid, id)
  const branch = first.branch
  const where = first.worktree

  // Some work on the branch, so abandoning it would be a real loss.
  fs.writeFileSync(path.join(where, 'work.txt'), 'work in progress\n')
  run(where, ['add', '.'])
  run(where, ['commit', '-m', 'work on the milestone branch'])
  const onBranch = execFileSync('git', ['rev-parse', branch], { cwd: project, encoding: 'utf8' }).trim()

  run(project, ['worktree', 'remove', where])
  const back = await startMilestone(project, rid, id)

  assert.equal(back.ok, true, back.error)
  assert.equal(back.reattached, true)
  assert.equal(back.branch, branch, 'the same branch, not a new one')
  assert.equal(back.worktree, where, 'back at the same path')
  assert.ok(fs.existsSync(path.join(where, 'work.txt')), 'the commit on it survived')

  const branches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: project, encoding: 'utf8' })
    .split('\n').filter((b) => b.startsWith('roadmap/'))
  assert.deepEqual(branches, [branch], 'exactly one roadmap branch')
  assert.equal(execFileSync('git', ['rev-parse', branch], { cwd: project, encoding: 'utf8' }).trim(), onBranch)
})

test('with the branch gone too, there is nothing to reattach to and it starts over', async () => {
  const project = repo()
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'Nothing to recover', task: '' })
  const id = only(project, rid).id

  const first = await startMilestone(project, rid, id)
  run(project, ['worktree', 'remove', first.worktree])
  run(project, ['branch', '-D', first.branch])

  const fresh = await startMilestone(project, rid, id)
  assert.equal(fresh.ok, true, fresh.error)
  assert.equal(fresh.reattached, undefined)
  assert.ok(fs.existsSync(fresh.worktree))
  assert.match(fresh.branch, /^roadmap\/nothing-to-recover/)
})

/* ---------- putting a session to work ---------- */

/** A launch that spawns nothing and remembers what it was asked for. */
function fakeLauncher() {
  const calls = []
  return {
    calls,
    launch: (options) => {
      calls.push(options)
      // The real one has no session id yet at this point either.
      return { deckId: `deck${calls.length}`, sessionId: null }
    },
  }
}

async function ready(title = 'Add metrics', task = 'add the session counter') {
  const project = repo()
  const rid = plan(project)
  roadmap.add(project, rid, { title, task })
  const id = only(project, rid).id
  await startMilestone(project, rid, id)
  return { project, rid, id }
}

test('running a milestone launches a session in its worktree, and records it', async () => {
  const { project, rid, id } = await ready()
  const launcher = fakeLauncher()

  const ran = await runMilestone(project, rid, id, { launch: launcher.launch, mode: 'acceptEdits' })
  assert.equal(ran.ok, true, ran.error)
  assert.equal(launcher.calls.length, 1)

  const call = launcher.calls[0]
  assert.equal(call.cwd, only(project, rid).worktree, 'in the worktree, not the project root')
  assert.equal(call.permissionMode, 'acceptEdits')
  assert.equal(call.name, 'Add metrics')
  assert.equal(only(project, rid).deckId, 'deck1')
})

/*
 * What the session is told is the whole of this slice: the task, where it is,
 * and what it must not do. A session that pushes or opens a pull request has
 * taken a decision that belongs on the roadmap screen.
 */
test('the session is told the task, where it is, and what it must not do', async () => {
  const project = repo()
  const rid = plan(project)
  roadmap.setGoal(project, rid, 'The deck runs a roadmap on its own')
  roadmap.add(project, rid, { title: 'First', task: 'do the first part' })
  roadmap.add(project, rid, { title: 'Second', task: 'do the second part' })
  const second = roadmap.get(project, rid).milestones[1]
  await startMilestone(project, rid, second.id)

  const prompt = promptFor(roadmap.get(project, rid), roadmap.get(project, rid).milestones[1])

  assert.match(prompt, /The deck runs a roadmap on its own/, 'the goal')
  assert.match(prompt, /milestone 2 of 2/, 'where it sits in the order')
  assert.match(prompt, /do the second part/, 'the task itself')
  assert.match(prompt, /worktree of your own/, 'where it is working')
  assert.match(prompt, /roadmap\/second/, 'the branch')
  assert.match(prompt, /Do not merge, do not push and do not open a pull request/)
  assert.match(prompt, /each milestone is merged as it finishes/, 'the landing it must not second-guess')
  assert.ok(!prompt.includes('do the first part'), 'not the other milestones’ tasks')
})

test('a milestone with no worktree cannot be run, and says which step is missing', async () => {
  const project = repo()
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'Not started', task: 'something' })
  const launcher = fakeLauncher()

  const ran = await runMilestone(project, rid, only(project, rid).id, { launch: launcher.launch })
  assert.equal(ran.ok, false)
  assert.match(ran.error, /Start this milestone first/)
  assert.equal(launcher.calls.length, 0, 'nothing was launched')
})

test('a milestone with no task written cannot be run', async () => {
  const project = repo()
  const rid = plan(project)
  roadmap.add(project, rid, { title: 'No task', task: '' })
  const id = only(project, rid).id
  await startMilestone(project, rid, id)
  const launcher = fakeLauncher()

  const ran = await runMilestone(project, rid, id, { launch: launcher.launch })
  assert.equal(ran.ok, false)
  assert.match(ran.error, /Write the task first/)
  assert.equal(launcher.calls.length, 0)
})

test('a milestone whose worktree was deleted is not run into thin air', async () => {
  const { project, rid, id } = await ready()
  run(project, ['worktree', 'remove', only(project, rid).worktree])
  const launcher = fakeLauncher()

  const ran = await runMilestone(project, rid, id, { launch: launcher.launch })
  assert.equal(ran.ok, false)
  assert.match(ran.error, /worktree is gone/)
  assert.equal(launcher.calls.length, 0)
})

/*
 * Two sessions on one milestone would work the same branch from two places,
 * and the roadmap would only remember the second.
 */
test('a milestone already being worked on is not launched a second time', async () => {
  const { project, rid, id } = await ready()
  const launcher = fakeLauncher()
  await runMilestone(project, rid, id, { launch: launcher.launch })

  const again = await runMilestone(project, rid, id, { launch: launcher.launch, isLive: () => true })
  assert.equal(again.ok, false)
  assert.match(again.error, /already working on this milestone/)
  assert.equal(launcher.calls.length, 1)

  // Once that session is gone, running again is allowed.
  const afterwards = await runMilestone(project, rid, id, { launch: launcher.launch, isLive: () => false })
  assert.equal(afterwards.ok, true, afterwards.error)
  assert.equal(launcher.calls.length, 2)
  assert.equal(only(project, rid).deckId, 'deck2')
})

test('a launch that throws is reported, and records nothing', async () => {
  const { project, rid, id } = await ready()
  const ran = await runMilestone(project, rid, id, {
    launch: () => { throw new Error('cwd is required') },
  })
  assert.equal(ran.ok, false)
  assert.match(ran.error, /cwd is required/)
  assert.equal(only(project, rid).deckId, null)
})

test('the session id is recorded once there is one to record', async () => {
  const { project, rid, id } = await ready()
  await runMilestone(project, rid, id, { launch: () => ({ deckId: 'deck9', sessionId: null }) })
  assert.equal(only(project, rid).sessionId, null, 'not known at launch')

  roadmap.attachSession(project, rid, id, { sessionId: '11111111-2222-3333-4444-555555555555' })
  assert.equal(only(project, rid).sessionId, '11111111-2222-3333-4444-555555555555')
  assert.equal(only(project, rid).deckId, 'deck9', 'and the deck id is not lost doing it')
})

/* ---------- finishing with a roadmap ---------- */

/*
 * The rule here is not `statusFor`'s rule, and the difference is the whole
 * point: a milestone that was started and never worked in has nothing to
 * land, so asking "is this in origin/master" would report it as unlanded for
 * as long as your own master sits unpushed. What matters is whether the
 * branch holds anything that is not already in what it was cut from.
 */
async function ready2(project, rid, title, task = 'something') {
  roadmap.add(project, rid, { title, task })
  const m = roadmap.get(project, rid).milestones.find((x) => x.title === title)
  const started = await startMilestone(project, rid, m.id)
  return { id: m.id, worktree: started.worktree, branch: started.branch }
}

test('a worktree nobody committed in is offered for removal', async () => {
  const project = repo()
  const rid = plan(project, 'A goal')
  await ready2(project, rid, 'Empty')

  const preview = await cleanupPlan(project, rid)
  assert.equal(preview.ok, true)
  assert.equal(preview.items.length, 1)
  assert.equal(preview.items[0].action, 'remove')
  assert.match(preview.items[0].why, /nothing was ever committed/)
  assert.equal(preview.removable, 1)
})

test('a worktree with uncommitted work is kept, and says how much', async () => {
  const project = repo()
  const rid = plan(project)
  const { worktree } = await ready2(project, rid, 'Half done')
  fs.writeFileSync(path.join(worktree, 'wip.txt'), 'half done\n')

  const preview = await cleanupPlan(project, rid)
  assert.equal(preview.items[0].action, 'keep')
  assert.match(preview.items[0].why, /1 uncommitted change/)
  assert.equal(preview.removable, 0)
})

test('a branch with commits of its own that are nowhere else is kept', async () => {
  const project = repo()
  const rid = plan(project)
  const { worktree } = await ready2(project, rid, 'With work')
  fs.writeFileSync(path.join(worktree, 'done.txt'), 'real work\n')
  run(worktree, ['add', '.'])
  run(worktree, ['commit', '-m', 'work that exists nowhere else'])

  const preview = await cleanupPlan(project, rid)
  assert.equal(preview.items[0].action, 'keep')
  assert.equal(preview.removable, 0)
})

/* A session inside a worktree outranks anything else we might say about it. */
test('a worktree with a session still in it is never offered for removal', async () => {
  const project = repo()
  const rid = plan(project)
  const { id } = await ready2(project, rid, 'Busy')
  roadmap.attachSession(project, rid, id, { deckId: 'deck1' })

  const preview = await cleanupPlan(project, rid, { isLive: () => true })
  assert.equal(preview.items[0].action, 'keep')
  assert.match(preview.items[0].why, /a session is still working in it/)
})

test('a worktree already gone leaves only a record to forget', async () => {
  const project = repo()
  const rid = plan(project)
  const { worktree } = await ready2(project, rid, 'Already deleted')
  run(project, ['worktree', 'remove', worktree])

  const preview = await cleanupPlan(project, rid)
  assert.equal(preview.items[0].action, 'forget')
  assert.match(preview.items[0].why, /already gone/)
})

test('finishing without tidying marks the roadmap and touches nothing', async () => {
  const project = repo()
  const rid = plan(project)
  const { worktree } = await ready2(project, rid, 'It stays')

  const done = await completeRoadmap(project, rid, { clean: false })
  assert.equal(done.ok, true)
  assert.equal(roadmap.get(project, rid).state, 'completed')
  assert.deepEqual(done.cleaned, [])
  assert.ok(fs.existsSync(worktree), 'the worktree is still there')
  assert.equal(roadmap.get(project, rid).milestones[0].worktree, worktree, 'and still recorded')
})

test('finishing and tidying removes what is safe, keeps what is not, and says which', async () => {
  const project = repo()
  const rid = plan(project, 'Two milestones, one with work')
  const empty = await ready2(project, rid, 'Empty')
  const worked = await ready2(project, rid, 'With work')

  fs.writeFileSync(path.join(worked.worktree, 'done.txt'), 'real work\n')
  run(worked.worktree, ['add', '.'])
  run(worked.worktree, ['commit', '-m', 'work that exists nowhere else'])

  const done = await completeRoadmap(project, rid, { clean: true })
  assert.equal(done.ok, true)
  assert.equal(roadmap.get(project, rid).state, 'completed')

  assert.deepEqual(done.cleaned.map((c) => c.name), ['empty'])
  assert.deepEqual(done.kept.map((k) => k.name), ['with-work'])

  assert.equal(fs.existsSync(empty.worktree), false, 'the empty one is gone')
  assert.ok(fs.existsSync(worked.worktree), 'the one with work is not')

  const branches = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: project, encoding: 'utf8' })
  assert.ok(!branches.includes(empty.branch), 'its branch went with it')
  assert.ok(branches.includes(worked.branch), 'and the other branch is untouched')

  // The record is forgotten for what was removed, and kept for what was not,
  // so the screen never points at a path that is no longer there.
  const after = roadmap.get(project, rid).milestones
  assert.equal(after.find((m) => m.id === empty.id).worktree, null)
  assert.equal(after.find((m) => m.id === worked.id).worktree, worked.worktree)
})

test('finishing a roadmap that is not there is refused', async () => {
  const project = repo()
  plan(project)
  assert.equal((await cleanupPlan(project, 'nosuch')).ok, false)
  assert.equal((await completeRoadmap(project, 'nosuch', { clean: true })).ok, false)
})
