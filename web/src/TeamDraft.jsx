import { useState } from 'react'

/**
 * TeamDraft.jsx — a team a session proposed, read before any of it is raised.
 *
 * ### Why this screen exists at all
 *
 * The document this was built against contains a team. It also contains the
 * sentences that matter more than the team — "do not raise this until the
 * preconditions are met", "more sessions do not move decisions", "six or
 * seven, not nine". A button that turned a proposal into four running sessions
 * would have thrown away every one of them.
 *
 * So `preconditions` is the loudest thing on this card, above the members and
 * above the button, and the button does not raise anything: it opens the
 * composer with the proposal in it, where you can take members out before
 * anything starts.
 *
 * ### The faults are the point, not an error state
 *
 * The author is a model. A role with no provenance, a member asking for a role
 * nobody will create, a project that is not in the workspace — none of those
 * are reasons to throw the draft away, and all of them are reasons to read it
 * harder. They are listed, named, and the draft stays usable around them.
 */
/**
 * A paragraph that can be any length, clamped until you want it.
 *
 * Measured on a real proposal: five numbered preconditions and a paragraph of
 * provenance per seat put the card's own buttons three screens down, and the
 * answer to "how do I accept this" became "you cannot see it". Reading is
 * still the point — so nothing is hidden, it is folded, and the fold says so.
 */
function Long({ children, lines = 3, className = '' }) {
  const [open, setOpen] = useState(false)
  const text = String(children || '')
  if (!text) return null
  // Short enough that folding it would only add a control to click.
  if (text.length < 180) return <p className={className}>{text}</p>
  return (
    <p
      className={`${className} draft-long ${open ? 'is-open' : ''}`}
      style={open ? undefined : { WebkitLineClamp: lines }}
      onClick={() => setOpen((o) => !o)}
      title={open ? 'Fold it back' : 'Click to read it all'}
    >
      {text}
    </p>
  )
}

export default function TeamDraft({ draft, onDismiss, onCreateRoles, onCompose }) {
  const [busy, setBusy] = useState(false)

  if (draft.status === 'drafting') {
    return (
      <div className="team-row-card is-drafting">
        <div className="team-row-open as-text">
          <span className="team-row-top">
            <span className="team-row-name">A team from {draft.from || 'a session'}</span>
            <span className="pill">writing it now</span>
          </span>
          <span className="team-row-sub">
            It is working out who the work needs. This card fills in when it has written the answer.
          </span>
        </div>
        <button type="button" className="team-dismiss" title="Stop waiting for this" onClick={onDismiss}>×</button>
      </div>
    )
  }

  const missingRoles = draft.roles.filter((r) => !r.exists)
  const unfillable = draft.members.filter((m) => !m.cwd).length
  const left = draft.members.filter((m) => m.cwd && !m.raised).length

  return (
    <section className="team-draft">
      {/*
        The action sits in the header and not at the foot. A proposal is as long
        as it needs to be — a real one ran to five preconditions and a paragraph
        of provenance per seat — and a button under all of that is a button
        nobody finds.
      */}
      <header className="team-head is-sticky">
        <h3>{draft.name || 'A proposed team'}</h3>
        <span className="team-sub">
          proposed by {draft.from || 'a session'}
          {draft.raisedCount > 0 && ` · ${draft.raisedCount} already raised`}
        </span>
        <span className="team-head-actions">
          {left === 0 ? (
            <span className="note">every seat raised</span>
          ) : missingRoles.length > 0 ? (
            <button
              type="button"
              className="btn btn-slim btn-primary"
              disabled={busy}
              onClick={async () => { setBusy(true); await onCreateRoles(missingRoles); setBusy(false) }}
              title="Save these roles, then the composer can be filled from this proposal"
            >
              {busy ? 'Saving...' : `Create ${missingRoles.length === 1 ? 'the role' : `the ${missingRoles.length} roles`}`}
            </button>
          ) : (
            <button type="button" className="btn btn-slim btn-primary" onClick={() => onCompose(draft)}>
              Open in the composer
            </button>
          )}
          <button type="button" className="team-dismiss" title="Discard this proposal" onClick={onDismiss}>×</button>
        </span>
      </header>

      <div className="team-draft-body">
        {/*
          Above everything, because it is the part a form cannot produce and
          the part that is lost if this is treated as a button.
        */}
        {draft.preconditions && (
          <div className="draft-block is-precondition">
            <span className="draft-label">Before raising any of this</span>
            {/* Folded highest of anything here: it is the part that is lost if
                a proposal is treated as a button. */}
            <Long lines={8}>{draft.preconditions}</Long>
          </div>
        )}

        {draft.goal && (
          <div className="draft-block">
            <span className="draft-label">What they would be working on</span>
            <Long lines={4}>{draft.goal}</Long>
          </div>
        )}

        <div className="draft-block">
          <span className="draft-label">
            {draft.members.length} {draft.members.length === 1 ? 'session' : 'sessions'}
          </span>
          <div className="draft-members">
            {draft.members.map((m, i) => (
              <div key={i} className={`draft-member ${m.cwd ? '' : 'is-bad'} ${m.raised ? 'is-raised' : ''}`}>
                <span className="m-name">{m.role}</span>
                <span className="m-addr">{m.project}</span>
                {m.delegates && <span className="pill lead">hands out work</span>}
                {/* Started already. Left on the card because the plan it came
                    from is usually in phases, and the half that has not gone
                    yet needs the half that has for context. */}
                {m.raised && <span className="pill is-done">raised</span>}
                {!m.cwd && <span className="pill is-warn">no such project</span>}
                <Long className="draft-why" lines={2}>{m.why}</Long>
              </div>
            ))}
          </div>
        </div>

        {missingRoles.length > 0 && (
          <div className="draft-block">
            <span className="draft-label">
              {missingRoles.length} {missingRoles.length === 1 ? 'role' : 'roles'} that do not exist yet
            </span>
            {missingRoles.map((r, i) => (
              <div key={i} className="draft-role">
                <div className="role-row-top">
                  <span className="role-row-name">{r.name}</span>
                  {r.delegates && <span className="pill lead">hands out work</span>}
                  {r.advisor && <span className="pill adv">advisor</span>}
                  {r.model && <span className="pill">{r.model}</span>}
                </div>
                <Long className="role-row-brief" lines={4}>{r.brief}</Long>
                <Long className="draft-why" lines={2}>{r.why}</Long>
              </div>
            ))}
          </div>
        )}

        {draft.notes && (
          <div className="draft-block">
            <span className="draft-label">What it left out, and who owns that</span>
            <Long lines={4}>{draft.notes}</Long>
          </div>
        )}

        {/*
          Not an error state. A model wrote this, and everything it got wrong is
          still worth reading — these are reasons to read it harder, not reasons
          to throw it away.
        */}
        {draft.faults.length > 0 && (
          <div className="draft-block is-fault">
            <span className="draft-label">Worth checking before you raise it</span>
            <ul>{draft.faults.map((f, i) => <li key={i}>{f}</li>)}</ul>
          </div>
        )}
      </div>

      {/*
        Creating the roles is its own step and its own decision: a role is a
        paragraph somebody wrote, and putting four of them into your saved list
        because you clicked "raise" is not a thing to do on the way past. Said
        here, where you have just finished reading them.
      */}
      <div className="draft-foot">
        {unfillable > 0 && (
          <span className="team-warn">
            {unfillable} {unfillable === 1 ? 'seat has' : 'seats have'} no project in your workspace, and will be left out
          </span>
        )}
        <span className="note">
          {left === 0
            ? 'Every seat in this proposal has been raised. The × puts the card away.'
            : missingRoles.length > 0
            ? `${missingRoles.length === 1 ? 'The role above is' : `The ${missingRoles.length} roles above are`} saved first, then the composer opens filled in — where you can still take rows out before anything starts.`
              : `The composer opens filled in with the ${left} ${left === 1 ? 'seat' : 'seats'} not yet raised. Nothing starts until you raise it there.`}
        </span>
      </div>
    </section>
  )
}
