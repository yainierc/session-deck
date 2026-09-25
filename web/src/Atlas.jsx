import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FileMap from './FileMap.jsx'
import { STATUS_LABEL, shortPath } from './format.js'

/**
 * Atlas — every agent at once.
 *
 * The session view answers "what is this one doing". This answers "what is
 * everything doing", which is the question you actually have when four of
 * them are running and you stepped away for ten minutes. Each card is one
 * session's map, live, with the counters that say whether it is reading
 * around or actually changing things.
 *
 * Each card is its own chart, not a slice of a shared one: the three hues
 * rank the folders *within* a session, so the same colour in two cards means
 * "this session's busiest folder" rather than one particular directory. That
 * is why every hub is labelled on the map itself — across cards, the label is
 * the identity and the colour is only emphasis.
 */

/** Activity is pulled, not pushed, so this is how fresh the atlas is. */
const POLL_MS = 2000

export default function Atlas({ sessions, onOpenSession }) {
  const [activity, setActivity] = useState([])
  const [error, setError] = useState(null)
  const timerRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/activity')
      const data = await response.json()
      setActivity(data.sessions || [])
      setError(null)
    } catch {
      // A dropped poll is not worth a banner; a run of them is.
      setError('Could not reach the deck')
    }
  }, [])

  useEffect(() => {
    load()
    timerRef.current = setInterval(load, POLL_MS)
    return () => clearInterval(timerRef.current)
  }, [load])

  const byId = useMemo(() => {
    const map = new Map()
    for (const entry of activity) map.set(entry.sessionId, entry)
    return map
  }, [activity])

  /*
   * Busiest first, and "busy" means recently, not in total: a session that
   * touched forty files an hour ago is not what you came here to look at.
   */
  const cards = useMemo(() => {
    const now = Date.now()
    return sessions
      .filter((session) => session.sessionId)
      .map((session) => {
        const entry = byId.get(session.sessionId)
        const events = entry?.events || []
        let recent = 0
        let edits = 0
        let failures = 0
        const files = new Set()
        for (const event of events) {
          files.add(event.path)
          if (event.action === 'edit' || event.action === 'write') edits += 1
          if (event.failed) failures += 1
          const at = event.at ? Date.parse(event.at) : 0
          if (at && now - at < 120_000) recent += 1
        }
        return {
          session,
          events,
          cwd: entry?.cwd || session.cwd,
          files: files.size,
          edits,
          failures,
          recent,
        }
      })
      .sort((a, b) => b.recent - a.recent || b.files - a.files)
  }, [sessions, byId])

  if (cards.length === 0) {
    return (
      <main className="stage">
        <header className="stage-head">
          <div>
            <h2>All agents</h2>
            <p className="stage-sub">Every running session, and what it is touching</p>
          </div>
        </header>
        <div className="atlas-empty">
          <h3>Nothing is running</h3>
          <p className="note">Start a task and it will appear here as it works.</p>
        </div>
      </main>
    )
  }

  return (
    <main className="stage">
      <header className="stage-head">
        <div>
          <h2>All agents</h2>
          <p className="stage-sub">
            {cards.length} {cards.length === 1 ? 'session' : 'sessions'} · busiest first
            {error && <span className="where">{error}</span>}
          </p>
        </div>
      </header>

      <div className="atlas">
        {cards.map((card) => (
          <button
            key={card.session.sessionId}
            className={`atlas-card ${card.recent > 0 ? 'is-live' : ''}`}
            onClick={() => onOpenSession(card.session)}
            title={`Open ${card.session.name}`}
          >
            <div className="atlas-head">
              <span className={`dot dot-${card.session.status}`} aria-hidden="true" />
              <span className="atlas-name">{card.session.name}</span>
              <span className="atlas-state">
                {card.session.status === 'waiting'
                  ? card.session.waitingFor || 'needs you'
                  : STATUS_LABEL[card.session.status] || card.session.status}
              </span>
            </div>
            <div className="atlas-where">{shortPath(card.cwd)}</div>

            <div className="atlas-map">
              <FileMap
                compact
                key={card.session.sessionId}
                events={card.events}
                cwd={card.cwd}
                live={card.session.status === 'busy'}
              />
            </div>

            <div className="atlas-foot">
              <span>{card.files} {card.files === 1 ? 'file' : 'files'}</span>
              <span>{card.edits} changed</span>
              {card.failures > 0 && <span className="is-critical">✕ {card.failures} failed</span>}
            </div>
          </button>
        ))}
      </div>
    </main>
  )
}
