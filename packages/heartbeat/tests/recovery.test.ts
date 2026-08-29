import { describe, expect, it } from 'vitest'
import { parseHeartbeatState } from '../src/schema.js'
import { createHeartbeatService } from '../src/service.js'
import { memoryStore } from './fixture.js'

describe('heartbeat persistence recovery', () => {
  it('migrates an empty v1 ledger without inventing a check', () => {
    expect(parseHeartbeatState({ failureCount: 0 })).toEqual({ schemaVersion: 2, checks: [] })
  })

  it('migrates the prior single lease and turns it into interrupted/backoff evidence', async () => {
    const store = memoryStore({
      schemaVersion: 1,
      activeLease: { leaseId: 'old-run', task: 'private label', acquiredAt: 10, lastHeartbeatAt: 20, expectedEveryMs: 2_000 },
      failureCount: 2,
      lastEvidence: 'old.log',
    })
    const service = createHeartbeatService(store, { now: () => 10_000 })
    expect(service.snapshot().checks[0]).toMatchObject({
      id: 'xiaoshe-product-runtime', activeLease: { leaseId: 'old-run' }, failureCount: 2,
    })
    await expect(service.recoverInterruptedLeases()).resolves.toEqual(['xiaoshe-product-runtime'])
    expect(service.snapshot().checks[0]).toMatchObject({
      status: 'backoff', failureCount: 3, lastFailureAt: 10_000,
      lastFailure: 'interrupted by process restart', nextRunAt: 70_000,
    })
    expect(service.snapshot().checks[0]?.activeLease).toBeUndefined()
    expect(store.raw()).toMatchObject({ schemaVersion: 2, checks: [{ id: 'xiaoshe-product-runtime' }] })
    service.dispose()
  })

  it('recovers every active v2 lease independently', async () => {
    const store = memoryStore({
      schemaVersion: 2,
      checks: [
        { id: 'a', intervalMs: 1_000, failureCount: 0, activeLease: { leaseId: 'a1', acquiredAt: 1, lastHeartbeatAt: 1 } },
        { id: 'b', intervalMs: 2_000, failureCount: 4, activeLease: { leaseId: 'b1', acquiredAt: 1, lastHeartbeatAt: 1 } },
        { id: 'c', intervalMs: 3_000, failureCount: 0 },
      ],
    })
    const service = createHeartbeatService(store, { now: () => 5_000 })
    await expect(service.recoverInterruptedLeases()).resolves.toEqual(['a', 'b'])
    expect(service.snapshot().checks.map(check => [check.id, check.failureCount, check.status])).toEqual([
      ['a', 1, 'backoff'], ['b', 5, 'backoff'], ['c', 0, 'idle'],
    ])
    service.dispose()
  })

  it('rejects unknown persisted fields instead of silently trusting them', () => {
    expect(() => parseHeartbeatState({ schemaVersion: 2, checks: [], surprise: true })).toThrow('Unknown heartbeat state field')
    expect(() => parseHeartbeatState({ schemaVersion: 2, checks: [{ id: 'a', intervalMs: 1_000, failureCount: 0, secret: 'x' }] })).toThrow('Unknown heartbeat check field')
  })
})
