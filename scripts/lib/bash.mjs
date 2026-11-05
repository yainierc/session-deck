/**
 * bash.mjs — reading a shell command well enough to count it.
 *
 * Not a shell parser. It answers three questions the analyses actually ask:
 * which separate commands are in this line, what is this command *for*, and
 * what does "the same command again" mean. Everything here was corrected by
 * being wrong on real data at least once; the comments say how.
 */
import path from 'node:path'

/**
 * Drop heredoc bodies before anything tries to read them as shell.
 *
 * `python3 - <<'PY' … PY` carries a Python program inside a bash string, and a
 * splitter that does not know that produces "commands" called `import`, `#` and
 * `assert` — four of the top twenty offenders on the first permission run were
 * lines of somebody's Python. The body is data; only the line that launches it
 * is shell.
 */
export function stripHeredocs(cmd) {
  if (!cmd.includes('<<')) return cmd
  const lines = cmd.split('\n')
  const out = []
  let tag = null
  for (const line of lines) {
    if (tag) {
      if (line.trim() === tag) tag = null
      continue
    }
    out.push(line)
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (m) tag = m[2]
  }
  return out.join('\n')
}

/**
 * Split a command line on the operators that chain separate commands, ignoring
 * any that sit inside quotes. Claude Code requires every segment to be allowed,
 * so `grep x | head` needs both halves covered — which is most of why an
 * allowlist feels like it never sticks.
 */
export function segments(raw) {
  const cmd = stripHeredocs(raw)
  const out = []
  let buf = ''
  let quote = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      buf += c
      if (c === quote && cmd[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; buf += c; continue }
    const two = cmd.slice(i, i + 2)
    if (two === '&&' || two === '||') { out.push(buf); buf = ''; i++; continue }
    if (c === ';' || c === '|' || c === '\n') { out.push(buf); buf = ''; continue }
    buf += c
  }
  out.push(buf)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Binaries whose first argument is really part of the command's identity. */
const SUBCOMMANDED = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'gh', 'az', 'docker', 'brew', 'claude',
  'kubectl', 'cargo', 'go', 'pip', 'pip3', 'terraform', 'bicep', 'dotnet', 'systemctl',
])

/**
 * A stable name for "the same command again" — the binary, plus its subcommand
 * when the binary has those. Arguments are dropped: `git log -5 src/a.js` and
 * `git log --oneline` are one habit, not two.
 */
export function shapeOfSegment(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean)
  let i = 0
  // env assignments and sudo prefix the real command
  while (tokens[i] && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++
  if (tokens[i] === 'sudo') i++
  if (!tokens[i]) return segment.slice(0, 40)
  const bin = path.basename(tokens[i])
  const next = tokens[i + 1]
  if (SUBCOMMANDED.has(bin) && next && !next.startsWith('-')) return bin + ' ' + next
  return bin
}

/** Scaffolding: moving around and setting variables is never the point. */
export function isScaffold(segment) {
  return /^cd(\s|$)/.test(segment)
    || /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment.split(/\s+/)[0] || '')
}

/**
 * What the command is for. A `cd` is never the point — `cd repo && git push` is
 * a push, and naming it `cd` put one meaningless bar on top of the first chart,
 * hiding the twenty real ones underneath.
 */
export function shapeOf(cmd) {
  const segs = segments(cmd)
  return shapeOfSegment(segs.find((s) => !isScaffold(s)) || segs[0] || cmd)
}

/** Shell syntax that looks like a command to the splitter but is not one. */
export const SHELL_KEYWORDS = new Set([
  'for', 'do', 'done', 'until', 'while', 'if', 'then', 'elif', 'else', 'fi',
  'case', 'esac', 'select', 'function', 'trap', 'eval', 'exec', 'source',
])

/** Work that only reads. Used as a control group, and to judge what is safe. */
export const READ_ONLY = new Set([
  'grep', 'rg', 'sed', 'awk', 'cat', 'ls', 'head', 'tail', 'wc', 'find', 'file',
  'stat', 'du', 'df', 'pwd', 'which', 'echo', 'date', 'sort', 'uniq', 'cut', 'tr',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git rev-parse',
])

/**
 * The identity of "this exact command again".
 *
 * Whitespace is collapsed, because the same command pasted twice differs by
 * indentation. The heredoc body is KEPT, and that is the whole point: an
 * earlier version stripped it, which made every `python3 - <<'PY' … PY` in the
 * corpus look like the same command and reported 264 unrelated Python scripts
 * as one habit repeated 264 times. The body is what distinguishes them.
 */
export function commandKey(cmd) {
  return String(cmd).replace(/\s+/g, ' ').trim()
}

/** The same command, cut down to something readable in a list. */
export function literalOf(cmd, { max = 220 } = {}) {
  return commandKey(cmd).slice(0, max)
}

/**
 * The command with the bits that only decide how much output you see removed.
 *
 * `node scripts/test-hooks.mjs 2>&1 | tail -3` and the same line with `tail -20`
 * are one habit run twice, not two commands — but by exact identity they split,
 * and the first sweep reported the same test run as five separate findings
 * because of it. Grouping by family puts them back together and makes the count
 * say what a person would say: "I run this constantly."
 */
export function commandFamily(cmd) {
  return commandKey(cmd)
    .replace(/\s*2>&1/g, '')
    .replace(/\s*\|\s*(tail|head)\s+-n?\s*\d+\s*$/i, '')
    .trim()
}
