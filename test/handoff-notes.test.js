/**
 * Handoff notes: what /handoff leaves in the repo, as the launcher reads it.
 *
 * The failure this file guards against is the launcher offering the wrong
 * note first — an old one for work that already has a newer note, or one
 * you already picked up — because the first one offered is the one clicked.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-notes-'))
process.env.SESSION_DECK_DIR = path.join(scratch, 'deck')

const notes = await import('../src/handoff-notes.js')

function checkout(name) {
  const dir = path.join(scratch, name)
  fs.mkdirSync(path.join(dir, 'docs', 'sessions'), { recursive: true })
  return dir
}

function note(dir, file, text, ageMs = 0) {
  const full = path.join(dir, 'docs', 'sessions', file)
  fs.writeFileSync(full, text)
  const at = new Date(Date.now() - ageMs)
  fs.utimesSync(full, at, at)
  return full
}

test('the title is what the skill writes, without the boilerplate around it', () => {
  assert.equal(notes.titleOf('# Handoff: Bill the rental (2026-10-23)\n', 'x.md'), 'Bill the rental')
  assert.equal(notes.titleOf('---\nbranch: a\n---\n# Handoff: Rental\n', 'x.md'), 'Rental')
  // No heading: the file name is readable on purpose, so it is used.
  assert.equal(notes.titleOf('no heading', '/r/docs/sessions/handoff-2026-10-23-rentcar-settlement.md'), 'rentcar settlement')
})

test('only handoff-*.md under docs/sessions counts', () => {
  const dir = checkout('only')
  note(dir, 'handoff-2026-10-23-a.md', '# Handoff: A\n')
  note(dir, 'notes.md', '# not a handoff\n')
  fs.mkdirSync(path.join(dir, 'docs', 'sessions', 'handoff-dir.md'))
  assert.deepEqual(notes.scan(dir).map((n) => n.title), ['A'])
  assert.deepEqual(notes.scan(path.join(scratch, 'missing')), [])
})

test('a newer note for the same branch replaces the older one', () => {
  const main = checkout('main')
  const wt = checkout('wt')
  note(main, 'handoff-2026-10-20-old.md', '---\nbranch: feature/x\n---\n# Handoff: Old\n', 3 * 86_400_000)
  note(wt, 'handoff-2026-10-23-new.md', '---\nbranch: feature/x\n---\n# Handoff: New\n')
  note(wt, 'handoff-2026-10-22-other.md', '---\nbranch: feature/y\n---\n# Handoff: Other\n', 86_400_000)

  const list = notes.list([main, wt], {})
  const state = Object.fromEntries(list.map((n) => [n.title, n.state]))
  assert.deepEqual(state, { New: 'pending', Other: 'pending', Old: 'superseded' })
  assert.equal(list[0].title, 'New', 'newest first')
})

test('picking a note up is remembered, and a rewrite of it makes it pending again', () => {
  const dir = checkout('picked')
  const file = note(dir, 'handoff-2026-10-23-p.md', '# Handoff: P\n', 60_000)
  assert.equal(notes.markPickedUp(file), true)
  assert.equal(notes.list([dir])[0].state, 'picked-up')

  // /handoff run again into the same file: newer than the pick-up.
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(file, later, later)
  assert.equal(notes.list([dir])[0].state, 'pending')
})

test('only a real note can be marked, never an arbitrary path', () => {
  const dir = checkout('guard')
  const other = path.join(dir, 'secret.md')
  fs.writeFileSync(other, 'x')
  assert.equal(notes.markPickedUp(other), false)
  assert.equal(notes.markPickedUp('relative/docs/sessions/handoff-a.md'), false)
  assert.equal(notes.markPickedUp(path.join(dir, 'docs', 'sessions', 'handoff-missing.md')), false)
  assert.equal(notes.markPickedUp(42), false)
})

test('a corrupt pick-up file means nothing was picked up', () => {
  fs.mkdirSync(process.env.SESSION_DECK_DIR, { recursive: true })
  fs.writeFileSync(path.join(process.env.SESSION_DECK_DIR, 'handoffs-used.json'), '{not json')
  assert.deepEqual(notes.readUsed(), {})
})
