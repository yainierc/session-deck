import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Roadmap — what this project is trying to get done, in order.
 *
 * Two things here act. **Start** gives a milestone somewhere to work — a
 * worktree and a branch, and nothing else — and **Run** puts a session in it
 * with the milestone as its task. Neither commits, merges or pushes: the
 * landing strategy is still a choice you make and nothing acts on, and it is
 * here because it is a decision about your repository rather than a detail of
 * the machinery.
 *
 * The order is the point. Until a milestone can declare real dependencies,
 * this list read top to bottom is the only statement the roadmap makes about
 * what has to happen before what — which is why moving one is a first-class
 * control and not a nicety.
 */

const STATUS_LABEL = {
  todo: 'To do',
  doing: 'In progress',
  done: 'Done',
  blocked: 'Blocked',
}

/** The dot the rest of the deck uses, borrowed so a status reads the same. */
const STATUS_DOT = { todo: 'idle', doing: 'busy', done: 'done', blocked: 'waiting' }

const LANDING_LABEL = {
  'merge-per-milestone': 'Merge each milestone as it lands',
  'one-pr': 'One pull request with everything at the end',
}

function Milestone({ milestone, index, count, onUpdate, onRemove, onMove, onStart, onRun, onOpenSession, busy }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(milestone.title)
  const [task, setTask] = useState(milestone.task)
  /*
   * Folded when it is done, open when it is not. A finished milestone is
   * archive: you want to see that it is there and read its title, and the
   * branch it used stopped mattering the moment it landed. Ten of them
   * unfolded is a wall you have to scroll past to reach the work.
   */
  const [open, setOpen] = useState(milestone.status !== 'done')

  function save() {
    setEditing(false)
    const changes = {}
    if (title.trim() !== milestone.title) changes.title = title
    if (task !== milestone.task) changes.task = task
    if (Object.keys(changes).length) onUpdate(milestone.id, changes)
  }

  function cancel() {
    setTitle(milestone.title)
    setTask(milestone.task)
    setEditing(false)
  }

  return (
    <article className={`ms ms-${milestone.status}`}>
      <div className="ms-head">
        {/* The deck's own fold gesture, same chevron as the session header. */}
        <button
          type="button"
          className={`ms-fold ${open ? 'is-open' : ''}`}
          aria-expanded={open}
          aria-label={open ? `Fold ${milestone.title}` : `Unfold ${milestone.title}`}
          onClick={() => setOpen((was) => !was)}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="ms-num">{index + 1}</span>
        <span className={`dot dot-${STATUS_DOT[milestone.status] || 'idle'}`} />

        {editing ? (
          <input
            className="ms-title-edit"
            value={title}
            autoFocus
            maxLength={80}
            aria-label="Milestone title"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); save() }
              if (e.key === 'Escape') { e.preventDefault(); cancel() }
            }}
          />
        ) : (
          <button
            type="button"
            className="ms-title"
            onClick={() => (open ? setEditing(true) : setOpen(true))}
            title={open ? 'Edit this milestone' : 'Unfold this milestone'}
          >
            {milestone.title}
          </button>
        )}

        <select
          className="ms-status"
          value={milestone.status}
          aria-label="Milestone status"
          onChange={(e) => onUpdate(milestone.id, { status: e.target.value })}
          title="Yours to set while nothing else can set it"
        >
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>

        <span className="ms-moves">
          <button type="button" className="linkish" disabled={index === 0} onClick={() => onMove(milestone.id, -1)} title="Earlier">↑</button>
          <button type="button" className="linkish" disabled={index === count - 1} onClick={() => onMove(milestone.id, 1)} title="Later">↓</button>
        </span>
      </div>

      {!open ? null : editing ? (
        <div className="ms-edit">
          <textarea
            className="ms-task-edit"
            value={task}
            rows={5}
            maxLength={4000}
            placeholder="What a session would be told to do here. Write it as a brief someone could act on without this conversation."
            aria-label="Milestone task"
            onChange={(e) => setTask(e.target.value)}
          />
          <div className="ms-edit-row">
            <button className="btn btn-primary btn-slim" onClick={save}>Save</button>
            <button className="btn btn-slim" onClick={cancel}>Cancel</button>
            <button
              className="linkish is-danger"
              onClick={() => { if (window.confirm(`Delete "${milestone.title}"?`)) onRemove(milestone.id) }}
            >
              delete
            </button>
          </div>
        </div>
      ) : (
        <>
          {milestone.task
            ? <p className="ms-task">{milestone.task}</p>
            : <p className="note ms-task">No task written yet — click the title to write what a session should do.</p>}

          <div className="ms-foot">
            {milestone.worktree && !milestone.gone ? (
              /*
               * Started. Its branch and where that lives, then whatever is
               * working in it: a session to launch, one to open, or one that
               * has ended and can be run again.
               */
              <>
                {milestone.session?.live ? (
                  /*
                   * A session blocked on a permission looks exactly like one
                   * working if you only say "open session" — and the deck's
                   * whole reason for existing is that a session waiting on
                   * you should be impossible to miss. Its prompt cannot be
                   * answered from here, so this points at where it can.
                   */
                  <>
                    <button
                      className="btn btn-slim"
                      onClick={() => onOpenSession(milestone.session)}
                      title={milestone.session.status === 'waiting'
                        ? 'This session is blocked on a permission — answer it there'
                        : 'Open the session working on this milestone'}
                    >
                      Open session
                    </button>
                    {milestone.session.status === 'waiting' && (
                      <span className="flag is-warn">needs you</span>
                    )}
                    {milestone.session.status === 'busy' && (
                      <span className="note ms-where">working</span>
                    )}
                  </>
                ) : (
                  <button
                    className="btn btn-slim"
                    onClick={() => onRun(milestone.id)}
                    disabled={busy || !milestone.task?.trim()}
                    title={milestone.task?.trim()
                      ? 'Launch a session in this worktree with this milestone as its task'
                      : 'Write the task first — a session has to be told what to do'}
                  >
                    {busy ? 'Launching...' : milestone.session ? 'Run again' : 'Run'}
                  </button>
                )}
                <span className="ms-branch">{milestone.branch}</span>
                <span className="note ms-where" title={milestone.worktree}>
                  in {milestone.worktree.replace(/^.*\/\.claude\//, '.claude/')}
                  {milestone.base && <> · from <code>{milestone.base}</code></>}
                </span>
                {/*
                  A session that is no longer running is said plainly, with a
                  way back to what it did — the transcript outlives it, and it
                  is the only record of how the milestone got where it is.
                */}
                {milestone.session && !milestone.session.live && (
                  <span className="note ms-where">
                    its session has ended
                    {milestone.session.sessionId && (
                      <> · <button className="linkish" onClick={() => onOpenSession(milestone.session)}>read it</button></>
                    )}
                  </span>
                )}
              </>
            ) : milestone.gone ? (
              /*
               * Its branch is still there; its directory is not. Said out
               * loud, because the alternative is a card that goes on pointing
               * at a path that cannot be opened. Starting again checks the
               * same branch back out rather than making a second one.
               */
              <>
                <button
                  className="btn btn-slim"
                  onClick={() => onStart(milestone.id)}
                  disabled={busy}
                  title={`Check ${milestone.branch} out again at ${milestone.worktree}`}
                >
                  {busy ? 'Starting...' : 'Start again'}
                </button>
                <span className="ms-branch">{milestone.branch}</span>
                <span className="note ms-where">its worktree is gone</span>
              </>
            ) : (
              <>
                <button
                  className="btn btn-slim"
                  onClick={() => onStart(milestone.id)}
                  disabled={busy}
                  title="Create the worktree and branch for this milestone. No session is launched."
                >
                  {busy ? 'Starting...' : 'Start'}
                </button>
                <span className="note ms-plan">
                  will branch <code>{milestone.planned?.branch || `roadmap/${milestone.id}`}</code> in a new worktree
                </span>
              </>
            )}
          </div>
        </>
      )}
    </article>
  )
}

const STATE_LABEL = { planned: 'Planned', 'in-progress': 'In progress', completed: 'Completed' }
const STATE_ORDER = ['in-progress', 'planned', 'completed']

/**
 * Which tab to open on.
 *
 * Never the archive. A project whose only roadmaps are finished with should
 * open on an empty "in progress" — that is the free screen you asked for by
 * finishing with them — rather than on the list of things you have
 * deliberately put away.
 */
function firstTab(roadmaps, openId) {
  const open = roadmaps.find((r) => r.id === openId)
  if (open && open.state !== 'completed') return open.state
  return STATE_ORDER.find(
    (state) => state !== 'completed' && roadmaps.some((r) => r.state === state),
  ) || 'in-progress'
}

/**
 * What finishing with a roadmap would tidy, said before anything is tidied.
 *
 * The whole reason for offering to clean up at this exact moment is that it is
 * the moment you know the work is over. The reason for showing it first is the
 * opposite: the one thing worse than three stale worktrees is deleting one
 * that still had something in it.
 */
/** Where a milestone's work ended up, in words rather than in a state name. */
const ENDED_UP = {
  merged: 'merged',
  'pr-open': 'pull request still open',
  'pr-closed': 'pull request closed without merging',
  unlanded: 'not merged anywhere',
  empty: 'nothing was ever written',
  none: 'never started',
}

/** The landings that leave nothing behind worth keeping a worktree for. */
const LANDED = ['merged', 'empty', 'none']

/**
 * What closing a roadmap just produced.
 *
 * The report is half of it. The half that earns the screen is the list: every
 * milestone with where its work actually ended up, read off the repository
 * rather than off the status somebody clicked. "Four of six landed" is a
 * number you cannot act on — the names of the two that did not are what tell
 * you which pull request to go and merge before coming back to tidy.
 *
 * `nothing was ever written` is kept apart from `merged` on purpose. Both
 * make a worktree safe to remove, and only one of them is good news.
 */
function Closed({ report, onDismiss }) {
  const milestones = report.summary?.milestones || []
  const left = milestones.filter((m) => !LANDED.includes(m.landing))

  return (
    <section className="panel-block rm-closed">
      <h3>
        Closed
        <button className="linkish" onClick={onDismiss}>dismiss</button>
      </h3>

      <p className="note">
        A session is writing the report to <code>{report.file}</code>. Nothing has been
        removed — the worktrees are still there, and so is what the report is being
        written from.
      </p>

      {left.length > 0 ? (
        <p className="note rm-closed-warn">
          {left.length === 1 ? 'One milestone has' : `${left.length} milestones have`} work
          that has not landed. Merge it, then come back and tidy up.
        </p>
      ) : (
        <p className="note">Everything landed. Tidying up is safe whenever you want it.</p>
      )}

      {milestones.map((m) => (
        <div className={`rm-finish-row${LANDED.includes(m.landing) ? '' : ' is-kept'}`} key={m.id}>
          <span className={`dot dot-${LANDED.includes(m.landing) ? 'done' : 'waiting'}`} />
          <span className="row-name">{m.title}</span>
          <span className="row-meta">
            {ENDED_UP[m.landing] || m.landing}
            {m.pr && (
              <> · <a href={m.pr.url} target="_blank" rel="noreferrer">#{m.pr.number}</a></>
            )}
            {m.diffstat ? ` · ${m.diffstat}` : ''}
          </span>
        </div>
      ))}
    </section>
  )
}

function Finishing({ plan, busy, onCancel, onComplete }) {
  const removable = plan.items.filter((i) => i.action !== 'keep')
  const kept = plan.items.filter((i) => i.action === 'keep')

  return (
    <div className="rm-finish">
      <h4>Finish with "{plan.label}"?</h4>

      {plan.unfinished > 0 && (
        <p className="note">
          {plan.unfinished} of its milestones {plan.unfinished === 1 ? 'is' : 'are'} not marked done.
          Finishing anyway is fine — a roadmap you are abandoning is finished with too.
        </p>
      )}

      {plan.items.length === 0 && <p className="note">It has no worktrees to tidy.</p>}

      {removable.map((item) => (
        <div className="rm-finish-row" key={item.id}>
          <span className="dot dot-done" />
          <span className="row-name">{item.name}</span>
          <span className="row-meta">{item.action === 'forget' ? 'record only' : 'remove'} · {item.why}</span>
        </div>
      ))}

      {kept.map((item) => (
        <div className="rm-finish-row is-kept" key={item.id}>
          <span className="dot dot-waiting" />
          <span className="row-name">{item.name}</span>
          <span className="row-meta">kept · {item.why}</span>
        </div>
      ))}

      <div className="rm-finish-actions">
        {removable.length > 0 && (
          <button className="btn btn-primary btn-slim" disabled={busy} onClick={() => onComplete(true)}>
            {busy ? 'Finishing...' : `Finish and tidy ${removable.length}`}
          </button>
        )}
        <button className="btn btn-slim" disabled={busy} onClick={() => onComplete(false)}>
          {removable.length > 0 ? 'Just finish' : 'Finish'}
        </button>
        <button className="linkish" disabled={busy} onClick={onCancel}>cancel</button>
      </div>
    </div>
  )
}

/**
 * A roadmap somebody asked for and nobody has agreed to yet.
 *
 * It sits above the tabs rather than inside one, because a draft is not in any
 * of the three states — it is not planned until a person says so, and saying
 * so is the whole point of showing it. Until then it is not in the list, not
 * in the counts, and not on disk as a roadmap.
 *
 * What it shows while it is being written is the document it was given, not a
 * progress bar. There is nothing to measure — one session is reading one file
 * — and naming the file is the thing that lets you notice you picked the wrong
 * one while it is still cheap to stop.
 */
function Draft({ proposal, busy, onAccept, onDismiss, onOpenSession }) {
  if (proposal.status === 'drafting') {
    return (
      <div className="rm-draft is-working">
        <div className="rm-draft-head">
          <span className="dot dot-busy" />
          <strong>Drafting a roadmap</strong>
          <span className="row-meta">{proposal.document}</span>
        </div>
        <p className="note">
          A session is reading it and writing the milestones it can justify from what is
          in there. Nothing is created until you have read it back.
          {proposal.deckId && onOpenSession && (
            <> · <button className="linkish" onClick={() => onOpenSession({ deckId: proposal.deckId })}>watch it</button></>
          )}
        </p>
      </div>
    )
  }

  const title = (proposal.goal || '').split('\n')[0].trim() || 'Untitled draft'

  return (
    <div className="rm-draft">
      <div className="rm-draft-head">
        <span className="dot dot-idle" />
        <strong>{title}</strong>
        <span className="row-meta">{proposal.milestones.length} milestones · from {proposal.document}</span>
      </div>

      <ol className="rm-draft-list">
        {proposal.milestones.map((m, i) => (
          <li key={i} className={m.missing?.length ? 'is-thin' : ''}>
            <span className="rm-draft-title">{m.title || 'Untitled'}</span>
            {m.missing?.length > 0 && <span className="row-meta">no {m.missing.join(', ')}</span>}
          </li>
        ))}
      </ol>

      {/*
        Named, not counted. A draft with a milestone that cites nothing is the
        exact failure this is built to avoid, and "3 problems" is not something
        you can act on without opening all of them.
      */}
      {proposal.faults?.length > 0 && (
        <ul className="rm-draft-faults">
          {proposal.faults.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      )}

      <div className="rm-draft-actions">
        <button className="btn btn-primary btn-slim" disabled={busy} onClick={onAccept}>
          {busy ? 'Accepting...' : 'Accept as a roadmap'}
        </button>
        <button className="linkish" disabled={busy} onClick={onDismiss}>discard the draft</button>
        <span className="note is-quiet">
          Accepting only writes it down. Every milestone is still yours to edit, reorder or delete.
        </span>
      </div>
    </div>
  )
}

export default function Roadmap({ project, onOpenSession }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [goalDirty, setGoalDirty] = useState(false)
  const [busy, setBusy] = useState(null)
  const [finishing, setFinishing] = useState(null)
  /*
   * What closing just produced: the report's path, the session writing it,
   * and where every milestone ended up. Held rather than reloaded because
   * none of it is in the roadmap file — it is a reading of the repository
   * taken at that instant.
   */
  const [report, setReport] = useState(null)
  const goalTimer = useRef(null)

  const roadmaps = data?.roadmaps || []
  /*
   * The open roadmap belongs to the tab it is in. Without this, finishing
   * with one left its goal and all its milestones on screen under a tab that
   * said "nothing in flight" — the screen never actually cleared, which was
   * the whole point of finishing with it.
   */
  const open = data?.open && data.open.state === tab ? data.open : null

  /* Nothing left to do -- which is not the same as finished, and is why this
     lights the way out rather than taking it. */
  const allDone = Boolean(open?.milestones?.length)
    && open.milestones.every((m) => m.status === 'done')

  const load = useCallback((roadmapId, { follow = true } = {}) => {
    const which = roadmapId ? `&roadmap=${encodeURIComponent(roadmapId)}` : ''
    fetch(`/api/roadmap?path=${encodeURIComponent(project.path)}${which}`)
      .then((r) => r.json())
      .then((next) => {
        setData(next)
        setOpenId(next.open?.id || null)
        setTab((current) => {
          if (!current) return firstTab(next.roadmaps || [], next.open?.id)
          /*
           * A write can move the open roadmap into another state — pressing
           * Start on a planned one makes it in progress. Following it there
           * beats having it vanish from under you while you are working in
           * it. Switching tabs by hand is the other direction, and that one
           * does not follow: see `shown` below.
           */
          if (follow && next.open && next.open.state !== current) return next.open.state
          return current
        })
        // Never overwrite what you are in the middle of typing.
        if (!goalDirty) setGoal(next.open?.goal || '')
        setError(null)
      })
      .catch(() => setError('Could not read this roadmap'))
  }, [project.path, goalDirty])

  useEffect(() => {
    setData(null)
    setTab(null)
    setOpenId(null)
    setGoalDirty(false)
    setFinishing(null)
    load(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path])

  /*
   * Once a milestone has a session, part of this screen is no longer a file
   * nobody else is writing: the session goes from working to blocked on a
   * permission to gone, and a card that says "working" over a session that has
   * been waiting on you for ten minutes is the exact failure this deck exists
   * to prevent. So it polls while there is a session to watch, and not
   * otherwise.
   */
  const watching = (open?.milestones || []).some((m) => m.session?.live)
  useEffect(() => {
    if (!watching) return
    const timer = setInterval(() => load(openId), 3000)
    return () => clearInterval(timer)
  }, [watching, openId, load])

  /*
   * A draft being written is the other thing on this screen that changes
   * without anybody touching it. Slower than a milestone's session, because
   * nothing here is live output: it is one file appearing at the end, and
   * reading it four times a minute is plenty to catch it.
   */
  const proposal = data?.proposal || null
  useEffect(() => {
    if (proposal?.status !== 'drafting') return
    const timer = setInterval(() => load(openId), 4000)
    return () => clearInterval(timer)
  }, [proposal?.status, openId, load])

  const send = useCallback((payload) => {
    return fetch(`/api/roadmap?path=${encodeURIComponent(project.path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roadmap: openId, ...payload }),
    })
      .then((r) => r.json())
      .then((result) => {
        if (result.ok) {
          setError(null)
          // Re-read rather than patch: a write can change which tab a roadmap
          // belongs to, and the list is what the tabs count.
          load(result.open?.id || result.roadmap?.id || openId)
        } else {
          setError(result.error || 'That did not work')
        }
        return result
      })
      .catch(() => setError('Could not reach the deck'))
  }, [project.path, openId, load])

  const saveGoal = useCallback((value) => {
    clearTimeout(goalTimer.current)
    if (value.trim() === (open?.goal || '').trim()) { setGoalDirty(false); return }
    send({ action: 'goal', goal: value }).then(() => setGoalDirty(false))
  }, [open?.goal, send])

  useEffect(() => () => clearTimeout(goalTimer.current), [])

  const startMilestone = useCallback((id) => {
    setBusy(id)
    send({ action: 'start', id }).finally(() => setBusy(null))
  }, [send])

  const runMilestone = useCallback((id) => {
    setBusy(id)
    send({ action: 'run', id }).finally(() => setBusy(null))
  }, [send])

  function addMilestone(e) {
    e.preventDefault()
    if (!title.trim()) return
    send({ action: 'add', title, task: '' }).then((r) => { if (r?.ok) setTitle('') })
  }

  /** Ask the deck what finishing would tidy, then show it. */
  function askToFinish() {
    setBusy('finish')
    fetch(`/api/roadmap?path=${encodeURIComponent(project.path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cleanup-plan', roadmap: openId }),
    })
      .then((r) => r.json())
      .then((plan) => setFinishing(plan.ok ? plan : null))
      .catch(() => setError('Could not work out what to tidy'))
      .finally(() => setBusy(null))
  }

  /*
   * The first half of finishing: close it and write down what it did.
   *
   * Separate from tidying because the merge happens between the two. A
   * roadmap is done when its milestones are done, and its worktrees can only
   * go once the work in them is somewhere else — with a single pull request
   * for the whole roadmap, that is days later. One button would make you
   * choose at the moment you cannot know.
   *
   * Nothing is removed here, so the evidence the report is being written from
   * is still on disk for as long as it takes to write it.
   */
  function closeAndReport() {
    setBusy('close')
    setReport(null)
    fetch(`/api/roadmap?path=${encodeURIComponent(project.path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'close', roadmap: openId }),
    })
      .then((r) => r.json())
      .then((result) => {
        if (!result.ok) { setError(result.error || 'Could not close it'); return }
        setReport(result)
        setGoalDirty(false)
        /*
         * Followed, unlike tidying, which deliberately gets the roadmap off
         * your screen. Closing is the opposite: the report and what did not
         * land are the two things you came here to read, and archiving the
         * panel out from under them would hide both.
         */
        load(openId)
      })
      .catch(() => setError('Could not reach the deck'))
      .finally(() => setBusy(null))
  }

  /*
   * Finishing does not go through `send`, which reloads whatever the write
   * returned: that would re-open the roadmap we just archived. Out of the way
   * is the point.
   */
  function finish(clean) {
    setBusy('finish')
    fetch(`/api/roadmap?path=${encodeURIComponent(project.path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'complete', clean, roadmap: openId }),
    })
      .then((r) => r.json())
      .then((result) => {
        setFinishing(null)
        if (!result.ok) { setError(result.error || 'Could not finish with it'); return }
        setGoalDirty(false)
        load(null, { follow: false })
      })
      .catch(() => setError('Could not reach the deck'))
      .finally(() => setBusy(null))
  }

  /*
   * Throwing a roadmap away.
   *
   * Offered on the two states where the plan is the only thing at stake:
   * planned, where nothing has been built yet, and completed, where whatever
   * was built is finished with. Not while it is in progress — there the plan is
   * what ties a running session and a half-finished worktree to the reason they
   * exist, and dropping it would leave both on the machine with nothing left to
   * explain them. Close it or finish with it first; both ways out are one
   * click from here.
   *
   * Like finishing, it does not go through `send`. That re-reads whatever the
   * write returned and falls back to the roadmap that was open — which here is
   * the one that has just stopped existing. Asking for the list instead is the
   * only honest question once the thing on screen is gone.
   *
   * The confirmation counts worktrees, because discarding is not tidying.
   * Nothing on disk is touched: the worktrees and branches the milestones left
   * behind stay exactly where they are, and this panel is the last thing on the
   * machine that knows what they were for. Tidying is reversible in the sense
   * that the plan survives it; this is the other way round.
   */
  function discard() {
    const count = (open?.milestones || []).length
    const stranded = (open?.milestones || []).filter((m) => m.worktree).length
    const warning = stranded
      ? `\n\n${stranded} of its milestones still ${stranded === 1 ? 'has a worktree' : 'have worktrees'} on disk.`
        + ' Discarding does not remove them, and afterwards nothing will know what they were for.'
        + ' Tidy up first if you want them gone.'
      : ''

    /* Named for what is actually being thrown away: an empty roadmap nobody
       wrote in is not the same loss as twelve milestones somebody typed. */
    const asked = count
      ? `Discard "${open.label}" and its ${count} milestone${count === 1 ? '' : 's'}? This cannot be undone.`
      : `Discard "${open.label}"? Nothing has been written in it.`

    if (!window.confirm(`${asked}${warning}`)) return

    setBusy('discard')
    fetch(`/api/roadmap?path=${encodeURIComponent(project.path)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'discard', roadmap: openId }),
    })
      .then((r) => r.json())
      .then((result) => {
        if (!result.ok) { setError(result.error || 'Could not discard it'); return }
        setGoalDirty(false)
        setReport(null)
        load(null, { follow: false })
      })
      .catch(() => setError('Could not reach the deck'))
      .finally(() => setBusy(null))
  }

  if (error && !data) return <div className="roadmap"><p className="note">{error}</p></div>
  if (!data) return <div className="roadmap"><p className="note">Loading...</p></div>

  const shown = roadmaps.filter((r) => r.state === tab)
  const milestones = open?.milestones || []
  const done = milestones.filter((m) => m.status === 'done').length

  return (
    <div className="roadmap">
      {error && <p className="note is-bad">{error}</p>}

      {proposal && (
        <Draft
          proposal={proposal}
          busy={busy === 'draft'}
          onOpenSession={onOpenSession}
          onAccept={() => {
            setBusy('draft')
            send({ action: 'accept-proposal' }).finally(() => setBusy(null))
          }}
          onDismiss={() => {
            if (!window.confirm('Discard this draft? The session that wrote it is not asked again.')) return
            setBusy('draft')
            send({ action: 'dismiss-proposal' }).finally(() => setBusy(null))
          }}
        />
      )}

      {/*
        The tabs are a filter over this project's roadmaps, and two of the
        three states are read off the milestones rather than set: a roadmap is
        planned until something happens to it, and in progress once something
        has. Only Completed is a decision, which is why it is the only one with
        a button.
      */}
      <div className="seg rm-tabs" role="tablist" aria-label="Roadmaps by state">
        {STATE_ORDER.map((state) => {
          const count = roadmaps.filter((r) => r.state === state).length
          return (
            <button
              key={state}
              role="tab"
              aria-selected={tab === state}
              className={`seg-btn${tab === state ? ' is-on' : ''}`}
              onClick={() => setTab(state)}
            >
              {STATE_LABEL[state]} {count > 0 && <span className="count">{count}</span>}
            </button>
          )
        })}
      </div>

      <div className="rm-list">
        {shown.length === 0 && (
          <p className="note">
            {tab === 'completed'
              ? 'Nothing finished with yet.'
              : tab === 'planned'
                ? 'Nothing waiting. A roadmap is a goal and the milestones that get you there.'
                : 'Nothing in flight. Start a milestone on a planned roadmap and it lands here.'}
          </p>
        )}

        {shown.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`row rm-row ${r.id === openId ? 'is-on' : ''}`}
            onClick={() => { setGoalDirty(false); load(r.id) }}
          >
            <span className={`dot dot-${r.state === 'completed' ? 'done' : r.state === 'in-progress' ? 'busy' : 'idle'}`} />
            <span className="row-name">{r.label}</span>
            <span className="row-meta">{r.done}/{r.milestones} done</span>
          </button>
        ))}

        <button
          className="btn btn-slim rm-new"
          onClick={() => send({ action: 'new', goal: '' }).then((r) => { if (r?.ok) setTab('planned') })}
        >
          New roadmap
        </button>
      </div>

      {finishing && (
        <Finishing
          plan={finishing}
          busy={busy === 'finish'}
          onCancel={() => setFinishing(null)}
          onComplete={finish}
        />
      )}

      {open && !finishing && report && <Closed report={report} onDismiss={() => setReport(null)} />}

      {open && !finishing && (
        <>
          <section className="panel-block">
            <h3>
              The goal
              {goalDirty && <span className="row-meta">saving...</span>}
              {open.state === 'completed' ? (
                <>
                  {/* The second half, and only reachable once it is closed:
                      the worktrees can go when the work in them is somewhere
                      else, which is usually after a merge that happens later. */}
                  <button className="linkish" onClick={askToFinish} disabled={busy === 'finish'}>
                    {busy === 'finish' ? 'checking...' : 'tidy up'}
                  </button>
                  <button className="linkish" onClick={() => send({ action: 'reopen' })}>reopen</button>
                </>
              ) : (
                /*
                 * Lit once every milestone is done. Completion is not derived
                 * from the milestones on purpose -- work can be finished and
                 * still need a merge -- but a roadmap with nothing left to do
                 * should say so instead of leaving the only way out as grey
                 * text nobody reads.
                 */
                <button
                  className={`linkish${allDone ? ' is-ready' : ''}`}
                  onClick={closeAndReport}
                  disabled={busy === 'close'}
                >
                  {busy === 'close' ? 'closing...' : 'close and report'}
                </button>
              )}

              {/*
                Outside the pair above because it belongs to both of them, and
                last in the row because it is the only control on this screen
                that cannot be undone. In progress is the one state without it:
                see `discard`.
              */}
              {open.state !== 'in-progress' && (
                <button
                  className="linkish is-danger"
                  onClick={discard}
                  disabled={busy === 'discard'}
                  title="Delete this roadmap. Worktrees and branches are left alone."
                >
                  {busy === 'discard' ? 'discarding...' : 'discard'}
                </button>
              )}
            </h3>
            <textarea
              className="rm-goal"
              rows={3}
              maxLength={2000}
              value={goal}
              placeholder="What this project is trying to get to. Optional — but this is what a session would read before proposing milestones."
              aria-label="Project goal"
              onChange={(e) => {
                const value = e.target.value
                setGoal(value)
                setGoalDirty(true)
                clearTimeout(goalTimer.current)
                goalTimer.current = setTimeout(() => saveGoal(value), 1200)
              }}
              onBlur={() => saveGoal(goal)}
            />
          </section>

          <section className="panel-block">
            <h3>
              Milestones <span className="count">{milestones.length}</span>
              {milestones.length > 0 && <span className="row-meta">{done} done</span>}
            </h3>

            {milestones.length === 0 && (
              <p className="note">
                Nothing yet. A milestone is one piece of work that can land on its own branch.
              </p>
            )}

            {milestones.map((m, i) => (
              <Milestone
                key={m.id}
                milestone={m}
                index={i}
                count={milestones.length}
                busy={busy === m.id}
                onUpdate={(id, changes) => send({ action: 'update', id, ...changes })}
                onRemove={(id) => send({ action: 'remove', id })}
                onMove={(id, by) => send({ action: 'move', id, by })}
                onStart={startMilestone}
                onRun={runMilestone}
                onOpenSession={onOpenSession}
              />
            ))}

            <form className="rm-add" onSubmit={addMilestone}>
              <input
                value={title}
                maxLength={80}
                placeholder="Add a milestone"
                aria-label="New milestone title"
                onChange={(e) => setTitle(e.target.value)}
              />
              <button className="btn btn-primary btn-slim" type="submit" disabled={!title.trim()}>Add</button>
            </form>
          </section>

          <section className="panel-block">
            <h3>How the work lands</h3>
            {/*
              A decision about your repository, so it is made here and read
              later rather than decided by whatever runs the milestones.
            */}
            {(data.landings || []).map((value) => (
              <label className="rm-landing" key={value}>
                <input
                  type="radio"
                  name="landing"
                  value={value}
                  checked={open.landing === value}
                  onChange={() => send({ action: 'landing', landing: value })}
                />
                <span>{LANDING_LABEL[value] || value}</span>
              </label>
            ))}
            <p className="note">
              Nothing acts on this yet. It is recorded now so that when something does, it is
              not a prompt deciding what happens to your branches.
            </p>
          </section>
        </>
      )}
    </div>
  )
}
