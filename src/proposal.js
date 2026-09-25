/**
 * proposal.js — turning a plan you already wrote into milestones the deck can run.
 *
 * The roadmaps in this deck are not where a plan is decided. That happens in a
 * conversation, and it ends in a document in the repository — a big one, often
 * tens of kilobytes, with sections, dated measurements and items somebody can
 * cite. One of those documents becomes several deck roadmaps, because a
 * document covers everything the work needs and a roadmap can only cover what
 * this repository can execute. On the machine this was written for, a single
 * 26 KB readiness document produced two roadmaps of seven and six milestones,
 * each one naming what it deliberately left to somebody else.
 *
 * So nothing here proposes a plan. The plan exists. What is missing between
 * the document and the roadmap is transcription: thirteen milestones, five
 * sections each, about twenty-three thousand characters of structured text
 * that is entirely mechanical and entirely tedious. That is the whole job.
 *
 * Three consequences of that, and they are the design:
 *
 *   - **The document is the input, and it is named.** Not "the repo", not the
 *     conversation. A generator pointed at `docs/` finds forty plans and
 *     cannot tell which one is live; the person pressing the button knows, and
 *     the session that just wrote it knows. So the path is chosen, never
 *     guessed.
 *   - **Every claim has to be citable.** This project has recorded, twice and
 *     in writing, that its sessions assert things that are not true — six
 *     retractions in four sessions, then ten in five sessions over two days.
 *     A milestone whose `why` names a section, a file or a dated measurement
 *     can be checked in seconds. One that says "the pipeline is broken" cannot
 *     be checked at all, and reviewing it costs more than writing it did.
 *   - **Nothing lands on its own.** What comes back is a draft. Statuses,
 *     branches and worktrees are not in the schema at all, because they are
 *     not the machine's to set — the same rule `roadmap.js` already keeps.
 *
 * The request and the answer are two files, and that is not tidiness.
 *
 * The deck writes down what was asked for — which document, which note, which
 * session — the moment it is asked, so a draft in flight survives a restart
 * and can say what it is working on. The session writes somewhere else, and
 * the only thing it is trusted with is the proposal itself. One file would
 * have meant the deck's own record of the request living inside a file a
 * session overwrites wholesale, which is a bookkeeping entry one careless
 * `Write` away from gone: the first version did exactly that, and the draft
 * came back unable to name the document it came from.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { deckDir } from './platform.js'

/** The five sections every milestone in both hand-written roadmaps carries. */
export const SECTIONS = [
  ['what', 'What'],
  ['why', 'Why / provenance'],
  ['where', 'Where'],
  ['doneWhen', 'Done when'],
  ['watchOut', 'Watch out'],
]

/** Without these a milestone is not reviewable, so it is not accepted. */
const REQUIRED = ['title', 'what', 'why', 'doneWhen']

const MAX_MILESTONES = 20

/**
 * One pending draft per project, named after the project rather than the
 * document.
 *
 * Keyed by the resolved path for the same reason `roadmap.js` is: /var is a
 * symlink to /private/var on this machine, and a draft filed under one
 * spelling is a draft the other spelling cannot find.
 */
function keyFor(projectPath) {
  let key = String(projectPath || '')
  try {
    key = fs.realpathSync(key)
  } catch {
    // Never resolved is fine; never *inconsistent* is what matters.
  }
  return createHash('sha1').update(key).digest('hex').slice(0, 12)
}

/** What the session is told to write. The only file it is given. */
export function proposalFile(projectPath) {
  return path.join(deckDir(), 'proposals', `${keyFor(projectPath)}.draft.json`)
}

/** What the deck wrote down when it asked. The session never sees this path. */
export function requestFile(projectPath) {
  return path.join(deckDir(), 'proposals', `${keyFor(projectPath)}.json`)
}

/**
 * Write down what was asked for, before anybody answers it.
 *
 * This is what makes "drafting" a state the deck can still see after a
 * restart, and it is why the session overwrites this file rather than
 * creating one: the request and the answer are the same record at two points
 * in its life.
 */
export function open(projectPath, { document, note, deckId }) {
  const record = {
    status: 'drafting',
    document: String(document || ''),
    note: String(note || '').slice(0, 2000),
    deckId: deckId || null,
    requestedAt: Date.now(),
  }
  try {
    fs.mkdirSync(path.join(deckDir(), 'proposals'), { recursive: true })
    // Any answer still lying around belongs to the request being replaced.
    try { fs.unlinkSync(proposalFile(projectPath)) } catch { /* none yet */ }
    fs.writeFileSync(requestFile(projectPath), JSON.stringify(record, null, 2) + '\n')
    return { ok: true, file: proposalFile(projectPath), proposal: record }
  } catch (err) {
    return { ok: false, error: `Could not open a draft: ${err.message}` }
  }
}

export function clear(projectPath) {
  for (const file of [requestFile(projectPath), proposalFile(projectPath)]) {
    try {
      fs.unlinkSync(file)
    } catch {
      // Already gone reads the same as just removed.
    }
  }
  return { ok: true }
}

/** One milestone's five sections, in the order the hand-written ones use. */
export function taskFrom(milestone) {
  return SECTIONS
    .map(([key, heading]) => {
      const body = String(milestone?.[key] ?? '').trim()
      return body ? `${heading}: ${body}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * What the session left behind, checked rather than trusted.
 *
 * A draft that is missing its provenance is not a draft with a gap in it — it
 * is the exact failure this is built to avoid, so it is reported as a fault
 * with the milestone named, not quietly accepted with an empty field.
 */
export function read(projectPath) {
  /*
   * The request is what decides a draft exists at all. An answer with no
   * request behind it is a file left over from a draft somebody discarded
   * while the session was still writing, and showing it would be offering
   * work that was already refused.
   */
  let record
  try {
    record = JSON.parse(fs.readFileSync(requestFile(projectPath), 'utf8'))
  } catch {
    return null
  }
  if (!record || typeof record !== 'object') return null

  let answer
  try {
    answer = JSON.parse(fs.readFileSync(proposalFile(projectPath), 'utf8'))
  } catch {
    // Not answered yet, or answered with something that is not JSON. Both are
    // "still drafting" as far as this screen is concerned: the session is the
    // one that gets told it wrote nonsense, by being asked again.
    return { ...record, status: 'drafting' }
  }

  if (!answer || !Array.isArray(answer.milestones)) return { ...record, status: 'drafting' }

  const faults = []
  const milestones = answer.milestones.slice(0, MAX_MILESTONES).map((m, i) => {
    const missing = REQUIRED.filter((k) => !String(m?.[k] ?? '').trim())
    if (missing.length) {
      faults.push(`Milestone ${i + 1} (${String(m?.title || 'untitled').slice(0, 40)}) has no ${missing.join(', ')}`)
    }
    return { title: String(m?.title || '').trim(), task: taskFrom(m), sections: m, missing }
  })

  /*
   * The request spreads last. What the session wrote is the proposal; what
   * the deck wrote is what was asked for, and a session cannot change the
   * second by writing the first.
   */
  return {
    goal: String(answer.goal || '').trim(),
    milestones,
    faults,
    ...record,
    status: 'ready',
  }
}

/**
 * What the session is told to do.
 *
 * Every rule in here is one that a hand-written roadmap in this project
 * already follows, or one that a session in this project already broke. None
 * of it is style: the citation rule exists because claims were wrong, the
 * slice rule exists because a document covers work this repository cannot do,
 * and the "leave it out" rule exists because a milestone nobody can check is
 * worse than a milestone that is missing.
 */
export function promptFor({ document, note, file, project }) {
  const lines = [
    `Read ${document} and turn the part of it this repository can execute into a roadmap proposal.`,
    '',
    'You are not planning anything. The plan is that document — it was written deliberately,',
    'after an analysis, and it is the authority here. Your job is to transcribe the slice of it',
    'that belongs to this repository into milestones, in the document\'s own terms.',
    '',
    '## What to write',
    '',
    `Write JSON, and nothing else, to ${file} — replacing that file's contents entirely.`,
    'It must parse as:',
    '',
    '{',
    '  "goal": "<one line that names the slice, then blank line, then the paragraphs below>",',
    '  "milestones": [',
    '    { "title": "...", "what": "...", "why": "...", "where": "...", "doneWhen": "...", "watchOut": "..." }',
    '  ]',
    '}',
    '',
    'The first line of `goal` is the name this roadmap goes by in a list, so make it a title and',
    'not a sentence fragment. After it, in the same string: what this roadmap is for, and then —',
    'this paragraph matters more than any other — **what it deliberately does NOT cover, and who',
    'owns that instead**. Name the people, the other repositories and the documents by name. A',
    'roadmap that does not say what it excludes will be read as claiming everything.',
    '',
    '## The five sections',
    '',
    'Every milestone carries all five, and they are not decoration:',
    '',
    '  what      — one imperative sentence. Include the non-goal where there is one',
    '              ("flag, do not delete"; "author the plan, retire nothing").',
    '  why       — where this comes from. MUST cite: an item or section of the document, a file',
    '              path, or a measurement with the date it was taken. See the rule below.',
    '  where     — the exact files or directories the work touches.',
    '  doneWhen  — an observable end state. Enumerate it (a)(b)(c) when it has parts.',
    '  watchOut  — the trap. What has already gone wrong here, what must not be touched, what',
    '              fails silently.',
    '',
    '## The rule that matters most',
    '',
    'Every `why` must be checkable by somebody who reads the document and the repository and',
    'nothing else. Cite the item, the file, or the dated measurement.',
    '',
    'Do not measure anything yourself and do not assert anything the document does not support.',
    'If the document gives you no citable reason for a piece of work, LEAVE THAT MILESTONE OUT',
    'and say so at the end of your reply. A short roadmap somebody can verify is the goal; a',
    'complete one they have to re-derive is the failure. This project has recorded retractions',
    'in its own planning documents twice over — claims that were asserted, believed, and wrong.',
    '',
    '## Scope',
    '',
    `Only work that can be carried out inside ${project}. Forms somebody has to file, grants that`,
    'are assigned out of band, work that lives in another repository: these are named in the',
    '`goal` as excluded, with their owner, and they do not become milestones.',
    '',
    'Order the milestones so that anything depending on an earlier one comes after it — the list',
    'read top to bottom is the only statement of dependency a roadmap has. Where two are',
    'independent, order does not matter and you should not imply that it does.',
    '',
    'Prefer few milestones. One milestone is one decision, which is not the same as one file:',
    'two things belong together when the contrast between them is the point.',
    '',
    'Set no statuses, no branches and no worktrees. They are not yours to set and they are not',
    'in the schema. Nothing you write here starts any work: a person reads this draft and',
    'accepts it before it becomes a roadmap.',
  ]

  if (String(note || '').trim()) {
    lines.push(
      '',
      '## From the person who asked',
      '',
      'This narrows the job. Where it conflicts with the document, it wins — they have read both:',
      '',
      String(note).trim(),
    )
  }

  lines.push(
    '',
    '## When you are done',
    '',
    `Reply with the roadmap's title, how many milestones you wrote, and — listed plainly — anything`,
    'in the document you left out for want of a citation. Do not paste the JSON back.',
  )

  return lines.join('\n')
}
