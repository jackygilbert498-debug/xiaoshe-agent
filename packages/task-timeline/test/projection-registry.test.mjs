import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../../../runtime/DSH/vendor/cordis/lib/index.js'
import { SessionStore } from '../../../runtime/DSH/packages/core/session/lib/index.js'
import { SessionProjectionRegistry } from '../../../runtime/DSH/packages/session/session-projection/lib/index.js'
import { createUserMessage } from '../../../runtime/DSH/packages/llm/llm/lib/index.js'
import { taskTimelineProjection } from '../lib/index.js'

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
