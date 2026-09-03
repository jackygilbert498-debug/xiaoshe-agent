import { Buffer } from 'node:buffer'
import { ProviderProbeBusyError, type ProviderProbeService } from './service.js'

export const PROVIDER_READINESS_PATH = '/api/xiaoshe/providers/readiness'
export const PROVIDER_PROBE_PATH = '/api/xiaoshe/providers/probe'
export const PROVIDER_PROBE_CANCEL_PATH = '/api/xiaoshe/providers/probe/cancel'
const JSON_LIMIT_BYTES = 4 * 1024

export interface ProviderReadinessHttpRequest extends AsyncIterable<Uint8Array | string> {
  readonly method?: string
  readonly headers: Record<string, string | string[] | undefined>
}
export interface ProviderReadinessHttpResponse {
  writeHead(status: number, headers?: Record<string, string | number>): ProviderReadinessHttpResponse
  end(data?: string | Uint8Array): void
}
export interface ProviderReadinessWebServer {
  register(route: {
    readonly name: string
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (request: ProviderReadinessHttpRequest, response: ProviderReadinessHttpResponse) => void | Promise<void>
  }): () => void
}
interface ServicePort {
  ready(): Promise<void>
  snapshot(): ReturnType<ProviderProbeService['snapshot']>
  probe(input: { readonly provider: string; readonly model: string; readonly timeoutMs: number }): ReturnType<ProviderProbeService['probe']>
  cancel(): boolean
}

class RequestBodyTooLargeError extends Error { readonly name = 'RequestBodyTooLargeError' }
class UnsupportedMediaTypeError extends TypeError { readonly name = 'UnsupportedMediaTypeError' }

/** Register same-origin loopback routes for explicit, auditable provider probes. */
export function registerProviderReadinessHttpRoutes(server: ProviderReadinessWebServer, service: ServicePort): () => void {
  const releases = [
    server.register({
      name: 'xiaoshe-provider-readiness', kind: 'exact', path: PROVIDER_READINESS_PATH,
      handler: guarded('GET', async (_request, response) => {
        await service.ready()
        sendJson(response, 200, service.snapshot())
      }),
    }),
    server.register({
      name: 'xiaoshe-provider-probe', kind: 'exact', path: PROVIDER_PROBE_PATH,
      handler: guarded('POST', async (request, response) => {
        const body = await requireJson(request)
        assertOnlyFields(body, ['provider', 'model', 'timeoutMs'])
        const timeoutMs = body.timeoutMs === undefined ? 15_000 : boundedInteger(body.timeoutMs, 'timeoutMs', 500, 120_000)
        const probe = await service.probe({
          provider: requiredString(body.provider, 'provider', 128),
          model: requiredString(body.model, 'model', 512),
          timeoutMs,
        })
        sendJson(response, 200, { probe, snapshot: service.snapshot() })
      }),
    }),
    server.register({
      name: 'xiaoshe-provider-probe-cancel', kind: 'exact', path: PROVIDER_PROBE_CANCEL_PATH,
      handler: guarded('POST', async (request, response) => {
        const body = await requireJson(request)
        assertOnlyFields(body, [])
        sendJson(response, 200, { cancelled: service.cancel() })
      }),
    }),
  ]
  return () => { for (const release of [...releases].reverse()) release() }
}

function guarded(method: 'GET' | 'POST', action: (request: ProviderReadinessHttpRequest, response: ProviderReadinessHttpResponse) => Promise<void>) {
  return async (request: ProviderReadinessHttpRequest, response: ProviderReadinessHttpResponse): Promise<void> => {
    if (!isTrustedRequest(request)) { sendJson(response, 403, { error: '该接口只接受同源回环请求。', kind: 'UNTRUSTED_REQUEST' }); return }
    if (request.method !== method) { response.writeHead(405, { allow: method, 'cache-control': 'no-store' }).end(); return }
    try { await action(request, response) }
    catch (error: unknown) {
      if (error instanceof UnsupportedMediaTypeError) { sendJson(response, 415, { error: error.message, kind: 'JSON_REQUIRED' }); return }
      if (error instanceof RequestBodyTooLargeError) { sendJson(response, 413, { error: error.message, kind: 'BODY_TOO_LARGE' }); return }
      if (error instanceof ProviderProbeBusyError) { sendJson(response, 409, { error: error.message, kind: 'PROBE_BUSY' }); return }
      const invalid = error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError
      sendJson(response, invalid ? 400 : 500, { error: safeMessage(error), kind: invalid ? 'INVALID_PROVIDER_REQUEST' : 'PROVIDER_RUNTIME_ERROR' })
    }
  }
}

async function requireJson(request: ProviderReadinessHttpRequest): Promise<Record<string, unknown>> {
  const contentType = singleHeader(request.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new UnsupportedMediaTypeError('provider controls require application/json')
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const raw of request) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw
    total += chunk.byteLength
    if (total > JSON_LIMIT_BYTES) throw new RequestBodyTooLargeError(`JSON body exceeds ${JSON_LIMIT_BYTES} bytes`)
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!isRecord(value)) throw new TypeError('JSON body must be an object')
  return value
}

function isTrustedRequest(request: ProviderReadinessHttpRequest): boolean {
  const host = singleHeader(request.headers.host)
  if (host === undefined) return false
  let hostUrl: URL
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  if (!isLoopbackHost(hostUrl.hostname) || singleHeader(request.headers['sec-fetch-site']) === 'cross-site') return false
  const origin = singleHeader(request.headers.origin)
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}
function assertOnlyFields(body: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields)
  const extra = Object.keys(body).filter(key => !allowed.has(key))
  if (extra.length > 0) throw new TypeError(`Unknown provider request field: ${extra.join(', ')}`)
}
function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  const normalized = value.trim()
  if (normalized === '' || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new TypeError(`${name} is invalid`)
  return normalized
}
function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new RangeError(`${name} must be between ${min} and ${max}`)
  return Number(value)
}
function singleHeader(value: string | string[] | undefined): string | undefined { return typeof value === 'string' && value !== '' ? value : undefined }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) }
function sendJson(response: ProviderReadinessHttpResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  }).end(payload)
}
