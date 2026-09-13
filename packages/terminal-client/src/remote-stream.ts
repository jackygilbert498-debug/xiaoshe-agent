import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { isRecord, parseRpcFailure } from './protocol.js'

/** Bounded inbox: a slow terminal must fail visibly rather than exhaust memory. */
export class Inbox<T> {
  private rows: T[] = []
  private wake: (() => void) | undefined
  private error: unknown
  private ended = false
  push(value: T): void {
    if (this.ended) return
    if (this.rows.length >= 4096) { this.fail(new Error('终端事件积压超过安全上限，请重新连接')); return }
    this.rows.push(value)
    this.wake?.()
  }
  fail(error: unknown): void { if (this.ended) return; this.error = error; this.end() }
  end(): void { this.ended = true; this.wake?.() }
  async next(): Promise<IteratorResult<T>> {
    while (true) {
      if (this.error !== undefined) throw this.error
      if (this.rows.length > 0) return { value: this.rows.shift() as T, done: false }
      if (this.ended) return { value: undefined, done: true }
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

export class CarrierError extends Error {}
export interface WireResponse {
  readonly endpoint: string
  readonly rpcId: string
  readonly args: object
  readonly status: number
  readonly bytes: string
}
export type ResponseObserver = (record: WireResponse) => void | Promise<void>

/** One independently cancellable Gateway logical stream. No business writes are retried here. */
export async function* openRemoteStream(
  base: URL, endpoint: string, args: object, cookie: string | undefined, signal: AbortSignal, onResponse?: ResponseObserver,
): AsyncGenerator<unknown> {
  signal.throwIfAborted()
  const url = new URL('api/remote.mux', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const streamId = randomUUID()
  const inbox = new Inbox<unknown>()
  const socket = new WebSocket(url, { ...(cookie === undefined ? {} : { headers: { cookie } }), handshakeTimeout: 15_000, maxPayload: 16 * 1024 * 1024 })
  let ended = false
  const abort = (): void => { inbox.fail(signal.reason ?? new Error('请求已取消')) }
  signal.addEventListener('abort', abort, { once: true })
  socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })))
  let observed = Promise.resolve()
  let pendingObservations = 0
  let accepting = true
  let observationFailure: unknown
  socket.on('message', bytes => {
    if (!accepting) return
    if (++pendingObservations > 4096) { inbox.fail(new Error('Remote wire retention 积压超过安全上限')); socket.close(); return }
    observed = observed.then(async () => {
      const raw = bytes.toString()
      const frame: unknown = JSON.parse(raw)
      if (!isRecord(frame) || frame.streamId !== streamId) throw new Error('Remote stream correlation 无效')
      await onResponse?.({ endpoint, rpcId: streamId, args, status: 101, bytes: raw })
      if (frame.type === 'item') inbox.push(frame.value)
      else if (frame.type === 'end') { ended = true; inbox.end() }
      else if (frame.type === 'error') {
        const failure = parseRpcFailure(frame.error)
        inbox.fail(Object.assign(new Error(failure.message), { code: failure.code }))
      } else throw new Error('Remote stream frame 无效')
    }).catch(error => { observationFailure ??= error; inbox.fail(error) }).finally(() => { pendingObservations-- })
  })
  socket.on('error', () => inbox.fail(new CarrierError('DSH 实时连接失败（请检查地址和认证）')))
  socket.on('unexpected-response', (request, response) => {
    inbox.fail(new Error('DSH 实时握手失败：HTTP ' + response.statusCode + '（请检查 Host 认证启动链接）'))
    response.resume(); request.destroy()
  })
  socket.on('close', () => { void observed.then(() => { if (!ended) inbox.fail(new CarrierError('DSH 实时连接已断开')) }) })
  try {
    while (true) {
      const row = await inbox.next()
      signal.throwIfAborted()
      if (row.done) return
      yield row.value
    }
  } finally {
    accepting = false
    signal.removeEventListener('abort', abort)
    if (socket.readyState === WebSocket.OPEN) {
      if (!ended) socket.send(JSON.stringify({ type: 'cancel', streamId }))
      socket.close()
    } else socket.terminate()
    await observed
    if (observationFailure !== undefined) throw observationFailure
  }
}
