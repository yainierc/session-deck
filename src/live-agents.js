/**
 * The subagents a managed session has running right now, read off its own
 * message stream.
 *
 * The Agents tab already answers this by re-reading the transcript every few
 * seconds, which is the only way for a session the deck merely watches. A
 * session the deck drives tells us as it happens: the CLI emits a message
 * when a task starts, while it works, and when it ends. This keeps that as a
 * small table, so the tab can carry a count and the work in flight without
 * being opened.
 *
 * Two kinds of message feed it, and they are not equally trustworthy:
 *
 *   - The edges (`task_started`, `task_updated`, `task_notification`) are
 *     what carry detail, but a single missed end leaves a row running
 *     forever — the SDK says as much about pairing them.
 *   - `background_tasks_changed` is the whole set of live background tasks,
 *     sent on every change. It is a level, not an edge, so it is what
 *     decides which background agents are still alive.
 *
 * A foreground agent is never in that set. It cannot outlive the turn that
 * launched it, so the turn's result is what clears it.
 */

/** A task is a subagent when the CLI says so, or when it carries a type. */
function isAgent(msg) {
  return msg.task_type === 'local_agent' || Boolean(msg.subagent_type)
}

const ENDED = new Set(['completed', 'failed', 'killed', 'stopped'])

export function createLiveAgents({ now = Date.now } = {}) {
  /** task_id -> row */
  const rows = new Map()

  /**
   * Fold one SDK message in. Returns null when nothing changed, otherwise
   * whether it is worth publishing at once: a start or an end is, a
   * progress tick arrives several times a second and can wait.
   */
  function apply(msg) {
    if (msg?.type === 'result') return endTurn()
    if (msg?.type !== 'system') return null

    switch (msg.subtype) {
      case 'task_started': {
        if (!isAgent(msg) || msg.ambient || rows.has(msg.task_id)) return null
        rows.set(msg.task_id, {
          taskId: msg.task_id,
          toolUseId: msg.tool_use_id || null,
          description: msg.description || '',
          type: msg.subagent_type || null,
          background: Boolean(msg.is_backgrounded),
          startedAt: now(),
          tokens: null,
          toolUses: null,
          lastTool: null,
          summary: null,
        })
        return { urgent: true }
      }

      case 'task_progress': {
        const row = rows.get(msg.task_id)
        if (!row) return null
        if (msg.usage) {
          row.tokens = msg.usage.total_tokens ?? row.tokens
          row.toolUses = msg.usage.tool_uses ?? row.toolUses
        }
        if (msg.last_tool_name) row.lastTool = msg.last_tool_name
        if (msg.summary) row.summary = msg.summary
        return { urgent: false }
      }

      case 'task_updated': {
        const row = rows.get(msg.task_id)
        if (!row) return null
        if (ENDED.has(msg.patch?.status)) {
          rows.delete(msg.task_id)
          return { urgent: true }
        }
        if (msg.patch?.is_backgrounded && !row.background) {
          row.background = true
          return { urgent: true }
        }
        return null
      }

      case 'task_notification': {
        if (!rows.delete(msg.task_id)) return null
        return { urgent: true }
      }

      case 'background_tasks_changed': {
        // Replace, not merge: a background row the level no longer lists is
        // over, whether or not its end ever reached us.
        const alive = new Set((msg.tasks || []).map((t) => t.task_id))
        let changed = false
        for (const [id, row] of rows) {
          if (row.background && !alive.has(id)) {
            rows.delete(id)
            changed = true
          }
        }
        return changed ? { urgent: true } : null
      }

      default:
        return null
    }
  }

  /** The turn is over, and with it every agent that was not backgrounded. */
  function endTurn() {
    let changed = false
    for (const [id, row] of rows) {
      if (!row.background) {
        rows.delete(id)
        changed = true
      }
    }
    return changed ? { urgent: true } : null
  }

  /** The process is gone, and nothing it launched can still be running. */
  function clear() {
    if (!rows.size) return false
    rows.clear()
    return true
  }

  /** Oldest first — the order they were launched in. */
  function list() {
    return [...rows.values()].map((row) => ({ ...row }))
  }

  return { apply, clear, list }
}
