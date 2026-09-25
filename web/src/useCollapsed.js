import { useCallback, useEffect, useRef, useState } from 'react'
import { readLocal, writeLocal } from './localKey.js'

const KEY = 'session-deck.collapsed'

/**
 * Which projects are folded shut.
 *
 * Kept in localStorage because it is a per-viewer convenience, not state
 * anyone else needs. Every access is guarded: in a private window, or with
 * site data blocked, the accessor throws rather than returning empty, and a
 * sidebar that will not render is a far worse outcome than one that forgets
 * which sections you folded.
 */
function load() {
  try {
    const raw = readLocal(KEY)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch {
    return new Set()
  }
}

function save(set) {
  writeLocal(KEY, JSON.stringify([...set]))
}

export function useCollapsed(projects) {
  const [collapsed, setCollapsed] = useState(load)
  const previousWaiting = useRef(new Map())

  const toggle = useCallback((path) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      save(next)
      return next
    })
  }, [])

  /**
   * A project folded shut must not be able to swallow an alert. When one of
   * its sessions starts waiting on you, it opens itself.
   *
   * This fires on the transition only, the same rule the desktop
   * notification follows: it nudges once, it does not fight you for the rest
   * of the session if you fold it again.
   */
  useEffect(() => {
    const opened = []
    const current = new Map()
    for (const project of projects) {
      const before = previousWaiting.current.get(project.path) || 0
      if (project.waiting > 0 && before === 0) opened.push(project.path)
      current.set(project.path, project.waiting)
    }
    // Forget projects that are gone. Keeping their last count would mean a
    // project that disappears while waiting and comes back still waiting
    // shows no transition — and a folded section would swallow the alert.
    previousWaiting.current = current

    if (!opened.length) return

    setCollapsed((prev) => {
      if (!opened.some((path) => prev.has(path))) return prev
      const next = new Set(prev)
      for (const path of opened) next.delete(path)
      save(next)
      return next
    })
  }, [projects])

  return { collapsed, toggle }
}
