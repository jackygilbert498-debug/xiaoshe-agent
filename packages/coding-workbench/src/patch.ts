import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkbenchTransaction, WorkbenchTransactionStore } from './transactions.js'

export interface WriteChallenge { readonly id: string; readonly token: string; readonly expiresAt: string; readonly workspaceId: string; readonly relativePath: string; readonly beforeSha256: string; readonly afterSha256: string; readonly bytes: number }
export interface ControlledFileWriterOptions { readonly store: WorkbenchTransactionStore; readonly now?: () => number; readonly tokenFactory?: () => string; readonly ttlMs?: number; readonly maxBytes?: number }

/** Exact-preimage, confirmation-gated atomic file replacement with one-shot revert. */
export class ControlledFileWriter {
  readonly #store: WorkbenchTransactionStore; readonly #now: () => number; readonly #token: () => string; readonly #ttl: number; readonly #max: number
  constructor(options: ControlledFileWriterOptions) {
    this.#store = options.store; this.#now = options.now ?? Date.now; this.#token = options.tokenFactory ?? (() => randomBytes(32).toString('base64url')); this.#ttl = options.ttlMs ?? 10 * 60_000; this.#max = options.maxBytes ?? 1024 * 1024
  }
  async prepare(input: { readonly workspaceId: string; readonly relativePath: string; readonly absolutePath: string; readonly newText: string }): Promise<WriteChallenge> {
    const before = await regularBytes(input.absolutePath, this.#max); const after = Buffer.from(input.newText, 'utf8')
    if (after.byteLength > this.#max) throw new RangeError('replacement exceeds workbench file limit')
    const id = `workbench-tx-${randomUUID()}`; const token = this.#token(); if (token.length < 20) throw new Error('unsafe confirmation token')
    const now = this.#now(); const beforeSha256 = digest(before); const afterSha256 = digest(after)
    await this.#store.save({ id, workspaceId: input.workspaceId, relativePath: input.relativePath, absolutePath: input.absolutePath,
      beforeSha256, afterSha256, beforeBase64: before.toString('base64'), afterBase64: after.toString('base64'), state: 'prepared', createdAt: now, updatedAt: now,
      challenge: { tokenSha256: digest(token), expiresAt: now + this.#ttl } })
    return Object.freeze({ id, token, expiresAt: new Date(now + this.#ttl).toISOString(), workspaceId: input.workspaceId, relativePath: input.relativePath, beforeSha256, afterSha256, bytes: after.byteLength })
  }
  async confirm(id: string, token: string): Promise<WorkbenchTransaction> {
    const row = required(this.#store.get(id)); if (row.state !== 'prepared') throw new Error('workbench confirmation is no longer available')
    if (this.#now() > row.challenge.expiresAt) { await this.#fail(row, 'confirmation expired'); throw new Error('workbench confirmation expired') }
    if (!equalDigest(digest(token), row.challenge.tokenSha256)) throw new Error('workbench confirmation token does not match')
    const current = await regularBytes(row.absolutePath, this.#max)
    if (!equalDigest(digest(current), row.beforeSha256)) { await this.#fail(row, 'file changed after prepare'); throw new Error('file changed after prepare') }
    const after = Buffer.from(row.afterBase64, 'base64'); await atomicReplace(row.absolutePath, after)
    const verified = await regularBytes(row.absolutePath, this.#max); if (!equalDigest(digest(verified), row.afterSha256)) throw new Error('atomic write verification failed')
    return this.#store.update(row.id, value => ({ ...value, state: 'applied', updatedAt: this.#now(), challenge: { ...value.challenge, confirmedAt: this.#now() } }))
  }
  async revert(id: string): Promise<WorkbenchTransaction> {
    const row = required(this.#store.get(id)); if (row.state === 'reverted') throw new Error('transaction is already reverted'); if (row.state !== 'applied') throw new Error('only an applied transaction can be reverted')
    const current = await regularBytes(row.absolutePath, this.#max); if (!equalDigest(digest(current), row.afterSha256)) throw new Error('file changed after apply; automatic revert is blocked')
    await atomicReplace(row.absolutePath, Buffer.from(row.beforeBase64, 'base64'))
    return this.#store.update(row.id, value => ({ ...value, state: 'reverted', updatedAt: this.#now() }))
  }
  list(): readonly WorkbenchTransaction[] { return this.#store.list().map(({ beforeBase64: _before, afterBase64: _after, challenge, ...row }) => ({ ...row, beforeBase64: '', afterBase64: '', challenge: { ...challenge, tokenSha256: '[redacted]' } })) }
  async #fail(row: WorkbenchTransaction, error: string): Promise<void> { await this.#store.update(row.id, value => ({ ...value, state: 'failed', error, updatedAt: this.#now() })) }
}
async function regularBytes(path: string, max: number): Promise<Buffer> { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError('write target must be a regular file'); if (stat.size > max) throw new RangeError('workbench file exceeds limit'); return readFile(path) }
async function atomicReplace(path: string, bytes: Buffer): Promise<void> { const temp = join(dirname(path), `.${randomUUID()}.xiaoshe.tmp`); await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, path) }
function digest(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }
function equalDigest(left: string, right: string): boolean { const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex'); return a.length === b.length && timingSafeEqual(a, b) }
function required(value: WorkbenchTransaction | undefined): WorkbenchTransaction { if (value === undefined) throw new Error('unknown workbench transaction'); return value }
