import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../../../runtime/DSH/vendor/cordis/lib/index.js'
import { SessionStore } from '../../../runtime/DSH/packages/core/session/lib/index.js'
import { SessionProjectionRegistry } from '../../../runtime/DSH/packages/session/session-projection/lib/index.js'
import { createUserMessage } from '../../../runtime/DSH/packages/llm/llm/lib/index.js'
import { taskTimelineProjection } from '../lib/index.js'

test('old failure checkpoint is replayed from durable cancellation instead of reused', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new SessionStore(ctx)
  const registry = new SessionProjectionRegistry(ctx)
  registry.register(taskTimelineProjection)
  const events = [
    { type: 'tool/call', seq: 0, time: 0, data: { name: 'pwsh', callId: 'cancelled' } },
    { type: 'tool/result', seq: 1, time: 1, data: { error: { name: 'AbortError', code: 'ABORTED' }, message: {
      source: { kind: 'tool', callId: 'cancelled' }, content: [{ type: 'tool-result', toolCallId: 'cancelled', content: [], isError: true }] } } },
  ]
  const old = { taskTimeline: { ver: 4, seq: 1, val: { value: { schemaVersion: 1, items: [
    { key: 'tool-result:1', seq: 1, time: 1, kind: 'tool', text: '失败 pwsh', isError: true },
  ] } } } }
  const restored = registry.restore(old, events, 0)
  assert.equal(restored.snapshot.values.taskTimeline.items[1].text, '已取消：pwsh')
  assert.notEqual(restored.snapshot.values.taskTimeline.items[1].isError, true)
  assert.deepEqual(registry.restore(restored.checkpoint, [], 2).snapshot.values, restored.snapshot.values)
})

test('real v3 registry exposes timeline snapshots and cold checkpoint views', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new SessionStore(ctx)
  const registry = new SessionProjectionRegistry(ctx)
  registry.register(taskTimelineProjection)
  const session = ctx.sessions.create('timeline-public-wire')
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'preserved history' }] }), { surfaceOp: 'append' })
  assert.equal(registry.snapshot(session).values.taskTimeline.items[0].text, 'preserved history')
  const restored = registry.restore({}, session.snapshotEvents(), 0)
  assert.equal(restored.snapshot.values.taskTimeline.items[0].text, 'preserved history')
  assert.equal(registry.viewCheckpoint(restored.checkpoint).taskTimeline.items[0].text, 'preserved history')
})
