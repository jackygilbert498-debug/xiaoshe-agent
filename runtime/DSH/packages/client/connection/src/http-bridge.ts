/**
 * node:http ↔ WHATWG fetch bridge for the /api transport (host side of the
 * web carrier; the fetch-shaped handler itself is transport-agnostic).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ConnectionFetchHandler } from './rpc.ts'

/** Default carrier cap for all HTTP RPC bodies: sized for the default
 * aggregate image limit (200 MiB) after base64 expansion plus envelope
 * headroom (~267.7 MiB required), rounded up for slack. The bridge buffers
 * each body in memory, so this cap is also the per-request resident bound. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024


/**
 * Bridge one node:http request to the fetch-shaped handler (client close
 * aborts; response bodies stream out chunk by chunk).
 * @param req - incoming node:http request; the carrier selects buffered or streaming input.
 * @param res - node:http response the bridge writes and owns to completion.
 * @param apiHandler - fetch-shaped API carrier the request is dispatched to.
 * @param maxRequestBodyBytes - maximum bytes buffered for buffered RPC routes.
 */
export async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  apiHandler: ConnectionFetchHandler,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<void> {
  const abort = new AbortController()
  let streamingInput = false
  let responseError: Error | undefined
  // A client can disappear after the handler has produced a response but
  // before node:http flushes it. ServerResponse emits that EPIPE/ECONNRESET
  // asynchronously; without a listener, one abandoned request terminates the
  // entire host process. Treat it as cancellation of this transport only.
  const onResponseError = (error: Error): void => {
    responseError ??= error
    if (!abort.signal.aborted) abort.abort(error)
  }
  // Client-disconnect detection MUST hang off the response, not the request:
  // since Node 16, IncomingMessage 'close' fires as soon as the request body is
  // fully consumed (immediately for a bodyless GET), which would abort every streaming
  // stream right after open. ServerResponse 'close' fires on connection teardown;
  // writableEnded distinguishes a normal end() from the client going away.
  const onResponseClose = (): void => {
    if (!res.writableEnded && !abort.signal.aborted) abort.abort()
  }
  res.on('error', onResponseError)
  res.once('close', onResponseClose)
  try {
    const unavailable = (): boolean => responseError !== undefined || abort.signal.aborted || res.destroyed
    /* v8 ignore next 2 -- node:http always sets url/method on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const method = req.method ?? 'GET'
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as [string, string][],
    )
    const bodyMode = apiHandler.requestBodyMode({ method, url })
    streamingInput = bodyMode === 'streaming'
    let request: Request
    if (bodyMode === 'buffered') {
      const declaredLength = req.headers['content-length']
      if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
        res.writeHead(413, { connection: 'close' })
        res.end()
        req.destroy()
        return
      }
      const chunks: Buffer[] = []
      let received = 0
      for await (const chunk of req) {
        const buffer = chunk as Buffer
        received += buffer.byteLength
        if (received > maxRequestBodyBytes) {
          res.writeHead(413, { connection: 'close' })
          res.end()
          req.destroy()
          return
        }
        chunks.push(buffer)
      }
      request = new Request(url, {
        method,
        headers,
        ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
        signal: abort.signal,
      })
    } else {
      request = new Request(url, {
        method,
        headers,
        body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
        signal: abort.signal,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
    }
    const response = await apiHandler.fetch(request)
    if (unavailable()) {
      // A producer owns its cleanup latency. Transport teardown must settle even
      // when an application cancel hook never does; contain late rejection only.
      void response.body?.cancel(abort.signal.reason).catch(() => {})
      return
    }
    const requestUnread = bodyMode === 'streaming' && !req.readableEnded
    const responseHeaders = Object.fromEntries(response.headers.entries())
    res.writeHead(response.status, requestUnread ? { ...responseHeaders, connection: 'close' } : responseHeaders)
    if (response.body === null) {
      res.end()
      if (requestUnread) req.destroy()
      return
    }
    const reader = response.body.getReader()
    let bodyCancellationRequested = false
    const cancelBody = (): void => {
      if (bodyCancellationRequested) return
      bodyCancellationRequested = true
      // Closing the stream wakes reader.read() synchronously; transport teardown
      // must not await an application producer whose cancel hook may never settle.
      // The rejection handler still contains a late cleanup failure.
      void reader.cancel(abort.signal.reason).catch(() => {})
    }
    abort.signal.addEventListener('abort', cancelBody, { once: true })
    try {
      // The response can close between the pre-header availability check and
      // acquiring the reader. Re-check after the abort listener is installed so
      // that every disconnect actively wakes a pending reader.read().
      if (unavailable()) return
      while (true) {
        const { done, value: chunk } = await reader.read()
        if (done || unavailable()) break
        // Backpressure: a false return means the socket buffer is full — wait for drain
        // instead of buffering unboundedly (slow/suspended SSE consumers). 'close' and
        // 'error' also resolve so a disconnected writer cannot park this loop forever.
        if (!res.write(chunk)) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              res.off('drain', done)
              res.off('close', done)
              res.off('error', done)
              resolve()
            }
            res.once('drain', done)
            res.once('close', done)
            res.once('error', done)
          })
          if (unavailable()) break
        }
      }
    } finally {
      abort.signal.removeEventListener('abort', cancelBody)
      if (unavailable()) cancelBody()
      reader.releaseLock()
    }
    if (!unavailable()) res.end()
    if (requestUnread) req.destroy()
  } catch (error) {
    // A handler can fail before consuming an upload. Cancel that request only,
    // preserving the original error, instead of leaving an unbounded upload alive.
    if (!abort.signal.aborted) abort.abort(error)
    if (streamingInput && !req.readableEnded && !req.destroyed) req.destroy()
    throw error
  } finally {
    res.off('error', onResponseError)
    res.off('close', onResponseClose)
  }
}
