export interface SessionFact { readonly type: string; readonly data: unknown; readonly seq: number; readonly time: number }
export interface TimelineItem {
  readonly key: string
  readonly seq: number
  readonly time: number
  readonly kind: 'user' | 'assistant' | 'tool' | 'error' | 'compaction' | 'status'
  readonly text: string
  /** Model reasoning is intentionally not part of the user-visible answer. */
  readonly reasoning?: string
  readonly errorCode?: string
  readonly isError?: boolean
  readonly callId?: string
}
export interface TimelineProjection { readonly schemaVersion: 1; readonly items: readonly TimelineItem[] }
interface State { readonly value: TimelineProjection }
interface Definition { readonly key: 'taskTimeline'; readonly schema: { parse(value: unknown): TimelineProjection }; readonly stateVersion: 3; init(): State; apply(state: State, event: SessionFact): State; view(state: State): TimelineProjection }

export const taskTimelineProjection: Definition = {
  key: 'taskTimeline', stateVersion: 3,
  schema: { parse(value) { const row = record(value); if (row?.schemaVersion !== 1 || !Array.isArray(row.items)) throw new TypeError('invalid task timeline'); return value as TimelineProjection } },
  init: () => ({ value: { schemaVersion: 1, items: [] } }),
  apply(state, event) {
    const item = project(event, state.value.items)
    if (item === undefined) return state
    // The projection is a durable history view, so it must never discard
    // source facts. Client providers own paging/windowing for presentation.
    return { value: { schemaVersion: 1, items: [...state.value.items, item] } }
  },
  view: state => state.value,
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
    if (text === '') return undefined
    return {
      key: `${event.type}:${event.seq}`, seq: event.seq, time: event.time,
      kind: event.type === 'user/message' ? 'user' : 'assistant', text,
      ...(event.type === 'assistant/message' && content.reasoning !== '' ? { reasoning: content.reasoning } : {}),
    }
  }
  if (event.type === 'tool/call') {
    const name = string(data?.name); const callId = string(data?.callId); if (name === undefined) return undefined
    return { key: `tool-call:${event.seq}`, seq: event.seq, time: event.time, kind: 'tool', text: `调用 ${name}`, ...(callId === undefined ? {} : { callId }) }
  }
  if (event.type === 'tool/result') {
    const message = record(data?.message); const source = record(message?.source); const callId = string(source?.callId)
    const call = [...previous].reverse().find(item => item.kind === 'tool' && item.text.startsWith('调用 ') && (callId === undefined || item.callId === callId))
    const name = call?.text.slice(3) ?? callId ?? '工具'; const failed = data?.error !== undefined || message?.isError === true || hasErrorContent(message?.content)
    return { key: `tool-result:${event.seq}`, seq: event.seq, time: event.time, kind: 'tool', text: `${failed ? '失败' : '完成'} ${name}`, ...(failed ? { isError: true } : {}) }
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
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function string(value: unknown): string | undefined { return typeof value === 'string' && value !== '' ? value : undefined }
