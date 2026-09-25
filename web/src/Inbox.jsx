import { useCallback, useEffect, useState } from 'react'
import { readLocal, writeLocal } from './localKey.js'
import PermissionCard from './PermissionCard.jsx'

/**
 * The triage queue: one list of everything waiting on you, across every
 * project, ordered by how much it is actually holding up.
 *
 * The rest of the deck is organised by where things live. This is organised
 * by whether they need you, which is the question you open the panel to ask.
 */
const GROUPS = [
  { key: 'blocked', title: 'Blocked on you', hint: 'A session has stopped and is waiting' },
  { key: 'broken', title: 'Broken', hint: 'Checks are failing, or the branch will not merge' },
  { key: 'risk', title: 'Only on this machine', hint: 'Work that is not committed or not pushed anywhere' },
  { key: 'ready', title: 'Ready to move', hint: 'Green and waiting on a look, or on a merge' },
  { key: 'idle', title: 'Forgotten', hint: 'Sessions nobody has touched in a while' },
  { key: 'cleanup', title: 'Can be tidied', hint: 'Finished work still taking up space' },
]

const MINE_KEY = 'session-deck.inbox-mine'

/**
 * Whether the queue is narrowed to your own pull requests.
 *
 * localStorage, like the folded projects: a per-viewer convenience nobody
 * else needs, read through localKey.js so a preference set before the rename
 * carries over instead of quietly resetting.
 */
function loadMineOnly() {
  return readLocal(MINE_KEY) === '1'
}

function saveMineOnly(value) {
  writeLocal(MINE_KEY, value ? '1' : '0')
}

/**
 * One queue row.
 *
 * Pulled out of the list because a row with an ask attached is wrapped in
 * something, and a row without one is not — inlining both shapes made the map
 * below unreadable.
 */
function Row({ item, label, onAct }) {
  return (
    <button className={`inbox-row is-${item.severity}`} onClick={onAct}>
      <span className="inbox-main">
        <span className="inbox-title">{item.title}</span>
        {item.detail && <span className="inbox-detail">{item.detail}</span>}
      </span>
      <span className="inbox-side">
        {item.note && <span className="inbox-note">{item.note}</span>}
        {/* Only worth the space when it is not you: in the Mine
            view every row would carry the same name. */}
        {item.isPr && item.author && item.mine === false && (
          <span className="inbox-author">@{item.author}</span>
        )}
        {/* One queue, ordered by urgency — but a pull request you
            open in Azure DevOps is a different trip from one on
            GitHub, and the row should say so before you click. */}
        {item.forge === 'ado' && <span className="inbox-forge">ADO</span>}
        <span className="inbox-project">{item.project}</span>
        <span className="inbox-action">{label}</span>
      </span>
    </button>
  )
}

export default function Inbox({ onOpenSession, onOpenProject, sessions, deck }) {
  const [inbox, setInbox] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [mineOnly, setMineOnly] = useState(loadMineOnly)

  const load = useCallback((refresh) => {
    setLoading(true)
    fetch(`/api/inbox${refresh ? '?refresh=1' : ''}`)
      .then((r) => r.json())
      .then((data) => { setInbox(data); setError(null) })
      .catch(() => setError('Could not build the queue'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(false) }, [load])

  // Blocked sessions come from the live socket, so a permission appearing
  // while you are looking at this screen should not need a manual refresh.
  const blockedNow = sessions.filter((s) => s.status === 'waiting').length
  useEffect(() => { load(false) }, [blockedNow, load])

  function act(item) {
    if (item.action?.type === 'session') {
      onOpenSession({ sessionId: item.action.sessionId, deckId: item.action.deckId })
    } else if (item.action?.type === 'project') {
      onOpenProject(item.action.path)
    } else if (item.action?.type === 'url') {
      window.open(item.action.url, '_blank', 'noreferrer')
    }
  }

  function chooseMine(value) {
    setMineOnly(value)
    saveMineOnly(value)
  }

  /**
   * The ask this row can be answered with, without leaving the queue.
   *
   * Two things are deliberately excluded. A session the deck did not launch
   * has no `deckId` and its prompt lives on its own TTY, so there is nothing
   * to press here. And a question — `AskUserQuestion` — is a decision, not a
   * permission: it is asked because the options need weighing, and weighing
   * them means reading the conversation the question came out of. Those keep
   * sending you to the session, which is the right amount of friction.
   *
   * The ask is read from the live session list, not from the row. The queue
   * arrives over HTTP and is a snapshot; `pending` arrives over the socket and
   * is the truth. Answering the ask a stale row remembered would be answering
   * a question the session has moved on from.
   */
  function inlineAsk(item) {
    if (item.severity !== 'blocked') return null
    const deckId = item.action?.deckId
    if (!deckId) return null
    const pending = sessions.find((s) => s.deckId === deckId)?.pending
    if (!pending || pending.questions) return null
    return { deckId, pending }
  }

  const all = inbox?.items || []
  const problems = inbox?.problems || []

  // The filter is only offered when it can be answered. With nothing signed
  // in, every `mine` is null — showing the control then would let you pick
  // "Mine" and get an empty screen with no explanation.
  const viewers = inbox?.viewers || []
  const canFilter = viewers.length > 0 && all.some((i) => i.isPr)
  const filtering = mineOnly && canFilter

  // Narrowed to pull requests on purpose. A blocked session or unpushed work
  // is yours by definition, and hiding it behind an author filter would be a
  // way to lose it.
  const items = filtering ? all.filter((i) => !i.isPr || i.mine) : all
  const total = items.length
  const hidden = all.length - total

  // When the list is empty the card below explains the filter in full, so the
  // subtitle does not repeat it.
  let summary
  if (loading && !inbox) summary = 'checking...'
  else if (total === 0) summary = hidden > 0 ? 'Nothing of yours is waiting' : 'Nothing is waiting'
  else summary = hidden > 0
    ? `${total} across your workspace · ${hidden} from other people hidden`
    : `${total} across your workspace`

  return (
    <main className="stage">
      <header className="stage-head">
        <div>
          <h2>What needs you</h2>
          <p className="stage-sub">{summary}</p>
        </div>
        <div className="stage-right project-actions">
          {canFilter && (
            <div className="seg" role="group" aria-label="Whose pull requests to show">
              <button
                className={`seg-btn${mineOnly ? '' : ' is-on'}`}
                aria-pressed={!mineOnly}
                onClick={() => chooseMine(false)}
              >
                Everyone
              </button>
              <button
                className={`seg-btn${mineOnly ? ' is-on' : ''}`}
                aria-pressed={mineOnly}
                onClick={() => chooseMine(true)}
                title={`Only pull requests opened by ${viewers.join(', ')}`}
              >
                Mine
              </button>
            </div>
          )}
          <button className="btn" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Checking...' : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="transcript">
        {error && <p className="note">{error}</p>}
        {!error && !inbox && <p className="note">Reading git and pull requests across your projects...</p>}

        {/* Not queue rows. These say the panel could not see something, which
            you need to know precisely because the queue below looks calm. */}
        {problems.length > 0 && (
          <div className="inbox-problems">
            <h4>Could not check {problems.length === 1 ? 'one place' : `${problems.length} places`}</h4>
            {problems.map((p) => (
              <p key={p.message}>
                {p.message}
                {p.hint && <code>{p.hint}</code>}
              </p>
            ))}
          </div>
        )}

        {/* "All clear" would be a claim, not a summary, while something above
            says a forge could not be reached. */}
        {inbox && total === 0 && problems.length === 0 && (
          <div className="inbox-clear">
            <h3>All clear</h3>
            {hidden > 0 ? (
              <p>
                Nothing of yours is waiting. {hidden === 1 ? 'One item belongs' : `${hidden} items belong`} to
                someone else — switch to Everyone to see {hidden === 1 ? 'it' : 'them'}.
              </p>
            ) : (
              <p>No sessions blocked, nothing unpushed, no pull requests waiting.</p>
            )}
          </div>
        )}

        {GROUPS.map((group) => {
          const rows = items.filter((i) => i.severity === group.key)
          if (rows.length === 0) return null
          return (
            <section className="panel-block" key={group.key}>
              <h3>
                {group.title} <span className="count">{rows.length}</span>
                <span className="group-hint">{group.hint}</span>
              </h3>
              {rows.map((item) => {
                const ask = inlineAsk(item)
                if (!ask) {
                  return (
                    <Row
                      key={item.id}
                      item={item}
                      label={item.action?.label || 'Open'}
                      onAct={() => act(item)}
                    />
                  )
                }
                return (
                  <div className="inbox-answerable" key={item.id}>
                    {/* "Answer" would be a lie next to the buttons that
                        actually answer it. The row still goes to the session,
                        for when you want to see what led here first. */}
                    <Row item={item} label="Open" onAct={() => act(item)} />
                    {/*
                      Keyed by the ask. A session can have several parked at
                      once, and answering one swaps the next straight into this
                      slot — a card still holding "Allowing..." from the ask you
                      just answered is a card with every button disabled.
                    */}
                    <PermissionCard
                      key={ask.pending.requestId}
                      pending={ask.pending}
                      onAnswer={(requestId, decision) => deck.answer(ask.deckId, requestId, decision)}
                    />
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </main>
  )
}
