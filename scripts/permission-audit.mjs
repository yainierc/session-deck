/**
 * permission-audit.mjs — how often Claude Code stops to ask you, and what it costs.
 *
 * WHAT CAN AND CANNOT BE MEASURED. There is no record in the transcripts that
 * says "a permission prompt was shown and the user approved it". Denials leave a
 * mark; approvals leave nothing. So this does not count prompts. It derives three
 * views, each one labelled by how hard its evidence is:
 *
 *   1. COVERAGE (hard). Every Bash command that ran, matched against the allow
 *      rules in your settings *as they are today*. A command no rule covers is a
 *      command that would stop and ask. This is arithmetic over two files.
 *   2. TIME (estimated). The gap between a tool_use and its tool_result contains
 *      execution plus, when a prompt appeared, a human. The same command run
 *      many times gives its own execution baseline — the p20 of its own gaps —
 *      and what exceeds that baseline is idle time. Stated as an estimate.
 *   3. DENIALS (hard). Tool results that say the user rejected the call.
 *
 * The estimate in (2) is not asserted, it is CHECKED against (1): if commands no
 * rule covers stall more often than commands a rule covers, the model has
 * predictive power, and the report prints that comparison so the number can be
 * disbelieved on evidence rather than on principle.
 *
 * Usage:  node scripts/permission-audit.mjs [--days 60] [--out <file.html>]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { claudeDir, scanTranscripts, pct, groupBy, dayKey } from './lib/transcripts.mjs'
import { segments, shapeOf, shapeOfSegment, isScaffold, READ_ONLY } from './lib/bash.mjs'

// ─── arguments ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const DAYS = Number(flag('days', '60'))
const OUT = path.resolve(flag('out', path.join(os.homedir(), '.session-deck', 'permission-audit.html')))
const JSON_OUT = OUT.replace(/\.html$/, '.json')

/** Under this many seconds over baseline, a gap is machine time, not a person. */
const WAIT_FLOOR_S = 5
/** A pause longer than this is someone who walked away, not someone deciding. */
const ATTENDED_CAP_S = 120

/**
 * Tools whose long gaps are the design, not an interruption: a question is
 * supposed to wait for you, a background agent is supposed to take minutes.
 */
const NOT_A_PROMPT = new Set([
  'AskUserQuestion', 'Agent', 'Task', 'TaskStop', 'SendMessage', 'Monitor',
  'ExitPlanMode', 'EnterPlanMode', 'KillShell', 'BashOutput', 'ScheduleWakeup',
])

// ─── settings: the allow rules, as they stand today ─────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** Allow rules that apply everywhere. */
function userRules() {
  const out = []
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(claudeDir(), name)
    for (const rule of readJson(file)?.permissions?.allow || []) {
      out.push({ rule, source: '~/.claude/' + name })
    }
  }
  const managed = '/Library/Application Support/ClaudeCode/managed-settings.json'
  for (const rule of readJson(managed)?.permissions?.allow || []) {
    out.push({ rule, source: 'managed-settings.json' })
  }
  return out
}

/** Allow rules that apply only inside one project, found by walking up from cwd. */
const projectRuleCache = new Map()
function projectRules(cwd) {
  if (!cwd) return []
  if (projectRuleCache.has(cwd)) return projectRuleCache.get(cwd)
  const out = []
  let dir = cwd
  for (let i = 0; i < 12; i++) {
    const claude = path.join(dir, '.claude')
    if (fs.existsSync(claude)) {
      for (const name of ['settings.json', 'settings.local.json']) {
        const file = path.join(claude, name)
        for (const rule of readJson(file)?.permissions?.allow || []) {
          out.push({ rule, source: path.relative(os.homedir(), file) })
        }
      }
      break
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  projectRuleCache.set(cwd, out)
  return out
}

/**
 * Parse `Bash(git status*)` into something matchable.
 *
 * Three forms exist in the wild: a bare command (exact), a trailing `*`
 * (prefix), and `bin:*` (that binary with any arguments). Everything that is
 * not a Bash rule is kept by tool name only — this report is about Bash, which
 * is where the asking happens.
 */
function parseRule({ rule, source }) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s.exec(rule)
  if (!m) return { tool: rule, kind: 'tool', source, rule }
  const [, tool, body] = m
  if (tool !== 'Bash') return { tool, kind: 'other', body, source, rule }
  if (body.endsWith(':*')) return { tool, kind: 'bin', body: body.slice(0, -2).trim(), source, rule }
  if (body.endsWith('*')) return { tool, kind: 'prefix', body: body.slice(0, -1), source, rule }
  return { tool, kind: 'exact', body, source, rule }
}

// ─── permission-specific parsing ────────────────────────────────────────────

/**
 * Which segment actually stops the run — a different question from what the
 * command is for, and the one that says what to authorise. `dotnet test 2>&1 |
 * tail -40` is a test run, but if no rule covers `tail` it is `tail` that puts
 * the prompt on screen, and allowing `tail` clears it for every command that
 * ends in a pipe.
 */
function blockerOf(uncoveredSegs) {
  const chosen = uncoveredSegs.find((s) => !isScaffold(s))
  if (!chosen) return uncoveredSegs.some((s) => /^cd(\s|$)/.test(s)) ? 'cd' : null
  return shapeOfSegment(chosen)
}

/** Does any rule cover this one segment? */
function segmentCovered(segment, rules) {
  for (const r of rules) {
    if (r.tool !== 'Bash') continue
    if (r.kind === 'exact' && segment === r.body) return r
    if (r.kind === 'prefix' && segment.startsWith(r.body)) return r
    if (r.kind === 'bin' && (segment === r.body || segment.startsWith(r.body + ' '))) return r
  }
  return null
}

/**
 * A command is covered only if every segment is. Returns the rules that did the
 * covering, so dead rules can be told apart from working ones.
 */
function coverageOf(cmd, rules) {
  const segs = segments(cmd)
  if (!segs.length) return { covered: false, used: [], uncovered: [] }
  const used = []
  const uncovered = []
  for (const s of segs) {
    const hit = segmentCovered(s, rules)
    if (hit) used.push(hit)
    else uncovered.push(s)
  }
  return { covered: uncovered.length === 0, used, uncovered }
}

// ─── the scan ───────────────────────────────────────────────────────────────

const DENIAL = /user doesn't want to proceed|haven't granted it yet|requested permissions to use/i

const since = Date.now() - DAYS * 86400_000
const calls = []            // every tool call we could time
const denials = []
const ruleHits = new Map()  // rule string -> times it covered something

const userRuleSet = userRules().map(parseRule)

const scan = await scanTranscripts({
  since,
  onCall(c) {
    if (c.isError && DENIAL.test(c.errorText)) {
      denials.push({
        at: new Date(c.at).toISOString(), tool: c.tool, sessionId: c.sessionId,
        command: c.command, reason: c.errorText.slice(0, 200),
      })
    }
    if (c.background || NOT_A_PROMPT.has(c.tool)) return

    let shape = c.tool
    let blocker = null
    let covered = null
    let cdOnly = false
    if (c.tool === 'Bash' && c.command) {
      const rules = [...projectRules(c.cwd).map(parseRule), ...userRuleSet]
      const cov = coverageOf(c.command, rules)
      shape = shapeOf(c.command)
      blocker = cov.covered ? null : blockerOf(cov.uncovered)
      covered = cov.covered
      // The whole command is blocked by a `cd` nobody allowed, and nothing else.
      cdOnly = !cov.covered && cov.uncovered.length > 0
        && cov.uncovered.every((s) => /^cd(\s|$)/.test(s))
      for (const r of cov.used) ruleHits.set(r.rule, (ruleHits.get(r.rule) || 0) + 1)
    }

    calls.push({
      tool: c.tool,
      shape,
      blocker,
      gap: c.gap,
      covered,
      cdOnly,
      readOnly: READ_ONLY.has(shape),
      at: c.at,
      sessionId: c.sessionId,
      cwd: c.cwd,
      command: c.command ? c.command.replace(/\s+/g, ' ').slice(0, 160) : null,
    })
  },
})
const { files: scannedFiles, lines: scannedLines, skippedOld } = scan

// ─── aggregation ────────────────────────────────────────────────────────────

/**
 * How long this exact kind of call takes when nobody is in the way. The p20 of
 * its own gaps: low enough to sit under any prompt, high enough not to be a
 * fluke. Rare shapes fall back to their tool's baseline.
 */
const gapsByKey = new Map()
for (const c of calls) {
  const key = c.tool + '\u0000' + c.shape
  if (!gapsByKey.has(key)) gapsByKey.set(key, [])
  gapsByKey.get(key).push(c.gap)
}
const gapsByTool = new Map()
for (const c of calls) {
  if (!gapsByTool.has(c.tool)) gapsByTool.set(c.tool, [])
  gapsByTool.get(c.tool).push(c.gap)
}
const baseline = new Map()
for (const [key, gaps] of gapsByKey) {
  const tool = key.split('\u0000')[0]
  baseline.set(key, gaps.length >= 5 ? pct(gaps, 0.2) : pct(gapsByTool.get(tool) || [0], 0.2))
}

/**
 * A pause is only a pause if it is long in absolute terms AND long relative to
 * what this command normally costs. Without the relative half, `dotnet test`
 * running forty seconds slower than usual gets filed as a permission prompt —
 * it stalled 57% of the time in the first run of this script, which is the
 * signature of a slow test suite, not of a person clicking yes.
 */
for (const c of calls) {
  const base = baseline.get(c.tool + '\u0000' + c.shape) || 0
  const excess = Math.max(0, c.gap - base)
  c.wait = excess >= Math.max(WAIT_FLOOR_S, 0.5 * base) ? excess : 0
  c.attended = Math.min(c.wait, ATTENDED_CAP_S)
}

/** The check: does rule coverage actually predict a stall? */
const bash = calls.filter((c) => c.tool === 'Bash')
const bashCovered = bash.filter((c) => c.covered === true)
const bashUncovered = bash.filter((c) => c.covered === false)
const stallRate = (arr) => (arr.length ? arr.filter((c) => c.wait > 0).length / arr.length : 0)

/**
 * The control rate, and what is left after subtracting it.
 *
 * Some fraction of calls stall for reasons that have nothing to do with
 * permission — a slow disk, a network hiccup, a machine under load. Commands a
 * rule already covers never show a prompt, so their stall rate IS that
 * background noise. Only what a command stalls *above* that floor is worth
 * calling a permission prompt, and only that fraction of the time is charged to
 * this report's headline. It is a subtraction, not a guess, but the control is
 * imperfect — covered commands are not a matched sample — so it stays labelled
 * as an estimate everywhere it appears.
 */
const CONTROL_RATE = stallRate(bashCovered)

function attributable(arr) {
  const stalls = arr.filter((c) => c.wait > 0)
  const expected = CONTROL_RATE * arr.length
  const excess = Math.max(0, stalls.length - expected)
  const share = stalls.length ? excess / stalls.length : 0
  return {
    calls: arr.length,
    stalls: stalls.length,
    excessStalls: excess,
    share,
    attendedS: stalls.reduce((s, c) => s + c.attended, 0) * share,
    blockedS: stalls.reduce((s, c) => s + c.wait, 0) * share,
  }
}

/** Per-day totals, only for days that actually had sessions. */
const days = [...groupBy(calls, (c) => dayKey(c.at))]
  .map(([day, list]) => {
    const uncovered = list.filter((c) => c.tool === 'Bash' && c.covered === false)
    const a = attributable(uncovered)
    return {
      day,
      calls: list.length,
      bash: list.filter((c) => c.tool === 'Bash').length,
      uncovered: uncovered.length,
      stalls: uncovered.filter((c) => c.wait > 0).length,
      promptsEst: Math.round(a.excessStalls),
      attendedMin: a.attendedS / 60,
      blockedMin: a.blockedS / 60,
      sessions: new Set(list.map((c) => c.sessionId)).size,
    }
  })
  .sort((a, b) => a.day.localeCompare(b.day))

/** The commands that would stop and ask, ranked by how often you run them. */
const offenders = [...groupBy(bashUncovered, (c) => c.shape)]
  .map(([shape, list]) => {
    const a = attributable(list)
    return {
      shape,
      count: list.length,
      stalls: a.stalls,
      promptsEst: Math.round(a.excessStalls),
      attendedMin: a.attendedS / 60,
      readOnly: list[0].readOnly,
      cdOnly: list.filter((c) => c.cdOnly).length,
      sessions: new Set(list.map((c) => c.sessionId)).size,
      projects: new Set(list.map((c) => c.cwd)).size,
      sample: list.find((c) => c.wait > 0)?.command || list[0].command,
    }
  })
  .sort((a, b) => b.promptsEst - a.promptsEst || b.count - a.count)

/**
 * What to authorise, ranked by what it would buy.
 *
 * Grouped by the blocking segment rather than by the command, because that is
 * the unit an allow rule is written in: one `Bash(tail *)` clears every command
 * in the corpus that ends in a pipe to tail, whatever the command was.
 */
const blockers = [...groupBy(bashUncovered.filter((c) => c.blocker), (c) => c.blocker)]
  .map(([blocker, list]) => {
    const a = attributable(list)
    return {
      blocker,
      count: list.length,
      promptsEst: Math.round(a.excessStalls),
      attendedMin: a.attendedS / 60,
      projects: new Set(list.map((c) => c.cwd)).size,
      shapes: [...new Set(list.map((c) => c.shape))].slice(0, 6),
      sample: list.find((c) => c.wait > 0)?.command || list[0].command,
    }
  })
  .sort((a, b) => b.promptsEst - a.promptsEst || b.count - a.count)

/**
 * For each blocker, whether a rule for it already exists — and where.
 *
 * This is the difference between "you never allowed grep" and "you allowed grep
 * in one project out of forty-five", and only the second one is true here. The
 * report is not allowed to claim either without checking.
 */
function ruleLocation(blocker) {
  const scopes = new Set()
  for (const r of uniqueRules.values()) {
    if (r.tool !== 'Bash' || r.kind === 'exact') continue
    const body = (r.body || '').trim()
    if (body === blocker || body.startsWith(blocker + ' ')) {
      scopes.add(r.source.startsWith('.claude/') || r.source.includes('managed') ? 'user' : 'project')
    }
  }
  if (scopes.has('user')) return 'user'
  if (scopes.has('project')) return 'project'
  return 'none'
}

/** Rules that have never covered a single call in the window: dead weight. */
const allRules = [...userRuleSet]
const seenProjects = new Set(calls.map((c) => c.cwd).filter(Boolean))
for (const cwd of seenProjects) for (const r of projectRules(cwd).map(parseRule)) allRules.push(r)
const uniqueRules = new Map()
for (const r of allRules) if (!uniqueRules.has(r.rule)) uniqueRules.set(r.rule, r)
const deadRules = [...uniqueRules.values()]
  .filter((r) => r.tool === 'Bash' && !ruleHits.get(r.rule))
  .map((r) => ({ rule: r.rule, source: r.source, kind: r.kind }))
/** A rule with no wildcard can only ever match the one command it was born from. */
const literalRules = [...uniqueRules.values()].filter((r) => r.tool === 'Bash' && r.kind === 'exact')

for (const b of blockers) b.where = ruleLocation(b.blocker)

const overall = attributable(bashUncovered)
const readControl = attributable(bashUncovered.filter((c) => c.readOnly))
const writeGroup = attributable(bashUncovered.filter((c) => !c.readOnly))

const totals = {
  windowDays: DAYS,
  scannedFiles,
  scannedLines,
  skippedOld,
  from: days[0]?.day || null,
  to: days[days.length - 1]?.day || null,
  activeDays: days.length,
  calls: calls.length,
  bash: bash.length,
  bashCovered: bashCovered.length,
  bashUncovered: bashUncovered.length,
  coverage: bash.length ? bashCovered.length / bash.length : 0,
  cdOnlyBlocked: bashUncovered.filter((c) => c.cdOnly).length,

  // the estimate, and the arithmetic behind it
  controlRate: CONTROL_RATE,
  stallRateUncovered: stallRate(bashUncovered),
  promptsEst: Math.round(overall.excessStalls),
  attendedH: overall.attendedS / 3600,
  blockedH: overall.blockedS / 3600,
  medianAttendedMin: pct(days.map((d) => d.attendedMin), 0.5),
  meanAttendedMin: days.length ? days.reduce((s, d) => s + d.attendedMin, 0) / days.length : 0,
  worstDay: [...days].sort((a, b) => b.attendedMin - a.attendedMin)[0] || null,
  secondsPerPrompt: overall.excessStalls ? overall.attendedS / overall.excessStalls : 0,

  // the second check: read-only work should look like the control, write work should not
  readOnlyStallRate: stallRate(bashUncovered.filter((c) => c.readOnly)),
  writeStallRate: stallRate(bashUncovered.filter((c) => !c.readOnly)),
  readOnlyCalls: readControl.calls,
  writeCalls: writeGroup.calls,

  ruleCount: uniqueRules.size,
  bashRuleCount: [...uniqueRules.values()].filter((r) => r.tool === 'Bash').length,
  deadRules: deadRules.length,
  literalRules: literalRules.length,
  denials: denials.length,
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(JSON_OUT, JSON.stringify({
  totals, days,
  offenders: offenders.slice(0, 40),
  blockers: blockers.slice(0, 40),
  deadRules, denials: denials.slice(0, 60),
}, null, 2))

// ─── the report ─────────────────────────────────────────────────────────────

const { renderHtml } = await import('./permission-report.mjs')
fs.writeFileSync(OUT, renderHtml({ totals, days, offenders, blockers, deadRules, literalRules, denials }))

console.log(`transcripts ${scannedFiles} · líneas ${scannedLines.toLocaleString()}`)
console.log(`ventana ${totals.from} → ${totals.to} (${totals.activeDays} días con actividad)`)
console.log(`bash ${totals.bash} · cubiertas ${(totals.coverage * 100).toFixed(1)}% · bloqueadas solo por cd: ${totals.cdOnlyBlocked}`)
console.log(`control ${(totals.controlRate * 100).toFixed(1)}% vs sin cubrir ${(totals.stallRateUncovered * 100).toFixed(1)}%`)
console.log(`  solo-lectura ${(totals.readOnlyStallRate * 100).toFixed(1)}% · escritura/ejecución ${(totals.writeStallRate * 100).toFixed(1)}%`)
console.log(`prompts estimados ${totals.promptsEst} · ${totals.secondsPerPrompt.toFixed(0)}s cada uno`)
console.log(`tiempo atendiendo ${totals.attendedH.toFixed(1)} h — mediana ${totals.medianAttendedMin.toFixed(1)} min/día`)
console.log(`reglas ${totals.bashRuleCount} bash · muertas ${totals.deadRules} · literales ${totals.literalRules}`)
console.log(`\n${OUT}`)
