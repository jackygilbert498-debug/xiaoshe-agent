import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BridgeRpcError } from './bridge-client.js'
import { MemoryRevisionConflictError } from './memory-service.js'
import type { MemoryService } from './memory-service.js'
import type { ActionToolController } from './action-controller.js'
import type {
  HttpRequestLike,
  HttpResponseLike,
  JsonValue,
  SettingsSchemaLike,
  SettingsScopeLike,
  WebServerLike,
} from './types.js'
import type { BridgeRequester } from './tools.js'

const STATUS_PATH = '/xiaoshe/desktop/status'
const PROBE_PATH = '/xiaoshe/desktop/probe'
const ACTIONS_PATH = '/xiaoshe/desktop/actions'
const PREFERENCES_PATH = '/xiaoshe/preferences'
const PREVIEW_PATH = '/xiaoshe/desktop/preview'
const execFileAsync = promisify(execFile)
const BRAND_ICON_PATH = '/xiaoshe/brand/favicon.svg'
const MEMORY_PATH = '/xiaoshe/memory'
const JSON_LIMIT_BYTES = 4 * 1024
const MEMORY_JSON_LIMIT_BYTES = 16 * 1024
const PREVIEW_LIMIT_BYTES = 50 * 1024 * 1024
const BRAND_ICON_LIMIT_BYTES = 256 * 1024

interface PreviewRecord {
  readonly token: string
  readonly path: string
}

interface ProbeRecord {
  readonly state: 'unknown' | 'available' | 'denied' | 'error'
  readonly message: string
  readonly checkedAt: string | null
  readonly elementCount?: number
}

export interface RuntimeRouteDependencies {
  readonly bridge: BridgeRequester
  readonly actions: ActionToolController
  readonly settings: SettingsScopeLike
  readonly setActionsEnabled: (enabled: boolean) => Promise<void>
  readonly setResponseStyle: (responseStyle: ResponseStyle) => Promise<void>
  readonly modlensAvailable: () => boolean
  readonly memory: MemoryService
  /** Absolute path to the sole Xiaoshe brand master; never a copied derivative. */
  readonly brandIconPath: string
  readonly version: string
}

export type ResponseStyle = 'pragmatic' | 'friendly'

/** Strict schema for durable Xiaoshe product preferences. */
export const desktopSettingsSchema: SettingsSchemaLike = Object.assign(
  (value: unknown): Record<string, JsonValue> => {
    if (value === undefined || value === null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('xiaoshe-desktop settings must be an object')
    }
    const record = value as Record<string, unknown>
    const extra = Object.keys(record).filter(key => key !== 'actionsEnabled' && key !== 'responseStyle')
    if (extra.length > 0) throw new TypeError(`Unknown xiaoshe-desktop setting: ${extra.join(', ')}`)
    if (record.actionsEnabled !== undefined && typeof record.actionsEnabled !== 'boolean') {
      throw new TypeError('xiaoshe-desktop.actionsEnabled must be a boolean')
    }
    if (record.responseStyle !== undefined && record.responseStyle !== 'pragmatic' && record.responseStyle !== 'friendly') {
      throw new TypeError('xiaoshe-desktop.responseStyle must be pragmatic or friendly')
    }
    return {
      ...(record.actionsEnabled === undefined ? {} : { actionsEnabled: record.actionsEnabled }),
      ...(record.responseStyle === undefined ? {} : { responseStyle: record.responseStyle }),
    } as Record<string, JsonValue>
  },
  {
    toJSON: () => ({
      uid: 0,
      refs: {
        0: {
          type: 'object',
          meta: { default: {} },
          dict: {
            actionsEnabled: {
              type: 'boolean',
              meta: { description: '是否在本次小蛇运行中注册点击、输入和按键工具。' },
            },
            responseStyle: {
              type: 'string',
              meta: { description: '小蛇后续回复使用务实或亲和的表达方式。' },
            },
          },
        },
      },
    }),
  },
)

/** Read the persisted preference with a fail-closed fallback. */
export function actionsPreference(settings: SettingsScopeLike, fallback: boolean): boolean {
  const value = settings.get().actionsEnabled
  return typeof value === 'boolean' ? value : fallback
}

/** Read the saved response style, treating older settings as the pragmatic default. */
export function responseStylePreference(settings: SettingsScopeLike): ResponseStyle {
  return settings.get().responseStyle === 'friendly' ? 'friendly' : 'pragmatic'
}

/** Mount loopback-only status, permission-probe, action-switch, preview and brand routes. */
export function registerRuntimeRoutes(
  server: WebServerLike,
  dependencies: RuntimeRouteDependencies,
): () => void {
  let latestPreview: PreviewRecord | undefined
  let lastProbe: ProbeRecord = { state: 'unknown', message: '尚未检测屏幕权限。', checkedAt: null }

  const disposers = [
    server.register({
      name: 'xiaoshe-brand-favicon',
      kind: 'exact',
      path: BRAND_ICON_PATH,
      handler: async (request, response) => {
        if (!guard(request, response, 'GET')) return
        try {
          const info = await lstat(dependencies.brandIconPath)
          if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > BRAND_ICON_LIMIT_BYTES) {
            throw new Error('小蛇品牌母本不是有效的 SVG 文件')
          }
          const bytes = await readFile(dependencies.brandIconPath)
          response.writeHead(200, {
            'content-type': 'image/svg+xml; charset=utf-8',
            'content-length': bytes.byteLength,
            // The client adds a version query. Long-lived caching is therefore
            // safe while keeping the exact legacy master as the only source.
            'cache-control': 'public, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
          }).end(bytes)
        } catch (error: unknown) {
          const fault = faultSummary(error)
          sendJson(response, 500, { error: fault.message, kind: 'BRAND_ICON_UNAVAILABLE' })
        }
      },
    }),
    server.register({
      name: 'xiaoshe-desktop-status',
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (request, response) => {
        if (!guard(request, response, 'GET')) return
        const abort = requestAbort(request)
        let bridge: Record<string, unknown>
        try {
          const health = objectResult(await dependencies.bridge.request('health', {}, abort.signal), 'health')
          bridge = {
            state: 'ready',
            protocol: stringField(health, 'protocol_version'),
            platform: stringField(health, 'platform'),
          }
        } catch (error: unknown) {
          bridge = { state: 'error', ...faultSummary(error) }
        }
        sendJson(response, 200, {
          api_version: 1,
          product: '小蛇',
          version: dependencies.version,
          response_style: responseStylePreference(dependencies.settings),
          bridge,
          actions: {
            deployment_allowed: dependencies.actions.deploymentAllowed,
            enabled: dependencies.actions.enabled,
            persistent: true,
          },
          modlens_available: dependencies.modlensAvailable(),
          last_probe: {
            state: lastProbe.state,
            message: lastProbe.message,
            checked_at: lastProbe.checkedAt,
            ...(lastProbe.elementCount === undefined ? {} : { element_count: lastProbe.elementCount }),
          },
        })
      },
    }),
    server.register({
      name: 'xiaoshe-memory',
      kind: 'exact',
      path: MEMORY_PATH,
      handler: async (request, response) => {
        if (!guard(request, response, ['GET', 'POST'])) return
        if (request.method === 'GET') {
          try {
            sendJson(response, 200, dependencies.memory.snapshot(memoryQuery(request.url)))
          } catch (error: unknown) {
            const fault = faultSummary(error)
            sendJson(response, 400, { error: fault.message, kind: 'INVALID_MEMORY_QUERY' })
          }
          return
        }
        const contentType = singleHeader(request.headers?.['content-type'])?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/json') {
          sendJson(response, 415, {
            error: 'memory writes require application/json',
            kind: 'MEMORY_JSON_REQUIRED',
          })
          return
        }
        try {
          const body = await readJsonBody(request, MEMORY_JSON_LIMIT_BYTES)
          const expectedRevision = nonNegativeIntegerField(body, 'expected_revision')
          let snapshot
          if (body.action === 'remember') {
            assertOnlyFields(body, ['action', 'expected_revision', 'scope', 'project', 'text', 'replaces_id'])
            snapshot = await dependencies.memory.remember({
              scope: body.scope as never,
              ...(body.project === undefined ? {} : { project: body.project as never }),
              text: body.text as never,
              ...(body.replaces_id === undefined ? {} : { replaces_id: body.replaces_id as never }),
            }, expectedRevision)
          } else if (body.action === 'set_state') {
            assertOnlyFields(body, ['action', 'expected_revision', 'id', 'state'])
            if (typeof body.id !== 'string' || (body.state !== 'active' && body.state !== 'forgotten')) {
              throw new TypeError('set_state requires an id and active or forgotten state')
            }
            snapshot = await dependencies.memory.setState(body.id, body.state, expectedRevision)
          } else {
            throw new TypeError('memory action must be remember or set_state')
          }
          sendJson(response, 200, snapshot)
        } catch (error: unknown) {
          if (error instanceof MemoryRevisionConflictError) {
            sendJson(response, 409, {
              error: error.message,
              kind: 'MEMORY_REVISION_CONFLICT',
              current_revision: error.currentRevision,
            })
            return
          }
          const fault = faultSummary(error)
          const invalid = error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError
          sendJson(response, invalid ? 400 : 500, {
            error: fault.message,
            kind: invalid ? 'INVALID_MEMORY_REQUEST' : 'MEMORY_RUNTIME_ERROR',
          })
        }
      },
    }),
    server.register({
      name: 'xiaoshe-desktop-probe',
      kind: 'exact',
      path: PROBE_PATH,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        const abort = requestAbort(request)
        try {
          const result = objectResult(
            await dependencies.bridge.request(
              'observe',
              { include_elements: true, max_elements: 20 },
              abort.signal,
            ),
            'observe',
          )
          const imagePath = stringField(result, 'image_path')
          await assertPrivatePreview(imagePath)
          const elements = Array.isArray(result.elements) ? result.elements : []
          const token = randomBytes(18).toString('base64url')
          latestPreview = { token, path: imagePath }
          lastProbe = {
            state: 'available',
            message: '屏幕截图与 AX/UIA 元素读取均可用。',
            checkedAt: new Date().toISOString(),
            elementCount: elements.length,
          }
          sendJson(response, 200, {
            state: 'available',
            preview_url: `${PREVIEW_PATH}?token=${encodeURIComponent(token)}`,
            captured_at: result.captured_at ?? null,
            pixel_size: result.pixel_size ?? null,
            logical_size: result.logical_size ?? null,
            element_count: elements.length,
            warnings: Array.isArray(result.warnings) ? result.warnings : [],
          })
        } catch (error: unknown) {
          const fault = faultSummary(error)
          lastProbe = {
            state: fault.kind === 'SCREEN_CAPTURE_FAILED' ? 'denied' : 'error',
            message: fault.message,
            checkedAt: new Date().toISOString(),
          }
          sendJson(response, 409, { error: fault.message, kind: fault.kind })
        }
      },
    }),
    server.register({
      name: 'xiaoshe-desktop-actions',
      kind: 'exact',
      path: ACTIONS_PATH,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        try {
          const body = await readJsonBody(request, JSON_LIMIT_BYTES)
          if (typeof body.enabled !== 'boolean' || Object.keys(body).some(key => key !== 'enabled')) {
            throw new TypeError('Body must be exactly {"enabled": boolean}')
          }
          await dependencies.setActionsEnabled(body.enabled)
          sendJson(response, 200, {
            deployment_allowed: dependencies.actions.deploymentAllowed,
            enabled: dependencies.actions.enabled,
            persistent: true,
          })
        } catch (error: unknown) {
          const fault = faultSummary(error)
          sendJson(response, 400, { error: fault.message, kind: fault.kind })
        }
      },
    }),
    server.register({
      name: 'xiaoshe-preferences',
      kind: 'exact',
      path: PREFERENCES_PATH,
      handler: async (request, response) => {
        if (!guard(request, response, 'POST')) return
        try {
          const body = await readJsonBody(request, JSON_LIMIT_BYTES)
          if (
            (body.response_style !== 'pragmatic' && body.response_style !== 'friendly')
            || Object.keys(body).some(key => key !== 'response_style')
          ) {
            throw new TypeError('Body must be exactly {"response_style": "pragmatic" | "friendly"}')
          }
          await dependencies.setResponseStyle(body.response_style)
          sendJson(response, 200, {
            response_style: responseStylePreference(dependencies.settings),
            persistent: true,
          })
        } catch (error: unknown) {
          const fault = faultSummary(error)
          sendJson(response, 400, { error: fault.message, kind: fault.kind })
        }
      },
    }),
    server.register({
      name: 'xiaoshe-desktop-preview',
      kind: 'exact',
      path: PREVIEW_PATH,
      handler: async (request, response) => {
        if (!guard(request, response, 'GET')) return
        const token = new URL(request.url ?? PREVIEW_PATH, 'http://localhost').searchParams.get('token')
        const preview = latestPreview
        if (preview === undefined || token === null || token !== preview.token) {
          sendJson(response, 404, { error: '截图预览已失效，请重新检测。', kind: 'PREVIEW_EXPIRED' })
          return
        }
        // Consume before the asynchronous file read so concurrent requests cannot
        // replay the same capability URL. The original screenshot remains owned
        // by the bridge because ModLens may still need its private file path.
        latestPreview = undefined
        try {
          await assertPrivatePreview(preview.path)
          const bytes = await readFile(preview.path)
          response.writeHead(200, {
            'content-type': 'image/png',
            'content-length': bytes.byteLength,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          }).end(bytes)
        } catch (error: unknown) {
          const fault = faultSummary(error)
          sendJson(response, 410, { error: fault.message, kind: 'PREVIEW_UNAVAILABLE' })
        }
      },
    }),
  ]

  return () => {
    latestPreview = undefined
    for (const dispose of disposers.reverse()) dispose()
  }
}

function guard(
  request: HttpRequestLike,
  response: HttpResponseLike,
  method: 'GET' | 'POST' | readonly ['GET', 'POST'],
): boolean {
  if (!isTrustedRequest(request)) {
    sendJson(response, 403, { error: '该接口只接受同源回环请求。', kind: 'UNTRUSTED_REQUEST' })
    return false
  }
  const methods = Array.isArray(method) ? method : [method]
  if (!methods.includes(request.method as never)) {
    response.writeHead(405, { allow: methods.join(', '), 'cache-control': 'no-store' }).end()
    return false
  }
  return true
}

function memoryQuery(url: string | undefined): {
  scope: 'global' | 'project' | 'all'
  project?: string
  include_inactive: boolean
} {
  const parsed = new URL(url ?? MEMORY_PATH, 'http://localhost')
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
  if (scope === 'project' && project === undefined) {
    throw new TypeError('project memory query requires an exact project key')
  }
  if (scope === 'global' && project !== undefined) {
    throw new TypeError('global memory query must not include a project key')
  }
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

function assertOnlyFields(body: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields)
  const extra = Object.keys(body).filter(key => !allowed.has(key))
  if (extra.length > 0) throw new TypeError(`Unknown memory request field: ${extra.join(', ')}`)
}

function nonNegativeIntegerField(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`)
  }
  return value
}

function requestAbort(request: HttpRequestLike): AbortController {
  const controller = new AbortController()
  request.once('aborted', () => controller.abort())
  return controller
}

function isTrustedRequest(request: HttpRequestLike): boolean {
  const host = singleHeader(request.headers?.host)
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false
  if (singleHeader(request.headers?.['sec-fetch-site']) === 'cross-site') return false
  const origin = singleHeader(request.headers?.origin)
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
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

async function readJsonBody(request: HttpRequestLike, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    total += chunk.byteLength
    if (total > limit) {
      request.destroy()
      throw new RangeError(`JSON body exceeds ${limit} bytes`)
    }
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('JSON body must be an object')
  }
  return value as Record<string, unknown>
}

async function assertPrivatePreview(path: string): Promise<void> {
  if (!isAbsolute(path) || !basename(path).startsWith('screen-') || !path.endsWith('.png')) {
    throw new Error('Bridge returned an invalid preview path')
  }
  const canonicalPath = await realpath(path)
  const canonicalRuntimeDirectory = dirname(canonicalPath)
  const canonicalTemporaryDirectory = await realpath(tmpdir())
  if (dirname(canonicalRuntimeDirectory) !== canonicalTemporaryDirectory
    || !basename(canonicalRuntimeDirectory).startsWith('xiaoshe-dsh-')) {
    throw new Error('Bridge preview is outside its private runtime directory')
  }
  const [info, directoryInfo] = await Promise.all([
    lstat(path),
    lstat(dirname(path)),
  ])
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Bridge preview is not a regular file')
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('Bridge preview runtime directory is invalid')
  }
  if (info.size <= 0 || info.size > PREVIEW_LIMIT_BYTES) throw new Error('Bridge preview size is invalid')
  if (process.platform !== 'win32') {
    if ((info.mode & 0o077) !== 0 || (directoryInfo.mode & 0o077) !== 0) {
      throw new Error('Bridge preview permissions are not private')
    }
    if (typeof process.getuid === 'function' && (info.uid !== process.getuid() || directoryInfo.uid !== process.getuid())) {
      throw new Error('Bridge preview is not owned by the current user')
    }
  } else {
    const helper = fileURLToPath(new URL('../scripts/check-private-path-windows.ps1', import.meta.url))
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, path, dirname(path),
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    const result: unknown = JSON.parse(stdout)
    if (typeof result !== 'object' || result === null || !Object.hasOwn(result, 'private')
      || (result as { readonly private?: unknown }).private !== true) {
      throw new Error('Bridge preview Windows ACL is not private')
    }
  }
}

function objectResult(value: JsonValue, operation: string): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${operation} returned a non-object result`)
  }
  return value
}

function stringField(record: Record<string, JsonValue>, name: string): string {
  const value = record[name]
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} is missing from bridge result`)
  return value
}

function faultSummary(error: unknown): { kind: string; message: string } {
  if (error instanceof BridgeRpcError) {
    const data = error.rpcData
    const kind = typeof data === 'object' && data !== null && !Array.isArray(data)
      && typeof (data as Record<string, unknown>).kind === 'string'
      ? String((data as Record<string, unknown>).kind)
      : 'BRIDGE_RPC_ERROR'
    return { kind, message: error.message.slice(0, 1_000) }
  }
  return {
    kind: error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError
      ? 'INVALID_REQUEST'
      : 'RUNTIME_ERROR',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
  }
}

function sendJson(response: HttpResponseLike, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }).end(payload)
}
