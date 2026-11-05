/**
 * Reading the CLI's own sign-in state.
 *
 * The bug this guards is not a crash, it is a confident wrong answer. The
 * panel turns this into a red dot and a button, so anything it cannot actually
 * read has to come back as "unknown" and not as "logged out" — offering to
 * sign someone in over a working setup is the one failure worse than saying
 * nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../src/claude-auth.js'

const { parseStatus, isMissingBinary } = __test

test('a subscription login is reported with the identity behind it', () => {
  const status = parseStatus(JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'someone@example.com',
    orgName: 'Example Org',
    subscriptionType: 'team',
  }))

  assert.equal(status.state, 'in')
  assert.equal(status.email, 'someone@example.com')
  assert.equal(status.org, 'Example Org')
  assert.equal(status.plan, 'team')
})

test('a logged-out CLI is the one state that offers a sign-in', () => {
  assert.equal(parseStatus(JSON.stringify({ loggedIn: false })).state, 'out')
})

test('an API key is signed in, but not by a route signing in would change', () => {
  const status = parseStatus(JSON.stringify({ loggedIn: true, authMethod: 'apiKey' }))
  assert.equal(status.state, 'in')
  assert.equal(status.method, 'apiKey')
})

test('output that is not JSON is unknown, never logged out', () => {
  // What an older CLI without `auth status` gives you: usage text on stdout.
  assert.equal(parseStatus('Usage: claude auth [options]').state, 'unknown')
  assert.equal(parseStatus('').state, 'unknown')
})

test('a warning printed ahead of the JSON does not hide the answer', () => {
  // An expired token or an update notice can land on stdout before the
  // object. Treating that as unknown left the panel with no Sign in button.
  const noisy = 'OAuth token has expired\n' + JSON.stringify({ loggedIn: false, apiProvider: 'firstParty' })
  assert.equal(parseStatus(noisy).state, 'out')
})

test('unreadable output says what the CLI said', () => {
  assert.match(parseStatus('Something went wrong\nmore').message, /Something went wrong/)
})

test('a cloud provider is not a logged-out account', () => {
  // Bedrock and Vertex authenticate through AWS and GCP. Reporting `out` here
  // would put a Sign in button over a setup that works and cannot be fixed by
  // signing in to anything.
  const status = parseStatus(JSON.stringify({ loggedIn: false, apiProvider: 'bedrock' }))
  assert.equal(status.state, 'provider')
  assert.equal(status.provider, 'bedrock')

  // First-party is still a real logout, button and all.
  assert.equal(parseStatus(JSON.stringify({ loggedIn: false, apiProvider: 'firstParty' })).state, 'out')
})

test('a missing binary is recognised through a shell, not only through ENOENT', () => {
  // The Windows path spawns through cmd.exe because the binary is claude.cmd,
  // and a shell that exists always spawns fine — so ENOENT never arrives and
  // the install message would never be shown.
  assert.equal(isMissingBinary({ code: 'ENOENT' }), true)
  assert.equal(isMissingBinary({ code: 1, stderr: "'claude' is not recognized as an internal or external command" }), true)
  // A CLI that ran and failed is not a missing CLI.
  assert.equal(isMissingBinary({ code: 127 }), true)
  // A CLI that ran and failed is not a missing CLI — including one whose own
  // error message happens to contain the word "not found".
  assert.equal(isMissingBinary({ code: 1, stderr: 'Error: could not reach the server' }), false)
  assert.equal(isMissingBinary({ code: 1, stderr: 'Error: organization not found' }), false)
})

test('JSON without a sign-in field is unknown, never logged out', () => {
  // The trap: `!data.loggedIn` is true for a key that was never there, which
  // would turn every unrecognised CLI into a red dot over a working account.
  assert.equal(parseStatus(JSON.stringify({ configDirectory: '/home/x/.claude' })).state, 'unknown')
})
