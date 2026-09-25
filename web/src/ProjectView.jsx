import { useCallback, useEffect, useMemo, useState } from 'react'
import { relativeTime, shortPath, STATUS_LABEL } from './format.js'
import Roadmap from './Roadmap.jsx'

/**
 * What you get when you click a folder instead of a session: the shape of
 * the project. Its worktrees (whether or not anything is open in them), its
 * sessions, and whatever subagents are running right now.
 *
 * Its roadmap lives here too, behind a switch rather than below the rest.
 * Overview answers "what is happening in this project", and the roadmap
 * answers "what is this project trying to get done" — two questions that
 * deserve the whole pane each, the same bargain a session's Chat/Map switch
 * makes.
 */
export default function ProjectView({ project, onNewTask, onOpenSession, onOpenPastSession, onRemove }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [view, setView] = useState('overview')
  const [worktrees, setWorktrees] = useState(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (!project?.path) return
    let cancelled = false
    setDetail(null)
    setError(null)

    const load = () => {
      fetch(`/api/project?path=${encodeURIComponent(project.path)}`)
        .then((r) => r.json())
        .then((data) => { if (!cancelled) setDetail(data) })
        .catch(() => { if (!cancelled) setError('Could not read this project') })
    }

    load()
    // Subagents come and go, so the view refreshes while you watch it.
    // Worktree status is NOT on this timer: it shells out to git and gh.
    const timer = setInterval(load, 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [project?.path])

  /*
   * The sessions this project has had. Loaded once per project and
   * deliberately off the four-second timer that refreshes `detail`: this one
   * goes to disk for every transcript directory on the machine, and the list
   * only changes when a session starts or ends — not something worth paying
   * for fifteen times a minute.
   */
  const [history, setHistory] = useState(null)
  useEffect(() => {
    if (!project?.path) return
    let cancelled = false
    setHistory(null)
    fetch(`/api/project-history?path=${encodeURIComponent(project.path)}`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setHistory(data) })
      // A project with no history reads the same as one we could not index:
      // an empty list. Nothing here is worth an error banner over.
      .catch(() => { if (!cancelled) setHistory({ sessions: [], total: 0 }) })
    return () => { cancelled = true }
  }, [project?.path])

  // Git state for the pull control. Separate from `detail` because it is a
  // different cost: detail is on a 4-second timer, this shells out to git.
  const [git, setGit] = useState(null)
  const [branch, setBranch] = useState('')
  const [pulling, setPulling] = useState(false)
  const [pullResult, setPullResult] = useState(null)
  const [fetching, setFetching] = useState(false)

  const loadBranches = useCallback(
    (refresh) => {
      if (!project?.path) return
      if (refresh) setFetching(true)
      fetch(`/api/git-branches?root=${encodeURIComponent(project.path)}${refresh ? '&refresh=1' : ''}`)
        .then((r) => r.json())
        .then((info) => {
          setGit(info)
          // The remembered branch wins, then whatever you are actually on.
          // Falling back to the first is only for a repo that has neither.
          setBranch((previous) => {
            const choices = info.branches || []
            if (previous && choices.includes(previous)) return previous
            if (info.remembered && choices.includes(info.remembered)) return info.remembered
            if (info.current && choices.includes(info.current)) return info.current
            return choices[0] || ''
          })
        })
        .catch(() => setGit({ available: false, error: 'Could not read git in this folder' }))
        .finally(() => setFetching(false))
    },
    [project?.path],
  )

  useEffect(() => {
    setGit(null)
    setBranch('')
    setPullResult(null)
    loadBranches(false)
  }, [loadBranches])

  /** Choosing is not fetching: this only records the preference. */
  function chooseBranch(next) {
    setBranch(next)
    setPullResult(null)
    fetch('/api/pull-branch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: project.path, branch: next }),
    })
      .then((r) => r.json())
      .then((r) => { if (!r.ok) setPullResult({ ok: false, error: r.error }) })
      .catch(() => {})
  }

  async function doPull() {
    setPulling(true)
    setPullResult(null)
    try {
      const response = await fetch('/api/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root: project.path, branch }),
      })
      setPullResult(await response.json())
    } catch {
      setPullResult({ ok: false, error: 'The deck did not answer' })
    } finally {
      setPulling(false)
      loadBranches(false)
    }
  }

  /**
   * Sessions that are editing the same files without knowing it.
   *
   * Two agents in one directory overwrite each other's work, and neither is
   * told — you find out later, reading modification times to reconstruct who
   * did what. The deck has always had the answer sitting in its own session
   * list; it simply never said it out loud.
   *
   * Only a shared working directory counts. Sessions in different worktrees of
   * this project are not a collision — they are the thing worktrees are for.
   */
  const sharing = useMemo(() => {
    const byDirectory = new Map()
    for (const session of detail?.sessions || []) {
      if (!session.cwd) continue
      if (!byDirectory.has(session.cwd)) byDirectory.set(session.cwd, [])
      byDirectory.get(session.cwd).push(session.name)
    }
    return [...byDirectory.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([cwd, names]) => ({ cwd, names }))
  }, [detail])

  const checkWorktrees = useCallback(
    (refresh) => {
      if (!project?.path) return
      setChecking(true)
      fetch(`/api/worktrees?root=${encodeURIComponent(project.path)}${refresh ? '&refresh=1' : ''}`)
        .then((r) => r.json())
        .then((data) => setWorktrees(data.worktrees || []))
        .catch(() => setWorktrees([]))
        .finally(() => setChecking(false))
    },
    [project?.path],
  )

  useEffect(() => {
    setWorktrees(null)
    checkWorktrees(false)
  }, [checkWorktrees])

  async function deleteWorktree(worktree) {
    const ok = window.confirm(
      `Delete the worktree "${worktree.name}"?\n\n` +
        `${worktree.path}\n\nIts branch is already in ${worktree.status?.parent || 'the parent branch'}. ` +
        'This removes the directory from disk. The branch itself is not touched.',
    )
    if (!ok) return
    const response = await fetch('/api/worktree', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: project.path, path: worktree.path }),
    })
    const result = await response.json()
    if (!result.ok) window.alert(result.error || 'Could not delete the worktree')
    checkWorktrees(true)
  }

  if (!project) return null

  return (
    <main className="stage">
      <header className="stage-head">
        <div>
          <h2>{project.name}</h2>
          {/* Under the title rather than beside the buttons: the same call
              the settings header already made, and the reason the
              `.seg-tabs` rule exists. */}
          <div className="seg seg-tabs" role="tablist" aria-label="What to look at in this project">
            {[
              { id: 'overview', label: 'Overview', hint: 'What is happening in it right now' },
              { id: 'roadmap', label: 'Roadmap', hint: 'What it is trying to get done' },
            ].map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={view === tab.id}
                className={`seg-btn${view === tab.id ? ' is-on' : ''}`}
                onClick={() => setView(tab.id)}
                title={tab.hint}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <p className="stage-sub">
            {shortPath(project.path)}
            {detail?.branch && <span className="branch">{detail.branch}</span>}
            {git?.dirty > 0 && <span className="flag is-warn">{git.dirty} uncommitted</span>}
          </p>
        </div>
        <div className="stage-right project-actions">
          {git?.available && git.branches.length > 0 && (
            <span className="pull-control">
              <select
                className="pull-branch"
                value={branch}
                onChange={(e) => chooseBranch(e.target.value)}
                disabled={pulling}
                title="Branch to pull from origin. What you pick is remembered for this project."
              >
                {git.branches.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <button
                className="btn"
                onClick={doPull}
                disabled={pulling || !branch}
                title={`Fast-forward ${git.current} to origin/${branch || '...'}`}
              >
                {pulling ? 'Pulling...' : 'Pull'}
              </button>
              <button className="linkish" onClick={() => loadBranches(true)} disabled={fetching || pulling}>
                {fetching ? 'fetching...' : 'refresh'}
              </button>
            </span>
          )}
          <button className="btn btn-primary" onClick={() => onNewTask(project.path)}>New task</button>
          {project.saved && (
            <button
              className="btn"
              onClick={() => onRemove(project.path)}
              title="Remove from the deck's workspace. The folder is not deleted."
            >
              Stop tracking
            </button>
          )}
        </div>
      </header>

      {view === 'roadmap' && <Roadmap project={project} onOpenSession={onOpenSession} />}

      <div className="transcript" hidden={view !== 'overview'}>
        {pullResult && (
          <div className={`pull-note ${pullResult.ok ? '' : 'is-bad'}`}>
            {pullResult.ok
              ? pullResult.unchanged
                ? pullResult.message
                : `${pullResult.into} fast-forwarded to origin/${pullResult.branch}. ${pullResult.message}`
              : pullResult.error}
          </div>
        )}

        {error && <p className="note">{error}</p>}
        {!detail && !error && <p className="note">Loading...</p>}

        {detail && (
          <>
            <section className="panel-block">
              <h3>
                Sessions <span className="count">{detail.sessions.length}</span>
                {sharing.length > 0 && (
                  <span className="flag is-warn">
                    {sharing.reduce((total, group) => total + group.names.length, 0)} sharing a working tree
                  </span>
                )}
              </h3>

              {sharing.map((group) => (
                <p className="note" key={group.cwd}>
                  <strong>{group.names.join(', ')}</strong> are all working in{' '}
                  {shortPath(group.cwd)}. They edit the same files and cannot see each other, so the
                  last save wins. Give the next one its own worktree and they stop overwriting:
                  <code>git worktree add ../{project.name}-2 -b una-rama-nueva</code>
                </p>
              ))}

              {detail.sessions.length === 0 && (
                <p className="note">Nothing running here. Start something with New task.</p>
              )}
              {detail.sessions.map((s) => (
                <button key={s.deckId || s.pid} className="row" onClick={() => onOpenSession(s)}>
                  <span className={`dot dot-${s.status}`} />
                  <span className="row-name">{s.name}</span>
                  {s.managed && <span className="tag">deck</span>}
                  <span className="row-meta">
                    {s.status === 'waiting'
                      ? (s.waitingFor || 'needs you')
                      : STATUS_LABEL[s.status] || s.status}
                  </span>
                </button>
              ))}
            </section>

            <section className="panel-block">
              <h3>
                History
                {history?.total > 0 && <span className="count">{history.total}</span>}
                <span className="group-hint">Past sessions, newest first</span>
              </h3>

              {!history && <p className="note">Reading transcripts...</p>}
              {history?.sessions.length === 0 && (
                <p className="note">
                  No sessions have run here yet. Once one does, it stays on this
                  list after it ends.
                </p>
              )}

              {history?.sessions.map((h) => {
                // A row that is still running opens the real thing, with its
                // composer and controls, rather than a read-only copy of a
                // conversation that is still moving.
                const live = detail.sessions.find((s) => s.sessionId === h.sessionId)
                return (
                  <button
                    key={h.sessionId}
                    className="row"
                    onClick={() => (live ? onOpenSession(live) : onOpenPastSession(h))}
                  >
                    <span className={`dot dot-${live ? live.status : 'done'}`} />
                    <span className="row-name">{h.title || 'untitled session'}</span>
                    {h.branch && <span className="row-branch">{h.branch}</span>}
                    {/* "live" would be a lie about a session the deck is holding
                        open but not running. Both are in `detail.sessions`; only
                        one of them has a process. */}
                    {live && <span className="tag">{live.status === 'detached' ? 'resumable' : 'live'}</span>}
                    <span className="row-meta">{relativeTime(h.lastActivity)}</span>
                  </button>
                )
              })}

              {history && history.total > history.sessions.length && (
                <p className="note">
                  Showing the last {history.sessions.length} of {history.total}.
                </p>
              )}
            </section>

            <section className="panel-block">
              <h3>Running subagents <span className="count">{detail.subagents.length}</span></h3>
              {detail.subagents.length === 0 && <p className="note">None running.</p>}
              {detail.subagents.map((a) => (
                <div key={a.id} className="row is-static">
                  <span className="dot dot-busy" />
                  <span className="row-name">{a.title}</span>
                  <span className="row-meta">{a.sessionName}</span>
                </div>
              ))}
            </section>

            <section className="panel-block">
              <h3>
                Worktrees <span className="count">{detail.worktrees.length}</span>
                {detail.worktrees.length > 0 && (
                  <button className="linkish" onClick={() => checkWorktrees(true)} disabled={checking}>
                    {checking ? 'checking...' : 'refresh'}
                  </button>
                )}
              </h3>
              {detail.worktrees.length === 0 && <p className="note">This project has no worktrees.</p>}

              {detail.worktrees.map((w) => {
                const live = worktrees?.find((x) => x.path === w.path)
                const status = live?.status
                return (
                  <div key={w.path} className={`worktree ${w.exists ? '' : 'is-stale'}`}>
                    <div className="worktree-line">
                      <span className="row-name">{w.name}</span>
                      {w.branch && <span className="row-branch">{w.branch}</span>}
                      <span className="row-meta">
                        {!w.exists ? 'missing' : w.sessions.length ? w.sessions.join(', ') : 'no session'}
                      </span>
                      {w.exists && (
                        <button className="btn btn-slim" onClick={() => onNewTask(w.path)}>New task</button>
                      )}
                      {status?.safeToDelete && (
                        <button className="btn btn-slim btn-deny" onClick={() => deleteWorktree(live)}>
                          Delete
                        </button>
                      )}
                    </div>

                    {w.exists && (
                      <div className="worktree-status">
                        {!worktrees && <span className="flag">checking...</span>}
                        {status && !status.available && <span className="flag">{status.error}</span>}
                        {status?.available && (
                          <>
                            {status.pr && (
                              <a className={`flag is-pr ${status.pr.state === 'MERGED' ? 'is-good' : ''}`}
                                 href={status.pr.url} target="_blank" rel="noreferrer">
                                PR #{status.pr.number} {status.pr.state.toLowerCase()}
                              </a>
                            )}
                            {status.landed && <span className="flag is-good">in {status.parent}</span>}
                            {status.dirty > 0 && <span className="flag is-warn">{status.dirty} uncommitted</span>}
                            {!status.upstream && status.ahead > 0 && <span className="flag is-warn">never pushed</span>}
                            {status.upstream && status.unpushed > 0 && (
                              <span className="flag is-warn">{status.unpushed} unpushed</span>
                            )}
                            {status.safeToDelete
                              ? <span className="flag is-good">safe to delete</span>
                              : <span className="flag">keep</span>}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          </>
        )}
      </div>
    </main>
  )
}
