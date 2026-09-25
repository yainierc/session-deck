/**
 * presets.js — saved tasks, for the things you type into every new session.
 *
 * A preset launches with one click and no review step, so the ones shipped by
 * default are deliberately investigative: they read and report, they do not
 * change code. Anything that edits should be something you wrote yourself and
 * meant to run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { deckDir } from './platform.js'

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

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (Array.isArray(data.presets)) return data.presets
  } catch {
    // No file yet: start from the defaults rather than an empty list, so the
    // feature is useful before you have configured anything.
  }
  return DEFAULTS
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

export function add({ label, prompt }) {
  const cleanLabel = String(label || '').trim()
  const cleanPrompt = String(prompt || '').trim()
  if (!cleanLabel) return { ok: false, error: 'A name is required' }
  if (!cleanPrompt) return { ok: false, error: 'A task is required' }
  if (cleanLabel.length > 40) return { ok: false, error: 'Keep the name under 40 characters' }

  const presets = read()
  if (presets.some((p) => p.label.toLowerCase() === cleanLabel.toLowerCase())) {
    return { ok: false, error: 'You already have a shortcut with that name' }
  }

  const preset = { id: randomUUID().slice(0, 8), label: cleanLabel, prompt: cleanPrompt }
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

/** Put the shipped defaults back, for when you have deleted your way into a corner. */
export function reset() {
  if (!write(DEFAULTS)) return { ok: false, error: 'Could not save' }
  return { ok: true, presets: DEFAULTS }
}
