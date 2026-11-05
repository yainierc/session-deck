/**
 * How a session is asked to think, and the one rule that guards it: nothing
 * reaches the CLI that this file did not recognise.
 *
 * `presets.json` is a file somebody can open and type into, and a launch
 * arrives over a socket from a browser. Both are places where a wrong value
 * has to become "the default" rather than a string handed to a subprocess, and
 * both go through here, which is why the allowlist lives in one module instead
 * of a copy in each.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanModel, cleanEffort, cleanAdvisor, spawnSettings, advisorFor } from '../src/choices.js'

test('a model is shape-checked, because the real list is not ours to hold', () => {
  /*
   * Which models exist is answered by the CLI per folder — it depends on what
   * the account has access to and on what the organisation allows. An
   * allowlist here would be a second, wrong copy of that answer, and the way
   * it would be wrong is by hiding a model somebody actually has.
   */
  assert.equal(cleanModel('opus'), 'opus', 'an alias')
  assert.equal(cleanModel('sonnet'), 'sonnet')
  assert.equal(cleanModel('claude-fable-5-1[1m]'), 'claude-fable-5-1[1m]', 'a full id, brackets and all')

  // What it does refuse is anything that is not shaped like a model name.
  assert.equal(cleanModel('--dangerously-skip-permissions'), null, 'never something flag-shaped')
  assert.equal(cleanModel('opus; rm -rf /'), null)
  assert.equal(cleanModel('a'.repeat(200)), null)
  assert.equal(cleanModel(''), null)
  assert.equal(cleanModel(undefined), null)

  // Effort is different: these five are the SDK's own and are not per-account.
  assert.equal(cleanEffort('xhigh'), 'xhigh')
  assert.equal(cleanEffort('max'), 'max')
  assert.equal(cleanEffort('extreme'), null)
  assert.equal(cleanEffort(null), null)
})

test('Fable advises Fable, and everything else is advised by Opus', () => {
  // Not a preference. A Fable session refuses an Opus advisor outright, and
  // the refusal is silent, so picking the wrong one means no advisor and no
  // error to show for it.
  assert.equal(advisorFor('claude-fable-5-1[1m]'), 'fable')
  assert.equal(advisorFor('fable'), 'fable')
  assert.equal(advisorFor('sonnet'), 'opus')
  assert.equal(advisorFor('claude-opus-5'), 'opus')
  assert.equal(advisorFor(null), 'opus')
})

test('the advisor arrives as a yes from a browser and as a model from disk', () => {
  // What the form asks is a yes or a no; the rule for turning that into a
  // model lives here so no caller has to know the pairing table.
  assert.equal(cleanAdvisor(true, 'sonnet'), advisorFor('sonnet'))
  assert.equal(cleanAdvisor(true, null), 'opus')
  assert.equal(cleanAdvisor(false, 'sonnet'), null)

  // What the handoff file stores is the model that yes resolved to.
  assert.equal(cleanAdvisor('opus', 'sonnet'), 'opus')

  assert.equal(cleanAdvisor('fable', 'claude-fable-5-1'), 'fable')

  // And anything this deck would not itself have chosen is no advisor rather
  // than a string passed on.
  assert.equal(cleanAdvisor('claude-opus-5', 'sonnet'), null)
  assert.equal(cleanAdvisor('yes', 'sonnet'), null)
  assert.equal(cleanAdvisor(undefined, 'sonnet'), null)
})

test('nothing to say means no settings key at all', () => {
  // The difference matters at the call site: an empty object would still be a
  // settings layer, and the point is to leave the key off entirely.
  assert.equal(spawnSettings({}), null)
  assert.equal(spawnSettings({ effort: 'nonsense' }), null)
  assert.equal(spawnSettings({ effort: null, advisor: null }), null)

  assert.deepEqual(spawnSettings({ effort: 'high' }), { effortLevel: 'high' })
  assert.deepEqual(spawnSettings({ advisor: 'opus' }), { advisorModel: 'opus' })
  assert.deepEqual(
    spawnSettings({ effort: 'low', advisor: 'opus' }),
    { effortLevel: 'low', advisorModel: 'opus' },
  )
})
