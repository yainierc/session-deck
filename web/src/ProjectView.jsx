import { useCallback, useEffect, useMemo, useState } from 'react'
import { relativeTime, shortPath, STATUS_LABEL } from './format.js'
import { ProjectPlans } from './Plans.jsx'
import { ProjectFiles } from './Files.jsx'

/**
 * What you get when you click a folder instead of a session: the shape of
 * the project. Its worktrees (whether or not anything is open in them), its
 * sessions, and whatever subagents are running right now.
 *
 * Its plans live here too, behind a switch rather than below the rest.
 * Overview answers "what is happening in this project", and the plans tab
 * answers "what is this project trying to get done" — two questions that
 * deserve the whole pane each, the same bargain a session's Chat/Map switch
 * makes.
 */
export default function ProjectView({ project, onNewTask, onOpenSession, onOpenPastSession, onRemove }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [view, setView] = useState('overview')
  const [worktrees, setWorktrees] = useState(null)
  const [tidying, setTidying] = useState(false)
  // How many can be collected right now: the number the batch button needs,
  // and the one figure on this screen that can be acted on in a single go.
  const landedCount = (worktrees || []).filter((w) => w.status?.finished && w.status?.safeToDelete).length
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

  /*
   * Deleting one, in the words of what makes it safe.
   *
   * The old text asserted the branch was already in the parent, which on a
   * repository that squash-merges was false for every worktree it was shown
   * on. Now the reason comes from the status itself, and a worktree whose
   * work has not landed says so instead of claiming the opposite.
   */
  async function deleteWorktree(worktree) {
    const status = worktree.status || {}
    const why = status.finished
      ? `Why this is safe: ${(status.evidence || []).join(' · ')}.`
      : 'This work has NOT landed yet. The branch and its commits stay — on the server too, ' +
        'if it was pushed — so you can bring the worktree back. But it is not finished.'
    const ok = window.confirm(
      `Delete the worktree "${worktree.name}"?\n\n${worktree.path}\n\n${why}\n\n` +
        'This removes the directory from disk. Commits are not deleted: the branch stays.',
    )
    if (!ok) return
    // Asked separately, because it is the step that is not recoverable the
    // same way — and only offered when git itself would allow it.
    const alsoBranch = status.finished && status.branch
      ? window.confirm(`Delete the branch "${status.branch}" too?\n\nGit will refuse if it is not merged.`)
      : false
    const response = await fetch('/api/worktree', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: project.path, path: worktree.path, deleteBranch: alsoBranch }),
    })
    const result = await response.json()
    if (!result.ok) window.alert(result.error || 'Could not delete the worktree')
    else if (alsoBranch && !result.branchDeleted) {
      window.alert(`The worktree is gone. Git kept the branch: ${result.branchError || 'it is not merged'}`)
    }
    checkWorktrees(true)
  }

  /** Everything that landed, in one go. */
  async function tidyWorktrees() {
    const done = (worktrees || []).filter((w) => w.status?.finished && w.status?.safeToDelete)
    if (!done.length) return
    const ok = window.confirm(
      `Remove ${done.length} worktree${done.length === 1 ? '' : 's'} whose work has landed?\n\n` +
        done.map((w) => `· ${w.name} — ${(w.status.evidence || [])[0] || ''}`).join('\n') +
        '\n\nCommits are not deleted. Anything with uncommitted or unpushed work is left alone.',
    )
    if (!ok) return
    const alsoBranches = window.confirm('Delete their branches too?\n\nGit will refuse any that are not merged.')
    setTidying(true)
    const response = await fetch('/api/worktrees/tidy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: project.path, deleteBranches: alsoBranches }),
    })
    const result = await response.json().catch(() => ({ ok: false }))
    setTidying(false)
    if (!result.ok) window.alert(result.error || 'Could not tidy the worktrees')
    else if (result.skipped?.length) {
      window.alert(`Removed ${result.removed.length}. Left alone: ` +
        result.skipped.map((x) => `${x.name} (${x.why})`).join(', '))
    }
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
              { id: 'plans', label: 'Plans', hint: 'What it is trying to get done, read from the repository' },
              { id: 'files', label: 'Files', hint: 'Its folders and files, read-only' },
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

      {/*
        The old roadmap lived exactly here and was never filled in: three
        plans, sixteen milestones, every one of them `done`, abandoned. It
        kept the plan in the deck's own directory, where nobody could read it
        without the deck. This reads the plan the repository already has.
      */}
      {view === 'plans' && <ProjectPlans root={project.path} />}
      {view === 'files' && <ProjectFiles root={project.path} />}

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
                  <code>git worktree add ../{project.name}-2 -b a-new-branch</code>
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
                {landedCount > 0 && (
                  <button className="linkish" onClick={tidyWorktrees} disabled={tidying}>
                    {tidying ? 'removing...' : `tidy ${landedCount} landed`}
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
                            {status.upstreamGone && <span className="flag is-good">remote branch gone</span>}
                            {status.merged === true && <span className="flag is-good">in {status.parent}</span>}
                            {status.atRisk?.map((risk) => (
                              <span className="flag is-warn" key={risk}>{risk}</span>
                            ))}
                            {/*
                              The verdict, and never on its own. "Safe to delete" with nothing
                              beside it is not believed by anybody who has lost a branch once,
                              which is why the reason is rendered next to it.
                            */}
                            {status.state === 'protected' && <span className="flag is-warn">keep — work only here</span>}
                            {status.state === 'integrated' && <span className="flag is-good">landed</span>}
                            {status.state === 'live' && <span className="flag">not landed · nothing would be lost</span>}
                            {status.evidence?.length > 0 && (
                              <span className="flag is-quiet">{status.evidence.join(' · ')}</span>
                            )}
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
