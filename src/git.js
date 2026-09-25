/**
 * git.js — the one way this deck runs git.
 *
 * Kept apart from any single caller because the rule it encodes has to hold
 * everywhere: never through a shell. Branch names and paths arrive from the
 * browser, and `execFile` with an argument array has no injection surface for
 * them to exploit — a branch called `; rm -rf ~` is just a branch that does
 * not exist.
 *
 * Failure is returned, never thrown. Every caller here is answering a question
 * for a panel, and "git could not tell us" is a legitimate answer that should
 * degrade one line of a view rather than take down a request.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Run one git command in a directory.
 *
 * The default timeout suits local plumbing. Anything that touches the network
 * has to pass its own, because the ten seconds that is generous for
 * `rev-parse` is nowhere near enough for a fetch over a phone tether.
 */
export async function git(cwd, args, timeout = 10_000) {
  try {
    const { stdout } = await run('git', args, { cwd, timeout, windowsHide: true })
    return { ok: true, out: stdout.trim() }
  } catch (err) {
    return { ok: false, error: err?.stderr?.trim() || err?.message || 'git failed' }
  }
}
