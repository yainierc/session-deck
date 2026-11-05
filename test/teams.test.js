/**
 * A team is a thing that was written down, or it is nothing.
 *
 * Without this file a team exists only in the instant it is launched: the
 * sessions come up, get introduced, and are from then on indistinguishable
 * from anything else running on the machine. The screen built on top of that
 * showed every live session in columns — the session list wearing a hat — and
 * nothing on it could say which four of eleven you had put together on
 * purpose.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-teams-'))
process.env.SESSION_DECK_DIR = scratch

const teams = await import('../src/teams.js')

const member = (deckId, extra = {}) => ({
  deckId, label: 'Backend', address: `p-${deckId}`, project: 'Platform', ...extra,
})

function reset() {
  fs.writeFileSync(path.join(scratch, 'teams.json'), JSON.stringify({ teams: [] }))
}

test('a team with nobody in it is not a team', () => {
  reset()
  // The residue of a launch where every member failed. Offering it back would
  // be offering an empty box with a name on it.
  assert.equal(teams.remember({ name: 'ghosts', members: [] }).ok, false)
  assert.equal(teams.list().length, 0)
})

test('what is stored is who is in it, and nothing that changes', () => {
  reset()
  const { ok, team } = teams.remember({
    name: 'Platform work',
    members: [member('a1', { delegates: true }), member('b2', { project: 'Payment' })],
  })

  assert.ok(ok)
  assert.equal(team.name, 'Platform work')
  assert.deepEqual(team.members.map((m) => m.deckId), ['a1', 'b2'])
  assert.equal(team.members[0].delegates, true)
  assert.equal(team.members[1].delegates, false)

  // Status, busyness and the rest are deliberately absent: none of it would
  // still be true by the time anybody read the file.
  assert.equal('status' in team.members[0], false)
})

test('members are matched to the sessions they are now, by deckId', () => {
  reset()
  teams.remember({ name: 'Mixed', members: [member('a1'), member('b2')] })

  const [team] = teams.withSessions([
    { deckId: 'a1', sessionId: 's1', status: 'busy', project: 'Platform' },
  ])

  assert.equal(team.members[0].live, true)
  assert.equal(team.members[0].session.status, 'busy')

  /*
   * And the one with no session left is carried through rather than dropped. A
   * team of two where one has exited is two people, one of whom left; a screen
   * that quietly shows one has stopped describing what was raised.
   */
  assert.equal(team.members[1].live, false)
  assert.equal(team.members[1].session, null)
  assert.equal(team.members[1].label, 'Backend', 'it still has a name to draw')
})

test('newest first, because the one you just raised is the one you want', () => {
  reset()
  teams.remember({ name: 'older', members: [member('a1')] })
  teams.remember({ name: 'newer', members: [member('b2')] })
  assert.deepEqual(teams.list().map((t) => t.name), ['newer', 'older'])
})

test('dismissing one leaves the others alone', () => {
  reset()
  teams.remember({ name: 'keep', members: [member('a1')] })
  const { team } = teams.remember({ name: 'drop', members: [member('b2')] })

  assert.equal(teams.forget(team.id).ok, true)
  assert.deepEqual(teams.list().map((t) => t.name), ['keep'])
  assert.equal(teams.forget('nope').ok, false)
})

test('a file somebody edited by hand cannot put a half-team on screen', () => {
  fs.writeFileSync(path.join(scratch, 'teams.json'), JSON.stringify({
    teams: [
      { id: 'x', name: 'half written' },
      { id: 'y', name: 'real', startedAt: 1, members: [{ deckId: 'a1' }, { nope: true }] },
    ],
  }))

  const list = teams.list()
  assert.equal(list.length, 1, 'the one with no members at all is dropped')
  assert.equal(list[0].name, 'real')
  assert.deepEqual(list[0].members.map((m) => m.deckId), ['a1'])
})
