import { useCallback, useEffect, useRef, useState } from 'react'
import Message from './Message.jsx'

/**
 * Subagents — what the workers said, not just that they exist.
 *
 * This view used to be impossible and the README said so: a subagent's
 * messages are not written into its parent's transcript, so the deck could
 * report which were running and what each had been asked to do, and nothing
 * more. They were never missing, though — each one keeps its own transcript
 * beside its parent's, and the SDK reads it by id.
 *
 * The shape follows what you actually want from it: the list is the question
 * "who is working", and one conversation at a time is the question "what is
 * it finding". Two panes side by side at this width would be neither.
 */

/** In a delegated conversation, 'user' is the parent session, not you. */
const AGENT_ROLES = { user: 'task', assistant: 'agent', system: 'summary' }

/** How often the list re-reads while something in it is still running. */
const POLL_MS = 3000

function agentLabel(agent) {
  return agent.description || agent.type || agent.agentId
}

export default function Subagents({ sessionId, focus, live }) {
  const [list, setList] = useState(null)
  const [error, setError] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [convo, setConvo] = useState(null)
  const [loading, setLoading] = useState(false)
  // Which agent the in-flight conversation belongs to, so a slow answer for
  // one you have already clicked away from cannot land in the pane.
  const wanted = useRef(null)

  const loadList = useCallback(() => {
    if (!sessionId) return
    fetch(`/api/subagents/${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.sessionId !== sessionId) return
        setList(data.subagents || [])
        setError(null)
      })
      .catch(() => setError('Could not read this session’s subagents'))
  }, [sessionId])

  const loadConvo = useCallback((agentId) => {
    wanted.current = agentId
    setLoading(true)
    fetch(`/api/subagent/${encodeURIComponent(sessionId)}/${encodeURIComponent(agentId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (wanted.current !== agentId) return
        setConvo(data)
        setLoading(false)
      })
      .catch(() => {
        if (wanted.current !== agentId) return
        setConvo(null)
        setLoading(false)
      })
  }, [sessionId])

  // A new session is a new list, and whatever was open belonged to the old one.
  useEffect(() => {
    setList(null)
    setOpenId(null)
    setConvo(null)
    wanted.current = null
    loadList()
  }, [sessionId, loadList])

  /*
   * Poll only while there is something to see change. A session whose
   * subagents have all finished is a fixed list of fixed transcripts, and
   * re-reading it on a timer would cost real work on the server for a view
   * that cannot move.
   */
  /*
   * The transcript calls a background agent finished the moment it is sent
   * away — its tool call returns at once with a placeholder. A session the
   * deck drives knows better from its own stream, so where that says an
   * agent is still up, it is.
   */
  const liveIds = new Set((live || []).map((a) => a.toolUseId).filter(Boolean))
  const isRunning = (a) => a.running || (a.toolUseId != null && liveIds.has(a.toolUseId))
  const running = (list || []).some(isRunning)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      loadList()
      if (openId && (list || []).find((a) => a.agentId === openId && isRunning(a))) loadConvo(openId)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [running, openId, list, live, loadList, loadConvo])

  /*
   * Arriving from the live count with one agent in mind: open it as soon as
   * the list can name it. Matched on the tool call that launched it, the one
   * id the stream and the transcript both carry. `at` makes a second click on
   * the same row count as a new request.
   */
  const focused = useRef(null)
  useEffect(() => {
    if (!focus?.toolUseId || !list || focused.current === focus.at) return
    const agent = list.find((a) => a.toolUseId === focus.toolUseId)
    if (!agent) return
    focused.current = focus.at
    if (openId !== agent.agentId) {
      setOpenId(agent.agentId)
      setConvo(null)
      loadConvo(agent.agentId)
    }
  }, [focus, list, openId, loadConvo])

  function open(agentId) {
    if (openId === agentId) {
      setOpenId(null)
      setConvo(null)
      wanted.current = null
      return
    }
    setOpenId(agentId)
    setConvo(null)
    loadConvo(agentId)
  }

  if (error) return <div className="agents"><p className="note">{error}</p></div>

  return (
    <div className="agents">
      <div className="agent-list">
        <h3>
          Subagents {list && <span className="count">{list.length}</span>}
        </h3>
        {list === null && <p className="note">Reading...</p>}
        {list?.length === 0 && (
          <p className="note">This session has not launched any subagents.</p>
        )}
        {list?.map((agent) => (
          <button
            key={agent.agentId}
            type="button"
            className={`row agent-row ${openId === agent.agentId ? 'is-on' : ''}`}
            onClick={() => open(agent.agentId)}
            title={isRunning(agent) ? 'Running — click to read what it is saying' : 'Click to read what it said'}
          >
            <span className={`dot dot-${isRunning(agent) ? 'busy' : 'idle'}`} />
            <span className="row-name">{agentLabel(agent)}</span>
            {agent.type && agent.description && <span className="row-meta">{agent.type}</span>}
          </button>
        ))}
      </div>

      {openId && (
        <div className="agent-convo">
          {loading && !convo && <p className="note">Reading its transcript...</p>}
          {convo?.missing && <p className="note">Its transcript is no longer on disk.</p>}
          {convo && !convo.missing && (
            <>
              {/* Same bargain the main conversation makes: what it said is the
                  view, and the tool calls are a count rather than a wall. */}
              <p className="note agent-meta">
                {convo.total} message{convo.total === 1 ? '' : 's'}
                {convo.tools > 0 && ` · ${convo.tools} tool call${convo.tools === 1 ? '' : 's'}`}
                {convo.total > convo.messages.length && ` · showing the last ${convo.messages.length}`}
              </p>
              {convo.messages.map((message, i) => (
                <Message key={message.uuid || i} message={message} roles={AGENT_ROLES} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
