#!/usr/bin/env node
/**
 * cli.js — entry point. `session-deck` starts the server and opens the
 * browser. Same command on Mac, Windows and Linux.
 */
import qrcode from 'qrcode-terminal'
import { createServer } from './server.js'
import { openBrowser, checkInstall, IS_WINDOWS } from './platform.js'
import * as auth from './auth.js'

const HELP = `
session-deck — one panel for every Claude Code session you have running

  session-deck [options]

Options:
  -p, --port <n>    Port to listen on (default 4317)
      --host <h>    Interface to bind (default 127.0.0.1).
                    Use 0.0.0.0 to reach it from your phone on the local network.
      --public-url <u>  Where another device reaches this deck, when something
                    in front of it is doing the listening -- a tunnel, a
                    reverse proxy, tailscale serve. Only then can a QR be
                    drawn. Example: http://my-machine:4317
      --no-open     Do not open the browser on start
      --no-notify   Do not send desktop notifications
  -h, --help        This help
`

function parseArgs(argv) {
  const opts = { port: 4317, host: '127.0.0.1', open: true, notifications: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') opts.help = true
    else if (arg === '-p' || arg === '--port') opts.port = Number(argv[++i])
    else if (arg.startsWith('--port=')) opts.port = Number(arg.split('=')[1])
    else if (arg === '--host') opts.host = argv[++i]
    else if (arg.startsWith('--host=')) opts.host = arg.split('=')[1]
    else if (arg === '--public-url') opts.publicUrl = argv[++i]
    else if (arg.startsWith('--public-url=')) opts.publicUrl = arg.slice('--public-url='.length)
    else if (arg === '--no-open') opts.open = false
    else if (arg === '--no-notify') opts.notifications = false
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

if (opts.help) {
  console.log(HELP)
  process.exit(0)
}

if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
  console.error(`Invalid port: ${opts.port}`)
  process.exit(1)
}

// Checked here rather than where it is used: this ends up inside a QR that
// somebody points a camera at, and a typo found at that moment looks like a
// broken deck rather than a bad flag.
if (opts.publicUrl) {
  let parsed
  try {
    parsed = new URL(opts.publicUrl)
  } catch {
    console.error(`Invalid --public-url: ${opts.publicUrl}`)
    console.error('It has to be a whole address, scheme and all, e.g. http://my-machine:4317')
    process.exit(1)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(`Invalid --public-url: ${opts.publicUrl} is not http or https`)
    process.exit(1)
  }
  // Trailing slashes survive into the pairing link and make it uglier than it
  // needs to be, without changing where it points.
  opts.publicUrl = parsed.origin
}

const { problems, dir } = checkInstall()
for (const p of problems) console.warn(`warning: ${p}`)

const { server, close, busyCount } = createServer({ notifications: opts.notifications, publicUrl: opts.publicUrl })

// If the port is taken we try the next one, up to 10 times: much better than
// dying because you already had another session-deck open.
let attempts = 0
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && attempts < 10) {
    attempts += 1
    server.listen(opts.port + attempts, opts.host)
    return
  }
  console.error(`Could not start: ${err.message}`)
  process.exit(1)
})

server.listen(opts.port, opts.host, () => {
  const { port } = server.address()
  const shown = opts.host === '0.0.0.0' ? 'localhost' : opts.host
  const url = auth.pairingUrl(`http://${shown}:${port}`)

  console.log(`\n  session-deck  ->  http://${shown}:${port}`)
  console.log(`  reading      ->  ${dir}`)

  // The token is printed on every start rather than only on the first, because
  // the alternative is a person who closed the tab having no way back in
  // short of reading a JSON file out of their home directory.
  console.log(`\n  locked. open this to pair this browser:\n  ${url}`)

  // A QR is only worth drawing when something could scan it and arrive.
  // Either this port is open to the network, or something in front of it is
  // forwarding here and was named with --public-url. Printing a code that
  // cannot work would be worse than printing nothing.
  const lan = opts.host === '0.0.0.0' ? auth.lanAddress() : null
  const origin = opts.publicUrl || (lan ? `http://${lan}:${port}` : null)
  if (origin) {
    console.log(`\n  or scan to pair a phone:\n`)
    qrcode.generate(auth.pairingUrl(origin), { small: true })
    console.log(`  ${origin}\n`)
  } else if (opts.host === '0.0.0.0') {
    console.log('\n  bound to every interface, but no local network address was found\n')
  }

  console.log(`  ctrl+c to quit\n`)
  if (opts.open) openBrowser(url)
})

/**
 * How long a session mid-turn is given to reach the end of it.
 *
 * Restarting the deck is usually a code change, not an emergency, and the
 * difference between four seconds and thirty is the difference between losing
 * the tail of whatever Claude was in the middle of and keeping it. A second
 * ctrl+c still gets your shell back immediately, which is the escape hatch
 * that makes a deadline this long safe to have.
 */
const DRAIN_MS = Number(process.env.SESSION_DECK_DRAIN_MS) || 25000

let closing = false
async function shutdown() {
  if (closing) {
    // Asked twice: you want out now, and the sessions have already been
    // written down as resumable.
    console.log('  leaving the rest to the next start')
    process.exit(0)
  }
  closing = true

  const busy = busyCount()
  if (busy) {
    console.log(`\n  ${busy} session${busy === 1 ? '' : 's'} mid-turn — waiting for a clean stop (ctrl+c again to skip)`)
  }

  /*
   * No race against a timer here any more. close() carries its own deadline
   * per session and its last act is writing the handoff file, so cutting it
   * short from the outside would drop exactly the record that makes the
   * restart survivable.
   */
  try {
    await close({ grace: DRAIN_MS })
  } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// On Windows ctrl+c does not always arrive as SIGINT when no TTY is attached.
if (IS_WINDOWS) {
  try {
    const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout })
    rl.on('SIGINT', shutdown)
  } catch {}
}
