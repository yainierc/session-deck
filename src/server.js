/**
 * server.js — HTTP + WebSocket. No framework: Node alone is enough for this
 * and it keeps startup instant and dependencies near zero.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { notify, openTerminal, chooseFolder } from './platform.js'
import { readSessions, groupByProject, stableOrder, watchSessions, killSession } from './sessions.js'
import { indexTranscripts, findTranscript, readTranscript, tailTranscript, recentProjects, subagentsFor, sessionHistory } from './transcripts.js'
import { createAgentManager } from './agent.js'
import { createSessionStore } from './session-store.js'
import { resolveProjectRoot, subpathWithin, listWorktrees, rootBranch } from './projects.js'
import * as workspace from './workspace.js'
import { browse } from './browse.js'
import * as files from './files.js'
import { meetingsFor } from './meeting.js'
import { resolvePeers, heldPeers } from './roster.js'
import * as presets from './presets.js'
import * as teams from './teams.js'
import * as plans from './plans.js'
import * as roles from './roles.js'
import * as teamproposal from './teamproposal.js'
import * as settings from './settings.js'
import * as permissions from './permissions.js'
import { statusFor, removeWorktree } from './worktree-status.js'
import { buildInbox } from './inbox.js'
import { accountsOverview, adoOrgsFor } from './forges.js'
import { claudeIdentity, forgetClaudeIdentity } from './claude-auth.js'
import { listMcpServers, findMcpServer } from './mcp.js'
import { branchesFor, pull } from './pull.js'
import * as auth from './auth.js'
import * as handoff from './handoff.js'
import * as handoffNotes from './handoff-notes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '..', 'dist')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/**
 * A managed session reports its own vocabulary. Map it onto the statuses the
 * panel already knows so one dot and one colour scheme covers both kinds.
 */
const MANAGED_TO_PANEL = {
  working: 'busy',
  waiting: 'waiting',
  idle: 'idle',
  // Its own panel status rather than a borrowed one: 'idle' would promise a
  // process that is standing by, and 'done' would promise a conversation that
  // is over. This one is neither, and the panel says so.
  detached: 'detached',
  done: 'done',
  error: 'error',
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Read a small JSON body. Capped because a client that never stops sending
 * would otherwise grow this buffer until the server runs out of memory.
 */
/**
 * Wrap a value for a shell command line.
 *
 * Project paths contain spaces ("My Project") and server names contain dots
 * and colons. Single quotes stop the shell reading any of it, and the
 * `'\''` dance is the only way to include a single quote inside them.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Did this request come from the machine the deck is running on?
 *
 * The deck can be reached from a phone — bound to 0.0.0.0 on the local
 * network, or proxied in over a tunnel. Everything that gets that far is
 * paired, so this is no longer the thing standing between the deck and a
 * stranger; `auth.js` is. What it still answers is a narrower question, for
 * the handful of things a paired device should not get to do anyway: open a
 * dialog on somebody's screen, browse the shape of their home folder, or read
 * the pairing key and go on to pair devices of its own.
 */
function isLocalRequest(req) {
  // A reverse proxy defeats the socket check. Tailscale (and cloudflared, and
  // ngrok) run on this machine and dial 127.0.0.1, so a phone on the far side
  // of the tunnel arrives at the same loopback address as the browser sitting
  // in front of the Mac. Asking the socket alone would hand a remote device
  // exactly what this guard exists to withhold.
  //
  // What gives the tunnel away is that it annotates what it forwards.
  // Tailscale stamps its own identity headers on every proxied request and
  // every proxy worth the name sets x-forwarded-for; a browser talking
  // straight to the port sends none of them. So their presence means "came
  // through something", and something is not here.
  //
  // Only the absence of these headers is trusted, never their contents. A
  // remote caller forging them lands in the stricter branch, which is where
  // they already were.
  const headers = req.headers || {}
  if (headers['tailscale-headers-info'] || headers['tailscale-user-login']) return false
  if (headers['x-forwarded-for'] || headers['x-forwarded-host']) return false

  const address = req.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Is `child` the same directory as `parent`, or inside it? */
function isInside(child, parent) {
  if (!child || !parent) return false
  if (child === parent) return true
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}

function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) { req.destroy(); resolve(null) }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * A built asset: `index-B2qAKNIs.js`, `index-Bb6nx77L.css`.
 *
 * The hash is of the contents, so the name changing *is* the file changing.
 * That is what makes it safe to keep one for a year and what makes it unsafe
 * to keep anything else for a second.
 */
const ASSET_NAME = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/
const FOREVER = 'public, max-age=31536000, immutable'
const NO_CACHE = 'no-cache'

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/') rel = '/index.html'

  // Never let a ../ escape the published directory. The separator matters:
  // without it a rel of `/../dist-something/x` normalises to a sibling that
  // still passes a bare prefix test.
  const target = path.join(DIST, rel)
  if (!target.startsWith(DIST + path.sep)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  const ext = path.extname(target)

  fs.readFile(target, (err, data) => {
    if (err) {
      /*
       * A missing asset is a 404 and never the index.
       *
       * The fallback below exists for routes — /settings typed into the bar —
       * and handing HTML back for a missing `.js` turns the most common
       * failure after an update into the most confusing one: the browser gets
       * a 200, tries to run a page as a module, and the app simply does not
       * boot. Nothing on screen says why, and reloading does it again.
       */
      if (ext && ext !== '.html') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found')
        return
      }

      fs.readFile(path.join(DIST, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('The UI has not been built yet.\n\nRun:  npm install && npm run build\n')
          return
        }
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': NO_CACHE }).end(html)
      })
      return
    }
    const type = MIME[ext] || 'application/octet-stream'
    /*
     * The build gives every asset a name containing a hash of its contents, so
     * a file that changed arrives under a new name and one that did not can be
     * kept for ever. `index.html` is the exception and the important one: it
     * is the only file whose name stays the same, it is what names the others,
     * and a stale copy of it asks for a bundle that no longer exists. Caching
     * it is how an update becomes invisible until somebody clears a cache they
     * have no reason to suspect.
     */
    const cache = ASSET_NAME.test(path.basename(target)) ? FOREVER : NO_CACHE
    res.writeHead(200, { 'content-type': type, 'cache-control': cache }).end(data)
  })
}

/**
 * What an unpaired caller gets.
 *
 * A person who typed the bare address deserves to be told what to do about it,
 * so a navigation gets a page rather than the word "Unauthorized". Anything
 * under /api gets JSON, because that is what is waiting for an answer there.
 *
 * The reason is named but never elaborated: "origin" and "token" are useful to
 * whoever is looking at the terminal, and describing which part of the
 * credential was wrong would only help someone guessing at it.
 */
/*
 * The unlock form, and only when there is a PIN to type into it. A box that
 * refuses everything teaches whoever finds this port that there is a second
 * credential to go looking for, which is a thing not to say when it is not
 * even true.
 *
 * Plain DOM and no template literals in the script: this string is itself a
 * template literal, and a stray backtick here is a page that does not parse.
 */
const UNLOCK_FORM = `
  <form id="unlock" autocomplete="off">
    <input id="pin" type="password" inputmode="numeric" pattern="[0-9]*"
           autocomplete="off" placeholder="PIN" aria-label="Unlock PIN" required>
    <button type="submit">Unlock</button>
  </form>
  <p id="msg" role="status" aria-live="polite"></p>
  <script>
    (function () {
      var f = document.getElementById('unlock')
      var p = document.getElementById('pin')
      var m = document.getElementById('msg')
      f.addEventListener('submit', function (e) {
        e.preventDefault()
        m.textContent = 'Checking...'
        fetch('/api/auth/unlock', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pin: p.value })
        }).then(function (r) {
          return r.json().catch(function () { return {} }).then(function (b) {
            if (r.status === 200) { location.replace(location.pathname); return }
            m.textContent = b && b.error ? b.error : 'That did not work'
            p.value = ''
            p.focus()
          })
        }).catch(function () { m.textContent = 'Could not reach the deck' })
      })
    })()
  </script>
`

function lockedPage() {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>session-deck — locked</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#101014; color:#e6e6ea;
         font:16px/1.6 ui-sans-serif,-apple-system,system-ui,sans-serif }
  main { max-width:32rem; padding:2rem; text-align:center }
  h1 { font-size:1.25rem; font-weight:600; margin:0 0 .75rem }
  p { margin:0 0 .75rem; color:#a0a0ab }
  code { background:#1c1c22; padding:.15rem .4rem; border-radius:.25rem; color:#e6e6ea }
  form { display:flex; gap:.5rem; justify-content:center; margin:1.25rem 0 .5rem }
  input { flex:0 1 11rem; padding:.55rem .7rem; font:inherit; letter-spacing:.2em;
          text-align:center; color:#e6e6ea; background:#1c1c22;
          border:1px solid #2c2c36; border-radius:.35rem }
  input:focus { outline:none; border-color:#6ea8fe }
  button { padding:.55rem 1rem; font:inherit; color:#101014; background:#6ea8fe;
           border:0; border-radius:.35rem; cursor:pointer }
  #msg { min-height:1.6rem; margin:0; font-size:.9rem; color:#ffa8a8 }
</style>
<main>
  <h1>This deck is locked</h1>
  <p>It can start sessions and run commands on the machine it is on, so it
     will not answer without the key.</p>
  <p>Scan the QR code in the terminal where you ran <code>session-deck</code>,
     or open the link printed beside it.</p>
  ${auth.hasPin() ? UNLOCK_FORM : ''}
</main>
`
}

function sendUnauthorized(req, res, url, reason) {
  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 401, { error: 'Unauthorized', reason })
  }
  const page = lockedPage()
  res.writeHead(401, {
    'content-type': MIME['.html'],
    'content-length': Buffer.byteLength(page),
  })
  res.end(page)
}

export function createServer({ notifications = true, publicUrl = null } = {}) {
  const agents = createAgentManager()
  /*
   * Everything the SDK can do to a session file by id — read its subagents,
   * set its name. It works on observed sessions too, which is why the name in
   * the sidebar and the Agents tab are not limited to what the deck launched.
   */
  const store = createSessionStore()

  /*
   * Put back the sessions the last deck was driving.
   *
   * They come back detached — listed, titled, and attached to their
   * transcript, but with no process behind them until you say something. That
   * is deliberate: a restart that silently respawned five CLIs would reload
   * five conversations into context for a panel you may only have restarted to
   * pick up a CSS change.
   */
  const liveNow = new Set(readSessions().map((s) => s.sessionId).filter(Boolean))
  for (const record of handoff.read()) {
    /*
     * Someone picked this conversation up in a terminal while the deck was
     * down — with `claude --resume`, which is exactly what you would do. It
     * has a process and an owner already, so the deck goes back to watching
     * it rather than claiming a session it cannot drive.
     */
    if (liveNow.has(record.sessionId)) continue
    agents.adopt({
      sessionId: record.sessionId,
      cwd: record.cwd,
      name: record.title,
      permissionMode: record.permissionMode,
      model: record.model,
      effort: record.effort,
      advisor: record.advisor,
      delegates: record.delegates,
      deckId: record.deckId,
      startedAt: record.startedAt,
      // What it had got through before the restart. The session will not
      // re-send its plan unprompted, so this file is the only way the strip
      // comes back filled in.
      todos: record.todos,
    })
  }

  /*
   * Keep the handoff file current, coalesced.
   *
   * On every state change and not only on the way out, because the exits that
   * cost the most work are the ones with no way out: `kill -9`, a crash, a
   * machine that went to sleep. The timer is what keeps a chatty session —
   * one publishing a change per tool call — from turning this into a write per
   * message.
   */
  let handoffTimer = null
  const rememberSessions = () => {
    if (handoffTimer) return
    handoffTimer = setTimeout(() => {
      handoffTimer = null
      handoff.remember(agents.list())
    }, 1000)
    handoffTimer.unref?.()
  }

  /**
   * Merge what we observe with what we drive.
   *
   * Sessions the deck launched also register themselves on disk, so they
   * appear in the observed list too — but without a status, because only the
   * interactive TUI publishes one. We overlay ours on top, and add the ones
   * that have not registered yet so they show up the instant you launch them.
   */
  function snapshot() {
    const managed = agents.bySessionId()
    const matched = new Set()

    const sessions = readSessions().map((s) => {
      /*
       * The name and tag out of the session's own file. The registry calls a
       * session `multi-tasking-cf`, which is no help at all next to three of
       * its siblings — so a name somebody actually set outranks it, whether
       * it was set with `claude -n`, with `/rename`, or from here.
       */
      const labels = store.labels(s.sessionId)
      const named = { ...s, title: labels.title, tag: labels.tag, name: labels.title || s.name }

      const m = s.sessionId && managed.get(s.sessionId)
      if (!m) return named
      matched.add(s.sessionId)
      return {
        ...named,
        managed: true,
        deckId: m.deckId,
        // The task you typed identifies it better than either of the names on
        // disk, and it is the label this deck owns.
        name: m.title || named.name,
        /*
         * And the address, carried separately because the line above just
         * replaced the name a peer would have to type with the one you find
         * readable. They are usually different strings and only one of them
         * reaches this session: `peerName` when the deck named it at spawn,
         * otherwise whatever the CLI derived and published to the registry.
         */
        peerName: m.peerName || named.name,
        status: MANAGED_TO_PANEL[m.status] || s.status,
        pending: m.pending,
        pendingCount: m.pendingCount,
        permissionMode: m.permissionMode,
        modeNote: m.modeNote,
        /*
         * What it runs on and how hard it thinks, beside what was asked for.
         * Copied field by field like everything above because this merge is a
         * whitelist, not a spread: a session's own file is the other half of
         * this object and must not be able to overwrite the deck's view of
         * the process it is driving.
         */
        model: m.model,
        requestedModel: m.requestedModel,
        effort: m.effort,
        requestedEffort: m.requestedEffort,
        requestedAdvisor: m.requestedAdvisor,
        delegates: m.delegates,
        // Only a managed session has one: the tool that writes it is passed
        // at spawn, and a session running in a terminal was never given it.
        todos: m.todos,
        // The subagents it has running, straight off its stream.
        agents: m.agents,
        waitingFor: m.pending ? m.pending.title : s.waitingFor,
      }
    })

    for (const m of agents.list()) {
      if (m.sessionId && matched.has(m.sessionId)) continue
      if (m.status === 'done') continue
      // Same repository grouping the observed sessions get, so a task
      // launched into a worktree lands under its project too.
      const { root, isWorktree } = resolveProjectRoot(m.cwd)
      sessions.push({
        pid: null,
        sessionId: m.sessionId,
        deckId: m.deckId,
        name: m.title,
        /*
         * Null until the process registers itself a moment from now. A
         * session that has not published an address yet is not somebody the
         * roster can introduce, and offering it would produce a peer name
         * that resolves to nothing.
         */
        peerName: m.peerName,
        cwd: m.cwd,
        project: root ? path.basename(root) : 'no project',
        projectPath: root || m.cwd,
        subpath: subpathWithin(root, m.cwd),
        isWorktree,
        status: MANAGED_TO_PANEL[m.status] || 'unknown',
        waitingFor: m.pending ? m.pending.title : null,
        pending: m.pending,
        pendingCount: m.pendingCount,
        permissionMode: m.permissionMode,
        modeNote: m.modeNote,
        model: m.model,
        requestedModel: m.requestedModel,
        effort: m.effort,
        requestedEffort: m.requestedEffort,
        requestedAdvisor: m.requestedAdvisor,
        delegates: m.delegates,
        agents: m.agents,
        managed: true,
        startedAt: m.startedAt,
        updatedAt: Date.now(),
        error: m.error,
      })
    }

    /*
     * The workspace decides what the deck is answerable for.
     *
     * A session running in a folder you never added is somebody else's
     * business — opened from a terminal in a repo you are not tracking here.
     * It is dropped before anything downstream sees it, so the sidebar, the
     * inbox, the teams screen and the notifier all agree on one list rather
     * than each filtering it differently.
     *
     * A session the deck launched is kept whatever folder it is in: we
     * started it and we own its permission prompts, and a prompt with
     * nowhere to be answered leaves that session blocked for ever.
     */
    const folders = workspace.list()
    const roots = new Set(folders.map((f) => f.path))
    /*
     * Ordered once, here, after the two sources have been merged. A session
     * the deck launched appears first in `agents.list()` and later in the
     * registry — it publishes its own file only once it has an id — so
     * without this it would move from the end of its project to its place
     * among the others a second after it starts.
     */
    const tracked = stableOrder(sessions.filter((s) => s.managed || roots.has(s.projectPath)))

    /*
     * A session says which project it belongs to, and that has to be the name
     * you gave the project rather than the folder's.
     *
     * Relabelled here, once, instead of inside the two places that build a
     * session: this is where the workspace has already been read, so it costs
     * nothing, and it means the toast, the inbox row, the launcher's grouping
     * and the sidebar heading are all fed the same string by construction.
     * A session in a folder that is not in the workspace keeps its basename —
     * there is no label to find for it.
     */
    const labelled = tracked.map((s) => {
      const named = folders.find((f) => f.path === s.projectPath)
      return named && named.name !== s.project ? { ...s, project: named.name } : s
    })

    return { sessions: labelled, projects: mergeWorkspace(labelled, folders) }
  }

  /**
   * The sidebar is a workspace, not a list of what happens to be running.
   *
   * Folders you added stay put whether or not anything is open in them, and
   * sessions started outside the deck attach to the folder they belong to —
   * what you added is watched however the work in it was started.
   */
  function mergeWorkspace(sessions, folders) {
    const live = new Map(groupByProject(sessions).map((g) => [g.path, g]))
    const projects = []

    for (const folder of folders) {
      const group = live.get(folder.path)
      live.delete(folder.path)
      projects.push({
        path: folder.path,
        name: folder.name,
        saved: true,
        exists: folder.exists,
        sessions: group?.sessions || [],
        waiting: group?.waiting || 0,
      })
    }

    /*
     * Whatever is left is a project the deck itself is driving from a folder
     * that is not in the workspace — a task launched into it and the folder
     * dropped afterwards, say. Its sessions survived the filter above, so it
     * shows, marked live: the alternative is a running session of ours with
     * no row to answer it from.
     */
    for (const group of live.values()) {
      projects.push({ ...group, saved: false, exists: true })
    }

    /*
     * Returned in workspace order, with the unsaved ones after it, and
     * deliberately not re-sorted.
     *
     * This used to float anything blocked on you to the top. That is the one
     * thing a sidebar must not do: the list you are reaching for changes
     * shape between deciding to click and clicking, and answering the ask
     * puts it back, so the project you were half-way through reading moves
     * twice per prompt. The badge says what is waiting; the toast at the top
     * right carries the ask itself. Neither costs you your place.
     */
    return projects
  }

  /** Everything the project view needs: worktrees, sessions, subagents. */
  function projectDetail(projectPath, sessions) {
    const mine = sessions.filter((s) => s.projectPath === projectPath)
    const worktrees = listWorktrees(projectPath).map((w) => ({
      ...w,
      sessions: mine.filter((s) => s.cwd === w.path).map((s) => s.name),
    }))

    const index = indexTranscripts()
    const subagents = []
    for (const session of mine) {
      if (!session.sessionId) continue
      const transcript = findTranscript(session.sessionId, index)
      if (!transcript) continue
      const { running } = subagentsFor(transcript)
      for (const task of running) {
        // Only the task's own title is worth showing. Its type is a fallback
        // for the odd Task launched without a description.
        subagents.push({
          id: task.id,
          title: task.description || task.type,
          sessionName: session.name,
          sessionId: session.sessionId,
        })
      }
    }

    return {
      path: projectPath,
      // The name you gave it if you gave it one, so the page's heading and the
      // sidebar row you clicked to get here cannot disagree.
      name: workspace.nameFor(projectPath) || projectPath,
      branch: rootBranch(projectPath),
      worktrees,
      subagents,
      sessions: mine,
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')

    // There is no `access-control-allow-origin` here on purpose. It used to be
    // `*`, which let any page you happened to have open read every transcript
    // on this machine. The UI is served from this same origin in production
    // and reaches it through Vite's proxy in development, so neither one ever
    // needed CORS — only the attack did.
    /*
     * The one route in front of the gate, because it is how a device holding
     * no credential gets one.
     *
     * What the gate would have done still happens. The origin is checked here
     * explicitly, so this is no easier to drive from another page than
     * anything behind it. The throttle in auth.js stands where the token
     * normally stands, and is the only thing doing so — a six-digit PIN is a
     * million guesses and this endpoint is unauthenticated by construction.
     * And success hands back the very same cookie pairing hands back: the PIN
     * is a second way to present the key, never a second key.
     */
    if (url.pathname === '/api/auth/unlock' && req.method === 'POST') {
      if (!auth.originAllowed(req)) return sendJson(res, 403, { error: 'Forbidden' })
      if (!auth.hasPin()) return sendJson(res, 404, { error: 'No PIN is set on this deck' })
      return readBody(req).then((body) => auth.verifyPin(body?.pin).then((result) => {
        if (result.ok) {
          res.setHeader('set-cookie', auth.cookieHeader(result.token))
          return sendJson(res, 200, { ok: true })
        }
        if (result.lockedFor) {
          const seconds = Math.ceil(result.lockedFor / 1000)
          return sendJson(res, 429, { error: `Too many wrong PINs. Try again in ${seconds}s.` })
        }
        // The count left is told on purpose. It is no use to somebody working
        // through a million PINs — they can count — and it is the difference
        // between a typo and a lockout for the person it is meant for.
        const left = result.attemptsLeft
        return sendJson(res, 401, {
          error: left ? `Wrong PIN — ${left} ${left === 1 ? 'try' : 'tries'} left` : 'Wrong PIN',
        })
      }))
    }

    const pass = auth.authorize(req, url)
    if (!pass.ok) return sendUnauthorized(req, res, url, pass.reason)

    // Pairing: the credential arrived in the URL. Trade it for a cookie and
    // then get it out of the address bar, where it would otherwise survive in
    // history, in a bookmark, and in every screenshot of the panel.
    if (pass.paired) {
      res.setHeader('set-cookie', auth.cookieHeader(auth.token()))
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        url.searchParams.delete('token')
        const query = url.searchParams.toString()
        res.writeHead(302, { location: `${url.pathname}${query ? `?${query}` : ''}` })
        return res.end()
      }
    }

    if (url.pathname === '/api/state') {
      return sendJson(res, 200, snapshot())
    }

    if (url.pathname === '/api/projects') {
      return sendJson(res, 200, { projects: recentProjects() })
    }

    if (url.pathname === '/api/project') {
      const target = url.searchParams.get('path')
      if (!target) return sendJson(res, 400, { error: 'path is required' })
      return sendJson(res, 200, projectDetail(target, snapshot().sessions))
    }
    /*
     * Deliberately not folded into /api/project, which the project view puts
     * on a four-second timer. This one goes to disk for every transcript
     * directory on the machine, and paying that every four seconds to redraw
     * a list that changes when a session ends is the wrong trade.
     */
    if (url.pathname === '/api/project-history') {
      const target = url.searchParams.get('path')
      if (!target) return sendJson(res, 400, { error: 'path is required' })
      const limit = Number(url.searchParams.get('limit')) || 5
      const live = new Set(snapshot().sessions.map((s) => s.sessionId).filter(Boolean))
      const { sessions, total } = sessionHistory(target, { limit })
      // A session that is still running appears here too: it is part of the
      // project's history, it just has not finished being made. Marking it is
      // what stops the row offering to reopen something already on screen.
      return sendJson(res, 200, {
        total,
        sessions: sessions.map((s) => ({ ...s, live: live.has(s.sessionId) })),
      })
    }

    if (url.pathname === '/api/workspace') {
      if (req.method === 'GET') return sendJson(res, 200, { folders: workspace.list() })

      /*
       * PATCH is everything about a folder already in the workspace — its
       * place in the order and the name you gave it — and it is a separate
       * verb rather than a flag on POST because it is a different act: POST
       * brings a folder in, PATCH edits one that is already there. Every one
       * of them ends in the same broadcast, so a reorder or a rename done on
       * your phone redraws the menu on the desktop without either side asking.
       *
       * The two PATCHes are told apart by which field arrived, not by a mode
       * string: a body with a direction is a move, a body carrying a name is a
       * rename. An empty name is a real request — it is how a label is
       * cleared — so presence of the key is what counts, never its truthiness.
       */
      if (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PATCH') {
        readBody(req).then((payload) => {
          if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid JSON' })
          let result
          if (req.method === 'POST') result = workspace.add(payload.path)
          else if (req.method === 'DELETE') result = workspace.remove(payload.path)
          else if ('name' in payload) result = workspace.rename(payload.path, payload.name)
          else result = workspace.move(payload.path, payload.direction)
          if (result.ok) broadcastState()
          sendJson(res, result.ok ? 200 : 400, result)
        })
        return
      }
    }

    /**
     * Conversations between sessions, for the room.
     *
     * Split in two because the bodies are the bulk of it: a busy room is
     * forty turns of two thousand characters, and the list that polls for
     * "is anyone talking" has no use for a word of it. The list carries
     * enough to draw a room shut; opening one fetches what it says.
     *
     * The first scan is not cheap — it reads a fortnight of transcripts —
     * but it happens once and every later call reads only what was appended.
     */
    if (url.pathname === '/api/meetings') {
      const rooms = meetingsFor(snapshot().sessions, indexTranscripts())
      return sendJson(res, 200, {
        rooms: rooms.map((room) => ({
          ...room,
          turns: room.turns.map((turn) => ({
            ...turn,
            text: undefined,
            preview: turn.text.replace(/\s+/g, ' ').trim().slice(0, 180),
          })),
        })),
      })
    }

    if (url.pathname.startsWith('/api/meeting/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/meeting/'.length))
      const room = meetingsFor(snapshot().sessions, indexTranscripts()).find((one) => one.id === id)
      if (!room) return sendJson(res, 404, { error: 'no such room' })
      return sendJson(res, 200, { room })
    }

    /**
     * Browsing the disk for a folder to add.
     *
     * Local requests only. A directory listing is not a file, but the shape of
     * someone's home folder is still theirs, and this server has no
     * authentication and can be bound to 0.0.0.0. Reading it should cost you
     * being on the machine.
     *
     * A bad path answers 200 with ok:false: walking into a folder you cannot
     * read is navigation, not a broken request, and the picker keeps its place.
     */
    if (url.pathname === '/api/browse') {
      if (!isLocalRequest(req)) {
        return sendJson(res, 403, { ok: false, error: 'Browsing is only possible from the machine running the deck' })
      }
      return sendJson(res, 200, browse(url.searchParams.get('path'), {
        showHidden: url.searchParams.get('hidden') === '1',
      }))
    }

    /**
     * The operating system's own folder dialog, for when you are sitting at
     * the machine and would rather use the Finder you already know.
     *
     * Local requests only, and for a blunter reason than the browse endpoint:
     * this opens a window on someone's screen. A stranger on the café wifi
     * does not get to make dialogs appear on your laptop.
     */
    if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
      if (!isLocalRequest(req)) {
        return sendJson(res, 403, { ok: false, error: 'The system dialog can only open on the machine running the deck' })
      }
      readBody(req).then(async (payload) => {
        const result = await chooseFolder(payload?.start)
        sendJson(res, 200, result)
      })
      return
    }

    /**
     * Worktree status is a separate call from the project view on purpose:
     * the view refreshes on a timer and this shells out to git and gh, so
     * they must not share a cadence.
     */
    /**
     * The triage queue. Aggregates git and gh across the workspace, so it is
     * on demand with its own refresh rather than anywhere near the 1s tick.
     */
    if (url.pathname === '/api/inbox') {
      const state = snapshot()
      buildInbox({
        sessions: state.sessions,
        projects: state.projects,
        refresh: url.searchParams.get('refresh') === '1',
      })
        .then((inbox) => sendJson(res, 200, inbox))
        .catch((err) => sendJson(res, 500, { error: err.message }))
      return
    }

    /**
     * Which identities the deck can use, and whether they work.
     *
     * Shares the inbox's cost profile — a handful of `gh` and `az` calls — so
     * like the inbox it runs on demand, never on the tick.
     */
    if (url.pathname === '/api/accounts') {
      const refresh = url.searchParams.get('refresh') === '1'
      // Claude's own sign-in is asked for alongside the forges rather than
      // inside accountsOverview(): it is not a forge, it has no repository to
      // map, and it is the one identity whose absence means there is nothing
      // to map anything for.
      Promise.all([
        // The forge side is the half that can throw — gh, az and git are all
        // shelled out to in there. It used to take the whole response with it,
        // which was survivable when the response was only about pull requests.
        // It is not survivable now: the identity that decides whether the deck
        // can run anything at all would be the first thing lost whenever
        // something unrelated to it broke.
        accountsOverview({
          roots: [...new Set(snapshot().projects.map((p) => p.path).filter(Boolean))],
          refresh,
          // Not `error`: the client treats a top-level `error` as "this whole
          // response is worthless" and renders nothing, which is the failure
          // being fixed here rather than a way to fix it.
        }).catch((err) => ({ forgeError: err.message })),
        claudeIdentity({ refresh }),
      ])
        // Whether signing in from the panel is even meaningful: a terminal
        // opening on this Mac is no use to someone reading this on a phone.
        .then(([overview, claude]) => sendJson(res, 200, { ...overview, claude, local: isLocalRequest(req) }))
        .catch((err) => sendJson(res, 500, { error: err.message }))
      return
    }

    /**
     * Open a terminal on the sign-in command for one forge.
     *
     * Two rules, both load-bearing, because this endpoint spawns processes and
     * the server has no authentication and can be bound to 0.0.0.0:
     *
     *   1. Local requests only. A stranger on the café wifi does not get to
     *      start processes on your laptop.
     *   2. The command is chosen from a fixed set here, never assembled from
     *      what the client sent. The organisation is matched against the ones
     *      actually in your workspace and the server's own URL is used.
     */
    if (url.pathname === '/api/mcp') {
      listMcpServers({
        roots: [...new Set(snapshot().projects.map((p) => p.path).filter(Boolean))],
        refresh: url.searchParams.get('refresh') === '1',
      })
        .then((list) => sendJson(res, 200, { ...list, local: isLocalRequest(req) }))
        .catch((err) => sendJson(res, 500, { error: err.message }))
      return
    }

    /**
     * What every project is trying to build, in whatever it writes it down in.
     *
     * Read per project and never cached: these are a few dozen small files and
     * the whole value of the screen is that it is true right now. The old
     * roadmap was a cache of the plan and that is precisely what killed it —
     * a board that lags the repository teaches you to stop believing it.
     *
     * Read-only, by construction. Nothing on this route writes to a
     * repository, and the detection result carries whether writing would even
     * be allowed, so the screen can say which projects the deck would be
     * willing to touch before anything can be asked of it.
     */
    if (url.pathname === '/api/plans') {
      const roots = [...new Set(snapshot().projects.map((p) => p.path).filter(Boolean))]
      const only = url.searchParams.get('root')

      try {
        const projects = (only ? roots.filter((r) => r === only) : roots).map((root) => {
          try {
            /*
             * The worktrees too, because a plan written on a branch is still a
             * plan of this project — and the main checkout is often parked
             * somewhere that has none of them.
             */
            return plans.readAll(root, listWorktrees(root).filter((w) => w.exists).map((w) => w.path))
          } catch (err) {
            /*
             * One unreadable repository must not take the screen with it.
             * These readers walk files written by other tools and by people,
             * and the honest failure is "this project could not be read",
             * next to the ten that could.
             */
            return {
              root,
              name: root.split('/').filter(Boolean).pop() || root,
              method: 'error',
              label: 'could not be read',
              supported: false,
              plans: [],
              drift: [],
              unreadable: [],
              error: err?.message || 'unreadable',
            }
          }
        })
        return sendJson(res, 200, { projects })
      } catch (err) {
        return sendJson(res, 500, { error: err.message })
      }
    }

    /**
     * The Files tab: one folder of a project, a name search across it, or
     * just what changed — and, at /api/file, one file read back as text.
     *
     * Only for a folder that is already a project in the deck. Unlike
     * /api/browse this answers a paired phone too, because that is what
     * pairing is for and the transcripts it already reads are full of these
     * same files; what keeps it from being a window onto the whole disk is
     * that `root` has to be one the deck knows, and files.js fences every
     * path inside it.
     */
    if (url.pathname === '/api/files' || url.pathname === '/api/file') {
      const root = url.searchParams.get('root')
      const known = snapshot().projects.some((p) => p.path && p.path === root)
      if (!root || !known) return sendJson(res, 404, { ok: false, error: 'That folder is not a project in the deck' })
      const showHidden = url.searchParams.get('hidden') === '1'
      const rel = url.searchParams.get('path') || ''

      const answer = url.pathname === '/api/file'
        ? files.readFile(root, rel)
        : url.searchParams.has('find')
          ? files.findFiles(root, url.searchParams.get('find'), { showHidden })
          : url.searchParams.get('changed') === '1'
            ? files.changedFiles(root)
            : files.listDir(root, rel, { showHidden })
      return answer
        .then((body) => sendJson(res, 200, body))
        .catch((err) => sendJson(res, 500, { ok: false, error: err?.message || 'Could not read the project' }))
    }

    /**
     * The handoff notes of the project this folder belongs to — its main
     * checkout and every worktree — so a new session can start from one.
     *
     * Asked by folder rather than by project, because the launcher only ever
     * knows the folder you clicked, and that may be a worktree.
     */
    if (url.pathname === '/api/handoffs' && req.method === 'GET') {
      const cwd = url.searchParams.get('cwd')
      if (!cwd) return sendJson(res, 400, { error: 'cwd is required' })
      const root = resolveProjectRoot(cwd).root || cwd
      const worktrees = listWorktrees(root).filter((w) => w.exists)
      const checkouts = [root, ...worktrees.map((w) => w.path)]

      const notes = handoffNotes.list(checkouts).map((note) => {
        const worktree = worktrees.find((w) => w.path === note.checkout)
        return {
          ...note,
          worktree: worktree ? worktree.name : null,
          // What the checkout has out now, when the note did not say.
          branch: note.branch || (worktree ? worktree.branch : rootBranch(root)),
        }
      })

      /*
       * A pending note whose worktree is already merged is probably stale:
       * the work it describes has landed. Said, not hidden — the note may
       * still carry the follow-ups. Only the pending ones are asked about,
       * so opening the launcher costs a handful of cached git calls.
       */
      Promise.all(notes.map(async (note) => {
        if (note.state !== 'pending' || !note.worktree) return { ...note, merged: false }
        const status = await statusFor(root, note.checkout).catch(() => null)
        return { ...note, merged: Boolean(status?.available && status.finished) }
      }))
        .then((handoffs) => sendJson(res, 200, { root, handoffs }))
        .catch((err) => sendJson(res, 500, { error: err.message }))
      return
    }

    if (url.pathname === '/api/handoffs/picked' && req.method === 'POST') {
      readBody(req).then((payload) => {
        const ok = handoffNotes.markPickedUp(payload?.file)
        sendJson(res, ok ? 200 : 400, ok ? { ok } : { ok, error: 'Not a handoff note' })
      })
      return
    }


    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!isLocalRequest(req)) {
        return sendJson(res, 403, { error: 'Signing in and out is only possible from the machine running the deck' })
      }
      readBody(req).then(async (payload) => {
        const roots = [...new Set(snapshot().projects.map((p) => p.path).filter(Boolean))]

        let command = null
        if (payload?.target === 'github') command = 'gh auth login'
        // Signing out travels this route rather than one of its own: the
        // property that makes this endpoint safe is that the command is chosen
        // here from a fixed set, and a second endpoint would have to copy it
        // along with the local-only guard. `action` picks between two constants
        // and is never interpolated.
        else if (payload?.target === 'claude') {
          command = payload.action === 'logout' ? 'claude auth logout' : 'claude auth login'
        }
        else if (payload?.target === 'azure') command = 'az login'
        else if (payload?.target === 'ado') {
          const match = (await adoOrgsFor(roots)).find((o) => o.org === payload.org)
          if (match) command = `az devops login --org ${match.orgUrl}`
        } else if (payload?.target === 'mcp') {
          // Project-scoped servers only resolve from inside their project, so
          // the command has to move there first. Both values come from the
          // live list, never from the request.
          const match = await findMcpServer({ roots, name: payload.server, cwd: payload.cwd })
          if (match) command = `cd ${shellQuote(match.path)} && claude mcp login ${shellQuote(match.name)}`
        }

        if (!command) return sendJson(res, 400, { error: 'Nothing to sign in to' })

        // Only the signed-in answer is cached, so this never matters for
        // arriving at a login — that state is never held. It matters for
        // leaving one: signing out and switching accounts both start ten
        // minutes of "you are still the old one" over an identity that no
        // longer exists, and a logout the panel keeps showing as signed in is
        // the one way this row can lie outright. It also bumps a generation,
        // so a lookup already in flight cannot land afterwards and restore
        // what it read before the handoff.
        if (payload?.target === 'claude') forgetClaudeIdentity()

        // The command travels back either way: when the terminal could not be
        // opened it is the only thing that gets the user unstuck.
        const opened = await openTerminal(command)
        sendJson(res, opened.ok ? 200 : 500, { ok: opened.ok, command, error: opened.error })
      })
      return
    }

    if (url.pathname === '/api/worktrees') {
      const root = url.searchParams.get('root')
      if (!root) return sendJson(res, 400, { error: 'root is required' })

      const known = listWorktrees(root)
      const refresh = url.searchParams.get('refresh') === '1'
      const live = snapshot().sessions

      Promise.all(
        known.map(async (worktree) => {
          if (!worktree.exists) return { ...worktree, status: { available: false, error: 'Directory is missing' } }
          const status = await statusFor(root, worktree.path, { refresh })

          // A worktree someone is working in right now is never deletable,
          // however finished the branch looks. git would not stop you, and
          // pulling the floor out from under a running session would be the
          // rudest thing this panel could do.
          const busy = live.filter((session) => isInside(session.cwd, worktree.path))
          if (busy.length && status.available) {
            status.safeToDelete = false
            status.finished = false
            status.state = 'protected'
            status.atRisk = [
              `${busy.length} session${busy.length === 1 ? '' : 's'} running here`,
              ...(status.atRisk || []),
            ]
            status.blockers = status.atRisk
          }

          // An untracked note already makes the worktree dirty, so it is
          // protected either way. This says which of the uncommitted changes
          // is the one you would miss.
          const waiting = handoffNotes.list([worktree.path]).filter((n) => n.state === 'pending')
          if (waiting.length && status.available) {
            status.atRisk = [
              `${waiting.length} handoff ${waiting.length === 1 ? 'note' : 'notes'} not picked up yet`,
              ...(status.atRisk || []),
            ]
            status.blockers = status.atRisk
          }
          return { ...worktree, status }
        }),
      )
        .then((worktrees) => sendJson(res, 200, { worktrees }))
        .catch((err) => sendJson(res, 500, { error: err.message }))
      return
    }

    if (url.pathname === '/api/worktree' && req.method === 'DELETE') {
      readBody(req).then(async (payload) => {
        if (!payload?.root || !payload?.path) {
          return sendJson(res, 400, { ok: false, error: 'root and path are required' })
        }

        // Only ever a path git itself reports as a worktree of this repo.
        // Taking a path straight from the client would hand anyone who can
        // reach this port a way to delete arbitrary directories.
        const known = listWorktrees(payload.root)
        const target = known.find((w) => w.path === payload.path)
        if (!target) return sendJson(res, 400, { ok: false, error: 'Not a worktree of this repository' })

        const busy = snapshot().sessions.filter((session) => isInside(session.cwd, target.path))
        if (busy.length) {
          return sendJson(res, 409, { ok: false, error: 'A session is still running in this worktree' })
        }

        // Re-check rather than trusting what the UI was showing: the button
        // may have been rendered from state that is now minutes old.
        const status = await statusFor(payload.root, target.path, { refresh: true })
        if (!status.available || !status.safeToDelete) {
          return sendJson(res, 409, {
            ok: false,
            error: 'Not safe to delete: ' + (status.blockers?.join(', ') || 'unknown state'),
          })
        }

        const result = await removeWorktree(payload.root, target.path, {
          // Only ever the branch this worktree actually had checked out, read
          // from git a line ago — never a name the browser chose.
          deleteBranch: payload.deleteBranch ? status.branch : null,
        })
        if (result.ok) broadcastState()
        sendJson(res, result.ok ? 200 : 400, result)
      })
      return
    }

    /**
     * Clear out every worktree whose work has landed, in one go.
     *
     * One button and not forty, because forty worktrees is where this
     * screen stops being used at all — and because they are all the same
     * decision, taken for the same reason.
     *
     * Each one is re-checked here rather than trusted from the list the
     * browser was showing: that list may be minutes old, and a session may
     * have started in one of them since. Nothing is forced, and anything
     * that fails is reported by name instead of stopping the rest.
     */
    if (url.pathname === '/api/worktrees/tidy' && req.method === 'POST') {
      readBody(req).then(async (payload) => {
        if (!payload?.root) return sendJson(res, 400, { ok: false, error: 'root is required' })

        const known = listWorktrees(payload.root)
        const live = snapshot().sessions
        const removed = []
        const skipped = []

        for (const worktree of known) {
          if (!worktree.exists || worktree.main) continue
          if (live.some((session) => isInside(session.cwd, worktree.path))) {
            skipped.push({ name: worktree.name, why: 'a session is running here' })
            continue
          }
          const status = await statusFor(payload.root, worktree.path, { refresh: true })
          if (!status.available || !status.finished || !status.safeToDelete) continue

          const result = await removeWorktree(payload.root, worktree.path, {
            deleteBranch: payload.deleteBranches ? status.branch : null,
          })
          if (result.ok) removed.push({ name: worktree.name, branch: status.branch, branchDeleted: result.branchDeleted })
          else skipped.push({ name: worktree.name, why: result.error })
        }

        if (removed.length) broadcastState()
        sendJson(res, 200, { ok: true, removed, skipped })
      })
      return
    }

    /**
     * Which branches this project could pull from, and where it stands now.
     *
     * `refresh=1` is the only thing here that touches the network, so opening
     * the panel costs nothing and asking for new branches is a deliberate act.
     */
    if (url.pathname === '/api/git-branches') {
      const root = url.searchParams.get('root')
      if (!root) return sendJson(res, 400, { error: 'root is required' })

      branchesFor(root, { refresh: url.searchParams.get('refresh') === '1' })
        .then((info) => sendJson(res, 200, { ...info, remembered: workspace.pullBranchFor(root) }))
        .catch((err) => sendJson(res, 500, { error: err.message }))
      return
    }

    /**
     * Remember a project's pull branch. Separate from the pull itself so that
     * choosing a branch and acting on it stay two decisions: picking one from
     * the list must never be what fetches.
     */
    if (url.pathname === '/api/pull-branch' && req.method === 'POST') {
      readBody(req).then((payload) => {
        if (!payload?.root) return sendJson(res, 400, { ok: false, error: 'root is required' })
        const result = workspace.setPullBranch(payload.root, payload.branch)
        sendJson(res, result.ok ? 200 : 400, result)
      })
      return
    }

    /**
     * Fast-forward a project to its remote.
     *
     * Deliberately NOT behind isLocalRequest, unlike the sign-in button. That
     * guard exists because opening a terminal hands over the machine; this
     * hands over a fast-forward of a clean checkout, which pull.js keeps dull
     * by construction. Gating it would mean the phone the tunnel was built for
     * is the one device that cannot use it.
     */
    if (url.pathname === '/api/pull' && req.method === 'POST') {
      readBody(req).then(async (payload) => {
        if (!payload?.root) return sendJson(res, 400, { ok: false, error: 'root is required' })

        const result = await pull(payload.root, payload.branch)
        if (result.ok) broadcastState()
        sendJson(res, result.ok ? 200 : 409, result)
      })
      return
    }

    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { settings: settings.read(), modes: settings.PERMISSION_MODES })
      }
      if (req.method === 'POST') {
        readBody(req).then((payload) => {
          if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid JSON' })
          const result = settings.update(payload)
          sendJson(res, result.ok ? 200 : 400, result)
        })
        return
      }
    }

    /*
     * Permission rules. The deck does not keep these — Claude Code does, in
     * the same files a terminal session reads — so this route reads and edits
     * those files in place rather than shadowing them with a copy of our own.
     */
    if (url.pathname === '/api/permissions') {
      if (req.method === 'GET') {
        const root = url.searchParams.get('root') || null
        return sendJson(res, 200, { ...permissions.overview(root), lists: permissions.LISTS })
      }

      if (req.method === 'POST' || req.method === 'DELETE') {
        /*
         * Reading these is reporting; writing one is granting. An allow rule
         * is standing permission for a session to act without stopping to
         * ask, so it may only be written from the machine it governs — never
         * from the phone on the far side of the tunnel, which is exactly the
         * reach this guard exists to withhold.
         */
        if (!isLocalRequest(req)) {
          return sendJson(res, 403, {
            ok: false,
            error: 'Permission rules can only be changed from the machine the deck runs on.',
          })
        }

        readBody(req).then((payload) => {
          if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid JSON' })
          const args = {
            source: payload.source,
            root: payload.root || null,
            list: payload.list,
            rule: payload.rule,
          }
          const result = req.method === 'POST'
            ? permissions.addRule(args)
            : permissions.removeRule(args)
          sendJson(res, result.ok ? 200 : 400, result)
        })
        return
      }
    }

    /*
     * The models a launch may ask for, before there is a session to ask.
     *
     * Answered per folder, because an organisation's allowlist can be set per
     * project, and by the agent manager rather than from a list written down
     * here — which models an account can reach depends on what it has access
     * to, and a model missing from a menu looks exactly like a model that does
     * not exist.
     */
    if (url.pathname === '/api/models' && req.method === 'GET') {
      const cwd = url.searchParams.get('cwd')
      agents
        .catalogue(cwd || process.cwd())
        .then((result) => sendJson(res, 200, result))
        .catch((err) => sendJson(res, 200, { ok: false, error: err?.message || 'Could not read the model list' }))
      return
    }

    /*
     * The teams, each member matched to the session it is now. Matched here
     * rather than in the browser because the matching needs the snapshot, and
     * the snapshot is already built on this side of the wire.
     */
    if (url.pathname === '/api/teams') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          teams: teams.withSessions(snapshot().sessions),
          /*
           * The put-away ones travel with them, plain. They are small, there
           * are at most twenty, and the screen cannot offer one back if it
           * does not know it is there.
           */
          dismissed: teams.dismissed(),
        })
      }
      if (req.method === 'DELETE') {
        readBody(req).then((payload) => {
          const result = teams.forget(payload?.id)
          sendJson(res, result.ok ? 200 : 400, result)
        }).catch(() => sendJson(res, 400, { ok: false, error: 'bad request' }))
        return
      }
      // Putting one back. A POST and not an undo-the-DELETE, because it can be
      // asked for an hour later from a page that never saw the DELETE.
      if (req.method === 'POST') {
        readBody(req).then((payload) => {
          const result = teams.restore(payload?.id)
          sendJson(res, result.ok ? 200 : 400, result)
        }).catch(() => sendJson(res, 400, { ok: false, error: 'bad request' }))
        return
      }
    }

    /*
     * The roles a team can be staffed with — a standing brief, not a task with
     * an end. The launcher's shortcuts live next door and are the other thing:
     * one errand, done when it is done.
     */
    /*
     * A team proposed by a session that did the work.
     *
     * Unlike the roadmap draft, which launches a session to read a document,
     * this one talks to a session that already exists — the whole point is the
     * context it is holding. So it is a message into that conversation, not a
     * new one, and the deck records the request before the answer can arrive.
     */
    if (url.pathname === '/api/team-proposals' && req.method === 'GET') {
      const snap = snapshot()
      return sendJson(res, 200, {
        drafts: teamproposal.list({
          knownRoles: roles.list(),
          knownProjects: snap.projects.filter((p) => p.path),
        }),
      })
    }

    if (url.pathname === '/api/team-proposal' && req.method === 'POST') {
      readBody(req).then((payload) => {
        const deckId = String(payload?.deckId || '')
        const source = `session:${deckId}`

        if (payload?.action === 'dismiss') {
          return sendJson(res, 200, teamproposal.clear(String(payload?.source || source)))
        }

        const snap = snapshot()
        const session = snap.sessions.find((s) => s.deckId === deckId)
        if (!session) return sendJson(res, 400, { ok: false, error: 'No such session' })

        const file = teamproposal.proposalFile(source)
        const prompt = teamproposal.promptFor({
          file,
          source: `the work in this session (${session.name})`,
          note: payload?.note,
          roles: roles.list(),
          projects: snap.projects.filter((p) => p.path),
        })

        /*
         * The request is written down before the message goes out, so a draft
         * in flight survives a restart and the screen can say what it is
         * waiting for rather than showing nothing.
         */
        const opened = teamproposal.open(source, {
          from: session.name,
          note: payload?.note,
          deckId,
        })
        if (!opened.ok) return sendJson(res, 500, opened)

        const said = agents.say(deckId, prompt)
        if (!said?.ok) {
          teamproposal.clear(source)
          return sendJson(res, 400, said || { ok: false, error: 'Could not reach that session' })
        }
        return sendJson(res, 200, { ok: true, source, queued: said.queued })
      }).catch(() => sendJson(res, 400, { ok: false, error: 'bad request' }))
      return
    }

    if (url.pathname === '/api/roles') {
      if (req.method === 'GET') return sendJson(res, 200, { roles: roles.list() })
      if (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PATCH') {
        readBody(req).then((payload) => {
          let result
          if (req.method === 'DELETE') result = roles.remove(payload?.id)
          // PATCH edits one that exists; POST brings a new one in. Separate
          // verbs because they are separate acts, the same way the workspace
          // tells adding a folder from reordering one.
          else if (req.method === 'PATCH') result = roles.update(payload?.id, payload?.patch || {})
          else if (payload?.reset) result = roles.reset()
          else result = roles.add(payload || {})
          sendJson(res, result.ok ? 200 : 400, result)
        }).catch(() => sendJson(res, 400, { ok: false, error: 'bad request' }))
        return
      }
    }

    if (url.pathname === '/api/presets') {
      if (req.method === 'GET') return sendJson(res, 200, { presets: presets.list() })

      if (req.method === 'POST' || req.method === 'DELETE') {
        readBody(req).then((payload) => {
          if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid JSON' })
          const result =
            req.method === 'DELETE'
              ? presets.remove(payload.id)
              : payload.reset
                ? presets.reset()
                : presets.add(payload)
          sendJson(res, result.ok ? 200 : 400, result)
        })
        return
      }
    }

    /**
     * A session's subagents, and what each of them said.
     *
     * Both work on a session the deck never launched: they read the files the
     * session wrote, by id. Two routes rather than one because the list is
     * cheap and polled while you watch it, and a conversation is neither.
     */
    if (url.pathname.startsWith('/api/subagents/')) {
      const sessionId = url.pathname.slice('/api/subagents/'.length)
      store.subagents(sessionId).then(
        (result) => sendJson(res, result.missing ? 404 : 200, { sessionId, ...result }),
        (err) => sendJson(res, 500, { error: err.message }),
      )
      return
    }

    if (url.pathname.startsWith('/api/subagent/')) {
      const [sessionId, agentId] = url.pathname.slice('/api/subagent/'.length).split('/')
      const limit = Number(url.searchParams.get('limit')) || 200
      store.messages(sessionId, agentId, { limit }).then(
        (result) => sendJson(res, result.missing ? 404 : 200, { sessionId, agentId, ...result }),
        (err) => sendJson(res, 500, { error: err.message }),
      )
      return
    }

    if (url.pathname.startsWith('/api/transcript/')) {
      const sessionId = url.pathname.slice('/api/transcript/'.length)
      const file = findTranscript(sessionId)
      if (!file) return sendJson(res, 404, { error: 'transcript not found', sessionId })
      const limit = Number(url.searchParams.get('limit')) || 60
      return sendJson(res, 200, { sessionId, ...readTranscript(file, { limit }) })
    }

    /**
     * The pairing link, for the panel to draw as a QR when the terminal that
     * printed one has long since scrolled away.
     *
     * Local-only, unlike almost everything else here. A paired phone is
     * authorised to *use* this deck; handing it the token would make it able to
     * pair further devices, and a credential that can mint more copies of
     * itself is not something a phone on a café network should hold.
     */
    if (url.pathname === '/api/auth') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Only from this machine' })
      const address = server.address()
      const host = req.headers.host || `127.0.0.1:${address?.port || ''}`

      /*
       * A second device arrives one of two ways, and only one of them is
       * visible from in here.
       *
       * Bound to every interface, the phone dials this port directly and we
       * can work the address out ourselves. Behind something that listens for
       * us and forwards — a tunnel, a reverse proxy, `tailscale serve` — the
       * deck still sees nothing but loopback, and guessing from that alone is
       * how it used to tell people with a working setup that they had none.
       * Only whoever configured the proxy knows its address, so they pass it
       * in with --public-url.
       */
      const bound = address?.address === '0.0.0.0' || address?.address === '::'
      const lan = bound ? auth.lanAddress() : null
      const origin = publicUrl || (lan ? `http://${lan}:${address.port}` : null)

      return sendJson(res, 200, {
        url: auth.pairingUrl(`http://${host}`),
        // Reachability is the existence of an address another device can use,
        // not the bind alone: bound wide open with no network address found,
        // there is still nothing to put in a QR.
        remote: origin ? auth.pairingUrl(origin) : null,
        reachable: Boolean(origin),
        via: origin ? (publicUrl ? 'public' : 'lan') : null,
        pin: auth.hasPin(),
        pinMin: auth.PIN_MIN,
      })
    }

    /*
     * Setting the PIN is local-only, exactly like the pairing key it stands
     * in for. A paired phone may drive this deck; letting it choose the
     * credential that admits further devices would hand it the one power the
     * pairing page is withheld from it to deny.
     */
    if (url.pathname === '/api/auth/pin' && req.method === 'POST') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Only from this machine' })
      return readBody(req).then((body) =>
        auth.setPin(body?.pin).then((result) => sendJson(res, result.ok ? 200 : 400, result)))
    }

    if (url.pathname === '/api/auth/pin' && req.method === 'DELETE') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Only from this machine' })
      return sendJson(res, 200, auth.clearPin())
    }

    if (url.pathname === '/api/auth/rotate' && req.method === 'POST') {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Only from this machine' })
      const next = auth.rotate()

      // Re-pair the browser that asked, in the same response. Revoking is for
      // kicking out the devices you no longer trust — locking yourself out of
      // the panel you clicked the button in would be a booby trap.
      res.setHeader('set-cookie', auth.cookieHeader(next))

      // A socket is only checked when it is opened, so every device already
      // connected would keep streaming transcripts through a connection the
      // old token bought. Dropping them all is what makes this a revocation
      // rather than a rename: the trusted browser reconnects by itself a
      // second later with the cookie it was just given, and nothing else can.
      for (const client of wss.clients) client.terminate()

      const address = server.address()
      const host = req.headers.host || `127.0.0.1:${address?.port || ''}`
      const open = address?.address === '0.0.0.0' || address?.address === '::'
      const lan = open ? auth.lanAddress() : null

      return sendJson(res, 200, {
        ok: true,
        url: auth.pairingUrl(`http://${host}`),
        lan: lan ? auth.pairingUrl(`http://${lan}:${address.port}`) : null,
        reachable: Boolean(open),
        // Always false — rotating clears the PIN — but said rather than
        // implied, so a caller reading this never has to know that to be right.
        pin: auth.hasPin(),
      })
    }

    if (url.pathname === '/api/health') {
      // `local` tells the UI whether to offer controls that act on this
      // machine, instead of offering them and failing on the click.
      return sendJson(res, 200, {
        ok: true,
        platform: process.platform,
        pid: process.pid,
        local: isLocalRequest(req),
      })
    }

    return serveStatic(req, res)
  })

  /**
   * The control plane lives on this socket — launch, say, permission, stop —
   * so it is checked exactly as hard as the HTTP side, and for a reason the
   * HTTP side does not have: the same-origin policy does not apply to
   * WebSockets. A page on any domain may open one to localhost, and the
   * browser will attach the cookie while doing it. `authorize` refuses that on
   * the `Origin` header; without this hook the socket would be the way in.
   */
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient({ req }, done) {
      const url = new URL(req.url, 'http://localhost')
      if (auth.authorize(req, url).ok) return done(true)
      // An explicit 401 rather than a silent drop, so the panel's reconnect
      // loop is distinguishable from a server that is simply not there.
      done(false, 401, 'Unauthorized')
    },
  })

  // `ws` re-emits, on this instance, the errors of the HTTP server it is
  // attached to. Without this listener an EADDRINUSE becomes an unhandled
  // 'error' and kills the process before cli.js can try the next port —
  // which is exactly what that retry exists to avoid.
  wss.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') console.error(`websocket: ${err.message}`)
  })
  const watcher = watchSessions()

  function broadcast(payload) {
    const data = JSON.stringify(payload)
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data)
    }
  }

  function broadcastState() {
    const state = snapshot()
    broadcast({ type: 'sessions', ...state })
  }

  // One notification per transition into 'waiting'. This is the event that
  // justifies the whole tool: a session blocked waiting on you.
  watcher.on('attention', (session) => {
    /*
     * Only for projects the deck is watching. This event comes straight off
     * the registry watcher rather than through snapshot(), so it would
     * otherwise knock on your desktop about a session the sidebar refuses to
     * show — an alert you cannot act on, for a repo you did not add.
     */
    const roots = new Set(workspace.list().map((f) => f.path))
    const ours = session.sessionId && agents.bySessionId().has(session.sessionId)
    if (!ours && !roots.has(session.projectPath)) return

    if (notifications) {
      notify({
        title: `${session.project} needs you`,
        subtitle: session.name,
        message: session.waitingFor || 'Session is waiting on your answer',
      })
    }
    broadcast({ type: 'attention', session })
  })

  watcher.on('sessions', broadcastState)

  // A managed session changing state is just as much a reason to refresh.
  agents.emitter.on('changed', () => {
    rememberSessions()
    broadcastState()
  })
  agents.emitter.on('permission', (session) => {
    if (notifications) {
      notify({
        // The name you gave the project, so a notification on your phone
        // matches the heading you would go looking for in the menu.
        title: `${workspace.nameFor(resolveProjectRoot(session.cwd).root || session.cwd)} needs you`,
        subtitle: session.pending?.title || 'Permission',
        message: session.pending?.detail || 'Approve or deny in the deck',
      })
    }
    broadcastState()
  })

  wss.on('connection', (socket) => {
    let tail = null
    let hunt = null
    socket.send(JSON.stringify({ type: 'sessions', ...snapshot() }))

    function stopFollowing() {
      tail?.stop()
      tail = null
      clearInterval(hunt)
      hunt = null
    }

    /** Send the transcript and start following it. */
    function follow(sessionId, file) {
      const initial = readTranscript(file, { limit: 60 })
      socket.send(JSON.stringify({
        type: 'transcript',
        sessionId,
        messages: initial.messages,
        total: initial.total,
        meta: initial.meta,
        activity: initial.activity,
        // What the session is actually thinking with, read off its own turns:
        // neither the effort nor the advisor arrives any other way.
        granted: initial.granted,
        // The file map's backlog: what this session has touched so far, so
        // opening the map mid-session shows the work instead of an empty sky.
        events: initial.events,
        eventsTruncated: initial.eventsTruncated,
        replace: true,
      }))
      // Follow from the end of the file: everything before was already sent.
      tail = tailTranscript(file, { fromSize: initial.size })

      /*
       * The file was truncated or rotated under us, so the tail starts again
       * from byte zero. Everything on screen came from bytes that no longer
       * exist, and the batch that follows carries the file from the top — so
       * the panel is told to drop what it has first. Without this the whole
       * transcript arrives as an append and the conversation reads double.
       */
      tail.on('reset', () => {
        if (socket.readyState !== 1) return
        socket.send(JSON.stringify({
          type: 'transcript',
          sessionId,
          messages: [],
          events: [],
          activity: null,
          replace: true,
          // Says "clear what you have", not "here is the session": the meta
          // this message carries none of is still true.
          reset: true,
        }))
      })

      tail.on('update', ({ messages, activity, granted, events, failed }) => {
        if (socket.readyState !== 1) return
        socket.send(JSON.stringify({
          type: 'transcript',
          sessionId,
          messages,
          events,
          failed,
          // Only when this batch actually says something about it. An absent
          // key means "unchanged"; a null means "not on a tool any more".
          ...(activity !== undefined ? { activity } : {}),
          // Same rule. A turn that ran without an advisor sends null, which is
          // news; a batch with no assistant line in it sends nothing at all.
          ...(granted !== undefined ? { granted } : {}),
        }))
      })
    }

    function reply(id, result) {
      if (socket.readyState !== 1) return
      socket.send(JSON.stringify({ type: 'ack', id, ...result }))
    }

    /**
     * Acknowledge a command whatever happens to it.
     *
     * The panel waits fifteen seconds for an ack and then gives up with
     * "timed out" — which is what a rejected promise looks like from the
     * outside, because nothing here was catching one. "Timed out" sends you
     * looking at the session; the error that actually happened would have sent
     * you to the bug.
     */
    function settle(id, promise, { refresh = false } = {}) {
      Promise.resolve(promise)
        .catch((err) => ({ ok: false, error: err?.message || 'the command failed' }))
        .then((result) => {
          reply(id, result)
          if (refresh) broadcastState()
        })
    }

    socket.on('message', (buf) => {
      let msg
      try { msg = JSON.parse(buf.toString()) } catch { return }

      if (msg.type === 'subscribe' && msg.sessionId) {
        stopFollowing()
        const sessionId = msg.sessionId
        const found = findTranscript(sessionId, indexTranscripts())
        if (found) {
          follow(sessionId, found)
          return
        }

        // A session launched from the deck is registered before it has
        // written its first line, so "not found" here is usually "not yet".
        // Keep looking instead of leaving the pane blank forever.
        socket.send(JSON.stringify({ type: 'transcript', sessionId, messages: [], missing: true, replace: true }))
        let tries = 0
        hunt = setInterval(() => {
          tries += 1
          const late = findTranscript(sessionId, indexTranscripts())
          if (late) {
            clearInterval(hunt)
            hunt = null
            follow(sessionId, late)
          } else if (tries >= 60) {
            clearInterval(hunt)
            hunt = null
          }
        }, 1000)
        return
      }

      if (msg.type === 'unsubscribe') {
        stopFollowing()
        return
      }

      // ---- control plane ----

      if (msg.type === 'launch') {
        try {
          // An unrecognised mode from a client must never widen privilege.
          const mode = settings.isValidMode(msg.permissionMode)
            ? msg.permissionMode
            : settings.read().permissionMode
          /*
           * Introductions, resolved here rather than trusted from the
           * browser. The panel picked these names off a list that may be a
           * minute old, and a peer that has exited since is not somebody to
           * tell a new session to go and ask. Resolving against the snapshot
           * this server just built drops the ones that are gone.
           */
          const live = snapshot().sessions
          const peers = resolvePeers(live, msg.peers)
          const session = agents.launch({
            cwd: msg.cwd,
            prompt: msg.prompt,
            /*
             * Passed through rather than folded into the prompt here: the
             * title a session is listed under is derived from the prompt, and
             * it has to be derived from what you typed, not from the briefing
             * that goes in front of it.
             */
            peers,
            name: msg.name,
            permissionMode: mode,
            /*
             * How this one should think. Unvalidated here on purpose: launch()
             * is the funnel every path goes through and it cleans them there,
             * so a value the browser invented becomes the default rather than
             * a string handed to a subprocess. The permission mode above is
             * the exception because it is the one that can widen privilege,
             * and that guard belongs as close to the socket as possible.
             */
            model: msg.model,
            effort: msg.effort,
            advisor: msg.advisor,
            /*
             * Every address currently answering, so the new one does not
             * duplicate it. The CLI takes the name it is given verbatim, and
             * two live sessions under one name is the case where delivery
             * stops being unambiguous.
             */
            taken: live.map((s) => s.peerName || s.name).filter(Boolean),
          })
          reply(msg.id, {
            ok: true,
            deckId: session.deckId,
            /*
             * What actually went in. The browser offered names; some may have
             * died between the click and here, and a launcher that reported
             * success on introductions it did not make would leave you
             * expecting a conversation that cannot happen.
             */
            peers: peers.map((p) => p.name),
            held: heldPeers(peers, mode).map((p) => p.name),
          })
        } catch (err) {
          reply(msg.id, { ok: false, error: err.message })
        }
        broadcastState()
        return
      }

      /*
       * A whole team in one act.
       *
       * The same guards as a single launch and for the same reasons — one mode
       * for everybody, validated here because this is the one that can widen
       * privilege; peers resolved against the snapshot this server just built
       * rather than trusted from a browser.
       *
       * One mode for the team and not one per member is not a simplification.
       * Delivery between two sessions is decided by permission-mode parity: a
       * coordinator that bypasses prompts, talking to specialists that ask for
       * them, gets silence rather than an error. A team assembled across that
       * line would look like it was working and would not be.
       */
      if (msg.type === 'team') {
        try {
          const mode = settings.isValidMode(msg.permissionMode)
            ? msg.permissionMode
            : settings.read().permissionMode
          const live = snapshot().sessions
          const peers = resolvePeers(live, msg.peers)
          const members = Array.isArray(msg.members) ? msg.members : []
          if (members.length === 0) {
            reply(msg.id, { ok: false, error: 'A team needs at least one member' })
            return
          }

          const results = agents.launchTeam({
            members,
            permissionMode: mode,
            peers,
            taken: live.map((s) => s.peerName || s.name).filter(Boolean),
          })

          /*
           * `ok` for the batch means every member started, and the per-member
           * results travel either way. A team where three came up and one did
           * not is not a failure to be retried wholesale — the three are
           * running — so the panel is given what it needs to say exactly that.
           */
          /*
           * Written down before the reply goes out. A team the deck does not
           * remember is four sessions that happen to have started together,
           * indistinguishable from everything else running a minute later —
           * which is the difference between a screen about teams and the
           * session list wearing columns.
           *
           * Only the ones that started: a member with no deckId has no
           * process and never had one.
           */
          const started = results.filter((r) => r.ok)
          const saved = started.length > 0
            ? teams.remember({
              name: msg.name,
              goal: msg.goal,
              members: started.map((r) => {
                /*
                 * By position, never by name. Two members of the same role are
                 * called the same thing on purpose, and matching on the name
                 * handed both of them the first one's properties — which put
                 * every Analyst on the "hands out the work" row.
                 */
                const asked = members[r.at] || {}
                return {
                  deckId: r.deckId,
                  label: r.label,
                  address: r.name,
                  project: asked.project || '',
                  delegates: Boolean(asked.delegates),
                }
              }),
            })
            : { ok: false }

          /*
           * Raised from a proposal: the seats that started are marked on it
           * rather than the whole draft being thrown away. A proposal that
           * says "raise these three now and the rest after a decision" would
           * otherwise lose its second half at the first raise. Once every
           * fillable seat has gone, the draft goes with it — the question has
           * been answered.
           *
           * Its own try, because by this line the sessions are running and
           * the team is written down. This is bookkeeping on the draft that
           * suggested them, and when it threw — it did, on an undefined
           * variable — the batch's catch answered "no session was launched"
           * over four sessions that had just started. A failure here is a
           * draft that stays on screen, which you can see and dismiss. It is
           * not a launch that did not happen, and must never claim to be.
           */
          if (msg?.fromProposal && started.length > 0) {
            try {
              teamproposal.markRaised(String(msg.fromProposal), {
                members: started.map((r) => members[r.at]).filter(Boolean),
                teamId: saved.ok ? saved.team.id : null,
              })
              const left = teamproposal.read(String(msg.fromProposal), {
                knownRoles: roles.list(),
                knownProjects: snapshot().projects.filter((p) => p.path),
              })
              if (left?.allRaised) teamproposal.clear(String(msg.fromProposal))
            } catch (err) {
              console.error(`team raised, proposal not updated: ${err.message}`)
            }
          }

          reply(msg.id, {
            ok: results.every((r) => r.ok),
            results,
            teamId: saved.ok ? saved.team.id : null,
            held: heldPeers(peers, mode).map((p) => p.name),
          })
        } catch (err) {
          reply(msg.id, { ok: false, error: err.message })
        }
        broadcastState()
        return
      }

      if (msg.type === 'permission') {
        reply(msg.id, agents.respond(msg.deckId, msg.requestId, msg.decision))
        return
      }

      if (msg.type === 'answer') {
        reply(msg.id, agents.answerQuestion(msg.deckId, msg.requestId, msg.answers))
        return
      }

      if (msg.type === 'say') {
        reply(msg.id, agents.say(msg.deckId, msg.text, msg.images, msg.files, msg.documents))
        return
      }

      /*
       * Two names, and which one you are setting depends on what the session
       * is. A session the deck launched has the deck's own label, and
       * renaming publishes a 'changed' event that is already wired to
       * broadcastState. A session the deck only watches has no such label —
       * so this writes the name Claude Code itself keeps, which is the one
       * its prompt box and its `/resume` picker show.
       */
      if (msg.type === 'rename') {
        if (msg.deckId) {
          reply(msg.id, agents.rename(msg.deckId, msg.name))
          return
        }
        store.retitle(msg.sessionId, msg.name).then((result) => {
          reply(msg.id, result)
          // Nothing else will announce this one: the registry file the
          // sidebar reads is not what we just wrote.
          if (result.ok) broadcastState()
        })
        return
      }

      /** A tag on a session, for grouping sessions the deck did not launch. */
      if (msg.type === 'tag') {
        store.retag(msg.sessionId, msg.tag).then((result) => {
          reply(msg.id, result)
          if (result.ok) broadcastState()
        })
        return
      }

      /*
       * The × on the progress strip. Only ever sends an empty list today,
       * but it takes one rather than being a `clearTodos` verb: the session
       * writes this field through its own tool, and a second way to set it
       * that could only ever unset it would be the odd one out.
       *
       * agents.setTodos publishes, which reaches the browser through the
       * 'changed' handler like any other state change — so there is no
       * broadcastState() here, unlike `rename` above, where the thing that
       * changed was a file on disk that nothing else watches.
       */
      if (msg.type === 'todos') {
        reply(msg.id, agents.setTodos(msg.deckId, msg.todos))
        return
      }

      if (msg.type === 'interrupt') {
        agents.interrupt(msg.deckId).then((r) => reply(msg.id, r))
        return
      }

      if (msg.type === 'mode') {
        if (!settings.isValidMode(msg.permissionMode)) {
          reply(msg.id, { ok: false, error: 'Unknown permission mode' })
          return
        }
        agents.setMode(msg.deckId, msg.permissionMode).then((r) => reply(msg.id, r))
        return
      }

      /*
       * How full the context is. Asked for rather than pushed: it changes only
       * when a turn ends, and putting it in the broadcast state would mean a
       * control request per managed session per second for a number nobody is
       * looking at unless a session pane is open.
       */
      if (msg.type === 'context') {
        settle(msg.id, agents.contextUsage(msg.deckId))
        return
      }

      /*
       * What this session can run on, and what it should run as. Three
       * commands rather than one settings blob: they are asked at different
       * moments — the list only when a menu opens, the two setters only when
       * you choose — and a blob would fetch the list on every change.
       */
      if (msg.type === 'models') {
        settle(msg.id, agents.models(msg.deckId))
        return
      }

      if (msg.type === 'model') {
        settle(msg.id, agents.setModel(msg.deckId, msg.model))
        return
      }

      if (msg.type === 'effort') {
        settle(msg.id, agents.setEffort(msg.deckId, msg.effort))
        return
      }


      /*
       * Put the process back without saying anything. `refresh` because the
       * session goes from having no process to having one, which is a change
       * every panel's list should see, not only the one that pressed it.
       */
      if (msg.type === 'wake') {
        // One or a set, same command. A team coming back after a restart is
        // the ordinary reason for the plural, and which sessions are in it is
        // the panel's question to answer, not this one's.
        settle(
          msg.id,
          Array.isArray(msg.deckIds) ? agents.wakeMany(msg.deckIds) : agents.wake(msg.deckId),
          { refresh: true },
        )
        return
      }

      if (msg.type === 'stop') {
        // The session is gone from the registry the moment its process exits;
        // push the new list rather than waiting for the next poll.
        settle(msg.id, agents.stop(msg.deckId), { refresh: true })
        return
      }

      /*
       * Take charge of a conversation that is already on disk — one from the
       * project's history, or one this deck was driving before it restarted.
       *
       * The cwd comes from the caller because that is the one thing the
       * transcript does not reliably carry, and it is what the resumed session
       * will actually run in. It is checked here rather than trusted: this
       * command reaches the deck from a phone on the LAN, and "resume this
       * conversation in that directory" is a sentence with real consequences.
       */
      if (msg.type === 'reopen') {
        const cwd = typeof msg.cwd === 'string' ? msg.cwd : ''
        if (!cwd || !fs.existsSync(cwd)) {
          reply(msg.id, { ok: false, error: 'that folder is not there any more' })
          return
        }
        /*
         * Refused if that conversation is already being written to. Resuming a
         * session that is live in somebody's terminal would put a second
         * process on the same transcript, each appending without seeing the
         * other — and the panel hides the button in that case, which is
         * exactly why the check has to exist here too: the button is not the
         * only way this message arrives.
         */
        if (readSessions().some((s) => s.sessionId === msg.sessionId)) {
          reply(msg.id, { ok: false, error: 'that session is running right now' })
          return
        }
        const result = agents.adopt({
          sessionId: msg.sessionId,
          cwd,
          name: msg.name,
          permissionMode: msg.permissionMode || settings.read().permissionMode,
        })
        reply(msg.id, result)
        if (result.ok) broadcastState()
        return
      }

      /*
       * The same button for a session the deck did not launch. There is no
       * deckId to aim at — only the pid it publishes — so this goes through
       * the registry, which refuses any pid that is not a live session right
       * now. Deliberately separate from 'stop': one unwinds a session we own,
       * the other ends somebody else's process, and collapsing them into one
       * command would make that difference invisible at the call site.
       */
      if (msg.type === 'kill') {
        settle(msg.id, killSession(msg.pid, { expectSessionId: msg.sessionId || null }), { refresh: true })
        return
      }

      /*
       * Nothing matched. Falling off the end of this chain in silence is how a
       * command the deck does not know becomes a fifteen-second spinner ending
       * in "timed out" — which reads as a session that has hung, and sends you
       * to debug the wrong thing entirely. The usual cause is mundane: the
       * panel was rebuilt and the server was not restarted, so the two are a
       * version apart. Say that, rather than nothing.
       */
      if (msg.id) {
        reply(msg.id, {
          ok: false,
          error: `this deck does not understand "${msg.type}" — the panel is newer than the server it is talking to, which a restart fixes`,
        })
      }
    })

    socket.on('close', stopFollowing)
    socket.on('error', stopFollowing)
  })

  /**
   * Tearing down the sessions is the only asynchronous part, so close()
   * resolves once their processes are gone. A caller that exits without
   * awaiting it orphans them.
   */
  const close = async ({ grace = 20000 } = {}) => {
    watcher.stop()

    /*
     * Suspended, not stopped. The processes still have to go — they are our
     * children and would be orphaned otherwise — but the conversations are
     * written down on the way out so the next deck can pick them up. Each
     * session is given the grace period to finish the turn it is on first,
     * because the part of a turn that never reaches the transcript is exactly
     * the part that cannot be resumed.
     */
    await agents.suspendAll({ grace })

    // The last write, and the one that has to be synchronous with the exit:
    // the debounced timer above may never fire again.
    if (handoffTimer) { clearTimeout(handoffTimer); handoffTimer = null }
    handoff.remember(agents.list())

    for (const c of wss.clients) c.terminate()
    wss.close()
    server.close()
  }

  return { server, close, agents, busyCount: () => agents.busyCount() }
}
