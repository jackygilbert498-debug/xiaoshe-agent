import { randomUUID } from 'node:crypto'
import type {
  ModelSelection, MuxEnvelope, SessionHistory, SessionSummary,
} from './protocol.js'
import { isRecord, parseMuxEnvelope, parseRpcFailure, parseSessionEvent } from './protocol.js'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Business error returned by the DSH Host inside a successful HTTP carrier. */
export class DshRpcError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details: unknown) {
    super(message)
    this.name = 'DshRpcError'
    this.code = code
    this.details = details
  }
}

function baseUrlOf(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('DSH 地址必须使用 http 或 https')
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  url.search = ''
  url.hash = ''
  return url
}

function requiredString(value: Record<string, unknown>, key: string, context: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field === '') throw new Error(`${context} 缺少 ${key}`)
  return field
}

/** Minimal strict RPC client for the public DSH browser API. */
export class DshApiClient {
  readonly baseUrl: URL

  constructor(baseUrl: string, private readonly fetcher: FetchLike = fetch) {
    this.baseUrl = baseUrlOf(baseUrl)
  }

  async call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const rpcId = `${method}-${randomUUID()}`
    const response = await this.fetcher(new URL(`api/${method}`, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`${method} 连接失败：HTTP ${response.status}`)
    const envelope: unknown = await response.json()
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !isRecord(envelope.result)) {
      throw new Error(`${method} 返回了无效的 RPC 信封`)
    }
    if (envelope.result.ok !== true) {
      const failure = parseRpcFailure(envelope.result.error)
      throw new DshRpcError(failure.code, failure.message, failure.details)
    }
    return envelope.result.value as T
  }

  async respond(rpcId: string, value: unknown, signal?: AbortSignal): Promise<void> {
    await this.sendResponse(rpcId, { ok: true, value }, signal)
  }

  /** Cancel an unanswered question when stdin disappears; approvals are rejected explicitly. */
  async respondCancelled(rpcId: string, message: string, signal?: AbortSignal): Promise<void> {
    await this.sendResponse(rpcId, {
      ok: false,
      error: { code: 'cancelled', message, details: { source: 'xiaoshe-terminal' } },
    }, signal)
  }

  private async sendResponse(rpcId: string, result: unknown, signal?: AbortSignal): Promise<void> {
    const response = await this.fetcher(new URL('api/respond', this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`交互响应失败：HTTP ${response.status}`)
    const receipt: unknown = await response.json()
    if (!isRecord(receipt) || receipt.accepted !== true) {
      const reason = isRecord(receipt) && typeof receipt.reason === 'string' ? `：${receipt.reason}` : ''
      throw new Error(`DSH 未接受交互响应${reason}`)
    }
  }

  async listSessions(signal?: AbortSignal): Promise<readonly SessionSummary[]> {
    const value = await this.call<unknown>('session.list', {}, signal)
    if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('session.list 返回值无效')
    return value.items.map(parseSessionSummary)
  }

  async createSession(cwd: string | undefined, signal?: AbortSignal): Promise<string> {
    const value = await this.call<unknown>('session.create', cwd === undefined ? {} : { cwd }, signal)
    if (!isRecord(value)) throw new Error('session.create 返回值无效')
    return requiredString(value, 'sessionId', 'session.create')
  }

  async history(sessionId: string, maxMessages = 200, signal?: AbortSignal): Promise<SessionHistory> {
    const value = await this.call<unknown>('session.history', { sessionId, maxMessages }, signal)
    if (!isRecord(value) || !Array.isArray(value.events) || typeof value.hasMore !== 'boolean') {
      throw new Error('session.history 返回值无效')
    }
    const projections = parseProjectionBlock(value.projections)
    return {
      events: value.events.map((entry) => {
        if (!isRecord(entry)) throw new Error('session.history 包含无效条目')
        return { event: parseSessionEvent(entry.event), ...(entry.view === undefined ? {} : { view: entry.view }) }
      }),
      hasMore: value.hasMore,
      ...(projections === undefined ? {} : { projections }),
    }
  }

  async models(sessionId: string, signal?: AbortSignal): Promise<ModelSelection> {
    const value = await this.call<unknown>('session.models', { sessionId }, signal)
    if (!isRecord(value) || !isRecord(value.current)) throw new Error('session.models 返回值无效')
    const provider = requiredString(value.current, 'provider', 'session.models.current')
    const model = requiredString(value.current, 'model', 'session.models.current')
    const reasoningEffort = typeof value.current.reasoningEffort === 'string' ? value.current.reasoningEffort : undefined
    return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  }

  async prompt(sessionId: string, text: string, timeZone: string, signal?: AbortSignal): Promise<{ readonly commandText?: string }> {
    const value = await this.call<unknown>('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: timeZone,
    }, signal)
    if (!isRecord(value) || value.accepted !== true) throw new Error('session.prompt 返回值无效')
    const commandText = isRecord(value.command) && typeof value.command.text === 'string' ? value.command.text : undefined
    return { ...(commandText === undefined ? {} : { commandText }) }
  }

  async cancel(sessionId: string): Promise<void> {
    const value = await this.call<unknown>('session.cancel', { sessionId })
    if (!isRecord(value) || value.accepted !== true) throw new Error('session.cancel 返回值无效')
  }

  muxUrl(): URL {
    const url = new URL('api/events.mux', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url
  }
}

function parseProjectionBlock(value: unknown): SessionSummary['projections'] {
  if (!isRecord(value) || typeof value.asOfSeq !== 'number' || !isRecord(value.values)) return undefined
  return { asOfSeq: value.asOfSeq, values: value.values }
}

function parseSessionSummary(value: unknown): SessionSummary {
  if (!isRecord(value)) throw new Error('session.list 包含无效条目')
  const sessionId = requiredString(value, 'sessionId', 'session.list')
  if (typeof value.updatedAt !== 'number' || typeof value.running !== 'boolean' || typeof value.blank !== 'boolean') {
    throw new Error('session.list 条目字段无效')
  }
  const projections = parseProjectionBlock(value.projections)
  return {
    sessionId,
    updatedAt: value.updatedAt,
    running: value.running,
    blank: value.blank,
    ...(typeof value.parentSessionId === 'string' ? { parentSessionId: value.parentSessionId } : {}),
    ...(value.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
    ...(projections === undefined ? {} : { projections }),
  }
}

export interface WebSocketLike {
  readonly readyState: number
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event | MessageEvent) => void, options?: AddEventListenerOptions): void
  close(): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

/** Ordered, bounded-consumer mux queue with strict frame parsing. */
export class MuxConnection {
  private readonly frames: MuxEnvelope[] = []
  private readonly waiters: Array<{ resolve: (frame: MuxEnvelope) => void; reject: (error: Error) => void }> = []
  private readonly subscriptions = new Set<string>()
  private closedError: Error | undefined
  readonly opened: Promise<void>

  constructor(url: URL, factory: WebSocketFactory = input => new WebSocket(input)) {
    const socket = factory(url.href)
    this.socket = socket
    this.opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('DSH 实时事件连接失败')), { once: true })
    })
    socket.addEventListener('message', event => {
      try {
        const raw = (event as MessageEvent).data
        const text = typeof raw === 'string' ? raw : String(raw)
        this.push(parseMuxEnvelope(JSON.parse(text)))
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.addEventListener('close', () => this.fail(new Error('DSH 实时事件连接已断开')), { once: true })
  }

  private readonly socket: WebSocketLike

  async next(): Promise<MuxEnvelope> {
    const frame = this.frames.shift()
    if (frame !== undefined) return frame
    if (this.closedError !== undefined) throw this.closedError
    return new Promise<MuxEnvelope>((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  /** Subscriptions may arrive before the active session is selected; retain that fact. */
  hasSubscription(sessionId: string): boolean {
    return this.subscriptions.has(sessionId)
  }

  close(): void {
    this.socket.close()
  }

  private push(frame: MuxEnvelope): void {
    if (frame.payload.type === 'session/subscribed') this.subscriptions.add(frame.payload.sessionId)
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.frames.push(frame)
    else waiter.resolve(frame)
  }

  private fail(error: Error): void {
    if (this.closedError !== undefined) return
    this.closedError = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }
}
