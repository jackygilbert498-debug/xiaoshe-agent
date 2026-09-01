interface ReactLike {
  createElement(
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T
  useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void]
  useRef<T>(initial: T): { current: T }
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void
}

interface ClientUiPrimitivesLike {
  readonly MarkdownText: (props: { readonly text: string; readonly streaming?: boolean }) => unknown
}

interface SlotsLike {
  inject(name: string, setup: () => () => void): () => void
  register(options: {
    name: string
    id?: string
    order?: number
    priority?: number
    label?: string
    children?: Readonly<Record<string, { readonly kind: 'single' | 'list'; readonly scope: 'root' }>>
  }, component: unknown): () => void
}

interface ShellSlotProps {
  readonly renderSlot?: (name: string, props: Readonly<Record<string, unknown>>) => unknown
}

interface Result<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly message: string }
}

type RuntimeImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
interface RuntimeImageInput {
  readonly mediaType: RuntimeImageMediaType
  readonly data: string
  readonly name?: string
}
interface RuntimeImageInputLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly maxImagePixels: number
  readonly maxImageDimension: number
  readonly mediaTypes: readonly RuntimeImageMediaType[]
}
interface DraftImage {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly mediaType: RuntimeImageMediaType
  readonly data: string
  readonly previewUrl: string
}

interface RuntimeSnapshot {
  readonly currentSessionId?: string
  readonly sessions: Readonly<Record<string, {
    readonly state: string
    readonly completionReceipt?: { readonly outcome?: string; readonly sourceSeq?: number }
    readonly imageInputLimits?: RuntimeImageInputLimits
  }>>
}

interface CatalogSnapshot {
  readonly sessions: Readonly<Record<string, {
    readonly sessionId: string
    readonly title?: string
    readonly cwd?: string
    readonly updatedAt: number
  }>>
}

interface TimelineSnapshot {
  readonly total?: number
  readonly hasEarlier?: boolean
  readonly items: readonly {
    readonly key: string
    readonly seq?: number
    readonly time?: number
    readonly kind: string
    readonly text: string
    readonly reasoning?: string
    readonly errorCode?: string
    readonly isError?: boolean
  }[]
}

type WorkSurfaceKind = 'web' | 'file' | 'image' | 'video' | 'pdf' | 'terminal' | 'desktop'
type WorkSurfaceStatus = 'running' | 'ready' | 'error' | 'blocked'
type WorkSurfaceTrust = 'loopback' | 'workspace' | 'local' | 'external' | 'unknown'
type WorkSurfaceView =
  | { readonly kind: 'web'; readonly url?: string; readonly embed: 'loopback' | 'external-only' | 'blocked'; readonly reason?: string }
  | { readonly kind: 'text'; readonly lines: readonly { readonly number: number; readonly text: string }[]; readonly totalLines: number; readonly language?: string; readonly truncated: boolean }
  | { readonly kind: 'diff'; readonly diffs: readonly { readonly path: string; readonly oldText: string | null; readonly newText: string }[]; readonly truncated: boolean }
  | { readonly kind: 'terminal'; readonly output: string; readonly truncated: boolean; readonly exitCode?: number; readonly signal?: string; readonly cwd?: string }
  | { readonly kind: 'media'; readonly mediaType: 'image' | 'video' | 'pdf' | 'desktop'; readonly url?: string; readonly description?: string }
  | { readonly kind: 'metadata'; readonly description: string }

interface WorkSurface {
  readonly id: string
  readonly sessionId: string
  readonly callId: string
  readonly seq: number
  readonly updatedAt: number
  readonly type: WorkSurfaceKind
  readonly title: string
  readonly source?: string
  readonly status: WorkSurfaceStatus
  readonly trust: WorkSurfaceTrust
  readonly capabilities: {
    readonly embedded: boolean
    readonly interactive: boolean
    readonly refresh: boolean
    readonly externalOpen: boolean
    readonly copySource: boolean
    readonly pinnable: true
  }
  readonly view: WorkSurfaceView
}

interface WorkSurfaceRegistrySnapshot {
  readonly sessionId?: string
  readonly items: readonly WorkSurface[]
}

interface ContextSnapshot {
  readonly sessions: Readonly<Record<string, {
    readonly pressure?: unknown
    readonly breakdown?: unknown
    readonly usage?: unknown
    readonly budget?: unknown
    readonly compactions?: readonly unknown[]
  }>>
}

interface ModelCatalogSnapshot {
  readonly sessionId?: string
  readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  readonly current?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly routable?: boolean
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
      readonly defaultEffort?: string
    }[]
  }[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
  readonly error?: string
}

interface RunCenterSnapshot {
  readonly sessionId?: string
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly jobs: readonly { readonly id: string; readonly label: string; readonly status: string; readonly detail?: string; readonly cancellable: false }[]
  readonly subagents: readonly ({ readonly kind: 'child'; readonly id: string; readonly label?: string; readonly activity: string; readonly canOpen: true; readonly canInterrupt: boolean } | { readonly kind: 'diagnostic'; readonly id: string; readonly reason: string; readonly canOpen: false; readonly canInterrupt: false })[]
  readonly queue: readonly { readonly id: string; readonly placement: string; readonly preview: string; readonly editable: boolean; readonly removable: boolean; readonly steerable: boolean }[]
  readonly goal?: { readonly objective: string; readonly phase: string; readonly roundsStarted: number; readonly maxGoalRounds: number; readonly blockedReason?: string }
  readonly plan?: { readonly active: boolean; readonly pending: boolean }
  readonly todos: readonly { readonly id: string; readonly text: string; readonly status: string }[]
  readonly skills: readonly { readonly name: string; readonly description: string; readonly modelInvocable: boolean }[]
  readonly deliverables: readonly { readonly id: string; readonly title: string; readonly kind: string; readonly status: string }[]
  readonly error?: string
}

interface ProviderReadinessSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'probing' | 'error'
  readonly providers: readonly {
    readonly id: string; readonly displayName: string; readonly active: boolean; readonly declared: boolean
    readonly routes: readonly {
      readonly provider: string; readonly model: string; readonly name: string
      readonly facts: { readonly catalogued: boolean; readonly supported: boolean; readonly configured: boolean; readonly available: boolean; readonly verified: boolean }
      readonly reasons: readonly string[]
      readonly probe?: { readonly status: string; readonly latencyMs?: number; readonly contextWindow?: number; readonly completedAt?: number; readonly error?: { readonly message: string } }
    }[]
  }[]
  readonly error?: string
}

interface WorkspaceCatalogSnapshot {
  readonly state: 'idle' | 'loading' | 'ready' | 'error'
  readonly items: readonly {
    readonly workspaceId: string
    readonly path: string
    readonly title: string
    readonly sessionIds: readonly string[]
    readonly createdAt: string
    readonly updatedAt: string
  }[]
  readonly archivedSessionIds: readonly string[]
  readonly error?: string
}

interface PermissionPresetSnapshot {
  readonly sessionId?: string
  readonly status: 'unavailable' | 'ready' | 'switching' | 'error'
  readonly currentValue?: string
  readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
  readonly error?: string
}

interface UserQuestionOption {
  readonly label: string
  readonly description?: string
}
interface UserQuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly UserQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
}
interface UserQuestionRequest {
  readonly key: string
  readonly sessionId: string
  readonly questions: readonly UserQuestionItem[]
  readonly error?: string
}
interface UserQuestionAnswer {
  readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
}
interface QuestionDraft {
  readonly selected: readonly string[]
  readonly custom: string
  readonly skipped: boolean
}
interface QuestionFlowState {
  readonly key?: string
  readonly index: number
  readonly drafts: readonly QuestionDraft[]
  readonly busy: 'answer' | 'cancel' | undefined
  readonly error: string
}

interface MemoryEntry {
  readonly id: string
  readonly scope: 'global' | 'project'
  readonly project?: string
  readonly text: string
  readonly state: 'active' | 'forgotten' | 'superseded'
  readonly version: number
  readonly created_at: string
  readonly updated_at: string
  readonly supersedes?: string
  readonly superseded_by?: string
}

interface MemorySnapshot {
  readonly api_version: 1
  readonly revision: number
  readonly counts: {
    readonly active: number
    readonly global: number
    readonly project: number
    readonly forgotten: number
    readonly superseded: number
  }
  readonly entries: readonly MemoryEntry[]
  readonly audit: readonly unknown[]
  readonly usage: readonly unknown[]
}

interface MemoryLifecycleSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly memory?: MemorySnapshot
  readonly error?: { readonly message: string; readonly status?: number; readonly kind?: string }
}

interface HeartbeatPublicCheck {
  readonly id: string
  readonly status: string
  readonly intervalMs: number
  readonly failureCount: number
  readonly nextRunAt?: number
}

interface ProductHealthValue {
  readonly heartbeat?: unknown
  readonly desktop?: Readonly<Record<string, unknown>>
}

interface ProductHealthSourceError {
  readonly source: 'heartbeat' | 'desktop'
  readonly message: string
  readonly status?: number
  readonly kind?: string
}

type ProductHealthSnapshot =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly value?: ProductHealthValue }
  | { readonly status: 'ready'; readonly value: ProductHealthValue }
  | { readonly status: 'degraded' | 'error'; readonly value?: ProductHealthValue; readonly errors: readonly ProductHealthSourceError[] }

interface PluginGovernanceSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error' | 'disposed'
  readonly transactions: readonly {
    readonly state: string
    readonly action: string
    readonly packageName: string
    readonly profile: string
  }[]
  readonly pendingRequests: number
  readonly error?: string
}

interface PublicCandidate {
  readonly id: string
  readonly packageName: string
  readonly version: string
  readonly sha256: string
  readonly manifestSha256: string
  readonly identity: CandidateIdentity
  readonly provenance: CandidateProvenance
  readonly audit: Readonly<Record<string, unknown>>
  readonly signature: { readonly status: 'unsigned' | 'invalid' | 'valid-untrusted' | 'trusted'; readonly fingerprint?: string; readonly publisher?: string; readonly reason: string }
  readonly healthPath?: string
  readonly osSandboxEnforced: false
}

interface CandidateIdentity {
  readonly displayName: string
  readonly description?: string
  readonly developer?: string
  readonly homepage?: string
  readonly license?: string
  readonly keywords: readonly string[]
}

interface CandidateProvenance {
  readonly kind: 'local-directory' | 'local-tarball' | 'registry'
  readonly selection: 'local-bytes' | 'exact-version' | 'floating-reference' | 'external-reference'
  readonly label: string
  readonly assurance: 'unverified' | 'signed-untrusted' | 'verified-publisher' | 'invalid-signature'
}

export interface PluginConfirmationChallenge {
  readonly id: string
  readonly token: string
  readonly expiresAt: string
  readonly action: 'add' | 'update' | 'remove'
  readonly profile: string
  readonly packageName: string
  readonly version: string
  readonly identity?: CandidateIdentity
  readonly provenance?: CandidateProvenance
  readonly disclosures: readonly string[]
  readonly compatibility?: { readonly status: 'compatible' | 'warning' | 'blocked'; readonly blockers: readonly string[]; readonly warnings: readonly string[]; readonly facts: readonly string[] }
  readonly osSandboxEnforced: false
}

interface PublicPluginTransaction {
  readonly id: string
  readonly action: string
  readonly profile: string
  readonly packageName: string
  readonly version: string
  readonly state: string
  readonly consent: { readonly confirmed: boolean; readonly expiresAt: number }
  readonly osSandboxEnforced: false
}

type CandidateSource =
  | { readonly kind: 'directory' | 'tarball'; readonly path: string; readonly signaturePath?: string }
  | { readonly kind: 'registry'; readonly spec: string; readonly signaturePath?: string }

export type PluginUiIntent =
  | { readonly action: 'add' | 'update'; readonly profile: string; readonly source: CandidateSource }
  | { readonly action: 'remove'; readonly profile: string; readonly packageName: string }

/** The managed target is product policy, not a user-facing implementation choice. */
const MANAGED_PLUGIN_PROFILE = 'xiaoshe-managed-lab'

interface PluginWorkflow {
  readonly step: 'idle' | 'audited' | 'prepared' | 'completed' | 'error'
  readonly intent?: PluginUiIntent
  readonly candidate?: PublicCandidate
  readonly challenge?: PluginConfirmationChallenge
  readonly transaction?: PublicPluginTransaction
  readonly message?: string
}

type SideEntityKind = 'workspace' | 'session'
interface SideEntityTarget {
  readonly kind: SideEntityKind
  readonly id: string
  readonly title: string
}
interface SideEditTarget extends SideEntityTarget {
  readonly value: string
}
interface SideRemovalTarget extends SideEntityTarget {
  readonly path?: string
  readonly sessionCount?: number
}

interface SearchResult {
  readonly items: readonly { readonly sessionId: string; readonly snippet: string }[]
}

export interface LegacyAdaptedClientContext {
  slots: SlotsLike
  /** DSH ui-theme is the sole persisted theme owner for shell and settings. */
  theme: {
    getTheme(): { readonly preference: string; readonly active: { readonly id: string; readonly colorScheme: 'light' | 'dark' }; readonly revision: number }
    setTheme(id: string): void
  }
  on(name: 'theme/change', listener: () => void): () => void
  agentRuntimeSession: {
    getSnapshot(): RuntimeSnapshot
    subscribe(listener: () => void): () => void
    sendTurn(input: { sessionId: string; content: string; images?: readonly RuntimeImageInput[]; mode: 'queue' | 'steer' }): Promise<Result<{ accepted: true }>>
    stopRun(input: { sessionId: string }): Promise<Result<{ accepted: true }>>
    forkSession(input: { sessionId: string }): Promise<Result<{ sessionId: string }>>
  }
  sessionCommand: {
    execute(input: { sessionId: string; line: string }): Promise<Result<{ matched: boolean }>>
  }
  sessionCatalog: {
    getSnapshot(): CatalogSnapshot
    subscribe(listener: () => void): () => void
    createLooseSession(): Promise<Result<{ sessionId: string }>>
    openSession(sessionId: string): Result<{ opened: true }>
    renameSession(sessionId: string, title: string): Promise<Result<{ title: string }>>
    archiveSession(sessionId: string): Promise<Result<{ archived: true }>>
    search(query: string, signal: AbortSignal): Promise<Result<SearchResult>>
  }
  taskTimeline: {
    getSnapshot(): TimelineSnapshot
    subscribe(listener: () => void): () => void
    loadEarlier(): void
  }
  workSurfaceRegistry: {
    getSnapshot(): WorkSurfaceRegistrySnapshot
    subscribe(listener: () => void): () => void
  }
  contextGovernance: {
    getSnapshot(): ContextSnapshot
    subscribe(listener: () => void): () => void
  }
  modelCatalog: {
    getSnapshot(): ModelCatalogSnapshot
    subscribe(listener: () => void): () => void
    refresh(sessionId?: string): Promise<Result<ModelCatalogSnapshot>>
    select(input: { readonly sessionId?: string; readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): Promise<Result<{ selected: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } }>>
  }
  runCenter: {
    getSnapshot(): RunCenterSnapshot
    subscribe(listener: () => void): () => void
    refresh(): Promise<Result<RunCenterSnapshot>>
    updateQueue(input: { readonly sessionId: string; readonly itemId: string; readonly action: { readonly kind: 'remove' | 'steer' } }): Promise<Result<{ accepted: true }>>
    openSubagent(input: { readonly parentSessionId: string; readonly childSessionId: string }): Result<{ opened: true }>
    interruptSubagent(input: { readonly parentSessionId: string; readonly childSessionId: string }): Promise<Result<{ accepted: true }>>
  }
  providerReadiness: {
    getSnapshot(): ProviderReadinessSnapshot
    subscribe(listener: () => void): () => void
    refresh(sessionId?: string): Promise<Result<ProviderReadinessSnapshot>>
    probe(input: { readonly provider: string; readonly model: string; readonly timeoutMs?: number }): Promise<Result<{ readonly probe: unknown; readonly snapshot: ProviderReadinessSnapshot }>>
    cancelProbe(): Result<{ readonly cancelled: true }>
  }
  workspaceCatalog: {
    getSnapshot(): WorkspaceCatalogSnapshot
    subscribe(listener: () => void): () => void
    addFromNativePicker(): Promise<Result<{ cancelled: boolean; workspace?: WorkspaceCatalogSnapshot['items'][number] }>>
    createAndOpenSession(workspaceId: string): Promise<Result<{ sessionId: string }>>
    renameWorkspace(workspaceId: string, title: string): Promise<Result<{ workspace: WorkspaceCatalogSnapshot['items'][number] }>>
    removeWorkspace(workspaceId: string): Promise<Result<{ removed: true }>>
  }
  userApproval: {
    getSnapshot(): {
      readonly approvals: readonly {
        readonly key: string
        readonly toolName: string
        readonly callId?: string
        readonly reason?: string
      }[]
    }
    subscribe(listener: () => void): () => void
    answer(key: string, outcome: 'allowed-once' | 'rejected'): Promise<Result<{ accepted: true }>>
  }
  userQuestionInteraction: {
    getSnapshot(): { readonly sessionId?: string; readonly requests: readonly UserQuestionRequest[] }
    subscribe(listener: () => void): () => void
    answer(key: string, answer: UserQuestionAnswer): Promise<Result<{ accepted: true }>>
    cancel(key: string): Promise<Result<{ cancelled: true }>>
  }
  permissionPresets: {
    getSnapshot(): PermissionPresetSnapshot
    subscribe(listener: () => void): () => void
    select(value: string): Promise<Result<{ selected: string }>>
  }
  pluginGovernance: {
    listHostPlugins(): Promise<Result<{ entries: readonly { moduleName: string; fiberPhase: string | null }[] }>>
    auditCandidate(source: CandidateSource, signal?: AbortSignal): Promise<Result<{ candidate: PublicCandidate }>>
    prepareChange(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<Result<{ challenge: PluginConfirmationChallenge }>>
    confirmChange(input: { readonly challengeId: string; readonly token: string }, signal?: AbortSignal): Promise<Result<{ transaction: PublicPluginTransaction }>>
    getSnapshot(): PluginGovernanceSnapshot
    subscribe(listener: () => void): () => void
    refreshTransactions(): Promise<unknown>
  }
  memoryLifecycle: {
    getSnapshot(): MemoryLifecycleSnapshot
    subscribe(listener: () => void): () => void
    refresh(query?: {
      readonly scope?: 'global' | 'project' | 'all'
      readonly project?: string
      readonly include_inactive?: boolean
    }): Promise<MemorySnapshot>
    remember(input: {
      readonly scope: 'global' | 'project'
      readonly project?: string
      readonly text: string
      readonly replaces_id?: string
    }, expectedRevision: number): Promise<MemorySnapshot>
    setState(id: string, state: 'active' | 'forgotten', expectedRevision: number): Promise<MemorySnapshot>
  }
  productHealth: {
    getSnapshot(): ProductHealthSnapshot
    subscribe(listener: () => void): () => void
    refresh(): Promise<ProductHealthSnapshot>
  }
}

/** Convert form values into a bounded intent. Runtime policy remains authoritative. */
export function validatePluginIntent(input: {
  readonly action: string
  readonly profile: string
  readonly sourceKind: string
  readonly source: string
  readonly signaturePath?: string
}): PluginUiIntent {
  const profile = input.profile.trim()
  if (!/^xiaoshe-managed-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(profile)) {
    throw new TypeError('目标必须是受管扩展环境')
  }
  const source = boundedText(input.source, '候选来源或包名', 2_000)
  const signaturePath = input.signaturePath?.trim() ?? ''
  if (signaturePath.length > 2_000 || /[\r\n\0]/u.test(signaturePath)) throw new TypeError('签名旁路文件路径无效')
  if (input.action === 'remove') {
    if (source.length > 214) throw new TypeError('包名过长')
    return { action: 'remove', profile, packageName: source }
  }
  if (input.action !== 'add' && input.action !== 'update') {
    throw new TypeError('插件动作必须是安装、更新或卸载')
  }
  if (input.sourceKind === 'registry') {
    if (source.length > 500) throw new TypeError('软件源版本说明过长')
    return { action: input.action, profile, source: { kind: 'registry', spec: source, ...(signaturePath === '' ? {} : { signaturePath }) } }
  }
  if (input.sourceKind !== 'directory' && input.sourceKind !== 'tarball') {
    throw new TypeError('候选来源类型无效')
  }
  return { action: input.action, profile, source: { kind: input.sourceKind, path: source, ...(signaturePath === '' ? {} : { signaturePath }) } }
}

export const inject = [
  'slots',
  'theme',
  'agentRuntimeSession',
  'sessionCommand',
  'sessionCatalog',
  'taskTimeline',
  'workSurfaceRegistry',
  'contextGovernance',
  'modelCatalog',
  'runCenter',
  'providerReadiness',
  'workspaceCatalog',
  'pluginGovernance',
  'userApproval',
  'userQuestionInteraction',
  'permissionPresets',
  'memoryLifecycle',
  'productHealth',
]

export const BROWSER_BRAND_ICON_HREF = '/api/xiaoshe/legacy-adapted-brand-icon?v=3a919a69c3b6f425'
export const BROWSER_BRAND_RASTER_HREF = '/api/xiaoshe/legacy-adapted-brand-raster?v=ac2b7c8f62f571c6'
const BROWSER_BRAND_ICON_ID = 'xiaoshe-legacy-adapted-browser-icon'

type BrowserBrandObserverFactory = (callback: () => void) => {
  observe(target: Node, options: MutationObserverInit): void
  disconnect(): void
}

/** Keep a durable session title while replacing only the DSH product suffix. */
export function brandBrowserTitle(value: string): string {
  const current = value.trim()
  if (current === '' || /^(?:DSH Local Build|DeepSeek Harness)$/iu.test(current)) return '小蛇'
  if (current === '小蛇' || current.endsWith(' — 小蛇') || current.startsWith('小蛇 · ')) return current
  const withoutHost = current.replace(/\s*(?:—|-)\s*(?:DSH Local Build|DeepSeek Harness)$/iu, '').trim()
  return withoutHost === '' ? '小蛇' : `${withoutHost} — 小蛇`
}

/** Own only browser metadata and restore every touched value on teardown. */
export function mountBrowserBrand(doc: Document, createObserver?: BrowserBrandObserverFactory): () => void {
  const originalTitle = doc.title
  const originalIcons = new Map<HTMLLinkElement, { href: string | null; rel: string | null; type: string | null; id: string }>()
  let managedIcon: HTMLLinkElement | null = null
  let managedIconCreated = false
  let applying = false

  const setAttribute = (node: HTMLLinkElement, name: 'href' | 'rel' | 'type', value: string): void => {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value)
  }
  const applyBrand = (): void => {
    if (applying) return
    applying = true
    try {
      const title = brandBrowserTitle(doc.title)
      if (doc.title !== title) doc.title = title
      const candidates = Array.from(doc.head.querySelectorAll<HTMLLinkElement>("link[rel~='icon']"))
      if (managedIcon === null || !managedIcon.isConnected) {
        managedIcon = doc.getElementById(BROWSER_BRAND_ICON_ID) as HTMLLinkElement | null
        managedIcon ??= candidates[0] ?? null
        if (managedIcon === null) {
          managedIcon = doc.createElement('link')
          managedIconCreated = true
          doc.head.appendChild(managedIcon)
        } else if (!originalIcons.has(managedIcon)) {
          originalIcons.set(managedIcon, {
            href: managedIcon.getAttribute('href'), rel: managedIcon.getAttribute('rel'),
            type: managedIcon.getAttribute('type'), id: managedIcon.id,
          })
        }
        managedIcon.id = BROWSER_BRAND_ICON_ID
      }
      for (const icon of candidates) {
        if (icon === managedIcon) continue
        if (!originalIcons.has(icon)) {
          originalIcons.set(icon, {
            href: icon.getAttribute('href'), rel: icon.getAttribute('rel'),
            type: icon.getAttribute('type'), id: icon.id,
          })
        }
        // Only one active favicon is allowed. Keep late Host candidates
        // restorable, but prevent them from racing the official Xiaoshe icon.
        setAttribute(icon, 'rel', 'alternate')
      }
      setAttribute(managedIcon, 'rel', 'icon')
      setAttribute(managedIcon, 'type', 'image/svg+xml')
      setAttribute(managedIcon, 'href', BROWSER_BRAND_ICON_HREF)
    } finally {
      applying = false
    }
  }

  applyBrand()
  const observer = createObserver?.(applyBrand)
  // Observe structural favicon replacement only. Watching the attributes we
  // write can race a host/theme favicon owner into an endless MutationObserver
  // ping-pong; in Electron that starves the renderer and leaves a painted but
  // non-interactive window. A newly inserted icon still triggers re-ownership.
  observer?.observe(doc.head, {
    childList: true,
    subtree: true,
  })

  return () => {
    observer?.disconnect()
    if (managedIconCreated) managedIcon?.remove()
    for (const [icon, original] of originalIcons) {
      if (original.href === null) icon.removeAttribute('href')
      else icon.setAttribute('href', original.href)
      if (original.rel === null) icon.removeAttribute('rel')
      else icon.setAttribute('rel', original.rel)
      if (original.type === null) icon.removeAttribute('type')
      else icon.setAttribute('type', original.type)
      icon.id = original.id
    }
    if (doc.title === '小蛇' || doc.title.endsWith(' — 小蛇') || doc.title.startsWith('小蛇 · ')) {
      doc.title = originalTitle
    }
  }
}

/** Replaced with the self-contained legacy-derived stylesheet by the build script. */
export const HERITAGE_CSS = '__XIAOSHE_LEGACY_ADAPTED_CSS__'

export type ComposerEnterBehavior = 'enter-send' | 'ctrl-enter-send'

/** Browser-local preference owned by the Xiaoshe composer plugin. */
export const COMPOSER_ENTER_STORAGE_KEY = 'xsla-composer-enter-v1'

/** Treat stored preference text as untrusted input. */
export function parseComposerEnterBehavior(value: string | null | undefined): ComposerEnterBehavior {
  return value === 'ctrl-enter-send' ? value : 'enter-send'
}

/** Resolve composer keyboard intent without breaking IME or multiline input. */
export function composerKeyAction(input: {
  readonly key: string
  readonly shiftKey: boolean
  readonly isComposing: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly behavior?: ComposerEnterBehavior
}): 'submit' | 'newline' | 'ignore' {
  if (input.key !== 'Enter') return 'ignore'
  if (input.shiftKey || input.isComposing) return 'newline'
  if (input.behavior === 'ctrl-enter-send') {
    return input.ctrlKey === true || input.metaKey === true ? 'submit' : 'newline'
  }
  return 'submit'
}

/** Display the shortcut actually handled by the current desktop platform. */
export function platformCommandShortcut(platform: string | undefined): string {
  return /mac|iphone|ipad|ipod/iu.test(platform ?? '') ? '⌘ K' : 'Ctrl K'
}

interface ComposerEnterPreference {
  getSnapshot(): ComposerEnterBehavior
  subscribe(listener: () => void): () => void
  set(value: ComposerEnterBehavior): void
}

/** One observable preference feeds both the settings contribution and composer. */
function createComposerEnterPreference(): ComposerEnterPreference {
  let value: ComposerEnterBehavior
  try {
    value = parseComposerEnterBehavior(globalThis.localStorage?.getItem(COMPOSER_ENTER_STORAGE_KEY))
  } catch {
    value = 'enter-send'
  }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (next === value) return
      value = next
      try { globalThis.localStorage?.setItem(COMPOSER_ENTER_STORAGE_KEY, next) } catch { /* Hardened WebViews may deny storage. */ }
      for (const listener of listeners) listener()
    },
  }
}

export type SlashCommandId = 'new' | 'stop' | 'fork' | 'compact' | 'status' | 'memory' | 'capabilities' | 'plugins'

export const SLASH_COMMAND_DEFINITIONS: readonly {
  readonly id: SlashCommandId
  readonly command: `/${string}`
  readonly label: string
  readonly detail: string
  readonly keywords: readonly string[]
}[] = Object.freeze([
  { id: 'new', command: '/new', label: '新建临时会话', detail: '建立并打开一条独立会话', keywords: ['create', 'session', '会话'] },
  { id: 'stop', command: '/stop', label: '停止当前任务', detail: '请求运行时停止当前执行', keywords: ['cancel', '停止', '任务'] },
  { id: 'fork', command: '/fork', label: '从当前会话分支', detail: '保留历史并创建一个分支会话', keywords: ['branch', '分支', '会话'] },
  { id: 'compact', command: '/compact', label: '压缩当前上下文', detail: '调用运行时压缩长对话，保留继续工作所需信息', keywords: ['compress', 'context', '压缩', '上下文'] },
  { id: 'status', command: '/status', label: '查看任务状态', detail: '打开右侧状态与审批事实', keywords: ['task', '状态', '审批'] },
  { id: 'memory', command: '/memory', label: '查看记忆', detail: '打开全局与项目记忆分区', keywords: ['remember', '记忆', '上下文'] },
  { id: 'capabilities', command: '/capabilities', label: '查看能力', detail: '打开模型、工作区和服务事实', keywords: ['model', 'workspace', '运行', '能力', '模型'] },
  { id: 'plugins', command: '/plugins', label: '管理插件', detail: '进入受控插件审计与一次性确认', keywords: ['plugin', '插件', '扩展'] },
])

/** Only a leading, single-line slash expression owns the command menu. */
export function parseSlashCommandQuery(value: string): string | undefined {
  if (!value.startsWith('/') || value.includes('\n')) return undefined
  return value.slice(1).trim().toLocaleLowerCase()
}

/** Keep filtering deterministic so keyboard and pointer selection share one order. */
export function filterSlashCommandIds(query: string): readonly SlashCommandId[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized === '') return SLASH_COMMAND_DEFINITIONS.map(item => item.id)
  return SLASH_COMMAND_DEFINITIONS.filter(item => [
    item.command.slice(1), item.label, item.detail, ...item.keywords,
  ].some(value => value.toLocaleLowerCase().includes(normalized))).map(item => item.id)
}

const COMPOSER_TEXTAREA_MAX_HEIGHT = 168
let draftImageSequence = 0
export const DEFAULT_DRAFT_IMAGE_LIMITS: RuntimeImageInputLimits = Object.freeze({
  maxImageBytes: 3.5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
})

export const COMPOSER_DRAFT_STORAGE_PREFIX = 'xsla-composer-draft-v1:'
const UNBOUND_COMPOSER_DRAFT_KEY = '__new-session__'
const MAX_STORED_DRAFT_TEXT_CHARACTERS = 1_000_000
const MAX_STORED_DRAFT_IMAGE_DATA_CHARACTERS = 8 * 1024 * 1024

interface ComposerDraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ComposerDraftImage {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly mediaType: RuntimeImageMediaType
  readonly data: string
}

export interface ComposerDraftSnapshot {
  readonly text: string
  readonly images: readonly ComposerDraftImage[]
}

export type ComposerDraftWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid-draft' | 'storage-unavailable' }

function composerDraftStorageKey(sessionId: string | undefined): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${encodeURIComponent(sessionId ?? UNBOUND_COMPOSER_DRAFT_KEY)}`
}

function validStoredDraftImage(value: unknown): value is ComposerDraftImage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const image = value as Readonly<Record<string, unknown>>
  return typeof image.id === 'string' && image.id.length > 0
    && typeof image.name === 'string' && image.name.length <= 512
    && typeof image.size === 'number' && Number.isSafeInteger(image.size) && image.size >= 0
    && (image.mediaType === 'image/png' || image.mediaType === 'image/jpeg' || image.mediaType === 'image/webp' || image.mediaType === 'image/gif')
    && typeof image.data === 'string'
    && image.data.length <= MAX_STORED_DRAFT_IMAGE_DATA_CHARACTERS
    && image.data.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)
}

/** Read one session partition and reject malformed browser storage as empty. */
export function readComposerDraft(storage: ComposerDraftStorage | undefined, sessionId: string | undefined): ComposerDraftSnapshot {
  if (storage === undefined) return { text: '', images: [] }
  try {
    const raw = storage.getItem(composerDraftStorageKey(sessionId))
    if (raw === null) return { text: '', images: [] }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { text: '', images: [] }
    const draft = parsed as Readonly<Record<string, unknown>>
    if (draft.version !== 1 || typeof draft.text !== 'string' || draft.text.length > MAX_STORED_DRAFT_TEXT_CHARACTERS
      || !Array.isArray(draft.images) || !draft.images.every(validStoredDraftImage)) return { text: '', images: [] }
    return { text: draft.text, images: draft.images }
  } catch {
    return { text: '', images: [] }
  }
}

/** Persist one session draft; storage denial never interrupts the live composer. */
export function writeComposerDraft(
  storage: ComposerDraftStorage | undefined,
  sessionId: string | undefined,
  draft: ComposerDraftSnapshot,
): ComposerDraftWriteResult {
  if (draft.text.length > MAX_STORED_DRAFT_TEXT_CHARACTERS || !draft.images.every(validStoredDraftImage)) {
    return { ok: false, reason: 'invalid-draft' }
  }
  if (storage === undefined) return { ok: false, reason: 'storage-unavailable' }
  try {
    storage.setItem(composerDraftStorageKey(sessionId), JSON.stringify({ version: 1, text: draft.text, images: draft.images }))
    return { ok: true }
  } catch {
    return { ok: false, reason: 'storage-unavailable' }
  }
}

/** Clear only the submitted/archived session partition. */
export function clearComposerDraft(storage: ComposerDraftStorage | undefined, sessionId: string | undefined): void {
  try { storage?.removeItem(composerDraftStorageKey(sessionId)) } catch { /* Hardened WebViews may deny storage. */ }
}

function browserSessionDraftStorage(): ComposerDraftStorage | undefined {
  try { return globalThis.sessionStorage } catch { return undefined }
}

function hydrateDraftImages(images: readonly ComposerDraftImage[]): readonly DraftImage[] {
  return images.map(image => ({
    ...image,
    previewUrl: `data:${image.mediaType};base64,${image.data}`,
  }))
}

function persistedDraftImages(images: readonly DraftImage[]): readonly ComposerDraftImage[] {
  return images.map(({ id, name, size, mediaType, data }) => ({ id, name, size, mediaType, data }))
}

/** Grow with content, then switch to an inner scrollbar instead of moving the toolbar. */
export function resizeComposerTextarea(
  textarea: Pick<HTMLTextAreaElement, 'scrollHeight' | 'style'>,
  maxHeight = COMPOSER_TEXTAREA_MAX_HEIGHT,
): number {
  textarea.style.height = 'auto'
  const height = Math.max(24, Math.min(textarea.scrollHeight, maxHeight))
  textarea.style.height = `${height}px`
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  return height
}

/** Infer only DSH-supported raster formats; the Host still verifies real bytes. */
export function imageMediaTypeOf(file: Pick<File, 'name' | 'type'>): RuntimeImageMediaType | undefined {
  if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp' || file.type === 'image/gif') return file.type
  const extension = file.name.toLowerCase().split('.').pop()
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return undefined
}

/** Return one actionable reason instead of partially accepting an ambiguous batch. */
export function draftImageBatchError(
  existing: readonly { readonly bytes: number }[],
  candidates: readonly { readonly name: string; readonly bytes: number; readonly mediaType?: RuntimeImageMediaType }[],
  limits: RuntimeImageInputLimits,
): string | undefined {
  if (candidates.length === 0) return undefined
  if (existing.length + candidates.length > limits.maxImagesPerMessage) return `每次最多添加 ${limits.maxImagesPerMessage} 张图片`
  for (const candidate of candidates) {
    if (candidate.mediaType === undefined || !limits.mediaTypes.includes(candidate.mediaType)) return `${candidate.name} 不是支持的 PNG、JPEG、WebP 或 GIF 图片`
    if (candidate.bytes <= 0) return `${candidate.name} 是空文件`
    if (candidate.bytes > limits.maxImageBytes) return `${candidate.name} 超过单图 ${formatBytes(limits.maxImageBytes)} 上限`
  }
  const total = [...existing, ...candidates].reduce((sum, item) => sum + item.bytes, 0)
  if (total > limits.maxMessageImageBytes) return `图片总大小超过 ${formatBytes(limits.maxMessageImageBytes)} 上限`
  return undefined
}

/** Encode without spreading large arrays onto the JS call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let result = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    const packed = (first << 16) | (second << 8) | third
    result += alphabet[(packed >>> 18) & 63]
    result += alphabet[(packed >>> 12) & 63]
    result += index + 1 < bytes.length ? alphabet[(packed >>> 6) & 63] : '='
    result += index + 2 < bytes.length ? alphabet[packed & 63] : '='
  }
  return result
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`
}

export interface UserTurnNavigationItem {
  readonly key: string
  readonly eventIndex: number
  readonly ordinal: number
  readonly preview: string
}

interface UserTurnPreviewState {
  readonly key: string
  readonly ordinal: number
  readonly preview: string
  readonly top: number
}

const USER_TURN_PREVIEW_MAX_CHARS = 96
const SESSION_CATALOG_PAGE_SIZE = 100

/** Derive the visual turn index from the authoritative timeline without copying session state. */
export function buildUserTurnNavigation(items: TimelineSnapshot['items']): readonly UserTurnNavigationItem[] {
  const result: UserTurnNavigationItem[] = []
  for (const [eventIndex, item] of items.entries()) {
    if (item.kind !== 'user') continue
    const normalized = item.text.replace(/\s+/g, ' ').trim()
    const characters = Array.from(normalized)
    const preview = normalized === ''
      ? '（无文字内容）'
      : characters.length <= USER_TURN_PREVIEW_MAX_CHARS
        ? normalized
        : `${characters.slice(0, USER_TURN_PREVIEW_MAX_CHARS - 1).join('').trimEnd()}…`
    result.push({ key: item.key, eventIndex, ordinal: result.length + 1, preview })
  }
  return result
}

/** Pick the message marker closest to the upper-third reading line. */
export function activeUserTurnOrdinalAtScroll(
  offsets: readonly number[],
  scrollTop: number,
  clientHeight: number,
): number | undefined {
  if (offsets.length === 0 || !Number.isFinite(scrollTop) || !Number.isFinite(clientHeight) || clientHeight <= 0) return undefined
  const readingLine = Math.max(0, scrollTop) + clientHeight * 0.34
  // offsetTop is integer-rounded while scrollTop/clientHeight may remain
  // fractional. Treat a one-pixel edge as the requested reading line so an
  // explicit marker jump cannot immediately highlight the previous message.
  const subpixelTolerance = 1
  let ordinal = 1
  for (const [index, offset] of offsets.entries()) {
    if (!Number.isFinite(offset) || offset > readingLine + subpixelTolerance) break
    ordinal = index + 1
  }
  return ordinal
}

/** Preserve meaningful titles while making generic sessions distinguishable. */
export function sessionDisplayTitle(title: string | undefined, sessionId: string, updatedAt: number): string {
  const normalized = title?.trim() ?? ''
  if (!isGenericSessionTitle(title)) return normalized
  const suffix = sessionId.replace(/[^a-z0-9]/giu, '').slice(-6) || '会话'
  const updated = new Date(updatedAt)
  if (Number.isFinite(updatedAt) && Number.isFinite(updated.getTime())) {
    const stamp = updated.toISOString().slice(5, 16).replace('-', '/').replace('T', ' ')
    return `未命名 · ${stamp} · ${suffix}`
  }
  return `未命名 · ${suffix}`
}

export interface SessionCatalogWindow<T> {
  readonly items: readonly T[]
  readonly total: number
  readonly hasMore: boolean
}

/** Bound sidebar DOM cost while retaining the selected session as an anchor. */
export function windowSessionCatalog<T extends { readonly sessionId: string }>(
  rows: readonly T[],
  requestedLimit: number,
  currentSessionId: string | undefined,
): SessionCatalogWindow<T> {
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 1
  if (rows.length <= limit) return { items: rows, total: rows.length, hasMore: false }
  const items = rows.slice(0, limit)
  const current = currentSessionId === undefined ? undefined : rows.find(row => row.sessionId === currentSessionId)
  if (current !== undefined && !items.some(row => row.sessionId === current.sessionId)) items.push(current)
  return { items, total: rows.length, hasMore: limit < rows.length }
}

/** Generated titles are utility metadata, not identity-bearing display copy. */
function isGenericSessionTitle(title: string | undefined): boolean {
  const normalized = title?.trim() ?? ''
  return normalized === '' || /^(?:未命名(?:任务|会话)?|新会话)$/u.test(normalized)
}

export interface ConversationScrollMetrics {
  readonly scrollHeight: number
  readonly scrollTop: number
  readonly clientHeight: number
}

/** Keep the shortcut absent near the latest turn and reveal it only after a meaningful upward scroll. */
export function shouldOfferJumpToLatest(metrics: ConversationScrollMetrics): boolean {
  const { scrollHeight, scrollTop, clientHeight } = metrics
  if (![scrollHeight, scrollTop, clientHeight].every(Number.isFinite) || clientHeight <= 0 || scrollHeight <= clientHeight) return false
  const distanceFromLatest = scrollHeight - clientHeight - Math.max(0, scrollTop)
  return distanceFromLatest > Math.max(160, clientHeight * 0.3)
}

function conversationScrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'smooth'
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/** Produce the only renderable form of a confirmation challenge; token is omitted by construction. */
export function pluginChallengePresentation(challenge: PluginConfirmationChallenge): {
  readonly heading: string
  readonly facts: readonly string[]
  readonly disclosures: readonly string[]
} {
  const displayName = challenge.identity?.displayName ?? `${challenge.packageName}@${challenge.version}`
  return {
    heading: `${pluginActionLabel(challenge.action)} ${displayName}`,
    facts: [
      `包标识：${challenge.packageName}@${challenge.version}`,
      ...(challenge.provenance === undefined ? [] : [
        `来源：${challenge.provenance.label}`,
        `来源核验：${pluginSourceAssuranceLabel(challenge.provenance.assurance)} · ${pluginSourceSelectionLabel(challenge.provenance.selection)}`,
      ]),
      '目标：受管扩展环境',
      `确认有效期至 ${challenge.expiresAt}`,
      '运行边界：本机进程内 · 系统沙箱未启用',
    ],
    disclosures: challenge.disclosures.map(userFacingPluginDisclosure),
  }
}

/** Format Host-audited facts without re-parsing or upgrading their assurance. */
export function pluginCandidatePresentation(candidate: PublicCandidate): {
  readonly heading: string
  readonly facts: readonly string[]
} {
  const identity = candidate.identity
  const developerLicense = [
    identity.developer === undefined ? undefined : `开发者：${identity.developer}`,
    identity.license === undefined ? undefined : `许可证：${identity.license}`,
  ].filter((value): value is string => value !== undefined).join(' · ')
  return {
    heading: identity.displayName,
    facts: Object.freeze([
      ...(identity.description === undefined ? [] : [`用途：${identity.description}`]),
      `包标识：${candidate.packageName}@${candidate.version}`,
      ...(developerLicense === '' ? [] : [developerLicense]),
      `来源：${candidate.provenance.label}`,
      `来源核验：${pluginSourceAssuranceLabel(candidate.provenance.assurance)} · ${pluginSourceSelectionLabel(candidate.provenance.selection)}`,
      `签名状态：${pluginSignatureStatusLabel(candidate.signature.status)}${candidate.signature.publisher === undefined ? '' : ` · ${candidate.signature.publisher}`}`,
      ...(candidate.signature.fingerprint === undefined ? [] : [`公钥指纹：${abbreviateHash(candidate.signature.fingerprint)}`]),
      '运行边界：本机进程内 · 系统沙箱未启用',
      `风险：${pluginRiskLabel(candidate.audit.risk)}`,
      ...pluginPolicyFacts(candidate.audit),
      `安装包摘要 ${abbreviateHash(candidate.sha256)} · 清单摘要 ${abbreviateHash(candidate.manifestSha256)}`,
    ]),
  }
}

export interface OverlayState {
  readonly side: boolean
  readonly inspector: boolean
}

export const WORKSPACE_GROUP_COLLAPSE_STORAGE_KEY = 'xsla-workspace-groups-collapsed-v1'
export const WORK_SURFACE_DOCK_STORAGE_KEY = 'xsla-work-surface-dock-v1'
export const WORK_SURFACE_DOCK_LIMITS = { min: 320, max: 720, standard: 420 } as const

export type WorkSurfaceDockMode = 'watch' | 'interact'
export interface WorkSurfaceDockPreference {
  readonly open: boolean
  readonly activeId?: string
  readonly width: number
  readonly pinnedIds: readonly string[]
  readonly dismissedIds: readonly string[]
  readonly knownIds: readonly string[]
  readonly mode: WorkSurfaceDockMode
}

interface WorkSurfaceDockState {
  readonly sessionId?: string
  readonly preference: WorkSurfaceDockPreference
}

const DEFAULT_WORK_SURFACE_DOCK: WorkSurfaceDockPreference = {
  open: false,
  width: WORK_SURFACE_DOCK_LIMITS.standard,
  pinnedIds: [],
  dismissedIds: [],
  knownIds: [],
  mode: 'watch',
}

function boundedSurfaceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 512) continue
    ids.add(item)
    if (ids.size >= 64) break
  }
  return [...ids]
}

function sanitizeWorkSurfaceDockPreference(value: unknown): WorkSurfaceDockPreference {
  const row = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {}
  const activeId = typeof row.activeId === 'string' && row.activeId.length > 0 && row.activeId.length <= 512
    ? row.activeId
    : undefined
  return {
    open: row.open === true,
    ...(activeId === undefined ? {} : { activeId }),
    width: Math.round(clampNumber(
      typeof row.width === 'number' && Number.isFinite(row.width) ? row.width : WORK_SURFACE_DOCK_LIMITS.standard,
      WORK_SURFACE_DOCK_LIMITS.min,
      WORK_SURFACE_DOCK_LIMITS.max,
    )),
    pinnedIds: boundedSurfaceIds(row.pinnedIds),
    dismissedIds: boundedSurfaceIds(row.dismissedIds),
    knownIds: boundedSurfaceIds(row.knownIds),
    mode: row.mode === 'interact' ? 'interact' : 'watch',
  }
}

interface StoredWorkSurfaceDockSession {
  readonly id: string
  readonly preference: WorkSurfaceDockPreference
}

/** Parse one session's dock state from bounded, versioned and untrusted browser storage. */
export function parseWorkSurfaceDockPreference(raw: string | null | undefined, sessionId: string | undefined): WorkSurfaceDockPreference {
  if (raw === null || raw === undefined || raw === '' || sessionId === undefined) return DEFAULT_WORK_SURFACE_DOCK
  try {
    const parsed: unknown = JSON.parse(raw)
    const root = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : undefined
    if (root?.version !== 1 || !Array.isArray(root.sessions)) return DEFAULT_WORK_SURFACE_DOCK
    for (const value of root.sessions.slice(-40)) {
      const row = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : undefined
      if (row?.id === sessionId) return sanitizeWorkSurfaceDockPreference(row.preference)
    }
  } catch { /* malformed or unavailable storage falls back to a closed dock */ }
  return DEFAULT_WORK_SURFACE_DOCK
}

/** Update one session without retaining an unbounded history of local UI preferences. */
export function updateWorkSurfaceDockPreferenceStore(
  raw: string | null | undefined,
  sessionId: string,
  preference: WorkSurfaceDockPreference,
): string {
  const sessions: StoredWorkSurfaceDockSession[] = []
  if (raw !== null && raw !== undefined && raw !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      const root = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? parsed as Readonly<Record<string, unknown>>
        : undefined
      if (root?.version === 1 && Array.isArray(root.sessions)) {
        for (const value of root.sessions.slice(-39)) {
          const row = typeof value === 'object' && value !== null && !Array.isArray(value)
            ? value as Readonly<Record<string, unknown>>
            : undefined
          if (typeof row?.id !== 'string' || row.id === sessionId || row.id.length === 0 || row.id.length > 512) continue
          sessions.push({ id: row.id, preference: sanitizeWorkSurfaceDockPreference(row.preference) })
        }
      }
    } catch { /* replace malformed storage with the current safe entry */ }
  }
  sessions.push({ id: sessionId.slice(0, 512), preference: sanitizeWorkSurfaceDockPreference(preference) })
  return JSON.stringify({ version: 1, sessions })
}

/** Reconcile durable UI choices with the authoritative current-session projection. */
export function reconcileWorkSurfaceDockPreference(
  preference: WorkSurfaceDockPreference,
  items: readonly Pick<WorkSurface, 'id'>[],
): WorkSurfaceDockPreference {
  const ids = items.map(item => item.id)
  const available = new Set(ids)
  const known = new Set(preference.knownIds)
  const newIds = ids.filter(id => !known.has(id))
  for (const id of ids) known.add(id)
  const knownIds = [...known].slice(-64)
  const pinnedIds = preference.pinnedIds.filter(id => available.has(id))
  const dismissedIds = preference.dismissedIds.filter(id => available.has(id))
  const visible = ids.filter(id => !dismissedIds.includes(id))
  const newest = newIds.at(-1)
  const activeId = newest ?? (preference.activeId !== undefined && visible.includes(preference.activeId)
    ? preference.activeId
    : visible.at(-1))
  const reconciled = {
    open: items.length > 0 && (newest !== undefined || (preference.open && activeId !== undefined)),
    width: preference.width,
    pinnedIds,
    dismissedIds,
    knownIds,
    mode: preference.mode,
  }
  return activeId === undefined ? reconciled : { ...reconciled, activeId }
}

/** Closing a tab is reversible from the dock launcher and never mutates the underlying DSH result. */
export function dismissWorkSurface(preference: WorkSurfaceDockPreference, surfaceId: string): WorkSurfaceDockPreference {
  const dismissedIds = [...new Set([...preference.dismissedIds, surfaceId])].slice(-64)
  const pinnedIds = preference.pinnedIds.filter(id => id !== surfaceId)
  const next = { open: preference.open, width: preference.width, dismissedIds, pinnedIds, knownIds: preference.knownIds, mode: preference.mode }
  return preference.activeId === undefined || preference.activeId === surfaceId ? next : { ...next, activeId: preference.activeId }
}

/** Constrain the internal divider while keeping a useful conversation column. */
export function workSurfaceDockWidth(requested: number, chatWidth = Number.POSITIVE_INFINITY): number {
  const maximumForChat = Number.isFinite(chatWidth)
    ? Math.max(WORK_SURFACE_DOCK_LIMITS.min, Math.floor(chatWidth - 360))
    : WORK_SURFACE_DOCK_LIMITS.max
  return Math.round(clampNumber(requested, WORK_SURFACE_DOCK_LIMITS.min, Math.min(WORK_SURFACE_DOCK_LIMITS.max, maximumForChat)))
}

export type ResizablePanel = 'side' | 'inspector'

export interface PanelWidths {
  readonly side: number
  readonly inspector: number
}

export const PANEL_WIDTH_STORAGE_KEY = 'xsla-panel-widths-v1'
// Below this width the inspector becomes a drawer so the current task keeps
// a genuinely useful working surface on compact laptops and portrait tablets.
export const PANEL_RESIZE_DESKTOP_BREAKPOINT = 1180
export const PANEL_WIDTH_LIMITS = {
  side: { min: 188, max: 420, standard: 232, wide: 256 },
  inspector: { min: 248, max: 480, standard: 292, wide: 320 },
  centerMin: 520,
} as const

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function sanitizedPanelWidth(value: unknown, fallback: number, panel: ResizablePanel): number {
  const limits = PANEL_WIDTH_LIMITS[panel]
  const candidate = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.round(clampNumber(candidate, limits.min, limits.max))
}

/** Match the two existing desktop density tiers before a user chooses custom widths. */
export function defaultPanelWidths(viewportWidth: number, viewportHeight: number): PanelWidths {
  const wide = viewportWidth >= 1920 && viewportHeight >= 1000
  return {
    side: wide ? PANEL_WIDTH_LIMITS.side.wide : PANEL_WIDTH_LIMITS.side.standard,
    inspector: wide ? PANEL_WIDTH_LIMITS.inspector.wide : PANEL_WIDTH_LIMITS.inspector.standard,
  }
}

/** Treat localStorage as untrusted input and retain safe defaults for missing fields. */
export function parsePanelWidths(raw: string | null | undefined, fallback: PanelWidths): PanelWidths {
  if (raw === null || raw === undefined || raw === '') return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
    const record = parsed as Readonly<Record<string, unknown>>
    return {
      side: sanitizedPanelWidth(record.side, fallback.side, 'side'),
      inspector: sanitizedPanelWidth(record.inspector, fallback.inspector, 'inspector'),
    }
  } catch {
    return fallback
  }
}

/** Keep both rails usable while guaranteeing room for the central task surface. */
export function fitPanelWidths(input: PanelWidths, viewportWidth: number): PanelWidths {
  let side = sanitizedPanelWidth(input.side, PANEL_WIDTH_LIMITS.side.standard, 'side')
  let inspector = sanitizedPanelWidth(input.inspector, PANEL_WIDTH_LIMITS.inspector.standard, 'inspector')
  if (!Number.isFinite(viewportWidth)) return { side, inspector }

  const minimumRailBudget = PANEL_WIDTH_LIMITS.side.min + PANEL_WIDTH_LIMITS.inspector.min
  const railBudget = Math.max(minimumRailBudget, Math.floor(viewportWidth - PANEL_WIDTH_LIMITS.centerMin))
  let overflow = side + inspector - railBudget
  if (overflow <= 0) return { side, inspector }

  // Reduce both custom rails proportionally instead of unexpectedly sacrificing one side.
  const sideRoom = side - PANEL_WIDTH_LIMITS.side.min
  const inspectorRoom = inspector - PANEL_WIDTH_LIMITS.inspector.min
  const totalRoom = sideRoom + inspectorRoom
  if (totalRoom > 0) {
    const sideReduction = Math.min(sideRoom, Math.round(overflow * sideRoom / totalRoom))
    side -= sideReduction
    overflow -= sideReduction
  }
  const inspectorReduction = Math.min(inspector - PANEL_WIDTH_LIMITS.inspector.min, overflow)
  inspector -= inspectorReduction
  overflow -= inspectorReduction
  if (overflow > 0) side -= Math.min(side - PANEL_WIDTH_LIMITS.side.min, overflow)
  return { side, inspector }
}

/** Clamp the actively dragged rail without moving the opposite boundary. */
export function resizePanelWidth(
  current: PanelWidths,
  panel: ResizablePanel,
  requestedWidth: number,
  viewportWidth: number,
): PanelWidths {
  const limits = PANEL_WIDTH_LIMITS[panel]
  const maximum = panelWidthMaximum(current, panel, viewportWidth)
  const width = sanitizedPanelWidth(requestedWidth, current[panel], panel)
  const constrained = Math.round(clampNumber(width, limits.min, maximum))
  return panel === 'side' ? { ...current, side: constrained } : { ...current, inspector: constrained }
}

/** Report the live constraint so pointer and assistive-technology limits agree. */
export function panelWidthMaximum(current: PanelWidths, panel: ResizablePanel, viewportWidth: number): number {
  const other = panel === 'side' ? current.inspector : current.side
  const limits = PANEL_WIDTH_LIMITS[panel]
  const viewportMaximum = Number.isFinite(viewportWidth)
    ? viewportWidth - other - PANEL_WIDTH_LIMITS.centerMin
    : limits.max
  return Math.max(limits.min, Math.min(limits.max, Math.floor(viewportMaximum)))
}

/** Translate separator keyboard input into the same width request used by pointer dragging. */
export function panelResizeKeyTarget(
  panel: ResizablePanel,
  currentWidth: number,
  key: string,
  shiftKey: boolean,
  defaultWidth: number,
): number | undefined {
  const limits = PANEL_WIDTH_LIMITS[panel]
  if (key === 'Home') return limits.min
  if (key === 'End') return limits.max
  if (key === 'Enter') return defaultWidth
  const step = shiftKey ? 32 : 8
  if (key === 'ArrowLeft') return currentWidth + (panel === 'inspector' ? step : -step)
  if (key === 'ArrowRight') return currentWidth + (panel === 'side' ? step : -step)
  return undefined
}

/** Parse the durable workspace-group preference without trusting browser storage. */
export function parseCollapsedWorkspaceIds(raw: string | null | undefined): readonly string[] {
  if (raw === null || raw === undefined || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const unique = new Set<string>()
    for (const value of parsed) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 512) continue
      unique.add(value)
      if (unique.size >= 200) break
    }
    return [...unique]
  } catch {
    return []
  }
}

/** Toggle one exact workspace id while preserving the remaining group state. */
export function toggleCollapsedWorkspaceId(current: readonly string[], workspaceId: string): readonly string[] {
  return current.includes(workspaceId)
    ? current.filter(value => value !== workspaceId)
    : [...current, workspaceId]
}

/** Keep narrow-screen rails mutually exclusive so neither traps the other. */
export function transitionOverlayState(
  current: OverlayState,
  action: 'toggle-side' | 'toggle-inspector' | 'close',
): OverlayState {
  if (action === 'close') return { side: false, inspector: false }
  if (action === 'toggle-side') return { side: !current.side, inspector: false }
  return { side: false, inspector: !current.inspector }
}

/** Abort the previous query and permanently close the coordinator on unmount. */
export function createSearchCoordinator(
  execute: (query: string, signal: AbortSignal) => Promise<Result<SearchResult>>,
): { search(query: string): Promise<Result<SearchResult>>; dispose(): void } {
  let controller: AbortController | undefined
  let disposed = false
  return {
    async search(query) {
      if (disposed) return { ok: false, error: { message: '搜索已停止' } }
      controller?.abort()
      controller = new AbortController()
      return execute(query, controller.signal)
    },
    dispose() {
      disposed = true
      controller?.abort()
      controller = undefined
    },
  }
}

interface ShellCommandHandlers {
  readonly running: boolean
  readonly hasSession: boolean
  readonly onCreate: () => void
  readonly onStop: () => void
  readonly onFork: () => void
  readonly onCompact: () => void
  readonly onPanel: (tab: 'status' | 'memory' | 'system') => void
  readonly onPlugins: () => void
}

interface ShellCommandAction {
  readonly id: SlashCommandId
  readonly command: `/${string}`
  readonly label: string
  readonly detail: string
  readonly disabled: boolean
  readonly run: () => void
}

/** One command source feeds both Ctrl/Command K and the inline slash menu. */
function shellCommandActions(handlers: ShellCommandHandlers): readonly ShellCommandAction[] {
  const runs: Readonly<Record<SlashCommandId, () => void>> = {
    new: handlers.onCreate,
    stop: handlers.onStop,
    fork: handlers.onFork,
    compact: handlers.onCompact,
    status: () => handlers.onPanel('status'),
    memory: () => handlers.onPanel('memory'),
    capabilities: () => handlers.onPanel('system'),
    plugins: handlers.onPlugins,
  }
  return SLASH_COMMAND_DEFINITIONS.map(definition => ({
    ...definition,
    disabled: (definition.id === 'stop' && !handlers.running) || ((definition.id === 'fork' || definition.id === 'compact') && !handlers.hasSession),
    run: runs[definition.id],
  }))
}

export function parseQuestionOptionLabel(label: string): { readonly label: string; readonly recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/iu
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

function emptyQuestionDraft(): QuestionDraft {
  return { selected: [], custom: '', skipped: false }
}

function createQuestionFlowState(request: UserQuestionRequest | undefined): QuestionFlowState {
  return {
    ...(request === undefined ? {} : { key: request.key }),
    index: 0,
    drafts: request?.questions.map(emptyQuestionDraft) ?? [],
    busy: undefined,
    error: '',
  }
}

function questionDraftAnswered(draft: QuestionDraft): boolean {
  return draft.selected.length > 0 || draft.custom.trim() !== ''
}

function questionDraftComplete(draft: QuestionDraft): boolean {
  return draft.skipped || questionDraftAnswered(draft)
}

function questionAnswerFromDrafts(
  questions: readonly UserQuestionItem[],
  drafts: readonly QuestionDraft[],
): UserQuestionAnswer | undefined {
  if (questions.length === 0 || drafts.length !== questions.length || drafts.some(draft => !questionDraftComplete(draft))) return undefined
  return {
    answers: questions.map((question, index) => {
      const draft = drafts[index] ?? emptyQuestionDraft()
      if (draft.skipped) return { id: question.id, selected: [] }
      const custom = draft.custom.trim()
      return {
        id: question.id,
        selected: custom !== '' && question.multiSelect !== true ? [] : [...draft.selected],
        ...(custom === '' ? {} : { custom }),
      }
    }),
  }
}

/**
 * Resolve DSH's seeded, Cordis-free Markdown renderer. The plain-text branch
 * is a fail-closed compatibility path for isolated unit harnesses or a
 * damaged platform seed: assistant HTML is never interpreted by the shell.
 */
function loadMarkdownTextPrimitive(react: ReactLike): ClientUiPrimitivesLike['MarkdownText'] {
  try {
    const candidate = (require('@deepseek-ai/dsh-client-ui-primitives') as { readonly MarkdownText?: unknown }).MarkdownText
    if (candidate !== undefined) return candidate as ClientUiPrimitivesLike['MarkdownText']
  } catch {
    // The real Web profile seeds this baseline module. Tests intentionally
    // exercise the fail-closed path unless they inject a probe primitive.
  }
  return ({ text }) => react.createElement('div', { 'data-safe-markdown-fallback': '' }, text)
}

/** Own a separate adapted root seat; the overlay Bundle disables the previous shell. */
export function apply(
  ctx: LegacyAdaptedClientContext,
  react: ReactLike = require('react') as ReactLike,
  injectedPrimitives?: ClientUiPrimitivesLike,
): () => void {
  const e = react.createElement
  const MarkdownText = injectedPrimitives?.MarkdownText ?? loadMarkdownTextPrimitive(react)
  const composerEnterPreference = createComposerEnterPreference()

  /** Xiaoshe owns the visible settings identity; DSH only supplies the slot ledger. */
  const SettingsBrandHeader = (): unknown => e('div', { className: 'xsla-settings-brand' },
    brandMark(e, 'xsla-settings-brand-mark', 'settings'),
    e('span', { className: 'xsla-settings-brand-copy' },
      e('b', null, '小蛇设置'),
      e('small', null, '设置中心 · 本机配置')))

  const SettingsTriggerContent = (props: { readonly wide?: boolean } = {}): unknown => e('span', { className: 'xsla-settings-trigger-content' },
    settingsGlyph(e),
    props.wide === false ? null : e('span', null, '设置'))

  /** The Xiaoshe composer owns this real, immediately applied preference row. */
  const ComposerEnterSettingsItem = (): unknown => {
    const behavior = react.useSyncExternalStore(composerEnterPreference.subscribe, composerEnterPreference.getSnapshot)
    const options: readonly { readonly value: ComposerEnterBehavior; readonly label: string; readonly detail: string }[] = [
      { value: 'enter-send', label: 'Enter 发送', detail: 'Shift+Enter 换行' },
      { value: 'ctrl-enter-send', label: 'Ctrl+Enter 发送', detail: 'Enter 直接换行' },
    ]
    return e('div', { className: 'xsla-enter-setting' },
      e('div', { className: 'xsla-enter-setting-copy' },
        e('b', null, '发送方式'),
        e('span', null, '立即控制当前小蛇输入框；偏好保存在本机。')),
      e('div', { className: 'xsla-enter-setting-options', role: 'radiogroup', 'aria-label': '发送方式' },
        ...options.map(option => e('button', {
          type: 'button', role: 'radio', key: option.value,
          'aria-checked': behavior === option.value,
          title: option.detail,
          onClick: () => composerEnterPreference.set(option.value),
        }, option.label))))
  }

  /**
   * The settings shell only owns the window. These three pages belong to this
   * native-shell adapter because it owns the visible permission control,
   * keyboard contract, browser bridge and Windows launch contract. They report
   * only live capabilities; unsupported defaults stay explicit instead of
   * becoming decorative toggles.
   */
  const SecuritySettingsSection = (props: { readonly close?: () => void } = {}): unknown => {
    const runtime = react.useSyncExternalStore(listener => ctx.agentRuntimeSession.subscribe(listener), () => ctx.agentRuntimeSession.getSnapshot())
    const permissions = react.useSyncExternalStore(listener => ctx.permissionPresets.subscribe(listener), () => ctx.permissionPresets.getSnapshot())
    const current = permissions.options.find(option => option.value === permissions.currentValue)
    const focusPermissionControl = (): void => {
      props.close?.()
      queueMicrotask(() => {
        const target = document.querySelector<HTMLElement>('.permission-select-wrap')
        target?.focus()
      })
    }
    return e('section', { className: 'xsla-settings-page', 'data-native-settings': 'security' },
      e('div', { className: 'xsla-settings-heading' },
        e('h2', null, '权限与安全'),
        e('p', null, '权限由运行时按会话强制执行；完全访问仍需二次确认。')),
      e('article', { className: 'xsla-settings-card' },
        e('div', { className: 'xsla-settings-card-head' },
          e('div', null, e('b', null, '当前会话权限'), e('small', null, runtime.currentSessionId === undefined ? '尚未建立会话' : '仅影响当前会话')),
          e('span', { className: 'xsla-settings-badge', 'data-status': permissions.status }, permissionPresetLabel(permissions.currentValue, current?.name) || '不可用')),
        e('p', null, current?.description ?? (permissionPresetDescription(permissions.currentValue ?? '') || '建立会话后可查看并调整权限。')),
        e('button', { className: 'xsla-settings-action', type: 'button', disabled: runtime.currentSessionId === undefined, onClick: focusPermissionControl }, '回到会话调整')),
      e('div', { className: 'xsla-settings-facts', role: 'list', 'aria-label': '权限档位' },
        ...permissions.options.map(option => e('div', { className: 'xsla-settings-fact', role: 'listitem', key: option.value },
          e('b', null, permissionPresetLabel(option.value, option.name)),
          e('span', null, permissionPresetDescription(option.value) || option.description || '由运行时定义')))),
      e('p', { className: 'xsla-settings-boundary' }, '当前版本不提供无效的跨会话默认权限开关；底层支持后再由权限插件贡献。'))
  }

  const ShortcutsSettingsSection = (): unknown => {
    const enterBehavior = react.useSyncExternalStore(composerEnterPreference.subscribe, composerEnterPreference.getSnapshot)
    const enterRows: readonly (readonly [string, string])[] = enterBehavior === 'ctrl-enter-send'
      ? [['Ctrl+Enter / Cmd+Enter', '发送消息'], ['Enter', '在消息中换行']]
      : [['Enter', '发送消息'], ['Shift+Enter', '在消息中换行']]
    const commandShortcut = platformCommandShortcut(typeof navigator === 'undefined' ? undefined : navigator.platform)
    const rows: readonly (readonly [string, string])[] = [
      [commandShortcut, '打开命令面板'],
      ['/', '在输入框中打开斜杠命令'],
      ...enterRows,
      ['Y / N', '出现行动审批时允许一次 / 拒绝'],
    ]
    return e('section', { className: 'xsla-settings-page', 'data-native-settings': 'shortcuts' },
      e('div', { className: 'xsla-settings-heading' },
        e('h2', null, '快捷键'),
        e('p', null, '只列出当前界面已经接通的快捷操作。')),
      e('div', { className: 'xsla-shortcut-list', role: 'list' },
        ...rows.map(([keys, detail]) => e('div', { className: 'xsla-shortcut-row', role: 'listitem', key: keys },
          e('kbd', null, keys), e('span', null, detail)))))
  }

  const AboutSettingsSection = (): unknown => {
    const health = react.useSyncExternalStore(listener => ctx.productHealth.subscribe(listener), () => ctx.productHealth.getSnapshot())
    const healthValue = 'value' in health ? health.value : undefined
    const desktopStatus = healthValue?.desktop
    const desktopError = healthSourceError(health, 'desktop')
    const bridge = record(desktopStatus?.bridge)
    const actions = record(desktopStatus?.actions)
    const waiting = health.status === 'idle' || health.status === 'loading'
    const unavailable = waiting ? '读取中…' : '提供方不可用'
    return e('section', { className: 'xsla-settings-page', 'data-native-settings': 'about' },
      e('div', { className: 'xsla-settings-heading' },
        e('h2', null, '高级与关于'),
        e('p', null, '来自桌面桥的实时版本与诊断信息。')),
      e('article', { className: 'xsla-settings-card xsla-about-card' },
        brandMark(e, 'xsla-about-mark', 'about'),
        e('div', { className: 'xsla-about-copy' },
          e('b', null, String(desktopStatus?.product ?? '小蛇')),
          e('span', null, `版本 ${String(desktopStatus?.version ?? unavailable)} · 小蛇 UI 适配版`))),
      e('div', { className: 'xsla-settings-facts', role: 'list', 'aria-label': '运行诊断' },
        e('div', { className: 'xsla-settings-fact', role: 'listitem' }, e('b', null, '桌面桥'), e('span', null, bridge === undefined ? unavailable : `${String(bridge.state)} · ${String(bridge.platform ?? '平台未报告')}`)),
        e('div', { className: 'xsla-settings-fact', role: 'listitem' }, e('b', null, '持久操作'), e('span', null, actions === undefined ? unavailable : actions.persistent === true ? '已启用' : '未启用')),
        e('div', { className: 'xsla-settings-fact', role: 'listitem' }, e('b', null, '运行日志'), e('span', null, bridge === undefined ? unavailable : platformLogLocation(bridge.platform)))),
      desktopError === undefined ? null : e('p', { className: 'xsla-settings-error', role: 'alert' }, `桌面诊断提供方不可用：${desktopError}`),
      e('a', { className: 'xsla-settings-action', href: '/xiaoshe/desktop/status', target: '_blank', rel: 'noreferrer' }, '查看诊断 JSON'),
      e('p', { className: 'xsla-settings-boundary' }, '配置文件由设置标题栏的“打开配置文件”入口管理；日志由本机启动器持续写入。'))
  }

  const Shell = (slotProps: ShellSlotProps = {}): unknown => {
    const runtime = react.useSyncExternalStore(listener => ctx.agentRuntimeSession.subscribe(listener), () => ctx.agentRuntimeSession.getSnapshot())
    const catalog = react.useSyncExternalStore(listener => ctx.sessionCatalog.subscribe(listener), () => ctx.sessionCatalog.getSnapshot())
    const timeline = react.useSyncExternalStore(listener => ctx.taskTimeline.subscribe(listener), () => ctx.taskTimeline.getSnapshot())
    const workSurfaces = react.useSyncExternalStore(listener => ctx.workSurfaceRegistry.subscribe(listener), () => ctx.workSurfaceRegistry.getSnapshot())
    const context = react.useSyncExternalStore(listener => ctx.contextGovernance.subscribe(listener), () => ctx.contextGovernance.getSnapshot())
    const models = react.useSyncExternalStore(listener => ctx.modelCatalog.subscribe(listener), () => ctx.modelCatalog.getSnapshot())
    const runCenter = react.useSyncExternalStore(listener => ctx.runCenter.subscribe(listener), () => ctx.runCenter.getSnapshot())
    const providerReadiness = react.useSyncExternalStore(listener => ctx.providerReadiness.subscribe(listener), () => ctx.providerReadiness.getSnapshot())
    const workspaces = react.useSyncExternalStore(listener => ctx.workspaceCatalog.subscribe(listener), () => ctx.workspaceCatalog.getSnapshot())
    const approvals = react.useSyncExternalStore(listener => ctx.userApproval.subscribe(listener), () => ctx.userApproval.getSnapshot())
    const questionInteractions = react.useSyncExternalStore(listener => ctx.userQuestionInteraction.subscribe(listener), () => ctx.userQuestionInteraction.getSnapshot())
    const permissions = react.useSyncExternalStore(listener => ctx.permissionPresets.subscribe(listener), () => ctx.permissionPresets.getSnapshot())
    const memoryState = react.useSyncExternalStore(listener => ctx.memoryLifecycle.subscribe(listener), () => ctx.memoryLifecycle.getSnapshot())
    const productHealth = react.useSyncExternalStore(listener => ctx.productHealth.subscribe(listener), () => ctx.productHealth.getSnapshot())
    const pluginState = react.useSyncExternalStore(listener => ctx.pluginGovernance.subscribe(listener), () => ctx.pluginGovernance.getSnapshot())
    const themeSnapshot = react.useSyncExternalStore(listener => ctx.on('theme/change', listener), () => ctx.theme.getTheme())
    const enterBehavior = react.useSyncExternalStore(composerEnterPreference.subscribe, composerEnterPreference.getSnapshot)
    const currentId = runtime.currentSessionId
    const initialComposerDraft = readComposerDraft(browserSessionDraftStorage(), currentId)
    const initialDraftImages = hydrateDraftImages(initialComposerDraft.images)

    const [sideCollapsed, setSideCollapsed] = react.useState(false)
    const [inspCollapsed, setInspCollapsed] = react.useState(false)
    const [panelWidths, setPanelWidths] = react.useState<PanelWidths>(readPanelWidthPreference())
    const [resizingPanel, setResizingPanel] = react.useState<ResizablePanel | undefined>(undefined)
    const panelWidthsTouchedRef = react.useRef(false)
    const panelResizeCleanupRef = react.useRef<(() => void) | undefined>(undefined)
    const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = react.useState<readonly string[]>(readWorkspaceGroupCollapsePreference())
    const theme = themeSnapshot.active.colorScheme === 'dark' ? 'ink-jade' : 'light'
    const [rightTab, setRightTab] = react.useState<'status' | 'memory' | 'system'>('status')
    const [overlayState, setOverlayState] = react.useState<OverlayState>({ side: false, inspector: false })
    const sideOverlayOpen = overlayState.side
    const inspOverlayOpen = overlayState.inspector
    const [pluginManagerOpen, setPluginManagerOpen] = react.useState(false)
    const [commandOpen, setCommandOpen] = react.useState(false)
    const [choiceMenu, setChoiceMenu] = react.useState<'permission' | 'effort' | undefined>(undefined)
    const [slashQuery, setSlashQuery] = react.useState<string | undefined>(undefined)
    const [slashSelection, setSlashSelection] = react.useState(0)
    const [permissionChallenge, setPermissionChallenge] = react.useState<string | undefined>(undefined)
    const [memoryScope, setMemoryScope] = react.useState<'global' | 'project'>('global')
    const [memoryDraft, setMemoryDraft] = react.useState('')
    const [memoryEditing, setMemoryEditing] = react.useState<MemoryEntry | undefined>(undefined)
    const [memoryBusy, setMemoryBusy] = react.useState('')
    const [memoryError, setMemoryError] = react.useState('')
    const [memoryEditorExpanded, setMemoryEditorExpanded] = react.useState(false)
    const [sideMenu, setSideMenu] = react.useState<SideEntityTarget | undefined>(undefined)
    const [sideEdit, setSideEdit] = react.useState<SideEditTarget | undefined>(undefined)
    const [sideRemoval, setSideRemoval] = react.useState<SideRemovalTarget | undefined>(undefined)
    const [sideMutation, setSideMutation] = react.useState<string | undefined>(undefined)
    const [pluginWorkflow, setPluginWorkflow] = react.useState<PluginWorkflow>({ step: 'idle' })
    const [error, setError] = react.useState('')
    const [questionFlow, setQuestionFlow] = react.useState<QuestionFlowState>(createQuestionFlowState(questionInteractions.requests[0]))
    const [submitting, setSubmitting] = react.useState(false)
    const [stopping, setStopping] = react.useState(false)
    const [draftImages, setDraftImages] = react.useState<readonly DraftImage[]>(initialDraftImages)
    const draftImagesRef = react.useRef<readonly DraftImage[]>(initialDraftImages)
    const draftStorageWarningRef = react.useRef(false)
    const composerTextareaRef = react.useRef<HTMLTextAreaElement | null>(null)
    const streamRef = react.useRef<HTMLDivElement | null>(null)
    const submittingRef = react.useRef(false)
    const stoppingRef = react.useRef(false)
    const [showJumpToLatest, setShowJumpToLatest] = react.useState(false)
    const [activeUserTurnOrdinal, setActiveUserTurnOrdinal] = react.useState<number | undefined>(undefined)
    const [unreadLatestCount, setUnreadLatestCount] = react.useState(0)
    const timelineCountRef = react.useRef(timeline.items.length)
    const [userTurnPreview, setUserTurnPreview] = react.useState<UserTurnPreviewState | undefined>(undefined)
    const [plugins, setPlugins] = react.useState<readonly { moduleName: string; fiberPhase: string | null }[]>([])
    const [query, setQuery] = react.useState('')
    const [searchResults, setSearchResults] = react.useState<readonly { sessionId: string; snippet: string }[]>([])
    const [sessionDisplayLimit, setSessionDisplayLimit] = react.useState(SESSION_CATALOG_PAGE_SIZE)
    const [searchCoordinator] = react.useState(createSearchCoordinator((value, signal) => ctx.sessionCatalog.search(value, signal)))
    const initialSurfacePreference = reconcileWorkSurfaceDockPreference(
      readWorkSurfaceDockPreference(currentId),
      workSurfaces.sessionId === currentId ? workSurfaces.items : [],
    )
    const [surfaceDockState, setSurfaceDockState] = react.useState<WorkSurfaceDockState>({
      ...(currentId === undefined ? {} : { sessionId: currentId }),
      preference: initialSurfacePreference,
    })
    const [surfaceReload, setSurfaceReload] = react.useState(0)
    const [resizingSurface, setResizingSurface] = react.useState(false)
    const surfaceResizeCleanupRef = react.useRef<(() => void) | undefined>(undefined)

    const current = currentId === undefined ? undefined : runtime.sessions[currentId]
    const projectedQuestionRequest = questionInteractions.requests[0]
    const imageLimits = current?.imageInputLimits ?? DEFAULT_DRAFT_IMAGE_LIMITS
    const currentCatalog = currentId === undefined ? undefined : catalog.sessions[currentId]
    const currentWorkspace = workspaces.items.find(item => item.sessionIds.includes(currentId ?? '') || item.path === currentCatalog?.cwd)
    const userTurnNavigation = buildUserTurnNavigation(timeline.items)
    const currentSurfaceItems = workSurfaces.sessionId === currentId ? workSurfaces.items : []
    const surfacePreference = surfaceDockState.sessionId === currentId
      ? surfaceDockState.preference
      : DEFAULT_WORK_SURFACE_DOCK
    const surfaceItems = [...currentSurfaceItems]
      .filter(item => !surfacePreference.dismissedIds.includes(item.id))
      .sort((left, right) => {
        const leftPinned = surfacePreference.pinnedIds.indexOf(left.id)
        const rightPinned = surfacePreference.pinnedIds.indexOf(right.id)
        if (leftPinned >= 0 || rightPinned >= 0) {
          if (leftPinned < 0) return 1
          if (rightPinned < 0) return -1
          return leftPinned - rightPinned
        }
        return left.updatedAt - right.updatedAt || left.seq - right.seq
      })
    const activeSurface = surfaceItems.find(item => item.id === surfacePreference.activeId) ?? surfaceItems.at(-1)
    const surfaceDockOpen = surfacePreference.open && activeSurface !== undefined

    react.useEffect(() => {
      if (typeof document === 'undefined') return
      const observerFactory = typeof MutationObserver === 'undefined' ? undefined : (callback: () => void) => new MutationObserver(callback)
      return mountBrowserBrand(document, observerFactory)
    }, [])

    react.useEffect(() => {
      writeWorkspaceGroupCollapsePreference(collapsedWorkspaceIds)
    }, [collapsedWorkspaceIds])

    react.useEffect(() => {
      if (questionFlow.key === projectedQuestionRequest?.key) return
      setQuestionFlow(createQuestionFlowState(projectedQuestionRequest))
    }, [projectedQuestionRequest?.key, questionFlow.key])

    react.useEffect(() => {
      if (!panelWidthsTouchedRef.current) return
      writePanelWidthPreference(panelWidths)
    }, [panelWidths.side, panelWidths.inspector])

    react.useEffect(() => {
      setSurfaceDockState(previous => {
        const base = previous.sessionId === currentId
          ? previous.preference
          : readWorkSurfaceDockPreference(currentId)
        return {
          ...(currentId === undefined ? {} : { sessionId: currentId }),
          preference: reconcileWorkSurfaceDockPreference(base, currentSurfaceItems),
        }
      })
    }, [currentId, workSurfaces.sessionId, workSurfaces.items])

    react.useEffect(() => {
      if (currentId === undefined || surfaceDockState.sessionId !== currentId) return
      writeWorkSurfaceDockPreference(currentId, surfaceDockState.preference)
    }, [currentId, surfaceDockState])

    react.useEffect(() => {
      if (typeof window === 'undefined') return
      const fitToViewport = (): void => {
        // Below this breakpoint the rails are drawers with CSS-owned widths;
        // preserve the user's desktop split instead of silently shrinking it.
        if (window.innerWidth <= PANEL_RESIZE_DESKTOP_BREAKPOINT) return
        setPanelWidths(current => fitPanelWidths(current, window.innerWidth))
      }
      window.addEventListener('resize', fitToViewport)
      return () => { window.removeEventListener('resize', fitToViewport) }
    }, [])

    react.useEffect(() => () => {
      panelResizeCleanupRef.current?.()
      surfaceResizeCleanupRef.current?.()
    }, [])

    react.useEffect(() => {
      if (typeof document === 'undefined') return
      const resetHorizontalPosition = (): void => {
        const list = document.querySelector('#xsla-side .sess-list')
        if (list instanceof HTMLElement) list.scrollLeft = 0
      }
      // Focusing an inline rename field can make Chromium horizontally scroll
      // an otherwise clipped vertical list. Reset once immediately and once
      // after layout/focus settles so project and session labels stay visible.
      resetHorizontalPosition()
      if (typeof window === 'undefined') return
      const frame = window.requestAnimationFrame(resetHorizontalPosition)
      return () => { window.cancelAnimationFrame(frame) }
    }, [sideEdit?.kind, sideEdit?.id, sideMenu?.kind, sideMenu?.id])

    react.useEffect(() => {
      if (currentWorkspace === undefined) return
      // Opening a session in another workspace must reveal that session once;
      // the user can still collapse the active group again afterwards.
      setCollapsedWorkspaceIds(value => value.includes(currentWorkspace.workspaceId)
        ? value.filter(id => id !== currentWorkspace.workspaceId)
        : value)
    }, [currentWorkspace?.workspaceId])

    react.useEffect(() => {
      let active = true
      void ctx.pluginGovernance.listHostPlugins().then(result => {
        if (active && result.ok) setPlugins(result.value?.entries ?? [])
      }).catch(() => {})
      void ctx.pluginGovernance.refreshTransactions().catch(() => {})
      return () => { active = false; searchCoordinator.dispose() }
    }, [searchCoordinator])

    react.useEffect(() => {
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      const refresh = (): void => {
        void ctx.productHealth.refresh().catch(() => {})
      }
      const onVisibility = (): void => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') refresh() }
      refresh()
      const timer = setInterval(refresh, 15_000)
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
      return () => {
        clearInterval(timer)
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      }
    }, [])

    react.useEffect(() => {
      void ctx.memoryLifecycle.refresh({
        scope: currentCatalog?.cwd === undefined ? 'global' : 'all',
        ...(currentCatalog?.cwd === undefined ? {} : { project: currentCatalog.cwd }),
        include_inactive: true,
      }).catch(() => {})
    }, [currentCatalog?.cwd])

    react.useEffect(() => {
      if (currentId !== undefined) {
        void ctx.modelCatalog.refresh(currentId).catch(() => {})
        void ctx.runCenter.refresh().catch(() => {})
        void ctx.providerReadiness.refresh(currentId).catch(() => {})
      }
    }, [currentId])

    react.useEffect(() => {
      const stream = streamRef.current
      if (stream === null) return

      const refresh = (): void => {
        setShowJumpToLatest(shouldOfferJumpToLatest(stream))
        const offsets = userTurnNavigation.map(item => stream.querySelector<HTMLElement>(`[data-event-index="${item.eventIndex}"]`)?.offsetTop ?? Number.NaN)
        setActiveUserTurnOrdinal(activeUserTurnOrdinalAtScroll(offsets, stream.scrollTop, stream.clientHeight))
      }
      refresh()

      /* A scroll event alone is insufficient: streamed text can make the
       * conversation taller while the pointer remains still. Observe the
       * scroll content so the shortcut follows the real viewport distance. */
      if (typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(refresh)
      for (const child of Array.from(stream.children)) observer.observe(child)
      const mutations = typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            for (const child of Array.from(stream.children)) observer.observe(child)
            refresh()
          })
        : undefined
      mutations?.observe(stream, { childList: true, subtree: true, characterData: true })
      return () => {
        mutations?.disconnect()
        observer.disconnect()
      }
    }, [currentId, timeline.items.length])

    react.useEffect(() => setUserTurnPreview(undefined), [currentId])

    react.useEffect(() => {
      const previous = timelineCountRef.current
      const next = timeline.items.length
      if (showJumpToLatest && next > previous) setUnreadLatestCount(value => value + next - previous)
      if (!showJumpToLatest) setUnreadLatestCount(0)
      timelineCountRef.current = next
    }, [timeline.items.length, showJumpToLatest])

    const persistDraft = (text: string, images: readonly DraftImage[], sessionId = currentId): void => {
      const outcome = writeComposerDraft(browserSessionDraftStorage(), sessionId, {
        text,
        images: persistedDraftImages(images),
      })
      if (!outcome.ok && !draftStorageWarningRef.current) {
        draftStorageWarningRef.current = true
        setError('当前浏览器不允许保存草稿；离开或刷新页面前请先发送。')
      }
    }

    const replaceDraftImages = (next: readonly DraftImage[], persist = true): void => {
      draftImagesRef.current = next
      setDraftImages(next)
      if (persist) persistDraft(composerTextareaRef.current?.value ?? '', next)
    }

    const clearDraftImages = (): void => {
      replaceDraftImages([], false)
    }

    const clearComposerText = (): void => {
      const textarea = composerTextareaRef.current
      if (textarea === null) return
      textarea.value = ''
      resizeComposerTextarea(textarea)
      persistDraft('', draftImagesRef.current)
      textarea.focus()
    }

    const restoreComposerText = (value: string): void => {
      const textarea = composerTextareaRef.current
      if (textarea === null) return
      textarea.value = value
      resizeComposerTextarea(textarea)
      setSlashQuery(parseSlashCommandQuery(value))
      persistDraft(value, draftImagesRef.current)
      textarea.focus()
    }

    react.useEffect(() => {
      const stored = readComposerDraft(browserSessionDraftStorage(), currentId)
      replaceDraftImages(hydrateDraftImages(stored.images), false)
      const textarea = composerTextareaRef.current
      if (textarea !== null) {
        textarea.value = stored.text
        resizeComposerTextarea(textarea)
        setSlashQuery(parseSlashCommandQuery(stored.text))
        setSlashSelection(0)
      }
    }, [currentId])

    const removeDraftImage = (id: string): void => {
      replaceDraftImages(draftImagesRef.current.filter(image => image.id !== id))
    }

    const addDraftFiles = async (source: FileList | readonly File[]): Promise<void> => {
      const files = Array.from(source)
      const candidates = files.map(file => {
        const mediaType = imageMediaTypeOf(file)
        return {
          name: file.name === '' ? '未命名图片' : file.name,
          bytes: file.size,
          ...(mediaType === undefined ? {} : { mediaType }),
        }
      })
      const rejection = draftImageBatchError(
        draftImagesRef.current.map(image => ({ bytes: image.size })),
        candidates,
        imageLimits,
      )
      if (rejection !== undefined) { setError(rejection); return }
      try {
        const added = await Promise.all(files.map(async (file, index): Promise<DraftImage | undefined> => {
          const mediaType = candidates[index]?.mediaType
          if (mediaType === undefined) return undefined
          const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
          return {
            id: `draft-image-${Date.now()}-${++draftImageSequence}`,
            name: file.name,
            size: file.size,
            mediaType,
            data,
            previewUrl: `data:${mediaType};base64,${data}`,
          }
        }))
        setError('')
        replaceDraftImages([...draftImagesRef.current, ...added.filter((image): image is DraftImage => image !== undefined)])
      } catch (errorValue: unknown) {
        setError(`无法读取图片草稿：${errorValue instanceof Error ? errorValue.message : String(errorValue)}`)
      }
    }

    const encodeDraftImages = (images: readonly DraftImage[]): readonly RuntimeImageInput[] => images.map(image => ({
      mediaType: image.mediaType,
      data: image.data,
      ...(image.name === '' ? {} : { name: image.name }),
    }))

    const createSession = async (): Promise<string | undefined> => {
      setError('')
      setSideMenu(undefined)
      const result = await ctx.sessionCatalog.createLooseSession()
      if (!result.ok || result.value === undefined) { setError(result.error?.message ?? '无法新建会话'); return undefined }
      const opened = ctx.sessionCatalog.openSession(result.value.sessionId)
      if (!opened.ok) { setError(opened.error?.message ?? '新会话无法打开'); return undefined }
      return result.value.sessionId
    }

    const submit = async (event: { preventDefault(): void; currentTarget: HTMLFormElement }): Promise<void> => {
      event.preventDefault()
      if (submittingRef.current || questionInteractions.requests[0] !== undefined || approvals.approvals[0] !== undefined) return
      setError('')
      const form = event.currentTarget
      const content = String(new FormData(form).get('content') ?? '').trim()
      const images = draftImagesRef.current
      if (content === '' && images.length === 0) return
      const commandQuery = parseSlashCommandQuery(content)
      if (commandQuery !== undefined) {
        setSlashQuery(commandQuery)
        setSlashSelection(0)
        return
      }
      submittingRef.current = true
      setSubmitting(true)
      try {
        const encodedImages = encodeDraftImages(images)
        const sessionId = currentId ?? await createSession()
        if (sessionId === undefined) return
        if (currentId === undefined) persistDraft(content, images, sessionId)
        const result = await ctx.agentRuntimeSession.sendTurn({
          sessionId, content,
          ...(encodedImages.length === 0 ? {} : { images: encodedImages }),
          // A new idle turn enters the normal queue. While the model is
          // running, the composer becomes an explicit steering channel.
          mode: current?.state === 'running' ? 'steer' : 'queue',
        })
        if (!result.ok) { setError(result.error?.message ?? '任务未发送'); return }
        form.reset()
        const textarea = form.elements.namedItem('content')
        if (textarea instanceof HTMLTextAreaElement) resizeComposerTextarea(textarea)
        setSlashQuery(undefined)
        setSlashSelection(0)
        clearDraftImages()
        clearComposerDraft(browserSessionDraftStorage(), currentId)
        if (sessionId !== currentId) clearComposerDraft(browserSessionDraftStorage(), sessionId)
      } catch (errorValue: unknown) {
        setError(`图片编码失败，草稿已保留：${errorValue instanceof Error ? errorValue.message : String(errorValue)}`)
      } finally {
        submittingRef.current = false
        setSubmitting(false)
      }
    }

    const search = async (value: string): Promise<void> => {
      const normalized = value.trim()
      if (normalized === '') { setSearchResults([]); return }
      const result = await searchCoordinator.search(normalized)
      if (!result.ok) {
        if (result.error?.message !== '搜索已停止') setError(result.error?.message ?? '搜索失败')
        return
      }
      setError('')
      setSearchResults(result.value?.items ?? [])
    }

    const stopRun = async (): Promise<void> => {
      if (currentId === undefined || stoppingRef.current) return
      stoppingRef.current = true
      setStopping(true)
      setError('')
      try {
        const result = await ctx.agentRuntimeSession.stopRun({ sessionId: currentId })
        if (!result.ok) setError(result.error?.message ?? '无法停止当前任务')
      } catch (errorValue: unknown) {
        setError(`无法停止当前任务：${errorValue instanceof Error ? errorValue.message : String(errorValue)}`)
      } finally {
        stoppingRef.current = false
        setStopping(false)
      }
    }

    const forkCurrent = async (): Promise<void> => {
      if (currentId === undefined) return
      setError('')
      const result = await ctx.agentRuntimeSession.forkSession({ sessionId: currentId })
      if (!result.ok || result.value === undefined) { setError(result.error?.message ?? '无法分支当前会话'); return }
      const opened = ctx.sessionCatalog.openSession(result.value.sessionId)
      if (!opened.ok) setError(opened.error?.message ?? '分支已创建，但无法打开')
    }

    const compactCurrent = async (): Promise<void> => {
      if (currentId === undefined) { setError('请先打开一条会话，再压缩上下文'); return }
      setError('')
      try {
        const result = await ctx.sessionCommand.execute({ sessionId: currentId, line: '/compact' })
        if (!result.ok) { setError(result.error?.message ?? '上下文压缩未能启动'); return }
        if (result.value?.matched !== true) setError('当前运行时没有提供上下文压缩命令')
      } catch (errorValue: unknown) {
        setError(`上下文压缩未能启动：${errorValue instanceof Error ? errorValue.message : String(errorValue)}`)
      }
    }

    const addProject = async (): Promise<void> => {
      setError('')
      setSideMenu(undefined)
      const adopted = await ctx.workspaceCatalog.addFromNativePicker()
      if (!adopted.ok || adopted.value === undefined) { setError(adopted.error?.message ?? '无法添加工作区'); return }
      if (adopted.value.cancelled || adopted.value.workspace === undefined) return
      const opened = await ctx.workspaceCatalog.createAndOpenSession(adopted.value.workspace.workspaceId)
      if (!opened.ok) setError(opened.error?.message ?? '工作区已添加，但无法打开会话')
    }

    const openWorkspaceSession = async (workspaceId: string): Promise<void> => {
      setError('')
      setSideMenu(undefined)
      const result = await ctx.workspaceCatalog.createAndOpenSession(workspaceId)
      if (!result.ok) setError(result.error?.message ?? '无法在该工作区新建会话')
      else setOverlayState(value => transitionOverlayState(value, 'close'))
    }

    const beginSideEdit = (target: SideEntityTarget): void => {
      setError('')
      setSideMenu(undefined)
      setSideEdit({ ...target, value: target.title })
    }

    const commitSideEdit = async (): Promise<void> => {
      if (sideEdit === undefined) return
      let title: string
      try { title = normalizeSideEntityTitle(sideEdit.value) }
      catch (value) { setError(value instanceof Error ? value.message : String(value)); return }
      const mutationKey = `${sideEdit.kind}:${sideEdit.id}:rename`
      setSideMutation(mutationKey)
      setError('')
      const result = sideEdit.kind === 'workspace'
        ? await ctx.workspaceCatalog.renameWorkspace(sideEdit.id, title)
        : await ctx.sessionCatalog.renameSession(sideEdit.id, title)
      setSideMutation(undefined)
      if (!result.ok) { setError(result.error?.message ?? '改名失败'); return }
      setSideEdit(undefined)
    }

    const confirmSideRemoval = async (): Promise<void> => {
      if (sideRemoval === undefined) return
      const mutationKey = `${sideRemoval.kind}:${sideRemoval.id}:remove`
      setSideMutation(mutationKey)
      setError('')
      const result = sideRemoval.kind === 'workspace'
        ? await ctx.workspaceCatalog.removeWorkspace(sideRemoval.id)
        : await ctx.sessionCatalog.archiveSession(sideRemoval.id)
      setSideMutation(undefined)
      if (!result.ok) { setError(result.error?.message ?? '移除失败'); return }
      setSideRemoval(undefined)
      setSideMenu(undefined)
      setSideEdit(current => current?.kind === sideRemoval.kind && current.id === sideRemoval.id ? undefined : current)
    }

    const selectModel = async (selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): Promise<void> => {
      if (currentId === undefined) { setError('请先新建会话，再选择模型'); return }
      setError('')
      const result = await ctx.modelCatalog.select({ sessionId: currentId, ...selection })
      if (!result.ok) setError(result.error?.message ?? '模型切换失败')
    }

    const updateRunQueue = async (itemId: string, kind: 'remove' | 'steer'): Promise<void> => {
      if (currentId === undefined) return
      setError('')
      const result = await ctx.runCenter.updateQueue({ sessionId: currentId, itemId, action: { kind } })
      if (!result.ok) setError(result.error?.message ?? '队列操作失败')
    }

    const openRunSubagent = (childSessionId: string): void => {
      if (currentId === undefined) return
      const result = ctx.runCenter.openSubagent({ parentSessionId: currentId, childSessionId })
      if (!result.ok) setError(result.error?.message ?? '无法打开子任务')
    }

    const interruptRunSubagent = async (childSessionId: string): Promise<void> => {
      if (currentId === undefined) return
      setError('')
      const result = await ctx.runCenter.interruptSubagent({ parentSessionId: currentId, childSessionId })
      if (!result.ok) setError(result.error?.message ?? '无法停止子任务')
    }

    const probeProviderRoute = async (provider: string, model: string): Promise<void> => {
      setError('')
      const result = await ctx.providerReadiness.probe({ provider, model })
      if (!result.ok) setError(result.error?.message ?? '模型服务探测失败')
    }

    const selectPermission = async (value: string): Promise<void> => {
      setError('')
      const result = await ctx.permissionPresets.select(value)
      if (!result.ok) setError(result.error?.message ?? '权限切换失败')
    }

    const requestPermission = (value: string): void => {
      if (value === permissions.currentValue) return
      if (value === 'danger-full-access') {
        setPermissionChallenge(value)
        return
      }
      void selectPermission(value)
    }

    const memoryQuery = (): { readonly scope: 'global' | 'all'; readonly project?: string; readonly include_inactive: true } => ({
      scope: currentCatalog?.cwd === undefined ? 'global' : 'all',
      ...(currentCatalog?.cwd === undefined ? {} : { project: currentCatalog.cwd }),
      include_inactive: true,
    })

    const refreshMemory = async (): Promise<void> => {
      await ctx.memoryLifecycle.refresh(memoryQuery())
    }

    const beginMemoryEdit = (entry: MemoryEntry): void => {
      setMemoryEditing(entry)
      setMemoryScope(entry.scope)
      setMemoryDraft(entry.text)
      setMemoryError('')
    }

    const cancelMemoryEdit = (): void => {
      setMemoryEditing(undefined)
      setMemoryDraft('')
      setMemoryError('')
    }

    const submitMemory = async (event: { preventDefault(): void }): Promise<void> => {
      event.preventDefault()
      const text = memoryDraft.trim()
      if (text === '') { setMemoryError('请输入要记住的内容。'); return }
      const snapshot = memoryState.memory
      if (snapshot === undefined) { setMemoryError('记忆服务尚未准备好，请稍后重试。'); return }
      const effectiveScope = memoryEditing?.scope ?? (memoryScope === 'project' && currentCatalog?.cwd === undefined ? 'global' : memoryScope)
      const project = effectiveScope === 'project' ? memoryEditing?.project ?? currentCatalog?.cwd : undefined
      if (effectiveScope === 'project' && project === undefined) { setMemoryError('请先选择一个工作区，再写入当前项目记忆。'); return }
      setMemoryBusy('save')
      setMemoryError('')
      try {
        await ctx.memoryLifecycle.remember({
          scope: effectiveScope,
          ...(project === undefined ? {} : { project }),
          text,
          ...(memoryEditing === undefined ? {} : { replaces_id: memoryEditing.id }),
        }, snapshot.revision)
        setMemoryDraft('')
        setMemoryEditing(undefined)
      } catch (errorValue: unknown) {
        if (isMemoryRevisionConflict(errorValue)) {
          await refreshMemory().catch(() => {})
          setMemoryError('记忆刚刚在别处发生变化，已刷新，请重新确认后保存。')
        } else {
          setMemoryError(errorValue instanceof Error ? errorValue.message : String(errorValue))
        }
      } finally {
        setMemoryBusy('')
      }
    }

    const changeMemoryState = async (entry: MemoryEntry, state: 'active' | 'forgotten'): Promise<void> => {
      const snapshot = memoryState.memory
      if (snapshot === undefined) { setMemoryError('记忆服务尚未准备好，请稍后重试。'); return }
      setMemoryBusy(entry.id)
      setMemoryError('')
      try {
        await ctx.memoryLifecycle.setState(entry.id, state, snapshot.revision)
        if (memoryEditing?.id === entry.id) cancelMemoryEdit()
      } catch (errorValue: unknown) {
        if (isMemoryRevisionConflict(errorValue)) {
          await refreshMemory().catch(() => {})
          setMemoryError('记忆刚刚在别处发生变化，已刷新。')
        } else {
          setMemoryError(errorValue instanceof Error ? errorValue.message : String(errorValue))
        }
      } finally {
        setMemoryBusy('')
      }
    }

    const answerApproval = async (key: string, outcome: 'allowed-once' | 'rejected'): Promise<void> => {
      setError('')
      const result = await ctx.userApproval.answer(key, outcome)
      if (!result.ok) setError(result.error?.message ?? '审批响应失败')
    }

    const updateQuestionDraft = (index: number, update: (draft: QuestionDraft) => QuestionDraft): void => {
      setQuestionFlow(currentState => ({
        ...currentState,
        error: '',
        drafts: currentState.drafts.map((draft, draftIndex) => draftIndex === index ? update(draft) : draft),
      }))
    }

    const submitQuestionDrafts = async (request: UserQuestionRequest, drafts: readonly QuestionDraft[]): Promise<void> => {
      const firstIncomplete = drafts.findIndex(draft => !questionDraftComplete(draft))
      const answer = questionAnswerFromDrafts(request.questions, drafts)
      if (answer === undefined) {
        setQuestionFlow(currentState => ({
          ...currentState,
          index: firstIncomplete < 0 ? 0 : firstIncomplete,
          error: '请回答或跳过每一个问题后再提交。',
        }))
        return
      }
      setQuestionFlow(currentState => ({ ...currentState, busy: 'answer', error: '' }))
      const result = await ctx.userQuestionInteraction.answer(request.key, answer)
      if (!result.ok) {
        setQuestionFlow(currentState => ({
          ...currentState,
          busy: undefined,
          error: result.error?.message ?? '回答发送失败，请重试。',
        }))
      }
    }

    const cancelQuestionRequest = async (request: UserQuestionRequest): Promise<void> => {
      setQuestionFlow(currentState => ({ ...currentState, busy: 'cancel', error: '' }))
      const result = await ctx.userQuestionInteraction.cancel(request.key)
      if (!result.ok) {
        setQuestionFlow(currentState => ({
          ...currentState,
          busy: undefined,
          error: result.error?.message ?? '取消失败，请重试。',
        }))
      }
    }

    const chooseQuestionOption = (question: UserQuestionItem, index: number, label: string): void => {
      updateQuestionDraft(index, draft => {
        if (question.multiSelect === true) {
          const selected = draft.selected.includes(label)
            ? draft.selected.filter(item => item !== label)
            : [...draft.selected, label]
          return { ...draft, selected, skipped: false }
        }
        return { selected: [label], custom: '', skipped: false }
      })
    }

    const changeQuestionCustom = (question: UserQuestionItem, index: number, custom: string): void => {
      updateQuestionDraft(index, draft => ({
        ...draft,
        selected: question.multiSelect === true ? draft.selected : [],
        custom,
        skipped: false,
      }))
    }

    const skipQuestion = (request: UserQuestionRequest, index: number): void => {
      const nextDrafts = questionFlow.drafts.map((draft, draftIndex) => draftIndex === index ? emptyQuestionDraft() : draft)
        .map((draft, draftIndex) => draftIndex === index ? { ...draft, skipped: true } : draft)
      if (index < request.questions.length - 1) {
        setQuestionFlow(currentState => ({ ...currentState, drafts: nextDrafts, index: index + 1, error: '' }))
        return
      }
      setQuestionFlow(currentState => ({ ...currentState, drafts: nextDrafts, error: '' }))
      void submitQuestionDrafts(request, nextDrafts)
    }

    const advanceQuestion = (request: UserQuestionRequest, index: number): void => {
      const draft = questionFlow.drafts[index]
      if (draft === undefined || !questionDraftAnswered(draft)) {
        setQuestionFlow(currentState => ({ ...currentState, error: '请选择一个选项，填写回答，或跳过这一题。' }))
        return
      }
      if (index < request.questions.length - 1) {
        setQuestionFlow(currentState => ({ ...currentState, index: index + 1, error: '' }))
        return
      }
      void submitQuestionDrafts(request, questionFlow.drafts)
    }

    const preparePluginIntent = async (intent: PluginUiIntent, candidate?: PublicCandidate): Promise<void> => {
      const input: Record<string, unknown> = intent.action === 'remove'
        ? { action: 'remove', profile: intent.profile, packageName: intent.packageName }
        : { action: intent.action, profile: intent.profile, candidateId: candidate?.id }
      const result = await ctx.pluginGovernance.prepareChange(input)
      if (!result.ok || result.value?.challenge === undefined) {
        setPluginWorkflow({ step: 'error', intent, ...(candidate === undefined ? {} : { candidate }), message: result.error?.message ?? '无法准备插件变更' })
        return
      }
      setPluginWorkflow({ step: 'prepared', intent, ...(candidate === undefined ? {} : { candidate }), challenge: result.value.challenge })
    }

    const beginPluginWorkflow = async (event: { preventDefault(): void; currentTarget: HTMLFormElement }): Promise<void> => {
      event.preventDefault()
      const form = new FormData(event.currentTarget)
      let intent: PluginUiIntent
      try {
        intent = validatePluginIntent({
          action: String(form.get('action') ?? ''), profile: MANAGED_PLUGIN_PROFILE,
          sourceKind: String(form.get('sourceKind') ?? ''), source: String(form.get('source') ?? ''),
          signaturePath: String(form.get('signaturePath') ?? ''),
        })
      } catch (validationError) {
        setPluginWorkflow({ step: 'error', message: validationError instanceof Error ? validationError.message : String(validationError) })
        return
      }
      setPluginWorkflow({ step: 'idle', intent, message: '正在核对本机扩展事实…' })
      if (intent.action === 'remove') { await preparePluginIntent(intent); return }
      const result = await ctx.pluginGovernance.auditCandidate(intent.source)
      if (!result.ok || result.value?.candidate === undefined) {
        setPluginWorkflow({ step: 'error', intent, message: result.error?.message ?? '候选审计失败' })
        return
      }
      setPluginWorkflow({ step: 'audited', intent, candidate: result.value.candidate })
    }

    const confirmPluginChange = async (): Promise<void> => {
      const challenge = pluginWorkflow.challenge
      if (challenge === undefined) return
      const result = await ctx.pluginGovernance.confirmChange({ challengeId: challenge.id, token: challenge.token })
      if (!result.ok || result.value?.transaction === undefined) {
        setPluginWorkflow({ ...pluginWorkflow, step: 'error', message: result.error?.message ?? '插件变更失败' })
        return
      }
      setPluginWorkflow({ ...pluginWorkflow, step: 'completed', transaction: result.value.transaction })
      await ctx.pluginGovernance.refreshTransactions().catch(() => {})
    }

    const resetPluginWorkflow = (): void => setPluginWorkflow({ step: 'idle' })
    const closePluginManager = (): void => { setPluginManagerOpen(false); resetPluginWorkflow() }
    const closeOverlays = (): void => {
      setOverlayState(value => transitionOverlayState(value, 'close'))
      if (pluginManagerOpen) closePluginManager()
      if (commandOpen) setCommandOpen(false)
      if (choiceMenu !== undefined) setChoiceMenu(undefined)
      if (permissionChallenge !== undefined) setPermissionChallenge(undefined)
      if (sideMenu !== undefined) setSideMenu(undefined)
      if (sideEdit !== undefined) setSideEdit(undefined)
      if (sideRemoval !== undefined) setSideRemoval(undefined)
      if (memoryEditorExpanded) setMemoryEditorExpanded(false)
    }

    react.useEffect(() => {
      if (typeof document === 'undefined') return
      const root = document.querySelector<HTMLElement>('[data-xiaoshe-legacy-adapted]')
      if (root === null) return
      const dialogs = Array.from(root.querySelectorAll<HTMLElement>('.modal-layer [role="dialog"]'))
      const dialog = dialogs[dialogs.length - 1]
      if (dialog === undefined) return

      const closeDialog = commandOpen
        ? () => setCommandOpen(false)
        : sideRemoval !== undefined
          ? () => { if (sideMutation === undefined) setSideRemoval(undefined) }
          : permissionChallenge !== undefined
            ? () => setPermissionChallenge(undefined)
            : memoryEditorExpanded
              ? () => setMemoryEditorExpanded(false)
              : pluginManagerOpen
                ? closePluginManager
                : undefined
      if (closeDialog === undefined) return
      dialog.tabIndex = -1
      return mountNativeDialogAccessibility(
        document,
        dialog,
        root.querySelector<HTMLElement>('.app') ?? undefined,
        closeDialog,
      )
    }, [commandOpen, memoryEditorExpanded, permissionChallenge, pluginManagerOpen, sideRemoval?.id, sideMutation])

    const updatePanelWidth = (panel: ResizablePanel, requestedWidth: number): void => {
      panelWidthsTouchedRef.current = true
      const viewportWidth = typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth
      setPanelWidths(current => resizePanelWidth(current, panel, requestedWidth, viewportWidth))
    }

    const resetPanelWidth = (panel: ResizablePanel): void => {
      const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight
      updatePanelWidth(panel, defaultPanelWidths(viewportWidth, viewportHeight)[panel])
    }

    const handlePanelResizeKey = (panel: ResizablePanel, event: {
      readonly key: string
      readonly shiftKey?: boolean
      preventDefault?(): void
    }): void => {
      const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
      const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight
      const target = panelResizeKeyTarget(
        panel,
        panelWidths[panel],
        event.key,
        event.shiftKey === true,
        defaultPanelWidths(viewportWidth, viewportHeight)[panel],
      )
      if (target === undefined) return
      event.preventDefault?.()
      updatePanelWidth(panel, target)
    }

    const beginPanelResize = (panel: ResizablePanel, event: {
      readonly button?: number
      readonly isPrimary?: boolean
      readonly clientX: number
      readonly pointerId?: number
      readonly currentTarget?: { setPointerCapture?(pointerId: number): void }
      preventDefault?(): void
    }): void => {
      if (typeof window === 'undefined' || event.button !== undefined && event.button !== 0 || event.isPrimary === false) return
      event.preventDefault?.()
      if (event.pointerId !== undefined) {
        try { event.currentTarget?.setPointerCapture?.(event.pointerId) } catch { /* global listeners still own the drag */ }
      }
      panelResizeCleanupRef.current?.()
      const startX = event.clientX
      const startWidth = panelWidths[panel]
      const move = (moveEvent: PointerEvent): void => {
        const delta = moveEvent.clientX - startX
        updatePanelWidth(panel, startWidth + (panel === 'side' ? delta : -delta))
      }
      const detach = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', finish)
      }
      const finish = (): void => {
        detach()
        if (panelResizeCleanupRef.current === detach) panelResizeCleanupRef.current = undefined
        setResizingPanel(undefined)
      }
      panelResizeCleanupRef.current = detach
      setResizingPanel(panel)
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', finish)
    }

    const updateSurfacePreference = (update: (current: WorkSurfaceDockPreference) => WorkSurfaceDockPreference): void => {
      if (currentId === undefined) return
      setSurfaceDockState(previous => {
        const base = previous.sessionId === currentId
          ? previous.preference
          : readWorkSurfaceDockPreference(currentId)
        return { sessionId: currentId, preference: update(base) }
      })
    }

    const openSurfaceDock = (): void => {
      if (currentSurfaceItems.length === 0) return
      updateSurfacePreference(currentPreference => {
        let dismissedIds = currentPreference.dismissedIds
        let visible = currentSurfaceItems.filter(item => !dismissedIds.includes(item.id))
        if (visible.length === 0) {
          dismissedIds = []
          visible = [...currentSurfaceItems]
        }
        const activeId = visible.at(-1)?.id
        return { ...currentPreference, open: activeId !== undefined, ...(activeId === undefined ? {} : { activeId }), dismissedIds }
      })
    }

    const closeSurfaceDock = (): void => updateSurfacePreference(value => ({ ...value, open: false }))

    const selectSurface = (surfaceId: string): void => updateSurfacePreference(value => ({
      ...value,
      open: true,
      activeId: surfaceId,
      dismissedIds: value.dismissedIds.filter(id => id !== surfaceId),
    }))

    const closeSurface = (surfaceId: string): void => updateSurfacePreference(value => reconcileWorkSurfaceDockPreference(
      dismissWorkSurface(value, surfaceId),
      currentSurfaceItems,
    ))

    const toggleSurfacePin = (surfaceId: string): void => updateSurfacePreference(value => ({
      ...value,
      pinnedIds: value.pinnedIds.includes(surfaceId)
        ? value.pinnedIds.filter(id => id !== surfaceId)
        : [...value.pinnedIds.filter(id => id !== surfaceId), surfaceId].slice(-24),
    }))

    const updateSurfaceWidth = (requestedWidth: number): void => {
      const chat = typeof document === 'undefined' ? undefined : document.querySelector<HTMLElement>('.xsla-shell .chat')
      const chatWidth = chat?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY
      updateSurfacePreference(value => ({ ...value, width: workSurfaceDockWidth(requestedWidth, chatWidth) }))
    }

    const handleSurfaceResizeKey = (event: { readonly key: string; readonly shiftKey?: boolean; preventDefault?(): void }): void => {
      let requested: number | undefined
      if (event.key === 'Home') requested = WORK_SURFACE_DOCK_LIMITS.min
      if (event.key === 'End') requested = WORK_SURFACE_DOCK_LIMITS.max
      if (event.key === 'Enter') requested = WORK_SURFACE_DOCK_LIMITS.standard
      const step = event.shiftKey === true ? 32 : 8
      if (event.key === 'ArrowLeft') requested = surfacePreference.width + step
      if (event.key === 'ArrowRight') requested = surfacePreference.width - step
      if (requested === undefined) return
      event.preventDefault?.()
      updateSurfaceWidth(requested)
    }

    const beginSurfaceResize = (event: {
      readonly button?: number
      readonly isPrimary?: boolean
      readonly clientX: number
      readonly pointerId?: number
      readonly currentTarget?: { setPointerCapture?(pointerId: number): void }
      preventDefault?(): void
    }): void => {
      if (typeof window === 'undefined' || event.button !== undefined && event.button !== 0 || event.isPrimary === false) return
      event.preventDefault?.()
      if (event.pointerId !== undefined) {
        try { event.currentTarget?.setPointerCapture?.(event.pointerId) } catch { /* window listeners retain the drag */ }
      }
      surfaceResizeCleanupRef.current?.()
      const startX = event.clientX
      const startWidth = surfacePreference.width
      const move = (moveEvent: PointerEvent): void => updateSurfaceWidth(startWidth + startX - moveEvent.clientX)
      const detach = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', finish)
      }
      const finish = (): void => {
        detach()
        if (surfaceResizeCleanupRef.current === detach) surfaceResizeCleanupRef.current = undefined
        setResizingSurface(false)
      }
      surfaceResizeCleanupRef.current = detach
      setResizingSurface(true)
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', finish)
    }

    const copySurfaceSource = async (surface: WorkSurface): Promise<void> => {
      if (!surface.capabilities.copySource || surface.source === undefined || typeof navigator === 'undefined' || navigator.clipboard === undefined) {
        setError('当前环境无法复制该来源')
        return
      }
      try { await navigator.clipboard.writeText(surface.source); setError('') }
      catch (value: unknown) { setError(`复制失败：${value instanceof Error ? value.message : String(value)}`) }
    }

    const openSurfaceExternally = (surface: WorkSurface): void => {
      const url = surface.view.kind === 'web' ? surface.view.url : undefined
      if (!surface.capabilities.externalOpen || url === undefined || typeof window === 'undefined') return
      window.open(url, '_blank', 'noopener,noreferrer')
    }

    const sessions = Object.values(catalog.sessions).sort((left, right) => right.updatedAt - left.updatedAt)
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const localMatches = normalizedQuery === '' ? sessions : sessions.filter(row => `${row.title ?? ''}\n${row.cwd ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
    const matchingSessions = searchResults.length === 0 ? localMatches : searchResults.flatMap(hit => {
      const row = catalog.sessions[hit.sessionId]
      return row === undefined ? [] : [{ ...row, searchSnippet: hit.snippet }]
    })
    const sessionWindow = windowSessionCatalog(matchingSessions, sessionDisplayLimit, currentId)
    const visibleSessions = sessionWindow.items
    const status = current?.state ?? 'idle'
    const receipt = current?.completionReceipt?.outcome
    const contextRow = currentId === undefined ? undefined : context.sessions[currentId]
    const contextView = contextPresentation(contextRow)
    const modelView = modelPresentation(models)
    const memoryView = memoryPresentation(memoryState)
    const productHealthValue = 'value' in productHealth ? productHealth.value : undefined
    const heartbeatView = heartbeatPresentation(productHealthValue?.heartbeat)
    const transactionView = pluginTransactionPresentation(pluginState)
    const questionRequest = projectedQuestionRequest
    const activeQuestionFlow = questionFlow.key === questionRequest?.key
      ? questionFlow
      : createQuestionFlowState(questionRequest)
    // Questions own the interaction seat before action approvals, matching the
    // runtime's native precedence while keeping both queues observable.
    const approval = questionRequest === undefined ? approvals.approvals[0] : undefined
    const interactionBlocked = questionRequest !== undefined || approval !== undefined
    const layoutViewportWidth = typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth
    const mainClass = ['main', sideCollapsed ? 'side-collapsed' : '', inspCollapsed ? 'insp-collapsed' : ''].filter(Boolean).join(' ')
    const mainStyle = {
      '--xsla-side-width': `${panelWidths.side}px`,
      '--xsla-insp-width': `${panelWidths.inspector}px`,
    }
    const commands = shellCommandActions({
      running: status === 'running', hasSession: currentId !== undefined,
      onCreate: () => { void createSession() },
      onStop: () => { void stopRun() },
      onFork: () => { void forkCurrent() },
      onCompact: () => { void compactCurrent() },
      onPanel: tab => { setRightTab(tab); setInspCollapsed(false) },
      onPlugins: () => { setRightTab('system'); setPluginManagerOpen(true) },
    })
    const matchingSlashIds = slashQuery === undefined ? [] : filterSlashCommandIds(slashQuery)
    const slashCommands = matchingSlashIds.flatMap(id => {
      const command = commands.find(item => item.id === id)
      return command === undefined ? [] : [command]
    })
    const selectableSlashCommands = slashCommands.filter(command => !command.disabled)
    const selectedSlashCommand = selectableSlashCommands.length === 0
      ? undefined
      : selectableSlashCommands[Math.min(slashSelection, selectableSlashCommands.length - 1)]
    const runSlashCommand = (command: ShellCommandAction): void => {
      if (command.disabled) return
      setSlashQuery(undefined)
      setSlashSelection(0)
      setError('')
      clearComposerText()
      command.run()
    }
    const interactionCards = questionRequest === undefined
      ? approvals.approvals.map(item => renderApproval(e, item, answerApproval))
      : [renderQuestionCard(e, {
        request: questionRequest,
        flow: activeQuestionFlow,
        onOption: (question, index, label) => chooseQuestionOption(question, index, label),
        onCustom: (question, index, value) => changeQuestionCustom(question, index, value),
        onPrevious: index => setQuestionFlow(currentState => ({ ...currentState, index: Math.max(0, index - 1), error: '' })),
        onNext: index => advanceQuestion(questionRequest, index),
        onSkip: index => skipQuestion(questionRequest, index),
        onSubmit: () => { void submitQuestionDrafts(questionRequest, activeQuestionFlow.drafts) },
        onCancel: () => { void cancelQuestionRequest(questionRequest) },
      })]

    return e('div', {
      className: 'xsla-shell', 'data-xiaoshe-legacy-adapted': '', 'data-theme': theme,
      'data-runtime-state': status, 'data-side-overlay': sideOverlayOpen, 'data-insp-overlay': inspOverlayOpen,
      onPointerDownCapture: (event: { target?: EventTarget | null }) => {
        if (!(event.target instanceof Element)) return
        if (sideMenu !== undefined && event.target.closest('[data-side-menu-root]') === null) setSideMenu(undefined)
        if (choiceMenu !== undefined && event.target.closest('[data-choice-popover-root]') === null) setChoiceMenu(undefined)
        if (slashQuery !== undefined && event.target.closest('.composer') === null) setSlashQuery(undefined)
      },
      onKeyDown: (event: { key: string; metaKey?: boolean; ctrlKey?: boolean; target?: EventTarget | null; preventDefault?(): void }) => {
        if (event.key.toLocaleLowerCase() === 'k' && (event.metaKey === true || event.ctrlKey === true)) {
          event.preventDefault?.()
          setSlashQuery(undefined)
          setCommandOpen(value => !value)
          return
        }
        if (event.key === 'Escape') {
          const target = event.target as ({ closest?(selector: string): unknown } | null | undefined)
          // An owned dialog closes itself and restores focus first. Closing the
          // mobile rail as well would immediately unmount that restored target.
          if (target?.closest?.('[role="dialog"]') == null) closeOverlays()
          return
        }
        if (questionRequest === undefined && approval !== undefined && !isTextEntryTarget(event.target)) {
          if (event.key.toLocaleLowerCase() === 'y') { event.preventDefault?.(); void answerApproval(approval.key, 'allowed-once') }
          if (event.key.toLocaleLowerCase() === 'n') { event.preventDefault?.(); void answerApproval(approval.key, 'rejected') }
        }
      },
    },
    e('style', null, HERITAGE_CSS),
    e('div', { className: 'app' },
      e('div', {
        className: mainClass,
        style: mainStyle,
        'data-resizing-panel': resizingPanel,
      },
        renderSide(e, {
          collapsed: sideCollapsed, overlayOpen: sideOverlayOpen, query, sessions: visibleSessions,
          sessionTotal: sessionWindow.total, hasMoreSessions: sessionWindow.hasMore,
          workspaces: workspaces.items, archivedSessionIds: workspaces.archivedSessionIds, collapsedWorkspaceIds, currentId, status, onCreate: () => { void createSession() },
          onProject: () => { void addProject() }, onWorkspace: workspaceId => { void openWorkspaceSession(workspaceId) },
          onToggleWorkspace: workspaceId => setCollapsedWorkspaceIds(value => toggleCollapsedWorkspaceId(value, workspaceId)),
          sideMenu, sideEdit, sideMutation,
          onMenu: target => { setSideEdit(undefined); setSideMenu(current => current?.kind === target.kind && current.id === target.id ? undefined : target) },
          onBeginEdit: beginSideEdit,
          onEditValue: value => setSideEdit(current => current === undefined ? current : { ...current, value }),
          onCommitEdit: () => { void commitSideEdit() }, onCancelEdit: () => setSideEdit(undefined),
          onRemove: target => { setSideMenu(undefined); setSideRemoval(target) },
          settings: slotProps.renderSlot?.('sidebar.settings', { wide: !sideCollapsed }),
          onQuery: value => { setQuery(value); setSessionDisplayLimit(SESSION_CATALOG_PAGE_SIZE); if (value.trim() === '') setSearchResults([]) },
          onSearch: value => { void search(value) },
          onShowMore: () => setSessionDisplayLimit(value => value + SESSION_CATALOG_PAGE_SIZE),
          onOpen: sessionId => {
            setSideMenu(undefined)
            const result = ctx.sessionCatalog.openSession(sessionId)
            if (!result.ok) setError(result.error?.message ?? '会话无法打开')
            else setOverlayState(value => transitionOverlayState(value, 'close'))
          },
          onCollapse: () => {
            if (sideOverlayOpen) {
              setSideCollapsed(false)
              setOverlayState(value => transitionOverlayState(value, 'close'))
            } else {
              setSideCollapsed(value => !value)
            }
          },
        }),
        renderPanelResizer(e, {
          panel: 'side', width: panelWidths.side,
          minimum: PANEL_WIDTH_LIMITS.side.min,
          maximum: panelWidthMaximum(panelWidths, 'side', layoutViewportWidth),
          onPointerDown: event => beginPanelResize('side', event),
          onKeyDown: event => handlePanelResizeKey('side', event),
          onReset: () => resetPanelWidth('side'),
        }),
        e('section', {
          className: ['chat', surfaceDockOpen ? 'surface-open' : ''].filter(Boolean).join(' '),
          style: { '--xsla-surface-width': `${surfacePreference.width}px` },
          'aria-label': '对话区',
          'data-surface-resizing': resizingSurface,
        },
          e('header', { className: 'chat-head' },
            e('h1', {
              className: `chat-title chat-title-frosted${currentCatalog !== undefined && isGenericSessionTitle(currentCatalog.title) ? ' chat-title-generic' : ''}`,
              title: currentCatalog?.title,
            }, currentCatalog === undefined ? '新会话' : sessionDisplayTitle(currentCatalog.title, currentCatalog.sessionId, currentCatalog.updatedAt)),
            e('div', { className: 'right' },
              e('span', { className: `live head-runtime ${status === 'running' ? 'busy' : ''}`, role: 'status' }, e('i', null), receipt === undefined ? statusLabel(status) : `${statusLabel(status)} · ${receiptLabel(receipt)}`),
              e('span', { className: 'head-governance' }, `待回答 ${questionInteractions.requests.length} · 待审批 ${approvals.approvals.length} · 压缩 ${contextRow?.compactions?.length ?? 0}`),
              e('span', { className: 'head-context' }, contextView.short)),
            e('button', { className: 'icbtn task-mobile-toggle', type: 'button', 'aria-controls': 'xsla-side', 'aria-expanded': sideOverlayOpen, onClick: () => { setSideCollapsed(false); setOverlayState(value => transitionOverlayState(value, 'toggle-side')) } }, '任务'),
            e('button', { className: 'icbtn inspector-mobile-toggle', type: 'button', 'aria-controls': 'xsla-insp', 'aria-expanded': inspOverlayOpen, onClick: () => { setInspCollapsed(false); setOverlayState(value => transitionOverlayState(value, 'toggle-inspector')) } }, icon(e, 'brain'), e('span', null, '状态面板')),
            currentSurfaceItems.length === 0 ? null : e('button', {
              className: `surface-launcher ${surfaceDockOpen ? 'on' : ''}`,
              type: 'button', title: surfaceDockOpen ? '工作现场已打开' : '打开工作现场',
              'aria-controls': 'xsla-work-surface-dock', 'aria-expanded': surfaceDockOpen,
              onClick: surfaceDockOpen ? closeSurfaceDock : openSurfaceDock,
            }, icon(e, 'surface'), e('span', null, '现场'), e('b', null, String(currentSurfaceItems.length))),
            e('button', {
              className: 'theme-toggle', type: 'button',
              'aria-label': theme === 'light' ? '切换为暗色主题' : '切换为亮色主题',
              title: '切换主题（云白薄荷/暗夜影院）',
              onClick: () => ctx.theme.setTheme(theme === 'light' ? 'dark' : 'light'),
            }, theme === 'light' ? icon(e, 'moon') : icon(e, 'sun'))),
          e('div', { className: 'conversation-body' },
            timeline.items.length === 0 ? null : renderConversationGhost(e),
            e('div', { className: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
              receipt === undefined ? statusLabel(status) : `${statusLabel(status)}，${receiptLabel(receipt)}`),
            e('div', {
              className: 'stream', ref: streamRef,
              'data-empty': timeline.items.length === 0,
              role: 'log', 'aria-label': '对话记录', 'aria-live': 'off',
              onScroll: (event: { currentTarget: HTMLDivElement }) => {
                const offerJump = shouldOfferJumpToLatest(event.currentTarget)
                setShowJumpToLatest(offerJump)
                if (!offerJump) setUnreadLatestCount(0)
                const offsets = typeof event.currentTarget.querySelector === 'function'
                  ? userTurnNavigation.map(item => event.currentTarget.querySelector<HTMLElement>(`[data-event-index="${item.eventIndex}"]`)?.offsetTop ?? Number.NaN)
                  : []
                setActiveUserTurnOrdinal(activeUserTurnOrdinalAtScroll(offsets, event.currentTarget.scrollTop, event.currentTarget.clientHeight))
              },
            },
            timeline.hasEarlier === true ? e('button', {
              className: 'timeline-load-earlier', type: 'button',
              'aria-label': `加载更早记录，当前显示 ${timeline.items.length} 条，共 ${timeline.total ?? timeline.items.length} 条`,
              onClick: () => {
                const stream = streamRef.current
                const previousHeight = stream?.scrollHeight ?? 0
                const previousTop = stream?.scrollTop ?? 0
                ctx.taskTimeline.loadEarlier()
                if (stream !== null && typeof window !== 'undefined') {
                  window.requestAnimationFrame(() => {
                    stream.scrollTop = previousTop + Math.max(0, stream.scrollHeight - previousHeight)
                  })
                }
              },
            }, `加载更早记录 · ${timeline.items.length}/${timeline.total ?? timeline.items.length}`) : null,
            timeline.items.length === 0 ? renderEmptyStage(e) : e('div', { className: 'events' }, ...timeline.items.map((item, eventIndex) => {
              const view = timelineEventPresentation(item, current?.completionReceipt?.sourceSeq)
              const failure = item.isError === true || item.kind === 'error'
              const previousUser = failure
                ? timeline.items.slice(0, eventIndex).reverse().find(candidate => candidate.kind === 'user' && candidate.text.trim() !== '')
                : undefined
              return e('article', {
                id: `xsla-event-${eventIndex}`, className: `event event-${item.kind}${view.historical ? ' historical' : ''}`, key: item.key,
                'data-event-index': String(eventIndex), 'data-kind': item.kind, 'data-error': failure,
              },
              e('span', { className: 'event-label' }, view.label),
              e('div', { className: 'event-body' },
                item.kind === 'assistant'
                  ? e('div', { className: 'event-markdown' }, e(MarkdownText, { text: item.text, streaming: item.key === 'partial' }))
                  : item.text,
                item.reasoning === undefined || item.reasoning.trim() === '' ? null : e('details', { className: 'event-reasoning' },
                  e('summary', null, '查看思考过程'), e('p', null, item.reasoning)),
                !failure ? null : e('div', { className: 'event-recovery' },
                  view.detail === '' ? null : e('details', null, e('summary', null, '技术详情'), e('code', null, view.detail)),
                  previousUser === undefined ? null : e('button', {
                    className: 'event-restore-button', type: 'button', onClick: () => restoreComposerText(previousUser.text),
                  }, '放回输入框'))))
            })),
            ...interactionCards),
            userTurnNavigation.length === 0 ? null : e('nav', { className: 'turn-index', 'aria-label': '我的消息导航' },
              e('div', { className: 'turn-index-scroll', onScroll: () => setUserTurnPreview(undefined) },
                ...userTurnNavigation.map(item => e('button', {
                  className: 'turn-index-marker', type: 'button', key: item.key,
                  'data-turn-index': item.ordinal,
                  'data-current': activeUserTurnOrdinal === item.ordinal ? 'true' : undefined,
                  'aria-current': activeUserTurnOrdinal === item.ordinal ? 'location' : undefined,
                  'aria-controls': `xsla-event-${item.eventIndex}`,
                  'aria-describedby': userTurnPreview?.key === item.key ? 'xsla-turn-index-preview' : undefined,
                  'aria-label': `跳转到第 ${item.ordinal} 条我的消息：${item.preview}`,
                  onMouseEnter: (event: { currentTarget: HTMLElement }) => {
                    const marker = event.currentTarget.getBoundingClientRect()
                    const body = event.currentTarget.closest('.conversation-body')?.getBoundingClientRect()
                    setUserTurnPreview({ key: item.key, ordinal: item.ordinal, preview: item.preview, top: marker.top - (body?.top ?? marker.top) + marker.height / 2 })
                  },
                  onMouseLeave: (event: { currentTarget: HTMLElement }) => {
                    if (typeof document === 'undefined' || document.activeElement !== event.currentTarget) setUserTurnPreview(undefined)
                  },
                  onFocus: (event: { currentTarget: HTMLElement }) => {
                    const marker = event.currentTarget.getBoundingClientRect()
                    const body = event.currentTarget.closest('.conversation-body')?.getBoundingClientRect()
                    setUserTurnPreview({ key: item.key, ordinal: item.ordinal, preview: item.preview, top: marker.top - (body?.top ?? marker.top) + marker.height / 2 })
                  },
                  onBlur: () => setUserTurnPreview(undefined),
                  onClick: () => {
                    setUserTurnPreview(undefined)
                    const stream = streamRef.current
                    const target = stream?.querySelector<HTMLElement>(`[data-event-index="${item.eventIndex}"]`)
                    if (stream !== null && target !== null && target !== undefined) {
                      setActiveUserTurnOrdinal(item.ordinal)
                      stream.scrollTo({
                        top: Math.max(0, target.offsetTop - stream.clientHeight * 0.34),
                        behavior: conversationScrollBehavior(),
                      })
                    }
                  },
                })))),
            userTurnPreview === undefined || !userTurnNavigation.some(item => item.key === userTurnPreview.key) ? null : e('aside', {
              id: 'xsla-turn-index-preview', className: 'turn-index-preview', role: 'tooltip',
              style: { '--xsla-turn-preview-top': `${userTurnPreview.top}px` },
            },
            e('b', null, `我发送的第 ${userTurnPreview.ordinal} 条`),
            e('span', null, userTurnPreview.preview)),
            showJumpToLatest ? e('button', {
              className: 'jump-to-latest', type: 'button', title: unreadLatestCount > 0 ? `回到最新消息（${unreadLatestCount} 条新内容）` : '回到最新消息', 'aria-label': unreadLatestCount > 0 ? `回到最新消息，${unreadLatestCount} 条新内容` : '回到最新消息',
              onClick: () => {
                const stream = streamRef.current
                if (stream === null) return
                stream.scrollTo({ top: stream.scrollHeight, behavior: conversationScrollBehavior() })
                setShowJumpToLatest(false)
                setUnreadLatestCount(0)
              },
            }, icon(e, 'down'), unreadLatestCount > 0 ? e('span', { className: 'jump-count', 'aria-hidden': 'true' }, unreadLatestCount > 9 ? '9+' : String(unreadLatestCount)) : null) : null),
          e('footer', { className: 'composer' },
            error === '' ? null : e('p', { className: 'composer-error', role: 'alert' }, error),
            e('form', {
              className: 'cbox', 'data-has-images': draftImages.length > 0,
              onSubmit: (event: unknown) => { void submit(event as { preventDefault(): void; currentTarget: HTMLFormElement }) },
            },
            slashQuery === undefined ? null : renderSlashCommandMenu(e, {
              commands: slashCommands,
              query: slashQuery,
              selectedId: selectedSlashCommand?.id,
              onSelect: runSlashCommand,
            }),
            e('div', {
              className: 'composer-content',
              onDragOver: (event: { preventDefault(): void }) => event.preventDefault(),
              onDrop: (event: { preventDefault(): void; dataTransfer: DataTransfer }) => {
                event.preventDefault()
                if (!submitting && !stopping && !interactionBlocked) void addDraftFiles(event.dataTransfer.files)
              },
            },
            draftImages.length === 0 ? null : e('div', { className: 'attachment-strip', role: 'list', 'aria-label': '待发送图片' },
              ...draftImages.map(image => e('figure', { className: 'attachment-item', role: 'listitem', key: image.id, title: `${image.name} · ${formatBytes(image.size)}` },
                e('img', { src: image.previewUrl, alt: image.name === '' ? '待发送图片' : image.name }),
                e('button', { type: 'button', className: 'attachment-remove', 'aria-label': `移除 ${image.name || '图片'}`, onClick: () => removeDraftImage(image.id) }, '×'),
                e('figcaption', null, image.name || '图片')))),
            e('textarea', {
              ref: composerTextareaRef,
              name: 'content', rows: 1, disabled: interactionBlocked || submitting || stopping,
              placeholder: questionRequest !== undefined ? '请先回答上方问题' : approval !== undefined ? '请先处理当前审批' : stopping ? '正在停止…' : submitting ? '正在发送…' : current?.state === 'running' ? '补充信息，调整当前方向…' : '交代小蛇做事…',
              'aria-label': '输入消息',
              'aria-autocomplete': 'list',
              'aria-haspopup': 'listbox',
              'aria-expanded': slashQuery !== undefined,
              'aria-controls': slashQuery === undefined ? undefined : 'xsla-slash-command-list',
              'aria-activedescendant': selectedSlashCommand === undefined ? undefined : `xsla-slash-command-${selectedSlashCommand.id}`,
              onInput: (event: { currentTarget: HTMLTextAreaElement }) => {
                resizeComposerTextarea(event.currentTarget)
                setSlashQuery(parseSlashCommandQuery(event.currentTarget.value))
                setSlashSelection(0)
                persistDraft(event.currentTarget.value, draftImagesRef.current)
              },
              onPaste: (event: { preventDefault(): void; clipboardData: DataTransfer }) => {
                const files = Array.from(event.clipboardData.files).filter(file => imageMediaTypeOf(file) !== undefined)
                if (files.length === 0 || submitting || stopping || interactionBlocked) return
                void addDraftFiles(files)
                if (event.clipboardData.getData('text/plain') === '') event.preventDefault()
              },
              onKeyDown: (event: {
                key: string
                shiftKey: boolean
                ctrlKey?: boolean
                metaKey?: boolean
                nativeEvent?: { readonly isComposing?: boolean }
                preventDefault(): void
                stopPropagation(): void
                currentTarget: HTMLTextAreaElement
              }) => {
                if (slashQuery !== undefined && event.nativeEvent?.isComposing !== true) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    const delta = event.key === 'ArrowDown' ? 1 : -1
                    if (selectableSlashCommands.length > 0) setSlashSelection(value => (value + delta + selectableSlashCommands.length) % selectableSlashCommands.length)
                    return
                  }
                  if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                    event.preventDefault()
                    if (selectedSlashCommand !== undefined) runSlashCommand(selectedSlashCommand)
                    else setError(`没有匹配“/${slashQuery}”的命令`)
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    setSlashQuery(undefined)
                    return
                  }
                }
                const action = composerKeyAction({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  ctrlKey: event.ctrlKey === true,
                  metaKey: event.metaKey === true,
                  isComposing: event.nativeEvent?.isComposing === true,
                  behavior: enterBehavior,
                })
                if (action === 'submit') {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              },
            })),
            e('div', { className: 'composer-toolbar', 'data-running': status === 'running' ? 'true' : 'false' },
              e('div', { className: 'composer-tools-left' },
                e('label', { className: 'attachment-control', title: `添加图片（最多 ${imageLimits.maxImagesPerMessage} 张）` },
                  e('span', { 'aria-hidden': 'true' }, '＋'),
                  e('span', { className: 'visually-hidden' }, '添加图片'),
                  e('input', {
                    className: 'attachment-input', type: 'file', multiple: true,
                    accept: '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif',
                    disabled: interactionBlocked || submitting || stopping,
                    'aria-label': '添加图片',
                    onChange: (event: { currentTarget: HTMLInputElement }) => {
                      if (event.currentTarget.files !== null) void addDraftFiles(event.currentTarget.files)
                      event.currentTarget.value = ''
                    },
                  })),
                renderPermissionControl(e, {
                  snapshot: permissions, disabled: currentId === undefined || interactionBlocked || submitting || stopping, open: choiceMenu === 'permission',
                  onToggle: () => setChoiceMenu(value => value === 'permission' ? undefined : 'permission'),
                  onSelect: value => { setChoiceMenu(undefined); requestPermission(value) },
                })),
              e('div', { className: 'cbtns' },
                renderModelControl(e, {
                  snapshot: models, disabled: currentId === undefined || interactionBlocked || submitting || stopping, effortOpen: choiceMenu === 'effort',
                  onToggleEffort: () => setChoiceMenu(value => value === 'effort' ? undefined : 'effort'),
                  onSelect: selection => { setChoiceMenu(undefined); void selectModel(selection) },
                }),
                status === 'running' ? e('button', {
                  className: 'stop-generation', type: 'button', disabled: submitting || stopping,
                  title: stopping ? '正在停止' : '停止生成', 'aria-label': stopping ? '正在停止' : '停止生成',
                  onClick: () => { void stopRun() },
                }, icon(e, 'stop'), e('span', null, stopping ? '停止中' : '停止')) : null,
                e('button', {
                  className: `send ${current?.state === 'running' ? 'steer' : ''}`.trim(), type: 'submit',
                  disabled: interactionBlocked || submitting || stopping,
                  title: submitting ? '正在发送' : current?.state === 'running' ? '调整方向' : '发送',
                  'aria-label': submitting ? '正在发送' : current?.state === 'running' ? '调整方向' : '发送',
                }, icon(e, 'send'), current?.state === 'running' ? e('span', null, '调整方向') : null)))),
            e('div', { className: 'hint' }, e('span', null, enterBehavior === 'ctrl-enter-send' ? 'Ctrl+Enter 发送 · Enter 换行' : 'Enter 发送 · Shift+Enter 换行'), status === 'running' ? e('span', { className: 'runtime-steer-hint' }, '运行中 · 发送将调整方向') : null, e('span', null, '/ 命令'), e('span', null, '粘贴、拖入或 ＋ 添加图片'), questionRequest === undefined ? null : e('span', { className: 'question-shortcut' }, '先完成上方问题'), approval === undefined ? null : e('span', { className: 'approval-shortcuts' }, 'Y 允许一次 · N 拒绝'))),
          renderWorkSurfaceDock(e, {
            open: surfaceDockOpen,
            items: surfaceItems,
            ...(activeSurface === undefined ? {} : { active: activeSurface }),
            preference: surfacePreference,
            reloadKey: surfaceReload,
            onSelect: selectSurface,
            onClose: closeSurface,
            onCloseDock: closeSurfaceDock,
            onTogglePin: toggleSurfacePin,
            onMode: mode => updateSurfacePreference(value => ({ ...value, mode })),
            onRefresh: () => setSurfaceReload(value => value + 1),
            onCopy: surface => { void copySurfaceSource(surface) },
            onExternal: openSurfaceExternally,
            onPointerDown: beginSurfaceResize,
            onResizeKey: handleSurfaceResizeKey,
            onResetWidth: () => updateSurfaceWidth(WORK_SURFACE_DOCK_LIMITS.standard),
          })),
        renderPanelResizer(e, {
          panel: 'inspector', width: panelWidths.inspector,
          minimum: PANEL_WIDTH_LIMITS.inspector.min,
          maximum: panelWidthMaximum(panelWidths, 'inspector', layoutViewportWidth),
          onPointerDown: event => beginPanelResize('inspector', event),
          onKeyDown: event => handlePanelResizeKey('inspector', event),
          onReset: () => resetPanelWidth('inspector'),
        }),
        renderInspector(e, {
          collapsed: inspCollapsed, overlayOpen: inspOverlayOpen, tab: rightTab, receipt,
          receiptSeq: current?.completionReceipt?.sourceSeq, contextRow, contextView, heartbeat: heartbeatView,
          approval, approvalCount: approvals.approvals.length, memorySummary: memoryView, memoryState,
          memoryScope, memoryDraft, memoryEditing, memoryBusy, memoryError, currentProject: currentCatalog?.cwd,
          onMemoryScope: setMemoryScope, onMemoryDraft: setMemoryDraft, onMemoryEdit: beginMemoryEdit,
          onMemoryCancel: cancelMemoryEdit, onMemorySubmit: submitMemory,
          onMemoryExpand: () => setMemoryEditorExpanded(true),
          onMemoryState: (entry, state) => { void changeMemoryState(entry, state) },
          transactions: transactionView, plugins,
          model: modelView,
          runCenter, providerReadiness,
          onQueueAction: (itemId, kind) => { void updateRunQueue(itemId, kind) },
          onOpenSubagent: openRunSubagent,
          onInterruptSubagent: childSessionId => { void interruptRunSubagent(childSessionId) },
          onProbeRoute: (provider, model) => { void probeProviderRoute(provider, model) },
          onCancelProbe: () => { ctx.providerReadiness.cancelProbe() },
          pendingRequests: pluginState.pendingRequests, onTab: setRightTab,
          onCollapse: () => {
            if (inspOverlayOpen) {
              setInspCollapsed(false)
              setOverlayState(value => transitionOverlayState(value, 'close'))
            } else {
              setInspCollapsed(value => !value)
            }
          },
          onManage: () => setPluginManagerOpen(true),
        })),
      renderStatusbar(e, { sessionId: currentId, turns: timeline.items.filter(item => item.kind === 'user').length })),
    sideOverlayOpen || inspOverlayOpen ? e('button', { className: 'overlay-scrim', type: 'button', 'aria-label': '关闭浮层', onClick: closeOverlays }) : null,
    pluginManagerOpen ? e('div', { className: 'modal-layer', role: 'presentation', onMouseDown: closePluginManager },
      e('section', { className: 'confirm-box plugin-manager', role: 'dialog', 'aria-modal': 'true', 'aria-label': '插件管理', onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation() },
        pluginManagerPanel(e, { workflow: pluginWorkflow, busy: pluginState.pendingRequests > 0, plugins, onSubmit: beginPluginWorkflow, onPrepare: preparePluginIntent, onConfirm: confirmPluginChange, onReset: resetPluginWorkflow, onClose: closePluginManager }))) : null,
    memoryEditorExpanded ? renderMemoryEditorModal(e, {
      memoryScope, memoryDraft, memoryEditing, memoryBusy, memoryError, currentProject: currentCatalog?.cwd,
      onMemoryScope: setMemoryScope, onMemoryDraft: setMemoryDraft, onMemoryCancel: cancelMemoryEdit,
      onMemorySubmit: submitMemory, onClose: () => setMemoryEditorExpanded(false),
    }) : null,
    permissionChallenge === undefined ? null : renderPermissionConfirmation(e, {
      onClose: () => setPermissionChallenge(undefined),
      onConfirm: () => { const value = permissionChallenge; setPermissionChallenge(undefined); void selectPermission(value) },
    }),
    sideRemoval === undefined ? null : renderSideRemovalConfirmation(e, {
      target: sideRemoval, busy: sideMutation === `${sideRemoval.kind}:${sideRemoval.id}:remove`,
      onClose: () => { if (sideMutation === undefined) setSideRemoval(undefined) },
      onConfirm: () => { void confirmSideRemoval() },
    }),
    commandOpen ? renderCommandPalette(e, {
      commands,
      onClose: () => setCommandOpen(false),
    }) : null)
  }

  const releases = [
    ctx.slots.inject('settings.trigger', () => ctx.slots.register({
      name: 'settings.trigger', id: 'xiaoshe-settings-trigger', priority: -1200,
    }, SettingsTriggerContent)),
    ctx.slots.inject('settings.header', () => ctx.slots.register({
      name: 'settings.header', id: 'xiaoshe-settings-header', priority: -1200,
    }, SettingsBrandHeader)),
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item', id: 'xiaoshe-composer-enter', order: 18,
    }, ComposerEnterSettingsItem)),
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'security', order: 12, label: '权限与安全',
    }, SecuritySettingsSection)),
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'shortcuts', order: 30, label: '快捷键',
    }, ShortcutsSettingsSection)),
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'about', order: 40, label: '高级与关于',
    }, AboutSettingsSection)),
    ctx.slots.inject('root', () => ctx.slots.register({
      name: 'root', id: 'xiaoshe-native-shell-legacy-adapted', priority: -1120,
      // The shell owns only the visual hole. ui-settings-general owns the
      // window/navigation and feature plugins own every settings section.
      children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
    }, Shell)),
  ]
  return () => {
    for (const release of [...releases].reverse()) release()
  }
}

function renderPanelResizer(e: ReactLike['createElement'], options: {
  readonly panel: ResizablePanel
  readonly width: number
  readonly minimum: number
  readonly maximum: number
  readonly onPointerDown: (event: {
    readonly button?: number
    readonly isPrimary?: boolean
    readonly clientX: number
    readonly pointerId?: number
    readonly currentTarget?: { setPointerCapture?(pointerId: number): void }
    preventDefault?(): void
  }) => void
  readonly onKeyDown: (event: { readonly key: string; readonly shiftKey?: boolean; preventDefault?(): void }) => void
  readonly onReset: () => void
}): unknown {
  const label = options.panel === 'side' ? '调整左侧会话栏宽度' : '调整右侧工作台宽度'
  return e('div', {
    className: `panel-resizer panel-resizer-${options.panel}`,
    'data-panel-resizer': options.panel,
    role: 'separator',
    'aria-label': label,
    'aria-orientation': 'vertical',
    'aria-valuemin': options.minimum,
    'aria-valuemax': options.maximum,
    'aria-valuenow': options.width,
    'aria-keyshortcuts': 'ArrowLeft ArrowRight Home End Enter',
    tabIndex: 0,
    title: `${label}；方向键微调，Shift 加速；双击或 Enter 恢复默认`,
    onPointerDown: options.onPointerDown,
    onDoubleClick: options.onReset,
    onKeyDown: options.onKeyDown,
  }, e('span', { className: 'panel-resizer-grip', 'aria-hidden': 'true' }))
}

function renderSide(e: ReactLike['createElement'], options: {
  readonly collapsed: boolean; readonly overlayOpen: boolean; readonly query: string
  readonly sessions: readonly { readonly sessionId: string; readonly title?: string; readonly cwd?: string; readonly updatedAt: number; readonly searchSnippet?: string }[]
  readonly sessionTotal: number; readonly hasMoreSessions: boolean
  readonly workspaces: readonly { readonly workspaceId: string; readonly path: string; readonly title: string; readonly sessionIds: readonly string[] }[]
  readonly archivedSessionIds: readonly string[]
  readonly collapsedWorkspaceIds: readonly string[]
  readonly sideMenu: SideEntityTarget | undefined; readonly sideEdit: SideEditTarget | undefined; readonly sideMutation: string | undefined
  readonly currentId: string | undefined; readonly status: string; readonly onCreate: () => void; readonly onProject: () => void
  readonly onWorkspace: (workspaceId: string) => void; readonly onToggleWorkspace: (workspaceId: string) => void
  readonly onMenu: (target: SideEntityTarget) => void; readonly onBeginEdit: (target: SideEntityTarget) => void
  readonly onEditValue: (value: string) => void; readonly onCommitEdit: () => void; readonly onCancelEdit: () => void
  readonly onRemove: (target: SideRemovalTarget) => void
  readonly settings: unknown
  readonly onQuery: (value: string) => void; readonly onSearch: (value: string) => void
  readonly onShowMore: () => void
  readonly onOpen: (sessionId: string) => void; readonly onCollapse: () => void
}): unknown {
  const archived = new Set(options.archivedSessionIds)
  const visible = options.sessions.filter(row => !archived.has(row.sessionId))
  const collapsed = new Set(options.collapsedWorkspaceIds)
  const revealSearchResults = options.query.trim() !== ''
  const groupedIds = new Set<string>()
  const groups = options.workspaces.map(workspace => {
    const sessions = visible.filter(row => workspace.sessionIds.includes(row.sessionId) || row.cwd === workspace.path)
    for (const session of sessions) groupedIds.add(session.sessionId)
    return { workspace, sessions }
  })
  const ungrouped = visible.filter(row => !groupedIds.has(row.sessionId))
  return e('aside', { id: 'xsla-side', className: `side${options.collapsed ? ' collapsed' : ''}${options.overlayOpen ? ' mobile-open' : ''}`, 'aria-label': '侧栏' },
    e('div', { className: 'brand' }, brandMark(e), e('div', { className: 'brand-copy' }, e('div', { className: 'bt' }, '小蛇'), e('div', { className: 'bs' }, 'HARNESS · ATELIER'))),
    e('div', { className: 'side-sec' }, e('span', null, '会话'), e('span', { className: 'side-acts' }, e('button', { className: 'mini-btn primary-session', type: 'button', onClick: options.onCreate }, '＋ 新会话'), e('button', { className: 'mini-btn', type: 'button', onClick: options.onProject }, '＋ 项目'))),
    e('label', { className: 'side-search' }, e('span', { className: 'visually-hidden' }, '搜索会话与项目'), e('input', { type: 'search', value: options.query, placeholder: '搜索会话/项目…', autoComplete: 'off', onChange: (event: { currentTarget: HTMLInputElement }) => options.onQuery(event.currentTarget.value), onKeyDown: (event: { key: string; preventDefault(): void; currentTarget: HTMLInputElement }) => { if (event.key === 'Enter') { event.preventDefault(); options.onSearch(event.currentTarget.value) } } })),
    e('nav', { className: 'sess-list', 'aria-label': '会话列表' },
      ...groups.map(({ workspace, sessions }, index) => {
        const isCollapsed = !revealSearchResults && collapsed.has(workspace.workspaceId)
        const panelId = `xsla-workspace-sessions-${index}`
        const headerId = `xsla-workspace-heading-${index}`
        const action = isCollapsed ? '展开' : '收起'
        const target: SideEntityTarget = { kind: 'workspace', id: workspace.workspaceId, title: workspace.title }
        const editing = options.sideEdit?.kind === 'workspace' && options.sideEdit.id === workspace.workspaceId
        const menuOpen = options.sideMenu?.kind === 'workspace' && options.sideMenu.id === workspace.workspaceId
        const busy = options.sideMutation?.startsWith(`workspace:${workspace.workspaceId}:`) === true
        return e('section', { className: 'proj', key: workspace.workspaceId, 'data-workspace-id': workspace.workspaceId, 'data-collapsed': isCollapsed, 'data-side-menu-root': '' },
          e('div', { className: 'proj-head' },
            e('button', {
              id: headerId, className: `proj-toggle${editing ? ' editing' : ''}`, type: 'button', title: `${action} ${workspace.title} 会话`,
              'aria-label': `${action} ${workspace.title} 会话`, 'aria-expanded': !isCollapsed, 'aria-controls': panelId,
              onClick: () => options.onToggleWorkspace(workspace.workspaceId),
            },
            e('span', { className: 'proj-chevron', 'aria-hidden': 'true' }, '›'),
            editing ? null : e('svg', { className: 'proj-folder-mark', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
              e('path', { d: 'M2.25 4.75h4.1l1.3 1.45h6.1v6.05H2.25z M2.25 4.75V3.6h4.2l1.15 1.15', fill: 'none', stroke: 'currentColor', strokeWidth: '1.25', strokeLinecap: 'round', strokeLinejoin: 'round' })),
            editing ? null : e('span', { className: 'proj-name', title: workspace.path }, workspace.title)),
            editing ? renderSideRenameInput(e, { value: options.sideEdit?.value ?? workspace.title, label: `重命名项目 ${workspace.title}`, busy, onValue: options.onEditValue, onCommit: options.onCommitEdit, onCancel: options.onCancelEdit }) : null,
            e('button', { className: 'icon-btn side-add-session', type: 'button', disabled: busy, title: `在 ${workspace.title} 新建会话`, 'aria-label': `在 ${workspace.title} 新建会话`, onClick: () => options.onWorkspace(workspace.workspaceId) }, '＋'),
            editing ? null : e('button', { className: 'icon-btn side-menu-trigger', type: 'button', disabled: busy, title: `${workspace.title} 项目操作`, 'aria-label': `${workspace.title} 项目操作`, 'aria-expanded': menuOpen, onClick: () => options.onMenu(target) }, '⋯')),
          menuOpen ? renderSideActionMenu(e, {
            label: `${workspace.title} 项目操作`,
            actions: [
              { label: '新建会话', onClick: () => options.onWorkspace(workspace.workspaceId) },
              { label: '重命名项目', onClick: () => options.onBeginEdit(target) },
              { label: '从侧栏移除', danger: true, onClick: () => options.onRemove({ ...target, path: workspace.path, sessionCount: sessions.length }) },
            ],
          }) : null,
          e('div', { id: panelId, className: 'proj-sess-shell', role: 'group', 'aria-labelledby': headerId, 'aria-hidden': isCollapsed, inert: isCollapsed ? true : undefined },
            e('div', { className: 'proj-sess' }, ...sessions.map(row => renderSessionButton(e, row, options)))))
      }),
      ungrouped.length === 0 ? null : e('section', { className: 'proj' }, e('div', { className: 'group-label' }, '临时会话'), ...ungrouped.map(row => renderSessionButton(e, row, options))),
      options.hasMoreSessions ? e('button', {
        className: 'session-show-more', type: 'button', onClick: options.onShowMore,
        'aria-label': `显示更多会话，当前 ${options.sessions.length} 个，共 ${options.sessionTotal} 个`,
      }, `显示更多 · ${options.sessions.length}/${options.sessionTotal}`) : null),
    options.settings === undefined ? null : e('div', { className: 'side-foot' }, options.settings),
    collapseButton(e, options.collapsed ? '展开侧栏' : '收缩侧栏', 'left', options.collapsed, options.onCollapse))
}

function renderSessionButton(e: ReactLike['createElement'], row: { readonly sessionId: string; readonly title?: string; readonly cwd?: string; readonly updatedAt: number; readonly searchSnippet?: string }, options: {
  readonly currentId: string | undefined; readonly status: string; readonly onOpen: (sessionId: string) => void
  readonly sideMenu: SideEntityTarget | undefined; readonly sideEdit: SideEditTarget | undefined; readonly sideMutation: string | undefined
  readonly onMenu: (target: SideEntityTarget) => void; readonly onBeginEdit: (target: SideEntityTarget) => void
  readonly onEditValue: (value: string) => void; readonly onCommitEdit: () => void; readonly onCancelEdit: () => void
  readonly onRemove: (target: SideRemovalTarget) => void
}): unknown {
  const title = sessionDisplayTitle(row.title, row.sessionId, row.updatedAt)
  const target: SideEntityTarget = { kind: 'session', id: row.sessionId, title }
  const editing = options.sideEdit?.kind === 'session' && options.sideEdit.id === row.sessionId
  const menuOpen = options.sideMenu?.kind === 'session' && options.sideMenu.id === row.sessionId
  const busy = options.sideMutation?.startsWith(`session:${row.sessionId}:`) === true
  const searchSnippet = row.searchSnippet?.trim()
  // The workspace header already owns location context. Repeating cwd below
  // every session turns one compact group into a two-line card wall, so keep
  // the full path in the native tooltip and reserve a second row for actual
  // search evidence only.
  const sessionTooltip = row.cwd === undefined ? title : `${title}\n${row.cwd}`
  return e('div', { className: `sess-row${row.sessionId === options.currentId ? ' on' : ''}`, key: row.sessionId, 'data-session-id': row.sessionId, 'data-side-menu-root': '' },
    editing
      ? e('div', { className: 'sess sess-edit' }, e('span', { className: `session-indicator${row.sessionId === options.currentId && options.status === 'running' ? ' running' : ''}` }), renderSideRenameInput(e, { value: options.sideEdit?.value ?? title, label: `重命名会话 ${title}`, busy, onValue: options.onEditValue, onCommit: options.onCommitEdit, onCancel: options.onCancelEdit }))
      : e('button', { className: 'sess', type: 'button', title: sessionTooltip, onClick: () => options.onOpen(row.sessionId) },
        e('div', { className: 't1' }, e('span', { className: `session-indicator${row.sessionId === options.currentId && options.status === 'running' ? ' running' : ''}` }), e('span', { className: 'prev' }, title)),
        searchSnippet === undefined || searchSnippet === '' ? null : e('div', { className: 't2', title: searchSnippet }, searchSnippet)),
    editing ? null : e('button', { className: 'side-menu-trigger session-menu-trigger', type: 'button', disabled: busy, title: `编辑“${title}”`, 'aria-label': `${title} 会话操作`, 'aria-expanded': menuOpen, onClick: () => options.onMenu(target) }, '⋯'),
    menuOpen ? renderSideActionMenu(e, {
      label: `${title} 会话操作`,
      actions: [
        { label: '重命名会话', onClick: () => options.onBeginEdit(target) },
        { label: '归档并移出列表', danger: true, onClick: () => options.onRemove(target) },
      ],
    }) : null)
}

function renderSideRenameInput(e: ReactLike['createElement'], options: {
  readonly value: string; readonly label: string; readonly busy: boolean
  readonly onValue: (value: string) => void; readonly onCommit: () => void; readonly onCancel: () => void
}): unknown {
  return e('input', {
    className: 'side-rename-input', type: 'text', value: options.value, autoFocus: true, maxLength: 120,
    disabled: options.busy, 'aria-label': options.label,
    onChange: (event: { currentTarget: HTMLInputElement }) => options.onValue(event.currentTarget.value),
    onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); options.onCommit() }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); options.onCancel() }
    },
  })
}

function renderSideActionMenu(e: ReactLike['createElement'], options: {
  readonly label: string
  readonly actions: readonly { readonly label: string; readonly danger?: boolean; readonly onClick: () => void }[]
}): unknown {
  return e('div', { className: 'side-action-menu', role: 'menu', 'aria-label': options.label },
    ...options.actions.map(action => e('button', { className: action.danger === true ? 'danger' : '', type: 'button', role: 'menuitem', key: action.label, onClick: action.onClick }, action.label)))
}

function renderInspector(e: ReactLike['createElement'], options: {
  readonly collapsed: boolean; readonly overlayOpen: boolean; readonly tab: 'status' | 'memory' | 'system'
  readonly receipt: string | undefined; readonly receiptSeq: number | undefined; readonly contextRow: ContextSnapshot['sessions'][string] | undefined
  readonly contextView: ReturnType<typeof contextPresentation>
  readonly heartbeat: { readonly status: string; readonly detail: string; readonly running: boolean; readonly tone?: 'ok' | 'warn' }
  readonly approval: { readonly key: string; readonly toolName: string; readonly reason?: string } | undefined
  readonly approvalCount: number
  readonly memorySummary: { readonly value: string; readonly detail: string }
  readonly memoryState: MemoryLifecycleSnapshot; readonly memoryScope: 'global' | 'project'; readonly memoryDraft: string
  readonly memoryEditing: MemoryEntry | undefined; readonly memoryBusy: string; readonly memoryError: string; readonly currentProject: string | undefined
  readonly onMemoryScope: (scope: 'global' | 'project') => void; readonly onMemoryDraft: (value: string) => void
  readonly onMemoryEdit: (entry: MemoryEntry) => void; readonly onMemoryCancel: () => void
  readonly onMemorySubmit: (event: { preventDefault(): void }) => Promise<void>
  readonly onMemoryExpand: () => void
  readonly onMemoryState: (entry: MemoryEntry, state: 'active' | 'forgotten') => void
  readonly transactions: { readonly total: number; readonly detail: string }
  readonly model: ReturnType<typeof modelPresentation>
  readonly runCenter: RunCenterSnapshot
  readonly providerReadiness: ProviderReadinessSnapshot
  readonly onQueueAction: (itemId: string, kind: 'remove' | 'steer') => void
  readonly onOpenSubagent: (childSessionId: string) => void
  readonly onInterruptSubagent: (childSessionId: string) => void
  readonly onProbeRoute: (provider: string, model: string) => void
  readonly onCancelProbe: () => void
  readonly plugins: readonly { readonly moduleName: string; readonly fiberPhase: string | null }[]; readonly pendingRequests: number
  readonly onTab: (tab: 'status' | 'memory' | 'system') => void; readonly onCollapse: () => void; readonly onManage: () => void
}): unknown {
  return e('aside', { id: 'xsla-insp', className: `insp${options.collapsed ? ' collapsed' : ''}${options.overlayOpen ? ' mobile-open' : ''}`, 'aria-label': '状态面板' },
    collapseButton(e, options.collapsed ? '展开状态面板' : '收缩状态面板', 'right', options.collapsed, options.onCollapse),
    e('div', { className: 'insp-head', role: 'tablist' }, tabButton(e, '状态', 'status', options.tab, options.onTab), tabButton(e, '记忆', 'memory', options.tab, options.onTab), tabButton(e, '能力', 'system', options.tab, options.onTab)),
    e('div', { className: 'insp-body' },
      e('section', { id: 'xsla-panel-status', 'aria-labelledby': 'xsla-tab-status', className: `panel${options.tab === 'status' ? ' on' : ''}`, role: 'tabpanel', hidden: options.tab !== 'status' },
        panelSection(e, '任务清单', '当前任务', options.receipt === undefined ? '运行事实尚未形成终态凭证' : `${receiptLabel(options.receipt)} · 来源 ${options.receiptSeq ?? '—'}`, options.receipt === 'verified' ? 'ok' : undefined, { 'data-receipt-outcome': options.receipt ?? 'none' }),
        renderRunCenterPanel(e, options),
        panelSection(e, '上下文', options.contextView.value, options.contextView.detail, options.contextView.level === 'critical' ? 'warn' : undefined),
        panelSection(e, '运行巡检', options.heartbeat.status, options.heartbeat.detail, options.heartbeat.tone),
        panelSection(e, '行动与审批', options.approval === undefined ? '当前无待审批行动' : `${options.approvalCount} 项等待确认 · ${options.approval.toolName}`, options.approval?.reason ?? '权限策略由运行时强制', options.approval === undefined ? undefined : 'warn')),
      e('section', { id: 'xsla-panel-memory', 'aria-labelledby': 'xsla-tab-memory', className: `panel memory-panel${options.tab === 'memory' ? ' on' : ''}`, role: 'tabpanel', hidden: options.tab !== 'memory' }, renderMemoryPanel(e, options)),
      e('section', { id: 'xsla-panel-system', 'aria-labelledby': 'xsla-tab-system', className: `panel${options.tab === 'system' ? ' on' : ''}`, role: 'tabpanel', hidden: options.tab !== 'system' }, panelSection(e, '模型路由', options.model.value, options.model.detail, options.model.routable === false ? 'warn' : undefined), renderProviderReadinessPanel(e, options), panelSection(e, '能力中心', '运行能力已连接', `${options.runCenter.skills.length} 项技能 · ${options.runCenter.deliverables.length} 项产物 · ${options.runCenter.subagents.length} 个子任务`), panelSection(e, '插件事务', `${options.transactions.total} 笔受控变更`, `${options.transactions.detail}\n${options.plugins.length} 个运行组件实例`, options.pendingRequests > 0 ? 'warn' : undefined), e('button', { className: 'manager-toggle', type: 'button', onClick: options.onManage }, '管理插件'), e('div', { className: 'reality-note' }, e('b', null, '安全边界：'), '本机扩展与小蛇共同运行在 Host 进程中，没有独立的系统沙箱。'))))
}

function renderRunCenterPanel(e: ReactLike['createElement'], options: {
  readonly runCenter: RunCenterSnapshot
  readonly onQueueAction: (itemId: string, kind: 'remove' | 'steer') => void
  readonly onOpenSubagent: (childSessionId: string) => void
  readonly onInterruptSubagent: (childSessionId: string) => void
}): unknown {
  const run = options.runCenter
  const rows: unknown[] = []
  if (run.goal !== undefined) rows.push(e('div', { className: 'run-center-row', key: 'goal' }, e('b', null, '目标'), e('span', null, run.goal.objective), e('small', null, `${run.goal.phase} · ${run.goal.roundsStarted}/${run.goal.maxGoalRounds}`)))
  for (const job of run.jobs) rows.push(e('div', { className: 'run-center-row', key: `job:${job.id}` }, e('b', null, job.label), e('span', { 'data-run-status': job.status }, runStatusLabel(job.status)), job.detail === undefined ? null : e('small', null, job.detail)))
  for (const item of run.queue) rows.push(e('div', { className: 'run-center-row', key: `queue:${item.id}` }, e('b', null, item.placement === 'steering' ? '调整方向' : '等待队列'), e('span', null, item.preview), e('div', { className: 'run-center-actions' }, item.steerable ? e('button', { type: 'button', onClick: () => options.onQueueAction(item.id, 'steer') }, '立即调整') : null, item.removable ? e('button', { type: 'button', onClick: () => options.onQueueAction(item.id, 'remove') }, '移除') : null)))
  for (const child of run.subagents) rows.push(e('div', { className: 'run-center-row', key: `subagent:${child.id}` }, e('b', null, child.kind === 'child' ? child.label ?? '子任务' : '子任务诊断'), e('span', null, child.kind === 'child' ? child.activity === 'running' ? '正在运行' : '已停歇' : `不可用 · ${child.reason}`), child.kind === 'child' ? e('div', { className: 'run-center-actions' }, e('button', { type: 'button', onClick: () => options.onOpenSubagent(child.id) }, '打开'), child.canInterrupt ? e('button', { type: 'button', onClick: () => options.onInterruptSubagent(child.id) }, '停止') : null) : null))
  if (rows.length === 0) rows.push(e('p', { className: 'run-center-empty', key: 'empty' }, run.status === 'loading' ? '正在读取运行事实…' : run.error ?? '当前没有后台任务、队列或子任务。'))
  return e('section', { className: 'psec run-center' }, e('h4', null, '运行中心'), e('div', { className: 'run-center-list' }, ...rows), e('p', { className: 'run-center-foot' }, `${run.todos.length} 项待办 · ${run.deliverables.length} 项产物 · ${run.skills.length} 项技能`))
}

function renderProviderReadinessPanel(e: ReactLike['createElement'], options: {
  readonly providerReadiness: ProviderReadinessSnapshot
  readonly onProbeRoute: (provider: string, model: string) => void
  readonly onCancelProbe: () => void
}): unknown {
  const readiness = options.providerReadiness
  const routes = readiness.providers.flatMap(provider => provider.routes.map(route => ({ provider, route })))
  return e('section', { className: 'psec provider-readiness', 'data-state': readiness.status },
    e('h4', null, '服务商就绪度'),
    routes.length === 0
      ? e('div', { className: 'panel-fact' }, e('b', null, readiness.status === 'loading' ? '正在读取服务商事实' : '暂无可探测模型'), e('span', null, readiness.error ?? '建立会话后显示精确模型路由。'))
      : e('div', { className: 'provider-route-list' }, ...routes.map(({ provider, route }) => e('article', { className: 'provider-route', key: `${route.provider}:${route.model}` },
        e('div', { className: 'provider-route-head' }, e('b', null, route.name), e('small', null, provider.displayName)),
        e('div', { className: 'provider-facts', 'aria-label': '服务商五态事实' }, ...(['catalogued', 'supported', 'configured', 'available', 'verified'] as const).map(fact => e('span', { key: fact, 'data-ready': route.facts[fact] }, providerFactLabel(fact)))),
        e('div', { className: 'provider-route-meta' }, e('span', null, route.probe === undefined ? providerReasonLabel(route.reasons[0]) : probeSummary(route.probe)), e('button', { type: 'button', disabled: readiness.status === 'probing', onClick: () => options.onProbeRoute(route.provider, route.model) }, route.facts.verified ? '重新验证' : '验证'))))),
    readiness.status === 'probing' ? e('button', { className: 'manager-toggle provider-cancel', type: 'button', onClick: options.onCancelProbe }, '停止当前验证') : null)
}

interface MemoryPanelOptions {
  readonly memorySummary: { readonly value: string; readonly detail: string }
  readonly memoryState: MemoryLifecycleSnapshot
  readonly memoryScope: 'global' | 'project'
  readonly memoryDraft: string
  readonly memoryEditing: MemoryEntry | undefined
  readonly memoryBusy: string
  readonly memoryError: string
  readonly currentProject: string | undefined
  readonly onMemoryScope: (scope: 'global' | 'project') => void
  readonly onMemoryDraft: (value: string) => void
  readonly onMemoryEdit: (entry: MemoryEntry) => void
  readonly onMemoryCancel: () => void
  readonly onMemorySubmit: (event: { preventDefault(): void }) => Promise<void>
  readonly onMemoryExpand: () => void
  readonly onMemoryState: (entry: MemoryEntry, state: 'active' | 'forgotten') => void
}

/** Compact editor over the public Memory lifecycle service; Provider state stays authoritative. */
function renderMemoryPanel(e: ReactLike['createElement'], options: MemoryPanelOptions): unknown {
  const snapshot = options.memoryState.memory
  const entries = snapshot?.entries ?? []
  const effectiveScope = options.memoryScope === 'project' && options.currentProject === undefined ? 'global' : options.memoryScope
  const globalEntries = entries.filter(entry => entry.scope === 'global' && entry.state === 'active')
  const projectEntries = entries.filter(entry => entry.scope === 'project' && entry.state === 'active' && entry.project === options.currentProject)
  const forgottenEntries = entries.filter(entry => entry.state === 'forgotten' && (entry.scope === 'global' || entry.project === options.currentProject))
  const busy = options.memoryBusy !== ''
  const error = options.memoryError || options.memoryState.error?.message || ''

  const memoryItem = (entry: MemoryEntry): unknown => e('article', {
    className: 'memory-item', key: entry.id, 'data-memory-id': entry.id, 'data-state': entry.state,
  },
  e('p', { className: 'memory-text' }, entry.text),
  e('div', { className: 'memory-meta' },
    e('span', null, `v${entry.version} · ${formatMemoryDate(entry.updated_at)}`),
    e('span', { className: 'memory-item-actions' },
      entry.state === 'forgotten'
        ? e('button', { type: 'button', disabled: busy, onClick: () => options.onMemoryState(entry, 'active') }, '恢复')
        : e('span', { className: 'memory-active-actions' },
            e('button', { type: 'button', disabled: busy, onClick: () => options.onMemoryEdit(entry) }, '编辑'),
            e('button', { type: 'button', disabled: busy, onClick: () => options.onMemoryState(entry, 'forgotten') }, '遗忘')))))

  const memoryGroup = (title: string, rows: readonly MemoryEntry[], empty: string): unknown => e('section', { className: 'psec memory-group' },
    e('h4', null, `${title} · ${rows.length}`),
    rows.length === 0
      ? e('p', { className: 'memory-empty' }, empty)
      : e('div', { className: 'memory-list' }, ...rows.map(memoryItem)))

  return e('div', { className: 'memory-workbench' },
    panelSection(e, '记忆', options.memorySummary.value, options.memorySummary.detail),
    e('section', { className: 'psec memory-editor' },
      e('h4', null, options.memoryEditing === undefined ? '写入记忆' : '修改记忆'),
      e('form', { 'aria-label': '记忆编辑器', onSubmit: options.onMemorySubmit },
        e('div', { className: 'memory-scope', role: 'group', 'aria-label': '记忆范围' },
          e('button', { type: 'button', 'aria-pressed': effectiveScope === 'global', disabled: options.memoryEditing !== undefined || busy, onClick: () => options.onMemoryScope('global') }, '长期'),
          e('button', { type: 'button', 'aria-pressed': effectiveScope === 'project', disabled: options.memoryEditing !== undefined || options.currentProject === undefined || busy, title: options.currentProject ?? '选择工作区后可用', onClick: () => options.onMemoryScope('project') }, '当前项目')),
        e('textarea', {
          value: options.memoryDraft, maxLength: 4_000, disabled: busy,
          placeholder: effectiveScope === 'project' ? '只在当前项目中长期保留的事实…' : '跨项目都适用的偏好或长期事实…',
          'aria-label': '记忆内容',
          onChange: (event: { currentTarget: HTMLTextAreaElement }) => options.onMemoryDraft(event.currentTarget.value),
        }),
        e('div', { className: 'memory-actions' },
          e('button', { type: 'button', disabled: busy, onClick: options.onMemoryExpand }, '放大编辑'),
          options.memoryEditing === undefined ? null : e('button', { type: 'button', disabled: busy, onClick: options.onMemoryCancel }, '取消'),
          e('button', { className: 'memory-save', type: 'submit', disabled: busy || options.memoryDraft.trim() === '' }, options.memoryBusy === 'save' ? '保存中…' : options.memoryEditing === undefined ? '记住' : '保存修改')))),
    error === '' ? null : e('p', { className: 'memory-error', role: 'alert' }, error),
    memoryGroup('长期', globalEntries, '还没有跨项目长期保留的记忆。'),
    memoryGroup('当前项目', projectEntries, options.currentProject === undefined ? '选择工作区后，这里会显示与该项目精确绑定的记忆。' : '当前项目还没有单独记住的内容。'),
    memoryGroup('已遗忘', forgottenEntries, '没有可恢复的已遗忘记忆。'),
    (snapshot?.counts.superseded ?? 0) === 0 ? null : e('p', { className: 'memory-history-note' }, `另有 ${snapshot?.counts.superseded ?? 0} 个旧版本保留在审计历史中。`))
}

interface MemoryEditorModalOptions {
  readonly memoryScope: 'global' | 'project'
  readonly memoryDraft: string
  readonly memoryEditing: MemoryEntry | undefined
  readonly memoryBusy: string
  readonly memoryError: string
  readonly currentProject: string | undefined
  readonly onMemoryScope: (scope: 'global' | 'project') => void
  readonly onMemoryDraft: (value: string) => void
  readonly onMemoryCancel: () => void
  readonly onMemorySubmit: (event: { preventDefault(): void }) => Promise<void>
  readonly onClose: () => void
}

/** A roomy editor for the same draft owned by the Memory plugin. */
function renderMemoryEditorModal(e: ReactLike['createElement'], options: MemoryEditorModalOptions): unknown {
  const effectiveScope = options.memoryScope === 'project' && options.currentProject === undefined ? 'global' : options.memoryScope
  const busy = options.memoryBusy !== ''
  return e('div', { className: 'modal-layer memory-modal-layer', role: 'presentation', onMouseDown: options.onClose },
    e('section', { className: 'confirm-box memory-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '完整记忆编辑器', onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation() },
      e('div', { className: 'memory-modal-head' },
        e('div', null, e('h2', null, options.memoryEditing === undefined ? '写入记忆' : '修改记忆'), e('p', null, '编辑的是右侧记忆栏中的同一份草稿。')),
        e('button', { type: 'button', onClick: options.onClose }, '返回侧栏')),
      e('form', { onSubmit: options.onMemorySubmit },
        e('div', { className: 'memory-scope', role: 'group', 'aria-label': '记忆范围' },
          e('button', { type: 'button', 'aria-pressed': effectiveScope === 'global', disabled: options.memoryEditing !== undefined || busy, onClick: () => options.onMemoryScope('global') }, '长期'),
          e('button', { type: 'button', 'aria-pressed': effectiveScope === 'project', disabled: options.memoryEditing !== undefined || options.currentProject === undefined || busy, title: options.currentProject ?? '选择工作区后可用', onClick: () => options.onMemoryScope('project') }, '当前项目')),
        e('textarea', {
          value: options.memoryDraft, maxLength: 4_000, disabled: busy, autoFocus: true,
          placeholder: effectiveScope === 'project' ? '只在当前项目中长期保留的事实…' : '跨项目都适用的偏好或长期事实…',
          'aria-label': '完整记忆内容',
          onChange: (event: { currentTarget: HTMLTextAreaElement }) => options.onMemoryDraft(event.currentTarget.value),
        }),
        e('div', { className: 'memory-modal-meta' }, e('span', null, `${Array.from(options.memoryDraft).length} / 4000`), e('span', null, effectiveScope === 'project' ? '仅当前项目' : '跨项目长期可用')),
        options.memoryError === '' ? null : e('p', { className: 'memory-error', role: 'alert' }, options.memoryError),
        e('div', { className: 'memory-actions' },
          options.memoryEditing === undefined ? null : e('button', { type: 'button', disabled: busy, onClick: options.onMemoryCancel }, '取消修改'),
          e('button', { className: 'memory-save', type: 'submit', disabled: busy || options.memoryDraft.trim() === '' }, options.memoryBusy === 'save' ? '保存中…' : options.memoryEditing === undefined ? '记住' : '保存修改')))))
}

function renderStatusbar(e: ReactLike['createElement'], options: { readonly sessionId: string | undefined; readonly turns: number }): unknown {
  return e('footer', { className: 'statusbar' },
    e('span', { className: 'status-session', title: options.sessionId ?? '当前无会话' }, options.sessionId === undefined ? '当前无会话' : `会话 ${options.sessionId}`),
    e('span', { className: 'status-turns' }, `${options.turns} 轮对话`),
    e('div', { className: 'r' }, e('span', null, '小蛇桌面端')))
}

/** Render the official raster asset as a theme-visible gradient outline. */
function renderBrandOutline(e: ReactLike['createElement'], className: string, idPrefix: string): unknown {
  const sheenId = `${idPrefix}-sheen`
  const edgeId = `${idPrefix}-edge`
  const outlineId = `${idPrefix}-outline`
  return e('svg', { className, viewBox: '0 0 256 256', fill: 'none', 'aria-hidden': 'true' },
    e('defs', null,
      e('linearGradient', { id: sheenId, x1: '0', y1: '256', x2: '256', y2: '0', gradientUnits: 'userSpaceOnUse' },
        e('stop', { className: 'brand-outline-stop-1', offset: '0', stopColor: 'var(--sheen-1)' }),
        e('stop', { className: 'brand-outline-stop-2', offset: '.42', stopColor: 'var(--sheen-2)' }),
        e('stop', { className: 'brand-outline-stop-3', offset: '.72', stopColor: 'var(--sheen-3)' }),
        e('stop', { className: 'brand-outline-stop-4', offset: '1', stopColor: 'var(--sheen-4)' })),
      e('filter', { id: edgeId, filterUnits: 'userSpaceOnUse', x: '-6', y: '-6', width: '268', height: '268' },
        e('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: '.47', result: 'outer' }),
        e('feMorphology', { in: 'SourceAlpha', operator: 'erode', radius: '.47', result: 'inner' }),
        e('feComposite', { in: 'outer', in2: 'inner', operator: 'out', result: 'outline' }),
        e('feFlood', { floodColor: '#fff', result: 'white' }),
        e('feComposite', { in: 'white', in2: 'outline', operator: 'in' })),
      e('mask', { id: outlineId, maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: '256', height: '256', 'mask-type': 'alpha' },
        e('image', { href: BROWSER_BRAND_RASTER_HREF, x: '0', y: '0', width: '256', height: '256', filter: `url(#${edgeId})` }))),
    e('rect', { width: '256', height: '256', fill: `url(#${sheenId})`, mask: `url(#${outlineId})` }))
}

function renderStageGhost(e: ReactLike['createElement']): unknown {
  return renderBrandOutline(e, 'stage-ghost', 'xsla-stage-icon')
}

function renderConversationGhost(e: ReactLike['createElement']): unknown {
  return renderBrandOutline(e, 'conversation-ghost', 'xsla-conversation-icon')
}

function renderEmptyStage(e: ReactLike['createElement']): unknown {
  return e('div', { className: 'stage-empty' }, renderStageGhost(e), e('div', { className: 'stage-cluster' }, e('div', { className: 'stage-badge' }, '小蛇待命 · DESKTOP AGENT'), e('div', { className: 'stage-word' }, '小蛇'), e('p', { className: 'stage-sub' }, '看懂你的屏幕，接手电脑里的任务；关键操作先确认，完成后给出验证。'), e('div', { className: 'stage-chips' }, e('span', { className: 'chip' }, '看得见桌面'), e('span', { className: 'chip' }, '真能动手做'), e('span', { className: 'chip' }, '关键操作可控'))))
}

function renderApproval(e: ReactLike['createElement'], approval: { readonly key: string; readonly toolName: string; readonly reason?: string }, answer: (key: string, outcome: 'allowed-once' | 'rejected') => Promise<void>): unknown {
  return e('section', { className: 'approval', key: approval.key, role: 'dialog', 'aria-label': '行动审批' }, e('div', { className: 'ap-head' }, e('span', { className: 'ap-tool' }, approval.toolName), e('span', { className: 'ap-risk' }, '需要确认')), e('p', { className: 'ap-note' }, approval.reason ?? '这项行动需要你明确决定。'), e('div', { className: 'ap-acts' }, e('button', { className: 'ap-btn', type: 'button', onClick: () => { void answer(approval.key, 'rejected') } }, e('b', null, 'n'), ' 拒绝'), e('button', { className: 'ap-btn primary', type: 'button', onClick: () => { void answer(approval.key, 'allowed-once') } }, e('b', null, 'y'), ' 仅允许一次')))
}

function renderQuestionCard(e: ReactLike['createElement'], options: {
  readonly request: UserQuestionRequest
  readonly flow: QuestionFlowState
  readonly onOption: (question: UserQuestionItem, index: number, label: string) => void
  readonly onCustom: (question: UserQuestionItem, index: number, value: string) => void
  readonly onPrevious: (index: number) => void
  readonly onNext: (index: number) => void
  readonly onSkip: (index: number) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
}): unknown {
  const busy = options.flow.busy !== undefined
  if (options.request.error !== undefined || options.request.questions.length === 0) {
    return e('section', {
      className: 'question-card malformed', key: options.request.key, role: 'dialog',
      'aria-label': '回答问题', 'data-question-key': options.request.key,
    },
    e('header', { className: 'question-head' },
      e('div', null, e('span', { className: 'question-eyebrow' }, '需要你的回答'), e('h2', null, '问题没有正确显示')),
      e('button', { className: 'question-cancel', type: 'button', disabled: busy, onClick: options.onCancel }, '取消请求')),
    e('p', { className: 'question-error', role: 'alert' }, options.request.error ?? '问题请求为空，可取消后让小蛇重试。'))
  }

  const index = Math.min(Math.max(0, options.flow.index), options.request.questions.length - 1)
  const question = options.request.questions[index] as UserQuestionItem
  const draft = options.flow.drafts[index] ?? emptyQuestionDraft()
  const hasOptions = (question.options?.length ?? 0) > 0
  const last = index === options.request.questions.length - 1
  return e('section', {
    className: 'question-card', key: options.request.key, role: 'dialog',
    'aria-labelledby': `xsla-question-${options.request.key}-${index}`,
    'data-question-key': options.request.key,
  },
  e('header', { className: 'question-head' },
    e('div', { className: 'question-title-group' },
      e('span', { className: 'question-eyebrow' }, question.header ?? '需要你的回答'),
      e('h2', { id: `xsla-question-${options.request.key}-${index}` }, question.question)),
    e('div', { className: 'question-head-actions' },
      e('span', { className: 'question-progress', 'aria-label': `第 ${index + 1} 题，共 ${options.request.questions.length} 题` }, `${index + 1} / ${options.request.questions.length}`),
      e('button', { className: 'question-cancel', type: 'button', disabled: busy, onClick: options.onCancel, 'aria-label': '取消问题请求' }, '取消'))),
  question.detail === undefined ? null : e('div', { className: 'question-detail' }, question.detail),
  e('div', { className: 'question-options', role: question.multiSelect === true ? 'group' : 'radiogroup', 'aria-label': question.question },
    ...(question.options ?? []).map((option, optionIndex) => {
      const selected = draft.selected.includes(option.label)
      const display = parseQuestionOptionLabel(option.label)
      return e('button', {
        className: `question-option${selected ? ' selected' : ''}`, type: 'button', key: `${option.label}:${optionIndex}`,
        role: question.multiSelect === true ? 'checkbox' : 'radio', 'aria-checked': selected,
        disabled: busy, onClick: () => options.onOption(question, index, option.label),
      },
      e('span', { className: 'question-choice-mark', 'aria-hidden': 'true' }, question.multiSelect === true ? selected ? '✓' : '' : String(optionIndex + 1)),
      e('span', { className: 'question-option-copy' },
        e('span', { className: 'question-option-line' }, e('b', null, display.label), display.recommended ? e('em', null, '推荐') : null),
        option.description === undefined ? null : e('small', null, option.description)))
    }),
    hasOptions
      ? e('label', { className: `question-custom-line${draft.custom.trim() === '' ? '' : ' active'}` },
        e('span', { className: 'question-choice-mark', 'aria-hidden': 'true' }, '✎'),
        e('span', { className: 'visually-hidden' }, '自定义回答'),
        e('input', {
          type: 'text', value: draft.custom, disabled: busy, placeholder: '或者输入自己的回答',
          onChange: (event: { currentTarget: HTMLInputElement }) => options.onCustom(question, index, event.currentTarget.value),
        }))
      : e('label', { className: 'question-freeform' },
        e('span', { className: 'visually-hidden' }, '回答内容'),
        e('textarea', {
          rows: 3, value: draft.custom, disabled: busy, placeholder: '输入你的回答…',
          onChange: (event: { currentTarget: HTMLTextAreaElement }) => options.onCustom(question, index, event.currentTarget.value),
        }))),
  options.flow.error === '' ? null : e('p', { className: 'question-error', role: 'alert' }, options.flow.error),
  e('footer', { className: 'question-actions' },
    e('button', { className: 'question-btn subtle', type: 'button', disabled: busy, onClick: () => options.onSkip(index) }, '跳过'),
    e('span', { className: 'question-action-spacer' }),
    index === 0 ? null : e('button', { className: 'question-btn', type: 'button', disabled: busy, onClick: () => options.onPrevious(index) }, '上一题'),
    e('button', {
      className: 'question-btn primary', type: 'button', disabled: busy,
      onClick: last ? options.onSubmit : () => options.onNext(index),
    }, busy ? options.flow.busy === 'cancel' ? '正在取消…' : '正在提交…' : last ? '提交回答' : '下一题')))
}

interface WorkSurfaceDockRenderOptions {
  readonly open: boolean
  readonly items: readonly WorkSurface[]
  readonly active?: WorkSurface
  readonly preference: WorkSurfaceDockPreference
  readonly reloadKey: number
  readonly onSelect: (surfaceId: string) => void
  readonly onClose: (surfaceId: string) => void
  readonly onCloseDock: () => void
  readonly onTogglePin: (surfaceId: string) => void
  readonly onMode: (mode: WorkSurfaceDockMode) => void
  readonly onRefresh: () => void
  readonly onCopy: (surface: WorkSurface) => void
  readonly onExternal: (surface: WorkSurface) => void
  readonly onPointerDown: (event: { readonly button?: number; readonly isPrimary?: boolean; readonly clientX: number; readonly pointerId?: number; readonly currentTarget?: { setPointerCapture?(pointerId: number): void }; preventDefault?(): void }) => void
  readonly onResizeKey: (event: { readonly key: string; readonly shiftKey?: boolean; preventDefault?(): void }) => void
  readonly onResetWidth: () => void
}

function workSurfaceKindLabel(kind: WorkSurfaceKind): string {
  const labels: Record<WorkSurfaceKind, string> = {
    web: '网页', file: '文件', image: '图片', video: '视频', pdf: 'PDF', terminal: '终端', desktop: '桌面',
  }
  return labels[kind]
}

function workSurfaceStatusLabel(status: WorkSurfaceStatus): string {
  if (status === 'running') return '进行中'
  if (status === 'error') return '失败'
  if (status === 'blocked') return '受保护'
  return '就绪'
}

/**
 * A sandbox with both scripts and same-origin is unsafe for a document sharing
 * the shell's own origin: that document could reach its frame element. Local
 * tools on a different port remain cross-origin and can still be embedded.
 */
export function canEmbedWorkSurfaceInShell(url: string, shellOrigin: string | undefined): boolean {
  if (shellOrigin === undefined) return true
  try { return new URL(url).origin !== new URL(shellOrigin).origin }
  catch { return false }
}

/** Render only the typed Product projection; tool output is never interpreted as HTML. */
function renderWorkSurfaceContent(
  e: ReactLike['createElement'],
  surface: WorkSurface,
  mode: WorkSurfaceDockMode,
  reloadKey: number,
): unknown {
  const view = surface.view
  if (view.kind === 'web') {
    const shellOrigin = typeof window === 'undefined' ? undefined : window.location.origin
    const sameOriginBlocked = view.url !== undefined && !canEmbedWorkSurfaceInShell(view.url, shellOrigin)
    if (view.embed !== 'loopback' || view.url === undefined || sameOriginBlocked) {
      return e('div', { className: 'surface-fallback', 'data-reason': view.embed },
        e('b', null, sameOriginBlocked ? '小蛇自身页面仅允许另行打开' : view.embed === 'external-only' ? '外部网页仅允许另行打开' : '此网页已阻止内嵌'),
        e('p', null, sameOriginBlocked ? '同源页面不会放入带脚本的内嵌沙箱，以免获得小蛇壳权限。' : view.reason ?? '该地址不满足本机安全内嵌条件。'),
        surface.source === undefined ? null : e('code', null, surface.source))
    }
    const interactive = mode === 'interact' && surface.capabilities.interactive
    return e('div', { className: 'surface-web', 'data-interactive': interactive },
      e('iframe', {
        key: `${surface.id}:${reloadKey}`,
        src: view.url,
        title: `${surface.title} · 工作现场`,
        sandbox: 'allow-downloads allow-forms allow-same-origin allow-scripts',
        referrerPolicy: 'no-referrer',
        loading: 'lazy',
        tabIndex: interactive ? 0 : -1,
      }),
      interactive ? null : e('div', { className: 'surface-web-guard', role: 'note' },
        e('span', null, '观察中'),
        e('small', null, '切换到“由你操作”后，才会把鼠标与键盘交给此本地页面。')))
  }
  if (view.kind === 'text') {
    return e('div', { className: 'surface-text', role: 'region', 'aria-label': `${surface.title} 文件内容` },
      ...view.lines.map(line => e('div', { className: 'surface-line', key: `${surface.id}:${line.number}` },
        e('span', { 'aria-hidden': 'true' }, String(line.number)), e('code', null, line.text))),
      view.truncated ? e('p', { className: 'surface-truncated' }, `已安全截断；文件共 ${view.totalLines} 行。`) : null)
  }
  if (view.kind === 'terminal') {
    const detail = [view.cwd, view.exitCode === undefined ? undefined : `退出码 ${view.exitCode}`, view.signal].filter(Boolean).join(' · ')
    return e('div', { className: 'surface-terminal' },
      detail === '' ? null : e('div', { className: 'surface-terminal-meta' }, detail),
      e('pre', null, view.output === '' ? '（命令没有输出）' : view.output),
      view.truncated ? e('p', { className: 'surface-truncated' }, '输出已按安全上限截断。') : null)
  }
  if (view.kind === 'diff') {
    return e('div', { className: 'surface-diffs' },
      ...view.diffs.map((diff, index) => e('article', { className: 'surface-diff', key: `${surface.id}:${index}` },
        e('h4', null, diff.path),
        diff.oldText === null ? null : e('section', { 'data-side': 'old' }, e('b', null, '修改前'), e('pre', null, diff.oldText)),
        e('section', { 'data-side': 'new' }, e('b', null, '修改后'), e('pre', null, diff.newText)))),
      view.truncated ? e('p', { className: 'surface-truncated' }, '改动内容已按安全上限截断。') : null)
  }
  if (view.kind === 'media') {
    if (view.url === undefined) return e('div', { className: 'surface-fallback' }, e('b', null, '已登记产物'), e('p', null, view.description ?? '当前会话没有提供可安全显示的内容地址。'))
    if (view.mediaType === 'video') return e('video', { className: 'surface-media', src: view.url, controls: true, preload: 'metadata' })
    if (view.mediaType === 'pdf') return e('object', { className: 'surface-media surface-pdf', data: view.url, type: 'application/pdf', 'aria-label': surface.title }, e('p', null, '当前浏览器无法内嵌此 PDF。'))
    return e('img', { className: 'surface-media', src: view.url, alt: view.description ?? surface.title, loading: 'lazy' })
  }
  return e('div', { className: 'surface-fallback' }, e('b', null, '工具产物'), e('p', null, view.description))
}

function renderWorkSurfaceDock(e: ReactLike['createElement'], options: WorkSurfaceDockRenderOptions): unknown {
  if (!options.open || options.active === undefined) return null
  const active = options.active
  const shellOrigin = typeof window === 'undefined' ? undefined : window.location.origin
  const interactiveAvailable = active.type === 'web' && active.capabilities.interactive && active.view.kind === 'web'
    && active.view.embed === 'loopback' && active.view.url !== undefined
    && canEmbedWorkSurfaceInShell(active.view.url, shellOrigin)
  const mode: WorkSurfaceDockMode = interactiveAvailable ? options.preference.mode : 'watch'
  const pinned = options.preference.pinnedIds.includes(active.id)
  return e('div', { className: 'surface-layer', 'data-surface-mode': mode },
    e('div', {
      className: 'surface-resizer', role: 'separator', tabIndex: 0,
      'aria-label': '调整工作现场宽度', 'aria-orientation': 'vertical',
      'aria-valuemin': WORK_SURFACE_DOCK_LIMITS.min, 'aria-valuemax': WORK_SURFACE_DOCK_LIMITS.max,
      'aria-valuenow': options.preference.width,
      onPointerDown: options.onPointerDown,
      onKeyDown: options.onResizeKey,
      onDoubleClick: options.onResetWidth,
    }, e('span', { className: 'surface-resizer-grip', 'aria-hidden': 'true' })),
    e('section', { id: 'xsla-work-surface-dock', className: 'surface-dock', 'aria-label': '工作现场' },
      e('header', { className: 'surface-head' },
        e('div', null, e('span', null, '工作现场'), e('small', null, `${options.items.length} 个当前产物`)),
        e('button', { type: 'button', title: '关闭工作现场', 'aria-label': '关闭工作现场', onClick: options.onCloseDock }, '×')),
      e('nav', { className: 'surface-tabs', 'aria-label': '工作现场标签页' },
        ...options.items.map(surface => e('div', { className: `surface-tab-wrap ${surface.id === active.id ? 'on' : ''}`, key: surface.id },
          e('button', { className: 'surface-tab', type: 'button', onClick: () => options.onSelect(surface.id), title: surface.title },
            e('span', { className: 'surface-tab-kind' }, workSurfaceKindLabel(surface.type)),
            e('span', { className: 'surface-tab-title' }, surface.title),
            options.preference.pinnedIds.includes(surface.id) ? e('i', { title: '已置顶', 'aria-label': '已置顶' }, '•') : null),
          e('button', { className: 'surface-tab-close', type: 'button', title: `关闭 ${surface.title}`, 'aria-label': `关闭 ${surface.title}`, onClick: () => options.onClose(surface.id) }, '×')))),
      e('div', { className: 'surface-toolbar' },
        e('div', { className: 'surface-mode', role: 'group', 'aria-label': '工作现场交互方式' },
          e('button', { type: 'button', 'aria-pressed': mode === 'watch', onClick: () => options.onMode('watch') }, '观察'),
          e('button', { type: 'button', disabled: !interactiveAvailable, 'aria-pressed': mode === 'interact', title: interactiveAvailable ? '由你在内嵌本地页面中操作' : '该产物不支持直接交互', onClick: () => options.onMode('interact') }, '由你操作')),
        e('div', { className: 'surface-actions' },
          e('button', { type: 'button', 'aria-pressed': pinned, onClick: () => options.onTogglePin(active.id), title: pinned ? '取消置顶' : '置顶标签' }, pinned ? '取消置顶' : '置顶'),
          e('button', { type: 'button', disabled: !active.capabilities.refresh, onClick: options.onRefresh }, '刷新'),
          e('button', { type: 'button', disabled: !active.capabilities.copySource, onClick: () => options.onCopy(active) }, '复制来源'),
          e('button', { type: 'button', disabled: !active.capabilities.externalOpen, onClick: () => options.onExternal(active) }, '另行打开'))),
      e('div', { className: 'surface-summary' },
        e('div', null, e('b', null, active.title), e('span', { 'data-status': active.status }, workSurfaceStatusLabel(active.status))),
        active.source === undefined ? null : e('code', { title: active.source }, active.source)),
      e('div', { className: 'surface-content', 'data-kind': active.type, 'aria-live': active.status === 'running' ? 'polite' : 'off' },
        renderWorkSurfaceContent(e, active, mode, options.reloadKey))))
}

function renderModelControl(e: ReactLike['createElement'], options: {
  readonly snapshot: ModelCatalogSnapshot
  readonly disabled: boolean
  readonly effortOpen: boolean
  readonly onToggleEffort: () => void
  readonly onSelect: (selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }) => void
}): unknown {
  const current = options.snapshot.current
  const currentGroup = current === undefined ? undefined : options.snapshot.groups.find(group => group.id === current.provider)
  const currentModel = current === undefined ? undefined : currentGroup?.models.find(model => model.id === current.model)
  const modelDisabled = options.disabled || options.snapshot.status === 'loading' || options.snapshot.status === 'selecting' || options.snapshot.groups.length === 0
  const routeValue = current === undefined ? '' : modelRouteKey(current.provider, current.model)
  const modelLabel = currentModel?.name ?? current?.model ?? (options.snapshot.status === 'loading' ? '正在读取模型' : '选择模型')
  const effortValue = current?.reasoningEffort ?? currentModel?.defaultEffort ?? ''
  const effortLabel = reasoningEffortLabel(effortValue, currentModel?.efforts.find(effort => effort.id === effortValue)?.name)
  const modelSelect = e('label', { className: 'model-select-wrap', title: `模型：${modelLabel}` },
    e('span', { className: 'model-name' }, modelLabel),
    e('span', { className: 'model-chevron', 'aria-hidden': 'true' }, '⌄'),
    e('select', {
      className: 'model-select', value: routeValue, disabled: modelDisabled,
      'aria-label': `模型：${modelLabel}`,
      onChange: (event: { currentTarget: HTMLSelectElement }) => {
        const route = parseModelRouteKey(event.currentTarget.value)
        if (route === undefined) return
        const group = options.snapshot.groups.find(item => item.id === route.provider)
        const model = group?.models.find(item => item.id === route.model)
        options.onSelect({ provider: route.provider, model: route.model, ...(model?.defaultEffort === undefined ? {} : { reasoningEffort: model.defaultEffort }) })
      },
    },
    current === undefined ? e('option', { value: '' }, options.snapshot.status === 'loading' ? '读取模型…' : '选择模型') : null,
    ...options.snapshot.groups.map(group => e('optgroup', { label: group.name, key: group.id }, ...group.models.map(model => e('option', { key: `${group.id}:${model.id}`, value: modelRouteKey(group.id, model.id) }, model.name))))))
  const effortControl = current === undefined || currentModel === undefined || currentModel.efforts.length === 0 ? null : e('div', { className: 'choice-control effort-control', 'data-choice-popover-root': '' },
    e('button', {
      className: 'effort-select-wrap', type: 'button', title: `推理档位：${effortLabel}`, disabled: modelDisabled,
      'aria-label': `思考强度：${effortLabel}`, 'aria-haspopup': 'menu', 'aria-expanded': options.effortOpen,
      onClick: options.onToggleEffort,
    }, icon(e, 'brain'), e('span', { className: 'choice-current-label' }, effortLabel)),
    options.effortOpen ? renderChoiceMenu(e, {
      label: '选择思考强度', currentValue: effortValue,
      options: [
        currentModel.efforts.some(effort => effort.id === 'off')
          ? { value: 'off', label: '关闭', description: '关闭额外推理，直接生成回答' }
          : { value: '', label: '关闭', description: '不额外指定思考强度，使用模型默认行为' },
        ...currentModel.efforts.filter(effort => effort.id !== 'off').map(effort => ({
          value: effort.id,
          label: reasoningEffortLabel(effort.id, effort.name),
          description: effort.description ?? reasoningEffortDescription(effort.id),
        })),
      ],
      onSelect: value => options.onSelect({ provider: current.provider, model: current.model, ...(value === '' ? {} : { reasoningEffort: value }) }),
      onDismiss: options.onToggleEffort,
    }) : null)
  return e('div', { className: 'model-controls', 'data-status': options.snapshot.status }, modelSelect, effortControl)
}

function permissionPresetLabel(value: string | undefined, fallback?: string): string {
  if (value === 'read-only') return '只读'
  if (value === 'workspace-write') return '工作区写入'
  if (value === 'danger-full-access') return '完全访问'
  if (value === 'custom') return '自定义权限'
  return fallback ?? '权限不可用'
}

function permissionPresetDescription(value: string): string {
  if (value === 'read-only') return '只读取内容，不修改文件'
  if (value === 'workspace-write') return '仅允许工作区写入'
  if (value === 'danger-full-access') return '可操作工作区之外的文件，需要再次确认'
  if (value === 'custom') return '当前策略不对应标准预设'
  return '由权限插件提供的会话策略'
}

function reasoningEffortDescription(value: string): string {
  if (value === 'low') return '更快的简短思考'
  if (value === 'high') return '更充分地分析任务'
  if (value === 'max') return '最深入推理，耗时更长'
  return '由当前模型提供的推理档位'
}

function reasoningEffortLabel(value: string, fallback?: string): string {
  if (value === '' || value === 'off') return '关闭'
  if (value === 'low') return '低'
  if (value === 'high') return '高'
  if (value === 'max') return '最大'
  return fallback ?? value
}

interface ChoiceMenuOption {
  readonly value: string
  readonly label: string
  readonly description: string
  readonly disabled?: boolean
  readonly danger?: boolean
}

/** Resolve roving-focus movement without coupling it to one popover. */
export function choiceMenuKeyboardIndex(key: string, current: number, count: number): number | undefined {
  if (count <= 0) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown') return (Math.max(0, current) + 1) % count
  if (key === 'ArrowUp') return (Math.max(0, current) - 1 + count) % count
  return undefined
}

/**
 * Resolve focus wrapping at a modal boundary. Returning `undefined` lets the
 * browser handle ordinary movement inside the dialog.
 */
export function dialogTabTarget(count: number, currentIndex: number, shiftKey: boolean): number | undefined {
  if (count <= 0) return undefined
  if (currentIndex < 0) return shiftKey ? count - 1 : 0
  if (shiftKey && currentIndex === 0) return count - 1
  if (!shiftKey && currentIndex === count - 1) return 0
  return undefined
}

function mountNativeDialogAccessibility(
  ownerDocument: Document,
  dialog: HTMLElement,
  background: HTMLElement | undefined,
  onClose: () => void,
): () => void {
  const previouslyFocused = ownerDocument.activeElement instanceof HTMLElement
    ? ownerDocument.activeElement
    : undefined
  const backgroundState = background === undefined ? undefined : {
    inert: background.hasAttribute('inert'),
    ariaHidden: background.getAttribute('aria-hidden'),
  }

  if (background !== undefined) {
    background.setAttribute('inert', '')
    background.setAttribute('aria-hidden', 'true')
  }

  const focusable = (): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  )).filter(element => element.getAttribute('aria-hidden') !== 'true')
  const preferred = dialog.querySelector<HTMLElement>(
    'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [autofocus]',
  )
  ;(preferred ?? focusable()[0] ?? dialog).focus()

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const elements = focusable()
    if (elements.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const current = elements.indexOf(ownerDocument.activeElement as HTMLElement)
    const target = dialogTabTarget(elements.length, current, event.shiftKey)
    if (target === undefined) return
    event.preventDefault()
    elements[target]?.focus()
  }
  ownerDocument.addEventListener('keydown', onKeyDown, true)

  return () => {
    ownerDocument.removeEventListener('keydown', onKeyDown, true)
    if (background !== undefined && backgroundState !== undefined) {
      if (backgroundState.inert) background.setAttribute('inert', '')
      else background.removeAttribute('inert')
      if (backgroundState.ariaHidden === null) background.removeAttribute('aria-hidden')
      else background.setAttribute('aria-hidden', backgroundState.ariaHidden)
    }
    if (previouslyFocused?.isConnected === true) previouslyFocused.focus()
  }
}

function renderChoiceMenu(e: ReactLike['createElement'], options: {
  readonly label: string
  readonly currentValue: string
  readonly options: readonly ChoiceMenuOption[]
  readonly onSelect: (value: string) => void
  readonly onDismiss: () => void
}): unknown {
  const selectedIndex = options.options.findIndex(option => option.value === options.currentValue && option.disabled !== true)
  return e('section', {
    className: 'choice-popover', role: 'menu', 'aria-label': options.label, 'data-placement': 'top',
    onKeyDown: (event: { key: string; currentTarget: HTMLElement; target: EventTarget | null; preventDefault(): void; stopPropagation(): void }) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        options.onDismiss()
        const trigger = event.currentTarget.closest<HTMLElement>('[data-choice-popover-root]')?.querySelector<HTMLElement>('button[aria-haspopup="menu"]')
        queueMicrotask(() => trigger?.focus())
        return
      }
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const current = buttons.indexOf(event.target as HTMLButtonElement)
      const target = choiceMenuKeyboardIndex(event.key, current, buttons.length)
      if (target === undefined) return
      event.preventDefault()
      event.stopPropagation()
      buttons[target]?.focus()
    },
  },
    e('div', { className: 'choice-popover-head' }, options.label),
    e('div', { className: 'choice-popover-list' }, ...options.options.map((option, index) => {
      const selected = option.value === options.currentValue
      return e('button', {
        className: `choice-option${selected ? ' selected' : ''}${option.danger === true ? ' danger' : ''}`,
        type: 'button', role: 'menuitemradio', key: option.value || 'off', disabled: option.disabled,
        'aria-checked': selected, 'data-value': option.value,
        autoFocus: option.disabled !== true && (selectedIndex === index || (selectedIndex < 0 && index === 0)),
        onClick: (event?: { currentTarget?: HTMLElement }) => {
          const trigger = event?.currentTarget?.closest<HTMLElement>('[data-choice-popover-root]')
            ?.querySelector<HTMLElement>('button[aria-haspopup="menu"]')
          options.onSelect(option.value)
          queueMicrotask(() => trigger?.focus())
        },
      },
      e('span', { className: 'choice-mark', 'aria-hidden': 'true' }, selected ? '✓' : ''),
      e('span', { className: 'choice-copy' }, e('b', null, option.label), e('small', null, option.description)))
    })))
}

function renderPermissionControl(e: ReactLike['createElement'], options: {
  readonly snapshot: PermissionPresetSnapshot
  readonly disabled: boolean
  readonly open: boolean
  readonly onToggle: () => void
  readonly onSelect: (value: string) => void
}): unknown {
  const current = options.snapshot.options.find(option => option.value === options.snapshot.currentValue)
  const label = permissionPresetLabel(options.snapshot.currentValue, current?.name)
  const disabled = options.disabled || options.snapshot.status !== 'ready' || options.snapshot.options.length === 0
  return e('div', { className: 'choice-control permission-control', 'data-choice-popover-root': '' },
    e('button', {
      className: 'permission-select-wrap', type: 'button', title: `权限：${label}`, disabled,
      'data-status': options.snapshot.status, 'data-value': options.snapshot.currentValue ?? 'unavailable',
      'aria-label': `权限：${label}`, 'aria-haspopup': 'menu', 'aria-expanded': options.open,
      onClick: options.onToggle,
    }, icon(e, 'shield'), e('span', { className: 'choice-current-label' }, label)),
    options.open ? renderChoiceMenu(e, {
      label: '选择权限', currentValue: options.snapshot.currentValue ?? '',
      options: options.snapshot.options.map(option => ({
        value: option.value,
        label: permissionPresetLabel(option.value, option.name),
        description: option.description ?? permissionPresetDescription(option.value),
        disabled: option.value === 'custom',
        danger: option.value === 'danger-full-access',
      })),
      onSelect: options.onSelect,
      onDismiss: options.onToggle,
    }) : null)
}

function renderPermissionConfirmation(e: ReactLike['createElement'], options: { readonly onClose: () => void; readonly onConfirm: () => void }): unknown {
  return e('div', { className: 'modal-layer permission-layer', role: 'presentation', onMouseDown: options.onClose },
    e('section', { className: 'confirm-box permission-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': '确认完全访问权限', onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation() },
      e('div', { className: 'confirm-title' }, '启用完全访问？'),
      e('div', { className: 'confirm-body' },
        e('p', null, '小蛇将可以在工作区之外读写文件，并执行不受文件沙箱限制的操作。'),
        e('p', { className: 'confirm-note' }, '此设置写入当前会话的 DSH 权限策略；后续可随时切回“工作区写入”或“只读”。')),
      e('div', { className: 'confirm-acts' },
        e('button', { className: 'confirm-cancel', type: 'button', onClick: options.onClose }, '取消'),
        e('button', { className: 'confirm-go danger', type: 'button', onClick: options.onConfirm }, '确认完全访问'))))
}

function renderSideRemovalConfirmation(e: ReactLike['createElement'], options: {
  readonly target: SideRemovalTarget; readonly busy: boolean; readonly onClose: () => void; readonly onConfirm: () => void
}): unknown {
  const workspace = options.target.kind === 'workspace'
  const title = workspace ? `从侧栏移除“${options.target.title}”？` : `归档“${options.target.title}”？`
  const detail = workspace
    ? `仅移除项目登记；目录${options.target.path === undefined ? '' : ` ${options.target.path}`}、用户文件和会话日志都不会被删除。`
    : '会话会从侧栏隐藏，但记录仍由 DSH 保存，可通过归档恢复能力找回。'
  const impact = workspace
    ? `其中 ${options.target.sessionCount ?? 0} 个会话将转入“临时会话”。`
    : '如果这是当前会话，归档后小蛇会回到可用的其他会话或新会话状态。'
  return e('div', { className: 'modal-layer side-removal-layer', role: 'presentation', onMouseDown: options.onClose },
    e('section', { className: 'confirm-box side-removal-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation() },
      e('div', { className: 'confirm-title' }, title),
      e('div', { className: 'confirm-body' }, e('p', null, detail), e('p', { className: 'confirm-note' }, impact)),
      e('div', { className: 'confirm-acts' },
        e('button', { className: 'confirm-cancel', type: 'button', disabled: options.busy, onClick: options.onClose }, '取消'),
        e('button', { className: 'confirm-go danger', type: 'button', disabled: options.busy, onClick: options.onConfirm }, options.busy ? '处理中…' : workspace ? '移除项目' : '归档会话'))))
}

function renderSlashCommandMenu(e: ReactLike['createElement'], options: {
  readonly commands: readonly ShellCommandAction[]
  readonly query: string
  readonly selectedId: SlashCommandId | undefined
  readonly onSelect: (command: ShellCommandAction) => void
}): unknown {
  return e('section', {
    id: 'xsla-slash-command-list', className: 'slash-menu', role: 'listbox', 'aria-label': '斜杠命令',
  },
  e('div', { className: 'slash-menu-head' }, e('span', null, '命令'), e('span', null, '↑↓ 选择 · Enter 执行 · Esc 关闭')),
  options.commands.length === 0
    ? e('div', { className: 'slash-empty' }, `没有匹配“/${options.query}”的命令`)
    : e('div', { className: 'slash-list' }, ...options.commands.map(command => e('button', {
      id: `xsla-slash-command-${command.id}`,
      className: `slash-item${command.id === options.selectedId ? ' selected' : ''}`,
      type: 'button', role: 'option', disabled: command.disabled,
      'aria-selected': command.id === options.selectedId,
      'data-command': command.command,
      onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
      onClick: () => options.onSelect(command),
    },
    e('code', null, command.command),
    e('span', { className: 'slash-copy' }, e('b', null, command.label), e('small', null, command.detail)),
    command.disabled ? e('span', { className: 'slash-unavailable' }, '当前不可用') : null))))
}

function renderCommandPalette(e: ReactLike['createElement'], options: {
  readonly commands: readonly ShellCommandAction[]
  readonly onClose: () => void
}): unknown {
  const action = (command: ShellCommandAction): unknown => e('button', {
    className: 'command-item', type: 'button', disabled: command.disabled,
    onClick: () => { options.onClose(); command.run() },
  }, e('b', null, command.label), e('span', null, command.detail))
  return e('div', { className: 'modal-layer command-layer', role: 'presentation', onMouseDown: options.onClose },
    e('section', { className: 'confirm-box command-palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': '命令面板', onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation() },
      e('div', { className: 'confirm-title' }, '命令面板'),
      e('p', { className: 'command-note' }, '这里只列出当前真实可执行的动作。'),
      e('div', { className: 'command-list' }, ...options.commands.map(action)),
      e('div', { className: 'confirm-acts' }, e('button', { className: 'confirm-cancel', type: 'button', onClick: options.onClose }, '关闭'))))
}

function pluginManagerPanel(e: ReactLike['createElement'], options: {
  readonly workflow: PluginWorkflow; readonly busy: boolean; readonly plugins: readonly { readonly moduleName: string; readonly fiberPhase: string | null }[]
  readonly onSubmit: (event: { preventDefault(): void; currentTarget: HTMLFormElement }) => Promise<void>
  readonly onPrepare: (intent: PluginUiIntent, candidate?: PublicCandidate) => Promise<void>; readonly onConfirm: () => Promise<void>
  readonly onReset: () => void; readonly onClose: () => void
}): unknown {
  const workflow = options.workflow
  const showForm = workflow.step === 'idle' || workflow.step === 'error'
  const inventory = pluginInventoryPresentation(options.plugins)
  const candidateView = workflow.step === 'audited' && workflow.candidate !== undefined
    ? pluginCandidatePresentation(workflow.candidate)
    : undefined
  return e('div', { className: 'plugin-manager-body' },
    e('div', { className: 'confirm-title' }, '受控插件管理'),
    e('div', { className: 'confirm-body' }, e('p', null, '所有变更只进入受管扩展环境。先审计事实，再生成十分钟一次性确认。'), e('p', { className: 'confirm-note' }, '本机扩展在 Host 进程中执行，没有独立的系统沙箱；本界面只提交受控插件事务，不生成或执行任意命令。')),
    workflow.step === 'error' ? e('p', { className: 'manager-error', role: 'alert' }, workflow.message ?? '插件操作失败') : null,
    showForm ? e('form', { id: 'xsla-plugin-form', className: 'manager-form', onSubmit: (event: unknown) => { void options.onSubmit(event as { preventDefault(): void; currentTarget: HTMLFormElement }) } },
      e('label', { className: 'confirm-field' }, '动作', e('select', { name: 'action', defaultValue: 'add', disabled: options.busy }, e('option', { value: 'add' }, '安装'), e('option', { value: 'update' }, '更新'), e('option', { value: 'remove' }, '卸载'))),
      e('label', { className: 'confirm-field' }, '候选来源', e('select', { name: 'sourceKind', defaultValue: 'registry', disabled: options.busy }, e('option', { value: 'registry' }, '软件源版本'), e('option', { value: 'tarball' }, '本地安装包'), e('option', { value: 'directory' }, '本地文件夹'))),
      e('label', { className: 'confirm-field' }, '来源或卸载包名', e('input', { name: 'source', required: true, maxLength: 2_000, placeholder: '@scope/plugin@1.0.0', disabled: options.busy })),
      e('label', { className: 'confirm-field' }, 'Ed25519 签名旁路文件（可选）', e('input', { name: 'signaturePath', maxLength: 2_000, placeholder: '本机 .signature.json 绝对路径', disabled: options.busy }))) : null,
    candidateView !== undefined && workflow.intent !== undefined ? e('div', { className: 'candidate-facts' }, e('b', null, candidateView.heading), ...candidateView.facts.map((fact, index) => e('span', { key: `candidate-fact:${index}` }, fact))) : null,
    workflow.step === 'prepared' && workflow.challenge !== undefined
      ? renderPluginChallenge(e, pluginChallengePresentation(workflow.challenge))
      : null,
    workflow.step === 'completed' && workflow.transaction !== undefined ? e('div', { className: 'candidate-facts' }, e('b', null, `${workflow.transaction.packageName}@${workflow.transaction.version}`), e('span', null, `${pluginActionLabel(workflow.transaction.action)} · ${pluginTransactionStateLabel(workflow.transaction.state)}`), e('span', null, `${workflow.transaction.consent.confirmed ? '已确认' : '未确认'} · 系统沙箱未启用`)) : null,
    e('details', { className: 'plugin-inventory', open: true },
      e('summary', null, inventory.length === 0 ? '运行组件仍在读取' : `运行组件 ${inventory.length} 类 · ${options.plugins.length} 个实例`),
      inventory.length === 0 ? e('p', { className: 'plugin-inventory-empty' }, '清单为空或仍在读取。') : e('div', { className: 'plugin-inventory-groups' },
        ...inventory.map(group => e('details', { className: 'plugin-inventory-group', key: group.key },
          e('summary', { className: 'plugin-inventory-group-head' }, e('b', null, group.name), e('span', null, group.active === group.instances ? `${group.instances} 个可用` : `${group.active}/${group.instances} 可用`)),
          e('p', null, group.description))))),
    e('div', { className: 'confirm-acts' },
      e('button', { className: 'confirm-cancel', type: 'button', onClick: options.onClose }, '关闭'),
      workflow.step === 'audited' && workflow.intent !== undefined ? e('button', { className: 'confirm-go', type: 'button', disabled: options.busy, onClick: () => { void options.onPrepare(workflow.intent!, workflow.candidate) } }, '准备一次性确认') : null,
      workflow.step === 'prepared' ? e('button', { className: 'confirm-go danger', type: 'button', disabled: options.busy, onClick: () => { void options.onConfirm() } }, '确认并执行一次') : null,
      workflow.step === 'completed' ? e('button', { className: 'confirm-go', type: 'button', onClick: options.onReset }, '继续管理') : null,
      showForm ? e('button', { className: 'confirm-go', type: 'submit', form: 'xsla-plugin-form', disabled: options.busy }, options.busy ? '正在核对…' : '审计并核对') : null))
}

function renderPluginChallenge(
  e: ReactLike['createElement'],
  view: ReturnType<typeof pluginChallengePresentation>,
): unknown {
  return e('div', { className: 'candidate-facts' },
    e('b', null, view.heading),
    ...view.facts.map((fact, index) => e('span', { key: `fact:${index}` }, fact)),
    e('ul', null, ...view.disclosures.map((item, index) => e('li', { key: `disclosure:${index}` }, item))))
}

function panelSection(e: ReactLike['createElement'], title: string, value: string, detail: string, tone?: 'ok' | 'warn', extra: Record<string, unknown> = {}): unknown {
  return e('section', { className: 'psec', ...(tone === undefined ? {} : { 'data-tone': tone }), ...extra }, e('h4', null, title), e('div', { className: 'panel-fact' }, e('b', null, value), e('span', null, detail)))
}

export function tabKeyboardTarget(current: 'status' | 'memory' | 'system', key: string): 'status' | 'memory' | 'system' | undefined {
  const tabs = ['status', 'memory', 'system'] as const
  if (key === 'Home') return tabs[0]
  if (key === 'End') return tabs[2]
  const delta = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0
  if (delta === 0) return undefined
  return tabs[(tabs.indexOf(current) + delta + tabs.length) % tabs.length]
}

function tabButton(e: ReactLike['createElement'], label: string, value: 'status' | 'memory' | 'system', current: 'status' | 'memory' | 'system', onTab: (value: 'status' | 'memory' | 'system') => void): unknown {
  return e('button', {
    id: `xsla-tab-${value}`, className: `itab${value === current ? ' on' : ''}`, type: 'button', role: 'tab',
    'aria-selected': value === current, 'aria-controls': `xsla-panel-${value}`, tabIndex: value === current ? 0 : -1,
    'data-tab': value,
    onClick: () => onTab(value),
    onKeyDown: (event: { key: string; currentTarget: HTMLElement; preventDefault(): void }) => {
      const next = tabKeyboardTarget(value, event.key)
      if (next === undefined) return
      event.preventDefault()
      onTab(next)
      const tablist = event.currentTarget.closest<HTMLElement>('[role="tablist"]')
      queueMicrotask(() => tablist?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus())
    },
  }, label)
}

function collapseButton(e: ReactLike['createElement'], label: string, direction: 'left' | 'right', collapsed: boolean, onClick: () => void): unknown {
  return e('button', { className: 'collapse-btn', type: 'button', title: label, 'aria-label': label, 'aria-expanded': !collapsed, onClick }, e('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, e('path', { d: direction === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6' })))
}

function brandMark(e: ReactLike['createElement'], className = 'brand-mark', idSuffix = ''): unknown {
  // Exact inline geometry and four-stop sheen from the immutable legacy brand
  // slot. The external SVG remains the favicon source; no second mark is drawn.
  const pupilId = `xsla-pupil-brand${idSuffix === '' ? '' : `-${idSuffix}`}`
  const sheenId = `xsla-brand-sheen${idSuffix === '' ? '' : `-${idSuffix}`}`
  return e('svg', { className, role: 'img', 'aria-label': '小蛇', viewBox: '0 0 24 24', fill: 'none' },
    e('defs', null,
      e('mask', { id: pupilId },
        e('rect', { width: '24', height: '24', fill: '#fff' }),
        e('path', { d: 'M14.7 5.1 Q14.7 4.4 15.4 4.4 L16.6 4.4 Q17.3 4.4 17.3 5.1 L17.3 6.1 L16.4 7 L15.4 7 Q14.7 7 14.7 6.3 Z', fill: '#000' }),
        e('rect', { x: '17.1', y: '5.425', width: '6.9', height: '.55', fill: '#000' })),
      e('linearGradient', { id: sheenId, x1: '3', y1: '20', x2: '21', y2: '4', gradientUnits: 'userSpaceOnUse' },
        e('stop', { offset: '0', stopColor: 'var(--sheen-1)' }),
        e('stop', { offset: '.42', stopColor: 'var(--sheen-2)' }),
        e('stop', { offset: '.72', stopColor: 'var(--sheen-3)' }),
        e('stop', { offset: '1', stopColor: 'var(--sheen-4)' }))),
    e('path', {
      mask: `url(#${pupilId})`, stroke: `url(#${sheenId})`, strokeWidth: '5', strokeLinecap: 'round',
      d: 'M16.8 6.8 C14.4 4.3 9.9 4.4 8.6 7 C7.3 9.6 10.1 10.8 12.5 12 C14.9 13.2 17.4 14.5 16.1 17.1 C14.8 19.7 9.9 20.1 7.4 17.9',
    }))
}

function settingsGlyph(e: ReactLike['createElement']): unknown {
  return e('svg', { className: 'xsla-settings-trigger-glyph', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.45', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    e('circle', { cx: '12', cy: '12', r: '2.8' }),
    e('path', { d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-2.87 2.87-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.55v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06-2.87-2.87.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.3V9.55h.1A1.7 1.7 0 0 0 4.1 8.5a1.7 1.7 0 0 0-.34-1.87l-.06-.06L6.57 3.7l.06.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.3h4.05v.1A1.7 1.7 0 0 0 15 4.1a1.7 1.7 0 0 0 1.87-.34l.06-.06 2.87 2.87-.06.06A1.7 1.7 0 0 0 19.4 8.5a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4.05h-.1A1.7 1.7 0 0 0 19.4 15Z' }))
}

/** Platform-correct, relocatable log location shown in diagnostics. */
export function platformLogLocation(platform: unknown): string {
  if (platform === 'darwin') return '~/Library/Logs/小蛇'
  if (platform === 'win32') return '%LOCALAPPDATA%\\Xiaoshe\\Logs'
  if (platform === 'linux') return '~/.local/state/xiaoshe/logs'
  return '等待桌面桥识别平台'
}

function icon(e: ReactLike['createElement'], name: 'brain' | 'shield' | 'stop' | 'moon' | 'sun' | 'image' | 'command' | 'send' | 'down' | 'surface'): unknown {
  const paths: Record<string, readonly string[]> = {
    brain: ['M12 4.5A2.8 2.8 0 0 0 9.2 7a3 3 0 0 0-2 5 3 3 0 0 0 1.6 4.8A3 3 0 0 0 12 19.5a3 3 0 0 0 3.2-2.7A3 3 0 0 0 16.8 12a3 3 0 0 0-2-5A2.8 2.8 0 0 0 12 4.5Z', 'M12 4.5v15'],
    shield: ['M12 3 19 6v5c0 4.6-2.8 8.1-7 10-4.2-1.9-7-5.4-7-10V6l7-3Z', 'M9.5 12.2 11.2 14l3.6-4'],
    stop: ['M7 7h10v10H7z'], moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z'],
    sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2'],
    image: ['M3 5h18v14H3z', 'm21 15-4.5-4.5L9 18'],
    command: ['M9 9h6v6H9z', 'M9 9H7a2 2 0 1 1 2-2v2ZM15 9V7a2 2 0 1 1 2 2h-2ZM15 15h2a2 2 0 1 1-2 2v-2ZM9 15v2a2 2 0 1 1-2-2h2Z'],
    surface: ['M3 4h18v16H3z', 'M15 4v16', 'M17.5 8h1M17.5 12h1M17.5 16h1'],
    send: ['M21 3 10.5 13.5', 'm21 3-6.8 18-3.7-8.5L2 8.8 21 3Z'],
    down: ['m6.5 9.5 5.5 5 5.5-5'],
  }
  return e('svg', { className: 'ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, ...paths[name]!.map((path, index) => e('path', { d: path, key: `${name}:${index}` })))
}

function memoryPresentation(value: MemoryLifecycleSnapshot): { readonly value: string; readonly detail: string } {
  const memory = value.memory
  if (value.status === 'loading') return { value: '正在读取', detail: '由独立 Memory 插件提供' }
  if (value.status === 'error') return { value: '读取失败', detail: '请检查 Memory 服务状态' }
  if (value.status !== 'ready' || memory === undefined) return { value: '尚未读取', detail: '由独立 Memory 插件提供' }
  const active = memory.entries?.filter(entry => entry.state === 'active')
  const activeCount = active?.length ?? memory.counts.active
  const globalCount = active?.filter(entry => entry.scope === 'global').length ?? memory.counts.global
  const projectCount = active?.filter(entry => entry.scope === 'project').length ?? memory.counts.project
  return { value: `${activeCount} 条可用`, detail: `revision ${memory.revision}\n全局 ${globalCount} · 项目 ${projectCount} · 已忘记 ${memory.counts.forgotten}` }
}

export function heartbeatPresentation(value: unknown): { readonly status: string; readonly detail: string; readonly running: boolean; readonly tone?: 'ok' | 'warn' } {
  const input = record(value)
  if (input?.schemaVersion !== 2 || typeof input.status !== 'string' || typeof input.running !== 'boolean' || !Array.isArray(input.checks)) return { status: '不可用', detail: '后台状态尚未连接', running: false }
  const checks = input.checks.flatMap((item): HeartbeatPublicCheck[] => {
    const check = record(item)
    if (typeof check?.id !== 'string' || typeof check.status !== 'string' || typeof check.intervalMs !== 'number' || typeof check.failureCount !== 'number') return []
    return [{ id: check.id, status: check.status, intervalMs: check.intervalMs, failureCount: check.failureCount, ...(typeof check.nextRunAt === 'number' ? { nextRunAt: check.nextRunAt } : {}) }]
  })
  const tone = input.status === 'healthy'
    ? 'ok'
    : ['lost', 'delayed', 'backoff'].includes(input.status) ? 'warn' : undefined
  const stateLabel = runtimeFactLabel(input.status)
  return {
    status: stateLabel,
    running: input.running,
    detail: checks.length === 0
      ? '没有后台检查在运行'
      : checks.map(check => `${friendlyCheckName(check.id)} · ${runtimeFactLabel(check.status)} · 失败 ${check.failureCount}${check.nextRunAt === undefined ? '' : ` · 下次 ${formatClockTime(check.nextRunAt)}`}`).join('\n'),
    ...(tone === undefined ? {} : { tone }),
  }
}

function healthSourceError(snapshot: ProductHealthSnapshot, source: ProductHealthSourceError['source']): string | undefined {
  if (!('errors' in snapshot)) return undefined
  const error = snapshot.errors.find(item => item.source === source)
  if (error === undefined) return undefined
  const facts = [error.kind, error.status === undefined ? undefined : `HTTP ${error.status}`].filter((value): value is string => value !== undefined)
  return `${error.message}${facts.length === 0 ? '' : `（${facts.join(' · ')}）`}`
}

export function pluginTransactionPresentation(value: PluginGovernanceSnapshot): { readonly total: number; readonly detail: string } {
  const counts = new Map<string, number>()
  for (const transaction of value.transactions) counts.set(transaction.state, (counts.get(transaction.state) ?? 0) + 1)
  return { total: value.transactions.length, detail: value.status === 'error' ? `事务读取失败${value.error === undefined ? '' : `：${value.error}`}` : counts.size === 0 ? value.status === 'loading' ? '正在读取事务' : '暂无受控变更记录' : [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([state, count]) => `${pluginTransactionStateLabel(state)} ${count}`).join(' · ') }
}

export interface PluginInventoryGroup {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly instances: number
  readonly active: number
}

const HOST_MODULE_GROUPS: readonly {
  readonly key: string; readonly name: string; readonly description: string; readonly matches: readonly string[]
}[] = [
  { key: 'continuity', name: '会话连续性', description: '按工作区查找并回溯既往会话', matches: ['session-continuity', 'session-query'] },
  { key: 'conversation', name: '会话与对话', description: '会话建立、消息与分支', matches: ['session', 'conversation', 'message'] },
  { key: 'task', name: '任务与时间线', description: '执行状态、凭证与上下文整理', matches: ['task', 'timeline', 'receipt', 'compact', 'context'] },
  { key: 'model', name: '模型与服务商', description: '模型目录、路由与服务商连接', matches: ['model', 'provider', 'deepseek', 'anthropic', 'openai'] },
  { key: 'permission', name: '权限与审批', description: '权限预设、确认与用户问题', matches: ['permission', 'approval', 'question', 'security'] },
  { key: 'memory', name: '记忆', description: '长期偏好与项目事实', matches: ['memory'] },
  { key: 'workspace', name: '工作区与文件', description: '项目目录、文件与搜索', matches: ['workspace', 'file', 'search'] },
  { key: 'surface', name: '桌面与工作现场', description: '桌面桥、终端与可视产物', matches: ['desktop', 'surface', 'terminal', 'browser'] },
  { key: 'appearance', name: '设置与外观', description: '主题、语言与设置中心', matches: ['setting', 'theme', 'locale', 'i18n'] },
  { key: 'governance', name: '插件治理', description: '插件审计、安装与事务记录', matches: ['plugin', 'governance', 'profile'] },
]

/** Collapse implementation modules into stable product capabilities for people. */
export function pluginInventoryPresentation(
  entries: readonly { readonly moduleName: string; readonly fiberPhase: string | null }[],
): readonly PluginInventoryGroup[] {
  const groups = new Map<string, PluginInventoryGroup>()
  const seen = new Set<string>()
  for (const entry of entries) {
    const normalized = entry.moduleName.trim().toLocaleLowerCase()
    if (normalized === '' || seen.has(`${normalized}:${entry.fiberPhase ?? ''}`)) continue
    seen.add(`${normalized}:${entry.fiberPhase ?? ''}`)
    const matched = HOST_MODULE_GROUPS.find(group => group.matches.some(fragment => normalized.includes(fragment)))
      ?? { key: 'runtime', name: '基础运行组件', description: '连接、同步与兼容层', matches: [] }
    const current = groups.get(matched.key)
    const active = entry.fiberPhase === 'active' ? 1 : 0
    groups.set(matched.key, {
      key: matched.key, name: matched.name, description: matched.description,
      instances: (current?.instances ?? 0) + 1,
      active: (current?.active ?? 0) + active,
    })
  }
  const order = [...HOST_MODULE_GROUPS.map(group => group.key), 'runtime']
  return [...groups.values()].sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key))
}

export function contextPresentation(value: ContextSnapshot['sessions'][string] | undefined): {
  readonly short: string
  readonly value: string
  readonly detail: string
  readonly level: 'unknown' | 'normal' | 'elevated' | 'critical'
  readonly cacheHitRatio?: number
} {
  if (value === undefined) return { short: '上下文待采样', value: '暂无当前会话上下文', detail: '等待运行时统计', level: 'unknown' }
  const budget = record(value.budget)
  const usage = record(value.usage)
  const used = nonNegativeNumber(budget?.usedTokens)
  const capacity = positiveNumber(budget?.capacityTokens)
  const ratio = unitRatio(budget?.ratio) ?? (used !== undefined && capacity !== undefined ? Math.min(1, used / capacity) : undefined)
  const level = budget?.level === 'normal' || budget?.level === 'elevated' || budget?.level === 'critical' ? budget.level : 'unknown'
  const uncached = nonNegativeNumber(usage?.uncachedInputTokens) ?? nonNegativeNumber(usage?.inputTokens) ?? 0
  const output = nonNegativeNumber(usage?.outputTokens) ?? 0
  const cacheRead = nonNegativeNumber(usage?.cacheReadTokens) ?? 0
  const cacheWrite = nonNegativeNumber(usage?.cacheWriteTokens) ?? 0
  const cacheDenominator = uncached + cacheRead
  const cacheHitRatio = cacheDenominator > 0 ? cacheRead / cacheDenominator : undefined
  const remaining = used === undefined || capacity === undefined ? undefined : Math.max(0, capacity - used)
  const percent = ratio === undefined ? undefined : `${(ratio * 100).toFixed(ratio >= 0.1 ? 0 : 1)}%`
  const detail = [
    used === undefined || capacity === undefined ? '窗口用量等待采样' : `已用 ${formatTokens(used)} / ${formatTokens(capacity)} · 剩余 ${formatTokens(remaining ?? 0)}`,
    `累计未缓存输入 ${formatTokens(uncached)} · 输出 ${formatTokens(output)}`,
    `缓存读取 ${formatTokens(cacheRead)} · 写入 ${formatTokens(cacheWrite)}${cacheHitRatio === undefined ? '' : ` · 命中 ${(cacheHitRatio * 100).toFixed(1)}%`}`,
    `上下文整理 ${value.compactions?.length ?? 0} 次`,
  ].join('\n')
  return {
    short: used === undefined || capacity === undefined ? '上下文待采样' : `上下文 ${formatTokens(used)} / ${formatTokens(capacity)} · ${percent ?? '—'}`,
    value: percent === undefined ? '预算已连接' : `${percent} 已用`,
    detail,
    level,
    ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
  }
}

export function modelPresentation(value: ModelCatalogSnapshot): { readonly value: string; readonly detail: string; readonly routable?: boolean } {
  const current = value.current
  if (current === undefined) {
    return { value: value.status === 'loading' ? '正在读取模型目录' : '尚无当前模型', detail: value.error ?? `已发现 ${value.groups.length} 个模型服务商`, ...(value.routable === undefined ? {} : { routable: value.routable }) }
  }
  const group = value.groups.find(item => item.id === current.provider)
  const model = group?.models.find(item => item.id === current.model)
  const label = model?.name ?? current.model
  const provider = group?.name ?? current.provider
  return {
    value: label,
    detail: `服务商 ${provider}${current.reasoningEffort === undefined ? '' : `\n思考强度 ${reasoningEffortLabel(current.reasoningEffort)}`}\n模型目录${modelCatalogStatusLabel(value.status)} · 服务商异常 ${value.failures.length}`,
    ...(value.routable === undefined ? {} : { routable: value.routable }),
  }
}

function runStatusLabel(value: string): string {
  return ({ running: '正在运行', stopping: '正在停止', completed: '已完成', killed: '已终止', failed: '失败' } as Record<string, string>)[value] ?? value
}

function providerFactLabel(value: 'catalogued' | 'supported' | 'configured' | 'available' | 'verified'): string {
  return ({ catalogued: '已收录', supported: '受支持', configured: '已配置', available: '可用', verified: '已验证' } as const)[value]
}

function providerReasonLabel(value: string | undefined): string {
  return ({
    provider_not_catalogued: '服务商尚未收录', route_unsupported: '当前路由不受支持', settings_missing: '缺少服务商设置',
    credential_missing: '缺少凭据', route_unavailable: '路由当前不可用', probe_missing: '尚未执行真实验证',
    probe_running: '正在验证', probe_failed: '上次验证失败', probe_cancelled: '上次验证已取消',
    probe_expired: '验证结果已过期', probe_route_mismatch: '验证结果不属于当前路由',
  } as Record<string, string>)[value ?? ''] ?? '等待运行事实'
}

function probeSummary(value: { readonly status: string; readonly latencyMs?: number; readonly contextWindow?: number; readonly error?: { readonly message: string } }): string {
  if (value.status === 'running') return '正在验证'
  if (value.status === 'failed') return value.error?.message ?? '验证失败'
  if (value.status === 'cancelled') return '验证已取消'
  const latency = value.latencyMs === undefined ? '' : `${Math.round(value.latencyMs)} ms`
  const context = value.contextWindow === undefined ? '' : `上下文 ${formatTokens(value.contextWindow)}`
  return [latency, context].filter(Boolean).join(' · ') || '验证通过'
}

/** Opaque select value; model/provider ids may themselves contain slashes. */
export function modelRouteKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

export function parseModelRouteKey(value: string): { readonly provider: string; readonly model: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' || parsed[0] === '' || parsed[1] === '') return undefined
    return { provider: parsed[0], model: parsed[1] }
  } catch {
    return undefined
  }
}

function statusLabel(value: string): string {
  return ({ running: '正在处理', blocked: '等待确认', completed: '任务结束', idle: '已连接', blank: '新会话' } as Record<string, string>)[value] ?? value
}

function runtimeFactLabel(value: string): string {
  return ({ idle: '待命', healthy: '正常', running: '运行中', lost: '连接中断', delayed: '响应延迟', backoff: '稍后重试', error: '异常' } as Record<string, string>)[value] ?? '状态未知'
}

function friendlyCheckName(value: string): string {
  const normalized = value.toLocaleLowerCase()
  if (normalized.includes('runtime')) return '小蛇运行服务'
  if (normalized.includes('desktop')) return '桌面桥'
  if (normalized.includes('memory')) return '记忆服务'
  if (normalized.includes('plugin')) return '插件治理'
  return '后台检查'
}

function pluginTransactionStateLabel(value: string): string {
  return ({ healthy: '运行正常', 'rolled-back': '已回滚', failed: '失败', prepared: '待确认', committed: '已完成', pending: '处理中' } as Record<string, string>)[value] ?? '其他状态'
}

function pluginActionLabel(value: string): string {
  return ({ add: '安装', update: '更新', remove: '卸载' } as Record<string, string>)[value] ?? '变更'
}

function pluginRiskLabel(value: unknown): string {
  if (typeof value !== 'string') return '未知'
  return ({ low: '低', medium: '中', high: '高', critical: '严重', unknown: '未知' } as Record<string, string>)[value.toLocaleLowerCase()] ?? '未知'
}

function pluginSourceAssuranceLabel(value: CandidateProvenance['assurance']): string {
  return ({ unverified: '未签名', 'signed-untrusted': '签名有效但未信任', 'verified-publisher': '发布者已验证', 'invalid-signature': '签名无效' } as const)[value]
}

function pluginSignatureStatusLabel(value: PublicCandidate['signature']['status']): string {
  return ({ unsigned: '未签名', invalid: '无效', 'valid-untrusted': '有效但未信任', trusted: '有效且受信' } as const)[value]
}

function pluginPolicyFacts(audit: Readonly<Record<string, unknown>>): readonly string[] {
  const policy = typeof audit.policy === 'object' && audit.policy !== null ? audit.policy as Readonly<Record<string, unknown>> : undefined
  if (policy === undefined) return []
  const permissions = Array.isArray(policy.permissions) ? policy.permissions.filter((row): row is string => typeof row === 'string') : []
  const capabilities = Array.isArray(policy.capabilities) ? policy.capabilities.filter((row): row is string => typeof row === 'string') : []
  return Object.freeze([
    `权限清单：${permissions.length === 0 ? '未声明' : permissions.join(', ')}`,
    `能力声明：${capabilities.length === 0 ? '未声明' : capabilities.join(', ')}`,
    `隔离声明：${typeof policy.isolation === 'string' ? policy.isolation : '未声明'}（实际为共享本机进程）`,
  ])
}

function pluginSourceSelectionLabel(value: CandidateProvenance['selection']): string {
  return ({ 'local-bytes': '本地字节', 'exact-version': '固定版本', 'floating-reference': '浮动引用', 'external-reference': '外部引用' } as const)[value]
}

function userFacingPluginDisclosure(value: string): string {
  return value
    .replace(/\s*Host\s*/giu, '本机')
    .replace(/\s*OS sandbox\s*/giu, '系统沙箱')
    .replace(/\s*Profile\s*/giu, '配置环境')
}

function modelCatalogStatusLabel(value: ModelCatalogSnapshot['status']): string {
  return ({ idle: '待命', loading: '读取中', ready: '可用', selecting: '切换中', error: '异常' } as const)[value]
}

function receiptLabel(value: string): string {
  return ({ verified: '已验证', partial: '部分验证', blocked: '受阻', failed: '失败', not_run: '未执行', release_held: '待发布', running: '执行中' } as Record<string, string>)[value] ?? value
}

function eventLabel(value: string): string {
  return ({ user: '你 · INPUT', assistant: '小蛇 · RESPONSE', tool: '行动 · ACTION', error: '错误 · ERROR', compaction: '上下文整理 · COMPACT', status: '验证 · VERIFY' } as Record<string, string>)[value] ?? value
}

/** Present timeline truth without making an older failure contradict a newer receipt. */
export function timelineEventPresentation(
  item: TimelineSnapshot['items'][number],
  receiptSeq: number | undefined,
): { readonly label: string; readonly historical: boolean; readonly detail: string } {
  const failure = item.isError === true || item.kind === 'error'
  const historical = failure && item.seq !== undefined && receiptSeq !== undefined && item.seq < receiptSeq
  const details = [
    item.errorCode === undefined ? undefined : `错误代码 ${item.errorCode}`,
    item.time === undefined ? undefined : formatClockTime(item.time),
  ].filter((value): value is string => value !== undefined)
  return {
    label: failure ? historical ? '上一轮失败 · ERROR' : '任务失败 · ERROR' : eventLabel(item.kind),
    historical,
    detail: details.join(' · '),
  }
}

function boundedText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.length > maxLength || /[\r\n\0]/u.test(normalized)) throw new TypeError(`${label}必须是单行有效值`)
  return normalized
}

/** Keep sidebar titles visible, bounded and compatible with DSH validation. */
export function normalizeSideEntityTitle(value: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new TypeError('名称不能为空')
  if ([...normalized].length > 120) throw new TypeError('名称不能超过 120 个字符')
  if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(normalized)) throw new TypeError('名称必须包含可见字符')
  return normalized
}

function abbreviateHash(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 12)}…${value.slice(-8)}`
}

function formatClockTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value))
}

function formatMemoryDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isMemoryRevisionConflict(value: unknown): boolean {
  const detail = record(value)
  return detail?.status === 409 || detail?.kind === 'revision_conflict'
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function unitRatio(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(1, value) : undefined
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${compactScale(value / 1_000_000, value >= 10_000_000)}M`
  if (value >= 1_000) return `${compactScale(value / 1_000, value >= 100_000)}K`
  return String(Math.round(value))
}

function compactScale(value: number, whole: boolean): string {
  return whole || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)
}

function isTextEntryTarget(target: EventTarget | null | undefined): boolean {
  const element = target as { readonly nodeName?: string; readonly isContentEditable?: boolean } | null | undefined
  const name = element?.nodeName?.toLocaleLowerCase()
  return name === 'input' || name === 'textarea' || name === 'select' || element?.isContentEditable === true
}

function readPanelWidthPreference(): PanelWidths {
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight
  const fallback = defaultPanelWidths(viewportWidth, viewportHeight)
  try {
    const parsed = parsePanelWidths(globalThis.localStorage?.getItem(PANEL_WIDTH_STORAGE_KEY), fallback)
    return viewportWidth <= PANEL_RESIZE_DESKTOP_BREAKPOINT ? parsed : fitPanelWidths(parsed, viewportWidth)
  } catch {
    // Hardened WebViews may deny storage access; resizing must still work for this run.
    return viewportWidth <= PANEL_RESIZE_DESKTOP_BREAKPOINT ? fallback : fitPanelWidths(fallback, viewportWidth)
  }
}

function writePanelWidthPreference(widths: PanelWidths): void {
  try {
    globalThis.localStorage?.setItem(PANEL_WIDTH_STORAGE_KEY, JSON.stringify(widths))
  } catch {
    // A storage failure must never break pointer or keyboard resizing.
  }
}

function readWorkSurfaceDockPreference(sessionId: string | undefined): WorkSurfaceDockPreference {
  try {
    return parseWorkSurfaceDockPreference(globalThis.localStorage?.getItem(WORK_SURFACE_DOCK_STORAGE_KEY), sessionId)
  } catch {
    // The dock is still usable for this run when a hardened WebView denies storage.
    return DEFAULT_WORK_SURFACE_DOCK
  }
}

function writeWorkSurfaceDockPreference(sessionId: string, preference: WorkSurfaceDockPreference): void {
  try {
    const previous = globalThis.localStorage?.getItem(WORK_SURFACE_DOCK_STORAGE_KEY)
    globalThis.localStorage?.setItem(
      WORK_SURFACE_DOCK_STORAGE_KEY,
      updateWorkSurfaceDockPreferenceStore(previous, sessionId, preference),
    )
  } catch {
    // A persistence failure must not hide or disable current tool results.
  }
}

function readWorkspaceGroupCollapsePreference(): readonly string[] {
  try {
    return parseCollapsedWorkspaceIds(globalThis.localStorage?.getItem(WORKSPACE_GROUP_COLLAPSE_STORAGE_KEY))
  } catch {
    // Private browsing and hardened WebViews may deny storage access.
    return []
  }
}

function writeWorkspaceGroupCollapsePreference(workspaceIds: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(WORKSPACE_GROUP_COLLAPSE_STORAGE_KEY, JSON.stringify(workspaceIds))
  } catch {
    // Collapsing must remain usable even when persistence is unavailable.
  }
}
