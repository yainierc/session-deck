/**
 * Is it safe to delete this worktree?
 *
 * These tests exist because the answer was wrong on a real repository, in the
 * direction that makes a tool useless: 48 worktrees, and the panel offered to
 * clean up seven. The rest were held back by two bugs that both read a tidy
 * outcome as a dangerous one.
 *
 * The repository is built here with git rather than mocked. The whole subject
 * of this file is what git reports in situations that are awkward to reach —
 * a deleted remote branch, a commit that lives under a different name on the
 * server — and a fake that returned what we expected would have agreed with
 * the bugs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { statusFor } from '../src/worktree-status.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-wt-'))
const run = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()

/** A bare "server" and a clone of it, with one commit on main. */
function repo(name) {
  const server = path.join(scratch, `${name}.git`)
  const local = path.join(scratch, name)
  execFileSync('git', ['init', '--bare', '-b', 'main', server], { stdio: 'pipe' })
  execFileSync('git', ['clone', server, local], { stdio: 'pipe' })
  run(local, 'config', 'user.email', 'deck@test')
  run(local, 'config', 'user.name', 'Deck Test')
  fs.writeFileSync(path.join(local, 'README.md'), '# start\n')
  run(local, 'add', '.')
  run(local, 'commit', '-m', 'start')
  run(local, 'push', '-u', 'origin', 'main')
  return { server, local }
}

/** A worktree on its own branch, with one commit. */
function branchWorktree(local, branch, file = 'a.txt') {
  const wt = path.join(local, '..', `${path.basename(local)}-${branch.replace(/\//g, '-')}`)
  run(local, 'worktree', 'add', '-b', branch, wt)
  fs.writeFileSync(path.join(wt, file), 'work\n')
  run(wt, 'add', '.')
  run(wt, 'commit', '-m', `work on ${branch}`)
  return wt
}

test('uncommitted work is the one thing that is never safe', async () => {
  const { local } = repo('dirty')
  const wt = branchWorktree(local, 'feature/dirty')
  run(wt, 'push', '-u', 'origin', 'feature/dirty')
  fs.writeFileSync(path.join(wt, 'a.txt'), 'edited but not committed\n')

  const s = await statusFor(local, wt, { refresh: true })
  assert.equal(s.state, 'protected')
  assert.equal(s.safeToDelete, false)
  assert.match(s.atRisk.join(' '), /uncommitted/)
})

test('a branch whose remote was deleted is finished, not "never pushed"', async () => {
  // The bug this file exists for. `rev-parse @{u}` fails once the remote
  // branch is gone, and the old code read that failure as "this was never
  // pushed" — the single most protective verdict it had, for the single
  // tidiest thing that can happen to a branch.
  const { local } = repo('gone')
  const wt = branchWorktree(local, 'feature/merged')
  run(wt, 'push', '-u', 'origin', 'feature/merged')
  run(local, 'push', 'origin', '--delete', 'feature/merged')
  run(local, 'fetch', '--prune')

  const s = await statusFor(local, wt, { refresh: true })
  assert.equal(s.upstreamGone, true)
  assert.equal(s.everTracked, 'origin/feature/merged', 'it must remember what it tracked')
  assert.deepEqual(s.atRisk, [], 'nothing is at risk: the commits are still in the branch')
  assert.equal(s.state, 'integrated')
  assert.match(s.evidence.join(' '), /deleted from the server/)
})

test('commits that live on the server under another name are not at risk', async () => {
  // Measured on a real worktree that reported "316 commits never pushed"
  // while every one of them sat in four remote branches. A worktree branched
  // off another feature branch has no upstream of its own and is not in main,
  // which looked identical to work that exists nowhere else.
  const { local } = repo('elsewhere')
  const wt = branchWorktree(local, 'feature/base')
  run(wt, 'push', '-u', 'origin', 'feature/base')

  // A second branch on the same commit, with no upstream of its own.
  const wt2 = path.join(local, '..', 'elsewhere-copy')
  run(local, 'worktree', 'add', '-b', 'feature/no-upstream', wt2, 'feature/base')

  const s = await statusFor(local, wt2, { refresh: true })
  assert.equal(s.everTracked, null, 'this branch never tracked anything')
  assert.ok(s.ahead > 0, 'and it is ahead of main')
  assert.ok(s.onRemote.length > 0, 'but the server has the commit')
  assert.deepEqual(s.atRisk, [], 'so nothing would be lost')
  assert.equal(s.safeToDelete, true)
})

test('work that really exists nowhere else is held back', async () => {
  const { local } = repo('local-only')
  const wt = branchWorktree(local, 'feature/never-pushed')

  const s = await statusFor(local, wt, { refresh: true })
  assert.equal(s.everTracked, null)
  assert.deepEqual(s.onRemote, [], 'the server has never seen this commit')
  assert.equal(s.state, 'protected')
  assert.equal(s.safeToDelete, false)
  assert.match(s.atRisk.join(' '), /only here/)
})

test('pushed but not landed: deleting loses nothing, and it is still not done', async () => {
  const { local } = repo('open')
  const wt = branchWorktree(local, 'feature/open-pr')
  run(wt, 'push', '-u', 'origin', 'feature/open-pr')

  const s = await statusFor(local, wt, { refresh: true })
  // The third state, and the reason a boolean could not carry this: these two
  // answers disagree, and both of them are true.
  assert.equal(s.safeToDelete, true, 'nothing would be lost')
  assert.equal(s.finished, false, 'but the work has not landed')
  assert.equal(s.state, 'live')
})

test('a branch merged into main the ordinary way is finished', async () => {
  const { local } = repo('merged')
  const wt = branchWorktree(local, 'feature/fast-forward')
  run(wt, 'push', '-u', 'origin', 'feature/fast-forward')
  run(local, 'merge', 'feature/fast-forward')
  run(local, 'push')

  const s = await statusFor(local, wt, { refresh: true })
  assert.equal(s.merged, true)
  assert.equal(s.state, 'integrated')
  assert.match(s.evidence.join(' '), /already in/)
})
