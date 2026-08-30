/**
 * Narrow client-side view of the DSH HTTP/SSE-neutral RPC wire.
 *
 * This package intentionally does not copy the DSH domain implementation. It
 * validates only the envelope and the fields the terminal consumes, while the
 * Host remains the source of truth for every business schema.
 */

export interface RpcFailure {
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

export interface RpcResult<T> {
  readonly value: T
}

export interface SessionProjectionBlock {
  readonly asOfSeq: number
  readonly values: Readonly<Record<string, unknown>>
}

export interface SessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly agentPreset?: string
  readonly projections?: SessionProjectionBlock
}

export interface SessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: unknown
}

export interface HistoryEntry {
  readonly event: SessionEvent
  readonly view?: unknown
}

export interface SessionHistory {
  readonly events: readonly HistoryEntry[]
  readonly hasMore: boolean
  readonly projections?: SessionProjectionBlock
}

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface MuxEnvelope {
  readonly type: 'server-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: MuxFrame
}

export type MuxFrame =
  | { readonly type: 'session/subscribed'; readonly sessionId: string; readonly lastSeq: number }
  | { readonly type: 'session/event'; readonly sessionId: string; readonly event: SessionEvent; readonly view?: unknown }
  | { readonly type: 'approval/requested'; readonly sessionId: string; readonly approvalId: string; readonly toolName: string; readonly callId?: string; readonly reason?: string }
  | { readonly type: 'approval/resolved'; readonly sessionId: string; readonly approvalId: string; readonly outcome: string }
  | { readonly type: 'question/requested'; readonly sessionId: string; readonly questions: readonly QuestionItem[] }
  | { readonly type: 'question/resolved'; readonly sessionId: string; readonly questionRpcId: string; readonly outcome: string }
  | { readonly type: 'session/queue'; readonly sessionId: string; readonly items: readonly unknown[] }
  | { readonly type: 'session/jobs'; readonly sessionId: string; readonly jobs: readonly unknown[] }
  | { readonly type: 'session/projection'; readonly sessionId: string; readonly key: string; readonly value: unknown; readonly seq: number }
  | { readonly type: 'stream/error'; readonly error: RpcFailure }

export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: string; readonly approve?: string }
}

export interface QuestionAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : undefined
}

/** Parse the stable outer mux envelope and the frame discriminant. */
export function parseMuxEnvelope(value: unknown): MuxEnvelope {
  const envelope = record(value)
  if (envelope?.type !== 'server-request') throw new Error('DSH 事件不是 server-request')
  const rpcId = stringField(envelope, 'rpcId')
  const method = stringField(envelope, 'method')
  const payload = record(envelope.payload)
  const frameType = payload === undefined ? undefined : stringField(payload, 'type')
  if (rpcId === undefined || method === undefined || payload === undefined || frameType === undefined) {
    throw new Error('DSH 事件信封缺少必需字段')
  }
  // The WebSocket carrier uses the frame discriminant as the server-request
  // method (for example `session/subscribed`), while the physical URL remains
  // `/api/events.mux`. Requiring equality catches cross-frame corruption
  // without assuming the SSE stream-opener method on this carrier.
  if (method !== frameType) throw new Error(`DSH 事件 method 与 payload.type 不一致：${method} / ${frameType}`)

  const sessionId = stringField(payload, 'sessionId')
  switch (frameType) {
    case 'session/subscribed': {
      const lastSeq = numberField(payload, 'lastSeq')
      if (sessionId === undefined || lastSeq === undefined) throw new Error('session/subscribed 字段无效')
      return { type: 'server-request', rpcId, method, payload: { type: frameType, sessionId, lastSeq } }
    }
    case 'session/event': {
      const event = parseSessionEvent(payload.event)
      if (sessionId === undefined) throw new Error('session/event 缺少 sessionId')
      return { type: 'server-request', rpcId, method, payload: { type: frameType, sessionId, event, ...(payload.view === undefined ? {} : { view: payload.view }) } }
    }
    case 'approval/requested': {
      const approvalId = stringField(payload, 'approvalId')
      const toolName = stringField(payload, 'toolName')
      if (sessionId === undefined || approvalId === undefined || toolName === undefined) throw new Error('approval/requested 字段无效')
      const callId = stringField(payload, 'callId')
      const reason = stringField(payload, 'reason')
      return {
        type: 'server-request', rpcId, method,
        payload: { type: frameType, sessionId, approvalId, toolName, ...(callId === undefined ? {} : { callId }), ...(reason === undefined ? {} : { reason }) },
      }
    }
    case 'approval/resolved': {
      const approvalId = stringField(payload, 'approvalId')
      const outcome = stringField(payload, 'outcome')
      if (sessionId === undefined || approvalId === undefined || outcome === undefined) throw new Error('approval/resolved 字段无效')
      return { type: 'server-request', rpcId, method, payload: { type: frameType, sessionId, approvalId, outcome } }
    }
    case 'question/requested': {
      if (sessionId === undefined || !Array.isArray(payload.questions)) throw new Error('question/requested 字段无效')
      const questions = payload.questions.map(parseQuestion)
      if (questions.length === 0) throw new Error('question/requested 不能为空')
      return { type: 'server-request', rpcId, method, payload: { type: frameType, sessionId, questions } }
    }
    case 'question/resolved': {
      const questionRpcId = stringField(payload, 'questionRpcId')
      const outcome = stringField(payload, 'outcome')
      if (sessionId === undefined || questionRpcId === undefined || outcome === undefined) throw new Error('question/resolved 字段无效')
      return { type: 'server-request', rpcId, method, payload: { type: frameType, sessionId, questionRpcId, outcome } }
    }
    case 'session/queue':
    case 'session/jobs': {
      const key = frameType === 'session/queue' ? 'items' : 'jobs'
      const items = payload[key]
      if (sessionId === undefined || !Array.isArray(items)) throw new Error(`${frameType} 字段无效`)
      return frameType === 'session/queue'
        ? { type: 'server-request', rpcId, method, payload: { type: frameType, sessionId, items } }
        : { type: 'server-request', rpcId, method, payload: { type: frameType, sessionId, jobs: items } }
    }
    case 'session/projection': {
      const key = stringField(payload, 'key')
      const seq = numberField(payload, 'seq')
      if (sessionId === undefined || key === undefined || seq === undefined) throw new Error('session/projection 字段无效')
      return { type: 'server-request', rpcId, method, payload: { type: frameType, sessionId, key, value: payload.value, seq } }
    }
    case 'stream/error': {
      const error = parseRpcFailure(payload.error)
      return { type: 'server-request', rpcId, method, payload: { type: frameType, error } }
    }
    default:
      throw new Error(`未知 DSH mux 事件：${frameType}`)
  }
}

export function parseSessionEvent(value: unknown): SessionEvent {
  const event = record(value)
  const type = event === undefined ? undefined : stringField(event, 'type')
  const seq = event === undefined ? undefined : numberField(event, 'seq')
  const time = event === undefined ? undefined : numberField(event, 'time')
  if (type === undefined || seq === undefined || time === undefined || event === undefined || !Object.hasOwn(event, 'data')) {
    throw new Error('DSH session event 字段无效')
  }
  return { type, seq, time, data: event.data, ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }) }
}

function parseQuestion(value: unknown): QuestionItem {
  const question = record(value)
  const id = question === undefined ? undefined : stringField(question, 'id')
  const text = question === undefined ? undefined : stringField(question, 'question')
  if (id === undefined || text === undefined || question === undefined) throw new Error('问题字段无效')
  const options = Array.isArray(question.options)
    ? question.options.map((entry) => {
      const option = record(entry)
      const label = option === undefined ? undefined : stringField(option, 'label')
      if (label === undefined || option === undefined) throw new Error('问题选项字段无效')
      const description = stringField(option, 'description')
      return { label, ...(description === undefined ? {} : { description }) }
    })
    : undefined
  const header = stringField(question, 'header')
  const detail = stringField(question, 'detail')
  const intent = record(question.intent)
  const intentKind = intent === undefined ? undefined : stringField(intent, 'kind')
  const intentApprove = intent === undefined ? undefined : stringField(intent, 'approve')
  return {
    id,
    question: text,
    ...(header === undefined ? {} : { header }),
    ...(detail === undefined ? {} : { detail }),
    ...(options === undefined ? {} : { options }),
    ...(typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {}),
    ...(intentKind === undefined ? {} : { intent: { kind: intentKind, ...(intentApprove === undefined ? {} : { approve: intentApprove }) } }),
  }
}

export function parseRpcFailure(value: unknown): RpcFailure {
  const error = record(value)
  const code = error === undefined ? undefined : stringField(error, 'code')
  const message = error === undefined ? undefined : stringField(error, 'message')
  if (code === undefined || message === undefined || error === undefined) throw new Error('DSH RPC 错误字段无效')
  return { code, message, ...(error.details === undefined ? {} : { details: error.details }) }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return record(value) !== undefined
}
