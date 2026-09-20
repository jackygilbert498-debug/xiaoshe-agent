type FiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
interface InventoryEntry { readonly entryId: string; readonly moduleName: string; readonly enabled: boolean; readonly fiberPhase: FiberPhase }
interface InventorySnapshot { readonly entries: readonly InventoryEntry[] }
export type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
interface InventoryRemote { list(): Promise<RpcResult<InventorySnapshot>> }

export interface GovernedPluginEntry extends InventoryEntry { readonly trust: 'trusted-host-code'; readonly osSandboxEnforced: false }
export interface PublicCandidate {
  readonly id: string
  readonly packageName: string
  readonly version: string
  readonly sha256: string
  readonly manifestSha256: string
  readonly identity: {
    readonly displayName: string; readonly description?: string; readonly developer?: string
    readonly homepage?: string; readonly license?: string; readonly keywords: readonly string[]
  }
  readonly provenance: {
    readonly kind: 'local-directory' | 'local-tarball' | 'registry'
    readonly selection: 'local-bytes' | 'exact-version' | 'floating-reference' | 'external-reference'
    readonly label: string; readonly assurance: 'unverified' | 'signed-untrusted' | 'verified-publisher' | 'invalid-signature'
  }
  readonly signature: { readonly status: 'unsigned' | 'invalid' | 'valid-untrusted' | 'trusted'; readonly fingerprint?: string; readonly publisher?: string; readonly reason: string }
  readonly audit: Readonly<Record<string, unknown>>
  readonly healthPath?: string
  readonly osSandboxEnforced: false
}
export interface PublicPluginTransaction {
  readonly id: string
  readonly action: string
  readonly profile: string
  readonly packageName: string
  readonly version: string
  readonly state: 'prepared' | 'pending' | 'running' | 'committed' | 'healthy' | 'partial-health' | 'failed' | 'rolled-back' | 'rollback-failed'
  readonly consent: { readonly confirmed: boolean; readonly expiresAt: number }
  readonly health?: readonly { readonly gate: string; readonly ok: boolean; readonly detail: string }[]
  readonly rollback?: {
    readonly attempted: boolean
    readonly succeeded: boolean
    readonly operation?: string
    readonly restoredSpec?: string
    readonly health?: readonly { readonly gate: string; readonly ok: boolean; readonly detail: string }[]
    readonly residuals: readonly string[]
  }
  readonly events?: readonly { readonly at: number; readonly kind: string; readonly message: string }[]
  readonly osSandboxEnforced: false
}
export interface PluginGovernanceSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error' | 'disposed'
  readonly transactions: readonly PublicPluginTransaction[]
  readonly pendingRequests: number
  readonly error?: string
}
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** DOM-free facade over authoritative Host inventory, audit and lifecycle endpoints. */
export class PluginGovernanceProvider {
  readonly #listeners = new Set<() => void>()
  readonly #controllers = new Set<AbortController>()
  #snapshot: PluginGovernanceSnapshot = freezeSnapshot({ status: 'idle', transactions: [], pendingRequests: 0 })
  #disposed = false
  #requestId = 0

  constructor(private readonly inventory: InventoryRemote, private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis)) {}

  getSnapshot = (): PluginGovernanceSnapshot => this.#snapshot
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  async listHostPlugins(): Promise<RpcResult<{ entries: readonly GovernedPluginEntry[] }>> {
    const result = await this.inventory.list()
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        entries: Object.freeze(result.value.entries.map(entry => Object.freeze({
          ...entry, trust: 'trusted-host-code' as const, osSandboxEnforced: false as const,
        }))),
      },
    }
  }

  auditCandidate(source: { readonly kind: 'directory' | 'tarball'; readonly path: string; readonly signaturePath?: string } | { readonly kind: 'registry'; readonly spec: string; readonly signaturePath?: string }, signal?: AbortSignal): Promise<RpcResult<{ candidate: PublicCandidate }>> {
    return this.#request('/api/xiaoshe/plugins/audit', { source }, signal)
  }
  prepareChange(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<RpcResult<{ challenge: Readonly<Record<string, unknown>> }>> {
    return this.#request('/api/xiaoshe/plugins/prepare', input, signal)
  }
  confirmChange(input: { readonly challengeId: string; readonly token: string }, signal?: AbortSignal): Promise<RpcResult<{ transaction: PublicPluginTransaction }>> {
    return this.#request('/api/xiaoshe/plugins/confirm', input, signal, true)
  }
  refreshTransactions(signal?: AbortSignal): Promise<RpcResult<{ transactions: readonly PublicPluginTransaction[] }>> {
    return this.#request('/api/xiaoshe/plugins/transactions', undefined, signal, true)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
    this.#listeners.clear()
    this.#snapshot = freezeSnapshot({ status: 'disposed', transactions: this.#snapshot.transactions, pendingRequests: 0 })
  }

  async #request<T>(path: string, body: unknown, outerSignal?: AbortSignal, projectsTransactions = false): Promise<RpcResult<T>> {
    if (this.#disposed) return failure('DISPOSED', 'plugin governance service is disposed')
    const requestId = ++this.#requestId
    const controller = new AbortController()
    this.#controllers.add(controller)
    const abort = (): void => controller.abort()
    outerSignal?.addEventListener('abort', abort, { once: true })
    this.#set({ status: 'loading', transactions: this.#snapshot.transactions, pendingRequests: this.#controllers.size })
    try {
      const response = await this.fetcher(path, body === undefined
        ? { method: 'GET', cache: 'no-store', signal: controller.signal }
        : { method: 'POST', cache: 'no-store', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const value: unknown = await response.json()
      if (!response.ok) {
        const detail = isRecord(value) && typeof value.error === 'string' ? value.error : `HTTP ${response.status}`
        const code = isRecord(value) && typeof value.kind === 'string' ? value.kind : 'PLUGIN_HTTP_ERROR'
        this.#settle(requestId, { status: 'error', transactions: this.#snapshot.transactions, pendingRequests: Math.max(0, this.#controllers.size - 1), error: detail })
        return failure(code, detail)
      }
      let publicValue = value
      if (projectsTransactions && isRecord(value)) {
        const transactions = Array.isArray(value.transactions)
          ? value.transactions.map(projectPluginTransaction)
          : isRecord(value.transaction) ? [projectPluginTransaction(value.transaction)] : undefined
        if (transactions !== undefined) {
          const projected = Array.isArray(value.transactions)
            ? transactions
            : [transactions[0]!, ...this.#snapshot.transactions.filter(row => row.id !== transactions[0]!.id)]
          this.#settle(requestId, { status: 'ready', transactions: projected, pendingRequests: Math.max(0, this.#controllers.size - 1) })
          publicValue = Object.freeze(Array.isArray(value.transactions)
            ? { transactions: Object.freeze([...transactions]) }
            : { transaction: transactions[0]! })
        }
        else this.#settle(requestId, { status: 'ready', transactions: this.#snapshot.transactions, pendingRequests: Math.max(0, this.#controllers.size - 1) })
      } else {
        this.#settle(requestId, { status: 'ready', transactions: this.#snapshot.transactions, pendingRequests: Math.max(0, this.#controllers.size - 1) })
      }
      return { ok: true, value: publicValue as T }
    } catch (error) {
      const aborted = controller.signal.aborted
      const message = aborted ? 'plugin governance request was aborted' : safeMessage(error)
      if (!this.#disposed) this.#settle(requestId, { status: 'error', transactions: this.#snapshot.transactions, pendingRequests: Math.max(0, this.#controllers.size - 1), error: message })
      return failure(aborted ? 'ABORTED' : 'PLUGIN_CLIENT_ERROR', message)
    } finally {
      outerSignal?.removeEventListener('abort', abort)
      this.#controllers.delete(controller)
    }
  }

  #set(value: PluginGovernanceSnapshot): void {
    if (this.#disposed) return
    this.#snapshot = freezeSnapshot(value)
    for (const listener of this.#listeners) listener()
  }

  #settle(requestId: number, value: PluginGovernanceSnapshot): void {
    if (this.#disposed) return
    if (requestId === this.#requestId) this.#set(value)
    else this.#set({ ...this.#snapshot, pendingRequests: value.pendingRequests })
  }
}

/** Keep the UI's lifecycle view bounded, typed and faithful to Host receipts. */
export function projectPluginTransaction(value: unknown): PublicPluginTransaction {
  if (!isRecord(value)) throw new TypeError('plugin transaction is invalid')
  const id = requiredText(value.id, 'id', 200)
  const action = requiredText(value.action, 'action', 80)
  const profile = requiredText(value.profile, 'profile', 80)
  const packageName = requiredText(value.packageName, 'packageName', 214)
  const version = requiredText(value.version, 'version', 500)
  const states = new Set<PublicPluginTransaction['state']>(['prepared', 'pending', 'running', 'committed', 'healthy', 'partial-health', 'failed', 'rolled-back', 'rollback-failed'])
  const state = value.state
  if (!states.has(state as PublicPluginTransaction['state'])) throw new TypeError('plugin transaction state is invalid')
  const consent = value.consent
  if (!isRecord(consent) || typeof consent.confirmed !== 'boolean' || typeof consent.expiresAt !== 'number' || !Number.isFinite(consent.expiresAt)) throw new TypeError('plugin transaction consent is invalid')
  if (value.osSandboxEnforced !== false) throw new TypeError('plugin transaction sandbox fact is invalid')
  const health = projectHealth(value.health)
  const rollback = projectRollback(value.rollback)
  const events = projectEvents(value.events)
  return Object.freeze({
    id, action, profile, packageName, version, state: state as PublicPluginTransaction['state'],
    consent: Object.freeze({ confirmed: consent.confirmed, expiresAt: consent.expiresAt }),
    ...(health === undefined ? {} : { health }),
    ...(rollback === undefined ? {} : { rollback }),
    ...(events === undefined ? {} : { events }),
    osSandboxEnforced: false,
  })
}

interface ClientContextLike {
  readonly remote: { readonly pluginInventory: InventoryRemote }
  inject(names: readonly string[], mount: (scope: ClientContextLike) => void): unknown
  provide(name: string, value: unknown): unknown
}
export const inject = ['remote', 'remote.pluginInventory']
export function apply(ctx: ClientContextLike): void {
  ctx.inject(inject, scope => { scope.provide('pluginGovernance', new PluginGovernanceProvider(scope.remote.pluginInventory)) })
}

function failure<T>(code: string, message: string): RpcResult<T> { return { ok: false, error: { code, message } } }
function freezeSnapshot(value: PluginGovernanceSnapshot): PluginGovernanceSnapshot {
  return Object.freeze({ ...value, transactions: Object.freeze(value.transactions.map(row => Object.freeze(structuredClone(row)))) })
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) }
function requiredText(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit) throw new TypeError(`plugin transaction ${label} is invalid`)
  return value
}
function projectHealth(value: unknown): PublicPluginTransaction['health'] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 20) throw new TypeError('plugin transaction health is invalid')
  return Object.freeze(value.map(row => {
    if (!isRecord(row) || typeof row.gate !== 'string' || typeof row.ok !== 'boolean' || typeof row.detail !== 'string' || row.gate.length > 80 || row.detail.length > 1_000) throw new TypeError('plugin health gate is invalid')
    return Object.freeze({ gate: row.gate, ok: row.ok, detail: row.detail })
  }))
}
function projectRollback(value: unknown): PublicPluginTransaction['rollback'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.attempted !== 'boolean' || typeof value.succeeded !== 'boolean' || !Array.isArray(value.residuals) || value.residuals.length > 50 || !value.residuals.every(row => typeof row === 'string' && row.length <= 500)) throw new TypeError('plugin transaction rollback is invalid')
  const operation = optionalText(value.operation, 'rollback operation', 80)
  const restoredSpec = optionalText(value.restoredSpec, 'rollback restoredSpec', 500)
  const health = projectHealth(value.health)
  return Object.freeze({
    attempted: value.attempted,
    succeeded: value.succeeded,
    ...(operation === undefined ? {} : { operation }),
    ...(restoredSpec === undefined ? {} : { restoredSpec }),
    ...(health === undefined ? {} : { health }),
    residuals: Object.freeze([...value.residuals]),
  })
}
function projectEvents(value: unknown): PublicPluginTransaction['events'] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 200) throw new TypeError('plugin transaction events are invalid')
  return Object.freeze(value.map(row => {
    if (!isRecord(row) || typeof row.at !== 'number' || !Number.isFinite(row.at) || typeof row.kind !== 'string' || typeof row.message !== 'string' || row.kind.length > 80 || row.message.length > 1_000) throw new TypeError('plugin transaction event is invalid')
    return Object.freeze({ at: row.at, kind: row.kind, message: row.message })
  }))
}
function optionalText(value: unknown, label: string, limit: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '' || value.length > limit) throw new TypeError(`plugin transaction ${label} is invalid`)
  return value
}
