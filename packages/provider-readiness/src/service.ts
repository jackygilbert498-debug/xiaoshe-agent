import type { ProviderProbeRecord } from '@xiaoshe/runtime-contract'
import { runProviderProbe, type ProviderProbeInput } from './probe.js'
import { ProviderProbeStore } from './store.js'

interface LlmPort {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
  stream(options: Readonly<Record<string, unknown>>): AsyncIterable<unknown>
}

export interface ProviderProbeServiceSnapshot {
  readonly probes: readonly ProviderProbeRecord[]
  readonly running?: { readonly provider: string; readonly model: string; readonly startedAt: number }
}

export class ProviderProbeBusyError extends Error { readonly name = 'ProviderProbeBusyError' }

/** Own one explicit provider probe at a time and persist crash-visible facts. */
export class ProviderProbeService {
  readonly #store: ProviderProbeStore
  readonly #llm: LlmPort
  readonly #now: () => number
  readonly #ready: Promise<void>
  #inFlight: { readonly controller: AbortController; readonly provider: string; readonly model: string; readonly startedAt: number } | undefined
  #disposed = false

  constructor(input: { readonly store: ProviderProbeStore; readonly llm: LlmPort; readonly now?: () => number }) {
    this.#store = input.store
    this.#llm = input.llm
    this.#now = input.now ?? Date.now
    this.#ready = this.#recoverInterrupted()
  }

  ready(): Promise<void> { return this.#ready }

  snapshot(): ProviderProbeServiceSnapshot {
    const running = this.#inFlight
    return Object.freeze({
      probes: this.#store.list(),
      ...(running === undefined ? {} : { running: Object.freeze({ provider: running.provider, model: running.model, startedAt: running.startedAt }) }),
    })
  }

  async probe(input: ProviderProbeInput): Promise<ProviderProbeRecord> {
    await this.#ready
    if (this.#disposed) throw new Error('provider probe service is disposed')
    if (this.#inFlight !== undefined) throw new ProviderProbeBusyError('a provider probe is already running')
    const provider = routePart(input.provider, 'provider', 128)
    const model = routePart(input.model, 'model', 512)
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 500 || input.timeoutMs > 120_000) {
      throw new RangeError('timeoutMs must be between 500 and 120000')
    }
    const controller = new AbortController()
    const startedAt = this.#now()
    this.#inFlight = { controller, provider, model, startedAt }
    await this.#store.save({ status: 'running', provider, model, startedAt, cost: { status: 'unavailable' } })
    try {
      const record = await runProviderProbe(this.#llm, { provider, model, timeoutMs: input.timeoutMs }, {
        now: this.#now,
        signal: controller.signal,
      })
      return await this.#store.save(record)
    } finally {
      if (this.#inFlight?.controller === controller) this.#inFlight = undefined
    }
  }

  cancel(): boolean {
    if (this.#inFlight === undefined) return false
    this.#inFlight.controller.abort(new Error('provider probe cancelled by user'))
    return true
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#inFlight?.controller.abort(new Error('provider probe service disposed'))
  }

  async #recoverInterrupted(): Promise<void> {
    const completedAt = this.#now()
    for (const record of this.#store.list()) {
      if (record.status !== 'running') continue
      await this.#store.save(Object.freeze({
        status: 'failed' as const,
        provider: record.provider,
        model: record.model,
        startedAt: record.startedAt,
        completedAt,
        latencyMs: Math.max(0, completedAt - record.startedAt),
        ...(record.contextWindow === undefined ? {} : { contextWindow: record.contextWindow }),
        error: Object.freeze({ code: 'process_restarted', message: '上次模型探测因进程退出而中断' }),
        cost: Object.freeze({ status: 'unavailable' as const }),
      }))
    }
  }
}

function routePart(value: string, label: string, max: number): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} is invalid`)
  }
  return normalized
}
