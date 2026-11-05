import { useCallback, useState } from 'react'
import { readLocal, writeLocal } from './localKey.js'

const KEY = 'session-deck.plans.hidden'

/**
 * Which plans you have put aside.
 *
 * A board that shows everything a workspace is building is honest and
 * unusable: eleven projects, forty-two plans, and the three you are actually
 * inside this week are somewhere in the middle of it. Putting the rest aside
 * is the difference between a report and a desk.
 *
 * ### Why this is not stored in the repository, and not on the server
 *
 * Because it is not a fact about the work. The plan, its milestones and their
 * statuses belong to the repository and the deck only reads them; which ones
 * you are looking at belongs to you, this week, on this screen. Writing it
 * into the repo would put one person's focus in everybody's checkout, and
 * putting it on the server would make two browsers fight over it.
 *
 * So it follows the rule `useCollapsed` already set for exactly this kind of
 * state: per-viewer convenience in localStorage, every access guarded. A
 * phone that cannot write it simply shows everything, which is the right
 * failure.
 *
 * ### Hidden, never deleted
 *
 * The same rule `teams.js` keeps about putting a team away. Nothing here
 * removes a plan from anything — it is a filter over what the readers found,
 * and the moment it stops being obvious that something is filtered, the
 * screen has started lying. Every caller shows the count and offers it back.
 */
function load() {
  try {
    const raw = readLocal(KEY)
    const list = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(list) ? list : [])
  } catch {
    // Private window, blocked site data, or a half-written value. Showing
    // every plan is a worse day than a crashed screen is an hour.
    return new Set()
  }
}

/**
 * One plan's address.
 *
 * Scoped by project because plan ids are only unique inside one: two
 * repositories can both have a spec called `identity-and-session`, and a key
 * of the id alone would hide one when you put away the other.
 */
export function planKey(root, planId) {
  return `${root}::${planId}`
}

export function useHiddenPlans() {
  const [hidden, setHidden] = useState(load)

  const update = useCallback((next) => {
    setHidden(next)
    try { writeLocal(KEY, JSON.stringify([...next])) } catch { /* see load() */ }
  }, [])

  const hide = useCallback((root, planId) => {
    update(new Set(hidden).add(planKey(root, planId)))
  }, [hidden, update])

  const show = useCallback((root, planId) => {
    const next = new Set(hidden)
    next.delete(planKey(root, planId))
    update(next)
  }, [hidden, update])

  /**
   * Bring back everything put aside in one project.
   *
   * Per project rather than globally, because that is the scope you lost
   * track in. Somebody who put aside nine plans in one repository six weeks
   * ago should not have to undo that to find the two they hid here today.
   */
  const showAll = useCallback((root) => {
    const next = new Set([...hidden].filter((k) => !k.startsWith(`${root}::`)))
    update(next)
  }, [hidden, update])

  const isHidden = useCallback((root, planId) => hidden.has(planKey(root, planId)), [hidden])

  return { hidden, hide, show, showAll, isHidden }
}
