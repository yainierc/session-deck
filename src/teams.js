/**
 * teams.js — the groups you raised, written down.
 *
 * Without this file a team exists only in the moment it is launched: the
 * sessions come up, they get introduced to each other, and from then on they
 * are indistinguishable from any other session running on this machine. A
 * screen about teams then has nothing to show but everything, arranged — which
 * is what the first version of that screen did, and it looked like the session
 * list wearing columns.
 *
 * What is stored is the smallest thing that answers "who is in this": the
 * deckIds, and who hands out the work. Everything else — the name on screen,
 * the project, whether it is busy or stopped or waiting on you — is looked up
 * live from the session list, because all of it changes and none of it would
 * stay true in a file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { deckDir } from './platform.js'

/**
 * How many teams are kept.
 *
 * A team outlives its sessions on purpose — you raise the same four roles on
 * Monday and want them back on Tuesday — but a list that only grows is a list
 * nobody reads. The oldest fall off the end.
 */
const MAX_TEAMS = 40

/**
 * How many put-away teams are kept, and for how long.
 *
 * Putting one away is not deleting it, because the thing being removed cannot
 * be rebuilt by hand: the members are deckIds, and once the record is gone the
 * only way back is to read start times out of the handoff file and guess which
 * cluster was which. That happened, to a real team of six, from a bare `×` with
 * no confirmation. A record this small is not worth destroying promptly.
 */
const MAX_DISMISSED = 20
const DISMISSED_TTL = 60 * 24 * 60 * 60 * 1000

function file() {
  return path.join(deckDir(), 'teams.json')
}

/**
 * One stored record, reduced to what this file vouches for.
 *
 * A team with no members is not a team; it is the residue of a launch where
 * every member failed, and offering it back would be offering an empty box.
 */
function clean(raw) {
  if (!raw || typeof raw !== 'object') return null
  const members = Array.isArray(raw.members)
    ? raw.members
      .filter((m) => m && typeof m.deckId === 'string' && m.deckId)
      .map((m) => ({
        deckId: m.deckId,
        // Kept so a member that has exited still has a name in the list; the
        // live one wins whenever there is a live one.
        label: typeof m.label === 'string' ? m.label : '',
        address: typeof m.address === 'string' ? m.address : '',
        project: typeof m.project === 'string' ? m.project : '',
        delegates: m.delegates === true,
      }))
    : []
  if (members.length === 0) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID().slice(0, 8),
    name: String(raw.name || '').trim().slice(0, 60) || 'Team',
    /*
     * What this team was raised to do, as typed. Kept beside the name because
     * a list of four teams called after their projects tells you nothing about
     * which one you came back for.
     */
    goal: String(raw.goal || '').trim().slice(0, 400),
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : Date.now(),
    /*
     * When it was put away, if it was. Absent on a team that is still on the
     * screen — not `null`, so a file written before this existed reads as
     * "never put away" rather than as something that needs fixing.
     */
    ...(Number.isFinite(raw.dismissedAt) ? { dismissedAt: raw.dismissedAt } : {}),
    members,
  }
}

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (Array.isArray(data.teams)) return data.teams.map(clean).filter(Boolean)
  } catch {
    // No file yet, or a half-written one. An empty list is the right start.
  }
  return []
}

/**
 * Both lists trimmed to their own limits, as one array.
 *
 * Kept apart on the way through: twenty put-away teams should not push a
 * running one off the end, and a running one should not be the reason a team
 * you put away yesterday is unrecoverable today.
 */
function prune(all) {
  const now = Date.now()
  const live = all.filter((t) => !t.dismissedAt)
  const away = all
    .filter((t) => t.dismissedAt && now - t.dismissedAt < DISMISSED_TTL)
    .sort((a, b) => b.dismissedAt - a.dismissedAt)
  return [...live.slice(0, MAX_TEAMS), ...away.slice(0, MAX_DISMISSED)]
}

function write(teams) {
  const target = file()
  const tmp = `${target}.tmp-${process.pid}`
  try {
    fs.mkdirSync(deckDir(), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ teams: prune(teams) }, null, 2) + '\n')
    fs.renameSync(tmp, target)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch {}
    return false
  }
}

/** Newest first: the one you just raised is the one you are looking for. */
export function list() {
  return read().filter((t) => !t.dismissedAt).sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * The ones put away, most recently put away first.
 *
 * Ordered by when you put it away rather than when it was raised, because the
 * reason anybody reads this list is that they have just put the wrong one away
 * and want it back — and that one is at the top.
 */
export function dismissed() {
  return read().filter((t) => t.dismissedAt).sort((a, b) => b.dismissedAt - a.dismissedAt)
}

/**
 * Write down a team that was just raised.
 *
 * Only the members that actually started. One that failed to launch has no
 * deckId and no process; keeping it would put a card on the screen for a
 * session that does not exist and never did.
 */
export function remember({ name, goal, members }) {
  const team = clean({
    id: randomUUID().slice(0, 8),
    name,
    goal,
    startedAt: Date.now(),
    members,
  })
  if (!team) return { ok: false, error: 'No member of that team started' }
  if (!write([team, ...read()].slice(0, MAX_TEAMS))) {
    return { ok: false, error: 'Could not save the team' }
  }
  return { ok: true, team }
}

/**
 * Take one off the screen. The sessions are left exactly as they are.
 *
 * The record is marked, not removed. What a team stores is six deckIds, and a
 * deckId is not something you can type back in — reconstructing one deleted by
 * mistake meant matching start times in the handoff file against a proposal
 * that happened to survive. Marked, it comes back with a click.
 */
export function forget(id) {
  const all = read()
  const team = all.find((t) => t.id === id && !t.dismissedAt)
  if (!team) return { ok: false, error: 'No such team' }
  team.dismissedAt = Date.now()
  if (!write(all)) return { ok: false, error: 'Could not save' }
  return { ok: true, team }
}

/** Put one back on the screen. */
export function restore(id) {
  const all = read()
  const team = all.find((t) => t.id === id && t.dismissedAt)
  if (!team) return { ok: false, error: 'That team is not in the put-away list' }
  delete team.dismissedAt
  if (!write(all)) return { ok: false, error: 'Could not save' }
  return { ok: true, team }
}

/**
 * The teams, with each member matched to the session it is now.
 *
 * Matched by deckId, which is the deck's own identifier and survives the
 * session being suspended, resumed and renamed. A member with no live session
 * is carried through as `gone` rather than dropped: a team of four where one
 * has exited is four people, one of whom left, and a screen that quietly shows
 * three is a screen that has stopped describing what you raised.
 */
export function withSessions(sessions) {
  const byDeckId = new Map(sessions.filter((s) => s.deckId).map((s) => [s.deckId, s]))
  return list().map((team) => ({
    ...team,
    members: team.members.map((member) => {
      const session = byDeckId.get(member.deckId) || null
      return {
        ...member,
        session,
        live: Boolean(session),
      }
    }),
  }))
}
