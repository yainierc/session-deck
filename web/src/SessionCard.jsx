import { AskBody } from './Ask.jsx'
import { STATUS_LABEL, shortPath } from './format.js'

/**
 * SessionCard.jsx — one session, as a card.
 *
 * One screen draws this now: the team, where a card's position is fixed by
 * project and by role. There were two. The other was the atlas — every
 * running session as a grid, ordered by who had touched most files in the
 * last two minutes, each card carrying a live treemap of what it was writing
 * to. It went, and this card lost the map with it.
 *
 * Worth knowing why, because the map was the better-looking half: it answered
 * "what is everything doing" by watching the files, and the teams screen
 * answers the same question by reading the arrangement you declared. One of
 * those is a guess made from activity and the other is what you said when you
 * raised the team, and when they disagreed the arrangement was right.
 *
 * ### What it stops being when it stops
 *
 * A card with an ask parked on it shows the ask, with its own Deny and Allow,
 * in the body of the card. Everything else here is a label; that is the only
 * part you can act on, so when it is there it gets the room.
 */
export default function SessionCard({ session, deck, address = false, onOpen, children }) {
  /*
   * Only an ask the deck can answer gets buttons. A session running in
   * somebody's terminal has no deckId and its prompt lives on its own TTY, so
   * the card says it is waiting and stops there.
   */
  const ask = session.deckId && deck ? session.pending : null

  return (
    <div className={`session-card ${ask ? 'is-asking' : ''}`}>
      {/*
        The head is the way in, rather than the whole card being one button: a
        card that contains Deny and Allow cannot also be a button, and nesting
        them would be a click whose meaning depends on where in the card it
        landed.
      */}
      <button
        type="button"
        className="session-card-head"
        onClick={() => onOpen(session)}
        title={`Open ${session.name}`}
      >
        <span className={`dot dot-${session.status}`} aria-hidden="true" />
        <span className="session-card-name">{session.name}</span>
        <span className="session-card-state">
          {session.status === 'waiting'
            ? session.waitingFor || 'needs you'
            : STATUS_LABEL[session.status] || session.status}
        </span>
      </button>

      {/*
        The folder, or the address — the caller decides. On a team the address
        is not decoration: it is the string the others have been told to write
        into SendMessage, and two cards both labelled "Backend" are two
        identical cards without it.
      */}
      <div className={`session-card-where ${address && session.peerName ? 'is-addr' : ''}`}>
        {address && session.peerName ? session.peerName : shortPath(session.cwd)}
      </div>

      {ask && (
        <div className={`session-card-ask ${ask.questions ? 'is-question' : ask.defaultToNo ? 'is-careful' : ''}`}>
          <AskBody
            pending={ask}
            deckId={session.deckId}
            onAnswer={deck.answer}
            onOpen={() => onOpen(session)}
          />
          {session.pendingCount > 1 && (
            <p className="toast-sub">and {session.pendingCount - 1} more waiting behind it</p>
          )}
        </div>
      )}

      {children}
    </div>
  )
}
