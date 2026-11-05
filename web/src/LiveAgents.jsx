import { useEffect, useRef, useState } from 'react'

/**
 * LiveAgents — how many subagents this session has running, beside the tab
 * that shows what they said.
 *
 * The count is the question you ask from any view ("is it waiting on its
 * workers?"); the list behind it is the next one ("which, and how far are
 * they?"). Each row is a way into that agent's conversation, so the popover
 * is a shortcut to the Agents tab rather than a second copy of it.
 *
 * Only a session the deck drives has this: the numbers come off its own
 * message stream. A watched session has no `agents` field and shows nothing,
 * which is not the same as claiming it has none running.
 */

function compact(n) {
  if (n == null) return null
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}

function age(startedAt, now) {
  const s = Math.max(0, Math.round((now - startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export default function LiveAgents({ agents, onOpen }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const anchor = useRef(null)
  const count = agents?.length || 0

  // The last one finishing closes the list; there is nothing left to show.
  useEffect(() => {
    if (!count) setOpen(false)
  }, [count])

  // The ages move on their own; nothing else re-renders this every second.
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!anchor.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!count) return null
  const background = agents.filter((a) => a.background).length

  function go(agent) {
    setOpen(false)
    onOpen(agent?.toolUseId || null)
  }

  return (
    <span className="live-agents" ref={anchor}>
      <button
        type="button"
        className={`live-count ${open ? 'is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${count} subagent${count === 1 ? '' : 's'} running`}
        title="Subagents running now"
        onClick={() => setOpen((v) => !v)}
      >
        {count}
      </button>

      {open && (
        <div className="live-pop" role="dialog" aria-label="Subagents running now">
          <header>
            <span className="dot dot-busy" />
            <span>
              {count} running{background > 0 && ` · ${background} in background`}
            </span>
            <button type="button" className="live-pop-all" onClick={() => go(null)}>
              Open Agents →
            </button>
          </header>
          <ul>
            {agents.map((a) => (
              <li key={a.taskId}>
                <button type="button" onClick={() => go(a)} title="Read what it is saying">
                  <span className={`dot ${a.background ? 'dot-shell' : 'dot-busy'}`} />
                  <span className="live-desc">{a.description || a.type || 'Subagent'}</span>
                  <span className="live-meta">
                    {a.type && <span className="live-type">{a.type}</span>}
                    <span>{a.background ? 'background' : 'foreground'}</span>
                    <span>{age(a.startedAt, now)}</span>
                    {a.toolUses != null && <span>{a.toolUses} tool{a.toolUses === 1 ? '' : 's'}</span>}
                    {a.tokens != null && <span>{compact(a.tokens)} tok</span>}
                    {a.lastTool && <span>last: {a.lastTool}</span>}
                  </span>
                  {a.summary && <span className="live-summary">{a.summary}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  )
}
