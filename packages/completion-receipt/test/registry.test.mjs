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
