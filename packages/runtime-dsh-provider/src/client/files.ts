import { RUNTIME_FILE_LIMITS } from '@xiaoshe/runtime-contract'
import type { RuntimeCommandResult, RuntimeCommandErrorKind, RuntimeFiles, RuntimeFileReceipt, RuntimeFileUploadInput, RuntimeFileReadInput, RuntimeFileContent, WorkSurfaceRegistry } from '@xiaoshe/runtime-contract'

type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } }
export interface FileUploadPort {
  upload(sessionId: string, data: Blob, name?: string, signal?: AbortSignal, onProgress?: RuntimeFileUploadInput['onProgress']): Promise<RemoteResult<{ readonly receiptId: string; readonly file: { readonly attachmentId: string; readonly name: string; readonly bytes: number } }>>
}
interface FileStat { readonly absolutePath: string; readonly version: string; readonly bytes?: number }
export interface WorkspaceFilesPort {
  stat(sessionId: string, path: string, signal: AbortSignal): Promise<RemoteResult<FileStat>>
  readBytes(sessionId: string, path: string, range: { readonly offset: number; readonly length: number }, signal: AbortSignal): Promise<RemoteResult<FileStat & { readonly offset: number; readonly data: string; readonly eof: boolean }>>
}
interface SessionsPort {
  readonly list: { getSnapshot(): { readonly current?: string }; subscribe(listener: () => void): () => void }
  binding(id: string): unknown
}
const failure = (kind: RuntimeCommandErrorKind, message: string, code?: string): RuntimeCommandResult<never> => ({ ok: false, error: { kind, message, ...(code === undefined ? {} : { code }) } })
function publicResult<T>(result: RemoteResult<T>): RuntimeCommandResult<T> {
  if (result.ok) return result
  const { code, message, details } = result.error
  return { ok: false, error: { kind: 'provider', code, message, ...(typeof details === 'object' && details !== null && !Array.isArray(details) ? { details: details as Readonly<Record<string, unknown>> } : {}) } }
}

/** Session-fenced adapter over public upload and filesystem RPCs. Never grants filesystem access. */
export class DshRuntimeFiles implements RuntimeFiles {
  readonly limits = RUNTIME_FILE_LIMITS
  private readonly staged = new Map<string, { readonly sessionId: string; readonly receipt: RuntimeFileReceipt }>()
  private readonly active = new Set<AbortController>()
  private readonly release: () => void
  private disposed = false
  private current: string | undefined

  constructor(private readonly sessions: SessionsPort, private readonly uploader: FileUploadPort | undefined, private readonly workspaceFiles: WorkspaceFilesPort | undefined, private readonly surfaces: Pick<WorkSurfaceRegistry, 'getSnapshot'>) {
    this.current = sessions.list.getSnapshot().current
    this.release = sessions.list.subscribe(() => {
      const next = sessions.list.getSnapshot().current
      if (next !== this.current) { this.current = next; for (const operation of this.active) operation.abort() }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.release()
    for (const operation of this.active) operation.abort()
    this.staged.clear()
  }

  upload(input: RuntimeFileUploadInput): Promise<RuntimeCommandResult<RuntimeFileReceipt>> {
    if (!(input.file instanceof Blob) || input.file.size > this.limits.maxFileBytes || typeof input.name !== 'string' || !input.name.trim() || input.name.includes('\0')) return Promise.resolve(failure('invalid_request', '文件无效或超过 32 MiB 限制。'))
    const uploader = this.uploader
    if (typeof uploader?.upload !== 'function') return Promise.resolve(failure('unsupported', '当前后端未提供文件上传服务。'))
    return this.operation<RuntimeFileReceipt>(input, async signal => {
      const result = publicResult(await uploader.upload(input.sessionId, input.file, input.name, signal, progress => {
        if (!signal.aborted && Number.isFinite(progress.loaded) && progress.loaded >= 0 && progress.loaded <= input.file.size) input.onProgress?.(progress)
      }))
      if (signal.aborted) return canceled()
      if (!result.ok) return result
      const { receiptId, file } = result.value
      if (typeof receiptId !== 'string' || !receiptId || typeof file?.attachmentId !== 'string' || !file.attachmentId || typeof file.name !== 'string' || !file.name || file.bytes !== input.file.size || this.staged.has(receiptId)) return failure('provider', '上传回执无效。')
      const receipt: RuntimeFileReceipt = Object.freeze({ receiptId, name: file.name, bytes: file.bytes, ...(input.file.type ? { mediaType: input.file.type } : {}) })
      this.staged.set(receiptId, { sessionId: input.sessionId, receipt })
      return { ok: true, value: receipt }
    })
  }

  /** Validate against completed local receipts; Host still owns final admission authority. */
  validateReceipts(sessionId: string, receipts: readonly RuntimeFileReceipt[]): RuntimeCommandResult<readonly { readonly type: 'file'; readonly receiptId: string }[]> {
    if (this.disposed) return canceled()
    if (!Array.isArray(receipts) || receipts.length > this.limits.maxFilesPerMessage) return failure('invalid_request', '每条消息最多 10 个文件。')
    const ids = new Set<string>(); let bytes = 0
    for (const receipt of receipts) {
      const stored = receipt && this.staged.get(receipt.receiptId)
      if (!stored || stored.sessionId !== sessionId || stored.receipt.bytes !== receipt.bytes || stored.receipt.name !== receipt.name || stored.receipt.mediaType !== receipt.mediaType || ids.has(receipt.receiptId)) return failure('invalid_request', '文件未在本会话完成上传，或回执已失效。', 'session/attachment-invalid')
      ids.add(receipt.receiptId); bytes += stored.receipt.bytes
    }
    if (bytes > this.limits.maxMessageFileBytes) return failure('invalid_request', '消息文件总量超过 128 MiB。')
    return { ok: true, value: [...ids].map(receiptId => ({ type: 'file', receiptId })) }
  }

  consumeReceipts(receipts: readonly RuntimeFileReceipt[]): void { for (const receipt of receipts) this.staged.delete(receipt.receiptId) }

  read(input: RuntimeFileReadInput): Promise<RuntimeCommandResult<RuntimeFileContent>> {
    const remote = this.workspaceFiles
    if (typeof remote?.stat !== 'function' || typeof remote.readBytes !== 'function') return Promise.resolve(failure('unsupported', '当前后端未提供文件字节读取服务。'))
    if (!this.isMaterial(input)) return Promise.resolve(failure('invalid_request', '只能预览当前会话材料中列出的文件。'))
    return this.operation<RuntimeFileContent>(input, async signal => {
      const stat = publicResult(await remote.stat(input.sessionId, input.path, signal))
      if (signal.aborted) return canceled()
      if (!stat.ok) return stat
      const identity = stat.value
      if (!identity.absolutePath || typeof identity.version !== 'string' || (identity.bytes !== undefined && (!Number.isSafeInteger(identity.bytes) || identity.bytes < 0))) return failure('provider', '文件元数据无效。')
      if (identity.bytes !== undefined && identity.bytes > this.limits.maxFileBytes) return failure('invalid_request', '文件超过 32 MiB 预览限制。')
      const chunks: Uint8Array[] = []; let offset = 0
      while (true) {
        if (signal.aborted) return canceled()
        if (!this.isMaterial(input)) return failure('conflict', '文件材料已离开当前会话。')
        // Request bounded windows, including one byte for unknown-size overflow detection.
        const length = Math.min(2 * 1024 * 1024, Math.max(1, (identity.bytes ?? this.limits.maxFileBytes + 1) - offset))
        const result = publicResult(await remote.readBytes(input.sessionId, input.path, { offset, length }, signal))
        if (signal.aborted) return canceled()
        if (!result.ok) return result
        const page = result.value
        if (page.absolutePath !== identity.absolutePath || page.version !== identity.version || page.offset !== offset || (identity.bytes !== undefined && page.bytes !== identity.bytes)) return failure('conflict', '读取期间文件已改变，请刷新后重试。')
        const bytes = decodePage(page.data, length)
        if (bytes === undefined || offset + bytes.length > this.limits.maxFileBytes || (identity.bytes !== undefined && offset + bytes.length > identity.bytes)) return failure('provider', '文件字节无效或超过预览限制。')
        chunks.push(bytes); offset += bytes.length
        if (page.eof) break
        if (bytes.length === 0 || (identity.bytes !== undefined && offset >= identity.bytes)) return failure('provider', '文件返回了不完整的字节窗口。')
      }
      if (identity.bytes !== undefined && offset !== identity.bytes) return failure('conflict', '文件字节不完整，请刷新后重试。')
      if (!this.isMaterial(input)) return failure('conflict', '文件材料已离开当前会话。')
      const data = new Uint8Array(offset); let position = 0
      for (const chunk of chunks) { data.set(chunk, position); position += chunk.length }
      const name = input.path.split(/[\\/]/u).at(-1) || 'file'
      return { ok: true, value: { sessionId: input.sessionId, path: input.path, name, mediaType: mediaType(name), data, bytes: offset, version: identity.version } }
    })
  }

  private isMaterial(input: RuntimeFileReadInput): boolean {
    if (typeof input.path !== 'string' || !input.path || input.path.includes('\0') || input.path.startsWith('//') || (/^[a-z][a-z\d+.-]*:/iu.test(input.path) && !/^[a-z]:[\\/]/iu.test(input.path))) return false
    const snapshot = this.surfaces.getSnapshot()
    return snapshot.sessionId === input.sessionId && snapshot.items.some(item => item.sessionId === input.sessionId && ['file', 'pdf', 'image', 'video'].includes(item.type) && item.source === input.path)
  }

  /** Abort only operation-owned signals; selected path permissions belong to the Host. */
  private async operation<T>(input: { readonly sessionId: string; readonly signal?: AbortSignal }, execute: (signal: AbortSignal) => Promise<RuntimeCommandResult<T>>): Promise<RuntimeCommandResult<T>> {
    if (this.disposed || input.signal?.aborted) return canceled()
    if (!input.sessionId || input.sessionId !== this.current || !this.sessions.binding(input.sessionId)) return failure('conflict', '会话已切换或不可用。')
    const controller = new AbortController(); this.active.add(controller)
    const abort = () => controller.abort(); input.signal?.addEventListener('abort', abort, { once: true })
    let abortResult: (() => void) | undefined
    const canceledResult = new Promise<RuntimeCommandResult<T>>(resolve => { abortResult = () => resolve(canceled()); controller.signal.addEventListener('abort', abortResult, { once: true }) })
    try {
      const result = await Promise.race([execute(controller.signal), canceledResult])
      return controller.signal.aborted ? canceled() : result
    } catch (error: unknown) {
      return controller.signal.aborted ? canceled() : failure('transport', error instanceof Error ? error.message : String(error))
    } finally {
      input.signal?.removeEventListener('abort', abort)
      if (abortResult) controller.signal.removeEventListener('abort', abortResult)
      this.active.delete(controller)
    }
  }
}

function canceled(): RuntimeCommandResult<never> { return failure('conflict', '操作已取消或会话已切换。', 'runtime-files/canceled') }
/** Validate encoded size before decoding so malformed backends cannot force an unbounded allocation. */
function decodePage(data: string, limit: number): Uint8Array | undefined {
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(limit / 3) || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) return undefined
  try { const raw = atob(data); if (raw.length > limit) return undefined; return Uint8Array.from(raw, value => value.charCodeAt(0)) } catch { return undefined }
}
function mediaType(name: string): string {
  const types: Readonly<Record<string, string>> = { pdf: 'application/pdf', html: 'text/html', htm: 'text/html', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4' }
  return types[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}
