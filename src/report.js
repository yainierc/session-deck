/**
 * report.js — what a finished roadmap actually did, assembled from evidence.
 *
 * Six milestones end, and the question is what happened across them. The
 * obvious way to answer it is to ask: the sessions that did the work are
 * right there, and each one can describe its own milestone.
 *
 * It is the wrong way twice over. By the time a roadmap is finished those
 * sessions have usually exited, and a session's registry entry goes with its
 * process — there is nobody left to ask. And a session that is still alive is
 * the least reliable witness available to the question: it reports what it
 * remembers intending, after a compaction or two, and it reports it
 * favourably. The diff does not.
 *
 * So nothing here talks to anybody. Everything an answer needs is already on
 * disk and outlives every process involved:
 *
 *   the brief   — `task`, from the roadmap record, which is what was asked
 *   the work    — `git log` and `git diff` between the milestone's base and
 *                 its branch, which is what was done
 *   the outcome — `status`, `note`, and where the branch ended up landing
 *   the why     — the transcript, kept for the cases the diff cannot explain:
 *                 a milestone that blocked, or one whose diff and brief
 *                 disagree
 *
 * Assembled in that order because it is the order of cost. Git is
 * milliseconds and is ground truth; transcripts are megabytes and are
 * hearsay. The dossier carries paths to the transcripts rather than their
 * contents, so whoever writes the report opens only the ones it needs.
 *
 * The freezing is the point. This runs before anything is tidied, so a
 * roadmap can be closed now and swept after its pull request merges without
 * the sweep taking the evidence with it.
 */
import path from 'node:path'
import * as roadmap from './roadmap.js'
import { git } from './git.js'
import { pullRequestForBranch } from './forges.js'
import { findTranscript } from './transcripts.js'

/** How many commits of one milestone are worth carrying. */
const MAX_COMMITS = 50

/** And how many file names. */
const MAX_FILES = 40

/**
 * Where a milestone's work ended up.
 *
 * `merged` and `empty` are the two that make a worktree safe to remove, and
 * they are different reasons: one landed, the other never had anything to
 * land. Keeping them apart matters in the report — "nothing was written for
 * this milestone" is a finding, and collapsing it into "tidied" hides it.
 */
export const LANDINGS = ['merged', 'pr-open', 'pr-closed', 'unlanded', 'empty', 'none']

/** The ones whose worktree and branch can go without losing anything. */
const SAFE_TO_TIDY = new Set(['merged', 'empty', 'none'])

/**
 * Whether a branch has landed, asked two ways because either can be the one
 * that knows.
 *
 * `--is-ancestor` is local and exact, and it is blind to a merge that
 * happened on the forge while this checkout has not fetched since. The pull
 * request knows about that one and knows nothing about a branch merged
 * locally and never pushed. A branch that either test calls landed, landed.
 */
async function hasLanded(repoRoot, cwd, branch, into, deps) {
  const ancestor = await deps.run(repoRoot, ['merge-base', '--is-ancestor', branch, into])
  if (ancestor.ok) return { landed: true, pr: null }

  const pr = await deps.pr(repoRoot, cwd, branch)
  return { landed: String(pr?.state || '').toUpperCase() === 'MERGED', pr }
}

/**
 * One milestone, as evidence rather than as recollection.
 *
 * Every git call is allowed to fail without failing the milestone: a branch
 * deleted by hand, a base that no longer resolves, a worktree moved. What
 * comes back then is a milestone whose record is intact and whose diff is
 * unknown, which is true and still worth reporting — the alternative is one
 * unreadable branch costing you the whole report.
 */
async function milestoneEvidence(repoRoot, milestone, deps) {
  const { branch, base } = milestone
  const cwd = milestone.worktree || repoRoot

  const evidence = {
    id: milestone.id,
    title: milestone.title,
    task: milestone.task,
    status: milestone.status,
    note: milestone.note || '',
    branch: branch || null,
    base: base || null,
    startedAt: milestone.startedAt || null,
    finishedAt: milestone.finishedAt || null,
    /*
     * The path and not the contents. A roadmap of a dozen milestones is a
     * dozen transcripts and hundreds of megabytes; the report opens the two
     * or three where the diff does not explain the outcome.
     */
    transcript: milestone.sessionId ? deps.transcript(milestone.sessionId) : null,
    commits: [],
    files: [],
    diffstat: null,
    landing: 'none',
    pr: null,
  }

  if (!branch || !base) return evidence

  /*
   * A milestone records `base` as `<branch>@<commit>`: the branch it was cut
   * from and, crucially, the commit that branch was sitting on at the time.
   * Both halves are used here and they are not interchangeable.
   *
   * The commit is what the diff is measured from. Measuring against the
   * branch instead would read correctly right up until the milestone merges,
   * at which point "what is on this branch that master has not got" becomes
   * "nothing" — and a merged milestone would be filed as one that never wrote
   * anything. That is the single mistake here that makes the sweep delete
   * work after calling it worthless. A recorded commit does not move.
   *
   * The branch name is what landing is asked of, because landing is exactly
   * the question of whether that moving ref has caught up.
   */
  const recorded = String(base).split('@')
  const from = recorded.length > 1 ? recorded.pop() : base
  const into = recorded.length > 0 && recorded.join('@') ? recorded.join('@') : 'HEAD'

  const log = await deps.run(repoRoot, ['log', '--format=%h %s', `-${MAX_COMMITS}`, `${from}..${branch}`])
  if (log.ok) evidence.commits = log.out ? log.out.split('\n') : []

  const files = await deps.run(repoRoot, ['diff', '--name-only', `${from}..${branch}`])
  if (files.ok && files.out) evidence.files = files.out.split('\n').slice(0, MAX_FILES)

  const stat = await deps.run(repoRoot, ['diff', '--shortstat', `${from}..${branch}`])
  if (stat.ok && stat.out) evidence.diffstat = stat.out

  evidence.from = from

  // Nothing was written, so there is nothing to have landed. Asking the forge
  // about a branch with no commits on it is a network call for a known answer.
  if (evidence.commits.length === 0 && evidence.files.length === 0) {
    evidence.landing = 'empty'
    return evidence
  }

  const { landed, pr } = await hasLanded(repoRoot, cwd, branch, into, deps)
  evidence.pr = pr
  if (landed) evidence.landing = 'merged'
  else if (pr) evidence.landing = String(pr.state).toUpperCase() === 'CLOSED' ? 'pr-closed' : 'pr-open'
  else evidence.landing = 'unlanded'

  return evidence
}

/**
 * The whole roadmap, frozen.
 *
 * Deps are injectable for the same reason they are in roadmap-runner: these
 * tests must be able to describe a repository state — a branch merged, a pull
 * request open, a base that vanished — without building one.
 */
export async function dossierFor(projectPath, roadmapId, deps = {}) {
  const resolved = {
    run: deps.run || git,
    pr: deps.pr || pullRequestForBranch,
    transcript: deps.transcript || findTranscript,
  }

  const plan = roadmap.get(projectPath, roadmapId)
  if (!plan) return { ok: false, error: 'No such roadmap' }

  const milestones = []
  for (const milestone of plan.milestones || []) {
    milestones.push(await milestoneEvidence(projectPath, milestone, resolved))
  }

  return {
    ok: true,
    dossier: {
      roadmapId: plan.id,
      goal: plan.goal || '',
      label: plan.label || '',
      landing: plan.landing,
      project: path.basename(projectPath),
      projectPath,
      frozenAt: Date.now(),
      milestones,
    },
  }
}

/**
 * The milestones whose worktree and branch can be removed without losing
 * anything that is not already in the base branch.
 *
 * Asked of a dossier taken *at the moment of sweeping*, never of the one
 * frozen when the roadmap was closed. The gap between those two moments is
 * the whole point of closing and sweeping separately: what happens in it is
 * somebody merging the pull request, which is precisely the fact that turns
 * an `unlanded` milestone into one that is safe to remove. Sweeping against
 * the frozen copy would refuse to tidy anything that landed after closing —
 * which, with a `one-pr` landing, is everything.
 *
 * The frozen dossier is evidence for the report. This is a decision about the
 * repository as it stands.
 */
export function tidyable(dossier) {
  return (dossier?.milestones || []).filter((m) => SAFE_TO_TIDY.has(m.landing))
}

/** The ones still holding work that is not in the base branch. */
export function outstanding(dossier) {
  return (dossier?.milestones || []).filter((m) => !SAFE_TO_TIDY.has(m.landing))
}

/**
 * The dossier as the panel needs it: where every milestone stands, without
 * the commit lists and file names that only the report reads.
 *
 * Sent to the browser so the closing screen can say what landed and what did
 * not, per milestone, instead of a count. "Four of six landed" is a number
 * you cannot act on; the two names are what tell you which pull request to go
 * and merge.
 */
export function summaryOf(dossier) {
  return {
    frozenAt: dossier.frozenAt,
    landing: dossier.landing,
    milestones: (dossier.milestones || []).map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      landing: m.landing,
      branch: m.branch,
      commits: m.commits.length,
      diffstat: m.diffstat,
      pr: m.pr ? { number: m.pr.number, state: m.pr.state, url: m.pr.url } : null,
    })),
  }
}

/** A milestone as a block the reporting session reads. */
function block(m, index, total) {
  const lines = [
    `### ${index + 1}/${total} — ${m.title}`,
    `status: ${m.status}${m.note ? ` — ${m.note}` : ''}`,
    `landing: ${m.landing}${m.pr ? ` (PR #${m.pr.number}, ${m.pr.state}, ${m.pr.url})` : ''}`,
    `brief: ${m.task || '(none written)'}`,
  ]

  if (m.branch) lines.push(`branch: ${m.branch} (from ${m.base})`)
  if (m.diffstat) lines.push(`diff: ${m.diffstat}`)
  if (m.commits.length) lines.push('commits:', ...m.commits.map((c) => `  ${c}`))
  if (m.files.length) lines.push('files:', ...m.files.map((f) => `  ${f}`))
  if (!m.commits.length && !m.files.length) lines.push('no commits and no files on this branch')
  if (m.transcript) lines.push(`transcript: ${m.transcript}`)

  return lines.join('\n')
}

/**
 * The brief for the session that writes the report.
 *
 * It is handed the evidence rather than told to go and find it, because the
 * finding is the part that has to happen before the worktrees are swept, and
 * a session told to "look at the branches" would do it minutes later against
 * a repository somebody may already be tidying.
 *
 * What it is told to distrust is deliberate. The brief is what somebody
 * wanted; the diff is what happened; the two disagreeing is the single most
 * useful line a report like this can contain, and a reporter that smooths it
 * over has written a status update instead of a report.
 */
export function promptFor(dossier, { file }) {
  const total = dossier.milestones.length
  const blocks = dossier.milestones.map((m, i) => block(m, i, total)).join('\n\n')

  return [
    `Write the closing report for the roadmap "${dossier.label}" in ${dossier.project}.`,
    '',
    dossier.goal ? `The goal it was working towards:\n${dossier.goal}` : 'No goal was written down.',
    '',
    `Landing mode: ${dossier.landing}. ${total} milestone${total === 1 ? '' : 's'}.`,
    '',
    'The evidence is below, already gathered — every milestone with what it was',
    'asked to do, what its branch actually contains, and where that branch ended',
    'up. It was frozen just now, so it stays true even if the worktrees are',
    'swept while you write.',
    '',
    blocks,
    '',
    '---',
    '',
    `Write it to ${file}, as markdown, and write nothing else. Do not change any`,
    'other file, do not commit, and do not touch a branch or a worktree.',
    '',
    'What the report has to do:',
    '',
    '- Say what the roadmap achieved, in a few sentences somebody who was not',
    '  here can read. Lead with the outcome, not with the process.',
    '- One short section per milestone: what it was asked for, what landed, and',
    '  where that is now.',
    '- **Name every disagreement between the brief and the diff.** A milestone',
    '  marked done whose branch is empty, one whose files have nothing to do',
    '  with its task, one that did far more than it was asked — those are the',
    '  findings. Do not smooth them over; a report that reads well and hides one',
    '  of these is worse than no report.',
    '- Say plainly what has not landed yet and what is waiting on a merge.',
    '- End with what is left to do, if anything is.',
    '',
    'Where the evidence runs out, open the transcript listed for that milestone —',
    'but only where it is needed: a milestone that blocked, or one whose diff and',
    'brief do not match. Read them in parallel with subagents, one per milestone,',
    'and have each return a few lines rather than a summary of the conversation.',
    'The transcripts are the one part of this that is hearsay: they say what a',
    'session believed it was doing. Where they contradict the diff, the diff won.',
    '',
    'Do not estimate anything you were not given — no percentages, no effort, no',
    'quality judgements about code you have not read.',
  ].join('\n')
}

/**
 * Where a roadmap's report is written.
 *
 * Inside the repository, because that is the only place it survives the deck,
 * the machine and the sessions that did the work — and the place somebody
 * reviewing the pull request will actually come across it.
 */
export function reportPath(dossier) {
  const stamp = new Date(dossier.frozenAt || Date.now()).toISOString().slice(0, 10)
  const slug = String(dossier.label || 'roadmap')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'roadmap'
  return path.join('reports', `${stamp}-${slug}.md`)
}
