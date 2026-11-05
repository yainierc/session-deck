/**
 * files.js — the project's own files, for the Files tab.
 *
 * browse.js walks the disk to choose a folder and refuses to show files on
 * purpose. This is the other half: once a folder is a project in the deck,
 * you can look inside it the way the VS Code explorer does — one folder at a
 * time, names coloured by git, and a file read back as text.
 *
 * Read-only, and fenced to the project. Every path that comes in is relative
 * to a root the server already knows, and it is resolved (symlinks included)
 * before anything is read, so `../../.ssh` and a link pointing out of the
 * repository both land outside the fence and stop there.
 *
 * Contents leave the machine, so three kinds of file are listed but never
 * read: anything git ignores (that is where `.env`, local settings and build
 * output live), anything named like a secret even when it is tracked, and
 * anything too large or binary to be worth drawing.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

/** A folder with more children than this is not one anybody reads by eye. */
const MAX_ENTRIES = 2000
/** Past this the preview stops being a preview. */
export const MAX_BYTES = 512 * 1024
/** How many hits a search returns. Enough to see you need a better word. */
const MAX_HITS = 300
/** git status is the expensive call, and every folder you open wants it. */
const STATUS_TTL_MS = 2000

/** Named like a secret: refused even when committed. `.env.example` is not. */
const SECRET = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc)$/i,
]
const NOT_SECRET = /^\.env\.(example|sample|template|dist)$/i

export function looksSecret(name) {
  return !NOT_SECRET.test(name) && SECRET.some((re) => re.test(name))
}

/**
 * git, with its raw output. Not `git()` from git.js: that trims, and the
 * leading space of a porcelain line is half of its status.
 *
 * Exit code 1 is an answer for `check-ignore` ("none of these"), so it comes
 * back as empty output rather than as a failure.
 */
function runGit(cwd, args, input) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (!err) return resolve(stdout)
      resolve(err.code === 1 ? '' : null)
    })
    child.stdin.end(input ?? '')
  })
}

/**
 * Turn a path from the browser into one on disk, or nothing.
 *
 * Resolved twice: once as written, which catches `..`, and once through
 * realpath, which catches a symlink that points out of the project. A path
 * that does not exist yet fails the second check, which for a read-only view
 * is the right answer.
 */
export async function resolveInside(root, rel = '') {
  const base = await fs.realpath(path.resolve(root)).catch(() => null)
  if (!base) return null
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const target = path.resolve(base, clean)
  if (!within(base, target)) return null
  const real = await fs.realpath(target).catch(() => null)
  if (!real || !within(base, real)) return null
  if (real.split(path.sep).includes('.git') && !base.split(path.sep).includes('.git')) return null
  return { base, abs: real, rel: toRel(base, real) }
}

function within(base, target) {
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
}

function toRel(base, abs) {
  return path.relative(base, abs).split(path.sep).join('/')
}

/* ---------- git status ---------- */

const statusCache = new Map()

/**
 * Every changed path in the project, keyed relative to its root.
 *
 * `M` modified, `A` added, `D` deleted, `R` renamed, `U` untracked — the
 * letters the VS Code explorer uses, which is the point. `-uall` so an
 * untracked folder lists its files instead of itself; ignored files are not
 * in it, so a fat `node_modules` costs nothing here.
 */
export async function gitStatus(root) {
  const hit = statusCache.get(root)
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value

  // Porcelain paths start at the repository root. A project that is a folder
  // inside a repository wants them from its own root, and only its own.
  const [prefix, out] = await Promise.all([
    runGit(root, ['rev-parse', '--show-prefix']),
    runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
  ])
  const value = out == null || prefix == null ? null : parseStatus(out, prefix.trim())
  statusCache.set(root, { at: Date.now(), value })
  return value
}

export function parseStatus(out, prefix = '') {
  const map = new Map()
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    const file = line.slice(3)
    // A rename carries its old name as the next field, which is not an entry.
    if (xy[0] === 'R' || xy[0] === 'C') i++
    if (!file.startsWith(prefix)) continue
    map.set(file.slice(prefix.length), letterFor(xy))
  }
  return map
}

function letterFor(xy) {
  if (xy === '??') return 'U'
  if (xy.includes('D')) return 'D'
  if (xy[0] === 'R') return 'R'
  if (xy[0] === 'A') return 'A'
  return 'M'
}

/** Does anything under this folder have a status? */
function changedUnder(status, rel) {
  if (!status) return false
  const prefix = rel ? `${rel}/` : ''
  for (const key of status.keys()) if (key.startsWith(prefix)) return true
  return false
}

/** Which of these paths git ignores. Folders are asked with a trailing slash. */
async function ignoredAmong(root, entries) {
  if (!entries.length) return new Set()
  const asked = entries.map((e) => (e.dir ? `${e.path}/` : e.path))
  // -z only exists with --stdin, and stdin has no argument-length limit either.
  const out = await runGit(root, ['check-ignore', '-z', '--stdin'], asked.join('\0') + '\0')
  if (!out) return new Set()
  return new Set(out.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, '')))
}

/* ---------- listing ---------- */

/**
 * One folder of the project, folders first, the way the explorer sorts.
 *
 * `.git` is never listed. Dotfiles are left out unless asked for, because the
 * approved design starts with them hidden.
 */
export async function listDir(root, rel = '', { showHidden = false } = {}) {
  const where = await resolveInside(root, rel)
  if (!where) return { ok: false, error: 'That path is not inside this project' }

  let raw
  try {
    raw = await fs.readdir(where.abs, { withFileTypes: true })
  } catch (err) {
    const reason = err?.code === 'ENOTDIR' ? 'That is a file, not a folder' : 'Could not read that folder'
    return { ok: false, error: reason }
  }

  const entries = []
  for (const entry of raw) {
    if (entries.length >= MAX_ENTRIES) break
    if (entry.name === '.git') continue
    if (!showHidden && entry.name.startsWith('.')) continue
    let dir = entry.isDirectory()
    if (!dir && entry.isSymbolicLink()) {
      dir = await fs.stat(path.join(where.abs, entry.name)).then((s) => s.isDirectory(), () => false)
    }
    entries.push({ name: entry.name, path: where.rel ? `${where.rel}/${entry.name}` : entry.name, dir })
  }

  const [status, ignored] = await Promise.all([gitStatus(where.base), ignoredAmong(where.base, entries)])
  for (const e of entries) {
    if (ignored.has(e.path)) e.ignored = true
    if (!e.dir && status?.has(e.path)) e.status = status.get(e.path)
    if (e.dir && !e.ignored && changedUnder(status, e.path)) e.changed = true
  }

  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  return { ok: true, path: where.rel, git: status != null, truncated: raw.length > entries.length && entries.length >= MAX_ENTRIES, entries }
}

/* ---------- search and the changed-only view ---------- */

/**
 * Files whose name contains `query`, anywhere in the project.
 *
 * The tree loads a folder when you open it, so filtering only what is loaded
 * would miss everything you have not clicked into yet. Git already knows
 * every file worth finding — tracked, plus untracked that are not ignored —
 * so the search asks it rather than walking `node_modules`.
 */
export async function findFiles(root, query, { showHidden = false } = {}) {
  const where = await resolveInside(root, '')
  if (!where) return { ok: false, error: 'Not a project folder' }
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return { ok: true, files: [], truncated: false }

  const out = await runGit(where.base, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  const all = out == null ? await walk(where.base) : [...new Set(out.split('\0').filter(Boolean))]
  const status = await gitStatus(where.base)

  const files = []
  for (const p of all) {
    const name = p.slice(p.lastIndexOf('/') + 1)
    if (!name.toLowerCase().includes(needle)) continue
    if (!showHidden && p.split('/').some((seg) => seg.startsWith('.'))) continue
    files.push({ path: p, status: status?.get(p) })
    if (files.length >= MAX_HITS) break
  }
  return { ok: true, files, truncated: files.length >= MAX_HITS }
}

/** Every changed file, for the "only changes" switch. Deleted ones too. */
export async function changedFiles(root) {
  const where = await resolveInside(root, '')
  if (!where) return { ok: false, error: 'Not a project folder' }
  const status = await gitStatus(where.base)
  if (!status) return { ok: true, git: false, files: [] }
  return { ok: true, git: true, files: [...status].map(([p, s]) => ({ path: p, status: s })) }
}

/** The search for a folder that is not a repository: bounded, and blind to the usual heavy folders. */
async function walk(base, limit = 20_000) {
  const out = []
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__'])
  const queue = ['']
  while (queue.length && out.length < limit) {
    const rel = queue.shift()
    const entries = await fs.readdir(path.join(base, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!skip.has(e.name)) queue.push(p) } else out.push(p)
    }
  }
  return out
}

/* ---------- reading ---------- */

/**
 * One file, as text, or the reason it is not shown.
 *
 * A refusal is `ok: true` with `withheld`: the file exists and the panel has
 * something honest to say about it. `ok: false` is for a path that is not a
 * file of this project at all.
 */
export async function readFile(root, rel) {
  const where = await resolveInside(root, rel)
  if (!where || !where.rel) return { ok: false, error: 'That file is not inside this project' }

  const stat = await fs.stat(where.abs).catch(() => null)
  if (!stat?.isFile()) return { ok: false, error: 'That is not a file' }

  const status = (await gitStatus(where.base))?.get(where.rel)
  const base = { ok: true, path: where.rel, size: stat.size, status }
  const name = path.basename(where.abs)

  if (looksSecret(name)) return { ...base, withheld: 'secret' }
  if ((await ignoredAmong(where.base, [{ path: where.rel, dir: false }])).has(where.rel)) {
    return { ...base, withheld: 'ignored' }
  }
  if (stat.size > MAX_BYTES) return { ...base, withheld: 'large' }

  const buf = await fs.readFile(where.abs).catch(() => null)
  if (!buf) return { ok: false, error: 'Could not read that file' }
  // The same test git uses: a NUL byte near the start means binary.
  if (buf.subarray(0, 8000).includes(0)) return { ...base, withheld: 'binary' }
  return { ...base, text: buf.toString('utf8') }
}
