/**
 * Introducing one session to another.
 *
 * Two things here are easy to get wrong and silent when you do, which is why
 * they are the ones pinned down.
 *
 * An address that does not resolve. The panel shows a managed session under
 * the label you typed, while the string that actually reaches it is the name
 * its process registered. Composing the roster out of what is on screen
 * yields a paragraph telling a session to go and ask somebody whose name
 * SendMessage has never heard of — and nothing fails: the message is simply
 * never sent, or sent nowhere.
 *
 * And a peer that cannot hear us. Cross-session delivery turns on
 * permission-mode parity; across the boundary a message is held for the user
 * instead of delivered. A launcher that says nothing about that produces a
 * session waiting on an answer that was parked, which looks exactly like a
 * session waiting on a slow peer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  peerName, resolvePeers, rosterBlock, withRoster, heldPeers, deliveryClass, MAX_PEERS,
} from '../src/roster.js'

test('an address carries the project and then the role', () => {
  assert.equal(peerName('/Users/x/acme/payments', 'specs'), 'payments-specs')
})

test('a label that already starts with its project is not made to say it twice', () => {
  assert.equal(peerName('/Users/x/multi-tasking', 'multi-tasking roster'), 'multi-tasking-roster')
})

test('an unlabelled launch gets no name, and keeps the one the CLI derives', () => {
  assert.equal(peerName('/Users/x/repo', ''), null)
  assert.equal(peerName('/Users/x/repo', null), null)
  // Punctuation only: a label with nothing addressable left in it is no label.
  assert.equal(peerName('/Users/x/repo', '...'), null)
})

test('an address survives being typed back: no accents, no spaces, no case', () => {
  assert.equal(peerName('/Users/x/acme/Checkout', 'Revisión de API'), 'checkout-revision-de-api')
})

test('an address already in use is numbered rather than duplicated', () => {
  const taken = ['payments-specs']
  assert.equal(peerName('/x/payments', 'specs', taken), 'payments-specs-2')
  assert.equal(peerName('/x/payments', 'specs', [...taken, 'payments-specs-2']), 'payments-specs-3')
})

test('numbering does not push an address past the length limit', () => {
  const long = peerName('/x/repo', 'y'.repeat(200))
  const numbered = peerName('/x/repo', 'y'.repeat(200), [long])
  assert.ok(numbered.length <= 60, `got ${numbered.length}`)
  assert.notEqual(numbered, long)
})

test('an address stays within the length a peer name is normalized to', () => {
  const name = peerName('/Users/x/repo', 'x'.repeat(200))
  assert.ok(name.length <= 60, `got ${name.length}`)
  assert.ok(!name.endsWith('-'))
})

/** The snapshot shape the server hands in: observed and managed side by side. */
function snapshot() {
  return [
    // Observed: what it is called is what it answers to.
    { name: 'payments-fa', project: 'Payments', cwd: '/x/Payments', status: 'idle' },
    // Managed: the label on screen, and the address underneath it.
    {
      name: 'Revisar el cierre',
      peerName: 'checkout-release',
      project: 'Checkout',
      cwd: '/x/Checkout',
      status: 'busy',
      permissionMode: 'default',
    },
  ]
}

test('a managed peer resolves by its address, not by the label on screen', () => {
  const [peer] = resolvePeers(snapshot(), ['checkout-release'])
  assert.equal(peer.name, 'checkout-release')
  assert.equal(peer.project, 'Checkout')
})

test('the label on screen is not an address and does not resolve', () => {
  assert.deepEqual(resolvePeers(snapshot(), ['Revisar el cierre']), [])
})

test('a name nobody answers to is dropped rather than introduced', () => {
  const peers = resolvePeers(snapshot(), ['payments-fa', 'a-session-that-exited'])
  assert.deepEqual(peers.map((p) => p.name), ['payments-fa'])
})

test('a session with no process behind it is not somebody to be introduced to', () => {
  const list = [
    { name: 'gone-detached', project: 'P', cwd: '/x/P', status: 'detached' },
    { name: 'gone-done', project: 'P', cwd: '/x/P', status: 'done' },
    { name: 'gone-error', project: 'P', cwd: '/x/P', status: 'error' },
    { name: 'here', project: 'P', cwd: '/x/P', status: 'idle' },
  ]
  const peers = resolvePeers(list, list.map((s) => s.name))
  assert.deepEqual(peers.map((p) => p.name), ['here'])
})

test('the same peer asked for twice is introduced once', () => {
  const peers = resolvePeers(snapshot(), ['payments-fa', 'payments-fa'])
  assert.equal(peers.length, 1)
})

test('an observed peer reports no permission mode rather than a guessed one', () => {
  const [peer] = resolvePeers(snapshot(), ['payments-fa'])
  assert.equal(peer.permissionMode, null)
})

test('introductions are capped', () => {
  const many = Array.from({ length: MAX_PEERS + 4 }, (_, i) => ({
    name: `peer-${i}`, project: 'P', cwd: '/x/P', status: 'idle',
  }))
  assert.equal(resolvePeers(many, many.map((p) => p.name)).length, MAX_PEERS)
})

test('a peer whose mode we do not know counts as one that may not hear us', () => {
  assert.equal(deliveryClass(null), 'unknown')
  const peers = resolvePeers(snapshot(), ['payments-fa'])
  assert.deepEqual(heldPeers(peers, 'default').map((p) => p.name), ['payments-fa'])
})

test('a peer in the other permission class is held', () => {
  const peers = resolvePeers(snapshot(), ['checkout-release'])
  assert.deepEqual(heldPeers(peers, 'bypassPermissions').map((p) => p.name), ['checkout-release'])
})

test('a peer in our own class is not', () => {
  const peers = resolvePeers(snapshot(), ['checkout-release'])
  assert.deepEqual(heldPeers(peers, 'default'), [])
})

test('the block names every peer and the project each one holds', () => {
  const block = rosterBlock(resolvePeers(snapshot(), ['payments-fa', 'checkout-release']))
  assert.match(block, /payments-fa — Payments/)
  assert.match(block, /checkout-release — Checkout/)
})

test('the block says nothing about who is busy, because that stops being true', () => {
  const block = rosterBlock(resolvePeers(snapshot(), ['checkout-release']))
  assert.doesNotMatch(block, /busy|idle/)
})

test('no peers means no paragraph, and the prompt is left exactly as typed', () => {
  assert.equal(rosterBlock([]), '')
  assert.equal(withRoster('do the thing', []), 'do the thing')
})

test('the briefing is separated from what the user typed', () => {
  const out = withRoster('do the thing', resolvePeers(snapshot(), ['payments-fa']))
  assert.ok(out.endsWith('---\n\ndo the thing'))
})
