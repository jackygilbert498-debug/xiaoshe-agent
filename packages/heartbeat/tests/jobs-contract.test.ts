import { describe, expect, it } from 'vitest'
import { createHeartbeatCoordinator } from '../src/coordinator.js'
import { createHeartbeatService } from '../src/service.js'
import { memoryStore } from './fixture.js'
import { fakeJobs, flush } from './jobs-fixture.js'

describe('DSH JobRegistry public boundary', () => {
  it('attaches a controller before start and exposes only an unowned redacted job', async () => {
    const jobs = fakeJobs()
    const service = createHeartbeatService(memoryStore())
    const coordinator = createHeartbeatCoordinator(service, jobs)
    coordinator.register({ id: 'runtime-ready', intervalMs: 1_000, run: async () => ({ summary: 'private summary', evidence: 'C:/private/evidence.json' }) })
    await coordinator.start()
    await coordinator.runNow('runtime-ready')
    await flush()

    expect(jobs.events[0]).toBe('attach:xiaoshe-heartbeat')
    expect(jobs.events[1]).toBe('start:Xiaoshe check runtime-ready')
    expect(JSON.stringify(jobs.events)).not.toContain('private summary')
    expect(JSON.stringify(jobs.events)).not.toContain('C:/private')
    await coordinator.dispose()
    service.dispose()
  })
})
