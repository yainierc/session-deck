/**
 * The Files tab's reader.
 *
 * Most of what matters here is what it refuses: a path that walks out of the
 * project, a link that points out of it, and the files whose contents must
 * not reach a phone even though their names may.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as files from '../src/files.js'

/** A small repository with one of everything the tab has to tell apart. */
function scratchRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-files-')))
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })

  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  write('.gitignore', 'dist/\n.env\n')
  write('README.md', '# hi\n')
  write('src/app.js', 'export const a = 1\n')
  write('src/b.js', 'export const b = 2\n')
  write('.env.example', 'TOKEN=\n')
  write('certs/server.pem', 'not really\n')
  git('add', '.')
  git('commit', '-qm', 'init')

  write('src/app.js', 'export const a = 2\n')
  write('src/new.js', 'new\n')
  write('dist/bundle.js', 'built\n')
  write('.env', 'TOKEN=secret\n')
  write('img.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]))
  write('big.txt', 'x'.repeat(files.MAX_BYTES + 1))
  return dir
}

test('a folder lists folders first, hides dotfiles, and never lists .git', async () => {
  const root = scratchRepo()
  const top = await files.listDir(root, '')
  assert.equal(top.ok, true)
  const names = top.entries.map((e) => e.name)
  assert.deepEqual(names.slice(0, 3), ['certs', 'dist', 'src'])
  assert.ok(!names.includes('.git'))
  assert.ok(!names.includes('.gitignore'))

  const hidden = await files.listDir(root, '', { showHidden: true })
  const all = hidden.entries.map((e) => e.name)
  assert.ok(all.includes('.gitignore'))
  assert.ok(!all.includes('.git'))
})

test('git status reaches the names, and a folder knows it has changes inside', async () => {
  const root = scratchRepo()
  const top = await files.listDir(root, '')
  const by = Object.fromEntries(top.entries.map((e) => [e.name, e]))
  assert.equal(by.src.changed, true)
  assert.equal(by.dist.ignored, true)
  assert.equal(by.dist.changed, undefined)

  const src = await files.listDir(root, 'src')
  const st = Object.fromEntries(src.entries.map((e) => [e.name, e.status]))
  assert.equal(st['app.js'], 'M')
  assert.equal(st['new.js'], 'U')
  assert.equal(st['b.js'], undefined)
})

test('paths that leave the project are refused, including through a symlink', async () => {
  const root = scratchRepo()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope')
  fs.symlinkSync(outside, path.join(root, 'escape'))

  assert.equal((await files.listDir(root, '../')).ok, false)
  assert.equal((await files.readFile(root, '../../etc/passwd')).ok, false)
  assert.equal((await files.readFile(root, 'escape/secret.txt')).ok, false)
  assert.equal((await files.listDir(root, 'escape')).ok, false)
  assert.equal((await files.readFile(root, '.git/config')).ok, false)
  assert.equal((await files.readFile(root, '/etc/hosts')).ok, false)
})

test('a file comes back as text, with its status', async () => {
  const root = scratchRepo()
  const r = await files.readFile(root, 'src/app.js')
  assert.equal(r.ok, true)
  assert.equal(r.text, 'export const a = 2\n')
  assert.equal(r.status, 'M')
})

test('secrets, ignored, binary and large files are named but never read', async () => {
  const root = scratchRepo()
  const cases = { '.env': 'secret', 'certs/server.pem': 'secret', 'dist/bundle.js': 'ignored', 'img.bin': 'binary', 'big.txt': 'large' }
  for (const [rel, why] of Object.entries(cases)) {
    const r = await files.readFile(root, rel)
    assert.equal(r.ok, true, rel)
    assert.equal(r.withheld, why, rel)
    assert.equal(r.text, undefined, rel)
  }
  assert.equal((await files.readFile(root, '.env.example')).text, 'TOKEN=\n')
})

test('search finds files in folders nobody opened, and skips what git ignores', async () => {
  const root = scratchRepo()
  const r = await files.findFiles(root, 'JS')
  const paths = r.files.map((f) => f.path).sort()
  assert.deepEqual(paths, ['src/app.js', 'src/b.js', 'src/new.js'])
  assert.equal(r.files.find((f) => f.path === 'src/new.js').status, 'U')
})

test('the changed list is the status, deleted files included', async () => {
  const root = scratchRepo()
  fs.rmSync(path.join(root, 'src/b.js'))
  await new Promise((r) => setTimeout(r, 2100)) // past the status cache
  const r = await files.changedFiles(root)
  const map = Object.fromEntries(r.files.map((f) => [f.path, f.status]))
  assert.equal(map['src/b.js'], 'D')
  assert.equal(map['src/app.js'], 'M')
  assert.equal(map['dist/bundle.js'], undefined)
})

test('porcelain parsing: renames skip their old name, and a prefix scopes to a subfolder', () => {
  const out = ' M app/a.js\0R  app/new.js\0app/old.js\0?? other/x.js\0'
  assert.deepEqual([...files.parseStatus(out)], [['app/a.js', 'M'], ['app/new.js', 'R'], ['other/x.js', 'U']])
  assert.deepEqual([...files.parseStatus(out, 'app/')], [['a.js', 'M'], ['new.js', 'R']])
})

test('a folder that is not a repository still lists, without status', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plain-')))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi')
  const r = await files.listDir(dir, '')
  assert.equal(r.ok, true)
  assert.equal(r.git, false)
  assert.deepEqual(r.entries.map((e) => e.name), ['notes.txt'])
  assert.equal((await files.findFiles(dir, 'notes')).files[0].path, 'notes.txt')
})
