/**
 * localKey.js — guarded localStorage access.
 *
 * What lives here is per-viewer convenience: which projects are folded, which
 * inbox filter is on. Nobody else needs it and nothing breaks without it,
 * which is why every access is wrapped. In a private window, or with site
 * data blocked, localStorage throws on access rather than returning empty,
 * and a panel that refuses to render is a far worse outcome than one that
 * forgets a preference.
 */

export function readLocal(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Nothing to do, and nothing worth interrupting the user over.
  }
}
