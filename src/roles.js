/**
 * roles.js — the jobs you put people in, as opposed to the errands you send
 * them on.
 *
 * These were briefly the same thing as the launcher's shortcuts, and the
 * composer offered "Catch me up" as a role to staff a team with. They are not
 * the same thing and the difference is not a nuance:
 *
 *   - a shortcut is a task with an end. "Review my changes" is done when the
 *     review is written, and the session that ran it has nothing left to be.
 *   - a role is a standing brief. "Backend" is not finished when the migration
 *     lands; it is what that session is for as long as the team exists, and it
 *     is the thing the others address when they need the API explained.
 *
 * A role therefore says how to behave rather than what to produce, and what it
 * is actually working on arrives separately, as the team's goal. Writing the
 * task into the role is how you end up with one role per project per sprint.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { deckDir } from './platform.js'
import { cleanModel, cleanEffort } from './choices.js'

/**
 * The four shipped ones.
 *
 * Deliberately a shape rather than a methodology: a supervisor that does not
 * write code, two that build on either side of a contract, and one that only
 * reads. They carry no model, no effort and no advisor, for the same reason
 * the shipped shortcuts do not — a default that quietly spends more than the
 * panel's own default is a bill nobody asked for.
 *
 * Every brief says the same two things in its own words, because they are what
 * make a team cheaper than one session doing everything: ask the peer who
 * already has that repository loaded instead of reading it yourself, and stop
 * at the decisions that are not yours to make.
 */
const DEFAULTS = [
  {
    id: 'supervisor',
    name: 'Supervisor',
    delegates: true,
    brief:
      'You coordinate this team. Keep the plan, split it into pieces that fit one session each, '
      + 'and hand them out by writing to the others by name. Do not write code yourself.\n\n'
      + 'When you need to know what another project does, ask the session that has it loaded '
      + 'rather than reading its repository: it costs a message instead of fifty file reads. '
      + 'Bring decisions that cross two areas back to the user instead of settling them alone.',
  },
  {
    id: 'backend',
    name: 'Backend',
    brief:
      'You own the API and the data in this project. Implement what the supervisor hands you.\n\n'
      + 'Stop and ask before anything that is hard to undo: a schema migration, a change to a '
      + 'response another project consumes, or deleting data. If the frontend needs a contract '
      + 'changed, agree it with them first rather than shipping and letting them find out.',
  },
  {
    id: 'frontend',
    name: 'Frontend',
    brief:
      'You own the web layer in this project. Implement what the supervisor hands you.\n\n'
      + 'Ask the backend session what an endpoint actually returns instead of guessing from the '
      + 'code or from memory, and agree any change to a shape with them before you build against '
      + 'it. Say when a design decision is yours to make and when it is not.',
  },
  {
    id: 'analyst',
    name: 'Analyst',
    brief:
      'You read and report. Change nothing: no edits, no commands that write.\n\n'
      + 'Answer with where it comes from — a repository and a file and a line — so the answer can '
      + 'be checked. When you are asked something that lives in another project, say so and name '
      + 'the session that would know, rather than guessing.',
  },
]

function file() {
  return path.join(deckDir(), 'roles.json')
}

/**
 * One stored record, reduced to what this file vouches for.
 *
 * The file is plain JSON in a directory you can open, so what comes out of it
 * is somebody's typing. An unrecognised model or effort becomes the default
 * rather than an error: the role still works, it has just stopped claiming
 * something the CLI would refuse.
 */
function clean(record) {
  if (!record || typeof record !== 'object') return null
  const name = String(record.name || '').trim()
  const brief = String(record.brief || '').trim()
  if (!name || !brief) return null
  return {
    id: String(record.id || randomUUID().slice(0, 8)),
    name,
    brief,
    model: cleanModel(record.model),
    effort: cleanEffort(record.effort),
    advisor: record.advisor === true,
    // A sensible starting point, never the last word: the composer asks per
    // member, because the same role supervises on one team and builds on
    // another.
    delegates: record.delegates === true,
  }
}

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (Array.isArray(data.roles)) return data.roles.map(clean).filter(Boolean)
  } catch {
    // No file yet: the shipped four are more use than an empty list.
  }
  return DEFAULTS.map(clean)
}

function write(roles) {
  const target = file()
  const tmp = `${target}.tmp-${process.pid}`
  try {
    fs.mkdirSync(deckDir(), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ roles }, null, 2) + '\n')
    fs.renameSync(tmp, target)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch {}
    return false
  }
}

export function list() {
  return read()
}

export function add({ name, brief, model, effort, advisor, delegates }) {
  const cleanName = String(name || '').trim()
  if (!cleanName) return { ok: false, error: 'A name is required' }
  if (!String(brief || '').trim()) return { ok: false, error: 'A brief is required' }
  if (cleanName.length > 40) return { ok: false, error: 'Keep the name under 40 characters' }

  const roles = read()
  if (roles.some((r) => r.name.toLowerCase() === cleanName.toLowerCase())) {
    return { ok: false, error: 'You already have a role with that name' }
  }

  const role = clean({ id: randomUUID().slice(0, 8), name: cleanName, brief, model, effort, advisor, delegates })
  if (!write([...roles, role])) return { ok: false, error: 'Could not save' }
  return { ok: true, role }
}

/**
 * Change one that already exists.
 *
 * A patch rather than a replacement, because the editor sends what you touched
 * and a role has fields that screen never shows. Passing a key means setting
 * it; leaving it out means leaving it alone — which is also how clearing a
 * model works, by sending null rather than by omitting it.
 */
export function update(id, patch) {
  const roles = read()
  const found = roles.find((r) => r.id === id)
  if (!found) return { ok: false, error: 'No such role' }

  const merged = { ...found, ...patch, id: found.id }
  const next = clean(merged)
  if (!next) return { ok: false, error: 'A name and a brief are both needed' }
  if (next.name.length > 40) return { ok: false, error: 'Keep the name under 40 characters' }
  if (roles.some((r) => r.id !== id && r.name.toLowerCase() === next.name.toLowerCase())) {
    return { ok: false, error: 'You already have a role with that name' }
  }

  if (!write(roles.map((r) => (r.id === id ? next : r)))) return { ok: false, error: 'Could not save' }
  return { ok: true, role: next }
}

export function remove(id) {
  const roles = read()
  const next = roles.filter((r) => r.id !== id)
  if (next.length === roles.length) return { ok: false, error: 'No such role' }
  if (!write(next)) return { ok: false, error: 'Could not save' }
  return { ok: true }
}

/**
 * Put back any of the shipped four that are missing, and keep everything else.
 *
 * Deliberately not the same as the shortcuts' reset, which replaces the list.
 * A shortcut is a sentence you could retype; a role is a paragraph somebody
 * sat down and wrote, and it is the substance of how a team behaves. Losing
 * four of those to a button labelled with one word is not a thing to risk for
 * the sake of matching another screen.
 *
 * Matched by name rather than by id, because a shipped role you edited and
 * renamed is yours now and should not come back doubled.
 */
export function reset() {
  const current = read()
  const names = new Set(current.map((r) => r.name.toLowerCase()))
  const missing = DEFAULTS.map(clean).filter((r) => !names.has(r.name.toLowerCase()))
  if (missing.length === 0) return { ok: true, roles: current, restored: 0 }
  const roles = [...current, ...missing]
  if (!write(roles)) return { ok: false, error: 'Could not save' }
  return { ok: true, roles, restored: missing.length }
}
