interface ReactLike {
  createElement(type: string | ((props?: Record<string, unknown>) => unknown), props: Record<string, unknown> | null, ...children: unknown[]): unknown
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T
  useState<T>(initial: T): [T, (value: T | ((current: T) => T)) => void]
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]): void
}
interface SlotsLike { inject(name: string, setup: () => () => void): () => void; register(options: { name: string; id?: string; order?: number; priority?: number }, component: unknown): () => void }
interface Result<T> { readonly ok: boolean; readonly value?: T; readonly error?: { readonly message: string } }
interface RuntimeSnapshot { readonly currentSessionId?: string; readonly sessions: Readonly<Record<string, { readonly state: string; readonly completionReceipt?: { readonly outcome?: string; readonly sourceSeq?: number } }>> }
interface CatalogSnapshot { readonly sessions: Readonly<Record<string, { readonly sessionId: string; readonly title?: string; readonly cwd?: string; readonly updatedAt: number }>> }
interface TimelineSnapshot { readonly items: readonly { readonly key: string; readonly kind: string; readonly text: string; readonly isError?: boolean }[] }
interface ContextSnapshot { readonly sessions: Readonly<Record<string, { readonly pressure?: unknown; readonly breakdown?: unknown; readonly usage?: unknown; readonly budget?: unknown; readonly compactions?: readonly unknown[] }>> }
interface MemoryLifecycleSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly memory?: {
    readonly revision: number
    readonly counts: { readonly active: number; readonly global: number; readonly project: number; readonly forgotten: number; readonly superseded: number }
    readonly entries?: readonly { readonly scope: 'global' | 'project'; readonly state: 'active' | 'forgotten' | 'superseded' }[]
  }
}
interface HeartbeatPublicCheck {
  readonly id: string
  readonly status: string
  readonly intervalMs: number
  readonly failureCount: number
  readonly nextRunAt?: number
}
interface HeartbeatPublicSnapshot {
  readonly schemaVersion: 2
  readonly status: string
  readonly running: boolean
  readonly checks: readonly HeartbeatPublicCheck[]
}
interface PluginGovernanceSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error' | 'disposed'
  readonly transactions: readonly { readonly state: string; readonly action: string; readonly packageName: string; readonly profile: string }[]
  readonly pendingRequests: number
  readonly error?: string
}

export interface NativeShellClientContext {
  slots: SlotsLike
  agentRuntimeSession: {
    getSnapshot(): RuntimeSnapshot; subscribe(listener: () => void): () => void
    sendTurn(input: { sessionId: string; content: string; mode: 'queue' | 'steer' }): Promise<Result<{ accepted: true }>>
    stopRun(input: { sessionId: string }): Promise<Result<{ accepted: true }>>
    forkSession(input: { sessionId: string }): Promise<Result<{ sessionId: string }>>
  }
  sessionCatalog: {
    getSnapshot(): CatalogSnapshot; subscribe(listener: () => void): () => void
    createLooseSession(): Promise<Result<{ sessionId: string }>>; openSession(sessionId: string): Result<{ opened: true }>
    search(query: string, signal: AbortSignal): Promise<Result<{ items: readonly { sessionId: string; snippet: string }[] }>>
  }
  taskTimeline: { getSnapshot(): TimelineSnapshot; subscribe(listener: () => void): () => void }
  contextGovernance: { getSnapshot(): ContextSnapshot; subscribe(listener: () => void): () => void }
  userApproval: {
    getSnapshot(): { readonly approvals: readonly { readonly key: string; readonly toolName: string; readonly callId?: string; readonly reason?: string }[] }
    subscribe(listener: () => void): () => void
    answer(key: string, outcome: 'allowed-once' | 'rejected'): Promise<Result<{ accepted: true }>>
  }
  pluginGovernance: {
    listHostPlugins(): Promise<Result<{ entries: readonly { moduleName: string; fiberPhase: string | null }[] }>>
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

export const inject = ['slots', 'agentRuntimeSession', 'sessionCatalog', 'taskTimeline', 'contextGovernance', 'pluginGovernance', 'userApproval', 'memoryLifecycle']

const CSS = `
:root{--cloud:#f3f7f5;--paper:#fbfdfc;--ink:#14231f;--muted:#66746f;--jade:#167c68;--mint:#dcebe6;--gold:#b68b3e;--line:#d6e1dd;--danger:#a7433b}*{box-sizing:border-box}.xs-shell{position:fixed;inset:0;z-index:30;display:grid;grid-template-columns:272px minmax(0,1fr);color:var(--ink);background:var(--cloud);font:14px/1.55 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;pointer-events:auto}.xs-nest{display:flex;min-height:0;flex-direction:column;border-right:1px solid var(--line);background:var(--paper);padding:22px 18px}.xs-brand{display:flex;align-items:center;gap:11px;padding:0 7px 22px}.xs-mark{width:34px;height:34px;background:linear-gradient(135deg,#7ed8bd 4%,var(--jade) 46%,var(--gold) 78%,#f0d896);mask:url('/api/xiaoshe/brand-icon') center/contain no-repeat;-webkit-mask:url('/api/xiaoshe/brand-icon') center/contain no-repeat}.xs-brand strong{font:600 22px/1 "STKaiti","KaiTi",serif;letter-spacing:.16em}.xs-kicker,.xs-meta{font:600 10px/1.3 "Cascadia Mono",monospace;letter-spacing:.13em;color:var(--muted)}.xs-actions{display:grid;grid-template-columns:1fr auto;gap:8px}.xs-btn{border:1px solid var(--line);border-radius:10px;background:var(--paper);color:inherit;padding:9px 12px;cursor:pointer}.xs-btn:hover{border-color:var(--jade);color:var(--jade)}.xs-btn.primary{border-color:var(--jade);background:var(--jade);color:white}.xs-btn:disabled{cursor:not-allowed;opacity:.48}.xs-search{margin:15px 0}.xs-search input,.xs-composer textarea{width:100%;border:1px solid var(--line);border-radius:11px;background:var(--paper);color:inherit;outline:none}.xs-search input{padding:9px 11px}.xs-search input:focus,.xs-composer textarea:focus{border-color:var(--jade);box-shadow:0 0 0 3px color-mix(in srgb,var(--jade) 15%,transparent)}.xs-list{min-height:0;overflow:auto;display:grid;gap:5px}.xs-session{display:grid;width:100%;border:0;border-radius:9px;background:transparent;color:inherit;text-align:left;padding:9px 10px;cursor:pointer}.xs-session[data-current=true]{background:var(--mint)}.xs-session span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xs-session small{color:var(--muted);font-size:11px}.xs-nest footer{margin-top:auto;padding-top:14px;border-top:1px solid var(--line)}.xs-canvas{min-width:0;min-height:0;display:grid;grid-template-rows:auto 1fr auto;background:radial-gradient(circle at 92% 4%,color-mix(in srgb,var(--gold) 9%,transparent),transparent 28%),var(--paper)}.xs-head{display:grid;grid-template-columns:1fr auto;gap:20px;align-items:center;padding:23px clamp(20px,4vw,54px) 17px;border-bottom:1px solid var(--line)}.xs-title{margin:5px 0 0;font-size:clamp(20px,2.2vw,30px);font-weight:650;letter-spacing:-.03em}.xs-spine{display:flex;align-items:center;gap:9px;color:var(--muted);white-space:nowrap}.xs-spine::before{content:"";width:38px;height:4px;border-radius:9px;background:linear-gradient(90deg,var(--jade),var(--gold))}.xs-flow{overflow:auto;padding:30px clamp(20px,7vw,90px)}.xs-empty{max-width:620px;margin:12vh auto 0}.xs-empty h2{font:500 clamp(31px,5vw,54px)/1.15 "STKaiti","KaiTi",serif;margin:0 0 17px}.xs-empty p{max-width:500px;color:var(--muted);font-size:15px}.xs-events{max-width:820px;margin:0 auto;display:grid;gap:14px}.xs-event{padding:16px 18px;border:1px solid var(--line);border-radius:14px;background:var(--paper);white-space:pre-wrap}.xs-event[data-kind=user]{margin-left:15%;border-color:var(--jade);background:var(--mint)}.xs-event[data-error=true]{border-color:var(--danger)}.xs-event-label{display:block;margin-bottom:6px;color:var(--muted);font:600 10px "Cascadia Mono",monospace}.xs-controls{max-width:820px;margin:18px auto 0}.xs-controls details{border-top:1px solid var(--line);padding:12px 0}.xs-controls summary{cursor:pointer;font-weight:600}.xs-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;padding-top:12px}.xs-card{border:1px solid var(--line);border-radius:11px;padding:12px;background:var(--cloud);min-height:92px}.xs-card code{font:11px/1.45 "Cascadia Mono",monospace;overflow-wrap:anywhere}.xs-composer{padding:12px clamp(20px,7vw,90px) 20px}.xs-composer form{max-width:820px;margin:auto;display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end}.xs-composer textarea{min-height:48px;max-height:150px;resize:vertical;padding:12px 14px}.xs-error{color:var(--danger);max-width:820px;margin:0 auto 8px}.xs-vh{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}:focus-visible{outline:3px solid var(--gold);outline-offset:2px}@media(prefers-color-scheme:dark){.xs-shell{--cloud:#101714;--paper:#17211e;--ink:#ecf4f0;--muted:#a2b0aa;--mint:#183c34;--line:#2c3b36}}@media(max-width:760px){.xs-shell{grid-template-columns:84px minmax(0,1fr)}.xs-nest{padding:16px 10px}.xs-brand{justify-content:center}.xs-brand-copy,.xs-search,.xs-session span,.xs-session small,.xs-actions .xs-btn:not(.primary){display:none}.xs-actions{display:block}.xs-actions .primary{display:block;width:100%;font-size:0}.xs-actions .primary::before{content:"＋";font-size:18px}.xs-session{height:38px}.xs-session::before{content:"•";text-align:center;color:var(--jade)}.xs-grid{grid-template-columns:1fr}.xs-head{padding-inline:18px}.xs-spine span{display:none}.xs-flow,.xs-composer{padding-inline:16px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`

// Visual continuity only: Xiaoshe remains the design owner. These restrained
// hairlines and paper-card details borrow layout polish from the user's two
// reference tools without importing their dashboard information architecture.
const REFERENCE_CSS = `
.xs-nest{box-shadow:inset -1px 0 0 rgba(20,35,31,.035),12px 0 28px -30px rgba(20,35,31,.35)}
.xs-head{position:relative}
.xs-head::after{content:"";position:absolute;left:clamp(20px,4vw,54px);bottom:-1px;width:96px;height:2px;border-radius:2px;background:linear-gradient(90deg,var(--jade),var(--gold))}
.xs-session{border-left:3px solid transparent;transition:border-color 120ms ease,background 120ms ease}
.xs-session[data-current=true]{border-left-color:var(--jade)}
.xs-event,.xs-card{box-shadow:0 1px 2px rgba(20,35,31,.045)}
.xs-btn{box-shadow:inset 0 1px 0 color-mix(in srgb,#fff 45%,transparent)}
.xs-composer>.xs-card{max-width:820px;margin:0 auto 10px;border-color:var(--gold);min-height:auto}
@media(prefers-reduced-motion:reduce){.xs-session{transition:none}}
`

/** Own the root slot: a product shell, not an overlay over DSH's product layout. */
export function apply(ctx: NativeShellClientContext, react: ReactLike = require('react') as ReactLike): () => void {
  const e = react.createElement
  const Shell = (): unknown => {
    const runtime = react.useSyncExternalStore(listener => ctx.agentRuntimeSession.subscribe(listener), () => ctx.agentRuntimeSession.getSnapshot())
    const catalog = react.useSyncExternalStore(listener => ctx.sessionCatalog.subscribe(listener), () => ctx.sessionCatalog.getSnapshot())
    const timeline = react.useSyncExternalStore(listener => ctx.taskTimeline.subscribe(listener), () => ctx.taskTimeline.getSnapshot())
    const context = react.useSyncExternalStore(listener => ctx.contextGovernance.subscribe(listener), () => ctx.contextGovernance.getSnapshot())
    const approvalState = react.useSyncExternalStore(listener => ctx.userApproval.subscribe(listener), () => ctx.userApproval.getSnapshot())
    const memoryState = react.useSyncExternalStore(listener => ctx.memoryLifecycle.subscribe(listener), () => ctx.memoryLifecycle.getSnapshot())
    const pluginState = react.useSyncExternalStore(listener => ctx.pluginGovernance.subscribe(listener), () => ctx.pluginGovernance.getSnapshot())
    const [error, setError] = react.useState('')
    const [plugins, setPlugins] = react.useState<readonly { moduleName: string; fiberPhase: string | null }[]>([])
    const [heartbeat, setHeartbeat] = react.useState<unknown>(undefined)
    const [query, setQuery] = react.useState('')
    const [searchResults, setSearchResults] = react.useState<readonly { sessionId: string; snippet: string }[]>([])
    const currentId = runtime.currentSessionId
    const current = currentId === undefined ? undefined : runtime.sessions[currentId]
    const currentCatalog = currentId === undefined ? undefined : catalog.sessions[currentId]
    react.useEffect(() => {
      let active = true
      void ctx.pluginGovernance.listHostPlugins().then(result => { if (active && result.ok) setPlugins(result.value?.entries ?? []) })
      void ctx.pluginGovernance.refreshTransactions().catch(() => {})
      void fetch('/api/xiaoshe/heartbeat', { cache: 'no-store' }).then(response => response.ok ? response.json() : undefined).then(value => { if (active) setHeartbeat(value) }).catch(() => {})
      return () => { active = false }
    }, [])
    react.useEffect(() => {
      void ctx.memoryLifecycle.refresh({
        scope: currentCatalog?.cwd === undefined ? 'global' : 'all',
        ...(currentCatalog?.cwd === undefined ? {} : { project: currentCatalog.cwd }),
        include_inactive: false,
      }).catch(() => {})
    }, [currentCatalog?.cwd])
    const createSession = async (): Promise<string | undefined> => {
      const result = await ctx.sessionCatalog.createLooseSession()
      if (!result.ok || result.value === undefined) { setError(result.error?.message ?? '无法新建会话'); return undefined }
      ctx.sessionCatalog.openSession(result.value.sessionId); return result.value.sessionId
    }
    const submit = async (event: { preventDefault(): void; currentTarget: HTMLFormElement }): Promise<void> => {
      event.preventDefault(); setError('')
      const form = event.currentTarget
      const content = String(new FormData(form).get('content') ?? '').trim()
      if (content === '') return
      const sessionId = currentId ?? await createSession(); if (sessionId === undefined) return
      const result = await ctx.agentRuntimeSession.sendTurn({ sessionId, content, mode: current?.state === 'running' ? 'queue' : 'steer' })
      if (!result.ok) setError(result.error?.message ?? '任务未发送'); else form.reset()
    }
    const search = async (value: string): Promise<void> => {
      const queryValue = value.trim()
      if (queryValue === '') { setSearchResults([]); return }
      const result = await ctx.sessionCatalog.search(queryValue, new AbortController().signal)
      if (!result.ok) { setError(result.error?.message ?? '搜索失败'); setSearchResults([]); return }
      setError(''); setSearchResults(result.value?.items ?? [])
    }
    const answerApproval = async (key: string, outcome: 'allowed-once' | 'rejected'): Promise<void> => {
      const result = await ctx.userApproval.answer(key, outcome)
      if (!result.ok) setError(result.error?.message ?? '审批响应失败')
    }
    const sessions = Object.values(catalog.sessions).sort((a, b) => b.updatedAt - a.updatedAt)
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const localMatches = normalizedQuery === '' ? sessions : sessions.filter(row => `${row.title ?? ''}\n${row.cwd ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
    const visibleSessions = searchResults.length === 0 ? localMatches : searchResults.flatMap(hit => {
      const row = catalog.sessions[hit.sessionId]
      return row === undefined ? [] : [{ ...row, searchSnippet: hit.snippet }]
    })
    const status = current?.state ?? 'idle'; const receipt = current?.completionReceipt?.outcome
    const contextRow = currentId === undefined ? undefined : context.sessions[currentId]
    const memory = memoryState.memory
    const visibleActive = memory?.entries?.filter(entry => entry.state === 'active')
    const visibleActiveCount = visibleActive?.length ?? memory?.counts.active
    const visibleGlobalCount = visibleActive?.filter(entry => entry.scope === 'global').length ?? memory?.counts.global
    const visibleProjectCount = visibleActive?.filter(entry => entry.scope === 'project').length ?? memory?.counts.project
    const memoryBody = memoryState.status === 'ready' && memory !== undefined
      ? `${visibleActiveCount ?? 0} 条可用 · revision ${memory.revision}`
      : memoryState.status === 'loading'
        ? '正在读取'
        : memoryState.status === 'error'
          ? '读取失败'
          : '尚未读取'
    const memoryDetail = memory === undefined
      ? '由独立 Product 插件提供'
      : `全局 ${visibleGlobalCount ?? 0} · 项目 ${visibleProjectCount ?? 0} · 已忘记 ${memory.counts.forgotten}`
    const heartbeatView = heartbeatPresentation(heartbeat)
    const pluginTransactions = pluginTransactionPresentation(pluginState)
    const approval = approvalState.approvals[0]
    return e('div', { className: 'xs-shell', 'data-xiaoshe-native-shell': '', 'data-xiaoshe-runtime-state': status }, e('style', null, CSS), e('style', null, REFERENCE_CSS),
      e('aside', { className: 'xs-nest', 'aria-label': '巢册' },
        e('header', { className: 'xs-brand' }, e('span', { className: 'xs-mark', role: 'img', 'aria-label': '小蛇' }), e('div', { className: 'xs-brand-copy' }, e('strong', null, '小蛇'), e('div', { className: 'xs-kicker' }, 'NATIVE WORKBENCH'))),
        e('div', { className: 'xs-actions' }, e('button', { className: 'xs-btn primary', type: 'button', 'aria-label': '新会话', onClick: () => { void createSession() } }, '新会话'), e('button', { className: 'xs-btn', type: 'button', disabled: true, title: '新项目需要目录选择能力' }, '＋')),
        e('label', { className: 'xs-search' }, e('span', { className: 'xs-vh' }, '搜索会话'), e('input', { type: 'search', value: query, placeholder: '搜索巢册', onChange: (event: { currentTarget: HTMLInputElement }) => { setQuery(event.currentTarget.value); if (event.currentTarget.value.trim() === '') setSearchResults([]) }, onKeyDown: (event: { key: string; preventDefault(): void; currentTarget: HTMLInputElement }) => { if (event.key === 'Enter') { event.preventDefault(); void search(event.currentTarget.value) } } })),
        e('nav', { className: 'xs-list', 'aria-label': '会话' }, ...visibleSessions.map(row => e('button', { className: 'xs-session', type: 'button', key: row.sessionId, 'aria-label': `${row.title ?? '未命名任务'}，${row.cwd ?? '未归入项目'}${'searchSnippet' in row ? `，命中：${String(row.searchSnippet)}` : ''}`, 'data-current': row.sessionId === currentId, onClick: () => ctx.sessionCatalog.openSession(row.sessionId) }, e('span', null, row.title ?? '未命名任务'), e('small', null, 'searchSnippet' in row ? String(row.searchSnippet) : row.cwd ?? '未归入项目')))),
        e('footer', null, e('div', { className: 'xs-meta', 'data-heartbeat-running': heartbeatView.running }, `后台 ${heartbeatView.status}`), e('div', null, `${sessions.length} 个会话`))),
      e('main', { className: 'xs-canvas' },
        e('header', { className: 'xs-head' }, e('div', null, e('div', { className: 'xs-kicker' }, currentCatalog?.cwd ?? '项目外任务'), e('h1', { className: 'xs-title' }, currentCatalog?.title ?? '从这里开始一件事')), e('div', { className: 'xs-spine', role: 'status' }, e('span', null, receipt === undefined ? statusLabel(status) : `${statusLabel(status)} · ${receiptLabel(receipt)}`))),
        e('section', { className: 'xs-flow', 'aria-label': '任务画布' },
          timeline.items.length === 0 ? e('div', { className: 'xs-empty' }, e('div', { className: 'xs-kicker' }, 'ONE THING AT A TIME'), e('h2', null, '说清目标，剩下的交给小蛇。'), e('p', null, '无需先创建项目。任务、行动、审批和验证会沿同一条证据脊线展开；没有运行事实时，这里保持安静。')) : e('div', { className: 'xs-events' }, ...timeline.items.map(item => e('article', { className: 'xs-event', key: item.key, 'data-kind': item.kind, 'data-error': item.isError === true }, e('span', { className: 'xs-event-label' }, eventLabel(item.kind)), item.text))),
          e('div', { className: 'xs-controls' }, e('details', null, e('summary', null, '小蛇控制中心'), e('div', { className: 'xs-grid' },
            card(e, '上下文', contextRow === undefined ? '当前无会话数据' : '预算与构成来自运行时', compact(contextRow?.budget ?? contextRow?.pressure)),
            card(e, '完成凭证', receipt === undefined ? '尚未形成凭证' : receiptLabel(receipt), current?.completionReceipt?.sourceSeq === undefined ? '' : `seq ${current.completionReceipt.sourceSeq}`),
            card(e, '插件与扩展', `${plugins.length} 个 Host 插件 · ${pluginTransactions.total} 笔受控变更`, `${plugins.slice(0, 6).map(item => `${item.moduleName} [${item.fiberPhase ?? '未观测'}]`).join('\n') || '清单为空'}\n${pluginTransactions.detail}\n受信任主机代码 · 无 OS 沙箱 · 变更需用户确认`),
            card(e, '会话与项目', `${sessions.length} 个会话`, '项目外会话可用 · 新项目等待目录选择能力'),
            card(e, '长期记忆', memoryBody, memoryDetail),
            card(e, '心跳与后台', heartbeatView.status, `${heartbeatView.detail}\n心跳与 DSH Schedule 分离`),
            card(e, '行动与审批', '由运行时策略强制', '权限档位与能力方案分离'),
            card(e, '模型与凭证', receipt === 'failed' ? '当前运行失败，请检查配置' : '由 DSH Profile 管理', '凭证不在浏览器显示'),
            card(e, 'Windows 桥接', '独立可选 Bundle', '未组合时不伪装可用'),
            card(e, '外观与性能', '跟随系统深浅色', '动态背景未加载 · reduced-motion 已支持'),
            card(e, '诊断、导出与恢复', '迁移检查与哈希备份可用', '发布、合并与跨平台验收仍需独立确认'))))),
        e('footer', { className: 'xs-composer' }, error === '' ? null : e('p', { className: 'xs-error', role: 'alert' }, error), approval === undefined ? null : e('section', { className: 'xs-card', role: 'dialog', 'aria-label': '行动审批' }, e('strong', null, `等待确认：${approval.toolName}`), e('p', null, approval.reason ?? '该行动需要你明确允许或拒绝。'), e('div', null, e('button', { className: 'xs-btn', type: 'button', onClick: () => { void answerApproval(approval.key, 'rejected') } }, '拒绝'), e('button', { className: 'xs-btn primary', type: 'button', onClick: () => { void answerApproval(approval.key, 'allowed-once') } }, '仅允许一次'))), e('form', { onSubmit: (event: unknown) => { void submit(event as { preventDefault(): void; currentTarget: HTMLFormElement }) } }, e('label', { className: 'xs-vh', htmlFor: 'xs-task-input' }, '输入任务'), e('textarea', { id: 'xs-task-input', name: 'content', disabled: approval !== undefined, placeholder: approval === undefined ? currentId === undefined ? '想完成什么？' : '继续说明，或补充约束…' : '请先处理当前审批' }), e('button', { className: 'xs-btn primary', type: 'submit', disabled: approval !== undefined }, current?.state === 'running' ? '加入队列' : '交给小蛇')))))
  }
  return ctx.slots.inject('root', () => ctx.slots.register({ name: 'root', id: 'xiaoshe-native-shell', priority: -1000 }, Shell))
}

function card(e: ReactLike['createElement'], title: string, body: string, detail: string): unknown { return e('div', { className: 'xs-card' }, e('strong', null, title), e('div', null, body), e('code', null, detail)) }
function statusLabel(value: string): string { return ({ running: '正在处理', blocked: '等待确认', completed: '任务结束', idle: '空闲', blank: '新会话' } as Record<string, string>)[value] ?? value }
function receiptLabel(value: string): string { return ({ verified: '已验证', partial: '部分验证', blocked: '受阻', failed: '失败', not_run: '未执行', release_held: '待发布', running: '执行中' } as Record<string, string>)[value] ?? value }
function eventLabel(value: string): string { return ({ user: '你', assistant: '小蛇', tool: '行动', error: '错误', compaction: '上下文整理', status: '状态' } as Record<string, string>)[value] ?? value }
function compact(value: unknown): string { if (value === undefined) return ''; try { return JSON.stringify(value) } catch { return '不可序列化' } }

export function heartbeatPresentation(value: unknown): { readonly status: string; readonly detail: string; readonly running: boolean } {
  const input = record(value)
  if (input?.schemaVersion !== 2 || typeof input.status !== 'string' || typeof input.running !== 'boolean' || !Array.isArray(input.checks)) {
    return { status: '不可用', detail: '后台状态尚未连接', running: false }
  }
  const checks = input.checks.flatMap((item): HeartbeatPublicCheck[] => {
    const check = record(item)
    if (typeof check?.id !== 'string' || typeof check.status !== 'string'
      || typeof check.intervalMs !== 'number' || typeof check.failureCount !== 'number') return []
    return [{
      id: check.id,
      status: check.status,
      intervalMs: check.intervalMs,
      failureCount: check.failureCount,
      ...(typeof check.nextRunAt === 'number' ? { nextRunAt: check.nextRunAt } : {}),
    }]
  })
  const detail = checks.length === 0
    ? '0 个检查 · 无任务运行'
    : checks.map(check => `${check.id} [${check.status}] · 失败 ${check.failureCount}${check.nextRunAt === undefined ? '' : ` · 下次 ${check.nextRunAt}`}`).join('\n')
  return { status: input.status, detail, running: input.running }
}

export function pluginTransactionPresentation(value: PluginGovernanceSnapshot): { readonly total: number; readonly detail: string } {
  const counts = new Map<string, number>()
  for (const transaction of value.transactions) counts.set(transaction.state, (counts.get(transaction.state) ?? 0) + 1)
  const detail = value.status === 'error'
    ? `事务读取失败${value.error === undefined ? '' : `：${value.error}`}`
    : counts.size === 0
      ? value.status === 'loading' ? '正在读取事务' : '暂无受控变更记录'
      : [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([state, count]) => `${state} ${count}`).join(' · ')
  return { total: value.transactions.length, detail }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
