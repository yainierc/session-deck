/**
 * presets.js — saved tasks, for the things you type into every new session.
 *
 * A preset launches with one click and no review step, so the ones shipped by
 * default are deliberately investigative: they read and report, they do not
 * change code. Anything that edits should be something you wrote yourself and
 * meant to run.
 *
 * A preset also carries how the session should think: which model, how much
 * effort, and whether a stronger model is consulted at the hard moments. Those
 * are part of the task and not of the session — "review my changes" wants care
 * and "catch me up" does not, whatever you happened to leave the panel set to
 * last night.
 *
 * What a preset deliberately does NOT carry is the permission mode. The three
 * paths that launch from something stored — a roadmap, a report, a milestone —
 * all take the mode from settings on purpose, because a stored plan must never
 * be the way privilege gets widened. This file is edited by hand more easily
 * than any of them, so the same rule holds here, and more so.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { deckDir } from './platform.js'
import { cleanModel, cleanEffort } from './choices.js'

const DEFAULTS = [
  {
    id: 'catch-up',
    label: 'Catch me up',
    prompt:
      'Look at the recent git history and any uncommitted changes here, then tell me ' +
      'what we were last working on and what is still pending. Read only — do not ' +
      'change anything yet.',
  },
  {
    id: 'whats-next',
    label: "What's next",
    prompt:
      'Given the current state of this project, what are the most valuable things to ' +
      'do next? List them briefly, most important first, and say what each one is ' +
      'blocked on. Do not change anything yet.',
  },
  {
    id: 'review-changes',
    label: 'Review my changes',
    prompt:
      'Review the uncommitted changes in this project for bugs and problems. Report ' +
      'what you find, most serious first. Do not fix anything yet.',
  },
]

function file() {
  return path.join(deckDir(), 'presets.json')
}

/**
 * One stored record, reduced to what this file is willing to vouch for.
 *
 * The file is plain JSON in a directory you can open, so what comes out of it
 * is treated as somebody's typing and not as the panel's own state. An
 * unrecognised model or effort becomes the default rather than an error: the
 * shortcut still works, it just stops claiming something the CLI would refuse.
 */
function clean(record) {
  if (!record || typeof record !== 'object') return null
  const label = String(record.label || '').trim()
  const prompt = String(record.prompt || '').trim()
  if (!label || !prompt) return null
  return {
    id: String(record.id || randomUUID().slice(0, 8)),
    label,
    prompt,
    model: cleanModel(record.model),
    effort: cleanEffort(record.effort),
    advisor: record.advisor === true,
  }
}

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (Array.isArray(data.presets)) return data.presets.map(clean).filter(Boolean)
  } catch {
    // No file yet: start from the defaults rather than an empty list, so the
    // feature is useful before you have configured anything.
  }
  return DEFAULTS.map(clean)
}

function write(presets) {
  try {
    fs.mkdirSync(deckDir(), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify({ presets }, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

export function list() {
  return read()
}

export function add({ label, prompt, model, effort, advisor }) {
  const cleanLabel = String(label || '').trim()
  const cleanPrompt = String(prompt || '').trim()
  if (!cleanLabel) return { ok: false, error: 'A name is required' }
  if (!cleanPrompt) return { ok: false, error: 'A task is required' }
  if (cleanLabel.length > 40) return { ok: false, error: 'Keep the name under 40 characters' }

  const presets = read()
  if (presets.some((p) => p.label.toLowerCase() === cleanLabel.toLowerCase())) {
    return { ok: false, error: 'You already have a shortcut with that name' }
  }

  /*
   * Built through the same cleaner the file is read with, so a shortcut saved
   * from the panel and one typed into the file by hand cannot end up different
   * shapes. It cannot return null here — label and prompt are checked above.
   */
  const preset = clean({ id: randomUUID().slice(0, 8), label: cleanLabel, prompt: cleanPrompt, model, effort, advisor })
  if (!write([...presets, preset])) return { ok: false, error: 'Could not save' }
  return { ok: true, preset }
}

export function remove(id) {
  const presets = read()
  const next = presets.filter((p) => p.id !== id)
  if (next.length === presets.length) return { ok: false, error: 'No such shortcut' }
  if (!write(next)) return { ok: false, error: 'Could not save' }
  return { ok: true }
}

/**
 * Put the shipped defaults back, for when you have deleted your way into a
 * corner.
 *
 * The shipped three carry no model, no effort and no advisor on purpose. They
 * are what somebody sees before they have configured anything, and a default
 * that quietly spends more than the panel's own default model would is a bill
 * nobody asked for — the advisor especially, which reads the whole
 * conversation every time it is called.
 */
export function reset() {
  const defaults = DEFAULTS.map(clean)
  if (!write(defaults)) return { ok: false, error: 'Could not save' }
  return { ok: true, presets: defaults }
}
