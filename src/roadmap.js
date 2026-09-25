/**
 * roadmap.js — what a project is trying to get done, in order.
 *
 * A project accumulates roadmaps. One is usually being worked on, others are
 * written and waiting their turn, and the ones you are finished with go quiet
 * instead of staying on screen forever. A roadmap is a goal, a list of
 * milestones in order, and a decision about how the finished work should
 * land — which branch, which worktree, merge as you go or one pull request at
 * the end. Those are decisions about your repository: they belong to you, and
 * they belong on screen rather than inside a prompt.
 *
 * Three things this file deliberately does not do:
 *
 *   - It does not run anything. `branch`, `worktree` and `sessionId` are
 *     written here, but only by `begin` and `attachSession`, which whatever
 *     does the running calls after the fact.
 *   - It does not decide that a milestone is done. Status is yours to set.
 *   - It does not decide that a roadmap is planned or in progress. Those two
 *     are read off the milestones every time, because a state you set by hand
 *     is a state reality can contradict. Only `completed` is an act you take:
 *     "every milestone is done" is not the same as "I am finished with this",
 *     and both of those happen on their own.
 *
 * It lives in the deck's own directory rather than in your repository. A
 * roadmap that lived in the repo would be checked out at a different version
 * inside every worktree it is about to create — the one file that must not
 * fork is the plan.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { deckDir } from './platform.js'

/** How the finished work is meant to arrive. */
export const LANDINGS = ['merge-per-milestone', 'one-pr']

/** What a milestone can be. Whatever runs them owns the middle two later. */
export const STATUSES = ['todo', 'doing', 'done', 'blocked']

/** The three a roadmap can be in. Two are read; one is set. */
export const STATES = ['planned', 'in-progress', 'completed']

const MAX_TITLE = 80
/*
 * Measured against the tasks people actually write, not guessed at. The
 * longest hand-written milestone on this machine is 3,466 characters — a
 * brief with its provenance, its files, an enumerated finish line and two
 * numbered traps — and the ceiling was 4,000. That is not headroom, it is a
 * near miss, and `clean` truncates in silence: the part that would have gone
 * is the end, which is where the traps are.
 */
const MAX_TASK = 12000
const MAX_GOAL = 2000
const MAX_MILESTONES = 60
const MAX_ROADMAPS = 40

function file() {
  return path.join(deckDir(), 'roadmaps.json')
}

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

/**
 * The key a project's roadmaps are filed under.
 *
 * Resolved through symlinks, because the same project answers to more than one
 * path and a plan keyed by the spelling is a plan you can lose. On this
 * machine /var is a symlink to /private/var, so a project opened by one path
 * and written by the other ended up with two sets of roadmaps and neither of
 * them was wrong — which is the worst kind of bug to read.
 */
function keyFor(projectPath) {
  const raw = clean(projectPath, 512)
  if (!raw) return ''
  try {
    return fs.realpathSync(raw)
  } catch {
    return raw
  }
}

/** Every project's roadmaps, straight off disk. */
function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (data && typeof data.roadmaps === 'object' && data.roadmaps) return data.roadmaps
  } catch {
    // No file yet, or one we cannot parse. An empty set reads the same as a
    // project with no roadmap, which is the honest answer either way.
  }
  return {}
}

function writeAll(roadmaps) {
  try {
    fs.mkdirSync(deckDir(), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify({ roadmaps }, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

/**
 * One roadmap, as it goes to disk.
 *
 * No title of its own: the first line of the goal is the name, the same trade
 * a launched session makes with the first line of its task. A field you have
 * to fill in before you can write anything down is a field that gets filled
 * in with "test".
 */
function blank(goal) {
  const now = Date.now()
  return {
    id: randomUUID().slice(0, 8),
    goal: clean(goal, MAX_GOAL),
    landing: 'merge-per-milestone',
    milestones: [],
    createdAt: now,
    completedAt: null,
    updatedAt: now,
  }
}

/**
 * A project's roadmaps, migrating the one-per-project shape on sight.
 *
 * The first version of this file held a single roadmap per project. Reading
 * that shape into the new one here, rather than in a migration step
 * somewhere, means there is never a moment where the old file exists and
 * nothing knows how to read it.
 */
function itemsFor(all, key) {
  const stored = all[key]
  if (!stored) return []
  if (Array.isArray(stored.items)) return stored.items
  if (Array.isArray(stored.milestones)) {
    const at = stored.updatedAt || Date.now()
    return [{
      ...blank(stored.goal),
      id: 'first001',
      landing: LANDINGS.includes(stored.landing) ? stored.landing : 'merge-per-milestone',
      milestones: stored.milestones,
      createdAt: at,
      updatedAt: at,
    }]
  }
  return []
}

/**
 * Which of the three a roadmap is in.
 *
 * Read, not stored, for everything but `completed`. A roadmap is untouched
 * until something has happened to one of its milestones — started, or moved
 * off `todo` by hand — and either counts, because marking a milestone done
 * without ever giving it a worktree is a perfectly ordinary way to use this.
 */
export function stateOf(roadmap) {
  if (roadmap?.completedAt) return 'completed'
  const touched = (roadmap?.milestones || []).some(
    (m) => m.worktree || m.deckId || m.status !== 'todo',
  )
  return touched ? 'in-progress' : 'planned'
}

/** The name a roadmap goes by in a list. */
export function labelFor(roadmap) {
  const first = String(roadmap?.goal || '').trim().split('\n')[0].trim()
  if (first) return first.slice(0, MAX_TITLE)
  const count = roadmap?.milestones?.length || 0
  return count ? `${count} milestone${count === 1 ? '' : 's'}, no goal written` : 'Empty roadmap'
}

/** One roadmap plus what is read off it rather than stored. */
function decorate(roadmap) {
  return { ...roadmap, state: stateOf(roadmap), label: labelFor(roadmap) }
}

/**
 * Every roadmap a project has: what is in flight, then what is waiting, then
 * the archive — the order you actually read them in.
 */
export function list(projectPath) {
  const key = keyFor(projectPath)
  if (!key) return { path: '', roadmaps: [] }

  /*
   * State first, then newest. The tiebreaks matter more than they look: two
   * roadmaps made in the same millisecond compare equal on time, and a sort
   * that leaves them in an undefined order makes the list jump around between
   * reads for no reason anybody can see.
   */
  const rank = { 'in-progress': 0, planned: 1, completed: 2 }
  const roadmaps = itemsFor(readAll(), key)
    .map(decorate)
    .sort((a, b) => (
      rank[a.state] - rank[b.state]
      || (b.updatedAt || 0) - (a.updatedAt || 0)
      || (b.createdAt || 0) - (a.createdAt || 0)
      || a.id.localeCompare(b.id)
    ))

  return { path: key, roadmaps }
}

/** One roadmap by id, or the one worth opening when no id is given. */
export function get(projectPath, roadmapId = null) {
  const { path: key, roadmaps } = list(projectPath)
  if (!key) return null
  if (roadmapId) return roadmaps.find((r) => r.id === roadmapId) || null
  // No id: whatever is in flight, else whatever is waiting. Never the archive.
  return roadmaps.find((r) => r.state === 'in-progress')
    || roadmaps.find((r) => r.state === 'planned')
    || null
}

function save(projectPath, items) {
  const key = keyFor(projectPath)
  if (!key) return { ok: false, error: 'Unknown project' }
  const all = readAll()
  all[key] = { path: key, items }
  if (!writeAll(all)) return { ok: false, error: 'Could not save the roadmap' }
  return { ok: true }
}

/**
 * Change one roadmap in place, leaving the rest of the project alone.
 *
 * Every write goes through here, so a refusal from any of them reads the same
 * and no caller has to remember to bump `updatedAt`.
 */
function edit(projectPath, roadmapId, change) {
  const key = keyFor(projectPath)
  if (!key) return { ok: false, error: 'Unknown project' }

  const items = itemsFor(readAll(), key)
  const index = items.findIndex((r) => r.id === roadmapId)
  if (index === -1) return { ok: false, error: 'No such roadmap' }

  const changed = change(items[index])
  if (changed?.error) return { ok: false, error: changed.error }

  const next = [...items]
  next[index] = { ...changed, updatedAt: Date.now() }
  const written = save(projectPath, next)
  if (!written.ok) return written
  return { ok: true, roadmap: decorate(next[index]) }
}

export function create(projectPath, { goal = '' } = {}) {
  const key = keyFor(projectPath)
  if (!key) return { ok: false, error: 'Unknown project' }

  const items = itemsFor(readAll(), key)
  if (items.length >= MAX_ROADMAPS) {
    return { ok: false, error: `A project holds ${MAX_ROADMAPS} roadmaps` }
  }

  const roadmap = blank(goal)
  const written = save(projectPath, [...items, roadmap])
  if (!written.ok) return written
  return { ok: true, roadmap: decorate(roadmap) }
}

/**
 * Mark a roadmap finished with.
 *
 * Deliberately not conditional on every milestone being done. A roadmap you
 * are abandoning is finished with too, and refusing to file that one would
 * leave the thing you least want to look at permanently on screen.
 */
export function complete(projectPath, roadmapId) {
  return edit(projectPath, roadmapId, (r) => ({ ...r, completedAt: r.completedAt || Date.now() }))
}

/** Put a completed roadmap back in play. */
export function reopen(projectPath, roadmapId) {
  return edit(projectPath, roadmapId, (r) => ({ ...r, completedAt: null }))
}

export function setGoal(projectPath, roadmapId, goal) {
  return edit(projectPath, roadmapId, (r) => ({ ...r, goal: clean(goal, MAX_GOAL) }))
}

export function setLanding(projectPath, roadmapId, landing) {
  if (!LANDINGS.includes(landing)) return { ok: false, error: 'Unknown landing strategy' }
  return edit(projectPath, roadmapId, (r) => ({ ...r, landing }))
}

/** Drop a roadmap and everything it remembered. */
export function remove(projectPath, roadmapId) {
  const key = keyFor(projectPath)
  const items = itemsFor(readAll(), key)
  const next = items.filter((r) => r.id !== roadmapId)
  if (next.length === items.length) return { ok: false, error: 'No such roadmap' }
  const written = save(projectPath, next)
  if (!written.ok) return written
  return { ok: true }
}

/* ---------- milestones ---------- */

/**
 * A milestone as it goes to disk.
 *
 * `task` is what a session would be told to do. It is not the title: a title
 * is for reading a list of ten at a glance, and a task is a brief somebody
 * has to be able to act on without the conversation it came from.
 */
function milestone({ title, task }) {
  return {
    id: randomUUID().slice(0, 8),
    title: clean(title, MAX_TITLE),
    task: clean(task, MAX_TASK),
    status: 'todo',
    note: '',
    // Written by whatever runs these, never from the browser.
    branch: null,
    worktree: null,
    base: null,
    deckId: null,
    sessionId: null,
    startedAt: null,
    finishedAt: null,
  }
}

/**
 * A branch name out of a milestone title.
 *
 * `roadmap/210e4d97` is unique and tells you nothing, and a branch name is
 * read in `git branch`, in a pull request and in six months. So the title
 * carries it, cut to something a shell and a forge both accept, and the id is
 * held in reserve for the collision.
 */
export function slugFor(title) {
  const slug = String(title || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // acentos fuera: los refs son ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'milestone'
}

/**
 * What a milestone would be called if it started now — and what it is called
 * if it already did.
 *
 * `taken` is what already exists, so the name the screen shows is the name
 * that will actually be created rather than one that turns out to collide.
 * The id only appears when it has to.
 */
export function plannedNames(milestone, taken = new Set()) {
  if (milestone.branch || milestone.worktree) {
    return {
      branch: milestone.branch,
      name: milestone.worktree ? milestone.worktree.split(/[/\\]/).pop() : null,
    }
  }
  const slug = slugFor(milestone.title)
  const name = taken.has(slug) || taken.has(`roadmap/${slug}`) ? `${slug}-${milestone.id}` : slug
  return { branch: `roadmap/${name}`, name }
}

export function add(projectPath, roadmapId, { title, task }) {
  if (!clean(title, MAX_TITLE)) return { ok: false, error: 'A milestone needs a title' }
  return edit(projectPath, roadmapId, (r) => {
    if (r.milestones.length >= MAX_MILESTONES) {
      return { error: `A roadmap holds ${MAX_MILESTONES} milestones` }
    }
    return { ...r, milestones: [...r.milestones, milestone({ title, task })] }
  })
}

/**
 * Change a milestone. Only the fields somebody can set by hand — the rest
 * belong to whatever runs these, and letting a browser write them would mean
 * a roadmap could claim work that never happened.
 */
export function update(projectPath, roadmapId, id, changes = {}) {
  return edit(projectPath, roadmapId, (r) => {
    const index = r.milestones.findIndex((m) => m.id === id)
    if (index === -1) return { error: 'No such milestone' }

    const next = { ...r.milestones[index] }
    if ('title' in changes) {
      const title = clean(changes.title, MAX_TITLE)
      if (!title) return { error: 'A milestone needs a title' }
      next.title = title
    }
    if ('task' in changes) next.task = clean(changes.task, MAX_TASK)
    if ('note' in changes) next.note = clean(changes.note, MAX_TITLE * 4)
    if ('status' in changes) {
      if (!STATUSES.includes(changes.status)) return { error: 'Unknown status' }
      next.status = changes.status
    }

    const milestones = [...r.milestones]
    milestones[index] = next
    return { ...r, milestones }
  })
}

export function removeMilestone(projectPath, roadmapId, id) {
  return edit(projectPath, roadmapId, (r) => {
    const milestones = r.milestones.filter((m) => m.id !== id)
    if (milestones.length === r.milestones.length) return { error: 'No such milestone' }
    return { ...r, milestones }
  })
}

/**
 * Move a milestone up or down.
 *
 * The order is not decoration: it is the only statement the roadmap makes
 * about what has to happen before what. Until milestones can declare real
 * dependencies, this list read top to bottom *is* the dependency chain.
 */
export function move(projectPath, roadmapId, id, by) {
  return edit(projectPath, roadmapId, (r) => {
    const from = r.milestones.findIndex((m) => m.id === id)
    if (from === -1) return { error: 'No such milestone' }

    const to = from + (Number(by) || 0)
    if (to < 0 || to >= r.milestones.length) return r

    const milestones = [...r.milestones]
    const [moved] = milestones.splice(from, 1)
    milestones.splice(to, 0, moved)
    return { ...r, milestones }
  })
}

/**
 * Record that a milestone has started: the only writer of the fields `update`
 * refuses.
 *
 * Not reachable from the browser on purpose — what gets written here is a
 * claim that a branch and a worktree exist, and the only thing entitled to
 * make that claim is whatever just created them.
 */
export function begin(projectPath, roadmapId, id, { branch, worktree, base }) {
  return edit(projectPath, roadmapId, (r) => {
    const index = r.milestones.findIndex((m) => m.id === id)
    if (index === -1) return { error: 'No such milestone' }

    const milestones = [...r.milestones]
    milestones[index] = {
      ...milestones[index],
      branch,
      worktree,
      base: base || null,
      startedAt: Date.now(),
      // Started is in progress. From here on this field is the deck's.
      status: 'doing',
    }
    return { ...r, milestones }
  })
}

/**
 * Record the session working on a milestone.
 *
 * The deck id is what is durable here, and the Claude session id is not known
 * when a session is launched — it registers itself a moment later — so this
 * takes either, and is called again with the session id once there is one.
 * That second call is what keeps the transcript readable after the deck has
 * been restarted and the deck id means nothing any more.
 */
export function attachSession(projectPath, roadmapId, id, { deckId, sessionId } = {}) {
  return edit(projectPath, roadmapId, (r) => {
    const index = r.milestones.findIndex((m) => m.id === id)
    if (index === -1) return { error: 'No such milestone' }

    const milestones = [...r.milestones]
    milestones[index] = {
      ...milestones[index],
      ...(deckId === undefined ? {} : { deckId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
    return { ...r, milestones }
  })
}

/**
 * Forget the worktree a milestone was given.
 *
 * Called after the worktree is actually gone, so that the roadmap stops
 * pointing at a path nobody can open — and so a milestone whose directory was
 * tidied away can be started again without inventing a second branch.
 */
export function detach(projectPath, roadmapId, id) {
  return edit(projectPath, roadmapId, (r) => {
    const index = r.milestones.findIndex((m) => m.id === id)
    if (index === -1) return { error: 'No such milestone' }

    const milestones = [...r.milestones]
    milestones[index] = { ...milestones[index], branch: null, worktree: null, base: null }
    return { ...r, milestones }
  })
}
