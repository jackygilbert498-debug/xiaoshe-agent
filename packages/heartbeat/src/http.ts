import { Buffer } from 'node:buffer'
import type { HeartbeatCoordinator } from './coordinator.js'
import type { HeartbeatCheckState, HeartbeatService, HeartbeatSnapshot, HeartbeatStatus } from './service.js'

const HEARTBEAT_API_PATH = '/api/xiaoshe/heartbeat'
const JSON_LIMIT_BYTES = 8 * 1024

export interface HeartbeatHttpRequest extends AsyncIterable<Uint8Array | string> {
  readonly method?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
}

export interface HeartbeatHttpResponse {
  writeHead(status: number, headers?: Record<string, string | number>): HeartbeatHttpResponse
  end(data?: string | Uint8Array): void
}

export interface HeartbeatWebServer {
  register(route: {
    readonly name: string
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (request: HeartbeatHttpRequest, response: HeartbeatHttpResponse) => void | Promise<void>
  }): () => void
}

export interface PublicHeartbeatCheck {
  readonly id: string
  readonly status: HeartbeatStatus
  readonly intervalMs: number
  readonly activeHours?: { readonly startHour: number; readonly endHour: number }
  readonly lastSuccessAt?: number
  readonly lastFailureAt?: number
  readonly nextRunAt?: number
  readonly failureCount: number
}

export interface PublicHeartbeatSnapshot {
  readonly schemaVersion: 2
  readonly status: HeartbeatStatus
  readonly running: boolean
  readonly checks: readonly PublicHeartbeatCheck[]
}

interface HeartbeatControlPort extends Pick<HeartbeatCoordinator, 'runNow' | 'pause' | 'resume'> {}

class RequestBodyTooLargeError extends Error {
  readonly name = 'RequestBodyTooLargeError'
}

/** Register one guarded control/read route; private ledger facts never cross this boundary. */
export function registerHeartbeatHttpRoute(
  server: HeartbeatWebServer,
  service: HeartbeatService,
  coordinator: HeartbeatControlPort,
): () => void {
  return server.register({
    name: 'xiaoshe-heartbeat-control',
    kind: 'exact',
    path: HEARTBEAT_API_PATH,
    handler: async (request, response) => {
      if (!isTrustedRequest(request)) {
        sendJson(response, 403, { error: '该接口只接受同源回环请求。', kind: 'UNTRUSTED_REQUEST' })
        return
      }
      if (request.method !== 'GET' && request.method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST', 'cache-control': 'no-store' }).end()
        return
      }
      if (request.method === 'GET') {
        const url = new URL(request.url ?? HEARTBEAT_API_PATH, 'http://localhost')
        if ([...url.searchParams.keys()].length > 0) {
          sendJson(response, 400, { error: 'heartbeat status does not accept query fields', kind: 'INVALID_HEARTBEAT_QUERY' })
          return
        }
        sendJson(response, 200, publicHeartbeatSnapshot(service.snapshot()))
        return
      }

      const contentType = singleHeader(request.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        sendJson(response, 415, { error: 'heartbeat controls require application/json', kind: 'HEARTBEAT_JSON_REQUIRED' })
        return
      }
      try {
        const body = await readJsonBody(request)
        assertOnlyFields(body, ['action', 'id'])
        if (typeof body.id !== 'string' || !service.snapshot().checks.some(check => check.id === body.id)) {
          sendJson(response, 404, { error: 'unknown heartbeat check', kind: 'HEARTBEAT_CHECK_NOT_FOUND' })
          return
        }
        if (body.action === 'run_now') {
          try {
            const result = await coordinator.runNow(body.id)
            sendJson(response, 202, { accepted: true, jobId: result.jobId })
          } catch (error: unknown) {
            if (/already running|active lease/iu.test(safeMessage(error))) {
              sendJson(response, 409, { error: 'heartbeat check is already running', kind: 'HEARTBEAT_RUN_CONFLICT' })
            } else if (/paused/iu.test(safeMessage(error))) {
              sendJson(response, 409, { error: 'heartbeat check is paused', kind: 'HEARTBEAT_PAUSED' })
            } else {
              sendJson(response, 500, { error: 'heartbeat job could not start', kind: 'HEARTBEAT_JOB_START_FAILED' })
            }
          }
          return
        }
        if (body.action === 'pause') {
          await coordinator.pause(body.id, 'paused by local operator')
          sendJson(response, 200, publicHeartbeatSnapshot(service.snapshot()))
          return
        }
        if (body.action === 'resume') {
          await coordinator.resume(body.id)
          sendJson(response, 200, publicHeartbeatSnapshot(service.snapshot()))
          return
        }
        throw new TypeError('heartbeat action must be run_now, pause or resume')
      } catch (error: unknown) {
        if (error instanceof RequestBodyTooLargeError) {
          sendJson(response, 413, { error: error.message, kind: 'HEARTBEAT_BODY_TOO_LARGE' })
          return
        }
        const invalid = error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError
        sendJson(response, invalid ? 400 : 500, {
          error: invalid ? safeMessage(error) : 'heartbeat control failed',
          kind: invalid ? 'INVALID_HEARTBEAT_REQUEST' : 'HEARTBEAT_RUNTIME_ERROR',
        })
      }
    },
  })
}

export function publicHeartbeatSnapshot(snapshot: HeartbeatSnapshot): PublicHeartbeatSnapshot {
  const checks = snapshot.checks.map(publicCheck)
  const running = checks.some(check => check.status === 'running' || check.status === 'delayed' || check.status === 'lost')
  return {
    schemaVersion: 2,
    status: aggregateStatus(checks),
    running,
    checks,
  }
}

function publicCheck(check: HeartbeatCheckState): PublicHeartbeatCheck {
  return {
    id: check.id,
    status: check.status,
    intervalMs: check.intervalMs,
    ...(check.activeHours === undefined ? {} : { activeHours: { ...check.activeHours } }),
    ...(check.lastSuccessAt === undefined ? {} : { lastSuccessAt: check.lastSuccessAt }),
    ...(check.lastFailureAt === undefined ? {} : { lastFailureAt: check.lastFailureAt }),
    ...(check.nextRunAt === undefined ? {} : { nextRunAt: check.nextRunAt }),
    failureCount: check.failureCount,
  }
}

function aggregateStatus(checks: readonly PublicHeartbeatCheck[]): HeartbeatStatus {
  const statuses = new Set(checks.map(check => check.status))
  for (const status of ['lost', 'delayed', 'running', 'backoff', 'healthy', 'paused'] as const) {
    if (statuses.has(status)) return status
  }
  return 'idle'
}

async function readJsonBody(request: HeartbeatHttpRequest): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const raw of request) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw
    total += chunk.byteLength
    if (total > JSON_LIMIT_BYTES) throw new RequestBodyTooLargeError(`JSON body exceeds ${JSON_LIMIT_BYTES} bytes`)
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('JSON body must be an object')
  return value as Record<string, unknown>
}

function isTrustedRequest(request: HeartbeatHttpRequest): boolean {
  const host = singleHeader(request.headers.host)
  if (host === undefined) return false
  let hostUrl: URL
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  if (!isLoopbackHost(hostUrl.hostname)) return false
  if (singleHeader(request.headers['sec-fetch-site']) === 'cross-site') return false
  const origin = singleHeader(request.headers.origin)
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function assertOnlyFields(body: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields)
  const extra = Object.keys(body).filter(key => !allowed.has(key))
  if (extra.length > 0) throw new TypeError(`Unknown heartbeat request field: ${extra.join(', ')}`)
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}

function sendJson(response: HeartbeatHttpResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }).end(payload)
}
