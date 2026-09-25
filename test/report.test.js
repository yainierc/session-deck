/**
 * Reading a finished roadmap off the evidence.
 *
 * Driven against real branches for the same reason the runner's tests are:
 * the whole claim of this module is that it can tell a milestone that landed
 * from one that only says it did, and a mocked `merge-base` would prove
 * nothing about that.
 *
 * The case that matters is the third one. A milestone marked `done` whose
 * branch merged, one marked `done` whose branch never merged, and one marked
 * `done` that wrote nothing at all look identical in the roadmap record —
 * the record is what somebody clicked. Only the repository can tell them
 * apart, and tidying the wrong one deletes work.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.SESSION_DECK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-report-'))

const roadmap = await import('../src/roadmap.js')
const { dossierFor, tidyable, outstanding, promptFor, reportPath } = await import('../src/report.js')

function run(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-report-repo-'))
  run(dir, ['init', '-b', 'master'])
  run(dir, ['config', 'user.email', 'deck@example.com'])
  run(dir, ['config', 'user.name', 'deck'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  run(dir, ['add', '.'])
  run(dir, ['commit', '-m', 'first'])
  return dir
}

/**
 * What a milestone records at Start: the branch it was cut from and the
 * commit that branch was on at the time. Both halves, because the module
 * under test reads them for different questions.
 */
function baseNow(dir) {
  return `master@${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()}`
}

/** A branch with one commit on it, optionally merged back into master. */
function branchWith(dir, name, file, { merge = false } = {}) {
  const base = baseNow(dir)
  run(dir, ['checkout', '-b', name])
  fs.writeFileSync(path.join(dir, file), 'work\n')
  run(dir, ['add', '.'])
  run(dir, ['commit', '-m', `work on ${name}`])
  run(dir, ['checkout', 'master'])
  if (merge) run(dir, ['merge', '--no-ff', '-m', `merge ${name}`, name])
  return base
}

/** A branch that was cut and never worked in. */
function branchEmpty(dir, name) {
  const base = baseNow(dir)
  run(dir, ['branch', name])
  return base
}

/** A roadmap whose milestones point at those branches. */
function plan(dir, bases) {
  const rid = roadmap.create(dir, { goal: 'Cerrar el trimestre' }).roadmap.id
  roadmap.add(dir, rid, { title: 'Landed', task: 'the one that did land' })
  roadmap.add(dir, rid, { title: 'Still open', task: 'the one waiting on a PR' })
  roadmap.add(dir, rid, { title: 'Wrote nothing', task: 'the one that says done and wrote nothing' })

  const ids = roadmap.get(dir, rid).milestones.map((m) => m.id)
  roadmap.begin(dir, rid, ids[0], { branch: 'landed', worktree: null, base: bases.landed })
  roadmap.begin(dir, rid, ids[1], { branch: 'open', worktree: null, base: bases.open })
  roadmap.begin(dir, rid, ids[2], { branch: 'empty', worktree: null, base: bases.empty })
  for (const id of ids) roadmap.update(dir, rid, id, { status: 'done' })
  return rid
}

/** The three-milestone fixture every landing test starts from. */
function threeMilestones() {
  const dir = repo()
  const bases = {
    landed: branchWith(dir, 'landed', 'a.txt', { merge: true }),
    open: branchWith(dir, 'open', 'b.txt'),
    empty: branchEmpty(dir, 'empty'),
  }
  return { dir, rid: plan(dir, bases) }
}

/** No forge, no transcripts: this suite is about what git alone can settle. */
const offline = { pr: async () => null, transcript: () => null }

test('a milestone that merged, one that did not, and one that wrote nothing', async () => {
  const { dir, rid } = threeMilestones()

  const { ok, dossier } = await dossierFor(dir, rid, offline)
  assert.ok(ok)
  assert.deepEqual(dossier.milestones.map((m) => m.landing), ['merged', 'unlanded', 'empty'])
})

test('all three are marked done in the record, which is why the record is not the answer', async () => {
  const { dir, rid } = threeMilestones()

  const { dossier } = await dossierFor(dir, rid, offline)
  assert.deepEqual(dossier.milestones.map((m) => m.status), ['done', 'done', 'done'])
})

test('only what landed, or never held anything, is offered to the sweep', async () => {
  const { dir, rid } = threeMilestones()

  const { dossier } = await dossierFor(dir, rid, offline)
  assert.deepEqual(tidyable(dossier).map((m) => m.title), ['Landed', 'Wrote nothing'])
  assert.deepEqual(outstanding(dossier).map((m) => m.title), ['Still open'])
})

test('the commits and the diffstat come from the branch, not from the record', async () => {
  const { dir, rid } = threeMilestones()

  const { dossier } = await dossierFor(dir, rid, offline)
  const [landed, , empty] = dossier.milestones
  assert.deepEqual(landed.files, ['a.txt'])
  assert.match(landed.commits[0], /work on landed$/)
  assert.match(landed.diffstat, /1 file changed/)
  assert.deepEqual(empty.files, [])
  assert.equal(empty.diffstat, null)
})

test('a branch merged on the forge but not fetched here still counts as landed', async () => {
  const dir = repo()
  branchWith(dir, 'open', 'b.txt')
  const rid = roadmap.create(dir, { goal: '' }).roadmap.id
  roadmap.add(dir, rid, { title: 'Merged upstream', task: '' })
  const [id] = roadmap.get(dir, rid).milestones.map((m) => m.id)
  roadmap.begin(dir, rid, id, { branch: 'open', worktree: null, base: 'master' })

  const { dossier } = await dossierFor(dir, rid, {
    transcript: () => null,
    pr: async () => ({ number: 7, state: 'MERGED', url: 'https://x/7', title: 'Merged upstream' }),
  })
  assert.equal(dossier.milestones[0].landing, 'merged')
  assert.equal(dossier.milestones[0].pr.number, 7)
})

test('an open pull request is not a merge', async () => {
  const dir = repo()
  branchWith(dir, 'open', 'b.txt')
  const rid = roadmap.create(dir, { goal: '' }).roadmap.id
  roadmap.add(dir, rid, { title: 'Waiting', task: '' })
  const [id] = roadmap.get(dir, rid).milestones.map((m) => m.id)
  roadmap.begin(dir, rid, id, { branch: 'open', worktree: null, base: 'master' })

  const { dossier } = await dossierFor(dir, rid, {
    transcript: () => null,
    pr: async () => ({ number: 8, state: 'OPEN', url: 'https://x/8', title: 'Waiting' }),
  })
  assert.equal(dossier.milestones[0].landing, 'pr-open')
  assert.deepEqual(tidyable(dossier), [])
})

test('a milestone that was never started reports no landing and no branch', async () => {
  const dir = repo()
  const rid = roadmap.create(dir, { goal: '' }).roadmap.id
  roadmap.add(dir, rid, { title: 'Never started', task: 'quedo en la lista' })

  const { dossier } = await dossierFor(dir, rid, offline)
  assert.equal(dossier.milestones[0].landing, 'none')
  assert.equal(dossier.milestones[0].branch, null)
})

test('a branch that no longer resolves costs its diff and not the report', async () => {
  const dir = repo()
  const rid = roadmap.create(dir, { goal: '' }).roadmap.id
  roadmap.add(dir, rid, { title: 'Branch deleted by hand', task: '' })
  const [id] = roadmap.get(dir, rid).milestones.map((m) => m.id)
  roadmap.begin(dir, rid, id, { branch: 'gone-for-good', worktree: null, base: 'master' })

  const { ok, dossier } = await dossierFor(dir, rid, offline)
  assert.ok(ok)
  assert.equal(dossier.milestones[0].title, 'Branch deleted by hand')
  assert.deepEqual(dossier.milestones[0].commits, [])
})

test('the brief carries the transcript path and not the transcript', async () => {
  const dir = repo()
  branchWith(dir, 'landed', 'a.txt', { merge: true })
  const rid = roadmap.create(dir, { goal: '' }).roadmap.id
  roadmap.add(dir, rid, { title: 'Landed', task: 'hazlo' })
  const [id] = roadmap.get(dir, rid).milestones.map((m) => m.id)
  roadmap.begin(dir, rid, id, { branch: 'landed', worktree: null, base: 'master' })
  // The session that did it, which is what makes a transcript findable at all.
  roadmap.attachSession(dir, rid, id, { sessionId: 'abc-123' })

  const { dossier } = await dossierFor(dir, rid, {
    pr: async () => null,
    transcript: () => '/somewhere/session.jsonl',
  })
  const prompt = promptFor(dossier, { file: 'reports/x.md' })
  assert.match(prompt, /transcript: \/somewhere\/session\.jsonl/)
  assert.match(prompt, /Write it to reports\/x\.md/)
  // The disagreement it must not smooth over is spelled out in the brief.
  assert.match(prompt, /disagreement between the brief and the diff/)
})

test('a report is filed under the day it was frozen and the roadmap it closes', () => {
  const file = reportPath({ label: 'Cerrar el trimestre', frozenAt: Date.UTC(2026, 8, 25) })
  assert.equal(file, path.join('reports', '2026-09-25-cerrar-el-trimestre.md'))
})
