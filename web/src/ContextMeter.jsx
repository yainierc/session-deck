/**
 * ContextMeter — how full this session's context window is.
 *
 * Not a warning light. Claude Code compacts the conversation on its own when
 * the window fills, so a full context is not a failure and there is nothing
 * here to avert: offering "start a fresh session" at 90% would trade a summary
 * for total amnesia. What the bar is for is that compaction is silent and
 * lossy — afterwards the fine detail of the last hour is a paragraph. Seeing
 * 85% is what lets you land a commit before that happens.
 */
import { useEffect, useRef, useState } from 'react'

/** Where the bar changes colour. Below the first, it says nothing at all. */
const WARM = 70
const HOT = 90

export default function ContextMeter({ session, deck, working, onReading }) {
  // Only the deck's own sessions can answer. One running in a terminal is
  // observed, not driven, so there is no handle to ask through.
  const deckId = session?.managed ? session.deckId : null
  const [usage, setUsage] = useState(null)

  /*
   * `deck` is rebuilt on every render of the hook that owns it, so depending
   * on it here would refetch on every keystroke in the composer. The ref keeps
   * the latest one without making the effect care that it changed.
   */
  const deckRef = useRef(deck)
  deckRef.current = deck
  const onReadingRef = useRef(onReading)
  onReadingRef.current = onReading

  useEffect(() => {
    if (!deckId) {
      setUsage(null)
      return
    }
    /*
     * Not while a turn is in flight. The reading is taken from the last
     * completed response, so asking mid-turn costs a round trip to be told
     * what we already knew — and `working` dropping is exactly the moment the
     * number changed, which is what re-runs this.
     */
    if (working) return

    let alive = true
    deckRef.current.contextUsage(deckId).then((result) => {
      // A session that ended, or one the panel navigated away from, answers
      // late. Writing that into state would leave a stale bar over a new
      // session, so a reply nobody is waiting for is dropped.
      if (!alive) return
      const next = result?.ok ? result.usage : null
      setUsage(next)
      // The header's Handoff button warms up from the same reading, so it is
      // taken once and shared rather than asked for twice.
      onReadingRef.current?.(next ? Math.round(next.percentage) : null)
    })
    return () => { alive = false }
  }, [deckId, working])

  // No reading is the normal case for most sessions: observed ones cannot be
  // asked, and a suspended one has nothing running to ask. Both draw nothing
  // rather than an empty bar, which would read as "plenty of room left".
  if (!usage) return null

  const pct = Math.round(usage.percentage)
  const tone = pct >= HOT ? 'is-hot' : pct >= WARM ? 'is-warm' : ''

  /*
   * The percentage can pass 100 — it is measured against the window the
   * session gets compacted at, not a hard ceiling. The fill is clamped so the
   * bar cannot overflow its track; the number is not, because "104%" is the
   * honest reading and rounding it down to 100 would hide the interesting part.
   */
  const fill = Math.min(pct, 100)

  const room = usage.tokens != null && usage.max != null
    ? `${usage.tokens.toLocaleString()} of ${usage.max.toLocaleString()} tokens`
    : `${pct}% of the context window`

  const fate = usage.compacts
    ? 'At the top, the conversation so far is summarised automatically and the session keeps going — the summary is shorter than what it replaces, so detail is lost.'
    : 'Auto-compaction is off for this session, so the top of this bar is the end of the window rather than a summary.'

  return (
    <span className={`ctx ${tone}`} title={`Context: ${room}. ${fate}`}>
      <span className="ctx-track">
        <span className="ctx-fill" style={{ width: `${fill}%` }} />
      </span>
      <span className="ctx-pct">{pct}%</span>
    </span>
  )
}
