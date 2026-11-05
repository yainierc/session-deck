import { useState } from 'react'

/**
 * Ask.jsx — one ask, and the one place that answers it.
 *
 * A parked ask is now drawn in two places: floating over whatever you are
 * looking at (`AskToasts`), and inside the card of the session that raised it
 * (`SessionCard`, on the teams screen). They are two surfaces for the same
 * decision, so the decision lives here and neither of them owns it.
 *
 * What is shared is not the layout — a toast and a card want different
 * spacing — but the behaviour around the buttons, which is the part with a
 * failure mode: a click must be sent once, the buttons must be dead while it
 * is in flight, and a send that fails has to give them back. Two copies of
 * that drift, and the copy that drifts is the one you press at three in the
 * morning.
 */

/**
 * The buttons of a permission ask, and the send behind them.
 *
 * `onAnswer` is `deck.answer`. It resolves to the server's reply rather than
 * throwing, so a refusal arrives here as `{ ok: false, error }`.
 */
export function PermissionChoices({ pending, deckId, onAnswer, size = 'slim' }) {
  const [sent, setSent] = useState(null)
  const [error, setError] = useState(null)

  async function answer(decision) {
    if (sent) return
    setSent(decision)
    setError(null)
    const result = await onAnswer(deckId, pending.requestId, decision)
    /*
     * Nothing removes itself on success: the session list does that, when the
     * server says the ask is gone. Failing, though, has to give the buttons
     * back — otherwise this is a dead end with no way out but a reload.
     */
    if (!result?.ok) {
      setSent(null)
      setError(result?.error || 'Could not send that')
    }
  }

  const cls = `btn btn-${size}`

  return (
    <>
      {error && <p className="toast-error">{error}</p>}
      <div className="toast-actions">
        <button className={`${cls} btn-deny`} onClick={() => answer('deny')} disabled={Boolean(sent)}>
          {sent === 'deny' ? 'Denying...' : 'Deny'}
        </button>
        {/*
          Offered only when the SDK says the rule it would write covers no more
          than the thing being asked about — the same restraint the card in the
          conversation shows, and for the same reason.
        */}
        {pending.canAlwaysAllow && (
          <button
            className={cls}
            onClick={() => answer('always')}
            disabled={Boolean(sent)}
            title="Allow this, and stop asking for it"
          >
            {sent === 'always' ? '...' : 'Always'}
          </button>
        )}
        <button
          className={`${cls} ${pending.defaultToNo ? '' : 'btn-primary'}`}
          onClick={() => answer('allow')}
          disabled={Boolean(sent)}
        >
          {sent === 'allow' ? 'Allowing...' : 'Allow once'}
        </button>
      </div>
    </>
  )
}

/**
 * What the ask says, without deciding where it sits.
 *
 * A question is not a permission, and the difference is not cosmetic: an
 * `AskUserQuestion` is asked because the options need weighing, and weighing
 * them means reading the conversation they came out of. So it says what is
 * being asked and takes you there. This is the same line the inbox and the
 * toasts already draw, drawn once.
 */
export function AskBody({ pending, deckId, onAnswer, onOpen }) {
  if (pending.questions) {
    const first = pending.questions[0]
    const more = pending.questions.length - 1
    return (
      <>
        <p className="toast-title">{first?.question || 'It is asking you something'}</p>
        {more > 0 && (
          <p className="toast-sub">and {more} more {more === 1 ? 'question' : 'questions'}</p>
        )}
        <div className="toast-actions">
          <button className="btn btn-slim btn-primary" onClick={onOpen}>Answer</button>
        </div>
      </>
    )
  }

  return (
    <>
      <p className="toast-title">
        {pending.title}
        {pending.defaultToNo && <span className="toast-warn">careful</span>}
      </p>
      {pending.detail && <pre className="toast-detail">{pending.detail}</pre>}
      <PermissionChoices pending={pending} deckId={deckId} onAnswer={onAnswer} />
    </>
  )
}
