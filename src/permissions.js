/**
 * permissions.js — the rules that decide what a session stops to ask about.
 *
 * The deck does not own these. Claude Code keeps them in settings files, and
 * both a terminal session and a deck session read the same ones, so this is a
 * reader and editor of somebody else's format rather than a store of our own.
 *
 * Three files are in play, and which one a rule lands in is the whole reason
 * this screen needs to exist: a rule saved while working in one project is
 * invisible from the next, and until now nothing showed you that.
 *
 *   user     ~/.claude/settings.json           every project, every session
 *   project  <root>/.claude/settings.json      this project, shared in git
 *   local    <root>/.claude/settings.local.json this project, just you
 *
 * We only ever touch the `permissions` key. These files hold hooks, model
 * choices and env of somebody's careful making, and a tool that rewrites more
 * than it was asked to is a tool you stop trusting with the file.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The buckets Claude Code understands, in the order we show them. */
export const LISTS = ['allow', 'ask', 'deny']

/**
 * Where a rule can live. `local` is the default for a new rule: it is the
 * file Claude Code itself writes to, and the one git already ignores, so
 * nothing you allow here turns up in a teammate's diff.
 */
export const SOURCES = [
  {
    id: 'local',
    label: 'This project, only you',
    file: '.claude/settings.local.json',
    hint: 'Not committed. Where Claude Code saves what you allow.',
  },
  {
    id: 'project',
    label: 'This project, the whole team',
    file: '.claude/settings.json',
    hint: 'Committed to git. Everyone who clones the repo gets these.',
  },
  {
    id: 'user',
    label: 'Every project',
    file: '~/.claude/settings.json',
    hint: 'Applies everywhere on this machine, whatever you are working on.',
  },
]

function fileFor(source, root) {
  if (source === 'user') return path.join(os.homedir(), '.claude', 'settings.json')
  if (!root) return null
  if (source === 'project') return path.join(root, '.claude', 'settings.json')
  if (source === 'local') return path.join(root, '.claude', 'settings.local.json')
  return null
}

/**
 * Read one settings file whole.
 *
 * A missing file is not a problem — most projects have never had one — but a
 * malformed file is, and it must not read as "no rules": that would invite
 * you to add a rule and overwrite whatever the file really held.
 */
function readFile(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { data: {}, missing: true }
    return { data: null, error: err.code === 'EACCES' ? 'Not readable' : err.message }
  }
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { data: null, error: 'Not a JSON object' }
    }
    return { data }
  } catch {
    return { data: null, error: 'Not valid JSON' }
  }
}

function rulesOf(data) {
  const perms = data?.permissions
  const out = {}
  for (const list of LISTS) {
    const value = perms?.[list]
    out[list] = Array.isArray(value) ? value.filter((r) => typeof r === 'string') : []
  }
  return out
}

/**
 * Every rule in force for a project, grouped by where it is written.
 *
 * Sources a project cannot have (there is no project file without a project)
 * are left out rather than reported as empty, so the screen never offers you
 * a place a rule could not go.
 */
export function overview(root) {
  const sources = []

  for (const source of SOURCES) {
    const file = fileFor(source.id, root)
    if (!file) continue

    const { data, missing, error } = readFile(file)
    sources.push({
      ...source,
      path: file,
      missing: Boolean(missing),
      error: error || null,
      // An unreadable file has rules we cannot see; showing zero would be a lie.
      rules: error ? null : rulesOf(data),
    })
  }

  const counts = {}
  for (const list of LISTS) {
    counts[list] = sources.reduce((sum, s) => sum + (s.rules?.[list]?.length || 0), 0)
  }

  return { root: root || null, sources, counts }
}

/**
 * Add or remove one rule, leaving every other key in the file untouched.
 *
 * Writes go through a temporary file in the same directory and one rename, so
 * an interrupted write cannot leave you with a half-written settings file —
 * which, for the file that decides what runs without asking, is the one
 * failure worth spending a few lines to make impossible.
 */
function edit(source, root, apply) {
  const file = fileFor(source, root)
  if (!file) return { ok: false, error: 'That project has no such settings file' }

  const { data, error } = readFile(file)
  if (error) return { ok: false, error: `Leaving ${file} alone: ${error}` }

  const next = { ...data }
  const perms = { ...(next.permissions || {}) }
  const changed = apply(perms)
  if (!changed.ok) return changed

  next.permissions = perms

  const tmp = `${file}.deck-${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
    return { ok: false, error: `Could not write ${file}: ${err.message}` }
  }

  return { ok: true }
}

export function addRule({ source, root, list, rule }) {
  if (!LISTS.includes(list)) return { ok: false, error: 'Unknown list' }
  const text = String(rule || '').trim()
  if (!text) return { ok: false, error: 'A rule is required' }

  return edit(source, root, (perms) => {
    const current = Array.isArray(perms[list]) ? perms[list] : []
    if (current.includes(text)) return { ok: false, error: 'That rule is already there' }
    perms[list] = [...current, text]
    return { ok: true }
  })
}

export function removeRule({ source, root, list, rule }) {
  if (!LISTS.includes(list)) return { ok: false, error: 'Unknown list' }

  return edit(source, root, (perms) => {
    const current = Array.isArray(perms[list]) ? perms[list] : []
    if (!current.includes(rule)) return { ok: false, error: 'That rule is no longer there' }
    perms[list] = current.filter((r) => r !== rule)
    return { ok: true }
  })
}
