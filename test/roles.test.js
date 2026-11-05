/**
 * A role is not a shortcut, and the difference is not a nuance.
 *
 * The composer briefly offered the launcher's shortcuts as roles, so you could
 * staff a team with "Catch me up". A shortcut is an errand with an end — it is
 * done when the thing is written, and the session that ran it has nothing left
 * to be. A role is a standing brief: "Backend" is not finished when the
 * migration lands, it is what that session is for as long as the team exists.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-roles-'))
process.env.SESSION_DECK_DIR = scratch

const roles = await import('../src/roles.js')
const file = () => path.join(scratch, 'roles.json')

test('the shipped roles are a shape, and spend nothing nobody asked for', () => {
  const shipped = roles.list()
  assert.deepEqual(shipped.map((r) => r.name), ['Supervisor', 'Backend', 'Frontend', 'Analyst'])

  // Exactly one of them hands out the work by default. Two supervisors is a
  // thing you can choose and never a thing you are given.
  assert.equal(shipped.filter((r) => r.delegates).length, 1)
  assert.equal(shipped.find((r) => r.delegates).name, 'Supervisor')

  for (const role of shipped) {
    assert.ok(role.brief.length > 40, `${role.name} ships with a real brief`)
    assert.equal(role.advisor, false, `${role.name} ships without an advisor`)
    assert.equal(role.model, null)
    assert.equal(role.effort, null)
  }
})

test('a role needs a name and a brief, and the brief is the point', () => {
  roles.reset()
  assert.equal(roles.add({ name: 'Nameless', brief: '' }).ok, false)
  assert.equal(roles.add({ name: '', brief: 'does things' }).ok, false)
  assert.equal(roles.add({ name: 'Backend', brief: 'a duplicate' }).ok, false)

  const { ok, role } = roles.add({
    name: 'Reviewer',
    brief: 'You read what the others wrote and say what is wrong with it.',
    model: 'opus',
    effort: 'xhigh',
    advisor: true,
  })
  assert.ok(ok)
  assert.equal(role.model, 'opus')
  assert.equal(role.effort, 'xhigh')
  assert.equal(role.advisor, true)
  assert.equal(roles.list().some((r) => r.name === 'Reviewer'), true)
})

test('what somebody typed into the file cannot reach the CLI', () => {
  fs.writeFileSync(file(), JSON.stringify({
    roles: [
      { id: 'a', name: 'Odd', brief: 'go', model: '--dangerously-skip-permissions', effort: 'extreme', advisor: 'yes' },
      { id: 'b', name: 'No brief' },
    ],
  }))

  const list = roles.list()
  assert.equal(list.length, 1, 'a role with no brief is not a role')
  assert.equal(list[0].model, null)
  assert.equal(list[0].effort, null)
  assert.equal(list[0].advisor, false)
})

test('restoring the shipped ones does not take your own with it', () => {
  // Not the same as the shortcuts' reset, which replaces the list. A role is a
  // paragraph somebody sat down and wrote; losing four of those to a one-word
  // button is not worth matching another screen for.
  fs.rmSync(file(), { force: true })
  const mine = roles.add({ name: 'Release manager', brief: 'You cut the release and nothing else.' })
  assert.ok(mine.ok)

  const analyst = roles.list().find((r) => r.name === 'Analyst')
  assert.equal(roles.remove(analyst.id).ok, true)
  assert.equal(roles.list().some((r) => r.name === 'Analyst'), false)

  const back = roles.reset()
  assert.equal(back.restored, 1, 'only the one that was missing')
  assert.equal(back.roles.some((r) => r.name === 'Analyst'), true)
  assert.equal(back.roles.some((r) => r.name === 'Release manager'), true, 'yours is still there')

  assert.equal(roles.remove('nope').ok, false)
})

test('editing one is a patch, so it cannot blank what the form never showed', () => {
  fs.rmSync(file(), { force: true })
  const backend = roles.list().find((r) => r.name === 'Backend')

  const { ok, role } = roles.update(backend.id, { name: 'API', effort: 'high' })
  assert.ok(ok)
  assert.equal(role.name, 'API')
  assert.equal(role.effort, 'high')
  assert.equal(role.brief, backend.brief, 'untouched, because it was not sent')

  // And the guards hold on the way through.
  assert.equal(roles.update(backend.id, { brief: '' }).ok, false)
  assert.equal(roles.update(backend.id, { name: 'Frontend' }).ok, false, 'a name already taken')
  assert.equal(roles.update('nope', { name: 'x' }).ok, false)
})
