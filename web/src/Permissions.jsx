import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * The permissions half of settings.
 *
 * What this screen exists to answer is not "what are my rules" but "why does
 * it keep asking me". The answer is almost always one of two things, and both
 * are invisible until you see the rules laid out by file:
 *
 *   - the rule was saved for one project, and you are now in another
 *   - the rule names one exact command, so the next command asks again
 *
 * So the grouping is by where a rule is written, never a merged list: a
 * merged list would show you a hundred rules in force and still not explain
 * the question you came here with.
 *
 * These files belong to Claude Code, not the deck. A terminal session reads
 * the same ones, so anything removed here stops applying there too — which is
 * the point, and is why removal asks first.
 */

const LIST_LABEL = {
  allow: 'Allowed without asking',
  ask: 'Always ask',
  deny: 'Never allowed',
}

/**
 * Rules are dense, repetitive strings. Splitting the tool from its argument
 * lets the eye skip down the arguments, which is the part that differs and
 * the part that explains why a near-identical rule did not match.
 */
function splitRule(rule) {
  const match = /^([A-Za-z_][\w-]*)\((.*)\)$/s.exec(rule)
  if (!match) return { tool: rule, arg: null }
  return { tool: match[1], arg: match[2] }
}

function Rule({ rule, list, source, canEdit, busy, onRemove }) {
  const { tool, arg } = splitRule(rule)
  return (
    <li className="perm-rule">
      <code className="perm-tool">{tool}</code>
      {arg !== null && <code className="perm-arg">{arg}</code>}
      {canEdit && (
        <button
          className="btn btn-slim perm-drop"
          disabled={busy}
          onClick={() => onRemove(source, list, rule)}
          title="Remove this rule"
          aria-label={`Remove ${rule}`}
        >
          Remove
        </button>
      )}
    </li>
  )
}

function Source({ source, lists, canEdit, busy, onRemove, onAdd }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [list, setList] = useState('allow')

  const total = lists.reduce((sum, key) => sum + (source.rules?.[key]?.length || 0), 0)

  async function submit(event) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    const ok = await onAdd(source.id, list, text)
    if (ok) { setDraft(''); setAdding(false) }
  }

  return (
    <section className="panel-block perm-source">
      <h3 className="perm-head">
        {source.label}
        <span className="badge badge-quiet">{source.error ? '?' : total}</span>
      </h3>
      <p className="perm-file">
        <code>{source.path}</code>
      </p>
      <p className="note perm-hint">{source.hint}</p>

      {source.error && (
        <p className="perm-error">
          Could not read this file ({source.error}), so its rules are not shown and nothing
          here will write to it.
        </p>
      )}

      {!source.error && total === 0 && (
        <p className="note">
          {source.missing ? 'No file yet.' : 'No rules here.'} Nothing is allowed from this file.
        </p>
      )}

      {!source.error && lists.map((key) => {
        const rules = source.rules?.[key] || []
        if (rules.length === 0) return null
        return (
          <div key={key} className="perm-list">
            <h4 className={`perm-list-head is-${key}`}>
              {LIST_LABEL[key]} <span className="count">{rules.length}</span>
            </h4>
            <ul className="perm-rules">
              {rules.map((rule) => (
                <Rule
                  key={rule}
                  rule={rule}
                  list={key}
                  source={source.id}
                  canEdit={canEdit}
                  busy={busy}
                  onRemove={onRemove}
                />
              ))}
            </ul>
          </div>
        )
      })}

      {canEdit && !source.error && (
        adding ? (
          <form className="perm-add" onSubmit={submit}>
            <select value={list} onChange={(e) => setList(e.target.value)} aria-label="Which list">
              {lists.map((key) => <option key={key} value={key}>{LIST_LABEL[key]}</option>)}
            </select>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Bash(npm run test:*)"
              aria-label="Rule"
            />
            <button className="btn btn-primary btn-slim" type="submit" disabled={busy}>Add</button>
            <button className="btn btn-slim" type="button" onClick={() => setAdding(false)}>Cancel</button>
          </form>
        ) : (
          <button className="btn btn-slim" onClick={() => setAdding(true)}>Add a rule</button>
        )
      )}
    </section>
  )
}

export default function Permissions({ tabs }) {
  const [projects, setProjects] = useState([])
  const [root, setRoot] = useState(null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Writing a rule grants standing permission, so the server only accepts it
  // from the machine it governs. Asking once tells us whether to offer the
  // controls at all, rather than offering them and failing on the click.
  const [canEdit, setCanEdit] = useState(false)
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((body) => setCanEdit(Boolean(body?.local)))
      .catch(() => setCanEdit(false))
  }, [])

  useEffect(() => {
    fetch('/api/state')
      .then((r) => r.json())
      .then((body) => {
        const list = (body.projects || []).filter((p) => p.path && p.path !== 'no project')
        setProjects(list)
        setRoot((current) => current ?? list[0]?.path ?? null)
      })
      .catch(() => { /* the user-wide file still works without a project */ })
  }, [])

  const load = useCallback((target) => {
    setLoading(true)
    const query = target ? `?root=${encodeURIComponent(target)}` : ''
    fetch(`/api/permissions${query}`)
      .then((r) => r.json())
      .then((body) => { setData(body); setError(null) })
      .catch(() => setError('Could not read your permission rules'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(root) }, [load, root])

  // A rule answered in a session lands in one of these files while this
  // screen is open, so coming back to the tab re-reads rather than showing a
  // list that quietly went stale.
  useEffect(() => {
    function refresh() { if (!document.hidden) load(root) }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [load, root])

  const lists = data?.lists || ['allow', 'ask', 'deny']

  async function change(method, source, list, rule) {
    setBusy(true)
    try {
      const res = await fetch('/api/permissions', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, root, list, rule }),
      })
      const body = await res.json()
      if (!body.ok) { setError(body.error || 'That did not work'); return false }
      setError(null)
      load(root)
      return true
    } catch {
      setError('That did not work')
      return false
    } finally {
      setBusy(false)
    }
  }

  function onRemove(source, list, rule) {
    const where = data?.sources?.find((s) => s.id === source)
    const confirmed = window.confirm(
      `Remove this rule?\n\n${rule}\n\nFrom ${where?.file || source}. ` +
      'Sessions will start asking about it again, in the terminal as well as here.'
    )
    if (confirmed) change('DELETE', source, list, rule)
  }

  const onAdd = (source, list, rule) => change('POST', source, list, rule)

  const summary = useMemo(() => {
    if (loading && !data) return 'reading...'
    if (!data) return 'unavailable'
    const { allow = 0, ask = 0, deny = 0 } = data.counts || {}
    if (allow + ask + deny === 0) return 'no rules yet — everything asks'
    const parts = [`${allow} allowed without asking`]
    if (ask) parts.push(`${ask} always ask`)
    if (deny) parts.push(`${deny} never allowed`)
    return parts.join(' · ')
  }, [loading, data])

  return (
    <main className="stage">
      <header className="stage-head">
        <div>
          <h2>Settings</h2>
          {tabs}
          <p className="stage-sub">{summary}</p>
        </div>
        <div className="stage-right project-actions">
          {projects.length > 0 && (
            <select
              className="perm-project"
              value={root || ''}
              onChange={(e) => setRoot(e.target.value || null)}
              aria-label="Which project's rules"
            >
              {projects.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
            </select>
          )}
          <button className="btn" onClick={() => load(root)} disabled={loading}>
            {loading ? 'Reading...' : 'Re-read'}
          </button>
        </div>
      </header>

      <div className="transcript">
        {error && <p className="perm-error">{error}</p>}

        {!canEdit && (
          <p className="note perm-remote">
            Showing rules only. Changing them grants a session standing permission to act
            without asking, so it is allowed only from the machine the deck runs on.
          </p>
        )}

        <p className="note perm-intro">
          A rule that keeps being asked about is usually saved against a different project, or
          written for one exact command. Rules match the command they name and nothing else —
          <code>Bash(npm run build)</code> does not cover <code>npm run test</code>; a pattern
          like <code>Bash(npm run *)</code> does.
        </p>

        {data?.sources?.map((source) => (
          <Source
            key={source.id}
            source={source}
            lists={lists}
            canEdit={canEdit}
            busy={busy}
            onRemove={onRemove}
            onAdd={onAdd}
          />
        ))}
      </div>
    </main>
  )
}
