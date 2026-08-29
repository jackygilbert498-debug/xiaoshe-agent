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
    readonly label: string; readonly assurance: 'unverified'
  }
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
  readonly state: string
  readonly consent: { readonly confirmed: boolean; readonly expiresAt: number }
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

  auditCandidate(source: { readonly kind: 'directory' | 'tarball'; readonly path: string } | { readonly kind: 'registry'; readonly spec: string }, signal?: AbortSignal): Promise<RpcResult<{ candidate: PublicCandidate }>> {
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
        this.#set({ status: 'error', transactions: this.#snapshot.transactions, pendingRequests: Math.max(0, this.#controllers.size - 1), error: detail })
        return failure(code, detail)
      }
      if (projectsTransactions && isRecord(value)) {
        const transactions = Array.isArray(value.transactions)
          ? value.transactions
          : isRecord(value.transaction) ? [value.transaction] : undefined
        if (transactions !== undefined) {
          const projected = Array.isArray(value.transactions)
            ? transactions as PublicPluginTransaction[]
            : [transactions[0] as PublicPluginTransaction, ...this.#snapshot.transactions.filter(row => row.id !== (transactions[0] as PublicPluginTransaction).id)]
          this.#set({ status: 'ready', transactions: projected, pendingRequests: Math.max(0, this.#controllers.size - 1) })
        }
        else this.#set({ status: 'ready', transactions: this.#snapshot.transactions, pendingRequests: Math.max(0, this.#controllers.size - 1) })
      } else {
        this.#set({ status: 'ready', transactions: this.#snapshot.transactions, pendingRequests: Math.max(0, this.#controllers.size - 1) })
      }
      return { ok: true, value: value as T }
    } catch (error) {
      const aborted = controller.signal.aborted
      const message = aborted ? 'plugin governance request was aborted' : safeMessage(error)
      if (!this.#disposed) this.#set({ status: 'error', transactions: this.#snapshot.transactions, pendingRequests: Math.max(0, this.#controllers.size - 1), error: message })
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
