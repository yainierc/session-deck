import { useCallback, useEffect, useState } from 'react'
import { signIn, SignInNotice, Dot } from './signin.jsx'

/**
 * The MCP half of settings.
 *
 * Same shape as the accounts panel, and for the same reason: a server that
 * needs authenticating is a capability silently missing, not an error anyone
 * ever sees. The difference is that here the sign-in genuinely can be driven
 * from one command — `claude mcp login` — so the button is the whole answer
 * rather than a handoff to a longer story.
 */

const STATE_LABEL = {
  connected: 'connected',
  'needs-auth': 'needs sign-in',
  pending: 'pending approval',
  error: 'not connecting',
}

/**
 * Who a server actually works as, under the row that says it connected.
 *
 * Shown only where the deck can answer it from configuration. The absence of
 * this line is not a clean bill of health — it means this is not a kind of
 * server whose identity we can read.
 */
function Identity({ ado }) {
  return (
    <div className="acct-ident">
      {ado.org && <span className="flag">{ado.org}</span>}
      <span className={`flag ${ado.caveat ? 'is-warn' : 'is-good'}`}>auth {ado.mode}</span>
      {ado.tenant ? (
        <span className="flag">tenant pinned</span>
      ) : (
        ado.mode === 'interactive' && <span className="flag is-warn">no tenant</span>
      )}
      <span className="acct-ident-scope">
        {ado.configs > 1 ? `${ado.configs} configs (${ado.scope} first)` : `${ado.scope} config`}
      </span>
      {ado.caveat && <span className="acct-ident-warn">{ado.caveat}</span>}
    </div>
  )
}

function Server({ server, canSignIn, onSignIn }) {
  const ado = server.ado || null
  const connected = server.state === 'connected'

  // A tick from `claude mcp list` only proves the process answered. Where we
  // know that leaves the identity open, the dot stays unknown rather than
  // green — grey is the honest colour for "connected, but as who?".
  const unverified = connected && Boolean(ado?.caveat)
  const ok = connected ? (unverified ? null : true) : server.state === 'pending' ? null : false

  return (
    <>
      <div className={`acct-row${ado ? ' has-ident' : ''}`}>
        <Dot ok={ok} />
        <span className="acct-name">{server.name}</span>
        <span className="acct-meta">{server.target}</span>
        <span className={`acct-state ${connected ? '' : 'is-bad'}`}>
          <span className="inbox-forge">{server.transport}</span>
          {unverified ? 'connected, identity unverified' : STATE_LABEL[server.state] || server.detail}
          {server.state === 'needs-auth' && canSignIn && (
            <button className="btn btn-slim" onClick={() => onSignIn(server)}>
              Sign in
            </button>
          )}
        </span>
      </div>
      {ado && <Identity ado={ado} />}
    </>
  )
}

export default function Mcp({ tabs }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [started, setStarted] = useState(null)

  const load = useCallback((refresh) => {
    setLoading(true)
    fetch(`/api/mcp${refresh ? '?refresh=1' : ''}`)
      .then((r) => r.json())
      .then((body) => {
        if (body.error && !body.shared) throw new Error(body.error)
        setData(body)
        setError(null)
      })
      .catch(() => setError('Could not list your MCP servers'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(false) }, [load])

  useEffect(() => {
    if (!started?.ok) return
    function recheck() { if (!document.hidden) load(true) }
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [started, load])

  const canSignIn = Boolean(data?.local)
  const shared = data?.shared || []
  const projects = data?.projects || []
  const all = [...shared, ...projects.flatMap((p) => p.servers)]
  // A server whose identity we cannot pin down counts as needing attention:
  // it is the failure that never announces itself, so the summary has to.
  const stuck = all.filter((s) => s.state !== 'connected' || s.ado?.caveat)

  async function onSignIn(server) {
    setStarted(await signIn({ target: 'mcp', server: server.name, cwd: server.path }))
  }

  let summary
  if (loading && !data) summary = 'checking...'
  else if (!data) summary = 'unavailable'
  else if (all.length === 0) summary = 'no MCP servers configured'
  else if (stuck.length === 0) summary = `${all.length} connected`
  else summary = `${stuck.length} of ${all.length} need attention`

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
        {!error && !data && <p className="note">Health-checking every MCP server in your workspace...</p>}

        <SignInNotice started={started} local={data?.local} />

        {shared.length > 0 && (
          <section className="panel-block">
            <h3>
              Everywhere <span className="count">{shared.length}</span>
              <span className="group-hint">Configured globally or by a plugin</span>
            </h3>
            {shared.map((server) => (
              <Server key={`${server.name}:${server.target}`} server={server} canSignIn={canSignIn} onSignIn={onSignIn} />
            ))}
          </section>
        )}

        {projects.map((project) => (
          <section className="panel-block" key={project.path}>
            <h3>
              {project.project} <span className="count">{project.servers.length}</span>
              <span className="group-hint">Only inside this project</span>
            </h3>
            {project.servers.map((server) => (
              <Server key={`${server.name}:${server.target}`} server={server} canSignIn={canSignIn} onSignIn={onSignIn} />
            ))}
          </section>
        ))}

        {data && all.length === 0 && (
          <p className="note">
            No MCP server is configured for the projects in your workspace.
            <code>claude mcp add</code>
          </p>
        )}
      </div>
    </main>
  )
}
