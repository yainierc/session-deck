import { useEffect, useState } from 'react'

/**
 * Handoff.jsx — passing the work on to a new session.
 *
 * The button does nothing the composer could not: it sends `/handoff`, the
 * user-level skill, as if you had typed it. The skill measures the repository
 * and writes `docs/sessions/handoff-<date>-<slug>.md`. What the deck adds is
 * the two ends — reminding you before the context fills, and noticing the
 * note once it exists so the next session can start from it.
 *
 * Not the same thing as handoff.js on the server, which carries the deck's
 * own sessions across a restart. See src/handoff-notes.js.
 */

/**
 * Where the button warms up. Below ContextMeter's own WARM (70) on purpose:
 * a handoff wants the detail that compaction is about to summarise away, so
 * the time to write one is before the bar starts to look worrying.
 */
export const HANDOFF_WARM = 60

/** The notes of the project this folder belongs to. `key` refetches. */
export function useHandoffNotes(cwd, key) {
  const [notes, setNotes] = useState(null)
  useEffect(() => {
    if (!cwd) { setNotes(null); return }
    let alive = true
    fetch(`/api/handoffs?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((data) => { if (alive) setNotes(data.handoffs || []) })
      .catch(() => { if (alive) setNotes([]) })
    return () => { alive = false }
  }, [cwd, key])
  return notes
}

/** The note's path as you would type it inside its own checkout. */
export function notePath(note) {
  return note.file.startsWith(note.checkout + '/') ? note.file.slice(note.checkout.length + 1) : note.file
}

/** What the new session is asked to do with a note. */
export function promptFor(note) {
  return `Read ${notePath(note)} and verify its "State" section against the repo before doing anything. Then continue with step 1 of "Remaining".`
}

export function HandoffButton({ pct, disabled, onClick }) {
  const warm = pct != null && pct >= HANDOFF_WARM
  return (
    <button
      type="button"
      className={`ctl ctl-handoff${warm ? ' is-warm' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={warm
        ? `Context is at ${pct}%. Write a handoff now, while the detail is still here, and continue in a new session.`
        : 'Run /handoff: write down where this work stands so a new session can pick it up'}
    >
      {warm && <span className="ctl-dot" aria-hidden="true" />}
      Handoff
    </button>
  )
}

/**
 * The note this session just wrote, once its turn is over.
 *
 * Looked for when the session stops working rather than polled: the skill
 * writes the file during the turn, so the end of the turn is the first moment
 * it can be there, and the last one worth checking.
 */
export function HandoffReady({ cwd, askedAt, working, onStart, onDismiss }) {
  // Refetch each time a turn ends after the ask.
  const [turns, setTurns] = useState(0)
  useEffect(() => { if (!working) setTurns((n) => n + 1) }, [working])
  const notes = useHandoffNotes(!working ? cwd : null, turns)

  if (working || !notes) return null
  // A little slack: the clock that stamped the file is the same machine, but
  // the click and the write are seconds apart either way.
  const note = notes.find((n) => n.mtime >= askedAt - 5000 && n.checkout === cwd)
    || notes.find((n) => n.mtime >= askedAt - 5000)
  if (!note) return null

  return (
    <div className="handoff-ready" role="status">
      <div className="handoff-ready-head">Handoff ready</div>
      <div className="handoff-ready-path" title={note.file}>{notePath(note)}</div>
      <div className="handoff-ready-row">
        <button type="button" className="btn btn-slim btn-primary" onClick={() => onStart(note)}>
          Start a new session from it
        </button>
        <button type="button" className="btn btn-slim" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  )
}
