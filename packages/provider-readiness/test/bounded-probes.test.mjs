import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProviderProbeService } from '../lib/service.js'
import { ProviderProbeStore } from '../lib/store.js'

async function setup(t, llm) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-bounded-probe-'))
  const store = new ProviderProbeStore(join(root, 'probes.json'))
  const service = new ProviderProbeService({ store, llm })
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }) })
  return { service, store }
}

async function settled(promise, limit = 1000) {
  let timer
  const result = await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve('unsettled'), limit) })])
  clearTimeout(timer)
  assert.notEqual(result, 'unsettled', 'probe must settle independently of provider cooperation')
  return result
}

test('deadline settles an uncooperative model-info promise and releases the service slot', async t => {
  let stalled = true
  const { service } = await setup(t, {
    resolveModelInfo() { return stalled ? new Promise(() => {}) : Promise.resolve({}) },
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  const result = await settled(service.probe({ provider: 'p', model: 'm', timeoutMs: 500 }))
  assert.equal(result.error.code, 'timeout')
  assert.equal(service.snapshot().running, undefined)
  stalled = false
  assert.equal((await service.probe({ provider: 'p', model: 'm', timeoutMs: 500 })).status, 'succeeded')
})

test('cancel settles uncooperative iteration and cleanup without letting late output overwrite a retry', async t => {
  let entered, late, first = true
  const gate = new Promise(resolve => { entered = resolve })
  const { service, store } = await setup(t, {
    async resolveModelInfo() { return {} },
    stream() {
      if (!first) return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
      first = false
      return { [Symbol.asyncIterator]() { return this }, next() { entered(); return new Promise(resolve => { late = resolve }) }, return() { return new Promise(() => {}) } }
    },
  })
  const pending = service.probe({ provider: 'p', model: 'm', timeoutMs: 5000 })
  await gate
  assert.equal(service.cancel(), true)
  assert.equal((await settled(pending, 250)).status, 'cancelled')
  const retried = await service.probe({ provider: 'p', model: 'm', timeoutMs: 500 })
  assert.equal(retried.status, 'succeeded')
  late({ done: false, value: { type: 'finish', reason: { kind: 'error', failure: { code: 'old' } } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(store.latest('p', 'm'), retried)
})
