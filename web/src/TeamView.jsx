import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import SessionCard from './SessionCard.jsx'
import TeamDraft from './TeamDraft.jsx'
import { relativeTime } from './format.js'

/**
 * TeamView.jsx — the groups you raised, and how each one is arranged.
 *
 * The first version of this screen showed every live session in a column per
 * project. It ran, and it was the wrong screen: with eleven sessions across
 * six projects it was the session list wearing columns, and nothing on it said
 * which four of those eleven you had put together on purpose. That was not a
 * layout problem. The deck did not know what a team was, so the screen could
 * not either.
 *
 * Now a team is written down when it is raised, and this shows those. A
 * session that is not in one does not appear here — it is reached from the
 * project tree in the drawer, which is the list of everything.
 *
 * ### Inside a team: position is role, then project
 *
 * The ones that hand out the work sit on their own line above the rest,
 * because they belong to no single project: coordinating three repositories is
 * the whole point of the arrangement. Below them, a column per project.
 * Nothing is ordered by how busy it is — a card that moves while you are
 * looking at it is a card you have to find again.
 *
 * ### A line is a message that happened
 *
 * From `/api/meetings`, which reconstructs every message that actually
 * travelled between two sessions. Two members that were introduced and never
 * spoke have no line, and who hands out the work was said when the team was
 * composed rather than worked out from who talks most — the busiest session is
 * usually the one being asked.
 *
 * ### A member that has gone is still a member
 *
 * A team of four where one has exited is four people, one of whom left. It is
 * drawn plain rather than dropped, because a screen that quietly shows three
 * has stopped describing the thing you raised.
 */

/** The room data is pulled, not pushed, so this is how fresh the lines are. */
const POLL_MS = 4000

/** A line is drawn brighter while something has been said across it recently. */
const RECENT_MS = 30 * 60 * 1000

/**
 * The members of a team with a conversation on disk and no process behind it.
 *
 * The deck suspends everything on its way out, so the ordinary state of this
 * screen the morning after a restart is every team asleep — and that is the
 * one case where waking them a card at a time is six presses to get back to
 * what you closed.
 *
 * Only the sessions the deck drives. One running in somebody else's terminal
 * has no process here to start, and a member that has gone has nothing to
 * start at all; both are skipped rather than counted and then failed.
 */
function sleepers(team) {
  return team.members
    .filter((m) => m.session?.managed && m.session?.status === 'detached')
    .map((m) => m.session.deckId)
}

/** Whether two sets of lines would draw the same picture. */
function sameEdges(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].key !== b[i].key || a[i].d !== b[i].d || a[i].recent !== b[i].recent) return false
  }
  return true
}

export default function TeamView({ teamId, deck, onOpenSession, onOpenTeam, onNewTeam, onCompose }) {
  const [teams, setTeams] = useState(null)
  const [away, setAway] = useState([])
  const [drafts, setDrafts] = useState([])
  const [rooms, setRooms] = useState([])
  const [error, setError] = useState(null)
  const [waking, setWaking] = useState(false)

  const load = useCallback(async () => {
    try {
      const [teamRes, roomRes, draftRes] = await Promise.all([
        fetch('/api/teams').then((r) => r.json()),
        fetch('/api/meetings').then((r) => r.json()),
        fetch('/api/team-proposals').then((r) => r.json()),
      ])
      setTeams(teamRes.teams || [])
      setAway(teamRes.dismissed || [])
      setRooms(roomRes.rooms || [])
      setDrafts(draftRes.drafts || [])
      setError(null)
    } catch {
      setError('Could not reach the deck')
      setTeams((current) => current || [])
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  /*
   * Who has said something to whom, and how long ago. One entry per ordered
   * pair: ten messages between the same two is one line, and what makes it
   * worth drawing brighter is that something was said recently rather than
   * that a lot was said at some point.
   */
  const traffic = useMemo(() => {
    const pairs = new Map()
    for (const room of rooms) {
      for (const turn of room.turns || []) {
        if (!turn.from || !turn.to || turn.from === turn.to) continue
        const key = `${turn.from}>${turn.to}`
        const at = Date.parse(turn.at) || 0
        const found = pairs.get(key)
        if (!found) pairs.set(key, { from: turn.from, to: turn.to, at })
        else found.at = Math.max(found.at, at)
      }
    }
    return [...pairs.values()]
  }, [rooms])

  async function dismissDraft(source) {
    await fetch('/api/team-proposal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', source }),
    })
    load()
  }

  /*
   * One at a time and reported, rather than a single call that either works or
   * does not: a name already taken is the ordinary case — somebody renamed a
   * role since the proposal was written — and it should not take the other
   * three down with it.
   */
  async function createRoles(roles) {
    const failed = []
    for (const role of roles) {
      const response = await fetch('/api/roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: role.name,
          brief: role.brief,
          model: role.model || null,
          effort: role.effort || null,
          advisor: role.advisor,
          delegates: role.delegates,
        }),
      })
      const result = await response.json().catch(() => ({ ok: false }))
      if (!result.ok) failed.push(`${role.name}: ${result.error || 'could not save'}`)
    }
    if (failed.length) window.alert(`Not every role was saved.\n\n${failed.join('\n')}`)
    load()
  }

  /*
   * Puts the record away; the sessions are not touched. Said out loud on the
   * confirmation and again under the list, because the one time this was a
   * bare `×` the reasonable reading of it was "close the whole team down" —
   * and what it actually did was remove the only record of who was in it.
   */
  async function dismiss(id) {
    await fetch('/api/teams', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    load()
  }

  /*
   * Bring a whole team back from a restart.
   *
   * One command and not one per member: six round trips is six chances to
   * half-finish, and what you asked for was the team, so what should be
   * reported is the team. The server wakes each of them and tells us who did
   * not come up — said by name, because "one failed" with six cards on screen
   * is a thing you then have to go and find.
   *
   * Which button is busy is the button's own business. This is called from
   * the open team's header and from any row on the list, and a shared flag
   * would grey out all six rows because you pressed one of them.
   */
  async function wakeTeam(deckIds, members) {
    const result = await deck.wakeMany(deckIds)
    load()
    if (!result?.ok) {
      window.alert(result?.error || 'Could not wake this team')
      return
    }
    if (result.failed?.length) {
      const nameOf = (deckId) => {
        const member = members.find((m) => m.deckId === deckId)
        return member?.session?.title || member?.label || member?.address || deckId
      }
      window.alert(
        `${result.woken} woke up. ${result.failed.length} did not:\n\n` +
          result.failed.map((f) => `${nameOf(f.deckId)}: ${f.error}`).join('\n'),
      )
    }
  }

  async function restore(id) {
    await fetch('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    load()
  }

  if (teams === null) {
    return (
      <main className="stage">
        <header className="stage-head"><div><h2>Teams</h2></div></header>
        <p className="note" style={{ padding: '16px 20px' }}>Loading...</p>
      </main>
    )
  }

  const draftCards = drafts.map((draft) => (
    <TeamDraft
      key={draft.source}
      draft={draft}
      onDismiss={() => dismissDraft(draft.source)}
      onCreateRoles={createRoles}
      onCompose={onCompose}
    />
  ))

  if (teams.length === 0 && drafts.length === 0) {
    return (
      <main className="stage">
        <header className="stage-head">
          <div>
            <h2>Teams</h2>
            <p className="stage-sub">The groups you raised, and how each one is arranged</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={onNewTeam}>New team</button>
        </header>
        <div className="stage-empty">
          <h3>No teams yet</h3>
          <p className="note">
            Raise one and it appears here: whoever hands out the work on top, a column per
            project below, and a line between any two that have actually talked.
          </p>
          <p className="note">
            Sessions started one at a time are not a team. They are in <b>All agents</b>.
          </p>
        </div>
        {/* Including here, where "no teams yet" might be wrong by one click. */}
        <PutAway teams={away} onRestore={restore} />
      </main>
    )
  }

  const open = teamId ? teams.find((t) => t.id === teamId) : null

  /*
   * One team, opened. The list answers "what have I got running"; this answers
   * "what is this one doing", and they are different enough questions that
   * stacking every team's diagram on one page answered neither — it was a wall
   * of cards again, which is the thing this screen exists to stop being.
   */
  if (teamId) {
    if (!open) {
      return (
        <main className="stage">
          <header className="stage-head">
            <div>
              <button type="button" className="crumb-back" onClick={() => onOpenTeam(null)}>
                ← Teams
              </button>
              <h2>Gone</h2>
            </div>
          </header>
          <div className="stage-empty">
            <h3>That team is no longer on the list</h3>
            <p className="note">It was dismissed, or this deck has not seen it.</p>
          </div>
        </main>
      )
    }

    const live = open.members.filter((m) => m.live).length
    const stuck = open.members.filter((m) => m.session?.deckId && m.session?.pending).length

    const asleep = sleepers(open)

    return (
      <main className="stage">
        <header className="stage-head">
          <div>
            <button type="button" className="crumb-back" onClick={() => onOpenTeam(null)}>
              ← Teams
            </button>
            <h2>{open.name}</h2>
            <p className="stage-sub">
              {live} of {open.members.length} running · raised {relativeTime(open.startedAt)}
              {stuck > 0 && <span className="stage-waiting"> · {stuck} waiting on you</span>}
              {error && <span className="where"> · {error}</span>}
            </p>
          </div>
          {asleep.length > 0 && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={waking}
              title="Start every resumable member's process again, where each left off. Nothing is sent to any of them, so nothing is spent."
              onClick={async () => {
                setWaking(true)
                await wakeTeam(asleep, open.members)
                setWaking(false)
              }}
            >
              {waking
                ? 'Waking...'
                : `Wake ${asleep.length === open.members.length ? 'team' : `${asleep.length}`}`}
            </button>
          )}
        </header>

        <div className="teams">
          <Team team={open} traffic={traffic} deck={deck} onOpenSession={onOpenSession} bare />
        </div>
      </main>
    )
  }

  const running = teams.reduce((n, t) => n + t.members.filter((m) => m.live).length, 0)
  const waiting = teams.reduce(
    (n, t) => n + t.members.filter((m) => m.session?.deckId && m.session?.pending).length,
    0,
  )

  return (
    <main className="stage">
      <header className="stage-head">
        <div>
          <h2>Teams</h2>
          <p className="stage-sub">
            {teams.length} {teams.length === 1 ? 'team' : 'teams'} · {running} running
            {drafts.length > 0 && (
              <span className="stage-waiting">
                {' '}· {drafts.length} proposed, waiting on you
              </span>
            )}
            {waiting > 0 && <span className="stage-waiting"> · {waiting} waiting on you</span>}
            {error && <span className="where"> · {error}</span>}
          </p>
        </div>
        <button type="button" className="btn" onClick={onNewTeam}>New team</button>
      </header>

      <div className="team-list">
        {/*
          Above the teams that exist, because a proposal is a decision waiting
          on you and a running team is not.
        */}
        {draftCards}
        {teams.map((team) => (
          <TeamRow
            key={team.id}
            team={team}
            onOpen={() => onOpenTeam(team.id)}
            onDismiss={() => dismiss(team.id)}
            onWake={() => wakeTeam(sleepers(team), team.members)}
          />
        ))}
        <PutAway teams={away} onRestore={restore} />
      </div>
    </main>
  )
}

/**
 * The teams you put away, and the way back.
 *
 * Folded, because it is housekeeping and not the screen's subject — but
 * present, and counted in the summary line, so that "where did it go" has an
 * answer on the same page as the thing that made it go.
 */
function PutAway({ teams, onRestore }) {
  const [open, setOpen] = useState(false)
  if (!teams.length) return null
  return (
    <div className="team-away">
      <button type="button" className="team-away-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} {teams.length} put away
      </button>
      {open && (
        <div className="team-away-list">
          {teams.map((team) => (
            <div key={team.id} className="team-away-row">
              <span className="team-away-name">{team.name}</span>
              <span className="note">
                {team.members.length} {team.members.length === 1 ? 'member' : 'members'} · put away{' '}
                {relativeTime(team.dismissedAt)}
              </span>
              <button type="button" className="btn btn-slim" onClick={() => onRestore(team.id)}>
                Bring it back
              </button>
            </div>
          ))}
          <p className="note">Kept for 60 days. Nothing here is running or stopped by being on this list.</p>
        </div>
      )}
    </div>
  )
}

/**
 * A team on the list: enough to choose one, and not a word more.
 *
 * What decides which one you open is whether something is stuck in it, so that
 * is the thing that is said loudest. The rest — who is in it, how it is
 * arranged, what each one is touching — is a click away, and putting it here
 * would make this the wall of cards the screen is trying not to be.
 */
function TeamRow({ team, onOpen, onDismiss, onWake }) {
  const [asking, setAsking] = useState(false)
  const [waking, setWaking] = useState(false)
  const asleep = sleepers(team)
  const live = team.members.filter((m) => m.live).length
  const stuck = team.members.filter((m) => m.session?.deckId && m.session?.pending).length
  const working = team.members.filter((m) => m.session?.status === 'busy').length
  const projects = [...new Set(team.members.map((m) => m.session?.project || m.project).filter(Boolean))]
  const lead = team.members.find((m) => m.delegates)

  return (
    <div className={`team-row-card ${stuck > 0 ? 'is-asking' : ''}`}>
      <button type="button" className="team-row-open" onClick={onOpen}>
        <span className="team-row-top">
          <span className="team-row-name">{team.name}</span>
          {stuck > 0 && <span className="pill is-warn">{stuck} waiting on you</span>}
          {stuck === 0 && working > 0 && <span className="pill">{working} working</span>}
        </span>
        <span className="team-row-sub">
          {live} of {team.members.length} running
          {lead && <> · {lead.label || lead.address} hands out the work</>}
          {projects.length > 0 && <> · {projects.join(' · ')}</>}
        </span>
        <span className="team-row-when">raised {relativeTime(team.startedAt)}</span>
      </button>
      {/*
        The way back from a restart, without opening the team to find it.
        After the deck has been restarted every row here reads "0 of 6
        running", and the trip into the team screen to press the same button
        is exactly the trip this list exists to save.

        Not while the × is asking its question: two decisions on one row, one
        of them "put it away", is a row you can misread in a hurry.
      */}
      {asleep.length > 0 && !asking && (
        <button
          type="button"
          className="btn btn-slim team-row-wake"
          disabled={waking}
          title="Start every resumable member's process again, where each left off. Nothing is sent to any of them, so nothing is spent."
          onClick={async () => {
            setWaking(true)
            await onWake()
            setWaking(false)
          }}
        >
          {waking
            ? 'Waking...'
            : asleep.length === team.members.length
              ? 'Wake team'
              : `Wake ${asleep.length}`}
        </button>
      )}

      {/*
        Not a bare ×. Next to a card showing five running sessions, × reads as
        "shut this down" — and the one thing it must not be mistaken for is the
        one thing it looks like. So it is asked, in the words of what happens:
        the sessions keep running, the grouping is what goes.
      */}
      {asking ? (
        <div className="team-row-confirm">
          {/* Said in the numbers on this card: "the sessions keep running" is a
              promise, and on a team where none of them is still up it would be
              a false one. */}
          <span className="note">
            {live > 0 ? (
              <>
                Put this team away? The {live} running {live === 1 ? 'session keeps' : 'sessions keep'} going —
                this only takes the group off the screen, and you can bring it back.
              </>
            ) : (
              <>
                Put this team away? Nothing in it is still running. This takes the record of who was
                in it off the screen, and you can bring it back.
              </>
            )}
          </span>
          <span className="team-row-confirm-acts">
            <button type="button" className="btn btn-slim" onClick={() => { setAsking(false); onDismiss() }}>
              Put away
            </button>
            <button type="button" className="btn btn-slim btn-ghost" onClick={() => setAsking(false)}>
              Keep it
            </button>
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="team-dismiss"
          title="Put this team away. The sessions are left running."
          onClick={() => setAsking(true)}
        >
          ×
        </button>
      )}
    </div>
  )
}

/** One team: its leads, its columns, and the lines between them. */
function Team({ team, traffic, deck, onOpenSession, bare = false }) {
  const hostRef = useRef(null)
  const cardRefs = useRef(new Map())
  const [edges, setEdges] = useState([])
  const [box, setBox] = useState({ width: 0, height: 0 })

  const leads = useMemo(() => team.members.filter((m) => m.delegates), [team])
  const rest = useMemo(() => team.members.filter((m) => !m.delegates), [team])

  const columns = useMemo(() => {
    const map = new Map()
    for (const member of rest) {
      const key = member.session?.project || member.project || 'elsewhere'
      map.set(key, [...(map.get(key) || []), member])
    }
    // Ordered by name, once, never by activity.
    return [...map].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rest])

  /*
   * Only the traffic between this team's own members. The same sessions may
   * also be talking to something outside it, and a line reaching off the edge
   * of a team to nowhere raises a question the screen cannot answer.
   */
  const mine = useMemo(() => {
    const ids = new Set(team.members.map((m) => m.session?.sessionId).filter(Boolean))
    return traffic.filter((t) => ids.has(t.from) && ids.has(t.to))
  }, [team, traffic])

  /*
   * Measured, not computed: the columns are a grid and a card grows when a
   * question parks on it, so where a line starts is something only the
   * resolved layout knows.
   */
  useLayoutEffect(() => {
    function measure() {
      const host = hostRef.current
      if (!host) return
      const origin = host.getBoundingClientRect()
      /*
       * Only when it actually changed. This runs after every render, and a
       * fresh object counts as a state change even when the numbers are
       * identical — which renders, which runs this again. That loop is how the
       * first version of this screen died the moment it was opened.
       */
      setBox((prev) => (
        prev.width === origin.width && prev.height === origin.height
          ? prev
          : { width: origin.width, height: origin.height }
      ))

      const at = (sessionId) => {
        const el = cardRefs.current.get(sessionId)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          left: r.left - origin.left,
          right: r.right - origin.left,
          top: r.top - origin.top,
          bottom: r.bottom - origin.top,
          cx: r.left - origin.left + r.width / 2,
          cy: r.top - origin.top + r.height / 2,
        }
      }

      const now = Date.now()
      const next = []
      for (const edge of mine) {
        const a = at(edge.from)
        const b = at(edge.to)
        if (!a || !b) continue
        let d
        if (Math.abs(a.cy - b.cy) > 40) {
          const top = a.cy < b.cy ? a : b
          const low = a.cy < b.cy ? b : a
          const mid = (top.bottom + low.top) / 2
          d = `M ${top.cx} ${top.bottom} C ${top.cx} ${mid}, ${low.cx} ${mid}, ${low.cx} ${low.top}`
        } else {
          // Sideways and dipped under both: between two areas there is no
          // hierarchy, and a straight line across would read as one.
          const left = a.cx < b.cx ? a : b
          const right = a.cx < b.cx ? b : a
          const dip = Math.max(left.bottom, right.bottom) + 28
          d = `M ${left.right} ${left.cy} C ${left.right + 40} ${dip}, ${right.left - 40} ${dip}, ${right.left} ${right.cy}`
        }
        next.push({ key: `${edge.from}>${edge.to}`, d, recent: now - edge.at < RECENT_MS })
      }
      setEdges((prev) => (sameEdges(prev, next) ? prev : next))
    }

    measure()
    const observer = new ResizeObserver(measure)
    if (hostRef.current) observer.observe(hostRef.current)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [mine, columns, leads])

  const setCardRef = (sessionId) => (el) => {
    if (!sessionId) return
    if (el) cardRefs.current.set(sessionId, el)
    else cardRefs.current.delete(sessionId)
  }

  return (
    <section className={bare ? 'team-block is-bare' : 'team-block'}>
      <div className="team-stage" ref={hostRef}>
        <svg className="team-wires" width={box.width} height={box.height} aria-hidden="true">
          {edges.map((edge) => (
            <path key={edge.key} d={edge.d} className={`team-wire ${edge.recent ? 'is-recent' : ''}`} />
          ))}
        </svg>

        {leads.length > 0 && (
          <div className="team-leads">
            <div className="team-band"><span>hands out the work</span></div>
            <div className="team-row">
              {leads.map((member) => (
                <Member
                  key={member.deckId}
                  member={member}
                  deck={deck}
                  onOpenSession={onOpenSession}
                  cardRef={setCardRef(member.session?.sessionId)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="team-columns">
          {columns.map(([project, list]) => (
            <section key={project} className="team-column">
              <div className="team-band"><span>{project}</span></div>
              {list.map((member) => (
                <Member
                  key={member.deckId}
                  member={member}
                  deck={deck}
                  onOpenSession={onOpenSession}
                  cardRef={setCardRef(member.session?.sessionId)}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * A member, which is a session when there is one and a name when there is not.
 *
 * The gone card is deliberately plain and deliberately present: it is how the
 * screen says "this team had four" without pretending the fourth is still here.
 */
function Member({ member, deck, onOpenSession, cardRef }) {
  if (!member.live) {
    return (
      <div className="team-slot">
        <div className="session-card is-gone">
          <div className="session-card-head is-static">
            <span className="dot dot-unknown" aria-hidden="true" />
            <span className="session-card-name">{member.label || member.address}</span>
            <span className="session-card-state">gone</span>
          </div>
          <div className="session-card-where is-addr">{member.address}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="team-slot" ref={cardRef}>
      <SessionCard session={member.session} deck={deck} address onOpen={onOpenSession} />
    </div>
  )
}
