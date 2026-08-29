import { describe, expect, it, vi } from 'vitest'
import { DshApiClient, DshRpcError, MuxConnection } from '../src/api.js'
import { parseOptions } from '../src/options.js'
import { eventText, eventTurn, parseQuestionAnswer, projectionStatus, sessionTitle } from '../src/presentation.js'
import { parseMuxEnvelope } from '../src/protocol.js'

describe('DshApiClient', () => {
  it('wraps calls and verifies the echoed rpc id', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string }
      return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [] } } })
    })
    const client = new DshApiClient('http://127.0.0.1:3080', fetcher)
    await expect(client.listSessions()).resolves.toEqual([])
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('fails closed on a mismatched response', async () => {
    const client = new DshApiClient('http://127.0.0.1:3080', async () => Response.json({
      type: 'server-response', rpcId: 'wrong', result: { ok: true, value: { items: [] } },
    }))
    await expect(client.listSessions()).rejects.toThrow('无效的 RPC 信封')
  })

  it('preserves business error code and message', async () => {
    const client = new DshApiClient('http://127.0.0.1:3080', async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: false, error: { code: 'agent-busy', message: 'busy', details: { reason: 'turn' } } },
      })
    })
    const error = await client.call('session.prompt', {}).catch(value => value)
    expect(error).toBeInstanceOf(DshRpcError)
    expect(error).toMatchObject({ code: 'agent-busy', message: 'busy' })
  })

  it('rejects an unaccepted interactive response', async () => {
    const client = new DshApiClient('http://127.0.0.1:3080', async () => Response.json({ accepted: false, reason: 'not-pending' }))
    await expect(client.respond('r1', {})).rejects.toThrow('not-pending')
  })

  it('cancels an unanswered question with the protocol error branch', async () => {
    let body: unknown
    const client = new DshApiClient('http://127.0.0.1:3080', async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ accepted: true })
    })
    await client.respondCancelled('q1', 'stdin closed')
    expect(body).toMatchObject({
      type: 'client-response', rpcId: 'q1',
      result: { ok: false, error: { code: 'cancelled', message: 'stdin closed' } },
    })
  })
})

describe('protocol and presentation', () => {
  it('parses approval frames without dropping audit correlation', () => {
    expect(parseMuxEnvelope({
      type: 'server-request', rpcId: 'rpc-1', method: 'approval/requested',
      payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash', callId: 'c1', reason: 'write' },
    })).toMatchObject({ rpcId: 'rpc-1', payload: { approvalId: 'a1', callId: 'c1', reason: 'write' } })
  })

  it('rejects a mux envelope whose method and payload discriminant drift', () => {
    expect(() => parseMuxEnvelope({
      type: 'server-request', rpcId: 'rpc-1', method: 'session/event',
      payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 },
    })).toThrow('不一致')
  })

  it('extracts text from current assistant event shape', () => {
    expect(eventText({
      type: 'assistant/message', seq: 3, time: 1,
      data: { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '你好' }] } },
    })).toBe('你好')
  })

  it('reads the durable turn identity used to ignore an earlier queued turn', () => {
    expect(eventTurn({ type: 'turn/start', seq: 2, time: 1, data: { turn: 7 } })).toBe(7)
    expect(eventTurn({ type: 'turn/start', seq: 2, time: 1, data: { turn: 1.5 } })).toBeUndefined()
  })

  it('uses durable title then cwd basename as session labels', () => {
    const base = { sessionId: 's', updatedAt: 1, running: false, blank: false }
    expect(sessionTitle({ ...base, cwd: '/tmp/demo', projections: { asOfSeq: 1, values: { title: ' 任务标题 ' } } })).toBe('任务标题')
    expect(sessionTitle({ ...base, cwd: '/tmp/demo' })).toBe('demo')
  })

  it('reports context and disjoint cache totals', () => {
    expect(projectionStatus({ asOfSeq: 2, values: {
      contextPressure: { projectedTokens: 20_000, contextWindow: 100_000 },
      tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 900, outputTokens: 50 },
    } })).toEqual(['上下文：20K / 100K（20.0%）', '会话累计：输入 100 · 缓存读取 900 · 输出 50 · 缓存命中 90.0%'])
  })

  it('parses single and multi-select question answers', () => {
    const options = [{ label: 'A' }, { label: 'B' }]
    expect(parseQuestionAnswer({ id: 'q', question: '?', options }, '2')).toEqual({ id: 'q', selected: ['B'] })
    expect(parseQuestionAnswer({ id: 'q', question: '?', options, multiSelect: true }, '1,2')).toEqual({ id: 'q', selected: ['A', 'B'] })
    expect(parseQuestionAnswer({ id: 'q', question: '?' }, '其他')).toEqual({ id: 'q', selected: [], custom: '其他' })
  })
})

describe('MuxConnection', () => {
  it('remembers subscriptions that arrive before session selection', async () => {
    const listeners = new Map<string, Array<(event: Event | MessageEvent) => void>>()
    const socket = {
      readyState: 1,
      addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: Event | MessageEvent) => void) {
        const bucket = listeners.get(type) ?? []
        bucket.push(listener)
        listeners.set(type, bucket)
      },
      close() {},
    }
    const mux = new MuxConnection(new URL('ws://127.0.0.1/api/events.mux'), () => socket)
    for (const listener of listeners.get('message') ?? []) listener({ data: JSON.stringify({
      type: 'server-request', rpcId: 'r1', method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 's-early', lastSeq: 3 },
    }) } as MessageEvent)
    expect(mux.hasSubscription('s-early')).toBe(true)
    await expect(mux.next()).resolves.toMatchObject({ payload: { sessionId: 's-early' } })
  })
})

describe('options', () => {
  it('keeps cwd and rejects conflicting selection flags', () => {
    expect(parseOptions(['--url', 'http://127.0.0.1:9999', '--new'], '/work')).toMatchObject({ baseUrl: 'http://127.0.0.1:9999', cwd: '/work', fresh: true })
    expect(() => parseOptions(['--new', '--resume', 's1'], '/work')).toThrow('不能同时使用')
  })
})
