import { randomUUID } from 'node:crypto'
import type { ModelSelection, SessionHistory, SessionSummary } from './protocol.js'
import { isRecord, parseRpcFailure, parseSessionEvent } from './protocol.js'
import { openRemoteStream, type ResponseObserver } from './remote-stream.js'
export type { WireResponse, ResponseObserver } from './remote-stream.js'
export { MuxConnection } from './session-feed.js'
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class DshRpcError extends Error {
  constructor(readonly code: string, message: string, readonly details: unknown) {
    super(message); this.name = 'DshRpcError'
  }
}

/** Public Connection HTTP carrier; compatibility labels never invoke removed endpoints. */
export class DshApiClient {
  readonly baseUrl: URL
  private readonly launchUrl: URL | undefined
  private cookie: string | undefined
  private authentication: Promise<void> | undefined
  private readonly historyCuts = new Map<string, { cursor: number; projections: SessionHistory['projections'] }>()
  private readonly historyReads = new Map<string, object>()
  constructor(baseUrl: string, private readonly fetcher: FetchLike = fetch, cookie?: string, private readonly options: { onResponse?: ResponseObserver } = {}) {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('DSH 地址必须使用不含用户名密码的 http 或 https')
    this.launchUrl = url.searchParams.has('token') ? new URL(url) : undefined
    const token = url.searchParams.get('token') ?? ''
    if (this.launchUrl !== undefined && (url.pathname !== '/' || url.hash || [...url.searchParams.keys()].length !== 1 || !/^[A-Za-z0-9_-]{43}$/u.test(token) || Buffer.from(token, 'base64url').length !== 32 || Buffer.from(token, 'base64url').toString('base64url') !== token)) throw new Error('DSH 启动认证地址格式无效')
    url.pathname = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/'
    url.search = ''; url.hash = ''
    this.baseUrl = url
    this.cookie = cookie
  }

  /** Exchange an explicitly supplied launch URL only; never discover personal credentials. */
  authenticate(): Promise<void> {
    this.authentication ??= (async () => {
      if (this.launchUrl === undefined) return
      let response: Response
      try { response = await this.fetcher(this.launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }) }
      catch { throw new Error('DSH 启动链接认证连接失败或超时') }
      const cookies = response.headers.getSetCookie().map(row => row.split(';', 1)[0]).filter((row): row is string => row !== undefined && /^dsh-auth-[A-Za-z0-9_-]{43}=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(row))
      await response.body?.cancel()
      if (cookies.length !== 1 || response.status !== 303 || response.headers.get('location') !== '/') throw new Error('DSH 启动链接认证失败')
      this.cookie = cookies[0]
    })()
    return this.authentication
  }

  /** Exact named-argument Typert endpoint. Custom fetchers may clone responses for wire evidence. */
  async remote<T>(endpoint: string, args: object, signal?: AbortSignal): Promise<T> {
    if (!/^\$?[-\w]+\/[-\w]+$/u.test(endpoint)) throw new Error('Remote endpoint 无效')
    await this.authenticate()
    const rpcId = randomUUID()
    const response = await this.fetcher(new URL('api/' + endpoint, this.baseUrl), {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(this.cookie === undefined ? {} : { cookie: this.cookie }) },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      ...(signal === undefined ? {} : { signal }),
    })
    const bytes = await response.text()
    await this.options.onResponse?.({ endpoint, rpcId, args, status: response.status, bytes })
    if (!response.ok) throw new Error(endpoint + ' 连接失败：HTTP ' + response.status + (response.status === 401 ? '（需要 Host 认证启动链接）' : ''))
    const envelope: unknown = JSON.parse(bytes)
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !isRecord(envelope.result)) throw new Error(endpoint + ' 返回了无效 RPC 信封')
    if (envelope.result.ok !== true) {
      const error = parseRpcFailure(envelope.result.error)
      throw new DshRpcError(error.code, error.message, error.details)
    }
    return envelope.result.value as T
  }
  async *stream(endpoint: string, args: object, signal: AbortSignal): AsyncGenerator<unknown> {
    await this.authenticate()
    yield* openRemoteStream(this.baseUrl, endpoint, args, this.cookie, signal, this.options.onResponse)
  }
  async call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    if (!isRecord(payload)) throw new Error(method + ' 参数无效')
    if (method === 'session.history') {
      const sessionId = string(payload, 'sessionId')
      const maxMessages = typeof payload.maxMessages === 'number' ? payload.maxMessages : 200
      if (payload.beforeSeq === undefined) return await this.history(sessionId, maxMessages, signal) as T
      const cut = this.historyCuts.get(sessionId)
      if (cut === undefined || !Number.isSafeInteger(payload.beforeSeq) || (payload.beforeSeq as number) < 0 || (payload.beforeSeq as number) > cut.cursor + 1) throw new Error('history continuation 缺少同会话有效 opening cutoff')
      const page = await this.remote<unknown>('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: cut.cursor, beforeSeq: payload.beforeSeq, maxMessages } }, signal)
      if (!isRecord(page)) throw new Error('session.page 返回值无效')
      return parseHistory({ ...page, cursor: cut.cursor, projections: cut.projections }) as T
    }
    if (method === 'session.models') return { current: await this.models(string(payload, 'sessionId'), signal), catalog: await this.modelCatalog(signal) } as T
    if (method === 'session.list') return this.remote<T>('session/list', { _request: payload }, signal)
    if (method === 'session.modelCatalog') return this.remote<T>('session/modelCatalog', {}, signal)
    if (method === 'workspace.create' || method === 'workspace.archiveSession') return this.remote<T>(method.replace('.', '/'), { request: payload }, signal)
    const requests = ['create', 'prompt', 'cancel', 'selectModel', 'updateQueue', 'rename', 'fork', 'search', 'attachment', 'page']
    const name = method.startsWith('session.') ? method.slice(8) : ''
    if (!requests.includes(name)) throw new Error('未映射的终端业务 API：' + method + '；请使用 remote(endpoint,args)')
    const request = name === 'prompt' ? { ...payload, requestId: payload.requestId ?? randomUUID() } : payload
    return this.remote<T>('session/' + name, { request }, signal)
  }
  async listSessions(signal?: AbortSignal): Promise<readonly SessionSummary[]> {
    const value = await this.call<unknown>('session.list', {}, signal)
    if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('session.list 返回值无效')
    return value.items.map(row => {
      if (!isRecord(row) || typeof row.updatedAt !== 'number' || typeof row.running !== 'boolean' || typeof row.blank !== 'boolean') throw new Error('session.list 条目无效')
      return { ...row, sessionId: string(row, 'sessionId') } as unknown as SessionSummary
    })
  }
  async createSession(cwd: string | undefined, signal?: AbortSignal): Promise<string> {
    const value = await this.call<unknown>('session.create', cwd === undefined ? {} : { cwd }, signal)
    if (!isRecord(value)) throw new Error('session.create 返回值无效')
    return string(value, 'sessionId')
  }
  async history(sessionId: string, maxMessages = 200, signal?: AbortSignal): Promise<SessionHistory> {
    const read = {}
    this.historyReads.set(sessionId, read)
    this.historyCuts.delete(sessionId)
    const lifetime = new AbortController()
    const combined = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
    try {
      for await (const frame of this.stream('session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages } }, combined)) {
        if (!isRecord(frame) || frame.type !== 'snapshot') throw new Error('session.follow 缺少 opening snapshot')
        const history = parseHistory(frame)
        if (this.historyReads.get(sessionId) === read) this.historyCuts.set(sessionId, { cursor: frame.cursor as number, projections: history.projections })
        return history
      }
      throw new Error('session.follow 未返回历史')
    } finally { lifetime.abort() }
  }
  async modelCatalog(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const value = await this.remote<unknown>('session/modelCatalog', {}, signal)
    if (!isRecord(value)) throw new Error('modelCatalog 返回值无效')
    return value
  }
  async models(sessionId: string, signal?: AbortSignal): Promise<ModelSelection> {
    const history = await this.history(sessionId, 1, signal)
    const selection = history.projections?.values.modelSelection
    const catalog = await this.modelCatalog(signal)
    const value = isRecord(selection) ? selection.next ?? selection.lastUsed ?? catalog.default : catalog.default
    if (!isRecord(value)) throw new Error('Host 未提供会话或默认模型')
    return { provider: string(value, 'provider'), model: string(value, 'model'), ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}) }
  }
  async selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<unknown> {
    return this.call('session.selectModel', { sessionId, provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
  }
  async prompt(sessionId: string, text: string, timeZone: string, signal?: AbortSignal, mode: 'queue' | 'steer' = 'queue', requestId?: string): Promise<{ readonly commandText?: string }> {
    if (text.trim() === '/') {
      const commands = await this.remote<unknown>('commands/list', { agentId: sessionId }, signal)
      if (!Array.isArray(commands)) throw new Error('commands.list 返回值无效')
      return { commandText: commands.map(row => {
        if (!isRecord(row)) throw new Error('commands.list 条目无效')
        return '/' + string(row, 'name') + '  ' + string(row, 'description')
      }).join('\n') }
    }
    if (text.startsWith('/')) {
      const command = await this.remote<unknown>('commands/execute', { agentId: sessionId, line: text, submittedAttachments: [] }, signal)
      if (command !== undefined && command !== null) {
        if (!isRecord(command) || !isRecord(command.result)) throw new Error('commands.execute 返回值无效')
        const result = command.result
        if (result.kind === 'error') throw new Error(string(result, 'text'))
        if (result.kind !== 'success') throw new Error('commands.execute outcome 无效')
        return { commandText: typeof result.text === 'string' ? result.text : '命令已完成' }
      }
    }
    const value = await this.call<unknown>('session.prompt', { sessionId, mode, content: [{ type: 'text', text }], clientTimeZone: timeZone, ...(requestId === undefined ? {} : { requestId }) }, signal)
    if (!isRecord(value) || value.accepted !== true) throw new Error('session.prompt 返回值无效')
    return {}
  }
  async cancel(sessionId: string): Promise<void> {
    const value = await this.call<unknown>('session.cancel', { sessionId })
    if (!isRecord(value) || value.accepted !== true) throw new Error('session.cancel 返回值无效')
  }
}
export function string(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || value === '') throw new Error('Remote 字段 ' + key + ' 无效')
  return value
}
export function parseHistory(frame: Record<string, unknown>): SessionHistory {
  if (!Array.isArray(frame.records) || typeof frame.hasMore !== 'boolean' || !Number.isSafeInteger(frame.cursor)) throw new Error('session.follow 历史字段无效')
  const events = frame.records.map(row => {
    if (!isRecord(row) || row.type !== 'event') throw new Error('session.follow record 无效')
    return { event: parseSessionEvent(row.event) }
  })
  if (!isRecord(frame.projections) || !isRecord(frame.projections.values) || typeof frame.projections.asOfSeq !== 'number') throw new Error('session.follow projections 无效')
  return { events, hasMore: frame.hasMore, throughSeq: frame.cursor as number, projections: { asOfSeq: frame.projections.asOfSeq, values: frame.projections.values } }
}
