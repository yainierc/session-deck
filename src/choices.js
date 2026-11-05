/**
 * choices.js — the model, the effort and the advisor a session can be started
 * with, and what counts as a valid one.
 *
 * Shared because two different files need the same answer and would otherwise
 * each keep their own copy: a saved shortcut validates what it stores, and the
 * launch path validates what arrives from a browser. A list that lives in one
 * of them is a list that drifts from the other, and the direction it drifts is
 * always towards the one nobody looked at.
 *
 * Everything here is an allowlist and never a passthrough. `presets.json` is a
 * plain file somebody can edit by hand, and the launch command arrives over a
 * socket; both are places where an unrecognised value should become "the
 * default" rather than a string handed to a subprocess.
 */

/**
 * What may be stored as a model.
 *
 * Not a menu — the panel asks the CLI which models this account can actually
 * reach, per folder, because that depends on what it has access to and on what
 * the organisation allows. This is only the shape check standing between a
 * hand-edited file and a subprocess argument: a value with no whitespace, no
 * leading dash, and a length a model id plausibly has.
 *
 * Aliases and full ids are both allowed, because both are things the CLI takes
 * and both are things the model list hands back — `sonnet` on one machine,
 * `claude-fable-5-1[1m]` on another.
 */
const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/

/**
 * The models that are an advisor to somebody, and the order of preference for
 * picking one. Short on purpose: see `advisorFor`.
 */
export const ADVISORS = ['fable', 'opus']

/** The five the SDK defines. `max` is session-only and never written to a settings file. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** An unrecognised value is the default, which is what `null` means here. */
export function cleanModel(value) {
  return typeof value === 'string' && MODEL_SHAPE.test(value) ? value : null
}

export function cleanEffort(value) {
  return EFFORTS.includes(value) ? value : null
}

/**
 * Which model advises, given the one doing the work.
 *
 * Stored as a yes or a no rather than as a model, because the pairing rules —
 * which advisor each main model will accept — are a table that belongs to the
 * API and changes with it. A shortcut that named its advisor would be a copy
 * of one row of that table, saved in a file, going stale silently.
 *
 * Two rules are enough to pick one, and both are about what gets refused
 * rather than about what is best:
 *
 * - A Fable session refuses an Opus or a Sonnet advisor, so Fable advises
 *   Fable. There is no second option there.
 * - Everything else accepts Opus, so Opus is the answer. Fable would also be
 *   accepted and is stronger, and it is deliberately not chosen: on some plans
 *   Fable bills to usage credits, and a yes/no checkbox is not where somebody
 *   agrees to that.
 *
 * Both are refused silently by the API when they are wrong — the request is
 * simply never attached — which is why the panel has to read back what was
 * granted rather than trust what this returned.
 */
export function advisorFor(model) {
  return /fable/i.test(String(model || '')) ? 'fable' : 'opus'
}

/**
 * The advisor a session is started with, from either shape it arrives in.
 *
 * A browser sends a yes or a no, because that is the question the form asks.
 * The handoff file sends back the model that yes resolved to, because that is
 * what was stored. Both land here so neither caller has to know about the
 * other, and anything that is not a model this deck would have chosen is no
 * advisor rather than a string passed on to a subprocess.
 */
export function cleanAdvisor(value, model) {
  if (value === true) return advisorFor(model)
  return ADVISORS.includes(value) ? value : null
}

/**
 * The settings layer a session is started with.
 *
 * Effort and the advisor both live in settings rather than in an option of
 * their own, and passing them at spawn is the only way to have them apply to
 * the first turn: the methods that change them mid-session need a running
 * process, and by the time there is one the first prompt has already been
 * pushed. Returns null when there is nothing to say, so the caller can leave
 * the key off entirely instead of sending an empty object.
 */
export function spawnSettings({ effort, advisor }) {
  const settings = {}
  if (cleanEffort(effort)) settings.effortLevel = effort
  if (advisor) settings.advisorModel = advisor
  return Object.keys(settings).length > 0 ? settings : null
}
