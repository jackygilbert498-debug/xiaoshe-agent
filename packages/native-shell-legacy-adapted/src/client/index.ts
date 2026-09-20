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
  useLayoutEffect?(effect: () => void | (() => void), dependencies: readonly unknown[]): void
}

interface ClientUiPrimitivesLike {
  readonly MarkdownText: (props: { readonly text: string; readonly streaming?: boolean; readonly labels: typeof MARKDOWN_LABELS }) => unknown
}

// DSH 0.1.5 makes localized code/footnote labels a required renderer input.
// Reuse one stable object in chat and file previews, including streaming updates.
const MARKDOWN_LABELS = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '脚注' } as const

const CLIENT_SOURCE_IDENTITY = '__XIAOSHE_CLIENT_SOURCE_IDENTITY__'

/** Called only by the committed root effect; never read an identity from DOM or disk. */
export function mountLoadedFrontendVersion(): () => void {
  const noop = (): void => {}
  if (typeof window === 'undefined' || !/^[a-f0-9]{64}$/u.test(CLIENT_SOURCE_IDENTITY)) return noop
  try {
    const version = (window as unknown as { xiaosheDesktop?: { version?: { mountFrontend(identity: string): () => void } } }).xiaosheDesktop?.version
    const release = version?.mountFrontend(CLIENT_SOURCE_IDENTITY)
    return typeof release === 'function' ? release : noop
  } catch { return noop }
}

/** Never turn an HTTP 200 or an unversioned legacy response into “latest”. */
export function runtimeVersionPresentation(value: unknown, loadedIdentity = CLIENT_SOURCE_IDENTITY): {
  state: 'current' | 'stale' | 'unknown' | 'unavailable'; label: string; detail: string; facts: readonly (readonly [string, string])[]
} {
  const report = record(value)
  const candidate = record(report?.candidate); const backend = record(report?.backend); const frontend = record(report?.frontend)
  const identity = (value: unknown): string | undefined => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : undefined
  const candidateId = identity(candidate?.identity); const backendId = identity(backend?.identity)
  const sourceId = identity(frontend?.source_identity); const buildId = identity(frontend?.build_identity); const loadedId = identity(loadedIdentity)
  const valid = report?.schema === 'xiaoshe-runtime-version/v1'
  let state: 'current' | 'stale' | 'unknown' | 'unavailable' = valid && report.status === 'unavailable' ? 'unavailable' : 'unknown'
  if (valid && (report.status === 'stale' || (candidateId && backendId && candidateId !== backendId)
    || (sourceId && buildId && sourceId !== buildId) || (buildId && loadedId && buildId !== loadedId))) state = 'stale'
  else if (valid && report.status === 'current' && candidateId && candidateId === backendId && sourceId && sourceId === buildId
    && loadedId === buildId && frontend?.state === 'current' && frontend.loaded_state === 'current') state = 'current'
  const labels = { current: '版本一致', stale: '版本不一致', unknown: '尚未确认', unavailable: '诊断不可用' }
  const details = {
    current: '运行后台、当前界面与本次检查的磁盘候选一致；这不是正式发布或签名验收结论。',
    stale: '检测到源码、后台或界面版本不一致。请先保存草稿，再按受控启动流程更新；检查不会自动刷新或重启。',
    unknown: '当前证据不足，不能确认是否运行最新版；旧启动器未报告来源时也会显示此状态。',
    unavailable: '暂时无法核对版本；服务可访问不代表版本一致，请查看本机诊断。',
  }
  const short = (value: string | undefined): string => value?.slice(0, 12) ?? '未报告'
  return { state, label: labels[state], detail: details[state], facts: [
    ['来源', report?.source === 'developer-source' ? '本机开发源码' : report?.source === 'embedded-runtime' ? '内嵌运行包' : '未报告'],
    ['磁盘候选', short(candidateId)], ['运行后台', short(backendId)], ['当前界面', short(loadedId)], ['磁盘界面', short(buildId)],
  ] }
}

interface BrowserTabState { tab_id: string; url: string; title: string; loading: boolean; error: string; busy: boolean }
interface BrowserWorkspaceState { mode: 'agent' | 'paused' | 'user'; desktop_allowed: boolean; desktop_until: number; active_tab: string | null; notice: string; tabs: BrowserTabState[] }
interface NativeBrowserBridge {
  request(ownerId: string, action: string, args?: Record<string, unknown>): Promise<{ ok: boolean; value?: BrowserWorkspaceState; error?: string }>
  bounds(ownerId: string, bounds?: { x: number; y: number; width: number; height: number }, reason?: string): void
  subscribe(callback: (event: string) => void): () => void
}
function nativeBrowserBridge(): NativeBrowserBridge | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { xiaosheDesktop?: { browser?: NativeBrowserBridge } }).xiaosheDesktop?.browser
}
export function browserAddress(value: string): { url?: string; error?: string } {
  const input = value.trim().replace(/^(["'])(.*)\1$/u, '$2').trim()
  if (!input) return {}
  // This panel navigates websites; do not leak local paths to a made-up host.
  let decoded = input
  try { decoded = decodeURIComponent(input) } catch { /* Validate malformed URLs below. */ }
  if (/^(?:[~/\\]|\.{1,2}[/\\]|[a-z]:[/\\]|file:)/iu.test(decoded)
    || /^https?:\/+(?:Users|Volumes|home|tmp|private|[a-z]:)(?:[/\\]|$)/iu.test(decoded)) {
    return { error: '这是本地文件路径，不是网页地址。此浏览器不打开本地目录；请让小蛇按原路径读取图片或文件，无需在这里重新上传。' }
  }
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/iu.test(input) ? input : `https://${input}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('unsupported')
    return { url: url.href }
  } catch { return { error: '请输入有效的 HTTP 或 HTTPS 网页地址；本地文件请交给小蛇按路径读取。' } }
}
function createBrowserDock(react: ReactLike): (props: { ownerId?: string; open: boolean; resizing: boolean; onOpen(): void }) => unknown {
  const e = react.createElement
  const bridge = nativeBrowserBridge()
  return function BrowserDock(props) {
    const [state, setState] = react.useState<BrowserWorkspaceState | undefined>(undefined)
    const [error, setError] = react.useState('')
    const [address, setAddress] = react.useState('')
    const [confirmDesktop, setConfirmDesktop] = react.useState(false)
    const slot = react.useRef<HTMLDivElement | null>(null)
    const live = react.useRef(props); live.current = props
    const active = state?.tabs.find(tab => tab.tab_id === state.active_tab)
    const send = async (action: string, args: Record<string, unknown> = {}): Promise<void> => {
      const owner = props.ownerId
      if (!bridge || !owner) return
      setError('')
      try {
        const reply = await bridge.request(owner, action, args)
        if (live.current.ownerId !== owner) return
        if (!reply.ok) throw new Error(reply.error || '浏览器控制失败')
        // Native events refresh state too; a late navigation reply cannot
        // overwrite a newer pause/takeover result.
        const fresh = await bridge.request(owner, 'status')
        if (fresh.ok && live.current.ownerId === owner) setState(fresh.value)
      } catch (failure) { if (live.current.ownerId === owner) setError(failure instanceof Error ? failure.message : '浏览器暂时不可用') }
    }
    react.useEffect(() => {
      const owner = props.ownerId
      setState(undefined); setError(''); setConfirmDesktop(false)
      if (!bridge || !owner) return
      let disposed = false; let ready = false
      const refresh = async (bind = false): Promise<void> => {
        try {
          const reply = await bridge.request(owner, bind ? 'bind' : 'status')
          if (disposed) return
          if (!reply.ok || !reply.value) throw new Error(reply.error || '浏览器暂时不可用')
          ready = true
          // Passive status refreshes must not steal the user's workbench view.
          // The native workspace's explicit reveal event still opens its tab.
          setState(reply.value)
        } catch (failure) { if (!disposed) setError(failure instanceof Error ? failure.message : '浏览器连接已中断') }
      }
      const unsubscribe = bridge.subscribe(event => { if (event === 'reveal') live.current.onOpen(); if (ready) void refresh() })
      void refresh(true)
      const timer = setInterval(() => { if (ready) void refresh() }, 5000)
      return () => { disposed = true; unsubscribe(); clearInterval(timer); bridge.bounds(owner, undefined, 'owner-effect-cleanup') }
    }, [props.ownerId])
    react.useEffect(() => { setAddress(active?.url === 'about:blank' ? '' : active?.url ?? '') }, [active?.tab_id, active?.url])
    react.useEffect(() => {
      const owner = props.ownerId
      if (!bridge || !owner) return
      // Native WebContentsView can swallow pointer events across the divider.
      // Temporarily unmount its bounds, not its tab, until the drag finishes.
      if (!props.open || props.resizing) { bridge.bounds(owner, undefined, !props.open ? 'dock-closed' : 'dock-resizing'); return }
      const update = (): void => {
        const element = slot.current
        // Preserve the existing guard priority; the reason is diagnostic only.
        if (!element) { bridge.bounds(owner, undefined, 'slot-missing'); return }
        if (document.visibilityState === 'hidden') { bridge.bounds(owner, undefined, 'document-hidden'); return }
        if (document.querySelector('[aria-modal="true"]')) { bridge.bounds(owner, undefined, 'modal-present'); return }
        const box = element.getBoundingClientRect()
        const points = [[box.left + 2, box.top + 2], [box.right - 2, box.bottom - 2], [box.left + box.width / 2, box.top + box.height / 2]]
        const clear = points.every(([x, y]) => element.contains(document.elementFromPoint(x!, y!)))
        bridge.bounds(owner, clear ? { x: box.x, y: box.y, width: box.width, height: box.height } : undefined, clear ? 'layout-visible' : 'hit-test-blocked')
      }
      const observer = new ResizeObserver(update)
      if (slot.current) observer.observe(slot.current)
      const mutations = new MutationObserver(update)
      mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-modal', 'hidden'] })
      const timer = setInterval(update, 400)
      window.addEventListener('resize', update); document.addEventListener('scroll', update, true); document.addEventListener('visibilitychange', update)
      update()
      return () => { observer.disconnect(); mutations.disconnect(); clearInterval(timer); window.removeEventListener('resize', update); document.removeEventListener('scroll', update, true); document.removeEventListener('visibilitychange', update); bridge.bounds(owner, undefined, 'layout-effect-cleanup') }
    }, [props.ownerId, props.open, props.resizing, active?.tab_id])
    if (!bridge || !props.open) return null
    const mode = state?.mode ?? 'paused'
    const navigate = (): void => {
      const target = browserAddress(address)
      if (target.error) { setError(target.error); return }
      if (target.url) void send('open', { url: target.url, ...(active ? { tab_id: active.tab_id } : {}) })
    }
    return e('div', { className: 'browser-dock', id: 'xsla-browser-dock', 'aria-label': '小蛇专用浏览器' },
      e('div', { className: 'browser-heading' }, e('span', null, '独立登录 · 不抢鼠标键盘')),
      e('div', { className: 'browser-tabs', role: 'tablist', 'aria-label': '网页标签' },
        ...(state?.tabs ?? []).map(tab => e('div', { key: tab.tab_id, className: `browser-tab ${tab.tab_id === active?.tab_id ? 'selected' : ''}` },
          e('button', { type: 'button', role: 'tab', 'aria-selected': tab.tab_id === active?.tab_id, title: tab.url, onClick: () => { void send('select', { tab_id: tab.tab_id }) } }, `${tab.loading ? '◌ ' : ''}${tab.title || '新标签页'}`),
          e('button', { type: 'button', title: '关闭标签', 'aria-label': `关闭 ${tab.title || '标签'}`, onClick: () => { void send('close', { tab_id: tab.tab_id }) } }, '×'))),
        e('button', { type: 'button', title: '新建标签', 'aria-label': '新建浏览器标签', onClick: () => { void send('open', { url: 'about:blank' }) } }, '+')),
      e('form', { className: 'browser-address', onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); navigate() } },
        ...(['back', 'forward', 'reload'] as const).map((action, index) => e('button', { key: action, type: 'button', disabled: !active, title: ['后退', '前进', '刷新'][index], 'aria-label': ['后退', '前进', '刷新'][index], onClick: () => { if (active) void send(action, { tab_id: active.tab_id }) } }, ['←', '→', '↻'][index])),
        e('input', { value: address, placeholder: '输入网址，例如 https://…', 'aria-label': '专用浏览器网址', spellCheck: false, onChange: (event: { target: { value: string } }) => setAddress(event.target.value) }),
        e('button', { type: 'submit', disabled: !address.trim() }, '打开')),
      e('div', { className: 'browser-control', 'data-browser-mode': mode },
        e('span', { role: 'status' }, mode === 'user' ? '你正在接管 · 小蛇已停手' : mode === 'paused' ? '已暂停 · 等待你恢复' : active?.busy ? '小蛇正在操作网页' : '小蛇可操作 · 电脑仍归你'),
        e('div', null,
          e('button', { type: 'button', disabled: mode === 'paused', onClick: () => { void send('mode', { mode: 'paused' }) } }, '暂停'),
          mode === 'user' ? null : e('button', { type: 'button', onClick: () => { void send('mode', { mode: 'user' }) } }, '我来接管'),
          mode === 'agent' ? null : e('button', { className: 'browser-primary', type: 'button', onClick: () => { void send('mode', { mode: 'agent' }) } }, '交给小蛇'))),
      error || active?.error || state?.notice ? e('div', { className: 'browser-error', role: 'alert' }, error || active?.error || state?.notice) : null,
      e('div', { className: 'browser-page-slot', ref: slot }, active ? null : e('div', { className: 'browser-empty' }, e('h3', null, '给小蛇一张自己的工作台'), e('p', null, '把网页链接发给小蛇，它会在这里操作。'), e('p', null, '首次使用网站时，点“我来接管”登录，再点“交给小蛇”。登录状态保存在此浏览器，不读取你的其他浏览器。'))),
      confirmDesktop ? e('div', { className: 'browser-desktop-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': '确认允许桌面控制' },
        e('p', null, '允许本会话在接下来 10 分钟操作真实桌面？这会使用你的鼠标、键盘或前台窗口。普通网页任务不需要开启。'),
        e('button', { type: 'button', onClick: () => setConfirmDesktop(false) }, '保持隔离'),
        e('button', { type: 'button', onClick: () => { setConfirmDesktop(false); void send('desktop', { allowed: true }) } }, '允许 10 分钟')) : null,
      e('footer', { className: 'browser-footer' }, e('span', null, state?.desktop_allowed ? '真实桌面：临时允许（原审批仍生效）' : '真实桌面：禁止自动操作'),
        e('button', { type: 'button', onClick: () => { if (state?.desktop_allowed) void send('desktop', { allowed: false }); else setConfirmDesktop(true) } }, state?.desktop_allowed ? '立即收回' : '桌面控制…')))
  }
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
  readonly error?: { readonly message: string; readonly code?: string; readonly kind?: string }
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
    readonly completionReceipt?: { readonly outcome?: string; readonly sourceSeq?: number; readonly unverified?: readonly string[] }
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

interface HistoryImageRef {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}
type HistoryImageReader = (input: { readonly sessionId: string; readonly attachmentId: string }) => Promise<{ readonly attachment: HistoryImageRef; readonly data: Uint8Array }>
interface TimelineSnapshot {
  readonly sessionId?: string
  readonly loading?: boolean
  readonly total?: number
  readonly hasEarlier?: boolean
  readonly items: readonly {
    readonly key: string
    readonly seq?: number
    readonly time?: number
    readonly kind: string
    readonly text: string
    readonly images?: readonly HistoryImageRef[]
    readonly reasoning?: string
    readonly errorCode?: string
    readonly isError?: boolean
  }[]
}

type ConversationDisplayEntry =
  | { readonly kind: 'message'; readonly item: TimelineSnapshot['items'][number]; readonly eventIndex: number }
  | { readonly kind: 'tools'; readonly key: string; readonly items: { readonly item: TimelineSnapshot['items'][number]; readonly eventIndex: number }[] }

/** Collapse only routine tool chatter. Errors and human/assistant messages keep their exact order and anchors. */
export function conversationDisplayEntries(items: TimelineSnapshot['items']): ConversationDisplayEntry[] {
  const result: ConversationDisplayEntry[] = []
  items.forEach((item, eventIndex) => {
    if (item.kind !== 'tool' || item.isError === true) { result.push({ kind: 'message', item, eventIndex }); return }
    const previous = result.at(-1)
    if (previous?.kind === 'tools') previous.items.push({ item, eventIndex })
    else result.push({ kind: 'tools', key: `tools:${item.key}`, items: [{ item, eventIndex }] })
  })
  return result
}

/** Label observable conversation phases in one pass, without interpreting hidden reasoning.
 * A later action/reply in the same turn makes an earlier assistant message a progress update.
 * The last reply is not an assertion that the task or its evidence passed verification.
 */
export function conversationMessagePhases(items: TimelineSnapshot['items']): Map<string, 'progress' | 'reply' | 'responding'> {
  let laterWork = false
  const phases = new Map<string, 'progress' | 'reply' | 'responding'>()
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.kind === 'user') { laterWork = false; continue }
    if (item.kind === 'assistant' && item.text.trim()) {
      phases.set(item.key, item.key === 'partial' ? 'responding' : laterWork ? 'progress' : 'reply')
      laterWork = true
    } else if (item.kind === 'tool') laterWork = true
  }
  return new Map(items.filter(item => phases.has(item.key)).map(item => [item.key, phases.get(item.key)!]))
}

/** Surface only recorded verification gaps; malformed/older receipts remain unknown. */
export function completionGaps(receipt: { readonly unverified?: unknown } | undefined): string[] {
  if (!Array.isArray(receipt?.unverified)) return []
  return [...new Set(receipt.unverified.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean))]
}

/** Never turn a verified receipt into uncertainty or hide recorded cancellation effects. */
export function verificationGapPresentation(outcome: string | undefined, gaps: readonly string[] = []): { gaps: readonly string[]; detail?: string } | undefined {
  if (gaps.length > 0) return { gaps }
  if (outcome === undefined || ['verified', 'completed', 'cancelled'].includes(outcome)) return undefined
  return { gaps, detail: '本轮未记录具体缺口，请结合回复和执行详情确认；不能视为验证通过。' }
}

/** A factual progress digest, deliberately independent of private reasoning and elapsed-time guesses. */
export function taskProgressSummary(input: { readonly state: string; readonly items: TimelineSnapshot['items']; readonly run: RunCenterSnapshot }): {
  readonly goal: string; readonly activity: string; readonly progress?: string; readonly warning?: string
} {
  let lastUserIndex = -1
  for (let index = input.items.length - 1; index >= 0; index--) {
    if (input.items[index]?.kind === 'user') { lastUserIndex = index; break }
  }
  const turnItems = input.items.slice(Math.max(0, lastUserIndex))
  const concise = (text: string): string => text.replace(/\s+/gu, ' ').trim().slice(0, 100)
  const goal = concise(input.run.goal?.objective ?? input.items[lastUserIndex]?.text ?? '')
  const completed = input.run.todos.filter(todo => ['completed', 'done'].includes(todo.status)).length
  const active = input.run.todos.find(todo => ['in_progress', 'running', 'doing'].includes(todo.status))
  const next = input.run.todos.find(todo => ['pending', 'todo', 'not_started'].includes(todo.status))
  const runningJob = input.run.jobs.find(job => job.status === 'running')
  const repeated = new Map<string, number>()
  for (const item of turnItems) if (item.isError || item.kind === 'error') {
    const key = concise(item.text)
    if (key) repeated.set(key, (repeated.get(key) ?? 0) + 1)
  }
  const failures = Math.max(0, ...repeated.values())
  const activity = input.run.goal?.phase === 'paused' ? '目标已暂停，可以补充信息后恢复'
    : input.state === 'blocked' ? '等待你处理确认或问题'
      : input.state !== 'running' ? '本轮已结束，可查看回复或继续补充'
        : active ? concise(active.text) : runningJob ? concise(runningJob.label)
          : next ? `下一步：${concise(next.text)}` : '正在处理，等待下一条可报告的进展'
  return { goal, activity,
    ...(input.run.todos.length ? { progress: `已完成 ${completed} / ${input.run.todos.length} 项计划` } : {}),
    ...(failures >= 3 ? { warning: `本轮同类错误已出现 ${failures} 次，可展开详情核对，或补充信息调整方向。` } : {}) }
}

/** A late Host acknowledgement owns only the submitted draft, never newer text or another session. */
export function shouldClearAcknowledgedDraft(owner: string, currentOwner: string | undefined, sent: string, currentText: string): boolean {
  return owner === currentOwner && sent === currentText
}

type ComposerSendPhase = 'sending' | 'accepted' | 'failed' | 'unknown'
export function sendFailurePhase(error?: { readonly kind?: string; readonly code?: string }): 'unknown' | 'failed' {
  return error?.kind === 'needs_verification' || error?.code === 'ambiguous' ? 'unknown' : 'failed'
}

export function sendStatusPresentation(phase: ComposerSendPhase, mode: 'queue' | 'steer'): { label: string; detail: string } {
  if (phase === 'sending') return { label: '正在发送', detail: '正在等待后台接收；你可以继续起草下一条。' }
  if (phase === 'accepted') return { label: mode === 'steer' ? '已接收 · 正在调整方向' : '已接收 · 按顺序执行', detail: '可以继续发送补充信息；排队消息支持编辑和移除。' }
  if (phase === 'unknown') return { label: '发送结果待核对', detail: '后台可能已经接收，草稿已保留。请先核对对话和队列，避免重复发送。' }
  return { label: '未发送成功', detail: '草稿已保留，可检查连接后重试。' }
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

interface FileReceipt { readonly receiptId: string; readonly name: string; readonly bytes: number; readonly mediaType?: string }
interface RuntimeFileContent { readonly sessionId: string; readonly path: string; readonly name: string; readonly mediaType: string; readonly data: Uint8Array; readonly bytes: number; readonly version: string }
interface RuntimeFiles {
  upload(input: { sessionId: string; file: Blob; name: string; signal?: AbortSignal; onProgress?: (progress: { loaded: number; total?: number }) => void }): Promise<Result<FileReceipt>>
  read(input: { sessionId: string; path: string; signal?: AbortSignal }): Promise<Result<RuntimeFileContent>>
}
interface DraftFile {
  readonly id: string; readonly owner: string; readonly file: File; readonly controller: AbortController
  readonly phase: 'uploading' | 'ready' | 'failed' | 'cancelled'; readonly progress: number
  readonly receipt?: FileReceipt; readonly error?: string
}

/** Mirror the public transport limits before admission; the provider validates again. */
export function validateFileBatch(files: readonly { readonly name: string; readonly size: number }[]): string | undefined {
  if (files.length > 10) return '每条消息最多添加 10 个文件'
  let bytes = 0
  for (const file of files) {
    if (!file.name.trim() || !Number.isSafeInteger(file.size) || file.size < 0) return '文件名称或大小无效'
    if (file.size > 32 * 1024 * 1024) return `${file.name} 超过单个文件 32 MB 上限`
    bytes += file.size
  }
  return bytes > 128 * 1024 * 1024 ? '每条消息的文件合计不能超过 128 MB' : undefined
}

/** One latest tab per file; the unmodified projection remains the execution history. */
export function materialFileTabs<T extends Pick<WorkSurface, 'id' | 'type' | 'source' | 'sessionId' | 'seq'>>(items: readonly T[]): readonly T[] {
  const files = new Map<string, T>()
  for (const item of items) {
    if (!['file', 'image', 'pdf', 'video'].includes(item.type) || !item.source) continue
    const key = `${item.sessionId}\0${/^[a-z]:[\\/]/iu.test(item.source) ? item.source.replace(/\\/gu, '/').toLocaleLowerCase() : item.source}`
    const previous = files.get(key)
    if (previous === undefined || item.seq >= previous.seq) files.set(key, item)
  }
  return [...files.values()]
}

/** CSP is first in the opaque sandbox document, before any untrusted markup. */
export function staticDocumentHtml(text: string): string {
  const escape = (value: string): string => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  let body = `<pre>${escape(text)}</pre>`
  if (typeof DOMParser !== 'undefined') {
    const parsed = new DOMParser().parseFromString(text, 'text/html')
    const allowed = new Set('div span p br hr h1 h2 h3 h4 h5 h6 b strong i em u s blockquote pre code ul ol li table thead tbody tfoot tr td th caption section article header footer main figure figcaption style'.split(' '))
    const clean = (node: Node): Node | undefined => {
      if (node.nodeType === 3) return parsed.createTextNode(node.textContent ?? '')
      if (!(node instanceof Element) || !allowed.has(node.tagName.toLowerCase())) return undefined
      const copy = parsed.createElement(node.tagName.toLowerCase())
      if (node.hasAttribute('style')) copy.setAttribute('style', node.getAttribute('style')!)
      for (const child of Array.from(node.childNodes)) { const safe = clean(child); if (safe) copy.append(safe) }
      return copy
    }
    const container = parsed.createElement('div')
    for (const node of [...Array.from(parsed.head.querySelectorAll('style')), ...Array.from(parsed.body.childNodes)]) {
      const safe = clean(node); if (safe) container.append(safe)
    }
    body = container.innerHTML
  }
  // No meta refresh, links, forms or active embeds survive the allowlist. CSP also blocks CSS network fetches.
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; base-uri \'none\'; form-action \'none\'"><style>body{font:14px/1.7 system-ui;padding:20px;overflow-wrap:anywhere}pre{white-space:pre-wrap}table{border-collapse:collapse}td,th{padding:6px;border:1px solid #ddd}</style></head><body>' + body + '</body></html>'
}

type FilePreviewState = { readonly status: 'loading' | 'ready' | 'error'; readonly file?: RuntimeFileContent; readonly url?: string; readonly error?: string }

/** A preview owns its read and Blob URL; cancellation cannot publish into the next document. */
export function createFilePreviewResource(input: {
  readonly sessionId: string; readonly path: string; readonly read: RuntimeFiles['read']; readonly onChange: (state: FilePreviewState) => void
}): { load(): Promise<void>; dispose(): void } {
  let disposed = false, generation = 0, url: string | undefined, controller: AbortController | undefined
  const release = (): void => { if (url) URL.revokeObjectURL(url); url = undefined }
  return {
    async load() {
      if (disposed) return
      const current = ++generation
      controller?.abort(); controller = new AbortController(); release()
      input.onChange({ status: 'loading' })
      try {
        const result = await input.read({ sessionId: input.sessionId, path: input.path, signal: controller.signal })
        if (disposed || current !== generation) return
        if (!result.ok || result.value === undefined) throw new Error(result.error?.message ?? '文件读取未确认')
        const file = result.value
        if (file.sessionId !== input.sessionId || file.path !== input.path || !(file.data instanceof Uint8Array)
          || file.bytes !== file.data.byteLength || file.bytes > 32 * 1024 * 1024) throw new Error('文件回执与当前材料不匹配')
        url = URL.createObjectURL(new Blob([new Uint8Array(file.data)], { type: file.mediaType }))
        input.onChange({ status: 'ready', file, url })
      } catch (cause: unknown) {
        if (!disposed && current === generation) input.onChange({ status: 'error', error: cause instanceof Error ? cause.message : String(cause) })
      }
    },
    dispose() { disposed = true; generation++; controller?.abort(); release() },
  }
}

function createFilePreviewComponent(react: ReactLike, read: RuntimeFiles['read'], MarkdownText: unknown): (props: { surface: WorkSurface; reloadKey: number }) => unknown {
  const e = react.createElement
  const ImageViewer = createImageViewer(react)
  return ({ surface, reloadKey }) => {
    const identity = `${surface.sessionId}\0${surface.source}\0${reloadKey}`
    const [loaded, setLoaded] = react.useState<{ identity: string; state: FilePreviewState }>({ identity, state: { status: 'loading' } })
    const resource = react.useRef<ReturnType<typeof createFilePreviewResource> | undefined>(undefined)
    react.useEffect(() => {
      const current = createFilePreviewResource({ sessionId: surface.sessionId, path: surface.source!, read, onChange: state => setLoaded({ identity, state }) })
      resource.current = current; void current.load()
      return () => { current.dispose(); if (resource.current === current) resource.current = undefined }
    }, [identity])
    const state = loaded.identity === identity ? loaded.state : { status: 'loading' as const }
    const file = state.file
    let content: unknown = e('p', { role: 'status' }, '正在读取文件…')
    if (state.status === 'error') content = e('div', { className: 'surface-fallback', role: 'alert' }, e('p', null, state.error), e('button', { type: 'button', onClick: () => { void resource.current?.load() } }, '重试读取'))
    else if (file && state.url) {
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (/^image\/(png|jpeg|webp|gif)$/u.test(file.mediaType)) content = e(ImageViewer, { src: state.url, alt: file.name })
      else if (file.mediaType === 'application/pdf') content = e('object', { data: state.url, type: 'application/pdf', className: 'surface-media surface-pdf', 'aria-label': file.name }, e('p', null, '此环境不支持内嵌 PDF；可保存后打开。'))
      else if (/^video\/(mp4|webm|ogg)$/u.test(file.mediaType)) content = e('video', { src: state.url, controls: true, className: 'surface-media' })
      else if (file.data.subarray(0, 1024).some(byte => byte === 0)) content = e('p', null, '此二进制格式暂不提供内嵌预览，可保存后使用本机应用打开。')
      else {
        const truncated = file.bytes > 512 * 1024
        const text = new TextDecoder().decode(file.data.subarray(0, 512 * 1024))
        content = e('div', { className: 'document-text' },
          ext === 'html' || ext === 'htm' ? e('div', null, e('p', { className: 'document-boundary' }, '静态预览 · 不执行脚本，外部资源与交互已禁用；完整网站请使用浏览器。'),
            e('iframe', { sandbox: '', srcDoc: staticDocumentHtml(text), title: `${file.name} 静态预览`, className: 'document-html', referrerPolicy: 'no-referrer' }))
            : ext === 'md' || ext === 'markdown' ? e('div', { className: 'event-markdown' }, e(MarkdownText, { text, labels: MARKDOWN_LABELS }))
              : e('pre', null, ...text.split('\n').slice(0, 5000).map((line, index) => e('span', { className: 'document-line', key: index }, e('i', { 'aria-hidden': true }, index + 1), e('code', null, line || '\u00a0')))),
          truncated || text.split('\n').length > 5000 ? e('p', null, '预览显示前 512 KB / 5000 行，保存文件可查看完整内容。') : null)
      }
    }
    return e('div', { className: 'document-reader', 'data-file-state': state.status },
      file === undefined ? null : e('div', { className: 'document-receipt' }, e('span', null, `当前文件 · ${formatBytes(file.bytes)}`),
        e('a', { href: state.url, download: file.name, rel: 'noopener noreferrer' }, '保存文件')),
      content,
      e('details', { className: 'document-evidence' }, e('summary', null, '历史执行快照'), renderWorkSurfaceContent(e, surface, 'watch', reloadKey)))
  }
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
  readonly jobs: readonly {
    readonly id: string
    readonly kind?: string
    readonly label: string
    readonly status: string
    readonly detail?: string
    readonly startedAt?: number
    readonly finishedAt?: number
    readonly cancellable: false
  }[]
  readonly subagents: readonly ({ readonly kind: 'child'; readonly id: string; readonly label?: string; readonly activity: string; readonly canOpen: true; readonly canInterrupt: boolean } | { readonly kind: 'diagnostic'; readonly id: string; readonly reason: string; readonly canOpen: false; readonly canInterrupt: false })[]
  readonly queue: readonly { readonly id: string; readonly placement: string; readonly preview: string; readonly text?: string | null; readonly editable: boolean; readonly removable: boolean; readonly steerable: boolean }[]
  readonly goal?: { readonly objective: string; readonly phase: string; readonly roundsStarted: number; readonly maxGoalRounds: number; readonly blockedReason?: string }
  readonly plan?: { readonly active: boolean; readonly pending: boolean }
  readonly todos: readonly { readonly id: string; readonly text: string; readonly status: string }[]
  readonly skills: readonly { readonly name: string; readonly description: string; readonly modelInvocable: boolean }[]
  readonly deliverables: readonly { readonly id: string; readonly title: string; readonly kind: string; readonly status: string }[]
  readonly taskGraph?: TaskGraphView
  readonly error?: string
}

type TaskGraphNodeStatus = 'pending' | 'running' | 'verifying' | 'completed' | 'blocked' | 'interrupted'
interface TaskGraphView {
  readonly version: 1
  readonly id: string
  readonly revision: number
  readonly sessionId: string
  readonly taskGeneration: number
  readonly goalId: string | null
  readonly objective: string
  readonly runtimeInstance: string
  readonly durability: 'pending' | 'durable'
  readonly status: 'ready' | 'active' | 'waiting' | 'completed'
  readonly stale: boolean
  readonly recoveryRequired: boolean
  readonly nodes: readonly {
    readonly id: string
    readonly title: string
    readonly dependencies: readonly string[]
    readonly acceptance: readonly { readonly id: string; readonly text: string }[]
    readonly status: TaskGraphNodeStatus
    readonly attempt: number
    readonly startSeq: number | null
    readonly evidence: readonly {
      readonly callId: string; readonly resultSeq: number; readonly toolName: string; readonly attempt: number
      readonly kind: 'execution' | 'reviewer-assessment'; readonly acceptanceId?: string; readonly assertion?: string; readonly sourceExcerpt?: string
    }[]
    readonly feedback: readonly { readonly text: string; readonly outcome: 'failed' | 'needs-work' | 'passed' | 'interrupted' }[]
  }[]
  readonly feedback: readonly { readonly text: string; readonly outcome: 'failed' | 'needs-work' | 'passed' | 'interrupted' }[]
}

interface ProviderReadinessSnapshot {
  readonly sessionId?: string
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
  readonly project?: string
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
  readonly status: 'idle' | 'loading' | 'ready' | 'degraded' | 'error'
  readonly memory?: MemorySnapshot
  readonly error?: { readonly message: string; readonly status?: number; readonly kind?: string }
}

interface MemoryProjectContext {
  readonly cwd?: string
  readonly canonical?: string
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
  readonly transactions: readonly PublicPluginTransaction[]
  readonly pendingRequests: number
  readonly error?: string
}

interface HostPluginFact {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: string | null
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
    getTheme(): { readonly preference: string; readonly active: { readonly id: string; readonly colorScheme: 'light' | 'dark' }; readonly revision: number; readonly fontSize?: number }
    setTheme(id: string): void
    setFontSize?(px: number): void
    overrideTokens?(source: string, tokens: Record<string, { light: string; dark: string }>): () => void
  }
  settingsScope?: { bind(spec: { namespace: string }): AppearanceSettingsScope }
  on(name: 'theme/change', listener: () => void): () => void
  agentRuntimeSession: {
    getSnapshot(): RuntimeSnapshot
    subscribe(listener: () => void): () => void
    sendTurn(input: { sessionId: string; content: string; images?: readonly RuntimeImageInput[]; files?: readonly FileReceipt[]; mode: 'queue' | 'steer' }): Promise<Result<{ accepted: true }>>
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
    /**
     * Move a session into another project. The Host forks the completed
     * history into the target project's directory, archives the original row,
     * and opens the returned session; the original cwd is never rewritten.
     */
    moveSessionToWorkspace(sessionId: string, workspaceId: string): Promise<Result<{ sessionId: string }>>
    search(query: string, signal: AbortSignal): Promise<Result<SearchResult>>
  }
  taskTimeline: {
    getSnapshot(): TimelineSnapshot
    subscribe(listener: () => void): () => void
    loadEarlier(): void
    getOutline?(): readonly { readonly key: string; readonly seq: number; readonly text: string }[]
    reveal?(seq: number): void
    readImage: HistoryImageReader
  }
  runtimeFiles?: RuntimeFiles
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
    select(input: { readonly sessionId?: string; readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): Promise<Result<{
      selected: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
      readonly persistence?: { readonly status: 'saved' | 'session-only'; readonly warning?: string }
      readonly effective?: 'next-request' | 'immediate'
    }>>
  }
  runCenter: {
    getSnapshot(): RunCenterSnapshot
    subscribe(listener: () => void): () => void
    refresh(): Promise<Result<RunCenterSnapshot>>
    updateQueue(input: { readonly sessionId: string; readonly itemId: string; readonly action: { readonly kind: 'remove' | 'steer' } | { readonly kind: 'edit'; readonly text: string } }): Promise<Result<{ accepted: true }>>
    setGoalPhase?(input: { readonly sessionId: string; readonly action: 'pause' | 'resume' }): Promise<Result<{ accepted: true }>>
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
      readonly sessionId?: string
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
    listHostPlugins(): Promise<Result<{ entries: readonly HostPluginFact[] }>>
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
  'settingsScope',
  'agentRuntimeSession',
  'sessionCommand',
  'sessionCatalog',
  'taskTimeline',
  'runtimeFiles',
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

type AppearancePreset = 'moss' | 'graphite' | 'ocean' | 'sand' | 'custom'
interface AppearanceValue {
  readonly preset: AppearancePreset
  readonly customAccent: string
  readonly customSurfaceLight: string
  readonly customBackgroundLight: string
  readonly customSurfaceDark: string
  readonly customBackgroundDark: string
}
type AppearanceMode = 'light' | 'dark'
type PaletteColors = readonly [accent: string, surface: string, background: string]
interface ImagePaletteColor { readonly color: string; readonly share: number }
interface AppearanceSettingsScope {
  getSnapshot(): { status: 'loading' | 'ready' | 'unavailable' | 'degraded'; value: unknown; writable: boolean; mode: 'host' | 'memory' }
  subscribe(listener: () => void): () => void
  mutate(ops: readonly { op: 'set'; path: readonly string[]; value: string }[]): Promise<void>
}
interface AppearanceSnapshot {
  readonly value: AppearanceValue
  readonly status: 'loading' | 'ready' | 'saving' | 'error' | 'unavailable'
  readonly writable: boolean
}
const DEFAULT_APPEARANCE: AppearanceValue = {
  preset: 'moss', customAccent: '#4d6e54', customSurfaceLight: '#fcfcfc', customBackgroundLight: '#f4f4f5',
  customSurfaceDark: '#1c1d1f', customBackgroundDark: '#17181a',
}
const APPEARANCE_PRESETS = [
  { id: 'moss', label: '竹影', detail: '温和的自然色', accent: '#4d6e54', darkAccent: '#b3ccb3', light: ['#fdfdfb', '#f3f4f0', '#f8f9f5'], dark: ['#1c1f1d', '#171a18', '#242925'] },
  { id: 'graphite', label: '墨灰', detail: '纯净的中性色', accent: '#52545d', darkAccent: '#c0c2cc', light: ['#fcfcfc', '#f4f4f5', '#f7f7f8'], dark: ['#1c1d1f', '#17181a', '#26272b'] },
  { id: 'ocean', label: '雾蓝', detail: '清晰、冷静', accent: '#416693', darkAccent: '#a9c5e8', light: ['#fcfdff', '#f1f4f8', '#f6f8fc'], dark: ['#1c1f25', '#171a20', '#252a33'] },
  { id: 'sand', label: '暖砂', detail: '柔和的纸张感', accent: '#86623c', darkAccent: '#d8bd98', light: ['#fffdf9', '#f4f1ea', '#faf6ef'], dark: ['#211e1a', '#1b1916', '#2b2721'] },
] as const

/** Narrow persisted values before they can enter CSS, including older or damaged files. */
export function normalizeAppearance(value: unknown): AppearanceValue {
  const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const color = (key: keyof Omit<AppearanceValue, 'preset'>): string => typeof input[key] === 'string' && /^#[0-9a-f]{6}$/iu.test(input[key]) ? input[key].toLowerCase() : DEFAULT_APPEARANCE[key]
  return {
    preset: ['moss', 'graphite', 'ocean', 'sand', 'custom'].includes(String(input.preset)) ? input.preset as AppearancePreset : 'moss',
    customAccent: color('customAccent'), customSurfaceLight: color('customSurfaceLight'), customBackgroundLight: color('customBackgroundLight'),
    customSurfaceDark: color('customSurfaceDark'), customBackgroundDark: color('customBackgroundDark'),
  }
}

/** Backgrounds are mode-specific; the existing shared accent remains backward compatible. */
export function customPaletteColors(value: unknown, mode: AppearanceMode): PaletteColors {
  const normalized = normalizeAppearance(value)
  return mode === 'dark' ? [normalized.customAccent, normalized.customSurfaceDark, normalized.customBackgroundDark]
    : [normalized.customAccent, normalized.customSurfaceLight, normalized.customBackgroundLight]
}

export function updateCustomPalette(value: unknown, mode: AppearanceMode, colors: PaletteColors): AppearanceValue {
  return normalizeAppearance({ ...normalizeAppearance(value), preset: 'custom', customAccent: colors[0],
    ...(mode === 'dark' ? { customSurfaceDark: colors[1], customBackgroundDark: colors[2] }
      : { customSurfaceLight: colors[1], customBackgroundLight: colors[2] }) })
}

/** sRGB -> Oklab, for perceptual grouping rather than raw RGB distance.
 * Matrices: https://bottosson.github.io/posts/oklab/ (public-domain reference).
 */
function imageColorCoordinates(rgb: readonly number[]): number[] {
  const [r, g, b] = rgb.map(channel => {
    const value = channel / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  }) as [number, number, number]
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b)
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b)
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b)
  return [.2104542553 * l + .793617785 * m - .0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .808675766 * s]
}

/** Discover up to eight independent color families for manual role assignment.
 * Fixed perceptual anchors prevent chained merges across different surfaces.
 * Unselected families (or pixels outside the bounded anchors) keep their area:
 * shares use the whole visible sample, never a renormalized three-color total.
 */
export function extractImagePalette(pixels: Uint8ClampedArray): ImagePaletteColor[] {
  if (!pixels.length || pixels.length % 4 !== 0) throw new Error('图片没有有效像素。')
  type Cluster = { rgb: number[]; weight: number }
  const histogram = new Map<number, Cluster>()
  const stride = Math.max(1, Math.ceil(pixels.length / 4 / 65536)) * 4
  for (let offset = 0; offset < pixels.length; offset += stride) {
    const alpha = pixels[offset + 3]! / 255
    if (alpha < .05) continue
    const rgb = [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!]
    const key = ((rgb[0]! >> 3) << 10) | ((rgb[1]! >> 3) << 5) | (rgb[2]! >> 3)
    const bin = histogram.get(key) ?? { rgb: [0, 0, 0], weight: 0 }
    for (let channel = 0; channel < 3; channel++) bin.rgb[channel]! += rgb[channel]! * alpha
    bin.weight += alpha; histogram.set(key, bin)
  }
  const bins = [...histogram.entries()].map(([key, bin]) => {
    const rgb = bin.rgb.map(channel => channel / bin.weight)
    return { key, rgb, coordinates: imageColorCoordinates(rgb), weight: bin.weight }
  }).sort((a, b) => b.weight - a.weight || a.key - b.key)
  if (!bins.length) throw new Error('图片完全透明，无法提取颜色。')
  const distance = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, channel, index) => sum + (channel - b[index]!) ** 2, 0)
  const total = bins.reduce((sum, bin) => sum + bin.weight, 0)
  // This radius groups texture/shading, not all colors needed to fill three slots.
  // The cap bounds work for noisy photos; distant overflow remains "other".
  const radiusSquared = .05 ** 2
  const anchors: number[][] = []
  for (const bin of bins) {
    if (anchors.every(anchor => distance(anchor, bin.coordinates) > radiusSquared)) anchors.push(bin.coordinates)
    if (anchors.length === 64) break
  }
  const groups: Cluster[] = anchors.map(() => ({ rgb: [0, 0, 0], weight: 0 }))
  for (const bin of bins) {
    let nearest = -1; let separation = radiusSquared
    anchors.forEach((anchor, index) => {
      const delta = distance(anchor, bin.coordinates)
      if (delta <= separation) { nearest = index; separation = delta }
    })
    if (nearest < 0) continue
    const group = groups[nearest]!
    group.weight += bin.weight
    for (let channel = 0; channel < 3; channel++) group.rgb[channel]! += bin.rgb[channel]! * bin.weight
  }
  // Adjacent histogram peaks can describe one textured surface. Consolidate
  // their measured means, keeping each largest family's reference fixed so a
  // sequence of small gradients cannot bridge cream -> peach -> terracotta.
  const families: (Cluster & { reference: number[] })[] = []
  for (const group of groups.filter(entry => entry.weight > 0).sort((a, b) => b.weight - a.weight)) {
    const coordinates = imageColorCoordinates(group.rgb.map(channel => channel / group.weight))
    let nearest: typeof families[number] | undefined; let separation = radiusSquared
    for (const family of families) {
      const delta = distance(family.reference, coordinates)
      if (delta <= separation) { nearest = family; separation = delta }
    }
    if (!nearest) { families.push({ ...group, rgb: [...group.rgb], reference: coordinates }); continue }
    nearest.weight += group.weight
    for (let channel = 0; channel < 3; channel++) nearest.rgb[channel]! += group.rgb[channel]!
  }
  return families.sort((a, b) => b.weight - a.weight).slice(0, 8).map(group => ({
    color: `#${group.rgb.map(channel => Math.round(channel / group.weight).toString(16).padStart(2, '0')).join('')}`, share: group.weight / total,
  }))
}

/** Only decodes a bounded local bitmap. No upload, URL fetch, model call or persistent image data. */
export async function readImagePalette(file: File): Promise<{ colors: ImagePaletteColor[]; thumbnail: string }> {
  if (!file.size) throw new Error('图片是空的，请重新选择。')
  if (file.size > 10 * 1024 * 1024) throw new Error('请选择不超过 10 MB 的图片。')
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。')
  let bitmap: ImageBitmap | undefined
  try {
    // 65k samples retain small surface boundaries while keeping decoding and
    // clustering bounded; the previous 128px reduction diluted their area.
    const size = 256
    bitmap = await createImageBitmap(file, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' })
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('canvas unavailable')
    context.drawImage(bitmap, 0, 0)
    const colors = extractImagePalette(context.getImageData(0, 0, size, size).data)
    return { colors, thumbnail: canvas.toDataURL('image/png') }
  } catch (error) {
    if (error instanceof Error && /透明/.test(error.message)) throw error
    throw new Error('无法读取这张图片，请换一张 PNG、JPG 或 WebP 图片。')
  } finally { bitmap?.close() }
}

/** Area selects the two bases; chroma selects the accent. Missing colors retain the user's bases. */
export function paletteFromImage(colors: readonly ImagePaletteColor[], value: unknown, mode: AppearanceMode): AppearanceValue {
  const ranked = colors.filter(entry => /^#[0-9a-f]{6}$/iu.test(entry.color) && Number.isFinite(entry.share) && entry.share > 0)
    .sort((a, b) => b.share - a.share).slice(0, 3)
  if (!ranked.length) return normalizeAppearance(value)
  const chroma = (color: string): number => { const channels = colorChannels(color); return Math.max(...channels) - Math.min(...channels) }
  const accent = ranked.reduce((chosen, entry) => chroma(entry.color) >= chroma(chosen.color) ? entry : chosen)
  const bases = ranked.filter(entry => entry !== accent)
  const current = customPaletteColors(value, mode)
  return updateCustomPalette(value, mode, [accent.color, bases[0]?.color ?? current[1], bases[1]?.color ?? current[2]])
}

function colorChannels(hex: string): number[] { return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) }
function mixColor(color: string, toward: string, ratio: number): string {
  const other = colorChannels(toward)
  return `#${colorChannels(color).map((channel, index) => Math.round(channel * (1 - ratio) + other[index]! * ratio).toString(16).padStart(2, '0')).join('')}`
}
function colorContrast(a: string, b: string): number {
  const luminance = (hex: string): number => colorChannels(hex).map(channel => {
    const value = channel / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0)
  const first = luminance(a); const second = luminance(b)
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05)
}
/** Keep chosen hue, but adjust lightness when text/focus would disappear on the surface. */
function readableAccent(color: string, background: string): string {
  const toward = colorContrast('#000000', background) > colorContrast('#ffffff', background) ? '#000000' : '#ffffff'
  for (let step = 0; step <= 25; step++) {
    const candidate = mixColor(color, toward, step / 25)
    if (colorContrast(candidate, background) >= 4.6) return candidate
  }
  return toward
}

/** One semantic palette drives the real shell, settings portals and lightweight sample alike. */
export function appearanceTokens(value: AppearanceValue, mode: 'light' | 'dark'): Record<string, string> {
  const normalized = normalizeAppearance(value)
  const palette = APPEARANCE_PRESETS.find(preset => preset.id === normalized.preset) ?? APPEARANCE_PRESETS[1]
  const dark = mode === 'dark'
  const custom = normalized.preset === 'custom'
  const chosen = customPaletteColors(normalized, mode)
  const [surface, background] = custom ? [chosen[1], chosen[2]] : dark ? palette.dark : palette.light
  const ink = custom ? readableAccent(dark ? '#edf0ed' : '#252b27', surface) : dark ? '#edf0ed' : '#252b27'
  const muted = custom ? readableAccent(dark ? '#adb6af' : '#636b65', surface) : dark ? '#adb6af' : '#636b65'
  const layer = custom ? mixColor(surface, ink, .035) : (dark ? palette.dark : palette.light)[2]
  const requested = normalized.preset === 'custom' ? normalized.customAccent : dark ? palette.darkAccent : palette.accent
  const accent = readableAccent(requested, surface)
  // A fill does not need text-on-surface contrast. Preserve the user's pigment;
  // adapt its label, focus ring and link tone independently instead of recoloring it.
  const fill = custom ? requested : accent
  const soft = mixColor(surface, fill, dark ? .12 : .09)
  const accentText = readableAccent(accent, soft)
  const onAccent = colorContrast('#ffffff', fill) >= 4.5 ? '#ffffff' : colorContrast('#171a18', fill) >= 4.5 ? '#171a18' : '#000000'
  const hoverFill = custom ? mixColor(fill, onAccent === '#ffffff' ? '#000000' : '#ffffff', .06) : accentText
  const tokens: Record<string, string> = {
    '--bg': background, '--surface': surface, '--surface-2': layer, '--card': custom ? surface : dark ? layer : '#ffffff',
    '--card-hover': mixColor(surface, ink, .065), '--ink': ink, '--ink2': custom ? ink : dark ? '#c4cdc6' : '#4e5851', '--ink3': muted, '--faint': muted,
    '--line': mixColor(surface, ink, .14), '--line2': mixColor(surface, ink, .20), '--line3': mixColor(surface, ink, .31),
    '--accent': accent, '--accent-deep': accentText, '--accent-bg': soft,
    '--cta': fill, '--cta-deep': hoverFill, '--cta-ink': onAccent, '--cta-glow': `${fill}22`, '--cta-border': custom ? accent : 'transparent',
    '--ok': dark ? '#a2c9ad' : '#3d7050', '--info': dark ? '#acc8e6' : '#416993',
    '--warn': dark ? '#ddc292' : '#85632c', '--err': dark ? '#e3a99d' : '#a3473b',
  }
  const sidebarInk = readableAccent(ink, background)
  const sidebarAccent = readableAccent(requested, background)
  tokens['--sidebar-ink'] = sidebarInk
  tokens['--sidebar-muted'] = readableAccent(muted, background)
  tokens['--sidebar-accent'] = sidebarAccent
  tokens['--sidebar-accent-bg'] = mixColor(background, custom ? requested : sidebarAccent, .10)
  tokens['--sidebar-accent-deep'] = readableAccent(sidebarAccent, tokens['--sidebar-accent-bg']!)
  tokens['--sidebar-line'] = mixColor(background, sidebarInk, .20)
  tokens['--sidebar-card'] = mixColor(background, sidebarInk, .035)
  const aliases: Record<string, string> = {
    '--dsw-alias-bg-base': '--surface', '--dsw-alias-bg-layer-1': '--bg', '--dsw-alias-bg-layer-2': '--surface-2',
    '--dsw-alias-bg-overlay': '--card', '--dsw-alias-border-l1': '--line', '--dsw-alias-border-l2': '--line2',
    '--dsw-alias-brand-primary': '--accent', '--dsw-alias-label-primary': '--ink', '--dsw-alias-label-secondary': '--ink3',
    '--dsw-alias-state-error-primary': '--err', '--dsw-alias-state-success-primary': '--ok', '--dsw-alias-state-warn-primary': '--warn',
    '--dsw-specific-sidebar-fill': '--bg',
  }
  for (const [alias, semantic] of Object.entries(aliases)) tokens[alias] = tokens[semantic]!
  return tokens
}

/**
 * The host remains authoritative. Coalesce rapid color changes and hold the newest
 * preview through older acknowledgements; only the last durable write earns "saved".
 */
export function createAppearancePreference(scope?: AppearanceSettingsScope) {
  const listeners = new Set<() => void>()
  const initial = scope?.getSnapshot()
  let snapshot: AppearanceSnapshot = {
    value: normalizeAppearance(initial?.value),
    status: initial?.status === 'loading' ? 'loading' : initial?.status === 'ready' && initial.mode === 'host' ? 'ready' : 'unavailable',
    writable: initial?.status === 'ready' && initial.writable === true && initial.mode === 'host',
  }
  let pending: AppearanceValue | undefined
  let draining: Promise<void> | undefined
  let disposed = false
  const publish = (next: AppearanceSnapshot): void => {
    snapshot = next
    if (!disposed) for (const listener of listeners) listener()
  }
  const unsubscribe = scope?.subscribe(() => {
    const host = scope.getSnapshot()
    const writable = host.writable && host.mode === 'host' && host.status === 'ready'
    if (draining !== undefined || pending !== undefined || snapshot.status === 'error') {
      publish({ ...snapshot, writable })
      return
    }
    publish({ value: normalizeAppearance(host.value), writable,
      status: host.status === 'loading' ? 'loading' : host.status === 'ready' && host.mode === 'host' ? 'ready' : 'unavailable' })
  })
  const save = (value: AppearanceValue): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (!scope || !snapshot.writable) { publish({ ...snapshot, status: 'unavailable' }); return Promise.resolve() }
    pending = normalizeAppearance(value)
    publish({ value: pending, writable: true, status: 'saving' })
    if (draining !== undefined) return draining
    draining = (async () => {
      while (pending !== undefined && !disposed) {
        const next = pending; pending = undefined
        try {
          await scope.mutate(Object.entries(next).map(([key, value]) => ({ op: 'set', path: [key], value })))
          if (pending === undefined) {
            const host = scope.getSnapshot()
            const accepted = normalizeAppearance(host.value)
            if (host.status !== 'ready' || host.mode !== 'host' || JSON.stringify(accepted) !== JSON.stringify(next)) throw new Error('appearance write not acknowledged')
            publish({ value: accepted, status: 'ready', writable: host.writable })
          }
        } catch {
          if (pending === undefined) publish({ ...snapshot, status: 'error' })
        }
      }
    })().finally(() => { draining = undefined })
    return draining
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    save,
    dispose() { disposed = true; pending = undefined; unsubscribe?.(); listeners.clear() },
  }
}

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
/** sessionStorage deliberately keeps unfinished prompts out of durable disk storage. */
export const COMPOSER_DRAFT_CURRENT_WINDOW_NOTICE = '草稿仅保存在当前窗口；关闭窗口或崩溃后不会恢复。'
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
  readonly seq?: number
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
export function buildUserTurnNavigation(items: TimelineSnapshot['items'], outline?: readonly { key: string; seq: number; text: string }[]): readonly UserTurnNavigationItem[] {
  if (outline !== undefined) return outline.map((item, index) => ({
    key: item.key, seq: item.seq, eventIndex: items.findIndex(row => row.key === item.key), ordinal: index + 1,
    preview: item.text.replace(/\s+/gu, ' ').trim().slice(0, USER_TURN_PREVIEW_MAX_CHARS) || '（附件或无文字内容）',
  }))
  const result: UserTurnNavigationItem[] = []
  for (const [eventIndex, item] of items.entries()) {
    if (item.kind !== 'user') continue
    const normalized = item.text.replace(/\s+/g, ' ').trim()
    const characters = Array.from(normalized)
    const preview = normalized === ''
      ? (item.images?.length ? `图片 ${item.images.length} 张` : '（无文字内容）')
      : characters.length <= USER_TURN_PREVIEW_MAX_CHARS
        ? normalized
        : `${characters.slice(0, USER_TURN_PREVIEW_MAX_CHARS - 1).join('').trimEnd()}…`
    result.push({ key: item.key, eventIndex, ordinal: result.length + 1, preview })
  }
  return result
}

/** Page the complete outline, not the timeline itself. Reserve two 24px controls
 * for long conversations so neither history length nor page zoom adds a nested
 * scrollbar. A manual page is temporary; the next reading-position change follows
 * the active message again. Tiny viewports keep ordinary transcript scrolling. */
export function userTurnNavigationPage(
  items: readonly UserTurnNavigationItem[], activeOrdinal: number | undefined,
  requestedPage: number | undefined, availableHeight: number | undefined,
): { items: readonly UserTurnNavigationItem[]; page: number; pageCount: number } {
  const height = availableHeight !== undefined && Number.isFinite(availableHeight) ? availableHeight : 216
  const slots = Math.min(7, Math.max(0, Math.floor((height - 16) / 24)))
  const needsPaging = items.length > Math.min(5, slots)
  const capacity = Math.min(5, Math.max(0, slots - (needsPaging ? 2 : 0)))
  if (items.length === 0 || capacity === 0) return { items: [], page: 0, pageCount: 0 }
  const pageCount = Math.ceil(items.length / capacity)
  const activeIndex = Math.max(0, items.findIndex(item => item.ordinal === activeOrdinal))
  const requested = requestedPage !== undefined && Number.isFinite(requestedPage)
    ? Math.floor(requestedPage) : Math.floor(activeIndex / capacity)
  const page = Math.min(pageCount - 1, Math.max(0, requested))
  return { items: items.slice(page * capacity, (page + 1) * capacity), page, pageCount }
}

/** Prefetch only on upward reading, never on startup or bottom-follow. */
export function shouldPrefetchHistory(input: {
  scrollTop: number; previousTop: number; clientHeight: number; hasEarlier: boolean; loading: boolean
}): boolean {
  return input.hasEarlier && !input.loading
    && [input.scrollTop, input.previousTop, input.clientHeight].every(Number.isFinite)
    && input.clientHeight > 0 && input.scrollTop < input.previousTop
    && input.scrollTop <= Math.min(240, input.clientHeight / 2)
}

/** Stable-message anchoring excludes unrelated new replies from the prepend
 * delta. Height is a fallback for a viewport without a surviving anchor. */
export function historyPrependScrollTop(input: {
  scrollTop: number; previousHeight: number; scrollHeight: number; anchorTop?: number; previousAnchorTop?: number
}): number {
  const delta = input.anchorTop !== undefined && input.previousAnchorTop !== undefined
    ? input.anchorTop - input.previousAnchorTop : Math.max(0, input.scrollHeight - input.previousHeight)
  return Math.max(0, input.scrollTop + delta)
}

interface HistoryPrependState {
  readonly owner: string | undefined
  readonly firstKey: string | undefined
  anchorKey: string | undefined
  anchorTop: number | undefined
  height: number
  timeout?: ReturnType<typeof setTimeout>
}

/** Record the reader's current message, including collapsed tool groups. */
function historyViewportAnchor(stream: HTMLElement): Pick<HistoryPrependState, 'anchorKey' | 'anchorTop' | 'height'> {
  const top = stream.getBoundingClientRect().top
  const anchor = Array.from(stream.querySelectorAll<HTMLElement>('.events > [data-event-key]'))
    .find(node => node.getBoundingClientRect().bottom > top + 1)
  return { height: stream.scrollHeight, anchorKey: anchor?.getAttribute('data-event-key') ?? undefined,
    anchorTop: anchor === undefined ? undefined : anchor.getBoundingClientRect().top - top }
}

type HistoryImageState = { readonly status: 'loading' | 'ready' | 'error'; readonly url?: string }

/** A rendered historical image owns only its Blob URL, never composer state.
 * Generation checks also cover retry/unmount while an authorized read is pending. */
export function createHistoryImageResource(input: {
  readonly sessionId: string; readonly image: HistoryImageRef; readonly readImage: HistoryImageReader
  readonly onChange: (state: HistoryImageState) => void
}, urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL): { load(): Promise<void>; fail(): void; dispose(): void } {
  let generation = 0; let disposed = false; let ownedUrl: string | undefined
  const release = (): void => { if (ownedUrl !== undefined) { urls.revokeObjectURL(ownedUrl); ownedUrl = undefined } }
  const fail = (): void => { if (disposed) return; generation++; release(); input.onChange({ status: 'error' }) }
  return {
    async load() {
      if (disposed) return
      const request = ++generation; release(); input.onChange({ status: 'loading' })
      try {
        const result = await input.readImage({ sessionId: input.sessionId, attachmentId: input.image.attachmentId })
        if (disposed || generation !== request) return
        const actual = result.attachment; const expected = input.image
        if (!actual || !/^sha256:[a-f0-9]{64}$/u.test(actual.attachmentId)
          || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(actual.mediaType)
          || actual.attachmentId !== expected.attachmentId || actual.mediaType !== expected.mediaType
          || actual.width !== expected.width || actual.height !== expected.height || actual.bytes !== expected.bytes
          || !(result.data instanceof Uint8Array) || result.data.byteLength !== expected.bytes) throw new Error('invalid historical image')
        const url = urls.createObjectURL(new Blob([Uint8Array.from(result.data).buffer], { type: actual.mediaType }))
        if (!url.startsWith('blob:')) throw new Error('historical images require Blob URLs')
        ownedUrl = url
        input.onChange({ status: 'ready', url })
      } catch { if (!disposed && generation === request) fail() }
    },
    fail,
    dispose() { if (disposed) return; disposed = true; generation++; release() },
  }
}

export function createHistoryImageComponent(react: ReactLike, readImage: HistoryImageReader): (props: { sessionId: string; image: HistoryImageRef; ordinal: number }) => unknown {
  const e = react.createElement
  const ImageViewer = createImageViewer(react)
  return ({ sessionId, image, ordinal }) => {
    const identity = JSON.stringify([sessionId, image.attachmentId, image.mediaType, image.bytes, image.width, image.height])
    const [loaded, setLoaded] = react.useState<{ identity: string; value: HistoryImageState }>({ identity, value: { status: 'loading' } })
    const resource = react.useRef<ReturnType<typeof createHistoryImageResource> | undefined>(undefined)
    react.useEffect(() => {
      const current = createHistoryImageResource({ sessionId, image, readImage, onChange: value => setLoaded({ identity, value }) })
      resource.current = current; void current.load()
      return () => { current.dispose(); if (resource.current === current) resource.current = undefined }
    }, [identity])
    const state = loaded.identity === identity ? loaded.value : { status: 'loading' as const }
    const label = image.name || `历史图片 ${ordinal}`
    const imageProps = {
      src: state.url, alt: label, width: image.width, height: image.height,
      'data-attachment-id': image.attachmentId, 'data-session-id': sessionId,
      onError: () => resource.current?.fail(),
    }
    return e('figure', { className: 'history-image', 'data-attachment-id': image.attachmentId, 'data-session-id': sessionId, 'data-image-state': state.status },
      state.status === 'ready' && state.url?.startsWith('blob:') ? e(ImageViewer, imageProps, e('img', imageProps)) : e('div', { className: 'history-image-placeholder', role: 'status' },
        state.status === 'error' ? '图片加载失败' : '图片加载中…',
        state.status === 'error' ? e('button', { type: 'button', onClick: () => { void resource.current?.load() }, 'aria-label': `重试加载${label}` }, '重试') : null),
      e('figcaption', null, label))
  }
}

/** Decorative image expansion does not navigate or outlive its parent's owned URL. */
function createImageViewer(react: ReactLike): (props: { src: string; alt: string; width?: number; height?: number; onError?: () => void; children?: unknown }) => unknown {
  const e = react.createElement
  return props => {
    const [open, setOpen] = react.useState(false)
    const trigger = react.useRef<HTMLButtonElement | null>(null)
    const close = react.useRef<HTMLButtonElement | null>(null)
    react.useEffect(() => { setOpen(false) }, [props.src])
    react.useEffect(() => {
      if (!open) return
      close.current?.focus()
      return () => { trigger.current?.focus() }
    }, [open])
    return e('div', { className: 'image-viewer' },
      e('button', { type: 'button', ref: trigger, className: 'image-expand', 'aria-label': `放大 ${props.alt}`, onClick: () => setOpen(true) }, props.children ?? e('img', props)),
      !open ? null : e('div', { className: 'image-lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.alt,
        onClick: (event: { target: EventTarget; currentTarget: EventTarget }) => { if (event.target === event.currentTarget) setOpen(false) },
        onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
          if (event.key === 'Tab') { event.preventDefault(); close.current?.focus() }
        } },
        e('button', { type: 'button', ref: close, 'aria-label': '关闭图片预览', onClick: () => setOpen(false) }, '关闭 · Esc'),
        e('img', { src: props.src, alt: props.alt, onError: () => { setOpen(false); props.onError?.() } })))
  }
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
  let ordinal: number | undefined
  for (const [index, offset] of offsets.entries()) {
    // The full outline includes history outside the currently rendered window.
    if (!Number.isFinite(offset)) continue
    ordinal ??= index + 1
    if (offset > readingLine + subpixelTolerance) break
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

/** Distance from the stream floor below which the reader still counts as
 * pinned: new content keeps following. */
const PINNED_FOLLOW_THRESHOLD = 24

/** A reader within the pinned threshold owns bottom-follow; anything above it
 * has deliberately scrolled away and must not be yanked back down. */
export function isPinnedAtBottom(metrics: ConversationScrollMetrics): boolean {
  const { scrollHeight, scrollTop, clientHeight } = metrics
  if (![scrollHeight, scrollTop, clientHeight].every(Number.isFinite) || clientHeight <= 0) return true
  return scrollHeight - clientHeight - Math.max(0, scrollTop) <= PINNED_FOLLOW_THRESHOLD
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
  for (const id of ids) known.add(id)
  const knownIds = [...known].slice(-64)
  const pinnedIds = preference.pinnedIds.filter(id => available.has(id))
  const dismissedIds = preference.dismissedIds.filter(id => available.has(id))
  const visible = ids.filter(id => !dismissedIds.includes(id))
  // Replay and passive tool results update the list, not the user's intent.
  // Explicit material/launcher clicks own opening; new results must not steal
  // the selected content or reopen a dock the user has just closed.
  const activeId = preference.activeId !== undefined && visible.includes(preference.activeId)
    ? preference.activeId
    : visible.at(-1)
  const reconciled = {
    open: preference.open && activeId !== undefined,
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
    // Reserve the existing 14 px divider hit target as well: a visually fitted
    // dock can otherwise still steal clicks from the composer's send button.
    ? Math.max(WORK_SURFACE_DOCK_LIMITS.min, Math.floor(chatWidth - 560 - 14))
    : WORK_SURFACE_DOCK_LIMITS.max
  const preferred = Number.isFinite(requested) && requested > 0 ? requested : WORK_SURFACE_DOCK_LIMITS.standard
  return Math.round(clampNumber(preferred, WORK_SURFACE_DOCK_LIMITS.min, Math.min(WORK_SURFACE_DOCK_LIMITS.max, maximumForChat)))
}

const BROWSER_WIDTH_STORAGE_KEY = 'xsla-browser-width-v1'

export type WorkbenchView = 'task' | 'materials' | 'browser'
const WORKBENCH_OVERLAY_BREAKPOINT = 1240

/** One reading area, with the existing per-mode preferences kept intact. */
export function workbenchPanelWidth(view: WorkbenchView, widths: { task: number; materials: number; browser: number | undefined }, availableWidth: number): number {
  if (view === 'browser') return browserDockWidth(widths.browser, availableWidth)
  if (view === 'materials') return workSurfaceDockWidth(widths.materials, availableWidth)
  const requested = Number.isFinite(widths.task) && widths.task > 0 ? widths.task : 280
  const maximum = Number.isFinite(availableWidth) ? Math.max(248, Math.min(400, availableWidth - 574)) : 400
  return Math.round(clampNumber(requested, 248, maximum))
}

export function workbenchTabKeyTarget(current: WorkbenchView, key: string, browserAvailable: boolean): WorkbenchView | undefined {
  const views: WorkbenchView[] = browserAvailable ? ['task', 'materials', 'browser'] : ['task', 'materials']
  const index = Math.max(0, views.indexOf(current))
  if (key === 'Home') return views[0]
  if (key === 'End') return views.at(-1)
  if (key === 'ArrowRight') return views[(index + 1) % views.length]
  if (key === 'ArrowLeft') return views[(index + views.length - 1) % views.length]
  return undefined
}

export function workbenchNotice(options: {
  questionCount: number; approvalCount: number; runCenter: RunCenterSnapshot
  contextView: { level: string }; heartbeat: { tone?: string }
}): { kind: 'interaction' | 'task'; label: string } | undefined {
  if (options.questionCount > 0) return { kind: 'interaction', label: `${options.questionCount} 项问题等待回答` }
  if (options.approvalCount > 0) return { kind: 'interaction', label: `${options.approvalCount} 项操作等待确认` }
  if (options.runCenter.status === 'error') return { kind: 'task', label: /not attached|not found/i.test(options.runCenter.error ?? '') ? '任务状态未连接' : '任务状态需要关注' }
  if (runCenterWorkbenchPresentation(options.runCenter).attentionGroups.length > 0 || taskGraphNeedsAttention(options.runCenter.taskGraph)
    || options.contextView.level === 'critical' || options.heartbeat.tone === 'warn') return { kind: 'task', label: '有运行事项需要关注' }
  return undefined
}

export function browserDockWidth(requested: number | undefined, chatWidth: number): number {
  const available = Number.isFinite(chatWidth) && chatWidth > 0 ? chatWidth : 1236
  const maximum = Math.max(320, Math.floor(available - 574))
  const preferred = requested !== undefined && Number.isFinite(requested) && requested > 0
    ? requested : Math.min(available * .45, 640)
  return Math.round(clampNumber(preferred, 320, maximum))
}

function readBrowserWidth(): number | undefined {
  try {
    const value = Number(globalThis.localStorage?.getItem(BROWSER_WIDTH_STORAGE_KEY))
    return Number.isFinite(value) && value > 0 ? value : undefined
  } catch { return undefined }
}

export type ResizablePanel = 'side' | 'inspector'

export interface PanelWidths {
  readonly side: number
  readonly inspector: number
}

export const PANEL_WIDTH_STORAGE_KEY = 'xsla-panel-widths-v1'
// Below this width the inspector becomes a drawer so the current task keeps
// a genuinely useful working surface on compact laptops and portrait tablets.
export const PANEL_RESIZE_DESKTOP_BREAKPOINT = 1240
export const PANEL_WIDTH_LIMITS = {
  side: { min: 188, max: 420, standard: 232, wide: 256 },
  inspector: { min: 248, max: 400, standard: 280, wide: 300 },
  centerMin: 640,
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

/** Opening the inspector is a drawer action only while the rails are off-canvas. */
export function openInspectorOverlayState(_current: OverlayState, viewportWidth: number): OverlayState {
  return viewportWidth <= PANEL_RESIZE_DESKTOP_BREAKPOINT
    ? { side: false, inspector: true }
    : { side: false, inspector: false }
}

/** A desktop resize must never leave a mobile scrim covering the application. */
export function overlayStateAfterViewportResize(current: OverlayState, viewportWidth: number): OverlayState {
  return viewportWidth > PANEL_RESIZE_DESKTOP_BREAKPOINT && (current.side || current.inspector)
    ? { side: false, inspector: false }
    : current
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
  const appearance = createAppearancePreference(ctx.settingsScope?.bind({ namespace: 'xiaoshe-appearance' }))
  let releasePalette: (() => void) | undefined
  let installedPalette = ''
  const syncPalette = (): void => {
    const value = appearance.getSnapshot().value
    const identity = JSON.stringify(value)
    if (identity === installedPalette) return
    installedPalette = identity
    const light = appearanceTokens(value, 'light'); const dark = appearanceTokens(value, 'dark')
    const pairs = Object.fromEntries(Object.keys(light).map(key => [key, { light: light[key]!, dark: dark[key]! }]))
    // Replace before disposing the old layer: avoids a flash and duplicate theme ownership.
    const previous = releasePalette
    releasePalette = ctx.theme.overrideTokens?.('xiaoshe-appearance', pairs)
    previous?.()
  }
  syncPalette()
  const unsubscribeAppearance = appearance.subscribe(syncPalette)
  const AppearanceSettingsSection = (): unknown => {
    const state = react.useSyncExternalStore(appearance.subscribe, appearance.getSnapshot)
    const themeState = react.useSyncExternalStore(listener => ctx.on('theme/change', listener), () => ctx.theme.getTheme())
    const mode = themeState.active.colorScheme
    const labels = ['强调色', '主界面底色', '侧栏底色'] as const
    const [selectedColor, setSelectedColor] = react.useState(0)
    const [draft, setDraft] = react.useState<AppearanceValue | undefined>(undefined)
    const [customDraft, setCustomDraft] = react.useState(state.value.customAccent)
    const [imageResult, setImageResult] = react.useState<{ colors: ImagePaletteColor[]; thumbnail: string; name: string } | undefined>(undefined)
    const [imageError, setImageError] = react.useState<string | undefined>(undefined)
    const [extracting, setExtracting] = react.useState(false)
    const imageRequest = react.useRef(0)
    const [swapFrom, setSwapFrom] = react.useState<number | undefined>(undefined)
    const [dragging, setDragging] = react.useState<{ source: number; target: number | undefined } | undefined>(undefined)
    const [swapNotice, setSwapNotice] = react.useState('')
    const dragCleanup = react.useRef<(() => void) | undefined>(undefined)
    const suppressDragClick = react.useRef(false)
    // Closing settings, changing modes or receiving a host update invalidates any
    // in-flight decode; an old file must never replace a newer manual selection.
    react.useEffect(() => {
      dragCleanup.current?.(); setSwapFrom(undefined); setSwapNotice('')
      imageRequest.current++; setDraft(undefined); setImageResult(undefined); setImageError(undefined); setExtracting(false)
      setCustomDraft(customPaletteColors(state.value, mode)[selectedColor]!)
      return () => { imageRequest.current++; dragCleanup.current?.() }
    }, [state.value, mode, state.writable])
    const colors = customPaletteColors(draft ?? state.value, mode)
    const selectedLabel = labels[selectedColor]!
    const validCustom = /^#[0-9a-f]{6}$/iu.test(customDraft)
    const preview = draft ?? state.value
    const imageOtherShare = imageResult ? Math.max(0, 1 - imageResult.colors.reduce((sum, entry) => sum + entry.share, 0)) : 0
    const imagePercent = (share: number): string => share > 0 && share < .001 ? '<0.1%' : `${Math.round(share * 1000) / 10}%`
    const discard = (): void => {
      dragCleanup.current?.(); setSwapFrom(undefined); setSwapNotice('')
      imageRequest.current++; setDraft(undefined); setImageResult(undefined); setImageError(undefined); setExtracting(false)
      setCustomDraft(customPaletteColors(state.value, mode)[selectedColor]!)
    }
    const choose = (preset: AppearancePreset): void => { discard(); void appearance.save({ ...state.value, preset }) }
    const swapColors = (from: number, to: number): void => {
      setSwapFrom(undefined)
      if (!state.writable || ![from, to].every(index => Number.isInteger(index) && index >= 0 && index < 3) || from === to || colors[from] === colors[to]) return
      imageRequest.current++; setExtracting(false)
      const next = [...colors] as [string, string, string]
      ;[next[from], next[to]] = [next[to]!, next[from]!]
      setDraft(updateCustomPalette(draft ?? state.value, mode, next)); setCustomDraft(next[selectedColor]!)
      setSwapNotice(`已互换${labels[from]}与${labels[to]}，尚未应用。`)
    }
    const selectColor = (index: number): void => {
      if (swapFrom !== undefined) { swapColors(swapFrom, index); return }
      imageRequest.current++; setExtracting(false); setSelectedColor(index); setCustomDraft(colors[index]!)
    }
    const editColor = (value: string): void => {
      if (!state.writable) return
      dragCleanup.current?.(); setSwapFrom(undefined); setSwapNotice('')
      imageRequest.current++; setExtracting(false); setCustomDraft(value)
      if (!/^#[0-9a-f]{6}$/iu.test(value)) return
      const next = [...colors] as [string, string, string]; next[selectedColor] = value
      setDraft(updateCustomPalette(draft ?? state.value, mode, next))
    }
    /** Own only this gesture: fixed roles are hit-tested, and release is the sole
     * commit point. Cancel, blur, unmount or a newer palette invalidates it.
     * Mouse movement also starts a conventional drag; touch waits for a hold.
     */
    const beginColorDrag = (source: number, event: Pick<PointerEvent, 'button' | 'isPrimary' | 'pointerId' | 'pointerType' | 'clientX' | 'clientY'> & { currentTarget: HTMLButtonElement }): void => {
      if (!state.writable || event.button !== 0 || event.isPrimary === false || swapFrom !== undefined) return
      const button = event.currentTarget; const group = button.parentElement
      const document = button.ownerDocument; const view = document.defaultView
      if (!group || !view) return
      dragCleanup.current?.(); suppressDragClick.current = false
      const request = ++imageRequest.current; setExtracting(false); setSwapNotice('')
      let active = false
      const targetAt = (point: { clientX: number; clientY: number }): number | undefined => {
        const target = document.elementFromPoint(point.clientX, point.clientY)?.closest<HTMLElement>('[data-palette-slot]')
        if (!target || !group.contains(target)) return undefined
        const index = Number(target.dataset.paletteSlot)
        return Number.isInteger(index) && index >= 0 && index < 3 ? index : undefined
      }
      const activate = (): void => {
        if (request !== imageRequest.current) { cleanup(); return }
        active = true; suppressDragClick.current = true; setDragging({ source, target: source })
        try { button.setPointerCapture(event.pointerId) } catch { /* window listeners still own release */ }
      }
      const timer = view.setTimeout(activate, 350)
      const move = (point: PointerEvent): void => {
        if (point.pointerId !== event.pointerId) return
        if (request !== imageRequest.current) { cleanup(); return }
        if (!active && Math.hypot(point.clientX - event.clientX, point.clientY - event.clientY) > 8) {
          if (event.pointerType !== 'mouse') { cleanup(); return } // early touch movement remains page scrolling
          view.clearTimeout(timer); activate()
        }
        if (!active) return
        point.preventDefault()
        const target = targetAt(point)
        setDragging(previous => previous?.source === source && previous.target === target ? previous : { source, target })
      }
      const finish = (point: PointerEvent): void => {
        if (point.pointerId !== event.pointerId) return
        const target = active && request === imageRequest.current ? targetAt(point) : undefined
        cleanup()
        if (target !== undefined) swapColors(source, target)
      }
      const cancel = (): void => { cleanup() }
      const key = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); keyEvent.stopPropagation(); cleanup() }
      }
      const cleanup = (): void => {
        view.clearTimeout(timer)
        view.removeEventListener('pointermove', move); view.removeEventListener('pointerup', finish)
        view.removeEventListener('pointercancel', cancel); view.removeEventListener('blur', cancel)
        view.removeEventListener('keydown', key, true); button.removeEventListener('lostpointercapture', cancel)
        if (dragCleanup.current === cleanup) dragCleanup.current = undefined
        try { if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId) } catch { /* already detached */ }
        setDragging(undefined)
      }
      dragCleanup.current = cleanup
      view.addEventListener('pointermove', move, { passive: false }); view.addEventListener('pointerup', finish)
      view.addEventListener('pointercancel', cancel); view.addEventListener('blur', cancel)
      view.addEventListener('keydown', key, true); button.addEventListener('lostpointercapture', cancel)
    }
    const applyDraft = (): void => {
      if (!draft || !validCustom || !state.writable) return
      imageRequest.current++; setExtracting(false); void appearance.save(draft)
    }
    const importImage = async (event: { currentTarget: HTMLInputElement }): Promise<void> => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''
      if (!file || !state.writable) return
      const request = ++imageRequest.current
      setExtracting(true); setImageError(undefined)
      try {
        const result = await readImagePalette(file)
        if (request !== imageRequest.current) return
        const next = paletteFromImage(result.colors, draft ?? state.value, mode)
        setDraft(next); setCustomDraft(customPaletteColors(next, mode)[selectedColor]!)
        setImageResult({ ...result, name: file.name })
      } catch (error) {
        if (request === imageRequest.current) setImageError(error instanceof Error ? error.message : '图片提色失败，请重试。')
      } finally { if (request === imageRequest.current) setExtracting(false) }
    }
    return e('section', { className: 'xsla-settings-page xsla-appearance', 'data-native-settings': 'appearance',
      onKeyDownCapture: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
        if (event.key === 'Escape' && swapFrom !== undefined) { event.preventDefault(); event.stopPropagation(); setSwapFrom(undefined); setSwapNotice('已取消互换。') }
      } },
      e('div', { className: 'xsla-settings-heading' }, e('h2', null, '外观'), e('p', null, '选择舒服的明暗与配色。设置保存在本机，所有会话共用。')),
      e('div', { className: 'xsla-appearance-grid' },
        e('div', { className: 'xsla-appearance-controls' },
          e('fieldset', null, e('legend', null, '显示模式'),
            e('div', { className: 'xsla-mode-options', role: 'group', 'aria-label': '显示模式' },
              ...(['light', 'dark', 'system'] as const).map((id, index) => e('button', {
                type: 'button', key: id, 'aria-pressed': themeState.preference === id,
                onClick: () => ctx.theme.setTheme(id),
              }, e('span', { className: 'xsla-mode-window', 'data-mode': id, 'aria-hidden': 'true' }, e('i', null), e('span', null)),
              e('span', null, ['亮色', '暗色', '跟随系统'][index]))))),
          ctx.theme.setFontSize === undefined ? null : e('fieldset', { className: 'xsla-font-setting' }, e('legend', null, '正文字号'),
            e('div', { role: 'group', 'aria-label': '正文字号' },
              e('button', { type: 'button', 'aria-label': '缩小正文', disabled: (themeState.fontSize ?? 14) <= 12, onClick: () => ctx.theme.setFontSize?.(Math.max(12, (themeState.fontSize ?? 14) - 1)) }, '−'),
              e('output', { 'aria-live': 'polite' }, `${themeState.fontSize ?? 14} px`),
              e('button', { type: 'button', 'aria-label': '放大正文', disabled: (themeState.fontSize ?? 14) >= 17, onClick: () => ctx.theme.setFontSize?.(Math.min(17, (themeState.fontSize ?? 14) + 1)) }, '＋'),
              e('button', { type: 'button', onClick: () => ctx.theme.setFontSize?.(14) }, '恢复默认')),
            e('p', null, '12–17 px，调整聊天正文，不改变窗口缩放。')),
          e('fieldset', null, e('legend', null, '配色方案'),
            e('div', { className: 'xsla-palette-options', role: 'group', 'aria-label': '配色方案' },
              ...APPEARANCE_PRESETS.map(preset => e('button', {
                type: 'button', key: preset.id, 'aria-pressed': state.value.preset === preset.id,
                disabled: !state.writable, onClick: () => choose(preset.id),
              }, e('span', { className: 'xsla-palette-swatches', 'aria-hidden': 'true' },
                ...[preset.accent, ...preset[mode].slice(0, 2)].map((color, index) => e('i', { key: index, style: { background: color } }))),
              e('span', null, e('b', null, preset.label), e('small', null, preset.detail)),
              state.value.preset === preset.id ? e('span', { className: 'xsla-choice-check', 'aria-hidden': 'true' }, '✓') : null)),
              e('button', { type: 'button', className: 'xsla-custom-palette-option', 'aria-pressed': state.value.preset === 'custom', disabled: !state.writable, onClick: () => choose('custom') },
                e('span', { className: 'xsla-palette-swatches', 'aria-hidden': 'true' }, ...customPaletteColors(state.value, mode).map((color, index) => e('i', { key: index, style: { background: color } }))),
                e('span', null, e('b', null, '自定义'), e('small', null, '三种颜色，由你搭配')),
                state.value.preset === 'custom' ? e('span', { className: 'xsla-choice-check', 'aria-hidden': 'true' }, '✓') : null))),
          e('fieldset', { className: 'xsla-custom-accent' }, e('legend', null, '自定义颜色'),
            e('p', null, `点选用途后调整。${mode === 'dark' ? '暗色' : '亮色'}底色单独保存；强调色填充保留原色，文字与边框自动适配，不改变标识。`),
            e('div', { className: 'xsla-color-slots', role: 'group', 'aria-label': '自定义三色', 'data-color-dragging': dragging !== undefined },
              ...labels.map((label, index) => e('button', { key: label, type: 'button', 'aria-label': `编辑${label}`, 'aria-pressed': selectedColor === index,
                'data-palette-slot': index, 'data-color-drag-source': dragging?.source === index,
                'data-color-drop-target': dragging?.target === index && dragging.source !== index,
                'aria-describedby': 'xsla-color-swap-hint', draggable: false, disabled: !state.writable,
                onPointerDown: (event: Parameters<typeof beginColorDrag>[1]) => beginColorDrag(index, event),
                onClick: (event?: { detail?: number }) => {
                  if (suppressDragClick.current && event?.detail !== 0) { suppressDragClick.current = false; return }
                  selectColor(index)
                } },
              e('i', { style: { background: colors[index] }, 'aria-hidden': 'true' }), e('span', null, label), e('small', null, colors[index])))),
            e('div', { className: 'xsla-color-swap-controls' },
              e('span', { id: 'xsla-color-swap-hint', role: 'status', 'aria-live': 'polite' },
                dragging ? dragging.target !== undefined && dragging.target !== dragging.source ? `松开，与${labels[dragging.target]}互换。` : '拖到另一个色块松开互换，Esc 取消。'
                  : swapFrom !== undefined ? `点击另一个用途，与${labels[swapFrom]}互换。` : swapNotice || '长按色块拖拽互换；三个用途的位置保持不变。'),
              e('button', { type: 'button', className: 'xsla-settings-action', disabled: !state.writable,
                'aria-label': swapFrom === undefined ? '交换颜色' : '取消颜色互换',
                onClick: () => { dragCleanup.current?.(); setSwapFrom(swapFrom === undefined ? selectedColor : undefined); setSwapNotice('') },
              }, swapFrom === undefined ? '交换颜色' : '取消互换')),
            e('label', { className: 'xsla-color-editor-label', htmlFor: 'xsla-custom-color-hex' }, `正在调整：${selectedLabel}`),
            e('div', { className: 'xsla-color-inputs' },
              e('input', { type: 'color', 'aria-label': `选择${selectedLabel}`, value: validCustom ? customDraft : colors[selectedColor], disabled: !state.writable,
                onChange: (event: { currentTarget: HTMLInputElement }) => editColor(event.currentTarget.value) }),
              e('input', { id: 'xsla-custom-color-hex', type: 'text', 'aria-label': `${selectedLabel}十六进制值`, value: customDraft, maxLength: 7, spellCheck: false, disabled: !state.writable,
                'aria-invalid': !validCustom, onChange: (event: { currentTarget: HTMLInputElement }) => editColor(event.currentTarget.value),
                onKeyDown: (event: { key: string; preventDefault(): void }) => { if (event.key === 'Enter' && validCustom) { event.preventDefault(); applyDraft() } } }),
              e('button', { type: 'button', className: 'xsla-settings-action', 'aria-label': '应用自定义配色', disabled: !state.writable || !validCustom || !draft || extracting,
                onClick: applyDraft }, !draft && state.value.preset === 'custom' ? '已应用' : '应用配色')),
            validCustom ? null : e('p', { className: 'xsla-appearance-error', role: 'status' }, '请输入六位颜色值，例如 #4D6E54。'),
            e('div', { className: 'xsla-image-palette' },
              e('label', { className: 'xsla-image-picker', 'data-disabled': !state.writable },
                e('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': '从图片提取配色', disabled: !state.writable, onChange: importImage }),
                e('span', null, extracting ? '正在本机提色…可重新选择' : '从图片提取配色')),
              e('small', null, 'PNG、JPG、WebP · 最大 10 MB · 图片不上传'),
              imageError ? e('p', { className: 'xsla-appearance-error', role: 'alert' }, imageError) : null,
              imageResult ? e('div', { className: 'xsla-image-result' },
                e('img', { src: imageResult.thumbnail, alt: '所选图片的提色缩略图' }),
                e('div', null, e('p', { className: 'xsla-image-name', title: imageResult.name }, imageResult.name),
                  e('small', null, `${imageResult.colors.length} 种候选色 · 按原图占比排序`)),
                e('div', { className: 'xsla-image-shares', role: 'group', 'aria-label': '主要颜色占比' }, ...imageResult.colors.map(entry => e('button', {
                  key: entry.color, type: 'button', title: `${entry.color} · 点击用于${selectedLabel}`,
                  'aria-label': `将 ${entry.color} 用于${selectedLabel}`, 'aria-pressed': colors[selectedColor] === entry.color,
                  disabled: !state.writable, onClick: () => editColor(entry.color),
                }, e('i', { 'aria-hidden': 'true', style: { background: entry.color } }), imagePercent(entry.share))),
                  imageOtherShare > .000001 ? e('span', { 'data-image-other-share': '', title: '未列出的细小色群，仍计入图片总面积' }, `其他 ${imagePercent(imageOtherShare)}`) : null),
                e('small', { className: 'xsla-image-assignment-hint' }, `先选上方用途，再点候选色分配。当前：${selectedLabel}。占比为原图可见面积估算，不代表界面面积；相近色已合并。`)) : null),
            draft || extracting || !validCustom ? e('div', { className: 'xsla-color-draft', role: 'status' }, e('span', null, extracting ? '等待提色完成后预览' : '右侧仅预览，应用后才会保存。'),
              e('button', { type: 'button', className: 'xsla-settings-action', 'aria-label': '取消配色调整', onClick: discard }, '取消调整')) : null),
          e('div', { className: 'xsla-appearance-footer' },
            e('span', { role: 'status', 'aria-live': 'polite', 'data-appearance-save': state.status },
              { loading: '正在读取配色…', ready: '配色已保存', saving: '正在保存配色…', error: '配色未保存，请重试', unavailable: '配色存储暂不可用' }[state.status]),
            state.status === 'error' ? e('button', { className: 'xsla-settings-action', type: 'button', disabled: !state.writable, onClick: () => { void appearance.save(state.value) } }, '重试保存') : null,
            e('button', { className: 'xsla-settings-action', type: 'button', disabled: !state.writable, onClick: () => { void appearance.save(DEFAULT_APPEARANCE) } }, '恢复默认配色'))),
        e('aside', { className: 'xsla-appearance-sample', 'aria-label': '当前外观示意', style: { ...appearanceTokens(preview, mode), '--sample-caption-ink': appearanceTokens(state.value, mode)['--ink3'] } },
          e('div', { className: 'xsla-sample-window', 'aria-hidden': 'true' },
            e('div', { className: 'xsla-sample-rail' }, brandMark(e, 'xsla-sample-brand', 'appearance'), e('i', null), e('i', null), e('i', null)),
            e('div', { className: 'xsla-sample-chat' }, e('header', null, '小蛇'),
              e('div', { className: 'xsla-sample-bubble' }, '把想做的事写下来'),
              e('div', { className: 'xsla-sample-answer' }, e('b', null, '清晰，专注'), e('p', null, '正文、进展和工作材料各在其位。')),
              e('div', { className: 'xsla-sample-input' }, e('span', null, '输入你的任务…'), e('b', null, '↑')))),
          e('p', { className: 'xsla-sample-caption' }, draft ? '配色预览 · 尚未应用' : '当前已应用的配色'),
          e('small', null, '颜色用于不同层级，不代表固定的画面面积比例。'))))
  }
  // The shell retains drafts and project guards while settings owns navigation.
  // These are presentation snapshots only; Memory and runtime stores remain the
  // sole owners of durable facts and all writes use the existing handlers.
  let managementPages: Readonly<{ memory: unknown; runtime: unknown }> = { memory: null, runtime: null }
  const managementListeners = new Set<() => void>()
  const ManagementSettingsSection = (props: { readonly page: 'memory' | 'runtime' }): unknown => {
    const pages = react.useSyncExternalStore(listener => { managementListeners.add(listener); return () => { managementListeners.delete(listener) } }, () => managementPages)
    return e('section', { className: 'xsla-settings-page xsla-management-page', 'data-native-settings': props.page }, pages[props.page])
  }
  const MemorySettingsSection = (): unknown => e(ManagementSettingsSection, { page: 'memory' })
  const RuntimeSettingsSection = (): unknown => e(ManagementSettingsSection, { page: 'runtime' })

  /** Xiaoshe owns the visible settings identity; DSH only supplies the slot ledger. */
  const SettingsBrandHeader = (): unknown => e('div', { className: 'xsla-settings-brand' },
    brandMark(e, 'xsla-settings-brand-mark', 'settings'),
    e('span', { className: 'xsla-settings-brand-copy' },
      e('b', null, '小蛇设置'),
      e('small', null, '设置中心 · 本机配置')))

  const SettingsTriggerContent = (props: { readonly wide?: boolean } = {}): unknown => e('span', { className: 'xsla-settings-trigger-content', 'data-xsla-settings-trigger-content': '' },
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
    const productHealth = react.useSyncExternalStore(listener => ctx.productHealth.subscribe(listener), () => ctx.productHealth.getSnapshot())
    const [networkPlugins, setNetworkPlugins] = react.useState<readonly HostPluginFact[] | undefined>(undefined)
    const current = permissions.options.find(option => option.value === permissions.currentValue)
    const desktop = 'value' in productHealth ? productHealth.value?.desktop : undefined
    const network = networkCapabilityPresentation({ desktop, plugins: networkPlugins })
    react.useEffect(() => {
      let active = true
      void ctx.pluginGovernance.listHostPlugins().then(result => {
        if (active && result.ok) setNetworkPlugins(result.value?.entries ?? [])
      }).catch(() => {})
      return () => { active = false }
    }, [])
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
      e('article', { className: 'xsla-settings-card', 'data-capability': 'network' },
        e('div', { className: 'xsla-settings-card-head' },
          e('div', null, e('b', null, '网络能力'), e('small', null, '独立于文件权限')),
          e('span', { className: 'xsla-settings-badge', 'data-status': network.state }, network.label)),
        e('p', null, network.detail)),
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
    const [versionReport, setVersionReport] = react.useState<unknown>(undefined)
    const [checkingVersion, setCheckingVersion] = react.useState(false)
    const [versionError, setVersionError] = react.useState('')
    const versionRequest = react.useRef<AbortController | undefined>(undefined)
    const versionView = runtimeVersionPresentation(versionReport)
    const checkVersion = async (): Promise<void> => {
      versionRequest.current?.abort()
      const controller = new AbortController(); versionRequest.current = controller
      const timer = setTimeout(() => controller.abort(), 35_000)
      setCheckingVersion(true); setVersionError(''); setVersionReport(undefined)
      try {
        const query = /^[a-f0-9]{64}$/u.test(CLIENT_SOURCE_IDENTITY) ? `?frontend_identity=${CLIENT_SOURCE_IDENTITY}` : ''
        const response = await fetch(`/xiaoshe/desktop/version${query}`, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error' })
        if (response.status === 404) throw new Error('当前后台尚不提供版本诊断；请先保存草稿，再按受控启动流程更新后台。')
        if (!response.ok) throw new Error('本次版本诊断未完成，不能确认新版；可稍后重新检查。')
        const report: unknown = await response.json()
        if (versionRequest.current === controller) setVersionReport(report)
      } catch (failure) {
        if (versionRequest.current === controller) setVersionError(controller.signal.aborted ? '版本检查超时，未刷新或重启任何服务。' : failure instanceof Error ? failure.message : '版本检查不可用。')
      } finally {
        clearTimeout(timer)
        if (versionRequest.current === controller) { versionRequest.current = undefined; setCheckingVersion(false) }
      }
    }
    react.useEffect(() => {
      void checkVersion()
      return () => { const pending = versionRequest.current; versionRequest.current = undefined; pending?.abort() }
    }, [])
    return e('section', { className: 'xsla-settings-page', 'data-native-settings': 'about' },
      e('div', { className: 'xsla-settings-heading' },
        e('h2', null, '高级与关于'),
        e('p', null, '来自桌面桥的实时版本与诊断信息。')),
      e('article', { className: 'xsla-settings-card' },
        e('b', null, '数据分享 · 产品默认值'),
        e('p', null, '公开发行配置默认关闭额外插件清单上报与模型请求日志上传；正常模型对话和本地会话记录不受影响。'),
        e('small', null, '这不是本机开关状态读数。已有个人配置可覆盖默认值，可通过“打开配置文件”核对或调整。')),
      e('article', { className: 'xsla-settings-card xsla-about-card' },
        brandMark(e, 'xsla-about-mark', 'about'),
        e('div', { className: 'xsla-about-copy' },
          e('b', null, String(desktopStatus?.product ?? '小蛇')),
          e('span', null, `版本 ${String(desktopStatus?.version ?? unavailable)} · 小蛇 UI 适配版`))),
      e('article', { className: 'xsla-settings-card', 'data-version-status': versionView.state },
        e('div', { className: 'xsla-settings-card-head' },
          e('b', null, '版本一致性'),
          e('span', { className: 'xsla-settings-badge', 'data-status': versionView.state }, checkingVersion ? '正在核对…' : versionView.label)),
        e('p', { ...(versionView.state === 'stale' ? { role: 'alert' } : {}) }, versionView.detail),
        e('div', { className: 'xsla-settings-facts', role: 'list', 'aria-label': '版本来源与身份' },
          ...versionView.facts.map(([label, value]) => e('div', { className: 'xsla-settings-fact', role: 'listitem', key: label }, e('b', null, label), e('span', null, value)))),
        versionError ? e('p', { className: 'xsla-settings-error', role: 'alert' }, versionError) : null,
        e('button', { className: 'xsla-settings-action', type: 'button', disabled: checkingVersion, onClick: () => { void checkVersion() } }, checkingVersion ? '检查中…' : '重新检查版本'),
        e('p', { className: 'xsla-settings-boundary' }, '只读检查本机文件和启动身份，不连接模型、不自动安装或重启。源码继续变化后需要重新检查。')),
      e('div', { className: 'xsla-settings-facts', role: 'list', 'aria-label': '运行诊断' },
        e('div', { className: 'xsla-settings-fact', role: 'listitem' }, e('b', null, '桌面桥'), e('span', null, bridge === undefined ? unavailable : `${String(bridge.state)} · ${String(bridge.platform ?? '平台未报告')}`)),
        e('div', { className: 'xsla-settings-fact', role: 'listitem' }, e('b', null, '持久操作'), e('span', null, actions === undefined ? unavailable : actions.persistent === true ? '已启用' : '未启用')),
        e('div', { className: 'xsla-settings-fact', role: 'listitem' }, e('b', null, '运行日志'), e('span', null, bridge === undefined ? unavailable : platformLogLocation(bridge.platform)))),
      desktopError === undefined ? null : e('p', { className: 'xsla-settings-error', role: 'alert' }, `桌面诊断提供方不可用：${desktopError}`),
      e('a', { className: 'xsla-settings-action', href: '/xiaoshe/desktop/status', target: '_blank', rel: 'noreferrer' }, '查看诊断 JSON'),
      e('p', { className: 'xsla-settings-boundary' }, '配置文件由设置标题栏的“打开配置文件”入口管理；日志由本机启动器持续写入。'))
  }

  const BrowserDock = createBrowserDock(react)
  const HistoryImage = createHistoryImageComponent(react, input => ctx.taskTimeline.readImage(input))
  const FilePreview = createFilePreviewComponent(react, input => ctx.runtimeFiles === undefined
    ? Promise.resolve({ ok: false, error: { message: '当前运行端不支持文件读取，请更新后重试' } }) : ctx.runtimeFiles.read(input), MarkdownText)
  const Shell = (slotProps: ShellSlotProps = {}): unknown => {
    react.useEffect(mountLoadedFrontendVersion, [])
    const runtime = react.useSyncExternalStore(listener => ctx.agentRuntimeSession.subscribe(listener), () => ctx.agentRuntimeSession.getSnapshot())
    const catalog = react.useSyncExternalStore(listener => ctx.sessionCatalog.subscribe(listener), () => ctx.sessionCatalog.getSnapshot())
    const timeline = react.useSyncExternalStore(listener => ctx.taskTimeline.subscribe(listener), () => ctx.taskTimeline.getSnapshot())
    const workSurfaces = react.useSyncExternalStore(listener => ctx.workSurfaceRegistry.subscribe(listener), () => ctx.workSurfaceRegistry.getSnapshot())
    const context = react.useSyncExternalStore(listener => ctx.contextGovernance.subscribe(listener), () => ctx.contextGovernance.getSnapshot())
    const models = react.useSyncExternalStore(listener => ctx.modelCatalog.subscribe(listener), () => ctx.modelCatalog.getSnapshot())
    const runCenter = react.useSyncExternalStore(listener => ctx.runCenter.subscribe(listener), () => ctx.runCenter.getSnapshot())
    const providerReadinessSnapshot = react.useSyncExternalStore(listener => ctx.providerReadiness.subscribe(listener), () => ctx.providerReadiness.getSnapshot())
    const workspaces = react.useSyncExternalStore(listener => ctx.workspaceCatalog.subscribe(listener), () => ctx.workspaceCatalog.getSnapshot())
    const approvals = react.useSyncExternalStore(listener => ctx.userApproval.subscribe(listener), () => ctx.userApproval.getSnapshot())
    const questionInteractions = react.useSyncExternalStore(listener => ctx.userQuestionInteraction.subscribe(listener), () => ctx.userQuestionInteraction.getSnapshot())
    const permissions = react.useSyncExternalStore(listener => ctx.permissionPresets.subscribe(listener), () => ctx.permissionPresets.getSnapshot())
    const memoryState = react.useSyncExternalStore(listener => ctx.memoryLifecycle.subscribe(listener), () => ctx.memoryLifecycle.getSnapshot())
    const productHealth = react.useSyncExternalStore(listener => ctx.productHealth.subscribe(listener), () => ctx.productHealth.getSnapshot())
    const connectionUnavailableRef = react.useRef(false)
    const connectionView = runtimeConnectionPresentation(productHealth, connectionUnavailableRef.current)
    connectionUnavailableRef.current = connectionView.unavailable
    const pluginState = react.useSyncExternalStore(listener => ctx.pluginGovernance.subscribe(listener), () => ctx.pluginGovernance.getSnapshot())
    const themeSnapshot = react.useSyncExternalStore(listener => ctx.on('theme/change', listener), () => ctx.theme.getTheme())
    const appearanceSnapshot = react.useSyncExternalStore(appearance.subscribe, appearance.getSnapshot)
    const enterBehavior = react.useSyncExternalStore(composerEnterPreference.subscribe, composerEnterPreference.getSnapshot)
    const currentId = runtime.currentSessionId
    const sessionModels = modelCatalogForSession(models, currentId)
    const providerReadiness = providerReadinessForSession(providerReadinessSnapshot, currentId)
    const sessionRunCenter = runCenterForSession(runCenter, currentId)
    const sessionApprovals = sessionScopedRows(approvals.approvals, approvals.sessionId, currentId)
    const sessionQuestionRequests = sessionScopedRows(questionInteractions.requests, questionInteractions.sessionId, currentId)
    const initialComposerDraft = readComposerDraft(browserSessionDraftStorage(), currentId)
    const initialDraftImages = hydrateDraftImages(initialComposerDraft.images)

    const [sideCollapsed, setSideCollapsed] = react.useState(false)
    const [inspCollapsed, setInspCollapsed] = react.useState(timeline.items.length === 0 || (typeof window !== 'undefined' && window.innerWidth <= WORKBENCH_OVERLAY_BREAKPOINT))
    const [workbenchView, setWorkbenchView] = react.useState<WorkbenchView>('task')
    const [layoutViewportWidth, setLayoutViewportWidth] = react.useState(typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth)
    const [panelWidths, setPanelWidths] = react.useState<PanelWidths>(readPanelWidthPreference())
    const [resizingPanel, setResizingPanel] = react.useState<ResizablePanel | undefined>(undefined)
    const panelWidthsTouchedRef = react.useRef(false)
    const panelResizeCleanupRef = react.useRef<(() => void) | undefined>(undefined)
    const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = react.useState<readonly string[]>(readWorkspaceGroupCollapsePreference())
    const theme = themeSnapshot.active.colorScheme === 'dark' ? 'ink-jade' : 'light'
    const [overlayState, setOverlayState] = react.useState<OverlayState>({ side: false, inspector: false })
    const sideOverlayOpen = overlayState.side
    // A native page is not a modal: otherwise the browser's modal safety guard
    // would correctly hide its own slot. Task/material drawers retain trapping.
    const inspOverlayOpen = !inspCollapsed && layoutViewportWidth <= WORKBENCH_OVERLAY_BREAKPOINT && workbenchView !== 'browser'
    const [pluginManagerOpen, setPluginManagerOpen] = react.useState(false)
    const [commandOpen, setCommandOpen] = react.useState(false)
    const [choiceMenu, setChoiceMenu] = react.useState<'permission' | 'model' | undefined>(undefined)
    const [modelSelectionNotice, setModelSelectionNotice] = react.useState<ModelSelectionNotice | undefined>(undefined)
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
    // Second action-menu step: the session whose target project is being picked.
    const [sideMove, setSideMove] = react.useState<SideEntityTarget | undefined>(undefined)
    const [sideEdit, setSideEdit] = react.useState<SideEditTarget | undefined>(undefined)
    const [sideRemoval, setSideRemoval] = react.useState<SideRemovalTarget | undefined>(undefined)
    const [sideMutation, setSideMutation] = react.useState<string | undefined>(undefined)
    const [pluginWorkflow, setPluginWorkflow] = react.useState<PluginWorkflow>({ step: 'idle' })
    const [error, setError] = react.useState('')
    const [questionFlow, setQuestionFlow] = react.useState<QuestionFlowState>(createQuestionFlowState(sessionQuestionRequests[0]))
    const [submitting, setSubmitting] = react.useState(false)
    const [sendMode, setSendMode] = react.useState<'queue' | 'steer'>('queue')
    const [sendNotice, setSendNotice] = react.useState<{ owner: string | undefined; phase: ComposerSendPhase; mode: 'queue' | 'steer' } | undefined>(undefined)
    const [queueEdit, setQueueEdit] = react.useState<{ id: string; text: string } | undefined>(undefined)
    const [queueBusy, setQueueBusy] = react.useState<string | undefined>(undefined)
    const [goalBusy, setGoalBusy] = react.useState(false)
    const sessionOwnerRef = react.useRef(currentId)
    sessionOwnerRef.current = currentId
    // Identity, not just the ID: A -> B -> A must invalidate A's old UI work.
    const sessionVisitRef = react.useRef({ id: currentId })
    if (sessionVisitRef.current.id !== currentId) sessionVisitRef.current = { id: currentId }
    const [stopping, setStopping] = react.useState(false)
    const [draftImages, setDraftImages] = react.useState<readonly DraftImage[]>(initialDraftImages)
    const [composerHasText, setComposerHasText] = react.useState(initialComposerDraft.text.trim() !== '')
    const [draftFiles, setDraftFiles] = react.useState<readonly DraftFile[]>([])
    const draftFilesRef = react.useRef<readonly DraftFile[]>([])
    const draftImagesRef = react.useRef<readonly DraftImage[]>(initialDraftImages)
    const draftStorageWarningRef = react.useRef(false)
    const composerTextareaRef = react.useRef<HTMLTextAreaElement | null>(null)
    const streamRef = react.useRef<HTMLDivElement | null>(null)
    const historyPrependRef = react.useRef<HistoryPrependState | undefined>(undefined)
    const previousScrollTopRef = react.useRef(0)
    const [historyLoading, setHistoryLoading] = react.useState(false)
    const [historyError, setHistoryError] = react.useState(false)
    /** Bottom-follow ownership: true while the reader sits at the stream floor. */
    const pinnedRef = react.useRef(true)
    const submittingRef = react.useRef(false)
    const stoppingRef = react.useRef(false)
    const [showJumpToLatest, setShowJumpToLatest] = react.useState(false)
    const [activeUserTurnOrdinal, setActiveUserTurnOrdinal] = react.useState<number | undefined>(undefined)
    const [turnIndexPage, setTurnIndexPage] = react.useState<number | undefined>(undefined)
    const [turnIndexHeight, setTurnIndexHeight] = react.useState(216)
    const [unreadLatestCount, setUnreadLatestCount] = react.useState(0)
    const timelineCountRef = react.useRef(timeline.items.length)
    const [userTurnPreview, setUserTurnPreview] = react.useState<UserTurnPreviewState | undefined>(undefined)
    const [plugins, setPlugins] = react.useState<readonly HostPluginFact[]>([])
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
    const [materialCategory, setMaterialCategory] = react.useState<'files' | 'activity'>('files')
    const [materialFullscreen, setMaterialFullscreen] = react.useState(false)
    const [materialSplit, setMaterialSplit] = react.useState(false)
    const [secondarySurfaceId, setSecondarySurfaceId] = react.useState<string | undefined>(undefined)
    const surfaceChatRef = react.useRef<HTMLElement | null>(null)
    const [surfaceChatWidth, setSurfaceChatWidth] = react.useState(Number.POSITIVE_INFINITY)
    const browserOpen = !inspCollapsed && workbenchView === 'browser'
    const [browserWidth, setBrowserWidth] = react.useState<number | undefined>(readBrowserWidth())
    const [resizingSurface, setResizingSurface] = react.useState(false)
    const surfaceResizeCleanupRef = react.useRef<(() => void) | undefined>(undefined)

    const current = currentId === undefined ? undefined : runtime.sessions[currentId]
    const projectedQuestionRequest = sessionQuestionRequests[0]
    const imageLimits = current?.imageInputLimits ?? DEFAULT_DRAFT_IMAGE_LIMITS
    const currentCatalog = currentId === undefined ? undefined : catalog.sessions[currentId]
    const memoryProjectContextRef = react.useRef<MemoryProjectContext>({
      ...(currentCatalog?.cwd === undefined ? {} : { cwd: currentCatalog.cwd }),
      ...(memoryState.memory?.project === undefined ? {} : { canonical: memoryState.memory.project }),
    })
    const currentWorkspace = workspaces.items.find(item => item.sessionIds.includes(currentId ?? '') || item.path === currentCatalog?.cwd)
    const userTurnNavigation = buildUserTurnNavigation(timeline.items, ctx.taskTimeline.getOutline?.())
    const turnIndex = userTurnNavigationPage(userTurnNavigation, activeUserTurnOrdinal, turnIndexPage, turnIndexHeight)
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
    // Choose the current file BEFORE applying visibility; hiding a current
    // revision must not resurrect an older execution record as the same tab.
    const allFileTabs = materialFileTabs(currentSurfaceItems)
    const fileTabs = allFileTabs.filter(item => !surfacePreference.dismissedIds.includes(item.id))
    const showingFiles = materialCategory === 'files' && allFileTabs.length > 0
    const materialItems = showingFiles ? fileTabs : surfaceItems
    const activeSurface = materialItems.find(item => item.id === surfacePreference.activeId) ?? materialItems.at(-1)
    const secondarySurface = materialItems.find(item => item.id === secondarySurfaceId && item.id !== activeSurface?.id)
      ?? materialItems.find(item => item.id !== activeSurface?.id)
    const surfaceDockOpen = !inspCollapsed && workbenchView === 'materials'
    const fittedSurfaceWidth = workSurfaceDockWidth(surfacePreference.width, surfaceChatWidth)
    const fittedWorkbenchWidth = workbenchPanelWidth(workbenchView, { task: panelWidths.inspector, materials: surfacePreference.width, browser: browserWidth }, surfaceChatWidth)

    react.useEffect(() => {
      try {
        if (browserWidth === undefined) globalThis.localStorage?.removeItem(BROWSER_WIDTH_STORAGE_KEY)
        else globalThis.localStorage?.setItem(BROWSER_WIDTH_STORAGE_KEY, String(browserWidth))
      } catch { /* Storage-denied WebViews retain the split for this window. */ }
    }, [browserWidth])

    react.useEffect(() => {
      const chat = surfaceChatRef.current
      if (chat === null || typeof window === 'undefined') return
      // Measure the joint conversation/workbench budget, not the already
      // narrowed chat column (which would feed back into the next width fit).
      const main = chat.parentElement
      const side = main?.querySelector<HTMLElement>('#xsla-side')
      const measure = (): void => setSurfaceChatWidth((main?.getBoundingClientRect().width ?? chat.getBoundingClientRect().width) - (side?.getBoundingClientRect().width ?? 0))
      measure()
      const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
      if (main) observer?.observe(main)
      if (side) observer?.observe(side)
      if (observer === undefined) window.addEventListener('resize', measure)
      return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
    }, [])

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
        setLayoutViewportWidth(window.innerWidth)
        setOverlayState(current => overlayStateAfterViewportResize(current, window.innerWidth))
        // Fit the displayed workbench separately. Merely resizing the window
        // must not overwrite a saved per-view reading width.
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
      const nextContext = {
        ...(currentCatalog?.cwd === undefined ? {} : { cwd: currentCatalog.cwd }),
        ...(memoryState.memory?.project === undefined ? {} : { canonical: memoryState.memory.project }),
      }
      if (memoryProjectContextChanged(memoryProjectContextRef.current, nextContext)) {
        // An edit is bound to the project where it began. Clear it before the
        // retained Memory snapshot can be mistaken for the newly selected cwd.
        setMemoryEditing(undefined)
        setMemoryDraft('')
        setMemoryError('')
        setMemoryEditorExpanded(false)
      }
      memoryProjectContextRef.current = nextContext
    }, [currentCatalog?.cwd, memoryState.memory?.project])

    react.useEffect(() => {
      void ctx.memoryLifecycle.refresh({
        scope: currentCatalog?.cwd === undefined ? 'global' : 'all',
        ...(currentCatalog?.cwd === undefined ? {} : { project: currentCatalog.cwd }),
        include_inactive: true,
      }).catch(() => {})
    }, [currentCatalog?.cwd])

    react.useEffect(() => {
      setModelSelectionNotice(undefined)
      setSendMode('queue')
      setQueueEdit(undefined)
      setMaterialFullscreen(false)
      setMaterialSplit(false)
      setSecondarySurfaceId(undefined)
      if (currentId !== undefined) {
        void ctx.modelCatalog.refresh(currentId).catch(() => {})
        void ctx.runCenter.refresh().catch(() => {})
        void ctx.providerReadiness.refresh(currentId).catch(() => {})
      }
    }, [currentId])

    const cancelHistoryPrepend = (): void => {
      clearTimeout(historyPrependRef.current?.timeout)
      historyPrependRef.current = undefined
      setHistoryLoading(false)
    }

    const loadEarlierHistory = (): void => {
      const stream = streamRef.current
      if (stream === null || historyPrependRef.current !== undefined || !timeline.hasEarlier || timeline.loading) return
      const pending: HistoryPrependState = {
        owner: currentId, firstKey: timeline.items[0]?.key, ...historyViewportAnchor(stream),
      }
      historyPrependRef.current = pending
      pinnedRef.current = false
      setHistoryError(false)
      setHistoryLoading(true)
      const fail = (): void => {
        if (historyPrependRef.current !== pending || sessionOwnerRef.current !== pending.owner) return
        cancelHistoryPrepend()
        setHistoryError(true)
      }
      // Wait for the committed snapshot even though today's provider expands
      // synchronously. A stalled provider offers retry rather than spinning.
      pending.timeout = setTimeout(fail, 10_000)
      try { ctx.taskTimeline.loadEarlier() } catch { fail() }
    }

    // Anchor before paint, then recheck Chromium's content-visibility layout.
    // Session ownership and one pending request prevent late/duplicate loads.
    ;(react.useLayoutEffect ?? react.useEffect)(() => {
      const pending = historyPrependRef.current
      const stream = streamRef.current
      if (pending === undefined || stream === null || pending.owner !== currentId || pending.firstKey === timeline.items[0]?.key) return
      clearTimeout(pending.timeout)
      let active = true
      const restore = (afterLayout = false): void => {
        if (!active || historyPrependRef.current !== pending || sessionOwnerRef.current !== pending.owner) return
        const anchor = Array.from(stream.querySelectorAll<HTMLElement>('.events > [data-event-key]'))
          .find(node => node.getAttribute('data-event-key') === pending.anchorKey)
        if (afterLayout && anchor === undefined) return
        stream.scrollTo({ top: historyPrependScrollTop({
          scrollTop: stream.scrollTop, previousHeight: pending.height, scrollHeight: stream.scrollHeight,
          ...(anchor === undefined || pending.anchorTop === undefined ? {} : { anchorTop: anchor.getBoundingClientRect().top - stream.getBoundingClientRect().top, previousAnchorTop: pending.anchorTop }),
        }), behavior: 'instant' })
        previousScrollTopRef.current = stream.scrollTop
      }
      restore()
      const frame = window.requestAnimationFrame(() => {
        // Reapplying a height fallback would double its delta. Only a surviving
        // message can be corrected again after the first layout.
        if (pending.anchorKey !== undefined) restore(true)
        if (active && historyPrependRef.current === pending) cancelHistoryPrepend()
      })
      return () => { active = false; window.cancelAnimationFrame(frame) }
    }, [currentId, timeline.items[0]?.key])

    react.useEffect(() => {
      cancelHistoryPrepend()
      setHistoryError(false)
      previousScrollTopRef.current = 0
      return () => { clearTimeout(historyPrependRef.current?.timeout); historyPrependRef.current = undefined }
    }, [currentId])

    // A late successful page or an outline jump supersedes an earlier timeout.
    // Do not leave an error with a retry button that can no longer load anything.
    react.useEffect(() => { setHistoryError(false) }, [currentId, timeline.items[0]?.key, timeline.hasEarlier])

    // A session switch resets bottom-follow ownership: the new transcript
    // opens at its floor instead of inheriting the previous reader position.
    react.useEffect(() => { pinnedRef.current = true }, [currentId])

    react.useEffect(() => {
      const stream = streamRef.current
      if (stream === null) return

      const refresh = (): void => {
        setTurnIndexHeight(stream.clientHeight)
        setShowJumpToLatest(shouldOfferJumpToLatest(stream))
        const offsets = userTurnNavigation.map(item => stream.querySelector<HTMLElement>(`[data-event-index="${item.eventIndex}"]`)?.offsetTop ?? Number.NaN)
        setActiveUserTurnOrdinal(activeUserTurnOrdinalAtScroll(offsets, stream.scrollTop, stream.clientHeight))
        // New flow content (a fresh item or streamed text growth) follows the
        // floor while the reader is pinned. 'instant' bypasses the .stream
        // smooth rule ('auto' inherits it), so continuous streaming never
        // stacks easing animations; the scroll event it emits re-reads the
        // real distance and re-arms the pinned ledger.
        if (pinnedRef.current) {
          stream.scrollTo({ top: stream.scrollHeight, behavior: 'instant' })
        }
      }
      refresh()

      /* A scroll event alone is insufficient: streamed text can make the
       * conversation taller while the pointer remains still. Observe the
       * scroll content so the shortcut follows the real viewport distance. */
      if (typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(refresh)
      observer.observe(stream)
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

    react.useEffect(() => {
      setTurnIndexPage(undefined)
      setUserTurnPreview(undefined)
    }, [currentId, activeUserTurnOrdinal])

    react.useEffect(() => {
      const previous = timelineCountRef.current
      const next = timeline.items.length
      if (showJumpToLatest && next > previous) setUnreadLatestCount(value => value + next - previous)
      if (!showJumpToLatest) setUnreadLatestCount(0)
      timelineCountRef.current = next
    }, [timeline.items.length, showJumpToLatest])

    const persistDraft = (text: string, images: readonly DraftImage[], sessionId = currentId): void => {
      if (sessionId === sessionOwnerRef.current) setComposerHasText(text.trim() !== '')
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
        setComposerHasText(stored.text.trim() !== '')
        resizeComposerTextarea(textarea)
        setSlashQuery(parseSlashCommandQuery(stored.text))
        setSlashSelection(0)
      }
    }, [currentId])

    const removeDraftImage = (id: string): void => {
      replaceDraftImages(draftImagesRef.current.filter(image => image.id !== id))
    }

    const addDraftImages = async (source: FileList | readonly File[], owner = currentId): Promise<void> => {
      const visit = sessionVisitRef.current
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
        if (sessionOwnerRef.current !== owner || sessionVisitRef.current !== visit) return
        setError('')
        const next = [...draftImagesRef.current, ...added.filter((image): image is DraftImage => image !== undefined)]
        replaceDraftImages(next, false)
        persistDraft(composerTextareaRef.current?.value ?? '', next, owner)
      } catch (errorValue: unknown) {
        if (sessionVisitRef.current === visit) setError(`无法读取图片草稿：${errorValue instanceof Error ? errorValue.message : String(errorValue)}`)
      }
    }

    const replaceDraftFiles = (next: readonly DraftFile[]): void => { draftFilesRef.current = next; setDraftFiles(next) }
    react.useEffect(() => {
      const retained = draftFilesRef.current.filter(file => file.owner === currentId)
      for (const file of draftFilesRef.current) if (file.owner !== currentId) file.controller.abort()
      replaceDraftFiles(retained)
    }, [currentId])
    react.useEffect(() => () => { for (const file of draftFilesRef.current) file.controller.abort() }, [])

    const uploadDraftFile = async (entry: DraftFile): Promise<void> => {
      const service = ctx.runtimeFiles
      if (service === undefined) return
      const update = (patch: Partial<DraftFile>): void => {
        if (sessionOwnerRef.current !== entry.owner || entry.controller.signal.aborted) return
        replaceDraftFiles(draftFilesRef.current.map(file => file.id === entry.id && file.controller === entry.controller ? { ...file, ...patch } : file))
      }
      try {
        const result = await service.upload({ sessionId: entry.owner, file: entry.file, name: entry.file.name, signal: entry.controller.signal,
          onProgress: progress => update({ progress: Math.min(100, Math.max(0, (progress.loaded / Math.max(1, progress.total ?? entry.file.size)) * 100)) }) })
        if (!result.ok || result.value === undefined) { update({ phase: 'failed', error: result.error?.message ?? '上传未确认，请重试' }); return }
        update({ phase: 'ready', progress: 100, receipt: result.value })
      } catch (cause: unknown) { update({ phase: 'failed', error: cause instanceof Error ? cause.message : String(cause) }) }
    }
    const cancelDraftFile = (id: string, remove = false): void => {
      const entry = draftFilesRef.current.find(file => file.id === id)
      entry?.controller.abort()
      replaceDraftFiles(remove ? draftFilesRef.current.filter(file => file.id !== id)
        : draftFilesRef.current.map(file => file.id === id ? { ...file, phase: 'cancelled' } : file))
    }
    const retryDraftFile = (id: string): void => {
      const prior = draftFilesRef.current.find(file => file.id === id)
      if (prior === undefined || prior.owner !== currentId) return
      prior.controller.abort()
      const { receipt: _receipt, error: _error, ...rest } = prior
      const next: DraftFile = { ...rest, phase: 'uploading', progress: 0, controller: new AbortController() }
      replaceDraftFiles(draftFilesRef.current.map(file => file.id === id ? next : file))
      void uploadDraftFile(next)
    }
    const addDraftFiles = async (source: FileList | readonly File[]): Promise<void> => {
      const images = Array.from(source).filter(file => imageMediaTypeOf(file) !== undefined)
      const files = Array.from(source).filter(file => imageMediaTypeOf(file) === undefined)
      if (files.length === 0) { if (images.length) await addDraftImages(images); return }
      if (ctx.runtimeFiles === undefined) { setError('当前运行端未提供文件上传，请更新运行端后重试'); return }
      const rejection = validateFileBatch([...draftFilesRef.current.map(entry => entry.file), ...files])
      if (rejection !== undefined) { setError(rejection); return }
      const priorText = composerTextareaRef.current?.value ?? ''
      const owner = currentId ?? await createSession()
      if (owner === undefined || ctx.agentRuntimeSession.getSnapshot().currentSessionId !== owner) return
      if (currentId === undefined) { persistDraft(priorText, draftImagesRef.current, owner); if (composerTextareaRef.current) composerTextareaRef.current.value = priorText }
      const entries: DraftFile[] = files.map(file => ({ id: `file-${Date.now()}-${++draftImageSequence}`, owner, file, controller: new AbortController(), phase: 'uploading', progress: 0 }))
      replaceDraftFiles([...draftFilesRef.current, ...entries])
      // Mixed batches should show their images immediately, even if an ordinary upload waits.
      await Promise.all([...entries.map(uploadDraftFile), ...(images.length ? [addDraftImages(images, owner)] : [])])
    }

    const encodeDraftImages = (images: readonly DraftImage[]): readonly RuntimeImageInput[] => images.map(image => ({
      mediaType: image.mediaType,
      data: image.data,
      ...(image.name === '' ? {} : { name: image.name }),
    }))

    const createSession = async (): Promise<string | undefined> => {
      const visit = sessionVisitRef.current
      setError('')
      setSideMenu(undefined)
      const result = await ctx.sessionCatalog.createLooseSession()
      if (sessionVisitRef.current !== visit) return undefined
      if (!result.ok || result.value === undefined) { setError(result.error?.message ?? '无法新建会话'); return undefined }
      const opened = ctx.sessionCatalog.openSession(result.value.sessionId)
      if (!opened.ok) { setError(opened.error?.message ?? '新会话无法打开'); return undefined }
      // Ports may notify before React commits the next render; adopt the new
      // owner now so immediate upload/send receipts cannot be dropped.
      sessionOwnerRef.current = result.value.sessionId
      if (sessionVisitRef.current.id !== result.value.sessionId) sessionVisitRef.current = { id: result.value.sessionId }
      return result.value.sessionId
    }

    const submit = async (event: { preventDefault(): void; currentTarget: HTMLFormElement }): Promise<void> => {
      event.preventDefault()
      if (connectionUnavailableRef.current || submittingRef.current || current?.state === 'blocked' || sessionQuestionRequests[0] !== undefined || sessionApprovals[0] !== undefined) return
      setError('')
      const form = event.currentTarget
      const draftText = String(new FormData(form).get('content') ?? '')
      const content = draftText.trim()
      const images = draftImagesRef.current
      const files = draftFilesRef.current.filter(file => file.owner === currentId)
      if (files.some(file => file.phase !== 'ready' || file.receipt === undefined)) { setError('请等待文件上传完成，或重试／移除未完成的文件'); return }
      if (content === '' && images.length === 0 && files.length === 0) return
      const commandQuery = parseSlashCommandQuery(content)
      if (commandQuery !== undefined) {
        setSlashQuery(commandQuery)
        setSlashSelection(0)
        return
      }
      submittingRef.current = true
      setSubmitting(true)
      const mode = current?.state === 'running' ? sendMode : 'queue'
      let visit = sessionVisitRef.current
      setSendNotice({ owner: currentId, phase: 'sending', mode })
      try {
        const encodedImages = encodeDraftImages(images)
        const sessionId = currentId ?? await createSession()
        if (sessionId === undefined) return
        if (currentId === undefined) visit = sessionVisitRef.current
        if (currentId === undefined) setSendNotice({ owner: sessionId, phase: 'sending', mode })
        if (currentId === undefined) persistDraft(draftText, images, sessionId)
        let result: Result<{ accepted: true }>
        try {
          result = await ctx.agentRuntimeSession.sendTurn({
            sessionId, content,
            ...(encodedImages.length === 0 ? {} : { images: encodedImages }),
            ...(files.length === 0 ? {} : { files: files.map(file => file.receipt!) }),
            // FIFO is the default even while running; steering is a deliberate choice.
            mode,
          })
        } catch (errorValue: unknown) {
          // A transport failure may happen after the Host accepted the turn;
          // keep the draft and describe that ambiguity instead of blaming the
          // earlier, already-completed image encoding step.
          if (sessionOwnerRef.current === sessionId && sessionVisitRef.current === visit) {
            setSendNotice({ owner: sessionId, phase: 'unknown', mode })
            setError(`发送结果不明确，草稿已保留：${errorValue instanceof Error ? errorValue.message : String(errorValue)}`)
          }
          return
        }
        if (sessionOwnerRef.current !== sessionId || sessionVisitRef.current !== visit) return
        if (!result.ok) {
          setSendNotice({ owner: sessionId, phase: sendFailurePhase(result.error), mode })
          setError(result.error?.message ?? '任务未发送'); return
        }
        setSendNotice({ owner: sessionId, phase: 'accepted', mode })
        const consumed = new Set(files.map(file => file.id))
        replaceDraftFiles(draftFilesRef.current.filter(file => !consumed.has(file.id)))
        const textarea = form.elements.namedItem('content')
        // The submitted attachments were consumed even if newer text now occupies the composer.
        const consumedImages = new Set(images.map(image => image.id))
        replaceDraftImages(draftImagesRef.current.filter(image => !consumedImages.has(image.id)), false)
        // Keep anything typed while admission was in flight. Never reset another session's form.
        if (!(textarea instanceof HTMLTextAreaElement)) return
        if (!shouldClearAcknowledgedDraft(sessionId, sessionOwnerRef.current, draftText, textarea.value)) {
          persistDraft(textarea.value, draftImagesRef.current, sessionId)
          return
        }
        textarea.value = ''
        resizeComposerTextarea(textarea)
        setSlashQuery(undefined)
        setSlashSelection(0)
        // Admission consumes only the captured draft. Images read while it was
        // pending remain unsent and must survive leaving and revisiting this session.
        if (draftImagesRef.current.length > 0) persistDraft('', draftImagesRef.current, sessionId)
        else clearComposerDraft(browserSessionDraftStorage(), sessionId)
        if (sessionId !== currentId) clearComposerDraft(browserSessionDraftStorage(), currentId)
      } catch (errorValue: unknown) {
        if (sessionOwnerRef.current === currentId && sessionVisitRef.current === visit) {
          setSendNotice({ owner: currentId, phase: 'failed', mode })
          setError(`发送准备失败，草稿已保留：${errorValue instanceof Error ? errorValue.message : String(errorValue)}`)
        }
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

    const beginSideMove = (target: SideEntityTarget): void => {
      setError('')
      setSideEdit(undefined)
      setSideMove(target)
    }

    const moveSessionToProject = async (sessionId: string, workspaceId: string): Promise<void> => {
      const mutationKey = `session:${sessionId}:move`
      setSideMutation(mutationKey)
      setError('')
      setSideMove(undefined)
      setSideMenu(undefined)
      const result = await ctx.sessionCatalog.moveSessionToWorkspace(sessionId, workspaceId)
      setSideMutation(undefined)
      if (!result.ok) { setError(result.error?.message ?? '移入项目失败'); return }
      setOverlayState(value => transitionOverlayState(value, 'close'))
    }

    const selectModel = async (selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): Promise<void> => {
      if (currentId === undefined) { setError('请先新建会话，再选择模型'); return }
      setError('')
      setModelSelectionNotice(undefined)
      try {
        const result = await ctx.modelCatalog.select({ sessionId: currentId, ...selection })
        if (sessionOwnerRef.current !== currentId) return
        if (!result.ok) { setError(result.error?.message ?? '模型切换失败'); return }
        setModelSelectionNotice(modelSelectionPersistenceNotice(result.value?.persistence)
          ?? (result.value?.effective === 'next-request' ? { tone: 'neutral', message: '已接收设置；从下一次模型请求生效，当前请求不变。' } : undefined))
      } catch (cause: unknown) {
        if (sessionOwnerRef.current === currentId) setError(`设置结果未确认：${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }

    const openManagementSettings = (sectionId: 'models' | 'memory' | 'runtime'): void => {
      setOverlayState(value => transitionOverlayState(value, 'close'))
      const content = document.querySelector<HTMLElement>('[data-xsla-settings-trigger-content]')
      const trigger = content?.closest<HTMLButtonElement>('button')
      if (trigger === undefined || trigger === null) {
        setError('请从左下角“设置”进入“模型与服务商”')
        return
      }
      setChoiceMenu(undefined)
      // Settings owns its open state. Navigate through its public DOM affordance
      // after React mounts the panel; a bounded observer avoids guessed delays.
      const root = content?.closest<HTMLElement>('[data-xiaoshe-legacy-adapted]')
      if (root !== null && root !== undefined) {
        const selectSection = (): boolean => {
          const item = root.querySelector<HTMLButtonElement>(`[data-xs-settings-nav-item="${sectionId}"]`)
          if (item === null) return false
          item.click()
          item.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          return true
        }
        const observer = new MutationObserver(() => { if (selectSection()) { observer.disconnect(); window.clearTimeout(timer) } })
        const timer = window.setTimeout(() => observer.disconnect(), 2_000)
        observer.observe(root, { childList: true, subtree: true })
        trigger.click()
        if (selectSection()) { observer.disconnect(); window.clearTimeout(timer) }
        return
      }
      trigger.click()
    }
    const openModelSettings = (): void => openManagementSettings('models')

    const updateRunQueue = async (itemId: string, kind: 'remove' | 'steer' | 'edit', text?: string): Promise<void> => {
      if (connectionUnavailableRef.current || currentId === undefined || queueBusy !== undefined) return
      if (kind === 'steer' && (stoppingRef.current || current?.state !== 'running')) return
      setError('')
      setQueueBusy(itemId)
      try {
        const result = await ctx.runCenter.updateQueue({ sessionId: currentId, itemId, action: kind === 'edit' ? { kind, text: text ?? '' } : { kind } })
        if (sessionOwnerRef.current !== currentId) return
        if (!result.ok) setError(result.error?.message ?? '队列操作失败')
        else setQueueEdit(undefined)
      } catch (cause: unknown) {
        if (sessionOwnerRef.current === currentId) setError(`队列操作未确认，请核对队列：${cause instanceof Error ? cause.message : String(cause)}`)
      } finally { setQueueBusy(undefined) }
    }

    const openRunSubagent = (childSessionId: string): void => {
      if (currentId === undefined) return
      const result = ctx.runCenter.openSubagent({ parentSessionId: currentId, childSessionId })
      if (!result.ok) setError(result.error?.message ?? '无法打开子任务')
    }

    const setGoalPhase = async (action: 'pause' | 'resume'): Promise<void> => {
      if (currentId === undefined || goalBusy || ctx.runCenter.setGoalPhase === undefined) return
      setGoalBusy(true)
      setError('')
      try {
        const result = await ctx.runCenter.setGoalPhase({ sessionId: currentId, action })
        if (sessionOwnerRef.current === currentId && !result.ok) setError(result.error?.message ?? '目标状态未确认，请核对任务面板')
      } catch (cause: unknown) {
        if (sessionOwnerRef.current === currentId) setError(`目标操作未确认：${cause instanceof Error ? cause.message : String(cause)}`)
      } finally { setGoalBusy(false) }
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
      if (inspOverlayOpen) setInspCollapsed(true)
      setOverlayState(value => transitionOverlayState(value, 'close'))
      if (pluginManagerOpen) closePluginManager()
      if (commandOpen) setCommandOpen(false)
      if (choiceMenu !== undefined) setChoiceMenu(undefined)
      if (permissionChallenge !== undefined) setPermissionChallenge(undefined)
      if (sideMenu !== undefined) setSideMenu(undefined)
      if (sideMove !== undefined) setSideMove(undefined)
      if (sideEdit !== undefined) setSideEdit(undefined)
      if (sideRemoval !== undefined) setSideRemoval(undefined)
      if (memoryEditorExpanded) setMemoryEditorExpanded(false)
    }

    const openInspector = (tab: 'status' | 'memory' | 'system'): void => {
      if (tab !== 'status') { openManagementSettings(tab === 'memory' ? 'memory' : 'runtime'); return }
      setWorkbenchView('task')
      setInspCollapsed(false)
      setOverlayState(value => transitionOverlayState(value, 'close'))
    }

    const dialogControls = {
      // The compact browser is visually an overlay too. Contain keyboard focus
      // without declaring it aria-modal, which would hide its native page.
      inspectorOpen: !inspCollapsed && (layoutViewportWidth <= WORKBENCH_OVERLAY_BREAKPOINT || (materialFullscreen && workbenchView === 'materials')),
      closeInspector: (): void => { if (materialFullscreen) setMaterialFullscreen(false); else { setInspCollapsed(true); setOverlayState(value => transitionOverlayState(value, 'close')) } },
      closeNative: (): void => {
        if (commandOpen) setCommandOpen(false)
        else if (sideRemoval !== undefined) { if (sideMutation === undefined) setSideRemoval(undefined) }
        else if (permissionChallenge !== undefined) setPermissionChallenge(undefined)
        else if (memoryEditorExpanded) setMemoryEditorExpanded(false)
        else closePluginManager()
      },
    }
    const dialogControlsRef = react.useRef(dialogControls)
    dialogControlsRef.current = dialogControls
    react.useEffect(() => {
      if (typeof document === 'undefined') return
      const root = document.querySelector<HTMLElement>('[data-xiaoshe-legacy-adapted]')
      if (root === null) return
      let active: HTMLElement | undefined
      let release: (() => void) | undefined
      const reconcile = (): void => {
        const image = Array.from(root.querySelectorAll<HTMLElement>('.image-lightbox')).at(-1)
        const native = Array.from(root.querySelectorAll<HTMLElement>('.modal-layer [role="dialog"]')).at(-1)
        const settings = root.querySelector<HTMLElement>('[data-xs-settings-panel]') ?? undefined
        const drawer = dialogControlsRef.current.inspectorOpen ? root.querySelector<HTMLElement>('#xsla-insp') ?? undefined : undefined
        const dialog = image ?? native ?? settings ?? drawer
        if (dialog === active) return
        const transferringFocus = active?.contains(document.activeElement) === true && document.activeElement instanceof HTMLElement ? document.activeElement : undefined
        release?.(); release = undefined; active = dialog
        if (transferringFocus?.isConnected === true) transferringFocus.focus()
        if (dialog === undefined) return
        const close = image !== undefined ? () => image.querySelector<HTMLButtonElement>('[aria-label="关闭图片预览"]')?.click() : native !== undefined
          ? () => dialogControlsRef.current.closeNative()
          : settings !== undefined ? () => {
            settings.querySelector<HTMLButtonElement>('[data-xs-settings-close]')?.click()
            window.requestAnimationFrame(() => {
              const trigger = root.querySelector<HTMLElement>('[data-xsla-settings-trigger-content]')?.closest<HTMLElement>('button')
              if (trigger?.getClientRects().length === 0) root.querySelector<HTMLElement>('.task-mobile-toggle')?.focus()
            })
          } : () => dialogControlsRef.current.closeInspector()
        dialog.tabIndex = -1
        // Only the uppermost modal owns the keyboard. Inert siblings along
        // its ancestor path also cover settings mounted inside the sidebar.
        const backgrounds: HTMLElement[] = []
        let branch: HTMLElement = dialog
        while (branch !== root && branch.parentElement !== null) {
          for (const sibling of Array.from(branch.parentElement.children)) {
            if (sibling !== branch && sibling instanceof HTMLElement) backgrounds.push(sibling)
          }
          branch = branch.parentElement
        }
        release = mountInspectorOverlayAccessibility(document, dialog, backgrounds, close)
      }
      const observer = new MutationObserver(reconcile)
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'class', 'hidden'] })
      reconcile()
      return () => { observer.disconnect(); release?.() }
    }, [])

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
      setWorkbenchView('materials')
      setInspCollapsed(false)
      setOverlayState(value => transitionOverlayState(value, 'close'))
      if (currentSurfaceItems.length === 0) return
      updateSurfacePreference(currentPreference => {
        let dismissedIds = currentPreference.dismissedIds
        let visible = currentSurfaceItems.filter(item => !dismissedIds.includes(item.id))
        if (visible.length === 0) {
          dismissedIds = []
          visible = [...currentSurfaceItems]
        }
        const activeId = visible.some(item => item.id === currentPreference.activeId) ? currentPreference.activeId : visible.at(-1)?.id
        return { ...currentPreference, open: activeId !== undefined, ...(activeId === undefined ? {} : { activeId }), dismissedIds }
      })
    }

    const closeWorkbench = (): void => {
      setInspCollapsed(true)
      setOverlayState(value => transitionOverlayState(value, 'close'))
      updateSurfacePreference(value => ({ ...value, open: false }))
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-workbench-launcher]')?.focus())
    }

    const selectWorkbenchView = (view: WorkbenchView): void => {
      if (view === 'materials') { openSurfaceDock(); return }
      setWorkbenchView(view)
      setInspCollapsed(false)
      setOverlayState(value => transitionOverlayState(value, 'close'))
    }

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
      if (workbenchView === 'task') {
        panelWidthsTouchedRef.current = true
        setPanelWidths(value => ({ ...value, inspector: workbenchPanelWidth('task', { task: requestedWidth, materials: surfacePreference.width, browser: browserWidth }, surfaceChatWidth) }))
        return
      }
      if (workbenchView === 'browser') setBrowserWidth(browserDockWidth(requestedWidth, surfaceChatWidth))
      else updateSurfacePreference(value => ({ ...value, width: workSurfaceDockWidth(requestedWidth, surfaceChatWidth) }))
    }

    const handleSurfaceResizeKey = (event: { readonly key: string; readonly shiftKey?: boolean; preventDefault?(): void }): void => {
      if (workbenchView === 'task') {
        const requested = panelResizeKeyTarget('inspector', fittedWorkbenchWidth, event.key, event.shiftKey === true, defaultPanelWidths(layoutViewportWidth, typeof window === 'undefined' ? 900 : window.innerHeight).inspector)
        if (requested !== undefined) { event.preventDefault?.(); updateSurfaceWidth(requested) }
        return
      }
      if (browserOpen && event.key === 'Enter') { event.preventDefault?.(); setBrowserWidth(undefined); return }
      let requested: number | undefined
      if (event.key === 'Home') requested = WORK_SURFACE_DOCK_LIMITS.min
      if (event.key === 'End') requested = browserOpen ? browserDockWidth(Number.MAX_SAFE_INTEGER, surfaceChatWidth) : WORK_SURFACE_DOCK_LIMITS.max
      if (event.key === 'Enter') requested = WORK_SURFACE_DOCK_LIMITS.standard
      const step = event.shiftKey === true ? 32 : 8
      const visibleWidth = fittedWorkbenchWidth
      if (event.key === 'ArrowLeft') requested = visibleWidth + step
      if (event.key === 'ArrowRight') requested = visibleWidth - step
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
      const startWidth = fittedWorkbenchWidth
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
    const status = connectionView.unavailable ? 'disconnected' : current?.state ?? 'idle'
    // A retained receipt describes a previous finished turn while work resumes.
    const receipt = connectionView.unavailable || status === 'running' || status === 'blocked' || stopping || sessionQuestionRequests.length > 0 || sessionApprovals.length > 0
      ? undefined : current?.completionReceipt?.outcome
    const runtimeLabel = connectionView.unavailable ? connectionView.label : sessionQuestionRequests.length > 0 ? '需要回答' : sessionApprovals.length > 0 ? '需要确认' : stopping ? '正在停止' : statusLabel(status)
    const contextRow = currentId === undefined ? undefined : context.sessions[currentId]
    const contextView = contextPresentation(contextRow)
    const modelView = modelPresentation(sessionModels)
    const memoryView = memoryPresentation(memoryState, {
      ...(currentCatalog?.cwd === undefined ? {} : { currentProject: currentCatalog.cwd }),
    })
    const heartbeatView = heartbeatHealthPresentation(productHealth)
    const transactionView = pluginTransactionPresentation(pluginState)
    const questionRequest = projectedQuestionRequest
    const activeQuestionFlow = questionFlow.key === questionRequest?.key
      ? questionFlow
      : createQuestionFlowState(questionRequest)
    // Questions own the interaction seat before action approvals, matching the
    // runtime's native precedence while keeping both queues observable.
    const approval = questionRequest === undefined ? sessionApprovals[0] : undefined
    const interactionDetailsReady = questionRequest !== undefined || approval !== undefined
    // The session list can announce a pending interaction before its live
    // question/approval binding arrives. Never treat that gap as ready to send.
    const interactionSyncPending = status === 'blocked' && !interactionDetailsReady
    const interactionBlocked = interactionDetailsReady || interactionSyncPending
    const notice = workbenchNotice({ questionCount: sessionQuestionRequests.length, approvalCount: sessionApprovals.length, runCenter: sessionRunCenter, contextView, heartbeat: heartbeatView })
    const onWorkbenchInteraction = (): void => {
      if (layoutViewportWidth <= WORKBENCH_OVERLAY_BREAKPOINT) setInspCollapsed(true)
      setOverlayState(value => transitionOverlayState(value, 'close'))
      window.requestAnimationFrame(() => {
        const card = document.querySelector<HTMLElement>(questionRequest === undefined ? '.approval' : '.question-card')
        card?.scrollIntoView({ block: 'center', behavior: conversationScrollBehavior() })
        ;(card?.querySelector<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled)') ?? card)?.focus()
      })
    }
    const mainClass = ['main workbench-layout', sideCollapsed ? 'side-collapsed' : '', inspCollapsed ? 'insp-collapsed' : ''].filter(Boolean).join(' ')
    const mainStyle = {
      '--xsla-side-width': `${panelWidths.side}px`,
      '--xsla-insp-width': `${fittedWorkbenchWidth}px`,
    }
    const commands = shellCommandActions({
      running: status === 'running', hasSession: currentId !== undefined,
      onCreate: () => { void createSession() },
      onStop: () => { void stopRun() },
      onFork: () => { void forkCurrent() },
      onCompact: () => { void compactCurrent() },
      onPanel: openInspector,
      onPlugins: () => openManagementSettings('runtime'),
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
      ? sessionApprovals.map(item => renderApproval(e, item, answerApproval))
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

    const nextManagementPages = {
      memory: e('div', null, e('div', { className: 'xsla-settings-heading' }, e('h2', null, '记忆'), e('p', null, '管理长期偏好和项目事实。关闭设置会保留尚未保存的草稿。')),
        renderMemoryPanel(e, {
          memorySummary: memoryView, memoryState, memoryScope, memoryDraft, memoryEditing, memoryBusy, memoryError, currentProject: currentCatalog?.cwd,
          onMemoryScope: setMemoryScope, onMemoryDraft: setMemoryDraft, onMemoryEdit: beginMemoryEdit, onMemoryCancel: cancelMemoryEdit,
          onMemorySubmit: submitMemory, onMemoryExpand: () => setMemoryEditorExpanded(true), onMemoryState: (entry, state) => { void changeMemoryState(entry, state) },
        })),
      runtime: e('div', null, e('div', { className: 'xsla-settings-heading' }, e('h2', null, '运行与扩展'), e('p', null, '需要排查连接或管理扩展时，在这里查看详情。')),
        panelSection(e, '当前模型', modelView.value, modelView.detail, modelView.routable === false ? 'warn' : undefined),
        e('button', { className: 'manager-toggle', type: 'button', onClick: openModelSettings }, '模型与服务商设置'),
        renderProviderReadinessPanel(e, { providerReadiness, onProbeRoute: (provider, model) => { void probeProviderRoute(provider, model) }, onCancelProbe: () => { ctx.providerReadiness.cancelProbe() } }),
        panelSection(e, '扩展变更', `${transactionView.total} 笔记录`, transactionView.detail),
        e('button', { className: 'manager-toggle', type: 'button', onClick: () => setPluginManagerOpen(true) }, '管理插件'),
        e('details', { className: 'task-disclosure' }, e('summary', null, '扩展运行边界'), e('p', null, '本机扩展与小蛇共同运行，没有独立的系统沙箱。'))),
    }
    react.useEffect(() => {
      managementPages = nextManagementPages
      for (const listener of managementListeners) listener()
    }, [nextManagementPages])

    const messagePhases = conversationMessagePhases(timeline.items)
    return e('div', {
      className: 'xsla-shell', 'data-xiaoshe-legacy-adapted': '', 'data-theme': theme,
      style: { ...appearanceTokens(appearanceSnapshot.value, themeSnapshot.active.colorScheme), '--xsla-content-font-size': `${Math.max(12, Math.min(22, themeSnapshot.fontSize ?? 14))}px` },
      'data-appearance-preset': appearanceSnapshot.value.preset,
      'data-xsla-source-identity': CLIENT_SOURCE_IDENTITY,
      'data-runtime-state': status, 'data-side-overlay': sideOverlayOpen, 'data-insp-overlay': inspOverlayOpen,
      onPointerDownCapture: (event: { target?: EventTarget | null }) => {
        if (!(event.target instanceof Element)) return
        if (sideMenu !== undefined && event.target.closest('[data-side-menu-root]') === null) { setSideMenu(undefined); setSideMove(undefined) }
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
          sideMenu, sideEdit, sideMutation, sideMove,
          onMenu: target => { setSideEdit(undefined); setSideMove(undefined); setSideMenu(current => current?.kind === target.kind && current.id === target.id ? undefined : target) },
          onBeginEdit: beginSideEdit,
          onEditValue: value => setSideEdit(current => current === undefined ? current : { ...current, value }),
          onCommitEdit: () => { void commitSideEdit() }, onCancelEdit: () => setSideEdit(undefined),
          onBeginMove: beginSideMove,
          onMoveTo: (sessionId, workspaceId) => { void moveSessionToProject(sessionId, workspaceId) },
          onRemove: target => { setSideMenu(undefined); setSideMove(undefined); setSideRemoval(target) },
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
          ref: surfaceChatRef,
          className: ['chat', timeline.items.length === 0 ? 'chat-empty' : '', !inspCollapsed ? 'workbench-open' : '', browserOpen ? 'browser-open' : ''].filter(Boolean).join(' '),
          'aria-label': '对话区',
          'data-surface-resizing': resizingSurface,
        },
          e('header', { className: 'chat-head' },
            e('h1', {
              className: `chat-title chat-title-frosted${currentCatalog !== undefined && isGenericSessionTitle(currentCatalog.title) ? ' chat-title-generic' : ''}`,
              title: currentCatalog?.title,
            }, currentCatalog === undefined || (timeline.items.length === 0 && isGenericSessionTitle(currentCatalog.title)) ? '新会话' : sessionDisplayTitle(currentCatalog.title, currentCatalog.sessionId, currentCatalog.updatedAt)),
            e('div', { className: 'right' },
              e('span', { className: `live head-runtime ${status === 'running' ? 'busy' : ''}`, role: 'status' }, e('i', null), receipt === undefined ? runtimeLabel : `${runtimeLabel} · ${receiptLabel(receipt)}`),
              sessionQuestionRequests.length + sessionApprovals.length === 0 ? null : e('span', { className: 'head-governance' }, sessionQuestionRequests.length > 0 ? `${sessionQuestionRequests.length} 项问题等待回答` : `${sessionApprovals.length} 项操作等待确认`),
              contextView.level === 'critical' ? e('span', { className: 'head-context' }, contextView.short) : null),
            e('button', { className: 'icbtn task-mobile-toggle', type: 'button', 'aria-controls': 'xsla-side', 'aria-expanded': sideOverlayOpen, onClick: () => { setSideCollapsed(false); setOverlayState(value => transitionOverlayState(value, 'toggle-side')) } }, '会话'),
            e('div', { className: 'surface-launchers' }, e('button', {
              className: `surface-launcher workbench-launcher ${!inspCollapsed ? 'on' : ''}`,
              type: 'button', 'data-workbench-launcher': '', 'aria-controls': 'xsla-insp', 'aria-expanded': !inspCollapsed,
              'aria-label': `切换工作台${notice === undefined ? '' : ` · ${notice.label}`}`,
              title: '任务进度、工作材料与专用浏览器',
              onClick: () => { if (inspCollapsed) selectWorkbenchView(workbenchView); else closeWorkbench() },
            }, icon(e, 'surface'), e('span', null, '工作台'), notice === undefined ? null : e('i', { className: 'workbench-notice-dot', 'aria-hidden': 'true' }))),
            e('button', {
              className: 'theme-toggle', type: 'button',
              'aria-label': theme === 'light' ? '切换为暗色主题' : '切换为亮色主题',
              title: '切换亮色或暗色；更多配色在设置 → 外观',
              onClick: () => ctx.theme.setTheme(theme === 'light' ? 'dark' : 'light'),
            }, theme === 'light' ? icon(e, 'moon') : icon(e, 'sun'))),
          e('div', { className: 'conversation-body' },
            timeline.items.length === 0 ? null : renderConversationGhost(e),
            e('div', { className: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
              receipt === undefined ? runtimeLabel : `${runtimeLabel}，${receiptLabel(receipt)}`),
            e('div', {
              className: 'stream', ref: streamRef,
              'data-empty': timeline.items.length === 0,
              role: 'log', 'aria-label': '对话记录', 'aria-live': 'off',
              onWheel: (event: { deltaY: number; currentTarget: HTMLDivElement }) => {
                // A short initial transcript may not scroll at all. An upward
                // gesture at its top must still reveal the preceding page.
                if (event.deltaY < 0 && event.currentTarget.scrollTop <= 0 && !historyError) loadEarlierHistory()
              },
              onScroll: (event: { currentTarget: HTMLDivElement }) => {
                // Reader scrolls own bottom-follow: pinned while within the
                // floor threshold, released the moment the reader moves up.
                pinnedRef.current = historyPrependRef.current === undefined && isPinnedAtBottom(event.currentTarget)
                // Native anchoring absorbs late image/content-visibility size
                // changes while reading; explicit bottom-follow owns the floor.
                event.currentTarget.style.overflowAnchor = pinnedRef.current ? 'none' : 'auto'
                const pendingHistory = historyPrependRef.current
                if (pendingHistory !== undefined && pendingHistory.owner === currentId && pendingHistory.firstKey === timeline.items[0]?.key) {
                  // A delayed page must respect further user scrolling, not
                  // restore the obsolete position where the request began.
                  Object.assign(pendingHistory, historyViewportAnchor(event.currentTarget))
                }
                const prefetch = !historyError && shouldPrefetchHistory({
                  scrollTop: event.currentTarget.scrollTop, previousTop: previousScrollTopRef.current,
                  clientHeight: event.currentTarget.clientHeight, hasEarlier: timeline.hasEarlier === true,
                  loading: historyPrependRef.current !== undefined || timeline.loading === true,
                })
                previousScrollTopRef.current = event.currentTarget.scrollTop
                const offerJump = shouldOfferJumpToLatest(event.currentTarget)
                setShowJumpToLatest(offerJump)
                if (!offerJump) setUnreadLatestCount(0)
                const offsets = typeof event.currentTarget.querySelector === 'function'
                  ? userTurnNavigation.map(item => event.currentTarget.querySelector<HTMLElement>(`[data-event-index="${item.eventIndex}"]`)?.offsetTop ?? Number.NaN)
                  : []
                setActiveUserTurnOrdinal(activeUserTurnOrdinalAtScroll(offsets, event.currentTarget.scrollTop, event.currentTarget.clientHeight))
                if (prefetch) loadEarlierHistory()
              },
            },
            timeline.hasEarlier === true || historyLoading || historyError ? e('div', { className: 'timeline-history-status', role: 'status' },
              historyError ? e('button', { type: 'button', onClick: loadEarlierHistory }, '旧消息暂未接上，点此重试')
                : historyLoading ? '正在接上更早的消息…' : '向上滚动查看更早消息') : null,
            timeline.loading === true ? e('p', { role: 'status', className: 'muted', 'aria-live': 'polite' }, '正在恢复对话记录…') : timeline.items.length === 0 ? renderEmptyStage(e, {
              drafting: composerHasText || draftImages.length > 0 || draftFiles.some(file => file.owner === currentId),
              needsModelSetup: emptyStageNeedsModelSetup(sessionModels, providerReadiness),
              onModelSettings: openModelSettings,
              onStarter: id => {
                const textarea = composerTextareaRef.current
                if (textarea === null || submitting || stopping || interactionBlocked) return
                const draft = taskStarterDraft(textarea.value, draftImagesRef.current.length + draftFilesRef.current.filter(file => file.owner === currentId).length, id)
                if (draft === undefined) { textarea.focus(); return }
                restoreComposerText(draft)
              },
            }) : e('div', { className: 'events' }, ...conversationDisplayEntries(timeline.items).map(entry => {
              if (entry.kind === 'tools') return e('details', { className: 'tool-disclosure', key: entry.key, 'data-event-key': entry.key },
                e('summary', null, `执行记录 · ${entry.items.length} 项`, e('span', null, '展开详情')),
                ...entry.items.map(({ item }) => e('article', { key: item.key, className: 'tool-detail' },
                  e('b', null, timelineEventPresentation(item, undefined).label), e('pre', null, item.text))))
              const { item, eventIndex } = entry
              if (item.kind === 'assistant' && item.text.trim() === '') return null
              const view = timelineEventPresentation(item, current?.completionReceipt?.sourceSeq)
              const failure = item.isError === true || item.kind === 'error'
              const previousUser = failure
                ? timeline.items.slice(0, eventIndex).reverse().find(candidate => candidate.kind === 'user' && candidate.text.trim() !== '')
                : undefined
              return e('article', {
                id: `xsla-event-${eventIndex}`, className: `event event-${item.kind}${view.historical ? ' historical' : ''}`, key: item.key,
                'data-event-index': String(eventIndex), 'data-event-seq': item.seq, 'data-event-key': item.key, 'data-session-id': timeline.sessionId, 'data-kind': item.kind, 'data-error': failure, 'data-message-phase': messagePhases.get(item.key),
              },
              e('span', { className: 'event-label' }, item.kind === 'assistant' && !failure ? `小蛇 · ${messagePhases.get(item.key) === 'progress' ? '进展' : messagePhases.get(item.key) === 'responding' ? '正在回复' : '回复'}` : view.label),
              e('div', { className: 'event-body' },
                item.kind === 'assistant'
                  ? e('div', { className: 'event-markdown' }, e(MarkdownText, { text: item.text, streaming: item.key === 'partial', labels: MARKDOWN_LABELS }))
                  : item.text,
                item.kind !== 'user' || currentId === undefined || timeline.sessionId !== currentId || !item.images?.length ? null
                  : e('div', { className: 'history-images', 'aria-label': `历史图片，共 ${item.images.length} 张` },
                    ...item.images.map((image, index) => e(HistoryImage, { key: `${currentId}:${item.key}:${index}:${image.attachmentId}`, sessionId: currentId, image, ordinal: index + 1 }))),
                !failure ? null : e('div', { className: 'event-recovery' },
                  view.detail === '' ? null : e('details', null, e('summary', null, '技术详情'), e('code', null, view.detail)),
                  previousUser === undefined ? null : e('button', {
                    className: 'event-restore-button', type: 'button', onClick: () => restoreComposerText(previousUser.text),
                  }, '放回输入框'))))
            })),
            status !== 'running' && status !== 'blocked' ? null : (() => {
              const summary = taskProgressSummary({ state: status, items: timeline.items, run: sessionRunCenter })
              return e('section', { className: 'progress-summary', 'aria-label': '当前进展', role: 'status', 'aria-live': 'polite' },
                e('div', { className: 'progress-summary-head' }, e('i', { 'aria-hidden': 'true' }), e('b', null, summary.activity)),
                summary.goal === '' ? null : e('small', null, `目标 · ${summary.goal}`),
                summary.progress === undefined ? null : e('small', null, summary.progress),
                summary.warning === undefined ? null : e('p', { className: 'progress-warning' }, summary.warning))
            })(),
            ...interactionCards),
            turnIndex.items.length === 0 ? null : e('nav', { className: 'turn-index', 'aria-label': '我的消息导航' },
              turnIndex.pageCount <= 1 ? null : e('button', {
                className: 'turn-index-page', type: 'button', 'data-direction': 'previous',
                'aria-label': '上一组消息', title: `上一组消息（第 ${turnIndex.page + 1} / ${turnIndex.pageCount} 组）`,
                disabled: turnIndex.page === 0,
                onClick: () => { setUserTurnPreview(undefined); setTurnIndexPage(turnIndex.page - 1) },
              }, icon(e, 'down')),
              e('div', { className: 'turn-index-marks' },
                ...turnIndex.items.map(item => e('button', {
                  className: 'turn-index-marker', type: 'button', key: item.key,
                  'data-turn-index': item.ordinal,
                  'data-current': activeUserTurnOrdinal === item.ordinal ? 'true' : undefined,
                  'aria-current': activeUserTurnOrdinal === item.ordinal ? 'location' : undefined,
                  'aria-controls': item.eventIndex < 0 ? undefined : `xsla-event-${item.eventIndex}`,
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
                    cancelHistoryPrepend()
                    setUserTurnPreview(undefined)
                    pinnedRef.current = false
                    if (item.seq !== undefined) ctx.taskTimeline.reveal?.(item.seq)
                    const owner = currentId
                    window.requestAnimationFrame(() => {
                      if (sessionOwnerRef.current !== owner) return
                      const stream = streamRef.current
                      const selector = item.seq === undefined ? `[data-event-index="${item.eventIndex}"]` : `[data-event-seq="${item.seq}"]`
                      const target = stream?.querySelector<HTMLElement>(selector)
                      if (stream !== null && target != null) {
                        setActiveUserTurnOrdinal(item.ordinal)
                        const top = Math.max(0, target.offsetTop - stream.clientHeight * 0.34)
                        // A distant jump is navigation, not upward reading or
                        // a multi-second animation through hundreds of rows.
                        previousScrollTopRef.current = top
                        stream.style.overflowAnchor = 'none'
                        stream.scrollTo({ top, behavior: Math.abs(stream.scrollTop - top) > stream.clientHeight * 2 ? 'instant' : conversationScrollBehavior() })
                      }
                    })
                  },
                }))),
              turnIndex.pageCount <= 1 ? null : e('button', {
                className: 'turn-index-page', type: 'button', 'data-direction': 'next',
                'aria-label': '下一组消息', title: `下一组消息（第 ${turnIndex.page + 1} / ${turnIndex.pageCount} 组）`,
                disabled: turnIndex.page === turnIndex.pageCount - 1,
                onClick: () => { setUserTurnPreview(undefined); setTurnIndexPage(turnIndex.page + 1) },
              }, icon(e, 'down'))),
            userTurnPreview === undefined || !turnIndex.items.some(item => item.key === userTurnPreview.key) ? null : e('aside', {
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
                cancelHistoryPrepend()
                stream.scrollTo({ top: stream.scrollHeight, behavior: conversationScrollBehavior() })
                setShowJumpToLatest(false)
                setUnreadLatestCount(0)
              },
            }, icon(e, 'down'), unreadLatestCount > 0 ? e('span', { className: 'jump-count', 'aria-hidden': 'true' }, unreadLatestCount > 9 ? '9+' : String(unreadLatestCount)) : null) : null),
          e('footer', { className: 'composer' },
            interactionSyncPending ? e('p', { className: 'interaction-sync-note', role: 'status' }, '正在同步待处理的问答或确认，可继续编辑草稿。若持续等待，请先另存草稿，再刷新窗口重新连接。') : null,
            error === '' ? null : e('p', { className: 'composer-error', role: 'alert' }, error),
            sendNotice?.owner !== currentId || sendNotice === undefined ? null : (() => {
              const notice = sendStatusPresentation(sendNotice.phase, sendNotice.mode)
              return e('div', { className: 'composer-send-status', role: 'status', 'aria-live': 'polite', 'data-phase': sendNotice.phase },
                e('b', null, notice.label), e('span', null, notice.detail))
            })(),
            sessionRunCenter.queue.length === 0 ? null : e('section', { className: 'composer-queue', 'aria-label': '待发送队列', tabIndex: -1 },
              e('header', null, e('b', null, `待执行 · ${sessionRunCenter.queue.length}`), e('small', null, '按顺序执行；可单独调整方向')),
              e('div', { className: 'composer-queue-list' }, ...sessionRunCenter.queue.map((item, index) => e('div', { className: 'composer-queue-item', key: item.id, 'data-composer-queue-id': item.id },
                e('span', { className: 'queue-ordinal' }, String(index + 1)),
                queueEdit?.id === item.id ? e('form', { className: 'queue-edit-form', onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void updateRunQueue(item.id, 'edit', queueEdit.text) } },
                  e('textarea', { value: queueEdit.text, rows: 2, 'aria-label': '修改队列消息', disabled: queueBusy !== undefined,
                    onChange: (event: { currentTarget: HTMLTextAreaElement }) => setQueueEdit({ id: item.id, text: event.currentTarget.value }) }),
                  e('button', { type: 'submit', disabled: connectionView.unavailable || queueBusy !== undefined || queueEdit.text.trim() === '' }, '保存'),
                  e('button', { type: 'button', disabled: queueBusy !== undefined, onClick: () => setQueueEdit(undefined) }, '取消')) : e('span', { className: 'queue-preview' }, item.preview),
                queueEdit?.id === item.id ? null : e('div', { className: 'queue-actions' },
                  item.editable && item.text != null ? e('button', { type: 'button', disabled: queueBusy !== undefined, onClick: () => setQueueEdit({ id: item.id, text: item.text! }) }, '编辑') : null,
                  item.steerable && status === 'running' ? e('button', { type: 'button', disabled: queueBusy !== undefined || stopping || connectionView.unavailable, onClick: () => { void updateRunQueue(item.id, 'steer') } }, '立即调整') : null,
                  item.removable ? e('button', { type: 'button', disabled: connectionView.unavailable || queueBusy !== undefined, onClick: () => { void updateRunQueue(item.id, 'remove') } }, '移除') : null))))),
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
            draftFiles.length === 0 ? null : e('div', { className: 'file-attachment-list', 'aria-label': '待发送文件' },
              ...draftFiles.filter(file => file.owner === currentId).map(file => e('div', { className: 'file-attachment', key: file.id, 'data-upload-state': file.phase },
                e('div', null, e('b', null, file.file.name), e('small', null, `${formatBytes(file.file.size)} · ${file.phase === 'ready' ? '可以发送' : file.phase === 'uploading' ? `上传 ${Math.round(file.progress)}%` : file.phase === 'cancelled' ? '已取消' : file.error ?? '上传失败'}`)),
                file.phase === 'uploading' ? e('button', { type: 'button', onClick: () => cancelDraftFile(file.id) }, '取消') : null,
                file.phase === 'failed' || file.phase === 'cancelled' ? e('button', { type: 'button', onClick: () => retryDraftFile(file.id) }, '重试') : null,
                e('button', { type: 'button', disabled: submitting, 'aria-label': `移除文件 ${file.file.name}`, onClick: () => cancelDraftFile(file.id, true) }, '×'))),
              e('small', { className: 'file-draft-boundary' }, '文件仅暂存在当前会话输入区；切换会话或刷新后需重新选择。')),
            e('textarea', {
              ref: composerTextareaRef,
              name: 'content', rows: 1, disabled: interactionDetailsReady,
              placeholder: questionRequest !== undefined ? '请先回答上方问题' : approval !== undefined ? '请先处理当前审批' : current?.state === 'running' ? (sendMode === 'queue' ? '继续输入，加入下一条任务…' : '补充信息，调整当前方向…') : '交代小蛇做事…',
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
            status !== 'running' ? null : e('div', { className: 'composer-running-options' },
              e('span', null, '新消息'),
              e('div', { className: 'send-mode-control', role: 'group', 'aria-label': '发送方式' },
                ...(['queue', 'steer'] as const).map(mode => e('button', { key: mode, type: 'button', 'aria-pressed': sendMode === mode,
                  disabled: submitting || stopping, onClick: () => setSendMode(mode) }, mode === 'queue' ? '排队' : '立即调整')))),
            e('div', { className: 'composer-toolbar', 'data-running': status === 'running' ? 'true' : 'false' },
              e('div', { className: 'composer-tools-left' },
                e('label', { className: 'attachment-control', title: `添加图片或文件（每个文件最多 32 MB）` },
                  e('span', { 'aria-hidden': 'true' }, '＋'),
                  e('span', { className: 'visually-hidden' }, '添加图片或文件'),
                  e('input', {
                    className: 'attachment-input', type: 'file', multiple: true,
                    disabled: interactionBlocked || submitting || stopping,
                    'aria-label': '添加图片或文件',
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
                  snapshot: sessionModels, providerReadiness,
                  disabled: currentId === undefined || interactionBlocked || stopping,
                  running: status === 'running',
                  open: choiceMenu === 'model',
                  ...(modelSelectionNotice === undefined ? {} : { selectionNotice: modelSelectionNotice }),
                  onToggle: () => setChoiceMenu(value => value === 'model' ? undefined : 'model'),
                  onDismiss: () => setChoiceMenu(undefined),
                  onSelect: selection => { void selectModel(selection) },
                  onOpenModelSettings: openModelSettings,
                }),
                status === 'running' ? e('button', {
                  className: 'stop-generation', type: 'button', disabled: stopping,
                  title: stopping ? '正在停止' : '停止生成', 'aria-label': stopping ? '正在停止' : '停止生成',
                  onClick: () => { void stopRun() },
                }, icon(e, 'stop'), e('span', null, stopping ? '停止中' : '停止')) : null,
                e('button', {
                  className: `send ${current?.state === 'running' && sendMode === 'steer' ? 'steer' : ''}`.trim(), type: 'submit',
                  disabled: connectionView.unavailable || interactionBlocked || submitting || stopping,
                  title: submitting ? '正在发送' : current?.state === 'running' ? (sendMode === 'queue' ? '加入队列' : '调整方向') : '发送',
                  'aria-label': submitting ? '正在发送' : current?.state === 'running' ? (sendMode === 'queue' ? '加入队列' : '调整方向') : '发送',
                }, icon(e, 'send'))))),
            e('div', { className: 'hint' }, e('span', null, enterBehavior === 'ctrl-enter-send' ? 'Ctrl+Enter 发送 · Enter 换行' : 'Enter 发送 · Shift+Enter 换行'), status === 'running' ? e('span', { className: 'runtime-steer-hint' }, '运行中可继续排队，也可调整下一次请求的思考强度') : null, e('span', null, '/ 命令'), e('span', null, '粘贴图片、拖入或 ＋ 添加文件'), e('span', { className: 'draft-window-boundary' }, COMPOSER_DRAFT_CURRENT_WINDOW_NOTICE), questionRequest === undefined ? null : e('span', { className: 'question-shortcut' }, '先完成上方问题'), approval === undefined ? null : e('span', { className: 'approval-shortcuts' }, 'Y 允许一次 · N 拒绝'))),
        ),
        renderInspector(e, {
          collapsed: inspCollapsed, overlayOpen: inspOverlayOpen, receipt,
          view: workbenchView, browserAvailable: nativeBrowserBridge() !== undefined,
          fullscreen: materialFullscreen && workbenchView === 'materials',
          notice, materialCount: fileTabs.length,
          taskGoal: taskProgressSummary({ state: status, items: timeline.items, run: sessionRunCenter }).goal,
          verificationGaps: receipt === undefined ? [] : completionGaps(current?.completionReceipt),
          onView: selectWorkbenchView,
          onTabKey: (view, event) => {
            const target = workbenchTabKeyTarget(view, event.key, nativeBrowserBridge() !== undefined)
            if (target === undefined) return
            event.preventDefault()
            selectWorkbenchView(target)
            window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-workbench-view="${target}"]`)?.focus())
          },
          resizer: e('div', {
            className: 'surface-resizer workbench-resizer', role: 'separator', tabIndex: 0,
            'aria-label': '调整工作台宽度', 'aria-orientation': 'vertical',
            'aria-valuemin': workbenchView === 'task' ? 248 : 320,
            'aria-valuemax': workbenchPanelWidth(workbenchView, { task: 400, materials: WORK_SURFACE_DOCK_LIMITS.max, browser: Number.MAX_SAFE_INTEGER }, surfaceChatWidth),
            'aria-valuenow': fittedWorkbenchWidth, title: '拖动调整宽度，双击恢复默认；方向键微调',
            onPointerDown: beginSurfaceResize, onKeyDown: handleSurfaceResizeKey,
            onDoubleClick: () => { if (workbenchView === 'browser') setBrowserWidth(undefined); else updateSurfaceWidth(workbenchView === 'task' ? defaultPanelWidths(layoutViewportWidth, typeof window === 'undefined' ? 900 : window.innerHeight).inspector : WORK_SURFACE_DOCK_LIMITS.standard) },
          }, e('span', { className: 'surface-resizer-grip', 'aria-hidden': 'true' })),
          materials: renderWorkSurfaceDock(e, {
            open: surfaceDockOpen,
            items: materialItems,
            category: showingFiles ? 'files' : 'activity',
            fileCount: fileTabs.length, activityCount: surfaceItems.length,
            onCategory: category => { setMaterialCategory(category); setMaterialSplit(false) },
            fullscreen: materialFullscreen, onFullscreen: () => setMaterialFullscreen(value => !value),
            split: materialSplit && (materialFullscreen || fittedWorkbenchWidth >= 640) && layoutViewportWidth >= 900,
            splitAvailable: materialItems.length > 1 && layoutViewportWidth >= 900,
            onSplit: () => { setMaterialSplit(value => !value); if (!materialSplit) setMaterialFullscreen(true) },
            ...(secondarySurface === undefined ? {} : { secondary: secondarySurface }),
            onSecondary: setSecondarySurfaceId,
            renderContent: surface => fileTabs.some(file => file.id === surface.id) && materialCategory === 'files'
              ? e(FilePreview, { key: `${surface.sessionId}:${surface.source}`, surface, reloadKey: surfaceReload })
              : renderWorkSurfaceContent(e, surface, surfacePreference.mode, surfaceReload),
            hiddenCount: currentSurfaceItems.length - surfaceItems.length,
            onRestoreHidden: () => updateSurfacePreference(value => ({ ...value, dismissedIds: [] })),
            ...(activeSurface === undefined ? {} : { active: activeSurface }),
            preference: { ...surfacePreference, width: fittedSurfaceWidth },
            reloadKey: surfaceReload,
            onSelect: selectSurface,
            onClose: closeSurface,
            onTogglePin: toggleSurfacePin,
            onMode: mode => updateSurfacePreference(value => ({ ...value, mode })),
            onRefresh: () => setSurfaceReload(value => value + 1),
            onCopy: surface => { void copySurfaceSource(surface) },
            onExternal: openSurfaceExternally,
          }),
          browser: e(BrowserDock, {
            ownerId: currentId, open: browserOpen, resizing: resizingSurface,
            onOpen: () => selectWorkbenchView('browser'),
          }),
          runtimeState: status, stopping, questionCount: sessionQuestionRequests.length,
          onInteraction: onWorkbenchInteraction,
          contextView, heartbeat: heartbeatView, approval, approvalCount: sessionApprovals.length,
          runCenter: sessionRunCenter, surfaces: currentSurfaceItems,
          onQueueAction: (itemId, kind) => { void updateRunQueue(itemId, kind) },
          onQueueFocus: () => document.querySelector<HTMLElement>('.composer-queue')?.focus(),
          ...(ctx.runCenter.setGoalPhase === undefined ? {} : { onGoalPhase: (action: 'pause' | 'resume') => { void setGoalPhase(action) } }),
          goalBusy,
          onOpenSubagent: openRunSubagent,
          onInterruptSubagent: childSessionId => { void interruptRunSubagent(childSessionId) },
          onCollapse: () => { if (materialFullscreen) setMaterialFullscreen(false); else closeWorkbench() },
        })),
      renderStatusbar(e, { sessionId: currentId, turns: timeline.items.filter(item => item.kind === 'user').length })),
    sideOverlayOpen || inspOverlayOpen ? e('button', { className: 'overlay-scrim', type: 'button', 'aria-label': '关闭浮层', onClick: closeOverlays }) : null,
    pluginManagerOpen ? e('div', { className: 'modal-layer', role: 'presentation', onMouseDown: closePluginManager },
      e('section', { className: 'confirm-box plugin-manager', role: 'dialog', 'aria-modal': 'true', 'aria-label': '插件管理', onMouseDown: (event: { stopPropagation(): void }) => event.stopPropagation() },
        pluginManagerPanel(e, { workflow: pluginWorkflow, busy: pluginState.pendingRequests > 0, plugins, transactions: pluginState.transactions, onSubmit: beginPluginWorkflow, onPrepare: preparePluginIntent, onConfirm: confirmPluginChange, onReset: resetPluginWorkflow, onClose: closePluginManager }))) : null,
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
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'appearance', order: 5, label: '外观',
    }, AppearanceSettingsSection)),
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'memory', order: 20, label: '记忆',
    }, MemorySettingsSection)),
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'runtime', order: 35, label: '运行与扩展',
    }, RuntimeSettingsSection)),
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
    unsubscribeAppearance()
    appearance.dispose()
    releasePalette?.()
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
  readonly sideMove: SideEntityTarget | undefined
  readonly currentId: string | undefined; readonly status: string; readonly onCreate: () => void; readonly onProject: () => void
  readonly onWorkspace: (workspaceId: string) => void; readonly onToggleWorkspace: (workspaceId: string) => void
  readonly onMenu: (target: SideEntityTarget) => void; readonly onBeginEdit: (target: SideEntityTarget) => void
  readonly onEditValue: (value: string) => void; readonly onCommitEdit: () => void; readonly onCancelEdit: () => void
  readonly onBeginMove: (target: SideEntityTarget) => void; readonly onMoveTo: (sessionId: string, workspaceId: string) => void
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

/**
 * Projects a session can still be moved into: every registered project except
 * the one its cwd already belongs to. Order follows the registry projection so
 * the submenu keeps a stable shape across renders.
 */
export function sessionMoveTargets(
  workspaces: readonly { readonly workspaceId: string; readonly path: string; readonly title: string }[],
  cwd: string | undefined,
): readonly { readonly workspaceId: string; readonly title: string }[] {
  return workspaces
    .filter(workspace => cwd === undefined || workspace.path !== cwd)
    .map(workspace => ({ workspaceId: workspace.workspaceId, title: workspace.title }))
}

function renderSessionButton(e: ReactLike['createElement'], row: { readonly sessionId: string; readonly title?: string; readonly cwd?: string; readonly updatedAt: number; readonly searchSnippet?: string }, options: {
  readonly currentId: string | undefined; readonly status: string; readonly onOpen: (sessionId: string) => void
  readonly workspaces: readonly { readonly workspaceId: string; readonly path: string; readonly title: string; readonly sessionIds: readonly string[] }[]
  readonly sideMenu: SideEntityTarget | undefined; readonly sideEdit: SideEditTarget | undefined; readonly sideMutation: string | undefined
  readonly sideMove: SideEntityTarget | undefined
  readonly onMenu: (target: SideEntityTarget) => void; readonly onBeginEdit: (target: SideEntityTarget) => void
  readonly onEditValue: (value: string) => void; readonly onCommitEdit: () => void; readonly onCancelEdit: () => void
  readonly onBeginMove: (target: SideEntityTarget) => void; readonly onMoveTo: (sessionId: string, workspaceId: string) => void
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
  // The move step replaces the action list with its eligible projects; an
  // empty target set (registry changed under an open menu) falls back instead
  // of rendering an unusable submenu.
  const moveTargets = sessionMoveTargets(options.workspaces, row.cwd)
  const moving = options.sideMove?.kind === 'session' && options.sideMove.id === row.sessionId && moveTargets.length > 0
  return e('div', { className: `sess-row${row.sessionId === options.currentId ? ' on' : ''}`, key: row.sessionId, 'data-session-id': row.sessionId, 'data-side-menu-root': '' },
    editing
      ? e('div', { className: 'sess sess-edit' }, e('span', { className: `session-indicator${row.sessionId === options.currentId && options.status === 'running' ? ' running' : ''}` }), renderSideRenameInput(e, { value: options.sideEdit?.value ?? title, label: `重命名会话 ${title}`, busy, onValue: options.onEditValue, onCommit: options.onCommitEdit, onCancel: options.onCancelEdit }))
      : e('button', { className: 'sess', type: 'button', title: sessionTooltip, onClick: () => options.onOpen(row.sessionId) },
        e('div', { className: 't1' }, e('span', { className: `session-indicator${row.sessionId === options.currentId && options.status === 'running' ? ' running' : ''}` }), e('span', { className: 'prev' }, title)),
        searchSnippet === undefined || searchSnippet === '' ? null : e('div', { className: 't2', title: searchSnippet }, searchSnippet)),
    editing ? null : e('button', { className: 'side-menu-trigger session-menu-trigger', type: 'button', disabled: busy, title: `编辑“${title}”`, 'aria-label': `${title} 会话操作`, 'aria-expanded': menuOpen, onClick: () => options.onMenu(target) }, '⋯'),
    menuOpen ? renderSideActionMenu(e, {
      label: `${title} 会话操作`,
      actions: moving
        ? moveTargets.map(workspace => ({
            label: `移入「${workspace.title}」`,
            onClick: () => options.onMoveTo(row.sessionId, workspace.workspaceId),
          }))
        : [
            { label: '重命名会话', onClick: () => options.onBeginEdit(target) },
            ...(moveTargets.length === 0
              ? []
              : [{ label: '移入项目…', onClick: () => options.onBeginMove(target) }]),
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
  readonly surfaces: readonly WorkSurface[]
  readonly runtimeState: string; readonly stopping: boolean; readonly questionCount: number; readonly onInteraction: () => void
  readonly collapsed: boolean; readonly overlayOpen: boolean
  readonly fullscreen?: boolean
  readonly receipt: string | undefined
  readonly taskGoal?: string
  readonly verificationGaps?: readonly string[]
  readonly contextView: ReturnType<typeof contextPresentation>
  readonly heartbeat: { readonly status: string; readonly detail: string; readonly running: boolean; readonly tone?: 'ok' | 'warn' }
  readonly approval: { readonly key: string; readonly toolName: string; readonly reason?: string } | undefined
  readonly approvalCount: number
  readonly runCenter: RunCenterSnapshot
  readonly onQueueAction: (itemId: string, kind: 'remove' | 'steer') => void
  readonly onQueueFocus?: () => void
  readonly onGoalPhase?: (action: 'pause' | 'resume') => void
  readonly goalBusy?: boolean
  readonly onOpenSubagent: (childSessionId: string) => void
  readonly onInterruptSubagent: (childSessionId: string) => void
  readonly view: WorkbenchView
  readonly browserAvailable: boolean
  readonly materialCount: number
  readonly notice: ReturnType<typeof workbenchNotice>
  readonly materials: unknown; readonly browser: unknown; readonly resizer: unknown
  readonly onView: (view: WorkbenchView) => void
  readonly onTabKey: (view: WorkbenchView, event: { key: string; preventDefault(): void }) => void
  readonly onCollapse: () => void
}): unknown {
  const narrow = typeof window !== 'undefined' && window.innerWidth <= WORKBENCH_OVERLAY_BREAKPOINT
  const modal = options.view !== 'browser' && (options.overlayOpen || options.fullscreen)
  const tabs: { view: WorkbenchView; label: string; panel: string }[] = [
    { view: 'task', label: '任务', panel: 'xsla-panel-status' },
    { view: 'materials', label: `材料 · ${options.materialCount}`, panel: 'xsla-panel-materials' },
    ...(options.browserAvailable ? [{ view: 'browser' as const, label: '浏览器', panel: 'xsla-panel-browser' }] : []),
  ]
  return e('aside', {
    id: 'xsla-insp', className: `insp unified-workbench${options.fullscreen ? ' material-fullscreen' : ''}${options.collapsed ? ' collapsed' : ''}${!options.collapsed && narrow ? ' mobile-open' : ''}`,
    hidden: options.collapsed, 'data-workbench-active': options.view,
    'aria-label': '工作台', role: modal ? 'dialog' : 'complementary',
    'aria-modal': modal ? 'true' : undefined,
    onKeyDown: (event: { key: string; target: EventTarget; currentTarget: HTMLElement; preventDefault(): void; stopPropagation(): void }) => {
      if (event.key !== 'Escape' || event.currentTarget.querySelector('[aria-modal="true"]')) return
      event.preventDefault(); event.stopPropagation(); options.onCollapse()
    },
  },
    options.resizer,
    e('div', { className: 'workbench-head' }, e('h2', null, '工作台'),
      e('button', { type: 'button', 'aria-label': '收起工作台', title: '收起面板，不停止任务或关闭网页', onClick: options.onCollapse }, '收起')),
    options.notice === undefined ? null : e('button', {
      type: 'button', className: 'workbench-attention', 'data-workbench-notice': options.notice.kind,
      onClick: options.notice.kind === 'interaction' ? options.onInteraction : () => options.onView('task'),
    }, e('span', { role: 'status' }, options.notice.label), e('small', null, options.notice.kind === 'interaction' ? '去处理' : '查看')),
    e('nav', { className: 'workbench-tabs', role: 'tablist', 'aria-label': '工作台视图' }, ...tabs.map(tab => e('button', {
      key: tab.view, id: `xsla-workbench-tab-${tab.view}`, type: 'button', role: 'tab',
      'data-workbench-view': tab.view, 'aria-selected': options.view === tab.view, 'aria-controls': tab.panel,
      tabIndex: options.view === tab.view ? 0 : -1,
      onClick: () => options.onView(tab.view), onKeyDown: (event: { key: string; preventDefault(): void }) => options.onTabKey(tab.view, event),
    }, tab.label))),
    e('section', { id: 'xsla-panel-status', className: 'workbench-view insp-body', role: 'tabpanel', 'aria-labelledby': 'xsla-workbench-tab-task', hidden: options.view !== 'task' }, renderRunCenterPanel(e, options)),
    e('section', { id: 'xsla-panel-materials', className: 'workbench-view workbench-materials', role: 'tabpanel', 'aria-labelledby': 'xsla-workbench-tab-materials', hidden: options.view !== 'materials' }, options.materials),
    // Stable position/ancestors keep BrowserDock's owner effect mounted across
    // tab switches. Only its open prop controls native bounds visibility.
    e('section', { id: 'xsla-panel-browser', className: 'workbench-view workbench-browser', role: 'tabpanel', 'aria-labelledby': 'xsla-workbench-tab-browser', hidden: options.view !== 'browser' }, options.browser))
}

function renderRunCenterPanel(e: ReactLike['createElement'], options: {
  readonly surfaces: readonly WorkSurface[]
  readonly runtimeState: string; readonly stopping: boolean; readonly questionCount: number; readonly onInteraction: () => void
  readonly runCenter: RunCenterSnapshot
  readonly receipt: string | undefined
  readonly taskGoal?: string
  readonly verificationGaps?: readonly string[]
  readonly contextView: ReturnType<typeof contextPresentation>
  readonly heartbeat: { readonly status: string; readonly detail: string; readonly running: boolean; readonly tone?: 'ok' | 'warn' }
  readonly approval: { readonly key: string; readonly toolName: string; readonly reason?: string } | undefined
  readonly approvalCount: number
  readonly onQueueAction: (itemId: string, kind: 'remove' | 'steer') => void
  readonly onQueueFocus?: () => void
  readonly onGoalPhase?: (action: 'pause' | 'resume') => void
  readonly goalBusy?: boolean
  readonly onOpenSubagent: (childSessionId: string) => void
  readonly onInterruptSubagent: (childSessionId: string) => void
}): unknown {
  const run = options.runCenter
  const view = runCenterWorkbenchPresentation(run)
  const pending = view.counts.pending + options.approvalCount + options.questionCount
  const attention = view.attentionGroups.length > 0 || taskGraphNeedsAttention(run.taskGraph) || options.contextView.level === 'critical' || options.heartbeat.tone === 'warn'
  const state = taskStatePresentation({
    runtimeState: options.runtimeState, stopping: options.stopping, questionCount: options.questionCount,
    approvalCount: options.approvalCount, queued: view.counts.pending, active: view.counts.active,
    loading: run.status === 'loading', attention: attention || run.status === 'error', receipt: options.receipt,
  })
  const currentTurnActive = options.runtimeState === 'running' || options.runtimeState === 'blocked' || options.stopping || options.questionCount + options.approvalCount > 0
  const summaryTitle = run.goal?.objective || (run.taskGraph?.stale === false ? run.taskGraph.objective : undefined) || options.taskGoal || (currentTurnActive || pending > 0 || attention || view.counts.active > 0 || options.receipt !== undefined ? '当前任务' : '可以开始了')
  const summaryDetail = run.status === 'error' && !currentTurnActive ? '任务状态暂未连接，不能据此判断执行结果。详细错误见运行信息。' : state.detail
  const gapView = verificationGapPresentation(options.receipt, options.verificationGaps)
  const graph = run.taskGraph === undefined ? undefined : taskGraphPresentation(run.taskGraph)

  const section = (title: string, className: string, rows: readonly unknown[], extra: Record<string, unknown> = {}): unknown => rows.length === 0
    ? null
    : e('section', { className: `psec task-section ${className}`, ...extra }, e('h4', null, title), e('div', { className: 'task-list' }, ...rows))
  const groupedRow = (group: RunCenterJobGroup, index: number, kind: 'attention' | 'history'): unknown => e('div', {
    className: `task-row task-row-${kind}`, key: `${kind}:${group.status}:${group.label}:${index}`,
    ...(kind === 'history' ? { 'data-run-history-group': group.label, 'data-run-history-count': group.count } : { 'data-run-attention-group': group.label }),
  }, e('div', { className: 'task-row-main' }, e('b', null, group.label), e('span', { 'data-run-status': group.status }, `${runStatusLabel(group.status)}${group.count > 1 ? ` ×${group.count}` : ''}`)), group.detail === undefined ? null : e('small', null, group.detail))

  const pendingRows: unknown[] = []
  if (options.questionCount > 0 || options.approval !== undefined) pendingRows.push(e('button', {
    className: 'task-row task-row-action task-interaction', type: 'button', key: 'interaction',
    'data-task-interaction': options.questionCount > 0 ? 'question' : 'approval', onClick: options.onInteraction,
  }, e('div', { className: 'task-row-main' }, e('b', null, options.questionCount > 0 ? `${options.questionCount} 项问题等待回答` : `${options.approvalCount} 项操作等待确认`), e('span', null, options.questionCount > 0 ? '去回答' : '去确认')),
  options.questionCount > 0 ? null : e('small', null, options.approval?.reason ?? '查看操作详情后决定是否允许。')))
  if (run.queue.length > 0) pendingRows.push(e('button', { className: 'task-row task-row-action', type: 'button', key: 'queue', onClick: options.onQueueFocus },
    e('b', null, `${run.queue.length} 条消息待执行`), e('small', null, '在输入区上方查看、编辑或移除排队消息')))

  const activeRows: unknown[] = []
  for (const job of view.activeJobs) activeRows.push(e('div', { className: 'task-row', key: `job:${job.id}`, 'data-run-job-id': job.id }, e('div', { className: 'task-row-main' }, e('b', null, job.label), e('span', { 'data-run-status': job.status }, runStatusLabel(job.status))), job.detail === undefined ? null : e('small', null, job.detail)))
  for (const todo of view.activeTodos) activeRows.push(e('div', { className: 'task-row', key: `todo:${todo.id}`, 'data-run-todo-id': todo.id }, e('div', { className: 'task-row-main' }, e('b', null, todo.text), e('span', null, '待办'))))
  for (const child of view.activeSubagents) activeRows.push(e('div', { className: 'task-row', key: `subagent:${child.id}`, 'data-run-subagent-id': child.id }, e('div', { className: 'task-row-main' }, e('b', null, child.label ?? '子任务'), e('span', null, '正在运行')), e('div', { className: 'run-center-actions' }, e('button', { type: 'button', onClick: () => options.onOpenSubagent(child.id) }, '打开'), child.canInterrupt ? e('button', { type: 'button', onClick: () => options.onInterruptSubagent(child.id) }, '停止') : null)))

  const attentionRows: unknown[] = view.attentionGroups.map((group, index) => groupedRow(group, index, 'attention'))
  if (options.contextView.level === 'critical') attentionRows.push(e('div', { className: 'task-row task-row-attention', key: 'context-warning' }, e('div', { className: 'task-row-main' }, e('b', null, '上下文空间不足'), e('span', null, options.contextView.value)), e('small', null, options.contextView.detail)))
  if (options.heartbeat.tone === 'warn') attentionRows.push(e('div', { className: 'task-row task-row-attention', key: 'heartbeat-warning' }, e('div', { className: 'task-row-main' }, e('b', null, '运行巡检'), e('span', null, options.heartbeat.status)), e('small', null, options.heartbeat.detail)))

  return e('div', { className: 'task-workbench' },
    e('section', { className: 'psec task-overview', ...(state.tone === undefined ? {} : { 'data-tone': state.tone }), 'data-receipt-outcome': options.receipt ?? 'none' },
      e('h4', null, '本轮'),
      e('div', { className: 'panel-fact task-summary' },
        e('div', { className: 'task-summary-head' }, e('b', null, summaryTitle), e('span', null, state.label)),
        e('small', null, summaryDetail),
        gapView === undefined ? null : e('details', { className: 'verification-gaps', open: true },
          e('summary', null, '尚未验证的部分'),
          gapView.gaps.length ? e('ul', null, ...gapView.gaps.map((gap, index) => e('li', { key: index }, gap)))
            : e('p', null, gapView.detail)),
        options.onGoalPhase === undefined || !['active', 'paused'].includes(run.goal?.phase ?? '') ? null : e('div', { className: 'run-center-actions' },
          e('button', { type: 'button', disabled: options.goalBusy === true,
            onClick: () => options.onGoalPhase?.(run.goal?.phase === 'paused' ? 'resume' : 'pause') }, run.goal?.phase === 'paused' ? '恢复目标' : '暂停目标')),
        e('div', { className: 'task-metrics', 'aria-label': '任务摘要' }, pending === 0 ? null : e('span', null, `待处理 ${pending}`), view.counts.active === 0 ? null : e('span', null, `进行中 ${view.counts.active}`)))),
    section('待处理', 'task-pending', pendingRows),
    section('需要关注', 'task-attention', attentionRows),
    graph === undefined || graph.stale ? null : renderTaskGraphSection(e, graph),
    section('正在推进', 'task-active', activeRows),
    graph?.stale !== true ? null : e('details', { className: 'task-disclosure task-graph-history', key: `history:${graph.id}` },
      e('summary', null, e('span', null, `历史任务图 · ${graph.objective}`), e('small', null, graph.summary)),
      renderTaskGraphSection(e, graph)),
    run.subagents.every(child => child.kind !== 'child' || child.activity === 'running') ? null : e('details', { className: 'task-disclosure' },
      e('summary', null, '其他子任务'),
      ...run.subagents.filter(child => child.kind === 'child' && child.activity !== 'running').map(child => child.kind !== 'child' ? null : e('div', { className: 'task-row', key: child.id, 'data-run-subagent-id': child.id },
        e('div', { className: 'task-row-main' }, e('b', null, child.label ?? '子任务'), e('span', null, '当前未运行')),
        e('button', { type: 'button', onClick: () => options.onOpenSubagent(child.id) }, '打开记录')))),
    view.recentGroups.length === 0 ? null : e('details', { className: 'task-disclosure run-history' },
      e('summary', null, e('span', null, '最近运行'), e('small', null, `${view.counts.history} 条记录 · 已归并为 ${view.recentGroups.length} 项`)),
      e('div', { className: 'task-list' }, ...view.recentGroups.map((group, index) => groupedRow(group, index, 'history')))),
    e('details', { className: 'task-disclosure runtime-facts' },
      e('summary', null, e('span', null, '运行信息'), e('small', null, `${options.contextView.short} · ${options.heartbeat.status}`)),
      e('div', { className: 'runtime-fact-list' },
        run.status !== 'error' ? null : e('div', { className: 'runtime-fact-row task-connection-error' }, e('b', null, '任务连接'), e('small', null, run.error ?? '未提供详细错误')),
        e('div', { className: 'runtime-fact-row' }, e('b', null, '上下文'), e('span', null, options.contextView.value), e('small', null, options.contextView.detail)),
        e('div', { className: 'runtime-fact-row' }, e('b', null, '巡检'), e('span', null, options.heartbeat.status), e('small', null, options.heartbeat.detail)))))
}

function renderTaskGraphSection(e: ReactLike['createElement'], graph: TaskGraphPresentation): unknown {
  // Keep live work and unresolved blockers outside the compact overflow. Native
  // disclosures retain their open state across revisions of the same graph.
  const firstReady = graph.nodes.find(node => node.displayStatus === 'ready')?.id
  const unfinished = graph.nodes.filter(node => node.displayStatus !== 'completed')
  const leading = new Set((graph.nodes.length > 8 && unfinished.length > 0 ? unfinished : graph.nodes).slice(0, 8).map(node => node.id))
  const visible = graph.nodes.filter(node => leading.has(node.id) || node.id === firstReady
    || ['running', 'verifying', 'blocked', 'interrupted'].includes(node.displayStatus))
  const visibleIds = new Set(visible.map(node => node.id))
  const remaining = graph.nodes.filter(node => !visibleIds.has(node.id))
  const renderNode = (node: TaskGraphNodePresentation): unknown => e('li', {
      className: 'task-graph-node', key: node.id, 'data-task-node': node.id, 'data-task-node-status': node.displayStatus,
    },
    e('div', { className: 'task-row-main task-graph-node-head' }, e('b', null, node.title), e('span', null, node.statusLabel)),
    node.dependencies.length === 0 ? null : e('small', { className: 'task-graph-dependencies' }, `依赖：${node.dependencies.join('、')}`),
    node.latestFeedback === undefined || !['blocked', 'interrupted'].includes(node.displayStatus) ? null
      : e('p', { className: 'task-graph-feedback-preview' }, e('b', null, '最近反馈：'), e('span', null, node.latestFeedback)),
    e('details', { className: 'task-graph-details' },
      e('summary', { 'aria-label': `展开 ${node.title} 详情` }, '详情'),
      e('div', { className: 'task-graph-detail-body' },
        node.attemptLabel === undefined ? null : e('small', null, node.attemptLabel),
        e('b', null, '验收项'),
        e('ul', null, ...node.acceptance.map((criterion, index) => e('li', { key: `${node.id}:acceptance:${index}` }, criterion))),
        node.latestFeedback === undefined ? null : e('p', null, e('b', null, '最新反馈'), e('span', null, node.latestFeedback)),
        node.evidenceLabels.length === 0 ? null : e('div', { className: 'task-graph-evidence' }, e('b', null, '依据'), ...node.evidenceLabels.map((label, index) => e('small', { key: `${node.id}:evidence:${index}` }, label))))))
  return e('section', { className: 'psec task-section task-graph', key: graph.id, 'data-task-graph': '', 'data-graph-status': graph.status },
    e('div', { className: 'task-graph-head' }, e('h4', null, '任务节点'), graph.status === 'waiting' ? e('span', { className: 'task-graph-state' }, graph.statusLabel) : null, e('small', null, graph.summary)),
    graph.current === undefined ? null : e('p', { className: 'task-graph-current' }, e('span', null, '当前'), e('b', null, graph.current)),
    graph.currentFeedback === undefined ? null : e('p', { className: 'task-graph-current-feedback' }, e('b', null, '最近反馈：'), e('span', null, graph.currentFeedback)),
    ...graph.notices.map((notice, index) => e('p', { className: 'task-graph-notice', key: `notice:${index}`, role: 'status' }, notice)),
    graph.latestFeedback === undefined ? null : e('details', { className: 'task-graph-feedback', key: 'feedback' },
      e('summary', null, e('b', null, '图的最近反馈'), e('span', null, graph.latestFeedback)),
      e('p', null, graph.latestFeedback)),
    e('ol', { className: 'task-graph-list', 'aria-label': '任务图节点', key: 'nodes' }, ...visible.map(renderNode)),
    remaining.length === 0 ? null : e('details', { className: 'task-graph-more', key: 'remaining' },
      e('summary', null, `其余 ${remaining.length} 个节点`),
      e('ol', { className: 'task-graph-list', 'aria-label': '其余任务图节点' }, ...remaining.map(renderNode))))
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
        e('div', { className: 'provider-route-meta' }, e('span', null, route.reasons.includes('probe_configuration_changed') ? providerReasonLabel('probe_configuration_changed') : route.probe === undefined ? providerReasonLabel(route.reasons[0]) : probeSummary(route.probe)), e('button', { type: 'button', disabled: readiness.status === 'probing', onClick: () => options.onProbeRoute(route.provider, route.model) }, route.facts.verified ? '重新验证' : '验证'))))),
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
  const groups = memoryPanelEntryGroups(snapshot, options.currentProject)
  const effectiveScope = options.memoryScope === 'project' && options.currentProject === undefined ? 'global' : options.memoryScope
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
    memoryGroup('长期', groups.global, '还没有跨项目长期保留的记忆。'),
    memoryGroup('当前项目', groups.project, options.currentProject === undefined ? '选择工作区后，这里会显示与该项目精确绑定的记忆。' : '当前项目还没有单独记住的内容。'),
    memoryGroup('已遗忘', groups.forgotten, '没有可恢复的已遗忘记忆。'),
    (snapshot?.counts.superseded ?? 0) === 0 ? null : e('p', { className: 'memory-history-note' }, `另有 ${snapshot?.counts.superseded ?? 0} 个旧版本保留在审计历史中。`))
}

/** Group the current memory projection using the Host's canonical project key. */
export function memoryPanelEntryGroups(
  snapshot: MemorySnapshot | undefined,
  currentProject: string | undefined,
): { readonly global: readonly MemoryEntry[]; readonly project: readonly MemoryEntry[]; readonly forgotten: readonly MemoryEntry[] } {
  const entries = snapshot?.entries ?? []
  // New Hosts return the exact canonical key used for filtering. Falling back
  // to Windows-insensitive comparison keeps rolling upgrades readable. A
  // retained snapshot from a previously selected project is never displayed.
  const projectKey = snapshot?.project === undefined
    ? currentProject
    : currentProject !== undefined && memoryProjectKeysEqual(snapshot.project, currentProject)
      ? snapshot.project
      : undefined
  const matchesProject = (entry: MemoryEntry): boolean => entry.project !== undefined
    && projectKey !== undefined
    && (snapshot?.project === undefined
      ? memoryProjectKeysEqual(entry.project, projectKey)
      : entry.project === projectKey)
  return {
    global: entries.filter(entry => entry.scope === 'global' && entry.state === 'active'),
    project: entries.filter(entry => entry.scope === 'project' && entry.state === 'active' && matchesProject(entry)),
    forgotten: entries.filter(entry => entry.state === 'forgotten'
      && (entry.scope === 'global' || matchesProject(entry))),
  }
}

/** Detect a real project-boundary change while tolerating Windows path aliases. */
export function memoryProjectContextChanged(
  previous: MemoryProjectContext,
  next: MemoryProjectContext,
): boolean {
  const cwdChanged = previous.cwd === undefined || next.cwd === undefined
    ? previous.cwd !== next.cwd
    : !memoryProjectKeysEqual(previous.cwd, next.cwd)
  const canonicalChanged = previous.canonical !== undefined
    && next.canonical !== undefined
    && !memoryProjectKeysEqual(previous.canonical, next.canonical)
  return cwdChanged || canonicalChanged
}

function memoryProjectKeysEqual(left: string, right: string): boolean {
  if (left === right) return true
  const comparable = (value: string): string | undefined => {
    const trimmed = value.trim()
    if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/u.test(trimmed)) return undefined
    return trimmed
      .replaceAll('\\', '/')
      .replace(/\/+$/u, '')
      .toLocaleLowerCase('en-US')
  }
  const normalizedLeft = comparable(left)
  return normalizedLeft !== undefined && normalizedLeft === comparable(right)
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
        e('div', null, e('h2', null, options.memoryEditing === undefined ? '写入记忆' : '修改记忆'), e('p', null, '编辑的是设置中同一份记忆草稿。')),
        e('button', { type: 'button', onClick: options.onClose }, '返回设置')),
      e('form', { onSubmit: options.onMemorySubmit },
        e('div', { className: 'memory-scope', role: 'group', 'aria-label': '记忆范围' },
          e('button', { type: 'button', 'aria-pressed': effectiveScope === 'global', disabled: options.memoryEditing !== undefined || busy, onClick: () => options.onMemoryScope('global') }, '长期'),
          e('button', { type: 'button', 'aria-pressed': effectiveScope === 'project', disabled: options.memoryEditing !== undefined || options.currentProject === undefined || busy, title: options.currentProject ?? '选择工作区后可用', onClick: () => options.onMemoryScope('project') }, '当前项目')),
        e('textarea', {
          value: options.memoryDraft, maxLength: 4_000, disabled: busy,
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
    e('span', { className: 'status-session', title: options.sessionId ?? '当前无会话' }, options.sessionId === undefined ? '当前无会话' : '当前会话'),
    e('span', { className: 'status-turns' }, `${options.turns} 轮对话`),
    e('div', { className: 'r' }, e('span', null, '小蛇桌面端')))
}

/** Render the official raster asset as a theme-visible gradient outline. */
function renderBrandOutline(e: ReactLike['createElement'], className: string, idPrefix: string): unknown {
  const sheenId = `${idPrefix}-sheen`
  const edgeId = `${idPrefix}-edge`
  const outlineId = `${idPrefix}-outline`
  // A subpixel morphology radius collapses to zero in Chromium when the large
  // watermark is scaled to a small welcome mark. Extract its outer edge in a
  // smaller coordinate space, retaining the exact canonical silhouette and a
  // roughly 1–1.5 CSS-pixel line at the supported welcome sizes (68–96 px).
  const compact = className === 'stage-symbol'
  const size = compact ? 64 : 256
  return e('svg', { className, viewBox: `0 0 ${size} ${size}`, fill: 'none', 'aria-hidden': 'true' },
    e('defs', null,
      e('linearGradient', { id: sheenId, x1: '0', y1: String(size), x2: String(size), y2: '0', gradientUnits: 'userSpaceOnUse' },
        e('stop', { className: 'brand-outline-stop-1', offset: '0', stopColor: 'var(--sheen-1)' }),
        e('stop', { className: 'brand-outline-stop-2', offset: '.42', stopColor: 'var(--sheen-2)' }),
        e('stop', { className: 'brand-outline-stop-3', offset: '.72', stopColor: 'var(--sheen-3)' }),
        e('stop', { className: 'brand-outline-stop-4', offset: '1', stopColor: 'var(--sheen-4)' })),
      e('filter', { id: edgeId, filterUnits: 'userSpaceOnUse', x: '-6', y: '-6', width: String(size + 12), height: String(size + 12) },
        e('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: compact ? '1' : '.92', result: 'outer' }),
        compact ? null : e('feMorphology', { in: 'SourceAlpha', operator: 'erode', radius: '.92', result: 'inner' }),
        e('feComposite', { in: 'outer', in2: compact ? 'SourceAlpha' : 'inner', operator: 'out', result: 'outline' }),
        e('feFlood', { floodColor: '#fff', result: 'white' }),
        e('feComposite', { in: 'white', in2: 'outline', operator: 'in' })),
      e('mask', { id: outlineId, maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: String(size), height: String(size), 'mask-type': 'alpha' },
        e('image', { href: BROWSER_BRAND_RASTER_HREF, x: '0', y: '0', width: String(size), height: String(size), filter: `url(#${edgeId})` }))),
    e('rect', { width: String(size), height: String(size), fill: `url(#${sheenId})`, mask: `url(#${outlineId})` }))
}

function renderStageGhost(e: ReactLike['createElement']): unknown {
  return renderBrandOutline(e, 'stage-ghost', 'xsla-stage-icon')
}

function renderConversationGhost(e: ReactLike['createElement']): unknown {
  return renderBrandOutline(e, 'conversation-ghost', 'xsla-conversation-icon')
}

const TASK_STARTERS = [
  { id: 'organize', label: '整理一份资料', detail: '提炼重点与待确认项', glyph: 'command', draft: '请帮我整理下面的资料，提炼重点和需要确认的事项：\n' },
  { id: 'research', label: '研究一个问题', detail: '查找资料，比较不同观点', glyph: 'surface', draft: '请研究下面的问题，查找可靠来源，比较不同观点并说明依据：\n' },
  { id: 'code', label: '检查一段代码', detail: '定位问题，修改并验证', glyph: 'shield', draft: '请检查下面的代码，先定位问题，再给出修改并进行验证：\n' },
] as const

/** Starters stage text only. Existing text and attachments always belong to the user. */
export function taskStarterDraft(text: string, imageCount: number, id: string): string | undefined {
  return text.trim() !== '' || imageCount > 0 ? undefined : TASK_STARTERS.find(item => item.id === id)?.draft
}

/** Unknown/loading catalogs are not evidence that configuration is missing. */
export function emptyStageNeedsModelSetup(snapshot: Pick<ModelCatalogSnapshot, 'status' | 'routable' | 'sessionId' | 'current'>, readiness?: ProviderReadinessSnapshot): boolean {
  if (snapshot.status !== 'ready') return false
  if (snapshot.routable === false) return true
  if (snapshot.current === undefined || snapshot.sessionId === undefined || readiness?.sessionId !== snapshot.sessionId || readiness.status !== 'ready') return false
  const selected = snapshot.current
  return readiness.providers.flatMap(provider => provider.routes)
    .find(route => route.provider === selected.provider && route.model === selected.model)?.facts.available === false
}

export function renderEmptyStage(e: ReactLike['createElement'], options: { readonly drafting?: boolean; readonly needsModelSetup: boolean; readonly onModelSettings: () => void; readonly onStarter: (id: string) => void }): unknown {
  const drafting = options.drafting === true
  return e('div', { className: 'stage-empty' }, e('div', { className: 'stage-cluster' },
    renderBrandOutline(e, 'stage-symbol', 'xsla-welcome-icon'),
    e('div', { className: 'stage-starters', 'aria-label': '任务草稿', 'aria-hidden': drafting, 'data-drafting': drafting }, ...TASK_STARTERS.map(item => e('button', {
      type: 'button', key: item.id, 'data-task-starter': item.id, disabled: drafting, tabIndex: drafting ? -1 : 0,
      onClick: () => { if (!drafting) options.onStarter(item.id) },
    }, icon(e, item.glyph), e('b', null, item.label), e('small', null, item.detail)))),
    options.needsModelSetup ? e('div', { className: 'stage-setup', role: 'status' }, e('p', null, '当前模型尚不可用，请先检查模型与服务商设置。'), e('button', { type: 'button', onClick: options.onModelSettings }, '打开模型设置')) : null))
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
  readonly category?: 'files' | 'activity'
  readonly fileCount?: number; readonly activityCount?: number
  readonly onCategory?: (category: 'files' | 'activity') => void
  readonly fullscreen?: boolean; readonly onFullscreen?: () => void
  readonly split?: boolean; readonly splitAvailable?: boolean; readonly onSplit?: () => void
  readonly secondary?: WorkSurface; readonly onSecondary?: (id: string) => void
  readonly renderContent?: (surface: WorkSurface) => unknown
  readonly items: readonly WorkSurface[]
  readonly hiddenCount: number
  readonly onRestoreHidden: () => void
  readonly active?: WorkSurface
  readonly preference: WorkSurfaceDockPreference
  readonly reloadKey: number
  readonly onSelect: (surfaceId: string) => void
  readonly onClose: (surfaceId: string) => void
  readonly onTogglePin: (surfaceId: string) => void
  readonly onMode: (mode: WorkSurfaceDockMode) => void
  readonly onRefresh: () => void
  readonly onCopy: (surface: WorkSurface) => void
  readonly onExternal: (surface: WorkSurface) => void
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

/** Keep identifying context available without pushing long local paths into compact labels. */
export function workSurfaceTooltip(surface: { readonly title: string; readonly source?: string; readonly view?: WorkSurfaceView }): string {
  const parts = [surface.title]
  if (surface.source !== undefined) parts.push(surface.source)
  if (surface.view?.kind === 'text') {
    const first = surface.view.lines.at(0)?.number
    const last = surface.view.lines.at(-1)?.number
    if (first !== undefined && last !== undefined) parts.push(`第 ${first === last ? first : `${first}–${last}`} 行 · 共 ${surface.view.totalLines} 行`)
  } else if (surface.view?.kind === 'diff') {
    parts.push(...surface.view.diffs.map(diff => diff.path))
  }
  return [...new Set(parts)].join('\n')
}

function renderWorkSurfaceDock(e: ReactLike['createElement'], options: WorkSurfaceDockRenderOptions): unknown {
  if (!options.open) return null
  // Hiding is only a viewing preference. With the duplicate task list removed,
  // this explicit recovery action keeps every original record reachable.
  const restoreHidden = options.hiddenCount === 0 ? null : e('button', { type: 'button', 'data-restore-materials': '', onClick: options.onRestoreHidden }, `显示已隐藏的记录（${options.hiddenCount}）`)
  const categories = options.onCategory === undefined ? null : e('div', { className: 'material-categories', role: 'group', 'aria-label': '材料分类' },
    e('button', { type: 'button', 'aria-pressed': options.category === 'files', disabled: options.fileCount === 0, onClick: () => options.onCategory?.('files') }, `文件 · ${options.fileCount ?? 0}`),
    e('button', { type: 'button', 'aria-pressed': options.category === 'activity', onClick: () => options.onCategory?.('activity') }, `执行快照 · ${options.activityCount ?? 0}`))
  if (options.active === undefined) return e('div', { className: 'workbench-empty', role: 'status' }, categories, e('b', null, '暂无可查看的材料'), e('p', null, '工具运行后，文件、终端记录和预览会集中出现在这里。材料记录不等于已验证的任务结果。'), restoreHidden)
  const active = options.active
  const shellOrigin = typeof window === 'undefined' ? undefined : window.location.origin
  const interactiveAvailable = active.type === 'web' && active.capabilities.interactive && active.view.kind === 'web'
    && active.view.embed === 'loopback' && active.view.url !== undefined
    && canEmbedWorkSurfaceInShell(active.view.url, shellOrigin)
  const mode: WorkSurfaceDockMode = interactiveAvailable ? options.preference.mode : 'watch'
  const pinned = options.preference.pinnedIds.includes(active.id)
  return e('section', { id: 'xsla-work-surface-dock', className: 'surface-dock', 'aria-label': '工作材料', 'data-surface-mode': mode },
      categories,
      e('details', { className: 'surface-directory' },
        e('summary', null, e('span', null, active.title), e('small', null, `${options.items.length} 项 · 切换材料`)),
        e('nav', { className: 'surface-tabs', 'aria-label': '工作材料列表' },
        ...options.items.map(surface => e('div', { className: `surface-tab-wrap ${surface.id === active.id ? 'on' : ''}`, key: surface.id },
          e('button', { className: 'surface-tab', type: 'button', 'data-run-deliverable-id': surface.id, 'aria-pressed': surface.id === active.id, onClick: () => options.onSelect(surface.id), title: workSurfaceTooltip(surface) },
            e('span', { className: 'surface-tab-kind' }, workSurfaceKindLabel(surface.type)),
            e('span', { className: 'surface-tab-title' }, surface.title),
            options.preference.pinnedIds.includes(surface.id) ? e('i', { title: '已置顶', 'aria-label': '已置顶' }, '•') : null),
          e('button', { className: 'surface-tab-close', type: 'button', title: `隐藏记录，不删除文件：${surface.title}`, 'aria-label': `隐藏 ${surface.title}`, onClick: () => options.onClose(surface.id) }, '×'))))),
      e('div', { className: 'surface-toolbar' },
        !interactiveAvailable ? null : e('div', { className: 'surface-mode', role: 'group', 'aria-label': '材料预览交互方式' },
          e('button', { type: 'button', 'aria-pressed': mode === 'watch', onClick: () => options.onMode('watch') }, '观察'),
          e('button', { type: 'button', disabled: !interactiveAvailable, 'aria-pressed': mode === 'interact', title: interactiveAvailable ? '由你在内嵌本地页面中操作' : '该产物不支持直接交互', onClick: () => options.onMode('interact') }, '由你操作')),
        e('div', { className: 'surface-actions' },
          restoreHidden,
          e('button', { type: 'button', 'aria-pressed': pinned, onClick: () => options.onTogglePin(active.id), title: pinned ? '取消置顶' : '置顶标签' }, pinned ? '取消置顶' : '置顶'),
          e('button', { type: 'button', disabled: !active.capabilities.refresh && options.category !== 'files', onClick: options.onRefresh }, '刷新'),
          options.onFullscreen === undefined ? null : e('button', { type: 'button', 'aria-pressed': options.fullscreen === true, onClick: options.onFullscreen }, options.fullscreen ? '退出全屏' : '全屏阅读'),
          options.onSplit === undefined ? null : e('button', { type: 'button', disabled: !options.splitAvailable, 'aria-pressed': options.split === true, onClick: options.onSplit }, options.split ? '单栏' : '双栏对照'),
          e('button', { type: 'button', disabled: !active.capabilities.copySource, onClick: () => options.onCopy(active) }, '复制来源'),
          active.capabilities.externalOpen ? e('button', { type: 'button', onClick: () => options.onExternal(active) }, '另行打开') : null)),
      e('div', { className: 'surface-summary' },
        e('div', null, e('b', null, active.title), e('span', { 'data-status': active.status }, workSurfaceStatusLabel(active.status))),
        active.source === undefined ? null : e('details', { className: 'surface-source' }, e('summary', null, '来源路径'), e('code', null, active.source))),
      e('div', { className: `surface-reading-panes${options.split && options.secondary ? ' split' : ''}` },
        e('div', { className: 'surface-content', 'data-kind': active.type, 'aria-live': active.status === 'running' ? 'polite' : 'off' },
          options.renderContent?.(active) ?? renderWorkSurfaceContent(e, active, mode, options.reloadKey)),
        !options.split || options.secondary === undefined ? null : e('section', { className: 'surface-secondary', 'aria-label': '对照材料' },
          e('select', { value: options.secondary.id, 'aria-label': '选择对照文件', onChange: (event: { currentTarget: HTMLSelectElement }) => options.onSecondary?.(event.currentTarget.value) },
            ...options.items.filter(item => item.id !== active.id).map(item => e('option', { value: item.id, key: item.id }, item.title))),
          e('div', { className: 'surface-content' }, options.renderContent?.(options.secondary) ?? renderWorkSurfaceContent(e, options.secondary, 'watch', options.reloadKey)))))
}

interface ModelControlOptionView {
  readonly value: string
  readonly label: string
  readonly description: string
  readonly selected: boolean
  readonly disabled?: boolean
  readonly statusLabel?: string
  readonly statusDetail?: string
}

interface ModelSelectionNotice {
  readonly tone: 'neutral' | 'warning'
  readonly message: string
}

interface ModelControlView {
  readonly modelLabel: string
  readonly effortLabel: string
  readonly triggerLabel: string
  readonly currentProvider?: string
  readonly currentModel?: string
  readonly modelGroups: readonly {
    readonly id: string
    readonly label: string
    readonly models: readonly (ModelControlOptionView & {
      readonly provider: string
      readonly model: string
      readonly defaultEffort?: string
    })[]
  }[]
  readonly efforts: readonly ModelControlOptionView[]
}

/**
 * Keep session-scoped provider facts from leaking across rapid conversation
 * switches. Untagged legacy payloads are deliberately treated as unknown.
 */
export function providerReadinessForSession(snapshot: ProviderReadinessSnapshot, sessionId: string | undefined): ProviderReadinessSnapshot {
  if (sessionId !== undefined && snapshot.sessionId === sessionId) return snapshot
  if (sessionId === undefined) return { status: 'idle', providers: [] }
  if (snapshot.sessionId === undefined) {
    return { status: 'error', providers: [], error: '当前 Host 未标注服务商状态所属会话；已忽略这份状态。' }
  }
  return { sessionId, status: 'loading', providers: [], error: '正在读取当前会话的服务商状态。' }
}

/**
 * Never let a directory from one conversation drive controls for another.
 * Untagged legacy Hosts remain diagnosable through the recovery panel, but
 * their routes are not presented as selectable facts for the current session.
 */
export function modelCatalogForSession(snapshot: ModelCatalogSnapshot, sessionId: string | undefined): ModelCatalogSnapshot {
  if (sessionId === undefined) return { status: 'idle', routable: false, groups: [], failures: [] }
  if (snapshot.sessionId === sessionId) return snapshot
  if (snapshot.sessionId === undefined) {
    return {
      sessionId, status: 'error', routable: false, groups: [], failures: [],
      error: '当前 Host 未标注模型目录所属会话；已忽略这份目录。请前往 设置 → 模型与服务商 检查配置。',
    }
  }
  return {
    sessionId, status: 'loading', routable: false, groups: [], failures: [],
    error: '正在读取当前会话的模型目录。',
  }
}

/**
 * Project the combined control exclusively from Host-advertised model facts.
 * In particular, absence of an explicit effort is "default", not "off";
 * an off position only exists when the adapter actually advertises it.
 */
export function modelControlPresentation(snapshot: ModelCatalogSnapshot, readiness?: ProviderReadinessSnapshot): ModelControlView {
  const scopedReadiness = readiness === undefined ? undefined : providerReadinessForSession(readiness, snapshot.sessionId)
  const current = snapshot.current
  const group = current === undefined ? undefined : snapshot.groups.find(item => item.id === current.provider)
  const model = current === undefined ? undefined : group?.models.find(item => item.id === current.model)
  const modelLabel = model?.name ?? current?.model ?? (snapshot.status === 'loading' ? '正在读取模型' : '选择模型')
  const effortValue = current?.reasoningEffort ?? model?.defaultEffort
  const selectedEffort = model?.efforts.find(effort => effort.id === effortValue)
  const effortLabel = effortValue === undefined ? '默认' : reasoningEffortLabel(effortValue, selectedEffort?.name)
  return {
    modelLabel,
    effortLabel,
    triggerLabel: `${modelLabel} · ${effortLabel}`,
    ...(current === undefined ? {} : { currentProvider: current.provider, currentModel: current.model }),
    modelGroups: snapshot.groups.map(item => ({
      id: item.id,
      label: item.name,
      models: item.models.map(candidate => {
        const route = modelRouteReadiness(scopedReadiness, item.id, candidate.id)
        return {
          value: modelRouteKey(item.id, candidate.id),
          provider: item.id,
          model: candidate.id,
          label: candidate.name,
          description: candidate.description ?? `${item.name} 提供`,
          selected: current?.provider === item.id && current.model === candidate.id,
          disabled: route.disabled,
          statusLabel: route.label,
          statusDetail: route.detail,
          ...(candidate.defaultEffort === undefined ? {} : { defaultEffort: candidate.defaultEffort }),
        }
      }),
    })),
    efforts: (model?.efforts ?? []).map(effort => ({
      value: effort.id,
      label: reasoningEffortLabel(effort.id, effort.name),
      description: effort.description ?? reasoningEffortDescription(effort.id),
      selected: effort.id === effortValue,
    })),
  }
}

function modelRouteReadiness(readiness: ProviderReadinessSnapshot | undefined, provider: string, model: string): {
  readonly disabled: boolean
  readonly label: string
  readonly detail: string
} {
  const route = readiness?.providers.flatMap(item => item.routes).find(item => item.provider === provider && item.model === model)
  if (route === undefined) return { disabled: false, label: '状态未确认', detail: readiness?.error ?? '旧版 Host 或当前目录未提供这条路线的运行事实' }
  if (!route.facts.catalogued) return { disabled: true, label: '未收录', detail: providerReasonLabel(route.reasons[0]) }
  if (!route.facts.supported) return { disabled: true, label: '不受支持', detail: providerReasonLabel(route.reasons[0]) }
  if (!route.facts.configured) return { disabled: true, label: '未配置', detail: providerReasonLabel(route.reasons[0]) }
  if (!route.facts.available) return { disabled: true, label: '当前不可用', detail: providerReasonLabel(route.reasons[0]) }
  if (route.facts.verified) return { disabled: false, label: '已验证', detail: route.probe === undefined ? 'Host 已确认此路线可用' : probeSummary(route.probe) }
  return { disabled: false, label: '可用 · 未验证', detail: providerReasonLabel(route.reasons[0]) }
}

/** Translate the Host persistence receipt without exposing unbounded error text. */
export function modelSelectionPersistenceNotice(persistence: { readonly status: 'saved' | 'session-only'; readonly warning?: string } | undefined): ModelSelectionNotice | undefined {
  if (persistence?.status === 'saved') return undefined
  if (persistence === undefined) return { tone: 'neutral', message: '当前会话已切换；旧版 Host 未报告默认保存状态。' }
  const warning = boundedSingleLineText(persistence.warning, 180)
  return {
    tone: 'warning',
    message: `当前会话已切换，但默认选择未保存。${warning ?? '请稍后在设置中重新保存。'}`,
  }
}

function boundedSingleLineText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (normalized === '' || normalized.length > maxLength || /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) return undefined
  return normalized
}

/** Arrow-key movement for the model list and discrete reasoning rail. */
export function modelControlKeyboardIndex(key: string, current: number, count: number): number | undefined {
  if (count <= 0) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowRight' || key === 'ArrowDown') return (Math.max(0, current) + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (Math.max(0, current) - 1 + count) % count
  return undefined
}

function handleModelControlRadioKey(event: {
  readonly key: string
  readonly currentTarget: HTMLElement
  readonly target: EventTarget | null
  preventDefault(): void
  stopPropagation(): void
}): void {
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)'))
  const current = buttons.indexOf(event.target as HTMLButtonElement)
  const target = modelControlKeyboardIndex(event.key, current, buttons.length)
  if (target === undefined) return
  event.preventDefault()
  event.stopPropagation()
  buttons[target]?.focus()
  buttons[target]?.click()
}

export function renderModelControl(e: ReactLike['createElement'], options: {
  readonly snapshot: ModelCatalogSnapshot
  readonly providerReadiness?: ProviderReadinessSnapshot
  readonly disabled: boolean
  readonly running?: boolean
  readonly disabledReason?: string
  readonly open: boolean
  readonly selectionNotice?: ModelSelectionNotice
  readonly onToggle: () => void
  readonly onDismiss: () => void
  readonly onSelect: (selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }) => void
  readonly onOpenModelSettings?: () => void
}): unknown {
  const view = modelControlPresentation(options.snapshot, options.providerReadiness)
  const current = options.snapshot.current
  const advertisedModels = view.modelGroups.flatMap(group => group.models)
  const enabledModels = advertisedModels.filter(model => !model.disabled)
  const hasSelectedModel = enabledModels.some(model => model.selected)
  const firstModelValue = enabledModels[0]?.value
  const currentRouteDisabled = advertisedModels.some(model => model.selected && model.disabled)
  const availabilityId = options.disabledReason === undefined ? undefined : 'xsla-model-reasoning-availability'
  // A running-task lock remains focusable so keyboard and assistive-technology
  // users can discover why switching is unavailable. Hard prerequisites such
  // as a missing session still use native disabled semantics.
  const triggerDisabled = options.disabled && options.disabledReason === undefined
  const actionDisabled = options.disabled || options.snapshot.status === 'loading' || options.snapshot.status === 'selecting'
  const directoryMessages = [options.snapshot.error, options.providerReadiness?.error, ...options.snapshot.failures.map(failure => `${failure.name}：${failure.message}`)]
    .map(message => boundedSingleLineText(message, 240)).filter((message): message is string => message !== undefined)
  const showDirectoryState = options.snapshot.status === 'error' || advertisedModels.length === 0 || directoryMessages.length > 0
  const restoreTriggerFocus = (event?: { currentTarget?: HTMLElement }): void => {
    const trigger = event?.currentTarget?.closest<HTMLElement>('[data-choice-popover-root]')
      ?.querySelector<HTMLElement>('button[aria-haspopup="dialog"]')
    queueMicrotask(() => trigger?.focus())
  }
  return e('div', { className: 'model-controls choice-control', 'data-status': options.snapshot.status, 'data-choice-popover-root': '' },
    e('button', {
      className: 'model-reasoning-trigger', type: 'button', disabled: triggerDisabled,
      title: options.disabledReason ?? `模型与思考强度：${view.triggerLabel}`,
      'aria-label': `模型 ${view.modelLabel}，思考强度 ${view.effortLabel}`,
      'aria-disabled': options.disabled,
      'aria-describedby': availabilityId,
      'aria-haspopup': 'dialog', 'aria-expanded': options.open, 'aria-controls': options.open ? 'xsla-model-reasoning-popover' : undefined,
      onClick: options.onToggle,
    }, icon(e, 'brain'),
    e('span', { className: 'model-reasoning-label' }, e('b', null, view.modelLabel), e('small', null, view.effortLabel)),
    e('span', { className: 'model-chevron', 'aria-hidden': 'true' }, '⌃')),
    availabilityId === undefined ? null : e('span', { id: availabilityId, className: 'visually-hidden' }, options.disabledReason),
    options.open ? e('section', {
      id: 'xsla-model-reasoning-popover', className: 'model-reasoning-popover', role: 'dialog',
      'aria-modal': 'false', 'aria-label': '选择模型与思考强度', 'data-placement': 'top',
      onKeyDown: (event: { key: string; currentTarget: HTMLElement; preventDefault(): void; stopPropagation(): void }) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        options.onDismiss()
        restoreTriggerFocus(event)
      },
    },
    e('header', { className: 'model-reasoning-head' },
      e('div', null, e('b', null, '模型与思考'), e('small', null, options.running ? '强度从下一次请求生效；当前请求保持不变' : '选择模型与思考强度')),
      e('button', { type: 'button', className: 'model-reasoning-close', 'aria-label': '关闭模型选择器', onClick: (event?: { currentTarget?: HTMLElement }) => { options.onDismiss(); restoreTriggerFocus(event) } }, '×')),
    options.disabledReason === undefined ? null : e('div', {
      className: 'model-control-lock-note', role: 'status', 'aria-live': 'polite',
    }, options.disabledReason),
    options.selectionNotice === undefined ? null : e('div', {
      className: 'model-selection-notice', role: 'status', 'aria-live': 'polite', 'data-tone': options.selectionNotice.tone,
    }, options.selectionNotice.message),
    showDirectoryState ? e('div', {
      className: 'model-directory-state', role: options.snapshot.status === 'error' ? 'alert' : 'status',
    },
    e('b', null, options.snapshot.status === 'loading' ? '正在读取模型目录' : advertisedModels.length === 0 ? '暂时没有可选模型' : '部分模型目录不可用'),
    ...directoryMessages.map((message, index) => e('p', { key: `${index}:${message}` }, message)),
    e('small', null, '请检查 设置 → 模型与服务商'),
    options.onOpenModelSettings === undefined ? null : e('button', {
      type: 'button', 'data-action': 'open-model-settings', autoFocus: advertisedModels.length === 0,
      onClick: options.onOpenModelSettings,
    }, '打开设置')) : null,
    e('div', { className: 'model-choice-scroll', role: 'radiogroup', 'aria-label': '选择模型', onKeyDown: handleModelControlRadioKey },
      ...view.modelGroups.map(group => e('section', { className: 'model-choice-group', key: group.id, 'aria-label': group.label },
        e('div', { className: 'model-choice-provider' }, group.label),
        ...group.models.map(model => e('button', {
          className: `model-choice-option${model.selected ? ' selected' : ''}`,
          type: 'button', role: 'radio', key: model.value, disabled: actionDisabled || options.running === true || model.disabled,
          'aria-checked': model.selected, 'data-model-route': model.value,
          tabIndex: !model.disabled && (model.selected || (!hasSelectedModel && model.value === firstModelValue)) ? 0 : -1,
          autoFocus: !model.disabled && (model.selected || (!hasSelectedModel && model.value === firstModelValue)),
          onClick: () => {
            if (actionDisabled || options.running === true || model.disabled) return
            options.onSelect({
              provider: model.provider,
              model: model.model,
              ...(model.selected && current?.reasoningEffort !== undefined
                ? { reasoningEffort: current.reasoningEffort }
                : model.defaultEffort === undefined ? {} : { reasoningEffort: model.defaultEffort }),
            })
          },
        },
        e('span', { className: 'model-choice-mark', 'aria-hidden': 'true' }, model.selected ? '✓' : ''),
        e('span', { className: 'model-choice-copy' },
          e('span', { className: 'model-choice-title' }, e('b', null, model.label), e('em', { 'data-route-state': model.disabled ? 'blocked' : 'available', title: model.statusDetail }, model.statusLabel)),
          e('small', null, model.description))))))),
    e('section', { className: 'effort-rail-section', 'aria-labelledby': 'xsla-effort-rail-title' },
      e('div', { className: 'effort-rail-head' },
        e('div', null, e('b', { id: 'xsla-effort-rail-title' }, '思考强度'), e('small', null, view.efforts.find(item => item.selected)?.description ?? (view.efforts.length === 0 ? '当前模型不提供可调档位' : '选择当前任务需要的推理深度'))),
        e('strong', null, view.effortLabel)),
      view.efforts.length === 0 || current === undefined
        ? e('p', { className: 'effort-rail-empty' }, current === undefined ? '先选择一个模型' : '此模型使用自身默认策略')
        : e('div', { className: 'effort-rail', role: 'radiogroup', 'aria-label': '选择思考强度', onKeyDown: handleModelControlRadioKey },
          e('span', { className: 'effort-rail-line', 'aria-hidden': 'true' }),
          ...view.efforts.map((effort, index) => e('button', {
            className: `effort-rail-option${effort.selected ? ' selected' : ''}`,
            type: 'button', role: 'radio', key: effort.value, disabled: actionDisabled || currentRouteDisabled,
            title: effort.description, 'aria-label': `${effort.label}：${effort.description}`,
            'aria-checked': effort.selected, 'data-effort': effort.value,
            tabIndex: effort.selected || (!view.efforts.some(item => item.selected) && index === 0) ? 0 : -1,
            onClick: () => {
              if (actionDisabled || currentRouteDisabled) return
              options.onSelect({ provider: current.provider, model: current.model, reasoningEffort: effort.value })
            },
          }, e('span', { className: 'effort-rail-dot', 'aria-hidden': 'true' }), e('span', null, effort.label)))))) : null)
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

export interface NetworkCapabilityView {
  readonly state: 'available' | 'unavailable' | 'unconfirmed'
  readonly label: string
  readonly detail: string
}

/**
 * Derive network availability only from the current product facts and Host
 * inventory. Absence of a trustworthy inventory is unknown, not permission.
 */
export function networkCapabilityPresentation(input: {
  readonly desktop?: Readonly<Record<string, unknown>> | undefined
  readonly plugins?: readonly Pick<HostPluginFact, 'entryId' | 'moduleName' | 'enabled' | 'fiberPhase'>[] | undefined
}): NetworkCapabilityView {
  const preset = firstBoundedRuntimeText(input.desktop?.preset, input.desktop?.agent_preset, input.desktop?.agentPreset) ?? '未确认'
  if (input.plugins === undefined) {
    return {
      state: 'unconfirmed',
      label: '未确认',
      detail: `当前预设：${preset} · 来源：尚未读到可信运行组件事实 · 网络能力独立于文件权限`,
    }
  }
  const module = (name: string): Pick<HostPluginFact, 'entryId' | 'moduleName' | 'enabled' | 'fiberPhase'> | undefined => input.plugins?.find(plugin => plugin.moduleName.trim().toLocaleLowerCase() === name)
  const tool = module('@deepseek-ai/dsh-tool-web')
  const fetchProvider = module('@deepseek-ai/dsh-web-fetch-http')
  const ready = (plugin: typeof tool): boolean => plugin?.enabled === true && plugin.fiberPhase === 'active'
  if (ready(tool) && ready(fetchProvider)) {
    return {
      state: 'available',
      label: '已确认可用',
      detail: `当前预设：${preset} · 来源：Host 运行组件（tool-web + web-fetch-http） · 范围：匿名读取公开 HTTP(S) 正文，不携带浏览器 Cookie；搜索需要另行配置提供端 · 不等同于文件权限`,
    }
  }
  const state = (plugin: typeof tool): string => plugin === undefined
    ? '缺失'
    : plugin.enabled !== true ? '已禁用' : plugin.fiberPhase === 'active' ? '可用' : plugin.fiberPhase ?? '未启动'
  return {
    state: 'unavailable',
    label: '当前不可用',
    detail: `当前预设：${preset} · 来源：Host 运行组件 · tool-web ${state(tool)}，web-fetch-http ${state(fetchProvider)} · 网络能力独立于文件权限`,
  }
}

function firstBoundedRuntimeText(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 100)?.trim()
}

function reasoningEffortDescription(value: string): string {
  if (value === 'off') return '关闭额外推理，直接生成回答'
  if (value === 'low') return '更快的简短思考'
  if (value === 'medium') return '平衡分析深度与响应速度'
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
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex]:not([tabindex="-1"])',
  )).filter(element => element.closest('[hidden], [inert], [aria-hidden="true"]') === null && element.getClientRects().length > 0)
  // Hidden tab panels remain mounted to preserve drafts, but cannot receive focus.
  const preferred = focusable().find(element => element.matches('input, textarea, select, [autofocus]'))
  if (!dialog.contains(ownerDocument.activeElement)) (preferred ?? focusable()[0] ?? dialog).focus()

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return
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
  // Bubble after a picker/child dialog has had the chance to own Escape.
  ownerDocument.addEventListener('keydown', onKeyDown)

  return () => {
    ownerDocument.removeEventListener('keydown', onKeyDown)
    if (background !== undefined && backgroundState !== undefined) {
      if (backgroundState.inert) background.setAttribute('inert', '')
      else background.removeAttribute('inert')
      if (backgroundState.ariaHidden === null) background.removeAttribute('aria-hidden')
      else background.setAttribute('aria-hidden', backgroundState.ariaHidden)
    }
    if (previouslyFocused?.isConnected === true) previouslyFocused.focus()
  }
}

/** Trap a mobile inspector like a dialog while leaving the inspector itself operable. */
function mountInspectorOverlayAccessibility(
  ownerDocument: Document,
  inspector: HTMLElement,
  backgrounds: readonly HTMLElement[],
  onClose: () => void,
): () => void {
  const previous = backgrounds.map(element => ({
    element,
    inert: element.hasAttribute('inert'),
    ariaHidden: element.getAttribute('aria-hidden'),
  }))
  for (const { element } of previous) {
    element.setAttribute('inert', '')
    element.setAttribute('aria-hidden', 'true')
  }
  const unmountDialog = mountNativeDialogAccessibility(ownerDocument, inspector, undefined, onClose)
  return () => {
    for (const state of previous) {
      if (state.inert) state.element.setAttribute('inert', '')
      else state.element.removeAttribute('inert')
      if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden')
      else state.element.setAttribute('aria-hidden', state.ariaHidden)
    }
    // Restore the background before returning focus to its trigger.
    unmountDialog()
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
  readonly workflow: PluginWorkflow; readonly busy: boolean; readonly plugins: readonly HostPluginFact[]
  readonly transactions: readonly PublicPluginTransaction[]
  readonly onSubmit: (event: { preventDefault(): void; currentTarget: HTMLFormElement }) => Promise<void>
  readonly onPrepare: (intent: PluginUiIntent, candidate?: PublicCandidate) => Promise<void>; readonly onConfirm: () => Promise<void>
  readonly onReset: () => void; readonly onClose: () => void
}): unknown {
  const workflow = options.workflow
  const showForm = workflow.step === 'idle' || workflow.step === 'error'
  const inventory = pluginInventoryPresentation(options.plugins)
  const history = pluginTransactionHistoryPresentation(options.transactions)
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
    workflow.step === 'completed' && workflow.transaction !== undefined ? e('div', { className: 'candidate-facts' }, e('b', null, `${workflow.transaction.packageName}@${workflow.transaction.version}`), e('span', null, `${pluginActionLabel(workflow.transaction.action)} · ${pluginTransactionStateLabel(workflow.transaction.state)}`), e('span', null, `${workflow.transaction.consent.confirmed ? '已确认' : '未确认'} · 系统沙箱未启用`), ...pluginTransactionFactLines(workflow.transaction).map((fact, index) => e('span', { key: `transaction-fact:${index}` }, fact))) : null,
    e('details', { className: 'plugin-inventory', open: true },
      e('summary', null, inventory.length === 0 ? '运行组件仍在读取' : `运行组件 ${inventory.length} 类 · ${options.plugins.length} 个实例`),
      inventory.length === 0 ? e('p', { className: 'plugin-inventory-empty' }, '清单为空或仍在读取。') : e('div', { className: 'plugin-inventory-groups' },
        ...inventory.map(group => e('details', { className: 'plugin-inventory-group', key: group.key },
          e('summary', { className: 'plugin-inventory-group-head' }, e('b', null, group.name), e('span', null, group.active === group.instances ? `${group.instances} 个可用` : `${group.active}/${group.instances} 可用`)),
          e('p', null, group.description),
          ...group.duplicates.map(duplicate => e('p', { className: 'plugin-inventory-duplicate', key: duplicate.moduleName }, `同名组件 ${duplicate.moduleName}：${duplicate.entries.map(entry => `${entry.entryId}（${entry.fiberPhase ?? '未知'}）`).join('、')}`)))))),
    e('details', { className: 'plugin-history' },
      e('summary', null, `事务记录 ${options.transactions.length} 笔${options.transactions.length > history.length ? `（最近 ${history.length} 笔）` : ''}`),
      history.length === 0
        ? e('p', { className: 'plugin-inventory-empty' }, '暂无受控变更记录。')
        : e('div', { className: 'plugin-history-list' }, ...history.map((row, index) => e('article', { className: 'candidate-facts', key: `${row.id}:${index}`, 'data-transaction-id': row.id },
          e('b', null, row.heading),
          ...row.facts.map((fact, factIndex) => e('span', { key: `${row.id}:fact:${factIndex}` }, fact)))))),
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

function icon(e: ReactLike['createElement'], name: 'brain' | 'shield' | 'stop' | 'moon' | 'sun' | 'image' | 'command' | 'send' | 'down' | 'right' | 'surface'): unknown {
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
    right: ['m9 6 6 6-6 6'],
  }
  return e('svg', { className: 'ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, ...paths[name]!.map((path, index) => e('path', { d: path, key: `${name}:${index}` })))
}

export function memoryPresentation(
  value: MemoryLifecycleSnapshot,
  context?: { readonly currentProject?: string },
): { readonly value: string; readonly detail: string } {
  const memory = value.memory
  if (value.status === 'error') return { value: '读取失败', detail: '请检查 Memory 服务状态' }
  if (context !== undefined && memory?.project !== undefined
    && (context.currentProject === undefined || !memoryProjectKeysEqual(memory.project, context.currentProject))) {
    return { value: '正在读取', detail: '正在切换项目记忆' }
  }
  if (value.status === 'loading') return { value: '正在读取', detail: '由独立 Memory 插件提供' }
  if ((value.status !== 'ready' && value.status !== 'degraded') || memory === undefined) return { value: '尚未读取', detail: '由独立 Memory 插件提供' }
  const active = memory.entries?.filter(entry => entry.state === 'active')
  const activeCount = active?.length ?? memory.counts.active
  const globalCount = active?.filter(entry => entry.scope === 'global').length ?? memory.counts.global
  const projectCount = active?.filter(entry => entry.scope === 'project').length ?? memory.counts.project
  const facts = `revision ${memory.revision}\n全局 ${globalCount} · 项目 ${projectCount} · 已忘记 ${memory.counts.forgotten}`
  return value.status === 'degraded'
    ? { value: `${activeCount} 条可用 · 需注意`, detail: `持久化降级 · 最近写入尚未确认\n${facts}` }
    : { value: `${activeCount} 条可用`, detail: facts }
}

export function heartbeatPresentation(value: unknown): { readonly status: string; readonly detail: string; readonly running: boolean; readonly tone?: 'ok' | 'warn' } {
  const input = record(value)
  if (input?.schemaVersion !== 2 || typeof input.status !== 'string' || typeof input.running !== 'boolean' || !Array.isArray(input.checks)) return { status: '不可用', detail: '后台状态尚未连接', running: false }
  const checks = input.checks.flatMap((item): HeartbeatPublicCheck[] => {
    const check = record(item)
    if (typeof check?.id !== 'string' || typeof check.status !== 'string' || typeof check.intervalMs !== 'number' || typeof check.failureCount !== 'number') return []
    return [{ id: check.id, status: check.status, intervalMs: check.intervalMs, failureCount: check.failureCount, ...(typeof check.nextRunAt === 'number' ? { nextRunAt: check.nextRunAt } : {}) }]
  })
  const persistenceDegraded = input.persistenceStatus === 'degraded'
  const tone = persistenceDegraded
    ? 'warn'
    : input.status === 'healthy'
    ? 'ok'
    : ['lost', 'delayed', 'backoff'].includes(input.status) ? 'warn' : undefined
  const stateLabel = runtimeFactLabel(input.status)
  const checksDetail = checks.length === 0
    ? '没有后台检查在运行'
    : checks.map(check => `${friendlyCheckName(check.id)} · ${runtimeFactLabel(check.status)} · 失败 ${check.failureCount}${check.nextRunAt === undefined ? '' : ` · 下次 ${formatClockTime(check.nextRunAt)}`}`).join('\n')
  return {
    status: persistenceDegraded ? '持久化降级' : stateLabel,
    running: input.running,
    detail: persistenceDegraded ? `持久化降级 · 最近状态可能未可靠保存\n${checksDetail}` : checksDetail,
    ...(tone === undefined ? {} : { tone }),
  }
}

/** Combine transport health with the retained heartbeat value shown by the shell. */
export function runtimeConnectionPresentation(value: ProductHealthSnapshot, previousUnavailable = false): { readonly unavailable: boolean; readonly label: string } {
  // A loading snapshot retains old health values; only a settled read may restore controls.
  const unavailable = value.status === 'loading' ? previousUnavailable : value.status === 'error'
  return { unavailable, label: unavailable ? '连接中断，任务状态待确认' : '' }
}

/** Combine transport health with the retained heartbeat value shown by the shell. */
export function heartbeatHealthPresentation(value: ProductHealthSnapshot): ReturnType<typeof heartbeatPresentation> {
  const heartbeat = 'value' in value ? value.value?.heartbeat : undefined
  const sourceError = heartbeatReadError(value)
  if (sourceError === undefined) return heartbeatPresentation(heartbeat)
  const retained = heartbeatPresentation(heartbeat)
  const retainedDetail = retained.status === '不可用'
    ? ''
    : `\n上次状态：${retained.status}\n${retained.detail}`
  return {
    status: '读取降级',
    detail: `后台状态读取失败：${sourceError}${retainedDetail}`,
    running: false,
    tone: 'warn',
  }
}

function heartbeatReadError(snapshot: ProductHealthSnapshot): string | undefined {
  if (!('errors' in snapshot)) return undefined
  const error = snapshot.errors.find(item => item.source === 'heartbeat'
    && item.kind !== 'HEARTBEAT_CHECK_DEGRADED'
    && item.kind !== 'HEARTBEAT_PERSISTENCE_DEGRADED')
  return error === undefined ? undefined : formatHealthSourceError(error)
}

function healthSourceError(snapshot: ProductHealthSnapshot, source: ProductHealthSourceError['source']): string | undefined {
  if (!('errors' in snapshot)) return undefined
  const error = snapshot.errors.find(item => item.source === source)
  return error === undefined ? undefined : formatHealthSourceError(error)
}

function formatHealthSourceError(error: ProductHealthSourceError): string {
  const facts = [error.kind, error.status === undefined ? undefined : `HTTP ${error.status}`].filter((value): value is string => value !== undefined)
  return `${error.message}${facts.length === 0 ? '' : `（${facts.join(' · ')}）`}`
}

export function pluginTransactionPresentation(value: PluginGovernanceSnapshot): { readonly total: number; readonly detail: string } {
  const counts = new Map<string, number>()
  for (const transaction of value.transactions) counts.set(transaction.state, (counts.get(transaction.state) ?? 0) + 1)
  return { total: value.transactions.length, detail: value.status === 'error' ? `事务读取失败${value.error === undefined ? '' : `：${value.error}`}` : counts.size === 0 ? value.status === 'loading' ? '正在读取事务' : '暂无受控变更记录' : [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([state, count]) => `${pluginTransactionStateLabel(state)} ${count}`).join(' · ') }
}

/** Surface transaction evidence rather than reducing degraded outcomes to one state label. */
export function pluginTransactionFactLines(value: Pick<PublicPluginTransaction, 'health' | 'rollback' | 'events'>): readonly string[] {
  const facts: string[] = []
  if (value.health !== undefined && value.health.length > 0) {
    facts.push(`健康门禁：${value.health.map(gate => `${gate.gate} ${gate.ok ? '通过' : '失败'}${gate.detail === '' ? '' : `（${gate.detail}）`}`).join('；')}`)
  }
  if (value.rollback !== undefined) {
    const rollback = value.rollback
    const rollbackFacts = [
      `回滚：${rollback.attempted ? rollback.succeeded ? '成功' : '失败' : '未尝试'}`,
      rollback.operation === undefined ? undefined : `操作 ${rollback.operation}`,
      rollback.restoredSpec === undefined ? undefined : `恢复 ${rollback.restoredSpec}`,
      rollback.health === undefined || rollback.health.length === 0
        ? undefined
        : `验证 ${rollback.health.map(gate => `${gate.gate} ${gate.ok ? '通过' : '失败'}${gate.detail === '' ? '' : `（${gate.detail}）`}`).join('、')}`,
      rollback.residuals.length === 0 ? undefined : `残留 ${rollback.residuals.join('、')}`,
    ].filter((fact): fact is string => fact !== undefined)
    facts.push(rollbackFacts.join('；'))
  }
  const latestEvent = value.events === undefined || value.events.length === 0 ? undefined : value.events[value.events.length - 1]
  if (latestEvent !== undefined) facts.push(`最近事件：${latestEvent.kind} · ${latestEvent.message}`)
  return facts
}

export interface PluginTransactionHistoryRow {
  readonly id: string
  readonly heading: string
  readonly facts: readonly string[]
}

/** Keep recent lifecycle receipts individually addressable without an unbounded modal. */
export function pluginTransactionHistoryPresentation(
  transactions: readonly Pick<PublicPluginTransaction, 'id' | 'action' | 'packageName' | 'version' | 'state' | 'health' | 'rollback' | 'events'>[],
  limit = 20,
): readonly PluginTransactionHistoryRow[] {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20
  return Object.freeze(transactions.slice(0, boundedLimit).map(transaction => Object.freeze({
    id: transaction.id,
    heading: `${transaction.packageName}@${transaction.version} · 事务 ${transaction.id}`,
    facts: Object.freeze([
      `${pluginActionLabel(transaction.action)} · ${pluginTransactionStateLabel(transaction.state)}`,
      ...pluginTransactionFactLines(transaction),
    ]),
  })))
}

export interface PluginInventoryGroup {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly instances: number
  readonly active: number
  readonly duplicates: readonly {
    readonly moduleName: string
    readonly entries: readonly { readonly entryId: string; readonly fiberPhase: string | null }[]
  }[]
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
  entries: readonly Pick<HostPluginFact, 'entryId' | 'moduleName' | 'fiberPhase'>[],
): readonly PluginInventoryGroup[] {
  const groups = new Map<string, PluginInventoryGroup>()
  const seen = new Set<string>()
  const moduleEntries = new Map<string, Map<string, { moduleName: string; entries: { entryId: string; fiberPhase: string | null }[] }>>()
  for (const entry of entries) {
    const normalized = entry.moduleName.trim().toLocaleLowerCase()
    const entryId = entry.entryId.trim()
    if (normalized === '' || entryId === '' || seen.has(entryId)) continue
    seen.add(entryId)
    const matched = HOST_MODULE_GROUPS.find(group => group.matches.some(fragment => normalized.includes(fragment)))
      ?? { key: 'runtime', name: '基础运行组件', description: '连接、同步与兼容层', matches: [] }
    const current = groups.get(matched.key)
    const active = entry.fiberPhase === 'active' ? 1 : 0
    groups.set(matched.key, {
      key: matched.key, name: matched.name, description: matched.description,
      instances: (current?.instances ?? 0) + 1,
      active: (current?.active ?? 0) + active,
      duplicates: current?.duplicates ?? [],
    })
    const groupedModules = moduleEntries.get(matched.key) ?? new Map()
    const module = groupedModules.get(normalized) ?? { moduleName: entry.moduleName.trim(), entries: [] }
    module.entries.push({ entryId, fiberPhase: entry.fiberPhase })
    groupedModules.set(normalized, module)
    moduleEntries.set(matched.key, groupedModules)
  }
  const order = [...HOST_MODULE_GROUPS.map(group => group.key), 'runtime']
  return [...groups.values()].map(group => Object.freeze({
    ...group,
    duplicates: Object.freeze([...moduleEntries.get(group.key)?.values() ?? []]
      .filter(module => module.entries.length > 1)
      .map(module => Object.freeze({ moduleName: module.moduleName, entries: Object.freeze(module.entries.map(entry => Object.freeze({ ...entry }))) }))),
  })).sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key))
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

export interface RunCenterJobGroup {
  readonly label: string
  readonly status: string
  readonly count: number
  readonly detail?: string
}

export interface RunCenterWorkbenchPresentation {
  readonly activeJobs: readonly RunCenterSnapshot['jobs'][number][]
  readonly activeTodos: readonly RunCenterSnapshot['todos'][number][]
  readonly activeSubagents: readonly Extract<RunCenterSnapshot['subagents'][number], { readonly kind: 'child' }>[]
  readonly attentionGroups: readonly RunCenterJobGroup[]
  readonly recentGroups: readonly RunCenterJobGroup[]
  readonly taskGraph?: TaskGraphPresentation
  readonly counts: {
    readonly active: number
    readonly pending: number
    readonly deliverables: number
    readonly history: number
    readonly historyGroups: number
    readonly attentionGroups: number
  }
}

export interface TaskGraphNodePresentation {
  readonly id: string
  readonly title: string
  readonly displayStatus: TaskGraphNodeStatus | 'ready' | 'waiting'
  readonly statusLabel: string
  readonly dependencies: readonly string[]
  readonly acceptance: readonly string[]
  readonly attemptLabel?: string
  readonly latestFeedback?: string
  readonly evidenceLabels: readonly string[]
}

export interface TaskGraphPresentation {
  readonly id: string
  readonly objective: string
  readonly stale: boolean
  readonly status: TaskGraphView['status']
  readonly statusLabel: string
  readonly summary: string
  readonly current?: string
  readonly currentFeedback?: string
  readonly latestFeedback?: string
  readonly notices: readonly string[]
  readonly nodes: readonly TaskGraphNodePresentation[]
}

const COMPLETED_TODO_STATES = new Set(['done', 'completed', 'complete', 'verified', 'cancelled', 'canceled'])
export const RUN_CENTER_VISIBLE_ITEM_LIMIT = 20
export const RUN_CENTER_HISTORY_GROUP_LIMIT = 12

function taskGraphNeedsAttention(graph: TaskGraphView | undefined): boolean {
  return graph !== undefined && (graph.durability === 'pending' || graph.stale || graph.recoveryRequired
    || graph.nodes.some(node => node.status === 'blocked' || node.status === 'interrupted'))
}

/** Compact, evidence-honest projection for the existing narrow task rail. */
export function taskGraphPresentation(graph: TaskGraphView): TaskGraphPresentation {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const completed = new Set(graph.nodes.filter(node => node.status === 'completed').map(node => node.id))
  const gated = graph.status === 'waiting' || graph.durability === 'pending' || graph.stale || graph.recoveryRequired
  const nodes = graph.nodes.map(node => {
    const ready = node.status === 'pending' && !gated && node.dependencies.every(id => completed.has(id))
    const displayStatus: TaskGraphNodePresentation['displayStatus'] = node.status === 'pending' ? (ready ? 'ready' : 'waiting') : node.status
    const labels: Record<TaskGraphNodePresentation['displayStatus'], string> = {
      ready: '可开始', waiting: '等待依赖', pending: '等待依赖', running: '进行中', verifying: '待验收', completed: '已完成', blocked: '已阻塞', interrupted: '已中断 · 待检查',
    }
    const retainedLabels: Partial<Record<TaskGraphNodeStatus, string>> = { running: '上次记录：进行中', verifying: '上次记录：待验收', completed: '节点记录：已完成' }
    const statusLabel = graph.status === 'waiting' && retainedLabels[node.status] !== undefined
      ? retainedLabels[node.status]!
      : displayStatus === 'waiting' && node.dependencies.every(id => completed.has(id)) ? '等待中' : labels[displayStatus]
    const latestFeedback = node.feedback.at(-1)?.text
    const evidenceLabels = node.evidence.map(item => item.kind === 'execution'
      ? `执行记录 · ${item.toolName}`
      : `验收评估 · ${node.acceptance.find(criterion => criterion.id === item.acceptanceId)?.text ?? item.acceptanceId ?? '未标注验收项'}${item.assertion === undefined ? '' : ` · ${item.assertion}`}${item.sourceExcerpt === undefined ? '' : ` · 来源：${item.sourceExcerpt}`}`)
    return Object.freeze({
      id: node.id,
      title: node.title,
      displayStatus,
      statusLabel,
      dependencies: Object.freeze(node.dependencies.map(id => byId.get(id)?.title ?? id)),
      acceptance: Object.freeze(node.acceptance.map(item => item.text)),
      ...(node.attempt < 1 ? {} : { attemptLabel: `第 ${node.attempt} 次尝试` }),
      ...(latestFeedback === undefined ? {} : { latestFeedback }),
      evidenceLabels: Object.freeze(evidenceLabels),
    })
  })
  const notices = [
    ...(graph.status === 'waiting' ? ['任务状态等待检查；节点状态为最近记录。'] : []),
    ...(graph.durability === 'pending' ? ['任务图变更尚未持久化。'] : []),
    ...(graph.stale ? ['任务定义已过期，等待刷新。'] : []),
    ...(graph.recoveryRequired ? ['运行实例已变化，需要恢复检查。'] : []),
  ]
  const current = graph.status === 'waiting' ? undefined : (nodes.find(node => ['running', 'verifying', 'blocked', 'interrupted'].includes(node.displayStatus))
    ?? nodes.find(node => node.displayStatus === 'ready'))
  return Object.freeze({
    id: graph.id,
    objective: graph.objective,
    stale: graph.stale,
    status: graph.status,
    statusLabel: ({ ready: '可开始', active: '进行中', waiting: '等待检查', completed: '已完成' } as const)[graph.status],
    summary: graph.status === 'waiting'
      ? `节点记录：${graph.nodes.filter(node => node.status === 'completed').length} / ${graph.nodes.length} 已完成`
      : `${graph.nodes.filter(node => node.status === 'completed').length} / ${graph.nodes.length} 个节点完成`,
    ...(current === undefined ? {} : { current: current.title }),
    ...(current?.latestFeedback === undefined || !['blocked', 'interrupted'].includes(current.displayStatus) ? {} : { currentFeedback: current.latestFeedback }),
    ...(graph.feedback.at(-1) === undefined ? {} : { latestFeedback: graph.feedback.at(-1)!.text }),
    notices: Object.freeze(notices),
    nodes: Object.freeze(nodes),
  })
}

/**
 * Turn an append-only run ledger into a compact task view. Maintenance jobs
 * stay available as grouped evidence, while live work and failures retain
 * their individual meaning.
 */
export function runCenterWorkbenchPresentation(run: RunCenterSnapshot): RunCenterWorkbenchPresentation {
  const activeJobsAll = orderRunCenterJobs(run.jobs)
    .map(({ job }) => job)
    .filter(job => job.status === 'running' || job.status === 'stopping')
    .map(presentRunCenterJob)
  // Retained stale Graphs are historical references, not the new task's plan.
  const activeTodosAll = run.taskGraph?.stale !== false ? run.todos.filter(todo => !COMPLETED_TODO_STATES.has(todo.status.trim().toLocaleLowerCase())) : []
  const activeSubagentsAll = run.subagents.filter((child): child is Extract<RunCenterSnapshot['subagents'][number], { readonly kind: 'child' }> => child.kind === 'child' && child.activity === 'running')
  const activeJobs = Object.freeze(activeJobsAll.slice(0, RUN_CENTER_VISIBLE_ITEM_LIMIT))
  const activeTodos = Object.freeze(activeTodosAll.slice(0, RUN_CENTER_VISIBLE_ITEM_LIMIT))
  const activeSubagents = Object.freeze(activeSubagentsAll.slice(0, RUN_CENTER_VISIBLE_ITEM_LIMIT))
  const unresolvedFailureIds = new Set<string>()
  const byOperation = new Map<string, RunCenterSnapshot['jobs'][number][]>()
  for (const { job } of orderRunCenterJobs(run.jobs)) {
    const identity = runCenterJobIdentity(job)
    const rows = byOperation.get(identity) ?? []
    rows.push(job)
    byOperation.set(identity, rows)
  }
  for (const rows of byOperation.values()) {
    for (const job of rows) {
      // A retry that is only running has not repaired a recorded failure yet.
      // Only a later success for this exact operation clears older failures.
      if (job.status === 'completed') break
      if (job.status === 'failed') unresolvedFailureIds.add(job.id)
    }
  }
  const failedJobs = run.jobs.filter(job => unresolvedFailureIds.has(job.id))
  const historicalJobs = run.jobs.filter(job => (job.status === 'completed' || job.status === 'killed' || job.status === 'failed') && !unresolvedFailureIds.has(job.id))
  const attentionGroups = groupRunCenterJobs(failedJobs)
  const recentGroups = groupRunCenterJobs(historicalJobs)
  return Object.freeze({
    activeJobs,
    activeTodos,
    activeSubagents,
    attentionGroups: Object.freeze(attentionGroups.slice(0, RUN_CENTER_VISIBLE_ITEM_LIMIT)),
    recentGroups: Object.freeze(recentGroups.slice(0, RUN_CENTER_HISTORY_GROUP_LIMIT)),
    ...(run.taskGraph === undefined ? {} : { taskGraph: taskGraphPresentation(run.taskGraph) }),
    counts: Object.freeze({
      active: activeJobsAll.length + activeTodosAll.length + activeSubagentsAll.length,
      pending: run.queue.length,
      deliverables: run.deliverables.length,
      history: historicalJobs.length,
      historyGroups: recentGroups.length,
      attentionGroups: attentionGroups.length,
    }),
  })
}

/** Do not expose actions or outputs from a retained snapshot after session navigation. */
export function runCenterForSession(run: RunCenterSnapshot, currentSessionId: string | undefined): RunCenterSnapshot {
  if (currentSessionId !== undefined && run.sessionId === currentSessionId) return run
  return Object.freeze({
    ...(currentSessionId === undefined ? {} : { sessionId: currentSessionId }),
    status: currentSessionId === undefined ? 'idle' : 'loading',
    jobs: Object.freeze([]),
    subagents: Object.freeze([]),
    queue: Object.freeze([]),
    todos: Object.freeze([]),
    skills: Object.freeze([]),
    deliverables: Object.freeze([]),
  })
}

/** External stores update independently; expose interaction rows only after their session identity catches up. */
export function sessionScopedRows<T>(
  rows: readonly T[],
  snapshotSessionId: string | undefined,
  currentSessionId: string | undefined,
): readonly T[] {
  return currentSessionId !== undefined && snapshotSessionId === currentSessionId
    ? rows
    : Object.freeze([])
}

function presentRunCenterJob(job: RunCenterSnapshot['jobs'][number]): RunCenterSnapshot['jobs'][number] {
  const detail = friendlyRunJobDetail(job)
  const { detail: _rawDetail, ...facts } = job
  return Object.freeze({
    ...facts,
    label: friendlyRunJobLabel(job),
    ...(detail === undefined ? {} : { detail }),
  })
}

function groupRunCenterJobs(jobs: readonly RunCenterSnapshot['jobs'][number][]): readonly RunCenterJobGroup[] {
  const ordered = orderRunCenterJobs(jobs)
  const groups = new Map<string, RunCenterJobGroup>()
  for (const { job } of ordered) {
    const label = friendlyRunJobLabel(job)
    const key = `${job.status}:${label}`
    const current = groups.get(key)
    if (current !== undefined) {
      groups.set(key, Object.freeze({ ...current, count: current.count + 1 }))
      continue
    }
    const detail = friendlyRunJobDetail(job)
    groups.set(key, Object.freeze({ label, status: job.status, count: 1, ...(detail === undefined ? {} : { detail }) }))
  }
  return Object.freeze([...groups.values()])
}

function orderRunCenterJobs(jobs: readonly RunCenterSnapshot['jobs'][number][]): readonly { readonly job: RunCenterSnapshot['jobs'][number]; readonly index: number }[] {
  return jobs.map((job, index) => ({ job, index })).sort((left, right) => {
    const leftAt = left.job.finishedAt ?? left.job.startedAt ?? left.index
    const rightAt = right.job.finishedAt ?? right.job.startedAt ?? right.index
    return rightAt - leftAt || right.index - left.index
  })
}

/** Keep recovery state separate even when several maintenance checks share one friendly label. */
function runCenterJobIdentity(job: Pick<RunCenterSnapshot['jobs'][number], 'kind' | 'label'>): string {
  return `${job.kind?.trim() ?? ''}\u0000${job.label.trim()}`
}

function friendlyRunJobLabel(job: Pick<RunCenterSnapshot['jobs'][number], 'kind' | 'label'>): string {
  return job.kind === 'xiaoshe-heartbeat' || /^Xiaoshe check(?:\s|$)/iu.test(job.label.trim())
    ? '运行巡检'
    : job.label.trim()
}

function friendlyRunJobDetail(job: Pick<RunCenterSnapshot['jobs'][number], 'kind' | 'label' | 'detail'>): string | undefined {
  const detail = job.detail?.trim()
  if (detail === undefined || detail === '') return undefined
  if (job.kind === 'xiaoshe-heartbeat' || /^Xiaoshe check(?:\s|$)/iu.test(job.label.trim())) {
    if (/check completed/iu.test(detail)) return undefined
    if (/did not complete/iu.test(detail)) return '巡检未完成'
  }
  return detail
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
    probe_configuration_changed: '模型配置已更改，请重新验证',
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
  return ({ running: '正在处理', blocked: '等待交互信息', completed: '任务结束', idle: '已连接', blank: '新会话' } as Record<string, string>)[value] ?? value
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
  return ({ prepared: '待确认', pending: '处理中', running: '处理中', committed: '已完成', healthy: '运行正常', 'partial-health': '健康不完整', failed: '失败', 'rolled-back': '已回滚', 'rollback-failed': '回滚失败' } as Record<string, string>)[value] ?? '未知状态'
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

/** Prioritize human action and the current turn over retained receipts and telemetry. */
export function taskStatePresentation(input: {
  readonly runtimeState: string; readonly stopping: boolean; readonly questionCount: number; readonly approvalCount: number
  readonly queued: number; readonly active: number; readonly loading: boolean; readonly attention: boolean; readonly receipt?: string | undefined
}): { readonly label: string; readonly detail: string; readonly tone?: 'ok' | 'warn' } {
  if (input.questionCount > 0) return { label: '需要回答', detail: '回答问题后，小蛇会继续执行。', tone: 'warn' }
  if (input.approvalCount > 0) return { label: '需要确认', detail: '查看操作详情，决定是否允许继续。', tone: 'warn' }
  if (input.stopping || input.runtimeState === 'stopping') return { label: '正在停止', detail: '正在结束当前执行，请稍候。' }
  if (input.runtimeState === 'blocked') return { label: '等待交互信息', detail: '正在同步需要回答的问题或确认的操作。', tone: 'warn' }
  if (input.runtimeState === 'running') return { label: '正在执行', detail: '可以随时补充要求，或停止当前任务。', tone: 'ok' }
  if (input.attention) return { label: '需要关注', detail: '有运行事项需要关注，请查看下方详情。', tone: 'warn' }
  if (input.queued > 0) return { label: '等待处理', detail: '补充要求正在等待处理，可在下方调整或移除。', tone: 'warn' }
  if (input.active > 0) return { label: '正在推进', detail: '下方事项正在推进，可以查看进展和工作材料。', tone: 'ok' }
  if (input.receipt === 'completed') return { label: '已结束', detail: '本轮执行已结束，任务结果请看回复中的证据。命令自动分类未覆盖不等于任务失败，也不代表所有执行影响均已独立验证。' }
  if (input.receipt === 'cancelled') return { label: '已取消', detail: '已按你的请求停止。未完成要求和未验证的执行影响仍保留，不代表任务完成。' }
  if (input.receipt !== undefined) return { label: receiptLabel(input.receipt), detail: `${receiptLabel(input.receipt)}。工作材料包含过程记录，请以本轮结果说明为准。`, ...(input.receipt === 'verified' ? { tone: 'ok' as const } : {}) }
  return input.loading ? { label: '正在读取', detail: '正在读取本轮任务信息，请稍候。' } : { label: '等待任务', detail: '发送一项任务后，在这里查看进展和工作材料。' }
}

function receiptLabel(value: string): string {
  return ({ completed: '已结束', verified: '已验证', partial: '部分验证', blocked: '受阻', failed: '失败', cancelled: '已取消', not_run: '未执行', release_held: '待发布', running: '执行中' } as Record<string, string>)[value] ?? value
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
