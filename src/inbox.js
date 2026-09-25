/**
 * inbox.js — one queue answering "what needs me".
 *
 * Everything else in the deck is organised by where things live: projects,
 * sessions, worktrees. This is organised by whether it is waiting on you,
 * which is a different question and the one you actually open the panel to
 * ask.
 *
 * It aggregates git and gh across every project in the workspace, so it runs
 * on demand rather than on a timer, and leans on the caches underneath.
 */
import path from 'node:path'
import { listWorktrees } from './projects.js'
import { statusFor, rootStatus } from './worktree-status.js'
import { listPullRequests } from './forges.js'

/** A session untouched for this long has probably been forgotten. */
const IDLE_HOURS = 12

/** Ordering of the queue. Blocked work outranks tidying, always. */
const SEVERITY = { blocked: 0, broken: 1, risk: 2, ready: 3, idle: 4, cleanup: 5 }

function hoursSince(ts) {
  if (!ts) return null
  return (Date.now() - ts) / 3_600_000
}

/** Is `child` the same directory as `parent`, or inside it? */
function isInside(child, parent) {
  if (!child || !parent) return false
  if (child === parent) return true
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export async function buildInbox({ sessions, projects, refresh = false }) {
  const items = []

  // ---- sessions blocked on you ----
  for (const session of sessions) {
    if (session.status !== 'waiting') continue
    items.push({
      id: `blocked:${session.sessionId || session.deckId}`,
      severity: 'blocked',
      title: session.waitingFor || 'Waiting on your answer',
      detail: session.name,
      project: session.project,
      projectPath: session.projectPath,
      action: session.managed
        ? { type: 'session', sessionId: session.sessionId, deckId: session.deckId, label: 'Answer' }
        : { type: 'session', sessionId: session.sessionId, deckId: session.deckId, label: 'Open' },
      // Only deck-launched sessions can actually be answered from here.
      note: session.managed ? null : 'Answer in its terminal',
    })
  }

  // ---- sessions nobody has touched in a long time ----
  for (const session of sessions) {
    if (session.status === 'waiting') continue
    const idle = hoursSince(session.statusUpdatedAt || session.updatedAt)
    // A nonsensical timestamp means unknown, not "idle since the epoch".
    if (idle === null || idle < IDLE_HOURS || idle > 24 * 365) continue
    items.push({
      id: `idle:${session.sessionId || session.deckId}`,
      severity: 'idle',
      title: `Untouched for ${Math.round(idle)}h`,
      detail: session.name,
      project: session.project,
      projectPath: session.projectPath,
      action: { type: 'session', sessionId: session.sessionId, deckId: session.deckId, label: 'Open' },
    })
  }

  // ---- everything that needs git or gh, one project at a time ----
  const roots = [...new Set(projects.map((p) => p.path).filter(Boolean))]

  // Every identity behind the projects in this workspace — a personal GitHub
  // account, a work one, an Azure DevOps sign-in. There is no single "you"
  // any more, so the UI is told the whole set.
  const logins = new Set()

  // Forges that could not be read at all. Kept apart from `items` on purpose:
  // an org nobody is signed into is a problem with your tools, not work
  // waiting on you, and putting it in the queue would be a category error.
  const problems = []
  const seenProblems = new Set()

  await Promise.all(
    roots.map(async (root) => {
      const name = path.basename(root)

      const [pullRequests, rootState, worktrees] = await Promise.all([
        listPullRequests(root, { refresh }),
        rootStatus(root, { refresh }),
        Promise.all(
          listWorktrees(root)
            .filter((w) => w.exists)
            .map(async (w) => ({ ...w, status: await statusFor(root, w.path, { refresh }) })),
        ),
      ])

      const prs = pullRequests.prs
      if (pullRequests.identity) logins.add(pullRequests.identity)

      // One Azure DevOps organisation covers many repositories, so the same
      // "not signed in" would otherwise be reported six times over.
      if (pullRequests.problem && !seenProblems.has(pullRequests.problem.message)) {
        seenProblems.add(pullRequests.problem.message)
        problems.push({ ...pullRequests.problem, project: name, projectPath: root })
      }

      for (const pr of prs) {
        if (pr.draft) continue

        // Everything a pull request row shares, so the branches below differ
        // only in the one thing that actually distinguishes them.
        const row = {
          detail: pr.title,
          project: name,
          projectPath: root,
          isPr: true,
          forge: pr.forge,
          author: pr.author,
          mine: pr.mine,
          action: { type: 'url', url: pr.url, label: 'Open PR' },
        }

        if (pr.failing > 0) {
          items.push({
            ...row,
            id: `pr-broken:${root}:${pr.number}`,
            severity: 'broken',
            title: `PR #${pr.number} — ${plural(pr.failing, 'check')} failing`,
          })
        } else if (pr.conflicted) {
          // Green checks mean nothing if the branch will not merge.
          items.push({
            ...row,
            id: `pr-conflict:${root}:${pr.number}`,
            severity: 'broken',
            title: `PR #${pr.number} — conflicts to resolve`,
          })
        } else if (pr.clear && pr.approved) {
          // The one nothing is waiting on but you pressing the button. It
          // used to fall through both branches and vanish from the queue.
          // `clear` rather than `green` so a repository without CI still
          // gets the row it is entitled to.
          items.push({
            ...row,
            id: `pr-merge:${root}:${pr.number}`,
            severity: 'ready',
            title: `PR #${pr.number} — approved, ready to merge`,
          })
        } else if (pr.clear && !pr.reviewDecision) {
          // `clear` again rather than `green`: a repository with no CI, and
          // Azure DevOps where build policies are not read, both have nothing
          // blocking them and still deserve the row. The title only claims
          // green when a passing build was actually seen.
          items.push({
            ...row,
            id: `pr-ready:${root}:${pr.number}`,
            severity: 'ready',
            title: `PR #${pr.number} — ${pr.green ? 'green, no review yet' : 'no review yet'}`,
          })
        }
      }

      // Work that exists only on this disk is the thing worth flagging.
      if (rootState.available) {
        const reasons = []
        if (rootState.dirty > 0) reasons.push(plural(rootState.dirty, 'uncommitted change'))
        if (!rootState.upstream) reasons.push('branch never pushed')
        else if (rootState.unpushed > 0) reasons.push(plural(rootState.unpushed, 'unpushed commit'))
        if (reasons.length) {
          items.push({
            id: `risk:${root}`,
            severity: 'risk',
            title: reasons.join(', '),
            detail: `on ${rootState.branch}`,
            project: name,
            projectPath: root,
            action: { type: 'project', path: root, label: 'Open project' },
          })
        }
      }

      for (const worktree of worktrees) {
        const status = worktree.status
        if (!status?.available) continue

        // The same rule the delete endpoint enforces: a worktree someone is
        // working in is not cleanup, whatever its branch looks like. Offering
        // it here and refusing it there would just waste a click.
        const busy = sessions.some((session) => isInside(session.cwd, worktree.path))

        if (status.safeToDelete && !busy) {
          items.push({
            id: `cleanup:${worktree.path}`,
            severity: 'cleanup',
            title: `Worktree "${worktree.name}" can go`,
            detail: status.pr ? `PR #${status.pr.number} merged` : `in ${status.parent}`,
            project: name,
            projectPath: root,
            action: { type: 'project', path: root, label: 'Open project' },
          })
          continue
        }
        if (busy) continue

        const reasons = []
        if (status.dirty > 0) reasons.push(plural(status.dirty, 'uncommitted change'))
        if (!status.upstream && status.ahead > 0) reasons.push('never pushed')
        else if (status.upstream && status.unpushed > 0) reasons.push(plural(status.unpushed, 'unpushed commit'))
        if (reasons.length) {
          items.push({
            id: `risk:${worktree.path}`,
            severity: 'risk',
            title: reasons.join(', '),
            detail: `worktree "${worktree.name}"`,
            project: name,
            projectPath: root,
            action: { type: 'project', path: root, label: 'Open project' },
          })
        }
      }
    }),
  )

  items.sort((a, b) => {
    const rank = SEVERITY[a.severity] - SEVERITY[b.severity]
    if (rank !== 0) return rank
    return (a.project || '').localeCompare(b.project || '')
  })

  const counts = {}
  for (const item of items) counts[item.severity] = (counts[item.severity] || 0) + 1

  // Each pull request already knows whether it is yours, judged against the
  // identity that could actually read it. The UI needs the names only to
  // label the filter and to know there is an identity to filter by at all.
  const viewers = [...logins].sort()

  return { items, counts, viewers, problems, checkedAt: Date.now() }
}
