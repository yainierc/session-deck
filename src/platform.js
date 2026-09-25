/**
 * platform.js — everything OS-specific lives here.
 *
 * If you take session-deck to Windows or Linux and something breaks, this is
 * the only file you need to look at. The rest of the code stays portable
 * because it never builds OS paths by hand or assumes a particular shell.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/** Root of the Claude Code configuration. Honours CLAUDE_CONFIG_DIR if set. */
export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

/**
 * Where the deck keeps its own state — the folders you added to the
 * workspace. Kept out of ~/.claude so we never write into Claude Code's
 * directory, only read from it.
 */
export function deckDir() {
  // Resolved on every call rather than cached: the tests point this at a
  // scratch directory by setting the variable.
  return process.env.SESSION_DECK_DIR || path.join(os.homedir(), '.session-deck')
}

/**
 * Claude Code's own configuration file — the one holding per-project MCP
 * servers, and with them the credentials those servers were given.
 *
 * It is a sibling of the configuration directory rather than a file inside it,
 * which is the one thing about this path that surprises everybody. With
 * CLAUDE_CONFIG_DIR set it moves inside that directory instead, so both places
 * are tried and the first that exists wins. A machine with neither simply has
 * no file, which every caller here already has to cope with.
 */
export function claudeConfigFile() {
  const candidates = [path.join(os.homedir(), '.claude.json')]
  if (process.env.CLAUDE_CONFIG_DIR) {
    candidates.unshift(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'))
  }
  return candidates.find((file) => fs.existsSync(file)) || candidates[0]
}

/** Directory holding one JSON file per live session. */
export function sessionsDir() {
  return path.join(claudeDir(), 'sessions')
}

/**
 * Transcript directory. It holds one subdirectory per project, named after
 * the encoded cwd — that encoding is NOT the same on Windows (drive letters,
 * backslashes), so we treat it as an opaque id and read the real cwd from
 * inside the files instead.
 */
export function projectsDir() {
  return path.join(claudeDir(), 'projects')
}

/**
 * Check whether a process is still alive.
 * Signal 0 kills nothing, it only queries. This behaves the same on all
 * three platforms, unlike parsing the output of `ps`.
 */
export function isAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to another user. Still alive.
    return err.code === 'EPERM'
  }
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * Wait for a process to actually be gone, up to a limit.
 *
 * Sending a signal and observing the exit are not the same event, and the gap
 * between them is where the tempting mistakes live: cleaning up after a
 * process that has not died yet, or reporting a kill that never landed.
 * Returns whether it is dead, never throws, and gives up rather than waiting
 * for ever.
 */
export async function waitForExit(pid, ms, { pollMs = 100 } = {}) {
  const deadline = Date.now() + ms
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false
    await delay(pollMs)
  }
  return true
}

/**
 * End a process that is not ours — a session started outside the deck.
 *
 * Sessions the deck launched are stopped through the SDK, which knows how to
 * unwind a turn. Nothing of the sort exists for a session running in somebody
 * else's terminal: the only handle on it is the pid it publishes, so this is
 * the blunt instrument, and it stays blunt on purpose rather than pretending
 * to be a graceful shutdown.
 *
 * SIGTERM first, because Claude Code answers it — it closes its transcript
 * and removes its socket instead of leaving both behind. SIGKILL is the
 * fallback for a process too wedged to answer, which is exactly the state you
 * are most likely to be killing one from. A kill that can hang is not a kill.
 *
 * Windows has no graceful signal for a console process you did not start, so
 * taskkill is the whole story there; /T takes the wrapper processes npm put
 * around the CLI with it.
 *
 * `gone` is separate from `ok` and is the field callers should read before
 * cleaning up after the process: `ok` means the signal was delivered, `gone`
 * means the process is actually off the table.
 */
export async function terminateProcess(pid, { graceMs = 4000, reapMs = 2000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'not a process id' }
  // The deck runs the sessions it launched as children of itself; killing its
  // own pid would take the panel down with them.
  if (pid === process.pid) return { ok: false, error: 'that pid is the deck itself' }
  if (!isAlive(pid)) return { ok: true, already: true, gone: true }

  if (IS_WINDOWS) {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'])
    if (result.status !== 0) {
      const message = String(result.stderr || '').trim().split('\n')[0]
      return { ok: false, error: message || 'taskkill could not end that process' }
    }
    return { ok: true, how: 'taskkill', gone: await waitForExit(pid, reapMs) }
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    // It exited between the check and the signal. That is the outcome asked
    // for, so it is not a failure.
    if (err.code === 'ESRCH') return { ok: true, already: true, gone: true }
    if (err.code === 'EPERM') return { ok: false, error: 'that process belongs to another user' }
    return { ok: false, error: err.message }
  }

  if (await waitForExit(pid, graceMs)) return { ok: true, how: 'SIGTERM', gone: true }

  try {
    process.kill(pid, 'SIGKILL')
  } catch (err) {
    if (err.code === 'ESRCH') return { ok: true, how: 'SIGTERM', gone: true }
    return { ok: false, error: err.message }
  }
  // SIGKILL is delivered instantly but the pid lingers until its own parent
  // reaps it, so "signalled" is still not "gone".
  return { ok: true, how: 'SIGKILL', gone: await waitForExit(pid, reapMs) }
}

/**
 * Native desktop notification.
 * This is the one piece that genuinely has to branch per platform.
 * Fails silently: a dropped notification must never take down the server.
 */
export function notify({ title, message, subtitle }) {
  try {
    if (IS_MAC) {
      const esc = (s) => String(s ?? '').replace(/["\\]/g, '\\$&')
      const parts = [`display notification "${esc(message)}"`, `with title "${esc(title)}"`]
      if (subtitle) parts.push(`subtitle "${esc(subtitle)}"`)
      spawn('osascript', ['-e', parts.join(' ')], { stdio: 'ignore' }).unref()
      return true
    }
    if (IS_WINDOWS) {
      // Toast via PowerShell. No external dependencies.
      const esc = (s) => String(s ?? '').replace(/'/g, "''")
      const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode('${esc(title)}')) > $null
$n.Item(1).AppendChild($t.CreateTextNode('${esc(message)}')) > $null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('session-deck').Show([Windows.UI.Notifications.ToastNotification]::new($t))
`.trim()
      spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' }).unref()
      return true
    }
    // Linux
    spawn('notify-send', [String(title), String(message)], { stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

/** Open the default browser at a URL. */
export function openBrowser(url) {
  try {
    if (IS_MAC) spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
    else if (IS_WINDOWS) spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref()
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
    return true
  } catch {
    return false
  }
}

/**
 * The operating system's own "choose a folder" dialog.
 *
 * The deck has its own picker, because a browser cannot be handed a real path
 * and because the panel is often open from somewhere else. This is the other
 * half: when you are sitting at the machine, the dialog you already know —
 * with your Finder sidebar, your tags, your recent places — beats any list a
 * web app can draw.
 *
 * The window opens on the machine running the deck, which is why the endpoint
 * that calls this refuses anything but a local request.
 *
 * Cancelling is not an error. It resolves { ok: false, cancelled: true } so
 * the panel can say nothing at all, which is what cancelling should cost.
 */
export function chooseFolder(startPath) {
  return new Promise((resolve) => {
    let child
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    try {
      if (IS_MAC) {
        // `tell me to activate` puts the dialog in front of the browser
        // instead of behind it, and needs no automation permission.
        const start = startPath
          ? ` default location POSIX file ${JSON.stringify(String(startPath))}`
          : ''
        child = spawn('osascript', [
          '-e', 'tell me to activate',
          '-e', `set chosen to choose folder with prompt "Choose a project folder"${start}`,
          '-e', 'POSIX path of chosen',
        ])
      } else if (IS_WINDOWS) {
        const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose a project folder'
if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath } else { exit 1 }
`.trim()
        child = spawn('powershell', ['-NoProfile', '-STA', '-Command', ps])
      } else {
        child = spawn('zenity', ['--file-selection', '--directory', '--title=Choose a project folder'])
      }
    } catch (err) {
      return done({ ok: false, error: err?.message || 'Could not open a folder dialog' })
    }

    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { err += chunk })

    child.on('error', () => done({
      ok: false,
      // The only failure worth naming: the helper is simply not installed.
      error: IS_MAC || IS_WINDOWS ? 'Could not open a folder dialog' : 'zenity is not installed',
    }))

    child.on('close', (code) => {
      const picked = out.trim()
      if (code === 0 && picked) return done({ ok: true, path: picked })
      // Every platform reports "the user pressed Cancel" as a non-zero exit
      // with nothing on stdout. That is not something to apologise for.
      if (!picked) return done({ ok: false, cancelled: true })
      done({ ok: false, error: err.trim().split('\n')[0] || 'Could not read the chosen folder' })
    })

    // A dialog nobody ever answers must not hold a request open for ever.
    setTimeout(() => {
      if (settled) return
      child.kill()
      done({ ok: false, cancelled: true })
    }, 180_000).unref?.()
  })
}

/**
 * Open a terminal window running a command, and leave it open.
 *
 * For the sign-in flows, which are interactive by nature: `gh auth login`
 * negotiates a device code, `az login` hands off to a browser, `az devops
 * login` waits for a token on stdin. Reimplementing any of that in the panel
 * would mean the deck handling your credentials, and the whole design here
 * rests on the opposite — the official CLI stays the only keystore.
 *
 * So this hands you to the real command instead of impersonating it.
 *
 * Resolves to `{ ok, error }` only once the outcome is actually known.
 * Fire-and-forget would be easier and would be a lie: `spawn` not throwing
 * says nothing about whether a window appeared, and a panel that reports
 * "a terminal is open" when none is, is worse than one that reports nothing.
 */
export function openTerminal(command) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok, error) => {
      if (settled) return
      settled = true
      resolve({ ok, error: ok ? null : error || 'Could not open a terminal' })
    }

    let child
    // A terminal emulator lives for as long as its window does, so waiting
    // for it to exit would mean waiting for the user to close it. Only the
    // launchers that return immediately can be waited on.
    let waitForExit = true

    try {
      if (IS_MAC) {
        // The command is embedded in an AppleScript string literal.
        const esc = String(command).replace(/[\\"]/g, '\\$&')
        child = spawn(
          'osascript',
          ['-e', `tell application "Terminal" to do script "${esc}"`,
           '-e', 'tell application "Terminal" to activate'],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        )
      } else if (IS_WINDOWS) {
        // /k keeps the window open after the command finishes, so a failed
        // login leaves its error on screen instead of vanishing.
        child = spawn('cmd', ['/c', 'start', 'cmd', '/k', command], { stdio: ['ignore', 'ignore', 'pipe'] })
      } else {
        // Linux has no single answer, and spawn reports a missing binary
        // through an event rather than a throw, so candidates are probed.
        const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']
          .find((candidate) => spawnSync('which', [candidate], { stdio: 'ignore' }).status === 0)
        if (!term) return done(false, 'No terminal emulator found')
        waitForExit = false
        child = spawn(term, ['-e', `bash -lc ${JSON.stringify(`${command}; exec bash`)}`], {
          stdio: 'ignore',
          detached: true,
        })
        child.unref()
      }
    } catch (err) {
      return done(false, err?.message)
    }

    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => done(false, err?.message))

    if (!waitForExit) {
      child.on('spawn', () => done(true))
    } else {
      child.on('close', (code) => {
        if (code === 0) return done(true)
        done(false, stderr.trim().split('\n')[0] || `the launcher exited with ${code}`)
      })
    }

    // A cold Terminal.app can take seconds; never hang the request on it.
    setTimeout(() => done(false, 'Timed out opening a terminal'), 20_000).unref?.()
  })
}

/**
 * Spawn the claude CLI as a subprocess.
 * On Windows the binary installed by npm is claude.cmd, which only starts
 * through the shell — this is the classic failure when porting tools like
 * this one.
 */
export function spawnClaude(args, opts = {}) {
  return spawn('claude', args, { shell: IS_WINDOWS, ...opts })
}

/**
 * Connect to a session's messaging socket.
 * On Mac/Linux it is a unix socket, on Windows a named pipe. Node accepts
 * both through the same API AS LONG AS we do not build the path ourselves:
 * we read it from the messagingSocketPath field the session publishes.
 */
export function socketPathFor(session) {
  return session?.messagingSocketPath || null
}

/** Is Claude Code's config directory present on this machine? */
export function checkInstall() {
  const dir = claudeDir()
  const problems = []
  if (!fs.existsSync(dir)) problems.push(`${dir} does not exist — Claude Code does not look installed for this user.`)
  else if (!fs.existsSync(sessionsDir())) problems.push(`${sessionsDir()} does not exist — no sessions registered yet.`)
  return { dir, problems }
}
