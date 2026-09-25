import { useMemo, useState } from 'react'

/**
 * RoadmapDraft — asking for a roadmap at the moment you finished deciding one.
 *
 * A plan is not reached here. It is reached in the conversation this panel is
 * attached to, and it ends up written down in the repository as a document.
 * What is left over — turning that document into milestones with a title, a
 * provenance, a place, a finish line and a trap each — is transcription, and
 * this is the button that hands it off.
 *
 * Which is why the only required input is a path, and why you should almost
 * never have to type it. The session just wrote that document, the deck
 * watched it happen, and the transcript already carries every file it touched
 * with what it did to each one. So the list is what this session wrote, most
 * recent first, and the text field underneath is the escape hatch for the
 * times the deck was not watching — a document from last week, or one written
 * by a session that has since gone.
 *
 * The note is the other half and it is deliberately small. A document covers
 * everything the work needs; a roadmap covers what one repository can execute,
 * and a big document is usually several roadmaps. The note is where you say
 * which slice you want this time. It is optional because the common case is
 * that the document already says.
 */

/** What the map calls an action that produced a file, rather than read one. */
const WROTE = new Set(['write', 'edit'])

function relativeTo(root, file) {
  if (!root || !file) return file || ''
  const base = root.endsWith('/') ? root : root + '/'
  return file.startsWith(base) ? file.slice(base.length) : file
}

/**
 * The documents this session wrote, newest first.
 *
 * Markdown only, and written rather than read: a session reads dozens of files
 * to answer a question and writes the one it was asked to produce. Offering
 * everything it opened would bury the answer in its own research.
 */
function documentsFrom(events, projectPath) {
  const seen = new Map()
  for (const e of events || []) {
    if (!WROTE.has(e.action)) continue
    if (!e.path || !/\.mdx?$/i.test(e.path)) continue
    const rel = relativeTo(projectPath, e.path)
    // Outside the project it cannot be read by a session running inside it.
    if (rel.startsWith('/') || rel.startsWith('..')) continue
    const at = Date.parse(e.at || '') || 0
    const prev = seen.get(rel)
    if (!prev || at >= prev) seen.set(rel, at)
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel)
}

export default function RoadmapDraft({ session, events, onClose, onStarted }) {
  const projectPath = session.projectPath || session.cwd
  const suggested = useMemo(() => documentsFrom(events, projectPath), [events, projectPath])

  const [document, setDocument] = useState(suggested[0] || '')
  const [typed, setTyped] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const chosen = (document === '__other__' ? typed : document).trim()

  async function submit(e) {
    e.preventDefault()
    if (!chosen || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/roadmap?path=${encodeURIComponent(projectPath)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'propose', document: chosen, note }),
      })
      const result = await res.json()
      if (!result?.ok) { setError(result?.error || 'Could not start the draft'); return }
      onStarted?.(result)
      onClose()
    } catch {
      setError('Could not reach the deck')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal draft" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Draft a roadmap from a document</h2>
        <p className="note">
          A session reads the plan you already wrote and turns the part this repository can
          execute into milestones. Nothing is created until you have read it back.
        </p>

        <label className="draft-label">The document</label>
        {suggested.length > 0 ? (
          <div className="draft-docs">
            {suggested.slice(0, 6).map((doc) => (
              <label key={doc} className={`draft-doc ${document === doc ? 'is-on' : ''}`}>
                <input
                  type="radio"
                  name="document"
                  checked={document === doc}
                  onChange={() => setDocument(doc)}
                />
                <span>{doc}</span>
              </label>
            ))}
            <label className={`draft-doc ${document === '__other__' ? 'is-on' : ''}`}>
              <input
                type="radio"
                name="document"
                checked={document === '__other__'}
                onChange={() => setDocument('__other__')}
              />
              <span>Another file...</span>
            </label>
          </div>
        ) : (
          <p className="note is-quiet">
            This session has not written a document the deck saw. Name one — a path inside
            the project.
          </p>
        )}

        {(document === '__other__' || suggested.length === 0) && (
          <input
            className="draft-path"
            value={typed}
            autoFocus
            placeholder="docs/implementation-plan/some-plan.md"
            aria-label="Path to the document"
            onChange={(e) => setTyped(e.target.value)}
          />
        )}

        <label className="draft-label" htmlFor="draft-note">
          Anything to narrow it <span className="row-meta">optional</span>
        </label>
        <textarea
          id="draft-note"
          className="draft-note"
          rows={3}
          maxLength={2000}
          value={note}
          placeholder="Which slice you want this time — &quot;only the observability track, leave the identity grants out&quot;. A big document is usually several roadmaps."
          onChange={(e) => setNote(e.target.value)}
        />

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-slim" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={!chosen || busy}>
            {busy ? 'Starting...' : 'Draft it'}
          </button>
        </div>
      </form>
    </div>
  )
}
