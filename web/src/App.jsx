import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDeck } from './useDeck.js'
import { STATUS_LABEL, relativeTime, shortPath, describeSubpath } from './format.js'
import Sidebar from './Sidebar.jsx'
import { readLocal, writeLocal } from './localKey.js'
import ProjectView from './ProjectView.jsx'
import Launcher from './Launcher.jsx'
import TeamLauncher from './TeamLauncher.jsx'
import FolderPicker from './FolderPicker.jsx'
import Subagents from './Subagents.jsx'
import LiveAgents from './LiveAgents.jsx'
import Message from './Message.jsx'
import TeamView from './TeamView.jsx'
import Room from './Room.jsx'
import PermissionCard from './PermissionCard.jsx'
import QuestionCard from './QuestionCard.jsx'
import AskToasts, { askKey } from './AskToasts.jsx'
import Composer from './Composer.jsx'
import Progress from './Progress.jsx'
import Inbox from './Inbox.jsx'
import Settings from './Settings.jsx'
import SessionControls from './SessionControls.jsx'
import Plans from './Plans.jsx'
import PickUp from './PickUp.jsx'
import ContextMeter from './ContextMeter.jsx'
import { HandoffButton, HandoffReady } from './Handoff.jsx'

function StatusDot({ status }) {
  return <span className={`dot dot-${status}`} aria-hidden="true" />
}

/**
 * A strip of text above the conversation: stopped-and-waiting, an error, a
 * mode the environment refused.
 *
 * On a phone these are clamped to two lines and open on a tap. They are worth
 * a glance and occasionally worth reading in full, but never worth a third of
 * the screen by default — which is what the untruncated three-line version of
 * the permissions notice was costing. Desktop has the room and shows them
 * whole, so there is nothing to open there.
 */
function Notice({ kind, children }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className={`${kind} ${open ? 'is-open' : ''}`}
      onClick={() => setOpen((o) => !o)}
      title={open ? undefined : 'Tap to read it all'}
    >
      {/* The clamp lives on this span rather than on the strip itself: the
          strip is a flex child of .stage, and -webkit-line-clamp does not
          survive being blockified — it left a third line half-showing under
          the fold instead of two lines and an ellipsis. */}
      <span className="notice-body">{children}</span>
    </div>
  )
}

/** All that is left of tool calls: knowing it is alive and what it is on. */
function Working({ tool }) {
  return (
    <div className="working">
      <span className="working-dots"><i /><i /><i /></span>
      working{tool ? <span className="working-tool">{tool}</span> : null}
    </div>
  )
}

/**
 * The session's name, editable in place — whether or not the deck started it.
 *
 * There are two names and this edits whichever one is real for the session in
 * front of you. A session the deck launched has the deck's own label. A
 * session found running in a terminal has the name Claude Code keeps for it,
 * the one its prompt box and its `/resume` picker show — writable from here
 * because it lives in the session's file, not in the terminal that owns the
 * process. Renaming a session you are only watching used to be the one thing
 * this box could not do.
 *
 * Blur commits rather than discards. Clicking away is how most people leave a
 * text field they have finished typing in, and losing the name to that is the
 * kind of small betrayal that makes you stop trusting the field. Escape is the
 * explicit way out. An empty box restores the derived name on the deck's own
 * label; on Claude Code's it leaves the name alone, because that one has no
 * empty state to restore to.
 */
function SessionName({ session, deck }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Enter and Escape both drop focus, so the blur that follows would commit a
  // second time — once deciding the outcome, it is decided.
  const settled = useRef(false)

  /*
   * A session with neither a deck label nor an id on disk is one the deck has
   * just launched and that has not registered yet. There is nothing to write
   * to for a few hundred milliseconds, and a box that silently does nothing
   * is worse than a name you cannot click yet.
   */
  const target = session.managed ? 'deck' : session.sessionId ? 'session' : null
  if (!target) return <span className="stage-name">{session.name}</span>

  function open() {
    setDraft(session.name || '')
    settled.current = false
    setEditing(true)
  }

  function commit() {
    if (settled.current) return
    settled.current = true
    setEditing(false)
    if (draft.trim() === (session.name || '').trim()) return
    if (target === 'deck') {
      deck.rename(session.deckId, draft)
      return
    }
    /*
     * Claude Code's own name for a session has no empty state, so clearing
     * this box cannot mean "go back to the derived name" the way it does for
     * the deck's label. It means "leave it as it was", which is the only
     * other honest reading of an empty box.
     */
    if (draft.trim()) deck.retitle(session.sessionId, draft)
  }

  function cancel() {
    settled.current = true
    setEditing(false)
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="stage-name is-editable"
        title={target === 'deck'
          ? 'Rename this session in the deck'
          : 'Rename this session — the name Claude Code shows in its prompt box and /resume'}
        onClick={open}
      >
        {session.name}
      </button>
    )
  }

  return (
    <input
      type="text"
      className="stage-name-edit"
      autoFocus
      maxLength={80}
      value={draft}
      placeholder={target === 'deck' ? 'Empty to go back to the task' : 'A name for this session'}
      aria-label="Session name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        if (e.key === 'Escape') { e.preventDefault(); cancel() }
      }}
    />
  )
}

function Conversation({ session, transcript, deck, modes, onOpenTeams, onStartFromHandoff }) {
  const endRef = useRef(null)
  const count = transcript.messages.length
  const working = session?.status === 'busy'
  const pending = session?.pending || null
  // Tool calls come in parallel, so more than one ask can be parked at once.
  // Answering the card on screen brings up the next one rather than releasing
  // the session, and saying so beats appearing to finish and then not.
  const parked = session?.pendingCount || 0
  const finished = session.status === 'done' || session.status === 'error'
  /*
   * Its conversation is on disk and nothing is running it. Deliberately not
   * folded into `finished`: a finished session is one there is no point typing
   * at, and this is the opposite — typing at it is the whole point, because
   * the message you send is what starts the process back up.
   */
  const detached = session.status === 'detached'
  /*
   * A past session nobody has taken charge of yet. It has a transcript and a
   * folder but no deckId, so there is nothing to send a message to until the
   * deck adopts it — which is what the Reopen button below does.
   *
   * `pid` is the important half of this condition. A session running in
   * somebody's terminal also has a transcript and a folder, and resuming that
   * one would put a second process on a conversation that is still being
   * written — two Claudes appending to the same file, neither aware of the
   * other. Only a session with nothing behind it can be picked up.
   */
  const adoptable = !session.managed && !!session.sessionId && !!session.cwd && !session.pid

  const [killing, setKilling] = useState(false)
  const [waking, setWaking] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [view, setView] = useState('chat')
  // Which subagent to open on arriving at the Agents tab from the live count.
  const [agentFocus, setAgentFocus] = useState(null)
  /*
   * On a phone the header is the whole screen's worth of chrome: the name, the
   * path, the branch, the mode chips and Kill together left about a fifth of a
   * 6" screen for the conversation itself. Folded shut, the header is one line
   * — name and state — and everything else is a tap away. Desktop has the room
   * and ignores this entirely.
   */
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [proposing, setProposing] = useState(false)
  // The context reading, shared with the Handoff button, and when that button
  // was last pressed — which is what the "Handoff ready" card looks after.
  const [contextPct, setContextPct] = useState(null)
  const [handoffAskedAt, setHandoffAskedAt] = useState(null)
  useEffect(() => { setHandoffAskedAt(null); setContextPct(null) }, [session.deckId])

  /*
   * A question and a permission come down the same channel and land in the
   * same slot, but they are not the same thing to answer: one wants a choice
   * out of the options it wrote, the other a yes or no. `questions` is the
   * only thing that tells them apart, and it is set by the server, not
   * guessed here.
   */
  const ask = !pending ? null : (
    <>
      {parked > 1 && (
        <p className="note ask-queue">
          {parked} asks are waiting. Answering this one brings up the next.
        </p>
      )}
      {/*
        Keyed by the ask, not by the session. With a queue behind it, answering
        one swaps the next straight into the same slot — and a card that keeps
        the "Allowing..." state of the ask you just answered is a card whose
        buttons are all disabled, which is the hang all over again.
      */}
      {pending.questions ? (
        <QuestionCard
          key={pending.requestId}
          pending={pending}
          onAnswer={(requestId, answers) => deck.answerQuestion(session.deckId, requestId, answers)}
        />
      ) : (
        <PermissionCard
          key={pending.requestId}
          pending={pending}
          onAnswer={(requestId, decision) => deck.answer(session.deckId, requestId, decision)}
        />
      )}
    </>
  )

  // Stick to the bottom to see the latest, which is what matters live.
  // Only while the chat is on screen: scrolling a pane nobody is looking at
  // would fight the map for the scroll position.
  useEffect(() => {
    if (view !== 'chat') return
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [count, working, pending?.requestId, transcript.sessionId, view])

  /*
   * Two sessions, two kills. One the deck launched and can unwind through the
   * SDK; one running in a terminal somewhere, where the only handle is the pid
   * it publishes and ending it is a signal, nothing gentler.
   *
   * The deck never kills the second kind on its own — not on restart, not on
   * shutdown, not when the panel loses sight of it. It happens here or not at
   * all, which is why the button is the only path and why it always asks.
   */
  const killable = !finished && (session.managed || !!session.pid)

  /**
   * Killing a session cannot be undone and cannot un-write what it already
   * wrote, so it asks first — and says what it does not do, because "kill"
   * invites the assumption that the edits so far are rolled back too.
   */
  async function kill() {
    const confirmed = window.confirm(
      detached
        ? `Let go of "${session.name}"?\n\n` +
          'Nothing is running, so nothing is killed. It leaves the panel and the ' +
          'deck stops offering to resume it. The conversation stays on disk and ' +
          'claude --resume can still reach it.'
        : `Kill "${session.name}"?\n\n` +
          (session.managed
            ? 'It stops right where it is and its process ends. Anything it already ' +
              'changed on disk stays changed, and the conversation is not resumed.'
            : `The deck did not start this one: ending it means killing process ${session.pid}, ` +
              'wherever it is running. It stops right where it is, anything it already changed ' +
              'on disk stays changed, and the terminal it was running in is left at a dead prompt. ' +
              'Its transcript is kept, so it can be resumed with claude --resume.')
    )
    if (!confirmed) return
    setKilling(true)
    const result = session.managed
      ? await deck.stop(session.deckId)
      : await deck.kill(session.pid, session.sessionId)
    setKilling(false)
    if (!result?.ok) window.alert(result?.error || 'Could not stop that session')
  }

  /**
   * Hand a past conversation back to the deck.
   *
   * Nothing needs to happen to the view afterwards. The adopted session comes
   * back over the socket carrying this same session id, and the pane resolves
   * a live session by id before it falls back to the read-only copy it was
   * showing — so the composer appears on its own.
   */
  async function resume() {
    setResuming(true)
    const result = await deck.reopen(session.sessionId, session.cwd, session.name)
    setResuming(false)
    if (!result?.ok) window.alert(result?.error || 'Could not reopen that session')
  }

  return (
    <main className="stage">
      {/*
        One row for what you touch, one thin strip for what you consult.

        This used to be two columns: a name on the left and, on the right, a
        tower of four stacked rows — state, tabs, time, permission strip, Kill
        — crammed into 235px of a header 1190px wide. Measured, it cost 172px
        of screen before a word of conversation, and the middle of that row
        was empty. The permission strip is what broke it: three labelled
        buttons do not fit in 235px, so they wrapped, and every wrap pushed
        the transcript another thirty pixels down.

        Nothing was removed. It was sorted: what changes the session is a chip
        on the row, what you only read is a 26px line under it.
      */}
      <header className={`stage-head ${detailsOpen ? 'show-detail' : ''}`}>
        <div className="stage-id">
          <h2>
            <StatusDot status={session.status} />
            {/* A name you gave it, or the first line of its task. Unnamed, it
                is a whole prompt: one line folded, three open — enough to tell
                two sessions apart without paying for it in screen the
                transcript needs. */}
            <SessionName session={session} deck={deck} />
            {session.managed && <span className="tag">deck</span>}
            {/* A tag set with `claude --tag`, or over the wire. The deck shows
                it; grouping the sidebar by it is not built yet. */}
            {session.tag && <span className="tag" title="Session tag">{session.tag}</span>}
          </h2>
        </div>
        {/* stage-views marks the one header whose controls need a row of their
            own on a phone: the inbox header also has a .stage-right, so the
            shape of the markup cannot tell them apart. */}
        <div className="stage-right stage-views">
          {/* Phone only — on desktop the details are never folded. */}
          <button
            type="button"
            className="stage-more"
            aria-expanded={detailsOpen}
            aria-controls="stage-detail"
            aria-label={
              detailsOpen
                ? 'Hide session details'
                : `Show session details${session.agents?.length ? ` (${session.agents.length} subagents running)` : ''}`
            }
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {/* Folded, the tabs are out of sight and the live count with
                them; this is the one place left to say work is in flight. */}
            {!detailsOpen && session.agents?.length > 0 && (
              <span className="live-folded" aria-hidden="true">{session.agents.length}</span>
            )}
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/*
            Two ways of watching the same session: what it is saying, and
            what it delegated. A toggle rather than a split pane — at this
            width, half of each would be neither.
          */}
          <div className="seg" role="tablist" aria-label="How to watch this session">
            {[
              { id: 'chat', label: 'Chat', hint: 'What it is saying' },
              { id: 'agents', label: 'Agents', hint: 'What its subagents said' },
            ].map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={view === tab.id}
                className={view === tab.id ? 'is-on' : ''}
                onClick={() => setView(tab.id)}
                title={tab.hint}
              >
                {tab.label}
              </button>
            ))}
            {/* Beside the tab it belongs to, not inside it: a button cannot
                hold another, and the count opens its own list. */}
            <LiveAgents
              agents={session.agents}
              onOpen={(toolUseId) => {
                setAgentFocus(toolUseId ? { toolUseId, at: Date.now() } : null)
                setView('agents')
              }}
            />
          </div>

          {/*
            What this session runs on, how hard it thinks, and what it may do
            without asking. Changing any of them mid-task is the point: you
            stop being asked, or start thinking harder, without throwing away
            the work already in flight.
          */}
          {session.managed && !finished && (
            /*
              `granted` comes off the transcript rather than out of the session
              list, because the session's own startup message carries neither
              the effort nor the advisor. It is read from the turns the session
              has already taken, which is the only place either one is written
              down.
            */
            <SessionControls
              session={session}
              deck={deck}
              modes={modes}
              granted={transcript.granted}
            />
          )}


          {/*
            The other thing an analysis ends in. The roadmap button turns a
            written plan into milestones this repository can run; this one asks
            the session who should run them — which it can answer and a form
            cannot, because the answer is in the conversation beside it.

            Only for sessions the deck drives: this is a message into that
            conversation, and there is nothing to send one to otherwise.

          {/*
            What an analysis ends in. This asks the session who should do the
            work — which it can answer and a form cannot, because the answer is
            in the conversation beside it.

            Only for sessions the deck drives: this is a message into that
            conversation, and there is nothing to send one to otherwise.
          */}
          {session.managed && !finished && (
            <button
              className="ctl"
              disabled={proposing}
              onClick={async () => {
                setProposing(true)
                const response = await fetch('/api/team-proposal', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ deckId: session.deckId }),
                })
                const result = await response.json().catch(() => ({ ok: false }))
                setProposing(false)
                if (result.ok) onOpenTeams()
                else window.alert(result.error || 'Could not ask for a team')
              }}
              title="Ask this session which team the work needs, based on what it already knows"
            >
              {proposing ? 'Asking...' : 'Propose a team'}
            </button>
          )}

          {/*
            Write down where the work stands, for the next session. It is the
            skill, sent as a message — so it waits its turn like anything you
            type, and works the same from a terminal.
          */}
          {session.managed && !finished && (
            <HandoffButton
              pct={contextPct}
              disabled={Boolean(pending)}
              onClick={async () => {
                const result = await deck.say(session.deckId, '/handoff')
                if (result?.ok === false) window.alert(result.error || 'Could not ask for a handoff')
                else setHandoffAskedAt(Date.now())
              }}
            />
          )}

          {/*
            Nothing is running it, and the conversation is on disk. Typing at
            it has always brought it back — but that makes you think of
            something to say in order to say nothing. This is the same wake,
            without the message: it reopens the conversation under the same id
            and stops there, ready.
          */}
          {detached && session.managed && (
            <button
              className="ctl ctl-go"
              disabled={waking}
              title="Start its process again, where it left off. Nothing is sent, so nothing is spent — it just comes back ready."
              onClick={async () => {
                setWaking(true)
                const result = await deck.wake(session.deckId)
                setWaking(false)
                if (!result?.ok) window.alert(result?.error || 'Could not wake this session')
              }}
            >
              {waking ? 'Waking...' : 'Wake'}
            </button>
          )}

          {/* A session the deck started is unwound; one it did not is
              signalled by pid. Both end the process, and both ask first. */}
          {killable && (
            <button
              className="ctl ctl-danger"
              onClick={kill}
              disabled={killing}
              title={session.managed
                ? 'Stop this session and end its process'
                : `End this session's process (pid ${session.pid}) — it was not started from the deck`}
            >
              {killing ? 'Killing...' : 'Kill'}
            </button>
          )}
        </div>
      </header>

      {/*
        The line you consult. Everything here is read, never clicked, which
        is the whole basis of the split: it can be quiet, small, and last.
      */}
      <div className="stage-detail" id="stage-detail">
        <span className="stage-path">{shortPath(session.cwd)}</span>
        {describeSubpath(session) && <span className="where">{describeSubpath(session)}</span>}
        {transcript.meta?.gitBranch && <span className="branch">{transcript.meta.gitBranch}</span>}
        {/* Nothing breaks when the context fills — the conversation gets
            summarised and carries on — so it belongs with what you consult
            rather than with what you act on. */}
        <ContextMeter session={session} deck={deck} working={working} onReading={setContextPct} />
        <span className="stage-time">{relativeTime(session.startedAt)}</span>
        {/* The one thing on this line that is not merely informative: a
            session blocked on you is something to go and do. */}
        <span className={`state state-${session.status}`}>
          {session.status === 'waiting'
            ? session.waitingFor || 'needs you'
            : STATUS_LABEL[session.status] || session.status}
        </span>
      </div>

      {/* A terminal session's prompt lives on its TTY: we can only point at it. */}
      {session.status === 'waiting' && !session.managed && (
        <Notice kind="waiting-banner">
          Stopped, waiting on your answer
          {session.waitingFor ? ` (${session.waitingFor})` : ''} — reply in its terminal. Only
          sessions started from the deck can be answered here.
        </Notice>
      )}

      {session.error && <Notice kind="waiting-banner">{session.error}</Notice>}

      {/*
        The refused-mode notice used to be a banner across the pane, forty
        pixels of permanent height saying a sentence the permissions chip now
        says in amber — with the sentence itself one click away, inside the
        menu you would open to change it. A warning that repeats what is
        already on screen is a warning you stop reading.
      */}

      {view === 'agents' && (
        <Subagents
          // Remount on a session change: the open conversation, the list and
          // the in-flight fetch all belong to the session that was showing.
          key={transcript.sessionId || session.deckId || 'none'}
          sessionId={session.sessionId}
          focus={agentFocus}
          live={session.agents}
        />
      )}

      {/* A question waiting on you outranks whichever view you chose. */}
      {view !== 'chat' && pending && (
        <div className="view-permission">{ask}</div>
      )}

      <div className="transcript" hidden={view !== 'chat'}>
        {transcript.loading && <p className="note">Loading...</p>}
        {transcript.missing && !session.managed && <p className="note">This session hasn't written anything yet.</p>}
        {/* The reader keeps the last 60 messages. Saying so is the difference
            between an old conversation and a conversation with a hole in it. */}
        {transcript.total > transcript.messages.length && (
          <p className="note">
            Showing the last {transcript.messages.length} of {transcript.total} messages.
          </p>
        )}
        {transcript.messages.map((message, i) => (
          <Message key={message.uuid || i} message={message} />
        ))}
        {working && !pending && <Working tool={transcript.activity} />}
        {ask}
        <div ref={endRef} />
      </div>

      {/*
        A conversation the deck is not driving. Adopting it is what puts a
        composer under it — and nothing is spawned by pressing this: the deck
        takes charge of the session, and the first message you send is what
        actually starts a process.
      */}
      {adoptable && (
        <div className="resume-bar">
          <p className="note">
            Nothing is running this one. Reopening hands it back to the deck, with
            everything it already knows, under the same session id.
          </p>
          <button className="btn btn-slim" disabled={resuming} onClick={resume}>
            {resuming ? 'Reopening...' : 'Reopen here'}
          </button>
        </div>
      )}

      {session.managed && (
        <>
          {/* Said once, above the box, because an enabled composer on a session
              with no process behind it otherwise looks like the same thing as
              any other — and the first message costs a little more than usual,
              since it reloads the conversation before answering. */}
          {detached && (
            <p className="note resume-hint">
              Nothing is running. Your next message starts it back up where it left off.
            </p>
          )}
          {/* The session's own checklist, between the hint and the box. It
              draws nothing until the session has sent one, so on a short task
              this row does not exist. */}
          {handoffAskedAt && (
            <HandoffReady
              cwd={session.cwd}
              askedAt={handoffAskedAt}
              working={working}
              onStart={(note) => { setHandoffAskedAt(null); onStartFromHandoff(note) }}
              onDismiss={() => setHandoffAskedAt(null)}
            />
          )}
          <Progress todos={session.todos} onClear={() => deck.clearTodos(session.deckId)} />
          <Composer
            disabled={finished}
            busy={working}
            blocked={Boolean(pending)}
            onSend={(text, images, files) => deck.say(session.deckId, text, images, files)}
            onInterrupt={() => deck.interrupt(session.deckId)}
          />
        </>
      )}
    </main>
  )
}

export default function App() {
  const deck = useDeck()
  const { sessions, projects, transcript, select, selected, connected } = deck

  // The bottom bar carries the same two counts the sidebar shows.
  const waitingTotal = projects.reduce((sum, p) => sum + p.waiting, 0)
  const sessionTotal = projects.reduce((sum, p) => sum + p.sessions.length, 0)

  // The main pane shows either a conversation or a project, never both.
  const [view, setView] = useState({ kind: 'none' })
  const [teamOpen, setTeamOpen] = useState(false)
  const [teamDraft, setTeamDraft] = useState(null)

  // On a phone the sidebar is a drawer over the content rather than a column
  // beside it. Desktop ignores this: there the sidebar is always in the grid.
  const [menuOpen, setMenuOpen] = useState(false)
  /*
   * Which side the projects menu sits on. Per browser, like the folded
   * projects: it is about the screen in front of you, and a phone, where the
   * menu is a drawer, has no say in it.
   */
  const [sideRight, setSideRight] = useState(() => readLocal('deck.sidebar.side') === 'right')
  const flipSide = () => {
    writeLocal('deck.sidebar.side', sideRight ? 'left' : 'right')
    setSideRight(!sideRight)
  }
  const closeMenu = useCallback(() => setMenuOpen(false), [])

  // Every navigation closes the drawer: on a phone you picked what to look at,
  // so leaving the menu covering it is never what you wanted.
  const nav = useCallback((fn) => (...args) => {
    setMenuOpen(false)
    return fn(...args)
  }, [])
  const [launcherFor, setLauncherFor] = useState(null)
  // A handoff note to have chosen already when the launcher opens.
  const [launchNote, setLaunchNote] = useState(null)
  const [picking, setPicking] = useState(false)
  const [modes, setModes] = useState([])

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => setModes(data.modes || []))
      .catch(() => setModes([]))
  }, [])

  const session = useMemo(() => {
    if (view.kind !== 'session') return null
    return (
      sessions.find((s) => s.sessionId && s.sessionId === selected) ||
      sessions.find((s) => s.deckId && s.deckId === view.deckId) ||
      /*
       * One opened from a project's history. Nothing in the live registry
       * describes it any more — that is what "history" means — but the
       * transcript is still on disk and the socket streams it by id alone.
       *
       * `done` is doing real work here rather than decorating: the pane hides
       * the composer, the permission mode and the kill button for a finished
       * session, which is exactly the read-only view a past conversation
       * should get. Offering to type into it would be offering something that
       * cannot happen.
       */
      view.past ||
      null
    )
  }, [sessions, selected, view])

  const project = useMemo(() => {
    if (view.kind !== 'project') return null
    return projects.find((p) => p.path === view.path) || { path: view.path, name: view.path.split('/').pop(), saved: false }
  }, [projects, view])

  const openSession = useCallback((target) => {
    setView({ kind: 'session', deckId: target.deckId || null })
    select(target.sessionId || null)
  }, [select])

  const openProject = useCallback((path) => setView({ kind: 'project', path }), [])

  const openPastSession = useCallback((row) => {
    setView({
      kind: 'session',
      deckId: null,
      past: {
        sessionId: row.sessionId,
        name: row.title || 'past session',
        cwd: row.cwd || '',
        startedAt: row.startedAt,
        status: 'done',
        managed: false,
      },
    })
    select(row.sessionId)
  }, [select])

  // A managed session registers its id late; open its transcript when it does.
  const openedFor = useRef(null)
  useEffect(() => {
    if (!session?.sessionId || session.sessionId === selected) return
    if (openedFor.current === session.sessionId) return
    openedFor.current = session.sessionId
    select(session.sessionId)
  }, [session, selected, select])

  // Deliberately no auto-jump into a session on load: the queue already
  // says what is waiting, and being thrown into one conversation hides the
  // other five things that also needed you.

  async function addFolder(path) {
    const response = await fetch('/api/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    const result = await response.json()
    if (result.ok) openProject(result.path)
    return result
  }

  /**
   * Move a project one place in the sidebar.
   *
   * Nothing is done to the view afterwards, and nothing needs to be: the
   * server broadcasts the workspace after writing it, so the menu redraws
   * from the same push that every other panel gets. Reordering on your phone
   * moves the desktop's menu too, which is right — it is one workspace.
   */
  async function moveProject(path, direction) {
    const response = await fetch('/api/workspace', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, direction }),
    })
    const result = await response.json().catch(() => ({ ok: false }))
    // Failing here is a write that did not happen — a read-only home
    // directory, say. Silence would leave the menu looking stuck.
    if (!result.ok) window.alert(result.error || 'Could not save the new order')
  }

  /**
   * Name a project something other than its folder.
   *
   * Same PATCH and same silence on success as a move, for the same reason: the
   * server broadcasts the workspace after writing, so the heading, the project
   * page and any other device all redraw from one push rather than from this
   * function guessing at the new state.
   */
  async function renameProject(path, name) {
    const response = await fetch('/api/workspace', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, name }),
    })
    const result = await response.json().catch(() => ({ ok: false }))
    if (!result.ok) window.alert(result.error || 'Could not save that name')
  }

  /**
   * Drop a folder from the workspace. The folder on disk is untouched and any
   * session running in it keeps running — it only stops being tracked here.
   *
   * The confirmation says exactly that, because "Remove" next to a folder name
   * reads like "delete my code" to anyone who has not read the source.
   */
  async function removeFolder(path) {
    const name = projects.find((p) => p.path === path)?.name || path.split('/').pop()
    const confirmed = window.confirm(
      `Stop tracking "${name}"?\n\n` +
      'It leaves your workspace in session-deck. The folder stays on disk, ' +
      'nothing is deleted, and any session running in it keeps running. ' +
      'You can add it back at any time.'
    )
    if (!confirmed) return

    const response = await fetch('/api/workspace', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    const result = await response.json().catch(() => ({ ok: false }))
    if (!result.ok) {
      window.alert(result.error || 'Could not remove that folder')
      return
    }
    // Only the view that was showing the removed project needs to move.
    setView((current) => (current.kind === 'project' && current.path === path ? { kind: 'none' } : current))
  }

  return (
    <div className={`app${menuOpen ? ' menu-open' : ''}${sideRight ? ' side-right' : ''}`}>
      {/* Phone-only bar: the only way back to the menu once it slides away. */}
      <div className="topbar">
        <button
          className="menu-btn"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
          aria-controls="deck-menu"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <span className="topbar-title">session-deck</span>
        <span className={`link ${connected ? 'ok' : 'off'}`} title={connected ? 'connected' : 'reconnecting'} />
      </div>

      {/* Tapping anything outside the drawer dismisses it. */}
      <div className="scrim" onClick={closeMenu} aria-hidden="true" />

      <Sidebar
        open={menuOpen}
        sideRight={sideRight}
        onFlipSide={flipSide}
        onClose={closeMenu}
        projects={projects}
        selectedSession={view.kind === 'session' ? selected : null}
        selectedProject={view.kind === 'project' ? view.path : null}
        onSelectSession={nav(openSession)}
        onSelectProject={nav(openProject)}
        onOpenInbox={nav(() => setView({ kind: 'inbox' }))}
        inboxActive={view.kind === 'inbox' || view.kind === 'none'}
        onOpenSettings={nav(() => setView({ kind: 'settings' }))}
        settingsActive={view.kind === 'settings'}
        onOpenRoom={nav(() => setView({ kind: 'room' }))}
        onOpenPlans={nav(() => setView({ kind: 'plans' }))}
        plansActive={view.kind === 'plans'}
        onOpenPickUp={nav(() => setView({ kind: 'pickup' }))}
        pickUpActive={view.kind === 'pickup'}
        roomActive={view.kind === 'room'}
        connected={connected}
        onNewTask={nav((path) => setLauncherFor(path))}
        onBrowseFolders={nav(() => setPicking(true))}
        onRemoveFolder={removeFolder}
        onMoveProject={moveProject}
        onRenameProject={renameProject}
        onOpenTeam={nav(() => setView({ kind: 'team' }))}
        teamActive={view.kind === 'team'}
      />

      {view.kind === 'session' && session && (
        <Conversation
          session={session}
          transcript={transcript}
          deck={deck}
          modes={modes}
          onOpenTeams={() => setView({ kind: 'team' })}
          onStartFromHandoff={(note) => { setLaunchNote(note.file); setLauncherFor(note.checkout) }}
        />
      )}
      {view.kind === 'project' && project && (
        <ProjectView
          project={project}
          onNewTask={(path) => setLauncherFor(path)}
          onOpenSession={openSession}
          onOpenPastSession={openPastSession}
          onRemove={removeFolder}
        />
      )}
      {view.kind === 'settings' && <Settings />}
      {view.kind === 'team' && (
        <TeamView
          teamId={view.teamId || null}
          deck={deck}
          onOpenSession={openSession}
          onOpenTeam={(id) => setView({ kind: 'team', teamId: id || null })}
          /* Raising a team belongs on the screen where you watch one, not in a
             menu beside it: it is the thing you do once before living here. */
          onNewTeam={() => { setTeamDraft(null); setTeamOpen(true) }}
          onCompose={(draft) => { setTeamDraft(draft); setTeamOpen(true) }}
        />
      )}
      {view.kind === 'room' && <Room onOpenSession={openSession} />}
      {view.kind === 'plans' && <Plans onOpenProject={openProject} />}
      {view.kind === 'pickup' && <PickUp onOpenProject={openProject} />}
      {(view.kind === 'inbox' || view.kind === 'none' || (view.kind === 'session' && !session)) && (
        <Inbox
          sessions={sessions}
          deck={deck}
          onOpenSession={openSession}
          onOpenProject={openProject}
        />
      )}

      {/*
        Phone navigation lives at the bottom, where the thumb already is.
        The drawer keeps the project tree — a hierarchy, not a destination —
        and these are the four places you actually move between.
      */}
      {/*
        Over everything, and outside every view on purpose: an ask blocked in
        one session has to be answerable from whichever other one you happen
        to be reading. The session already on screen is left out — its own
        card is right there in the conversation, and two copies of the same
        buttons is a way to wonder which one you pressed.
      */}
      <AskToasts
        sessions={sessions}
        deck={deck}
        hideFor={view.kind === 'session' ? askKey(session) : null}
        /* "What needs you" is the queue of exactly these asks, with the same
           buttons on them. Floating a second copy over the first is not
           urgency, it is double vision. A team is the same case seen from the
           other side: every session that could be asking has a card on
           screen, and the ask is drawn inside it. */
        silent={['inbox', 'none', 'team'].includes(view.kind)}
        onOpenSession={nav(openSession)}
        onOpenInbox={nav(() => setView({ kind: 'inbox' }))}
      />

      <nav className="tabbar" aria-label="Sections">
        <button
          className={menuOpen ? 'is-on' : ''}
          onClick={() => setMenuOpen((o) => !o)}
          aria-expanded={menuOpen}
          aria-controls="deck-menu"
        >
          <svg viewBox="0 0 20 20" width="21" height="21" aria-hidden="true">
            <path d="M2.5 5.5a1 1 0 0 1 1-1h3.2l1.5 1.8h8.3a1 1 0 0 1 1 1v8.2a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"
              fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          Projects
        </button>

        <button
          className={view.kind === 'inbox' || view.kind === 'none' ? 'is-on' : ''}
          onClick={nav(() => setView({ kind: 'inbox' }))}
        >
          <svg viewBox="0 0 20 20" width="21" height="21" aria-hidden="true">
            <path d="M2.5 12.5h4l1.5 2.5h4l1.5-2.5h4M2.5 12.5 4.8 5h10.4l2.3 7.5v3a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"
              fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          Needs you
          {waitingTotal > 0 && <span className="tab-dot">{waitingTotal}</span>}
        </button>

        {/*
          This slot was "Agents": every running session as a grid of live file
          maps, ordered by whichever was busiest. The teams screen answers the
          same question — what is everything doing — with the arrangement you
          declared rather than one worked out from who touched most files, so
          the grid went and the slot stays.

          The drawer had the only way to a team, which on a phone is two taps
          and a scroll to reach the screen you live on.
        */}
        {sessionTotal > 0 && (
          <button
            className={view.kind === 'team' ? 'is-on' : ''}
            onClick={nav(() => setView({ kind: 'team' }))}
          >
            <svg viewBox="0 0 20 20" width="21" height="21" aria-hidden="true">
              <circle cx="10" cy="10" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="4.5" cy="5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="15.5" cy="5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="10" cy="16.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8.6 8.3 5.7 6.2M11.4 8.3l2.9-2.1M10 12.2v2.5"
                fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            Team
          </button>
        )}

        <button
          className={view.kind === 'settings' ? 'is-on' : ''}
          onClick={nav(() => setView({ kind: 'settings' }))}
        >
          <svg viewBox="0 0 20 20" width="21" height="21" aria-hidden="true">
            <circle cx="10" cy="10" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4M15.2 15.2l-1.4-1.4M6.2 6.2 4.8 4.8"
              fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Settings
        </button>
      </nav>

      <FolderPicker
        open={picking}
        onClose={() => setPicking(false)}
        onAdd={addFolder}
        // Folders already tracked are shown as such rather than offered and
        // then refused: the picker knows, so it should say so before you click.
        known={projects.filter((p) => p.saved).map((p) => p.path)}
      />

      <TeamLauncher
        open={teamOpen}
        projects={deck.projects}
        sessions={deck.sessions}
        draft={teamDraft}
        onClose={() => { setTeamOpen(false); setTeamDraft(null) }}
        /*
          The results come back here rather than being swallowed: a team where
          three came up and one did not is three sessions running, and the
          modal has to be able to say which is which.
        */
        onRaise={(options) => deck.team(options)}
      />

      <Launcher
        open={Boolean(launcherFor)}
        fixedCwd={launcherFor}
        /*
         * Every session that is alive right now, so the launcher can offer
         * the new one somebody to ask. It filters and groups them itself;
         * what it needs from here is the same list the sidebar draws.
         */
        sessions={deck.sessions}
        preselectNote={launchNote}
        onStopSession={(deckId) => deck.stop(deckId)}
        onClose={() => { setLauncherFor(null); setLaunchNote(null) }}
        onLaunch={async (options) => {
          const result = await deck.launch(options)
          if (result?.ok) setView({ kind: 'session', deckId: result.deckId })
          return result
        }}
      />
    </div>
  )
}
