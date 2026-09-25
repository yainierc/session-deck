import { useCallback, useState } from 'react'
import Menu from './Menu.jsx'

/**
 * SessionControls.jsx — the three things you can change about a running
 * session without restarting it: what it runs on, how hard it thinks, and
 * what it may do without asking.
 *
 * They are siblings and they look like siblings. The permission mode used to
 * be a strip of three labelled buttons in the header, which is why the header
 * grew a second and third row: three words in a row 235px wide do not fit, so
 * they wrapped, and each wrap pushed the conversation another thirty pixels
 * down the screen. A chip is the same control in a tenth of the width, and it
 * can say what it is set to as well as let you change it.
 *
 * ### Asked, and granted
 *
 * The rule the deck already applies to permissions applies to all three, and
 * it is the reason none of these chips show what you clicked:
 *
 *   - `bypassPermissions` is refused outright by some environments and comes
 *     back as `default`.
 *   - `max` effort is session-only and runs as `high` on a model without it;
 *     an organisation can cap the level besides.
 *   - a model can be swapped underneath you by the same kind of policy.
 *
 * So every chip shows the value the session reports, not the one that was
 * asked for, and turns amber when the two differ — with the difference spelled
 * out in the menu. A control that shows your request rather than the outcome
 * is a control that lies exactly when it matters.
 */

/** The five the SDK defines, in the order they escalate. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

const EFFORT_BLURB = {
  low: 'Fewer turns, less preamble. For routine work.',
  medium: 'The step down that usually holds quality.',
  high: 'The default balance.',
  xhigh: 'What Claude Code itself uses for coding.',
  max: 'When being right matters more than the cost.',
}

/**
 * Which row of the model list this session is on.
 *
 * Not a simple lookup by id, because more than one row can resolve to the
 * same wire model: "Default" and "Opus" both land on the same string when the
 * default *is* Opus. Matching by resolved id alone therefore answered
 * "Default" for a session where Opus had been picked on purpose — the chip
 * forgot a choice that had been made.
 *
 * So what you chose wins when you chose something, and the resolved id is
 * only used to name a model nobody picked. A session with no choice on it is
 * genuinely running the default, and saying so is more use than naming the
 * model that happens to be behind it today.
 */
function findModel(models, { model, requestedModel }) {
  if (!models?.length) return null
  if (requestedModel) {
    return models.find((m) => m.value === requestedModel)
      || models.find((m) => m.resolvedModel === model)
      || null
  }
  if (!model) return null
  return models.find((m) => m.value === 'default' && (!m.resolvedModel || m.resolvedModel === model))
    || models.find((m) => m.resolvedModel === model || m.value === model)
    || null
}

/** `claude-opus-5` reads badly in a chip; `opus-5` is the same information. */
function shortModel(id) {
  if (!id) return 'default'
  return id.replace(/^claude-/, '')
}

function Chip({ label, value, amber, title, onOpen, children }) {
  return (
    <Menu
      buttonClass={`ctl ${amber ? "is-amber" : ""}`}
      className="ctl-menu"
      title={title}
      onOpen={onOpen}
      label={
        <>
          <span className="ctl-key">{label}</span>
          <span className="ctl-value">{value}</span>
          <svg viewBox="0 0 8 8" width="7" height="7" aria-hidden="true" className="ctl-caret">
            <path d="M1 2.5 L4 5.5 L7 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </>
      }
    >
      {children}
    </Menu>
  )
}

export default function SessionControls({ session, deck, modes }) {
  /*
   * null while nobody has asked. The list belongs to the session — which
   * models a CLI offers changes with the CLI — so it is fetched when a menu
   * opens rather than written down here or held for every session on screen.
   */
  const [models, setModels] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (models) return
    const result = await deck.models(session.deckId)
    if (result?.ok) setModels(result.models || [])
    else { setModels([]); setError(result?.error || 'Could not read the model list') }
  }, [models, deck, session.deckId])

  const current = findModel(models, session)
  /*
   * Which levels this model takes.
   *
   * An empty list is an answer — Haiku takes none, which the SDK says by
   * returning `[]` — and it is not the same answer as not having asked yet.
   * Reading the two the same way is what made every level look available on a
   * model that has none, which is the exact promise this control exists to
   * keep. So the fallback hangs on whether the row was found at all, never on
   * whether its list happens to be empty.
   */
  const levels = current ? current.effortLevels : EFFORT_LEVELS

  const modelAmber = Boolean(session.requestedModel && session.model && session.requestedModel !== session.model
    && session.requestedModel !== current?.value)

  /*
   * Whether this session tells us the effort it is actually running at.
   *
   * Measured against a live session rather than assumed: the SDK publishes
   * the granted level on its init message for terminal- and editor-hosted
   * sessions, and not for the ones the deck launches itself. So the control
   * works — setting it is accepted — but it is write-only here.
   *
   * The chip stays either way, showing what was asked for and saying that is
   * what it is showing. Hiding it would have hidden a working control; and
   * dressing the request up as the outcome is the one thing the other two
   * chips exist to avoid.
   */
  const effortKnown = session.effort !== undefined
  const effortAmber = Boolean(effortKnown && session.requestedEffort && session.requestedEffort !== session.effort)

  async function choose(action, label) {
    const result = await action()
    if (!result?.ok) window.alert(result?.error || `Could not change the ${label}`)
  }

  return (
    <>
      <Chip
        label="model"
        value={current?.displayName || shortModel(session.model)}
        amber={modelAmber}
        onOpen={load}
        title={modelAmber
          ? `Asked for "${session.requestedModel}", running "${session.model}"`
          : 'What this session runs on'}
      >
        {(close) => (
          <>
            <div className="menu-title">Model</div>
            {models === null && <p className="menu-note">Asking the session...</p>}
            {models?.length === 0 && (
              <p className="menu-note">{error || 'This session did not offer a list.'}</p>
            )}
            {models?.map((m) => {
              const on = m === current
              return (
                <button
                  key={m.value}
                  role="menuitem"
                  className={on ? 'is-on' : ''}
                  onClick={() => { close(); if (!on) choose(() => deck.setModel(session.deckId, m.value), 'model') }}
                >
                  {m.displayName}
                  {m.description && <span className="menu-desc">{m.description}</span>}
                </button>
              )
            })}
            {modelAmber && (
              <p className="menu-foot">
                Asked for <b>{session.requestedModel}</b>, running <b>{shortModel(session.model)}</b>.
              </p>
            )}
          </>
        )}
      </Chip>

      <Chip
        label="effort"
        value={effortKnown ? session.effort || '—' : session.requestedEffort || 'default'}
        amber={effortAmber}
        onOpen={load}
        title={effortAmber
          ? `Asked for "${session.requestedEffort}", running "${session.effort || 'none'}"`
          : 'How hard it thinks before answering'}
      >
          {(close) => (
            <>
              <div className="menu-title">Reasoning effort</div>
              {EFFORT_LEVELS.map((level) => {
                const allowed = levels.includes(level)
                const on = level === (effortKnown ? session.effort : session.requestedEffort)
                return (
                  <button
                    key={level}
                    role="menuitem"
                    disabled={!allowed}
                    className={on ? 'is-on' : ''}
                    onClick={() => { close(); choose(() => deck.setEffort(session.deckId, level), 'effort') }}
                  >
                    {level}
                    <span className="menu-desc">
                      {allowed
                        ? EFFORT_BLURB[level]
                        : `${current?.displayName || 'This model'} does not take it`}
                    </span>
                  </button>
                )
              })}
              <div className="menu-sep" />
              {/* Back to whatever the model does on its own, rather than to a
                  level we would be choosing for you. */}
              <button role="menuitem" onClick={() => { close(); choose(() => deck.setEffort(session.deckId, null), 'effort') }}>
                Model default
              </button>
              {effortAmber && (
                <p className="menu-foot">
                  Asked for <b>{session.requestedEffort}</b>, running <b>{session.effort || 'none'}</b>.
                </p>
              )}
              {!effortKnown && (
                <p className="menu-foot is-quiet">
                  This session does not report which level is in force, so the chip shows
                  what was asked for. Setting it works; reading it back does not.
                </p>
              )}
            </>
          )}
      </Chip>

      {modes.length > 0 && (
        <Chip
          label="permissions"
          value={modes.find((m) => m.id === session.permissionMode)?.label || session.permissionMode}
          amber={Boolean(session.modeNote)}
          title={session.modeNote || 'What it may do without asking'}
        >
          {(close) => (
            <>
              <div className="menu-title">Without asking</div>
              {modes.map((mode) => (
                <button
                  key={mode.id}
                  role="menuitem"
                  className={`${mode.id === session.permissionMode ? 'is-on' : ''} ${mode.dangerous ? 'is-warn' : ''}`}
                  onClick={() => { close(); deck.setMode(session.deckId, mode.id) }}
                >
                  {mode.label}
                  {mode.description && <span className="menu-desc">{mode.description}</span>}
                </button>
              ))}
              {/*
                This used to be a banner across the whole pane, forty pixels
                tall, saying what the chip above now says in amber. It lives
                here because this is where you look when the chip does not say
                what you set.
              */}
              {session.modeNote && <p className="menu-foot">{session.modeNote}</p>}
            </>
          )}
        </Chip>
      )}
    </>
  )
}
