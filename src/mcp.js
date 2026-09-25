/**
 * mcp.js — which MCP servers this workspace has, and which are authenticated.
 *
 * The same question the accounts screen asks about gh and az, asked about the
 * other half of the tooling. An MCP server that quietly needs a login behaves
 * exactly like a logged-out forge: the capability is simply absent, with
 * nothing on screen to say so.
 *
 * The source of truth is `claude mcp list`, not the config file. The config
 * says what was *configured*; only the CLI health-check says what actually
 * connects, and the gap between those two is the entire point of the screen.
 *
 * MCP servers are scoped per project, so this runs the check once per project
 * in the workspace. That costs a few seconds, which is why — like the inbox —
 * it runs on demand and caches.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { IS_WINDOWS } from './platform.js'
import { adoMcpServersFor, describe as describeAdo } from './ado-identity.js'

const run = promisify(execFile)

const cache = new Map()
const TTL_MS = 60_000

/**
 * Read one line of `claude mcp list`.
 *
 * The shape is `name: target [(TRANSPORT)] - status`, and every part of it is
 * awkward: names contain spaces ("my server") and colons
 * ("plugin:example:standards"), targets are URLs or whole command lines. So
 * the split is on the first `": "` and the last `" - "`, which are the only
 * two separators the format actually guarantees.
 */
function parseLine(line) {
  const text = String(line).trim()
  if (!text || /^Checking MCP/i.test(text)) return null

  const nameEnd = text.indexOf(': ')
  if (nameEnd < 0) return null
  const name = text.slice(0, nameEnd).trim()

  const rest = text.slice(nameEnd + 2).trim()
  const statusStart = rest.lastIndexOf(' - ')
  if (statusStart < 0) return null

  let target = rest.slice(0, statusStart).trim()
  const status = rest.slice(statusStart + 3).trim()

  let transport = null
  const tagged = target.match(/\s\((HTTP|SSE|WebSocket|stdio)\)$/i)
  if (tagged) {
    transport = tagged[1]
    target = target.slice(0, tagged.index).trim()
  } else {
    transport = /^https?:\/\//i.test(target) ? 'HTTP' : 'stdio'
  }

  // Strip the leading status glyph (✔ ! ⏸ ✗) without depending on which one.
  const detail = status.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  const lower = detail.toLowerCase()
  const state = lower.includes('connected') ? 'connected'
    : lower.includes('needs authentication') ? 'needs-auth'
    : lower.includes('pending approval') ? 'pending'
    : 'error'

  return { name, target, transport, state, detail }
}

async function serversIn(cwd, refresh) {
  const key = `mcp::${cwd}`
  const hit = cache.get(key)
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.promise

  const promise = (async () => {
    try {
      const { stdout } = await run('claude', ['mcp', 'list'], {
        cwd,
        timeout: 60_000,
        windowsHide: true,
        shell: IS_WINDOWS,
      })
      const servers = String(stdout).split('\n').map(parseLine).filter(Boolean)

      // What the CLI cannot tell us. `claude mcp list` reports whether a server
      // answered, never who it answers as — so for the servers where that
      // difference bites, the configuration is read alongside it.
      const identities = new Map()
      for (const found of adoMcpServersFor(cwd)) {
        const descriptor = describeAdo(found)
        const first = identities.get(found.name)
        if (!first) {
          identities.set(found.name, descriptor)
          continue
        }
        // The same name configured in two scopes. Which one Claude Code loads
        // is its own business and not visible from here; that the two disagree
        // about who the server signs in as is very much our business, and is
        // the only version of this worth interrupting anybody over.
        first.configs = (first.configs || 1) + 1
        if (first.org !== descriptor.org || first.tenant !== descriptor.tenant || first.mode !== descriptor.mode) {
          first.caveat = `Also configured in the ${descriptor.scope} config as a different identity (${descriptor.org || 'no org'}, auth ${descriptor.mode}). Which of the two Claude Code loads is not visible from here.`
        }
      }
      for (const server of servers) {
        const identity = identities.get(server.name)
        if (identity) server.ado = identity
      }

      return { available: true, servers, error: null }
    } catch (err) {
      const text = String(err?.stderr || err?.message || '')
      if (/ENOENT|not found/i.test(text)) {
        return { available: false, servers: [], error: 'The claude CLI is not on PATH' }
      }
      return { available: false, servers: [], error: text.split('\n')[0] || 'Could not list MCP servers' }
    }
  })()

  cache.set(key, { at: Date.now(), promise })
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key) })
  return promise
}

/**
 * Every MCP server reachable from this workspace.
 *
 * Servers configured globally appear in every project, so listing them per
 * project would show the same eight connectors three times. Anything present
 * in every project under the same target is reported once as shared; the rest
 * stay with the project that defines them, because that is where you have to
 * be standing to act on them.
 */
export async function listMcpServers({ roots = [], refresh = false } = {}) {
  const scopes = roots.length ? roots : [process.cwd()]

  const results = await Promise.all(
    scopes.map(async (root) => ({ root, name: path.basename(root), ...(await serversIn(root, refresh)) })),
  )

  const reachable = results.filter((r) => r.available)
  const seen = new Map()
  for (const result of reachable) {
    for (const server of result.servers) {
      const key = `${server.name}::${server.target}`
      if (!seen.has(key)) seen.set(key, { server, roots: [] })
      seen.get(key).roots.push(result.root)
    }
  }

  const shared = []
  const perProject = new Map(reachable.map((r) => [r.root, { project: r.name, path: r.root, servers: [] }]))

  for (const { server, roots: where } of seen.values()) {
    if (reachable.length > 1 && where.length === reachable.length) {
      // Present everywhere: configured globally, so it belongs to no project.
      shared.push({ ...server, scope: 'global', path: where[0] })
    } else {
      for (const root of where) perProject.get(root).servers.push({ ...server, scope: 'project', path: root })
    }
  }

  shared.sort((a, b) => a.name.localeCompare(b.name))
  const projects = [...perProject.values()]
    .filter((p) => p.servers.length > 0)
    .sort((a, b) => a.project.localeCompare(b.project))
  for (const project of projects) project.servers.sort((a, b) => a.name.localeCompare(b.name))

  return {
    available: reachable.length > 0,
    error: reachable.length ? null : results[0]?.error || 'Could not list MCP servers',
    shared,
    projects,
    checkedAt: Date.now(),
  }
}

/**
 * Is this exact (server, project) pair really configured?
 *
 * The whitelist behind the sign-in button. The name reaches the server from
 * the browser and ends up inside a shell command, so it is matched against
 * the live list rather than trusted.
 */
export async function findMcpServer({ roots = [], name, cwd }) {
  const list = await listMcpServers({ roots })
  const candidates = [...list.shared, ...list.projects.flatMap((p) => p.servers)]
  return candidates.find((s) => s.name === name && (!cwd || s.path === cwd)) || null
}
