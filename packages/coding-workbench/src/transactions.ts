import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { atomicFileReplace, type AtomicFileIo } from './atomic-file.js'

export type WorkbenchTransactionState = 'prepared' | 'applying' | 'applied' | 'reverting' | 'reverted' | 'failed'
export interface WorkbenchTransaction {
  readonly id: string; readonly workspaceId: string; readonly relativePath: string; readonly absolutePath: string
  readonly beforeSha256: string; readonly afterSha256: string; readonly beforeBase64: string; readonly afterBase64: string
  readonly state: WorkbenchTransactionState; readonly createdAt: number; readonly updatedAt: number
  readonly challenge: { readonly tokenSha256: string; readonly expiresAt: number; readonly confirmedAt?: number }
  readonly error?: string
}
interface Ledger { readonly schemaVersion: 1; readonly transactions: readonly WorkbenchTransaction[] }
export class WorkbenchStorageError extends Error {
  readonly code = 'WORKBENCH_STORAGE_FAILED'
  constructor() { super('工作台账本保存失败；未确认落盘的状态不会发布，请检查本机存储后重试。') }
}
export function pendingTransaction(row: WorkbenchTransaction): boolean { return row.state === 'applying' || row.state === 'reverting' }

/** Profile-local, atomically replaced journal for exact write and revert receipts. */
export class WorkbenchTransactionStore {
  readonly #path: string; #rows: WorkbenchTransaction[]; #tail: Promise<void> = Promise.resolve()
  readonly #paths = new Map<string, Promise<void>>()
  constructor(path: string, private readonly max = 100, private readonly io?: AtomicFileIo) {
    if (!isAbsolute(path)) throw new TypeError('workbench ledger path must be absolute')
    if (!Number.isSafeInteger(max) || max < 1) throw new TypeError('workbench ledger history limit must be positive')
    this.#path = resolve(path); this.#rows = this.#load()
  }
  list(): readonly WorkbenchTransaction[] { return structuredClone(this.#rows) }
  get(id: string): WorkbenchTransaction | undefined { const row = this.#rows.find(item => item.id === id); return row === undefined ? undefined : structuredClone(row) }
  async save(row: WorkbenchTransaction): Promise<WorkbenchTransaction> { return this.#mutate(row.id, () => row, true) }
  async update(id: string, change: (row: WorkbenchTransaction) => WorkbenchTransaction): Promise<WorkbenchTransaction> { return this.#mutate(id, change, false) }
  /** Serializes this service's writers, not unrelated processes or external editors. */
  async withPath<T>(path: string, action: () => Promise<T>): Promise<T> {
    const key = resolve(path); const previous = this.#paths.get(key) ?? Promise.resolve()
    let release!: () => void; const tail = new Promise<void>(done => { release = done }); this.#paths.set(key, tail)
    await previous
    try { return await action() } finally { release(); if (this.#paths.get(key) === tail) this.#paths.delete(key) }
  }
  async #mutate(id: string, change: (row: WorkbenchTransaction) => WorkbenchTransaction, insert: boolean): Promise<WorkbenchTransaction> {
    let release!: () => void; const previous = this.#tail; this.#tail = new Promise(resolveTail => { release = resolveTail }); await previous
    try {
      const current = this.#rows.find(row => row.id === id)
      if (!insert && current === undefined) throw new Error(`unknown workbench transaction ${id}`)
      if (insert && current !== undefined) throw new Error('workbench transaction already exists')
      const next = structuredClone(change(structuredClone(current ?? ({} as WorkbenchTransaction))))
      if (!validRow(next) || next.id !== id) throw new TypeError('workbench transaction is invalid')
      const candidates = this.#retain([next, ...this.#rows.filter(row => row.id !== id)])
      // Publish only committed state. A failed write must not change list()/get().
      await this.#persist(candidates); this.#rows = candidates; return structuredClone(next)
    } finally { release() }
  }
  #load(): WorkbenchTransaction[] {
    if (!existsSync(this.#path)) return []
    let value: unknown
    // Parse failures can echo saved file contents; never forward them to logs/UI.
    try { value = JSON.parse(readFileSync(this.#path, 'utf8')) }
    catch { throw new Error('workbench transaction ledger is unreadable') }
    if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.transactions)) throw new Error('workbench transaction ledger is unreadable')
    if (!value.transactions.every(validRow) || new Set(value.transactions.map(row => row.id)).size !== value.transactions.length) throw new Error('workbench transaction ledger is unreadable')
    return this.#retain(value.transactions)
  }
  #retain(rows: readonly WorkbenchTransaction[]): WorkbenchTransaction[] {
    let completed = 0
    return [...rows].sort((a, b) => b.updatedAt - a.updatedAt).filter(row => pendingTransaction(row) || completed++ < this.max)
  }
  async #persist(rows: readonly WorkbenchTransaction[]): Promise<void> {
    try {
      await mkdir(dirname(this.#path), { recursive: true })
      await atomicFileReplace(this.#path, Buffer.from(`${JSON.stringify({ schemaVersion: 1, transactions: rows } satisfies Ledger, null, 2)}\n`), { ...(this.io === undefined ? {} : { io: this.io }) })
    } catch { throw new WorkbenchStorageError() }
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function validRow(value: unknown): value is WorkbenchTransaction {
  if (!record(value) || !record(value.challenge)) return false
  const text = (key: string) => typeof value[key] === 'string' && value[key] !== '' && !(value[key] as string).includes('\0')
  const sha = (item: unknown) => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item)
  return ['id', 'workspaceId', 'relativePath', 'absolutePath'].every(text)
    && isAbsolute(value.absolutePath as string)
    && sha(value.beforeSha256) && sha(value.afterSha256) && sha(value.challenge.tokenSha256)
    && typeof value.beforeBase64 === 'string' && typeof value.afterBase64 === 'string'
    && ['prepared', 'applying', 'applied', 'reverting', 'reverted', 'failed'].includes(String(value.state))
    && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.updatedAt)
    && Number.isSafeInteger(value.challenge.expiresAt)
    && (value.challenge.confirmedAt === undefined || Number.isSafeInteger(value.challenge.confirmedAt))
    && (value.state !== 'applying' && value.state !== 'reverting' || Number.isSafeInteger(value.challenge.confirmedAt))
}
