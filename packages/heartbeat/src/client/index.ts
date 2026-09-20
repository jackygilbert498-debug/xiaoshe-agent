import type {
  ProductDesktopDiagnostic,
  ProductHealth,
  ProductHealthSnapshot,
  ProductHealthSourceError,
  ProductHealthValue,
  ProductHeartbeatCheck,
  ProductHeartbeatSnapshot,
} from '@xiaoshe/runtime-contract'

const HEARTBEAT_API_PATH = '/api/xiaoshe/heartbeat'
const DESKTOP_STATUS_PATH = '/xiaoshe/desktop/status'
const MAX_RESPONSE_BYTES = 256 * 1024
const HEALTH_REQUEST_TIMEOUT_MS = 5_000
const HEARTBEAT_STATUSES = new Set(['idle', 'running', 'healthy', 'delayed', 'lost', 'paused', 'backoff'])
const DEGRADED_HEARTBEAT_STATUSES = new Set(['delayed', 'lost', 'backoff'])

export type ProductHealthFetch = (input: string, init?: RequestInit) => Promise<Response>

class ProductHealthRequestError extends Error {
  readonly name = 'ProductHealthRequestError'
  constructor(readonly status: number, readonly kind: string | undefined, message: string) { super(message) }
}

class ProductHealthTimeoutError extends Error {
  readonly name = 'ProductHealthTimeoutError'
  constructor() { super('后台健康检查超时（5 秒），连接状态尚未确认。') }
}

/**
 * Browser-independent aggregate over the heartbeat and desktop diagnostic
 * providers. Each source remains independently attributable on partial failure.
 */
export class ProductHealthProvider implements ProductHealth {
  private readonly listeners = new Set<() => void>()
  private snapshot: ProductHealthSnapshot = Object.freeze({ status: 'idle' })
  private controller: AbortController | undefined
  private generation = 0
  private disposed = false

  constructor(private readonly fetcher: ProductHealthFetch = (input, init) => globalThis.fetch(input, init)) {}

  getSnapshot(): ProductHealthSnapshot { return this.snapshot }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async refresh(): Promise<ProductHealthSnapshot> {
    if (this.disposed) throw new Error('productHealth is disposed')
    const generation = ++this.generation
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    const previous = healthValue(this.snapshot)
    this.publish(freezeSnapshot({ status: 'loading', ...(previous === undefined ? {} : { value: previous }) }))

    // This deadline owns only the two read-only probes, never the user's Agent turn.
    const deadline = setTimeout(() => controller.abort(new ProductHealthTimeoutError()), HEALTH_REQUEST_TIMEOUT_MS)
    const [heartbeatResult, desktopResult] = await Promise.allSettled([
      this.request(HEARTBEAT_API_PATH, controller.signal, parseHeartbeatSnapshot),
      this.request(DESKTOP_STATUS_PATH, controller.signal, parseDesktopDiagnostic),
    ]).finally(() => clearTimeout(deadline))
    if (this.disposed || generation !== this.generation) return this.snapshot

    const value: ProductHealthValue = {
      ...(previous?.heartbeat === undefined ? {} : { heartbeat: previous.heartbeat }),
      ...(previous?.desktop === undefined ? {} : { desktop: previous.desktop }),
      ...(heartbeatResult.status === 'fulfilled' ? { heartbeat: heartbeatResult.value } : {}),
      ...(desktopResult.status === 'fulfilled' ? { desktop: desktopResult.value } : {}),
    }
    const errors = Object.freeze([
      ...(heartbeatResult.status === 'rejected' ? [sourceError('heartbeat', heartbeatResult.reason)] : []),
      ...(desktopResult.status === 'rejected' ? [sourceError('desktop', desktopResult.reason)] : []),
      ...(heartbeatResult.status === 'fulfilled' && heartbeatResult.value.persistenceStatus === 'degraded'
        ? [Object.freeze({
            source: 'heartbeat' as const,
            message: 'heartbeat persistence is degraded',
            kind: 'HEARTBEAT_PERSISTENCE_DEGRADED',
          })]
        : []),
      ...(heartbeatResult.status === 'fulfilled' && DEGRADED_HEARTBEAT_STATUSES.has(heartbeatResult.value.status)
        ? [Object.freeze({
            source: 'heartbeat' as const,
            message: `heartbeat check status is ${heartbeatResult.value.status}`,
            kind: 'HEARTBEAT_CHECK_DEGRADED',
          })]
        : []),
    ])
    const successful = Number(heartbeatResult.status === 'fulfilled') + Number(desktopResult.status === 'fulfilled')
    const next = successful === 2 && errors.length === 0
      ? freezeSnapshot({ status: 'ready', value: value as Required<ProductHealthValue> })
      : successful >= 1
        ? freezeSnapshot({ status: 'degraded', value, errors })
        : freezeSnapshot({ status: 'error', ...(Object.keys(value).length === 0 ? {} : { value }), errors })
    this.publish(next)
    if (this.controller === controller) this.controller = undefined
    return next
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.controller?.abort()
    this.controller = undefined
    this.listeners.clear()
  }

  private async request<T>(path: string, signal: AbortSignal, parse: (value: unknown) => T): Promise<T> {
    signal.throwIfAborted()
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      // Abort the actual fetch signal; racing also bounds an embedding transport
      // that does not settle its promise on abort. Generation fences late results.
      return await Promise.race([aborted, (async () => {
        const response = await this.fetcher(path, { method: 'GET', cache: 'no-store', signal })
        signal.throwIfAborted()
        const body = await readBoundedJson(response)
        signal.throwIfAborted()
        if (!response.ok) {
          const message = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
          const kind = isRecord(body) && typeof body.kind === 'string' ? body.kind : undefined
          throw new ProductHealthRequestError(response.status, kind, message.slice(0, 1_000))
        }
        return parse(body)
      })()])
    } finally { signal.removeEventListener('abort', onAbort) }
  }

  private publish(next: ProductHealthSnapshot): void {
    if (this.disposed) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

interface ProductHealthClientContext {
  provide(name: string, value: unknown): unknown
  effect(execute: () => () => void, label?: string): unknown
}

export const inject: readonly string[] = []

/** Provide the service; the consuming shell owns refresh timing, not transport. */
export function apply(ctx: ProductHealthClientContext): void {
  const service = new ProductHealthProvider()
  ctx.provide('productHealth', service)
  ctx.effect(() => () => service.dispose(), 'xiaoshe-heartbeat: Product health Client lifecycle')
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw new RangeError('health response exceeds the Client limit')
  }
  try { return JSON.parse(text) as unknown } catch { throw new TypeError('health response is not valid JSON') }
}

function parseHeartbeatSnapshot(value: unknown): ProductHeartbeatSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 2 || !isHeartbeatStatus(value.status)
    || typeof value.running !== 'boolean' || !Array.isArray(value.checks)
    || (value.persistenceStatus !== 'ready'
      && value.persistenceStatus !== 'degraded')) {
    throw new TypeError('heartbeat response has an invalid envelope or missing collections')
  }
  if (value.checks.length > 200) throw new RangeError('heartbeat response exceeds collection limits')
  const checks = Object.freeze(value.checks.map((item): ProductHeartbeatCheck => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 200
      || !isHeartbeatStatus(item.status) || !isPositiveInteger(item.intervalMs)
      || !isNonNegativeInteger(item.failureCount)
      || (item.nextRunAt !== undefined && !isNonNegativeInteger(item.nextRunAt))) {
      throw new TypeError('heartbeat response contains an invalid check')
    }
    return Object.freeze({
      id: item.id,
      status: item.status,
      intervalMs: item.intervalMs,
      failureCount: item.failureCount,
      ...(item.nextRunAt === undefined ? {} : { nextRunAt: item.nextRunAt }),
    })
  }))
  const derivedStatus = aggregateHeartbeatStatus(checks)
  const derivedRunning = checks.some(check => check.status === 'running')
  if (value.status !== derivedStatus || value.running !== derivedRunning) {
    throw new TypeError('heartbeat response top-level facts contradict its checks')
  }
  return Object.freeze({
    schemaVersion: 2,
    status: value.status,
    running: value.running,
    persistenceStatus: value.persistenceStatus,
    checks,
  })
}

/** Keep the Client trust boundary aligned with the Host's aggregate contract. */
function aggregateHeartbeatStatus(checks: readonly ProductHeartbeatCheck[]): ProductHeartbeatSnapshot['status'] {
  const statuses = new Set(checks.map(check => check.status))
  for (const status of ['lost', 'delayed', 'backoff', 'running', 'healthy', 'paused'] as const) {
    if (statuses.has(status)) return status
  }
  return 'idle'
}

function parseDesktopDiagnostic(value: unknown): ProductDesktopDiagnostic {
  if (!isRecord(value) || value.api_version !== 1 || typeof value.product !== 'string'
    || value.product.length === 0 || value.product.length > 200
    || typeof value.version !== 'string' || value.version.length === 0 || value.version.length > 200
    || !isRecord(value.bridge) || typeof value.bridge.state !== 'string'
    || !isRecord(value.actions)) {
    throw new TypeError('desktop diagnostic response has an invalid envelope or missing collections')
  }
  return Object.freeze({
    api_version: 1,
    product: value.product,
    version: value.version,
    ...(typeof value.response_style === 'string' ? { response_style: value.response_style.slice(0, 200) } : {}),
    bridge: freezeRecord(value.bridge),
    actions: freezeRecord(value.actions),
    ...(typeof value.modlens_available === 'boolean' ? { modlens_available: value.modlens_available } : {}),
    ...(isRecord(value.last_probe) ? { last_probe: freezeRecord(value.last_probe) } : {}),
  }) as ProductDesktopDiagnostic
}

function sourceError(source: ProductHealthSourceError['source'], error: unknown): ProductHealthSourceError {
  return Object.freeze({
    source,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
    ...(error instanceof ProductHealthRequestError ? { status: error.status } : {}),
    ...(error instanceof ProductHealthRequestError && error.kind !== undefined ? { kind: error.kind } : {}),
    ...(error instanceof ProductHealthTimeoutError ? { kind: 'HEALTH_REQUEST_TIMEOUT' } : {}),
  })
}

function healthValue(snapshot: ProductHealthSnapshot): ProductHealthValue | undefined {
  return 'value' in snapshot ? snapshot.value : undefined
}

function freezeSnapshot<T extends ProductHealthSnapshot>(snapshot: T): T {
  const value = 'value' in snapshot && snapshot.value !== undefined
    ? Object.freeze({ ...snapshot.value })
    : undefined
  return Object.freeze({
    ...snapshot,
    ...(value === undefined ? {} : { value }),
    ...('errors' in snapshot ? { errors: Object.freeze([...snapshot.errors]) } : {}),
  }) as T
}

function freezeRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...value })
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isHeartbeatStatus(value: unknown): value is ProductHeartbeatCheck['status'] {
  return typeof value === 'string' && HEARTBEAT_STATUSES.has(value)
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0
}
