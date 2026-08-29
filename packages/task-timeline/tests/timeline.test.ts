import { describe, expect, it } from 'vitest'
import { foldTaskTimeline } from '../src/index.js'
const event = (type: string, data: unknown, seq: number) => ({ type, data, seq, time: seq * 10 })
describe('task timeline projection', () => {
  it('folds user, assistant, tool, compaction and errors from canonical events', () => {
    expect(foldTaskTimeline([
      event('user/message', { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, 1),
      event('user/message', { content: [{ type: 'text', text: '内部上下文' }], source: { kind: 'plugin', plugin: 'test' } }, 1.5),
      event('tool/call', { callId: 'c1', name: 'read_file' }, 2),
      event('tool/result', { message: { source: { callId: 'c1' }, isError: false } }, 3),
      event('assistant/message', { message: { content: [{ type: 'text', text: '完成' }] } }, 4),
      event('compaction/summary', { summary: '压缩摘要' }, 5),
      event('turn/end', { reason: { kind: 'error', message: '模型不可用' } }, 6),
    ])).toMatchObject({ items: [
      { kind: 'user', text: '你好' }, { kind: 'tool', text: '调用 read_file' }, { kind: 'tool', text: '完成 read_file' },
      { kind: 'assistant', text: '完成' }, { kind: 'compaction', text: '压缩摘要' }, { kind: 'error', text: '模型不可用', isError: true },
    ] })
  })

  it('matches interleaved results by call id and reads DSH error blocks', () => {
    expect(foldTaskTimeline([
      event('tool/call', { callId: 'c1', name: 'first' }, 1),
      event('tool/call', { callId: 'c2', name: 'second' }, 2),
      event('tool/result', { message: { source: { callId: 'c1' }, content: [{ isError: true }] } }, 3),
      event('tool/result', { message: { source: { callId: 'c2' }, content: [] } }, 4),
    ]).items).toMatchObject([
      { text: '调用 first' }, { text: '调用 second' },
      { text: '失败 first', isError: true }, { text: '完成 second' },
    ])
  })

  it('keeps private reasoning separate from the visible assistant answer and preserves event facts', () => {
    expect(foldTaskTimeline([
      event('assistant/message', { message: { content: [
        { type: 'reasoning', text: '先检查隐藏推理' },
        { type: 'text', text: '这是给用户看的回答' },
      ] } }, 7),
      event('turn/end', { reason: { kind: 'error', code: 'provider_timeout', message: '服务响应超时' } }, 8),
    ]).items).toEqual([
      {
        key: 'assistant/message:7', seq: 7, time: 70, kind: 'assistant',
        text: '这是给用户看的回答', reasoning: '先检查隐藏推理',
      },
      {
        key: 'error:8', seq: 8, time: 80, kind: 'error', text: '服务响应超时',
        errorCode: 'provider_timeout', isError: true,
      },
    ])
  })

  it('preserves the complete durable history instead of silently dropping records after 500 items', () => {
    const events = Array.from({ length: 620 }, (_, index) => event(
      'user/message',
      { content: [{ type: 'text', text: `消息 ${index + 1}` }], source: { kind: 'user' } },
      index + 1,
    ))

    const timeline = foldTaskTimeline(events)
    expect(timeline.items).toHaveLength(620)
    expect(timeline.items[0]).toMatchObject({ seq: 1, text: '消息 1' })
    expect(timeline.items.at(-1)).toMatchObject({ seq: 620, text: '消息 620' })
  })
})
