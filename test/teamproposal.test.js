/**
 * A team proposed by a session, checked rather than trusted.
 *
 * The author here is a model, which makes this the opposite case to every
 * other store in the deck. A file somebody typed into should degrade to a
 * default — that is what `clean()` does in handoff, presets, roles and teams.
 * A file a model wrote should be handed back with its mistakes named, because
 * a row that disappears silently is a bug nobody can see.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-teamprop-'))
process.env.SESSION_DECK_DIR = scratch

const tp = await import('../src/teamproposal.js')

const PROJECTS = [{ name: 'Platform', path: '/tmp/platform' }]
const SAVED = [{ name: 'Supervisor', delegates: true }, { name: 'Backend', delegates: false }]

/** Open a draft and answer it, which is the shape the real flow has. */
function answer(source, body) {
  const opened = tp.open(source, { from: 'a session' })
  fs.writeFileSync(opened.file, typeof body === 'string' ? body : JSON.stringify(body))
  return tp.read(source, { knownRoles: SAVED, knownProjects: PROJECTS })
}

const member = (role, extra = {}) => ({ role, project: 'Platform', why: 'because §3 says so', ...extra })

test('no request means no draft, whatever is lying around', () => {
  assert.equal(tp.read('never-asked', { knownRoles: SAVED }), null)
})

test('asked and not yet answered reads as drafting, and so does nonsense', () => {
  const opened = tp.open('pending', { from: 'a session' })
  assert.ok(opened.ok)
  assert.equal(tp.read('pending').status, 'drafting')

  // The session is the one that gets told it wrote rubbish, by being asked
  // again — not the person looking at the screen.
  fs.writeFileSync(opened.file, 'I had a think and here are my notes')
  assert.equal(tp.read('pending').status, 'drafting')

  fs.writeFileSync(opened.file, JSON.stringify({ name: 'no arrays here' }))
  assert.equal(tp.read('pending').status, 'drafting')
})

test('a role with no provenance is reported and kept, never dropped', () => {
  const draft = answer('faulty', {
    name: 'T', goal: 'g',
    roles: [{ name: 'Verifier', brief: 'You re-measure.' }],
    members: [member('Verifier')],
  })

  assert.equal(draft.roles.length, 1, 'kept')
  assert.deepEqual(draft.roles[0].missing, ['why'])
  assert.ok(draft.faults.some((f) => /Verifier.*has no why/.test(f)))
})

test('a seat that cannot be filled is said now, not at the moment you raise it', () => {
  const draft = answer('unfillable', {
    name: 'T', goal: 'g', roles: [],
    members: [member('Astronaut'), member('Backend', { project: 'Atlantis' })],
  })

  assert.ok(draft.faults.some((f) => /"Astronaut", which is neither proposed nor already saved/.test(f)))
  assert.ok(draft.faults.some((f) => /Not in your workspace: "Atlantis"/.test(f)))
  // And the one that does resolve carries the folder it will run in.
  assert.equal(draft.members[1].cwd, null)
  assert.equal(draft.members[0].cwd, '/tmp/platform')
})

test('a project is matched by the name you gave it or by the folder it lives in', () => {
  /*
   * Measured on screen: the workspace called it "Development" and the folder
   * was "Acme Gateway", so every seat a real session proposed came back
   * unfillable. The session is the one standing in the folder.
   */
  const projects = [{ name: 'Development', path: '/repos/Acme Gateway' }]
  const draft = answer('renamed', {
    name: 'T', goal: 'g', roles: [],
    members: [member('Backend', { project: 'Acme Gateway' }), member('Backend', { project: 'Development' })],
  })
  const reread = tp.read('renamed', { knownRoles: SAVED, knownProjects: projects })
  assert.equal(reread.members[0].cwd, '/repos/Acme Gateway', 'by its folder')
  assert.equal(reread.members[1].cwd, '/repos/Acme Gateway', 'by its label')
  assert.equal(reread.faults.filter((f) => /workspace/.test(f)).length, 0)
  assert.ok(draft)
})

test('one project nobody can find is one fault, not one per seat', () => {
  const draft = answer('noisy', {
    name: 'T', goal: 'g', roles: [],
    members: [member('Backend', { project: 'Atlantis' }), member('Backend', { project: 'Atlantis' }),
      member('Supervisor', { project: 'Mu' })],
  })
  const workspace = draft.faults.filter((f) => /workspace/.test(f))
  assert.equal(workspace.length, 1)
  assert.match(workspace[0], /"Atlantis" \(2\)/)
  assert.match(workspace[0], /"Mu"/)
})

test('a member says nothing about delegating, so it inherits the role it was given', () => {
  /*
   * Measured against a real proposal: the session reused the saved Supervisor
   * role and left the member's box alone. That is not a team with nobody in
   * charge — it is a proposal written by somebody who read the role.
   */
  const draft = answer('inherit', {
    name: 'T', goal: 'g', roles: [],
    members: [member('Supervisor'), member('Backend')],
  })

  assert.equal(draft.members[0].delegates, true)
  assert.equal(draft.members[0].delegatesInherited, true)
  assert.equal(draft.members[1].delegates, false)
  assert.equal(draft.faults.length, 0)
})

test('said and omitted are different answers', () => {
  // An explicit false is a decision about this team; the same role supervises
  // on one team and builds on another.
  const draft = answer('explicit', {
    name: 'T', goal: 'g', roles: [],
    members: [member('Supervisor', { delegates: false }), member('Backend', { delegates: true })],
  })

  assert.equal(draft.members[0].delegates, false)
  assert.equal(draft.members[0].delegatesInherited, false)
  assert.equal(draft.members[1].delegates, true)
})

test('the ceilings that stop a team working are read here, not discovered later', () => {
  const draft = answer('too-many', {
    name: 'T', goal: 'g', roles: [],
    members: Array.from({ length: 11 }, () => member('Backend')),
  })

  assert.ok(draft.faults.some((f) => /11 sessions: past 8 colleagues/.test(f)))
  assert.ok(draft.faults.some((f) => /Nobody hands out the work/.test(f)))
})

test('a session cannot rewrite what the deck recorded by writing its answer', () => {
  const draft = answer('sneaky', {
    name: 'T', goal: 'g', roles: [], members: [member('Backend')],
    // The deck's own bookkeeping, offered back by the session.
    status: 'raised', from: 'somewhere else', requestedAt: 1, source: 'elsewhere',
  })

  assert.equal(draft.status, 'ready')
  assert.equal(draft.from, 'a session')
  assert.equal(draft.source, 'sneaky')
})

test('discarding takes both halves with it', () => {
  answer('throwaway', { name: 'T', goal: 'g', roles: [], members: [member('Backend')] })
  assert.equal(tp.read('throwaway', { knownRoles: SAVED }).status, 'ready')
  tp.clear('throwaway')
  assert.equal(tp.read('throwaway', { knownRoles: SAVED }), null)
})

test('the prompt carries the limits that decide the shape, and the saved roles', () => {
  const prompt = tp.promptFor({
    file: '/tmp/x.json',
    roles: [{ name: 'Backend', brief: 'You own the API.' }],
    projects: PROJECTS,
  })

  assert.match(prompt, /at most 8 colleagues/)
  assert.match(prompt, /same permission mode/)
  assert.match(prompt, /started last/)
  assert.match(prompt, /\*\*Backend\*\*: You own the API\./, 'the brief, so it does not propose a near-duplicate')
  assert.match(prompt, /- Platform/, 'the exact project spelling it has to match')

  /*
   * The skeleton asks rather than answers. Measured: the first version showed
   * `"delegates": false` as the example and a real session filled it in on all
   * seven members, including the supervisor — a default inside a skeleton is
   * an answer, not a placeholder.
   */
  assert.doesNotMatch(prompt, /"delegates": false/)
  assert.match(prompt, /they are\nquestions, not defaults/)
})

test('raising part of a proposal marks those seats and keeps the rest', () => {
  /*
   * The proposal this was built against says it in its own preconditions:
   * raise these three now, hold the other four until a decision lands. A draft
   * that vanished at the first raise would take the second half with it.
   */
  const draft = answer('phased', {
    name: 'T', goal: 'g', roles: [],
    members: [member('Supervisor'), member('Backend'), member('Analyst')],
  })
  assert.equal(draft.raisedCount, 0)
  assert.equal(draft.allRaised, false)

  tp.markRaised('phased', {
    members: [{ role: 'Supervisor', project: 'Platform' }],
    teamId: 'team1',
  })

  const after = tp.read('phased', { knownRoles: SAVED, knownProjects: PROJECTS })
  assert.equal(after.raisedCount, 1)
  assert.ok(after.members[0].raised, 'the one that went')
  assert.equal(after.members[1].raised, null, 'the ones that did not')
  assert.equal(after.allRaised, false, 'there is still a second half')
})

test('two seats of the same role are marked one at a time', () => {
  answer('twins', {
    name: 'T', goal: 'g', roles: [],
    members: [member('Backend'), member('Backend')],
  })
  tp.markRaised('twins', { members: [{ role: 'Backend', project: 'Platform' }] })

  const after = tp.read('twins', { knownRoles: SAVED, knownProjects: PROJECTS })
  assert.ok(after.members[0].raised)
  assert.equal(after.members[1].raised, null, 'one raise, one seat')
})

test('a seat nobody can fill does not keep the draft open for ever', () => {
  // `allRaised` is measured against the seats that could go, because one in a
  // project that is not in the workspace never can.
  answer('impossible', {
    name: 'T', goal: 'g', roles: [],
    members: [member('Backend'), member('Backend', { project: 'Atlantis' })],
  })
  tp.markRaised('impossible', { members: [{ role: 'Backend', project: 'Platform' }] })

  const after = tp.read('impossible', { knownRoles: SAVED, knownProjects: PROJECTS })
  assert.equal(after.allRaised, true)
})

test('marking what was raised cannot be undone by the session rewriting its answer', () => {
  const opened = tp.open('rewritten', { from: 'a session' })
  fs.writeFileSync(opened.file, JSON.stringify({
    name: 'T', goal: 'g', roles: [], members: [member('Backend')],
  }))
  tp.markRaised('rewritten', { members: [{ role: 'Backend', project: 'Platform' }] })

  // The session is asked to think again and overwrites the only file it owns.
  fs.writeFileSync(opened.file, JSON.stringify({
    name: 'T2', goal: 'g2', roles: [], members: [member('Backend')],
  }))

  const after = tp.read('rewritten', { knownRoles: SAVED, knownProjects: PROJECTS })
  assert.equal(after.name, 'T2', 'the new answer')
  assert.ok(after.members[0].raised, 'and the deck still knows what it started')
})
