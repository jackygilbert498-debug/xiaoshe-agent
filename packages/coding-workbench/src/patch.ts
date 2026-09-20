import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { atomicFileReplace, type AtomicFileIo } from './atomic-file.js'
import { pendingTransaction, type WorkbenchTransaction, type WorkbenchTransactionStore } from './transactions.js'
import type { WorkspacePathPolicy } from './path-policy.js'

export interface WriteChallenge { readonly id: string; readonly token: string; readonly expiresAt: string; readonly workspaceId: string; readonly relativePath: string; readonly beforeSha256: string; readonly afterSha256: string; readonly bytes: number }
export interface ControlledFileWriterOptions {
  readonly store: WorkbenchTransactionStore
  readonly paths: WorkspacePathPolicy
  readonly now?: () => number
  readonly tokenFactory?: () => string
  readonly ttlMs?: number
  readonly maxBytes?: number
  readonly io?: AtomicFileIo
}
export class WorkbenchRecoveryError extends Error {
  readonly code = 'WORKBENCH_RECOVERY_REQUIRED'
  constructor(readonly transactionId: string) {
    super('文件操作可能已生效，账本仍待恢复对账；请勿重复提交新写入。检查存储后使用“恢复对账”；内容或工作区发生变化时会停止，不覆盖现有文件。')
  }
}

/** Persist intent before changing a file. Interrupted operations are explicitly
 * resumed, never silently executed on startup. This is a single-service protocol,
 * not an atomic transaction spanning the file and ledger or a power-loss promise. */
export class ControlledFileWriter {
  readonly #store: WorkbenchTransactionStore; readonly #now: () => number; readonly #token: () => string; readonly #ttl: number; readonly #max: number
  constructor(private readonly options: ControlledFileWriterOptions) {
    this.#store = options.store; this.#now = options.now ?? Date.now; this.#token = options.tokenFactory ?? (() => randomBytes(32).toString('base64url')); this.#ttl = options.ttlMs ?? 10 * 60_000; this.#max = options.maxBytes ?? 1024 * 1024
  }
  async prepare(input: { readonly workspaceId: string; readonly relativePath: string; readonly absolutePath: string; readonly newText: string }): Promise<WriteChallenge> {
    const target = await this.options.paths.existing(input.workspaceId, input.relativePath, 'file')
    if (target.absolutePath !== input.absolutePath) throw new Error('workspace write target changed')
    return this.#store.withPath(target.absolutePath, async () => {
      this.#assertNoPending(target.absolutePath)
      await this.#target(input)
      const before = await regularBytes(target.absolutePath, this.#max); const after = Buffer.from(input.newText, 'utf8')
      if (after.byteLength > this.#max) throw new RangeError('replacement exceeds workbench file limit')
      const id = `workbench-tx-${randomUUID()}`; const token = this.#token(); if (token.length < 20) throw new Error('unsafe confirmation token')
      const now = this.#now(); const beforeSha256 = digest(before); const afterSha256 = digest(after)
      await this.#store.save({ id, workspaceId: input.workspaceId, relativePath: input.relativePath, absolutePath: target.absolutePath,
        beforeSha256, afterSha256, beforeBase64: before.toString('base64'), afterBase64: after.toString('base64'), state: 'prepared', createdAt: now, updatedAt: now,
        challenge: { tokenSha256: digest(token), expiresAt: now + this.#ttl } })
      return Object.freeze({ id, token, expiresAt: new Date(now + this.#ttl).toISOString(), workspaceId: input.workspaceId, relativePath: input.relativePath, beforeSha256, afterSha256, bytes: after.byteLength })
    })
  }
  async confirm(id: string, token: string): Promise<WorkbenchTransaction> {
    return this.#locked(id, async row => {
      if (!equalDigest(digest(token), row.challenge.tokenSha256)) throw new Error('workbench confirmation token does not match')
      if (row.state === 'applied') return row // Retry returns the original receipt, without reapplying it.
      if (row.state === 'applying') return this.#finish(row)
      if (row.state !== 'prepared') throw new Error('workbench confirmation is no longer available')
      this.#assertNoPending(row.absolutePath, row.id)
      if (this.#now() > row.challenge.expiresAt) { await this.#fail(row, 'confirmation expired'); throw new Error('workbench confirmation expired') }
      await this.#target(row)
      if (!equalDigest(digest(await regularBytes(row.absolutePath, this.#max)), row.beforeSha256)) {
        await this.#fail(row, 'file changed after prepare'); throw new Error('file changed after prepare')
      }
      // No file mutation is possible unless intent and consumed authorization
      // have reached the ledger. Resuming that intent needs no new authorization.
      const intent = await this.#store.update(row.id, value => ({ ...value, state: 'applying', updatedAt: this.#now(), challenge: { ...value.challenge, confirmedAt: this.#now() } }))
      return this.#finish(intent)
    })
  }
  async revert(id: string): Promise<WorkbenchTransaction> {
    return this.#locked(id, async row => {
      if (row.state === 'reverted') return row
      if (row.state === 'reverting') return this.#finish(row)
      if (row.state !== 'applied') throw new Error('only an applied transaction can be reverted')
      this.#assertNoPending(row.absolutePath, row.id)
      await this.#target(row)
      if (!equalDigest(digest(await regularBytes(row.absolutePath, this.#max)), row.afterSha256)) throw new Error('file changed after apply; automatic revert is blocked')
      const intent = await this.#store.update(row.id, value => ({ ...value, state: 'reverting', updatedAt: this.#now(), challenge: { ...value.challenge, confirmedAt: value.challenge.confirmedAt ?? this.#now() } }))
      return this.#finish(intent)
    })
  }
  async recover(id: string): Promise<WorkbenchTransaction> {
    return this.#locked(id, row => {
      if (pendingTransaction(row)) return this.#finish(row)
      if (row.state === 'applied' || row.state === 'reverted') return Promise.resolve(row)
      throw new Error('transaction has no confirmed operation to recover')
    })
  }
  list(): readonly WorkbenchTransaction[] {
    return this.#store.list().map(({ beforeBase64: _before, afterBase64: _after, challenge, ...row }) => ({ ...row, beforeBase64: '', afterBase64: '', challenge: { ...challenge, tokenSha256: '[redacted]' } }))
  }
  async #locked<T>(id: string, action: (row: WorkbenchTransaction) => Promise<T>): Promise<T> {
    const initial = required(this.#store.get(id))
    return this.#store.withPath(initial.absolutePath, () => action(required(this.#store.get(id))))
  }
  #assertNoPending(path: string, except?: string): void {
    const pending = this.#store.list().find(row => row.absolutePath === path && row.id !== except && pendingTransaction(row))
    if (pending !== undefined) throw new WorkbenchRecoveryError(pending.id)
  }
  async #target(row: Pick<WorkbenchTransaction, 'workspaceId' | 'relativePath' | 'absolutePath'>): Promise<void> {
    const target = await this.options.paths.existing(row.workspaceId, row.relativePath, 'file')
    if (target.absolutePath !== row.absolutePath) throw new Error('workspace write target changed; recovery is blocked')
  }
  async #finish(row: WorkbenchTransaction): Promise<WorkbenchTransaction> {
    try {
      this.#assertNoPending(row.absolutePath, row.id)
      await this.#target(row)
      const applying = row.state === 'applying'
      const source = applying ? row.beforeSha256 : row.afterSha256
      const destination = applying ? row.afterSha256 : row.beforeSha256
      const bytes = Buffer.from(applying ? row.afterBase64 : row.beforeBase64, 'base64')
      if (bytes.byteLength > this.#max || !equalDigest(digest(bytes), destination)) throw new Error('workbench recovery payload is invalid')
      const current = digest(await regularBytes(row.absolutePath, this.#max))
      if (!equalDigest(current, destination)) {
        if (!equalDigest(current, source)) throw new Error('file changed while operation was pending')
        const info = await lstat(row.absolutePath)
        await atomicFileReplace(row.absolutePath, bytes, {
          ...(this.options.io === undefined ? {} : { io: this.options.io }), mode: info.mode & 0o777,
          beforeRename: async () => {
            // Catch edits or path changes during staging. This does not lock out
            // arbitrary external writers in the final gap between syscalls.
            await this.#target(row)
            if (!equalDigest(digest(await regularBytes(row.absolutePath, this.#max)), source)) throw new Error('file changed before commit')
          },
        })
      }
      await this.#target(row)
      if (!equalDigest(digest(await regularBytes(row.absolutePath, this.#max)), destination)) throw new Error('file verification failed')
      return await this.#store.update(row.id, value => ({ ...value, state: applying ? 'applied' : 'reverted', updatedAt: this.#now() }))
    } catch { throw new WorkbenchRecoveryError(row.id) }
  }
  async #fail(row: WorkbenchTransaction, error: string): Promise<void> { await this.#store.update(row.id, value => ({ ...value, state: 'failed', error, updatedAt: this.#now() })) }
}
async function regularBytes(path: string, max: number): Promise<Buffer> { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError('write target must be a regular file'); if (stat.size > max) throw new RangeError('workbench file exceeds limit'); return readFile(path) }
function digest(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }
function equalDigest(left: string, right: string): boolean { const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex'); return a.length === b.length && timingSafeEqual(a, b) }
function required(value: WorkbenchTransaction | undefined): WorkbenchTransaction { if (value === undefined) throw new Error('unknown workbench transaction'); return value }
