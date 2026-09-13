import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { SessionStore } from '../runtime/DSH/packages/core/session/lib/index.js'
import { readSessionEvents } from '../dist/session-events.js'

test('public Session snapshots remain readable and do not become a mutable event log', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new SessionStore(ctx)
  const session = ctx.sessions.create('snapshot-compatibility')
  assert.equal(session.events, undefined)
  const before = readSessionEvents(session)
  session.append('turn/start', { turn: 0 })
  const after = readSessionEvents(session)
  assert.equal(before.length + 1, after.length)
  assert.equal(after.at(-1).type, 'turn/start')
  assert.notEqual(before, after)
})

test('canonical snapshot wins over legacy history and errors are not hidden', () => {
  const old = [{ type: 'old' }]
  assert.deepEqual(readSessionEvents({ events: old }), old)
  assert.deepEqual(readSessionEvents({ events: old, snapshotEvents: () => [{ type: 'new' }] }), [{ type: 'new' }])
  assert.throws(() => readSessionEvents({ events: old, snapshotEvents() { throw new Error('unavailable') } }), /unavailable/)
  assert.deepEqual(readSessionEvents(undefined), [])
})
