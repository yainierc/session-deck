import { useEffect, useRef, useState } from 'react'
import { shortPath } from './format.js'
import PermissionMode from './PermissionMode.jsx'
import { useHandoffNotes, notePath, promptFor } from './Handoff.jsx'

/**
 * How many sessions one launch may be introduced to.
 *
 * Kept in step with MAX_PEERS in src/roster.js, which is the one that
 * decides: the server caps what it introduces whatever arrives from here.
 * This copy exists so the checkboxes stop offering before the server starts
 * silently dropping.
 */
const MAX_PEERS = 8

/*
 * No list of models is written down here, and none should be. Which ones an
 * account can reach depends on what it has access to and on what the
 * organisation allows, so it is asked of the CLI per folder — and until the
 * answer arrives, or if it never does, the only honest option is the default.
 * A model missing from a menu looks exactly like a model that does not exist.
 */

/** No choice made: the CLI's own default model, its own default effort, no advisor. */
const DEFAULT_HOW = { model: '', effort: '', advisor: false }

function howOf(preset) {
  return {
    model: preset?.model || '',
    effort: preset?.effort || '',
    advisor: Boolean(preset?.advisor),
  }
}

/** The hover of a shortcut: its task, and what it asks to be run with. */
function describe(preset) {
  const how = [
    preset.model,
    preset.effort && `${preset.effort} effort`,
    preset.advisor && 'with an advisor',
  ].filter(Boolean)
  return how.length ? `${preset.prompt}\n\n(${how.join(' · ')})` : preset.prompt
}

/**
 * The launcher. It always opens against a folder you already picked — from
 * the sidebar, or from a worktree in the project view — so there is no
 * project dropdown to get wrong: what you clicked is where the task runs.
 *
 * Shortcuts sit above the box for the things you type into every new
 * session. Clicking one starts it straight away; the pencil loads it into
 * the box instead, for when you want to adjust it first.
 */
export default function Launcher({ open, fixedCwd, sessions = [], preselectNote = null, onStopSession, onClose, onLaunch }) {
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [peers, setPeers] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [presets, setPresets] = useState([])
  const [managing, setManaging] = useState(false)
  const [modes, setModes] = useState([])
  const [mode, setMode] = useState('default')
  /*
   * How the session should think. Kept together because they are answered
   * together — and separate from `mode`, which is a deck-wide setting this
   * form writes back. These three are for this launch and are not remembered.
   */
  const [how, setHow] = useState(DEFAULT_HOW)
  const [models, setModels] = useState([])
  const boxRef = useRef(null)
  /*
   * The handoff note this task continues, if any. Choosing one also moves the
   * launch to the checkout the note was written in: the note describes that
   * worktree's state, and a session reading it from the main checkout would
   * verify it against the wrong branch.
   */
  const [note, setNote] = useState(null)
  const [showOlder, setShowOlder] = useState(false)
  const notes = useHandoffNotes(open ? fixedCwd : null, open)

  useEffect(() => {
    if (!open) return
    setPrompt('')
    setName('')
    /*
     * Cleared every time, and never remembered between launches. A peer's
     * name is its address only while its process is alive, so a roster kept
     * from last time is a list of sessions that have since exited.
     */
    setPeers([])
    setError(null)
    setManaging(false)
    setHow(DEFAULT_HOW)
    setNote(null)
    setShowOlder(false)
    fetch('/api/presets')
      .then((r) => r.json())
      .then((data) => setPresets(data.presets || []))
      .catch(() => setPresets([]))
    /*
     * Asked per folder, because the answer can be. The first one costs a CLI
     * starting up — it sends no turn, so it costs nothing else — and the deck
     * remembers it afterwards. An empty list is not an error message here: the
     * control falls back to offering the default alone, which is what the
     * panel can honestly say it knows.
     */
    setModels([])
    fetch(`/api/models?cwd=${encodeURIComponent(fixedCwd || '')}`)
      .then((r) => r.json())
      .then((data) => setModels(data.ok ? data.models || [] : []))
      .catch(() => setModels([]))
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        setModes(data.modes || [])
        setMode(data.settings?.permissionMode || 'default')
      })
      .catch(() => setModes([]))
  }, [open, fixedCwd])

  /*
   * The levels this model takes, from the same answer the model list came
   * from. With no model chosen there is no way to know which one the CLI will
   * pick, so the five the SDK defines are offered and the CLI is left to
   * ignore what does not apply — the alternative is an empty control on the
   * path most launches take.
   */
  const chosen = models.find((m) => m.value === how.model)
  const efforts = chosen
    ? (chosen.supportsEffort ? chosen.effortLevels : [])
    : ['low', 'medium', 'high', 'xhigh', 'max']

  /*
   * You picked xhigh, then switched to a model that does not take it. Cleared
   * rather than left sitting in a control nobody looks at twice: what the form
   * shows is what gets sent.
   *
   * Above the early return, with every other hook, because a component that
   * calls a different number of them depending on whether it is open is a
   * component React refuses to render.
   */
  // Keyed on the levels themselves and not the array: a fresh array every
  // render would re-run this every render for nothing.
  // Opened from a "Handoff ready" card: that note is already chosen.
  useEffect(() => {
    if (!open || !preselectNote || !notes) return
    const found = notes.find((n) => n.file === preselectNote)
    if (found) chooseNote(found)
    // chooseNote only sets state; depending on it would re-run every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preselectNote, notes])

  const effortKey = efforts.join(',')
  useEffect(() => {
    if (how.effort && !effortKey.split(',').includes(how.effort)) {
      setHow((h) => ({ ...h, effort: '' }))
    }
  }, [how.effort, effortKey])

  if (!open || !fixedCwd) return null

  const cwd = note ? note.checkout : fixedCwd

  /*
   * `choices` is passed rather than read off the form because a shortcut
   * starts on one click, without the form ever showing what it is about to
   * ask for. Its own model and effort travel with it; the box's are for a task
   * you typed.
   */
  async function start(text, choices = how, { fromNote = note } = {}) {
    const value = String(text || '').trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    const from = fromNote
    const result = await onLaunch({
      cwd,
      prompt: value,
      permissionMode: mode,
      name,
      peers,
      // Empty means "no choice made", which has to reach the server as an
      // absent value and not as the string "".
      model: choices.model || undefined,
      effort: choices.effort || undefined,
      advisor: choices.advisor || undefined,
    })
    setBusy(false)
    if (!result?.ok) {
      setError(result?.error || 'Could not start the session')
      return
    }
    if (from) {
      fetch('/api/handoffs/picked', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: from.file }),
      }).catch(() => {})
      /*
       * The session that wrote the note may still be running in the same
       * checkout. Two sessions in one worktree overwrite each other's edits,
       * but stopping one unasked could cut work still in flight — so ask,
       * after the new one is up and not before, so a failed launch never
       * costs you the old one.
       */
      const old = sessions.filter((s) => s.managed && s.deckId && s.deckId !== result.deckId
        && s.cwd === from.checkout && !['done', 'error'].includes(s.status))
      for (const s of old) {
        if (window.confirm(`"${s.name || 'A session'}" is still running in ${shortPath(from.checkout)}. Stop it?`)) {
          onStopSession?.(s.deckId)
        }
      }
    }
    onClose()
  }

  function chooseNote(next) {
    setNote(next)
    setPrompt(promptFor(next))
    setName((current) => current || next.title.slice(0, 80))
  }

  function clearNote() {
    setNote(null)
    setPrompt('')
    setName('')
  }

  function chooseMode(next) {
    setMode(next)
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: next }),
    }).catch(() => {})
  }

  function loadIntoBox(preset) {
    setPrompt(preset.prompt)
    // Its choices come with it, or editing a shortcut to adjust one word would
    // quietly launch it with the panel's defaults instead of its own.
    setHow(howOf(preset))
    // Put the caret at the end so you can keep typing where it left off.
    requestAnimationFrame(() => {
      const box = boxRef.current
      if (!box) return
      box.focus()
      box.setSelectionRange(box.value.length, box.value.length)
    })
  }

  async function removePreset(id) {
    await fetch('/api/presets', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await (await fetch('/api/presets')).json()
    setPresets(data.presets || [])
  }

  async function resetPresets() {
    await fetch('/api/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    })
    const data = await (await fetch('/api/presets')).json()
    setPresets(data.presets || [])
  }

  function togglePeer(address) {
    setPeers((current) => {
      if (current.includes(address)) return current.filter((a) => a !== address)
      return current.length >= MAX_PEERS ? current : [...current, address]
    })
  }

  /*
   * The address, which is not always the name on screen: a session the deck
   * launched is listed under the label you typed and answers to the name its
   * process registered. Offering the label would put a string in the roster
   * that SendMessage cannot deliver to.
   */
  const offered = sessions
    .map((s) => ({ ...s, address: s.peerName || s.name }))
    // A detached session has a conversation and no process, so it has no
    // inbox: it reads as available and would never hear the question.
    .filter((s) => s.address && !['detached', 'done', 'error'].includes(s.status))

  const groups = [...offered.reduce((map, s) => {
    const key = s.project || 'no project'
    map.set(key, [...(map.get(key) || []), s])
    return map
  }, new Map())]

  /*
   * Advisory only: heldPeers() in src/roster.js decides, with the modes the
   * server can see. Unknown counts as quiet — a session the deck did not
   * start publishes no permission mode at all, and a green tick there would
   * be a guess on precisely the case most likely to strand a conversation.
   */
  const ourClass = mode === 'bypassPermissions' ? 'bypass' : 'prompting'
  const quiet = peers.filter((address) => {
    const theirs = offered.find((s) => s.address === address)?.permissionMode
    if (!theirs) return true
    return (theirs === 'bypassPermissions' ? 'bypass' : 'prompting') !== ourClass
  })

  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); start(prompt) }}
      >
        <h2>New task</h2>
        <p className="modal-where" title={cwd}>
          {shortPath(cwd)}
          {note && note.checkout !== fixedCwd && <span className="modal-where-why"> · from the handoff</span>}
        </p>

        <HandoffList
          notes={notes}
          chosen={note}
          showOlder={showOlder}
          busy={busy}
          onToggleOlder={() => setShowOlder((v) => !v)}
          onChoose={(n) => (note?.file === n.file ? clearNote() : chooseNote(n))}
          onFromRepo={() => { clearNote(); start('/handoff', how, { fromNote: null }) }}
        />

        <div className="presets">
          <div className="presets-head">
            <span>Shortcuts</span>
            <button type="button" className="linkish" onClick={() => setManaging((m) => !m)}>
              {managing ? 'Done' : 'Manage'}
            </button>
          </div>

          <div className="chips">
            {presets.map((preset) => (
              <span key={preset.id} className="chip-wrap">
                <button
                  type="button"
                  className="chip"
                  title={describe(preset)}
                  disabled={busy}
                  onClick={() => start(preset.prompt, howOf(preset))}
                >
                  {preset.label}
                  {/* A dot, not a word: the shortcut's name is the thing to
                      read, and the hover says what the dot stands for. */}
                  {(preset.model || preset.effort || preset.advisor) && (
                    <span className="chip-marked" aria-hidden="true">·</span>
                  )}
                </button>
                {managing ? (
                  <button
                    type="button"
                    className="chip-side is-danger"
                    title="Delete this shortcut"
                    onClick={() => removePreset(preset.id)}
                  >
                    ×
                  </button>
                ) : (
                  <button
                    type="button"
                    className="chip-side"
                    title="Load it into the box to edit before running"
                    onClick={() => loadIntoBox(preset)}
                  >
                    ✎
                  </button>
                )}
              </span>
            ))}
            {presets.length === 0 && <span className="note">No shortcuts yet.</span>}
          </div>

          {managing && (
            <NewPreset onSaved={setPresets} onReset={resetPresets} currentPrompt={prompt} how={how} />
          )}
        </div>

        {/*
          Optional on purpose. Without it the session is still called after the
          first line of the task, which is the right answer most of the time —
          this is for the case it is not: three sessions in the same repo whose
          prompts all open the same way.
        */}
        <label className="field">
          <span>Name <em className="field-optional">optional</em></span>
          <input
            type="text"
            value={name}
            maxLength={80}
            placeholder="What to call it — defaults to the first line of the task"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
          />
        </label>

        <label className="field">
          <span>Task</span>
          <textarea
            autoFocus
            ref={boxRef}
            rows={5}
            value={prompt}
            placeholder="What should Claude do here?"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Enter alone would submit a half-written multi-line task.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(prompt) }
              if (e.key === 'Escape') onClose()
            }}
          />
        </label>

        {/*
          How it should think, asked before it starts rather than corrected
          afterwards. The effort and the advisor only reach the first turn if
          they are set at launch, and the first turn is usually where the plan
          gets decided — changing them after that is changing them late.

          The models are aliases and not the real list: the panel can only ask
          a running session what models exist, and there is no session yet.
          Leaving one on "default" asks for nothing, which is not the same as
          asking for the default and is why the option says so.
        */}
        <div className="field">
          <span>How it works <em className="field-optional">optional</em></span>
          <div className="how">
            <label className="how-one">
              <span>Model</span>
              <select
                value={how.model}
                disabled={busy || models.length === 0}
                onChange={(e) => setHow((h) => ({ ...h, model: e.target.value }))}
              >
                <option value="">Default</option>
                {models
                  // The CLI's own "default" row is the empty option above; two
                  // ways to say the same thing is one of them being wrong.
                  .filter((m) => m.value !== 'default')
                  .map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}
              </select>
            </label>
            {/*
              Offered only where it exists. Haiku supports no effort levels at
              all, so a session started on it with "high" selected would run at
              whatever it always runs at and the form would have said otherwise
              — which is the one thing a control on this panel may not do.
            */}
            <label className="how-one">
              <span>Effort</span>
              <select
                value={how.effort}
                disabled={busy || efforts.length === 0}
                title={efforts.length === 0 && how.model ? 'This model takes no effort levels' : undefined}
                onChange={(e) => setHow((h) => ({ ...h, effort: e.target.value }))}
              >
                <option value="">Default</option>
                {efforts.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <label className={`how-advisor ${how.advisor ? 'is-on' : ''}`}>
              <input
                type="checkbox"
                checked={how.advisor}
                disabled={busy}
                onChange={(e) => setHow((h) => ({ ...h, advisor: e.target.checked }))}
              />
              Advisor
            </label>
          </div>
          {/*
            Said before, not after. An advisor re-reads the whole conversation
            on every call and none of it is cached, so it is the most expensive
            thing that can happen in a session without anybody asking for it.
          */}
          {how.advisor && (
            <p className="note">
              A stronger model is consulted at the hard moments. It reads the whole
              conversation each time, so it costs noticeably more.
            </p>
          )}
        </div>

        {modes.length > 0 && (
          <div className="field">
            <span>Permissions</span>
            <PermissionMode modes={modes} value={mode} onChange={chooseMode} disabled={busy} />
          </div>
        )}

        {offered.length > 0 && (
          <div className="field">
            <span>Can ask <em className="field-optional">optional</em></span>
            <p className="note peer-why">
              Sessions to introduce this one to. It can ask them about their own
              projects instead of reading those repositories itself.
            </p>

            <div className="peers">
              {groups.map(([project, list]) => (
                <div key={project} className="peer-group">
                  <span className="peer-project">{project}</span>
                  {list.map((peer) => (
                    <label key={peer.address} className="peer">
                      <input
                        type="checkbox"
                        checked={peers.includes(peer.address)}
                        disabled={busy || (peers.length >= MAX_PEERS && !peers.includes(peer.address))}
                        onChange={() => togglePeer(peer.address)}
                      />
                      <span className="peer-name">{peer.address}</span>
                      <span className={`peer-status is-${peer.status}`}>{peer.status}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>

            {/*
              Said before the launch and not after, because after is silence.
              Across a permission-mode boundary a peer's reply is held for you
              to approve rather than delivered, and a session waiting on a
              held reply looks exactly like one waiting on a busy peer.
            */}
            {quiet.length > 0 && (
              <p className="note peer-warn">
                {quiet.length === 1 ? `${quiet[0]} runs` : `${quiet.length} of these run`}
                {' '}in a different permission mode, or one the deck cannot see. Their
                replies will wait for your approval instead of arriving.
              </p>
            )}
          </div>
        )}

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <span className="hint">{isMac ? 'Cmd' : 'Ctrl'}+Enter to start</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!prompt.trim() || busy}>
            {busy ? 'Starting...' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Save whatever is in the box as a new shortcut.
 *
 * It takes the model, the effort and the advisor from the form above rather
 * than asking for them a second time: you set the launch up, then you keep it.
 * A second set of controls here would be two answers to one question, and the
 * one that got saved would be whichever the layout put closer to the button.
 */
function NewPreset({ onSaved, onReset, currentPrompt, how }) {
  const [label, setLabel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState(null)

  async function save(event) {
    event.preventDefault()
    const text = prompt.trim() || currentPrompt.trim()
    if (!label.trim() || !text) {
      setError('A name and a task are both needed')
      return
    }
    const response = await fetch('/api/presets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: label.trim(),
        prompt: text,
        model: how.model || null,
        effort: how.effort || null,
        advisor: how.advisor,
      }),
    })
    const result = await response.json()
    if (!result.ok) { setError(result.error); return }
    const data = await (await fetch('/api/presets')).json()
    onSaved(data.presets || [])
    setLabel('')
    setPrompt('')
    setError(null)
  }

  return (
    <div className="preset-editor">
      <input
        value={label}
        placeholder="Name"
        onChange={(e) => { setLabel(e.target.value); setError(null) }}
      />
      <input
        value={prompt}
        placeholder={currentPrompt.trim() ? 'Task (blank = use what is in the box)' : 'Task'}
        onChange={(e) => { setPrompt(e.target.value); setError(null) }}
      />
      <button type="button" className="btn btn-slim btn-primary" onClick={save}>Save</button>
      <button type="button" className="btn btn-slim" onClick={onReset} title="Restore the shipped shortcuts">
        Reset
      </button>
      {error && <p className="add-error">{error}</p>}
      <p className="note preset-how">
        Saved with whatever "How it works" says above.
      </p>
    </div>
  )
}

function age(ms) {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

/**
 * Work a previous session wrote down for this one to continue.
 *
 * Pending notes are open; the ones already picked up or replaced by a newer
 * note for the same branch fold away under a count rather than disappearing —
 * picking one up twice is allowed, just not the first thing offered.
 */
function HandoffList({ notes, chosen, showOlder, busy, onToggleOlder, onChoose, onFromRepo }) {
  if (!notes) return null
  const pending = notes.filter((n) => n.state === 'pending')
  const older = notes.filter((n) => n.state !== 'pending')
  const shown = showOlder ? [...pending, ...older] : pending

  return (
    <div className="handoffs">
      <div className="presets-head">
        <span>Continue work{pending.length ? ` · ${pending.length} pending` : ''}</span>
        <button
          type="button"
          className="linkish"
          disabled={busy}
          onClick={onFromRepo}
          title="Start a session here that runs /handoff from git and the open PRs alone, for when the session that did the work can no longer answer"
        >
          Write one from the repo
        </button>
      </div>
      {shown.length === 0 && <span className="note">No handoff notes in this project yet.</span>}
      {shown.map((n) => (
        <button
          type="button"
          key={n.file}
          className={`handoff-item${chosen?.file === n.file ? ' is-on' : ''}`}
          aria-pressed={chosen?.file === n.file}
          title={n.file}
          onClick={() => onChoose(n)}
        >
          <span className="handoff-main">
            <span className="handoff-title">{n.title}</span>
            <span className="handoff-meta">
              {[n.branch, n.worktree || 'main checkout', notePath(n)].filter(Boolean).join(' · ')}
            </span>
            {n.merged && (
              <span className="handoff-warn">Its branch is already merged, so this may be out of date</span>
            )}
          </span>
          <span className="handoff-age">{age(n.mtime)}</span>
          <span className={`handoff-state is-${n.state}`}>
            {n.state === 'pending' ? 'pending' : n.state === 'picked-up' ? 'picked up' : 'replaced'}
          </span>
        </button>
      ))}
      {older.length > 0 && (
        <button type="button" className="linkish handoff-older" onClick={onToggleOlder}>
          {showOlder ? 'Hide older notes' : `Show ${older.length} older ${older.length === 1 ? 'note' : 'notes'}`}
        </button>
      )}
    </div>
  )
}
