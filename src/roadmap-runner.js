/**
 * roadmap-runner.js — the part of a roadmap that acts.
 *
 * Today it does exactly one thing: starting a milestone gives it somewhere to
 * work. A worktree and a branch, and nothing else — no session is launched,
 * nothing is committed, nothing is merged. That is deliberate and it is the
 * first slice of the execution phase: it is the only step in the whole
 * sequence that cannot lose you anything, so it is the one worth having
 * before the steps that can.
 *
 * Where the worktree goes is not this file's invention. Claude Code puts them
 * in `<repo>/.claude/worktrees/<name>`, which is where the ones already on
 * this machine live, and a deck that scattered its own somewhere else would
 * be a deck whose worktree list stopped matching the repository.
 *
 * Two rules hold here and are worth stating because the rest of the execution
 * phase will be built on them:
 *
 *   - Git first, state second. The roadmap records a branch only after git
 *     has actually made one. A milestone that claims a branch nobody created
 *     is worse than a milestone that failed to start.
 *   - Nothing is half-done. If the worktree cannot be created, the roadmap is
 *     not touched at all, and the error comes back as text you can read.
 */
import fs from 'node:fs'
import path from 'node:path'
import { git } from './git.js'
import { rootBranch } from './projects.js'
import { statusFor, removeWorktree } from './worktree-status.js'
import * as roadmap from './roadmap.js'

/** Where this machine already keeps its worktrees. */
export function worktreeRoot(projectPath) {
  return path.join(projectPath, '.claude', 'worktrees')
}

/**
 * Branch and directory names that are already spoken for.
 *
 * Both are consulted before a name is offered, so the name the panel shows is
 * the name that will be created — not one that turns out to exist the moment
 * somebody presses the button.
 */
export async function takenNames(projectPath, { run = git } = {}) {
  const taken = new Set()

  const branches = await run(projectPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (branches.ok) {
    for (const line of branches.out.split('\n')) {
      const name = line.trim()
      if (!name) continue
      taken.add(name)
      // A directory named after the branch's last segment collides too.
      taken.add(name.replace(/^roadmap\//, ''))
    }
  }

  try {
    for (const entry of fs.readdirSync(worktreeRoot(projectPath))) taken.add(entry)
  } catch {
    // No worktrees directory yet, which is the common case the first time.
  }

  return taken
}

/**
 * A milestone that says it started, into a directory that is not there.
 *
 * Worktrees get deleted — by hand, by the deck's own worktree cleanup, by a
 * `git worktree prune`. The roadmap has to be able to say that rather than go
 * on pointing at a path nobody can open, because a plan that trusts its own
 * memory over the disk is a plan that quietly stops being true.
 */
export function startedButGone(milestone) {
  return Boolean(milestone?.worktree) && !fs.existsSync(milestone.worktree)
}

/**
 * Give a milestone somewhere to work.
 *
 * Returns the roadmap on success so the panel redraws from what is now true,
 * and an error string on failure so it can say what git said.
 */
export async function startMilestone(projectPath, roadmapId, id, { run = git } = {}) {
  const current = roadmap.get(projectPath, roadmapId)
  if (!current) return { ok: false, error: 'No such roadmap' }
  const milestone = current.milestones.find((m) => m.id === id)
  if (!milestone) return { ok: false, error: 'No such milestone' }

  /*
   * Starting twice is the mistake this guard exists for: a second worktree
   * for the same milestone would split its work across two directories, and
   * the roadmap would only remember one of them.
   */
  if (milestone.worktree && !startedButGone(milestone)) {
    return { ok: false, error: `Already started in ${milestone.worktree}` }
  }

  const inside = await run(projectPath, ['rev-parse', '--git-dir'])
  if (!inside.ok) return { ok: false, error: 'This project is not a git repository' }

  // Branching needs something to branch from, and a repository with no
  // commits has nothing — worth saying plainly rather than passing git's
  // "ambiguous argument HEAD" up to the panel.
  const head = await run(projectPath, ['rev-parse', '--short', 'HEAD'])
  if (!head.ok) return { ok: false, error: 'This repository has no commits yet to branch from' }

  const taken = await takenNames(projectPath, { run })

  /*
   * Its directory is gone but its branch survived, which is what deleting a
   * worktree leaves behind. Checking the branch out again at the same path is
   * the only answer that does not abandon the commits already on it — a
   * second branch off HEAD would silently strand the work.
   */
  if (startedButGone(milestone) && milestone.branch && taken.has(milestone.branch)) {
    try {
      fs.mkdirSync(worktreeRoot(projectPath), { recursive: true })
    } catch (err) {
      return { ok: false, error: `Could not create ${worktreeRoot(projectPath)}: ${err.message}` }
    }
    const back = await run(projectPath, ['worktree', 'add', milestone.worktree, milestone.branch], 30_000)
    if (!back.ok) return { ok: false, error: back.error }
    const again = roadmap.begin(projectPath, roadmapId, id, {
      branch: milestone.branch,
      worktree: milestone.worktree,
      base: milestone.base,
    })
    if (!again.ok) return { ok: false, error: again.error }
    return { ok: true, roadmap: again.roadmap, branch: milestone.branch, worktree: milestone.worktree, reattached: true }
  }

  const { branch, name } = roadmap.plannedNames(
    // Its branch is gone too, so there is nothing left to reattach to and it
    // starts over — under a fresh name, since the old one may be half-tidied.
    startedButGone(milestone) ? { ...milestone, branch: null, worktree: null } : milestone,
    taken,
  )
  const target = path.join(worktreeRoot(projectPath), name)

  if (fs.existsSync(target)) {
    return { ok: false, error: `${target} already exists` }
  }

  try {
    fs.mkdirSync(worktreeRoot(projectPath), { recursive: true })
  } catch (err) {
    return { ok: false, error: `Could not create ${worktreeRoot(projectPath)}: ${err.message}` }
  }

  /*
   * Branched from the project's current HEAD, not from its default branch.
   * The roadmap is work on this project as it stands — and the commit it
   * started from is recorded, because "what was this based on" is the first
   * question asked of a branch that turns out to conflict.
   */
  const base = rootBranch(projectPath)
  const created = await run(projectPath, ['worktree', 'add', '-b', branch, target, 'HEAD'], 30_000)
  if (!created.ok) return { ok: false, error: created.error }

  const recorded = roadmap.begin(projectPath, roadmapId, id, {
    branch,
    worktree: target,
    base: base ? `${base}@${head.out}` : head.out,
  })

  /*
   * The worktree exists and the roadmap could not be written. Leaving the
   * directory there and saying so beats removing work-in-progress storage
   * nobody asked us to remove — and the next Start would refuse anyway,
   * naming the path, which is the thing you need to know.
   */
  if (!recorded.ok) {
    return { ok: false, error: `Created ${target}, but could not record it: ${recorded.error}` }
  }

  return { ok: true, roadmap: recorded.roadmap, branch, worktree: target }
}

/** How each landing strategy reads when the session is told about it. */
const LANDING_SENTENCE = {
  'merge-per-milestone': 'each milestone is merged as it finishes',
  'one-pr': 'everything arrives as a single pull request at the end',
}

/**
 * What the session working on a milestone is told.
 *
 * Three things beyond the task itself, and each is here because leaving it
 * out caused a specific kind of wrong work:
 *
 *   - Where it is. A session that does not know it is in a worktree on a
 *     branch of its own reaches for the project root out of habit.
 *   - What it is part of. The goal and the milestone's place in the order are
 *     the difference between doing the task and doing the task the way the
 *     rest of the roadmap needs it done.
 *   - What it must not do. Merging, pushing and opening a pull request are
 *     decided on the roadmap screen and carried out by the deck. A session
 *     that helpfully opens a PR has taken a decision that was not its to
 *     take, and it cannot be un-taken from here.
 */
export function promptFor(plan, milestone) {
  const order = plan.milestones.findIndex((m) => m.id === milestone.id) + 1
  const lines = []

  if (plan.goal) lines.push(`What this project is working towards: ${plan.goal}`, '')
  lines.push(`This is milestone ${order} of ${plan.milestones.length} on its roadmap: ${milestone.title}`, '')
  lines.push(milestone.task, '')
  lines.push(
    `You are in a worktree of your own at ${milestone.worktree}, on the branch ` +
      `${milestone.branch}${milestone.base ? `, cut from ${milestone.base}` : ''}. ` +
      'Work and commit there as you go.',
    '',
    'Do not merge, do not push and do not open a pull request. How this work lands is ' +
      `already decided — ${LANDING_SENTENCE[plan.landing] || plan.landing} — and the deck ` +
      'does it, not you. If you think the plan is wrong, say so and stop rather than ' +
      'working around it.',
  )

  return lines.join('\n')
}

/**
 * Put a session to work on a milestone that has somewhere to work.
 *
 * `launch` is the agent manager's, passed in rather than imported: this file
 * has no business owning the process table, and a test has no business
 * spawning a CLI.
 */
export async function runMilestone(projectPath, roadmapId, id, { launch, mode = 'default', isLive = () => false } = {}) {
  const plan = roadmap.get(projectPath, roadmapId)
  if (!plan) return { ok: false, error: 'No such roadmap' }
  const milestone = plan.milestones.find((m) => m.id === id)
  if (!milestone) return { ok: false, error: 'No such milestone' }

  // Order matters in these refusals: each one names the thing you would fix.
  if (!milestone.worktree) return { ok: false, error: 'Start this milestone first, so it has a worktree' }
  if (startedButGone(milestone)) return { ok: false, error: 'Its worktree is gone — start it again first' }
  if (!milestone.task?.trim()) {
    return { ok: false, error: 'Write the task first: a session needs to be told what to do' }
  }
  if (milestone.deckId && isLive(milestone.deckId)) {
    return { ok: false, error: 'A session is already working on this milestone' }
  }

  let session
  try {
    session = await launch({
      cwd: milestone.worktree,
      prompt: promptFor(plan, milestone),
      name: milestone.title,
      permissionMode: mode,
    })
  } catch (err) {
    return { ok: false, error: err.message }
  }

  /*
   * The session is running either way, so a roadmap that could not record it
   * is reported as what it is: the work started and the plan lost track of
   * it. Silence here would leave a session nobody can find from the roadmap.
   */
  const recorded = roadmap.attachSession(projectPath, roadmapId, id, {
    deckId: session.deckId,
    sessionId: session.sessionId || null,
  })
  if (!recorded.ok) {
    return { ok: false, error: `Launched the session, but could not record it: ${recorded.error}` }
  }

  return { ok: true, roadmap: recorded.roadmap, deckId: session.deckId }
}

/* ---------- finishing with a roadmap ---------- */

/**
 * Does this milestone's branch hold anything that is not already in what it
 * was cut from?
 *
 * This is the question `statusFor` cannot answer for a roadmap, and the
 * difference matters. `statusFor` asks "has this landed in origin/master",
 * which is right for a feature branch and wrong here: a milestone that was
 * started and never worked in has nothing to land, yet it would be reported
 * as unlanded for as long as your own master sits unpushed. So the base the
 * milestone recorded at Start is the thing to compare against.
 */
async function ownWork(projectPath, milestone, run) {
  const base = String(milestone.base || '').split('@').pop() || 'HEAD'
  const commits = await run(projectPath, ['rev-list', '--count', `${base}..${milestone.branch}`])
  const dirty = await run(milestone.worktree, ['status', '--porcelain'])

  return {
    commits: commits.ok ? Number(commits.out) || 0 : null,
    dirty: dirty.ok ? dirty.out.split('\n').filter(Boolean).length : null,
  }
}

/**
 * What finishing with a roadmap would leave behind, and what it would tidy.
 *
 * Shown before anything is removed, because the whole point of tidying at this
 * moment is that it is the moment you know the work is over — and the one
 * thing worse than leaving three stale worktrees around is deleting one that
 * still had something in it. Nothing here writes or deletes.
 */
export async function cleanupPlan(projectPath, roadmapId, { run = git, isLive = () => false } = {}) {
  const plan = roadmap.get(projectPath, roadmapId)
  if (!plan) return { ok: false, error: 'No such roadmap' }

  const items = []
  for (const milestone of plan.milestones) {
    if (!milestone.worktree) continue

    const entry = {
      id: milestone.id,
      title: milestone.title,
      branch: milestone.branch,
      worktree: milestone.worktree,
      name: milestone.worktree.split(/[/\\]/).pop(),
    }

    // Its directory is already gone: there is only a record left to forget.
    if (startedButGone(milestone)) {
      items.push({ ...entry, action: 'forget', why: 'its worktree is already gone' })
      continue
    }

    // A session inside it outranks everything else we might say about it.
    if (milestone.deckId && isLive(milestone.deckId)) {
      items.push({ ...entry, action: 'keep', why: 'a session is still working in it' })
      continue
    }

    const { commits, dirty } = await ownWork(projectPath, milestone, run)
    if (commits === null || dirty === null) {
      items.push({ ...entry, action: 'keep', why: 'git could not tell us what is in it' })
      continue
    }
    if (dirty > 0) {
      items.push({ ...entry, action: 'keep', why: `${dirty} uncommitted ${dirty === 1 ? 'change' : 'changes'}` })
      continue
    }

    if (commits === 0) {
      items.push({ ...entry, action: 'remove', why: 'nothing was ever committed on it' })
      continue
    }

    /*
     * It has commits of its own, so the conservative question is the right
     * one: is that work anywhere else? This is what `statusFor` is for, and
     * reusing it means a branch that landed through a merged pull request
     * counts as landed, not just one merged locally.
     */
    const status = await statusFor(projectPath, milestone.worktree, { refresh: true })
    if (status.available && status.landed) {
      items.push({
        ...entry,
        action: 'remove',
        why: `${commits} ${commits === 1 ? 'commit' : 'commits'}, already in ${status.parent || 'the parent branch'}`,
      })
    } else {
      items.push({
        ...entry,
        action: 'keep',
        why: status.blockers?.length
          ? status.blockers.join(', ')
          : `${commits} ${commits === 1 ? 'commit' : 'commits'} that are not anywhere else`,
      })
    }
  }

  const unfinished = plan.milestones.filter((m) => m.status !== 'done').length

  return {
    ok: true,
    roadmapId: plan.id,
    label: plan.label,
    unfinished,
    items,
    removable: items.filter((i) => i.action !== 'keep').length,
  }
}

/**
 * Mark a roadmap finished with, and optionally tidy what its milestones left.
 *
 * The roadmap is marked first. Tidying is the part that can fail halfway —
 * git can refuse a worktree, a branch can turn out to be checked out
 * somewhere else — and a roadmap that stayed open because a directory would
 * not delete would be a roadmap you have to come back to for no reason.
 */
export async function completeRoadmap(projectPath, roadmapId, { clean = false, run = git, isLive = () => false } = {}) {
  const preview = await cleanupPlan(projectPath, roadmapId, { run, isLive })
  if (!preview.ok) return preview

  const marked = roadmap.complete(projectPath, roadmapId)
  if (!marked.ok) return marked
  if (!clean) return { ok: true, roadmap: marked.roadmap, cleaned: [], kept: preview.items }

  const cleaned = []
  const kept = preview.items.filter((i) => i.action === 'keep')

  for (const item of preview.items) {
    if (item.action === 'keep') continue

    if (item.action === 'remove') {
      const gone = await removeWorktree(projectPath, item.worktree)
      if (!gone.ok) {
        kept.push({ ...item, action: 'keep', why: gone.error })
        continue
      }
    }

    /*
     * The branch goes with it. `-d` and not `-D`: git refusing to delete a
     * branch that is not merged is exactly the check we want at this point,
     * and a refusal here leaves the branch and says so rather than taking the
     * decision for you.
     */
    const branchGone = milestoneBranch(item) ? await run(projectPath, ['branch', '-d', item.branch]) : { ok: true }
    roadmap.detach(projectPath, roadmapId, item.id)
    cleaned.push({
      ...item,
      branchRemoved: branchGone.ok,
      branchError: branchGone.ok ? null : branchGone.error,
    })
  }

  return { ok: true, roadmap: roadmap.get(projectPath, roadmapId), cleaned, kept }
}

/** A worktree we tidied may have had no branch of its own to tidy with it. */
function milestoneBranch(item) {
  return Boolean(item.branch)
}
