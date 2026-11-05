import { useCallback, useEffect, useState } from 'react'
import { useHiddenPlans } from './useHiddenPlans.js'

/**
 * Plans.jsx — what every project is trying to build, in one set of words.
 *
 * Four conventions across one workspace: Implementation Plans, trellis
 * contracts, prose briefs, and projects with nothing at all. They are named
 * differently and they are the same idea — one large piece of work, cut into
 * pieces, tracked as the pieces land. So the screen groups and counts in its
 * own vocabulary, *plan* and *milestone*, and every row carries the native
 * name beside it.
 *
 * Beside, never instead. The deck already draws that distinction for sessions
 * — the label you renamed it to next to the address another session has to
 * type — and it is here for the same reason: a board that renames
 * `PROP-T-87` to "milestone 3" makes you translate every time you open the
 * file.
 *
 * ### Two screens, because there are two questions
 *
 * "What can I pick up today?" crosses every project and has to be thin.
 * "How is this repository going?" is deep and belongs where you already
 * stand when you ask it. Putting both in one page was the first draft, and
 * eleven projects of ninety-eight milestones each is not a screen.
 *
 * So `Plans` is the global one — the startable items, then one row per
 * project — and `ProjectPlans` is the board, which replaces the Roadmap tab
 * inside a project. That tab was the old roadmap, and it is the thing being
 * replaced rather than something new sitting next to it.
 *
 * ### Earned, and declared
 *
 * The column this exists for. A milestone is `done` because somebody typed
 * it, or because a gate re-ran the work's own checks and wrote the verdict.
 * Those are different claims and must not print in the same ink — the
 * roadmap this replaces died of sixteen `done`s that were all typed, none
 * ever contradicted, and worth nothing by the end.
 *
 * ### It reads. It does not act.
 *
 * No buttons that start work, on purpose. Reading four conventions correctly
 * is a job on its own, and a board that launches sessions from a plan it has
 * only just learned to parse would be acting on its own first draft. Refresh
 * is the only control: you implement in the normal way and press it when you
 * want the board to catch up.
 */

const STATUS_LABEL = {
  doing: 'running',
  blocked: 'blocked',
  todo: 'to do',
  done: 'done',
  dropped: 'dropped',
  unknown: 'unread',
}

const PLAN_LABEL = {
  'in-progress': 'in progress',
  planned: 'planned',
  done: 'finished',
  empty: 'empty',
}

/** What each convention calls the two things, said once per project. */
const NATIVE = {
  ip: 'IP → sessions',
  trellis: 'spec → contracts',
  prose: 'documents',
  deck: 'plan → items',
}

/**
 * The totals of whatever is actually being shown.
 *
 * Recomputed here rather than taken from the server, because putting a plan
 * aside has to move the numbers with it. A header reading `68/98 done` above
 * three plans that add up to twelve is a header describing a screen you are
 * not looking at, and the whole point of this board is that what it says is
 * true of what is in front of you. How many were put aside is said next to
 * it, so the smaller number is never mistaken for the whole of the work.
 */
function totalsOf(plans) {
  return plans.reduce((acc, p) => ({
    plans: acc.plans + 1,
    milestones: acc.milestones + p.milestones.length,
    done: acc.done + p.progress.done,
    earned: acc.earned + p.earned,
    ready: acc.ready + p.ready,
    waiting: acc.waiting + p.waiting,
  }), { plans: 0, milestones: 0, done: 0, earned: 0, ready: 0, waiting: 0 })
}

/** Ask the server. One place, so every screen fails the same way. */
export function usePlans(root) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/plans${root ? `?root=${encodeURIComponent(root)}` : ''}`)
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.error)
        setData(body.projects || [])
        setError(null)
      })
      .catch(() => setError('Could not read the plans'))
      .finally(() => setLoading(false))
  }, [root])

  useEffect(() => { load() }, [load])
  return { data, error, loading, reload: load }
}

/**
 * Progress and how much of it is verified, in one width.
 *
 * Two fills rather than two bars, because they are not two measurements —
 * they are the same one asked twice. The darker length is everything called
 * done; the bright length is the part a gate stands behind. A project where
 * the second never appears is not in trouble, it is unchecked, and that is a
 * different and more useful thing to see.
 */
function Bar({ done, total, earned }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  const sure = total ? Math.round((Math.min(earned, done) / total) * 100) : 0
  return (
    <span className="pl-bar" title={`${done} of ${total} done · ${earned} verified`}>
      <span className="pl-bar-done" style={{ width: `${pct}%` }} />
      <span className="pl-bar-earned" style={{ width: `${sure}%` }} />
    </span>
  )
}

function Item({ milestone: m, showPlan }) {
  const kind = m.ready ? 'ready' : m.status

  return (
    <li className={`pl-it is-${kind}`}>
      <span className={`pl-dot is-${kind}`} aria-hidden="true" />
      {/* The native id first: it is what you will search the repo for. */}
      <span className="pl-id">{m.id}</span>
      <span className="pl-ttl">{m.title}</span>

      {showPlan && <span className="pl-inplan">{m.plan?.title}</span>}
      {m.estimate && <span className="pl-est">{m.estimate}</span>}

      {/*
        A dependency naming something no file in this project declares. Not
        treated as satisfied and not as blocking — both would be guesses, and
        the id was written by hand. Saying the reference does not resolve is
        the only honest reading.
      */}
      {m.missingDeps?.length > 0 && (
        <span className="pl-flag" title={`Not found: ${m.missingDeps.join(', ')}`}>broken dep</span>
      )}
      {m.conflict && <span className="pl-flag" title={m.conflict}>disagrees</span>}

      {m.status === 'done' && (
        <span className={`pl-proof ${m.determined === 'earned' ? 'is-earned' : 'is-declared'}`}>
          {m.determined === 'earned' ? `verified · ${m.checks} checks` : 'declared'}
        </span>
      )}
      {m.status === 'doing' && <span className="pl-proof is-doing">running</span>}
      {m.ready && <span className="pl-proof is-ready">ready</span>}
      {!m.ready && m.status === 'todo' && m.blockedBy?.length > 0 && (
        <span className="pl-waits" title={`Waits on ${m.blockedBy.join(', ')}`}>
          waits on {m.blockedBy.length}
        </span>
      )}
    </li>
  )
}

/**
 * One plan, collapsed until you ask for it.
 *
 * It used to open itself whenever it had something ready or running, which
 * was right for eleven plans and wrong for sixty-six: the Implementation
 * Plans reader turned one project into a page that could not be scanned and,
 * for a while, could not even be scrolled. The row already carries what you
 * need to choose — how many are ready, how many blocked, the bar — so the
 * items wait behind one click.
 */
function PlanBlock({ plan, onHide, open }) {
  const live = plan.milestones.filter((m) => m.status !== 'done')
  const done = plan.milestones.filter((m) => m.status === 'done')

  // Startable first, then running, then the rest.
  const order = [...live].sort((a, b) => {
    const rank = (m) => (m.ready ? 0 : m.status === 'doing' ? 1 : 2)
    return rank(a) - rank(b)
  })

  return (
    <details className="pl-plan" open={open}>
      <summary className="pl-phead">
        <span className="pl-caret" aria-hidden="true">▸</span>
        <span className="pl-ptitle">{plan.title}</span>
        {plan.ready > 0 && <span className="pl-tag-ready">{plan.ready} ready</span>}
        {plan.blocked > 0 && <span className="pl-tag-blocked">{plan.blocked} blocked</span>}
        <span className={`pl-state is-${plan.status}`}>{PLAN_LABEL[plan.status] || plan.status}</span>
        <span className="pl-count">{plan.progress.done}/{plan.progress.total}</span>
        <Bar done={plan.progress.done} total={plan.progress.total} earned={plan.earned} />
        {/*
          Inside the summary, so it sits on the row it acts on — which means
          stopping the click from also toggling the disclosure it lives in.
          Nothing is deleted: see useHiddenPlans.
        */}
        {onHide && (
          <button
            className="pl-hide"
            title="Put this plan aside. It stays in the repository and comes back from the line below."
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onHide() }}
          >
            ×
          </button>
        )}
      </summary>

      {order.length > 0 && (
        <ul className="pl-items">
          {order.map((m) => <Item key={m.id} milestone={m} />)}
        </ul>
      )}

      {/*
        Finished work, one more click in. It is kept reachable rather than
        dropped because "which ones are resolved, and on what evidence" is a
        real question — it is just not the one you open a board to ask.
      */}
      {done.length > 0 && (
        <details className="pl-done">
          <summary>{done.length} done</summary>
          <ul className="pl-items">
            {done.map((m) => <Item key={m.id} milestone={m} />)}
          </ul>
        </details>
      )}
    </details>
  )
}

function Totals({ totals }) {
  return (
    <span className="pl-totals">
      {totals.plans} plans · {totals.done}/{totals.milestones} done ·{' '}
      <b className={totals.earned ? 'is-earned' : 'is-unver'}>
        {totals.earned ? `${totals.earned} verified` : 'none verified'}
      </b>
      {totals.ready > 0 && <> · <b className="is-ready">{totals.ready} ready</b></>}
      {totals.waiting > 0 && <> · {totals.waiting} waiting</>}
    </span>
  )
}

/**
 * A project whose plans the deck can see and cannot read, or one that keeps
 * none at all.
 *
 * Two different facts, drawn differently and neither hidden. "This project
 * writes plans in a shape I do not read yet" and "this project has no plans"
 * collapse into the same empty state only if you are willing to lie by
 * omission, and the evidence is printed so the inference can be argued with.
 */
function Unread({ project }) {
  if (project.method === 'none') {
    return (
      <p className="note">
        This project writes no plans in any shape the deck recognises.
      </p>
    )
  }
  return (
    <>
      <p className="note">
        There are plans here and I cannot read them yet. Rather than invent a board, here is where they live.
      </p>
      <ul className="pl-evidence">
        {project.evidence?.map((e, i) => <li key={i}>{e.what} <code>{e.where}</code></li>)}
      </ul>
      {project.caveat && <p className="note is-quiet">{project.caveat}</p>}
    </>
  )
}

/**
 * The three states a plan can be in, as folders.
 *
 * The nesting people reach for when a list stops fitting, and here it falls
 * out of the data rather than being imposed on it: a project's plans are
 * always mostly finished, and forty finished plans at the same level as the
 * six you are inside is the whole of the density problem.
 *
 * Only "in progress" opens itself. Everything else is one line until asked —
 * including "not started", which is where next quarter lives and which is
 * exactly what you did not come here to read.
 */
const GROUPS = [
  { id: 'in-progress', label: 'In progress', open: true },
  { id: 'planned', label: 'Not started', open: false },
  { id: 'done', label: 'Finished', open: false },
]

function PlanGroup({ group, plans, onHide }) {
  if (plans.length === 0) return null

  const ready = plans.reduce((n, p) => n + p.ready, 0)
  const blocked = plans.reduce((n, p) => n + p.blocked, 0)

  return (
    <details className="pl-group" open={group.open}>
      <summary className="pl-ghead">
        <span className="pl-caret" aria-hidden="true">▸</span>
        <span className="pl-glabel">{group.label}</span>
        <span className="pl-gcount">{plans.length}</span>
        {ready > 0 && <span className="pl-tag-ready">{ready} ready</span>}
        {blocked > 0 && <span className="pl-tag-blocked">{blocked} blocked</span>}
      </summary>
      <div className="pl-gbody">
        {plans.map((p) => (
          <PlanBlock
            key={p.id}
            plan={p}
            open={false}
            onHide={onHide ? () => onHide(p.id) : null}
          />
        ))}
      </div>
    </details>
  )
}

/**
 * What you put aside, and the way back — by name.
 *
 * The first version said only how many, which read fine and was useless the
 * moment there was more than one: the only way back was "bring them all
 * back", so anybody who had put aside ten and wanted one had to restore the
 * nine they meant to keep hidden and start again.
 *
 * The count itself is never hidden. A filter you can forget you applied is
 * the thing that makes a board wrong — you come back in a fortnight, see four
 * plans, and conclude the project has four.
 */
function HiddenNote({ plans, onShow, onShowAll }) {
  if (!plans.length) return null
  return (
    <details className="pl-hidden-note">
      <summary>
        <span className="pl-caret" aria-hidden="true">▸</span>
        {plans.length} {plans.length === 1 ? 'plan put aside' : 'plans put aside'}
        {/*
          The list is behind a disclosure and the "all" is not. Bringing one
          back is the considered act — you have to look at the names — and
          bringing everything back is the panic button, which should never be
          two clicks away from somebody who has lost track of what they hid.
        */}
        <button
          className="pl-link"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onShowAll() }}
        >
          bring them all back
        </button>
      </summary>
      <ul className="pl-hidden-list">
        {plans.map((p) => (
          <li key={p.key || p.id}>
            <span className="pl-hidden-title">{p.title}</span>
            {p.project && <span className="pl-inplan">{p.project}</span>}
            <button className="pl-link" onClick={() => onShow(p)}>show</button>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Why the deck would not write here, said before anything asks it to. */
function Locked({ project }) {
  if (project.writable) return null
  const why = project.index?.generated
    ? `The index is generated (${project.index.file}) — writing the frontmatter would break the build`
    : 'A gate writes the status in this project'
  return <span className="pl-locked" title={why}>read only</span>
}

function Drift({ drift }) {
  if (!drift?.length) return null
  return (
    <details className="pl-drift">
      <summary>{drift.length} recorded drifts</summary>
      <ul>
        {drift.slice(0, 30).map((d, i) => (
          <li key={i}>
            <code>{d.milestone}</code> {d.what}
            {d.at && <span className="pl-when">{new Date(d.at).toLocaleDateString()}</span>}
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * The board for one project — the Roadmap tab's new contents.
 *
 * Takes the project's path and asks for that one, rather than filtering a
 * whole-workspace answer in the browser: eleven repositories is eleven
 * directory walks, and the tab you are standing in needs one.
 */
export function ProjectPlans({ root }) {
  const { data, error, loading, reload } = usePlans(root)
  const { hide, show, showAll, isHidden } = useHiddenPlans()
  const project = data?.[0]

  const all = project?.plans || []
  const visible = all.filter((p) => !isHidden(root, p.id))
  const totals = totalsOf(visible)

  /*
   * Sorted so that, inside a folder, the plans with work available come
   * first. Alphabetical within a state is a filing order, not a working one.
   */
  const byGroup = (id) => visible
    .filter((p) => (id === 'planned' ? p.status === 'planned' || p.status === 'empty' : p.status === id))
    .sort((a, b) => b.ready - a.ready || a.title.localeCompare(b.title))

  return (
    <div className="pl-scroll">
    <section className="panel-block pl-root">
      <h3>
        Plans
        {project?.supported && <span className="group-hint">{NATIVE[project.method]}</span>}
        <span className="pl-head-right">
          {project && <span className="pl-method">{project.label}</span>}
          {project && <Locked project={project} />}
          <button className="btn btn-slim" onClick={reload} disabled={loading}>
            {loading ? 'Reading...' : 'Re-read'}
          </button>
        </span>
      </h3>

      {error && <p className="note">{error}</p>}
      {!error && !data && <p className="note">Reading the repository...</p>}

      {project && !project.supported && <Unread project={project} />}

      {project?.supported && (
        <>
          <p className="pl-sub"><Totals totals={totals} /></p>
          <HiddenNote
            plans={all.filter((p) => isHidden(root, p.id))}
            onShow={(p) => show(root, p.id)}
            onShowAll={() => showAll(root)}
          />
          <Drift drift={project.drift} />
          {GROUPS.map((g) => (
            <PlanGroup
              key={g.id}
              group={g}
              plans={byGroup(g.id)}
              onHide={(planId) => hide(root, planId)}
            />
          ))}
          {all.length > 0 && visible.length === 0 && (
            <p className="note">Every plan in this project is put aside.</p>
          )}
          {project.unreadable?.length > 0 && (
            <p className="note is-quiet">
              {project.unreadable.length} files in that folder are not plans and were skipped.
            </p>
          )}
        </>
      )}
    </section>
    </div>
  )
}

/**
 * The global screen: what could be started, anywhere, and how each project
 * stands.
 *
 * Thin on purpose. The only thing drawn in full is the work whose
 * dependencies are satisfied — across this workspace that is eleven rows, not
 * a thousand — and every project below it is one line. Repeating the board
 * eleven times would answer the other question, badly, in a place nobody
 * asked it.
 */
export default function Plans({ onOpenProject }) {
  const { data, error, loading, reload } = usePlans(null)
  const { hidden, show, showAll, isHidden } = useHiddenPlans()

  /*
   * Read first and, among those, the ones with work available. Then the
   * projects the deck cannot follow, then the ones with nothing — where an
   * empty row is an offer rather than a gap.
   */
  const projects = [...(data || [])].sort((a, b) => {
    const rank = (p) => (p.supported ? 0 : p.method === 'none' ? 2 : 1)
    return rank(a) - rank(b)
      || (b.totals?.ready || 0) - (a.totals?.ready || 0)
      || a.name.localeCompare(b.name)
  })

  /*
   * Focus reaches this screen too, and it has to: a plan put aside inside a
   * project while working on something else should not keep offering its
   * items here as the next thing to pick up. That is the one list on this
   * page whose value is that it is short.
   */
  const supported = projects
    .filter((p) => p.supported)
    .map((p) => {
      const visible = p.plans.filter((plan) => !isHidden(p.root, plan.id))
      return { ...p, visible, totals: totalsOf(visible), putAside: p.plans.length - visible.length }
    })

  const ready = supported.flatMap((p) => (p.ready || [])
    .filter((m) => !isHidden(p.root, m.plan?.id))
    .map((m) => ({ ...m, project: p.name })))

  const sum = totalsOf(supported.flatMap((p) => p.visible))
  const putAside = supported.reduce((n, p) => n + p.putAside, 0)

  return (
    <main className="stage">
      <header className="stage-head">
        <div>
          <h2>Plans</h2>
          <p className="stage-sub">
            {loading && !data ? 'Reading the repositories...'
              : supported.length === 0 ? 'No project yet keeps plans in a shape the deck can read'
                : <Totals totals={sum} />}
          </p>
        </div>
        <div className="stage-right project-actions">
          <button className="btn" onClick={reload} disabled={loading}>
            {loading ? 'Reading...' : 'Re-read'}
          </button>
        </div>
      </header>

      <div className="transcript">
        {error && <p className="note">{error}</p>}

        {putAside > 0 && (
          <HiddenNote
            plans={supported.flatMap((p) => p.plans
              .filter((plan) => isHidden(p.root, plan.id))
              .map((plan) => ({ ...plan, project: p.name, root: p.root, key: `${p.root}::${plan.id}` })))}
            onShow={(p) => show(p.root, p.id)}
            onShowAll={() => [...new Set([...hidden].map((k) => k.split('::')[0]))].forEach(showAll)}
          />
        )}

        {ready.length > 0 && (
          <section className="panel-block pl-ready">
            <h3>
              Ready to start <span className="count">{ready.length}</span>
              <span className="group-hint">dependencies met — any of these can be picked up today</span>
            </h3>
            <ul className="pl-items">
              {ready.map((m) => (
                <Item key={`${m.project}:${m.id}`} milestone={m} showPlan />
              ))}
            </ul>
          </section>
        )}

        {projects.length > 0 && (
          <section className="panel-block">
            <h3>Projects <span className="count">{projects.length}</span></h3>
            {projects.map((p) => (
              <div key={p.root} className={`pl-row ${p.supported ? '' : 'is-unread'}`}>
                <button
                  className="pl-row-name"
                  onClick={() => onOpenProject?.(p.root)}
                  title="Open the project and its board"
                >
                  {p.name}
                </button>
                <span className="pl-row-meta">
                  {p.supported
                    ? <>{p.totals.plans} plans · {p.totals.done}/{p.totals.milestones} ·{' '}
                      <span className={p.totals.earned ? 'is-earned' : 'is-unver'}>
                        {p.totals.earned} verified
                      </span></>
                    : p.label}
                </span>
                <span className="pl-row-right">
                  {p.supported
                    ? (p.totals.ready > 0
                      ? <b className="is-ready">{p.totals.ready} ready</b>
                      : <span className="is-quiet">nothing to pick up</span>)
                    : <span className="is-quiet">
                      {p.method === 'none' ? 'no convention' : 'reader pending'}
                    </span>}
                  <Locked project={p} />
                </span>
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  )
}
