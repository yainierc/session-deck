import { useState } from 'react'

/**
 * The whole point of phase 2: the permission prompt that used to live in a
 * terminal, as a card with buttons.
 *
 * Two rules come from the SDK and are worth honouring rather than styling
 * away: some asks must open on the decline option, and some must not offer
 * "always allow" because the rule they would write grants more than the
 * action being asked about.
 */
export default function PermissionCard({ pending, onAnswer }) {
  const [sent, setSent] = useState(null)

  async function answer(decision) {
    if (sent) return
    setSent(decision)
    const result = await onAnswer(pending.requestId, decision)
    if (!result?.ok) setSent(null)
  }

  return (
    <section className={`permission ${pending.defaultToNo ? 'is-careful' : ''}`}>
      <header className="permission-head">
        <span className="permission-tool">{pending.title}</span>
        {pending.defaultToNo && <span className="permission-warn">needs a careful look</span>}
      </header>

      {pending.detail && <pre className="permission-detail">{pending.detail}</pre>}

      <div className="permission-actions">
        <button className="btn btn-deny" onClick={() => answer('deny')} disabled={Boolean(sent)}>
          {sent === 'deny' ? 'Denying...' : 'Deny'}
        </button>
        {pending.canAlwaysAllow && (
          <button className="btn" onClick={() => answer('always')} disabled={Boolean(sent)}>
            {sent === 'always' ? 'Allowing...' : 'Always allow'}
          </button>
        )}
        <button
          className={`btn ${pending.defaultToNo ? '' : 'btn-primary'}`}
          onClick={() => answer('allow')}
          disabled={Boolean(sent)}
        >
          {sent === 'allow' ? 'Allowing...' : 'Allow once'}
        </button>
      </div>
    </section>
  )
}
