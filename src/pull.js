/**
 * pull.js — bringing a project up to date with its remote, from a button.
 *
 * This is the first thing the deck does that *writes* to your working tree,
 * and it can be triggered from a phone on the far side of a tunnel. So the
 * design is not "run git pull and report what happened"; it is to make the
 * worst possible outcome of that button dull.
 *
 * Three rules do that, and they are the whole module:
 *
 *   1. Fast-forward only. A pull that would merge is a pull that can leave
 *      conflict markers in files a Claude session is editing, and nobody is
 *      resolving that from a phone. If the branch diverged, this refuses and
 *      says so — which is information, not a failure.
 *   2. Never with uncommitted work. Fast-forwarding over a dirty tree is how
 *      you lose the change you had not finished describing yet.
 *   3. Never changes which branch you are on. Checking out somewhere else
 *      pulls the floor from under every session open in the folder.
 *
 * What is left is an operation whose worst case is that a clean checkout
 * advances to a commit that already exists on the remote — recoverable from
 * the reflog, and usually just what you asked for.
 */
import { git } from './git.js'

const REMOTE = 'origin'

/** Fetching is a network round trip; local plumbing is not. */
const NETWORK_MS = 120_000

/**
 * Where this checkout stands, and the branches it could pull from.
 *
 * The branch list comes from the last fetch rather than the network, so the
 * panel opens instantly. `refresh` is what asks git to go and look — needed
 * when a branch was created on GitHub after the last time anyone fetched.
 */
export async function branchesFor(root, { refresh = false } = {}) {
  const current = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!current.ok) return { available: false, error: 'Not a git repository the deck can read' }

  if (refresh) await git(root, ['fetch', '--prune', REMOTE], NETWORK_MS)

  const [listed, status, upstream] = await Promise.all([
    git(root, ['branch', '--remotes', '--format=%(refname:short)']),
    git(root, ['status', '--porcelain']),
    git(root, ['rev-parse', '--abbrev-ref', '@{u}']),
  ])

  // `origin/HEAD` is a symbolic pointer at the default branch, not a branch
  // anybody pulls by that name — offering it would be offering a duplicate.
  const branches = (listed.ok ? listed.out.split('\n') : [])
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${REMOTE}/`) && line !== `${REMOTE}/HEAD`)
    .map((line) => line.slice(REMOTE.length + 1))
    .filter(Boolean)
    .sort()

  return {
    available: true,
    current: current.out,
    branches,
    dirty: status.ok ? status.out.split('\n').filter(Boolean).length : 0,
    upstream: upstream.ok && upstream.out ? upstream.out : null,
  }
}

/**
 * Fast-forward the current branch to one of the remote's.
 *
 * `branch` arrives from the browser and is never interpolated anywhere: it is
 * matched against the branches git itself just reported, and the match — not
 * the input — is what gets used. The same whitelist shape the MCP sign-in
 * button uses, for the same reason.
 */
export async function pull(root, branch) {
  const state = await branchesFor(root)
  if (!state.available) return { ok: false, error: state.error }

  const target = state.branches.find((name) => name === branch)
  if (!target) {
    return {
      ok: false,
      error: state.branches.length
        ? `No branch called "${branch}" on ${REMOTE}`
        : `${REMOTE} has no branches the deck can see — try Refresh first`,
    }
  }

  if (state.dirty > 0) {
    return {
      ok: false,
      branch: target,
      error: `${state.dirty} uncommitted ${state.dirty === 1 ? 'change' : 'changes'} here. Commit or stash first — pulling over them is how work disappears.`,
    }
  }

  const result = await git(root, ['pull', '--ff-only', REMOTE, target], NETWORK_MS)
  if (!result.ok) {
    // The one failure worth translating: everything else git already words
    // better than a paraphrase would.
    const diverged = /not possible to fast-forward|diverging|non-fast-forward/i.test(result.error)
    return {
      ok: false,
      branch: target,
      error: diverged
        ? `${state.current} and ${REMOTE}/${target} have diverged, so this cannot fast-forward. Merge or rebase it yourself — that decision is not one a button should make.`
        : result.error,
    }
  }

  const unchanged = /already up to date/i.test(result.out)
  return {
    ok: true,
    branch: target,
    into: state.current,
    unchanged,
    message: unchanged ? `Already up to date with ${REMOTE}/${target}` : summarise(result.out),
  }
}

/**
 * The one line of a pull worth reading.
 *
 * git ends its output with the diffstat, so the last line is whatever file
 * happened to sort last — "create mode 100644 c.txt" tells you nothing about
 * the pull. The summary line does, and when there is none the range git
 * updated is the next best thing.
 */
function summarise(out) {
  const lines = out.split('\n').map((line) => line.trim()).filter(Boolean)
  return (
    lines.find((line) => /\d+ files? changed/.test(line)) ||
    lines.find((line) => /^Updating [0-9a-f]+\.\.[0-9a-f]+$/.test(line)) ||
    lines[lines.length - 1] ||
    'Updated'
  )
}
