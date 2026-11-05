import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { STATUS_LABEL, shortPath, relativeTime } from './format.js'

/**
 * Room — what the sessions are saying to each other.
 *
 * The teams screen answers "what is everything doing". This answers the one you
 * have once two of them are working the same repo: what did they agree, who
 * conceded, and are they waiting on me. Until now that lived in two
 * transcripts and could only be read by opening both and going by timestamp.
 *
 * Three things decide how it looks, and all three come from the data rather
 * than from taste.
 *
 * Identity is the lane, not the colour. The deck's status hues already carry
 * meaning everywhere else, and they are already at capacity — busy and shell
 * are 7.5 apart under deuteranopia, well under the separation this palette
 * claims. Adding two speaker hues would overload a channel that is full.
 * Left and right cost nothing and are unambiguous.
 *
 * Turns are shut by default. They run to two thousand characters of dense
 * argument; open, a dozen of them is a wall nobody reads. The `summary` the
 * sending model wrote is a five-word headline, and in a row those headlines
 * are the minutes of the meeting.
 *
 * Silence is content. The band between turns says how long they went quiet,
 * because a supervisor's real question is whether this is still moving.
 */

/** Rooms are polled, not pushed: this screen is one of several. */
const POLL_MS = 4000

function Dot({ status }) {
  return <span className={`dot dot-${status}`} aria-hidden="true" />
}

/** "7m 11s", and never "0s" where a duration is not the point. */
function duration(msValue) {
  if (!msValue || msValue < 1000) return null
  const seconds = Math.round(msValue / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

function clock(at) {
  if (!at) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function day(at) {
  if (!at) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/**
 * One turn, on its speaker's side.
 *
 * `side` is 'a' or 'b' for a two-session room and null when there are more,
 * where lanes stop working and every turn carries its speaker's name instead.
 */
function Turn({ turn, who, side, open, onToggle }) {
  const gap = duration(turn.gapBefore)
  const lag = turn.deliveredAt && turn.at
    ? duration(Date.parse(turn.deliveredAt) - Date.parse(turn.at))
    : null

  return (
    <>
      {gap && (
        <div className="room-gap">
          <span className="room-gap-label">quiet · {gap}</span>
        </div>
      )}

      <div className={`room-turn ${side ? `from-${side}` : 'from-none'} ${open ? 'is-open' : ''}`}>
        <div className="room-slot-a">
          {side !== 'b' && (
            <button className="room-card" onClick={onToggle} aria-expanded={open}>
              <span className="room-card-head">
                {!side && <span className="room-speaker">{who}</span>}
                <span className="room-summary">{turn.summary || 'sent a message'}</span>
                <span className="room-chev" aria-hidden="true">›</span>
              </span>
              {!open && <span className="room-preview">{turn.preview || ''}</span>}
              {open && <span className="room-body">{turn.text}</span>}
              <span className="room-card-foot">
                <span>{clock(turn.at)}</span>
                {lag
                  ? <span title="Time it sat queued before the peer read it">delivered +{lag}</span>
                  : <span className="room-undelivered" title="No session recorded receiving this">no delivery recorded</span>}
                {turn.hops && <span title={turn.hops}>relayed</span>}
              </span>
            </button>
          )}
        </div>

        <div className="room-node" aria-hidden="true">
          <span className="room-node-mark" />
        </div>

        <div className="room-slot-b">
          {side === 'b' && (
            <button className="room-card" onClick={onToggle} aria-expanded={open}>
              <span className="room-card-head">
                <span className="room-chev" aria-hidden="true">›</span>
                <span className="room-summary">{turn.summary || 'sent a message'}</span>
              </span>
              {!open && <span className="room-preview">{turn.preview || ''}</span>}
              {open && <span className="room-body">{turn.text}</span>}
              <span className="room-card-foot">
                {turn.hops && <span title={turn.hops}>relayed</span>}
                {lag
                  ? <span title="Time it sat queued before the peer read it">delivered +{lag}</span>
                  : <span className="room-undelivered" title="No session recorded receiving this">no delivery recorded</span>}
                <span>{clock(turn.at)}</span>
              </span>
            </button>
          )}
        </div>
      </div>
    </>
  )
}

function Lane({ person, align, onOpenSession }) {
  return (
    <div className={`room-lane ${align}`}>
      <button
        className="room-lane-id"
        onClick={() => person.live && onOpenSession?.(person)}
        disabled={!person.live}
        title={person.live ? 'Open this session' : 'This session has ended'}
      >
        {person.name}
      </button>
      {person.cwd && <div className="room-lane-where">{shortPath(person.cwd)}</div>}
      <div className={`room-lane-state state-${person.live ? person.status : 'gone'}`}>
        {person.live
          ? <><Dot status={person.status} /> {person.waitingFor || STATUS_LABEL[person.status] || person.status}</>
          : <>ended</>}
      </div>
    </div>
  )
}

export default function Room({ onOpenSession }) {
  const [rooms, setRooms] = useState([])
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [open, setOpen] = useState(() => new Set())
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const timer = useRef(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/meetings')
      const data = await response.json()
      setRooms(data.rooms || [])
      setError(null)
    } catch {
      setError('Could not reach the deck')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    timer.current = setInterval(load, POLL_MS)
    return () => clearInterval(timer.current)
  }, [load])

  // The list carries no bodies, so opening a room fetches them once.
  useEffect(() => {
    if (!selected) { setDetail(null); return }
    let cancelled = false
    fetch(`/api/meeting/${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setDetail(data.room || null) })
      .catch(() => { if (!cancelled) setDetail(null) })
    return () => { cancelled = true }
  }, [selected])

  const current = useMemo(
    () => detail || rooms.find((one) => one.id === selected) || null,
    [detail, rooms, selected],
  )

  const toggle = useCallback((key) => {
    setOpen((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  if (loading) {
    return (
      <main className="stage">
        <header className="stage-head"><div><h2>Room</h2></div></header>
        <p className="note" style={{ padding: '0 20px' }}>Reading the transcripts…</p>
      </main>
    )
  }

  if (!rooms.length) {
    return (
      <main className="stage">
        <header className="stage-head">
          <div>
            <h2>Room</h2>
            <p className="stage-sub">What your sessions say to each other</p>
          </div>
        </header>
        <div className="stage-empty">
          <p>No session has spoken to another one yet.</p>
          <p className="note">
            When one session messages another, the whole exchange appears here as one thread.
          </p>
        </div>
      </main>
    )
  }

  /* The list, when nothing is picked. */
  if (!current) {
    return (
      <main className="stage">
        <header className="stage-head">
          <div>
            <h2>Room</h2>
            <p className="stage-sub">
              {rooms.length === 1 ? '1 conversation' : `${rooms.length} conversations`}
              {error && <span className="where"> · {error}</span>}
            </p>
          </div>
        </header>

        <div className="room-list">
          {rooms.map((room) => (
            <button key={room.id} className="room-entry" onClick={() => setSelected(room.id)}>
              <span className="room-entry-who">
                {room.participants.map((person, i) => (
                  <span key={person.sessionId}>
                    {i > 0 && <span className="room-entry-x"> ⇄ </span>}
                    {person.live && <Dot status={person.status} />}
                    {person.name}
                  </span>
                ))}
              </span>
              <span className="room-entry-meta">
                {room.turns.length} {room.turns.length === 1 ? 'message' : 'messages'}
                {room.cwd && <> · {shortPath(room.cwd)}</>}
                <> · {day(room.startedAt)} {clock(room.startedAt)}</>
                {room.live && <span className="room-entry-live">live</span>}
              </span>
            </button>
          ))}
        </div>
      </main>
    )
  }

  /* One room. */
  const people = current.participants
  const pair = people.length === 2
  const sideOf = (sessionId) => {
    if (!pair) return null
    return sessionId === people[0].sessionId ? 'a' : 'b'
  }
  const nameOf = (sessionId) =>
    people.find((p) => p.sessionId === sessionId)?.name || sessionId.slice(0, 8)

  const waiting = people.filter((p) => p.live && p.status === 'waiting')

  return (
    <main className="stage">
      <header className="stage-head">
        <div>
          <button className="room-back" onClick={() => setSelected(null)}>‹ All conversations</button>
          <h2>{people.map((p) => p.name).join('  ⇄  ')}</h2>
          <p className="stage-sub">
            {current.turns.length} messages · {day(current.startedAt)} {clock(current.startedAt)} → {clock(current.endedAt)}
            {current.cwd && <> · {shortPath(current.cwd)}</>}
          </p>
        </div>
      </header>

      {waiting.length > 0 && (
        <div className="room-blocked">
          <Dot status="waiting" />
          <span>
            {waiting.map((p) => p.name).join(' and ')}
            {waiting.length === 1 ? ' is' : ' are'} waiting on you
            {waiting[0].waitingFor ? ` — ${waiting[0].waitingFor}` : ''}
          </span>
          {waiting.length === 1 && (
            <button className="room-blocked-go" onClick={() => onOpenSession?.(waiting[0])}>
              Open session
            </button>
          )}
        </div>
      )}

      {pair && (
        <div className="room-lanes">
          <Lane person={people[0]} align="left" onOpenSession={onOpenSession} />
          <div className="room-lane-spacer" />
          <Lane person={people[1]} align="right" onOpenSession={onOpenSession} />
        </div>
      )}

      <div className="room-thread">
        {current.turns.map((turn, i) => {
          const key = `${current.id}:${i}`
          return (
            <Turn
              key={key}
              turn={turn}
              who={nameOf(turn.from)}
              side={sideOf(turn.from)}
              open={open.has(key)}
              onToggle={() => toggle(key)}
            />
          )
        })}
      </div>

      <p className="room-foot note">
        Read from both transcripts. Nothing here is inferred: a message with no
        recorded arrival is marked, not guessed at.
        {current.live ? '' : ` Last word ${relativeTime(Date.parse(current.endedAt))}.`}
      </p>
    </main>
  )
}
