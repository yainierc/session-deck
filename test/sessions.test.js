/**
 * Killing a session the deck is only watching.
 *
 * The interesting part is not the signal — it is the guard in front of it.
 * The deck is handed a pid by a browser, and a pid is the easiest number in
 * the world to be wrong about: stale lists, recycled numbers, a process that
 * was never a session at all. Every test here is about what does NOT get a
 * signal.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { killSession, forgetSession, readSessions, stableOrder, groupByProject } from '../src/sessions.js'
import { terminateProcess, isAlive } from '../src/platform.js'

/** A scratch ~/.claude with a sessions directory the registry will read. */
function claudeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sessions-'))
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = dir
  return dir
}

/** A process that does nothing but stay alive until something ends it. */
function idleProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  child.unref()
  return child
}

/**
 * Register a pid as a live session, the way Claude Code publishes one: the
 * JSON the panel reads, and the key file it keeps beside it.
 */
function register(home, pid, extra = {}) {
  fs.writeFileSync(
    path.join(home, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, cwd: home, name: 'a terminal session', status: 'idle', ...extra }),
  )
  fs.writeFileSync(path.join(home, 'sessions', `${pid}.deadbeef.key`), 'secret')
}

const registryFiles = (home) => fs.readdirSync(path.join(home, 'sessions')).sort()

async function settle(pid, ms = 3000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !isAlive(pid)
}

test('kills a session that is in the registry, and clears what it left behind', async (t) => {
  const home = claudeHome()
  const child = idleProcess()
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  register(home, child.pid)

  const result = await killSession(child.pid)
  assert.equal(result.ok, true)
  assert.equal(result.gone, true)
  assert.equal(await settle(child.pid), true)

  // A process that was signalled to death never removed its own registration.
  // Leaving it is how a reused pid becomes a session that is not there.
  assert.deepEqual(result.cleaned.sort(), [`${child.pid}.deadbeef.key`, `${child.pid}.json`])
  assert.deepEqual(registryFiles(home), [])
  assert.deepEqual(readSessions(), [])
})

test('refuses a pid that is not a live session, however alive it is', async (t) => {
  claudeHome()
  const child = idleProcess()
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  // Deliberately not registered: a real process, but not one of ours to end.

  const result = await killSession(child.pid)
  assert.equal(result.ok, false)
  assert.match(result.error, /not running/)
  assert.equal(isAlive(child.pid), true)
})

test('refuses a pid whose session id no longer matches', async (t) => {
  const home = claudeHome()
  const child = idleProcess()
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  register(home, child.pid, { sessionId: 'now-a-different-session' })

  const result = await killSession(child.pid, { expectSessionId: 'the-one-you-clicked' })
  assert.equal(result.ok, false)
  assert.match(result.error, /different session/)
  assert.equal(isAlive(child.pid), true)
})

test('refuses anything that is not a pid', async () => {
  claudeHome()
  for (const bad of [null, undefined, '123', 1.5, NaN]) {
    assert.equal((await killSession(bad)).ok, false)
  }
})

test('never signals the deck itself', async () => {
  const result = await terminateProcess(process.pid)
  assert.equal(result.ok, false)
  assert.match(result.error, /the deck itself/)
})

test('never clears the registration of a process that is still alive', async (t) => {
  const home = claudeHome()
  const child = idleProcess()
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  register(home, child.pid)

  assert.deepEqual(forgetSession(child.pid), [])
  assert.equal(registryFiles(home).length, 2)
})

test('clears only the pid it was given, not the ones it is a prefix of', async (t) => {
  const home = claudeHome()
  const child = idleProcess()
  child.kill('SIGKILL')
  await settle(child.pid)

  // `${pid}0` is a different, longer pid. On `startsWith(String(pid))` alone
  // it would be swept up with its neighbour.
  const neighbour = `${child.pid}0`
  register(home, child.pid)
  register(home, neighbour)

  const removed = forgetSession(child.pid)
  assert.deepEqual(removed.sort(), [`${child.pid}.deadbeef.key`, `${child.pid}.json`])
  assert.deepEqual(registryFiles(home), [`${neighbour}.deadbeef.key`, `${neighbour}.json`])
})

test('a process that is already gone is the outcome asked for, not an error', async () => {
  const child = idleProcess()
  child.kill('SIGKILL')
  await settle(child.pid)

  const result = await terminateProcess(child.pid)
  assert.equal(result.ok, true)
  assert.equal(result.already, true)
})

/*
 * The sidebar's one promise: a row is where you left it.
 *
 * These are about what must NOT move. A session asking for permission is the
 * moment you are most likely to be reaching for the list with your eyes
 * somewhere else, and it used to be the exact moment the list rearranged
 * itself — up on the ask, down again on the answer.
 */
const ordered = (sessions) => stableOrder(sessions).map((s) => s.name)

test('a session that stops to ask you something does not move', () => {
  const list = [
    { name: 'first', sessionId: 'a', startedAt: 100, status: 'busy' },
    { name: 'second', sessionId: 'b', startedAt: 200, status: 'idle' },
    { name: 'third', sessionId: 'c', startedAt: 300, status: 'idle' },
  ]
  const before = ordered(list)

  // The third one blocks on a permission prompt, and then you answer it.
  list[2].status = 'waiting'
  assert.deepEqual(ordered(list), before, 'asking did not reorder the list')
  list[2].status = 'idle'
  assert.deepEqual(ordered(list), before, 'answering did not reorder it either')
})

test('a busy session touching its file does not drag itself up the list', () => {
  const list = [
    { name: 'quiet', sessionId: 'a', startedAt: 100, updatedAt: 1 },
    { name: 'chatty', sessionId: 'b', startedAt: 200, updatedAt: 1 },
  ]
  list[1].updatedAt = Date.now()
  assert.deepEqual(ordered(list), ['quiet', 'chatty'])
})

test('sessions that started in the same millisecond keep one fixed order', () => {
  const together = [
    { name: 'b', sessionId: 'bbb', startedAt: 500 },
    { name: 'a', sessionId: 'aaa', startedAt: 500 },
  ]
  assert.deepEqual(ordered(together), ordered([...together].reverse()))
})

test('a project does not climb the sidebar because something in it is waiting', () => {
  const sessions = [
    { name: 'one', sessionId: 'a', startedAt: 1, project: 'alpha', projectPath: '/alpha', status: 'idle' },
    { name: 'two', sessionId: 'b', startedAt: 2, project: 'zeta', projectPath: '/zeta', status: 'waiting' },
  ]
  const groups = groupByProject(sessions)
  assert.deepEqual(groups.map((g) => g.path), ['/alpha', '/zeta'])
  // The count still travels — it is what the badge and the toast count.
  assert.equal(groups.find((g) => g.path === '/zeta').waiting, 1)
})
