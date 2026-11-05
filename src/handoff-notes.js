/**
 * handoff-notes.js — the notes one session leaves for the next.
 *
 * Not to be confused with handoff.js, which is the deck handing its *own*
 * sessions to its successor across a restart: same session, same id, back on
 * screen. This file is about a different session picking up the work. The
 * note is written by the `/handoff` skill into the repository, at
 * `docs/sessions/handoff-<date>-<slug>.md`, and the deck only reads it.
 *
 * ### Why the note lives in the repository
 *
 * The same reason plans.js reads plans from the repo: a note that only the
 * deck can see stops being written, and `/handoff` is just as useful from a
 * terminal. The cost is that a worktree can be deleted with a note in it —
 * which the worktree screen already refuses, because an untracked file is an
 * uncommitted change, and which /api/worktrees now names out loud.
 *
 * ### What the deck adds: whether a note was picked up
 *
 * The one fact the repository cannot hold without the deck writing into it.
 * It is kept in the deck's own directory, keyed by the note's path, and it
 * is the only thing here that writes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { deckDir } from './platform.js'
import { frontmatter } from './plans.js'

/** Where `/handoff` writes, relative to the checkout it ran in. */
export const NOTES_DIR = path.join('docs', 'sessions')
const NOTE_FILE = /^handoff-.+\.md$/

/** A ceiling, so a repo full of old notes cannot make the launcher slow. */
const MAX_NOTES = 40
/** Remembered pick-ups older than this are forgotten; the note may be too. */
const USED_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000

function usedFile() {
  return path.join(deckDir(), 'handoffs-used.json')
}

/**
 * The note's title, read the way the skill writes it: `# Handoff: <what>`,
 * optionally followed by `(<date>)`. Anything else falls back to the file
 * name, which the skill also makes readable.
 */
export function titleOf(text, file) {
  const heading = /^#\s+(.+)$/m.exec(String(text))
  let title = heading ? heading[1].trim() : ''
  title = title.replace(/^handoff:\s*/i, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '').trim()
  if (title) return title
  return path.basename(file, '.md').replace(/^handoff-(\d{4}-\d{2}-\d{2}-)?/, '').replace(/-/g, ' ')
}

/** Every note in one checkout, newest first. Never throws. */
export function scan(checkout) {
  const dir = path.join(checkout, NOTES_DIR)
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => NOTE_FILE.test(n))
  } catch {
    return []
  }
  const notes = []
  for (const name of names) {
    const file = path.join(dir, name)
    let stat, text
    try {
      stat = fs.statSync(file)
      if (!stat.isFile()) continue
      // The head is enough: frontmatter and the title are at the top.
      text = fs.readFileSync(file, 'utf8').slice(0, 4096)
    } catch {
      continue
    }
    const fields = frontmatter(text)
    notes.push({
      file,
      checkout,
      title: titleOf(text, file),
      branch: typeof fields.branch === 'string' && fields.branch ? fields.branch : null,
      created: typeof fields.created === 'string' ? fields.created : null,
      mtime: stat.mtimeMs,
    })
  }
  return notes.sort((a, b) => b.mtime - a.mtime)
}

/** Paths already picked up, with when. A missing or corrupt file is none. */
export function readUsed() {
  try {
    const data = JSON.parse(fs.readFileSync(usedFile(), 'utf8'))
    if (!data || typeof data.used !== 'object' || Array.isArray(data.used)) return {}
    const cutoff = Date.now() - USED_MAX_AGE_MS
    const out = {}
    for (const [file, at] of Object.entries(data.used)) {
      if (typeof file === 'string' && Number.isFinite(at) && at >= cutoff) out[file] = at
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Record that a session was started from this note.
 *
 * Only a file that looks like a note and exists is accepted: the path comes
 * from the browser, and this must not become a way to write arbitrary keys.
 */
export function markPickedUp(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false
  if (!NOTE_FILE.test(path.basename(file))) return false
  if (path.basename(path.dirname(file)) !== path.basename(NOTES_DIR)) return false
  if (!fs.existsSync(file)) return false
  const used = readUsed()
  used[file] = Date.now()
  const dir = deckDir()
  const target = usedFile()
  const tmp = `${target}.tmp-${process.pid}`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify({ used }, null, 2) + '\n')
    fs.renameSync(tmp, target)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch {}
    return false
  }
}

/**
 * The notes of one project — its main checkout and every worktree — each with
 * a state:
 *
 *   - `pending`: nobody started from it yet, and it is the newest for its work;
 *   - `picked-up`: a session was started from it;
 *   - `superseded`: a newer note exists for the same branch (or, with no
 *     branch recorded, the same checkout). Writing a second note is how you
 *     say the first one is out of date, so the old one stops competing.
 */
export function list(checkouts, used = readUsed()) {
  const all = []
  for (const checkout of checkouts) all.push(...scan(checkout))
  all.sort((a, b) => b.mtime - a.mtime)

  const newestFor = new Set()
  return all.slice(0, MAX_NOTES).map((note) => {
    const key = note.branch ? `branch:${note.branch}` : `dir:${note.checkout}`
    let state
    if (used[note.file] && used[note.file] >= note.mtime) state = 'picked-up'
    else if (newestFor.has(key)) state = 'superseded'
    else state = 'pending'
    newestFor.add(key)
    return { ...note, state, pickedUpAt: used[note.file] || null }
  })
}
