import { useEffect, useState } from 'react'
import PermissionMode from './PermissionMode.jsx'
import RoleEditor from './RoleEditor.jsx'

/**
 * TeamLauncher.jsx — several sessions as one act.
 *
 * Starting a team by hand is the new-task modal four times over, and what
 * comes out is worse than four launches: the roster paragraph goes into a
 * session's first prompt and only there, so the one you start first is the one
 * that knows nobody. Doing it here means somebody knows the whole list before
 * the first process exists.
 *
 * ### A role and a project are two questions
 *
 * The role is what gets saved and reused — its task, and the model, effort and
 * advisor it usually wants. The project is chosen here, at the moment of
 * composing. Saving them together would make "Backend of Platform", "Backend
 * of Payment" and "Backend of Checkout" three separate things to keep in step
 * with each other, which is three places to forget.
 *
 * ### One permission mode, for everybody
 *
 * Not a simplification. Whether a message between two sessions arrives or
 * waits for your approval is decided by permission-mode parity, so a team
 * assembled across that line would look like it was working and would not be.
 */

/** Addresses are composed the way src/roster.js composes them. */
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * What this member will answer to, worked out before it exists.
 *
 * Shown because two members called "Backend" are two identical rows otherwise,
 * and the address is the thing the others will actually type. The server
 * composes the real one — this has to agree with it, including the rule that
 * the project is not repeated when the role already starts with it.
 */
function addressFor(project, role, taken) {
  const p = slug(project)
  const r = slug(role)
  if (!r) return ''
  const base = p && !r.startsWith(p) ? `${p}-${r}` : r
  if (!taken.includes(base)) return base
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return base
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * What a seat will actually run with, as opposed to what was typed into it.
 *
 * The list used to show only the overrides, so a row that takes its model from
 * its role showed nothing at all — and a row that came from a proposal showed
 * nothing ever, because a proposal names roles and leaves the rest to them.
 * The question "which model is this one on" then had no answer on the screen
 * that is about to start it.
 *
 * So the effective value is shown, and where it came from is shown with it: a
 * value set on this row reads normally, one inherited from the role reads
 * quieter. Nothing at all means nothing was chosen anywhere, which is a real
 * answer — that seat runs on the panel's own default — and five rows all
 * saying "default" would be five rows of noise.
 */
function Running({ member, role }) {
  /*
   * A row from a proposal takes the role's, because that is what it will be
   * raised with. A row composed here keeps its own, including a `false` —
   * the controls were seeded from the role when it was picked, so what they
   * say now is this seat's decision and not a gap to fill in.
   */
  const from = member.fromDraft ? role : member
  const model = from?.model || ''
  const effort = from?.effort || ''
  const advisor = Boolean(from?.advisor)
  const mark = member.fromDraft ? ' is-inherited' : ''
  const whose = member.fromDraft ? `from the ${member.name} role` : 'chosen for this seat'

  if (!model && !effort && !advisor) {
    return <span className="pill is-inherited" title="Nothing chosen here or on the role">default</span>
  }

  return (
    <>
      {model && <span className={`pill${mark}`} title={whose}>{model}</span>}
      {effort && <span className={`pill${mark}`} title={whose}>effort <b>{effort}</b></span>}
      {advisor && <span className={`pill adv${mark}`} title={whose}>advisor</span>}
    </>
  )
}

export default function TeamLauncher({ open, projects = [], sessions = [], draft = null, onClose, onRaise }) {
  const [members, setMembers] = useState([])
  const [roles, setRoles] = useState([])
  const [models, setModels] = useState([])
  const [modes, setModes] = useState([])
  const [mode, setMode] = useState('default')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState(null)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [managing, setManaging] = useState(false)

  // The row being composed.
  const [project, setProject] = useState('')
  const [role, setRole] = useState('')
  const [how, setHow] = useState({ model: '', effort: '', advisor: false })
  const [delegates, setDelegates] = useState(false)

  const folders = projects.filter((p) => p.path)

  useEffect(() => {
    if (!open) return
    setResults(null)
    /*
     * Opened from a proposal, the form starts filled in. Every seat is still a
     * row you can take out before raising — which is the whole reason the
     * proposal opens the composer instead of raising anything itself.
     */
    if (draft) {
      /*
       * Composed in order, so two seats of the same role in the same project
       * get the numbered addresses they will actually answer to. Without this
       * the rows arrive blank where the one thing that tells them apart goes.
       */
      const taken = sessions.map((s) => s.peerName || s.name).filter(Boolean)
      // Seats already started are left out: raising one twice is two sessions
      // on the same job, and the proposal is the thing that remembers.
      setMembers(draft.members.filter((m) => m.cwd && !m.raised).map((m, i) => {
        const address = addressFor(m.project, m.role, taken)
        taken.push(address)
        return {
          id: `draft-${i}`,
          cwd: m.cwd,
          project: m.project,
          name: m.role,
          brief: '',
          delegates: Boolean(m.delegates),
          address,
          fromDraft: true,
          why: m.why,
        }
      }))
    } else {
      setMembers([])
    }
    setName(draft?.name || '')
    setGoal(draft?.goal || '')
    setManaging(false)
    setBusy(false)
    setProject(folders[0]?.path || '')
    /*
     * Roles, which are not the launcher's shortcuts. A shortcut is an errand
     * that is done when it is done; a role is a standing brief for as long as
     * the team exists. Offering "Catch me up" as a role to staff a team with
     * was this screen reusing the wrong list.
     */
    loadRoles()
    fetch('/api/settings').then((r) => r.json())
      .then((d) => { setModes(d.modes || []); setMode(d.settings?.permissionMode || 'default') })
      .catch(() => setModes([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft])

  /*
   * Roles, which are not the launcher's shortcuts. A shortcut is an errand that
   * is done when it is done; a role is a standing brief for as long as the team
   * exists. Reloadable, because the editor below changes them in place.
   */
  async function loadRoles() {
    try {
      const data = await (await fetch('/api/roles')).json()
      const list = data.roles || []
      setRoles(list)
      setRole((current) => (list.some((r) => r.name === current) ? current : list[0]?.name || ''))
    } catch {
      setRoles([])
    }
  }

  /*
   * Per project, because an organisation's allowlist can be. Asked again when
   * the row's project changes rather than once for the whole team: two members
   * in two repositories are not guaranteed the same answer.
   */
  useEffect(() => {
    if (!open || !project) { setModels([]); return }
    fetch(`/api/models?cwd=${encodeURIComponent(project)}`)
      .then((r) => r.json())
      .then((d) => setModels(d.ok ? d.models || [] : []))
      .catch(() => setModels([]))
  }, [open, project])

  /** Picking a role brings the values it usually runs with, and its habit of delegating. */
  useEffect(() => {
    const found = roles.find((r) => r.name === role)
    if (!found) return
    setHow({ model: found.model || '', effort: found.effort || '', advisor: Boolean(found.advisor) })
    setDelegates(Boolean(found.delegates))
  }, [role, roles])

  const chosenModel = models.find((m) => m.value === how.model)
  const efforts = chosenModel ? (chosenModel.supportsEffort ? chosenModel.effortLevels : []) : EFFORTS

  if (!open) return null

  const taken = [
    ...sessions.map((s) => s.peerName || s.name).filter(Boolean),
    ...members.map((m) => m.address),
  ]
  const projectName = (path) => folders.find((f) => f.path === path)?.name || path
  const preview = addressFor(projectName(project), role, taken)

  function add() {
    const found = roles.find((r) => r.name === role)
    if (!found || !project) return
    setMembers((list) => [...list, {
      id: Math.random().toString(36).slice(2),
      cwd: project,
      project: projectName(project),
      name: found.name,
      /*
       * The brief says how this one behaves; the goal says what the team is
       * on right now. Both, in that order, because a session reads its
       * standing instructions better when what it is actually for comes
       * straight after them.
       */
      brief: found.brief,
      /*
       * Recorded as chosen, including a no. The controls above were seeded
       * from the role the moment it was picked, so what they say now is a
       * decision about this seat — and `advisor: false` on a row whose role
       * usually has one is the decision that matters most.
       */
      model: how.model || null,
      effort: how.effort || null,
      advisor: how.advisor,
      delegates,
      address: preview,
    }])
    setDelegates(false)
  }

  async function raise() {
    if (members.length === 0 || busy) return
    setBusy(true)
    const result = await onRaise({
      /*
       * Named, because a screen listing three of these needs to tell them
       * apart, and "the one from Tuesday" stops working on Wednesday. The
       * projects it spans is the honest default.
       */
      name: name.trim() || [...new Set(members.map((m) => m.project))].join(' + '),
      goal: goal.trim(),
      // So the proposal can mark what went, rather than being thrown away.
      fromProposal: draft?.source || undefined,
      members: members.map(({ id, address, brief, fromDraft, why, ...rest }) => {
        /*
         * A row from a proposal carries its role name and nothing else: the
         * proposal names roles and leaves how they run to them. So the brief,
         * the model, the effort and the advisor all come from the saved role —
         * which is why the roles are created before this screen opens, and why
         * a seat that skipped that would have started on the panel's defaults
         * while the card said it had an advisor.
         */
        const saved = roles.find((r) => r.name === rest.name)
        const body = brief || saved?.brief || ''
        const how = fromDraft
          ? { model: saved?.model || null, effort: saved?.effort || null, advisor: Boolean(saved?.advisor) }
          : { model: rest.model, effort: rest.effort, advisor: rest.advisor }
        return {
          ...rest,
          ...how,
          prompt: goal.trim()
            ? `${body}\n\n---\n\nWhat this team is working on right now:\n\n${goal.trim()}`
            : body,
        }
      }),
      permissionMode: mode,
    })
    setBusy(false)
    setResults(result)
  }

  const byProject = members.reduce((map, m) => {
    map.set(m.project, [...(map.get(m.project) || []), m])
    return map
  }, new Map())

  const leads = members.filter((m) => m.delegates).length

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{draft ? 'New team, from a proposal' : 'New team'}</h2>
        <p className="modal-where">
          {draft
            ? `proposed by ${draft.from || 'a session'} — every row can still be taken out`
            : `${folders.length} ${folders.length === 1 ? 'project' : 'projects'} in your workspace`}
        </p>

        {!results && !managing && (
          <>
            <label className="field">
              <span>Name <em className="field-optional">optional</em></span>
              <input
                type="text"
                value={name}
                maxLength={60}
                disabled={busy}
                placeholder="Defaults to the projects it spans"
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            {/*
              What they are on, as opposed to what each one is for. A role is a
              standing brief and says nothing about today; without this every
              member comes up knowing how to behave and with nothing to do.
            */}
            <label className="field">
              <span>What the team is working on</span>
              <textarea
                rows={3}
                value={goal}
                maxLength={400}
                disabled={busy}
                placeholder="Goes to every member, after their own brief"
                onChange={(e) => setGoal(e.target.value)}
              />
            </label>
          </>
        )}

        {managing ? (
          <RoleEditor
            roles={roles}
            models={models}
            onChanged={loadRoles}
            onClose={() => setManaging(false)}
          />
        ) : results ? (
          <Results results={results} onClose={onClose} />
        ) : (
          <>
            <div className="composer">
              <div className="crow">
                <label className="f">
                  <span>Project</span>
                  <select value={project} disabled={busy} onChange={(e) => setProject(e.target.value)}>
                    {folders.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
                  </select>
                </label>
                <label className="f">
                  <span>
                    Role
                    <button
                      type="button"
                      className="linkish f-side"
                      onClick={() => setManaging(true)}
                      title="Add a role, or change what one says"
                    >
                      manage
                    </button>
                  </span>
                  <select value={role} disabled={busy} onChange={(e) => setRole(e.target.value)}>
                    {roles.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
                  </select>
                </label>
                <label className="f">
                  <span>Model</span>
                  <select
                    value={how.model}
                    disabled={busy || models.length === 0}
                    onChange={(e) => setHow((h) => ({ ...h, model: e.target.value }))}
                  >
                    <option value="">Default</option>
                    {models.filter((m) => m.value !== 'default')
                      .map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}
                  </select>
                </label>
                <label className="f">
                  <span>Effort</span>
                  <select
                    value={how.effort}
                    disabled={busy || efforts.length === 0}
                    onChange={(e) => setHow((h) => ({ ...h, effort: e.target.value }))}
                  >
                    <option value="">Default</option>
                    {efforts.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
                <div className="f toggle">
                  <label className={`swx ${how.advisor ? 'is-on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={how.advisor}
                      disabled={busy}
                      onChange={(e) => setHow((h) => ({ ...h, advisor: e.target.checked }))}
                    />
                    Advisor
                  </label>
                </div>
                <div className="f toggle">
                  <button type="button" className="btn btn-primary" disabled={busy || !role || !project} onClick={add}>
                    Add
                  </button>
                </div>
              </div>

              {roles.find((r) => r.name === role)?.brief && (
                <p className="role-brief">{roles.find((r) => r.name === role).brief}</p>
              )}

              <p className="team-addr">
                {preview
                  ? <>will answer to <b>{preview}</b></>
                  : 'pick a role'}
                {' · '}
                {/*
                  Which one delegates is the only thing that changes the order
                  sessions are started in, and the order is what decides who
                  knows whom. It is a property of this member on this team, not
                  of the saved role, because the same role supervises on one
                  team and does the work on another.
                */}
                <label className="team-lead">
                  <input
                    type="checkbox"
                    checked={delegates}
                    disabled={busy}
                    onChange={(e) => setDelegates(e.target.checked)}
                  />
                  this one hands out the work
                </label>
              </p>
            </div>

            <div className="team">
              {members.length === 0 ? (
                <p className="team-empty">Nobody yet. Pick a project and a role, and add.</p>
              ) : [...byProject].map(([name, list]) => (
                <div key={name} className="tgroup">
                  <div className="tgroup-head">{name}</div>
                  {list.map((m) => (
                    <div key={m.id} className="member">
                      <span className="m-name">{m.name}</span>
                      <span className="m-addr">{m.address}</span>
                      <span className="m-meta">
                        {m.delegates && <span className="pill lead">hands out work</span>}
                        <Running member={m} role={roles.find((r) => r.name === m.name)} />
                      </span>
                      <button
                        className="m-drop"
                        title="Remove"
                        disabled={busy}
                        onClick={() => setMembers((l) => l.filter((x) => x.id !== m.id))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/*
              Said before, not after. The one that hands out the work is
              started last so it is introduced to everybody; with nobody
              marked, they all come up knowing whoever came before them and
              that is all, which is a team that cannot be driven from inside.
            */}
            {members.length > 1 && leads === 0 && (
              <p className="note team-warn">
                Nobody hands out the work, so these start as strangers to each other except
                in the order they come up. Mark one if something should coordinate the rest.
              </p>
            )}
            {leads > 1 && (
              <p className="note team-warn">
                Two of these hand out the work. They will both be started last and will
                both know everybody, which is allowed and is rarely what is meant.
              </p>
            )}

            {modes.length > 0 && (
              <div className="field">
                <span>Permissions <em className="field-optional">one for the whole team</em></span>
                <PermissionMode modes={modes} value={mode} onChange={setMode} disabled={busy} />
                <p className="note">
                  The same for everybody on purpose: a message between two sessions in
                  different modes waits for your approval instead of arriving, and a session
                  waiting on a held reply looks exactly like one waiting on a busy colleague.
                </p>
              </div>
            )}

            <div className="modal-actions">
              <span className="hint">
                {members.length} {members.length === 1 ? 'session' : 'sessions'}
              </span>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={members.length === 0 || busy}
                onClick={raise}
              >
                {busy ? 'Starting...' : 'Raise the team'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * What actually happened, one line per member.
 *
 * Not a success or a failure for the batch: a team where three came up and one
 * did not is three sessions running, and there is no un-launching them. The
 * useful thing to say is which is which.
 */
function Results({ results, onClose }) {
  const rows = results?.results || []
  const failed = rows.filter((r) => !r.ok)

  /*
   * Nothing got as far as being launched: the socket was down, the command
   * timed out, or the server is older than this screen and does not know the
   * word. Without this the empty list below reads as "all of them are
   * running", which is the worst available answer to "did that work".
   */
  if (rows.length === 0) {
    return (
      <>
        <p className="modal-error">{results?.error || 'Nothing was started.'}</p>
        <p className="note">
          No session was launched. If the deck was updated while it was running, it has to
          be restarted before it knows how to raise a team.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="team">
        {rows.map((row, i) => (
          <div key={row.deckId || i} className={`member ${row.ok ? '' : 'is-bad'}`}>
            <span className="m-name">{row.label}</span>
            {row.ok ? (
              <>
                <span className="m-addr">{row.name}</span>
                <span className="m-meta">
                  <span className="pill">
                    {row.introduced.length === 0
                      ? 'introduced to nobody'
                      : `knows ${row.introduced.length}`}
                  </span>
                  {/*
                    The number that decides whether a team works. Past the
                    limit somebody is working beside colleagues they were never
                    told about, and until now that was decided in silence by
                    whatever order the session list happened to be in.
                  */}
                  {row.notIntroduced > 0 && (
                    <span className="pill is-warn">{row.notIntroduced} too many to introduce</span>
                  )}
                </span>
              </>
            ) : (
              <span className="m-meta"><span className="pill is-warn">{row.error}</span></span>
            )}
          </div>
        ))}
      </div>

      {failed.length === 0 ? (
        <p className="note">
          All {rows.length} are running. The one that hands out the work was started last,
          so it knows the rest; the rest can reply to whoever writes to them.
        </p>
      ) : (
        <p className="note team-warn">
          {failed.length} of {rows.length} did not start. The others are running and were
          left alone — there is no un-launching a session.
        </p>
      )}
      {results?.held?.length > 0 && (
        <p className="note team-warn">
          Replies from {results.held.join(', ')} will wait for your approval instead of
          arriving: they run in a different permission mode, or one the deck cannot see.
        </p>
      )}

      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
    </>
  )
}
