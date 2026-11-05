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
 *
 * ### Why there are three states and not a boolean
 *
 * There are two different questions here and treating them as one is what
 * made this screen useless on a real repository. "Would deleting this lose
 * work?" and "is this work finished?" are not the same question, and the
 * answer to the first is almost always no:
 *
 *   **`git worktree remove` does not delete commits.** It removes a working
 *   directory. The branch stays in the repository, and if it was pushed it is
 *   also on the server. The only thing that can be lost for good is what
 *   exists nowhere else — uncommitted changes, or commits never pushed.
 *
 * So `safeToDelete` now answers the first question and `finished` answers the
 * second. On the repository this was measured against — 48 worktrees — one was
 * protected and the rest were recoverable; the old single flag offered seven.
 *
 * ### Why `merge-base --is-ancestor` is not enough
 *
 * It was the only structural signal, and on a repository that squash-merges it
 * is false for everything: squashing rewrites the commits, so a branch that
 * landed months ago is not an ancestor of anything. Measured on those same 48
 * worktrees it said "not in main yet" 48 times out of 48.
 *
 * The signal that does work there is the upstream having disappeared: a branch
 * that once had a remote and no longer does was merged and tidied by whoever
 * merged it. It is local, free, and does not care how the merge was performed.
 * It depends on the remote refs having been pruned, which is why it is a
 * signal and not a proof — and why every verdict here carries its evidence.
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

  /*
   * The upstream, asked for in the one way that still answers after the remote
   * branch is deleted.
   *
   * `rev-parse @{u}` *fails* in that case — it resolves a ref, and the ref is
   * gone — so a branch whose pull request was merged and tidied came back
   * indistinguishable from one that was never pushed at all. That is how a
   * finished worktree ended up labelled "3 commits never pushed" and held on
   * disk for ever: the panel was reading the tidiest possible outcome as the
   * most dangerous one.
   *
   * `for-each-ref` reads the branch's *configuration* instead, so it still
   * names the upstream that used to exist, and `%(upstream:track)` says
   * `[gone]` when it does not any more. One call, both answers.
   */
  const [statusResult, trackResult, parent] = await Promise.all([
    git(worktreePath, ['status', '--porcelain']),
    git(worktreePath, [
      'for-each-ref', '--format=%(upstream:short)%09%(upstream:track)', `refs/heads/${branch}`,
    ]),
    parentBranch(repoRoot),
  ])

  const dirty = statusResult.ok ? statusResult.out.split('\n').filter(Boolean).length : 0

  const [configured = '', track = ''] = trackResult.ok ? trackResult.out.split('\t') : []
  // Configured to track something that no longer exists: merged and tidied.
  const upstreamGone = track.includes('[gone]')
  // What it tracks *now*. Null once the remote branch is gone, which is what
  // the rest of this file means by "there is nowhere else this lives".
  const upstream = configured && !upstreamGone ? configured : null
  // What it tracked, gone or not — the proof that it was pushed at all.
  const everTracked = configured || null

  // Commits made here that are not on the remote yet. Unanswerable once the
  // remote branch is gone: there is nothing left to compare against.
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

  /*
   * Did this branch's remote disappear?
   *
   * `%(upstream:track)` prints `[gone]` when the branch is still configured to
   * track something that no longer exists. That happens exactly once in a
   * branch's life: when somebody merged the pull request and let the forge
   * delete the source branch. It survives squashing, which `--is-ancestor`
   * does not.
   *
   * Read from the local refs, so it costs nothing and works offline — and so
   * it is only as current as the last `fetch --prune`. A stale remote makes
   * this say "still there", never the other way round, which is the direction
   * that errs toward keeping things.
   */
  /*
   * The last question, and the only one that settles it: is this commit on
   * the server at all, under any name?
   *
   * Counting commits against an upstream answers "is this branch pushed",
   * which is not the same thing and is wrong in both directions here. A
   * worktree branched off another feature branch, or one whose work reached
   * the server through a different branch entirely, has commits that exist in
   * origin under a name nobody thought to look up — and the count called them
   * unpushed. Measured on a real repository that mislabelled five worktrees,
   * one of them as "316 commits never pushed" while every one of those commits
   * sat in four remote branches.
   *
   * Only asked when something already looks at risk, because walking the graph
   * costs more than everything above it put together, and for most worktrees
   * the answer changes nothing.
   */
  const looksUnsafe = (!everTracked && ahead > 0) || (upstream && unpushed > 0)
  let onRemote = null
  if (looksUnsafe) {
    const contains = await git(worktreePath, [
      'branch', '--remotes', '--contains', 'HEAD', '--format=%(refname:short)',
    ], 20_000)
    onRemote = contains.ok && contains.out ? contains.out.split('\n').filter(Boolean) : []
  }
  const safeOnServer = Boolean(onRemote && onRemote.length)

  const pr = await pullRequestForBranch(repoRoot, worktreePath, branch)

  /*
   * What would be lost for good. Only work that exists nowhere else counts:
   * removing a worktree keeps the branch, and a pushed branch is also on the
   * server. These are the only things git cannot give back.
   */
  const atRisk = []
  if (dirty > 0) atRisk.push(`${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}`)
  // Commits only count as at risk once the server has been asked and said no.
  if (upstream && unpushed > 0 && !safeOnServer) {
    atRisk.push(`${unpushed} unpushed ${unpushed === 1 ? 'commit' : 'commits'}`)
  }
  // Only when it never had a remote at all. A branch whose upstream is gone
  // was pushed — that is precisely why there was something to delete.
  if (!everTracked && ahead > 0 && !safeOnServer) {
    atRisk.push(`${ahead} ${ahead === 1 ? 'commit' : 'commits'} that exist only here`)
  }

  /*
   * Whether the work is done, and what says so. The evidence travels with the
   * verdict because "safe to delete" on its own is not believed — and should
   * not be, by anyone who has lost a branch once.
   */
  const evidence = []
  if (pr?.state === 'MERGED') evidence.push(`PR #${pr.number} merged`)
  if (upstreamGone) evidence.push(`${everTracked} was deleted from the server`)
  if (merged === true) evidence.push(`every commit is already in ${parent}`)
  if (upstream && unpushed === 0 && !evidence.length) evidence.push(`everything is pushed to ${upstream}`)
  if (safeOnServer && !evidence.length) {
    evidence.push(onRemote.length === 1
      ? `its commits are on the server, in ${onRemote[0]}`
      : `its commits are on the server, in ${onRemote.length} remote branches`)
  }
  const finished = Boolean(pr?.state === 'MERGED' || upstreamGone || merged === true)

  const state = atRisk.length ? 'protected' : finished ? 'integrated' : 'live'

  const value = {
    available: true,
    branch,
    parent,
    dirty,
    upstream,
    everTracked,
    upstreamGone,
    onRemote,
    unpushed,
    ahead,
    merged,
    pr,
    landed: finished,
    finished,
    /*
     * `state` is what the panel branches on:
     *   protected  — work exists only here. Never delete.
     *   integrated — it landed. Delete without asking.
     *   live       — pushed but not landed: deleting loses nothing, but the
     *                work is not done. The person decides.
     */
    state,
    evidence,
    atRisk,
    // Answers "would this lose work?", not "is this finished?". See the note
    // at the top of this file for why conflating them emptied this screen.
    safeToDelete: atRisk.length === 0,
    blockers: atRisk,
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/**
 * Remove a worktree, and optionally the branch it was checked out on.
 *
 * Never forced: git refusing is a result, not an obstacle.
 *
 * The branch is a separate step because removing a worktree deliberately does
 * not touch it — which is what makes deletion recoverable, and also why a
 * repository ends up with 185 branches for 48 worktrees. `-d` and not `-D`:
 * git's own refusal to delete a branch that is not merged is the last check
 * standing, and overriding it here would throw away the one thing that makes
 * this safe.
 */
export async function removeWorktree(repoRoot, worktreePath, { deleteBranch = null } = {}) {
  const result = await git(repoRoot, ['worktree', 'remove', worktreePath], 20_000)
  if (!result.ok) return { ok: false, error: result.error }
  cache.delete(`${repoRoot}::${worktreePath}`)

  let branchDeleted = false
  let branchError = null
  if (deleteBranch) {
    const dropped = await git(repoRoot, ['branch', '-d', deleteBranch], 20_000)
    branchDeleted = dropped.ok
    // A branch git will not drop is not an error worth failing the whole
    // operation over: the worktree is gone, which is what was asked for.
    if (!dropped.ok) branchError = dropped.error
  }
  return { ok: true, branchDeleted, branchError }
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
