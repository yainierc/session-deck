import { useState } from 'react'

/**
 * RoleEditor.jsx — writing down what a session is for.
 *
 * A role is the only thing in this panel whose whole substance is a paragraph.
 * A shortcut is a sentence you could retype; a permission mode is one of
 * three; a role is the standing instruction a session lives under for as long
 * as the team exists, and the difference between a team that works and one
 * that mills about is almost entirely in these words.
 *
 * So the brief gets a real box rather than a line, and the list shows it
 * rather than hiding it behind a name. What you are choosing between when you
 * staff a team is not four words.
 */

const MODELS_EMPTY = []
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const BLANK = { name: '', brief: '', model: '', effort: '', advisor: false, delegates: false }

function toForm(role) {
  if (!role) return { ...BLANK }
  return {
    name: role.name,
    brief: role.brief,
    model: role.model || '',
    effort: role.effort || '',
    advisor: Boolean(role.advisor),
    delegates: Boolean(role.delegates),
  }
}

export default function RoleEditor({ roles, models = MODELS_EMPTY, onChanged, onClose }) {
  // null = nothing open, 'new' = the blank one, otherwise the id being edited.
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  function open(role) {
    setEditing(role ? role.id : 'new')
    setForm(toForm(role))
    setError(null)
  }

  async function send(method, body) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/roles', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const result = await response.json().catch(() => ({ ok: false, error: 'Could not save' }))
    setBusy(false)
    if (!result.ok) { setError(result.error || 'Could not save'); return false }
    await onChanged()
    return true
  }

  async function save() {
    /*
     * The empty string means "no choice", and it has to reach the server as a
     * null rather than as "" — otherwise clearing a model would store one
     * called nothing.
     */
    const payload = {
      name: form.name,
      brief: form.brief,
      model: form.model || null,
      effort: form.effort || null,
      advisor: form.advisor,
      delegates: form.delegates,
    }
    const ok = editing === 'new'
      ? await send('POST', payload)
      : await send('PATCH', { id: editing, patch: payload })
    if (ok) setEditing(null)
  }

  async function remove(role) {
    if (!window.confirm(
      `Delete the role "${role.name}"?\n\nTeams already running are not touched — a role is `
      + 'only read when a session is started.',
    )) return
    await send('DELETE', { id: role.id })
  }

  const chosen = models.find((m) => m.value === form.model)
  const efforts = chosen ? (chosen.supportsEffort ? chosen.effortLevels : []) : EFFORTS

  if (editing) {
    return (
      <div className="roles-pane">
        <div className="roles-head">
          <strong>{editing === 'new' ? 'New role' : 'Edit role'}</strong>
          <button type="button" className="linkish" onClick={() => setEditing(null)}>Back</button>
        </div>

        <label className="field">
          <span>Name</span>
          <input
            type="text"
            value={form.name}
            maxLength={40}
            autoFocus
            placeholder="Backend, QA, Release manager..."
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </label>

        <label className="field">
          <span>Brief</span>
          <textarea
            rows={7}
            value={form.brief}
            placeholder={'What this session is, for as long as the team exists.\n\n'
              + 'Say how it should behave, not what to produce — what it is working on arrives '
              + 'separately, when the team is raised.'}
            onChange={(e) => setForm((f) => ({ ...f, brief: e.target.value }))}
          />
        </label>

        <div className="field">
          <span>How it works <em className="field-optional">optional</em></span>
          <div className="how">
            <label className="how-one">
              <span>Model</span>
              <select
                value={form.model}
                disabled={models.length === 0}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              >
                <option value="">Default</option>
                {models.filter((m) => m.value !== 'default')
                  .map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}
              </select>
            </label>
            <label className="how-one">
              <span>Effort</span>
              <select
                value={form.effort}
                disabled={efforts.length === 0}
                onChange={(e) => setForm((f) => ({ ...f, effort: e.target.value }))}
              >
                <option value="">Default</option>
                {efforts.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <label className={`how-advisor ${form.advisor ? 'is-on' : ''}`}>
              <input
                type="checkbox"
                checked={form.advisor}
                onChange={(e) => setForm((f) => ({ ...f, advisor: e.target.checked }))}
              />
              Advisor
            </label>
          </div>
          {form.advisor && (
            <p className="note">
              A stronger model is consulted at the hard moments. It reads the whole conversation
              each time, so it costs noticeably more — on every session given this role.
            </p>
          )}
        </div>

        {/*
          A starting point and never the last word: the composer asks again per
          member, because the same role supervises on one team and builds on
          another.
        */}
        <label className="role-lead">
          <input
            type="checkbox"
            checked={form.delegates}
            onChange={(e) => setForm((f) => ({ ...f, delegates: e.target.checked }))}
          />
          Usually hands out the work
        </label>

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !form.name.trim() || !form.brief.trim()}
            onClick={save}
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="roles-pane">
      <div className="roles-head">
        <strong>Roles</strong>
        <span className="note">What a session is for, as long as the team exists</span>
        <button type="button" className="linkish" onClick={onClose}>Done</button>
      </div>

      <div className="roles-list">
        {roles.map((role) => (
          <div key={role.id} className="role-row">
            <div className="role-row-top">
              <span className="role-row-name">{role.name}</span>
              {role.delegates && <span className="pill lead">hands out work</span>}
              {role.model && <span className="pill">{role.model}</span>}
              {role.effort && <span className="pill">effort <b>{role.effort}</b></span>}
              {role.advisor && <span className="pill adv">advisor</span>}
              <span className="role-row-actions">
                <button type="button" className="linkish" onClick={() => open(role)}>Edit</button>
                <button type="button" className="linkish is-danger" onClick={() => remove(role)}>Delete</button>
              </span>
            </div>
            {/* Shown, not hidden behind the name: what you are choosing between
                when you staff a team is not four words. */}
            <p className="role-row-brief">{role.brief}</p>
          </div>
        ))}
        {roles.length === 0 && <p className="note">No roles. Add one, or put the shipped four back.</p>}
      </div>

      {error && <p className="modal-error">{error}</p>}

      <div className="modal-actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => send('POST', { reset: true })}
          title="Put back any of the shipped four you have deleted. Everything else is kept."
        >
          Restore shipped
        </button>
        <button type="button" className="btn btn-primary" onClick={() => open(null)}>New role</button>
      </div>
    </div>
  )
}
