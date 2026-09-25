/**
 * projects.js — working out which project a directory belongs to.
 *
 * Grouping by cwd alone splits a project apart: a git worktree, or a session
 * opened in a subdirectory, shows up as its own project even though it is the
 * same codebase. We resolve the repository root instead.
 *
 * This reads files rather than shelling out to `git`. Spawning a process per
 * session per refresh would be slow, and `git` is not guaranteed to be on the
 * PATH of whatever machine the deck is running on.
 */
import fs from 'node:fs'
import path from 'node:path'

/** cwd -> { root, isWorktree, at }. Repo roots effectively never move. */
const cache = new Map()
const TTL_MS = 60_000

/**
 * A worktree's .git is a FILE holding `gitdir: <main>/.git/worktrees/<name>`,
 * whereas a normal checkout's .git is a directory. That one difference is
 * what lets a worktree find its way home.
 */
function rootFromGitFile(gitFilePath, dir) {
  let contents
  try {
    contents = fs.readFileSync(gitFilePath, 'utf8')
  } catch {
    return null
  }

  const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(contents)
  if (!match) return null

  let gitdir = match[1]
  // Git allows the pointer to be relative to the worktree directory.
  if (!path.isAbsolute(gitdir)) gitdir = path.resolve(dir, gitdir)

  // <main-repo>/.git/worktrees/<name>  ->  <main-repo>
  const worktree = /^(.*)[/\\]\.git[/\\]worktrees[/\\]/.exec(gitdir)
  if (worktree) return { root: worktree[1], isWorktree: true }

  // A submodule or anything else pointing elsewhere: treat it as its own root.
  return { root: dir, isWorktree: false }
}

/**
 * Walk up from `cwd` to the repository root.
 * Falls back to `cwd` itself when the directory is not in a repo at all.
 */
export function resolveProjectRoot(cwd) {
  if (!cwd) return { root: '', isWorktree: false }

  const cached = cache.get(cwd)
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { root: cached.root, isWorktree: cached.isWorktree }
  }

  let result = { root: cwd, isWorktree: false }
  let dir = cwd

  while (true) {
    const dotGit = path.join(dir, '.git')
    let stat = null
    try { stat = fs.statSync(dotGit) } catch {}

    if (stat?.isDirectory()) {
      result = { root: dir, isWorktree: false }
      break
    }
    if (stat?.isFile()) {
      result = rootFromGitFile(dotGit, dir) || { root: dir, isWorktree: false }
      break
    }

    const parent = path.dirname(dir)
    if (parent === dir) break // hit the filesystem root
    dir = parent
  }

  cache.set(cwd, { ...result, at: Date.now() })
  return result
}

/**
 * Where this session sits inside its project, '' when it is at the root.
 * This is what keeps grouping from hiding information: sessions collapse
 * under one project, but you can still see which worktree each one is in.
 */
export function subpathWithin(root, cwd) {
  if (!root || !cwd || root === cwd) return ''
  const rel = path.relative(root, cwd)
  // A cwd outside the root (shouldn't happen) must not render as ../../..
  if (!rel || rel.startsWith('..')) return ''
  return rel.split(path.sep).join('/')
}

/**
 * Every worktree of a repository, whether or not a session is open in it.
 *
 * Git records each one under <repo>/.git/worktrees/<name>/gitdir, whose
 * contents point at the worktree's own .git. Reading that directory is how
 * you enumerate worktrees without running `git worktree list`.
 */
export function listWorktrees(root) {
  if (!root) return []
  const dir = path.join(root, '.git', 'worktrees')
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // No worktrees, or not a repository at all.
  }

  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const base = path.join(dir, entry.name)

    let target = null
    try {
      // "<worktree>/.git" -> the worktree directory is its parent.
      target = path.dirname(fs.readFileSync(path.join(base, 'gitdir'), 'utf8').trim())
    } catch {
      continue
    }

    let branch = null
    try {
      const head = fs.readFileSync(path.join(base, 'HEAD'), 'utf8').trim()
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
      branch = ref ? ref[1] : head.slice(0, 8) // detached HEAD: show the sha
    } catch {}

    out.push({
      name: entry.name,
      path: target,
      branch,
      // A worktree whose directory is gone is stale until `git worktree prune`.
      exists: fs.existsSync(target),
    })
  }

  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** The branch checked out at the repository root itself. */
export function rootBranch(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return ref ? ref[1] : head.slice(0, 8)
  } catch {
    return null
  }
}
