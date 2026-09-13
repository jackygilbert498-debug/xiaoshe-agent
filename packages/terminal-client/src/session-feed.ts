import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { DshApiClient, parseHistory, string } from './api.js'
import { Inbox, CarrierError } from './remote-stream.js'
import { isRecord, parseMuxEnvelope, parseSessionEvent } from './protocol.js'
import type { MuxEnvelope, MuxFrame } from './protocol.js'

interface Pending { readonly clientId: string; readonly lifetime: AbortController }

/** Terminal domain feed over Gateway follow/control/$events; not the removed events carrier. */
export class MuxConnection {
  private readonly lifetime = new AbortController()
  private readonly inbox = new Inbox<MuxEnvelope>()
  private readonly subscriptions = new Map<string, number>()
  private readonly pending = new Map<string, Pending>()
  private readonly following = new Set<string>()
  private activeSession: string | undefined
  private eventsStarted = false
  private eventsReady = false
  private failure: unknown
  private readonly readyWaiters = new Set<{ sessionId: string; resolve: () => void; reject: (error: unknown) => void }>()
  readonly opened: Promise<void>
  constructor(private readonly api: DshApiClient) {
    this.opened = api.authenticate()
    void this.maintain('control', signal => this.control(signal))
  }
  private emit(payload: MuxFrame, rpcId = randomUUID()): void {
    this.inbox.push({ type: 'server-request', rpcId, method: payload.type, payload })
  }
  async next(): Promise<MuxEnvelope> {
    const row = await this.inbox.next()
    if (row.done) throw new Error('终端事件连接已关闭')
    return row.value
  }
  hasSubscription(sessionId: string): boolean { return this.eventsReady && this.subscriptions.has(sessionId) }
  /** Readiness never consumes human requests or durable events queued for the UI. */
  waitSubscribed(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => { this.readyWaiters.add({ sessionId, resolve, reject }); this.notifyReady() })
  }
  private notifyReady(): void {
    for (const waiter of this.readyWaiters) {
      if (this.failure !== undefined) { this.readyWaiters.delete(waiter); waiter.reject(this.failure) }
      else if (this.hasSubscription(waiter.sessionId)) { this.readyWaiters.delete(waiter); waiter.resolve() }
    }
  }
  subscribe(sessionId: string): void {
    this.activeSession = sessionId
    // Do not claim/delegate pending human questions before the user chooses an Agent.
    if (!this.eventsStarted) {
      this.eventsStarted = true
      void this.maintain('events', signal => this.events(signal))
    }
    if (this.following.has(sessionId)) return
    this.following.add(sessionId)
    void this.maintain('follow', signal => this.follow(sessionId, signal))
  }
  interactionSignal(id: string): AbortSignal {
    return this.pending.get(id)?.lifetime.signal ?? AbortSignal.abort(new Error('交互已失效'))
  }
  /** Claim before transport: an ambiguous receipt must never cause a duplicate answer. */
  async respond(id: string, value: unknown): Promise<void> {
    await this.outcome(id, { kind: 'result', value })
  }
  async respondCancelled(id: string, message: string): Promise<void> {
    await this.outcome(id, { kind: 'rejected', error: { name: 'AbortError', code: 'cancelled', message } })
  }
  private async outcome(id: string, outcome: object): Promise<void> {
    const pending = this.pending.get(id)
    if (pending === undefined || pending.lifetime.signal.aborted) throw new Error('交互已完成或连接已失效')
    this.pending.delete(id)
    await this.api.remote('$events/result', { clientId: pending.clientId, eventId: id, outcome }, this.lifetime.signal)
  }
  close(): void {
    this.failure = new Error('终端事件连接已关闭'); this.notifyReady()
    this.lifetime.abort()
    this.invalidate()
    this.inbox.end()
  }
  private invalidate(): void {
    for (const value of this.pending.values()) value.lifetime.abort(new Error('交互已取消或连接断开'))
    this.pending.clear()
  }
  private async maintain(label: string, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    let retry = 0
    while (!this.lifetime.signal.aborted) {
      try { await run(this.lifetime.signal); if (!this.lifetime.signal.aborted) throw new CarrierError('Remote 流意外结束') }
      catch (error) {
        if (this.lifetime.signal.aborted) return
        if (!(error instanceof CarrierError)) { this.failure = error; this.notifyReady(); this.inbox.fail(error); return }
        if (label === 'events') this.invalidate()
        // Read streams can reopen; writes and pending responses are never replayed.
        await delay(Math.min(5000, 250 * 2 ** Math.min(retry++, 5)), undefined, { signal: this.lifetime.signal }).catch(() => {})
      }
    }
  }
  private async events(signal: AbortSignal): Promise<void> {
    let clientId: string | undefined
    try {
      for await (const value of this.api.stream('$events', {}, signal)) {
        if (!isRecord(value)) throw new Error('Remote event 无效')
        if (value.type === 'ready') {
          clientId = string(value, 'clientId'); this.eventsReady = true
          this.notifyReady()
          for (const [sessionId, lastSeq] of this.subscriptions) this.emit({ type: 'session/subscribed', sessionId, lastSeq })
          continue
        }
        if (clientId === undefined) throw new Error('Remote event 缺少 generation')
        if (value.type === 'cancel') {
          const id = string(value, 'eventId')
          this.pending.get(id)?.lifetime.abort(new Error('Host 已取消交互'))
          this.pending.delete(id)
          continue
        }
        if (value.type === 'emit') {
          if (value.event === 'api-session/error' && Array.isArray(value.args) && value.args[0] === this.activeSession) {
            if (typeof value.args[1] !== 'string') throw new Error('api-session/error 字段无效')
            this.emit({ type: 'stream/error', error: { code: 'session/error', message: value.args[1] } })
          }
          continue
        }
        if (value.type !== 'waterfall' || !isRecord(value.request)) throw new Error('Remote event 格式无效')
        const id = string(value, 'eventId')
        if (this.pending.has(id)) throw new Error('重复 Remote event identity')
        const sessionId = string(value, 'agentId')
        const event = string(value, 'event')
        this.pending.set(id, { clientId, lifetime: new AbortController() })
        // Decline other agents and unknown waterfalls so they can reach another answerer.
        if (sessionId !== this.activeSession || !['approval/request', 'user-questions/request'].includes(event)) {
          await this.outcome(id, { kind: 'next' }); continue
        }
        const payload = event === 'approval/request'
          ? { ...value.request, type: 'approval/requested', sessionId, approvalId: id }
          : { type: 'question/requested', sessionId, questions: value.request.questions }
        // This parser validates the terminal domain item, not a legacy wire frame.
        const frame = parseMuxEnvelope({ type: 'server-request', rpcId: id, method: payload.type, payload })
        this.inbox.push(frame)
      }
    } finally { this.eventsReady = false; this.invalidate() }
  }
  private async control(signal: AbortSignal): Promise<void> {
    for await (const value of this.api.stream('session/control', {}, signal)) {
      if (!isRecord(value)) throw new Error('session.control frame 无效')
      if (value.type === 'baseline') {
        if (!isRecord(value.value)) throw new Error('session.control baseline 无效')
        for (const [key, kind] of [['queues', 'queue'], ['jobs', 'jobs']] as const) {
          const map = value.value[key]
          if (!isRecord(map)) throw new Error('session.control baseline 字段无效')
          for (const [sessionId, rows] of Object.entries(map)) {
            if (!Array.isArray(rows)) throw new Error('session.control baseline 条目无效')
            this.emit(kind === 'queue' ? { type: 'session/queue', sessionId, items: rows } : { type: 'session/jobs', sessionId, jobs: rows })
          }
        }
        continue
      }
      const payload = { ...value, type: 'session/' + String(value.type) }
      this.inbox.push(parseMuxEnvelope({ type: 'server-request', rpcId: randomUUID(), method: payload.type, payload }))
    }
  }
  private async follow(sessionId: string, signal: AbortSignal): Promise<void> {
    for await (const value of this.api.stream('session/follow', { request: { address: { kind: 'session', sessionId }, maxMessages: 200 } }, signal)) {
      if (!isRecord(value)) throw new Error('session.follow frame 无效')
      if (value.type === 'snapshot') {
        const history = parseHistory(value)
        const cursor = value.cursor as number
        const previous = this.subscriptions.get(sessionId)
        let records = [...history.events]
        let hasMore = history.hasMore
        // A reconnect opening is bounded. Fill the missing prefix from its fixed cut.
        while (previous !== undefined && hasMore && (records[0]?.event.seq ?? cursor + 1) > previous + 1) {
          const beforeSeq = records[0]?.event.seq
          if (beforeSeq === undefined) throw new Error('重连历史无法推进')
          const page = await this.api.remote<unknown>('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: cursor, beforeSeq, maxMessages: 200 } }, signal)
          if (!isRecord(page) || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') throw new Error('重连历史页无效')
          const older = page.records.map(row => {
            if (!isRecord(row) || row.type !== 'event') throw new Error('重连历史条目无效')
            return { event: parseSessionEvent(row.event) }
          })
          if (!older.length || older[0]!.event.seq >= beforeSeq || records.length > 100000) throw new Error('重连历史超过安全边界')
          records = [...older, ...records]; hasMore = page.hasMore
        }
        if (previous !== undefined) {
          for (const row of records) if (row.event.seq > previous) this.emit({ type: 'session/event', sessionId, event: row.event })
        }
        this.subscriptions.set(sessionId, cursor)
        this.notifyReady()
        this.emit({ type: 'session/subscribed', sessionId, lastSeq: cursor })
        continue
      }
      if (value.type !== 'event') throw new Error('未知 session.follow frame')
      const event = parseSessionEvent(value.event)
      const cursor = this.subscriptions.get(sessionId)
      if (cursor === undefined || event.seq !== cursor + 1) throw new Error('session.follow 序号不连续')
      this.subscriptions.set(sessionId, event.seq)
      this.emit({ type: 'session/event', sessionId, event })
    }
  }
}
