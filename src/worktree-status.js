/**
 * worktree-status.js — is the work in a worktree finished with?
 *
 * This is the one place the deck shells out to git, and the trade is
 * deliberate. Reading files is right for the session registry, which
 * refreshes every second; answering "has this branch landed in main" means
 * walking the commit graph, which you cannot do sanely by hand. This runs on
 * demand, from a click, so the cost lands where it is affordable.
 *
 * Everything degrades: no git on PATH, no gh, no network — you get fewer
 * answers, never a broken view, and never a wrong "safe to delete".
 */
import { pullRequestForBranch } from './forges.js'
import { git } from './git.js'

/** cacheKey -> { at, value }. Git state does not change that fast. */
const cache = new Map()
const TTL_MS = 30_000

/** The branch a worktree is expected to land in, e.g. origin/main. */
async function parentBranch(repoRoot) {
  const head = await git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.ok && head.out) return head.out

  // No origin/HEAD (a fresh clone, or a repo with no remote): fall back to
  // whichever conventional name actually exists.
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const exists = await git(repoRoot, ['rev-parse', '--verify', '--quiet', candidate])
    if (exists.ok && exists.out) return candidate
  }
  return null
}

export async function statusFor(repoRoot, worktreePath, { refresh = false } = {}) {
  const key = `${repoRoot}::${worktreePath}`
  const hit = cache.get(key)
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.value

  const branchResult = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branchResult.ok) {
    const value = { available: false, error: 'Could not read this worktree with git' }
    cache.set(key, { at: Date.now(), value })
    return value
  }
  const branch = branchResult.out

  const [statusResult, upstreamResult, parent] = await Promise.all([
    git(worktreePath, ['status', '--porcelain']),
    git(worktreePath, ['rev-parse', '--abbrev-ref', '@{u}']),
    parentBranch(repoRoot),
  ])

  const dirty = statusResult.ok ? statusResult.out.split('\n').filter(Boolean).length : 0
  const upstream = upstreamResult.ok && upstreamResult.out ? upstreamResult.out : null

  // Commits made here that are not on the remote yet.
  let unpushed = null
  if (upstream) {
    const counted = await git(worktreePath, ['rev-list', '--count', `${upstream}..HEAD`])
    if (counted.ok) unpushed = Number(counted.out) || 0
  }

  // Is every commit on this branch already in the parent?
  let merged = null
  let ahead = null
  if (parent) {
    const ancestor = await git(worktreePath, ['merge-base', '--is-ancestor', 'HEAD', parent])
    merged = ancestor.ok
    const counted = await git(worktreePath, ['rev-list', '--count', `${parent}..HEAD`])
    if (counted.ok) ahead = Number(counted.out) || 0
  }

  const pr = await pullRequestForBranch(repoRoot, worktreePath, branch)

  // Deliberately conservative. "Safe" has to mean safe: work that exists only
  // here and nowhere else must never be one click from gone.
  const blockers = []
  if (dirty > 0) blockers.push(`${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}`)
  if (upstream && unpushed > 0) blockers.push(`${unpushed} unpushed ${unpushed === 1 ? 'commit' : 'commits'}`)
  if (!upstream && ahead > 0) blockers.push('never pushed')
  const landed = merged === true || pr?.state === 'MERGED'
  if (!landed) blockers.push(`not in ${parent || 'the parent branch'} yet`)

  const value = {
    available: true,
    branch,
    parent,
    dirty,
    upstream,
    unpushed,
    ahead,
    merged,
    pr,
    landed,
    safeToDelete: blockers.length === 0,
    blockers,
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Remove a worktree. Never forced: git refusing is a result, not an obstacle. */
export async function removeWorktree(repoRoot, worktreePath) {
  const result = await git(repoRoot, ['worktree', 'remove', worktreePath], 20_000)
  if (!result.ok) return { ok: false, error: result.error }
  cache.delete(`${repoRoot}::${worktreePath}`)
  return { ok: true }
}

/** Uncommitted and unpushed work sitting at the repository root itself. */
export async function rootStatus(repoRoot, { refresh = false } = {}) {
  const key = `root::${repoRoot}`
  const hit = cache.get(key)
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.value

  const branchResult = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branchResult.ok) {
    const value = { available: false }
    cache.set(key, { at: Date.now(), value })
    return value
  }

  const [statusResult, upstreamResult] = await Promise.all([
    git(repoRoot, ['status', '--porcelain']),
    git(repoRoot, ['rev-parse', '--abbrev-ref', '@{u}']),
  ])

  const dirty = statusResult.ok ? statusResult.out.split('\n').filter(Boolean).length : 0
  const upstream = upstreamResult.ok && upstreamResult.out ? upstreamResult.out : null

  let unpushed = 0
  if (upstream) {
    const counted = await git(repoRoot, ['rev-list', '--count', `${upstream}..HEAD`])
    if (counted.ok) unpushed = Number(counted.out) || 0
  }

  const value = { available: true, branch: branchResult.out, dirty, upstream, unpushed }
  cache.set(key, { at: Date.now(), value })
  return value
}
