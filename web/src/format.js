export const STATUS_LABEL = {
  waiting: 'needs you',
  idle: 'idle',
  busy: 'working',
  shell: 'in shell',
  // Not "paused" and not "stopped": both suggest a process sitting somewhere.
  // There is no process. There is a conversation you can pick back up.
  detached: 'resumable',
  done: 'finished',
  error: 'failed',
  unknown: 'unknown',
}

export function relativeTime(ts) {
  if (!ts) return ''
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Shorten /Users/me/projects/x to ~/projects/x so it fits. */
export function shortPath(p) {
  if (!p) return ''
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^C:\\Users\\[^\\]+/i, '~')
}

/**
 * Where a session sits inside its project, for the row under its name.
 * Grouping by repository would otherwise hide that two sessions under the
 * same heading are in different worktrees.
 */
export function describeSubpath(session) {
  if (!session?.subpath) return null
  if (session.isWorktree) {
    // The full path to a worktree is mostly plumbing; its name is the point.
    const name = session.subpath.split('/').filter(Boolean).pop()
    return `worktree · ${name}`
  }
  return session.subpath
}
