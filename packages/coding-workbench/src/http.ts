import { Buffer } from 'node:buffer'
import type { CodingWorkbenchService } from './service.js'

export const WORKBENCH_BASE_PATH = '/api/xiaoshe/workbench'
const LIMIT = 2 * 1024 * 1024
export interface WorkbenchRequest extends AsyncIterable<Uint8Array | string> { readonly method?: string; readonly headers: Record<string, string | string[] | undefined> }
export interface WorkbenchResponse { writeHead(status: number, headers?: Record<string, string | number>): WorkbenchResponse; end(data?: string | Uint8Array): void }
export interface WorkbenchWebServer { register(route: { readonly name: string; readonly kind: 'exact'; readonly path: string; readonly handler: (request: WorkbenchRequest, response: WorkbenchResponse) => void | Promise<void> }): () => void }

export function registerCodingWorkbenchHttpRoutes(server: WorkbenchWebServer, service: CodingWorkbenchService): () => void {
  const get = (suffix: string, action: () => unknown | Promise<unknown>) => route(server, suffix, 'GET', async (_body, response) => send(response, 200, await action()))
  const post = (suffix: string, action: (body: Record<string, unknown>) => unknown | Promise<unknown>) => route(server, suffix, 'POST', async (body, response) => send(response, 200, await action(body)))
  const releases = [
    get('/status', () => service.snapshot()),
    post('/tree', body => service.tree(text(body.workspaceId, 'workspaceId', 512))),
    post('/read', body => service.read(text(body.workspaceId, 'workspaceId', 512), text(body.path, 'path', 4096))),
    post('/git/status', body => service.gitStatus(text(body.workspaceId, 'workspaceId', 512))),
    post('/git/diff', body => service.gitDiff(text(body.workspaceId, 'workspaceId', 512), optionalText(body.path, 'path', 4096), boolean(body.staged, 'staged', false))),
    post('/write/prepare', body => service.prepareWrite({ workspaceId: text(body.workspaceId, 'workspaceId', 512), path: text(body.path, 'path', 4096), newText: text(body.newText, 'newText', 1024 * 1024, true) })),
    post('/write/confirm', body => service.confirmWrite(text(body.id, 'id', 200), text(body.token, 'token', 512))),
    post('/write/revert', body => service.revert(text(body.id, 'id', 200))),
    post('/scripts', body => service.scripts(text(body.workspaceId, 'workspaceId', 512))),
    post('/run', body => service.runScript(text(body.workspaceId, 'workspaceId', 512), text(body.script, 'script', 80))),
    post('/cancel', body => ({ cancelled: service.cancel(text(body.id, 'id', 200)) })),
  ]
  return () => { for (const release of [...releases].reverse()) release() }
}
function route(server: WorkbenchWebServer, suffix: string, method: 'GET' | 'POST', action: (body: Record<string, unknown>, response: WorkbenchResponse) => Promise<void>): () => void {
  return server.register({ name: `xiaoshe-workbench${suffix.replaceAll('/', '-')}`, kind: 'exact', path: `${WORKBENCH_BASE_PATH}${suffix}`, handler: async (request, response) => {
    if (!trusted(request)) { send(response, 403, { error: '该接口只接受同源回环请求。', kind: 'UNTRUSTED_REQUEST' }); return }
    if (request.method !== method) { response.writeHead(405, { allow: method }).end(); return }
    try { await action(method === 'POST' ? await json(request) : {}, response) }
    catch (error) { const invalid = error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError; send(response, invalid ? 400 : 409, { error: safe(error), kind: invalid ? 'INVALID_WORKBENCH_REQUEST' : 'WORKBENCH_OPERATION_FAILED' }) }
  } })
}
async function json(request: WorkbenchRequest): Promise<Record<string, unknown>> {
  if (header(request.headers['content-type'])?.split(';', 1)[0] !== 'application/json') throw new TypeError('application/json is required')
  const chunks: Buffer[] = []; let size = 0
  for await (const value of request) { const chunk = Buffer.from(value); size += chunk.byteLength; if (size > LIMIT) throw new RangeError('workbench request body is too large'); chunks.push(chunk) }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!record(value)) throw new TypeError('JSON body must be an object'); return value
}
function trusted(request: WorkbenchRequest): boolean { const host = header(request.headers.host); if (host === undefined || header(request.headers['sec-fetch-site']) === 'cross-site') return false; try { const product = new URL(`http://${host}`); if (!['localhost', '127.0.0.1', '[::1]'].includes(product.hostname)) return false; const origin = header(request.headers.origin); return origin === undefined || new URL(origin).origin === product.origin } catch { return false } }
function header(value: string | string[] | undefined): string | undefined { return typeof value === 'string' && value !== '' ? value : undefined }
function text(value: unknown, label: string, max: number, empty = false): string { if (typeof value !== 'string' || (!empty && value.trim() === '') || value.length > max || /[\0]/u.test(value)) throw new TypeError(`${label} is invalid`); return value }
function optionalText(value: unknown, label: string, max: number): string | undefined { return value === undefined ? undefined : text(value, label, max) }
function boolean(value: unknown, label: string, fallback: boolean): boolean { if (value === undefined) return fallback; if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`); return value }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safe(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1000) }
function send(response: WorkbenchResponse, status: number, body: unknown): void { const payload = JSON.stringify(body); response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(payload) }
