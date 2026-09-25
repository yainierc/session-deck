import { useCallback, useEffect, useState } from 'react'
import { signIn, SignInNotice, Dot } from './signin.jsx'

/**
 * Who the deck is, everywhere it looks.
 *
 * The panel quietly depends on being signed in to several places at once — a
 * personal GitHub account, a work one, an Azure DevOps organisation or four —
 * and when one of them lapses the symptom is a queue that looks calm. There
 * is nothing to click and nothing to read; the work is simply not there.
 *
 * So this panel is built around the failure, not the happy path. The account
 * list is the easy half and answers little on its own: being logged in says
 * nothing about whether that login can read *your* repositories. The table at
 * the bottom is the one that answers the question people actually arrive
 * with, which is "why is this project showing me nothing".
 */

const STATE_LABEL = {
  ok: 'signed in',
  'needs-login': 'needs sign-in',
  error: 'unreachable',
  unknown: 'unknown',
}

export default function Accounts({ tabs }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [started, setStarted] = useState(null)

  const load = useCallback((refresh) => {
    setLoading(true)
    fetch(`/api/accounts${refresh ? '?refresh=1' : ''}`)
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.error)
        setData(body)
        setError(null)
      })
      .catch(() => setError('Could not read your accounts'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(false) }, [load])

  async function startSignIn(payload, label) {
    setStarted({ label, ...(await signIn(payload)) })
  }

  // Coming back from the terminal is the moment the answer has changed, and
  // the moment you would otherwise have to remember to press Re-check.
  useEffect(() => {
    if (!started?.ok) return
    function recheck() { if (!document.hidden) load(true) }
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [started, load])

  const github = data?.github
  const ado = data?.ado
  const claude = data?.claude
  const repos = data?.repos || []
  const canSignIn = Boolean(data?.local)

  // What is worth saying in one line at the top: the things that are wrong.
  // Claude leads it when it is the thing that is wrong, because it is not one
  // more broken account among four — it is the one that stops the deck.
  const claudeBroken = claude && (claude.state === 'out' || claude.state === 'missing')
  const broken = [
    ...(claudeBroken ? ['Claude'] : []),
    ...(github?.accounts || []).filter((a) => !a.ok).map((a) => a.login),
    ...(ado?.orgs || []).filter((o) => o.state !== 'ok').map((o) => o.org),
  ]

  let summary
  if (loading && !data) summary = 'checking...'
  else if (!data) summary = 'unavailable'
  else if (broken.length === 0) summary = 'every account is signed in'
  else summary = `${broken.length} need${broken.length === 1 ? 's' : ''} attention: ${broken.join(', ')}`

  return (
    <main className="stage">
      <header className="stage-head">
        <div>
          <h2>Settings</h2>
          {tabs}
          <p className="stage-sub">{summary}</p>
        </div>
        <div className="stage-right project-actions">
          <button className="btn" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Checking...' : 'Re-check'}
          </button>
        </div>
      </header>

      <div className="transcript">
        {error && <p className="note">{error}</p>}
        {!error && !data && <p className="note">Asking gh and az who you are...</p>}

        <SignInNotice started={started} local={data?.local} />

        {/* The forge half failed on its own. Said here rather than swallowing
            the screen, because the Claude row below still answers the question
            that stops the deck. */}
        {data?.forgeError && (
          <p className="note">
            Could not read your GitHub and Azure accounts ({data.forgeError}). Everything below
            about them is missing rather than empty.
          </p>
        )}

        {claude && (
          <section className="panel-block">
            <h3>
              Claude
              <span className="group-hint">
                {claude.tool === false ? 'the claude CLI is not installed' : 'the account every session runs as'}
              </span>
            </h3>

            {claude.state === 'missing' ? (
              <p className="note">
                The deck launches sessions by running the CLI, so without it there is nothing to
                drive.<code>npm install -g @anthropic-ai/claude-code</code>
              </p>
            ) : (
              <div className="acct-row">
                {/* `provider` is a working setup, not a half-broken one: the
                    credentials are just somebody else's to manage. */}
                <Dot ok={claude.state === 'unknown' ? null : claude.state === 'in' || claude.state === 'provider'} />
                <span className="acct-name">
                  {/* "unknown" must not read as "not signed in" here either —
                      the name column is the line people actually scan. */}
                  {claude.email
                    || (claude.state === 'in' && 'signed in')
                    || (claude.state === 'out' && 'not signed in')
                    || (claude.state === 'provider' && 'authenticated by the cloud provider')
                    || 'could not be read'}
                  {claude.plan && <span className="tag">{claude.plan}</span>}
                </span>
                <span className="acct-meta">{claude.org || ''}</span>
                <span className={`acct-state ${claude.state === 'out' ? 'is-bad' : ''}`}>
                  {claude.state === 'in' && (claude.method === 'apiKey' ? 'API key' : 'signed in')}
                  {claude.state === 'out' && 'not signed in'}
                  {claude.state === 'provider' && claude.provider}
                  {claude.state === 'unknown' && (claude.message || 'unknown')}
                  {claude.state === 'out' && canSignIn && (
                    <button className="btn btn-slim" onClick={() => startSignIn({ target: 'claude' }, 'Claude')}>
                      Sign in
                    </button>
                  )}
                </span>
              </div>
            )}

            {claude.state === 'out' && (
              <p className="acct-foot">
                Every session you start will fail until this is fixed, and it fails out of sight —
                the CLI asks for a browser from inside a subprocess with no terminal to ask in.
                {!canSignIn && <> Run <code>claude auth login</code> on the machine itself.</>}
              </p>
            )}

            {claude.state === 'provider' && (
              <p className="acct-foot">
                {claude.message} — sessions run on {claude.provider} credentials, so signing in to
                a Claude subscription here would change nothing.
              </p>
            )}

            {claude.method === 'apiKey' && (
              <p className="acct-foot">
                Sessions are billed to an API key from the environment, not to a subscription.
                Signing in would not change that while the key is set.
              </p>
            )}
          </section>
        )}

        {github && (
          <section className="panel-block">
            <h3>
              GitHub <span className="count">{github.accounts.length}</span>
              <span className="group-hint">{github.tool || 'gh is not installed'}</span>
            </h3>

            {!github.tool && (
              <p className="note">
                Without the GitHub CLI the deck cannot see pull requests at all.
                <code>brew install gh</code>
              </p>
            )}
            {github.tool && github.accounts.length === 0 && (
              <p className="note">
                No account is signed in.<code>gh auth login</code>
              </p>
            )}

            {github.accounts.map((account) => (
              <div key={`${account.host}/${account.login}`} className="acct-row">
                <Dot ok={account.ok} />
                <span className="acct-name">
                  {account.login}
                  {account.active && <span className="tag">default</span>}
                </span>
                <span className="acct-meta">{account.scopes || ''}</span>
                <span className={`acct-state ${account.ok ? '' : 'is-bad'}`}>
                  {account.ok ? 'signed in' : account.error || 'token rejected'}
                  {!account.ok && canSignIn && (
                    <button className="btn btn-slim" onClick={() => startSignIn({ target: 'github' }, account.login)}>
                      Fix
                    </button>
                  )}
                </span>
              </div>
            ))}

            {(github.accounts.length > 0 || github.tool) && (
              <p className="acct-foot">
                The deck picks an account per repository, so these do not compete — the
                <span className="tag">default</span> only matters to gh on the command line.
                {canSignIn ? (
                  <button className="btn btn-slim" onClick={() => startSignIn({ target: 'github' }, 'GitHub')}>
                    Add an account
                  </button>
                ) : (
                  <>Add another with <code>gh auth login</code>.</>
                )}
              </p>
            )}
          </section>
        )}

        {ado && (
          <section className="panel-block">
            <h3>
              Azure DevOps <span className="count">{ado.orgs.length}</span>
              <span className="group-hint">{ado.tool || 'Azure CLI is not installed'}</span>
            </h3>

            {ado.tool && (
              <div className="acct-row">
                <Dot ok={Boolean(ado.identity)} />
                <span className="acct-name">{ado.identity || 'not signed in'}</span>
                <span className="acct-meta">{ado.tenant || ''}</span>
                <span className="acct-state">
                  {ado.identity ? 'az login' : 'not signed in'}
                  {!ado.identity && canSignIn && (
                    <button className="btn btn-slim" onClick={() => startSignIn({ target: 'azure' }, 'Azure')}>
                      Sign in
                    </button>
                  )}
                </span>
              </div>
            )}

            {ado.orgs.length === 0 && <p className="note">No Azure DevOps repository in your workspace.</p>}

            {ado.orgs.map((org) => (
              <div key={org.org} className="acct-row">
                <Dot ok={org.state === 'ok' ? true : org.state === 'unknown' ? null : false} />
                <span className="acct-name">{org.org}</span>
                <span className="acct-meta">
                  {org.repos} {org.repos === 1 ? 'repo' : 'repos'}
                  {org.message ? ` — ${org.message}` : ''}
                </span>
                <span className={`acct-state ${org.state === 'ok' ? '' : 'is-bad'}`}>
                  {STATE_LABEL[org.state] || org.state}
                  {/* The command stays visible even with the button there: it
                      is what you need when the terminal is on another Mac. */}
                  {org.hint && <code>{org.hint}</code>}
                  {org.state === 'needs-login' && canSignIn && (
                    <button className="btn btn-slim" onClick={() => startSignIn({ target: 'ado', org: org.org }, org.org)}>
                      Sign in
                    </button>
                  )}
                </span>
              </div>
            ))}

            {/* The honest caveat: one az login does not cover every org. */}
            {ado.orgs.some((o) => o.state === 'needs-login') && (
              <p className="acct-foot">
                Organisations outside the tenant you ran <code>az login</code> for need their own
                sign-in, which means a Personal Access Token created in that organisation.
              </p>
            )}
          </section>
        )}

        {repos.length > 0 && (
          <section className="panel-block">
            <h3>
              Projects <span className="count">{repos.length}</span>
              <span className="group-hint">Which identity reads which repository</span>
            </h3>
            {repos.map((repo) => (
              <div key={repo.path} className="acct-row">
                <Dot ok={repo.kind === null ? null : repo.readable} />
                <span className="acct-name">{repo.name}</span>
                <span className="acct-meta">{repo.label || 'no git remote'}</span>
                <span className={`acct-state ${repo.readable === false ? 'is-bad' : ''}`}>
                  {repo.kind === null ? 'not tracked' : repo.readable ? repo.account : 'nobody can read it'}
                </span>
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  )
}
