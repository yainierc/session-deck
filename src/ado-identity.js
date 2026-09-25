/**
 * ado-identity.js — which Azure DevOps identity a project actually works as.
 *
 * The deck used to answer this once, globally, with `az account show`. That is
 * the identity `az` happens to be logged in as, and for a workspace with one
 * Azure DevOps organisation it is the right answer.
 *
 * It stops being the right answer the moment a project carries its own
 * credential, which is not hypothetical: a project configuring the Azure
 * DevOps MCP server with a Personal Access Token in its `env` is already
 * working as somebody else, and has been all along. The deck reading that same
 * repository as the ambient `az` user then disagrees with the person using it
 * about who they are — so their own pull requests come back as somebody
 * else's, and the inbox quietly files them under other people's work.
 *
 * Being wrong about that is worse than not knowing. So this module goes and
 * looks at what the project is actually configured with, rather than assuming
 * the ambient answer covers it.
 *
 * Everything here is read-only. Claude Code's configuration belongs to Claude
 * Code; the deck reads it exactly the way `permissions.js` does, and writes
 * nothing back.
 */
import fs from 'node:fs'
import path from 'node:path'
import { claudeConfigFile } from './platform.js'

/**
 * The package every Azure DevOps MCP server in the wild is built on. Matched
 * against the whole command line rather than a single argument, because it
 * turns up as an npx argument, a global binary and a local path.
 */
const ADO_MCP = /@azure-devops\/mcp|azure-devops-mcp|mcp-server-azuredevops/i

/**
 * How `@azure-devops/mcp` picks a credential, and which variable each mode
 * actually reads. Taken from the server's own `createAuthenticator`, not from
 * documentation, because the two disagree and only one of them runs.
 *
 * The default is the part that catches people out: with no `-a` flag the
 * server signs in interactively through Entra and caches the result for the
 * whole machine. So a project that sets a token variable without also setting
 * the mode is not using that token — it is using whoever last signed in, and
 * nothing anywhere says so.
 *
 * Deliberately an exact map rather than a pattern over env keys. A loose match
 * would eventually pick up some unrelated token and hand it to Azure DevOps as
 * a credential, and a token sent to the wrong host is the one mistake in this
 * file that cannot be taken back.
 */
const AUTH_MODES = {
  pat: 'PERSONAL_ACCESS_TOKEN',
  envvar: 'ADO_MCP_AUTH_TOKEN',
}

/** The modes that ignore any token in `env` and use an ambient sign-in. */
const AMBIENT_MODES = ['interactive', 'azcli', 'env']

const DEFAULT_MODE = 'interactive'

/**
 * Variables people reasonably expect to work and which nothing reads. Kept so
 * the deck can say "this is being ignored" instead of leaving someone to
 * believe a credential is in force for months.
 */
const DECOY_KEYS = ['AZURE_DEVOPS_PAT', 'AZURE_DEVOPS_EXT_PAT', 'ADO_PAT', 'AZDO_PAT']

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch {
    // Missing or malformed. Either way there is no configuration to read, and
    // guessing at a half-parsed one would be worse than having none.
    return null
  }
}

/**
 * Flags of `@azure-devops/mcp` that take a separate value, so the value is not
 * mistaken for a positional argument. Without this, `... contoso -a pat` reads
 * as an organisation called "pat".
 */
const VALUE_FLAGS = new Set(['-a', '--authentication', '-t', '--tenant', '-d', '--domains'])

/**
 * Split a server's argument list into the organisation and the flags that
 * matter, in one pass rather than three filters that disagree with each other.
 *
 * `npx -y @azure-devops/mcp contoso` — the organisation is positional, so it is
 * the first argument that is neither a flag, a flag's value, nor the package
 * itself. Anything before the package name belongs to the runner (`npx -y`),
 * never to the server.
 */
function parseArgs(rawArgs) {
  const args = (Array.isArray(rawArgs) ? rawArgs : []).map(String)

  const start = args.findIndex((arg) => ADO_MCP.test(arg))
  const own = start >= 0 ? args.slice(start + 1) : args

  let org = null
  let mode = null
  let tenant = null

  const isMode = (flag) => flag === '-a' || flag === '--authentication'
  const isTenant = (flag) => flag === '-t' || flag === '--tenant'

  for (let i = 0; i < own.length; i += 1) {
    const arg = own[i]

    const inline = arg.match(/^(--authentication|-a|--tenant|-t)=(.+)$/)
    if (inline) {
      if (isTenant(inline[1])) tenant = inline[2]
      else mode = inline[2]
      continue
    }
    if (VALUE_FLAGS.has(arg)) {
      if (isMode(arg)) mode = own[i + 1] || null
      else if (isTenant(arg)) tenant = own[i + 1] || null
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    if (!org) org = arg
  }

  return { org, mode, tenant }
}

function orgOf(config, fromArgs) {
  if (fromArgs) return fromArgs

  const env = config.env || {}
  const url = env.AZURE_DEVOPS_ORG_URL || env.ADO_ORG_URL || env.AZURE_DEVOPS_ORG || null
  if (!url) return null
  // Either a bare name or a full https://dev.azure.com/{org} URL.
  const tail = String(url).replace(/\/+$/, '').split('/').filter(Boolean).pop()
  return tail || null
}

/**
 * What a server is really authenticating as, and what it was told to but is
 * not.
 *
 * The second half is the point. `ignored` holding a key means somebody put a
 * credential in this config believing it was in use, and it never was — which
 * is not an error anyone will ever be shown, so the deck has to be the one
 * that shows it.
 */
function credentialOf(config, mode) {
  const env = config.env || {}
  const effective = mode || DEFAULT_MODE
  const key = AUTH_MODES[effective] || null

  const token = key && typeof env[key] === 'string' && env[key].trim() ? env[key].trim() : null
  const ignored = DECOY_KEYS.filter((k) => typeof env[k] === 'string' && env[k].trim() && k !== key)

  return {
    mode: effective,
    ambient: AMBIENT_MODES.includes(effective),
    key,
    token,
    // A mode that needs a token and has none will fail at first use, not at
    // startup — so the server still reports itself connected.
    missing: Boolean(key && !token),
    ignored,
  }
}

function collect(servers, scope, file, out) {
  for (const [name, config] of Object.entries(servers || {})) {
    if (!config || typeof config !== 'object') continue

    const line = [config.command, ...(Array.isArray(config.args) ? config.args : [])].filter(Boolean).join(' ')
    if (!ADO_MCP.test(line)) continue

    const { org, mode, tenant } = parseArgs(config.args)
    out.push({ name, scope, file, org: orgOf(config, org), tenant, ...credentialOf(config, mode) })
  }
}

/**
 * Every Azure DevOps MCP server visible from a project, and how each is
 * authenticated.
 *
 * The three scopes are Claude Code's own, and they are read in the order it
 * resolves them — project file, then this project's entry in the global
 * config, then the servers configured for every project. A name defined twice
 * is reported twice on purpose: which one wins is Claude Code's business, and
 * the fact that there are two is exactly what a person would want told.
 *
 * The returned objects carry a live credential. They are for this process to
 * use and never for the browser to see; `describe()` is the redacted view that
 * is safe to send.
 */
export function adoMcpServersFor(root) {
  const found = []

  if (root) {
    const projectFile = path.join(root, '.mcp.json')
    const projectConfig = readJson(projectFile)
    if (projectConfig) collect(projectConfig.mcpServers, 'project', projectFile, found)
  }

  const globalFile = claudeConfigFile()
  const globalConfig = readJson(globalFile)
  if (globalConfig) {
    if (root) collect(globalConfig.projects?.[root]?.mcpServers, 'local', globalFile, found)
    collect(globalConfig.mcpServers, 'user', globalFile, found)
  }

  return found
}

/**
 * The credential this project already uses for one organisation, if any.
 *
 * Matching on the organisation is the load-bearing part. A token for `fabrikam`
 * is not a token for `contoso`, and using one where the other was meant would
 * turn a wrong answer into a rejected request — or, worse, send a working
 * credential to an organisation it was never issued for.
 */
export function adoCredentialFor(root, org) {
  if (!org) return null
  const wanted = String(org).toLowerCase()

  const servers = adoMcpServersFor(root)
  return servers.find((s) => s.token && String(s.org || '').toLowerCase() === wanted) || null
}

/**
 * What is untrue, or unknowable, about this server's identity — phrased as the
 * thing a person would have to go and do about it. Null when the configuration
 * says exactly who the server works as.
 *
 * The last case is the one worth the whole module. `claude mcp list` prints
 * `✔ Connected` once the process starts and answers; for a server signing in
 * through Entra against `/common`, that happened before any account was picked.
 * The tick is therefore true and says nothing about identity, and a deck that
 * renders it green is repeating a claim nobody made.
 */
function caveatOf(server) {
  if (server.missing) {
    return `Auth mode "${server.mode}" reads ${server.key}, which is not set here — the server starts anyway and fails on its first real request.`
  }
  if (server.ignored.length) {
    return `${server.ignored.join(' and ')} ${server.ignored.length > 1 ? 'are' : 'is'} set but nothing reads ${server.ignored.length > 1 ? 'them' : 'it'} in "${server.mode}" mode — the credential you think is in force is not.`
  }
  if (server.mode === 'interactive' && !server.tenant) {
    return 'Signs in interactively against /common with no tenant pinned, so which account it ends up as is whatever the broker offers. Pass -t <tenant-id> to fix it to one organisation.'
  }
  return null
}

/**
 * What the browser is allowed to know about a server: which identity it works
 * as and where that was decided — never the credential itself, which does not
 * leave this process.
 */
export function describe(server) {
  if (!server) return null
  return {
    server: server.name,
    scope: server.scope,
    org: server.org,
    tenant: server.tenant,
    mode: server.mode,
    ambient: server.ambient,
    hasToken: Boolean(server.token),
    missing: server.missing,
    ignored: server.ignored,
    caveat: caveatOf(server),
  }
}

/**
 * The account behind a Personal Access Token.
 *
 * Azure DevOps will tell you who a credential belongs to through
 * `_apis/connectionData`, which is the only way to find out: a PAT is opaque,
 * and `az account show` describes a different login entirely.
 *
 * Failure here is answered with null rather than an exception. An identity the
 * deck could not establish has to stay unknown, because the caller turns this
 * into "is this pull request mine", and there null means "cannot tell" while a
 * wrong name means "no" — the false answer this whole module exists to stop
 * giving.
 */
export async function identityForPat(org, token, { mode = 'envvar', timeoutMs = 10_000 } = {}) {
  if (!org || !token) return null

  const url = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/connectionData?api-version=7.1-preview.1`
  // The two token modes hand over different things: `pat` stores a value that
  // is already the base64 Basic credential and is used as-is, while `envvar`
  // stores a raw token that still has to be encoded.
  const auth = mode === 'pat' ? token : Buffer.from(`:${token}`).toString('base64')

  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: control.signal,
    })
    if (!response.ok) return null

    const data = await response.json()
    const user = data?.authenticatedUser
    // The sign-in name lives in a property bag; the display name is the
    // fallback, and is what shows for identities that have no account name.
    return user?.properties?.Account?.$value || user?.providerDisplayName || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
