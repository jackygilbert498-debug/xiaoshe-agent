import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { ProviderProbeRecord } from '@xiaoshe/runtime-contract'

interface StoreDocument {
  readonly schemaVersion: 1
  readonly records: readonly ProviderProbeRecord[]
}

/** Profile-owned, serialized, atomic ledger of explicit provider probes. */
export class ProviderProbeStore {
  readonly #path: string
  readonly #maxRecords: number
  #records: ProviderProbeRecord[]
  #tail: Promise<void> = Promise.resolve()

  constructor(path: string, options: { readonly maxRecords?: number } = {}) {
    if (!isAbsolute(path)) throw new TypeError('provider probe store path must be absolute')
    this.#path = resolve(path)
    this.#maxRecords = options.maxRecords ?? 200
    if (!Number.isSafeInteger(this.#maxRecords) || this.#maxRecords < 1 || this.#maxRecords > 1_000) {
      throw new RangeError('maxRecords must be between 1 and 1000')
    }
    this.#records = this.#load()
  }

  list(): readonly ProviderProbeRecord[] { return freezeCopy(this.#records) }

  latest(provider: string, model: string): ProviderProbeRecord | undefined {
    const value = this.#records.find(record => record.provider === provider && record.model === model)
    return value === undefined ? undefined : freezeCopy(value)
  }

  async save(record: ProviderProbeRecord): Promise<ProviderProbeRecord> {
    return await this.#serialize(async () => {
      const sanitized = sanitizeRecord(record)
      this.#records = [sanitized, ...this.#records.filter(row => routeKey(row) !== routeKey(sanitized))]
        .sort((left, right) => recordTime(right) - recordTime(left))
        .slice(0, this.#maxRecords)
      await this.#persist()
      return freezeCopy(sanitized)
    })
  }

  #load(): ProviderProbeRecord[] {
    if (!existsSync(this.#path)) return []
    try {
      const value: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
      if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.records)) throw new TypeError('unsupported ledger schema')
      return value.records.slice(0, this.#maxRecords).map(sanitizeRecord)
        .sort((left, right) => recordTime(right) - recordTime(left))
    } catch (error: unknown) {
      throw new Error(`provider probe ledger is unreadable: ${safeMessage(error)}`)
    }
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const temp = `${this.#path}.${String(process.pid)}.${String(Date.now())}.tmp`
    const document: StoreDocument = { schemaVersion: 1, records: this.#records }
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, this.#path)
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.#tail
    this.#tail = new Promise<void>(resolveTail => { release = resolveTail })
    await previous
    try { return await operation() } finally { release() }
  }
}

function sanitizeRecord(value: unknown): ProviderProbeRecord {
  if (!isRecord(value)) throw new TypeError('probe record must be an object')
  const provider = boundedText(value.provider, 128)
  const model = boundedText(value.model, 512)
  const startedAt = nonNegative(value.startedAt)
  const cost = isRecord(value.cost) && value.cost.status === 'unavailable'
    ? Object.freeze({ status: 'unavailable' as const })
    : undefined
  if (provider === undefined || model === undefined || startedAt === undefined || cost === undefined) throw new TypeError('probe record identity is invalid')
  const contextWindow = positiveInteger(value.contextWindow)
  if (value.status === 'running') return Object.freeze({
    status: 'running', provider, model, startedAt,
    ...(contextWindow === undefined ? {} : { contextWindow }), cost,
  })
  const completedAt = nonNegative(value.completedAt)
  const latencyMs = nonNegative(value.latencyMs)
  if (completedAt === undefined || latencyMs === undefined) throw new TypeError('settled probe timing is invalid')
  const common = { provider, model, startedAt, completedAt, latencyMs, ...(contextWindow === undefined ? {} : { contextWindow }), cost }
  if (value.status === 'cancelled') return Object.freeze({ status: 'cancelled', ...common })
  if (value.status === 'failed') {
    if (!isRecord(value.error)) throw new TypeError('failed probe error is invalid')
    const code = boundedText(value.error.code, 128)
    const message = boundedText(value.error.message, 1_000)
    if (code === undefined || message === undefined) throw new TypeError('failed probe error is invalid')
    return Object.freeze({ status: 'failed', ...common, error: Object.freeze({ code, message }) })
  }
  if (value.status === 'succeeded') {
    const finishReason = boundedText(value.finishReason, 128)
    const usage = sanitizeUsage(value.usage)
    if (finishReason === undefined || usage === undefined) throw new TypeError('successful probe result is invalid')
    return Object.freeze({ status: 'succeeded', ...common, finishReason, usage })
  }
  throw new TypeError('probe status is invalid')
}

function sanitizeUsage(value: unknown): Readonly<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }> | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = nonNegativeInteger(value.inputTokens)
  const outputTokens = nonNegativeInteger(value.outputTokens)
  const totalTokens = nonNegativeInteger(value.totalTokens)
  return Object.freeze({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  })
}

function routeKey(value: Pick<ProviderProbeRecord, 'provider' | 'model'>): string { return `${value.provider}\u0000${value.model}` }
function recordTime(value: ProviderProbeRecord): number { return value.completedAt ?? value.startedAt }
function freezeCopy<T>(value: T): T { return deepFreeze(structuredClone(value)) }
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return value
}
function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized === '' ? undefined : normalized.slice(0, max).trimEnd()
}
function nonNegative(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined }
function nonNegativeInteger(value: unknown): number | undefined { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined }
function positiveInteger(value: unknown): number | undefined { return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined }
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 500) }
