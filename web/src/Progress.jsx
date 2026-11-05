import { useState } from 'react'
import { readLocal, writeLocal } from './localKey.js'

/**
 * Progress.jsx — the checklist a session keeps, above the box you type in.
 *
 * The session writes this list through an MCP tool the deck hands it at
 * spawn (see `src/progress.js`); by the time it renders here it has already
 * been through the socket as an ordinary field on the session. So there is no
 * fetching and no local copy to keep in step: this file only draws what the
 * session last said, and the one thing it can write back is "put it away".
 *
 * ### It sits with the composer, not with the messages
 *
 * Above the box rather than at the end of the transcript, because it is not
 * part of the conversation — it is the state of the work, and it gets
 * replaced rather than appended. In the transcript it would scroll away from
 * you exactly when the list got long enough to be worth having.
 *
 * ### Collapsed is the normal state on a long task
 *
 * Folded, it keeps one line: the step in progress. That is the answer to
 * "what is it doing right now", which is the question being asked most of the
 * time, and it costs one row instead of thirty. The choice is remembered per
 * browser, not per session — it is a preference about how much room you want
 * the strip to take, and it would be strange for it to reset every time you
 * clicked into a different session.
 */

const KEY = 'session-deck.progress-open'

/**
 * How a step is drawn. Never colour alone: each state has its own glyph and
 * its own word in the title, so the list reads the same to someone who cannot
 * tell the green from the grey.
 */
const MARK = {
  completed: { glyph: '●', label: 'done' },
  in_progress: { glyph: '◐', label: 'in progress' },
  pending: { glyph: '○', label: 'to do' },
}

export default function Progress({ todos, onClear }) {
  const [open, setOpen] = useState(() => readLocal(KEY) !== 'no')

  // An empty list is not an empty panel: it is no panel. A session that has
  // not said anything about its plan has nothing to show, and a strip that
  // was permanently there saying "0/0" would be furniture.
  if (!todos || !todos.length) return null

  const total = todos.length
  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')

  function toggle(next) {
    setOpen(next)
    writeLocal(KEY, next ? 'yes' : 'no')
  }

  return (
    <section className="progress">
      <div className="progress-head">
        <button
          className="progress-toggle"
          aria-expanded={open}
          onClick={() => toggle(!open)}
          title={open ? 'Fold the list' : 'Unfold the list'}
        >
          <span className={`progress-caret ${open ? 'is-open' : ''}`} aria-hidden="true">▸</span>
          <span className="progress-count">Progress {done}/{total}</span>
          {/*
            The folded line. It is inside the button because the whole row is
            the control, and it carries the step in progress — or says that
            none is, which on a finished list is the more useful sentence.
          */}
          {!open && (
            <span className="progress-current">
              {current ? current.text : done === total ? 'all done' : 'nothing in progress'}
            </span>
          )}
        </button>
        {/*
          Clearing takes the list off this screen and tells the session
          nothing. It is cheap to undo — the next call to the tool brings a
          list straight back — which is why it does not ask first.
        */}
        <button
          className="progress-clear"
          onClick={onClear}
          title="Put this list away. The session can send a new one at any time."
          aria-label="Put this list away"
        >
          ×
        </button>
      </div>

      {open && (
        <ol className="progress-items">
          {todos.map((todo, i) => {
            const mark = MARK[todo.status] || MARK.pending
            return (
              <li key={i} className={`progress-item is-${todo.status}`}>
                <span className="progress-mark" aria-hidden="true">{mark.glyph}</span>
                <span className="progress-text">{todo.text}</span>
                <span className="sr-only"> — {mark.label}</span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
