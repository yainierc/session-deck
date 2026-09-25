/**
 * workspace.js — the folders you chose to keep an eye on.
 *
 * The session registry only knows about projects that happen to be running
 * right now. A workspace is the other half: folders you add stay in the
 * sidebar whether or not anything is open in them, so you can launch work
 * into them and follow it from one place.
 */
import fs from 'node:fs'
import path from 'node:path'
import { deckDir } from './platform.js'
import { resolveProjectRoot } from './projects.js'

function file() {
  return path.join(deckDir(), 'workspace.json')
}

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'))
    return Array.isArray(data.folders) ? data.folders : []
  } catch {
    // Missing or corrupt: an empty workspace is the right starting point.
    return []
  }
}

function write(folders) {
  const dir = deckDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file(), JSON.stringify({ folders }, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

/** Folders in the workspace, newest first, with the stale ones flagged. */
export function list() {
  return read().map((f) => ({
    ...f,
    name: path.basename(f.path),
    exists: fs.existsSync(f.path),
  }))
}

/**
 * Add a folder. The path is resolved to its repository root first, so adding
 * a subdirectory or a worktree adds the project it belongs to rather than
 * creating a second entry for the same codebase.
 */
export function add(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return { ok: false, error: 'A folder path is required' }
  }

  // ~ is what people type; it is not a path any filesystem call understands.
  let target = inputPath.trim()
  if (target.startsWith('~')) {
    return { ok: false, error: 'Use the full path, not ~' }
  }
  target = path.resolve(target)

  let stat
  try { stat = fs.statSync(target) } catch {
    return { ok: false, error: 'That folder does not exist' }
  }
  if (!stat.isDirectory()) return { ok: false, error: 'That is a file, not a folder' }

  const { root } = resolveProjectRoot(target)
  const resolved = root || target

  const folders = read()
  if (folders.some((f) => f.path === resolved)) {
    return { ok: false, error: 'That project is already in the workspace' }
  }

  folders.unshift({ path: resolved, addedAt: Date.now() })
  if (!write(folders)) return { ok: false, error: 'Could not save the workspace' }
  return { ok: true, path: resolved }
}

/**
 * Remember which branch a project pulls from, so the choice is made once.
 *
 * Only folders actually in the workspace have somewhere to keep this. A
 * project you are merely visiting because a session happens to be running
 * there is not saved anywhere, so there is nothing to write the preference
 * on — the caller is told rather than left believing it stuck.
 */
export function setPullBranch(targetPath, branch) {
  const folders = read()
  const entry = folders.find((f) => f.path === targetPath)
  if (!entry) return { ok: false, error: 'Add this project to the workspace to remember a branch for it' }

  if (branch) entry.pullBranch = String(branch)
  else delete entry.pullBranch

  if (!write(folders)) return { ok: false, error: 'Could not save the workspace' }
  return { ok: true, branch: entry.pullBranch || null }
}

/** The remembered branch for a project, or null if it has none. */
export function pullBranchFor(targetPath) {
  return read().find((f) => f.path === targetPath)?.pullBranch || null
}

export function remove(targetPath) {
  const folders = read()
  const next = folders.filter((f) => f.path !== targetPath)
  if (next.length === folders.length) return { ok: false, error: 'Not in the workspace' }
  if (!write(next)) return { ok: false, error: 'Could not save the workspace' }
  return { ok: true }
}

/**
 * Move a project one place up or down the sidebar.
 *
 * The order was already here — this file's array *is* the order the menu is
 * drawn in, and `add` puts a new folder at the top. All that was missing was
 * a way to say so. Nothing about how the list is rendered changes.
 *
 * One step at a time, and the step is named rather than the destination.
 * The alternative — the panel sending back the whole list in its new order —
 * is the same feature with a way to lose a folder in it: that list is a
 * snapshot, and a folder added from your phone between the render and the
 * click would be missing from it, so saving it would silently drop the
 * folder. A swap with a neighbour cannot delete anything it does not know
 * about, and it reads the file at the moment it acts.
 *
 * Being already at the end is not a failure. The buttons for it are disabled,
 * so the only way to arrive here is a race, and "it is already where you
 * asked for it" is the outcome that was wanted, not an error to show.
 */
export function move(targetPath, direction) {
  const step = direction === 'up' ? -1 : direction === 'down' ? 1 : 0
  if (!step) return { ok: false, error: 'Direction must be up or down' }

  const folders = read()
  const from = folders.findIndex((f) => f.path === targetPath)
  if (from === -1) return { ok: false, error: 'Not in the workspace' }

  const to = from + step
  if (to < 0 || to >= folders.length) return { ok: true, moved: false }

  const next = [...folders]
  next[from] = folders[to]
  next[to] = folders[from]
  if (!write(next)) return { ok: false, error: 'Could not save the workspace' }
  return { ok: true, moved: true }
}
