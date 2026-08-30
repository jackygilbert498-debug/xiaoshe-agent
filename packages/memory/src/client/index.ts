import type {
  MemoryQuery,
  MemorySnapshot,
  RememberMemoryInput,
} from '../service.js'

const MEMORY_API_PATH = '/api/xiaoshe/memory'
const MAX_RESPONSE_BYTES = 256 * 1024

export interface MemoryClientError {
  readonly message: string
  readonly status?: number
  readonly kind?: string
}

export type MemoryLifecycleSnapshot =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly memory?: MemorySnapshot }
  | { readonly status: 'ready'; readonly memory: MemorySnapshot }
  | { readonly status: 'error'; readonly memory?: MemorySnapshot; readonly error: MemoryClientError }

export type MemoryFetch = (input: string, init?: RequestInit) => Promise<Response>

class MemoryRequestError extends Error {
  readonly name = 'MemoryRequestError'
  constructor(readonly status: number, readonly kind: string | undefined, message: string) { super(message) }
}

/** Browser-independent store for Product memory API state. */
export class MemoryLifecycleProvider {
  private readonly listeners = new Set<() => void>()
  private readonly controllers = new Set<AbortController>()
  private snapshot: MemoryLifecycleSnapshot = Object.freeze({ status: 'idle' })
  private generation = 0
  private disposed = false

  constructor(private readonly fetcher: MemoryFetch = (input, init) => globalThis.fetch(input, init)) {}

  getSnapshot(): MemoryLifecycleSnapshot { return this.snapshot }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async refresh(query: MemoryQuery = {}): Promise<MemorySnapshot> {
    const parameters = new URLSearchParams()
    if (query.scope !== undefined) parameters.set('scope', query.scope)
    if (query.project !== undefined) parameters.set('project', query.project)
    if (query.include_inactive !== undefined) parameters.set('include_inactive', String(query.include_inactive))
    const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`
    return await this.request(`${MEMORY_API_PATH}${suffix}`, { method: 'GET' })
  }

  async remember(input: RememberMemoryInput, expectedRevision: number): Promise<MemorySnapshot> {
    return await this.mutate({ action: 'remember', expected_revision: expectedRevision, ...input })
  }

  async setState(
    id: string,
    state: 'active' | 'forgotten',
    expectedRevision: number,
  ): Promise<MemorySnapshot> {
    return await this.mutate({ action: 'set_state', expected_revision: expectedRevision, id, state })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.listeners.clear()
  }

  private async mutate(body: Record<string, unknown>): Promise<MemorySnapshot> {
    return await this.request(MEMORY_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  private async request(path: string, init: RequestInit): Promise<MemorySnapshot> {
    if (this.disposed) throw new Error('memoryLifecycle is disposed')
    const generation = ++this.generation
    const controller = new AbortController()
    this.controllers.add(controller)
    this.publish(Object.freeze({
      status: 'loading',
      ...('memory' in this.snapshot && this.snapshot.memory !== undefined ? { memory: this.snapshot.memory } : {}),
    }))
    try {
      const response = await this.fetcher(path, { ...init, signal: controller.signal })
      const body = await readResponse(response)
      if (!response.ok) {
        const error = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
        const kind = isRecord(body) && typeof body.kind === 'string' ? body.kind : undefined
        throw new MemoryRequestError(response.status, kind, error.slice(0, 1_000))
      }
      const memory = freezeMemorySnapshot(body)
      if (!this.disposed && generation === this.generation) {
        this.publish(Object.freeze({ status: 'ready', memory }))
      }
      return memory
    } catch (error: unknown) {
      if (!this.disposed && generation === this.generation) {
        const previous = 'memory' in this.snapshot ? this.snapshot.memory : undefined
        const detail: MemoryClientError = Object.freeze({
          message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
          ...(error instanceof MemoryRequestError ? { status: error.status } : {}),
          ...(error instanceof MemoryRequestError && error.kind !== undefined ? { kind: error.kind } : {}),
        })
        this.publish(Object.freeze({
          status: 'error',
          ...(previous === undefined ? {} : { memory: previous }),
          error: detail,
        }))
      }
      throw error
    } finally {
      this.controllers.delete(controller)
    }
  }

  private publish(next: MemoryLifecycleSnapshot): void {
    if (this.disposed) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

interface MemoryClientContext {
  provide(name: string, value: unknown): unknown
  effect(execute: () => () => void, label?: string): unknown
}

export const inject: readonly string[] = []

/** Provide one lifecycle service without mounting or querying DOM. */
export function apply(ctx: MemoryClientContext): void {
  const service = new MemoryLifecycleProvider()
  ctx.provide('memoryLifecycle', service)
  ctx.effect(() => () => service.dispose(), 'xiaoshe-memory: Client lifecycle')
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new RangeError('memory response exceeds the Client limit')
  try { return JSON.parse(text) as unknown } catch { throw new TypeError('memory response is not valid JSON') }
}

function freezeMemorySnapshot(value: unknown): MemorySnapshot {
  if (!isRecord(value) || value.api_version !== 1 || !isNonNegativeInteger(value.revision)) {
    throw new TypeError('memory response has an invalid envelope')
  }
  if (!isRecord(value.counts) || !Array.isArray(value.entries)
    || !Array.isArray(value.audit) || !Array.isArray(value.usage)) {
    throw new TypeError('memory response is missing collections')
  }
  const countKeys = ['active', 'global', 'project', 'forgotten', 'superseded'] as const
  for (const key of countKeys) {
    if (!isNonNegativeInteger(value.counts[key])) throw new TypeError(`memory count ${key} is invalid`)
  }
  if (value.entries.length > 500 || value.audit.length > 200 || value.usage.length > 500) {
    throw new RangeError('memory response exceeds collection limits')
  }
  const entries = value.entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.text !== 'string'
      || (entry.scope !== 'global' && entry.scope !== 'project')
      || (entry.state !== 'active' && entry.state !== 'forgotten' && entry.state !== 'superseded')
      || !isPositiveInteger(entry.version)) {
      throw new TypeError('memory response contains an invalid entry')
    }
    return Object.freeze({ ...entry })
  })
  const audit = value.audit.map(row => {
    if (!isRecord(row)) throw new TypeError('memory response contains an invalid audit row')
    return Object.freeze({ ...row })
  })
  const usage = value.usage.map(row => {
    if (!isRecord(row)) throw new TypeError('memory response contains an invalid usage row')
    return Object.freeze({ ...row })
  })
  return Object.freeze({
    api_version: 1,
    revision: value.revision,
    counts: Object.freeze({
      active: value.counts.active as number,
      global: value.counts.global as number,
      project: value.counts.project as number,
      forgotten: value.counts.forgotten as number,
      superseded: value.counts.superseded as number,
    }),
    entries: Object.freeze(entries),
    audit: Object.freeze(audit),
    usage: Object.freeze(usage),
  }) as unknown as MemorySnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
