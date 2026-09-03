import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { MigrationExporter } from './exporter.js'
import type { MigrationImporter, MigrationPreview } from './importer.js'
import type { WorkspacePathMapping } from './path-map.js'
import type { MigrationManifest } from './schema.js'

interface ExporterPort { exportTo(target: string, signal?: AbortSignal): Promise<MigrationManifest> }
interface ImporterPort {
  preview(bundlePath: string, mappings: readonly WorkspacePathMapping[], signal?: AbortSignal): Promise<MigrationPreview>
  apply(preview: MigrationPreview, signal?: AbortSignal): Promise<void>
}

export type MigrationOperationState = 'idle' | 'exporting' | 'inspecting' | 'prepared' | 'importing' | 'succeeded' | 'failed'
export interface MigrationRecoverySnapshot {
  readonly state: MigrationOperationState
  readonly updatedAt: number
  readonly message?: string
  readonly lastExport?: { readonly path: string; readonly exportedAt: number; readonly files: number }
  readonly lastImport?: { readonly path: string; readonly bundleHash: string; readonly importedAt: number; readonly sessions: number }
}

export interface MigrationImportChallenge {
  readonly id: string
  readonly token: string
  readonly expiresAt: string
  readonly bundlePath: string
  readonly bundleHash: string
  readonly sessions: number
  readonly disclosures: readonly string[]
}

interface PreparedImport {
  readonly challenge: MigrationImportChallenge
  readonly tokenSha256: string
  readonly expiresAt: number
  readonly preview: MigrationPreview
}

export interface MigrationRecoveryServiceOptions {
  readonly exporter: Pick<MigrationExporter, 'exportTo'> | ExporterPort
  readonly importer: Pick<MigrationImporter, 'preview' | 'apply'> | ImporterPort
  readonly now?: () => number
  readonly tokenFactory?: () => string
  readonly confirmationTtlMs?: number
}

/** A preview that requires path mapping or would overwrite non-identical state. */
export class MigrationConflictError extends Error {
  readonly name = 'MigrationConflictError'
  constructor(readonly preview: MigrationPreview) {
    super('migration preview contains conflicts')
  }
}

/**
 * Host-owned migration lifecycle. Reads may be previewed, while every write is
 * serialized and imports consume one fact-bound, expiring confirmation.
 */
export class MigrationRecoveryService {
  readonly #exporter: ExporterPort
  readonly #importer: ImporterPort
  readonly #now: () => number
  readonly #tokenFactory: () => string
  readonly #confirmationTtlMs: number
  readonly #prepared = new Map<string, PreparedImport>()
  readonly #controllers = new Set<AbortController>()
  #busy = false
  #disposed = false
  #snapshot: MigrationRecoverySnapshot

  constructor(options: MigrationRecoveryServiceOptions) {
    this.#exporter = options.exporter
    this.#importer = options.importer
    this.#now = options.now ?? Date.now
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'))
    this.#confirmationTtlMs = options.confirmationTtlMs ?? 10 * 60_000
    if (!Number.isSafeInteger(this.#confirmationTtlMs) || this.#confirmationTtlMs < 30_000 || this.#confirmationTtlMs > 60 * 60_000) {
      // Tests may intentionally use a short deterministic clock window.
      if (options.confirmationTtlMs === undefined || this.#confirmationTtlMs < 1) throw new RangeError('confirmationTtlMs is invalid')
    }
    this.#snapshot = Object.freeze({ state: 'idle', updatedAt: this.#now() })
  }

  snapshot(): MigrationRecoverySnapshot { return this.#snapshot }

  async inspect(input: { readonly bundlePath: string; readonly mappings: readonly WorkspacePathMapping[] }): Promise<MigrationPreview> {
    const release = this.#begin('inspecting', '正在校验迁移包')
    try {
      const preview = await this.#importer.preview(input.bundlePath, input.mappings, release.signal)
      this.#publish({ state: 'idle', message: preview.conflicts.length === 0 ? '迁移包校验通过' : `发现 ${preview.conflicts.length} 个冲突` })
      return preview
    } catch (error) {
      this.#publish({ state: 'failed', message: safeMessage(error) })
      throw error
    } finally { release.done() }
  }

  async exportTo(target: string): Promise<MigrationManifest> {
    const release = this.#begin('exporting', '正在导出会话、记忆、设置、插件清单与工作区引用')
    try {
      const manifest = await this.#exporter.exportTo(target, release.signal)
      this.#publish({
        state: 'succeeded', message: '迁移包已原子写入',
        lastExport: Object.freeze({ path: target, exportedAt: manifest.exportedAt, files: manifest.files.length }),
      })
      return manifest
    } catch (error) {
      this.#publish({ state: 'failed', message: safeMessage(error) })
      throw error
    } finally { release.done() }
  }

  async prepareImport(input: { readonly bundlePath: string; readonly mappings: readonly WorkspacePathMapping[] }): Promise<MigrationImportChallenge> {
    const release = this.#begin('inspecting', '正在重新校验并绑定待导入事实')
    try {
      const preview = await this.#importer.preview(input.bundlePath, input.mappings, release.signal)
      if (preview.conflicts.length > 0) throw new MigrationConflictError(preview)
      const now = this.#now()
      const expiresAt = now + this.#confirmationTtlMs
      const token = this.#tokenFactory()
      if (token.length < 20) throw new Error('confirmation token factory returned an unsafe token')
      const challenge: MigrationImportChallenge = Object.freeze({
        id: `migration-challenge-${randomUUID()}`,
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        bundlePath: preview.bundlePath,
        bundleHash: preview.bundleHash,
        sessions: preview.sessions.length,
        disclosures: Object.freeze([
          `将导入 ${preview.sessions.length} 条会话，并按预检结果恢复可迁移设置与工作区引用。`,
          '目标设备现有的不同会话、不同设置和未映射路径均已阻止，不会静默覆盖。',
          'API 密钥、令牌和其他机密不在迁移包中，需在目标设备重新配置。',
        ]),
      })
      this.#prepared.set(challenge.id, {
        challenge, tokenSha256: digest(token), expiresAt, preview,
      })
      this.#publish({ state: 'prepared', message: '预检通过，等待一次性确认' })
      return challenge
    } catch (error) {
      this.#publish({ state: 'failed', message: safeMessage(error) })
      throw error
    } finally { release.done() }
  }

  async confirmImport(input: { readonly challengeId: string; readonly token: string }): Promise<void> {
    this.#assertLive()
    const prepared = this.#prepared.get(input.challengeId)
    if (prepared === undefined) throw new Error('unknown challenge; it may have expired or been invalidated by process restart')
    if (this.#now() > prepared.expiresAt) {
      this.#prepared.delete(input.challengeId)
      this.#publish({ state: 'failed', message: '迁移确认已过期，请重新预检' })
      throw new Error('migration confirmation challenge expired')
    }
    if (!safeDigestEqual(prepared.tokenSha256, digest(input.token))) throw new Error('confirmation token does not match the prepared migration facts')
    const release = this.#begin('importing', '正在导入；若进程中断，可重新预检并按日志继续')
    // Consume before the first asynchronous write so double-clicks cannot race.
    this.#prepared.delete(input.challengeId)
    try {
      await this.#importer.apply(prepared.preview, release.signal)
      this.#publish({
        state: 'succeeded', message: '导入完成',
        lastImport: Object.freeze({
          path: prepared.preview.bundlePath,
          bundleHash: prepared.preview.bundleHash,
          importedAt: this.#now(),
          sessions: prepared.preview.sessions.length,
        }),
      })
    } catch (error) {
      this.#publish({ state: 'failed', message: `${safeMessage(error)}；重新预检后可按日志继续` })
      throw error
    } finally { release.done() }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#prepared.clear()
    for (const controller of this.#controllers) controller.abort(new Error('migration service disposed'))
    this.#controllers.clear()
  }

  #begin(state: Extract<MigrationOperationState, 'exporting' | 'inspecting' | 'importing'>, message: string): { readonly signal: AbortSignal; done(): void } {
    this.#assertLive()
    if (this.#busy) throw new Error('another migration operation is already running')
    this.#busy = true
    const controller = new AbortController()
    this.#controllers.add(controller)
    this.#publish({ state, message })
    let released = false
    return {
      signal: controller.signal,
      done: () => {
        if (released) return
        released = true
        this.#controllers.delete(controller)
        this.#busy = false
      },
    }
  }

  #publish(next: Pick<MigrationRecoverySnapshot, 'state'> & Partial<Omit<MigrationRecoverySnapshot, 'state' | 'updatedAt'>>): void {
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      ...next,
      updatedAt: this.#now(),
    })
  }

  #assertLive(): void { if (this.#disposed) throw new Error('migration service is disposed') }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function safeDigestEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) }
