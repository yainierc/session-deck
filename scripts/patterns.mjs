/**
 * patterns.mjs — the retroactive sweep: is there signal here at all?
 *
 * The permission audit proved one pattern was real and worth acting on. This
 * asks the broader question that came first and is still unanswered: does the
 * record of how you work contain anything else a machine could have noticed?
 *
 * Six detectors, all deterministic. No model reads a transcript here — this
 * counts, and counting is the only part that can be checked. What it produces
 * is a ranked list with its evidence attached, so each line can be believed or
 * dismissed on the spot rather than taken on faith.
 *
 * The rules every detector obeys:
 *
 *   - **A pattern needs a floor.** Five occurrences, three sessions, two days.
 *     Below that it is a coincidence, and a proposal built on a coincidence is
 *     what makes somebody turn the whole feature off in a week.
 *   - **Evidence travels with the claim.** Counts, sessions, days, projects and
 *     one real sample. A finding you cannot check in ten seconds costs more to
 *     review than it saves.
 *   - **Cost is measured, not assumed.** Where the seconds are known they are
 *     summed, because "you do this a lot" and "this costs you an hour a month"
 *     are different sentences and only one of them is worth acting on.
 *
 * Usage:  node scripts/patterns.mjs [--days 60] [--out <file.md>]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { scanTranscripts, groupBy, pct, dayKey } from './lib/transcripts.mjs'
import { shapeOf, literalOf, commandKey, commandFamily, SHELL_KEYWORDS, READ_ONLY } from './lib/bash.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const DAYS = Number(flag('days', '60'))
const OUT = path.resolve(flag('out', path.join(os.homedir(), '.session-deck', 'patterns.md')))

/** The floor below which a repetition is a coincidence. */
const MIN_COUNT = 5
const MIN_SESSIONS = 3
const MIN_DAYS = 2

// ─── collection ─────────────────────────────────────────────────────────────

const since = Date.now() - DAYS * 86400_000
const bash = []      // bash calls, in order
const reads = []     // Read calls with a path
const edits = []     // Edit/Write calls with a path
const failures = []  // any call that came back an error
const prompts = []

/** Which project a transcript belongs to: the directory name Claude Code encodes. */
function projectOf(file) {
  const parts = file.split(path.sep)
  const i = parts.lastIndexOf('projects')
  return i >= 0 && parts[i + 1] ? parts[i + 1] : path.dirname(file)
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

const stats = await scanTranscripts({
  since,
  onCall(c) {
    if (c.isError) {
      failures.push({
        tool: c.tool, shape: c.tool === 'Bash' && c.command ? shapeOf(c.command) : c.tool,
        command: c.command, path: c.path, errorText: c.errorText,
        at: c.at, sessionId: c.sessionId, project: projectOf(c.file),
      })
    }
    if (c.tool === 'Bash' && c.command && !c.background) {
      bash.push({
        key: commandKey(c.command), family: commandFamily(c.command), literal: literalOf(c.command), shape: shapeOf(c.command), gap: c.gap,
        at: c.at, ordinal: c.ordinal, sessionId: c.sessionId,
        project: projectOf(c.file), cwd: c.cwd, raw: c.command,
      })
    } else if (c.tool === 'Read' && c.path) {
      reads.push({
        path: c.path, at: c.at, ordinal: c.ordinal, sessionId: c.sessionId,
        project: projectOf(c.file), gap: c.gap,
      })
    } else if (EDIT_TOOLS.has(c.tool) && c.path) {
      edits.push({
        path: c.path, at: c.at, sessionId: c.sessionId, project: projectOf(c.file),
      })
    }
  },
  onPrompt(p) {
    prompts.push({ text: p.text, at: p.at, sessionId: p.sessionId, project: projectOf(p.file) })
  },
})

// ─── the shape of a finding ─────────────────────────────────────────────────

/**
 * Measure a group of occurrences the same way every time.
 *
 * `sessions` and `days` are the two that matter most: forty runs of the same
 * command inside one afternoon is one task, not a habit, and the floor exists
 * to keep those out.
 */
function evidence(items, { secondsOf = null } = {}) {
  const sessions = new Set(items.map((i) => i.sessionId).filter(Boolean))
  const days = new Set(items.map((i) => dayKey(i.at)))
  const projects = new Set(items.map((i) => i.project).filter(Boolean))
  return {
    count: items.length,
    sessions: sessions.size,
    days: days.size,
    projects: projects.size,
    seconds: secondsOf ? items.reduce((s, i) => s + secondsOf(i), 0) : null,
    firstAt: Math.min(...items.map((i) => i.at)),
    lastAt: Math.max(...items.map((i) => i.at)),
  }
}

const passesFloor = (e) => e.count >= MIN_COUNT && e.sessions >= MIN_SESSIONS && e.days >= MIN_DAYS

// ─── detector 1: the same command, typed again ──────────────────────────────

/**
 * Repeats, grouped by family so that the same command asked to show a different
 * number of output lines counts once. Ranked by the time they cost rather than
 * by how often they happen: thirty instant `git status` calls are not a problem
 * and six two-minute builds are.
 */
const repeatCommands = [...groupBy(bash, (b) => b.family)]
  .map(([family, items]) => ({
    literal: family.slice(0, 220),
    ...evidence(items, { secondsOf: (i) => i.gap }),
    shape: items[0].shape,
    variants: new Set(items.map((i) => i.key)).size,
    sample: items[0].raw,
  }))
  .filter(passesFloor)
  .sort((a, b) => b.seconds - a.seconds)

// ─── detector 2: the same three commands, in the same order ─────────────────

/**
 * Trigrams of consecutive command shapes within one session. A sequence that
 * recurs across sessions is a routine somebody performs by hand — the thing a
 * script, an alias or a skill exists to absorb.
 *
 * Shell keywords are dropped first: `for`/`do` are punctuation from the
 * splitter's point of view, and leaving them in fills the ranking with
 * sequences that say nothing.
 */
const sequences = new Map()
for (const [, calls] of groupBy(bash, (b) => b.sessionId)) {
  const ordered = [...calls]
    .sort((a, b) => a.ordinal - b.ordinal)
    // Exploration is not a routine. Keeping grep/sed/cat in produced 897
    // "sequences" whose top twelve were all permutations of the same five
    // text-wrangling tools — true, and useless. What is left is work that
    // changes something: builds, tests, commits, deploys.
    .filter((c) => !SHELL_KEYWORDS.has(c.shape) && !READ_ONLY.has(c.shape))
  for (let i = 0; i + 2 < ordered.length; i++) {
    const trio = ordered.slice(i, i + 3)
    // A run of the identical command is detector 1's business, not a sequence.
    if (trio[0].shape === trio[1].shape && trio[1].shape === trio[2].shape) continue
    const key = trio.map((t) => t.shape).join(' → ')
    if (!sequences.has(key)) sequences.set(key, [])
    sequences.get(key).push(trio[0])
  }
}
/**
 * Ranked by how many separate sessions the routine shows up in, NOT by elapsed
 * time. Summing the gaps here produced "35 hours" for twenty-five occurrences —
 * the gaps carry idle time between commands, and across parallel sessions they
 * add up past the clock. Breadth is the honest signal: a sequence that appears
 * in twenty different sessions is a habit whatever it cost.
 */
const repeatSequences = [...sequences]
  .map(([key, items]) => ({ key, ...evidence(items) }))
  .filter(passesFloor)
  .sort((a, b) => b.sessions - a.sessions || b.count - a.count)

// ─── detector 3: the same thing failing ─────────────────────────────────────

/**
 * What the error actually says, minus what makes two instances of it differ.
 *
 * The first version read only the first line, which for a shell command is
 * `Exit code 1` and nothing else — so the top "repeated failure" was grep
 * finding no match, sixty-four times. That is not a failure, it is grep
 * answering the question. Signatures now come from the whole message, and a
 * bare exit code with no stderr behind it is dropped entirely.
 */
function errorSignature(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const meaningful = lines.filter((l) => !/^Exit code \d+$/i.test(l))
  return meaningful.slice(0, 2).join(' · ')
}
function normalizeError(text) {
  return errorSignature(text)
    .replace(/\/[^\s:]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\b\d+\b/g, '<n>')
    .trim().slice(0, 130)
}

/** An exit code on its own is a program answering "no", not a problem. */
const isBenign = (f) => !errorSignature(f.errorText)

const repeatFailures = [...groupBy(
  failures.filter((f) => f.errorText
    && !isBenign(f)
    && !/user doesn't want to proceed|haven't granted it yet/i.test(f.errorText)),
  (f) => f.shape + ' :: ' + normalizeError(f.errorText),
)]
  .map(([key, items]) => ({
    key,
    shape: items[0].shape,
    signature: normalizeError(items[0].errorText),
    ...evidence(items),
    sample: items[0].command || items[0].path || '',
    sampleError: errorSignature(items[0].errorText).slice(0, 160),
  }))
  .filter(passesFloor)
  .sort((a, b) => b.count - a.count)

// ─── detector 4: the files every session opens first ────────────────────────

/**
 * Files read in the opening moves of a session, session after session, inside
 * one project. That is orientation the session has to redo every time, and it
 * is exactly what a CLAUDE.md is for.
 */
const OPENING_MOVES = 12
const startupReads = [...groupBy(
  reads.filter((r) => r.ordinal < OPENING_MOVES),
  (r) => r.project + '\u0000' + r.path,
)]
  .map(([key, items]) => {
    const [project, file] = key.split('\u0000')
    return { project, file, ...evidence(items, { secondsOf: (i) => i.gap }) }
  })
  .filter((f) => f.sessions >= 5 && f.days >= MIN_DAYS)
  .sort((a, b) => b.sessions - a.sessions)

// ─── detector 5: reading the same file over and over inside one session ─────

/**
 * The same file read four or more times in a single session. Usually context
 * that fell out of the window and had to be fetched again — cheap in seconds,
 * expensive in tokens, and a sign the file wants to be smaller or pinned.
 */
const churn = []
for (const [sessionId, items] of groupBy(reads, (r) => r.sessionId)) {
  for (const [file, rs] of groupBy(items, (r) => r.path)) {
    if (rs.length >= 4) churn.push({ sessionId, file, times: rs.length, at: rs[0].at, project: rs[0].project })
  }
}
const churnFiles = [...groupBy(churn, (c) => c.file)]
  .map(([file, items]) => ({
    file,
    ...evidence(items),
    totalReads: items.reduce((s, i) => s + i.times, 0),
    worst: Math.max(...items.map((i) => i.times)),
  }))
  .filter((f) => f.sessions >= 3)
  .sort((a, b) => b.totalReads - a.totalReads)

// ─── detector 6: asking for the same thing again ────────────────────────────

/**
 * Prompts that recur nearly verbatim across sessions — the candidate for a
 * slash command. Normalisation is deliberately blunt (lowercase, no accents,
 * no punctuation, first words only): the aim is to catch "run the tests and
 * show me what failed" typed eight different ways, and a stricter comparison
 * catches none of them.
 */
function normalizePrompt(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ').slice(0, 9).join(' ')
}
const repeatPrompts = [...groupBy(
  prompts.filter((p) => p.text.trim().length > 12),
  (p) => normalizePrompt(p.text),
)]
  .map(([key, items]) => ({ key, ...evidence(items), sample: items[0].text.replace(/\s+/g, ' ').slice(0, 150) }))
  .filter((f) => f.key.split(' ').length >= 4 && f.count >= 4 && f.sessions >= 3)
  .sort((a, b) => b.count - a.count)

// ─── context: where the wall clock actually goes ────────────────────────────

const toolTime = [...groupBy(
  [...bash.map((b) => ({ tool: 'Bash', gap: b.gap })),
   ...reads.map((r) => ({ tool: 'Read', gap: r.gap }))],
  (c) => c.tool,
)].map(([tool, items]) => ({
  tool, count: items.length,
  seconds: items.reduce((s, i) => s + i.gap, 0),
  median: pct(items.map((i) => i.gap), 0.5),
}))

// ─── the page ───────────────────────────────────────────────────────────────

const fmtS = (s) => (s >= 3600 ? (s / 3600).toFixed(1) + ' h' : s >= 60 ? Math.round(s / 60) + ' min' : Math.round(s) + ' s')
const ev = (f) => `${f.count}× · ${f.sessions} sesiones · ${f.days} días${f.projects > 1 ? ` · ${f.projects} proyectos` : ''}${f.seconds ? ` · ${fmtS(f.seconds)}` : ''}`
const code = (s) => '`' + String(s).replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, 150) + '`'

const L = []
L.push('# Patrones en cómo trabajas')
L.push('')
L.push(`Barrido retroactivo sobre ${stats.files} transcripts y ${stats.lines.toLocaleString('es')} líneas `
  + `(${stats.calls.toLocaleString('es')} llamadas con resultado, ${stats.prompts.toLocaleString('es')} prompts tuyos), `
  + `ventana de ${DAYS} días.`)
L.push('')
L.push(`Umbral para que algo cuente como patrón: **≥${MIN_COUNT} veces, ≥${MIN_SESSIONS} sesiones, ≥${MIN_DAYS} días**. `
  + 'Por debajo de eso es casualidad. Nada de lo que sigue lo escribió un modelo: son cuentas sobre los ficheros, con su evidencia al lado.')
L.push('')

function section(title, note, rows, render) {
  L.push(`## ${title}`)
  L.push('')
  L.push(note)
  L.push('')
  if (!rows.length) {
    L.push('_Nada supera el umbral._')
    L.push('')
    return
  }
  for (const r of rows) { L.push(render(r)) }
  L.push('')
}

section(
  '1. El mismo comando, otra vez',
  'Repeticiones exactas. Ordenado por el tiempo que cuestan, no por cuántas veces pasan — treinta `git status` instantáneos no son un problema y seis builds de dos minutos sí.',
  repeatCommands.slice(0, 15),
  (r) => `- **${fmtS(r.seconds)}** — ${ev(r)}${r.variants > 1 ? ` · ${r.variants} variantes` : ''}\n  ${code(r.literal)}`,
)

section(
  '2. La misma secuencia de tres comandos',
  'Rutinas que ejecutas a mano en el mismo orden, en sesiones distintas. Es lo que un script o una skill absorbe entero.',
  repeatSequences.slice(0, 12),
  (r) => `- **${r.key}** — ${ev(r)}`,
)

section(
  '3. Lo mismo fallando',
  'Mismo comando, mismo error, repetido. Cada uno es un hook, una corrección o una línea de documentación que no existe.',
  repeatFailures.slice(0, 12),
  (r) => `- **${r.shape}** — ${ev(r)}\n  - error: ${code(r.sampleError)}\n  - al correr: ${code(r.sample)}`,
)

section(
  '4. Lo que toda sesión lee al empezar',
  `Ficheros abiertos en las primeras ${OPENING_MOVES} acciones, sesión tras sesión, dentro del mismo proyecto. Es orientación que se repite desde cero cada vez: candidato a CLAUDE.md.`,
  startupReads.slice(0, 15),
  (r) => `- **${r.sessions} sesiones** — \`${r.file.replace(os.homedir(), '~')}\``,
)

section(
  '5. Ficheros releídos dentro de una misma sesión',
  'Cuatro o más lecturas del mismo fichero en una sola sesión: contexto que se cayó de la ventana y hubo que volver a traer. Barato en segundos, caro en tokens.',
  churnFiles.slice(0, 12),
  (r) => `- **${r.totalReads} lecturas** en ${r.sessions} sesiones (peor caso ${r.worst} en una) — \`${r.file.replace(os.homedir(), '~')}\``,
)

section(
  '6. Lo que pides una y otra vez',
  'Prompts casi idénticos en sesiones distintas. Candidatos a comando propio.',
  repeatPrompts.slice(0, 12),
  (r) => `- **${r.count}×** en ${r.sessions} sesiones — ${code(r.sample)}`,
)

L.push('## Contexto')
L.push('')
for (const t of toolTime.sort((a, b) => b.count - a.count)) {
  L.push(`- **${t.tool}** — ${t.count.toLocaleString('es')} llamadas, mediana ${t.median.toFixed(2)} s`)
}
L.push('')
L.push('_No sumo el total de horas a propósito: la latencia de una llamada incluye tiempo muerto, '
  + 'y las sesiones corren en paralelo, así que el total daba 450 h en 32 días. Medir eso bien es lo que hace el informe de permisos._')
L.push('')
L.push('---')
L.push('')
L.push('Generado por `scripts/patterns.mjs`. Cada línea es comprobable: el comando, el fichero y las cuentas están ahí.')

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, L.join('\n') + '\n')

console.log(`transcripts ${stats.files} · líneas ${stats.lines.toLocaleString('es')} · llamadas ${stats.calls.toLocaleString('es')} · prompts ${stats.prompts}`)
console.log(`bash ${bash.length} · reads ${reads.length} · edits ${edits.length} · fallos ${failures.length}`)
console.log('')
console.log(`1. comandos repetidos ....... ${repeatCommands.length}`)
console.log(`2. secuencias repetidas ..... ${repeatSequences.length}`)
console.log(`3. fallos repetidos ......... ${repeatFailures.length}`)
console.log(`4. lecturas de arranque ..... ${startupReads.length}`)
console.log(`5. ficheros releídos ........ ${churnFiles.length}`)
console.log(`6. prompts repetidos ........ ${repeatPrompts.length}`)
console.log(`\n${OUT}`)
