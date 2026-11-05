/**
 * plans.js — how each project writes down what it is trying to build.
 *
 * The deck used to answer this with `roadmap.js`, which stored plans in the
 * deck's own directory. That answer is why it was abandoned: a plan nobody
 * can read without the deck is a plan that stops being written, and after
 * three roadmaps and sixteen milestones — every one of them marked `done`,
 * none ever `blocked` — it had become a thing filled in after the fact.
 *
 * So the plan belongs in the repository, and this file starts from the
 * observation that it is usually already there. Across one real workspace:
 *
 *   - 49 Implementation Plans with 359 items, in `docs/IPs/`
 *   - 9 trellis contracts whose status is written by a gate, not typed
 *   - 23 prose session briefs under `docs/implementation-plan/`
 *
 * Three conventions, two of them entrenched and working. Converting those
 * would destroy something that functions in order to install a format, which
 * is the wrong trade. What is missing is not a format — it is one screen that
 * reads all of them and stays true.
 *
 * ### This file only detects. It does not read plans and never writes.
 *
 * Detection is separated from reading because the honest outcome of looking
 * at a repository is often "I do not know what this project does", and that
 * answer has to survive all the way to the screen. A detector that guesses
 * produces a board that is confidently wrong about whether work is done,
 * which is worse than a board that is empty — the empty one sends you to look
 * at the code.
 *
 * ### Evidence travels with the verdict
 *
 * Every result carries what was found and where. Partly so the screen can
 * explain itself, and partly because these conventions are discovered by
 * looking at files whose meaning the deck is inferring: when the inference is
 * wrong, the person reading it needs to see what it was inferred from in
 * order to say so.
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * The conventions the deck can recognise, in the order they win.
 *
 * Order matters because repositories carry more than one. A project that
 * adopted trellis last month still has last year's prose plans on disk, and
 * reading those as the live truth would resurrect a retired index — which is
 * exactly the failure one of these repositories documented about itself.
 *
 * So the strongest signal wins and the rest are reported as `others`. The
 * rule behind the order: a convention a machine maintains beats one a person
 * maintains, and anything explicit beats a folder of documents whose shape
 * the deck is inferring.
 */
const ORDER = ['deck', 'trellis', 'ip', 'prose']

/** Cheap existence checks that never throw on a path we cannot read. */
function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

function entries(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }) } catch { return [] }
}

function readHead(p, bytes = 4096) {
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const read = fs.readSync(fd, buf, 0, bytes, 0)
      return buf.slice(0, read).toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch { return '' }
}

/**
 * A whole small file, or nothing.
 *
 * Frontmatter is read from this rather than from a fixed-size peek, after a
 * peek of 4KB truncated a spec whose frontmatter runs to 5.8KB — the parser
 * then found no closing `---`, fell through to searching the body, and
 * matched a YAML *comment* inside the frontmatter it had not finished
 * reading. The board printed half a sentence about an empty list as the name
 * of a plan.
 *
 * The cap is here so a stray huge file cannot be pulled into memory, not as a
 * guess about how long frontmatter gets. Plans, specs and contracts are
 * documents people read; none of them is a megabyte.
 */
function readDoc(p, max = 512 * 1024) {
  try {
    if (fs.statSync(p).size > max) return readHead(p, max)
    return fs.readFileSync(p, 'utf8')
  } catch { return '' }
}

/**
 * Is this project's index generated rather than hand-written?
 *
 * The question is not cosmetic: it decides whether the deck may touch a
 * plan's frontmatter. One repository here generates its index from exactly
 * those fields and fails the build when the tables are stale, so a deck that
 * flipped a `status` would break a pipeline it has never heard of.
 *
 * Detected from the generated-region markers rather than from the CI file,
 * because the markers are in the document the deck would be editing — and a
 * pipeline can live in Azure, GitHub, a Makefile or somebody's shell history,
 * while the marker is always next to the thing it protects.
 */
function indexGuard(root, dirs) {
  for (const dir of dirs) {
    for (const name of ['README.md', 'index.md', '_index.md']) {
      const file = path.join(dir, name)
      if (!isFile(file)) continue
      const head = readHead(file, 8192)
      const marker = head.match(/<!--\s*BEGIN GENERATED:\s*([^\s(]+)\s*(?:\(([^)]*)\))?/)
      if (marker) {
        return {
          generated: true,
          file: path.relative(root, file),
          // The command is printed inside the marker by every generator that
          // uses this convention, which is the only portable way to learn how
          // to regenerate without reading somebody's pipeline.
          command: (marker[2] || '').trim() || null,
        }
      }
    }
  }
  return { generated: false, file: null, command: null }
}

/**
 * Implementation Plans: a folder per plan, named `IP-NNN-<slug>`.
 *
 * Matched on the directory name rather than on a template file, because the
 * template is the one thing a project copies and then deletes. The numbering
 * is part of the identity here — a sibling folder that is not `IP-\d+` is an
 * auxiliary artifact, which is how the convention's own index reads it.
 */
function findIp(root) {
  const dirs = [path.join(root, 'docs', 'IPs'), path.join(root, 'docs', 'ips')]
  for (const dir of dirs) {
    if (!isDir(dir)) continue
    const plans = entries(dir).filter((e) => e.isDirectory() && /^IP-\d+/i.test(e.name))

    const archive = path.join(dir, 'archive')
    const archived = isDir(archive)
      ? entries(archive).filter((e) => e.isDirectory() && /^IP-\d+/i.test(e.name)).length
      : 0

    /*
     * The archive counts towards recognising the convention, not just towards
     * the total. A repository that has finished and filed every plan it ever
     * wrote still uses Implementation Plans, and reading it as having no
     * convention would offer to install one next to the forty already there.
     */
    if (plans.length === 0 && archived === 0) continue

    return {
      method: 'ip',
      label: 'Implementation Plans',
      dir: path.relative(root, dir),
      count: plans.length,
      archived,
      evidence: [
        { what: `${plans.length} IP-NNN folders`, where: path.relative(root, dir) },
        ...(archived ? [{ what: `${archived} archived`, where: path.relative(root, archive) }] : []),
      ],
      index: indexGuard(root, [dir, path.join(root, 'docs')]),
    }
  }
  return null
}

/**
 * trellis: contracts filed by state, and a gate that writes the state.
 *
 * `.trellis/` alone is not enough and neither are the folders alone — a
 * repository can carry the profile with no work in it yet, and another can
 * have a `docs/contracts/` that means something else entirely. Both are
 * reported, and the gate log is the part worth finding: when it is there, a
 * contract's `completed` was written by a run of its own checks rather than
 * typed by somebody, and the board can say which of the two it is looking at.
 */
function findTrellis(root) {
  const profile = path.join(root, '.trellis', 'profile.yml')
  const contracts = path.join(root, 'docs', 'contracts')
  const states = ['pending', 'active', 'completed']

  const counts = {}
  let total = 0
  for (const state of states) {
    const dir = path.join(contracts, state)
    const n = isDir(dir) ? entries(dir).filter((e) => e.isFile() && e.name.endsWith('.md')).length : 0
    counts[state] = n
    total += n
  }

  const hasProfile = isFile(profile)
  if (!hasProfile && total === 0) return null

  const gateLog = path.join(root, '.trellis', 'gate-log.jsonl')
  const widenings = path.join(root, '.trellis', 'widenings.jsonl')

  return {
    method: 'trellis',
    label: 'trellis contracts',
    dir: path.relative(root, contracts),
    count: total,
    counts,
    evidence: [
      ...(hasProfile ? [{ what: 'profile.yml', where: '.trellis/profile.yml' }] : []),
      ...(total ? [{ what: `${total} contracts (${states.map((s) => `${counts[s]} ${s}`).join(', ')})`, where: path.relative(root, contracts) }] : []),
      ...(isFile(gateLog) ? [{ what: 'gate log — status is written by a gate, not typed', where: '.trellis/gate-log.jsonl' }] : []),
      ...(isFile(widenings) ? [{ what: 'widenings log — scope changes already recorded', where: '.trellis/widenings.jsonl' }] : []),
    ],
    /*
     * Who owns the status. With a gate log present, trellis decides when a
     * contract is complete by re-running its checks — so the deck reports and
     * never writes. Claiming otherwise would put two writers on one field.
     */
    statusOwner: isFile(gateLog) ? 'gate' : 'human',
    index: { generated: false, file: null, command: null },
  }
}

/** The deck's own format, for projects that had no convention of their own. */
function findDeck(root) {
  const dir = path.join(root, 'docs', 'plans')
  if (!isDir(dir)) return null
  const plans = entries(dir).filter((e) => e.isFile() && /^\d+[-.].*\.md$/.test(e.name))
  if (plans.length === 0) return null

  return {
    method: 'deck',
    label: 'deck plans',
    dir: path.relative(root, dir),
    count: plans.length,
    evidence: [{ what: `${plans.length} plan files`, where: path.relative(root, dir) }],
    index: indexGuard(root, [dir]),
  }
}

/**
 * Prose briefs: a folder of documents the deck can see but not parse.
 *
 * The weakest signal here and the one most likely to be wrong, so it is
 * reported with that said out loud. These are real plans — one such folder
 * holds twenty-three session briefs — but their status lives in a bold line
 * of running text, which is readable by a person and guessable by a machine.
 * Guessing is what this file exists not to do, so this reports the shape and
 * leaves the reading to a step that can be checked.
 */
function findProse(root) {
  const candidates = [
    path.join(root, 'docs', 'implementation-plan'),
    path.join(root, 'docs', 'implementation-plans'),
    path.join(root, 'docs', 'plan'),
  ]
  for (const dir of candidates) {
    if (!isDir(dir)) continue
    const docs = entries(dir).filter((e) => e.isFile() && e.name.endsWith('.md'))
    if (docs.length === 0) continue

    /*
     * Do the documents carry a status line at all? It is the difference
     * between a folder the deck can offer to read and one it can only link
     * to, and it is cheap to answer: the convention puts it in the first few
     * lines, so a short read of each file settles it.
     */
    const withStatus = docs.filter((e) => /^\s*\*\*Status:?\*\*/mi.test(readHead(path.join(dir, e.name), 2048))).length

    return {
      method: 'prose',
      label: 'prose plans',
      dir: path.relative(root, dir),
      count: docs.length,
      withStatus,
      evidence: [
        { what: `${docs.length} documents`, where: path.relative(root, dir) },
        { what: withStatus ? `${withStatus} carry a **Status:** line` : 'no status lines found — these read as documents, not items', where: path.relative(root, dir) },
      ],
      index: indexGuard(root, [dir]),
      caveat: 'Inferred from the folder\'s shape. The deck can show these, but their status is prose and it will not be guessed at.',
    }
  }
  return null
}

const FINDERS = { deck: findDeck, trellis: findTrellis, ip: findIp, prose: findProse }

/**
 * How one project writes down its plans.
 *
 * Always answers. `none` is a real result and the one the deck acts on most
 * usefully — it is the project where there is something to offer — so it is
 * shaped like all the others rather than returned as null.
 */
export function detect(root) {
  const found = []
  for (const method of ORDER) {
    const hit = FINDERS[method](root)
    if (hit) found.push(hit)
  }

  const name = path.basename(root)
  if (found.length === 0) {
    return {
      root,
      name,
      method: 'none',
      label: 'no plan convention found',
      count: 0,
      evidence: [],
      others: [],
      /*
       * Nothing to collide with, so the deck may both read and write here.
       * This is the only state where it offers to create a plan: everywhere
       * else the project already has an answer, and a second one would be the
       * two-systems problem that emptied the old roadmap.
       */
      writable: true,
      index: { generated: false, file: null, command: null },
      caveat: null,
    }
  }

  const [primary, ...others] = found

  /*
   * Whether the deck may write a plan's frontmatter here.
   *
   * Two reasons it may not, and they are different: a generated index means
   * editing the fields it is built from breaks a build, and a gate-written
   * status means a machine already owns the field. Either way the deck reads
   * and reports; item-level notes stay writable because no index is built
   * from them.
   */
  const guarded = Boolean(primary.index?.generated) || primary.statusOwner === 'gate'

  return {
    root,
    name,
    method: primary.method,
    label: primary.label,
    dir: primary.dir,
    count: primary.count,
    counts: primary.counts || null,
    evidence: primary.evidence,
    index: primary.index,
    statusOwner: primary.statusOwner || 'human',
    writable: !guarded,
    /*
     * The conventions that are also here. Reported rather than merged: a
     * repository with trellis contracts and last year's prose plans has one
     * live plan store and one archive, and showing both as current would
     * resurrect exactly the stale index this whole screen replaces.
     */
    others: others.map((o) => ({ method: o.method, label: o.label, dir: o.dir, count: o.count })),
    caveat: primary.caveat || null,
  }
}

/** Every tracked project, newest convention question answered for each. */
export function detectAll(roots = []) {
  return roots.map((root) => detect(root))
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading
 *
 * Detection answers which convention a project uses. From here down the job is
 * to turn whichever one it is into a single shape, because the thing being
 * asked for is one screen over every project — and four conventions that are
 * each a big task cut into pieces, tracked as the pieces land, are four names
 * for one idea.
 *
 * The shared words are `plan` and `milestone`. Each one keeps the native name
 * beside it and never instead of it: the board groups and counts in its own
 * vocabulary, the card says `acme-wave-1-T-04`. A label that replaces the
 * real name makes you translate every time you open the file.
 * ──────────────────────────────────────────────────────────────────────────*/

/** What a milestone can be, once every convention has been mapped onto it. */
export const MILESTONE_STATUS = ['todo', 'doing', 'done', 'blocked', 'dropped', 'unknown']

/**
 * How a status came to be what it says.
 *
 * The distinction the old roadmap lacked, and the reason it died: sixteen
 * milestones, all `done`, none ever `blocked` — a record kept by hand after
 * the fact. A board that shows a typed `done` and a `done` written by a run of
 * the work's own checks in the same ink is a board that teaches you to trust
 * both equally, and one of them has not earned it.
 */
export const DETERMINED = ['earned', 'declared', 'unknown']

/**
 * Frontmatter, parsed without a YAML dependency.
 *
 * Deliberately a small reader for the subset these files actually use —
 * scalars, inline `[a, b]` arrays and block `- item` lists — rather than a
 * real parser. Two reasons: the deck ships three runtime dependencies and a
 * plan reader is not worth a fourth, and a strict parser is the wrong tool
 * here anyway. These files are written by people and by other tools; one
 * malformed line must cost that one field, not the whole plan.
 *
 * The part that is not optional is block scalars. `standards: |` is followed
 * by prose containing colons, and reading those lines as fields invents
 * entries like `the convention has no rule for a glossary` out of a sentence.
 * So an indented block after `|`, `>` or a bare key is skipped wholesale.
 */
export function frontmatter(text) {
  // The BOM is matched by escape, not by an invisible character pasted into
  // the source, where nobody can see it and a careless edit deletes it.
  const match = String(text).match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  return parseFields(match[1])
}

/**
 * The same reader, pointed at a fenced ```yaml block.
 *
 * Implementation Plans keep their items in those rather than in frontmatter —
 * one fence per session, under a `### session-id` heading — so the two
 * formats differ only in what delimits them. Sharing the parser is not
 * tidiness: the block scalars that made `standards: |` dangerous in a
 * contract are the same `scope: |` paragraphs that open every session here,
 * and a second parser would have to learn that lesson again.
 */
export function parseFields(text) {
  const lines = String(text).split(/\r?\n/)
  const out = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    i += 1
    if (!line.trim() || /^\s*#/.test(line)) continue

    const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!field) continue

    const key = field[1]
    let value = field[2].replace(/\s+#.*$/, '').trim()

    // A block scalar: everything indented under it is text, not fields.
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block = []
      while (i < lines.length && (/^\s+/.test(lines[i]) || !lines[i].trim())) {
        block.push(lines[i].trim())
        i += 1
      }
      out[key] = block.join(' ').trim()
      continue
    }

    // A block list: `- item` lines under the key.
    if (value === '') {
      const list = []
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        list.push(lines[i].replace(/^\s*-\s+/, '').replace(/\s+#.*$/, '').trim())
        i += 1
      }
      // Indented non-list lines belong to a nested map this reader does not
      // need; skipping them keeps the next key from being read out of them.
      while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*-\s+/.test(lines[i])) i += 1
      out[key] = list
      continue
    }

    if (/^\[.*\]$/.test(value)) {
      out[key] = value.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean)
      continue
    }

    // `~` and `null` are YAML's nothing, and a plan that says a ticket is `~`
    // is saying it has none — not that it has a ticket called "~".
    if (value === '~' || value === 'null' || value === '') out[key] = null
    else out[key] = value.replace(/^["']|["']$/g, '')
  }
  return out
}

/** Read a JSON-per-line log, skipping the lines that are not. */
function readJsonl(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* a torn write; the rest still counts */ }
  }
  return rows
}

/** Every `.md` under a directory, one level of nesting deep. */
function markdownUnder(dir) {
  const out = []
  for (const e of entries(dir)) {
    const full = path.join(dir, e.name)
    if (e.isFile() && e.name.endsWith('.md')) out.push(full)
    else if (e.isDirectory()) {
      for (const inner of entries(full)) {
        if (inner.isFile() && inner.name.endsWith('.md')) out.push(path.join(full, inner.name))
      }
    }
  }
  return out
}

/**
 * trellis statuses, mapped onto the shared five.
 *
 * `exploring` becomes `doing` rather than `todo`, which is the one choice
 * here worth defending: it means the paths and criteria are not known yet, so
 * somebody is actively finding out. Filing it under "not started" would hide
 * the work that is least predictable and most worth watching.
 */
const TRELLIS_STATUS = {
  pending: 'todo',
  exploring: 'doing',
  active: 'doing',
  blocked: 'blocked',
  gated: 'blocked',
  completed: 'done',
  withdrawn: 'dropped',
}

/**
 * Where a spec actually is, given where a contract says it was.
 *
 * Specs get archived when their work lands, and archiving is a move: the path
 * written into every contract that served it stops resolving the day it
 * happens. Those contracts are not wrong and must not be renamed — the
 * reference is a historical fact — so the archive is searched for the same
 * filename before giving up.
 *
 * Only by basename, and only under the specs tree. A looser search would
 * eventually match some unrelated document and title a plan after it, which
 * is the failure this function exists downstream of.
 */
function resolveSpec(root, ref) {
  const direct = path.join(root, ref)
  if (isFile(direct)) return direct

  const name = path.basename(ref)
  const specs = path.join(root, path.dirname(ref))
  for (const archive of [path.join(specs, 'archive'), path.join(root, 'docs', 'specs', 'archive')]) {
    if (!isDir(archive)) continue
    if (isFile(path.join(archive, name))) return path.join(archive, name)
    // Archives are filed by year, so one level down is the shape in use.
    for (const e of entries(archive)) {
      if (!e.isDirectory()) continue
      const candidate = path.join(archive, e.name, name)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/** The bucket for contracts that answer to no spec. */
const NO_SPEC = '(no spec)'

/** `docs/specs/app-shell-and-navigation.md` → `app shell and navigation`. */
function humanise(ref) {
  return path.basename(String(ref || ''), '.md').replace(/[-_]+/g, ' ').trim()
}

/**
 * What a spec calls itself.
 *
 * Its frontmatter `title` first, and the body's first heading only as a
 * fallback. The order is not a preference — reading the body first is wrong,
 * and wrong in a way that looks right: a spec's frontmatter can carry comment
 * lines, those start with `#`, and a heading match over the whole file picks
 * one up and prints half a sentence about why a list is empty as the name of
 * the plan. So the frontmatter is parsed, and the body is only searched below
 * where it ends.
 */
function titleOf(file) {
  const text = readDoc(file)
  const fm = frontmatter(text)
  if (fm.title) return String(fm.title)

  /*
   * No usable frontmatter. If the file opens with `---` the body cannot be
   * searched at all: either the block closes and there was simply no title in
   * it, or it never closes and every `#` line below is a comment inside it.
   * Guessing between those is what produced the wrong name, so neither is
   * guessed — the caller falls back to the filename, which is always true.
   */
  if (/^\uFEFF?---\r?\n/.test(text)) {
    const closed = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---/, '')
    if (closed === text) return null
    const m = closed.match(/^#\s+(.+)$/m)
    return m ? m[1].trim() : null
  }

  const m = text.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

/**
 * Does this contract name a parent spec?
 *
 * `none` is a real, documented value — the convention uses it for mechanical
 * work that answers to no spec — so it has to be read as "no parent" rather
 * than as a path. Left alone it becomes a plan called "none", which is how a
 * board grows a twelfth plan nobody wrote.
 */
function specRef(value) {
  const ref = String(value ?? '').trim()
  if (!ref || ref === 'none' || ref === '~' || ref === 'null') return null
  return ref
}

/**
 * trellis: contracts filed by state, grouped by the spec they serve.
 *
 * The grouping is the whole reason this maps cleanly. A contract names its
 * parent in `spec:`, so the plan is not something the deck invents — it is
 * written in every file, and thirty contracts in one repository resolve into
 * seven plans without anybody deciding anything.
 *
 * Status is read twice over. The folder a contract sits in and its `status:`
 * field should agree; when they do not, the folder wins, because moving a
 * file is an act and editing a field is a keystroke. A disagreement is kept
 * and surfaced rather than smoothed over — a contract filed under `completed`
 * that still says `active` is either a bad move or a bad edit, and both are
 * worth somebody's attention.
 */
function readTrellis(root) {
  const base = path.join(root, 'docs', 'contracts')
  const plans = new Map()
  const unreadable = []

  /*
   * The gate's own record, keyed by contract. This is what turns `done` from
   * a claim into a fact: a verdict, the number of checks that produced it and
   * when. Last entry wins — a contract can be gated more than once, and the
   * most recent run is the one that describes it now.
   */
  const verdicts = new Map()
  for (const row of readJsonl(path.join(root, '.trellis', 'gate-log.jsonl'))) {
    if (row && row.contract) verdicts.set(String(row.contract), row)
  }

  const drift = []
  for (const row of readJsonl(path.join(root, '.trellis', 'widenings.jsonl'))) {
    if (!row || !row.contract) continue
    drift.push({
      milestone: String(row.contract),
      at: row.at || null,
      what: 'scope widened past what the contract declared',
      where: row.path || null,
    })
  }

  for (const state of ['pending', 'active', 'completed', 'archive']) {
    const dir = path.join(base, state)
    if (!isDir(dir)) continue

    for (const file of markdownUnder(dir)) {
      const fm = frontmatter(readDoc(file))
      const id = fm.id || path.basename(file, '.md')
      if (!fm.id && !fm.status) {
        // A markdown file in the contracts tree that is not a contract — a
        // README, a note. Recorded rather than dropped so a plan that fails
        // to appear has somewhere to be explained.
        unreadable.push({ file: path.relative(root, file), why: 'no contract frontmatter' })
        continue
      }

      const filed = state === 'archive' ? 'completed' : state
      const declared = String(fm.status || '').trim()
      const status = TRELLIS_STATUS[filed] || TRELLIS_STATUS[declared] || 'unknown'

      const verdict = verdicts.get(String(id))
      const earned = Boolean(verdict && verdict.verdict === 'passed' && verdict.completed)

      const ref = specRef(fm.spec)
      const key = ref || NO_SPEC
      if (!plans.has(key)) {
        const specFile = ref ? resolveSpec(root, ref) : null
        plans.set(key, {
          id: ref ? path.basename(ref, '.md') : NO_SPEC,
          native: { kind: 'spec', ref, file: specFile ? path.relative(root, specFile) : null },
          /*
           * Work with no spec is still work and still belongs on the board —
           * it is just not a plan anybody wrote, so it is named for what it
           * is instead of being given a borrowed title.
           */
          title: ref
            ? ((specFile && titleOf(specFile)) || humanise(ref))
            : 'No plan — loose work',
          milestones: [],
        })
      }

      plans.get(key).milestones.push({
        id: String(id),
        title: fm.title ? String(fm.title) : humanise(file),
        native: { kind: 'contract', state: filed, file: path.relative(root, file) },
        status,
        /*
         * Earned only when a gate says so. `declared` is not an accusation —
         * most work is honestly reported — it is a statement about where the
         * claim came from, which is the thing you need when a board and a
         * repository disagree.
         */
        determined: earned ? 'earned' : status === 'done' ? 'declared' : 'unknown',
        checks: verdict?.checks ?? null,
        at: verdict?.at || fm.last_touched || null,
        dependsOn: Array.isArray(fm.depends_on) ? fm.depends_on.map(String) : [],
        estimate: fm.estimate || null,
        owner: fm.agent || null,
        // Both readings, kept apart, so a disagreement can be shown instead
        // of one of them quietly winning.
        conflict: declared && TRELLIS_STATUS[declared] && TRELLIS_STATUS[declared] !== status
          ? `filed under ${filed}, says ${declared}`
          : null,
      })
    }
  }

  return { plans: [...plans.values()], drift, unreadable }
}

/**
 * Which milestones could actually be started right now.
 *
 * The question the board is for. A plan with thirty pending items does not
 * offer you thirty choices — most of them are waiting on something, and the
 * handful whose dependencies are all satisfied are the only ones you can
 * pick up today. Without this the screen is a report: true, and no help at
 * all when what you want to know is what to do next.
 *
 * Resolved across the whole project rather than within a plan, because
 * dependencies cross plans freely — a contract in the shell plan waits on one
 * in the identity plan, and scoping the lookup per plan would call that
 * satisfied because it could not see the thing holding it up.
 *
 * A dependency naming something that is not here is neither satisfied nor
 * blocking: it is missing, and it is reported as missing. Treating it as done
 * would mark work ready that is not; treating it as blocked would hide work
 * that may well be startable. Both are guesses, and the id was written by
 * hand, so the honest answer is to say the reference does not resolve.
 */
function resolveReadiness(plans, { knowsDependencies = true } = {}) {
  const status = new Map()
  for (const plan of plans) {
    for (const m of plan.milestones) status.set(m.id, m.status)
  }

  for (const plan of plans) {
    for (const m of plan.milestones) {
      const blockedBy = []
      const missing = []
      for (const dep of m.dependsOn) {
        if (!status.has(dep)) missing.push(dep)
        else if (status.get(dep) !== 'done') blockedBy.push(dep)
      }
      m.blockedBy = blockedBy
      m.missingDeps = missing
      /*
       * Ready means "nothing is stopping this": not started, and everything
       * it named is finished. An item already running is not ready — it is
       * under way, which the status already says.
       */
      /*
       * A convention that records no dependencies at all cannot answer this,
       * and answering it anyway would be the worst thing on this board:
       * thirty prose documents declared startable because none of them said
       * otherwise, drowning the handful that really are. So those are never
       * ready, and the screen says the project does not record dependencies
       * rather than leaving an empty list looking like bad news.
       */
      m.ready = knowsDependencies && m.status === 'todo' && blockedBy.length === 0 && missing.length === 0
    }
  }
  return plans
}

/**
 * A plan's own state, worked out from its milestones every time.
 *
 * Never stored. The old roadmap kept this as a field somebody set, and a
 * state you set by hand is a state reality can contradict — which is how
 * three roadmaps ended up with every milestone `done` and no state at all.
 */
function rollUp(plan) {
  const ms = plan.milestones
  const by = (s) => ms.filter((m) => m.status === s).length
  const done = by('done')
  const live = ms.length - by('dropped')

  const status = live === 0 ? 'empty'
    : done === live ? 'done'
      : by('doing') || done ? 'in-progress'
        : 'planned'

  return {
    ...plan,
    status,
    blocked: by('blocked'),
    progress: { done, total: live },
    /*
     * How much of that progress was verified rather than asserted. Shown
     * beside the count because "9 of 9 done" means two different things
     * depending on whether anything re-ran the checks.
     */
    earned: ms.filter((m) => m.determined === 'earned').length,
    // How many of its unstarted items you could pick up today.
    ready: ms.filter((m) => m.ready).length,
    waiting: ms.filter((m) => m.status === 'todo' && !m.ready).length,
  }
}

/**
 * Implementation Plan statuses, mapped onto the shared five.
 *
 * Two vocabularies in one file: the plan's own `draft | in-progress | done |
 * abandoned`, and its sessions' `pending | in-progress | done | blocked`.
 * They overlap without being the same list, so both are folded here and the
 * plan's is only ever used to disagree with what its sessions say.
 */
const IP_STATUS = {
  pending: 'todo',
  draft: 'todo',
  'in-progress': 'doing',
  'in progress': 'doing',
  active: 'doing',
  blocked: 'blocked',
  done: 'done',
  complete: 'done',
  completed: 'done',
  abandoned: 'dropped',
  withdrawn: 'dropped',
}

/**
 * The sessions inside one Implementation Plan.
 *
 * Each is a `### session-id` heading followed by a fenced ```yaml block, and
 * the pairing is what makes them findable: a heading on its own is a section,
 * a fence on its own is an example. Only the two together are an item, which
 * is why this matches both rather than scanning for either.
 *
 * Blank lines and prose are allowed to sit between the two, because they do —
 * the template puts a note under some headings — but another `###` in between
 * ends the search, so a section that merely precedes a session cannot adopt
 * that session's block.
 */
/**
 * The rows of a markdown table, keyed by its own header.
 *
 * Keyed rather than positional because these tables are written by hand and
 * the columns differ between plans — one puts Notes last, another puts an
 * owner in the middle. Reading by position would silently shift every value
 * one column across, which is worse than not reading them at all.
 */
function markdownTable(body) {
  const lines = String(body).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'))
  if (lines.length < 2) return []
  const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
  const head = cells(lines[0]).map((h) => h.toLowerCase())
  const rows = []
  for (const line of lines.slice(1)) {
    // The `|---|:--:|` rule under the header, which is layout and not data.
    if (/^\|[\s:|-]+\|?$/.test(line)) continue
    const values = cells(line)
    if (values.length < 2) continue
    const row = {}
    head.forEach((key, i) => { row[key] = values[i] ?? '' })
    rows.push(row)
  }
  return rows
}

/**
 * The last thing that happened, out of the plan's own execution log.
 *
 * This is the one field on this screen that nothing else can supply, and the
 * reason is in the plan's own words: "Updated by the orchestrator as sessions
 * complete. Append-only; never delete entries." A file that records what
 * happened and when already exists; it was simply never read, because it sits
 * under the tenth heading of a four-hundred-line document.
 *
 * It answers "where was I", which is a different question from "what is
 * done" — and the one actually asked after two months away. The note is
 * carried verbatim, because the sentence that matters is usually the one
 * somebody wrote in passing: on the plan this was built against, it is
 * "0 portal-src imports (no adoption)", meaning the library exists and
 * nothing uses it yet.
 */
function ipLog(text) {
  const sections = String(text).split(/^##[ \t]+/m).slice(1)
  const section = sections.find((part) => /^execution log/i.test(part))
  if (!section) return null

  const rows = markdownTable(section)
  if (!rows.length) return null

  const pick = (row, ...names) => {
    for (const name of names) if (row[name]) return row[name]
    return ''
  }
  const entries = rows.map((row) => ({
    at: pick(row, 'date', 'when') || null,
    unit: pick(row, 'session', 'task', 'unit') || null,
    outcome: pick(row, 'outcome', 'result', 'status') || null,
    note: pick(row, 'notes', 'note') || null,
  })).filter((e) => e.at || e.unit)

  if (!entries.length) return null
  // Append-only by the plan's own rule, so the last row is the latest. Not
  // sorted by date: a hand-written log can repeat or omit one, and reordering
  // would invent a sequence the file does not claim.
  return { entries, last: entries[entries.length - 1] }
}

function ipSessions(body) {
  /*
   * Split on the headings rather than matching each session with a lookahead
   * that has to spell "end of string". The first attempt used `\Z` for that,
   * which is Python: JavaScript reads it as a literal Z, the lookahead never
   * matched, and every plan came back with no sessions at all.
   *
   * `###` followed by a space, so `####` sub-headings inside a session do not
   * end it.
   */
  const parts = String(body).split(/^###[ \t]+/m).slice(1)
  const out = []

  for (const part of parts) {
    const brk = part.indexOf('\n')
    const id = (brk < 0 ? part : part.slice(0, brk)).trim()
    const rest = brk < 0 ? '' : part.slice(brk + 1)

    // Only up to the next heading, so a section that merely precedes a
    // session cannot adopt that session's block.
    const fence = rest.match(/```ya?ml\r?\n([\s\S]*?)```/)
    if (!id || !fence) continue
    out.push({ id, fields: parseFields(fence[1]) })
  }
  return out
}

/**
 * Implementation Plans: a folder per plan, sessions inside the document.
 *
 * The deck never writes here, and in the repository this was built against it
 * could not: the index is generated from the plans' frontmatter and CI fails
 * when it is stale, so editing a `status` would break a pipeline the deck has
 * never heard of. `detect` already reports that; this only reads.
 *
 * ### The plan's own status is read, and only used to contradict
 *
 * An IP says `done` in its frontmatter while its sessions say 7 of 13. The
 * progress bar is always the sessions — a count cannot be wished — but the
 * disagreement is worth surfacing rather than silently preferring one, so it
 * rides along as a conflict in exactly the way a misfiled contract does.
 */
function readIp(root) {
  const base = isDir(path.join(root, 'docs', 'IPs'))
    ? path.join(root, 'docs', 'IPs')
    : path.join(root, 'docs', 'ips')

  const plans = []
  const unreadable = []
  const drift = []

  const folders = []
  for (const dir of [base, path.join(base, 'archive')]) {
    for (const e of entries(dir)) {
      if (e.isDirectory() && /^IP-\d+/i.test(e.name)) {
        folders.push({ dir: path.join(dir, e.name), archived: dir !== base })
      }
    }
  }

  for (const { dir, archived } of folders) {
    /*
     * The plan's own document, not its artifacts. A session may drop design
     * notes and screenshots in the same folder and the convention names some
     * of those after the plan too, so the main file is the one whose name
     * starts with the plan's number — matched the way the project's own index
     * matches it, rather than by taking the first markdown file.
     */
    const file = entries(dir)
      .filter((e) => e.isFile() && /^IP-\d+.*\.md$/i.test(e.name))
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => a.length - b.length)[0]

    if (!file) {
      unreadable.push({ file: path.relative(root, dir), why: 'no IP document in this folder' })
      continue
    }

    const text = readDoc(file)
    const fm = frontmatter(text)
    const id = String(fm.id || path.basename(dir).match(/^IP-\d+/i)?.[0] || path.basename(dir))
    const sessions = ipSessions(text)
    const log = ipLog(text)

    if (sessions.length === 0) {
      /*
       * A plan with no readable sessions still exists and still has a status.
       * It is carried with no milestones rather than dropped, because a plan
       * missing from the board is indistinguishable from a plan that was
       * never written — and one of those is somebody's problem.
       */
      unreadable.push({ file: path.relative(root, file), why: 'no session blocks found' })
    }

    const declared = String(fm.status || '').trim().toLowerCase()

    plans.push({
      id,
      native: { kind: 'IP', ref: path.relative(root, file), archived },
      title: fm.title ? String(fm.title) : humanise(path.basename(dir)),
      owner: fm.owner || null,
      declared: IP_STATUS[declared] || null,
      /*
       * Where this was left, and when. Null on a plan that keeps no log —
       * most of them — and the screen says nothing rather than guessing from
       * the frontmatter's `updated`, which is the date somebody edited the
       * document and not the date anything happened.
       */
      log: log ? log.entries : null,
      lastEntry: log ? log.last : null,
      milestones: sessions.map(({ id: sid, fields }) => {
        const status = IP_STATUS[String(fields.status || '').trim().toLowerCase()] || 'unknown'
        return {
          id: sid,
          title: firstLine(fields.scope) || humanise(sid),
          native: { kind: 'session', file: path.relative(root, file) },
          status,
          /*
           * Never earned. Every session carries `acceptance` — runnable
           * checks — and nothing in the repository records them having been
           * re-run, so the status is a person's word. The board says so
           * rather than dressing a claim as a verdict.
           */
          determined: status === 'done' ? 'declared' : 'unknown',
          checks: Array.isArray(fields.acceptance) ? fields.acceptance.length : null,
          dependsOn: Array.isArray(fields.depends_on) ? fields.depends_on.map(String) : [],
          estimate: fields.estimated_effort || null,
          owner: fields.subagent_type || null,
          // What the plan said about this one in passing. It is where
          // "leave this for later" ends up today, for want of a field of
          // its own.
          note: fields.notes ? String(fields.notes) : null,
          conflict: null,
        }
      }),
    })
  }

  return { plans, drift, unreadable }
}

/**
 * Prose briefs: a folder of documents whose status is a line of running text.
 *
 * The weakest of the readers and the one that most needs to know it. These
 * are real plans — one such folder holds thirty-eight — but nothing in them
 * is structured: no dependencies, no items, and a status line that in
 * practice reads `pending`, or `STUB — full brief pending`, or an entire
 * paragraph explaining that the document is a snapshot and not a roadmap.
 *
 * So this reads exactly two things per document, the status token and the
 * title, and refuses the rest. The raw line is carried untouched so the
 * screen can show what it actually said when the token did not resolve.
 *
 * ### Why a document is a milestone and the folder is the plan
 *
 * Because that is what they are. `P-S03` is a unit of work with a status; the
 * folder is the body of work they belong to. Making each document its own
 * plan would produce thirty-eight plans of one item, and inventing epics by
 * reading the prose would be the guessing this file exists to avoid.
 */
const PROSE_STATUS = {
  pending: 'todo', stub: 'todo', draft: 'todo', proposed: 'todo', open: 'todo', todo: 'todo',
  'in-progress': 'doing', 'in progress': 'doing', active: 'doing', wip: 'doing',
  blocked: 'blocked',
  done: 'done', complete: 'done', completed: 'done', closed: 'done',
  withdrawn: 'dropped', superseded: 'dropped', abandoned: 'dropped', dropped: 'dropped', 'n/a': 'dropped',
}

/** `**Status:** `pending` · T01–T03 delivered` → `pending`, plus the raw line. */
function proseStatus(text) {
  const line = text.match(/^[ \t]*\*\*Status:?\*\*[ \t]*(.+)$/mi)
  if (!line) return { status: 'unknown', raw: null }

  const raw = line[1].trim()
  /*
   * The token is whatever opens the line: a backticked word, a checkbox, or
   * the first bare word. Anything after it is commentary — a date, an ADO
   * number, four sentences about what was re-measured — and reading further
   * is how `open. Deploy the narrow grants to dev.` becomes a status called
   * "deploy".
   */
  /*
   * Unwrap the backticks first, then look inside. Testing for a checkbox
   * before unwrapping made ``[x]`` yield the token "[x]" — brackets and all —
   * which matched nothing, so a document marked done read as unknown.
   */
  const head = raw.match(/^`([^`]+)`/)?.[1] ?? raw

  const box = head.match(/^\[([ xX])\]/)
  if (box) return { status: box[1].toLowerCase() === 'x' ? 'done' : 'todo', raw }

  const token = (head.match(/^([A-Za-z/-]+)/)?.[1] || '').trim().toLowerCase()
  if (token === '') return { status: 'unknown', raw }
  return { status: PROSE_STATUS[token] || 'unknown', raw }
}

/** `P-S03-identity-registry.md` → `P-S03`; `Feature_S07_Kiosk.md` → `Feature_S07`. */
function proseId(name) {
  const base = name.replace(/\.md$/i, '')
  /*
   * The convention is `<prefix>S<number>` — `P-S03`, `Feature_S07`. The `S`
   * is required, and that is the whole guard: without it `e2e-flow-todo.md`
   * parses as family `e`, number `2`, and the board grows a one-item plan
   * called "e series" out of a filename.
   */
  const m = base.match(/^([A-Za-z][A-Za-z]*[-_]?S)(\d+[a-z]?)(?![A-Za-z])/)
  return m ? { family: m[1].replace(/[-_]$/, ''), id: `${m[1]}${m[2]}`.replace(/[-_]$/, '') } : null
}

function readProse(root) {
  const dir = ['implementation-plan', 'implementation-plans', 'plan']
    .map((d) => path.join(root, 'docs', d)).find(isDir)
  if (!dir) return { plans: [], drift: [], unreadable: [] }

  const families = new Map()
  const unreadable = []

  for (const e of entries(dir)) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    if (/^(_|readme)/i.test(e.name)) continue

    const file = path.join(dir, e.name)
    const text = readDoc(file)
    const { status, raw } = proseStatus(text)
    const named = proseId(e.name)
    const key = named ? named.family : 'documents'

    if (!families.has(key)) {
      families.set(key, {
        id: key,
        native: { kind: 'folder', ref: path.relative(root, dir) },
        title: key === 'documents' ? 'Documents with no session number' : `${key} series`,
        milestones: [],
      })
    }

    families.get(key).milestones.push({
      id: named ? named.id : e.name.replace(/\.md$/i, ''),
      title: titleOf(file) || humanise(e.name),
      native: { kind: 'document', file: path.relative(root, file) },
      status,
      determined: status === 'done' ? 'declared' : 'unknown',
      checks: null,
      // Nothing here records what waits on what, which is why `read` turns
      // readiness off for this method entirely rather than per item.
      dependsOn: [],
      estimate: null,
      owner: null,
      /*
       * What the line actually said, whenever it could not be reduced to a
       * status. It is shown instead of a verdict — several of these are a
       * paragraph, and a paragraph is a true answer to "what state is this
       * in" in a way that an invented `todo` is not.
       */
      conflict: status === 'unknown' && raw ? `status reads: ${raw.slice(0, 120)}` : null,
    })
  }

  for (const family of families.values()) {
    family.milestones.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  }

  return { plans: [...families.values()], drift: [], unreadable }
}

/** The opening line of a block scalar, which is where these say what they do. */
function firstLine(text) {
  const line = String(text || '').trim().split(/(?<=\.)\s|\n/)[0]
  return line ? line.trim().slice(0, 160) : null
}

const READERS = { trellis: readTrellis, ip: readIp, prose: readProse }

/**
 * One project's plans, in the shared shape.
 *
 * A convention with no reader yet is not an error and not an empty project:
 * it comes back with `supported: false` and the detection intact, so the
 * screen can say "this project keeps plans here, and I cannot read them yet"
 * — which is true, useful, and the opposite of inventing a board.
 */
export function read(root) {
  const found = detect(root)
  const reader = READERS[found.method]
  if (!reader) {
    return { ...found, supported: false, plans: [], drift: [], unreadable: [] }
  }

  const { plans, drift, unreadable } = reader(root)
  const knowsDependencies = found.method !== 'prose'
  const rolled = resolveReadiness(plans, { knowsDependencies })
    .map(rollUp).sort((a, b) => a.title.localeCompare(b.title))

  return {
    ...found,
    supported: true,
    // Said out loud so an empty "ready" list reads as "this convention does
    // not record what waits on what", not as "there is nothing to do".
    knowsDependencies,
    plans: rolled,
    drift,
    unreadable,
    totals: {
      plans: rolled.length,
      milestones: rolled.reduce((n, p) => n + p.milestones.length, 0),
      done: rolled.reduce((n, p) => n + p.progress.done, 0),
      earned: rolled.reduce((n, p) => n + p.earned, 0),
      blocked: rolled.reduce((n, p) => n + p.blocked, 0),
      ready: rolled.reduce((n, p) => n + p.ready, 0),
      waiting: rolled.reduce((n, p) => n + p.waiting, 0),
    },
    /*
     * Every startable item in the project, flattened and carrying its plan.
     * The board leads with this: it is the answer to "what can I pick up",
     * and digging it out of eleven collapsed plans was the thing that made
     * the first draft a report instead of a tool.
     */
    ready: rolled.flatMap((p) => p.milestones.filter((m) => m.ready)
      .map((m) => ({ ...m, plan: { id: p.id, title: p.title } }))),
  }
}

/**
 * Every plan a project has, including the ones that are not in the branch the
 * checkout happens to be sitting on.
 *
 * `read()` walks the working directory, which is the honest thing for one
 * directory and the wrong thing for a project. Measured on a real repository:
 * the main checkout was parked on `tmp-verify-3`, a temporary verification
 * branch, so the board showed that branch's four plans — while the one the
 * person wanted to work on lived in `Development` and in six feature branches,
 * none of which the deck was looking at. A plan belongs to the project, not to
 * whichever branch somebody left checked out.
 *
 * So the worktrees are read too, and the main checkout still wins every
 * collision: it is the copy being edited, and the others are snapshots of it
 * from whenever their branch left.
 *
 * Cheap on the common path. Listing a worktree's plan folder is a readdir; a
 * worktree that adds nothing new is never read. On the repository above, 48
 * worktrees cost 48 readdirs and two full reads.
 */
export function readAll(root, worktrees = []) {
  const base = read(root)
  if (!base.supported || !base.dir) return base

  const known = new Set((base.plans || []).map((p) => p.id))
  const extra = []
  const seen = new Set()

  /*
   * `dir` comes back relative to the root — it is there to be printed on a
   * card, not resolved. Running it through `path.relative` treated it as a
   * path from the process's own directory and produced a plausible-looking
   * route to nowhere, which the readdir below swallowed as "this worktree has
   * no plans". Every worktree answered that, so the feature reported success
   * and found nothing.
   */
  const inside = path.isAbsolute(base.dir) ? path.relative(root, base.dir) : base.dir

  for (const worktree of worktrees) {
    if (!worktree || worktree === root) continue
    // Which plan folders does this worktree have that the checkout does not?
    // A readdir, not a read: most worktrees are a copy of the same branch and
    // answer "none" without a file being opened.
    let names = []
    try {
      names = fs.readdirSync(path.join(worktree, inside), { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.name.endsWith('.md'))
        .map((e) => e.name)
    } catch {
      continue
    }
    if (!names.some((name) => !known.has(name.replace(/\.md$/, '').match(/^IP-\d+/i)?.[0] || name))) continue

    let found
    try { found = read(worktree) } catch { continue }
    for (const plan of found.plans || []) {
      if (known.has(plan.id) || seen.has(plan.id)) continue
      seen.add(plan.id)
      /*
       * Said on the card, because where a plan lives changes what you can do
       * with it: this one is not in the branch you have open, and starting it
       * means checking that branch out first.
       */
      extra.push({ ...plan, elsewhere: { worktree, name: path.basename(worktree) } })
    }
  }

  if (!extra.length) return base
  return {
    ...base,
    plans: [...base.plans, ...extra].sort((a, b) => String(a.title).localeCompare(String(b.title))),
    elsewhere: extra.length,
  }
}
