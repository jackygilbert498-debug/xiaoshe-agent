import { mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export type PluginAction = 'bootstrap' | 'add' | 'update' | 'remove' | 'rollback'
export type TransactionState = 'prepared' | 'running' | 'healthy' | 'partial-health' | 'failed' | 'rolled-back' | 'rollback-failed'

export interface TransactionEvent {
  readonly at: number
  readonly kind: 'audit' | 'mutation' | 'health' | 'rollback' | 'error'
  readonly message: string
}

export interface ProcessReceiptView {
  readonly operation: string
  readonly exitCode: number
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly stdout: string
  readonly stderr: string
  readonly stdoutBytes: number
  readonly stderrBytes: number
}

export interface HealthGateReceipt {
  readonly gate: 'cli-mutation' | 'profile-dump' | 'profile-start' | 'functional-probe' | 'clean-stop'
  readonly ok: boolean
  readonly detail: string
}

export interface RollbackReceipt {
  readonly attempted: boolean
  readonly succeeded: boolean
  readonly operation?: string
  readonly restoredSpec?: string
  readonly health?: readonly HealthGateReceipt[]
  readonly residuals: readonly string[]
}

export interface PluginTransaction {
  readonly id: string
  readonly action: PluginAction
  readonly profile: string
  readonly packageName: string
  readonly version: string
  readonly candidateSha256: string
  readonly manifestSha256: string
  readonly state: TransactionState
  readonly createdAt: number
  readonly updatedAt: number
  readonly consent: {
    readonly challengeId: string
    readonly tokenSha256: string
    readonly expiresAt: number
    readonly confirmedAt?: number
  }
  readonly disclosures: readonly string[]
  readonly events: readonly TransactionEvent[]
  readonly process?: ProcessReceiptView
  readonly health?: readonly HealthGateReceipt[]
  readonly rollback?: RollbackReceipt
  readonly priorDependencySpec?: string
}

interface StoreDocument { readonly schemaVersion: 1; readonly transactions: readonly PluginTransaction[] }

/** Small profile-owned JSON ledger. Writes are serialized and replaced atomically. */
export class PluginTransactionStore {
  readonly #path: string
  readonly #maxTransactions: number
  #transactions: PluginTransaction[]
  #tail: Promise<void> = Promise.resolve()

  constructor(path: string, options: { readonly maxTransactions?: number } = {}) {
    if (!isAbsolute(path)) throw new TypeError('plugin transaction store path must be absolute')
    this.#path = resolve(path)
    this.#maxTransactions = options.maxTransactions ?? 200
    if (!Number.isSafeInteger(this.#maxTransactions) || this.#maxTransactions < 1 || this.#maxTransactions > 2_000) throw new RangeError('maxTransactions must be between 1 and 2000')
    this.#transactions = this.#load()
  }

  list(): readonly PluginTransaction[] { return freezeCopy(this.#transactions) }

  async save(transaction: PluginTransaction): Promise<PluginTransaction> {
    return this.#serialize(async () => {
      const sanitized = sanitizeTransaction(transaction)
      this.#transactions = [sanitized, ...this.#transactions.filter(row => row.id !== sanitized.id)]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, this.#maxTransactions)
      await this.#persist()
      return freezeCopy(sanitized)
    })
  }

  async update(id: string, mutate: (current: PluginTransaction) => PluginTransaction): Promise<PluginTransaction> {
    return this.#serialize(async () => {
      const index = this.#transactions.findIndex(row => row.id === id)
      if (index < 0) throw new Error(`unknown transaction ${id}`)
      const next = sanitizeTransaction(mutate(freezeCopy(this.#transactions[index]!)))
      if (next.id !== id) throw new TypeError('transaction update cannot change its id')
      this.#transactions[index] = next
      this.#transactions.sort((left, right) => right.updatedAt - left.updatedAt)
      await this.#persist()
      return freezeCopy(next)
    })
  }

  #load(): PluginTransaction[] {
    if (!existsSync(this.#path)) return []
    try {
      const value: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
      if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.transactions)) throw new TypeError('unsupported transaction ledger')
      return value.transactions.slice(0, this.#maxTransactions).map(row => sanitizeTransaction(row as PluginTransaction))
    } catch (error) {
      throw new Error(`plugin transaction ledger is unreadable: ${safeMessage(error)}`)
    }
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    const temp = `${this.#path}.${process.pid}.${Date.now()}.tmp`
    const document: StoreDocument = { schemaVersion: 1, transactions: this.#transactions }
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' })
    await rename(temp, this.#path)
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.#tail
    this.#tail = new Promise<void>(resolveTail => { release = resolveTail })
    await previous
    try { return await operation() } finally { release() }
  }
}

function sanitizeTransaction(value: PluginTransaction): PluginTransaction {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.profile !== 'string' || typeof value.packageName !== 'string') throw new TypeError('invalid plugin transaction')
  const clone = structuredClone(value)
  return clone
}

function freezeCopy<T>(value: T): T { return deepFreeze(structuredClone(value)) }
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return value
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 500) }
