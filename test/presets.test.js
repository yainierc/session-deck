/**
 * A shortcut carries how the task should be done, not only what it says.
 *
 * "Review my changes" wants care and "catch me up" does not, and which one you
 * get should not depend on what the panel happened to be set to last night. So
 * a preset stores a model, an effort and whether an advisor is consulted —
 * and, because presets.json is a plain file in a directory you can open, it
 * has to survive somebody typing into it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-presets-'))
process.env.SESSION_DECK_DIR = scratch

const presets = await import('../src/presets.js')

const file = () => path.join(scratch, 'presets.json')
const writeRaw = (list) => fs.writeFileSync(file(), JSON.stringify({ presets: list }))

test('a shortcut keeps the model, the effort and the advisor it was saved with', () => {
  presets.reset()
  const { ok, preset } = presets.add({
    label: 'Deep review',
    prompt: 'Review the uncommitted changes for bugs.',
    model: 'opus',
    effort: 'xhigh',
    advisor: true,
  })

  assert.ok(ok)
  assert.equal(preset.model, 'opus')
  assert.equal(preset.effort, 'xhigh')
  assert.equal(preset.advisor, true)

  // And they survive the trip through disk, which is the only trip that counts.
  const stored = presets.list().find((p) => p.label === 'Deep review')
  assert.equal(stored.model, 'opus')
  assert.equal(stored.effort, 'xhigh')
  assert.equal(stored.advisor, true)
})

test('a shortcut that asks for nothing says so in all three', () => {
  presets.reset()
  const { preset } = presets.add({ label: 'Plain', prompt: 'Have a look around.' })
  assert.equal(preset.model, null)
  assert.equal(preset.effort, null)
  assert.equal(preset.advisor, false)
})

test('what somebody typed into the file by hand cannot reach the CLI', () => {
  writeRaw([
    {
      id: 'x1',
      label: 'Hand written',
      prompt: 'go',
      model: '--dangerously-skip-permissions',
      effort: 'extreme',
      advisor: 'yes',
    },
  ])

  const [row] = presets.list()
  // Not an error and not a dropped shortcut: it still runs, it has just
  // stopped claiming something the CLI would refuse.
  assert.equal(row.label, 'Hand written')
  assert.equal(row.model, null, 'never something flag-shaped')
  assert.equal(row.effort, null)
  assert.equal(row.advisor, false, 'a truthy string is not a yes')
})

test('a model this machine actually has survives the round trip', () => {
  // Which models exist is the CLI's answer, per folder and per account, so a
  // shortcut is allowed to name one this file has never heard of.
  writeRaw([{ id: 'x2', label: 'Fable', prompt: 'go', model: 'claude-fable-5-1[1m]' }])
  assert.equal(presets.list()[0].model, 'claude-fable-5-1[1m]')
})

test('a record with no task at all is dropped rather than offered', () => {
  writeRaw([
    { id: 'ok', label: 'Real', prompt: 'do the thing' },
    { id: 'bad', label: 'Half written' },
    null,
  ])

  const rows = presets.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, 'Real')
})

test('the shipped shortcuts spend nothing nobody asked for', () => {
  const { presets: shipped } = presets.reset()
  // Especially the advisor: it re-reads the whole conversation on every call
  // and none of it is cached, so a default that turned it on would be a bill
  // arriving from a button somebody pressed once.
  for (const row of shipped) {
    assert.equal(row.advisor, false, `${row.label} ships with an advisor`)
    assert.equal(row.model, null, `${row.label} ships with a model`)
    assert.equal(row.effort, null, `${row.label} ships with an effort`)
  }
})
