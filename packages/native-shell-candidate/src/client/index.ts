interface ReactLike {
  createElement(type: string | ((props?: Record<string, unknown>) => unknown), props: Record<string, unknown> | null, ...children: unknown[]): unknown
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

interface PluginConfirmationChallenge {
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

type CandidateSource = { readonly kind: 'directory' | 'tarball'; readonly path: string } | { readonly kind: 'registry'; readonly spec: string }

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

export interface NativeShellCandidateClientContext {
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
    getSnapshot(): { readonly approvals: readonly { readonly key: string; readonly toolName: string; readonly callId?: string; readonly reason?: string }[] }
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
    refresh(query?: { readonly scope?: 'global' | 'project' | 'all'; readonly project?: string; readonly include_inactive?: boolean }): Promise<unknown>
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
  if (input.action !== 'add' && input.action !== 'update') throw new TypeError('插件动作必须是安装、更新或卸载')
  if (input.sourceKind === 'registry') {
    if (source.length > 500) throw new TypeError('Registry spec 过长')
    return { action: input.action, profile, source: { kind: 'registry', spec: source } }
  }
  if (input.sourceKind !== 'directory' && input.sourceKind !== 'tarball') throw new TypeError('候选来源类型无效')
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

export const BROWSER_BRAND_ICON_HREF = '/api/xiaoshe/candidate-brand-icon?v=3a919a69c3b6f425'
const BROWSER_BRAND_ICON_ID = 'xiaoshe-candidate-browser-icon'

type BrowserBrandObserverFactory = (callback: () => void) => {
  observe(target: Node, options: MutationObserverInit): void
  disconnect(): void
}

/** Keep the durable session title while replacing only the DSH product suffix. */
export function brandBrowserTitle(value: string): string {
  const current = value.trim()
  if (current === '' || /^(?:DSH Local Build|DeepSeek Harness)$/iu.test(current)) return '小蛇'
  if (current === '小蛇' || current.endsWith(' — 小蛇') || current.startsWith('小蛇 · ')) return current
  const withoutHost = current.replace(/\s*(?:—|-)\s*(?:DSH Local Build|DeepSeek Harness)$/iu, '').trim()
  return withoutHost === '' ? '小蛇' : `${withoutHost} — 小蛇`
}

/**
 * Own only browser metadata. DSH may rewrite the title or append another icon
 * after the candidate mounts, so the bounded head observer reapplies branding
 * and restores every touched value on teardown.
 */
export function mountBrowserBrand(
  doc: Document,
  createObserver?: BrowserBrandObserverFactory,
): () => void {
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

export const CANDIDATE_CSS = `
:root{--xsc-bg:#101411;--xsc-rail:#121713;--xsc-stage:#0c100e;--xsc-card:#151a17;--xsc-raised:#181e1a;--xsc-hover:#1a211c;--xsc-ink:#edf1ee;--xsc-muted:#a6ada8;--xsc-faint:#747d77;--xsc-line:rgba(255,255,255,.065);--xsc-line-strong:rgba(255,255,255,.12);--xsc-accent:#82a991;--xsc-accent-deep:#bfd5c7;--xsc-accent-bg:rgba(130,169,145,.12);--xsc-warm:#b6a674;--xsc-error:#b57b74;--xsc-sheen-1:#f0f4f1;--xsc-sheen-2:#a7d6bf;--xsc-sheen-3:#5fa17f;--xsc-sheen-4:#dbc788;--xsc-ghost-opacity:.05;--xsc-radius-sm:4px;--xsc-radius-md:8px;--xsc-radius-lg:12px;--xsc-motion-fast:120ms;--xsc-motion-med:180ms;--xsc-ease:cubic-bezier(.16,1,.3,1);--xsc-nest-width:236px;--xsc-pulse-width:292px;--xsc-content-width:800px;--xsc-reading-width:760px;--xsc-stage-gutter:clamp(28px,4vw,52px)}
.xsc-shell,.xsc-shell *{box-sizing:border-box}.xsc-shell [hidden]{display:none!important}.xsc-shell button,.xsc-shell input,.xsc-shell textarea,.xsc-shell select{font:inherit}.xsc-shell button{color:inherit}.xsc-shell{position:fixed;inset:0;z-index:30;display:grid;grid-template-columns:var(--xsc-nest-width) minmax(0,1fr) var(--xsc-pulse-width);overflow:hidden;background:var(--xsc-bg);color:var(--xsc-ink);font:14px/1.58 "PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;pointer-events:auto;transition:grid-template-columns 180ms cubic-bezier(.16,1,.3,1)}
.xsc-shell[data-nest-collapsed=true]{grid-template-columns:52px minmax(0,1fr) var(--xsc-pulse-width)}.xsc-shell[data-pulse-collapsed=true]{grid-template-columns:var(--xsc-nest-width) minmax(0,1fr) 48px}.xsc-shell[data-nest-collapsed=true][data-pulse-collapsed=true]{grid-template-columns:52px minmax(0,1fr) 48px}
.xsc-nest,.xsc-pulse{position:relative;z-index:3;display:flex;min-width:0;min-height:0;flex-direction:column;background:var(--xsc-rail)}.xsc-nest{border-right:1px solid var(--xsc-line)}.xsc-pulse{border-left:1px solid var(--xsc-line)}
.xsc-nest-head,.xsc-pulse-head{height:64px;flex:0 0 64px;display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--xsc-line)}.xsc-brand-mark,.xsc-empty-word{background:linear-gradient(115deg,var(--xsc-sheen-1) 0%,var(--xsc-sheen-2) 28%,var(--xsc-sheen-3) 48%,var(--xsc-sheen-4) 62%,var(--xsc-sheen-2) 78%,var(--xsc-sheen-1) 100%);background-size:280% 100%;animation:xsc-sheen 9s ease-in-out infinite}.xsc-brand-mark{width:29px;height:29px;flex:0 0 29px;mask:url('${BROWSER_BRAND_ICON_HREF}') center/contain no-repeat;-webkit-mask:url('${BROWSER_BRAND_ICON_HREF}') center/contain no-repeat}.xsc-brand-copy{min-width:0}.xsc-brand-copy strong{display:block;font:650 18px/1.15 "Songti SC","STSong",serif;letter-spacing:.06em}.xsc-eyebrow{font:500 11px/1.4 "PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;letter-spacing:.06em;color:var(--xsc-faint)}
.xsc-icon-button{width:32px;height:32px;display:flex;flex:0 0 32px;align-items:center;justify-content:center;padding:0;border:1px solid var(--xsc-line-strong);border-radius:var(--xsc-radius-md);background:transparent;cursor:pointer;transition:background 120ms ease,border-color 120ms ease,color 120ms ease}.xsc-icon-button:hover{border-color:var(--xsc-accent);background:var(--xsc-hover);color:var(--xsc-accent-deep)}.xsc-icon-button svg{width:14px;height:14px;stroke:currentColor;stroke-width:1.7;fill:none}.xsc-nest-head .xsc-icon-button{margin-left:auto}.xsc-pulse-head .xsc-icon-button{margin-left:auto}
.xsc-nest-body{display:flex;min-height:0;flex:1;flex-direction:column;padding:14px 12px 12px}.xsc-primary{width:100%;height:38px;border:1px solid var(--xsc-line-strong);border-radius:var(--xsc-radius-md);background:transparent;color:var(--xsc-ink)!important;font-weight:650;cursor:pointer;transition:border-color var(--xsc-motion-fast) var(--xsc-ease),background var(--xsc-motion-fast) var(--xsc-ease),transform var(--xsc-motion-fast) var(--xsc-ease)}.xsc-primary:hover{border-color:var(--xsc-accent);background:var(--xsc-hover);transform:translateY(-1px)}.xsc-primary:active{transform:translateY(0)}.xsc-primary:disabled,.xsc-quiet:disabled{cursor:not-allowed;opacity:.46}
.xsc-search{position:relative;margin:12px 0 18px}.xsc-search input{width:100%;height:34px;padding:0 40px 0 10px;border:1px solid var(--xsc-line);border-radius:var(--xsc-radius-sm);outline:0;background:transparent;color:var(--xsc-ink);font-size:12px}.xsc-search::after{content:"⌘K";position:absolute;right:10px;top:8px;color:var(--xsc-faint);font:500 11px ui-monospace,"SFMono-Regular",Consolas,monospace}.xsc-search input:focus{border-color:var(--xsc-accent)}.xsc-search input::placeholder,.xsc-compose-form textarea::placeholder{color:var(--xsc-faint)}
.xsc-section-label{display:flex;align-items:center;gap:9px;margin:0 4px 8px;color:var(--xsc-faint);font:600 11px/1.4 "PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;letter-spacing:.06em}.xsc-section-label::after{content:"";height:1px;flex:1;background:var(--xsc-line)}
.xsc-session-list{min-height:0;overflow:auto;display:grid;align-content:start;gap:1px}.xsc-session{position:relative;width:100%;display:grid;gap:3px;padding:9px 10px 9px 14px;border:0;border-radius:var(--xsc-radius-sm);background:transparent;text-align:left;cursor:pointer;transition:background var(--xsc-motion-fast) var(--xsc-ease),transform var(--xsc-motion-fast) var(--xsc-ease)}.xsc-session::before{content:"";position:absolute;left:3px;top:8px;bottom:8px;width:2px;border-radius:var(--xsc-radius-sm);background:transparent}.xsc-session:hover{background:var(--xsc-hover);transform:translateX(1px)}.xsc-session[data-current=true]{background:var(--xsc-raised)}.xsc-session[data-current=true]::before{background:var(--xsc-accent)}.xsc-session span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600}.xsc-session small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--xsc-faint);font:500 11px/1.4 ui-monospace,"SFMono-Regular",Consolas,monospace}
.xsc-nest-foot{margin-top:auto;padding:12px 4px 0;border-top:1px solid var(--xsc-line);color:var(--xsc-faint);font-size:11px}.xsc-connection{display:flex;align-items:center;gap:7px;color:var(--xsc-muted)}.xsc-connection::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--xsc-accent);animation:xsc-breathe 2.4s ease-in-out infinite}
.xsc-stage{position:relative;z-index:1;min-width:0;min-height:0;display:grid;grid-template-rows:auto 1fr auto;overflow:hidden;background:radial-gradient(circle at 50% 76%,rgba(86,125,104,.055),transparent 34%),var(--xsc-stage)}
.xsc-stage-head{min-height:104px;display:flex;align-items:center;justify-content:space-between;gap:24px;padding-block:23px 18px;padding-inline:max(var(--xsc-stage-gutter),calc((100% - var(--xsc-content-width))/2));border-bottom:1px solid var(--xsc-line)}.xsc-stage-head h1{max-width:820px;margin:4px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:520 clamp(32px,3vw,42px)/1.1 "Songti SC","STSong",serif;letter-spacing:-.025em}.xsc-head-actions{display:flex;align-items:center;gap:12px}.xsc-theme-toggle{width:32px;height:32px;display:grid;place-items:center;padding:0;border:1px solid var(--xsc-line-strong);border-radius:var(--xsc-radius-md);background:transparent;color:var(--xsc-muted);cursor:pointer;font-size:15px}.xsc-theme-toggle:hover{border-color:var(--xsc-accent);background:var(--xsc-hover);color:var(--xsc-accent-deep)}.xsc-state{display:flex;align-items:center;gap:8px;white-space:nowrap;color:var(--xsc-faint);font:500 11px/1.4 "PingFang SC","Microsoft YaHei UI",system-ui,sans-serif}.xsc-state::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--xsc-accent)}.xsc-shell[data-runtime-state=running] .xsc-state::before{animation:xsc-breathe 1.8s ease-in-out infinite}
.xsc-flow{min-height:0;overflow:auto;padding-block:26px 44px;padding-inline:max(var(--xsc-stage-gutter),calc((100% - var(--xsc-content-width))/2))}.xsc-flow[data-empty=true]{display:grid;grid-template-rows:auto minmax(0,1fr)}.xsc-trail-head{width:100%;max-width:var(--xsc-content-width);margin:0 auto 20px;display:flex;align-items:center;gap:10px;color:var(--xsc-faint);font:600 11px/1.4 "PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;letter-spacing:.06em}.xsc-trail-head::after{content:"";height:1px;flex:1;background:var(--xsc-line)}
.xsc-events{width:100%;max-width:var(--xsc-content-width);margin:0 auto;display:flex;flex-direction:column;gap:16px}.xsc-event{position:relative;max-width:min(100%,var(--xsc-reading-width));padding:12px 15px;border-left:2px solid var(--xsc-line-strong);color:var(--xsc-muted);white-space:pre-wrap;overflow-wrap:anywhere;animation:xsc-rise var(--xsc-motion-med) var(--xsc-ease) both}.xsc-event-label{display:block;margin-bottom:6px;color:var(--xsc-faint);font:600 11px/1.4 "PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;letter-spacing:.04em}.xsc-event[data-kind=user]{align-self:flex-end;max-width:min(76%,580px);padding:12px 15px;border:1px solid var(--xsc-line-strong);border-radius:var(--xsc-radius-lg);background:var(--xsc-raised);color:var(--xsc-ink)}.xsc-event[data-kind=assistant],.xsc-event[data-kind=message]{border-left:0;padding-left:0;color:var(--xsc-ink)}.xsc-event[data-kind=tool]{border:1px solid var(--xsc-line);border-radius:var(--xsc-radius-md);background:var(--xsc-card);color:var(--xsc-muted)}.xsc-event[data-kind=status],.xsc-event[data-kind=system]{padding-block:7px;color:var(--xsc-faint);font-size:12px}.xsc-event[data-error=true]{border-color:var(--xsc-error);color:var(--xsc-error)}
.xsc-empty{position:relative;align-self:center;width:min(100%,700px);max-width:700px;margin:0 auto;padding:34px 30px 46px;text-align:center;isolation:isolate}.xsc-empty-signature{position:absolute;z-index:-1;left:calc(50% + 74px);top:20px;width:198px;height:198px;opacity:var(--xsc-ghost-opacity);pointer-events:none}.xsc-empty>.xsc-eyebrow{display:inline-flex;align-items:center;gap:9px}.xsc-empty>.xsc-eyebrow::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--xsc-accent);animation:xsc-breathe 2.4s ease-in-out infinite}.xsc-empty-word{margin:16px 0 14px;font:620 clamp(62px,7vw,88px)/1 "Songti SC","STSong",serif;letter-spacing:.065em;color:transparent;background-clip:text;-webkit-background-clip:text}.xsc-empty p{max-width:560px;margin:0 auto;color:var(--xsc-muted);font-size:13px;letter-spacing:.02em}.xsc-prompts{display:flex;justify-content:center;flex-wrap:wrap;margin-top:18px;color:var(--xsc-faint);font-size:11px;letter-spacing:.04em}.xsc-prompt{position:relative;padding:0 16px}.xsc-prompt+.xsc-prompt::before{content:"";position:absolute;left:0;top:50%;width:1px;height:11px;transform:translateY(-50%);background:var(--xsc-line-strong)}
.xsc-composer{padding-block:10px 22px;padding-inline:max(var(--xsc-stage-gutter),calc((100% - var(--xsc-content-width))/2));background:var(--xsc-stage)}.xsc-composer-inner{width:100%;max-width:var(--xsc-content-width);margin:0 auto}.xsc-approval{margin-bottom:10px;padding:13px 14px;border:1px solid var(--xsc-warm);border-radius:var(--xsc-radius-md);background:var(--xsc-card)}.xsc-approval-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.xsc-approval-actions{display:flex;gap:7px}.xsc-quiet{height:32px;padding:0 11px;border:1px solid var(--xsc-line-strong);border-radius:var(--xsc-radius-sm);background:transparent;cursor:pointer;transition:border-color var(--xsc-motion-fast) var(--xsc-ease),background var(--xsc-motion-fast) var(--xsc-ease)}.xsc-quiet[data-tone=allow]{border-color:var(--xsc-accent);background:var(--xsc-accent);color:#101411}.xsc-error{margin:0 0 8px;color:var(--xsc-error);font-size:12px}.xsc-compose-form{display:grid;grid-template-columns:1fr auto;gap:8px;padding:8px;border:1px solid var(--xsc-line-strong);border-radius:var(--xsc-radius-lg);background:var(--xsc-card);transition:border-color var(--xsc-motion-fast) var(--xsc-ease),box-shadow var(--xsc-motion-fast) var(--xsc-ease)}.xsc-compose-form:focus-within{border-color:var(--xsc-accent);box-shadow:0 0 0 3px var(--xsc-accent-bg)}.xsc-compose-form textarea{min-height:60px;max-height:160px;resize:vertical;padding:10px 11px;border:0;outline:0;background:transparent;color:var(--xsc-ink)}.xsc-send{align-self:end;min-width:104px;height:42px;border:1px solid var(--xsc-line-strong);border-radius:var(--xsc-radius-md);background:var(--xsc-accent);color:#101411!important;font-weight:700;cursor:pointer;transition:background var(--xsc-motion-fast) var(--xsc-ease),transform var(--xsc-motion-fast) var(--xsc-ease),box-shadow var(--xsc-motion-fast) var(--xsc-ease)}.xsc-send:hover{background:var(--xsc-accent-deep);transform:translateY(-1px);box-shadow:0 7px 18px -12px var(--xsc-accent-deep)}.xsc-send:active{transform:translateY(0)}.xsc-send:disabled{cursor:not-allowed;opacity:.45}.xsc-compose-meta{display:flex;justify-content:space-between;margin-top:8px;color:var(--xsc-faint);font:500 11px/1.4 "PingFang SC","Microsoft YaHei UI",system-ui,sans-serif}
.xsc-pulse-head h2{margin:0;font:520 18px/1.2 "Songti SC","STSong",serif;letter-spacing:.04em}.xsc-tabs{height:40px;display:grid;grid-template-columns:repeat(3,1fr);padding:0 12px;border-bottom:1px solid var(--xsc-line)}.xsc-tab{position:relative;border:0;background:transparent;color:var(--xsc-faint);cursor:pointer;font-size:12px}.xsc-tab[aria-selected=true]{color:var(--xsc-ink)}.xsc-tab[aria-selected=true]::after{content:"";position:absolute;left:28%;right:28%;bottom:-1px;height:2px;background:var(--xsc-accent)}.xsc-pulse-body{min-height:0;overflow:auto;padding:14px 16px 24px}.xsc-tab-panel{display:grid;gap:0}.xsc-ledger{display:grid;gap:0}.xsc-ledger-section{padding:14px 1px 15px;border-bottom:1px solid var(--xsc-line);background:transparent}.xsc-ledger-section[data-tone=verified] .xsc-ledger-value{color:var(--xsc-accent-deep)}.xsc-ledger-section[data-tone=attention] .xsc-ledger-value{color:var(--xsc-warm)}.xsc-ledger-title{display:flex;align-items:center;gap:8px;margin-bottom:6px}.xsc-ledger-title strong{font-size:12px;font-weight:650}.xsc-ledger-value{font-size:13px;font-weight:600}.xsc-ledger-detail{margin-top:5px;color:var(--xsc-faint);font:500 11px/1.58 "PingFang SC","Microsoft YaHei UI",system-ui,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere}
.xsc-manager-toggle{width:100%;height:36px;margin-top:14px;border:1px solid var(--xsc-line-strong);border-radius:var(--xsc-radius-md);background:transparent;color:var(--xsc-muted);font-size:11px;font-weight:600;cursor:pointer}.xsc-manager-toggle:hover{border-color:var(--xsc-accent);background:var(--xsc-hover);color:var(--xsc-ink)}.xsc-manager{display:grid;gap:11px;margin-top:10px;padding:13px;border:1px solid var(--xsc-line);border-radius:var(--xsc-radius-lg);background:var(--xsc-card)}.xsc-manager h3{margin:0;font:520 15px/1.3 "Songti SC","STSong",serif}.xsc-manager-note{margin:0;color:var(--xsc-faint);font-size:11px}.xsc-manager-form{display:grid;gap:9px}.xsc-field{display:grid;gap:5px;color:var(--xsc-faint);font-size:11px}.xsc-field input,.xsc-field select{width:100%;height:34px;padding:0 8px;border:1px solid var(--xsc-line);border-radius:var(--xsc-radius-sm);outline:0;background:var(--xsc-stage);color:var(--xsc-ink);font-size:12px}.xsc-field input:focus,.xsc-field select:focus{border-color:var(--xsc-accent)}.xsc-manager-actions{display:flex;gap:8px}.xsc-manager-actions button{flex:1;min-height:34px;padding:6px 8px;border:1px solid var(--xsc-line-strong);border-radius:var(--xsc-radius-sm);background:transparent;cursor:pointer;font-size:11px}.xsc-manager-actions button[data-primary=true]{border-color:var(--xsc-accent);background:var(--xsc-accent);color:#101411}.xsc-manager-actions button[data-danger=true]{border-color:var(--xsc-error);color:var(--xsc-error)}.xsc-manager-actions button:disabled{cursor:not-allowed;opacity:.48}.xsc-candidate-facts{padding:10px;border:1px dashed var(--xsc-line-strong);border-radius:var(--xsc-radius-sm);background:var(--xsc-stage);font:500 11px/1.58 ui-monospace,"SFMono-Regular",Consolas,monospace;overflow-wrap:anywhere}.xsc-disclosures{margin:0;padding-left:18px;color:var(--xsc-faint);font-size:11px}.xsc-disclosures li+li{margin-top:5px}.xsc-inventory summary{cursor:pointer;color:var(--xsc-faint);font-size:11px}.xsc-inventory-list{max-height:140px;overflow:auto;margin-top:7px;padding:8px;border-top:1px dashed var(--xsc-line);color:var(--xsc-faint);font:500 11px/1.65 ui-monospace,"SFMono-Regular",Consolas,monospace}.xsc-reality{margin-top:14px;padding:13px 1px 0;border-top:1px solid var(--xsc-line);color:var(--xsc-faint);font-size:11px}.xsc-reality strong{display:block;margin-bottom:4px;color:var(--xsc-muted)}
.xsc-shell[data-nest-collapsed=true] .xsc-nest-head{height:auto;min-height:100px;flex-direction:column;padding:16px 8px}.xsc-shell[data-nest-collapsed=true] .xsc-brand-copy,.xsc-shell[data-nest-collapsed=true] .xsc-nest-body{display:none}.xsc-shell[data-nest-collapsed=true] .xsc-nest-head .xsc-icon-button{margin:0}.xsc-shell[data-pulse-collapsed=true] .xsc-pulse-head{padding:16px 8px;justify-content:center}.xsc-shell[data-pulse-collapsed=true] .xsc-pulse-head h2,.xsc-shell[data-pulse-collapsed=true] .xsc-tabs,.xsc-shell[data-pulse-collapsed=true] .xsc-pulse-body{display:none}.xsc-shell[data-pulse-collapsed=true] .xsc-pulse-head .xsc-icon-button{margin:0}.xsc-vh{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}.xsc-shell :focus-visible{outline:2px solid var(--xsc-accent);outline-offset:2px}
.xsc-shell[data-theme=dark]{--xsc-bg:#101411;--xsc-rail:#121713;--xsc-stage:#0c100e;--xsc-card:#151a17;--xsc-raised:#181e1a;--xsc-hover:#1a211c;--xsc-ink:#edf1ee;--xsc-muted:#a6ada8;--xsc-faint:#747d77;--xsc-line:rgba(255,255,255,.065);--xsc-line-strong:rgba(255,255,255,.12);--xsc-accent:#82a991;--xsc-accent-deep:#bfd5c7;--xsc-accent-bg:rgba(130,169,145,.12);--xsc-warm:#b6a674;--xsc-error:#b57b74}
.xsc-shell[data-theme=light]{--xsc-bg:#f4f6f4;--xsc-rail:#f0f3f0;--xsc-stage:#fbfcfb;--xsc-card:#fff;--xsc-raised:#e8ede9;--xsc-hover:#e9eeea;--xsc-ink:#1c211e;--xsc-muted:#555f59;--xsc-faint:#778079;--xsc-line:rgba(28,33,30,.08);--xsc-line-strong:rgba(28,33,30,.15);--xsc-accent:#678775;--xsc-accent-deep:#395946;--xsc-accent-bg:rgba(75,111,90,.1);--xsc-warm:#8b7652;--xsc-error:#925e58;--xsc-sheen-1:#23362d;--xsc-sheen-2:#4f8069;--xsc-sheen-3:#9cc2b1;--xsc-sheen-4:#d7c27f;--xsc-ghost-opacity:.065}.xsc-shell[data-theme=light] .xsc-send{background:#26342c;color:#fff!important}.xsc-shell[data-theme=light] .xsc-send:hover{background:#19241e}
@keyframes xsc-sheen{0%,100%{background-position:0% 0}50%{background-position:100% 0}}
@keyframes xsc-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.38;transform:scale(.82)}}
@keyframes xsc-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media(min-width:1600px){.xsc-shell{--xsc-nest-width:clamp(244px,15vw,264px);--xsc-pulse-width:clamp(304px,18vw,328px);--xsc-content-width:clamp(920px,58vw,1040px);--xsc-reading-width:900px;--xsc-stage-gutter:clamp(48px,3vw,64px)}.xsc-event[data-kind=user]{max-width:min(72%,680px)}}
@media(min-width:2200px){.xsc-shell{--xsc-nest-width:264px;--xsc-pulse-width:328px;--xsc-content-width:1080px;--xsc-reading-width:920px;font-size:15px}.xsc-eyebrow,.xsc-state,.xsc-section-label,.xsc-compose-meta,.xsc-ledger-detail,.xsc-session small{font-size:12px}.xsc-session span,.xsc-ledger-value{font-size:14px}.xsc-empty p{font-size:14px}.xsc-prompts{font-size:12px}.xsc-tab{font-size:13px}}
@media(max-width:1180px){.xsc-shell{--xsc-nest-width:204px;--xsc-pulse-width:276px;--xsc-stage-gutter:28px}}
@media(max-width:860px){.xsc-shell,.xsc-shell[data-nest-collapsed=true],.xsc-shell[data-pulse-collapsed=true],.xsc-shell[data-nest-collapsed=true][data-pulse-collapsed=true]{grid-template-columns:52px minmax(0,1fr)}.xsc-brand-copy,.xsc-nest-body{display:none}.xsc-nest-head{height:auto;min-height:100px;flex-direction:column;padding:16px 8px}.xsc-nest-head .xsc-icon-button{margin:0}.xsc-pulse{position:absolute;z-index:8;top:0;right:0;bottom:0;width:min(292px,calc(100vw - 52px));box-shadow:-12px 0 36px rgba(0,0,0,.24);transition:transform 180ms cubic-bezier(.16,1,.3,1)}.xsc-shell[data-pulse-collapsed=true] .xsc-pulse{transform:translateX(calc(100% - 48px))}.xsc-stage-head{min-height:88px}.xsc-stage-head h1{font-size:27px}.xsc-state span{display:none}}
@media(max-width:620px){.xsc-stage-head{padding:18px 16px 14px}.xsc-flow{padding:18px 14px 32px}.xsc-composer{padding:8px 12px 14px}.xsc-compose-form{grid-template-columns:1fr}.xsc-send{width:100%}.xsc-event[data-kind=user]{max-width:92%}.xsc-empty{padding-inline:10px}.xsc-empty-signature{width:150px;height:150px;left:calc(50% + 34px)}.xsc-empty-word{font-size:56px}.xsc-prompt{padding:0 10px}.xsc-compose-meta{display:none}}
@media(prefers-reduced-motion:reduce){.xsc-shell,.xsc-icon-button,.xsc-pulse,.xsc-compose-form{transition:none!important}.xsc-shell *,.xsc-shell *::before,.xsc-shell *::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
`

/**
 * Abort the previous query before starting the next one and permanently close
 * the coordinator on unmount. This prevents stale search results from winning.
 */
export function createSearchCoordinator(
  execute: (query: string, signal: AbortSignal) => Promise<Result<SearchResult>>,
): {
  search(query: string): Promise<Result<SearchResult>>
  dispose(): void
} {
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

/** Own a separate candidate root seat; the overlay Bundle disables the original seat. */
export function apply(
  ctx: NativeShellCandidateClientContext,
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
    const [nestCollapsed, setNestCollapsed] = react.useState(false)
    const [pulseCollapsed, setPulseCollapsed] = react.useState(false)
    const [darkTheme, setDarkTheme] = react.useState(true)
    const [rightTab, setRightTab] = react.useState<'status' | 'memory' | 'system'>('status')
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
      const observerFactory = typeof MutationObserver === 'undefined'
        ? undefined
        : (callback: () => void) => new MutationObserver(callback)
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
      if (!result.ok || result.value === undefined) {
        setError(result.error?.message ?? '无法新建会话')
        return undefined
      }
      const opened = ctx.sessionCatalog.openSession(result.value.sessionId)
      if (!opened.ok) {
        setError(opened.error?.message ?? '新会话无法打开')
        return undefined
      }
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
      const result = await ctx.agentRuntimeSession.sendTurn({
        sessionId,
        content,
        mode: current?.state === 'running' ? 'queue' : 'steer',
      })
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
        intent = validatePluginIntent({
          action: String(form.get('action') ?? ''),
          profile: String(form.get('profile') ?? ''),
          sourceKind: String(form.get('sourceKind') ?? ''),
          source: String(form.get('source') ?? ''),
        })
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

    const sessions = Object.values(catalog.sessions).sort((left, right) => right.updatedAt - left.updatedAt)
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const localMatches = normalizedQuery === ''
      ? sessions
      : sessions.filter(row => `${row.title ?? ''}\n${row.cwd ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
    const visibleSessions = searchResults.length === 0
      ? localMatches
      : searchResults.flatMap(hit => {
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

    return e('div', {
      className: 'xsc-shell',
      'data-xiaoshe-shell-candidate': '',
      'data-runtime-state': status,
      'data-nest-collapsed': nestCollapsed,
      'data-pulse-collapsed': pulseCollapsed,
      'data-theme': darkTheme ? 'dark' : 'light',
    },
    e('style', null, CANDIDATE_CSS),
    e('aside', { className: 'xsc-nest', 'aria-label': '会话' },
      e('header', { className: 'xsc-nest-head' },
        e('span', { className: 'xsc-brand-mark', role: 'img', 'aria-label': '小蛇' }),
        e('div', { className: 'xsc-brand-copy' }, e('strong', null, '小蛇'), e('div', { className: 'xsc-eyebrow' }, 'HARNESS · ATELIER')),
        railButton(e, nestCollapsed ? '展开会话栏' : '收起会话栏', nestCollapsed ? 'right' : 'left', nestCollapsed, () => setNestCollapsed(value => !value))),
      e('div', { className: 'xsc-nest-body' },
        e('button', { className: 'xsc-primary', type: 'button', onClick: () => { void createSession() } }, '＋ 新会话'),
        e('label', { className: 'xsc-search' },
          e('span', { className: 'xsc-vh' }, '搜索会话'),
          e('input', {
            type: 'search', value: query, placeholder: '搜索会话或工作区', autoComplete: 'off',
            onChange: (event: { currentTarget: HTMLInputElement }) => {
              setQuery(event.currentTarget.value)
              if (event.currentTarget.value.trim() === '') setSearchResults([])
            },
            onKeyDown: (event: { key: string; preventDefault(): void; currentTarget: HTMLInputElement }) => {
              if (event.key === 'Enter') { event.preventDefault(); void search(event.currentTarget.value) }
            },
          })),
        e('div', { className: 'xsc-section-label' }, '会话'),
        e('nav', { className: 'xsc-session-list', 'aria-label': '会话列表' }, ...visibleSessions.map(row => e('button', {
          className: 'xsc-session', type: 'button', key: row.sessionId, 'data-current': row.sessionId === currentId,
          'aria-label': `${row.title ?? '未命名任务'}，${row.cwd ?? '未归入项目'}${'searchSnippet' in row ? `，命中：${String(row.searchSnippet)}` : ''}`,
          onClick: () => { const result = ctx.sessionCatalog.openSession(row.sessionId); if (!result.ok) setError(result.error?.message ?? '会话无法打开') },
        }, e('span', null, row.title ?? '未命名任务'), e('small', null, 'searchSnippet' in row ? String(row.searchSnippet) : row.cwd ?? '未归入项目')))),
        e('footer', { className: 'xsc-nest-foot' },
          e('div', { className: 'xsc-connection' }, heartbeatView.running ? '后台任务运行中' : '已连接'),
          e('div', { className: 'xsc-eyebrow' }, `${sessions.length} 个会话 · ${statusLabel(status)}`)))),
    e('main', { className: 'xsc-stage' },
      e('header', { className: 'xsc-stage-head' },
        e('div', null,
          e('div', { className: 'xsc-eyebrow' }, currentCatalog?.cwd ?? '项目外任务'),
          e('h1', null, currentCatalog?.title ?? '从这里开始一件事')),
        e('div', { className: 'xsc-head-actions' },
          e('button', {
            className: 'xsc-theme-toggle', type: 'button',
            'aria-label': darkTheme ? '切换为亮色主题' : '切换为暗色主题',
            title: darkTheme ? '切换为云白薄荷' : '切换为暗夜影院',
            onClick: () => setDarkTheme(value => !value),
          }, e('span', { 'aria-hidden': 'true' }, darkTheme ? '☼' : '☾')),
          e('div', { className: 'xsc-state', role: 'status' },
            e('span', null, receipt === undefined ? statusLabel(status) : `${statusLabel(status)} · ${receiptLabel(receipt)}`)))),
      e('section', { className: 'xsc-flow', 'data-empty': timeline.items.length === 0, 'aria-label': '任务过程' },
        e('div', { className: 'xsc-trail-head' }, '任务过程'),
        timeline.items.length === 0
          ? e('div', { className: 'xsc-empty' },
              brandOutline(e),
              e('div', { className: 'xsc-eyebrow' }, '小蛇待命 · ATELIER'),
              e('div', { className: 'xsc-empty-word' }, '小蛇'),
              e('p', null, '说清要做的事，剩下的交给我。关键操作先确认，完成后给出验证。'),
              e('div', { className: 'xsc-prompts', 'aria-label': '任务示例' },
                e('span', { className: 'xsc-prompt' }, '整理工作区'),
                e('span', { className: 'xsc-prompt' }, '检查方案'),
                e('span', { className: 'xsc-prompt' }, '接手完成任务')))
          : e('div', { className: 'xsc-events' }, ...timeline.items.map(item => e('article', {
              className: 'xsc-event', key: item.key, 'data-kind': item.kind, 'data-error': item.isError === true,
            }, e('span', { className: 'xsc-event-label' }, eventLabel(item.kind)), item.text)))),
      e('footer', { className: 'xsc-composer' },
        e('div', { className: 'xsc-composer-inner' },
          error === '' ? null : e('p', { className: 'xsc-error', role: 'alert' }, error),
          approval === undefined ? null : e('section', { className: 'xsc-approval', role: 'dialog', 'aria-label': '行动审批' },
            e('div', { className: 'xsc-approval-head' },
              e('div', null, e('strong', null, `等待确认 · ${approval.toolName}`), e('div', { className: 'xsc-ledger-detail' }, approval.reason ?? '这项行动需要你明确决定。')),
              e('div', { className: 'xsc-approval-actions' },
                e('button', { className: 'xsc-quiet', type: 'button', onClick: () => { void answerApproval(approval.key, 'rejected') } }, '拒绝'),
                e('button', { className: 'xsc-quiet', 'data-tone': 'allow', type: 'button', onClick: () => { void answerApproval(approval.key, 'allowed-once') } }, '仅允许一次')))),
          e('form', { className: 'xsc-compose-form', onSubmit: (event: unknown) => { void submit(event as { preventDefault(): void; currentTarget: HTMLFormElement }) } },
            e('label', { className: 'xsc-vh', htmlFor: 'xsc-task-input' }, '输入任务'),
            e('textarea', { id: 'xsc-task-input', name: 'content', disabled: approval !== undefined, placeholder: approval === undefined ? currentId === undefined ? '交代小蛇做一件事…' : '继续说明，或补充约束…' : '请先处理当前审批' }),
            e('button', { className: 'xsc-send', type: 'submit', disabled: approval !== undefined }, current?.state === 'running' ? '加入队列 ↑' : '交给小蛇 ↑')),
          e('div', { className: 'xsc-compose-meta' }, e('span', null, 'Enter 发送 · Shift+Enter 换行'), e('span', null, '关键操作先确认 · 完成必须有凭证'))))),
    e('aside', { className: 'xsc-pulse', 'aria-label': '工作台' },
      e('header', { className: 'xsc-pulse-head' },
        e('h2', null, '工作台'),
        railButton(e, pulseCollapsed ? '展开工作台' : '收起工作台', pulseCollapsed ? 'left' : 'right', pulseCollapsed, () => setPulseCollapsed(value => !value))),
      e('div', { className: 'xsc-tabs', role: 'tablist', 'aria-label': '工作台页面' },
        e('button', { className: 'xsc-tab', type: 'button', role: 'tab', 'aria-selected': rightTab === 'status', onClick: () => setRightTab('status') }, '状态'),
        e('button', { className: 'xsc-tab', type: 'button', role: 'tab', 'aria-selected': rightTab === 'memory', onClick: () => setRightTab('memory') }, '记忆'),
        e('button', { className: 'xsc-tab', type: 'button', role: 'tab', 'aria-selected': rightTab === 'system', onClick: () => setRightTab('system') }, '系统')),
      e('div', { className: 'xsc-pulse-body' },
        e('section', { className: 'xsc-tab-panel', role: 'tabpanel', hidden: rightTab !== 'status' },
          e('div', { className: 'xsc-section-label' }, '当前任务'),
          e('div', { className: 'xsc-ledger' },
            ledgerSection(e, '完成凭证', receipt === undefined ? '尚未形成凭证' : receiptLabel(receipt), current?.completionReceipt?.sourceSeq === undefined ? '只有终态事实才会形成凭证' : `来源序号 ${current.completionReceipt.sourceSeq}`, receipt === 'verified' ? 'verified' : receipt === 'blocked' || receipt === 'failed' ? 'attention' : undefined, { 'data-receipt-outcome': receipt ?? 'none' }),
            ledgerSection(e, '上下文', contextRow === undefined ? '当前无会话数据' : '预算与构成已连接', compact(contextRow?.budget ?? contextRow?.pressure) || '等待会话运行事实'),
            ledgerSection(e, '心跳与后台', heartbeatView.status, heartbeatView.detail),
            ledgerSection(e, '行动与审批', approval === undefined ? '当前无待确认行动' : `等待确认 · ${approval.toolName}`, approval === undefined ? '权限策略由运行时强制' : approval.reason ?? '需要你的决定', approval === undefined ? undefined : 'attention'))),
        e('section', { className: 'xsc-tab-panel', role: 'tabpanel', hidden: rightTab !== 'memory' },
          e('div', { className: 'xsc-section-label' }, '长期记忆'),
          e('div', { className: 'xsc-ledger' }, ledgerSection(e, '可用记忆', memoryView.value, memoryView.detail)),
          e('div', { className: 'xsc-reality' }, e('strong', null, '记忆边界'), '记忆按全局与项目范围读取；切换会话不会伪造共享记忆。')),
        e('section', { className: 'xsc-tab-panel', role: 'tabpanel', hidden: rightTab !== 'system' },
          e('div', { className: 'xsc-section-label' }, '运行与扩展'),
          e('div', { className: 'xsc-ledger' },
            ledgerSection(e, '插件事务', `${transactionView.total} 笔受控变更`, `${transactionView.detail}\n${plugins.length} 个 Host 插件`, pluginState.pendingRequests > 0 ? 'attention' : undefined)),
          e('button', {
            className: 'xsc-manager-toggle', type: 'button', 'aria-expanded': pluginManagerOpen,
            onClick: () => setPluginManagerOpen(value => !value),
          }, pluginManagerOpen ? '收起插件管理' : '管理插件'),
          pluginManagerOpen ? pluginManagerPanel(e, {
            workflow: pluginWorkflow,
            busy: pluginState.pendingRequests > 0,
            plugins,
            onSubmit: beginPluginWorkflow,
            onPrepare: preparePluginIntent,
            onConfirm: confirmPluginChange,
            onReset: () => setPluginWorkflow({ step: 'idle' }),
          }) : null,
          e('div', { className: 'xsc-reality' }, e('strong', null, '现实边界'), 'Host 插件是受信任代码，没有 OS 沙箱。安装与变更需要一次性确认；本界面不会自动宣称发布或跨平台验收完成。')))))
  }

  return ctx.slots.inject('root', () => ctx.slots.register({
    name: 'root', id: 'xiaoshe-native-shell-candidate', priority: -1100,
  }, Shell))
}

/**
 * Derive the quiet hero outline from the canonical asset at runtime. The SVG
 * contains no replacement snake path: morphology extracts only the edge of
 * the approved icon served by the Host route.
 */
function brandOutline(e: ReactLike['createElement']): unknown {
  return e('svg', {
    className: 'xsc-empty-signature', viewBox: '0 0 256 256', fill: 'none',
    'aria-hidden': 'true', focusable: 'false',
  },
  e('defs', null,
    e('linearGradient', { id: 'xsc-signature-sheen', x1: '0', y1: '256', x2: '256', y2: '0', gradientUnits: 'userSpaceOnUse' },
      e('stop', { offset: '0', stopColor: 'var(--xsc-sheen-1)' }),
      e('stop', { offset: '.42', stopColor: 'var(--xsc-sheen-2)' }),
      e('stop', { offset: '.72', stopColor: 'var(--xsc-sheen-3)' }),
      e('stop', { offset: '1', stopColor: 'var(--xsc-sheen-4)' })),
    e('filter', { id: 'xsc-signature-edge', filterUnits: 'userSpaceOnUse', x: '-6', y: '-6', width: '268', height: '268' },
      e('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: '.75', result: 'outer' }),
      e('feMorphology', { in: 'SourceAlpha', operator: 'erode', radius: '.75', result: 'inner' }),
      e('feComposite', { in: 'outer', in2: 'inner', operator: 'out', result: 'outline' }),
      e('feFlood', { floodColor: '#fff', result: 'white' }),
      e('feComposite', { in: 'white', in2: 'outline', operator: 'in' })),
    e('mask', { id: 'xsc-signature-outline', maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: '256', height: '256', maskType: 'alpha' },
      e('image', { href: BROWSER_BRAND_ICON_HREF, x: '0', y: '0', width: '256', height: '256', filter: 'url(#xsc-signature-edge)' }))),
  e('rect', { width: '256', height: '256', fill: 'url(#xsc-signature-sheen)', mask: 'url(#xsc-signature-outline)' }))
}

function railButton(
  e: ReactLike['createElement'],
  label: string,
  direction: 'left' | 'right',
  pressed: boolean,
  onClick: () => void,
): unknown {
  return e('button', { className: 'xsc-icon-button', type: 'button', 'aria-label': label, 'aria-expanded': !pressed, onClick },
    e('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' },
      e('path', { d: direction === 'left' ? 'M12.5 4.5 7 10l5.5 5.5' : 'M7.5 4.5 13 10l-5.5 5.5' })))
}

function ledgerSection(
  e: ReactLike['createElement'],
  title: string,
  value: string,
  detail: string,
  tone?: 'verified' | 'attention',
  extra: Record<string, unknown> = {},
): unknown {
  return e('section', { className: 'xsc-ledger-section', ...(tone === undefined ? {} : { 'data-tone': tone }), ...extra },
    e('div', { className: 'xsc-ledger-title' }, e('strong', null, title)),
    e('div', { className: 'xsc-ledger-value' }, value),
    e('div', { className: 'xsc-ledger-detail' }, detail))
}

function pluginManagerPanel(e: ReactLike['createElement'], options: {
  readonly workflow: PluginWorkflow
  readonly busy: boolean
  readonly plugins: readonly { readonly moduleName: string; readonly fiberPhase: string | null }[]
  readonly onSubmit: (event: { preventDefault(): void; currentTarget: HTMLFormElement }) => Promise<void>
  readonly onPrepare: (intent: PluginUiIntent, candidate?: PublicCandidate) => Promise<void>
  readonly onConfirm: () => Promise<void>
  readonly onReset: () => void
}): unknown {
  const { workflow } = options
  const showForm = workflow.step === 'idle' || workflow.step === 'error'
  return e('section', { className: 'xsc-manager', 'aria-label': '插件管理' },
    e('h3', null, '受控插件管理'),
    e('p', { className: 'xsc-manager-note' }, '只允许受管非活动 Profile。先审计事实，再生成十分钟一次性确认；界面不生成或执行命令。'),
    workflow.step === 'error' ? e('p', { className: 'xsc-error', role: 'alert' }, workflow.message ?? '插件操作失败') : null,
    showForm ? e('form', { className: 'xsc-manager-form', onSubmit: (event: unknown) => { void options.onSubmit(event as { preventDefault(): void; currentTarget: HTMLFormElement }) } },
      e('label', { className: 'xsc-field' }, '动作', e('select', { name: 'action', defaultValue: 'add', disabled: options.busy },
        e('option', { value: 'add' }, '安装'), e('option', { value: 'update' }, '更新'), e('option', { value: 'remove' }, '卸载'))),
      e('label', { className: 'xsc-field' }, '候选来源', e('select', { name: 'sourceKind', defaultValue: 'registry', disabled: options.busy },
        e('option', { value: 'registry' }, 'Registry spec'), e('option', { value: 'tarball' }, '本地 tarball'), e('option', { value: 'directory' }, '本地目录'))),
      e('label', { className: 'xsc-field' }, '来源或卸载包名', e('input', { name: 'source', required: true, maxLength: 2000, placeholder: '@scope/plugin@1.0.0', disabled: options.busy })),
      e('label', { className: 'xsc-field' }, '目标 Profile', e('input', { name: 'profile', required: true, maxLength: 80, defaultValue: 'xiaoshe-managed-lab', pattern: 'xiaoshe-managed-[a-z0-9-]+', disabled: options.busy })),
      e('div', { className: 'xsc-manager-actions' }, e('button', { type: 'submit', 'data-primary': 'true', disabled: options.busy }, options.busy ? '正在核对…' : '审计并核对'))) : null,
    workflow.step === 'audited' && workflow.candidate !== undefined && workflow.intent !== undefined
      ? e('div', null,
          e('div', { className: 'xsc-candidate-facts' }, `${workflow.candidate.packageName}@${workflow.candidate.version}\nSHA256 ${abbreviateHash(workflow.candidate.sha256)}\nmanifest ${abbreviateHash(workflow.candidate.manifestSha256)}\nhealth ${workflow.candidate.healthPath ?? '未声明'}\nrisk ${String(workflow.candidate.audit.risk ?? 'unknown')}\nOS sandbox false`),
          e('div', { className: 'xsc-manager-actions' },
            e('button', { type: 'button', onClick: options.onReset }, '取消'),
            e('button', { type: 'button', 'data-primary': 'true', disabled: options.busy, onClick: () => { void options.onPrepare(workflow.intent!, workflow.candidate) } }, '准备一次性确认')))
      : null,
    workflow.step === 'prepared' && workflow.challenge !== undefined
      ? e('div', null,
          e('div', { className: 'xsc-candidate-facts' }, `${workflow.challenge.action} ${workflow.challenge.packageName}@${workflow.challenge.version}\nProfile ${workflow.challenge.profile}\n到期 ${workflow.challenge.expiresAt}\nOS sandbox false`),
          e('ul', { className: 'xsc-disclosures' }, ...workflow.challenge.disclosures.map((item, index) => e('li', { key: `${index}:${item}` }, item))),
          e('div', { className: 'xsc-manager-actions' },
            e('button', { type: 'button', onClick: options.onReset }, '暂不执行'),
            e('button', { type: 'button', 'data-danger': 'true', disabled: options.busy, onClick: () => { void options.onConfirm() } }, '确认并执行一次')))
      : null,
    workflow.step === 'completed' && workflow.transaction !== undefined
      ? e('div', null,
          e('div', { className: 'xsc-candidate-facts' }, `${workflow.transaction.packageName}@${workflow.transaction.version}\n${workflow.transaction.action} · ${workflow.transaction.state}\nconsent confirmed ${workflow.transaction.consent.confirmed}\nOS sandbox false`),
          e('div', { className: 'xsc-manager-actions' }, e('button', { type: 'button', 'data-primary': 'true', onClick: options.onReset }, '继续管理')))
      : null,
    e('details', { className: 'xsc-inventory' },
      e('summary', null, `Host 清单 ${options.plugins.length}`),
      e('div', { className: 'xsc-inventory-list' }, options.plugins.length === 0 ? '清单为空或仍在读取' : options.plugins.slice(0, 40).map(item => `${item.moduleName} [${item.fiberPhase ?? '未观测'}]`).join('\n'))))
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
  return {
    value: `${activeCount} 条可用`,
    detail: `revision ${memory.revision}\n全局 ${globalCount} · 项目 ${projectCount} · 已忘记 ${memory.counts.forgotten}`,
  }
}

export function heartbeatPresentation(value: unknown): { readonly status: string; readonly detail: string; readonly running: boolean } {
  const input = record(value)
  if (input?.schemaVersion !== 2 || typeof input.status !== 'string' || typeof input.running !== 'boolean' || !Array.isArray(input.checks)) {
    return { status: '不可用', detail: '后台状态尚未连接', running: false }
  }
  const checks = input.checks.flatMap((item): HeartbeatPublicCheck[] => {
    const check = record(item)
    if (typeof check?.id !== 'string' || typeof check.status !== 'string' || typeof check.intervalMs !== 'number' || typeof check.failureCount !== 'number') return []
    return [{
      id: check.id,
      status: check.status,
      intervalMs: check.intervalMs,
      failureCount: check.failureCount,
      ...(typeof check.nextRunAt === 'number' ? { nextRunAt: check.nextRunAt } : {}),
    }]
  })
  return {
    status: input.status,
    running: input.running,
    detail: checks.length === 0
      ? '0 个检查 · 无任务运行'
      : checks.map(check => `${check.id} [${check.status}] · 失败 ${check.failureCount}${check.nextRunAt === undefined ? '' : ` · 下次 ${check.nextRunAt}`}`).join('\n'),
  }
}

export function pluginTransactionPresentation(value: PluginGovernanceSnapshot): { readonly total: number; readonly detail: string } {
  const counts = new Map<string, number>()
  for (const transaction of value.transactions) counts.set(transaction.state, (counts.get(transaction.state) ?? 0) + 1)
  return {
    total: value.transactions.length,
    detail: value.status === 'error'
      ? `事务读取失败${value.error === undefined ? '' : `：${value.error}`}`
      : counts.size === 0
        ? value.status === 'loading' ? '正在读取事务' : '暂无受控变更记录'
        : [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([state, count]) => `${state} ${count}`).join(' · '),
  }
}

function statusLabel(value: string): string {
  return ({ running: '正在处理', blocked: '等待确认', completed: '任务结束', idle: '空闲', blank: '新会话' } as Record<string, string>)[value] ?? value
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
