/**
 * browse.js — walking the filesystem for the folder picker.
 *
 * The deck is a web app, and a browser cannot hand back a real path from a
 * file input: it gives you file contents and a relative name, never the
 * folder on disk. So the browsing happens here, where the deck already runs,
 * and the panel only ever navigates — it never uploads anything.
 *
 * Only directory NAMES cross the wire. No file contents, no sizes, not even
 * the files themselves: the picker exists to choose a project folder, and
 * anything more would be a filesystem viewer nobody asked for.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** A directory with this many children is a dumping ground, not a project. */
const MAX_ENTRIES = 800

/** `~` is what people type. It is not a path any filesystem call understands. */
function expand(input) {
  const value = String(input || '').trim()
  if (!value) return os.homedir()
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return path.resolve(value)
}

/** A git checkout or a worktree — either way, something you can work in. */
function looksLikeRepo(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'))
  } catch {
    return false
  }
}

/**
 * The shortcuts across the top of the picker.
 *
 * Home first because that is where everyone's code lives, then the handful of
 * places that are worth one click on each platform. Anything that does not
 * exist on this machine is dropped rather than offered and then failing.
 */
export function shortcuts() {
  const home = os.homedir()
  const candidates = [
    { label: 'Home', path: home },
    { label: 'Documents', path: path.join(home, 'Documents') },
    { label: 'Desktop', path: path.join(home, 'Desktop') },
    { label: 'Projects', path: path.join(home, 'Projects') },
    { label: 'Developer', path: path.join(home, 'Developer') },
    { label: 'Code', path: path.join(home, 'code') },
    { label: 'Volumes', path: '/Volumes' },
  ]
  const seen = new Set()
  return candidates.filter((entry) => {
    if (seen.has(entry.path)) return false
    seen.add(entry.path)
    try {
      return fs.statSync(entry.path).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * List the subdirectories of one folder.
 *
 * Failures are values, not exceptions: browsing into a folder you cannot read
 * is ordinary navigation, and the picker should say so and stay where it was
 * rather than fall over.
 */
export function browse(inputPath, { showHidden = false } = {}) {
  const target = expand(inputPath)

  let stat
  try {
    stat = fs.statSync(target)
  } catch (err) {
    const reason = err?.code === 'EACCES' ? 'You do not have access to that folder' : 'That folder does not exist'
    return { ok: false, error: reason, path: target }
  }
  if (!stat.isDirectory()) return { ok: false, error: 'That is a file, not a folder', path: target }

  let raw
  try {
    raw = fs.readdirSync(target, { withFileTypes: true })
  } catch (err) {
    const reason = err?.code === 'EACCES' || err?.code === 'EPERM'
      ? 'macOS is blocking access to that folder'
      : 'Could not read that folder'
    return { ok: false, error: reason, path: target }
  }

  const entries = []
  for (const entry of raw) {
    if (entries.length >= MAX_ENTRIES) break
    if (!showHidden && entry.name.startsWith('.')) continue

    const full = path.join(target, entry.name)

    // A symlink says nothing about what it points at, so it has to be asked.
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = fs.statSync(full).isDirectory() } catch { continue }
    }
    if (!isDir) continue

    entries.push({ name: entry.name, path: full, isRepo: looksLikeRepo(full) })
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

  const parent = path.dirname(target)

  return {
    ok: true,
    path: target,
    name: path.basename(target) || target,
    // At the filesystem root, dirname returns the root itself: no way up.
    parent: parent === target ? null : parent,
    isRepo: looksLikeRepo(target),
    truncated: entries.length >= MAX_ENTRIES,
    entries,
    home: os.homedir(),
    separator: path.sep,
    shortcuts: shortcuts(),
  }
}
