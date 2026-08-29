import { Buffer } from 'node:buffer'
import type { CandidateSource, ResolvedCandidate } from './audit.js'
import type { ConfirmationChallenge, PluginLifecycleService, PreparePluginInput } from './lifecycle.js'
import type { PluginTransaction } from './store.js'

export const PLUGIN_TRANSACTIONS_PATH = '/api/xiaoshe/plugins/transactions'
export const PLUGIN_AUDIT_PATH = '/api/xiaoshe/plugins/audit'
export const PLUGIN_PREPARE_PATH = '/api/xiaoshe/plugins/prepare'
export const PLUGIN_CONFIRM_PATH = '/api/xiaoshe/plugins/confirm'
const JSON_LIMIT_BYTES = 16 * 1024

export interface PluginHttpRequest extends AsyncIterable<Uint8Array | string> {
  readonly method?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
}
export interface PluginHttpResponse {
  writeHead(status: number, headers?: Record<string, string | number>): PluginHttpResponse
  end(data?: string | Uint8Array): void
}
export interface PluginWebServer {
  register(route: {
    readonly name: string
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (request: PluginHttpRequest, response: PluginHttpResponse) => void | Promise<void>
  }): () => void
}
interface LifecyclePort {
  ready?(): Promise<void>
  audit(source: CandidateSource): Promise<ResolvedCandidate>
  candidate(id: string): ResolvedCandidate | undefined
  prepare(input: PreparePluginInput): Promise<ConfirmationChallenge>
  confirm(input: { readonly challengeId: string; readonly token: string }): Promise<PluginTransaction>
  listTransactions(): readonly PluginTransaction[]
}

class RequestBodyTooLargeError extends Error { readonly name = 'RequestBodyTooLargeError' }
class UnsupportedMediaTypeError extends TypeError { readonly name = 'UnsupportedMediaTypeError' }
class ResourceNotFoundError extends Error { readonly name = 'ResourceNotFoundError' }

/** Register guarded loopback lifecycle endpoints and return one composite disposer. */
export function registerPluginGovernanceHttpRoutes(server: PluginWebServer, service: LifecyclePort | PluginLifecycleService): () => void {
  const releases = [
    server.register({
      name: 'xiaoshe-plugin-transactions', kind: 'exact', path: PLUGIN_TRANSACTIONS_PATH,
      handler: guarded('GET', async (_request, response) => {
        await service.ready?.()
        sendJson(response, 200, { transactions: service.listTransactions().map(publicTransaction) })
      }),
    }),
    server.register({
      name: 'xiaoshe-plugin-audit', kind: 'exact', path: PLUGIN_AUDIT_PATH,
      handler: guarded('POST', async (request, response) => {
        const body = await requireJson(request)
        assertOnlyFields(body, ['source'])
        sendJson(response, 200, { candidate: publicCandidate(await service.audit(parseSource(body.source))) })
      }),
    }),
    server.register({
      name: 'xiaoshe-plugin-prepare', kind: 'exact', path: PLUGIN_PREPARE_PATH,
      handler: guarded('POST', async (request, response) => {
        const body = await requireJson(request)
        assertOnlyFields(body, ['action', 'profile', 'candidateId', 'packageName', 'version', 'sourceProfile', 'rollbackTransactionId'])
        const candidateId = optionalString(body.candidateId, 'candidateId', 200)
        const candidate = candidateId === undefined ? undefined : service.candidate(candidateId)
        if (candidateId !== undefined && candidate === undefined) throw new ResourceNotFoundError('audited candidate not found or process restarted')
        const input: PreparePluginInput = {
          action: pluginAction(body.action),
          profile: requiredString(body.profile, 'profile', 80),
          ...(candidate === undefined ? {} : { candidate }),
          ...(candidateId === undefined ? {} : { candidateId }),
          ...optionalField(body, 'packageName', 214),
          ...optionalField(body, 'version', 500),
          ...optionalField(body, 'sourceProfile', 80),
          ...optionalField(body, 'rollbackTransactionId', 200),
        }
        sendJson(response, 200, { challenge: await service.prepare(input) })
      }),
    }),
    server.register({
      name: 'xiaoshe-plugin-confirm', kind: 'exact', path: PLUGIN_CONFIRM_PATH,
      handler: guarded('POST', async (request, response) => {
        const body = await requireJson(request)
        assertOnlyFields(body, ['challengeId', 'token'])
        const transaction = await service.confirm({
          challengeId: requiredString(body.challengeId, 'challengeId', 200),
          token: requiredString(body.token, 'token', 500),
        })
        sendJson(response, 200, { transaction: publicTransaction(transaction) })
      }),
    }),
  ]
  return () => { for (const release of [...releases].reverse()) release() }
}

function guarded(method: 'GET' | 'POST', handler: (request: PluginHttpRequest, response: PluginHttpResponse) => Promise<void>): (request: PluginHttpRequest, response: PluginHttpResponse) => Promise<void> {
  return async (request, response) => {
    if (!isTrustedRequest(request)) { sendJson(response, 403, { error: '该接口只接受同源回环请求。', kind: 'UNTRUSTED_REQUEST' }); return }
    if (request.method !== method) { response.writeHead(405, { allow: method, 'cache-control': 'no-store' }).end(); return }
    if (method === 'GET') {
      const url = new URL(request.url ?? PLUGIN_TRANSACTIONS_PATH, 'http://localhost')
      if ([...url.searchParams.keys()].length > 0) { sendJson(response, 400, { error: 'plugin transaction list accepts no query fields', kind: 'INVALID_PLUGIN_QUERY' }); return }
    }
    try { await handler(request, response) } catch (error) {
      if (error instanceof UnsupportedMediaTypeError) { sendJson(response, 415, { error: error.message, kind: 'PLUGIN_JSON_REQUIRED' }); return }
      if (error instanceof RequestBodyTooLargeError) { sendJson(response, 413, { error: error.message, kind: 'PLUGIN_BODY_TOO_LARGE' }); return }
      if (error instanceof ResourceNotFoundError) { sendJson(response, 404, { error: error.message, kind: 'PLUGIN_RESOURCE_NOT_FOUND' }); return }
      const message = safeMessage(error)
      const conflict = /expired|already|active profile|running|changed|token|restart/iu.test(message)
      const invalid = error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError
      sendJson(response, conflict ? 409 : invalid ? 400 : 500, {
        error: conflict || invalid ? message : 'plugin lifecycle operation failed',
        kind: conflict ? 'PLUGIN_LIFECYCLE_CONFLICT' : invalid ? 'INVALID_PLUGIN_REQUEST' : 'PLUGIN_LIFECYCLE_ERROR',
      })
    }
  }
}

async function requireJson(request: PluginHttpRequest): Promise<Record<string, unknown>> {
  const contentType = singleHeader(request.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new UnsupportedMediaTypeError('plugin lifecycle writes require application/json')
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

function parseSource(value: unknown): CandidateSource {
  if (!isRecord(value)) throw new TypeError('source must be an object')
  if (value.kind === 'directory' || value.kind === 'tarball') {
    assertOnlyFields(value, ['kind', 'path'])
    return { kind: value.kind, path: requiredString(value.path, 'source.path', 2_000) }
  }
  if (value.kind === 'registry') {
    assertOnlyFields(value, ['kind', 'spec'])
    return { kind: 'registry', spec: requiredString(value.spec, 'source.spec', 500) }
  }
  throw new TypeError('source.kind must be directory, tarball or registry')
}

function publicCandidate(candidate: ResolvedCandidate): Record<string, unknown> {
  return {
    id: candidate.id, packageName: candidate.packageName, version: candidate.version,
    sha256: candidate.sha256, manifestSha256: candidate.manifestSha256,
    identity: candidate.identity, provenance: candidate.provenance, audit: candidate.audit,
    ...(candidate.healthPath === undefined ? {} : { healthPath: candidate.healthPath }),
    osSandboxEnforced: false,
  }
}

export function publicTransaction(transaction: PluginTransaction): Record<string, unknown> {
  return {
    id: transaction.id, action: transaction.action, profile: transaction.profile, packageName: transaction.packageName,
    version: transaction.version, candidateSha256: transaction.candidateSha256, manifestSha256: transaction.manifestSha256,
    state: transaction.state, createdAt: transaction.createdAt, updatedAt: transaction.updatedAt,
    consent: {
      challengeId: transaction.consent.challengeId, expiresAt: transaction.consent.expiresAt,
      confirmed: transaction.consent.confirmedAt !== undefined,
      ...(transaction.consent.confirmedAt === undefined ? {} : { confirmedAt: transaction.consent.confirmedAt }),
    },
    disclosures: transaction.disclosures, events: transaction.events,
    ...(transaction.process === undefined ? {} : { process: transaction.process }),
    ...(transaction.health === undefined ? {} : { health: transaction.health }),
    ...(transaction.rollback === undefined ? {} : { rollback: transaction.rollback }),
    osSandboxEnforced: false,
  }
}

function pluginAction(value: unknown): PreparePluginInput['action'] {
  if (value === 'bootstrap' || value === 'add' || value === 'update' || value === 'remove' || value === 'rollback') return value
  throw new TypeError('action must be bootstrap, add, update, remove or rollback')
}
function optionalField(body: Record<string, unknown>, key: 'packageName' | 'version' | 'sourceProfile' | 'rollbackTransactionId', max: number): Partial<Record<typeof key, string>> {
  const value = optionalString(body[key], key, max)
  return value === undefined ? {} : { [key]: value }
}
function optionalString(value: unknown, label: string, max: number): string | undefined { return value === undefined ? undefined : requiredString(value, label, max) }
function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\r\n\0]/u.test(value)) throw new TypeError(`${label} must be a bounded string`)
  return value
}
function assertOnlyFields(body: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields)
  const extra = Object.keys(body).filter(key => !allowed.has(key))
  if (extra.length > 0) throw new TypeError(`Unknown plugin request field: ${extra.join(', ')}`)
}
function isTrustedRequest(request: PluginHttpRequest): boolean {
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
function singleHeader(value: string | string[] | undefined): string | undefined { return typeof value === 'string' && value !== '' ? value : undefined }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) }
function sendJson(response: PluginHttpResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(payload)
}
