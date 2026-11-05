/**
 * Reading somebody else's plans without inventing any.
 *
 * Every test here is a mistake this reader actually made against real
 * repositories, because the failure mode of this file is not a crash — it is
 * a board that looks right and says something false about whether work is
 * done. The old roadmap died of exactly that, so the bar is that the reader
 * would rather say nothing than say something it inferred.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { detect, read, frontmatter } = await import('../src/plans.js')

function repo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plans-'))
}

function write(root, rel, text) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

const contract = (fields) => `---\n${fields}\n---\n\n# body\n`

test('a block scalar is text, not a pile of fields', () => {
  // `standards: |` is followed by prose containing colons. Read as fields it
  // invents entries out of half-sentences, and one of them can be `status`.
  const fm = frontmatter(contract([
    'id: T-01',
    'standards: |',
    '  acme-standards origin/main abc1234, read 2026-10-06: the convention has no rule',
    '  status: this line is prose and must not become a field',
    'status: completed',
  ].join('\n')))

  assert.equal(fm.id, 'T-01')
  assert.equal(fm.status, 'completed')
  assert.match(fm.standards, /^acme-standards/)
})

test('dependencies are read in both of the shapes in use', () => {
  const inline = frontmatter(contract('depends_on: [A-1, A-2]'))
  assert.deepEqual(inline.depends_on, ['A-1', 'A-2'])

  const block = frontmatter(contract('depends_on:\n  - A-1\n  - A-2\nstatus: pending'))
  assert.deepEqual(block.depends_on, ['A-1', 'A-2'])
  // The key after a block list is still found; losing it swallowed `status`.
  assert.equal(block.status, 'pending')
})

test('nothing is a real answer and is not the string "~"', () => {
  assert.equal(frontmatter(contract('ticket: ~')).ticket, null)
})

test('a project with no convention says so, and is writable', () => {
  const root = repo()
  const found = detect(root)
  assert.equal(found.method, 'none')
  // The only state where the deck may offer to create a plan. Everywhere else
  // the project already has an answer and a second one is the old disease.
  assert.equal(found.writable, true)
})

test('a gate log means the deck reports and never writes', () => {
  const root = repo()
  write(root, '.trellis/profile.yml', 'project:\n  code: x\n')
  write(root, 'docs/contracts/completed/T-01.md', contract('id: T-01\nstatus: completed'))
  write(root, '.trellis/gate-log.jsonl', '')

  const found = detect(root)
  assert.equal(found.method, 'trellis')
  assert.equal(found.statusOwner, 'gate')
  // Two writers on one field is how a board and a repository start disagreeing.
  assert.equal(found.writable, false)
})

test('a generated index closes the door on writing', () => {
  const root = repo()
  fs.mkdirSync(path.join(root, 'docs/IPs/IP-001-thing'), { recursive: true })
  write(root, 'docs/IPs/README.md', '<!-- BEGIN GENERATED: ip-active (node scripts/docs-index.mjs) -->\n')

  const found = detect(root)
  assert.equal(found.method, 'ip')
  assert.equal(found.writable, false)
  // Carried so the screen can say how to regenerate rather than just refusing.
  assert.equal(found.index.command, 'node scripts/docs-index.mjs')
})

test('done is not the same claim when a gate wrote it', () => {
  const root = repo()
  write(root, '.trellis/profile.yml', 'project:\n  code: x\n')
  write(root, 'docs/specs/thing.md', contract('id: thing\ntitle: The real title'))
  write(root, 'docs/contracts/completed/T-01.md', contract('id: T-01\ntitle: one\nspec: docs/specs/thing.md\nstatus: completed'))
  write(root, 'docs/contracts/completed/T-02.md', contract('id: T-02\ntitle: two\nspec: docs/specs/thing.md\nstatus: completed'))
  write(root, '.trellis/gate-log.jsonl',
    JSON.stringify({ contract: 'T-01', verdict: 'passed', checks: 10, completed: true, at: '2026-10-06T00:00:00Z' }) + '\n')

  const plan = read(root).plans[0]
  assert.equal(plan.title, 'The real title')
  assert.equal(plan.progress.done, 2)
  // Both are done; only one of them earned it, and the board shows that split.
  assert.equal(plan.earned, 1)
  assert.equal(plan.milestones.find((m) => m.id === 'T-01').determined, 'earned')
  assert.equal(plan.milestones.find((m) => m.id === 'T-02').determined, 'declared')
})

test('a plan named "none" is not a plan', () => {
  const root = repo()
  write(root, '.trellis/profile.yml', 'project:\n  code: x\n')
  // `none` is the documented value for mechanical work with no parent spec.
  write(root, 'docs/contracts/completed/T-01.md', contract('id: T-01\nspec: none\nstatus: completed'))

  const plan = read(root).plans[0]
  assert.notEqual(plan.title, 'none')
  assert.equal(plan.native.ref, null)
})

test('a spec that was archived still names its plan', () => {
  const root = repo()
  write(root, '.trellis/profile.yml', 'project:\n  code: x\n')
  // Archiving is a move, so every contract that served it now points at a
  // path that does not resolve. The contracts are not wrong and are not fixed.
  write(root, 'docs/specs/archive/2026/old.md', contract('id: old\ntitle: Archived but still named'))
  write(root, 'docs/contracts/completed/T-01.md', contract('id: T-01\nspec: docs/specs/old.md\nstatus: completed'))

  assert.equal(read(root).plans[0].title, 'Archived but still named')
})

test('frontmatter too long to parse never becomes a title from the body', () => {
  const root = repo()
  write(root, '.trellis/profile.yml', 'project:\n  code: x\n')
  /*
   * The real bug: a spec whose frontmatter runs past the read window, closing
   * `---` never seen, and a YAML *comment* inside it matched as a markdown
   * heading. The board printed "Empty because this spec has not been planned
   * into contracts yet" as the name of a plan.
   */
  write(root, 'docs/specs/long.md', '---\nid: long\n# Empty because this spec has no contracts yet\n')
  write(root, 'docs/contracts/pending/T-01.md', contract('id: T-01\nspec: docs/specs/long.md\nstatus: pending'))

  const plan = read(root).plans[0]
  assert.doesNotMatch(plan.title, /^Empty because/)
  // Falls back to the filename, which is the one thing that is always true.
  assert.equal(plan.title, 'long')
})

test('where a contract is filed beats what it says, and the disagreement is kept', () => {
  const root = repo()
  write(root, '.trellis/profile.yml', 'project:\n  code: x\n')
  write(root, 'docs/contracts/completed/T-01.md', contract('id: T-01\nspec: none\nstatus: active'))

  const milestone = read(root).plans[0].milestones[0]
  // Moving a file is an act; editing a field is a keystroke.
  assert.equal(milestone.status, 'done')
  assert.match(milestone.conflict, /filed under completed, says active/)
})

test('a convention with no reader yet is not an empty project', () => {
  const root = repo()
  // The deck's own format is the one still unwritten: it is meant to be
  // distilled from the three that already work, not invented ahead of them.
  write(root, 'docs/plans/0001-thing.md', '---\nid: 0001\ntitle: A plan\n---\n')

  const result = read(root)
  assert.equal(result.method, 'deck')
  assert.equal(result.supported, false)
  // "I can see plans here and cannot read them yet" is the honest answer, and
  // it is not the same screen as a project that has none.
  assert.equal(result.plans.length, 0)
})

/**
 * Implementation Plans: the plan is a folder, the items are fenced blocks.
 */
const ip = (root, num, frontMatter, body) =>
  write(root, `docs/IPs/IP-${num}-thing/IP-${num}-thing.md`, `---\n${frontMatter}\n---\n\n${body}`)

const session = (id, fields) => `### ${id}\n\n\`\`\`yaml\n${fields}\n\`\`\`\n`

test('a session is a heading and a fence together, never either alone', () => {
  const root = repo()
  ip(root, '001', 'id: IP-001\ntitle: A plan', [
    '## Sessions\n',
    // A section that merely precedes a session must not adopt its block.
    '### not-a-session\n\nJust prose about what follows.\n',
    session('real-one', 'scope: Do the thing.\nstatus: pending'),
  ].join('\n'))

  const plan = read(root).plans[0]
  assert.deepEqual(plan.milestones.map((m) => m.id), ['real-one'])
})

test('a plan that calls itself done while its sessions do not is not believed', () => {
  const root = repo()
  ip(root, '002', 'id: IP-002\ntitle: Optimistic\nstatus: done', [
    session('a', 'scope: One.\nstatus: done'),
    session('b', 'scope: Two.\nstatus: pending'),
  ].join('\n'))

  const plan = read(root).plans[0]
  // The count cannot be wished: the bar is always the sessions.
  assert.equal(plan.progress.done, 1)
  assert.equal(plan.status, 'in-progress')
  // And the claim is kept, so the disagreement can be shown.
  assert.equal(plan.declared, 'done')
})

test('acceptance checks are counted but never mistaken for having been run', () => {
  const root = repo()
  ip(root, '003', 'id: IP-003\ntitle: Checked', session('a', [
    'scope: Ship it.',
    'acceptance:',
    '  - "dotnet build succeeds"',
    '  - "grep Thing file.cs returns 1+ match"',
    'status: done',
  ].join('\n')))

  const m = read(root).plans[0].milestones[0]
  assert.equal(m.checks, 2)
  // Nothing in the repository records them re-running, so the status is a
  // person's word and the board says so.
  assert.equal(m.determined, 'declared')
})

test('archived plans are read too', () => {
  const root = repo()
  write(root, 'docs/IPs/archive/IP-004-old/IP-004-old.md',
    `---\nid: IP-004\ntitle: Finished long ago\n---\n\n${session('a', 'scope: Done.\nstatus: done')}`)

  const plan = read(root).plans[0]
  assert.equal(plan.title, 'Finished long ago')
  assert.equal(plan.native.archived, true)
})

/**
 * Prose briefs: a status line of running text, and nothing else structured.
 */
const prose = (root, name, text) => write(root, `docs/implementation-plan/${name}`, text)

test('a status token is read, and the sentence after it is not', () => {
  const root = repo()
  prose(root, 'P-S01-a.md', '# P-S01 — A\n\n**Status:** `pending` · T01–T03 delivered (ADO #49925)\n')
  prose(root, 'P-S02-b.md', '# P-S02 — B\n\n**Status:** open. Deploy the narrow grants to dev.\n')
  prose(root, 'P-S03-c.md', '# P-S03 — C\n\n**Status:** `[x]` **DONE 2026-05-04**\n')

  const by = Object.fromEntries(read(root).plans[0].milestones.map((m) => [m.id, m]))
  assert.equal(by['P-S01'].status, 'todo')
  // `open. Deploy the narrow grants to dev.` must not become a status called
  // "deploy", which is what reading past the first token did.
  assert.equal(by['P-S02'].status, 'todo')
  assert.equal(by['P-S03'].status, 'done')
})

test('a status that is a paragraph is unknown, and the paragraph is kept', () => {
  const root = repo()
  prose(root, 'P-S01-a.md',
    '# P-S01 — A\n\n**Status:** Snapshot. Every row was measured on this date against the live estate.\n')

  const m = read(root).plans[0].milestones[0]
  assert.equal(m.status, 'unknown')
  // Shown instead of a verdict: a paragraph is a true answer to "what state
  // is this in" in a way an invented `todo` is not.
  assert.match(m.conflict, /status reads: Snapshot/)
})

test('a filename that is not an identifier does not become a plan', () => {
  const root = repo()
  prose(root, 'e2e-flow-todo-2026-09-25.md', '# E2E flow\n\n**Status:** `pending`\n')
  prose(root, 'P-S01-a.md', '# P-S01 — A\n\n**Status:** `pending`\n')

  const titles = read(root).plans.map((p) => p.title)
  // `e2e-flow` parsed as family `e`, number `2`, and grew a one-item plan
  // called "e series" out of a filename.
  assert.ok(!titles.some((t) => /^e series/.test(t)), titles.join(' | '))
  assert.ok(titles.includes('P-S series'))
})

test('a convention that records no dependencies never calls anything ready', () => {
  const root = repo()
  prose(root, 'P-S01-a.md', '# P-S01 — A\n\n**Status:** `pending`\n')
  prose(root, 'P-S02-b.md', '# P-S02 — B\n\n**Status:** `pending`\n')

  const result = read(root)
  assert.equal(result.knowsDependencies, false)
  /*
   * Thirty prose documents declared startable because none of them said
   * otherwise would drown the handful that really are, in the one list on
   * this screen whose whole value is that it is short and true.
   */
  assert.equal(result.totals.ready, 0)
  assert.equal(result.totals.waiting, 2)
})

/**
 * The execution log.
 *
 * An Implementation Plan records what happened and when, in a table its own
 * template calls append-only — and nothing read it, because it sits under the
 * tenth heading of a four-hundred-line document. It is the one thing on the
 * "where you left off" screen that no other field can supply: `updated:` in
 * the frontmatter is the day somebody edited the file, not the day anything
 * happened.
 */
function ipWithLog(root, body) {
  write(root, 'docs/IPs/IP-900-Thing/IP-900-Thing.md',
    '---\nid: IP-900\ntitle: A thing\nstatus: in-progress\n---\n\n' +
    '## Sessions\n\n### first\n\n```yaml\nscope: Do the first part\nstatus: done\n' +
    'estimated_effort: 3-4h\ndepends_on: []\nnotes: "left the adoption for later"\n```\n\n' +
    body)
  return read(root)
}

test('the last line of the execution log is where you left off', () => {
  const root = repo()
  const r = ipWithLog(root, [
    '## Execution log',
    '',
    '| Date       | Session | Outcome | Notes |',
    '|------------|---------|---------|-------|',
    '| 2026-08-01 | first   | done    | started it |',
    '| 2026-08-18 | second  | done    | 0 portal-src imports (no adoption) |',
    '',
  ].join('\n'))

  const plan = r.plans.find((p) => p.id === 'IP-900')
  assert.equal(plan.log.length, 2)
  // The last row, not the newest date: a hand-written log can repeat or omit
  // one, and sorting would invent an order the file never claimed.
  assert.equal(plan.lastEntry.at, '2026-08-18')
  assert.equal(plan.lastEntry.unit, 'second')
  assert.equal(plan.lastEntry.note, '0 portal-src imports (no adoption)')
})

test('the columns are read by name, not by position', () => {
  // These tables are written by hand and the columns differ between plans.
  // Reading by position would shift every value one column across — which is
  // worse than not reading them, because it would look like data.
  const root = repo()
  const r = ipWithLog(root, [
    '## Execution log',
    '',
    '| Session | Notes            | Date       | Outcome |',
    '|---------|------------------|------------|---------|',
    '| only    | in another order | 2026-09-09 | done    |',
    '',
  ].join('\n'))

  const plan = r.plans.find((p) => p.id === 'IP-900')
  assert.equal(plan.lastEntry.at, '2026-09-09')
  assert.equal(plan.lastEntry.unit, 'only')
  assert.equal(plan.lastEntry.note, 'in another order')
})

test('a plan with no log says nothing rather than borrowing a date', () => {
  const root = repo()
  const r = ipWithLog(root, '## Rollback strategy\n\nRevert the branch.\n')
  const plan = r.plans.find((p) => p.id === 'IP-900')
  assert.equal(plan.log, null)
  assert.equal(plan.lastEntry, null)
})

test('a note on a session is carried, because that is where "later" ends up', () => {
  const root = repo()
  const r = ipWithLog(root, '')
  const plan = r.plans.find((p) => p.id === 'IP-900')
  assert.equal(plan.milestones[0].note, 'left the adoption for later')
})
