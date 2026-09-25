import { useCallback, useEffect, useRef, useState } from 'react'
import { shortPath } from './format.js'

/**
 * The folder picker.
 *
 * A browser cannot give a web app a real path — a file input hands over
 * contents and a relative name, never the folder on disk — so this walks the
 * filesystem through the deck's own server instead of pretending to be a
 * native dialog. The upside of doing it this way: it works just as well from
 * a phone on the couch as from the machine the deck runs on.
 *
 * Two things are always visible, because a picker that hides either is the
 * kind you fight: which folder you are in, and which folder the button will
 * actually add.
 */
export default function FolderPicker({ open, onClose, onAdd, known = [] }) {
  const [data, setData] = useState(null)
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [typed, setTyped] = useState('')
  const [typing, setTyping] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  // No filesystem to browse (the panel is open from another machine): the
  // dialog falls back to what it always had, a box you paste a path into.
  const [remote, setRemote] = useState(false)
  const listRef = useRef(null)

  const load = useCallback(async (target, { hidden = showHidden } = {}) => {
    const params = new URLSearchParams()
    if (target) params.set('path', target)
    if (hidden) params.set('hidden', '1')

    let response
    try {
      response = await fetch(`/api/browse?${params}`)
    } catch {
      setError('Could not reach the deck')
      return
    }

    if (response.status === 403) {
      setRemote(true)
      setTyping(true)
      return
    }

    const result = await response.json().catch(() => null)
    if (!result?.ok) {
      // Stay where we are and say why: losing your place on a folder you
      // cannot open is a worse punishment than the folder you cannot open.
      setError(result?.error || 'Could not read that folder')
      return
    }
    setData(result)
    setSelected(null)
    setError(null)
    listRef.current?.scrollTo?.({ top: 0 })
  }, [showHidden])

  useEffect(() => {
    if (!open) return
    setData(null)
    setSelected(null)
    setError(null)
    setTyped('')
    setTyping(false)
    setRemote(false)
    load(null)
  }, [open, load])

  // A folder chosen in the system dialog can be anywhere in a long list.
  useEffect(() => {
    if (!selected) return
    listRef.current?.querySelector('.picker-row.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!open) return null

  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

  // What "Add" will add: the folder you clicked, or the one you are standing
  // in when you have not clicked anything.
  const target = selected || (data ? { path: data.path, name: data.name, isRepo: data.isRepo } : null)
  const alreadyKnown = target ? known.includes(target.path) : false

  async function add(pathToAdd) {
    const value = String(pathToAdd || '').trim()
    if (!value || busy) return
    setBusy(true)
    const result = await onAdd(value)
    setBusy(false)
    if (result?.ok) onClose()
    else setError(result?.error || 'Could not add that folder')
  }

  /**
   * Hand over to the operating system's own dialog.
   *
   * What comes back is not added behind your back: the picker walks to that
   * folder and selects it, so the same "Add folder" button finishes the job
   * and you can still see what you are about to add.
   */
  async function pickNatively() {
    setBusy(true)
    let result = null
    try {
      const response = await fetch('/api/pick-folder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ start: data?.path || null }),
      })
      result = await response.json()
    } catch {
      result = { ok: false, error: 'Could not reach the deck' }
    }
    setBusy(false)

    // Cancelling is an answer, not a failure: say nothing.
    if (!result?.ok) {
      if (!result?.cancelled) setError(result?.error || 'Could not open the system dialog')
      return
    }

    const chosen = result.path.replace(/\/+$/, '') // the dialog returns a trailing slash
    const parent = chosen.slice(0, chosen.lastIndexOf('/')) || '/'
    await load(parent)
    setSelected({ path: chosen, name: chosen.split('/').pop() })
  }

  function toggleHidden() {
    const next = !showHidden
    setShowHidden(next)
    load(data?.path, { hidden: next })
  }

  /** Breadcrumb segments for the folder we are in, each one clickable. */
  function crumbs() {
    if (!data) return []
    const sep = data.separator || '/'
    const parts = data.path.split(sep).filter(Boolean)
    const out = []
    let acc = data.path.startsWith(sep) ? '' : null
    for (const part of parts) {
      acc = acc === null ? part : `${acc}${sep}${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal picker"
        role="dialog"
        aria-label="Add a project folder"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      >
        <h2>Add a project</h2>

        {remote ? (
          <p className="picker-note">
            The deck is running on another machine, so its disk cannot be browsed from here.
            Type the full path of the folder instead.
          </p>
        ) : (
          <>
            <div className="picker-shortcuts">
              {(data?.shortcuts || []).map((shortcut) => (
                <button
                  key={shortcut.path}
                  className={`picker-shortcut ${data?.path === shortcut.path ? 'is-on' : ''}`}
                  onClick={() => load(shortcut.path)}
                >
                  {shortcut.label}
                </button>
              ))}
            </div>

            <div className="picker-bar">
              <button
                className="btn btn-slim"
                title="Up one folder"
                disabled={!data?.parent}
                onClick={() => load(data.parent)}
              >
                ↑
              </button>
              <div className="crumbs">
                {crumbs().map((crumb, i) => (
                  <span key={crumb.path}>
                    {i > 0 && <span className="crumb-sep">/</span>}
                    <button className="crumb" onClick={() => load(crumb.path)}>{crumb.label}</button>
                  </span>
                ))}
              </div>
            </div>

            <div className="picker-list" ref={listRef}>
              {!data && !error && <p className="picker-empty">Reading…</p>}

              {data?.entries.map((entry) => {
                const isKnown = known.includes(entry.path)
                return (
                  <div
                    key={entry.path}
                    className={`picker-row ${selected?.path === entry.path ? 'is-selected' : ''}`}
                  >
                    <button
                      className="picker-pick"
                      title={entry.path}
                      onClick={() => setSelected(entry)}
                      onDoubleClick={() => load(entry.path)}
                    >
                      <span className="picker-icon" aria-hidden="true">{entry.isRepo ? '◆' : '▸'}</span>
                      <span className="picker-name">{entry.name}</span>
                      {entry.isRepo && <span className="tag">git</span>}
                      {isKnown && <span className="ghost-tag">added</span>}
                    </button>
                    <button
                      className="picker-enter"
                      title={`Open ${entry.name}`}
                      aria-label={`Open ${entry.name}`}
                      onClick={() => load(entry.path)}
                    >
                      ›
                    </button>
                  </div>
                )
              })}

              {data?.entries.length === 0 && (
                <p className="picker-empty">
                  Nothing in here{showHidden ? '' : ' — hidden folders are off'}.
                </p>
              )}
              {data?.truncated && <p className="picker-empty">Showing the first 800 folders.</p>}
            </div>

            <div className="picker-tools">
              <label className="picker-check">
                <input type="checkbox" checked={showHidden} onChange={toggleHidden} />
                Show hidden
              </label>
              <div className="picker-links">
                {/*
                  The deck runs on this machine, so its own dialog is right
                  there — and for people who live in the Finder sidebar it
                  beats any list this panel can draw.
                */}
                <button className="linkish" onClick={pickNatively} disabled={busy}>
                  {isMac ? 'Choose in Finder…' : 'Open system dialog…'}
                </button>
                <button className="linkish" onClick={() => setTyping((t) => !t)}>
                  {typing ? 'Browse instead' : 'Type a path'}
                </button>
              </div>
            </div>
          </>
        )}

        {(typing || remote) && (
          <form
            className="picker-typed"
            onSubmit={(e) => {
              e.preventDefault()
              // From the box, Enter goes there rather than adding blind: you
              // get to see what you typed resolved before committing to it.
              if (remote) add(typed)
              else load(typed)
            }}
          >
            <input
              autoFocus
              value={typed}
              placeholder="/Users/you/code/project"
              onChange={(e) => { setTyped(e.target.value); setError(null) }}
            />
            <button type="submit" className="btn btn-slim" disabled={!typed.trim()}>
              {remote ? 'Add' : 'Go'}
            </button>
          </form>
        )}

        {error && <p className="modal-error">{error}</p>}

        <div className="picker-target">
          {target ? (
            <>
              <span className="picker-target-label">Add</span>
              <span className="picker-target-name">{target.name}</span>
              {target.isRepo && <span className="tag">git</span>}
              <span className="picker-target-path" title={target.path}>{shortPath(target.path)}</span>
              {alreadyKnown && <span className="ghost-tag">already in your workspace</span>}
            </>
          ) : (
            <span className="picker-target-label">Choose a folder</span>
          )}
        </div>

        <div className="modal-actions">
          <span className="hint">
            {/* The rule that is not guessable from looking at it. */}
            Click to choose, double-click to open
          </span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!target || busy || alreadyKnown || remote}
            onClick={() => add(target.path)}
          >
            {busy ? 'Adding…' : 'Add folder'}
          </button>
        </div>
      </div>
    </div>
  )
}
