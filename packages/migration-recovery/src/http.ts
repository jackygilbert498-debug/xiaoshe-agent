import { Buffer } from 'node:buffer'
import type { MigrationPreview } from './importer.js'
import type { WorkspacePathMapping } from './path-map.js'
import { MigrationConflictError, type MigrationImportChallenge, type MigrationRecoveryService, type MigrationRecoverySnapshot } from './service.js'

export const MIGRATION_STATUS_PATH = '/api/xiaoshe/migration/status'
export const MIGRATION_EXPORT_PATH = '/api/xiaoshe/migration/export'
export const MIGRATION_INSPECT_PATH = '/api/xiaoshe/migration/inspect'
export const MIGRATION_PREPARE_PATH = '/api/xiaoshe/migration/prepare'
export const MIGRATION_CONFIRM_PATH = '/api/xiaoshe/migration/confirm'
const JSON_LIMIT_BYTES = 64 * 1024

export interface MigrationHttpRequest extends AsyncIterable<Uint8Array | string> {
  readonly method?: string
  readonly headers: Record<string, string | string[] | undefined>
}
export interface MigrationHttpResponse {
  writeHead(status: number, headers?: Record<string, string | number>): MigrationHttpResponse
  end(data?: string | Uint8Array): void
}
export interface MigrationWebServer {
  register(route: {
    readonly name: string
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (request: MigrationHttpRequest, response: MigrationHttpResponse) => void | Promise<void>
  }): () => void
}
interface MigrationServicePort {
  snapshot(): MigrationRecoverySnapshot
  exportTo(target: string): Promise<unknown>
  inspect(input: { readonly bundlePath: string; readonly mappings: readonly WorkspacePathMapping[] }): Promise<MigrationPreview>
  prepareImport(input: { readonly bundlePath: string; readonly mappings: readonly WorkspacePathMapping[] }): Promise<MigrationImportChallenge>
  confirmImport(input: { readonly challengeId: string; readonly token: string }): Promise<void>
}

class RequestBodyTooLargeError extends Error { readonly name = 'RequestBodyTooLargeError' }
class UnsupportedMediaTypeError extends TypeError { readonly name = 'UnsupportedMediaTypeError' }

/** Register loopback-only migration routes. Every import write is confirmation-gated. */
export function registerMigrationRecoveryHttpRoutes(server: MigrationWebServer, service: MigrationServicePort | MigrationRecoveryService): () => void {
  const releases = [
    server.register({
      name: 'xiaoshe-migration-status', kind: 'exact', path: MIGRATION_STATUS_PATH,
      handler: guarded('GET', async (_request, response) => { sendJson(response, 200, service.snapshot()) }),
    }),
    server.register({
      name: 'xiaoshe-migration-export', kind: 'exact', path: MIGRATION_EXPORT_PATH,
      handler: guarded('POST', async (request, response) => {
        const body = await requireJson(request); assertOnlyFields(body, ['target'])
        const target = requiredPath(body.target, 'target')
        const manifest = await service.exportTo(target)
        sendJson(response, 200, { manifest, snapshot: service.snapshot() })
      }),
    }),
    server.register({
      name: 'xiaoshe-migration-inspect', kind: 'exact', path: MIGRATION_INSPECT_PATH,
      handler: guarded('POST', async (request, response) => {
        const input = importInput(await requireJson(request))
        sendJson(response, 200, { preview: await service.inspect(input), snapshot: service.snapshot() })
      }),
    }),
    server.register({
      name: 'xiaoshe-migration-prepare', kind: 'exact', path: MIGRATION_PREPARE_PATH,
      handler: guarded('POST', async (request, response) => {
        const input = importInput(await requireJson(request))
        sendJson(response, 200, { challenge: await service.prepareImport(input), snapshot: service.snapshot() })
      }),
    }),
    server.register({
      name: 'xiaoshe-migration-confirm', kind: 'exact', path: MIGRATION_CONFIRM_PATH,
      handler: guarded('POST', async (request, response) => {
        const body = await requireJson(request); assertOnlyFields(body, ['challengeId', 'token'])
        await service.confirmImport({
          challengeId: requiredString(body.challengeId, 'challengeId', 256),
          token: requiredString(body.token, 'token', 512),
        })
        sendJson(response, 200, { snapshot: service.snapshot() })
      }),
    }),
  ]
  return () => { for (const release of [...releases].reverse()) release() }
}

function guarded(method: 'GET' | 'POST', action: (request: MigrationHttpRequest, response: MigrationHttpResponse) => Promise<void>) {
  return async (request: MigrationHttpRequest, response: MigrationHttpResponse): Promise<void> => {
    if (!isTrustedRequest(request)) { sendJson(response, 403, { error: '该接口只接受同源回环请求。', kind: 'UNTRUSTED_REQUEST' }); return }
    if (request.method !== method) { response.writeHead(405, { allow: method, 'cache-control': 'no-store' }).end(); return }
    try { await action(request, response) }
    catch (error: unknown) {
      if (error instanceof UnsupportedMediaTypeError) { sendJson(response, 415, { error: error.message, kind: 'JSON_REQUIRED' }); return }
      if (error instanceof RequestBodyTooLargeError) { sendJson(response, 413, { error: error.message, kind: 'BODY_TOO_LARGE' }); return }
      if (error instanceof MigrationConflictError) { sendJson(response, 409, { error: error.message, kind: 'MIGRATION_CONFLICT', preview: error.preview }); return }
      const message = safeMessage(error)
      if (/already running|unknown challenge|expired|does not match/iu.test(message)) { sendJson(response, 409, { error: message, kind: 'MIGRATION_STATE_CONFLICT' }); return }
      const invalid = error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError
      sendJson(response, invalid ? 400 : 500, { error: message, kind: invalid ? 'INVALID_MIGRATION_REQUEST' : 'MIGRATION_RUNTIME_ERROR' })
    }
  }
}

function importInput(body: Record<string, unknown>): { readonly bundlePath: string; readonly mappings: readonly WorkspacePathMapping[] } {
  assertOnlyFields(body, ['bundlePath', 'mappings'])
  const value = body.mappings ?? []
  if (!Array.isArray(value) || value.length > 200) throw new TypeError('mappings must be an array with at most 200 entries')
  const mappings = value.map((row, index): WorkspacePathMapping => {
    if (!isRecord(row)) throw new TypeError(`mappings[${index}] must be an object`)
    assertOnlyFields(row, ['from', 'to'])
    return Object.freeze({ from: requiredPath(row.from, `mappings[${index}].from`), to: requiredPath(row.to, `mappings[${index}].to`) })
  })
  return Object.freeze({ bundlePath: requiredPath(body.bundlePath, 'bundlePath'), mappings: Object.freeze(mappings) })
}

async function requireJson(request: MigrationHttpRequest): Promise<Record<string, unknown>> {
  const contentType = singleHeader(request.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new UnsupportedMediaTypeError('migration controls require application/json')
  const chunks: Uint8Array[] = []; let total = 0
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

function isTrustedRequest(request: MigrationHttpRequest): boolean {
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
  const allowed = new Set(fields); const extra = Object.keys(body).filter(key => !allowed.has(key))
  if (extra.length > 0) throw new TypeError(`Unknown migration request field: ${extra.join(', ')}`)
}
function requiredPath(value: unknown, name: string): string { return requiredString(value, name, 4_096) }
function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`)
  const normalized = value.trim()
  if (normalized === '' || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new TypeError(`${name} is invalid`)
  return normalized
}
function singleHeader(value: string | string[] | undefined): string | undefined { return typeof value === 'string' && value !== '' ? value : undefined }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) }
function sendJson(response: MigrationHttpResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  }).end(payload)
}
