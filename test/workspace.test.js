/**
 * The order of the sidebar.
 *
 * The interesting part is not the swap — it is that the file is the order,
 * so every one of these is really asking the same question: can a click in
 * the menu lose a folder, or leave the list in a state that is not the one
 * on screen.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as workspace from '../src/workspace.js'

/** A scratch ~/.session-deck, plus real folders to put in it. */
function scratch(count) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-workspace-'))
  process.env.SESSION_DECK_DIR = path.join(home, 'deck')
  return Array.from({ length: count }, (_, i) => {
    const dir = path.join(home, `project-${i + 1}`)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  })
}

const order = () => workspace.list().map((f) => f.name)

test('a project moves one place, and the file is what remembers it', () => {
  const [one, two, three] = scratch(3)
  // add() puts a new folder at the top, so this is the reverse of the order
  // they were added in.
  for (const dir of [one, two, three]) workspace.add(dir)
  assert.deepEqual(order(), ['project-3', 'project-2', 'project-1'])

  assert.deepEqual(workspace.move(three, 'down'), { ok: true, moved: true })
  assert.deepEqual(order(), ['project-2', 'project-3', 'project-1'])

  assert.deepEqual(workspace.move(one, 'up'), { ok: true, moved: true })
  assert.deepEqual(order(), ['project-2', 'project-1', 'project-3'])
})

test('the ends are not an error, because nothing went wrong', () => {
  const [one, two] = scratch(2)
  workspace.add(one)
  workspace.add(two)
  const before = order()

  // The buttons for these are disabled, so the only way here is a race — and
  // "it is already where you asked for" is the outcome that was wanted.
  assert.deepEqual(workspace.move(two, 'up'), { ok: true, moved: false })
  assert.deepEqual(workspace.move(one, 'down'), { ok: true, moved: false })
  assert.deepEqual(order(), before)
})

test('refuses a folder it does not have, and a direction it does not know', () => {
  const [one] = scratch(1)
  workspace.add(one)

  assert.equal(workspace.move('/somewhere/else', 'up').ok, false)
  assert.equal(workspace.move(one, 'sideways').ok, false)
  assert.equal(workspace.move(one, undefined).ok, false)
  assert.deepEqual(order(), ['project-1'])
})

test('moving keeps everything else about a folder', () => {
  const [one, two] = scratch(2)
  workspace.add(one)
  workspace.add(two)
  workspace.setPullBranch(one, 'develop')

  workspace.move(one, 'up')

  // A reorder rewrites the array, and an entry that came back with only its
  // path would quietly drop the branch you chose for it.
  assert.equal(workspace.pullBranchFor(one), 'develop')
  assert.equal(workspace.list().find((f) => f.path === one).addedAt > 0, true)
})

test('a folder added while the menu was on screen is not dropped by a move', () => {
  const [one, two, three] = scratch(3)
  workspace.add(one)
  workspace.add(two)

  /*
   * The panel that clicked the arrow had only rendered two folders. A third
   * arrived from somewhere else — another browser, a phone — between that
   * render and the click. The move reads the file rather than trusting a
   * list the caller remembered, so the newcomer survives.
   */
  workspace.add(three)
  workspace.move(two, 'down')

  assert.deepEqual(order().sort(), ['project-1', 'project-2', 'project-3'])
  assert.equal(workspace.list().length, 3)
})

test('a project can be called something other than its folder', () => {
  const [one, two] = scratch(2)
  workspace.add(one)
  workspace.add(two)

  assert.deepEqual(workspace.rename(one, '  X1   Platform  '), {
    ok: true,
    name: 'X1 Platform',
    label: 'X1 Platform',
  })

  const entry = workspace.list().find((f) => f.path === one)
  // The name the sidebar shows is the label; where it lives is still on hand.
  assert.equal(entry.name, 'X1 Platform')
  assert.equal(entry.folderName, 'project-1')
  assert.equal(workspace.nameFor(one), 'X1 Platform')
  // Naming one project says nothing about the others.
  assert.equal(workspace.list().find((f) => f.path === two).name, 'project-2')
  assert.equal(workspace.nameFor(two), 'project-2')
})

test('emptying the name gives the folder back, and does not leave a trace', () => {
  const [one] = scratch(1)
  workspace.add(one)
  workspace.rename(one, 'Accounting')

  assert.deepEqual(workspace.rename(one, '   '), { ok: true, name: 'project-1', label: null })

  const entry = workspace.list().find((f) => f.path === one)
  assert.equal(entry.name, 'project-1')
  assert.equal(entry.label, null)
  // Cleared, not blanked: an empty string on disk would come back as a label.
  assert.equal('label' in JSON.parse(fs.readFileSync(path.join(process.env.SESSION_DECK_DIR, 'workspace.json'), 'utf8')).folders[0], false)
})

test('a name survives a reorder, and only a tracked folder can have one', () => {
  const [one, two] = scratch(2)
  workspace.add(one)
  workspace.add(two)
  workspace.rename(one, 'Ledger')

  workspace.move(one, 'up')
  assert.equal(workspace.list().find((f) => f.path === one).name, 'Ledger')

  assert.equal(workspace.rename('/not/in/the/workspace', 'Hello').ok, false)
  assert.equal(workspace.rename(one, 'x'.repeat(61)).ok, false)
  // Rejected means nothing was written, not that a 60-character prefix was.
  assert.equal(workspace.list().find((f) => f.path === one).name, 'Ledger')
})
