/**
 * settings.js — deck preferences that outlive a single launch.
 *
 * Small enough to be one JSON file. Kept separate from the workspace so a
 * corrupt preference file can never cost you your folder list.
 */
import fs from 'node:fs'
import path from 'node:path'
import { deckDir } from './platform.js'

/**
 * How much the deck asks before a launched session acts.
 *
 * These are the Agent SDK's own modes. The descriptions are what the UI
 * shows, and they say what actually happens rather than dressing it up:
 * a person choosing to stop being asked deserves to know what they traded.
 */
export const PERMISSION_MODES = [
  {
    id: 'default',
    label: 'Ask me',
    description: 'Asks before anything your rules do not already allow.',
  },
  {
    id: 'acceptEdits',
    label: 'Auto-accept edits',
    description: 'Writes and edits files without asking. Still asks before running commands.',
  },
  {
    id: 'bypassPermissions',
    label: 'Never ask',
    description: 'Runs everything without asking, including shell commands. Nothing stops it.',
    dangerous: true,
  },
]

export const DEFAULT_SETTINGS = { permissionMode: 'default' }

function file() {
  return path.join(deckDir(), 'settings.json')
}

export function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'))
    return {
      ...DEFAULT_SETTINGS,
      ...data,
      // An unknown mode from a hand-edited file must not silently widen
      // privilege, so anything unrecognised falls back to asking.
      permissionMode: PERMISSION_MODES.some((m) => m.id === data.permissionMode)
        ? data.permissionMode
        : DEFAULT_SETTINGS.permissionMode,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function update(patch) {
  const next = { ...read(), ...patch }
  if (patch.permissionMode && !PERMISSION_MODES.some((m) => m.id === patch.permissionMode)) {
    return { ok: false, error: 'Unknown permission mode' }
  }
  try {
    fs.mkdirSync(deckDir(), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(next, null, 2) + '\n')
    return { ok: true, settings: next }
  } catch {
    return { ok: false, error: 'Could not save settings' }
  }
}

export function isValidMode(mode) {
  return PERMISSION_MODES.some((m) => m.id === mode)
}

/**
 * Which identity a project should use, when you have said so explicitly.
 *
 * The deck normally works this out by asking the forge which of your accounts
 * can read a repository, and for repositories only one account can see, that
 * is the whole answer. It stops being the whole answer when two accounts can
 * both read something — an org you belong to twice, a public repo — because
 * then "can read it" no longer identifies whose work it is, and the queue
 * starts calling your own pull requests someone else's.
 *
 * So this is an override, not a mapping: absent means detect, present means
 * you decided. Kept here in the deck's own file, like everything else it
 * writes; Claude Code's configuration is read-only as far as this tool is
 * concerned.
 */
export function projectAccounts() {
  const value = read().projectAccounts
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function accountForProject(projectPath) {
  return projectAccounts()[projectPath]?.github || null
}

export function setAccountForProject(projectPath, login) {
  if (!projectPath) return { ok: false, error: 'A project is required' }

  const map = { ...projectAccounts() }
  const entry = { ...(map[projectPath] || {}) }

  if (login) entry.github = login
  else delete entry.github

  // Do not leave `{}` behind for a project whose only setting was cleared.
  if (Object.keys(entry).length) map[projectPath] = entry
  else delete map[projectPath]

  return update({ projectAccounts: map })
}
