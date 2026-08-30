import { validateActiveHours, validateCheckId, validateHeartbeatInterval, type HeartbeatActiveHours } from './schema.js'
import type { HeartbeatCheckState, HeartbeatService } from './service.js'

export interface HeartbeatCheckDefinition {
  readonly id: string
  readonly intervalMs: number
  readonly activeHours?: HeartbeatActiveHours
  run(signal: AbortSignal): Promise<{ readonly summary: string; readonly evidence?: string }>
}

interface JobOutcome {
  readonly status: 'completed' | 'killed' | 'failed'
  readonly detail?: string
  readonly output?: string
}

interface JobRegistryPort {
  attachController(name: string): () => void
  start(spec: {
    readonly kind: string
    readonly label: string
    readonly owner?: unknown
    run(): { cancel(reason?: string): void; done: Promise<JobOutcome> }
  }): string
  kill(id: string, caller?: unknown, reason?: string): 'requested' | 'already-finished'
}

export interface HeartbeatCoordinator {
  register(definition: HeartbeatCheckDefinition): () => void
  runNow(id: string): Promise<{ readonly jobId: string }>
  pause(id: string, reason: string): Promise<void>
  resume(id: string): Promise<void>
  start(): Promise<void>
  dispose(): Promise<void>
}

interface ActiveRun {
  readonly jobId: string
  readonly leaseId: string
  readonly done: Promise<JobOutcome>
  readonly settled: Promise<void>
}

const MAX_TIMER_DELAY_MS = 2_147_000_000
const MAX_SUMMARY_LENGTH = 512
const MAX_EVIDENCE_LENGTH = 2_048

/** Coordinate persistent checks through the public DSH JobRegistry lifecycle. */
export function createHeartbeatCoordinator(
  service: HeartbeatService,
  jobs: JobRegistryPort,
  options: {
    readonly now?: () => number
    readonly setTimer?: typeof setTimeout
    readonly clearTimer?: typeof clearTimeout
  } = {},
): HeartbeatCoordinator {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const definitions = new Map<string, HeartbeatCheckDefinition>()
  const active = new Map<string, ActiveRun>()
  let registrationQueue: Promise<void> = Promise.resolve()
  let detachController: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let leaseCounter = 0
  let started = false
  let starting: Promise<void> | undefined
  let disposed = false

  const coordinator: HeartbeatCoordinator = {
    register(definition) {
      assertDefinition(definition)
      if (disposed) throw new Error('heartbeat coordinator is disposed')
      if (definitions.has(definition.id)) throw new Error(`heartbeat check already registered: ${definition.id}`)
      definitions.set(definition.id, definition)
      registrationQueue = registrationQueue.then(async () => {
        if (!definitions.has(definition.id) || disposed) return
        await service.ensureCheck({
          id: definition.id,
          intervalMs: definition.intervalMs,
          ...(definition.activeHours === undefined ? {} : { activeHours: definition.activeHours }),
        })
        schedule()
      })
      let registered = true
      return () => {
        if (!registered) return
        registered = false
        definitions.delete(definition.id)
        schedule()
      }
    },
    async runNow(id) {
      await assertReady()
      await registrationQueue
      const definition = definitions.get(id)
      if (definition === undefined) throw new Error(`unknown heartbeat check: ${id}`)
      const persisted = service.snapshot().checks.find(check => check.id === id)
      if (active.has(id) || persisted?.activeLease !== undefined) throw new Error(`heartbeat check is already running: ${id}`)
      if (persisted?.pauseReason !== undefined) throw new Error(`heartbeat check is paused: ${id}`)
      return await launch(definition)
    },
    async pause(id, reason) {
      await assertReady()
      await registrationQueue
      if (!definitions.has(id)) throw new Error(`unknown heartbeat check: ${id}`)
      await service.pause(id, reason)
      const running = active.get(id)
      if (running !== undefined) {
        jobs.kill(running.jobId, undefined, 'heartbeat check paused')
        await running.settled
      }
      schedule()
    },
    async resume(id) {
      await assertReady()
      await registrationQueue
      if (!definitions.has(id)) throw new Error(`unknown heartbeat check: ${id}`)
      await service.resume(id)
      schedule()
    },
    async start() {
      if (disposed) throw new Error('heartbeat coordinator is disposed')
      if (started) return
      if (starting !== undefined) return await starting
      const pending = startCoordinator()
      starting = pending
      try {
        await pending
      } finally {
        if (starting === pending) starting = undefined
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      started = false
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
      unsubscribe?.()
      unsubscribe = undefined
      const owned = [...active.values()]
      for (const run of owned) {
        try { jobs.kill(run.jobId, undefined, 'heartbeat coordinator disposed') } catch { /* Settlement still owns the durable result. */ }
      }
      await Promise.allSettled(owned.map(run => run.settled))
      detachController?.()
      detachController = undefined
      definitions.clear()
    },
  }

  return coordinator

  async function startCoordinator(): Promise<void> {
    detachController = jobs.attachController('xiaoshe-heartbeat')
    try {
      await registrationQueue
      if (disposed) return
      await service.recoverInterruptedLeases()
      if (disposed) return
      unsubscribe = service.subscribe(schedule)
      started = true
      schedule()
    } catch (error: unknown) {
      detachController?.()
      detachController = undefined
      throw error
    }
  }

  async function launch(definition: HeartbeatCheckDefinition): Promise<{ readonly jobId: string }> {
    const leaseId = `heartbeat-${definition.id}-${now()}-${++leaseCounter}`
    await service.acquire(definition.id, leaseId)
    let done: Promise<JobOutcome> | undefined
    let evidence: string | undefined
    let failureReason = 'heartbeat job failed'
    let jobId: string
    try {
      jobId = jobs.start({
        kind: 'xiaoshe-heartbeat',
        label: `Xiaoshe check ${definition.id}`,
        run() {
          const controller = new AbortController()
          done = Promise.resolve().then(async () => {
            try {
              if (controller.signal.aborted) throw new Error('aborted before start')
              const result = await definition.run(controller.signal)
              validateRunResult(result)
              evidence = result.evidence
              return {
                status: 'completed' as const,
                detail: 'check completed',
                output: `Xiaoshe check ${definition.id} completed`,
              }
            } catch (error: unknown) {
              failureReason = safeError(error)
              return {
                status: controller.signal.aborted ? 'killed' as const : 'failed' as const,
                detail: controller.signal.aborted ? 'check cancelled' : 'check failed',
                output: `Xiaoshe check ${definition.id} did not complete`,
              }
            }
          })
          return {
            cancel: () => controller.abort(),
            done,
          }
        },
      })
    } catch (error: unknown) {
      await service.fail(definition.id, leaseId, `job start failed: ${safeError(error)}`)
      schedule()
      throw error
    }
    if (done === undefined) {
      await service.fail(definition.id, leaseId, 'job registry did not invoke the heartbeat starter')
      schedule()
      throw new Error('DSH JobRegistry did not invoke heartbeat run()')
    }
    const outcomePromise = done
    let settled!: Promise<void>
    settled = outcomePromise.then(async (outcome) => {
      try {
        if (outcome.status === 'completed') await service.succeed(definition.id, leaseId, evidence)
        else await service.fail(definition.id, leaseId, outcome.status === 'killed' ? 'job cancelled' : failureReason)
      } finally {
        if (active.get(definition.id)?.settled === settled) active.delete(definition.id)
        schedule()
      }
    })
    active.set(definition.id, { jobId, leaseId, done: outcomePromise, settled })
    schedule()
    return { jobId }
  }

  async function assertReady(): Promise<void> {
    if (disposed) throw new Error('heartbeat coordinator is disposed')
    // The HTTP route can become reachable in the same host turn that starts
    // durable recovery. Controls arriving in that narrow window must join the
    // one startup promise instead of exposing a transient 500 to the operator.
    if (!started && starting !== undefined) await starting
    if (disposed) throw new Error('heartbeat coordinator is disposed')
    if (!started) throw new Error('heartbeat coordinator has not started')
  }

  function schedule(): void {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    if (!started || disposed) return
    const at = now()
    const eligible = service.snapshot().checks
      .filter(check => definitions.has(check.id) && check.pauseReason === undefined && check.activeLease === undefined)
      .map(check => nextEligibleAt(check, at))
      .filter((value): value is number => value !== undefined)
    if (eligible.length === 0) return
    const delay = Math.min(Math.max(0, Math.min(...eligible) - at), MAX_TIMER_DELAY_MS)
    timer = setTimer(() => {
      timer = undefined
      void tick()
    }, delay)
    timer.unref?.()
  }

  async function tick(): Promise<void> {
    if (!started || disposed) return
    const at = now()
    const due = service.snapshot().checks.filter(check => {
      if (!definitions.has(check.id) || check.pauseReason !== undefined || check.activeLease !== undefined) return false
      const dueAt = check.nextRunAt ?? at + check.intervalMs
      return dueAt <= at && isWithinActiveHours(check.activeHours, at)
    })
    for (const check of due) {
      try { await coordinator.runNow(check.id) } catch { /* Durable failure/conflict state is already authoritative. */ }
    }
    schedule()
  }
}

function assertDefinition(definition: HeartbeatCheckDefinition): void {
  validateCheckId(definition.id)
  validateHeartbeatInterval(definition.intervalMs)
  if (definition.activeHours !== undefined) validateActiveHours(definition.activeHours)
  if (typeof definition.run !== 'function') throw new TypeError('heartbeat check run must be a function')
}

function validateRunResult(value: { readonly summary: string; readonly evidence?: string }): void {
  if (typeof value !== 'object' || value === null || typeof value.summary !== 'string'
    || value.summary.trim() === '' || value.summary.length > MAX_SUMMARY_LENGTH) {
    throw new TypeError(`heartbeat summary must contain 1 to ${MAX_SUMMARY_LENGTH} characters`)
  }
  if (value.evidence !== undefined && (typeof value.evidence !== 'string'
    || value.evidence.trim() === '' || value.evidence.length > MAX_EVIDENCE_LENGTH)) {
    throw new TypeError(`heartbeat evidence must contain 1 to ${MAX_EVIDENCE_LENGTH} characters`)
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) || 'unknown heartbeat failure'
}

function nextEligibleAt(check: HeartbeatCheckState, at: number): number | undefined {
  const dueAt = check.nextRunAt ?? at + check.intervalMs
  if (isWithinActiveHours(check.activeHours, Math.max(at, dueAt))) return dueAt
  return nextActiveStart(check.activeHours, Math.max(at, dueAt))
}

function isWithinActiveHours(hours: HeartbeatActiveHours | undefined, at: number): boolean {
  if (hours === undefined) return true
  const hour = new Date(at).getHours()
  return hours.startHour < hours.endHour
    ? hour >= hours.startHour && hour < hours.endHour
    : hour >= hours.startHour || hour < hours.endHour
}

function nextActiveStart(hours: HeartbeatActiveHours | undefined, at: number): number {
  if (hours === undefined) return at
  const candidate = new Date(at)
  candidate.setMinutes(0, 0, 0)
  candidate.setHours(hours.startHour)
  if (candidate.getTime() <= at) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}
