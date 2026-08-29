interface ReactLike {
  createElement(
    type: string | ((props?: Record<string, unknown>) => unknown),
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T
  useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void]
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void
}

interface SlotsLike {
  inject(name: string, setup: () => () => void): () => void
  register(options: { name: string; id?: string; order?: number; priority?: number }, component: unknown): () => void
}

interface Result<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly message: string }
}

interface RuntimeSnapshot {
  readonly currentSessionId?: string
  readonly sessions: Readonly<Record<string, {
    readonly state: string
    readonly completionReceipt?: { readonly outcome?: string; readonly sourceSeq?: number }
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
  readonly items: readonly {
    readonly key: string
    readonly kind: string
    readonly text: string
    readonly isError?: boolean
  }[]
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

interface MemoryLifecycleSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly memory?: {
    readonly revision: number
    readonly counts: {
      readonly active: number
      readonly global: number
      readonly project: number
      readonly forgotten: number
      readonly superseded: number
    }
    readonly entries?: readonly {
      readonly scope: 'global' | 'project'
      readonly state: 'active' | 'forgotten' | 'superseded'
    }[]
  }
}

interface HeartbeatPublicCheck {
  readonly id: string
  readonly status: string
  readonly intervalMs: number
  readonly failureCount: number
  readonly nextRunAt?: number
}

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
  readonly audit: Readonly<Record<string, unknown>>
  readonly healthPath?: string
  readonly osSandboxEnforced: false
}

export interface PluginConfirmationChallenge {
  readonly id: string
  readonly token: string
  readonly expiresAt: string
  readonly action: 'add' | 'update' | 'remove'
  readonly profile: string
  readonly packageName: string
  readonly version: string
  readonly disclosures: readonly string[]
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
  | { readonly kind: 'directory' | 'tarball'; readonly path: string }
  | { readonly kind: 'registry'; readonly spec: string }

export type PluginUiIntent =
  | { readonly action: 'add' | 'update'; readonly profile: string; readonly source: CandidateSource }
  | { readonly action: 'remove'; readonly profile: string; readonly packageName: string }

interface PluginWorkflow {
  readonly step: 'idle' | 'audited' | 'prepared' | 'completed' | 'error'
  readonly intent?: PluginUiIntent
  readonly candidate?: PublicCandidate
  readonly challenge?: PluginConfirmationChallenge
  readonly transaction?: PublicPluginTransaction
  readonly message?: string
}

interface SearchResult {
  readonly items: readonly { readonly sessionId: string; readonly snippet: string }[]
}

export interface NativeShellV6ClientContext {
  slots: SlotsLike
  agentRuntimeSession: {
    getSnapshot(): RuntimeSnapshot
    subscribe(listener: () => void): () => void
    sendTurn(input: { sessionId: string; content: string; mode: 'queue' | 'steer' }): Promise<Result<{ accepted: true }>>
    stopRun(input: { sessionId: string }): Promise<Result<{ accepted: true }>>
    forkSession(input: { sessionId: string }): Promise<Result<{ sessionId: string }>>
  }
  sessionCatalog: {
    getSnapshot(): CatalogSnapshot
    subscribe(listener: () => void): () => void
    createLooseSession(): Promise<Result<{ sessionId: string }>>
    openSession(sessionId: string): Result<{ opened: true }>
    search(query: string, signal: AbortSignal): Promise<Result<SearchResult>>
  }
  taskTimeline: {
    getSnapshot(): TimelineSnapshot
    subscribe(listener: () => void): () => void
  }
  contextGovernance: {
    getSnapshot(): ContextSnapshot
    subscribe(listener: () => void): () => void
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
    }): Promise<unknown>
  }
}

/** Convert form values into a bounded intent. Host policy remains authoritative. */
export function validatePluginIntent(input: {
  readonly action: string
  readonly profile: string
  readonly sourceKind: string
  readonly source: string
}): PluginUiIntent {
  const profile = input.profile.trim()
  if (!/^xiaoshe-managed-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(profile)) {
    throw new TypeError('目标必须是名称明确的受管非活动 Profile（xiaoshe-managed-*）')
  }
  const source = boundedText(input.source, '候选来源或包名', 2_000)
  if (input.action === 'remove') {
    if (source.length > 214) throw new TypeError('包名过长')
    return { action: 'remove', profile, packageName: source }
  }
  if (input.action !== 'add' && input.action !== 'update') {
    throw new TypeError('插件动作必须是安装、更新或卸载')
  }
  if (input.sourceKind === 'registry') {
    if (source.length > 500) throw new TypeError('Registry spec 过长')
    return { action: input.action, profile, source: { kind: 'registry', spec: source } }
  }
  if (input.sourceKind !== 'directory' && input.sourceKind !== 'tarball') {
    throw new TypeError('候选来源类型无效')
  }
  return { action: input.action, profile, source: { kind: input.sourceKind, path: source } }
}

export const inject = [
  'slots',
  'agentRuntimeSession',
  'sessionCatalog',
  'taskTimeline',
  'contextGovernance',
  'pluginGovernance',
  'userApproval',
  'memoryLifecycle',
]

export const BROWSER_BRAND_ICON_HREF = '/api/xiaoshe/candidate-v6-brand-icon?v=3a919a69c3b6f425'
const BROWSER_BRAND_ICON_ID = 'xiaoshe-candidate-v6-browser-icon'

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
  const originalIcons = new Map<HTMLLinkElement, { href: string | null; type: string | null }>()
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
      for (const icon of Array.from(doc.head.querySelectorAll<HTMLLinkElement>("link[rel~='icon']"))) {
        if (icon.id === BROWSER_BRAND_ICON_ID) continue
        if (!originalIcons.has(icon)) {
          originalIcons.set(icon, { href: icon.getAttribute('href'), type: icon.getAttribute('type') })
        }
        setAttribute(icon, 'href', BROWSER_BRAND_ICON_HREF)
        setAttribute(icon, 'type', 'image/svg+xml')
      }
      let icon = doc.getElementById(BROWSER_BRAND_ICON_ID) as HTMLLinkElement | null
      if (icon === null) {
        icon = doc.createElement('link')
        icon.id = BROWSER_BRAND_ICON_ID
        doc.head.appendChild(icon)
      }
      setAttribute(icon, 'rel', 'icon')
      setAttribute(icon, 'type', 'image/svg+xml')
      setAttribute(icon, 'href', BROWSER_BRAND_ICON_HREF)
    } finally {
      applying = false
    }
  }

  applyBrand()
  const observer = createObserver?.(applyBrand)
  observer?.observe(doc.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['href', 'rel', 'type'],
  })

  return () => {
    observer?.disconnect()
    doc.getElementById(BROWSER_BRAND_ICON_ID)?.remove()
    for (const [icon, original] of originalIcons) {
      if (original.href === null) icon.removeAttribute('href')
      else icon.setAttribute('href', original.href)
      if (original.type === null) icon.removeAttribute('type')
      else icon.setAttribute('type', original.type)
    }
    if (doc.title === '小蛇' || doc.title.endsWith(' — 小蛇') || doc.title.startsWith('小蛇 · ')) {
      doc.title = originalTitle
    }
  }
}

/** Replaced with the self-contained legacy-derived stylesheet by the build script. */
export const HERITAGE_CSS = '__XIAOSHE_V6_HERITAGE_CSS__'

/** Resolve composer keyboard intent without breaking IME or multiline input. */
export function composerKeyAction(input: {
  readonly key: string
  readonly shiftKey: boolean
  readonly isComposing: boolean
}): 'submit' | 'newline' | 'ignore' {
  if (input.key !== 'Enter') return 'ignore'
  if (input.shiftKey || input.isComposing) return 'newline'
  return 'submit'
}

/** Produce the only renderable form of a confirmation challenge; token is omitted by construction. */
export function pluginChallengePresentation(challenge: PluginConfirmationChallenge): {
  readonly heading: string
  readonly facts: readonly string[]
  readonly disclosures: readonly string[]
} {
  return {
    heading: `${challenge.action} ${challenge.packageName}@${challenge.version}`,
    facts: [
      `Profile ${challenge.profile}`,
      `到期 ${challenge.expiresAt}`,
      'OS sandbox false',
    ],
    disclosures: challenge.disclosures,
  }
}

export interface OverlayState {
  readonly side: boolean
  readonly inspector: boolean
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

/** Own a separate V6 root seat; the overlay Bundle disables the original seat. */
export function apply(
  ctx: NativeShellV6ClientContext,
  react: ReactLike = require('react') as ReactLike,
): () => void {
  const e = react.createElement

  const Shell = (): unknown => {
    const runtime = react.useSyncExternalStore(listener => ctx.agentRuntimeSession.subscribe(listener), () => ctx.agentRuntimeSession.getSnapshot())
    const catalog = react.useSyncExternalStore(listener => ctx.sessionCatalog.subscribe(listener), () => ctx.sessionCatalog.getSnapshot())
    const timeline = react.useSyncExternalStore(listener => ctx.taskTimeline.subscribe(listener), () => ctx.taskTimeline.getSnapshot())
    const context = react.useSyncExternalStore(listener => ctx.contextGovernance.subscribe(listener), () => ctx.contextGovernance.getSnapshot())
    const approvals = react.useSyncExternalStore(listener => ctx.userApproval.subscribe(listener), () => ctx.userApproval.getSnapshot())
    const memoryState = react.useSyncExternalStore(listener => ctx.memoryLifecycle.subscribe(listener), () => ctx.memoryLifecycle.getSnapshot())
    const pluginState = react.useSyncExternalStore(listener => ctx.pluginGovernance.subscribe(listener), () => ctx.pluginGovernance.getSnapshot())

    const [sideCollapsed, setSideCollapsed] = react.useState(false)
    const [inspCollapsed, setInspCollapsed] = react.useState(false)
    const [theme, setTheme] = react.useState<'light' | 'ink-jade'>('light')
    const [rightTab, setRightTab] = react.useState<'status' | 'memory' | 'system'>('status')
    const [overlayState, setOverlayState] = react.useState<OverlayState>({ side: false, inspector: false })
    const sideOverlayOpen = overlayState.side
    const inspOverlayOpen = overlayState.inspector
    const [pluginManagerOpen, setPluginManagerOpen] = react.useState(false)
    const [pluginWorkflow, setPluginWorkflow] = react.useState<PluginWorkflow>({ step: 'idle' })
    const [error, setError] = react.useState('')
    const [plugins, setPlugins] = react.useState<readonly { moduleName: string; fiberPhase: string | null }[]>([])
    const [heartbeat, setHeartbeat] = react.useState<unknown>(undefined)
    const [query, setQuery] = react.useState('')
    const [searchResults, setSearchResults] = react.useState<readonly { sessionId: string; snippet: string }[]>([])
    const [searchCoordinator] = react.useState(createSearchCoordinator((value, signal) => ctx.sessionCatalog.search(value, signal)))

    const currentId = runtime.currentSessionId
    const current = currentId === undefined ? undefined : runtime.sessions[currentId]
    const currentCatalog = currentId === undefined ? undefined : catalog.sessions[currentId]

    react.useEffect(() => {
      if (typeof document === 'undefined') return
      const observerFactory = typeof MutationObserver === 'undefined' ? undefined : (callback: () => void) => new MutationObserver(callback)
      return mountBrowserBrand(document, observerFactory)
    }, [])

    react.useEffect(() => {
      let active = true
      void ctx.pluginGovernance.listHostPlugins().then(result => {
        if (active && result.ok) setPlugins(result.value?.entries ?? [])
      }).catch(() => {})
      void ctx.pluginGovernance.refreshTransactions().catch(() => {})
      void fetch('/api/xiaoshe/heartbeat', { cache: 'no-store' })
        .then(response => response.ok ? response.json() : undefined)
        .then(value => { if (active) setHeartbeat(value) })
        .catch(() => {})
      return () => { active = false; searchCoordinator.dispose() }
    }, [searchCoordinator])

    react.useEffect(() => {
      void ctx.memoryLifecycle.refresh({
        scope: currentCatalog?.cwd === undefined ? 'global' : 'all',
        ...(currentCatalog?.cwd === undefined ? {} : { project: currentCatalog.cwd }),
        include_inactive: false,
      }).catch(() => {})
    }, [currentCatalog?.cwd])

    const createSession = async (): Promise<string | undefined> => {
      setError('')
      const result = await ctx.sessionCatalog.createLooseSession()
      if (!result.ok || result.value === undefined) { setError(result.error?.message ?? '无法新建会话'); return undefined }
      const opened = ctx.sessionCatalog.openSession(result.value.sessionId)
      if (!opened.ok) { setError(opened.error?.message ?? '新会话无法打开'); return undefined }
      return result.value.sessionId
    }

    const submit = async (event: { preventDefault(): void; currentTarget: HTMLFormElement }): Promise<void> => {
      event.preventDefault()
      setError('')
      const form = event.currentTarget
      const content = String(new FormData(form).get('content') ?? '').trim()
      if (content === '') return
      const sessionId = currentId ?? await createSession()
      if (sessionId === undefined) return
      const result = await ctx.agentRuntimeSession.sendTurn({ sessionId, content, mode: current?.state === 'running' ? 'queue' : 'steer' })
      if (!result.ok) setError(result.error?.message ?? '任务未发送')
      else form.reset()
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
      if (currentId === undefined) return
      const result = await ctx.agentRuntimeSession.stopRun({ sessionId: currentId })
      if (!result.ok) setError(result.error?.message ?? '无法停止当前任务')
    }

    const answerApproval = async (key: string, outcome: 'allowed-once' | 'rejected'): Promise<void> => {
      setError('')
      const result = await ctx.userApproval.answer(key, outcome)
      if (!result.ok) setError(result.error?.message ?? '审批响应失败')
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
        intent = validatePluginIntent({ action: String(form.get('action') ?? ''), profile: String(form.get('profile') ?? ''), sourceKind: String(form.get('sourceKind') ?? ''), source: String(form.get('source') ?? '') })
      } catch (validationError) {
        setPluginWorkflow({ step: 'error', message: validationError instanceof Error ? validationError.message : String(validationError) })
        return
      }
      setPluginWorkflow({ step: 'idle', intent, message: '正在核对 Host 事实…' })
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
    }

    const sessions = Object.values(catalog.sessions).sort((left, right) => right.updatedAt - left.updatedAt)
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const localMatches = normalizedQuery === '' ? sessions : sessions.filter(row => `${row.title ?? ''}\n${row.cwd ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
    const visibleSessions = searchResults.length === 0 ? localMatches : searchResults.flatMap(hit => {
      const row = catalog.sessions[hit.sessionId]
      return row === undefined ? [] : [{ ...row, searchSnippet: hit.snippet }]
    })
    const status = current?.state ?? 'idle'
    const receipt = current?.completionReceipt?.outcome
    const contextRow = currentId === undefined ? undefined : context.sessions[currentId]
    const memoryView = memoryPresentation(memoryState)
    const heartbeatView = heartbeatPresentation(heartbeat)
    const transactionView = pluginTransactionPresentation(pluginState)
    const approval = approvals.approvals[0]
    const mainClass = ['main', sideCollapsed ? 'side-collapsed' : '', inspCollapsed ? 'insp-collapsed' : ''].filter(Boolean).join(' ')

    return e('div', {
      className: 'xsv6-shell', 'data-xiaoshe-shell-v6': '', 'data-theme': theme,
      'data-runtime-state': status, 'data-side-overlay': sideOverlayOpen, 'data-insp-overlay': inspOverlayOpen,
      onKeyDown: (event: { key: string }) => { if (event.key === 'Escape') closeOverlays() },
    },
    e('style', null, HERITAGE_CSS),
    e('div', { className: 'app' },
      e('div', { className: mainClass },
        renderSide(e, {
          collapsed: sideCollapsed, overlayOpen: sideOverlayOpen, query, sessions: visibleSessions,
          currentId, status, onCreate: () => { void createSession() },
          onProject: () => setError('当前公开服务尚未提供项目创建；会话仍可按工作区归类。'),
          onQuery: value => { setQuery(value); if (value.trim() === '') setSearchResults([]) },
          onSearch: value => { void search(value) },
          onOpen: sessionId => {
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
        e('section', { className: 'chat', 'aria-label': '对话区' },
          e('header', { className: 'chat-head' },
            e('h1', null, currentCatalog?.title ?? '新会话'),
            e('span', { className: 'meta' }, currentCatalog?.cwd ?? '项目外任务'),
            e('div', { className: 'right' },
              e('span', { className: `live ${status === 'running' ? 'busy' : ''}`, role: 'status' }, e('i', null), receipt === undefined ? statusLabel(status) : `${statusLabel(status)} · ${receiptLabel(receipt)}`),
              e('span', null, '停滞 0 · 拒绝 0'),
              e('span', null, contextRow === undefined ? '—' : compact(contextRow.budget ?? contextRow.pressure))),
            e('button', { className: 'icbtn task-mobile-toggle', type: 'button', 'aria-controls': 'xsv6-side', 'aria-expanded': sideOverlayOpen, onClick: () => { setSideCollapsed(false); setOverlayState(value => transitionOverlayState(value, 'toggle-side')) } }, '任务'),
            e('button', { className: 'icbtn inspector-mobile-toggle', type: 'button', 'aria-controls': 'xsv6-insp', 'aria-expanded': inspOverlayOpen, onClick: () => { setInspCollapsed(false); setOverlayState(value => transitionOverlayState(value, 'toggle-inspector')) } }, icon(e, 'brain'), e('span', null, '状态面板')),
            status === 'running' ? e('button', { className: 'icbtn stop-run', type: 'button', onClick: () => { void stopRun() }, title: '停止当前任务' }, icon(e, 'stop')) : null,
            e('button', { className: 'theme-toggle', type: 'button', 'aria-label': theme === 'light' ? '切换为暗色主题' : '切换为亮色主题', title: '切换主题（云白薄荷/暗夜影院）', onClick: () => setTheme(value => value === 'light' ? 'ink-jade' : 'light') }, theme === 'light' ? icon(e, 'moon') : icon(e, 'sun'))),
          e('div', { className: 'stream', 'data-empty': timeline.items.length === 0, 'aria-live': 'polite' },
            timeline.items.length === 0 ? renderEmptyStage(e) : e('div', { className: 'events' }, ...timeline.items.map(item => e('article', { className: `event event-${item.kind}`, key: item.key, 'data-kind': item.kind, 'data-error': item.isError === true }, e('span', { className: 'event-label' }, eventLabel(item.kind)), e('div', { className: 'event-body' }, item.text)))),
            approval === undefined ? null : renderApproval(e, approval, answerApproval)),
          e('footer', { className: 'composer' },
            error === '' ? null : e('p', { className: 'composer-error', role: 'alert' }, error),
            e('form', { className: 'cbox', onSubmit: (event: unknown) => { void submit(event as { preventDefault(): void; currentTarget: HTMLFormElement }) } },
              e('textarea', {
                name: 'content', rows: 1, disabled: approval !== undefined,
                placeholder: approval === undefined ? '交代小蛇做事…' : '请先处理当前审批',
                'aria-label': '输入消息',
                onKeyDown: (event: {
                  key: string
                  shiftKey: boolean
                  nativeEvent?: { readonly isComposing?: boolean }
                  preventDefault(): void
                  currentTarget: HTMLTextAreaElement
                }) => {
                  const action = composerKeyAction({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent?.isComposing === true,
                  })
                  if (action === 'submit') {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                },
              }),
              e('div', { className: 'cbtns' },
                e('button', { className: 'icbtn', type: 'button', disabled: true, title: '图片入口由桌面能力插件提供' }, icon(e, 'image')),
                e('button', { className: 'pill locked', type: 'button', disabled: true, title: '执行范围由当前会话工作区决定' }, e('span', { className: 'pill-dot' }), e('span', { className: 'pill-text' }, '项目内执行')),
                e('button', { className: 'icbtn', type: 'button', title: '命令面板暂未接入' }, icon(e, 'command')),
                e('button', { className: 'send', type: 'submit', disabled: approval !== undefined, title: current?.state === 'running' ? '加入队列' : '发送', 'aria-label': current?.state === 'running' ? '加入队列' : '发送' }, icon(e, 'send')))),
            e('div', { className: 'hint' }, e('span', null, 'Enter 发送 · Shift+Enter 换行'), e('span', null, `上下文 ${compact(contextRow?.budget) || '—'}`), e('span', null, `工具 0/60 · ${statusLabel(status)}`), e('span', null, 'y/n/a/p 审批')))),
        renderInspector(e, {
          collapsed: inspCollapsed, overlayOpen: inspOverlayOpen, tab: rightTab, receipt,
          receiptSeq: current?.completionReceipt?.sourceSeq, contextRow, heartbeat: heartbeatView,
          approval, memory: memoryView, transactions: transactionView, plugins,
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
      renderStatusbar(e, { status, sessionId: currentId, turns: timeline.items.filter(item => item.kind === 'user').length, heartbeat: heartbeatView })),
    sideOverlayOpen || inspOverlayOpen ? e('button', { className: 'overlay-scrim', type: 'button', 'aria-label': '关闭浮层', onClick: closeOverlays }) : null,
    pluginManagerOpen ? e('div', { className: 'modal-layer', role: 'presentation', onMouseDown: closePluginManager },
      e('section', { className: 'confirm-box plugin-manager', role: 'dialog', 'aria-modal': 'true', 'aria-label': '插件管理', onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation() },
        pluginManagerPanel(e, { workflow: pluginWorkflow, busy: pluginState.pendingRequests > 0, plugins, onSubmit: beginPluginWorkflow, onPrepare: preparePluginIntent, onConfirm: confirmPluginChange, onReset: resetPluginWorkflow, onClose: closePluginManager }))) : null)
  }

  return ctx.slots.inject('root', () => ctx.slots.register({ name: 'root', id: 'xiaoshe-native-shell-candidate-v6', priority: -1110 }, Shell))
}

function renderSide(e: ReactLike['createElement'], options: {
  readonly collapsed: boolean; readonly overlayOpen: boolean; readonly query: string
  readonly sessions: readonly { readonly sessionId: string; readonly title?: string; readonly cwd?: string; readonly searchSnippet?: string }[]
  readonly currentId: string | undefined; readonly status: string; readonly onCreate: () => void; readonly onProject: () => void
  readonly onQuery: (value: string) => void; readonly onSearch: (value: string) => void
  readonly onOpen: (sessionId: string) => void; readonly onCollapse: () => void
}): unknown {
  return e('aside', { id: 'xsv6-side', className: `side${options.collapsed ? ' collapsed' : ''}${options.overlayOpen ? ' mobile-open' : ''}`, 'aria-label': '侧栏' },
    e('div', { className: 'brand' }, brandMark(e), e('div', { className: 'brand-copy' }, e('div', { className: 'bt' }, '小蛇'), e('div', { className: 'bs' }, 'HARNESS · ATELIER'))),
    e('div', { className: 'side-sec' }, e('span', null, '会话'), e('span', { className: 'side-acts' }, e('button', { className: 'mini-btn primary-session', type: 'button', onClick: options.onCreate }, '＋ 新会话'), e('button', { className: 'mini-btn', type: 'button', onClick: options.onProject }, '＋ 项目'))),
    e('label', { className: 'side-search' }, e('span', { className: 'visually-hidden' }, '搜索会话与项目'), e('input', { type: 'search', value: options.query, placeholder: '搜索会话/项目…', autoComplete: 'off', onChange: (event: { currentTarget: HTMLInputElement }) => options.onQuery(event.currentTarget.value), onKeyDown: (event: { key: string; preventDefault(): void; currentTarget: HTMLInputElement }) => { if (event.key === 'Enter') { event.preventDefault(); options.onSearch(event.currentTarget.value) } } })),
    e('nav', { className: 'sess-list', 'aria-label': '会话列表' }, e('div', { className: 'group-label' }, '未分组'), ...options.sessions.map(row => e('button', { className: `sess${row.sessionId === options.currentId ? ' on' : ''}`, type: 'button', key: row.sessionId, onClick: () => options.onOpen(row.sessionId) }, e('div', { className: 't1' }, e('span', { className: `session-indicator${row.sessionId === options.currentId && options.status === 'running' ? ' running' : ''}` }), e('span', { className: 'prev' }, row.title ?? '未命名任务')), e('div', { className: 't2' }, row.searchSnippet ?? row.cwd ?? '项目外任务')))),
    e('div', { className: 'side-foot' }, e('button', { className: 'cmd', type: 'button' }, ':todos'), ' · ', e('button', { className: 'cmd', type: 'button' }, ':memory'), ' · ', e('button', { className: 'cmd', type: 'button' }, ':skills'), e('br', null), e('button', { className: 'cmd', type: 'button' }, ':notes'), ' · ', e('button', { className: 'cmd', type: 'button' }, 'resume'), e('div', { className: 'sc-tip' }, e('span', { className: 'sc-key' }, 'Ctrl K'), ' 打开命令面板')),
    collapseButton(e, options.collapsed ? '展开侧栏' : '收缩侧栏', 'left', options.collapsed, options.onCollapse))
}

function renderInspector(e: ReactLike['createElement'], options: {
  readonly collapsed: boolean; readonly overlayOpen: boolean; readonly tab: 'status' | 'memory' | 'system'
  readonly receipt: string | undefined; readonly receiptSeq: number | undefined; readonly contextRow: ContextSnapshot['sessions'][string] | undefined
  readonly heartbeat: { readonly status: string; readonly detail: string; readonly running: boolean }
  readonly approval: { readonly key: string; readonly toolName: string; readonly reason?: string } | undefined
  readonly memory: { readonly value: string; readonly detail: string }; readonly transactions: { readonly total: number; readonly detail: string }
  readonly plugins: readonly { readonly moduleName: string; readonly fiberPhase: string | null }[]; readonly pendingRequests: number
  readonly onTab: (tab: 'status' | 'memory' | 'system') => void; readonly onCollapse: () => void; readonly onManage: () => void
}): unknown {
  return e('aside', { id: 'xsv6-insp', className: `insp${options.collapsed ? ' collapsed' : ''}${options.overlayOpen ? ' mobile-open' : ''}`, 'aria-label': '状态面板' },
    collapseButton(e, options.collapsed ? '展开状态面板' : '收缩状态面板', 'right', options.collapsed, options.onCollapse),
    e('div', { className: 'insp-head', role: 'tablist' }, tabButton(e, '状态', 'status', options.tab, options.onTab), tabButton(e, '记忆', 'memory', options.tab, options.onTab), tabButton(e, '系统', 'system', options.tab, options.onTab)),
    e('div', { className: 'insp-body' },
      e('section', { className: `panel${options.tab === 'status' ? ' on' : ''}`, role: 'tabpanel', hidden: options.tab !== 'status' },
        panelSection(e, '任务清单', '当前任务', options.receipt === undefined ? '运行事实尚未形成终态凭证' : `${receiptLabel(options.receipt)} · 来源 ${options.receiptSeq ?? '—'}`, options.receipt === 'verified' ? 'ok' : undefined, { 'data-receipt-outcome': options.receipt ?? 'none' }),
        panelSection(e, '上下文', options.contextRow === undefined ? '暂无当前会话上下文' : '预算与构成已连接', compact(options.contextRow?.budget ?? options.contextRow?.pressure) || '等待运行事实'),
        panelSection(e, '后台任务', options.heartbeat.status, options.heartbeat.detail),
        panelSection(e, '行动与审批', options.approval === undefined ? '当前无待审批行动' : `等待确认 · ${options.approval.toolName}`, options.approval?.reason ?? '权限策略由运行时强制', options.approval === undefined ? undefined : 'warn')),
      e('section', { className: `panel${options.tab === 'memory' ? ' on' : ''}`, role: 'tabpanel', hidden: options.tab !== 'memory' }, panelSection(e, '记忆', options.memory.value, options.memory.detail), panelSection(e, '记忆边界', '全局与项目分区', '切换会话不会伪造共享记忆。')),
      e('section', { className: `panel${options.tab === 'system' ? ' on' : ''}`, role: 'tabpanel', hidden: options.tab !== 'system' }, panelSection(e, '能力中心', 'Product 服务已连接', '会话 · 时间线 · 审批 · 凭证 · 心跳 · 记忆 · 插件治理'), panelSection(e, '插件事务', `${options.transactions.total} 笔受控变更`, `${options.transactions.detail}\n${options.plugins.length} 个 Host 插件`, options.pendingRequests > 0 ? 'warn' : undefined), e('button', { className: 'manager-toggle', type: 'button', onClick: options.onManage }, '管理插件'), e('div', { className: 'reality-note' }, e('b', null, '现实边界：'), 'Host 插件是受信任进程内代码，没有 OS 沙箱。'))))
}

function renderStatusbar(e: ReactLike['createElement'], options: { readonly status: string; readonly sessionId: string | undefined; readonly turns: number; readonly heartbeat: { readonly running: boolean } }): unknown {
  return e('footer', { className: 'statusbar' }, e('span', { className: options.status === 'blocked' ? 'warn' : 'ok' }, `● ${statusLabel(options.status)}`), e('span', null, options.sessionId ?? '—'), e('span', null, `轮次 ${options.turns}`), e('span', null, 'denied 0'), e('div', { className: 'r' }, e('span', null, `jobs ${options.heartbeat.running ? 1 : 0}`), e('span', null, 'subagent 0'), e('span', null, '小蛇 UI · 候选 V6')))
}

function renderEmptyStage(e: ReactLike['createElement']): unknown {
  return e('div', { className: 'stage-empty' }, e('svg', { className: 'stage-ghost', viewBox: '0 0 256 256', 'aria-hidden': 'true' }, e('image', { href: BROWSER_BRAND_ICON_HREF, width: '256', height: '256' })), e('div', { className: 'stage-badge' }, '小蛇待命 · DESKTOP AGENT'), e('div', { className: 'stage-word' }, '小蛇'), e('p', { className: 'stage-sub' }, '看懂你的屏幕，接手电脑里的任务；关键操作先确认，完成后给出验证。'), e('div', { className: 'stage-chips' }, e('span', { className: 'chip' }, '看得见桌面'), e('span', { className: 'chip' }, '真能动手做'), e('span', { className: 'chip' }, '关键操作可控')))
}

function renderApproval(e: ReactLike['createElement'], approval: { readonly key: string; readonly toolName: string; readonly reason?: string }, answer: (key: string, outcome: 'allowed-once' | 'rejected') => Promise<void>): unknown {
  return e('section', { className: 'approval', role: 'dialog', 'aria-label': '行动审批' }, e('div', { className: 'ap-head' }, e('span', { className: 'ap-tool' }, approval.toolName), e('span', { className: 'ap-risk' }, '需要确认')), e('p', { className: 'ap-note' }, approval.reason ?? '这项行动需要你明确决定。'), e('div', { className: 'ap-acts' }, e('button', { className: 'ap-btn', type: 'button', onClick: () => { void answer(approval.key, 'rejected') } }, e('b', null, 'n'), ' 拒绝'), e('button', { className: 'ap-btn primary', type: 'button', onClick: () => { void answer(approval.key, 'allowed-once') } }, e('b', null, 'y'), ' 仅允许一次')))
}

function pluginManagerPanel(e: ReactLike['createElement'], options: {
  readonly workflow: PluginWorkflow; readonly busy: boolean; readonly plugins: readonly { readonly moduleName: string; readonly fiberPhase: string | null }[]
  readonly onSubmit: (event: { preventDefault(): void; currentTarget: HTMLFormElement }) => Promise<void>
  readonly onPrepare: (intent: PluginUiIntent, candidate?: PublicCandidate) => Promise<void>; readonly onConfirm: () => Promise<void>
  readonly onReset: () => void; readonly onClose: () => void
}): unknown {
  const workflow = options.workflow
  const showForm = workflow.step === 'idle' || workflow.step === 'error'
  return e('div', { className: 'plugin-manager-body' },
    e('div', { className: 'confirm-title' }, '受控插件管理'),
    e('div', { className: 'confirm-body' }, e('p', null, '只允许受管非活动 Profile。先审计事实，再生成十分钟一次性确认。'), e('p', { className: 'confirm-note' }, 'Host 插件是受信任代码，没有 OS 沙箱；本界面不会生成或执行任意命令。')),
    workflow.step === 'error' ? e('p', { className: 'manager-error', role: 'alert' }, workflow.message ?? '插件操作失败') : null,
    showForm ? e('form', { id: 'xsv6-plugin-form', className: 'manager-form', onSubmit: (event: unknown) => { void options.onSubmit(event as { preventDefault(): void; currentTarget: HTMLFormElement }) } },
      e('label', { className: 'confirm-field' }, '动作', e('select', { name: 'action', defaultValue: 'add', disabled: options.busy }, e('option', { value: 'add' }, '安装'), e('option', { value: 'update' }, '更新'), e('option', { value: 'remove' }, '卸载'))),
      e('label', { className: 'confirm-field' }, '候选来源', e('select', { name: 'sourceKind', defaultValue: 'registry', disabled: options.busy }, e('option', { value: 'registry' }, 'Registry spec'), e('option', { value: 'tarball' }, '本地 tarball'), e('option', { value: 'directory' }, '本地目录'))),
      e('label', { className: 'confirm-field' }, '来源或卸载包名', e('input', { name: 'source', required: true, maxLength: 2_000, placeholder: '@scope/plugin@1.0.0', disabled: options.busy })),
      e('label', { className: 'confirm-field' }, '目标 Profile', e('input', { name: 'profile', required: true, maxLength: 80, defaultValue: 'xiaoshe-managed-lab', pattern: 'xiaoshe-managed-[a-z0-9-]+', disabled: options.busy }))) : null,
    workflow.step === 'audited' && workflow.candidate !== undefined && workflow.intent !== undefined ? e('div', { className: 'candidate-facts' }, e('b', null, `${workflow.candidate.packageName}@${workflow.candidate.version}`), e('span', null, `SHA256 ${abbreviateHash(workflow.candidate.sha256)}`), e('span', null, `manifest ${abbreviateHash(workflow.candidate.manifestSha256)}`), e('span', null, `risk ${String(workflow.candidate.audit.risk ?? 'unknown')} · OS sandbox false`)) : null,
    workflow.step === 'prepared' && workflow.challenge !== undefined
      ? renderPluginChallenge(e, pluginChallengePresentation(workflow.challenge))
      : null,
    workflow.step === 'completed' && workflow.transaction !== undefined ? e('div', { className: 'candidate-facts' }, e('b', null, `${workflow.transaction.packageName}@${workflow.transaction.version}`), e('span', null, `${workflow.transaction.action} · ${workflow.transaction.state}`), e('span', null, `consent confirmed ${workflow.transaction.consent.confirmed} · OS sandbox false`)) : null,
    e('details', { className: 'plugin-inventory' }, e('summary', null, `Host 清单 ${options.plugins.length}`), e('pre', null, options.plugins.length === 0 ? '清单为空或仍在读取' : options.plugins.slice(0, 40).map(item => `${item.moduleName} [${item.fiberPhase ?? '未观测'}]`).join('\n'))),
    e('div', { className: 'confirm-acts' },
      e('button', { className: 'confirm-cancel', type: 'button', onClick: options.onClose }, '关闭'),
      workflow.step === 'audited' && workflow.intent !== undefined ? e('button', { className: 'confirm-go', type: 'button', disabled: options.busy, onClick: () => { void options.onPrepare(workflow.intent!, workflow.candidate) } }, '准备一次性确认') : null,
      workflow.step === 'prepared' ? e('button', { className: 'confirm-go danger', type: 'button', disabled: options.busy, onClick: () => { void options.onConfirm() } }, '确认并执行一次') : null,
      workflow.step === 'completed' ? e('button', { className: 'confirm-go', type: 'button', onClick: options.onReset }, '继续管理') : null,
      showForm ? e('button', { className: 'confirm-go', type: 'submit', form: 'xsv6-plugin-form', disabled: options.busy }, options.busy ? '正在核对…' : '审计并核对') : null))
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

function tabButton(e: ReactLike['createElement'], label: string, value: 'status' | 'memory' | 'system', current: 'status' | 'memory' | 'system', onTab: (value: 'status' | 'memory' | 'system') => void): unknown {
  return e('button', { className: `itab${value === current ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': value === current, onClick: () => onTab(value) }, label)
}

function collapseButton(e: ReactLike['createElement'], label: string, direction: 'left' | 'right', collapsed: boolean, onClick: () => void): unknown {
  return e('button', { className: 'collapse-btn', type: 'button', title: label, 'aria-label': label, 'aria-expanded': !collapsed, onClick }, e('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, e('path', { d: direction === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6' })))
}

function brandMark(e: ReactLike['createElement']): unknown {
  return e('svg', { className: 'brand-mark', role: 'img', 'aria-label': '小蛇', viewBox: '0 0 24 24', fill: 'none' }, e('defs', null, e('mask', { id: 'xsv6-pupil-brand' }, e('rect', { width: '24', height: '24', fill: '#fff' }), e('path', { d: 'M14.7 5.1Q14.7 4.4 15.4 4.4H16.6Q17.3 4.4 17.3 5.1V6.1L16.4 7H15.4Q14.7 7 14.7 6.3Z', fill: '#000' }), e('rect', { x: '17.1', y: '5.425', width: '6.9', height: '.55', fill: '#000' })), e('linearGradient', { id: 'xsv6-brand-sheen', x1: '3', y1: '20', x2: '21', y2: '4', gradientUnits: 'userSpaceOnUse' }, e('stop', { offset: '0', stopColor: 'var(--sheen-1)' }), e('stop', { offset: '.42', stopColor: 'var(--sheen-2)' }), e('stop', { offset: '.72', stopColor: 'var(--sheen-3)' }), e('stop', { offset: '1', stopColor: 'var(--sheen-4)' }))), e('path', { mask: 'url(#xsv6-pupil-brand)', stroke: 'url(#xsv6-brand-sheen)', strokeWidth: '5', strokeLinecap: 'round', d: 'M16.8 6.8C14.4 4.3 9.9 4.4 8.6 7 7.3 9.6 10.1 10.8 12.5 12 14.9 13.2 17.4 14.5 16.1 17.1 14.8 19.7 9.9 20.1 7.4 17.9' }))
}

function icon(e: ReactLike['createElement'], name: 'brain' | 'stop' | 'moon' | 'sun' | 'image' | 'command' | 'send'): unknown {
  const paths: Record<string, readonly string[]> = {
    brain: ['M12 4.5A2.8 2.8 0 0 0 9.2 7a3 3 0 0 0-2 5 3 3 0 0 0 1.6 4.8A3 3 0 0 0 12 19.5a3 3 0 0 0 3.2-2.7A3 3 0 0 0 16.8 12a3 3 0 0 0-2-5A2.8 2.8 0 0 0 12 4.5Z', 'M12 4.5v15'],
    stop: ['M7 7h10v10H7z'], moon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z'],
    sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2'],
    image: ['M3 5h18v14H3z', 'm21 15-4.5-4.5L9 18'],
    command: ['M9 9h6v6H9z', 'M9 9H7a2 2 0 1 1 2-2v2ZM15 9V7a2 2 0 1 1 2 2h-2ZM15 15h2a2 2 0 1 1-2 2v-2ZM9 15v2a2 2 0 1 1-2-2h2Z'],
    send: ['M21 3 10.5 13.5', 'm21 3-6.8 18-3.7-8.5L2 8.8 21 3Z'],
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

export function heartbeatPresentation(value: unknown): { readonly status: string; readonly detail: string; readonly running: boolean } {
  const input = record(value)
  if (input?.schemaVersion !== 2 || typeof input.status !== 'string' || typeof input.running !== 'boolean' || !Array.isArray(input.checks)) return { status: '不可用', detail: '后台状态尚未连接', running: false }
  const checks = input.checks.flatMap((item): HeartbeatPublicCheck[] => {
    const check = record(item)
    if (typeof check?.id !== 'string' || typeof check.status !== 'string' || typeof check.intervalMs !== 'number' || typeof check.failureCount !== 'number') return []
    return [{ id: check.id, status: check.status, intervalMs: check.intervalMs, failureCount: check.failureCount, ...(typeof check.nextRunAt === 'number' ? { nextRunAt: check.nextRunAt } : {}) }]
  })
  return { status: input.status, running: input.running, detail: checks.length === 0 ? '0 个检查 · 无任务运行' : checks.map(check => `${check.id} [${check.status}] · 失败 ${check.failureCount}${check.nextRunAt === undefined ? '' : ` · 下次 ${check.nextRunAt}`}`).join('\n') }
}

export function pluginTransactionPresentation(value: PluginGovernanceSnapshot): { readonly total: number; readonly detail: string } {
  const counts = new Map<string, number>()
  for (const transaction of value.transactions) counts.set(transaction.state, (counts.get(transaction.state) ?? 0) + 1)
  return { total: value.transactions.length, detail: value.status === 'error' ? `事务读取失败${value.error === undefined ? '' : `：${value.error}`}` : counts.size === 0 ? value.status === 'loading' ? '正在读取事务' : '暂无受控变更记录' : [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([state, count]) => `${state} ${count}`).join(' · ') }
}

function statusLabel(value: string): string {
  return ({ running: '正在处理', blocked: '等待确认', completed: '任务结束', idle: '已连接', blank: '新会话' } as Record<string, string>)[value] ?? value
}

function receiptLabel(value: string): string {
  return ({ verified: '已验证', partial: '部分验证', blocked: '受阻', failed: '失败', not_run: '未执行', release_held: '待发布', running: '执行中' } as Record<string, string>)[value] ?? value
}

function eventLabel(value: string): string {
  return ({ user: '你 · INPUT', assistant: '小蛇 · RESPONSE', tool: '行动 · ACTION', error: '错误 · ERROR', compaction: '上下文整理 · COMPACT', status: '验证 · VERIFY' } as Record<string, string>)[value] ?? value
}

function compact(value: unknown): string {
  if (value === undefined) return ''
  try { return JSON.stringify(value) } catch { return '不可序列化' }
}

function boundedText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.length > maxLength || /[\r\n\0]/u.test(normalized)) throw new TypeError(`${label}必须是单行有效值`)
  return normalized
}

function abbreviateHash(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 12)}…${value.slice(-8)}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
