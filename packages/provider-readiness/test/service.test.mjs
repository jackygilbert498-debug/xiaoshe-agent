import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProviderProbeService } from '../lib/service.js'
import { ProviderProbeStore } from '../lib/store.js'

async function fixture(llm) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-provider-service-'))
  const store = new ProviderProbeStore(join(root, 'probes.json'))
  return { store, service: new ProviderProbeService({ store, llm }) }
}

test('ProviderProbeService persists running and settled exact-route facts', async () => {
  const { store, service } = await fixture({
    async resolveModelInfo() { return { context: { contextWindow: 64_000 } } },
    async *stream() {
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  const result = await service.probe({ provider: 'p', model: 'm', timeoutMs: 2_000 })
  assert.equal(result.status, 'succeeded')
  assert.equal(store.latest('p', 'm').status, 'succeeded')
  assert.equal(service.snapshot().running, undefined)
})

test('ProviderProbeService allows one probe and supports explicit cancellation', async () => {
  let entered
  const gate = new Promise(resolve => { entered = resolve })
  const { service } = await fixture({
    async resolveModelInfo(_provider, _model, signal) {
      entered()
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
    async *stream() {},
  })
  const first = service.probe({ provider: 'p', model: 'm', timeoutMs: 2_000 })
  await gate
  await assert.rejects(() => service.probe({ provider: 'p2', model: 'm2', timeoutMs: 2_000 }), /already running/u)
  assert.equal(service.cancel(), true)
  assert.equal((await first).status, 'cancelled')
  assert.equal(service.cancel(), false)
})

test('ProviderProbeService recovers interrupted running records on startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-provider-recovery-'))
  const store = new ProviderProbeStore(join(root, 'probes.json'))
  await store.save({ status: 'running', provider: 'p', model: 'm', startedAt: 10, cost: { status: 'unavailable' } })
  const service = new ProviderProbeService({
    store,
    llm: { async resolveModelInfo() {}, async *stream() {} },
    now: () => 100,
  })
  await service.ready()
  const recovered = store.latest('p', 'm')
  assert.equal(recovered.status, 'failed')
  assert.equal(recovered.error.code, 'process_restarted')
})
