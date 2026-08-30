import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProviderProbeStore } from '../lib/store.js'

function record(provider, model, completedAt) {
  return {
    status: 'succeeded', provider, model,
    startedAt: completedAt - 20, completedAt, latencyMs: 20,
    finishReason: 'stop',
    usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    cost: { status: 'unavailable' },
  }
}

test('ProviderProbeStore atomically keeps the newest exact-route record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-provider-probes-'))
  const path = join(root, 'probes.json')
  const store = new ProviderProbeStore(path, { maxRecords: 2 })

  await Promise.all([
    store.save(record('p', 'a', 100)),
    store.save(record('p', 'a', 200)),
    store.save(record('p', 'b', 300)),
  ])

  const rows = store.list()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].model, 'b')
  assert.equal(rows.find(row => row.model === 'a').completedAt, 200)
  assert.ok(Object.isFrozen(rows))
  const persisted = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(persisted.schemaVersion, 1)
})

test('ProviderProbeStore fails closed on an unreadable ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-provider-probes-bad-'))
  const path = join(root, 'probes.json')
  await writeFile(path, '{"schemaVersion":99,"records":[]}', 'utf8')

  assert.throws(() => new ProviderProbeStore(path), /ledger is unreadable/u)
})

test('ProviderProbeStore rejects relative paths and invalid limits', () => {
  assert.throws(() => new ProviderProbeStore('relative.json'), /absolute/u)
  assert.throws(() => new ProviderProbeStore('C:/absolute/probes.json', { maxRecords: 0 }), /between 1 and 1000/u)
})
