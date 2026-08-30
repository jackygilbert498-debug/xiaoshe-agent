import { createHeartbeatCoordinator, type HeartbeatCoordinator } from './coordinator.js'
import { registerHeartbeatHttpRoute, type HeartbeatWebServer } from './http.js'
import { heartbeatSettingsSchema } from './schema.js'
import { createHeartbeatService, type HeartbeatStore } from './service.js'

interface JobRegistryLike {
  attachController(name: string): () => void
  start(spec: {
    readonly kind: string
    readonly label: string
    readonly owner?: unknown
    run(): {
      cancel(reason?: string): void
      done: Promise<{ readonly status: 'completed' | 'killed' | 'failed'; readonly detail?: string; readonly output?: string }>
    }
  }): string
  kill(id: string, caller?: unknown, reason?: string): 'requested' | 'already-finished'
}

interface HeartbeatHostContext {
  readonly settings: {
    register(namespace: string, schema: unknown, options: { readonly base: Record<string, unknown>; readonly applies: 'live' }): HeartbeatStore
  }
  readonly webServer: HeartbeatWebServer
  readonly jobs: JobRegistryLike
  readonly xiaosheVerificationPolicy: unknown
  get?(name: string): unknown
  provide(name: string, value: unknown): unknown
  effect(execute: () => (() => void | Promise<void>), label?: string): unknown
  readonly logger?: { error(message: string): void }
}

export const name = 'xiaoshe-heartbeat'
export const inject = ['settings', 'webServer', 'jobs', 'xiaosheVerificationPolicy']

/** Mount the durable ledger, DSH Jobs coordinator, readiness check and guarded Product API. */
export function apply(ctx: HeartbeatHostContext): void {
  const store = ctx.settings.register('xiaoshe-heartbeat', heartbeatSettingsSchema, {
    base: { schemaVersion: 2, checks: [] },
    applies: 'live',
  })
  const service = createHeartbeatService(store)
  const coordinator = createHeartbeatCoordinator(service, ctx.jobs)
  coordinator.register({
    id: 'xiaoshe-product-runtime',
    intervalMs: 5 * 60 * 1_000,
    async run(signal) {
      // Keep the Job observably running for one short turn without external I/O;
      // this also proves cancellation and settlement pass through DSH Jobs.
      await abortableDelay(2_000, signal)
      const missing = requiredRuntimeServices(ctx).filter(serviceName => ctx.get?.(serviceName) === undefined)
      if (missing.length > 0) throw new Error(`required Product services are unavailable: ${missing.join(', ')}`)
      return { summary: 'Product runtime services are ready', evidence: 'runtime-readiness:v1' }
    },
  })
  ctx.provide('xiaosheHeartbeat', { service, coordinator })
  ctx.effect(
    () => registerHeartbeatHttpRoute(ctx.webServer, service, coordinator),
    'xiaoshe-heartbeat: guarded control route',
  )
  ctx.effect(() => {
    const started = coordinator.start()
    void started.catch((error: unknown) => {
      ctx.logger?.error(`xiaoshe heartbeat failed to start: ${safeMessage(error)}`)
    })
    return async () => {
      await started.catch(() => undefined)
      await coordinator.dispose()
      service.dispose()
    }
  }, 'xiaoshe-heartbeat: DSH Jobs lifecycle')
}

function requiredRuntimeServices(_coordinatorContext: HeartbeatHostContext): readonly string[] {
  return ['jobs', 'settings', 'webServer', 'sessionProjections', 'xiaosheVerificationPolicy', 'xiaosheMemory']
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('runtime readiness check aborted')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('runtime readiness check aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export { createHeartbeatCoordinator, createHeartbeatService, heartbeatSettingsSchema }
export type { HeartbeatCoordinator }
export * from './coordinator.js'
export * from './http.js'
export * from './schema.js'
export * from './service.js'
