import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export type WorkbenchTransactionState = 'prepared' | 'applied' | 'reverted' | 'failed'
export interface WorkbenchTransaction {
  readonly id: string; readonly workspaceId: string; readonly relativePath: string; readonly absolutePath: string
  readonly beforeSha256: string; readonly afterSha256: string; readonly beforeBase64: string; readonly afterBase64: string
  readonly state: WorkbenchTransactionState; readonly createdAt: number; readonly updatedAt: number
  readonly challenge: { readonly tokenSha256: string; readonly expiresAt: number; readonly confirmedAt?: number }
  readonly error?: string
}
interface Ledger { readonly schemaVersion: 1; readonly transactions: readonly WorkbenchTransaction[] }

/** Profile-local, atomically replaced journal for exact write and revert receipts. */
export class WorkbenchTransactionStore {
  readonly #path: string; #rows: WorkbenchTransaction[]; #tail: Promise<void> = Promise.resolve()
  constructor(path: string, private readonly max = 100) {
    if (!isAbsolute(path)) throw new TypeError('workbench ledger path must be absolute')
    this.#path = resolve(path); this.#rows = this.#load()
  }
  list(): readonly WorkbenchTransaction[] { return structuredClone(this.#rows) }
  get(id: string): WorkbenchTransaction | undefined { const row = this.#rows.find(item => item.id === id); return row === undefined ? undefined : structuredClone(row) }
  async save(row: WorkbenchTransaction): Promise<WorkbenchTransaction> { return this.#mutate(row.id, () => row, true) }
  async update(id: string, change: (row: WorkbenchTransaction) => WorkbenchTransaction): Promise<WorkbenchTransaction> { return this.#mutate(id, change, false) }
  async #mutate(id: string, change: (row: WorkbenchTransaction) => WorkbenchTransaction, insert: boolean): Promise<WorkbenchTransaction> {
    let release!: () => void; const previous = this.#tail; this.#tail = new Promise(resolveTail => { release = resolveTail }); await previous
    try {
      const current = this.#rows.find(row => row.id === id)
      if (!insert && current === undefined) throw new Error(`unknown workbench transaction ${id}`)
      const next = structuredClone(change(current ?? ({} as WorkbenchTransaction)))
      this.#rows = [next, ...this.#rows.filter(row => row.id !== id)].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, this.max)
      await this.#persist(); return structuredClone(next)
    } finally { release() }
  }
  #load(): WorkbenchTransaction[] {
    if (!existsSync(this.#path)) return []
    const value: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
    if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.transactions)) throw new Error('workbench transaction ledger is unreadable')
    return value.transactions.slice(0, this.max) as WorkbenchTransaction[]
  }
  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true }); const temp = `${this.#path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, transactions: this.#rows } satisfies Ledger, null, 2)}\n`, { flag: 'wx' }); await rename(temp, this.#path)
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
