import { useState } from 'react'
import { usePlans } from './Plans.jsx'
import { useHiddenPlans } from './useHiddenPlans.js'

/**
 * PickUp.jsx — where you left off.
 *
 * The Plans board answers "what is this project trying to build". This screen
 * answers the question asked far more often and by the same person: **"where
 * was I?"** — after a blocker pulled you onto something else, after a week on
 * another repository, after two months.
 *
 * ### It invents nothing
 *
 * Every number here was already written down. An Implementation Plan declares
 * each unit's `status`, its `depends_on` and its `estimated_effort`, and keeps
 * an execution log its own template calls append-only. The reason none of it
 * was visible is that it lives spread across four hundred lines, under ten
 * headings, in ten separate blocks — which is precisely the file nobody reads
 * on the way back in.
 *
 * ### A plan that keeps no log does not belong at the top
 *
 * The screen promises "where you left off" and takes it out of the execution
 * log. In a real workspace twelve plans are in flight and only four keep one:
 * the other eight —trellis contracts, briefs in prose— have nowhere to take
 * that answer from. Putting them in the same list meant setting them aside by
 * hand one at a time, which is what happened the first time this was used:
 * eleven set aside out of twelve, and the row of set-aside plans covering
 * whatever was left.
 *
 * So they drop to a section of their own, folded, with their count in plain
 * sight. They are not hidden —keeping quiet about them would be lying by
 * omission, and the deck has already buried a board over that— but they stop
 * competing with the ones that do answer.
 *
 * ### Ordered by neglect, not by progress
 *
 * Longest untouched first. Three units done out of ten is not news; a plan
 * that has not moved in fifty-six days while still declaring itself
 * `in-progress` is, and it is the one thing on this screen that nothing else
 * would ever have told you.
 *
 * ### What is ready is a calculation, not a field
 *
 * Nowhere does a plan say "this one can start now" — it says what each unit
 * waits on. Crossing those dependencies against the statuses is the same
 * resolution an orchestrator runs to hand work to subagents; here it runs for
 * the person instead. On the plan this was built against it surfaces a unit
 * that had been free to start for fifty-six days, two branches away from
 * where the work stopped, which is the kind of thing a person re-reading the
 * file does not spot.
 */

/** Whole days between a plan's last entry and now, or null if it keeps no log. */
function daysSince(date) {
  if (!date) return null
  const then = Date.parse(date)
  if (Number.isNaN(then)) return null
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}

/**
 * Hours out of an estimate somebody typed, or null when the unit is not one.
 *
 * The unit has to be read, not assumed. A first version pulled the number out
 * and called it hours, which turned a trellis contract estimated at `180min`
 * into 180 hours and gave one plan a total of 2220 — a figure wrong by a
 * factor of sixty, printed in the same confident type as a real one.
 *
 * Anything whose unit is not recognised returns null rather than zero, and a
 * plan with one of those shows no total at all. Saying nothing is a worse
 * screen and an honest one; a sum quietly missing a third of its entries is a
 * better screen that lies.
 *
 * The top of a range, not the middle: the honest summary of "3-4 hours"
 * inside a total is the four.
 */
function hoursOf(estimate) {
  if (!estimate) return null
  const text = String(estimate).toLowerCase()
  const numbers = text.match(/\d+(?:\.\d+)?/g)
  if (!numbers) return null
  const top = Math.max(...numbers.map(Number))
  if (/min/.test(text)) return top / 60
  if (/\dh|hour|\bhr/.test(text)) return top
  // Days, story points, t-shirt sizes: real units that are not time, or not
  // time anyone here can convert without inventing a working day.
  return null
}

/** Hours done and hours left — or nothing, if any estimate was unreadable. */
function effortSplit(milestones) {
  let done = 0
  let total = 0
  let unreadable = 0
  for (const m of milestones) {
    if (!m.estimate) continue
    const h = hoursOf(m.estimate)
    if (h == null) { unreadable += 1; continue }
    total += h
    if (m.status === 'done') done += h
  }
  return { done, total, unreadable }
}

/** `12`, `2.5` — never `12.000000000000002`. */
const hours = (n) => (Math.round(n * 10) / 10).toString()

function Plan({ plan, project, onOpenProject, onHide }) {
  const stale = daysSince(plan.lastEntry?.at)
  const effort = effortSplit(plan.milestones)
  const ready = plan.milestones.filter((m) => m.ready)
  const parked = plan.milestones.filter((m) => m.status === 'blocked' || m.status === 'dropped')
  const pct = plan.progress.total ? (plan.progress.done / plan.progress.total) * 100 : 0

  return (
    <article className="pu-plan">
      <header className="pu-head">
        <div className="pu-ident">
          <span className="pu-id">{plan.id}</span>
          <span className="pu-proj" onClick={() => onOpenProject?.(project.root)}>{project.name}</span>
          {/*
            Where it lives, when that is not where you are. The main checkout
            can be parked on any branch, so a plan can exist in a worktree and
            nowhere else — and starting it means going there first.
          */}
          {plan.elsewhere && (
            <span className="pu-else" title={plan.elsewhere.worktree}>
              in {plan.elsewhere.name}
            </span>
          )}
          {/*
            Where it lives, when that is not where you are. The main checkout
            can be parked on any branch, so a plan can exist in a worktree and
            nowhere else — and starting it means going there first.
          */}
          {plan.elsewhere && (
            <span className="pu-else" title={plan.elsewhere.worktree}>
              in {plan.elsewhere.name}
            </span>
          )}
          {plan.owner && <span className="pu-owner">{plan.owner}</span>}
          {/*
            Set aside, not discarded. Nothing is deleted anywhere: it is a
            filter over what the reader found, and the count up top always says
            how many are out — the moment it stops being obvious something is
            filtered, the screen has started to lie.
          */}
          <button
            className="pu-hide"
            onClick={() => onHide?.(project.root, plan.id)}
            title="Set this plan aside. Bring it back from the row above."
            aria-label="Set this plan aside"
          >
            ×
          </button>
        </div>
        <h3 className="pu-title">{plan.title}</h3>
      </header>

      <div className="pu-meters">
        {/*
          Days first, and in red. It is the only figure here that nothing else
          in the deck would have told you, and the only one that is bad news
          on its own — "3 of 10" is just a plan being executed.
        */}
        {stale != null && (
          <div className={`pu-meter ${stale > 14 ? 'is-stale' : ''}`}>
            <div className="pu-v">{stale} {stale === 1 ? 'day' : 'days'}</div>
            <div className="pu-k">untouched</div>
          </div>
        )}
        <div className="pu-meter">
          <div className="pu-v">{plan.progress.done} / {plan.progress.total}</div>
          <div className="pu-k">units done</div>
        </div>
        {effort.total > 0 && effort.unreadable === 0 && (
          <div className="pu-meter">
            <div className="pu-v">{hours(effort.done)}h</div>
            <div className="pu-k">of ~{hours(effort.total)} estimated</div>
          </div>
        )}
        <div className="pu-track">
          <div className="pu-bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
      </div>

      {/*
        The last thing that happened, in the words of whoever wrote it down.
        Carried verbatim and not summarised: the sentence that matters on the
        way back in is usually the one somebody added in passing.
      */}
      {plan.lastEntry && (
        <div className="pu-resume">
          <div className="pu-rhead">Where you left off</div>
          <div className="pu-rwhat">
            {plan.lastEntry.unit}
            {plan.lastEntry.outcome && <span className="pu-outcome"> — {plan.lastEntry.outcome}</span>}
          </div>
          <div className="pu-rwhen">
            {plan.lastEntry.at}
            {stale != null && ` · ${stale} ${stale === 1 ? 'day' : 'days'} ago`}
            {' · last entry in the execution log'}
          </div>
          {plan.lastEntry.note && <p className="pu-rnote">{plan.lastEntry.note}</p>}
        </div>
      )}

      {ready.length > 0 && (
        <div className="pu-next">
          <div className="pu-nhead">
            Pick up here · {ready.length} ready, nothing blocking {ready.length === 1 ? 'it' : 'them'}
          </div>
          {ready.map((m) => (
            <div className="pu-ready" key={m.id}>
              <span className="pu-rid">{m.id}</span>
              <span className="pu-rtitle">{m.title}</span>
              {m.estimate && <span className="pu-rest">{m.estimate}</span>}
            </div>
          ))}
        </div>
      )}

      {ready.length === 0 && plan.waiting > 0 && (
        <p className="pu-none">
          Nothing can start: all {plan.waiting} remaining units are waiting on something else.
        </p>
      )}
      {parked.length > 0 && (
        <p className="pu-none">{parked.length} blocked or dropped.</p>
      )}
    </article>
  )
}

export default function PickUp({ onOpenProject }) {
  const { data, error, loading, reload } = usePlans(null)
  const { hidden, hide, show, showAll, isHidden } = useHiddenPlans()
  /*
   * Null is "all". It lives in local state and not in localStorage on
   * purpose: a remembered filter is a screen that lies by staying quiet — you
   * come back three days later, see two plans, and nothing says nine are
   * behind them.
   */
  const [onlyRoot, setOnlyRoot] = useState(null)

  if (loading && !data) return <main className="stage"><p className="note">Reading the plans...</p></main>
  if (error) return <main className="stage"><p className="note">{error}</p></main>

  /*
   * Only what is in flight. A plan nobody started is not something you are in
   * the middle of, and putting it here would bury the four that are.
   */
  const open = []
  const quiet = []
  const put = []
  for (const project of data || []) {
    if (!project.supported || !project.plans) continue
    for (const plan of project.plans) {
      if (plan.status !== 'in-progress') continue
      if (isHidden(project.root, plan.id)) {
        put.push({ plan, project })
        continue
      }
      // The one question that decides where it goes: can this plan say where
      // it stopped? Without a log it cannot, and up top it is only in the way.
      if (plan.lastEntry) open.push({ plan, project })
      else quiet.push({ plan, project })
    }
  }
  // Longest untouched first; plans with no log last, since nothing is known
  // about when they moved and guessing would rank them on a fiction.
  open.sort((a, b) => (daysSince(b.plan.lastEntry?.at) ?? -1) - (daysSince(a.plan.lastEntry?.at) ?? -1))

  /*
   * One chip per project with something in flight, with its count.
   *
   * A filter here and not a screen per project: the question that brings you
   * to this view is sometimes "what was I on?", and then you do not even know
   * which project to come in through. Filtering keeps both readings in one
   * place, and a separate tab would have been a second copy to maintain.
   */
  const byRoot = new Map()
  for (const row of open) {
    const entry = byRoot.get(row.project.root) || { name: row.project.name, root: row.project.root, n: 0 }
    entry.n += 1
    byRoot.set(row.project.root, entry)
  }
  for (const row of quiet) {
    const entry = byRoot.get(row.project.root) || { name: row.project.name, root: row.project.root, n: 0 }
    entry.n += 1
    byRoot.set(row.project.root, entry)
  }
  const projects = [...byRoot.values()].sort((a, b) => b.n - a.n)
  const shown = onlyRoot ? open.filter((row) => row.project.root === onlyRoot) : open
  const quietShown = onlyRoot ? quiet.filter((row) => row.project.root === onlyRoot) : quiet

  return (
    <main className="stage">
      <header className="stage-head">
        <div>
          <h2>Where you left off</h2>
          <p className="note">
            {open.length
              ? `${open.length} with an execution log, longest untouched first.` +
                (quiet.length ? ` ${quiet.length} more in flight with no log, at the end.` : '')
              : 'No plan is in progress right now.'}
          </p>
        </div>
        <button className="btn btn-slim" onClick={reload} disabled={loading}>
          {loading ? 'Reading...' : 'Refresh'}
        </button>
      </header>

      {projects.length > 1 && (
        <div className="pu-filter">
          <button
            className={`pu-chip ${onlyRoot === null ? 'is-on' : ''}`}
            onClick={() => setOnlyRoot(null)}
          >
            All <span className="pu-n">{open.length + quiet.length}</span>
          </button>
          {projects.map((p) => (
            <button
              key={p.root}
              className={`pu-chip ${onlyRoot === p.root ? 'is-on' : ''}`}
              onClick={() => setOnlyRoot(onlyRoot === p.root ? null : p.root)}
            >
              {p.name} <span className="pu-n">{p.n}</span>
            </button>
          ))}
        </div>
      )}

      {/*
        Folded, and not a row of chips: with eleven set aside it took two lines
        and pushed the one thing left to see off the screen. The count is
        always visible — which is what keeps the screen from lying by omission
        — and the names only if you open it.
      */}
      {put.length > 0 && (
        <details className="pu-put">
          <summary>
            <span className="pu-caret" aria-hidden="true">▸</span>
            {put.length} {put.length === 1 ? 'plan set aside' : 'plans set aside'}
          </summary>
          <div className="pu-putlist">
            {put.map(({ plan, project }) => (
              <button
                key={`${project.root}:${plan.id}`}
                className="pu-back"
                onClick={() => show(project.root, plan.id)}
                title={plan.title}
              >
                {plan.id} ↩
              </button>
            ))}
            {put.length > 1 && (
              <button
                className="pu-back"
                onClick={() => [...new Set(put.map((x) => x.project.root))].forEach(showAll)}
              >
                bring them all back
              </button>
            )}
          </div>
        </details>
      )}

      <div className="pu-list">
        {shown.map(({ plan, project }) => (
          <Plan
            key={`${project.root}:${plan.id}`}
            plan={plan}
            project={project}
            onOpenProject={onOpenProject}
            onHide={hide}
          />
        ))}
        {shown.length === 0 && open.length > 0 && (
          <p className="note">Nothing in flight in that project.</p>
        )}
        {shown.length === 0 && open.length === 0 && quiet.length > 0 && (
          <p className="note">
            No plan in flight keeps an execution log, so none of them can say where you
            left off. The {quiet.length} there are sit below.
          </p>
        )}

        {quietShown.length > 0 && (
          <details className="pu-quiet">
            <summary>
              <span className="pu-caret" aria-hidden="true">▸</span>
              {quietShown.length} in flight with no execution log
              <span className="pu-qhint">they cannot say where you left off</span>
            </summary>
            {quietShown.map(({ plan, project }) => (
              <div className="pu-qrow" key={`${project.root}:${plan.id}`}>
                <span className="pu-qid">{plan.id}</span>
                <span className="pu-qtitle">{plan.title}</span>
                <span className="pu-qprog">{plan.progress.done}/{plan.progress.total}</span>
                <span className="pu-qproj">{project.name}</span>
                {plan.elsewhere && <span className="pu-else">in {plan.elsewhere.name}</span>}
                {plan.elsewhere && <span className="pu-else">in {plan.elsewhere.name}</span>}
                <button
                  className="pu-hide"
                  onClick={() => hide(project.root, plan.id)}
                  aria-label="Set this plan aside"
                >
                  ×
                </button>
              </div>
            ))}
          </details>
        )}
      </div>
    </main>
  )
}
