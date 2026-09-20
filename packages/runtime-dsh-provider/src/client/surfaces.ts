import type {
  WorkSurface,
  WorkSurfaceCapabilities,
  WorkSurfaceContributionRegistry,
  WorkSurfaceDiff,
  WorkSurfaceRegistry,
  WorkSurfaceRegistrySnapshot,
  WorkSurfaceTrust,
} from '@xiaoshe/runtime-contract'
import { WORK_SURFACE_VIEW } from './surface-view.js'
export { registerWorkSurfaceView } from './surface-view.js'

const MAX_SURFACES = 24
const MAX_TEXT_LINES = 2_000
const MAX_TEXT_BYTES = 512 * 1024
const MAX_TERMINAL_BYTES = 256 * 1024
const MAX_DIFFS = 24
const MAX_DIFF_BYTES = 384 * 1024
const MAX_CONTENT_BLOCKS = 128
const MAX_SUBCALL_DEPTH = 32
const SENSITIVE_QUERY_KEY = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth|authorization|credential|jwt|password|secret|signature|sig|token)(?:$|[_-])/iu
const LOOPBACK_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/[^\s<>"']*)?/giu

interface ObservableSnapshotPort<T = unknown> {
  getSnapshot(): T
  subscribe?(listener: () => void): () => void
}

interface SurfaceSessionFacePort {
  getSnapshot?(): {
    readonly nodes?: readonly unknown[]
    readonly runningCalls?: readonly unknown[]
    readonly views?: { get(target: string): unknown }
  }
  subscribe?(listener: () => void): () => void
}

interface SurfaceSessionsPort {
  readonly list: {
    getSnapshot(): {
      readonly current?: string
      readonly byId: Readonly<Record<string, { readonly cwd?: string }>>
    }
    subscribe(listener: () => void): () => void
  }
  binding(id: string): { readonly session: SurfaceSessionFacePort } | undefined
}

export interface SafeSurfaceUrl {
  readonly displayUrl: string
  readonly url?: string
  readonly trust: 'loopback' | 'external' | 'unknown'
  readonly embed: 'loopback' | 'external-only' | 'blocked'
  readonly reason?: string
}

/** Remove credential-bearing URL material before it crosses the Product service. */
export function safeSurfaceUrl(raw: string): SafeSurfaceUrl {
  const input = raw.trim()
  let value: URL
  try { value = new URL(input) }
  catch { return { displayUrl: bounded(input, 2_000), trust: 'unknown', embed: 'blocked', reason: '网址格式无效' } }
  if (value.protocol !== 'http:' && value.protocol !== 'https:') {
    return { displayUrl: `${value.protocol}//…`, trust: 'unknown', embed: 'blocked', reason: '只允许 HTTP(S) 网址' }
  }
  const sensitive = value.username !== '' || value.password !== '' || value.hash !== ''
    || [...value.searchParams.keys()].some(key => SENSITIVE_QUERY_KEY.test(key))
  value.username = ''
  value.password = ''
  value.hash = ''
  for (const key of [...value.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) value.searchParams.set(key, '[已隐藏]')
  }
  const displayUrl = bounded(value.toString(), 2_000)
  const loopback = isLoopbackHost(value.hostname)
  if (sensitive) {
    return { displayUrl, trust: loopback ? 'loopback' : 'external', embed: 'blocked', reason: '网址含凭据或敏感参数，已阻止内嵌与跳转' }
  }
  return loopback
    ? { displayUrl, url: displayUrl, trust: 'loopback', embed: 'loopback' }
    : { displayUrl, url: displayUrl, trust: 'external', embed: 'external-only', reason: '外部网页不在小蛇内嵌，避免跨域认证与页面劫持' }
}

export function isLoopbackHost(hostname: string): boolean {
  const value = hostname.toLocaleLowerCase('en-US')
  return value === 'localhost' || value === '127.0.0.1' || value === '::1' || value === '[::1]'
}

/** Public current-session SurfaceRegistry backed only by DSH's replayable Client snapshot. */
export class DshWorkSurfaceRegistry implements WorkSurfaceContributionRegistry {
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeList: () => void
  private unsubscribeSession: (() => void) | undefined
  private snapshot: WorkSurfaceRegistrySnapshot = { items: [] }
  private readonly contributions = new Map<string, { readonly sessionId: string; readonly items: readonly WorkSurface[] }>()
  private disposed = false

  constructor(private readonly sessions: SurfaceSessionsPort) {
    this.rebind()
    this.unsubscribeList = sessions.list.subscribe(() => { this.rebind(); this.publish() })
  }

  getSnapshot(): WorkSurfaceRegistrySnapshot { return this.snapshot }

  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error('WorkSurfaceRegistry provider is disposed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publishContribution(namespace: string, sessionId: string, items: readonly WorkSurface[]): () => void {
    if (this.disposed) throw new Error('WorkSurfaceRegistry provider is disposed')
    if (!/^[a-z][a-z0-9._-]{0,79}$/u.test(namespace)) throw new TypeError('surface contribution namespace is invalid')
    if (sessionId === '' || sessionId.length > 512 || /[\r\n\0]/u.test(sessionId)) throw new TypeError('surface contribution session is invalid')
    const bounded = Object.freeze(items.slice(-MAX_SURFACES).filter(item => item.sessionId === sessionId))
    this.contributions.set(namespace, { sessionId, items: bounded })
    this.publish()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.contributions.delete(namespace)
      this.publish()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeSession?.()
    this.unsubscribeList()
    this.contributions.clear()
    this.listeners.clear()
  }

  private rebind(): void {
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    const current = this.sessions.list.getSnapshot().current
    const face = current === undefined ? undefined : this.sessions.binding(current)?.session
    if (face?.subscribe !== undefined) this.unsubscribeSession = face.subscribe(() => this.publish())
    this.snapshot = this.project(current, face)
  }

  private publish(): void {
    if (this.disposed) return
    const current = this.sessions.list.getSnapshot().current
    const face = current === undefined ? undefined : this.sessions.binding(current)?.session
    this.snapshot = this.project(current, face)
    for (const listener of this.listeners) listener()
  }

  private project(sessionId: string | undefined, face: SurfaceSessionFacePort | undefined): WorkSurfaceRegistrySnapshot {
    if (sessionId === undefined || face === undefined) return { items: [] }
    const cwd = this.sessions.list.getSnapshot().byId[sessionId]?.cwd
    const durable = projectDshWorkSurfaces(sessionId, cwd, face.getSnapshot?.())
    const contributed = [...this.contributions.values()].flatMap(row => row.sessionId === sessionId ? row.items : [])
    const merged = new Map<string, WorkSurface>()
    for (const item of [...durable, ...contributed]) {
      const previous = merged.get(item.id)
      if (previous === undefined || previous.updatedAt <= item.updatedAt) merged.set(item.id, item)
    }
    return { sessionId, items: [...merged.values()].sort((left, right) => left.updatedAt - right.updatedAt || left.seq - right.seq).slice(-MAX_SURFACES) }
  }
}

/** Pure, bounded projector used by tests and by the live provider. */
export function projectDshWorkSurfaces(
  sessionId: string,
  cwd: string | undefined,
  snapshot: { readonly nodes?: readonly unknown[]; readonly runningCalls?: readonly unknown[] } | undefined,
): readonly WorkSurface[] {
  const projected: WorkSurface[] = []
  // Generic chat is deliberately absent from the product composition. Prefer
  // the independently registered tool-only view, retaining the old public
  // snapshot fallback for older DSH clients and other shells.
  const data = record((snapshot as ReturnType<NonNullable<SurfaceSessionFacePort['getSnapshot']>>)?.views?.get(WORK_SURFACE_VIEW))
  const nodes = Array.isArray(data?.nodes) ? data.nodes : snapshot?.nodes ?? []
  const runningCalls = Array.isArray(data?.runningCalls) ? data.runningCalls : snapshot?.runningCalls ?? []
  for (const row of flattenToolBlocks(nodes, MAX_SUBCALL_DEPTH)) {
    if (row.kind !== 'tool-result') continue
    projected.push(...surfacesForResult(sessionId, cwd, row))
  }
  for (const row of flattenToolBlocks(runningCalls, MAX_SUBCALL_DEPTH)) {
    if (row.kind === 'tool-result') continue
    projected.push(...surfacesForRunningCall(sessionId, cwd, row))
  }
  const deduped = new Map<string, WorkSurface>()
  for (const surface of projected) {
    const previous = deduped.get(surface.id)
    if (previous === undefined || previous.updatedAt <= surface.updatedAt) deduped.set(surface.id, surface)
  }
  return withFileMaterialTitles([...deduped.values()]
    .sort((left, right) => left.updatedAt - right.updatedAt || left.seq - right.seq || left.id.localeCompare(right.id))
    .slice(-MAX_SURFACES), cwd)
}

/** Label only validated read/diff evidence, never parse a tool's prose title.
 * Paths, evidence and counts stay unchanged; sibling filenames receive the
 * shortest distinguishing parent suffix within this bounded session window.
 */
function withFileMaterialTitles(items: readonly WorkSurface[], cwd: string | undefined): readonly WorkSurface[] {
  const files = items.flatMap(item => {
    if ((item.view.kind !== 'text' && item.view.kind !== 'diff') || !validFileSource(item.source)) return []
    const path = normalizedPath(isAbsolutePath(item.source) || cwd === undefined ? item.source : `${cwd}/${item.source}`)
    const parts = path.split('/').filter(Boolean)
    const basename = parts.at(-1)
    if (basename === undefined) return []
    const windows = /^[a-z]:\//iu.test(path)
    const key = windows ? path.toLocaleLowerCase('en-US') : path
    return [{ item, basename, key, parents: parts.slice(0, -1), nameKey: windows ? basename.toLocaleLowerCase('en-US') : basename, windows }]
  })
  const titles = new Map<string, string>()
  for (const file of files) {
    const peers = files.filter(other => other.nameKey === file.nameKey && other.key !== file.key)
    let directory = ''
    if (peers.length > 0) {
      for (let depth = 1; depth <= Math.max(1, file.parents.length); depth++) {
        directory = file.parents.slice(-depth).join('/') || '.'
        const equal = (other: typeof file): boolean => {
          const suffix = other.parents.slice(-depth).join('/') || '.'
          return file.windows ? suffix.toLocaleLowerCase('en-US') === directory.toLocaleLowerCase('en-US') : suffix === directory
        }
        if (!peers.some(equal)) break
      }
    }
    const view = file.item.view
    const operation = view.kind === 'text' ? '读取' : '改动'
    const fileCount = view.kind === 'diff' ? new Set(view.diffs.map(diff => normalizedPath(diff.path))).size : 1
    titles.set(file.item.id, bounded(`${file.basename}${directory === '' ? '' : ` · ${directory}`} · ${operation}${fileCount > 1 ? `（${fileCount} 个文件）` : ''}`, 160))
  }
  return items.map(item => titles.has(item.id) ? { ...item, title: titles.get(item.id) as string } : item)
}

function surfacesForResult(sessionId: string, cwd: string | undefined, row: Record<string, unknown>): WorkSurface[] {
  const callId = string(row.callId) ?? `seq-${number(row.seq) ?? 0}`
  const seq = number(row.seq) ?? 0
  const updatedAt = number(row.time) ?? seq
  const call = record(row.call)
  const callView = record(row.callView)
  const resultView = record(row.resultView)
  const name = string(call?.name) ?? callId
  const title = surfaceTitle(resultView, callView, name)
  const status = row.isError === true ? 'error' as const : 'ready' as const
  const base = { sessionId, callId, seq, updatedAt, status }
  const surfaces: WorkSurface[] = []

  if (resultView?.card === 'web') {
    const rawUrl = string(resultView.url) ?? firstWebSourceUrl(resultView)
    if (rawUrl !== undefined) surfaces.push(webSurface(base, `${callId}:web`, title, rawUrl))
  }

  if (resultView?.card === 'read' && validFileSource(resultView.path)) {
    const rawLines = Array.isArray(resultView.lines) ? resultView.lines : []
    let lineTextTruncated = false
    const lines = rawLines.slice(0, MAX_TEXT_LINES + 1).flatMap(value => {
      const line = record(value)
      if (typeof line?.number !== 'number' || typeof line.text !== 'string') return []
      lineTextTruncated ||= line.text.length > 32_768
      return [{ number: Math.max(1, Math.floor(line.number)), text: bounded(line.text, 32_768) }]
    })
    const boundedLines = boundLines(lines, MAX_TEXT_LINES, MAX_TEXT_BYTES)
    const source = bounded(resultView.path, 4_096)
    surfaces.push({
      ...base, id: `${sessionId}:${callId}:read`, type: fileKind(source), title, source,
      trust: pathTrust(source, cwd),
      capabilities: passiveCapabilities(true),
      view: {
        kind: 'text', lines: boundedLines.lines,
        totalLines: Math.max(boundedLines.lines.length, Math.floor(number(resultView.totalLines) ?? boundedLines.lines.length)),
        ...(typeof resultView.lang === 'string' ? { language: bounded(resultView.lang, 40) } : {}),
        truncated: lineTextTruncated || boundedLines.truncated || lines.length > boundedLines.lines.length || rawLines.length > lines.length,
      },
    })
  }

  if (resultView?.card === 'diff') {
    const allDiffs = projectDiffs(resultView.diffs)
    const boundedDiffs = boundDiffs(allDiffs)
    const source = boundedDiffs.diffs[0]?.path
    if (boundedDiffs.diffs.length > 0) surfaces.push({
      ...base, id: `${sessionId}:${callId}:diff`, type: 'file', title,
      ...(source === undefined ? {} : { source }), trust: source === undefined ? 'unknown' : pathTrust(source, cwd),
      capabilities: passiveCapabilities(source !== undefined),
      view: { kind: 'diff', diffs: boundedDiffs.diffs, truncated: boundedDiffs.truncated },
    })
  }

  if (resultView?.card === 'terminal' || callView?.card === 'terminal') {
    const rawOutput = string(resultView?.output)
    // Generic error presenters fall back to content blocks; preserve their
    // earlier byte/block truncation instead of reclassifying clipped text.
    const output = rawOutput === undefined ? contentText(row.content) : boundText(rawOutput, MAX_TERMINAL_BYTES)
    const source = string(callView?.cwd) ?? cwd
    surfaces.push({
      ...base, id: `${sessionId}:${callId}:terminal`, type: 'terminal', title,
      ...(source === undefined ? {} : { source: bounded(source, 4_096) }),
      trust: source === undefined ? 'unknown' : pathTrust(source, cwd),
      capabilities: passiveCapabilities(source !== undefined),
      view: {
        kind: 'terminal', output: output.text, truncated: output.truncated,
        ...(number(resultView?.exitCode) === undefined ? {} : { exitCode: Math.floor(number(resultView?.exitCode) as number) }),
        ...(string(resultView?.signal) === undefined ? {} : { signal: bounded(string(resultView?.signal) as string, 80) }),
        ...(source === undefined ? {} : { cwd: bounded(source, 4_096) }),
      },
    })
    // URL discovery runs only over the already bounded terminal projection;
    // a hostile or accidental multi-megabyte result cannot force a second scan.
    for (const rawUrl of loopbackUrls(output.text)) surfaces.push(webSurface(base, `${callId}:url:${stableToken(rawUrl)}`, '本地工具', rawUrl))
  }

  surfaces.push(...mediaSurfaces(sessionId, base, row, name))
  if (surfaces.length === 0) surfaces.push(...locationSurfaces(sessionId, base, callView, cwd, title))
  return surfaces
}

function surfacesForRunningCall(sessionId: string, cwd: string | undefined, row: Record<string, unknown>): WorkSurface[] {
  const callId = string(row.callId)
  if (callId === undefined) return []
  const callView = record(row.callView)
  const updatedAt = number(row.time) ?? 0
  const base = { sessionId, callId, seq: Number.MAX_SAFE_INTEGER, updatedAt, status: 'running' as const }
  if (callView?.card === 'terminal') {
    const source = string(callView.cwd) ?? cwd
    return [{
      ...base, id: `${sessionId}:${callId}:terminal`, type: 'terminal', title: surfaceTitle(undefined, callView, string(row.name) ?? callId),
      ...(source === undefined ? {} : { source: bounded(source, 4_096) }), trust: source === undefined ? 'unknown' : pathTrust(source, cwd),
      capabilities: passiveCapabilities(source !== undefined),
      view: { kind: 'terminal', output: '命令正在执行…', truncated: false, ...(source === undefined ? {} : { cwd: bounded(source, 4_096) }) },
    }]
  }
  return locationSurfaces(sessionId, base, callView, cwd, surfaceTitle(undefined, callView, string(row.name) ?? callId))
}

function webSurface(
  base: Pick<WorkSurface, 'sessionId' | 'callId' | 'seq' | 'updatedAt' | 'status'>,
  suffix: string,
  title: string,
  rawUrl: string,
): WorkSurface {
  const safe = safeSurfaceUrl(rawUrl)
  const navigable = safe.url !== undefined
  return {
    ...base, id: `${base.sessionId}:${suffix}`, type: 'web', title, source: safe.displayUrl,
    status: safe.embed === 'blocked' ? 'blocked' : base.status,
    trust: safe.trust,
    capabilities: {
      embedded: safe.embed === 'loopback', interactive: safe.embed === 'loopback', refresh: safe.embed === 'loopback',
      externalOpen: navigable, copySource: navigable, pinnable: true,
    },
    view: { kind: 'web', ...(safe.url === undefined ? {} : { url: safe.url }), embed: safe.embed, ...(safe.reason === undefined ? {} : { reason: safe.reason }) },
  }
}

function mediaSurfaces(
  sessionId: string,
  base: Pick<WorkSurface, 'sessionId' | 'callId' | 'seq' | 'updatedAt' | 'status'>,
  row: Record<string, unknown>,
  toolName: string,
): WorkSurface[] {
  const desktop = /(?:screen|screenshot|desktop|window|observe)/iu.test(toolName)
  return contentBlocks(row.content).flatMap((block, index): WorkSurface[] => {
    if (block.type !== 'image') return []
    const rawUrl = string(block.url)
    const rawData = string(block.data)
    const mediaType = string(block.mediaType) ?? string(record(block.attachment)?.mediaType)
    const dataUrl = rawData !== undefined && rawData.length <= 14_000_000 && /^image\/(?:png|jpeg|webp|gif)$/u.test(mediaType ?? '')
      ? `data:${mediaType};base64,${rawData}`
      : undefined
    const safe = rawUrl === undefined ? undefined : safeSurfaceUrl(rawUrl)
    const url = dataUrl ?? safe?.url
    const type = desktop ? 'desktop' as const : 'image' as const
    return [{
      ...base, id: `${sessionId}:${base.callId}:media:${index}`, type,
      title: desktop ? '桌面现场' : '图片产物',
      ...(safe === undefined ? {} : { source: safe.displayUrl }),
      trust: safe?.trust ?? (dataUrl === undefined ? 'unknown' : 'local'),
      capabilities: {
        embedded: url !== undefined, interactive: false, refresh: false,
        externalOpen: safe?.url !== undefined, copySource: safe?.url !== undefined, pinnable: true,
      },
      view: {
        kind: 'media', mediaType: desktop ? 'desktop' : 'image', ...(url === undefined ? {} : { url }),
        ...(url === undefined ? { description: `图片结果已登记（${mediaType ?? '未知格式'}），当前会话未提供可读取的公开附件 URL。` } : {}),
      },
    }]
  })
}

function locationSurfaces(
  sessionId: string,
  base: Pick<WorkSurface, 'sessionId' | 'callId' | 'seq' | 'updatedAt' | 'status'>,
  callView: Record<string, unknown> | undefined,
  cwd: string | undefined,
  title: string,
): WorkSurface[] {
  const locations = Array.isArray(callView?.locations) ? callView.locations : []
  return locations.slice(0, 4).flatMap((value, index): WorkSurface[] => {
    const source = string(record(value)?.path)
    if (!validFileSource(source)) return []
    const kind = fileKind(source)
    const view: WorkSurface['view'] = kind === 'image' || kind === 'video' || kind === 'pdf'
      ? { kind: 'media', mediaType: kind, description: '工具已登记该文件；浏览器端没有绕过工作区权限直接读取本地路径。' }
      : { kind: 'metadata', description: '工具已登记该文件位置；打开内容仍沿用受控工具读取。' }
    return [{
      ...base, id: `${sessionId}:${base.callId}:location:${index}`, type: kind, title, source: bounded(source, 4_096),
      trust: pathTrust(source, cwd), capabilities: passiveCapabilities(true),
      view,
    }]
  })
}

function passiveCapabilities(copySource: boolean): WorkSurfaceCapabilities {
  return { embedded: true, interactive: false, refresh: false, externalOpen: false, copySource, pinnable: true }
}

function flattenToolBlocks(values: readonly unknown[], maxDepth: number): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = []
  const stack = values.map(value => ({ value, depth: 0 })).reverse()
  const seen = new Set<object>()
  while (stack.length > 0) {
    const current = stack.pop() as { value: unknown; depth: number }
    const row = record(current.value)
    if (row === undefined || seen.has(row)) continue
    seen.add(row)
    if (row.kind === 'tool-result' || typeof row.callId === 'string') output.push(row)
    if (current.depth >= maxDepth || !Array.isArray(row.subCalls)) continue
    for (let index = row.subCalls.length - 1; index >= 0; index--) stack.push({ value: row.subCalls[index], depth: current.depth + 1 })
  }
  return output
}

function firstWebSourceUrl(view: Record<string, unknown>): string | undefined {
  if (view.kind !== 'search' || !Array.isArray(view.sources)) return undefined
  return view.sources.flatMap(value => string(record(value)?.url) ?? []).at(0)
}

function surfaceTitle(resultView: Record<string, unknown> | undefined, callView: Record<string, unknown> | undefined, fallback: string): string {
  return bounded(string(resultView?.title) ?? string(callView?.title) ?? fallback, 160)
}

function projectDiffs(value: unknown): WorkSurfaceDiff[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(row => {
    const diff = record(row)
    if (!validFileSource(diff?.path) || typeof diff?.newText !== 'string' || !(typeof diff.oldText === 'string' || diff.oldText === null)) return []
    return [{ path: bounded(diff.path, 4_096), oldText: diff.oldText, newText: diff.newText }]
  })
}

function boundDiffs(value: readonly WorkSurfaceDiff[]): { readonly diffs: readonly WorkSurfaceDiff[]; readonly truncated: boolean } {
  const output: WorkSurfaceDiff[] = []
  let bytes = 0
  let textTruncated = false
  for (const diff of value.slice(0, MAX_DIFFS)) {
    const old = boundText(diff.oldText ?? '', Math.max(0, MAX_DIFF_BYTES - bytes))
    bytes += byteLength(old.text)
    const next = boundText(diff.newText, Math.max(0, MAX_DIFF_BYTES - bytes))
    bytes += byteLength(next.text)
    textTruncated ||= old.truncated || next.truncated
    output.push({ path: diff.path, oldText: diff.oldText === null ? null : old.text, newText: next.text })
    if (bytes >= MAX_DIFF_BYTES) break
  }
  // Reaching the budget exactly need not omit anything; conversely UTF-8
  // boundaries can leave a few unused bytes after text was already clipped.
  return { diffs: output, truncated: textTruncated || output.length < value.length }
}

function boundLines(value: readonly { readonly number: number; readonly text: string }[], maxLines: number, maxBytes: number): {
  readonly lines: readonly { readonly number: number; readonly text: string }[]
  readonly truncated: boolean
} {
  const lines: { number: number; text: string }[] = []
  let bytes = 0
  let textTruncated = false
  for (const line of value.slice(0, maxLines)) {
    const remaining = maxBytes - bytes
    if (remaining <= 0) break
    const text = boundText(line.text, remaining)
    // A byte cap can shorten the last retained line without dropping a row.
    textTruncated ||= text.truncated
    lines.push({ number: line.number, text: text.text })
    bytes += byteLength(text.text)
    if (bytes >= maxBytes) break
  }
  return { lines, truncated: textTruncated || lines.length < value.length }
}

function contentBlocks(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_CONTENT_BLOCKS).flatMap(block => {
    const row = record(block)
    return row === undefined ? [] : [row]
  })
}

function contentText(value: unknown): { readonly text: string; readonly truncated: boolean } {
  let output = ''
  let truncated = Array.isArray(value) && value.length > MAX_CONTENT_BLOCKS
  for (const block of contentBlocks(value)) {
    if (typeof block.text !== 'string') continue
    const separator = output === '' ? '' : '\n'
    const remaining = MAX_TERMINAL_BYTES - byteLength(output) - byteLength(separator)
    if (remaining <= 0) { truncated = true; break }
    const part = boundText(block.text, remaining)
    output += `${separator}${part.text}`
    if (part.truncated) { truncated = true; break }
  }
  return { text: output, truncated }
}

function loopbackUrls(value: string): readonly string[] {
  const unique = new Set<string>()
  for (const match of value.matchAll(LOOPBACK_URL)) {
    const raw = match[0].replace(/[),.;!?]+$/u, '')
    const safe = safeSurfaceUrl(raw)
    if (safe.embed === 'loopback' && safe.url !== undefined) unique.add(safe.url)
    if (unique.size >= 4) break
  }
  return [...unique]
}

function fileKind(path: string): 'file' | 'image' | 'video' | 'pdf' {
  const clean = path.toLocaleLowerCase('en-US').split(/[?#]/u, 1)[0] ?? ''
  if (/\.(?:png|jpe?g|webp|gif|avif|heic)$/u.test(clean)) return 'image'
  if (/\.(?:mp4|mov|m4v|webm|mkv)$/u.test(clean)) return 'video'
  if (/\.pdf$/u.test(clean)) return 'pdf'
  return 'file'
}

function pathTrust(path: string, cwd: string | undefined): WorkSurfaceTrust {
  if (!validFileSource(path)) return 'unknown'
  if (!isAbsolutePath(path) && cwd === undefined) return 'unknown'
  if (cwd === undefined) return 'local'
  const source = normalizedPath(isAbsolutePath(path) ? path : `${cwd}/${path}`)
  const root = normalizedPath(cwd).replace(/\/$/u, '')
  const windows = /^[a-z]:\//iu.test(root)
  const left = windows ? source.toLocaleLowerCase('en-US') : source
  const right = windows ? root.toLocaleLowerCase('en-US') : root
  return left === right || left.startsWith(`${right}/`) ? 'workspace' : 'local'
}

function isAbsolutePath(value: string): boolean { return value.startsWith('/') || /^[a-z]:[\\/]/iu.test(value) }
/** A file presenter cannot turn a credential-bearing URL into a copyable path. */
function validFileSource(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/[\u0000-\u001f]/u.test(value)
    && (!/^[a-z][a-z0-9+.-]*:/iu.test(value) || /^[a-z]:[\\/]/iu.test(value))
}
function normalizedPath(value: string): string {
  const parts: string[] = []
  for (const part of value.replace(/\\/gu, '/').split('/')) {
    if (part === '.') continue
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop()
    else if (part !== '' || parts.length === 0) parts.push(part)
  }
  return parts.join('/')
}
function stableToken(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16)
}
function bounded(value: string, length: number): string { return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…` }
function boundText(value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: value !== '' }
  // Avoid encoding an unbounded tool result before applying the byte limit.
  // At most `maxBytes` UTF-16 code units are needed to fill `maxBytes` UTF-8 bytes.
  if (value.length <= maxBytes && byteLength(value) <= maxBytes) return { text: value, truncated: false }
  const encoder = new TextEncoder()
  const candidate = value.slice(0, maxBytes)
  if (maxBytes < 3) return { text: '.'.repeat(maxBytes), truncated: true }
  // encodeInto never splits a multi-byte character; decoding a sliced byte
  // sequence could insert U+FFFD and exceed the advertised UTF-8 budget.
  const buffer = new Uint8Array(maxBytes - 3)
  const { written } = encoder.encodeInto(candidate, buffer)
  return { text: `${new TextDecoder().decode(buffer.subarray(0, written))}…`, truncated: true }
}
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function string(value: unknown): string | undefined { return typeof value === 'string' && value !== '' ? value : undefined }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
