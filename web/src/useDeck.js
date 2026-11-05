import { useEffect, useRef, useState, useCallback } from 'react'

/**
 * One WebSocket for everything: the session list arrives on its own, the
 * transcript is requested on subscribe, and control commands go back out the
 * same pipe. If the connection drops it retries with growing backoff so it
 * never hammers the server.
 */
const EMPTY = {
  sessionId: null, messages: [], meta: {}, activity: null, granted: null, events: [], loading: false,
}

/**
 * How many file events the map keeps in memory.
 *
 * A session that runs all afternoon would otherwise grow this array without
 * limit in a tab nobody reloads. The map draws a picture of what is happening
 * now over what has accumulated, so the oldest events are the cheapest to lose.
 */
const EVENT_CAP = 600

/** Apply a batch of late-arriving failures to events already on screen. */
function markFailed(events, failed) {
  if (!failed?.length) return events
  const ids = new Set(failed)
  let touched = false
  const next = events.map((event) => {
    if (!ids.has(event.id) || event.failed) return event
    touched = true
    return { ...event, failed: true }
  })
  return touched ? next : events
}

export function useDeck() {
  const [connected, setConnected] = useState(false)
  const [sessions, setSessions] = useState([])
  const [projects, setProjects] = useState([])
  const [transcript, setTranscript] = useState(EMPTY)
  const socketRef = useRef(null)
  const selectedRef = useRef(null)
  const retryRef = useRef(0)
  const pendingAcks = useRef(new Map())

  const connect = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${proto}//${location.host}/ws`)
    socketRef.current = socket

    socket.onopen = () => {
      setConnected(true)
      retryRef.current = 0
      // On reconnect we restore the transcript you were looking at.
      if (selectedRef.current) {
        socket.send(JSON.stringify({ type: 'subscribe', sessionId: selectedRef.current }))
      }
    }

    socket.onmessage = (event) => {
      let msg
      try { msg = JSON.parse(event.data) } catch { return }

      if (msg.type === 'sessions') {
        setSessions(msg.sessions || [])
        setProjects(msg.projects || [])
      }

      if (msg.type === 'ack') {
        const waiting = pendingAcks.current.get(msg.id)
        if (waiting) {
          pendingAcks.current.delete(msg.id)
          waiting(msg)
        }
      }

      if (msg.type === 'transcript') {
        setTranscript((prev) => {
          // A transcript for a session no longer selected arrived late: drop it.
          if (msg.sessionId !== selectedRef.current) return prev
          if (msg.replace) {
            return {
              sessionId: msg.sessionId,
              messages: msg.messages || [],
              // A reset clears what was read off the file, not what we know
              // about the session: its cwd and branch did not change because
              // the transcript rotated.
              meta: msg.meta ?? prev.meta,
              activity: msg.activity || null,
              granted: msg.granted ?? null,
              events: msg.events || [],
              eventsTruncated: Boolean(msg.eventsTruncated),
              total: msg.total || 0,
              missing: Boolean(msg.missing),
              loading: false,
            }
          }

          const events = msg.events?.length
            ? [...prev.events, ...msg.events].slice(-EVENT_CAP)
            : prev.events

          return {
            ...prev,
            messages: [...prev.messages, ...(msg.messages || [])],
            /*
             * The key is present only when that batch of lines had something
             * to say about it, so its absence means "unchanged" and a null
             * means "it finished and spoke". This used to be `msg.activity ??
             * prev.activity`, which reads a null as no news — so the indicator
             * was never cleared and a session that had moved on kept showing
             * the tool it ran an hour ago.
             */
            activity: 'activity' in msg ? msg.activity : prev.activity,
            /*
             * Same tri-state, same reason. A batch with no assistant line in
             * it says nothing about the advisor, and reading that as "no
             * advisor" would blink the chip off between every turn.
             */
            granted: 'granted' in msg ? msg.granted : prev.granted,
            // A failure lands on a later line than the call it belongs to.
            events: markFailed(events, msg.failed),
            loading: false,
          }
        })
      }
    }

    socket.onclose = () => {
      setConnected(false)
      const delay = Math.min(1000 * 2 ** retryRef.current, 10000)
      retryRef.current += 1
      setTimeout(connect, delay)
    }
    socket.onerror = () => socket.close()
  }, [])

  useEffect(() => {
    connect()
    return () => socketRef.current?.close()
  }, [connect])

  /** Send a command and resolve with the server's ack. */
  const command = useCallback((payload) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== 1) {
      return Promise.resolve({ ok: false, error: 'not connected' })
    }
    const id = Math.random().toString(36).slice(2)
    return new Promise((resolve) => {
      pendingAcks.current.set(id, resolve)
      socket.send(JSON.stringify({ ...payload, id }))
      // Never leave a caller hanging if the ack is lost.
      setTimeout(() => {
        if (pendingAcks.current.delete(id)) resolve({ ok: false, error: 'timed out' })
      }, 15000)
    })
  }, [])

  const select = useCallback((sessionId) => {
    selectedRef.current = sessionId
    setTranscript({ ...EMPTY, sessionId, loading: true })
    const socket = socketRef.current
    if (socket && socket.readyState === 1 && sessionId) {
      socket.send(JSON.stringify({ type: 'subscribe', sessionId }))
    }
  }, [])

  return {
    connected,
    sessions,
    projects,
    transcript,
    select,
    selected: transcript.sessionId,
    /*
     * An object rather than eight positional arguments. Five was already the
     * point where a caller has to count commas to see which one is the name,
     * and how a session thinks — its model, its effort, whether it consults an
     * advisor — adds three more that are all optional and all strings.
     *
     * `peers` are addresses, not labels: the names the new session will be
     * told to write into SendMessage. The server resolves them against the
     * live list before anything is introduced, so one that has exited between
     * the click and the launch is dropped rather than promised.
     */
    launch: (options) => command({ type: 'launch', ...options }),
    /*
     * A whole team. The server decides the order they come up in — the one
     * that hands out the work goes last so it is introduced to everybody — so
     * what goes out is a set, not a sequence.
     */
    team: (options) => command({ type: 'team', ...options }),
    rename: (deckId, name) => command({ type: 'rename', deckId, name }),
    /*
     * The other name: the one Claude Code keeps in the session's own file, for
     * sessions the deck did not launch and therefore has no label of its own
     * for. Same command, and the absence of a deckId is what picks the path.
     */
    retitle: (sessionId, name) => command({ type: 'rename', sessionId, name }),
    tag: (sessionId, value) => command({ type: 'tag', sessionId, tag: value }),
    answer: (deckId, requestId, decision) => command({ type: 'permission', deckId, requestId, decision }),
    answerQuestion: (deckId, requestId, answers) =>
      command({ type: 'answer', deckId, requestId, answers }),
    /*
     * Four kinds of thing can ride along with what you typed: images and text
     * files inline, and PDFs as their own content block — a PDF read as text
     * is mojibake, so it is the one attachment that cannot travel that way.
     */
    say: (deckId, text, images, files, documents) =>
      command({ type: 'say', deckId, text, images, files, documents }),
    setMode: (deckId, permissionMode) => command({ type: 'mode', deckId, permissionMode }),
    /*
     * Put the progress strip away. The list itself arrives on the session
     * object like every other managed field, so there is nothing to read
     * here — only this one way to write it, and in practice only with [].
     */
    clearTodos: (deckId) => command({ type: 'todos', deckId, todos: [] }),
    interrupt: (deckId) => command({ type: 'interrupt', deckId }),
    /*
     * How full this session's context window is. Only the deck's own sessions
     * can answer — an observed one has no handle to ask through.
     */
    contextUsage: (deckId) => command({ type: 'context', deckId }),
    /*
     * What this session can be switched to. Asked when the menu opens rather
     * than kept in state: the answer belongs to the session, changes with the
     * CLI it is running, and is read once per look at it.
     */
    models: (deckId) => command({ type: 'models', deckId }),
    setModel: (deckId, model) => command({ type: 'model', deckId, model }),
    setEffort: (deckId, effort) => command({ type: 'effort', deckId, effort }),
    /*
     * Start a resumable session's process without sending it anything. The
     * composer can still wake one by being typed at; this is for when what
     * you want is the session ready rather than the session answering.
     */
    wake: (deckId) => command({ type: 'wake', deckId }),
    /*
     * The same wake, for a set. A restart puts a whole team to sleep at once,
     * and bringing it back one card at a time is the press you should not
     * have to make six times. The caller picks who is in the set.
     */
    wakeMany: (deckIds) => command({ type: 'wake', deckIds }),
    stop: (deckId) => command({ type: 'stop', deckId }),
    /*
     * Take charge of a conversation already on disk — one out of a project's
     * history, or one this deck was driving before it was restarted. The cwd
     * travels with it because that is what the resumed session will run in,
     * and the transcript alone does not reliably say.
     */
    reopen: (sessionId, cwd, name) => command({ type: 'reopen', sessionId, cwd, name }),
    /*
     * The other kill: a session running in someone else's terminal, which the
     * deck can only reach by the pid it publishes. The session id rides along
     * so the server can refuse a pid this panel saw before it was recycled.
     */
    kill: (pid, sessionId) => command({ type: 'kill', pid, sessionId }),
  }
}
