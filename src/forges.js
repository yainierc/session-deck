/**
 * forges.js — where a repository's pull requests actually live, and which of
 * your identities is allowed to see them.
 *
 * The deck used to assume one thing: `gh`, logged in as whoever happened to be
 * the active account. That holds for exactly one workspace — one person, one
 * GitHub account, no Azure DevOps. The moment a personal repo sits next to a
 * work repo, the active account cannot read half of them, and the panel shows
 * an empty queue that looks calm and is lying.
 *
 * So this module answers two questions per repository, in order:
 *
 *   1. Which forge is this?  — parsed from the origin remote.
 *   2. Who am I here?        — the gh account that can actually read it, or
 *                              the az identity for Azure DevOps.
 *
 * and then normalises both platforms onto one pull request shape, so nothing
 * downstream has to care which one it came from.
 *
 * Everything degrades the same way the rest of the deck does: a missing tool,
 * a logged-out org or no network costs you answers, never correctness. What it
 * must never do is degrade *silently* — an org nobody is signed into comes
 * back as a stated problem, not as zero pull requests.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { IS_WINDOWS } from './platform.js'
import { accountForProject } from './settings.js'

const run = promisify(execFile)

const cache = new Map()

/** Pull request state, like the rest of the deck's git reads. */
const TTL_MS = 30_000

/** Who you are, and which account owns which repo, moves far more slowly. */
const IDENTITY_TTL_MS = 10 * 60_000

/**
 * Memoise by key, storing the promise rather than the resolved value.
 *
 * Storing the promise is the point: buildInbox fans out over every project at
 * once, so half a dozen roots ask "who am I" in the same tick. Caching values
 * would let all of them miss and spawn their own `gh` process.
 */
function cached(key, ttl, refresh, produce) {
  const hit = cache.get(key)
  if (!refresh && hit && Date.now() - hit.at < ttl) return hit.promise

  const promise = produce()
  cache.set(key, { at: Date.now(), promise })
  // A lookup that threw is not an answer worth remembering.
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
  return promise
}

function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || null
}

// ---------------------------------------------------------------------------
// which forge
// ---------------------------------------------------------------------------

function decodeSegment(segment) {
  // Azure DevOps happily puts spaces in project and repository names, so
  // "My Repo" arrives as "My%20Repo".
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function ado(org, project, repo) {
  if (!org || !project || !repo) return null
  return {
    kind: 'ado',
    org,
    project,
    repo,
    orgUrl: `https://dev.azure.com/${encodeURIComponent(org)}`,
    label: `${org}/${project}/${repo}`,
  }
}

/**
 * Read a git remote URL into a forge descriptor.
 *
 * Exported for its own sake: this is the part with all the shapes in it, and
 * it is pure, so it is the part worth being able to test directly.
 */
export function parseRemote(url) {
  if (!url) return null

  let text = url.trim().replace(/\.git$/, '')

  // scp-style (`git@host:owner/repo`) is not a URL until it is rewritten as
  // one. Guarded on `://` so real URLs with a port are left alone.
  if (!text.includes('://')) {
    const scp = text.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/)
    if (!scp) return null
    text = `https://${scp[1]}/${scp[2]}`
  }

  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return null
  }

  const host = parsed.hostname.toLowerCase()
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeSegment)

  if (host === 'github.com' || host === 'www.github.com' || host === 'ssh.github.com') {
    const [owner, repo] = parts
    if (!owner || !repo) return null
    return { kind: 'github', host: 'github.com', owner, repo, slug: `${owner}/${repo}`, label: `${owner}/${repo}` }
  }

  // ssh://git@ssh.dev.azure.com/v3/{org}/{project}/{repo}
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    const marker = parts.indexOf('v3')
    const seg = marker >= 0 ? parts.slice(marker + 1) : parts
    return ado(seg[0], seg[1], seg[2])
  }

  // https://dev.azure.com/{org}/{project}/_git/{repo}
  // https://dev.azure.com/{org}/_git/{repo}   — project name equals the repo
  if (host === 'dev.azure.com') {
    const marker = parts.indexOf('_git')
    if (marker < 1) return null
    const repo = parts[marker + 1]
    return ado(parts[0], marker === 2 ? parts[1] : repo, repo)
  }

  // The legacy https://{org}.visualstudio.com/{project}/_git/{repo}
  if (host.endsWith('.visualstudio.com')) {
    const marker = parts.indexOf('_git')
    if (marker < 0) return null
    const repo = parts[marker + 1]
    return ado(host.slice(0, -'.visualstudio.com'.length), marker >= 1 ? parts[marker - 1] : repo, repo)
  }

  return null
}

export async function detectForge(repoRoot, { refresh = false } = {}) {
  return cached(`forge::${repoRoot}`, IDENTITY_TTL_MS, refresh, async () => {
    try {
      const { stdout } = await run('git', ['remote', 'get-url', 'origin'], {
        cwd: repoRoot,
        timeout: 10_000,
        windowsHide: true,
      })
      return parseRemote(stdout.trim())
    } catch {
      // No remote, or not a repository. Either way there is nothing to ask.
      return null
    }
  })
}

// ---------------------------------------------------------------------------
// GitHub: which of your accounts can read this
// ---------------------------------------------------------------------------

/**
 * Every account gh is logged into, active one first.
 *
 * `gh auth status --json` arrived in 2.40, alongside multi-account support
 * itself. On anything older the fallback is a single account with no login,
 * which means "use whatever gh does by default" — exactly the old behaviour.
 */
async function githubAccounts(refresh) {
  return cached('gh::accounts', IDENTITY_TTL_MS, refresh, async () => {
    try {
      const { stdout } = await run('gh', ['auth', 'status', '--json', 'hosts'], {
        timeout: 8000,
        windowsHide: true,
        shell: IS_WINDOWS,
      })
      const hosts = JSON.parse(stdout || '{}').hosts || {}
      const accounts = []
      for (const [host, list] of Object.entries(hosts)) {
        for (const account of list || []) {
          if (account.state === 'success' && account.login) {
            accounts.push({
              host,
              login: account.login,
              active: Boolean(account.active),
              scopes: account.scopes || null,
            })
          }
        }
      }
      if (!accounts.length) return [{ host: 'github.com', login: null, active: true }]
      // The active account is the right answer more often than not, so it is
      // the one probed first.
      accounts.sort((a, b) => Number(b.active) - Number(a.active))
      return accounts
    } catch {
      return [{ host: 'github.com', login: null, active: true }]
    }
  })
}

/**
 * A token for one account, without making it the active one.
 *
 * `gh auth switch` would be the obvious move and is the wrong one: it is
 * global mutable state, and the deck reads every project concurrently. Two
 * roots wanting different accounts would race and both get the loser's answer.
 * Handing the token to one child process has no such shared state.
 *
 * The value is a credential. It is never logged, never returned to the
 * browser, and never stored by the deck — gh remains the only keystore.
 */
async function tokenFor(account) {
  if (!account?.login) return null
  return cached(`gh::token::${account.host}::${account.login}`, IDENTITY_TTL_MS, false, async () => {
    try {
      const { stdout } = await run('gh', ['auth', 'token', '--hostname', account.host, '--user', account.login], {
        timeout: 8000,
        windowsHide: true,
        shell: IS_WINDOWS,
      })
      return stdout.trim() || null
    } catch {
      return null
    }
  })
}

async function ghEnv(account) {
  const token = await tokenFor(account)
  // GH_TOKEN outranks both the active account and GITHUB_TOKEN, so setting it
  // is enough to pin this one call to this one identity.
  return token ? { ...process.env, GH_TOKEN: token } : process.env
}

/**
 * The account that can actually read a repository.
 *
 * Ownership is the cheap hint — `alice/notebook` is almost certainly the
 * `alice` account — but it only covers personal repos. An organisation like
 * `acme-corp` matches no login, so the answer has to be established rather than
 * guessed: ask the API and see which token gets an answer. One call, then
 * remembered.
 */
async function probeRepo(forge, account) {
  try {
    await run('gh', ['api', `repos/${forge.owner}/${forge.repo}`, '--jq', '.id'], {
      env: await ghEnv(account),
      timeout: 8000,
      windowsHide: true,
      shell: IS_WINDOWS,
    })
    return true
  } catch {
    // This account cannot see it. That is information, not a failure.
    return false
  }
}

async function accountForRepo(forge, { refresh = false, prefer = null } = {}) {
  return cached(`gh::repo::${forge.host}/${forge.slug}::${prefer || 'auto'}`, IDENTITY_TTL_MS, refresh, async () => {
    const accounts = (await githubAccounts(refresh)).filter((a) => a.host === forge.host)

    // An explicit choice wins, and is honoured even if it turns out not to be
    // able to read the repository. Quietly substituting a working account
    // would hide the mistake; the settings screen reports it instead.
    if (prefer) {
      const chosen = accounts.find((a) => a.login === prefer)
      if (chosen) return chosen
    }

    if (accounts.length <= 1) return accounts[0] || null

    const owner = forge.owner.toLowerCase()
    const ordered = [...accounts].sort(
      (a, b) => Number(b.login?.toLowerCase() === owner) - Number(a.login?.toLowerCase() === owner),
    )

    for (const account of ordered) {
      if (await probeRepo(forge, account)) return account
    }
    return null
  })
}

function mapGithubPr(pr, me) {
  const checks = (pr.statusCheckRollup || []).map((c) => c.conclusion || c.state).filter(Boolean)
  const failing = checks.filter((c) => c === 'FAILURE' || c === 'ERROR').length
  const pending = checks.filter((c) => c === 'PENDING' || c === 'IN_PROGRESS').length
  const author = pr.author?.login || null

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: pr.headRefName,
    draft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision || null,
    failing,
    pending,
    // `green` means CI ran and passed. `clear` means nothing is standing in
    // the way, which a repository with no CI at all also satisfies — otherwise
    // every pull request in such a repo is invisible forever.
    green: failing === 0 && pending === 0 && checks.length > 0,
    clear: failing === 0 && pending === 0,
    updatedAt: pr.updatedAt ? Date.parse(pr.updatedAt) : null,
    author,
    // null, never false, when either side is unknown. "Not yours" and "cannot
    // tell" have to stay distinguishable, or a filter built on this would
    // quietly hide your own work.
    mine: me && author ? author.toLowerCase() === me.toLowerCase() : null,
    approved: pr.reviewDecision === 'APPROVED',
    // GitHub reports MERGEABLE / CONFLICTING / UNKNOWN. Only a positive
    // CONFLICTING counts: UNKNOWN means the merge check has not finished.
    conflicted: pr.mergeable === 'CONFLICTING',
    forge: 'github',
  }
}

async function githubPulls(repoRoot, forge, refresh) {
  const account = await accountForRepo(forge, { refresh, prefer: accountForProject(repoRoot) })
  const me = account?.login || null

  try {
    const { stdout } = await run(
      'gh',
      ['pr', 'list', '--state', 'open', '--json',
       'number,title,url,isDraft,reviewDecision,statusCheckRollup,updatedAt,headRefName,author,mergeable',
       '--limit', '20'],
      { cwd: repoRoot, env: await ghEnv(account), timeout: 10_000, windowsHide: true, shell: IS_WINDOWS },
    )
    return { forge, identity: me, prs: JSON.parse(stdout || '[]').map((pr) => mapGithubPr(pr, me)), problem: null }
  } catch (err) {
    const text = String(err?.stderr || err?.message || '')
    // gh not being installed is a fact about the machine, not about this
    // repository, and saying it once per project would be noise.
    if (/ENOENT|not found/i.test(text) && !/repository/i.test(text)) {
      return { forge, identity: me, prs: [], problem: null }
    }
    return {
      forge,
      identity: me,
      prs: [],
      problem: {
        kind: 'auth',
        message: `${forge.label}: no signed-in GitHub account can read this repository`,
        hint: 'gh auth login',
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

/** The account `az` is signed in as, used to tell your pull requests apart. */
async function adoIdentity(refresh) {
  return cached('ado::me', IDENTITY_TTL_MS, refresh, async () => {
    try {
      const { stdout } = await run('az', ['account', 'show', '--query', 'user.name', '-o', 'tsv'], {
        timeout: 20_000,
        windowsHide: true,
        shell: IS_WINDOWS,
      })
      return stdout.trim() || null
    } catch {
      return null
    }
  })
}

function adoPrUrl(pr, forge) {
  const web = pr.repository?.webUrl
  if (web) return `${web}/pullrequest/${pr.pullRequestId}`
  return `${forge.orgUrl}/${encodeURIComponent(forge.project)}/_git/${encodeURIComponent(forge.repo)}/pullrequest/${pr.pullRequestId}`
}

function mapAdoPr(pr, forge, me) {
  // Azure DevOps votes: 10 approved, 5 approved with suggestions, 0 no vote,
  // -5 waiting for the author, -10 rejected.
  const votes = (pr.reviewers || []).map((r) => Number(r.vote) || 0)
  const rejected = votes.some((v) => v < 0)
  const approved = !rejected && votes.some((v) => v >= 5)
  const author = pr.createdBy?.uniqueName || pr.createdBy?.displayName || null

  return {
    number: pr.pullRequestId,
    title: pr.title,
    url: adoPrUrl(pr, forge),
    branch: String(pr.sourceRefName || '').replace(/^refs\/heads\//, ''),
    draft: Boolean(pr.isDraft),
    reviewDecision: rejected ? 'CHANGES_REQUESTED' : approved ? 'APPROVED' : null,
    // Build policy results live behind a separate call per pull request.
    // Rather than pay for that on every refresh, checks are reported as
    // unknown — `clear` but never `green`, so nothing downstream can claim a
    // passing build this never actually looked at.
    failing: 0,
    pending: 0,
    green: false,
    clear: true,
    updatedAt: pr.creationDate ? Date.parse(pr.creationDate) : null,
    author,
    mine: me && author ? author.toLowerCase() === me.toLowerCase() : null,
    approved,
    conflicted: String(pr.mergeStatus || '').toLowerCase() === 'conflicts',
    forge: 'ado',
  }
}

async function adoPulls(repoRoot, forge, refresh) {
  const me = await adoIdentity(refresh)

  try {
    const { stdout } = await run(
      'az',
      ['repos', 'pr', 'list', '--org', forge.orgUrl, '--project', forge.project,
       '--repository', forge.repo, '--status', 'active', '--output', 'json'],
      { cwd: repoRoot, timeout: 45_000, windowsHide: true, shell: IS_WINDOWS },
    )
    return { forge, identity: me, prs: JSON.parse(stdout || '[]').map((pr) => mapAdoPr(pr, forge, me)), problem: null }
  } catch (err) {
    const text = String(err?.stderr || err?.message || '')

    if (/ENOENT|not found/i.test(text) && !/project|repository/i.test(text)) {
      return { forge, identity: me, prs: [], problem: null }
    }

    // An organisation outside the tenant `az login` covers needs its own
    // sign-in. Worth saying plainly, with the command that fixes it.
    if (/az devops login|run the login|TF400813|Unauthorized|\b401\b/i.test(text)) {
      return {
        forge,
        identity: me,
        prs: [],
        problem: {
          kind: 'auth',
          message: `Azure DevOps "${forge.org}" is not signed in`,
          hint: `az devops login --org ${forge.orgUrl}`,
        },
      }
    }

    // Most often a remote pointing at a project that was renamed or removed.
    return {
      forge,
      identity: me,
      prs: [],
      problem: { kind: 'error', message: `Azure DevOps "${forge.label}" could not be read`, hint: firstLine(text) },
    }
  }
}

// ---------------------------------------------------------------------------
// the shared surface
// ---------------------------------------------------------------------------

/**
 * Open pull requests for a repository, whichever forge it lives on.
 *
 * Always resolves to `{ forge, identity, prs, problem }`. `prs` is empty both
 * when there is nothing open and when the lookup failed — `problem` is what
 * tells those two apart, and callers are expected to surface it.
 */
export async function listPullRequests(repoRoot, { refresh = false } = {}) {
  const forge = await detectForge(repoRoot, { refresh })
  if (!forge) return { forge: null, identity: null, prs: [], problem: null }

  // The chosen account is part of the question, so it is part of the key:
  // changing it must not serve the previous account's answer.
  return cached(`prs::${repoRoot}::${accountForProject(repoRoot) || 'auto'}`, TTL_MS, refresh, () =>
    forge.kind === 'github' ? githubPulls(repoRoot, forge, refresh) : adoPulls(repoRoot, forge, refresh),
  )
}

// ---------------------------------------------------------------------------
// the accounts screen
// ---------------------------------------------------------------------------

/** First line of a tool's own version banner, or null when it is not installed. */
async function toolVersion(command, args, match) {
  try {
    const { stdout } = await run(command, args, { timeout: 10_000, windowsHide: true, shell: IS_WINDOWS })
    // az pads its version into columns, so internal runs of spaces collapse.
    const lines = String(stdout).split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean)
    // az also prints an upgrade warning before anything useful, so the caller
    // says which line it actually wants.
    return (match ? lines.find((l) => match.test(l)) : lines[0]) || null
  } catch {
    return null
  }
}

/** Does this account's stored token still work? A logged-in row that 401s is a lie. */
async function verifyGithubAccount(account) {
  try {
    const { stdout } = await run('gh', ['api', 'user', '--jq', '.login'], {
      env: await ghEnv(account),
      timeout: 8000,
      windowsHide: true,
      shell: IS_WINDOWS,
    })
    const login = stdout.trim()
    return login ? { ok: true, login, error: null } : { ok: false, login: null, error: 'No answer from GitHub' }
  } catch (err) {
    return { ok: false, login: null, error: firstLine(err?.stderr || err?.message) || 'Token rejected' }
  }
}

/** Can `az` reach this organisation at all? */
async function adoOrgState(orgUrl) {
  try {
    await run('az', ['devops', 'project', 'list', '--org', orgUrl, '--top', '1', '-o', 'json'], {
      timeout: 45_000,
      windowsHide: true,
      shell: IS_WINDOWS,
    })
    return { state: 'ok', message: null, hint: null }
  } catch (err) {
    const text = String(err?.stderr || err?.message || '')
    if (/az devops login|run the login|TF400813|Unauthorized|\b401\b/i.test(text)) {
      return { state: 'needs-login', message: 'Not signed in to this organisation', hint: `az devops login --org ${orgUrl}` }
    }
    return { state: 'error', message: firstLine(text), hint: null }
  }
}

/**
 * The Azure DevOps organisations this workspace actually points at.
 *
 * Exists to be a whitelist. The sign-in command is a shell string handed to a
 * terminal, so an org name taken from the client would be an injection hole
 * the size of the building. Callers resolve the org against this list and use
 * the `orgUrl` from here, never the one they were sent.
 */
export async function adoOrgsFor(roots = []) {
  const forges = await Promise.all(roots.map((root) => detectForge(root)))
  const orgs = new Map()
  for (const forge of forges) {
    if (forge?.kind === 'ado') orgs.set(forge.org, { org: forge.org, orgUrl: forge.orgUrl })
  }
  return [...orgs.values()]
}

/**
 * Every identity the deck can use, and whether it actually works right now.
 *
 * This exists because the answer was previously spread across three commands
 * in a terminal — `gh auth status`, `az account show`, `az devops project
 * list` per org — and the panel silently depended on all of them. A tool that
 * quietly needs you to be logged into five places owes you one screen saying
 * which of the five you are.
 *
 * Deliberately not just a list of accounts: an account being logged in says
 * nothing about whether it can read *your* repositories. The per-repository
 * mapping is the part that answers "why is this project showing no pull
 * requests", which is the question that actually brings someone here.
 */
export async function accountsOverview({ roots = [], refresh = false } = {}) {
  const detected = await Promise.all(
    roots.map(async (root) => ({ root, forge: await detectForge(root, { refresh }) })),
  )

  const [ghTool, azTool, accounts, azIdentity] = await Promise.all([
    toolVersion('gh', ['--version']),
    toolVersion('az', ['--version'], /^azure-cli/i),
    githubAccounts(refresh),
    (async () => {
      try {
        const { stdout } = await run('az', ['account', 'show', '--query', '{user:user.name,tenant:name}', '-o', 'json'], {
          timeout: 20_000,
          windowsHide: true,
          shell: IS_WINDOWS,
        })
        return JSON.parse(stdout || '{}')
      } catch {
        return {}
      }
    })(),
  ])

  const real = accounts.filter((a) => a.login)
  const githubAccountRows = await Promise.all(
    real.map(async (account) => {
      const check = await verifyGithubAccount(account)
      return { ...account, ok: check.ok, error: check.error }
    }),
  )

  // One row per Azure DevOps organisation, not per repository: the sign-in is
  // per organisation, so that is the unit you can act on.
  const orgs = new Map()
  for (const { forge } of detected) {
    if (forge?.kind !== 'ado') continue
    if (!orgs.has(forge.org)) orgs.set(forge.org, { org: forge.org, orgUrl: forge.orgUrl, repos: 0 })
    orgs.get(forge.org).repos += 1
  }
  const adoOrgRows = await Promise.all(
    [...orgs.values()].map(async (org) => ({ ...org, ...(azTool ? await adoOrgState(org.orgUrl) : { state: 'unknown', message: 'Azure CLI is not installed', hint: null }) })),
  )

  // Which identity reads which repository. The GitHub side is established by
  // asking; Azure DevOps has one sign-in per org, so the org row already
  // carries the answer.
  const repoRows = await Promise.all(
    detected.map(async ({ root, forge }) => {
      const base = { path: root, name: root.split(/[\\/]/).filter(Boolean).pop() }
      if (!forge) return { ...base, kind: null, label: null, account: null, readable: null }
      if (forge.kind === 'ado') {
        const org = adoOrgRows.find((o) => o.org === forge.org)
        return { ...base, kind: 'ado', label: forge.label, account: azIdentity.user || null, readable: org?.state === 'ok' }
      }
      const override = accountForProject(root)
      const account = await accountForRepo(forge, { refresh, prefer: override })
      // The automatic path proves readability by probing, so a resolved
      // account already means "can read it". A forced one proves nothing and
      // has to be checked, or the screen would endorse a choice that does not
      // work — the exact mistake this override makes possible.
      const readable = override && account ? await probeRepo(forge, account) : Boolean(account)
      return {
        ...base,
        kind: 'github',
        label: forge.label,
        account: account?.login || null,
        override: override || null,
        readable,
      }
    }),
  )

  repoRows.sort((a, b) => (a.kind || 'zz').localeCompare(b.kind || 'zz') || (a.label || '').localeCompare(b.label || ''))

  return {
    github: { tool: ghTool, accounts: githubAccountRows },
    ado: { tool: azTool, identity: azIdentity.user || null, tenant: azIdentity.tenant || null, orgs: adoOrgRows },
    repos: repoRows,
    checkedAt: Date.now(),
  }
}

/**
 * The pull request for one branch, in whatever state — what tells a finished
 * worktree from an abandoned one.
 */
export async function pullRequestForBranch(repoRoot, cwd, branch) {
  if (!branch) return null
  const forge = await detectForge(repoRoot)
  if (!forge) return null

  if (forge.kind === 'github') {
    try {
      const { stdout } = await run(
        'gh',
        ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url,title', '--limit', '1'],
        { cwd, env: await ghEnv(await accountForRepo(forge, { prefer: accountForProject(repoRoot) })), timeout: 8000, windowsHide: true, shell: IS_WINDOWS },
      )
      const [pr] = JSON.parse(stdout || '[]')
      return pr ? { number: pr.number, state: pr.state, url: pr.url, title: pr.title } : null
    } catch {
      return null
    }
  }

  try {
    const { stdout } = await run(
      'az',
      ['repos', 'pr', 'list', '--org', forge.orgUrl, '--project', forge.project, '--repository', forge.repo,
       '--source-branch', branch, '--status', 'all', '--output', 'json'],
      { cwd, timeout: 45_000, windowsHide: true, shell: IS_WINDOWS },
    )
    const [pr] = JSON.parse(stdout || '[]')
    if (!pr) return null
    // "completed" is Azure DevOps for merged, and the only state the caller
    // is allowed to read as "this work has landed".
    const status = String(pr.status || '').toLowerCase()
    return {
      number: pr.pullRequestId,
      state: status === 'completed' ? 'MERGED' : status.toUpperCase(),
      url: adoPrUrl(pr, forge),
      title: pr.title,
    }
  } catch {
    return null
  }
}
