/**
 * claude-auth.js — whether the deck can start a session at all.
 *
 * Every other identity in this panel costs you a feature. GitHub lapsing costs
 * you the pull request queue; an Azure DevOps org lapsing costs you one
 * project's queue. This one costs you the product: the deck does not talk to
 * the API itself, it drives the `claude` binary through the agent SDK, so a
 * logged-out CLI means every session you launch dies on arrival — and it dies
 * inside a subprocess whose OAuth prompt nobody will ever see, because the
 * panel is a web page and the prompt wants a terminal.
 *
 * That was the gap: the Accounts screen listed four things you could sign into
 * and omitted the one that had to be signed in for any of it to matter. It was
 * also the one with no route back, since `gh auth login` had a button and the
 * thing the button existed to serve did not.
 *
 * The check is deliberately the CLI's own answer rather than a look at where
 * credentials live. Those move — this machine keeps them in the macOS Keychain
 * and has no `~/.claude/.credentials.json` at all, `~/.claude.json` keeps an
 * `oauthAccount` block that outlives a logout, and an API key in the
 * environment beats both. Asking `claude auth status` gets the resolution
 * order from the only thing entitled to know it.
 *
 * It also answers as the deck, which is the point: `query()` spawns the binary
 * as a child of this process, so a credential it can see here is the one the
 * sessions will get, environment variables included.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { IS_WINDOWS } from './platform.js'

const run = promisify(execFile)

/** Who you are moves slowly, and this runs on a panel people leave open. */
const TTL_MS = 10 * 60_000

let cache = null

/**
 * Bumped whenever the answer is deliberately forgotten, so a lookup that was
 * already in flight cannot write its stale result back afterwards.
 *
 * Without it the ordering is: page asks -> user clicks Sign in -> cache
 * cleared -> the earlier lookup lands and restores "logged out" with a fresh
 * timestamp, buying it another ten minutes across the sign-in it was meant to
 * be invalidated by.
 */
let generation = 0

/** The first line of it, since this ends up in a narrow column in the panel. */
function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || null
}

/**
 * What `claude auth status` says, normalised into the shape the panel renders.
 *
 * Four outcomes, not two, and the difference between them decides whether a
 * sign-in button appears at all:
 *
 *   - `missing`  — the CLI is not on PATH. Nothing to sign into; install first.
 *   - `out`      — installed and logged out. This is the one with a button.
 *   - `in`       — signed in, and the identity is worth naming: people run a
 *                  personal account next to a work one and the deck inherits
 *                  whichever the terminal had.
 *   - `unknown`  — it answered something this does not understand, which an
 *                  older CLI without `auth status` will do. Unknown is not
 *                  "logged out": offering to fix a problem nobody established
 *                  is how a panel talks someone into breaking a working setup.
 */
function parseStatus(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { state: 'unknown', message: 'The CLI did not answer in a form this understands' }
  }

  if (typeof data?.loggedIn !== 'boolean') {
    return { state: 'unknown', message: 'This version of the CLI does not report a sign-in state' }
  }

  const provider = data.apiProvider || null

  if (!data.loggedIn) {
    // Bedrock and Vertex authenticate through the cloud provider's own
    // credentials, so "not signed in to Anthropic" is not a fault there and
    // `claude auth login` is not the remedy. Sending someone to a subscription
    // login over a working AWS setup is the same mistake as calling `unknown`
    // a logout, so it gets its own state rather than a button.
    if (provider && provider !== 'firstParty') {
      return { state: 'provider', provider, message: `Credentials come from ${provider}, not from a sign-in` }
    }
    return { state: 'out', provider }
  }

  return {
    state: 'in',
    email: data.email || null,
    org: data.orgName || null,
    // `claude.ai` is a subscription login, `apiKey` is a key in the
    // environment. They fail differently and are worth telling apart: a key
    // that expires cannot be fixed by signing in.
    method: data.authMethod || null,
    provider: data.apiProvider || null,
    plan: data.subscriptionType || null,
  }
}

/**
 * Is this "the binary is not there", as opposed to "the binary said no"?
 *
 * ENOENT answers it everywhere the command is spawned directly. On Windows it
 * cannot: `claude.cmd` only starts through a shell, and a shell always exists,
 * so a missing binary comes back as cmd.exe exiting 1 or 127 with `'claude' is
 * not recognized` on stderr. Without this the whole Windows install path
 * degrades to "unknown" and the one actionable message — install it — is the
 * one the panel never shows.
 */
function isMissingBinary(err) {
  if (err?.code === 'ENOENT') return true

  // 127 is every shell's "command not found", and cmd.exe says it in words.
  // Both phrasings are matched exactly rather than loosely: `/not found/`
  // alone would swallow a CLI that ran perfectly well and reported something
  // like "organization not found", turning a real answer into "install this".
  if (err?.code === 127) return true
  return /is not recognized as|command not found/i.test(String(err?.stderr || err?.message || ''))
}

/**
 * Ask the CLI who it is.
 *
 * `auth status` is read-only and answers in JSON by default, so this never
 * needs to touch the keychain itself — which it must not, since reading
 * someone's credential to display a green dot is a worse trade than showing no
 * dot.
 *
 * A non-zero exit is not treated as failure on its own. Some versions report
 * "logged out" by exiting non-zero while still printing the JSON, so the
 * output is parsed either way and only a genuinely empty answer degrades.
 */
export async function claudeIdentity({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < TTL_MS) return cache.value

  const asked = generation
  const value = await (async () => {
    try {
      const { stdout } = await run('claude', ['auth', 'status', '--json'], {
        timeout: 10_000,
        windowsHide: true,
        // On Windows the binary npm installs is claude.cmd, which only starts
        // through the shell — the same trap spawnClaude() documents.
        shell: IS_WINDOWS,
      })
      return { tool: true, ...parseStatus(stdout) }
    } catch (err) {
      // execFile rejects on a non-zero exit too, and the payload is still on
      // the error. Prefer it over the exit code.
      const stdout = String(err?.stdout || '').trim()
      if (stdout) return { tool: true, ...parseStatus(stdout) }

      if (isMissingBinary(err)) {
        return { tool: false, state: 'missing', message: 'The claude CLI is not on PATH' }
      }
      // Whatever execFile put in here is a multi-line "Command failed: ..."
      // with the process's stderr glued on, and it lands in a narrow column.
      return { tool: true, state: 'unknown', message: firstLine(err?.message) || 'The CLI did not answer' }
    }
  })()

  // Only the signed-in answer is worth keeping. The other three are the states
  // someone is actively in the middle of changing — they cost a third of a
  // second to re-establish, and holding one for ten minutes means showing a
  // red dot and "every session will fail" over an account that now works.
  // That is this module's worst failure, and a TTL is not worth paying it for.
  if (value.state === 'in' && asked === generation) cache = { at: Date.now(), value }
  return value
}

/** Forget the cached answer, for the moment a sign-in is known to have happened. */
export function forgetClaudeIdentity() {
  cache = null
  generation += 1
}

export const __test = { parseStatus, isMissingBinary }
