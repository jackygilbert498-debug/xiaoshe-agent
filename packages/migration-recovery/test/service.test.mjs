import assert from 'node:assert/strict'
import test from 'node:test'

import { MigrationConflictError, MigrationRecoveryService } from '../lib/service.js'

function preview(overrides = {}) {
  return Object.freeze({
    bundlePath: 'C:\\migration', bundleHash: 'a'.repeat(64), mappings: [],
    sessions: [{ id: 's1', action: 'create' }], conflicts: [], ...overrides,
  })
}

test('MigrationRecoveryService binds a one-shot confirmation to previewed facts', async () => {
  const applied = []
  const value = preview()
  const service = new MigrationRecoveryService({
    exporter: { async exportTo() { throw new Error('not used') } },
    importer: { async preview() { return value }, async apply(input) { applied.push(input) } },
    now: () => 1_000,
    tokenFactory: () => 't'.repeat(32),
  })

  const challenge = await service.prepareImport({ bundlePath: value.bundlePath, mappings: [] })
  await assert.rejects(service.confirmImport({ challengeId: challenge.id, token: 'wrong' }), /does not match/u)
  await service.confirmImport({ challengeId: challenge.id, token: challenge.token })
  assert.deepEqual(applied, [value])
  await assert.rejects(service.confirmImport({ challengeId: challenge.id, token: challenge.token }), /unknown challenge/u)
})

test('MigrationRecoveryService refuses conflicts and expired confirmations', async () => {
  let now = 1_000
  const service = new MigrationRecoveryService({
    exporter: { async exportTo() { throw new Error('not used') } },
    importer: {
      async preview() { return preview() },
      async apply() { throw new Error('must not apply') },
    },
    now: () => now,
    tokenFactory: () => 'u'.repeat(32),
    confirmationTtlMs: 500,
  })
  const conflictService = new MigrationRecoveryService({
    exporter: { async exportTo() { throw new Error('not used') } },
    importer: {
      async preview() { return preview({ conflicts: [{ kind: 'path-unmapped', id: 's1', detail: 'C:\\old' }] }) },
      async apply() { throw new Error('must not apply') },
    },
  })
  await assert.rejects(conflictService.prepareImport({ bundlePath: 'C:\\migration', mappings: [] }), MigrationConflictError)

  const challenge = await service.prepareImport({ bundlePath: 'C:\\migration', mappings: [] })
  now = 2_000
  await assert.rejects(service.confirmImport({ challengeId: challenge.id, token: challenge.token }), /expired/u)
})

test('MigrationRecoveryService serializes mutations and reports safe status', async () => {
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const service = new MigrationRecoveryService({
    exporter: { async exportTo() { await waiting; return { schemaVersion: 1, product: 'xiaoshe', exportedAt: 1, files: [] } } },
    importer: { async preview() { return preview() }, async apply() {} },
    now: () => 5_000,
  })
  const running = service.exportTo('C:\\bundle')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.snapshot().state, 'exporting')
  await assert.rejects(service.exportTo('C:\\other'), /already running/u)
  release()
  await running
  assert.equal(service.snapshot().state, 'succeeded')
  assert.equal(service.snapshot().lastExport?.path, 'C:\\bundle')
})
