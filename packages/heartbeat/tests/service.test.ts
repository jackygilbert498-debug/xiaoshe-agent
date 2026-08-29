import { describe, expect, it } from 'vitest'
import { createHeartbeatService } from '../src/service.js'
import { memoryStore } from './fixture.js'

describe('heartbeat service v2', () => {
  it('keeps independent, sorted check records and records success only for the matching lease', async () => {
    let at = 1_000
    const store = memoryStore()
    const service = createHeartbeatService(store, { now: () => at })
    await service.ensureCheck({ id: 'z-check', intervalMs: 5_000 })
    await service.ensureCheck({ id: 'a-check', intervalMs: 1_000, activeHours: { startHour: 22, endHour: 6 } })

    expect(service.snapshot()).toMatchObject({
      schemaVersion: 2,
      checks: [
        { id: 'a-check', intervalMs: 1_000, failureCount: 0, status: 'idle' },
        { id: 'z-check', intervalMs: 5_000, failureCount: 0, status: 'idle' },
      ],
    })

    await service.acquire('a-check', 'lease-a')
    expect(service.snapshot().checks[0]).toMatchObject({ status: 'running', activeLease: { leaseId: 'lease-a' } })
    await expect(service.succeed('a-check', 'wrong')).rejects.toThrow('lease mismatch')
    at = 1_500
    await service.succeed('a-check', 'lease-a', 'readiness:ok')
    expect(service.snapshot().checks[0]).toMatchObject({
      status: 'healthy', lastSuccessAt: 1_500, lastEvidence: 'readiness:ok', failureCount: 0, nextRunAt: 2_500,
    })
    expect(service.snapshot().checks[1]).toMatchObject({ id: 'z-check', status: 'idle' })
    service.dispose()
  })

  it('validates ids, intervals and active hours', async () => {
    const service = createHeartbeatService(memoryStore())
    await expect(service.ensureCheck({ id: '../escape', intervalMs: 1_000 })).rejects.toThrow('check id')
    await expect(service.ensureCheck({ id: 'too-fast', intervalMs: 99 })).rejects.toThrow('intervalMs')
    await expect(service.ensureCheck({ id: 'bad-hours', intervalMs: 1_000, activeHours: { startHour: 4, endHour: 4 } })).rejects.toThrow('activeHours')
    await service.ensureCheck({ id: 'overnight', intervalMs: 1_000, activeHours: { startHour: 22, endHour: 6 } })
    service.dispose()
  })

  it('computes bounded exponential backoff and pauses one check without affecting another', async () => {
    let at = 2_000
    const service = createHeartbeatService(memoryStore(), { now: () => at })
    await service.ensureCheck({ id: 'a', intervalMs: 1_000 })
    await service.ensureCheck({ id: 'b', intervalMs: 1_000 })
    for (let failure = 1; failure <= 15; failure += 1) {
      const lease = `lease-${failure}`
      await service.acquire('a', lease)
      await service.fail('a', lease, 'timeout')
      const check = service.snapshot().checks.find(row => row.id === 'a')
      expect(check?.failureCount).toBe(failure)
      expect((check?.nextRunAt ?? at) - at).toBeLessThanOrEqual(3_600_000)
      at = check?.nextRunAt ?? at
    }
    await service.pause('a', 'operator pause')
    expect(service.snapshot().checks.find(row => row.id === 'a')).toMatchObject({ status: 'paused', pauseReason: 'operator pause' })
    expect(service.snapshot().checks.find(row => row.id === 'b')).toMatchObject({ status: 'idle' })
    await service.resume('a')
    expect(service.snapshot().checks.find(row => row.id === 'a')?.pauseReason).toBeUndefined()
    service.dispose()
  })

  it('releases the settings watcher on dispose', async () => {
    const store = memoryStore()
    const service = createHeartbeatService(store)
    await service.ensureCheck({ id: 'runtime', intervalMs: 1_000 })
    expect(store.watcherCount()).toBe(1)
    service.dispose()
    expect(store.watcherCount()).toBe(0)
    await expect(service.ensureCheck({ id: 'later', intervalMs: 1_000 })).rejects.toThrow('disposed')
  })
})
