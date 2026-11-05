/**
 * The gate, tested from both sides.
 *
 * These are the first tests in the repository and they are on this file rather
 * than a more interesting one for a simple reason: everything else here fails
 * loudly and locally — a wrong worktree flag is visible in the panel. A hole in
 * this file is invisible until somebody else finds it.
 *
 *   node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Point the deck at a scratch directory before anything reads the real one.
// `deckDir()` resolves this on every call, so setting it here is enough.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-auth-'))
process.env.SESSION_DECK_DIR = SCRATCH

const auth = await import('../src/auth.js')
const { createServer } = await import('../src/server.js')

/** A request as the server sees it: headers, and the URL already parsed. */
function request({ headers = {}, target = '/api/state' } = {}) {
  return [{ headers }, new URL(target, 'http://localhost')]
}

/**
 * The key file is as private as the platform allows, and the deck's own
 * account of that matches the file system.
 *
 * Where there are permission bits the answer is 0600 and nothing looser.
 * Windows has none — chmod there flips the read-only attribute and returns
 * happily — so the file stays readable by other accounts and the thing worth
 * asserting is that `keyIsPrivate()` reports it, because a deck that believes
 * it locked a file it did not is how a shared machine gets surprised.
 */
function assertKeyFilePrivacy(file) {
  const mode = fs.statSync(file).mode & 0o777
  const openToOthers = (mode & 0o077) !== 0
  assert.equal(
    auth.keyIsPrivate(), !openToOthers,
    'the deck and the file system disagree about whether the key is private',
  )
  if (process.platform !== 'win32') {
    assert.equal(mode, 0o600, 'the key file is readable by other accounts')
  }
}

test('a token is minted, persisted, and kept private', () => {
  const value = auth.token()
  assert.ok(value.length >= 32, 'token is too short to be worth having')
  assert.equal(auth.token(), value, 'the token changes between calls')

  const file = path.join(SCRATCH, 'auth.json')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, value)

  // 0600. A token every account on a shared machine can read is not a token.
  //
  // Windows has no permission bits to set: chmod there flips the read-only
  // attribute and reports success. So what is asserted is not "the bits are
  // 0600 everywhere" — which is false — but that the deck's own account of
  // itself matches the file system. A deck that thinks it locked a file it
  // did not is the failure worth catching; the exposure is reported at start.
  assertKeyFilePrivacy(file)
})

test('rotating invalidates the old token and rewrites it privately', () => {
  const before = auth.token()
  const after = auth.rotate()

  assert.notEqual(after, before)
  assert.equal(auth.token(), after, 'the cached token survived a rotation')
  assert.ok(!auth.authorize(...request({ headers: { 'x-deck-token': before } })).ok)

  // The mode argument to writeFileSync is ignored when the file already
  // exists, so this asserts the chmod that covers for it.
  assertKeyFilePrivacy(path.join(SCRATCH, 'auth.json'))
})

test('a key file left readable is reported, on the start that only reads it', async (t) => {
  // The bits are the point, so there is nothing to assert where they do not
  // exist. Windows is covered by the deck agreeing with the file system in
  // the two tests above.
  if (process.platform === 'win32') return t.skip('no permission bits on Windows')

  // A deck that has already been started once: the key is on disk, and this
  // run will read it rather than write it. The file is loosened the way a
  // careless `cp`, an unpacked backup or an older build would have left it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-auth-loose-'))
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ token: 'x'.repeat(40), pin: null }))
  fs.chmodSync(path.join(dir, 'auth.json'), 0o644)

  // A second copy of the module, with its own cache, pointed at that
  // directory: the first one has already cached a key from its own scratch.
  const before = process.env.SESSION_DECK_DIR
  process.env.SESSION_DECK_DIR = dir
  try {
    const fresh = await import('../src/auth.js?loose')
    assert.equal(fresh.token(), 'x'.repeat(40), 'the existing key was read, not replaced')
    assert.equal(fresh.keyIsPrivate(), false, 'a world-readable key file was reported as private')
  } finally {
    process.env.SESSION_DECK_DIR = before
  }
})

test('a request with no credential is refused', () => {
  const result = auth.authorize(...request())
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing')
})

test('a wrong credential is refused', () => {
  const result = auth.authorize(...request({ headers: { 'x-deck-token': 'not-the-token' } }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'token')
})

test('the token is accepted from header, query and cookie alike', () => {
  const value = auth.token()

  assert.ok(auth.authorize(...request({ headers: { 'x-deck-token': value } })).ok)
  assert.ok(auth.authorize(...request({ headers: { authorization: `Bearer ${value}` } })).ok)
  assert.ok(auth.authorize(...request({ target: `/api/state?token=${value}` })).ok)
  assert.ok(auth.authorize(...request({ headers: { cookie: `deck_token=${value}` } })).ok)

  // Only the URL form counts as pairing: the others are already-paired clients
  // and re-issuing a cookie for them would be noise.
  assert.equal(auth.authorize(...request({ target: `/?token=${value}` })).paired, true)
  assert.equal(auth.authorize(...request({ headers: { 'x-deck-token': value } })).paired, false)
})

test('the cookie is found among other cookies', () => {
  const value = auth.token()
  const cookie = `theme=dark; deck_token=${value}; other=1`
  assert.ok(auth.authorize(...request({ headers: { cookie } })).ok)
})

test('a valid token from a foreign origin is still refused', () => {
  // The CSRF and cross-site-WebSocket case: the browser attaches the cookie
  // itself, so holding a valid credential proves nothing about who asked.
  const headers = {
    'x-deck-token': auth.token(),
    origin: 'https://evil.example',
    host: '127.0.0.1:4317',
  }
  const result = auth.authorize(...request({ headers }))
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'origin')
})

test('the dev server origin is allowed across ports', () => {
  // Vite serves the UI on 5317 and proxies to 4317. Same host, different port:
  // a different origin, but not a foreign one.
  const headers = {
    'x-deck-token': auth.token(),
    origin: 'http://localhost:5317',
    host: 'localhost:4317',
  }
  assert.ok(auth.authorize(...request({ headers })).ok)
})

test('a request with no origin is allowed', () => {
  // curl, the CLI, any non-browser client. The threat model is a browser, and
  // browsers always send Origin on the requests that matter.
  const headers = { 'x-deck-token': auth.token(), host: '127.0.0.1:4317' }
  assert.ok(auth.authorize(...request({ headers })).ok)
})

test('the pairing cookie cannot be read by scripts or sent cross-site', () => {
  const header = auth.cookieHeader(auth.token())
  assert.match(header, /HttpOnly/)
  assert.match(header, /SameSite=Strict/)
  // Never Secure: the deck is plain HTTP on a local network, and a Secure
  // cookie over HTTP is not stored at all.
  assert.doesNotMatch(header, /Secure/)
})

// ---- the server itself ----

test('the server refuses and admits over real HTTP', async (t) => {
  const { server, close } = createServer({ notifications: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { await close() })

  const anonymous = await fetch(`${base}/api/state`)
  assert.equal(anonymous.status, 401)

  // A person who typed the address gets an explanation, not the word
  // "Unauthorized" on a white page.
  const page = await fetch(`${base}/`)
  assert.equal(page.status, 401)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(await page.text(), /locked/i)

  const allowed = await fetch(`${base}/api/state`, {
    headers: { 'x-deck-token': auth.token() },
  })
  assert.equal(allowed.status, 200)

  // The header that used to let any page on the internet read this.
  assert.equal(allowed.headers.get('access-control-allow-origin'), null)

  // Pairing trades the URL token for a cookie and sends the token back out of
  // the address bar.
  const paired = await fetch(`${base}/?token=${auth.token()}`, { redirect: 'manual' })
  assert.equal(paired.status, 302)
  assert.equal(paired.headers.get('location'), '/')
  assert.match(paired.headers.get('set-cookie'), /deck_token=/)
})

test('the control socket is guarded as hard as the API', async (t) => {
  const { WebSocket } = await import('ws')
  const { server, close } = createServer({ notifications: false })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `ws://127.0.0.1:${server.address().port}/ws`
  t.after(async () => { await close() })

  /** Resolve with 'open' or the HTTP status the handshake was refused with. */
  function connect(options) {
    return new Promise((resolve) => {
      const socket = new WebSocket(base, options)
      socket.on('open', () => { socket.close(); resolve('open') })
      socket.on('unexpected-response', (_, res) => resolve(res.statusCode))
      socket.on('error', () => resolve('error'))
    })
  }

  // `launch` lives on this socket, so an unauthenticated open would be
  // arbitrary code execution on this machine.
  assert.equal(await connect(), 401)
  assert.equal(await connect({ headers: { 'x-deck-token': 'wrong' } }), 401)

  // The one that matters most: a valid cookie, a foreign page. Browsers do not
  // apply the same-origin policy to WebSockets, so this arrives looking
  // authentic and must still be refused.
  const crossSite = await connect({
    headers: { cookie: `deck_token=${auth.token()}`, origin: 'https://evil.example' },
  })
  assert.equal(crossSite, 401)

  assert.equal(await connect({ headers: { 'x-deck-token': auth.token() } }), 'open')
  assert.equal(await connect({ headers: { cookie: `deck_token=${auth.token()}` } }), 'open')
})

/*
 * ---- the unlock PIN ----
 *
 * The PIN is the one credential here that can be guessed, so these tests are
 * less about it working and more about the throttle that makes it survivable.
 */

test('a PIN must be digits, and enough of them', async () => {
  assert.equal(auth.pinProblem('123456'), null)
  assert.ok(auth.pinProblem('12345'), 'five digits is under the floor')
  assert.ok(auth.pinProblem('abcdefgh'), 'letters are not a PIN here')
  assert.ok(auth.pinProblem('12345a'), 'nor are they with digits around them')
  assert.ok(auth.pinProblem(''), 'nor is nothing at all')

  const rejected = await auth.setPin('12345')
  assert.equal(rejected.ok, false)
  assert.equal(auth.hasPin(), false, 'a rejected PIN must not be stored')
})

test('a PIN is stored hashed and salted, never in the clear', async () => {
  await auth.setPin('314159')
  const raw = fs.readFileSync(path.join(SCRATCH, 'auth.json'), 'utf8')
  assert.ok(!raw.includes('314159'), 'the PIN itself must not be on disk')

  const stored = JSON.parse(raw).pin
  assert.ok(stored.salt && stored.hash)

  // Same PIN, set again: a fresh salt, so the hash cannot be recognised by
  // anyone who has seen it before.
  const first = stored.hash
  await auth.setPin('314159')
  const second = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'auth.json'), 'utf8')).pin.hash
  assert.notEqual(first, second)

  auth.clearPin()
  assert.equal(auth.hasPin(), false)
})

test('the right PIN hands back the token, a wrong one hands back nothing', async () => {
  await auth.setPin('271828')

  const wrong = await auth.verifyPin('271829')
  assert.equal(wrong.ok, false)
  assert.equal(wrong.token, undefined, 'a failed attempt must never leak the key')

  const right = await auth.verifyPin('271828')
  assert.equal(right.ok, true)
  assert.equal(right.token, auth.token(), 'the PIN presents the key, it is not a second one')

  auth.clearPin()
})

test('wrong PINs lock the door, and the lock outlasts the guessing', async () => {
  await auth.setPin('161803')

  // Four wrong answers warn; the fifth shuts it.
  for (let i = 0; i < 4; i += 1) {
    const result = await auth.verifyPin('000000')
    assert.equal(result.ok, false)
    assert.equal(result.lockedFor, undefined, `attempt ${i + 1} should not lock yet`)
  }

  const locked = await auth.verifyPin('000000')
  assert.ok(locked.lockedFor > 0, 'the fifth wrong PIN locks')
  assert.ok(auth.lockedFor() > 0)

  // The point of the lock: even the correct PIN waits it out. Without this it
  // would only slow down someone who guesses wrong to the very end.
  const correct = await auth.verifyPin('161803')
  assert.equal(correct.ok, false, 'locked means locked, right answer or not')
  assert.equal(correct.token, undefined)

  auth.clearPin()
  assert.equal(auth.lockedFor(), 0, 'clearing the PIN resets the throttle')
})

test('revoking the key clears the PIN with it', async () => {
  await auth.setPin('123456')
  assert.equal(auth.hasPin(), true)

  auth.rotate()

  // A lost device knew both. Re-keying while leaving the PIN would sign it out
  // of one credential and leave it holding the other.
  assert.equal(auth.hasPin(), false)
  const raw = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'auth.json'), 'utf8'))
  assert.equal(raw.pin, null)
})

test('an unset PIN matches nothing, including an empty guess', async () => {
  auth.clearPin()
  assert.equal((await auth.verifyPin('')).ok, false)
  assert.equal((await auth.verifyPin('123456')).ok, false)
  assert.equal((await auth.verifyPin(null)).ok, false)
})
