import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginTransactionStore } from '../src/store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('plugin transaction store', () => {
  it('persists redacted, bounded immutable receipts without raw confirmation tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaoshe-plugin-store-'))
    roots.push(root)
    const path = join(root, 'transactions.json')
    const store = new PluginTransactionStore(path, { maxTransactions: 2 })

    for (let index = 1; index <= 3; index += 1) {
      await store.save({
        id: `tx-${index}`, action: 'add', profile: 'xiaoshe-managed-proof',
        packageName: `fixture-${index}`, version: '1.0.0', candidateSha256: 'a'.repeat(64),
        manifestSha256: 'b'.repeat(64), state: 'prepared', createdAt: index, updatedAt: index,
        consent: { challengeId: `challenge-${index}`, tokenSha256: 'c'.repeat(64), expiresAt: index + 1 },
        disclosures: ['trusted host code'], events: [],
      })
    }

    expect(store.list().map(row => row.id)).toEqual(['tx-3', 'tx-2'])
    expect(Object.isFrozen(store.list()[0])).toBe(true)
    const disk = await readFile(path, 'utf8')
    expect(disk).not.toContain('raw-secret-token')
    expect(JSON.parse(disk)).toMatchObject({ schemaVersion: 1, transactions: [{ id: 'tx-3' }, { id: 'tx-2' }] })
  })

  it('serializes concurrent updates and rejects unknown transaction ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaoshe-plugin-store-'))
    roots.push(root)
    const store = new PluginTransactionStore(join(root, 'transactions.json'))
    await store.save({
      id: 'tx-1', action: 'remove', profile: 'xiaoshe-managed-proof', packageName: 'fixture', version: '1.0.0',
      candidateSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), state: 'prepared', createdAt: 1, updatedAt: 1,
      consent: { challengeId: 'challenge', tokenSha256: 'c'.repeat(64), expiresAt: 2 }, disclosures: [], events: [],
    })
    await Promise.all([
      store.update('tx-1', row => ({ ...row, state: 'running', updatedAt: 2 })),
      store.update('tx-1', row => ({ ...row, events: [...row.events, { at: 3, kind: 'audit', message: 'serialized' }], updatedAt: 3 })),
    ])
    expect(store.list()).toHaveLength(1)
    await expect(store.update('missing', row => row)).rejects.toThrow(/unknown transaction/iu)
  })
})
