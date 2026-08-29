import { describe, expect, it, vi } from 'vitest'
import { createHeartbeatCoordinator } from '../src/coordinator.js'
import { createHeartbeatService } from '../src/service.js'
import { memoryStore } from './fixture.js'
import { deferred, fakeJobs, flush } from './jobs-fixture.js'

describe('heartbeat DSH Jobs coordinator', () => {
  it('commits DSH Job completion before heartbeat success', async () => {
    const jobs = fakeJobs()
    const store = memoryStore()
    const service = createHeartbeatService(store, { now: () => 1_000 })
    const run = deferred<{ summary: string; evidence?: string }>()
    const observedService = {
      ...service,
      async succeed(...args: Parameters<typeof service.succeed>) {
        jobs.events.push('heartbeat:succeeded')
        await service.succeed(...args)
      },
    }
    const coordinator = createHeartbeatCoordinator(observedService, jobs)
    coordinator.register({ id: 'runtime', intervalMs: 60_000, run: () => run.promise })
    await coordinator.start()

    const { jobId } = await coordinator.runNow('runtime')
    expect(jobId).toBe('xiaoshe-heartbeat-1')
    expect(service.snapshot().checks[0]).toMatchObject({ status: 'running' })
    run.resolve({ summary: 'ready', evidence: 'probe:runtime-ready' })
    await flush()

    expect(jobs.events.indexOf('job:completed')).toBeLessThan(jobs.events.indexOf('heartbeat:succeeded'))
    expect(service.snapshot().checks[0]).toMatchObject({
      status: 'healthy', failureCount: 0, lastEvidence: 'probe:runtime-ready',
    })
    await coordinator.dispose()
    service.dispose()
  })

  it('records failed jobs as backoff and never starts a duplicate active lease', async () => {
    const jobs = fakeJobs()
    const service = createHeartbeatService(memoryStore(), { now: () => 2_000 })
    const run = deferred<{ summary: string }>()
    const coordinator = createHeartbeatCoordinator(service, jobs)
    coordinator.register({ id: 'runtime', intervalMs: 10_000, run: () => run.promise })
    await coordinator.start()
    await coordinator.runNow('runtime')
    await expect(coordinator.runNow('runtime')).rejects.toThrow('already running')
    run.reject(new Error('private path C:/secret'))
    await flush()
    expect(service.snapshot().checks[0]).toMatchObject({ status: 'backoff', failureCount: 1 })
    expect(service.snapshot().checks[0]?.lastFailure).toContain('private path')
    await coordinator.dispose()
    service.dispose()
  })

  it('aborts through jobs.kill and dispose waits for owned runs to settle', async () => {
    const jobs = fakeJobs()
    const service = createHeartbeatService(memoryStore())
    let aborted = false
    const coordinator = createHeartbeatCoordinator(service, jobs)
    coordinator.register({
      id: 'runtime',
      intervalMs: 10_000,
      run: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
      }),
    })
    await coordinator.start()
    await coordinator.runNow('runtime')
    await coordinator.dispose()
    expect(aborted).toBe(true)
    expect(jobs.events).toContain('job:killed')
    expect(jobs.events.at(-1)).toBe('detach:xiaoshe-heartbeat')
    service.dispose()
  })

  it('uses one bounded timer for due checks and clears it on dispose', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const jobs = fakeJobs()
    const service = createHeartbeatService(memoryStore(), { now: Date.now })
    const coordinator = createHeartbeatCoordinator(service, jobs, { now: Date.now })
    coordinator.register({ id: 'runtime', intervalMs: 1_000, run: async () => ({ summary: 'ok' }) })
    await coordinator.start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    expect(jobs.list().length).toBe(1)
    await coordinator.dispose()
    expect(vi.getTimerCount()).toBe(0)
    service.dispose()
    vi.useRealTimers()
  })

  it('retries only transient settings writer-lock contention across durable mutations', async () => {
    const jobs = fakeJobs()
    const backing = memoryStore()
    let updateAttempts = 0
    const transient = 'atomic-write: timed out waiting for the writer lock at C:/proof/settings.yaml.lock'
    const flakyStore = {
      ...backing,
      async update(patch: Record<string, unknown>) {
        updateAttempts += 1
        if (updateAttempts === 1 || updateAttempts === 3) throw new Error(transient)
        await backing.update(patch)
      },
    }
    const delays: number[] = []
    const service = createHeartbeatService(flakyStore, {
      sleep: async milliseconds => { delays.push(milliseconds) },
    })
    const coordinator = createHeartbeatCoordinator(service, jobs)
    coordinator.register({ id: 'runtime', intervalMs: 60_000, run: async () => ({ summary: 'ready' }) })

    await coordinator.start()
    await expect(coordinator.runNow('runtime')).resolves.toMatchObject({ jobId: 'xiaoshe-heartbeat-1' })
    // Four ordinary coordinator writes plus the two deliberately injected retries.
    expect({ updateAttempts, delays }).toEqual({ updateAttempts: 6, delays: [50, 50] })
    await flush()
    await coordinator.dispose()
    service.dispose()
  })

  it('waits for an in-flight startup before accepting a manual run', async () => {
    const jobs = fakeJobs()
    const backing = memoryStore()
    const startupGate = deferred<void>()
    let firstUpdate = true
    const service = createHeartbeatService({
      ...backing,
      async update(patch: Record<string, unknown>) {
        if (firstUpdate) {
          firstUpdate = false
          await startupGate.promise
        }
        await backing.update(patch)
      },
    })
    const coordinator = createHeartbeatCoordinator(service, jobs)
    coordinator.register({ id: 'runtime', intervalMs: 60_000, run: async () => ({ summary: 'ready' }) })

    const starting = coordinator.start()
    const manualRun = coordinator.runNow('runtime').then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )
    await Promise.resolve()
    expect(jobs.list()).toHaveLength(0)

    startupGate.resolve()
    await starting
    await expect(manualRun).resolves.toMatchObject({
      status: 'fulfilled',
      value: { jobId: 'xiaoshe-heartbeat-1' },
    })
    await flush()
    await coordinator.dispose()
    service.dispose()
  })

  it('does not retry unrelated startup failures', async () => {
    const jobs = fakeJobs()
    const backing = memoryStore()
    let attempts = 0
    const service = createHeartbeatService({
      ...backing,
      async update() { attempts += 1; throw new Error('settings schema is invalid') },
    }, { sleep: async () => { throw new Error('sleep must not run') } })
    const coordinator = createHeartbeatCoordinator(service, jobs)
    coordinator.register({ id: 'runtime', intervalMs: 60_000, run: async () => ({ summary: 'ready' }) })

    await expect(coordinator.start()).rejects.toThrow('settings schema is invalid')
    expect(attempts).toBe(1)
    await coordinator.dispose()
    service.dispose()
  })
})
