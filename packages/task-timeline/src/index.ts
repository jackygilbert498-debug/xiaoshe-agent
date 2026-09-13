export interface SessionFact { readonly type: string; readonly data: unknown; readonly seq: number; readonly time: number }
export interface TimelineImage { readonly attachmentId: string; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; readonly bytes: number; readonly width: number; readonly height: number; readonly name?: string }
export interface TimelineItem {
  readonly key: string
  readonly seq: number
  readonly time: number
  readonly kind: 'user' | 'assistant' | 'tool' | 'error' | 'compaction' | 'status'
  readonly text: string
  readonly images?: readonly TimelineImage[]
  /** Model reasoning is intentionally not part of the user-visible answer. */
  readonly reasoning?: string
  readonly errorCode?: string
  readonly isError?: boolean
  readonly callId?: string
}
export interface TimelineProjection { readonly schemaVersion: 1; readonly items: readonly TimelineItem[] }
interface State { readonly value: TimelineProjection }
interface Definition { readonly key: 'taskTimeline'; readonly stateSchema: { parse(value: unknown): State }; readonly schema: { parse(value: unknown): TimelineProjection }; readonly stateVersion: 5; readonly wire: { readonly viewSchema: { parse(value: unknown): TimelineProjection }; view(state: State): TimelineProjection }; init(): State; apply(state: State, event: SessionFact): State; view(state: State): TimelineProjection }

export const taskTimelineProjection: Definition = {
  // Replay old projection caches from their original log; do not migrate/delete source facts.
  key: 'taskTimeline', stateVersion: 5,
  schema: { parse(value) { const row = record(value); if (row?.schemaVersion !== 1 || !Array.isArray(row.items)) throw new TypeError('invalid task timeline'); return value as TimelineProjection } },
  stateSchema: { parse(value) {
    const row = record(value)
    return { value: taskTimelineProjection.schema.parse(row?.value) }
  } },
  init: () => ({ value: { schemaVersion: 1, items: [] } }),
  apply(state, event) {
    const item = project(event, state.value.items)
    if (item === undefined) return state
    // The projection is a durable history view, so it must never discard
    // source facts. Client providers own paging/windowing for presentation.
    return { value: { schemaVersion: 1, items: [...state.value.items, item] } }
  },
  view: state => state.value,
  // DSH v3 publishes only explicit wire views; keep the pure view for callers.
  wire: {
    viewSchema: { parse: value => taskTimelineProjection.schema.parse(value) },
    view: state => state.value,
  },
}
export function foldTaskTimeline(events: readonly SessionFact[]): TimelineProjection { let state = taskTimelineProjection.init(); for (const event of events) state = taskTimelineProjection.apply(state, event); return state.value }
export const inject = ['sessionProjections']
export function apply(ctx: { readonly sessionProjections: { register(definition: Definition): unknown } }): void { ctx.sessionProjections.register(taskTimelineProjection) }

function project(event: SessionFact, previous: readonly TimelineItem[]): TimelineItem | undefined {
  const data = record(event.data)
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    if (event.type === 'user/message' && record(data?.source)?.kind !== 'user') return undefined
    const message = record(data?.message) ?? data
    const content = messageContent(message?.content)
    const text = content.text
    const images = event.type === 'user/message' ? messageImages(message?.content) : []
    if (text === '' && images.length === 0) return undefined
    return {
      key: `${event.type}:${event.seq}`, seq: event.seq, time: event.time,
      kind: event.type === 'user/message' ? 'user' : 'assistant', text,
      ...(images.length === 0 ? {} : { images }),
      ...(event.type === 'assistant/message' && content.reasoning !== '' ? { reasoning: content.reasoning } : {}),
    }
  }
  if (event.type === 'tool/call') {
    const name = string(data?.name); const callId = string(data?.callId); if (name === undefined) return undefined
    return { key: `tool-call:${event.seq}`, seq: event.seq, time: event.time, kind: 'tool', text: `调用 ${name}`, ...(callId === undefined ? {} : { callId }) }
  }
  if (event.type === 'tool/result') {
    const message = record(data?.message); const source = record(message?.source); const callId = string(source?.callId)
    // Missing result identity is not evidence about the most recent call. Keep
    // it visible for diagnostics without manufacturing a successful binding.
    const call = callId === undefined ? undefined : [...previous].reverse()
      .find(item => item.kind === 'tool' && item.text.startsWith('调用 ') && item.callId === callId)
    const name = call?.text.slice(3) ?? callId ?? '未关联工具结果'; const failed = data?.error !== undefined || message?.isError === true || hasErrorContent(message?.content)
    // Cancellation is a durable tool-result code, never a guess from output,
    // the latest turn's state, or another call. Keep prior genuine errors intact.
    const code = record(data?.error)?.code
    if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') {
      return { key: `tool-result:${event.seq}`, seq: event.seq, time: event.time, kind: 'tool', text: `已取消：${name}` }
    }
    // A successful result proves only its own arrival until an exact call is
    // found. Calling an orphan result "completed" would manufacture task
    // progress in the user-visible timeline.
    const outcome = failed ? '失败' : call === undefined ? '收到' : '完成'
    return { key: `tool-result:${event.seq}`, seq: event.seq, time: event.time, kind: 'tool', text: `${outcome} ${name}`, ...(failed ? { isError: true } : {}) }
  }
  if (event.type === 'compaction/summary') { const text = string(data?.summary); return text === undefined ? undefined : { key: `compaction:${event.seq}`, seq: event.seq, time: event.time, kind: 'compaction', text } }
  if (event.type === 'turn/end') {
    const reason = record(data?.reason)
    if (reason?.kind !== 'error') return undefined
    const errorCode = string(reason.code)
    return {
      key: `error:${event.seq}`, seq: event.seq, time: event.time, kind: 'error',
      text: string(reason.message) ?? string(data?.message) ?? '任务失败',
      ...(errorCode === undefined ? {} : { errorCode }), isError: true,
    }
  }
  return undefined
}
function messageContent(value: unknown): { readonly text: string; readonly reasoning: string } {
  if (typeof value === 'string') return { text: value, reasoning: '' }
  if (!Array.isArray(value)) return { text: '', reasoning: '' }
  const blocks = value.map(block => record(block))
  return {
    text: blocks.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n'),
    reasoning: blocks.flatMap(block => block?.type === 'reasoning' && typeof block.text === 'string' ? [block.text] : []).join('\n'),
  }
}
function hasErrorContent(value: unknown): boolean { return Array.isArray(value) && value.some(block => record(block)?.isError === true) }
// This projection deliberately has no client/runtime dependency. Keep this
// durable whitelist aligned with the independently validated product contract.
function messageImages(value: unknown): readonly TimelineImage[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(block => {
    const part = record(block); const row = part?.type === 'image' ? record(part.attachment) : undefined
    if (row === undefined || typeof row.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(row.attachmentId)
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(row.mediaType))
      || ![row.bytes, row.width, row.height].every(number => typeof number === 'number' && Number.isSafeInteger(number) && number > 0)) return []
    return [{ attachmentId: row.attachmentId, mediaType: row.mediaType as TimelineImage['mediaType'], bytes: row.bytes as number,
      width: row.width as number, height: row.height as number,
      ...(typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 255 && !/[\\/\u0000-\u001f\u007f]/u.test(row.name) ? { name: row.name } : {}) }]
  })
}
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function string(value: unknown): string | undefined { return typeof value === 'string' && value !== '' ? value : undefined }
