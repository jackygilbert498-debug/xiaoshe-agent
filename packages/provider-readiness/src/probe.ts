import { randomUUID } from 'node:crypto'
import type { ProviderProbeRecord, ProviderProbeUsage } from '@xiaoshe/runtime-contract'

interface LlmPort {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
  stream(options: Readonly<Record<string, unknown>>): AsyncIterable<unknown>
}

export interface ProviderProbeInput {
  readonly provider: string
  readonly model: string
  readonly timeoutMs: number
}

export interface ProviderProbeRuntime {
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  /** Caller-owned cancellation; timeout remains a distinct failed outcome. */
  readonly signal?: AbortSignal
}

const PROBE_TEXT = 'Reply only with OK.'

/** Execute one explicit, bounded, tool-free route probe and retain no content. */
export async function runProviderProbe(
  llm: LlmPort,
  input: ProviderProbeInput,
  runtime: ProviderProbeRuntime = {},
): Promise<ProviderProbeRecord> {
  const provider = identifier(input.provider, 'provider', 128)
  const model = identifier(input.model, 'model', 512)
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 500 || input.timeoutMs > 120_000) {
    throw new RangeError('timeoutMs must be between 500 and 120000')
  }
  const now = runtime.now ?? Date.now
  const start = now()
  const controller = new AbortController()
  let timedOut = false
  const cancelFromCaller = (): void => controller.abort(runtime.signal?.reason)
  if (runtime.signal?.aborted === true) cancelFromCaller()
  else runtime.signal?.addEventListener('abort', cancelFromCaller, { once: true })
  const makeTimer = runtime.setTimer ?? setTimeout
  const clear = runtime.clearTimer ?? clearTimeout
  const timer = makeTimer(() => {
    timedOut = true
    controller.abort(new Error('provider probe timed out'))
  }, input.timeoutMs)
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') timer.unref()
  let contextWindow: number | undefined
  let usage: ProviderProbeUsage = Object.freeze({})
  try {
    const info = await llm.resolveModelInfo(provider, model, controller.signal)
    contextWindow = resolvedContextWindow(info)
    let finish: unknown
    for await (const chunk of llm.stream({
      provider,
      model,
      messages: [Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: [Object.freeze({ type: 'text', text: PROBE_TEXT })],
        source: Object.freeze({ kind: 'plugin', plugin: 'xiaoshe-provider-readiness' }),
      })],
      maxTokens: 8,
      temperature: 0,
      signal: controller.signal,
    })) {
      controller.signal.throwIfAborted()
      if (!isRecord(chunk) || typeof chunk.type !== 'string') continue
      if (chunk.type === 'usage') usage = projectUsage(chunk.usage)
      if (chunk.type === 'finish') finish = chunk.reason
    }
    const completedAt = now()
    const latencyMs = Math.max(0, completedAt - start)
    if (!isRecord(finish) || typeof finish.kind !== 'string') {
      return failed(provider, model, start, completedAt, latencyMs, contextWindow, 'stream_incomplete', '模型流未返回终止事实')
    }
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const failure = isRecord(finish.failure) ? finish.failure : {}
      return failed(
        provider, model, start, completedAt, latencyMs, contextWindow,
        safeCode(failure.code, finish.kind === 'aborted' ? 'aborted' : 'provider_error'),
        safeErrorMessage(failure.message ?? (finish.kind === 'aborted' ? '探测已中止' : '服务商返回错误')),
      )
    }
    return Object.freeze({
      status: 'succeeded', provider, model, startedAt: start, completedAt, latencyMs,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      finishReason: finish.kind.slice(0, 128),
      usage,
      cost: Object.freeze({ status: 'unavailable' }),
    })
  } catch (error: unknown) {
    const completedAt = now()
    const latencyMs = Math.max(0, completedAt - start)
    if (controller.signal.aborted) {
      if (timedOut) {
        return failed(provider, model, start, completedAt, latencyMs, contextWindow, 'timeout', '模型服务探测超时')
      }
      return Object.freeze({
        status: 'cancelled', provider, model, startedAt: start, completedAt, latencyMs,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        cost: Object.freeze({ status: 'unavailable' }),
      })
    }
    return failed(provider, model, start, completedAt, latencyMs, contextWindow, errorCode(error), safeErrorMessage(error))
  } finally {
    clear(timer)
    runtime.signal?.removeEventListener('abort', cancelFromCaller)
  }
}

function failed(
  provider: string,
  model: string,
  startedAt: number,
  completedAt: number,
  latencyMs: number,
  contextWindow: number | undefined,
  code: string,
  message: string,
): ProviderProbeRecord {
  return Object.freeze({
    status: 'failed', provider, model, startedAt, completedAt, latencyMs,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    error: Object.freeze({ code, message }),
    cost: Object.freeze({ status: 'unavailable' }),
  })
}

function projectUsage(value: unknown): ProviderProbeUsage {
  if (!isRecord(value)) return Object.freeze({})
  const uncached = tokenCount(value.inputTokens)
  const cacheRead = tokenCount(value.cacheReadTokens)
  const cacheWrite = tokenCount(value.cacheWriteTokens)
  const outputTokens = tokenCount(value.outputTokens)
  const inputTokens = uncached + cacheRead + cacheWrite
  return Object.freeze({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens })
}

function resolvedContextWindow(value: unknown): number | undefined {
  if (!isRecord(value) || !isRecord(value.context)) return undefined
  const candidate = value.context.contextWindow
  return Number.isSafeInteger(candidate) && Number(candidate) > 0 ? Number(candidate) : undefined
}

function identifier(value: string, label: string, max: number): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new TypeError(`${label} is invalid`)
  return normalized
}

function tokenCount(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0 }
function errorCode(error: unknown): string { return isRecord(error) ? safeCode(error.code, 'probe_failed') : 'probe_failed' }
function safeCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value) ? value : fallback
}
function safeErrorMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value)
  return raw
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(/(https?:\/\/)(?:[^/@\s]+@)/gu, '$1')
    .replace(/([?&](?:key|token|api_key)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1_000) || 'provider probe failed'
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
