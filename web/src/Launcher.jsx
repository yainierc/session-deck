import { useEffect, useRef, useState } from 'react'
import { shortPath } from './format.js'
import PermissionMode from './PermissionMode.jsx'

/**
 * How many sessions one launch may be introduced to.
 *
 * Kept in step with MAX_PEERS in src/roster.js, which is the one that
 * decides: the server caps what it introduces whatever arrives from here.
 * This copy exists so the checkboxes stop offering before the server starts
 * silently dropping.
 */
const MAX_PEERS = 8

/**
 * The launcher. It always opens against a folder you already picked — from
 * the sidebar, or from a worktree in the project view — so there is no
 * project dropdown to get wrong: what you clicked is where the task runs.
 *
 * Shortcuts sit above the box for the things you type into every new
 * session. Clicking one starts it straight away; the pencil loads it into
 * the box instead, for when you want to adjust it first.
 */
export default function Launcher({ open, fixedCwd, sessions = [], onClose, onLaunch }) {
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [peers, setPeers] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [presets, setPresets] = useState([])
  const [managing, setManaging] = useState(false)
  const [modes, setModes] = useState([])
  const [mode, setMode] = useState('default')
  const boxRef = useRef(null)

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
    fetch('/api/presets')
      .then((r) => r.json())
      .then((data) => setPresets(data.presets || []))
      .catch(() => setPresets([]))
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        setModes(data.modes || [])
        setMode(data.settings?.permissionMode || 'default')
      })
      .catch(() => setModes([]))
  }, [open, fixedCwd])

  if (!open || !fixedCwd) return null

  async function start(text) {
    const value = String(text || '').trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    const result = await onLaunch(fixedCwd, value, mode, name, peers)
    setBusy(false)
    if (result?.ok) onClose()
    else setError(result?.error || 'Could not start the session')
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
        <p className="modal-where" title={fixedCwd}>{shortPath(fixedCwd)}</p>

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
                  title={preset.prompt}
                  disabled={busy}
                  onClick={() => start(preset.prompt)}
                >
                  {preset.label}
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

          {managing && <NewPreset onSaved={setPresets} onReset={resetPresets} currentPrompt={prompt} />}
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

/** Save whatever is in the box as a new shortcut. */
function NewPreset({ onSaved, onReset, currentPrompt }) {
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
      body: JSON.stringify({ label: label.trim(), prompt: text }),
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
    </div>
  )
}
