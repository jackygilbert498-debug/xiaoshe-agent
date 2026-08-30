import {
  deriveProviderReadinessFacts,
  type ModelCatalog,
  type ModelCatalogSnapshot,
  type ProviderProbeRecord,
  type ProviderReadiness,
  type ProviderReadinessProvider,
  type ProviderReadinessSnapshot,
  type RuntimeCommandResult,
} from '@xiaoshe/runtime-contract'

type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code?: string; readonly message: string } }
interface DirectoryEntry {
  readonly provider: string; readonly displayName: string; readonly settingsNs: string
  readonly settingsPath: readonly string[]; readonly active: boolean; readonly declared: boolean
}
interface NamespaceView { readonly ns: string; readonly value: unknown }
interface CredentialView { readonly configured: boolean }
interface SettingsFace {
  ensure(): Promise<void>
  getSnapshot(): { readonly status: string; readonly view?: { readonly namespaces: readonly NamespaceView[] }; readonly error?: string | null }
  subscribe(listener: () => void): () => void
}
interface ConnectionPort {
  readonly api: {
    readonly llm: { providers(input: Record<string, never>): Promise<{ readonly result: RpcResult<{ readonly providers: readonly DirectoryEntry[] }> }> }
    readonly credentials: { describe(input: { readonly refs: readonly string[] }): Promise<{ readonly result: RpcResult<{ readonly credentials: Readonly<Record<string, CredentialView>> }> }> }
  }
}
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ProjectProviderReadinessInput {
  readonly directory: readonly DirectoryEntry[]
  readonly settings: readonly NamespaceView[]
  readonly credentials: Readonly<Record<string, CredentialView>>
  readonly modelSnapshot: ModelCatalogSnapshot
  readonly probes: readonly ProviderProbeRecord[]
  readonly now: number
  readonly verificationTtlMs: number
}

/** Join directory, shared settings, credentials, session routes and exact probes. */
export function projectProviderReadiness(input: ProjectProviderReadinessInput): Pick<ProviderReadinessSnapshot, 'sessionId' | 'providers'> {
  const directory = new Map(input.directory.map(row => [row.provider, row]))
  const groups = new Map(input.modelSnapshot.groups.map(group => [group.id, group]))
  const providerIds = [...new Set([...input.directory.map(row => row.provider), ...input.modelSnapshot.groups.map(group => group.id)])]
  const probes = new Map(input.probes.map(row => [`${row.provider}\u0000${row.model}`, row]))
  const namespaces = new Map(input.settings.map(row => [row.ns, row]))
  const providers: ProviderReadinessProvider[] = providerIds.map((providerId) => {
    const entry = directory.get(providerId)
    const group = groups.get(providerId)
    const namespace = entry === undefined ? undefined : namespaces.get(entry.settingsNs)
    const profile = entry === undefined || namespace === undefined ? undefined : valueAt(namespace.value, entry.settingsPath)
    const settingsConfigured = entry !== undefined && namespace !== undefined
      && (entry.settingsPath.length === 0 || profile !== undefined)
    const credentialRef = stringField(profile, 'apiKeyEnv')
    const routes = (group?.models ?? []).map(model => {
      const probe = probes.get(`${providerId}\u0000${model.id}`)
      const derived = deriveProviderReadinessFacts({
        provider: providerId,
        model: model.id,
        catalogued: entry !== undefined,
        supported: true,
        settingsConfigured,
        credentialRequired: credentialRef !== undefined,
        credentialConfigured: credentialRef === undefined || input.credentials[credentialRef]?.configured === true,
        routeAvailable: entry?.active === true,
        ...(probe === undefined ? {} : { probe }),
      }, input.now, input.verificationTtlMs)
      return Object.freeze({
        provider: providerId,
        model: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...derived,
        ...(probe === undefined ? {} : { probe }),
      })
    })
    return Object.freeze({
      id: providerId,
      displayName: entry?.displayName ?? group?.name ?? providerId,
      active: entry?.active === true,
      declared: entry?.declared === true,
      routes: Object.freeze(routes),
    })
  })
  return Object.freeze({
    ...(input.modelSnapshot.sessionId === undefined ? {} : { sessionId: input.modelSnapshot.sessionId }),
    providers: Object.freeze(providers),
  })
}

/** DOM-free observable provider; no probe occurs until the user asks for one. */
export class ProviderReadinessClient implements ProviderReadiness {
  readonly #listeners = new Set<() => void>()
  readonly #controllers = new Set<AbortController>()
  readonly #connection: ConnectionPort
  readonly #settings: SettingsFace
  readonly #modelCatalog: ModelCatalog
  readonly #fetcher: FetchLike
  readonly #now: () => number
  readonly #verificationTtlMs: number
  readonly #releases: readonly (() => void)[]
  #snapshot: ProviderReadinessSnapshot
  #generation = 0
  #disposed = false

  constructor(input: {
    readonly connection: ConnectionPort; readonly settings: SettingsFace; readonly modelCatalog: ModelCatalog
    readonly fetcher?: FetchLike; readonly now?: () => number; readonly verificationTtlMs?: number
  }) {
    this.#connection = input.connection
    this.#settings = input.settings
    this.#modelCatalog = input.modelCatalog
    this.#fetcher = input.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#now = input.now ?? Date.now
    this.#verificationTtlMs = input.verificationTtlMs ?? 24 * 60 * 60 * 1_000
    if (!Number.isSafeInteger(this.#verificationTtlMs) || this.#verificationTtlMs <= 0) throw new TypeError('verificationTtlMs must be a positive integer')
    this.#snapshot = freezeSnapshot({ status: 'idle', providers: [], verificationTtlMs: this.#verificationTtlMs })
    const schedule = (): void => { queueMicrotask(() => { if (!this.#disposed) void this.refresh() }) }
    this.#releases = [this.#settings.subscribe(schedule), this.#modelCatalog.subscribe(schedule)]
  }

  getSnapshot = (): ProviderReadinessSnapshot => this.#snapshot
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  async refresh(sessionId = this.#modelCatalog.getSnapshot().sessionId): Promise<RuntimeCommandResult<ProviderReadinessSnapshot>> {
    if (this.#disposed) return failure('conflict', 'provider readiness service is disposed')
    const generation = ++this.#generation
    this.#publish({ ...withoutError(this.#snapshot), ...(sessionId === undefined ? {} : { sessionId }), status: 'loading' })
    const controller = new AbortController()
    this.#controllers.add(controller)
    try {
      await this.#settings.ensure()
      let modelSnapshot = this.#modelCatalog.getSnapshot()
      if (sessionId !== undefined && modelSnapshot.status !== 'ready') {
        await this.#modelCatalog.refresh(sessionId)
        modelSnapshot = this.#modelCatalog.getSnapshot()
      }
      const [providerResponse, probeResponse] = await Promise.all([
        this.#connection.api.llm.providers({}),
        this.#fetcher('/api/xiaoshe/providers/readiness', { method: 'GET', cache: 'no-store', signal: controller.signal }),
      ])
      if (this.#disposed || generation !== this.#generation) return failure('conflict', 'provider readiness refresh was superseded')
      if (!providerResponse.result.ok) return this.#fail('provider', providerResponse.result.error.message)
      const settingsSnapshot = this.#settings.getSnapshot()
      const settings = settingsSnapshot.view?.namespaces
      if (settings === undefined) return this.#fail('provider', settingsSnapshot.error ?? 'settings are unavailable')
      const hostValue: unknown = await probeResponse.json()
      if (!probeResponse.ok) return this.#fail('transport', httpError(hostValue, probeResponse.status))
      const probes = parseProbeList(hostValue)
      const refs = credentialRefs(providerResponse.result.value.providers, settings)
      let credentials: Readonly<Record<string, CredentialView>> = {}
      if (refs.length > 0) {
        const response = await this.#connection.api.credentials.describe({ refs })
        if (!response.result.ok) return this.#fail('provider', response.result.error.message)
        credentials = response.result.value.credentials
      }
      const projected = projectProviderReadiness({
        directory: providerResponse.result.value.providers,
        settings,
        credentials,
        modelSnapshot,
        probes,
        now: this.#now(),
        verificationTtlMs: this.#verificationTtlMs,
      })
      const next = freezeSnapshot({ ...projected, status: 'ready', verificationTtlMs: this.#verificationTtlMs, updatedAt: this.#now() })
      this.#publish(next)
      return { ok: true, value: next }
    } catch (error: unknown) {
      if (this.#disposed || generation !== this.#generation) return failure('conflict', 'provider readiness refresh was superseded')
      return this.#fail(controller.signal.aborted ? 'conflict' : 'transport', safeMessage(error))
    } finally { this.#controllers.delete(controller) }
  }

  async probe(input: { readonly provider: string; readonly model: string; readonly timeoutMs?: number }): Promise<RuntimeCommandResult<{ readonly probe: ProviderProbeRecord; readonly snapshot: ProviderReadinessSnapshot }>> {
    if (this.#disposed) return failure('conflict', 'provider readiness service is disposed')
    const timeoutMs = input.timeoutMs ?? 15_000
    const controller = new AbortController()
    this.#controllers.add(controller)
    this.#publish({ ...withoutError(this.#snapshot), status: 'probing' })
    try {
      const response = await this.#fetcher('/api/xiaoshe/providers/probe', {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: input.provider, model: input.model, timeoutMs }),
      })
      const value: unknown = await response.json()
      if (!response.ok) return this.#failResult(httpKind(value, response.status), httpError(value, response.status))
      const probe = parseSingleProbe(value)
      const refreshed = await this.refresh(this.#snapshot.sessionId)
      if (!refreshed.ok) return refreshed
      return { ok: true, value: Object.freeze({ probe, snapshot: refreshed.value }) }
    } catch (error: unknown) {
      return this.#failResult(controller.signal.aborted ? 'conflict' : 'transport', safeMessage(error))
    } finally { this.#controllers.delete(controller) }
  }

  cancelProbe(): RuntimeCommandResult<{ readonly cancelled: true }> {
    if (this.#disposed) return failure('conflict', 'provider readiness service is disposed')
    void this.#cancelOnHost()
    return { ok: true, value: { cancelled: true } }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    ++this.#generation
    for (const release of this.#releases) release()
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
    this.#listeners.clear()
  }

  async #cancelOnHost(): Promise<void> {
    try {
      await this.#fetcher('/api/xiaoshe/providers/probe/cancel', {
        method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}',
      })
    } catch { /* The running probe request reports the authoritative outcome. */ }
  }
  #fail(kind: 'provider' | 'transport' | 'conflict', message: string): RuntimeCommandResult<ProviderReadinessSnapshot> {
    this.#publish({ ...this.#snapshot, status: 'error', error: message })
    return failure(kind, message)
  }
  #failResult<T>(kind: 'provider' | 'transport' | 'conflict' | 'invalid_request', message: string): RuntimeCommandResult<T> {
    this.#publish({ ...this.#snapshot, status: 'error', error: message })
    return failure(kind, message)
  }
  #publish(next: ProviderReadinessSnapshot): void {
    if (this.#disposed) return
    this.#snapshot = freezeSnapshot(next)
    for (const listener of this.#listeners) listener()
  }
}

interface ClientScope {
  readonly connection: ConnectionPort
  readonly modelCatalog: ModelCatalog
  readonly settingsScope: { describe(): SettingsFace }
  provide(name: string, value: unknown): unknown
  effect(execute: () => (() => void), label?: string): unknown
}
interface ClientContext { inject(names: readonly string[], mount: (scope: ClientScope) => void): unknown }
export const inject = ['connection', 'modelCatalog', 'settingsScope']
export function apply(ctx: ClientContext): void {
  ctx.inject(inject, scope => {
    const provider = new ProviderReadinessClient({ connection: scope.connection, settings: scope.settingsScope.describe(), modelCatalog: scope.modelCatalog })
    scope.provide('providerReadiness', provider)
    scope.effect(() => { void provider.refresh(); return () => provider.dispose() }, 'xiaoshe-provider-readiness: browser projection')
  })
}

function credentialRefs(entries: readonly DirectoryEntry[], settings: readonly NamespaceView[]): readonly string[] {
  const namespaces = new Map(settings.map(row => [row.ns, row]))
  return Object.freeze([...new Set(entries.flatMap(entry => {
    const profile = valueAt(namespaces.get(entry.settingsNs)?.value, entry.settingsPath)
    const ref = stringField(profile, 'apiKeyEnv')
    return ref === undefined ? [] : [ref]
  }))])
}
function valueAt(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined
    current = current[part]
  }
  return current
}
function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value) || typeof value[field] !== 'string') return undefined
  const normalized = String(value[field]).trim()
  return normalized === '' ? undefined : normalized
}
function parseProbeList(value: unknown): readonly ProviderProbeRecord[] {
  if (!isRecord(value) || !Array.isArray(value.probes)) throw new TypeError('provider probe response is invalid')
  return Object.freeze(value.probes.map(parseProbe))
}
function parseSingleProbe(value: unknown): ProviderProbeRecord {
  if (!isRecord(value)) throw new TypeError('provider probe response is invalid')
  return parseProbe(value.probe)
}
function parseProbe(value: unknown): ProviderProbeRecord {
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.model !== 'string'
    || typeof value.startedAt !== 'number' || !isRecord(value.cost) || value.cost.status !== 'unavailable') {
    throw new TypeError('provider probe record is invalid')
  }
  if (value.status === 'running') return Object.freeze(value as unknown as ProviderProbeRecord)
  if ((value.status !== 'succeeded' && value.status !== 'failed' && value.status !== 'cancelled')
    || typeof value.completedAt !== 'number' || typeof value.latencyMs !== 'number') throw new TypeError('provider probe record is invalid')
  return Object.freeze(structuredClone(value) as ProviderProbeRecord)
}
function freezeSnapshot(value: ProviderReadinessSnapshot): ProviderReadinessSnapshot {
  return Object.freeze(structuredClone(value))
}
function withoutError(value: ProviderReadinessSnapshot): Omit<ProviderReadinessSnapshot, 'error'> {
  const { error: _error, ...rest } = value
  return rest
}
function failure<T>(kind: 'provider' | 'transport' | 'conflict' | 'invalid_request', message: string): RuntimeCommandResult<T> {
  return { ok: false, error: { kind, message } }
}
function httpError(value: unknown, status: number): string { return isRecord(value) && typeof value.error === 'string' ? value.error : `HTTP ${status}` }
function httpKind(value: unknown, status: number): 'provider' | 'transport' | 'conflict' | 'invalid_request' {
  if (status === 409) return 'conflict'
  if (status >= 400 && status < 500) return 'invalid_request'
  return isRecord(value) && value.kind === 'PROVIDER_RUNTIME_ERROR' ? 'provider' : 'transport'
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000) }
