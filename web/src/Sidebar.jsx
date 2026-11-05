import { useEffect, useState } from 'react'
import { STATUS_LABEL, shortPath, describeSubpath } from './format.js'
import { useCollapsed } from './useCollapsed.js'
import PermissionMode from './PermissionMode.jsx'
import Menu from './Menu.jsx'

function StatusDot({ status }) {
  return <span className={`dot dot-${status}`} aria-hidden="true" />
}

/**
 * The part of a session's name it inherited from its folder.
 *
 * The deck derives a name like `github-acmeplatform-25` from the project it runs
 * in, so inside `GITHUB-AcmePlatform` the first twenty characters of every
 * session say what the heading above them already said. Four sessions like
 * that are four rows that start identically and differ in the last two
 * characters — which is exactly where the eye is not looking.
 *
 * So the inherited half is dimmed rather than removed. Dimming buys the
 * glance without costing the name: it is still there to read, to copy, and to
 * recognise if this list is ever seen without its heading. A session you
 * named yourself has nothing to inherit and is left exactly as you wrote it.
 */
function splitInherited(projectNames, sessionName) {
  if (!sessionName) return null
  /*
   * Several names to try, because the heading and the folder can now differ.
   * A session is named after the *folder* it runs in, so a project you have
   * renamed to `Accounting` still has sessions called `ledger-api-25` — and
   * those are exactly the ones where the prefix is redundant with the path
   * line underneath. Checking both keeps the dimming working through a rename
   * instead of quietly switching itself off.
   */
  for (const projectName of projectNames) {
    if (!projectName) continue
    const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    if (slug.length < 3) continue
    const prefix = `${slug}-`
    if (!sessionName.toLowerCase().startsWith(prefix)) continue
    const rest = sessionName.slice(prefix.length)
    // A name that is *only* the prefix has nothing left to distinguish it, and
    // dimming the whole row would be worse than leaving it alone.
    if (rest) return { inherited: sessionName.slice(0, prefix.length), rest }
  }
  return null
}

function SessionName({ session, projectNames }) {
  const split = splitInherited(projectNames, session.name)
  if (!split) return <span className="session-name">{session.name}</span>
  return (
    <span className="session-name" title={session.name}>
      <span className="session-inherited">{split.inherited}</span>
      {split.rest}
    </span>
  )
}

function SessionRow({ session, projectNames, active, onSelect }) {
  const waiting = session.status === 'waiting'
  const where = describeSubpath(session)
  return (
    <button
      className={`session ${active ? 'is-active' : ''} ${waiting ? 'is-waiting' : ''}`}
      onClick={() => onSelect(session)}
      title={session.cwd}
    >
      <span className="session-line">
        <StatusDot status={session.status} />
        <SessionName session={session} projectNames={projectNames} />
        {session.managed && <span className="tag" title="Launched from the deck">deck</span>}
        <span className="session-meta">
          {waiting ? (session.waitingFor || 'needs you') : STATUS_LABEL[session.status] || session.status}
        </span>
      </span>
      {where && <span className="session-sub">{where}</span>}
    </button>
  )
}

/**
 * The permission level new sessions start at.
 *
 * It lives here, in sight, rather than only inside the launcher: a standing
 * preference you have to open a dialog to find is one you forget you set.
 */
function DefaultPermissions() {
  const [modes, setModes] = useState([])
  const [mode, setMode] = useState('default')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        setModes(data.modes || [])
        setMode(data.settings?.permissionMode || 'default')
      })
      .catch(() => setModes([]))
  }, [])

  function choose(next) {
    setMode(next)
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: next }),
    }).catch(() => {})
  }

  if (modes.length === 0) return null
  const current = modes.find((m) => m.id === mode)

  return (
    <div className="foot-setting">
      <button className="foot-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="foot-label">New sessions</span>
        <span className={`foot-value ${current?.dangerous ? 'is-danger' : ''}`}>
          {current?.label || mode}
        </span>
      </button>
      {open && (
        <div className="foot-body">
          <PermissionMode modes={modes} value={mode} onChange={choose} />
        </div>
      )}
    </div>
  )
}

/**
 * Renaming a project in place.
 *
 * In place rather than in a dialog because the name is being judged against
 * its neighbours: `web` is only a bad heading next to the other three `web`s,
 * and a modal covers exactly the list you are trying to fix. Typing it in the
 * row means you see the result where it will live, at the width it will have.
 *
 * Enter saves, Escape abandons, and clicking away saves too — the field looks
 * like a text input in a menu, and losing a rename because the mouse moved
 * would be surprising in a way that losing a half-typed search is not.
 *
 * Clearing the field is the documented way back: it drops the label and the
 * folder's own name returns. The placeholder says so by being that name, so
 * an empty field is never a blank row — it is a preview of what emptying it
 * gets you.
 */
function ProjectNameEditor({ project, onCommit, onCancel }) {
  const [value, setValue] = useState(project.label || '')

  return (
    <form
      className="project-rename"
      onSubmit={(e) => { e.preventDefault(); onCommit(value) }}
    >
      <input
        autoFocus
        value={value}
        placeholder={project.folderName || project.name}
        aria-label={`Name for ${project.name}`}
        maxLength={60}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        }}
      />
    </form>
  )
}

/**
 * Everything a project can have done to it, in one menu.
 *
 * The heading used to carry four controls — fold, up, down, new task, stop
 * tracking — in a row 293px wide that also has to say a name of eighteen
 * characters. There is no good way to divide that width: either the name
 * breaks in half or the buttons end up 15px across, which is a target a
 * finger misses rather than merely finds hard.
 *
 * So the row keeps the one thing you do daily and the rest moves in here,
 * where the options can be called by their names instead of being a nine-pixel
 * arrow. It is the same control on a desktop and on a phone, which matters
 * more than it sounds: nothing here lives only in a hover, so nothing here is
 * unreachable from the screen this panel is most often opened on.
 */
const DOTS = (
  <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
    <circle cx="7" cy="3" r="1.15" fill="currentColor" />
    <circle cx="7" cy="7" r="1.15" fill="currentColor" />
    <circle cx="7" cy="11" r="1.15" fill="currentColor" />
  </svg>
)

function ProjectMenu({ project, canUp, canDown, onNewTask, onMove, onRemove, onRename }) {
  return (
    <Menu
      label={DOTS}
      title={`More for ${project.name}`}
      buttonClass="icon-btn icon-btn-more"
    >
      {(close) => {
        const run = (action) => { close(); action() }
        return (
          <>
            <button role="menuitem" onClick={() => run(() => onNewTask(project.path))}>
              New task
            </button>
            <button role="menuitem" onClick={() => run(() => onRename(project.path))}>
              {project.label ? 'Rename' : 'Rename\u2026'}
            </button>
            <button role="menuitem" disabled={!canUp} onClick={() => run(() => onMove(project.path, 'up'))}>
              Move up
            </button>
            <button role="menuitem" disabled={!canDown} onClick={() => run(() => onMove(project.path, 'down'))}>
              Move down
            </button>
            <div className="menu-sep" />
            {/* Last, apart, and in red. Dropping a folder is the one thing here
                you cannot undo with the item above it. */}
            <button
              role="menuitem"
              className="is-danger"
              onClick={() => run(() => onRemove(project.path))}
            >
              Stop tracking
            </button>
          </>
        )
      }}
    </Menu>
  )
}

export default function Sidebar({
  projects, selectedSession, selectedProject, onSelectSession, onSelectProject,
  connected, onNewTask, onBrowseFolders, sideRight, onFlipSide, onRemoveFolder, onMoveProject, onOpenInbox, inboxActive,
  onOpenSettings, settingsActive, onOpenRoom, roomActive, onOpenPlans, plansActive,
  onOpenPickUp, pickUpActive,
  onRenameProject, onOpenTeam, teamActive, open, onClose,
}) {
  const waitingTotal = projects.reduce((sum, p) => sum + p.waiting, 0)
  const sessionTotal = projects.reduce((sum, p) => sum + p.sessions.length, 0)
  const { collapsed, toggle } = useCollapsed(projects)
  // One at a time, by path: a rename is a thing you are doing to one heading,
  // and the path survives the redraw that saving the name causes.
  const [renaming, setRenaming] = useState(null)

  /*
   * Only saved folders have a place in the order, so only they can be moved
   * through it. An unsaved project is one the deck is driving a task in
   * without the folder being in the workspace; it is appended after the
   * saved ones and has nothing to write a position on — the same reason it
   * cannot be removed either.
   */
  const ordered = projects.filter((p) => p.saved).map((p) => p.path)

  return (
    <aside className={`sidebar ${open ? 'is-open' : ''}`} id="deck-menu">
      <header className="brand">
        <div className="brand-row">
          <h1>session-deck</h1>
          <span className={`link ${connected ? 'ok' : 'off'}`} title={connected ? 'connected' : 'reconnecting'} />
          <button
            className="side-flip"
            onClick={onFlipSide}
            title={sideRight ? 'Move this menu to the left' : 'Move this menu to the right'}
            aria-label={sideRight ? 'Move this menu to the left' : 'Move this menu to the right'}
          >
            {/* A window with its menu drawn on the side it would move to. */}
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
              <path d={sideRight ? 'M5.5 2.5v11' : 'M10.5 2.5v11'} />
              <rect x={sideRight ? 1.5 : 10.5} y="2.5" width="4" height="11" fill="currentColor" stroke="none" opacity=".45" />
            </svg>
          </button>
          {/* Only reachable on phones, where the menu is a drawer over the view. */}
          <button className="drawer-close" onClick={onClose} aria-label="Close menu">
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2 2 L10 10 M10 2 L2 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p className="brand-sub">
          {sessionTotal} {sessionTotal === 1 ? 'session' : 'sessions'} across {projects.length}{' '}
          {projects.length === 1 ? 'project' : 'projects'}
        </p>
      </header>

      <button className={`inbox-link ${inboxActive ? 'is-active' : ''}`} onClick={onOpenInbox}>
        What needs you
        {waitingTotal > 0 && <span className="badge">{waitingTotal}</span>}
      </button>

      {/*
        The screens, as a row rather than a stack.
        
        Every one of these used to be a button the full width of the menu, and
        there were four of them: between the one thing that needs you and the
        projects you came to look at sat four rows of chrome. They are all
        one word, they are all the same kind of thing, and a word does not need
        240px to be legible. What stays full width is the queue above, which is
        the only one carrying a number that changes.
      */}
      <nav className="nav-chips" aria-label="Screens">
        {sessionTotal > 0 && (
          <button
            className={`nav-chip ${teamActive ? 'is-active' : ''}`}
            onClick={onOpenTeam}
            title="Who is working, who hands out the work, and who has talked to whom"
          >
            Team
          </button>
        )}

        {/*
          Always offered, unlike the other two, because a room outlives its
          sessions: the conversation two agents had yesterday is still worth
          reading after both have exited, and gating this on what is running
          now would hide exactly that.
        */}
        {/*
          Always offered, like the room and for the same reason: a plan
          outlives the sessions that worked on it, and gating this on what is
          running would hide the project you have not started yet — which is
          the one this screen is best at answering for.
        */}
        <button
          className={`nav-chip ${plansActive ? 'is-active' : ''}`}
          onClick={onOpenPlans}
          title="What each project is trying to build, and what can be started today"
        >
          Plans
        </button>

        {/*
          Beside Plans, because it reads the same files and answers the other
          question about them: not what the project is building, but where you
          stopped — which is what you need after a blocker pulled you away and
          you came back a fortnight later.
        */}
        <button
          className={`nav-chip ${pickUpActive ? 'is-active' : ''}`}
          onClick={onOpenPickUp}
          title="Where you left off on each plan in progress, and what can be started now"
        >
          Pick up
        </button>

        <button
          className={`nav-chip ${roomActive ? 'is-active' : ''}`}
          onClick={onOpenRoom}
          title="What your sessions have said to each other"
        >
          Room
        </button>

        <button
          className={`nav-chip ${settingsActive ? 'is-active' : ''}`}
          onClick={onOpenSettings}
        >
          Settings
        </button>
      </nav>

      {waitingTotal > 0 && (
        <div className="alert">
          {waitingTotal === 1
            ? '1 session is blocked waiting for you'
            : `${waitingTotal} sessions are blocked waiting for you`}
        </div>
      )}

      <nav className="projects">
        {projects.map((project) => {
          const isShut = collapsed.has(project.path)
          /*
           * The project the conversation on screen belongs to.
           *
           * The row itself is marked too, but a row is one line in a list of
           * twenty and the heading above it may have scrolled away. Lighting
           * the name as well means the answer to "where am I" is legible
           * from the shape of the menu rather than from reading it.
           *
           * Matched on sessionId, the same key the row uses, so the two marks
           * can never disagree about which session is the one you are in.
           */
          const hasOpenSession = project.sessions.some(
            (s) => s.sessionId && s.sessionId === selectedSession,
          )
          /*
           * Two different things used to be called "active": the project whose
           * own page is on screen, and the project the open conversation
           * belongs to. Both light the block, because both answer the same
           * question — this is the branch you are looking into. What tells
           * them apart is which row inside lights up: the heading, or the
           * session.
           */
          const isPage = selectedProject === project.path
          const isHere = hasOpenSession || isPage
          const at = ordered.indexOf(project.path)
          return (
            <section
              key={project.path}
              className={`project ${isShut ? 'is-collapsed' : ''} ${isHere ? 'is-here' : ''} ${isPage ? 'is-page' : ''}`}
            >
              <div className="project-head">
                <button
                  className="chevron"
                  onClick={() => toggle(project.path)}
                  aria-expanded={!isShut}
                  title={isShut ? 'Expand' : 'Collapse'}
                >
                  <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
                    <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {renaming === project.path ? (
                  <ProjectNameEditor
                    project={project}
                    onCancel={() => setRenaming(null)}
                    onCommit={(name) => {
                      setRenaming(null)
                      // Unchanged is not a write. Saving it would work, but it
                      // would also broadcast the workspace to every client for
                      // nothing every time the field is opened and dismissed.
                      if ((name.trim() || null) !== project.label) onRenameProject(project.path, name)
                    }}
                  />
                ) : (
                  <button
                    className="project-name"
                    onClick={() => onSelectProject(project.path)}
                    onDoubleClick={() => project.saved && setRenaming(project.path)}
                    title={project.label ? `${project.label} — ${project.path}` : project.path}
                  >
                    <span className="project-label">{project.name}</span>
                    {!project.saved && <span className="ghost-tag" title="The deck is running a task here, but the folder is not in your workspace">live</span>}
                    {!project.exists && <span className="ghost-tag is-stale">missing</span>}
                    {/* Folded away, the count is the only clue to what is in there. */}
                    {isShut && project.sessions.length > 0 && (
                      <span className="folded-count">{project.sessions.length}</span>
                    )}
                  </button>
                )}
                {/*
                  Outside the name rather than inside it. In the name it was a
                  flex item taking 25px off the very heading you most want to
                  read, so a long name broke in half exactly on the project
                  that was asking for you.
                */}
                {project.waiting > 0 && <span className="badge">{project.waiting}</span>}
                <button
                  className="icon-btn"
                  title={`New task in ${project.name}`}
                  aria-label={`New task in ${project.name}`}
                  onClick={() => onNewTask(project.path)}
                >
                  +
                </button>
                {/*
                  Only saved folders get a menu. An unsaved project is one the
                  deck is driving a task in without the folder being in the
                  workspace: there is no position to move it to and nothing to
                  stop tracking, so the only item left would be the one already
                  on the row.
                */}
                {project.saved && (
                  <ProjectMenu
                    project={project}
                    canUp={at > 0}
                    canDown={at >= 0 && at < ordered.length - 1}
                    onNewTask={onNewTask}
                    onMove={onMoveProject}
                    onRemove={onRemoveFolder}
                    onRename={setRenaming}
                  />
                )}
              </div>

              {!isShut && (
                <div className="project-kids">
                  {/* The one line that always says where this actually is —
                      worth more once the heading above it may be a name of
                      your own choosing rather than the folder's. */}
                  <div className="project-path" title={project.path}>{shortPath(project.path)}</div>
                  {project.sessions.map((session) => (
                    <SessionRow
                      key={session.deckId || session.pid}
                      session={session}
                      projectNames={[project.name, project.folderName]}
                      active={session.sessionId === selectedSession}
                      onSelect={onSelectSession}
                    />
                  ))}
                  {project.sessions.length === 0 && <p className="project-empty">no sessions</p>}
                </div>
              )}
            </section>
          )
        })}

        {projects.length === 0 && (
          <p className="empty-side">
            Your workspace is empty. Add a folder to start launching work into it.
          </p>
        )}
      </nav>

      <footer className="sidebar-foot">
        <button className="btn btn-block btn-ghost" onClick={onBrowseFolders}>+ Add folder</button>
        <DefaultPermissions />
      </footer>
    </aside>
  )
}
