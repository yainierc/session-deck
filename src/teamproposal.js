/**
 * teamproposal.js — a team, proposed by a session that did the work.
 *
 * Composing a team by hand asks you to know the answer before you start: which
 * roles, how many, in which repositories, who hands out the work. That is the
 * right form when you already know. It is the wrong one straight after an
 * analysis, when the session in front of you has just spent three days
 * measuring the thing and knows the answer better than the form does.
 *
 * So this is the other door, and it is the same door `proposal.js` opens for
 * roadmaps: the deck writes down what it asked for, the session writes JSON
 * somewhere else, and what comes back is a draft that a person reads before
 * anything is raised.
 *
 * ### Why a draft and not a team
 *
 * The document this was built against — a real one, 17 KB, written by a
 * session that had coordinated nine others for three days — contains a team.
 * It also contains the sentences that matter more than the team:
 *
 *     "Phase B — do not raise this until §5's preconditions are met"
 *     "Do not add parallelism to Phase A. More sessions do not move decisions."
 *     "Total 6–7, under the 8-peer ceiling. Do not plan for nine."
 *
 * A button that turned that into four running sessions would have thrown away
 * every one of them. `preconditions` and `notes` are in the schema for exactly
 * this, and the panel shows them beside the button rather than under a fold.
 *
 * ### Why every entry has to cite something
 *
 * The same rule `proposal.js` keeps, for the same recorded reason: sessions in
 * this project have asserted things that were not true, in writing, more than
 * once. A role whose `why` names a file, a measurement or a section of the
 * document can be checked in seconds. One that says "you will need a
 * verifier" cannot be checked at all, and a team invented in good faith costs
 * four sessions to find out.
 *
 * ### What a bad answer does here
 *
 * It does not disappear. A model is the author, and a row dropped silently is
 * a bug nobody can see — so everything the session wrote is kept and the
 * problems travel beside it as `faults`. That is the opposite of what the
 * stores in this deck do with a hand-edited file, and deliberately: a file
 * somebody typed into should degrade to a default, and a file a model wrote
 * should be handed back with its mistakes named.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { deckDir } from './platform.js'
import { cleanModel, cleanEffort, EFFORTS } from './choices.js'
import { MAX_PEERS } from './roster.js'

/** Without these a role cannot be reviewed, so it is reported, never accepted quietly. */
const ROLE_REQUIRED = ['name', 'brief', 'why']

/** Same, for one seat on the team. */
const MEMBER_REQUIRED = ['role', 'project', 'why']

const MAX_ROLES = 12
const MAX_MEMBERS = 16
const MAX_TEXT = 4000

/**
 * One pending draft per source, where a source is the session that was asked
 * or the document that was read.
 *
 * Hashed for the same reason `proposal.js` hashes a project path: a key that
 * is a path is a key two spellings of the same thing cannot share.
 */
function keyFor(source) {
  return createHash('sha1').update(String(source || '')).digest('hex').slice(0, 12)
}

/** What the session is told to write. The only file it is given. */
export function proposalFile(source) {
  return path.join(deckDir(), 'team-proposals', `${keyFor(source)}.draft.json`)
}

/** What the deck wrote down when it asked. The session never sees this path. */
export function requestFile(source) {
  return path.join(deckDir(), 'team-proposals', `${keyFor(source)}.json`)
}

/**
 * Write down what was asked for, before anybody answers it.
 *
 * Two files and not one, the same as for roadmaps and for the same reason: a
 * single file would put the deck's own record inside a file the session
 * overwrites wholesale, one careless `Write` away from gone.
 */
export function open(source, { from, document, note, deckId } = {}) {
  const record = {
    status: 'drafting',
    source: String(source || ''),
    // What this came out of, in words, so the draft can say so on screen.
    from: String(from || '').slice(0, 200),
    document: String(document || ''),
    note: String(note || '').slice(0, 2000),
    deckId: deckId || null,
    requestedAt: Date.now(),
  }
  try {
    fs.mkdirSync(path.join(deckDir(), 'team-proposals'), { recursive: true })
    // Any answer still lying around belongs to the request being replaced.
    try { fs.unlinkSync(proposalFile(source)) } catch { /* none yet */ }
    fs.writeFileSync(requestFile(source), JSON.stringify(record, null, 2) + '\n')
    return { ok: true, file: proposalFile(source), proposal: record }
  } catch (err) {
    return { ok: false, error: `Could not open a draft: ${err.message}` }
  }
}

/**
 * Every draft there is, newest request first.
 *
 * Enumerated from the requests rather than from the answers, because the
 * request is what decides a draft exists at all: an answer with nothing behind
 * it is a file left over from one somebody discarded while the session was
 * still writing, and offering it would be offering work that was refused.
 */
export function list(options = {}) {
  const dir = path.join(deckDir(), 'team-proposals')
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }

  const drafts = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.draft.json')) continue
    let record
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const draft = record?.source ? read(record.source, options) : null
    if (draft) drafts.push(draft)
  }
  return drafts.sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0))
}

/**
 * Write down which seats were actually raised, and when.
 *
 * Not a reason to throw the proposal away. The one this was built against says
 * it in its own preconditions — raise these three now, hold the other four
 * until a decision lands — so a draft that vanished at the first raise would
 * take the second half of the plan with it. It stays, with the seats already
 * started marked, until every fillable one has gone.
 *
 * Recorded on the request rather than on the answer, which is the file the
 * session owns and overwrites: a session asked to think again would otherwise
 * erase the deck's record of what has already been started.
 */
export function markRaised(source, { members = [], teamId = null } = {}) {
  let record
  try {
    record = JSON.parse(fs.readFileSync(requestFile(source), 'utf8'))
  } catch {
    return { ok: false, error: 'No such proposal' }
  }
  const raised = Array.isArray(record.raised) ? record.raised : []
  for (const member of members) {
    if (!member?.role || !member?.project) continue
    raised.push({
      role: String(member.role),
      project: String(member.project),
      teamId,
      at: Date.now(),
    })
  }
  try {
    fs.writeFileSync(requestFile(source), JSON.stringify({ ...record, raised }, null, 2) + '\n')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export function clear(source) {
  for (const file of [requestFile(source), proposalFile(source)]) {
    try { fs.unlinkSync(file) } catch { /* already gone reads the same */ }
  }
  return { ok: true }
}

const text = (value, limit = 400) => String(value ?? '').trim().slice(0, limit)

/** A saved role, given either as a name or as the whole record. */
const roleName = (role) => (typeof role === 'string' ? role : String(role?.name || ''))

/**
 * What the session left behind, checked rather than trusted.
 *
 * `knownRoles` and `knownProjects` are what the deck has: a member naming a
 * role nobody will create, or a project that is not in the workspace, is a
 * seat that cannot be filled — and finding that out at the moment you press
 * Raise is finding it out too late.
 */
export function read(source, { knownRoles = [], knownProjects = [] } = {}) {
  let record
  try {
    record = JSON.parse(fs.readFileSync(requestFile(source), 'utf8'))
  } catch {
    return null
  }
  if (!record || typeof record !== 'object') return null

  let answer
  try {
    answer = JSON.parse(fs.readFileSync(proposalFile(source), 'utf8'))
  } catch {
    // Not answered yet, or answered with something that is not JSON. Both are
    // "still drafting" as far as this screen is concerned: the session is the
    // one that gets told it wrote nonsense, by being asked again.
    return { ...record, status: 'drafting' }
  }
  if (!answer || !Array.isArray(answer.roles) || !Array.isArray(answer.members)) {
    return { ...record, status: 'drafting' }
  }

  const faults = []

  const roles = answer.roles.slice(0, MAX_ROLES).map((raw, i) => {
    const role = {
      name: text(raw?.name, 40),
      brief: text(raw?.brief, MAX_TEXT),
      why: text(raw?.why, MAX_TEXT),
      model: raw?.model == null ? null : text(raw.model, 60),
      effort: raw?.effort == null ? null : text(raw.effort, 20),
      advisor: raw?.advisor === true,
      delegates: raw?.delegates === true,
      // A role the deck already has is reused rather than made again; the
      // panel needs to know which is which before it offers to create any.
      exists: knownRoles.some((k) => roleName(k).toLowerCase() === text(raw?.name, 40).toLowerCase()),
    }
    const missing = ROLE_REQUIRED.filter((k) => !role[k])
    if (missing.length) {
      faults.push(`Role ${i + 1} (${role.name || 'unnamed'}) has no ${missing.join(', ')}`)
    }
    /*
     * Kept as written and reported, not cleaned. The stores clean, because
     * what reaches them has been accepted; a draft that silently corrected a
     * model nobody offers would be hiding the one thing worth reading.
     */
    if (role.model && !cleanModel(role.model)) {
      faults.push(`Role ${role.name || i + 1} asks for model "${role.model}", which is not shaped like a model name`)
    }
    if (role.effort && !cleanEffort(role.effort)) {
      faults.push(`Role ${role.name || i + 1} asks for effort "${role.effort}", which is not one of ${EFFORTS.join(', ')}`)
    }
    return { ...role, missing }
  })

  const roleNames = new Set([
    ...roles.map((r) => r.name.toLowerCase()).filter(Boolean),
    ...knownRoles.map((r) => roleName(r).toLowerCase()),
  ])

  /*
   * Which roles hand out the work by habit — the proposed ones and the saved
   * ones together. A member that says nothing about it inherits this, exactly
   * as the composer does when you pick a role: a proposal that names the
   * Supervisor role and leaves the member's box alone is not a team with
   * nobody in charge, it is a proposal written by somebody who read the role.
   */
  const delegatingRoles = new Set([
    ...roles.filter((r) => r.delegates).map((r) => r.name.toLowerCase()),
    ...knownRoles.filter((r) => r && typeof r === 'object' && r.delegates)
      .map((r) => roleName(r).toLowerCase()),
  ])
  /*
   * By the name you gave it and by the folder it actually lives in.
   *
   * Those are two different strings as soon as a project is renamed, and the
   * session proposing is the one standing in the folder: it will say "Acme
   * Gateway" where the workspace says "Development". Refusing that is refusing
   * the right answer for a bookkeeping reason.
   */
  const projectNames = new Map()
  for (const project of knownProjects) {
    const folder = String(project.path || '').split(/[/\\]/).filter(Boolean).pop() || ''
    for (const spelling of [project.name, folder]) {
      const key = String(spelling || '').toLowerCase()
      if (key && !projectNames.has(key)) projectNames.set(key, project)
    }
  }

  /*
   * One entry per seat already started, consumed in order so two seats of the
   * same role in the same project are marked one at a time rather than both at
   * once by the first match.
   */
  const alreadyRaised = [...(Array.isArray(record.raised) ? record.raised : [])]

  const members = answer.members.slice(0, MAX_MEMBERS).map((raw, i) => {
    const role = text(raw?.role, 40)
    // Said and omitted are different answers: an explicit false is a decision
    // about this team, and silence is a question the role already answered.
    const said = raw && typeof raw === 'object' && 'delegates' in raw
    const member = {
      role,
      project: text(raw?.project, 120),
      why: text(raw?.why, MAX_TEXT),
      delegates: said ? raw.delegates === true : delegatingRoles.has(role.toLowerCase()),
      delegatesInherited: !said && delegatingRoles.has(role.toLowerCase()),
    }
    const missing = MEMBER_REQUIRED.filter((k) => !member[k])
    if (missing.length) {
      faults.push(`Member ${i + 1} (${member.role || 'no role'}) has no ${missing.join(', ')}`)
    }
    if (member.role && !roleNames.has(member.role.toLowerCase())) {
      faults.push(`Member ${i + 1} wants the role "${member.role}", which is neither proposed nor already saved`)
    }
    const found = projectNames.get(member.project.toLowerCase())
    const at = alreadyRaised.findIndex(
      (r) => r.role.toLowerCase() === member.role.toLowerCase()
        && r.project.toLowerCase() === member.project.toLowerCase(),
    )
    const raised = at >= 0 ? alreadyRaised.splice(at, 1)[0] : null
    return { ...member, cwd: found?.path || null, missing, raised: raised ? raised.at : null }
  })

  /*
   * Said once with the names in it rather than once per seat. Six members in
   * one project that is not in the workspace is one problem with six symptoms,
   * and six identical lines bury the other faults under it.
   */
  const unknown = new Map()
  for (const member of members) {
    if (!member.project || member.cwd) continue
    unknown.set(member.project, (unknown.get(member.project) || 0) + 1)
  }
  if (unknown.size) {
    const named = [...unknown].map(([name, n]) => (n > 1 ? `"${name}" (${n})` : `"${name}"`)).join(', ')
    faults.push(
      `Not in your workspace: ${named}. Either add the folder, or the proposal is naming it `
      + 'something else than the panel does',
    )
  }

  /*
   * The ceilings that make a team not work rather than merely imperfect, so
   * they are read here and not discovered at the moment of raising.
   */
  const leads = members.filter((m) => m.delegates).length
  if (members.length > MAX_PEERS + 1) {
    faults.push(
      `${members.length} sessions: past ${MAX_PEERS} colleagues each one is introduced to only some `
      + 'of the others, and which ones is decided by the order of the list',
    )
  }
  if (members.length > 1 && leads === 0) {
    faults.push('Nobody hands out the work, so these come up knowing only whoever came before them')
  }
  if (leads > 1) {
    faults.push(`${leads} members hand out the work; they will all be started last and all know everybody`)
  }

  /*
   * The request spreads last. What the session wrote is the proposal; what the
   * deck wrote is what was asked for, and a session cannot change the second
   * by writing the first.
   */
  /*
   * A seat with no project can never be raised, so "everything that could go
   * has gone" is measured against the fillable ones. A draft with nothing left
   * is a question that has been answered.
   */
  const fillable = members.filter((m) => m.cwd)
  const allRaised = fillable.length > 0 && fillable.every((m) => m.raised)

  return {
    allRaised,
    raisedCount: members.filter((m) => m.raised).length,
    name: text(answer.name, 60),
    goal: text(answer.goal, MAX_TEXT),
    preconditions: text(answer.preconditions, MAX_TEXT),
    notes: text(answer.notes, MAX_TEXT),
    roles,
    members,
    faults,
    ...record,
    status: 'ready',
  }
}

/**
 * What the session is told to do.
 *
 * Every rule in here is one this deck already enforces or one a session in
 * this project already broke. The citation rule is `proposal.js`'s, unchanged
 * and for the same reason. The ceilings are real — eight is where
 * `resolvePeers` stops, one permission mode is what makes messages arrive at
 * all, and "whoever hands out the work starts last" is how the roster ends up
 * pointing the right way.
 *
 * The existing roles go in by name and brief rather than by name alone: a
 * session that cannot read what `Backend` already says will propose a second
 * one that says nearly the same thing, and you will have two.
 */
export function promptFor({ file, source, roles = [], projects = [], note = '' }) {
  const lines = [
    `Propose the team this work needs, and write it to ${file}.`,
    '',
    'You are not being asked to do the work. You are being asked who should, based on what you',
    'already know from this conversation — which repositories were involved, where the collisions',
    'were, what had to be decided rather than built.',
    '',
  ]

  if (source) lines.push(`What this is proposed from: ${source}`, '')
  if (note) lines.push(`What the person asking added: ${note}`, '')

  lines.push(
    '## The model you are proposing into',
    '',
    'A **role** is a standing brief: what a session is, for as long as the team exists. It says how',
    'to behave, not what to produce. A **member** is one session: a role, placed in one project. A',
    '**team** is the set of members raised together, plus one goal they all receive.',
    '',
    '## The limits that decide the shape — these are real, not advice',
    '',
    `- A session is introduced to at most ${MAX_PEERS} colleagues. Past that the rest are dropped,`,
    '  and which ones is decided by the order of a list. Propose a team that fits.',
    '- Every member runs in the same permission mode. A message between two sessions in different',
    '  modes is held for a human instead of arriving, and that is indistinguishable from "busy".',
    '- Whoever hands out the work is started last, so it is the only one introduced to everybody.',
    '  The others can always reply — a message carries its sender — but they do not know each other.',
    '- The deck does not isolate working trees. Two members in the same checkout share a git index.',
    '  If that matters for what you are proposing, say so in `preconditions`.',
    '',
  )

  if (roles.length) {
    lines.push(
      '## Roles that already exist — reuse them by name before inventing one',
      '',
      ...roles.map((r) => `- **${r.name}**: ${String(r.brief || '').replace(/\s+/g, ' ').slice(0, 220)}`),
      '',
    )
  }

  if (projects.length) {
    lines.push(
      '## Projects in the workspace — `project` must be one of these, spelled exactly',
      '',
      ...projects.map((p) => `- ${p.name}`),
      '',
    )
  }

  lines.push(
    '## What to write',
    '',
    `Write JSON, and nothing else, to ${file} — replacing that file's contents entirely.`,
    'It must parse as this, with every angle-bracketed note replaced by a real value — they are',
    'questions, not defaults:',
    '',
    '{',
    '  "name": "<what this team goes by in a list>",',
    '  "goal": "<what they are working on; every member receives this after their own brief>",',
    '  "preconditions": "<what must be true BEFORE raising this, or empty. See below>",',
    '  "notes": "<what you deliberately left out, and who owns it instead>",',
    '  "roles": [',
    '    { "name": "...", "brief": "...", "why": "...",',
    '      "model": <an alias, or null>, "effort": <a level, or null>,',
    '      "advisor": <true only where being wrong is expensive>,',
    '      "delegates": <true if this role hands out the work by habit> }',
    '  ],',
    '  "members": [',
    '    { "role": "...", "project": "...", "why": "...",',
    '      "delegates": <true on the one that hands out the work on THIS team> }',
    '  ]',
    '}',
    '',
    '## The rules that decide whether this is usable',
    '',
    '**Every role and every member carries a `why`, and a `why` has to be checkable.** Name a file,',
    'a measurement, a ticket, a section of a document, something that happened in this conversation.',
    '"A verifier would help" is not a reason — "two sessions reported green against a stale tree on',
    'the 14th" is. If you cannot cite it, leave the role out and say why in `notes`. A team member',
    'nobody can justify costs a session to find out.',
    '',
    '**`preconditions` is the most valuable field here, and it is usually not empty.** If some of',
    'this should not be raised yet — a decision is open, a branch has not merged, an interface is',
    'not agreed — say exactly that, and say which members it blocks. A draft that says "raise three',
    'of these now and the other two after X" is worth more than one that lists five.',
    '',
    '**A brief says how to behave, not what to build this week.** What they are building goes in',
    '`goal`, once, for everybody. Two paragraphs, imperative, in the house style of the roles above.',
    '',
    '**Reuse a role that already exists rather than proposing a near-duplicate.** A role already',
    'saved still needs its entry in `members`; it just does not need one in `roles`.',
    '',
    '**`delegates` on a member is what decides the order sessions are started in.** The one on a',
    'role is only its habit. Leave a member\'s out and it inherits the role\'s; set it to decide',
    'differently for this team — the same role supervises on one team and builds on another.',
    '',
    '`model` is an alias like `opus` or `sonnet`, or null for the panel\'s own default — which is',
    'the right answer unless you have a reason. `effort` is one of ' + EFFORTS.join(', ') + ', or null.',
    '',
    '**Set `advisor: true` only where being wrong is expensive.** The advisor re-reads the whole',
    'conversation uncached on every call — measured at 78% of a turn\'s cost on this machine.',
    '',
    'Then stop. Do not paste the JSON back, do not summarise it, do not raise anything: a person',
    'reads this before any session is started.',
  )

  return lines.join('\n')
}
