import { useEffect, useMemo, useState } from 'react'
import { AskBody } from './Ask.jsx'

/**
 * AskToasts — every ask blocked on you, floating over whatever you are
 * looking at.
 *
 * The deck always knew what was waiting; what it did not have was a way to
 * answer without going there. A permission prompt raised in one session while
 * you were reading another meant leaving the screen you were on, finding the
 * row, answering, and coming back to a sidebar that had rearranged itself in
 * the meantime. The answer itself was one click; everything around it was the
 * chore.
 *
 * So the ask comes to you. Top right, over everything, with its own buttons:
 * you answer where you are and carry on, and the session you were reading
 * never moves.
 *
 * Three rules this keeps, and none of them are styling:
 *
 * - Nothing here ever times out. These are not notifications about something
 *   that happened — they are a process stopped dead waiting for an answer,
 *   and a toast that fades away on its own would leave it stopped for ever.
 *   They leave when they are answered, or when you put them away.
 *
 * - Only asks the deck can actually answer get one. A session running in
 *   somebody's terminal has no deckId and its prompt lives on its own TTY:
 *   there is nothing for a button here to send.
 *
 * - A question is not a permission. `AskUserQuestion` is asked because the
 *   options need weighing, and weighing them means reading the conversation
 *   they came out of — so its toast says what is being asked and takes you
 *   there, rather than pretending a corner of the screen is enough context to
 *   decide in. This is the same line the inbox draws, drawn the same way.
 */

/** How many are shown at once; the rest are counted, not stacked. */
const MAX_SHOWN = 3

/** What identifies the session an ask belongs to, whoever launched it. */
export function askKey(session) {
  return session?.deckId || session?.sessionId || null
}

function Where({ ask, onOpen, onDismiss }) {
  return (
    <header className="toast-head">
      <button
        type="button"
        className="toast-jump"
        onClick={onOpen}
        title="Open this session"
      >
        <span className="toast-name">{ask.name}</span>
        {ask.project && <span className="toast-project">{ask.project}</span>}
      </button>
      {/*
        Putting it away is not answering it. The session stays blocked, the
        sidebar dot stays amber and "What needs you" still counts it — this
        only says "not from here, not now", for people who would rather answer
        in the conversation.
      */}
      <button
        type="button"
        className="toast-close"
        onClick={onDismiss}
        title="Hide this — the session stays blocked until you answer it"
        aria-label="Hide this ask"
      >
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M2 2 L10 10 M10 2 L2 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </header>
  )
}

/**
 * The toast is the frame; what is inside it is the same ask the session's own
 * card draws, from the same place. A question and a permission differ in what
 * they offer, and `AskBody` is where that difference is decided.
 */
function Toast({ ask, onAnswer, onOpen, onDismiss }) {
  const pending = ask.pending
  const tone = pending.questions ? 'is-question' : (pending.defaultToNo ? 'is-careful' : '')

  return (
    <section className={`toast ${tone}`} role="alert">
      <Where ask={ask} onOpen={onOpen} onDismiss={onDismiss} />
      <AskBody pending={pending} deckId={ask.deckId} onAnswer={onAnswer} onOpen={onOpen} />
    </section>
  )
}

export default function AskToasts({ sessions, deck, hideFor, silent, onOpenSession, onOpenInbox }) {
  /*
   * Keyed by requestId rather than by session: a session with several asks
   * parked behind each other hands you the next one after you answer, and
   * putting one away must not also put away one you have not seen yet.
   */
  const [dismissed, setDismissed] = useState(() => new Set())

  const asks = useMemo(
    () =>
      sessions
        .filter((s) => s.pending && s.deckId && askKey(s) !== hideFor)
        .map((s) => ({
          deckId: s.deckId,
          name: s.name,
          project: s.project,
          sessionId: s.sessionId,
          pending: s.pending,
        })),
    [sessions, hideFor],
  )

  /*
   * An answered ask leaves the list, and its id must leave with it — a set
   * that only ever grows is a slow leak in a panel nobody reloads for days,
   * and a requestId that outlives its ask could in principle silence a later
   * one.
   */
  useEffect(() => {
    setDismissed((current) => {
      if (current.size === 0) return current
      const live = new Set(asks.map((a) => a.pending.requestId))
      const next = new Set([...current].filter((id) => live.has(id)))
      return next.size === current.size ? current : next
    })
  }, [asks])

  /*
   * Silenced rather than unmounted, so what you put away stays put away
   * across a trip to the queue and back.
   */
  const showing = silent ? [] : asks.filter((a) => !dismissed.has(a.pending.requestId))
  if (showing.length === 0) return null

  const shown = showing.slice(0, MAX_SHOWN)
  const rest = showing.length - shown.length

  function dismiss(requestId) {
    setDismissed((current) => new Set(current).add(requestId))
  }

  return (
    /*
     * `polite` rather than `assertive`: a screen reader in the middle of a
     * sentence should finish it. The cards themselves are alerts, so each one
     * is announced as it lands.
     */
    <div className="toasts" role="region" aria-label="Waiting on you" aria-live="polite">
      {shown.map((ask) => (
        <Toast
          key={ask.pending.requestId}
          ask={ask}
          onAnswer={deck.answer}
          onOpen={() => onOpenSession(ask)}
          onDismiss={() => dismiss(ask.pending.requestId)}
        />
      ))}

      {/* Past three, the corner stops being readable and starts being a wall.
          The rest are counted and the queue is one click away. */}
      {rest > 0 && (
        <button type="button" className="toast-more" onClick={onOpenInbox}>
          {rest} more waiting on you
        </button>
      )}
    </div>
  )
}
