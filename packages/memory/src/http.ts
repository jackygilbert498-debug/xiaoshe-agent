import { Buffer } from 'node:buffer'
import { MemoryRevisionConflictError, type MemoryQuery, type MemoryService } from './service.js'

const MEMORY_API_PATH = '/api/xiaoshe/memory'
const JSON_LIMIT_BYTES = 16 * 1024

export interface MemoryHttpRequest extends AsyncIterable<Uint8Array | string> {
  readonly method?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
}

export interface MemoryHttpResponse {
  writeHead(status: number, headers?: Record<string, string | number>): MemoryHttpResponse
  end(data?: string | Uint8Array): void
}

export interface MemoryWebServer {
  register(route: {
    readonly name: string
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (request: MemoryHttpRequest, response: MemoryHttpResponse) => void | Promise<void>
  }): () => void
}

class RequestBodyTooLargeError extends Error {
  readonly name = 'RequestBodyTooLargeError'
}

/** Register the loopback-only Product memory lifecycle route. */
export function registerMemoryHttpRoute(server: MemoryWebServer, service: MemoryService): () => void {
  return server.register({
    name: 'xiaoshe-product-memory',
    kind: 'exact',
    path: MEMORY_API_PATH,
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
        try {
          sendJson(response, 200, service.snapshot(parseMemoryQuery(request.url)))
        } catch (error: unknown) {
          sendJson(response, 400, { error: safeMessage(error), kind: 'INVALID_MEMORY_QUERY' })
        }
        return
      }

      const contentType = singleHeader(request.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        sendJson(response, 415, { error: 'memory writes require application/json', kind: 'MEMORY_JSON_REQUIRED' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const expectedRevision = nonNegativeInteger(body.expected_revision, 'expected_revision')
        if (body.action === 'remember') {
          assertOnlyFields(body, ['action', 'expected_revision', 'scope', 'project', 'text', 'replaces_id'])
          const snapshot = await service.remember({
            scope: body.scope as never,
            ...(body.project === undefined ? {} : { project: body.project as never }),
            text: body.text as never,
            ...(body.replaces_id === undefined ? {} : { replaces_id: body.replaces_id as never }),
          }, expectedRevision)
          sendJson(response, 200, snapshot)
          return
        }
        if (body.action === 'set_state') {
          assertOnlyFields(body, ['action', 'expected_revision', 'id', 'state'])
          if (typeof body.id !== 'string' || (body.state !== 'active' && body.state !== 'forgotten')) {
            throw new TypeError('set_state requires an id and active or forgotten state')
          }
          sendJson(response, 200, await service.setState(body.id, body.state, expectedRevision))
          return
        }
        throw new TypeError('memory action must be remember or set_state')
      } catch (error: unknown) {
        if (error instanceof MemoryRevisionConflictError) {
          sendJson(response, 409, {
            error: error.message,
            kind: 'MEMORY_REVISION_CONFLICT',
            current_revision: error.currentRevision,
          })
          return
        }
        if (error instanceof RequestBodyTooLargeError) {
          sendJson(response, 413, { error: error.message, kind: 'MEMORY_BODY_TOO_LARGE' })
          return
        }
        const invalid = error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError
        sendJson(response, invalid ? 400 : 500, {
          error: safeMessage(error),
          kind: invalid ? 'INVALID_MEMORY_REQUEST' : 'MEMORY_RUNTIME_ERROR',
        })
      }
    },
  })
}

function parseMemoryQuery(url: string | undefined): MemoryQuery {
  const parsed = new URL(url ?? MEMORY_API_PATH, 'http://localhost')
  for (const key of parsed.searchParams.keys()) {
    if (key !== 'scope' && key !== 'project' && key !== 'include_inactive') {
      throw new TypeError(`Unknown memory query field: ${key}`)
    }
  }
  const scope = parsed.searchParams.get('scope') ?? 'all'
  if (scope !== 'global' && scope !== 'project' && scope !== 'all') {
    throw new TypeError('memory scope must be global, project or all')
  }
  const project = parsed.searchParams.get('project') ?? undefined
  if (project !== undefined && (project.trim() === '' || project.length > 240)) {
    throw new TypeError('memory project query must contain 1 to 240 characters')
  }
  if (scope === 'project' && project === undefined) throw new TypeError('project scope requires an exact project key')
  if (scope === 'global' && project !== undefined) throw new TypeError('global scope must not include a project key')
  const inactive = parsed.searchParams.get('include_inactive')
  if (inactive !== null && inactive !== 'true' && inactive !== 'false') {
    throw new TypeError('include_inactive must be true or false')
  }
  return {
    scope,
    ...(project === undefined ? {} : { project }),
    include_inactive: inactive === 'true',
  }
}

async function readJsonBody(request: MemoryHttpRequest): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const raw of request) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw
    total += chunk.byteLength
    if (total > JSON_LIMIT_BYTES) {
      throw new RequestBodyTooLargeError(`JSON body exceeds ${JSON_LIMIT_BYTES} bytes`)
    }
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!isRecord(value)) throw new TypeError('JSON body must be an object')
  return value
}

function isTrustedRequest(request: MemoryHttpRequest): boolean {
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
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function assertOnlyFields(body: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields)
  const extra = Object.keys(body).filter(key => !allowed.has(key))
  if (extra.length > 0) throw new TypeError(`Unknown memory request field: ${extra.join(', ')}`)
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}

function sendJson(response: MemoryHttpResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }).end(payload)
}
