/**
 * transcripts.mjs — one pass over everything Claude Code has written down.
 *
 * The corpus on this machine is 575 .jsonl files and a gigabyte, and reading it
 * takes about a minute. That is affordable once and absurd per detector, so
 * every analysis in `scripts/` reads through here: one walk, one parse, many
 * consumers. A detector that wants its own pass is a detector that has not been
 * written yet.
 *
 * What comes out is the tool call, not the conversation. Each call is paired
 * with its result — they arrive on different lines, matched by tool_use id — so
 * a consumer gets the one thing neither line carries alone: how long it took.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

/**
 * Every transcript under ~/.claude/projects, including the nested ones.
 *
 * Subagents and workflows write their own .jsonl two and three levels down —
 * half the corpus here — and work a subagent does is still your work. Reading
 * only the top level dropped 284 of 570 files the first time this was written.
 */
export function transcriptFiles(dir = path.join(claudeDir(), 'projects'), depth = 0) {
  const out = []
  if (depth > 6) return out
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...transcriptFiles(p, depth + 1))
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

/**
 * Prompt origins that mean a person put it there. `system` is Claude Code
 * talking to itself (compaction notices, injected context) and `sdk` is another
 * program driving the session; neither says anything about how you work.
 */
const HUMAN_PROMPT = new Set(['typed', 'queued', 'suggestion_accepted'])

/** The file a tool call is about, when it is about one. */
function pathOf(input) {
  if (!input || typeof input !== 'object') return null
  const v = input.file_path || input.notebook_path || input.path
  return typeof v === 'string' ? v : null
}

/** Result payloads are sometimes a string, sometimes a list of blocks. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => c?.text || '').join(' ')
  return ''
}

/**
 * Walk every transcript once.
 *
 * `onCall` receives a completed tool call — one that got its result back.
 * Unanswered calls (a session killed mid-flight) never fire, which is correct:
 * they have no duration and nothing to say.
 *
 * `onPrompt` receives each thing the person actually typed, so a detector can
 * ask what the work was for and not only what it did.
 *
 * Both are called in file order and, within a file, in line order — detectors
 * that care about sequence can rely on it.
 */
export async function scanTranscripts({
  since = 0,
  onCall = null,
  onPrompt = null,
  maxCommandChars = 4000,
  maxErrorChars = 600,
} = {}) {
  const files = transcriptFiles()
  const stats = { files: 0, lines: 0, calls: 0, prompts: 0, skippedOld: 0, unmatched: 0 }

  for (const file of files) {
    stats.files++
    const pending = new Map()
    let ordinal = 0
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })

    for await (const line of rl) {
      stats.lines++
      let o
      try { o = JSON.parse(line) } catch { continue }

      if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
        const at = Date.parse(o.timestamp || '')
        for (const b of o.message.content) {
          if (b?.type !== 'tool_use') continue
          pending.set(b.id, {
            tool: b.name,
            at,
            ordinal: ordinal++,
            sessionId: o.sessionId || null,
            cwd: o.cwd || null,
            gitBranch: o.gitBranch || null,
            file,
            command: typeof b.input?.command === 'string'
              ? b.input.command.slice(0, maxCommandChars) : null,
            path: pathOf(b.input),
            background: b.input?.run_in_background === true,
          })
        }
        continue
      }

      if (o.type !== 'user' || !Array.isArray(o.message?.content)) {
        // A prompt is a plain string body, never a list of blocks — and only
        // some of those came from a person. `promptSource` says which: without
        // that filter the top "thing you ask repeatedly" was the compaction
        // notice Claude Code writes to itself, 11 times across 10 sessions.
        if (onPrompt && o.type === 'user' && typeof o.message?.content === 'string'
            && !o.isMeta && !o.isSidechain && HUMAN_PROMPT.has(o.promptSource)) {
          const at = Date.parse(o.timestamp || '')
          if (at >= since) {
            stats.prompts++
            onPrompt({
              at, text: o.message.content, sessionId: o.sessionId || null,
              cwd: o.cwd || null, file, source: o.promptSource,
            })
          }
        }
        continue
      }

      const endAt = Date.parse(o.timestamp || '')
      for (const b of o.message.content) {
        if (b?.type !== 'tool_result' || !b.tool_use_id) continue
        const use = pending.get(b.tool_use_id)
        if (!use) { stats.unmatched++; continue }
        pending.delete(b.tool_use_id)
        if (!onCall) continue
        if (!Number.isFinite(use.at) || !Number.isFinite(endAt)) continue
        if (use.at < since) { stats.skippedOld++; continue }

        const isError = b.is_error === true
        stats.calls++
        onCall({
          ...use,
          endAt,
          gap: Math.max(0, (endAt - use.at) / 1000),
          isError,
          errorText: isError ? textOf(b.content).slice(0, maxErrorChars) : '',
        })
      }
    }
  }
  return stats
}

// ─── small statistics shared by every detector ──────────────────────────────

export function pct(arr, p) {
  if (!arr.length) return 0
  const a = [...arr].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(a.length * p))]
}

export function groupBy(arr, keyOf) {
  const m = new Map()
  for (const item of arr) {
    const k = keyOf(item)
    if (k === null || k === undefined) continue
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(item)
  }
  return m
}

/**
 * How long a kind of call takes when nobody is in the way: the p20 of its own
 * durations. Kinds seen fewer than `minSamples` times borrow their tool's.
 */
export function baselines(calls, keyOf, { minSamples = 5 } = {}) {
  const byKey = new Map()
  const byTool = new Map()
  for (const c of calls) {
    const k = keyOf(c)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(c.gap)
    if (!byTool.has(c.tool)) byTool.set(c.tool, [])
    byTool.get(c.tool).push(c.gap)
  }
  const out = new Map()
  for (const [k, gaps] of byKey) out.set(k, gaps.length >= minSamples ? pct(gaps, 0.2) : null)
  return {
    get(call) {
      const k = keyOf(call)
      const own = out.get(k)
      if (own !== null && own !== undefined) return own
      return pct(byTool.get(call.tool) || [0], 0.2)
    },
  }
}

/** Local YYYY-MM-DD, the unit a person means by "a day". */
export const dayKey = (ms) => new Date(ms).toLocaleDateString('sv-SE')
