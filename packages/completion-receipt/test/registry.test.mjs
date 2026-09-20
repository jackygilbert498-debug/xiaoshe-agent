import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { register } from '../../../runtime/DSH/node_modules/tsx/dist/esm/api/index.mjs'
import { completionReceiptProjection } from '../lib/index.js'

register({ tsconfig: fileURLToPath(new URL('../../../runtime/DSH/tsconfig.base.json', import.meta.url)) })
const { Context } = await import('../../../runtime/DSH/vendor/cordis/src/index.ts')
const { SessionStore } = await import('../../../runtime/DSH/packages/core/session/src/index.ts')
const { SessionProjectionRegistry } = await import('../../../runtime/DSH/packages/session/session-projection/src/index.ts')
const { createToolResultMessage } = await import('../../../runtime/DSH/packages/llm/llm/src/index.ts')

test('v2 pending identity is null on the real wire and resumes old debt through a cached tail', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new SessionStore(ctx)
  const registry = new SessionProjectionRegistry(ctx); registry.register(completionReceiptProjection)
  const session = ctx.sessions.create('receipt-post-admission')
  const user = id => {
    session.append('user/message', { id, role: 'user', source: { kind: 'user' }, content: [] }, { surfaceOp: 'append' })
    return session.snapshotEvents().at(-1).seq
  }
  const marker = (id, seq, relation) => session.append('xiaoshe/task-generation', { version: 2, generation: 1, relation, triggerMessageId: id, triggerMessageSeq: seq })
  session.append('turn/start', { turn: 1 })
  marker('first', user('first'), 'new')
  session.append('tool/call', { turn: 1, step: 1, callId: 'write', name: 'write', arguments: '{"file_path":"src/a.ts","content":"changed"}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'write', content: [], isError: false }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  const triggerSeq = user('next')
  assert.equal(registry.snapshot(session).values.completionReceipt, null)
  const pending = registry.restore({}, session.snapshotEvents(), 0, session.header, 0)
  assert.equal(pending.snapshot.values.completionReceipt, null)
  const baseSeq = session.seq
  marker('next', triggerSeq, 'continuation')
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const live = registry.snapshot(session).values.completionReceipt
  const resumed = registry.restore(pending.checkpoint, session.snapshotEvents().slice(baseSeq), baseSeq, session.header, 0)
  assert.deepEqual(resumed.snapshot.values.completionReceipt, live)
  assert.equal(live.turn, 2); assert.equal(live.outcome, 'partial'); assert.equal(live.tools[0].callId, 'write')
})

test('real registry publishes live, restored and cached completion receipts on the V3 wire', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new SessionStore(ctx)
  const registry = new SessionProjectionRegistry(ctx)
  registry.register(completionReceiptProjection)
  const session = ctx.sessions.create('receipt-wire-fixture')
  session.append('turn/start', { turn: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: '{}' })
  const nested = { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'write', arguments: { file_path: 'src/fixture.ts', content: 'fixture' } }
  session.append('tool/ptc-dispatch-start', nested)
  session.append('tool/ptc-dispatch', { ...nested, isError: false, content: [] })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'root', content: [], isError: false }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const live = registry.snapshot(session).values.completionReceipt
  assert.equal(live?.turn, 1)
  assert.equal(live.tools.find(tool => tool.callId === 'root:ptc:1')?.status, 'succeeded')
  assert.equal(live.outcome, 'partial', 'a successful write is not independent verification')
  const restored = registry.restore({}, session.snapshotEvents(), 0, session.header, 0)
  assert.deepEqual(restored.snapshot.values.completionReceipt, live)
  const cached = registry.restore(restored.checkpoint, [], session.seq, session.header, 0)
  assert.deepEqual(cached.snapshot.values.completionReceipt, live)
  const obsolete = { completionReceipt: { ver: 20, seq: session.seq - 1, val: { forged: true } } }
  assert.deepEqual(registry.restore(obsolete, session.snapshotEvents(), 0, session.header, 0).snapshot.values.completionReceipt, live)
  const corrupt = structuredClone(restored.checkpoint)
  corrupt.completionReceipt.val.mutations = { forged: { requirements: ['invented'], results: [], targets: [] } }
  assert.throws(() => registry.restore(corrupt, [], session.seq, session.header, 0))
})
