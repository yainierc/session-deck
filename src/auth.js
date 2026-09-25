/**
 * auth.js — the one credential between the deck and everything else.
 *
 * The deck can launch a session with `bypassPermissions` in any folder on this
 * machine. That is arbitrary code execution behind an HTTP port, so the port
 * cannot be open. It was, and `--host 0.0.0.0` was documented as the way to
 * reach it from a phone: anyone on the same network could have driven it.
 *
 * One shared secret, held on this machine, presented by whoever wants in.
 * Three ways to present it, because three different callers need to:
 *
 *   ?token=...        pairing. Scanned off the QR, or the link the CLI prints.
 *   cookie            every request after that, sent by the browser itself.
 *   x-deck-token      non-browser callers, and the dev proxy.
 *
 * The cookie is what makes "token always" bearable: you pair once per device
 * and never see it again.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deckDir } from './platform.js'

const COOKIE = 'deck_token'

/** A year. The cookie is the pairing; re-scanning a QR monthly helps nobody. */
const COOKIE_MAX_AGE = 31_536_000

function file() {
  return path.join(deckDir(), 'auth.json')
}

/**
 * Read once and keep it. The token is consulted on every single request, and
 * going to disk that often to read 80 bytes that cannot change underneath us
 * would be silly — every writer below updates this too.
 */
let cached = null

function generate() {
  // 256 bits from the CSPRNG. base64url so it survives a URL, a QR code and a
  // cookie without escaping.
  return crypto.randomBytes(32).toString('base64url')
}

/** A stored PIN, or null if what is on disk is not one. */
function readPin(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.salt !== 'string' || typeof raw.hash !== 'string') return null
  if (!raw.salt || !raw.hash) return null
  return { salt: raw.salt, hash: raw.hash }
}

/** The whole credential record, minting one on first run. */
function load() {
  if (cached) return cached
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'))
    // A truncated or hand-edited token is not a token. Replacing it locks out
    // paired devices, which is the safe direction to fail in.
    if (typeof data.token === 'string' && data.token.length >= 32) {
      cached = { token: data.token, pin: readPin(data.pin) }
      return cached
    }
  } catch {}
  return save({ token: generate(), pin: null })
}

function save(record) {
  cached = record
  try {
    fs.mkdirSync(deckDir(), { recursive: true })
    const target = file()
    const body = JSON.stringify({ ...record, created: Date.now() }, null, 2) + '\n'
    fs.writeFileSync(target, body, { mode: 0o600 })
    // `mode` above only applies when writeFileSync creates the file. On every
    // write after the first it is silently ignored, so a file that was ever
    // world-readable would stay world-readable. chmod is the one that binds.
    fs.chmodSync(target, 0o600)
  } catch {
    // Persisting failed — a read-only home, a full disk. Keep it in memory so
    // this run still works; it just will not survive a restart.
  }
  return record
}

/** The current token, generating and persisting one on first run. */
export function token() {
  return load().token
}

/**
 * Mint a new token, invalidating every device paired against the old one.
 *
 * The PIN goes with it. Re-keying is what you do when a device is lost, and a
 * lost device knew the PIN as well as the cookie — leaving the PIN standing
 * would sign that device out of one credential while leaving it the other,
 * which is not a revocation at all.
 *
 * Returns the new token rather than nothing, because the caller usually wants
 * to re-pair itself in the same breath — see the rotate endpoint, which hands
 * the new cookie straight back to the browser that asked.
 */
export function rotate() {
  return save({ token: generate(), pin: null }).token
}

/**
 * Compare in constant time.
 *
 * `===` on a secret leaks how many leading characters were right, one failed
 * request at a time. The length check before it is not a leak worth caring
 * about: every token this file mints is the same length.
 */
function same(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/*
 * ---- the unlock PIN ----
 *
 * A second way to present the same key, for the case the QR does not cover:
 * a phone that was never paired, or was re-imaged, with nobody at the laptop
 * to show it a code.
 *
 * It is worth being clear about what this costs. The token is 256 bits and
 * cannot be guessed. A six-digit PIN is a million guesses, and the port it
 * opens runs commands on this machine. So the PIN is never the thing standing
 * between an attacker and the deck on its own — the throttle below is, and it
 * is the part to be suspicious of if any of this is ever changed.
 *
 * Opt-in, and off until you set one.
 */

/** Enough digits that the throttle has something to work with. */
export const PIN_MIN = 6

/**
 * scrypt, not a plain hash. The stored value is offline-crackable by anyone
 * who reads auth.json, and against six digits a fast hash is no protection at
 * all — these parameters put every guess at tens of milliseconds instead of
 * nanoseconds. They are node's own defaults except for the cost.
 */
const SCRYPT = { N: 16384, r: 8, p: 1 }
const KEYLEN = 32

function derive(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, KEYLEN, SCRYPT, (err, key) => {
      if (err) reject(err)
      else resolve(key.toString('base64url'))
    })
  })
}

/** Is there a PIN to try at all? Drives whether the form is even offered. */
export function hasPin() {
  return Boolean(load().pin)
}

/** Why this is not an acceptable PIN, or null if it is. */
export function pinProblem(pin) {
  const value = String(pin ?? '')
  if (!/^[0-9]+$/.test(value)) return 'The PIN must be digits only'
  if (value.length < PIN_MIN) return `The PIN must be at least ${PIN_MIN} digits`
  return null
}

export async function setPin(pin) {
  const problem = pinProblem(pin)
  if (problem) return { ok: false, error: problem }
  // Per-PIN salt: two decks with the same PIN must not have the same hash,
  // and a rainbow table for six digits is otherwise trivial to build once.
  const salt = crypto.randomBytes(16).toString('base64url')
  save({ token: load().token, pin: { salt, hash: await derive(pin, salt) } })
  clearThrottle()
  return { ok: true }
}

export function clearPin() {
  save({ token: load().token, pin: null })
  clearThrottle()
  return { ok: true }
}

/*
 * Attempt throttling.
 *
 * Counted globally rather than per-IP. Per-IP throttling is bypassed by
 * anyone who can change address, which is exactly the caller this is meant to
 * stop. The usual objection to a global lock — that a stranger can lock the
 * owner out — does not apply here: the owner is sitting at the machine, and
 * the pairing link and the QR in Settings never stop working. Being locked
 * out of the PIN is never being locked out of the deck.
 */
const ATTEMPT_LIMIT = 5
const LOCK_BASE_MS = 60_000
const LOCK_MAX_MS = 3_600_000

let failures = 0
let lockouts = 0
let lockedUntil = 0

function clearThrottle() {
  failures = 0
  lockouts = 0
  lockedUntil = 0
}

/** How long the door stays shut, doubling each time it is shut again. */
function lockDuration() {
  return Math.min(LOCK_BASE_MS * 2 ** lockouts, LOCK_MAX_MS)
}

/** Milliseconds until the PIN can be tried again, or 0 if it can be now. */
export function lockedFor() {
  return Math.max(0, lockedUntil - Date.now())
}

/**
 * Try a PIN.
 *
 * The lock is checked before any work is done, so a flood of guesses cannot
 * turn the deliberately-expensive hash into a way to exhaust the machine.
 */
export async function verifyPin(pin) {
  const wait = lockedFor()
  if (wait > 0) return { ok: false, lockedFor: wait }

  const record = load().pin
  // Shape-check before hashing: a non-numeric PIN can never match one this
  // module stored, and is not worth a scrypt call.
  if (!record || !/^[0-9]+$/.test(String(pin ?? ''))) return fail()

  let attempt
  try {
    attempt = await derive(pin, record.salt)
  } catch {
    // The hash could not be computed. Not the caller's fault and not a wrong
    // answer, so it does not count against them.
    return { ok: false }
  }

  if (!same(attempt, record.hash)) return fail()

  clearThrottle()
  return { ok: true, token: load().token }
}

function fail() {
  failures += 1
  if (failures >= ATTEMPT_LIMIT) {
    lockedUntil = Date.now() + lockDuration()
    lockouts += 1
    failures = 0
    return { ok: false, lockedFor: lockedFor() }
  }
  return { ok: false, attemptsLeft: ATTEMPT_LIMIT - failures }
}

function fromCookie(req) {
  const header = req.headers?.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== COOKIE) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function fromHeader(req) {
  const direct = req.headers?.['x-deck-token']
  if (direct) return String(direct)
  const bearer = req.headers?.authorization
  if (bearer && /^bearer /i.test(bearer)) return bearer.slice(7).trim()
  return null
}

/** Whatever credential this request carries, in order of explicitness. */
function presented(req, url) {
  return url?.searchParams?.get('token') || fromHeader(req) || fromCookie(req) || null
}

function hostnameOf(value) {
  if (!value) return null
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return null
  }
}

/**
 * Is this request coming from a page the deck actually served?
 *
 * A cookie is attached by the browser to requests the page never consciously
 * made, so any website you visit while the deck is running could otherwise
 * drive it — the CSRF shape. `SameSite=Strict` on the cookie is the first
 * defence and this is the second, because WebSockets ignore the same-origin
 * policy entirely and arrive with a cookie and an honest `Origin` header.
 *
 * The rule is that the origin's hostname must match the host the request was
 * addressed to. That allows `localhost:5317` (the Vite dev server, proxying to
 * `localhost:4317`) while refusing `https://evil.example`.
 *
 * A missing `Origin` is allowed: curl, the CLI's own health check and every
 * non-browser client omit it, and none of them is the threat. The threat is a
 * browser, and browsers always send it on exactly the requests that matter.
 *
 * DNS rebinding — pointing a name the browser trusts at 127.0.0.1 so that
 * origin and host match — defeats this check and is defeated by the cookie
 * instead: cookies are scoped to the host that set them, so a page on
 * `evil.example` never holds the one issued for `localhost`.
 */
export function originAllowed(req) {
  const origin = req.headers?.origin
  if (!origin || origin === 'null') return true
  let source
  try {
    source = new URL(origin).hostname
  } catch {
    return false
  }
  const target = hostnameOf(req.headers?.host)
  return Boolean(target) && source === target
}

/**
 * The gate. `{ ok }` plus why not, so the caller can answer a browser with a
 * page and an API client with JSON.
 *
 * `paired` says the credential arrived in the URL, which is the signal to set
 * the cookie and get it out of the address bar.
 */
export function authorize(req, url) {
  if (!originAllowed(req)) return { ok: false, reason: 'origin' }
  const supplied = presented(req, url)
  if (!supplied) return { ok: false, reason: 'missing' }
  if (!same(supplied, token())) return { ok: false, reason: 'token' }
  return { ok: true, paired: Boolean(url?.searchParams?.get('token')) }
}

/**
 * The pairing cookie.
 *
 * `HttpOnly` keeps it away from scripts, so an XSS in the panel cannot read
 * the token and mail it somewhere. `SameSite=Strict` is the CSRF defence.
 *
 * Deliberately not `Secure`: the deck serves plain HTTP on a local network by
 * definition, and a `Secure` cookie over HTTP is simply never stored — the
 * flag would not harden anything, it would break pairing outright.
 */
export function cookieHeader(value) {
  return [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ].join('; ')
}

/** The link that pairs a device: this deck, this token. */
export function pairingUrl(origin) {
  return `${origin}/?token=${token()}`
}

/**
 * The address another device on this network can actually dial.
 *
 * `0.0.0.0` means "every interface", which is not something anybody can type
 * into a phone, and a QR code carrying it would be a QR code that goes
 * nowhere. The first non-internal IPv4 is the one a device on the same network
 * will reach this machine on.
 *
 * Returns null when there is no such address — on an unplugged laptop, or when
 * the deck is bound to loopback and nothing outside could arrive anyway.
 */
export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return null
}
