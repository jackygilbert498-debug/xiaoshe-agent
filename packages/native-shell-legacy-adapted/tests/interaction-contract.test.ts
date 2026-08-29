import { afterEach, describe, expect, it, vi } from 'vitest'
import * as legacyAdaptedClient from '../src/client/index.js'
import {
  apply,
  activeUserTurnOrdinalAtScroll,
  bytesToBase64,
  COMPOSER_DRAFT_STORAGE_PREFIX,
  COMPOSER_ENTER_STORAGE_KEY,
  composerKeyAction,
  DEFAULT_DRAFT_IMAGE_LIMITS,
  draftImageBatchError,
  dialogTabTarget,
  filterSlashCommandIds,
  imageMediaTypeOf,
  normalizeSideEntityTitle,
  PANEL_WIDTH_STORAGE_KEY,
  platformLogLocation,
  parseCollapsedWorkspaceIds,
  parseSlashCommandQuery,
  platformCommandShortcut,
  pluginCandidatePresentation,
  pluginChallengePresentation,
  resizeComposerTextarea,
  sessionDisplayTitle,
  timelineEventPresentation,
  tabKeyboardTarget,
  choiceMenuKeyboardIndex,
  toggleCollapsedWorkspaceId,
  windowSessionCatalog,
  WORKSPACE_GROUP_COLLAPSE_STORAGE_KEY,
} from '../src/client/index.js'
import { contextFixture } from './fixture.js'

interface TreeNode {
  readonly type: unknown
  readonly props: Record<string, unknown> | null
  readonly children: readonly unknown[]
}

function hookHarness() {
  const state: unknown[] = []
  let stateCursor = 0
  let refCursor = 0
  let effectCursor = 0
  const refs: Array<{ current: unknown }> = []
  const effectDependencies: unknown[][] = []
  const cleanups: Array<void | (() => void)> = []

  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props, children }),
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
    useState: <T>(initial: T): [T, (value: T | ((current: T) => T)) => void] => {
      const index = stateCursor++
      if (!(index in state)) state[index] = initial
      return [state[index] as T, value => {
        state[index] = typeof value === 'function'
          ? (value as (current: T) => T)(state[index] as T)
          : value
      }]
    },
    useRef: <T>(initial: T): { current: T } => {
      const index = refCursor++
      if (refs[index] === undefined) refs[index] = { current: initial }
      return refs[index] as { current: T }
    },
    useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => {
      const index = effectCursor++
      const previous = effectDependencies[index]
      const changed = previous === undefined || previous.length !== dependencies.length
        || dependencies.some((value, dependencyIndex) => !Object.is(value, previous[dependencyIndex]))
      if (!changed) return
      cleanups[index]?.()
      effectDependencies[index] = [...dependencies]
      cleanups[index] = effect()
    },
  }

  return {
    react,
    render(component: () => unknown): TreeNode {
      stateCursor = 0
      refCursor = 0
      effectCursor = 0
      return component() as TreeNode
    },
    dispose() { for (const cleanup of cleanups) cleanup?.() },
  }
}

function findNode(root: unknown, predicate: (node: TreeNode) => boolean): TreeNode | undefined {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return undefined
  const node = root as TreeNode
  if ('type' in node && 'children' in node && predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

function findNodes(root: unknown, predicate: (node: TreeNode) => boolean): TreeNode[] {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return []
  const node = root as TreeNode
  const own = 'type' in node && 'children' in node && predicate(node) ? [node] : []
  return [...own, ...(node.children ?? []).flatMap(child => findNodes(child, predicate))]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Legacy-adapted interaction contracts', () => {
  it('keeps the conversation, inspector, composer, and statusbar in their grid-owned seats', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    const release = apply(ctx, harness.react)
    const tree = harness.render(component!)
    const root = findNode(tree, node => node.props?.['data-xiaoshe-legacy-adapted'] === '')
    const app = findNode(root, node => node.props?.className === 'app')
    const main = findNode(app, node => typeof node.props?.className === 'string'
      && (node.props.className as string).split(' ').includes('main'))
    const chat = findNode(main, node => typeof node.props?.className === 'string'
      && (node.props.className as string).split(' ').includes('chat'))

    expect(main?.children.some(child => (child as TreeNode | null)?.props?.className === 'insp')).toBe(true)
    expect(chat?.children.some(child => (child as TreeNode | null)?.props?.className === 'conversation-body')).toBe(true)
    expect(chat?.children.some(child => (child as TreeNode | null)?.props?.className === 'composer')).toBe(true)
    expect(app?.children.some(child => (child as TreeNode | null)?.props?.className === 'statusbar')).toBe(true)

    release()
    harness.dispose()
  })

  it('builds a compact navigation model from user turns only', () => {
    const buildNavigation = (legacyAdaptedClient as unknown as {
      buildUserTurnNavigation?: (items: readonly { key: string; kind: string; text: string }[]) => readonly unknown[]
    }).buildUserTurnNavigation

    expect(buildNavigation).toBeTypeOf('function')
    expect(buildNavigation?.([
      { key: 'status-0', kind: 'status', text: '开始' },
      { key: 'user-1', kind: 'user', text: '  第一条\n   消息  ' },
      { key: 'assistant-2', kind: 'assistant', text: '回答' },
      { key: 'user-3', kind: 'user', text: '甲'.repeat(100) },
      { key: 'user-4', kind: 'user', text: '   ' },
      { key: 'user-5', kind: 'user', text: '😀'.repeat(100) },
    ])).toEqual([
      { key: 'user-1', eventIndex: 1, ordinal: 1, preview: '第一条 消息' },
      { key: 'user-3', eventIndex: 3, ordinal: 2, preview: `${'甲'.repeat(95)}…` },
      { key: 'user-4', eventIndex: 4, ordinal: 3, preview: '（无文字内容）' },
      { key: 'user-5', eventIndex: 5, ordinal: 4, preview: `${'😀'.repeat(95)}…` },
    ])
  })

  it('gives generic sessions a stable, distinguishable display title', () => {
    expect(sessionDisplayTitle('真正的任务名', 'session-abcdef', Date.UTC(2026, 7, 29, 6, 5))).toBe('真正的任务名')
    expect(sessionDisplayTitle('未命名任务', 'session-abcdef', Date.UTC(2026, 7, 29, 6, 5))).toBe('未命名 · 08/29 06:05 · abcdef')
    expect(sessionDisplayTitle('未命名任务', 'session-123456', Date.UTC(2026, 7, 29, 6, 5)))
      .not.toBe(sessionDisplayTitle('未命名任务', 'session-abcdef', Date.UTC(2026, 7, 29, 6, 5)))
    expect(sessionDisplayTitle(undefined, 'session-abcdef', Number.NaN)).toBe('未命名 · abcdef')
    expect(sessionDisplayTitle(undefined, 'session-abcdef', Number.MAX_VALUE)).toBe('未命名 · abcdef')
  })

  it('windows a large session catalog while retaining the active session', () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({ sessionId: `s${index + 1}`, updatedAt: 250 - index }))
    const first = windowSessionCatalog(rows, 100, 's250')
    expect(first.total).toBe(250)
    expect(first.hasMore).toBe(true)
    expect(first.items).toHaveLength(101)
    expect(first.items.some(row => row.sessionId === 's250')).toBe(true)

    expect(windowSessionCatalog(rows, 300, 's250')).toEqual({ items: rows, total: 250, hasMore: false })
  })

  it('uses the same quiet frosted heading treatment for generated and meaningful session titles', () => {
    let component: (() => unknown) | undefined
    let catalogTitle = '未命名任务'
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    ctx.sessionCatalog.getSnapshot = () => ({
      sessions: { s1: { sessionId: 's1', title: catalogTitle, updatedAt: Date.UTC(2026, 7, 29, 6, 5) } },
    })
    const release = apply(ctx, harness.react)

    let tree = harness.render(component!)
    let heading = findNode(tree, node => node.type === 'h1')
    expect(heading?.props?.className).toBe('chat-title chat-title-frosted chat-title-generic')
    expect(heading?.children).toEqual(['未命名 · 08/29 06:05 · s1'])

    catalogTitle = '真正的任务名'
    tree = harness.render(component!)
    heading = findNode(tree, node => node.type === 'h1')
    expect(heading?.props?.className).toBe('chat-title chat-title-frosted')
    expect(heading?.children).toEqual(['真正的任务名'])

    release()
    harness.dispose()
  })

  it('separates historical failures from the latest verified completion', () => {
    expect(timelineEventPresentation({ key: 'e1', seq: 4, kind: 'error', text: 'provider timeout', errorCode: 'timeout' }, 9)).toEqual({
      label: '上一轮失败 · ERROR',
      historical: true,
      detail: '错误代码 timeout',
    })
    expect(timelineEventPresentation({ key: 'e2', seq: 10, kind: 'error', text: 'provider timeout' }, 9)).toEqual({
      label: '任务失败 · ERROR',
      historical: false,
      detail: '',
    })
  })

  it('renders assistant text through the shared safe Markdown primitive only', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const MarkdownProbe = (_props: { readonly text: string; readonly streaming?: boolean }) => null
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    ctx.taskTimeline.getSnapshot = () => ({ items: [
      { key: 'u1', kind: 'user', text: '**用户原文**' },
      { key: 'a1', kind: 'assistant', text: '**加粗回答**', reasoning: '折叠推理' },
    ] })

    const release = apply(ctx, harness.react, { MarkdownText: MarkdownProbe })
    const tree = harness.render(component!)
    const markdown = findNode(tree, node => node.type === MarkdownProbe)
    const userBody = findNode(tree, node => node.props?.className === 'event event-user')

    expect(markdown?.props).toMatchObject({ text: '**加粗回答**', streaming: false })
    expect(userBody).toBeDefined()
    expect(findNode(userBody, node => node.type === MarkdownProbe)).toBeUndefined()

    release()
    harness.dispose()
  })

  it('offers the latest-message shortcut only after leaving the bottom threshold', () => {
    const shouldOffer = (legacyAdaptedClient as unknown as {
      shouldOfferJumpToLatest?: (metrics: { scrollHeight: number; scrollTop: number; clientHeight: number }) => boolean
    }).shouldOfferJumpToLatest

    expect(shouldOffer).toBeTypeOf('function')
    expect(shouldOffer?.({ scrollHeight: 1_200, scrollTop: 720, clientHeight: 400 })).toBe(false)
    expect(shouldOffer?.({ scrollHeight: 1_200, scrollTop: 520, clientHeight: 400 })).toBe(true)
    expect(shouldOffer?.({ scrollHeight: Number.NaN, scrollTop: 0, clientHeight: 400 })).toBe(false)
  })

  it('marks the user turn nearest the reading line without inventing a position', () => {
    expect(activeUserTurnOrdinalAtScroll([80, 420, 910], 360, 600)).toBe(2)
    expect(activeUserTurnOrdinalAtScroll([80, 420, 910], 0, 600)).toBe(1)
    // Real browser layout can leave the requested reading line a fraction of a
    // pixel before an integer offsetTop; that rounding must not select the
    // previous message after an explicit marker jump.
    expect(activeUserTurnOrdinalAtScroll([34, 242, 1019], 816, 597)).toBe(3)
    expect(activeUserTurnOrdinalAtScroll([], 0, 600)).toBeUndefined()
  })

  it('renders user-turn markers that reveal previews and jump to the matching event', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    const release = apply(ctx, harness.react)
    const tree = harness.render(component!)

    const navigation = findNode(tree, node => node.props?.['aria-label'] === '我的消息导航')
    const marker = findNode(navigation, node => node.type === 'button' && node.props?.['data-turn-index'] === 1)
    const stream = findNode(tree, node => node.props?.className === 'stream')
    const conversationBody = findNode(tree, node => node.props?.className === 'conversation-body')
    const markerScroller = findNode(navigation, node => node.props?.className === 'turn-index-scroll')
    const scrollTo = vi.fn()
    const querySelector = vi.fn(() => ({ offsetTop: 910 }))
    ;(stream?.props?.ref as { current: unknown }).current = { querySelector, scrollTo, clientHeight: 600 }

    expect(navigation).toBeDefined()
    expect(conversationBody?.children).toContain(navigation)
    expect(stream?.props?.role).toBe('log')
    expect(stream?.props?.['aria-label']).toBe('对话记录')
    expect(stream?.props?.['aria-live']).toBe('off')
    expect(findNode(stream, node => node.props?.['aria-label'] === '我的消息导航')).toBeUndefined()
    expect(markerScroller).toBeDefined()
    expect(marker?.props?.style).toBeUndefined()
    expect(marker?.props?.['aria-label']).toBe('跳转到第 1 条我的消息：完成交接')
    ;(marker?.props?.onMouseEnter as (event: { currentTarget: unknown }) => void)({
      currentTarget: {
        getBoundingClientRect: () => ({ top: 220, height: 16 }),
        closest: () => ({ getBoundingClientRect: () => ({ top: 100 }) }),
      },
    })
    const previewTree = harness.render(component!)
    const preview = findNode(previewTree, node => node.props?.role === 'tooltip')
    expect(preview?.props?.style).toEqual({ '--xsla-turn-preview-top': '128px' })
    expect(JSON.stringify(preview)).toContain('我发送的第 1 条')
    expect(JSON.stringify(preview)).toContain('完成交接')
    ;(marker?.props?.onClick as () => void)()
    expect(querySelector).toHaveBeenCalledWith('[data-event-index="0"]')
    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'smooth', top: 706 })

    release()
    harness.dispose()
  })

  it('offers an explicit older-history page action from the timeline service', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    const loadEarlier = vi.fn()
    ctx.taskTimeline.getSnapshot = () => ({
      total: 240, hasEarlier: true,
      items: [{ key: 'u1', kind: 'user', text: '当前窗口' }],
    })
    ctx.taskTimeline.loadEarlier = loadEarlier

    const release = apply(ctx, harness.react)
    const tree = harness.render(component!)
    const button = findNode(tree, node => node.props?.className === 'timeline-load-earlier')
    expect(button?.children).toEqual(['加载更早记录 · 1/240'])
    ;(button?.props?.onClick as () => void)()
    expect(loadEarlier).toHaveBeenCalledOnce()

    release()
    harness.dispose()
  })

  it('fades in a non-persistent shortcut when the conversation is far from latest', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    let stream = findNode(tree, node => node.props?.className === 'stream')

    expect(findNode(tree, node => node.props?.['aria-label'] === '回到最新消息')).toBeUndefined()
    ;(stream?.props?.onScroll as (event: { currentTarget: { scrollHeight: number; scrollTop: number; clientHeight: number } }) => void)({
      currentTarget: { scrollHeight: 1_600, scrollTop: 300, clientHeight: 600 },
    })

    tree = harness.render(component!)
    stream = findNode(tree, node => node.props?.className === 'stream')
    const scrollTo = vi.fn()
    ;(stream?.props?.ref as { current: unknown }).current = { scrollHeight: 1_600, scrollTo }
    const shortcut = findNode(tree, node => node.props?.['aria-label'] === '回到最新消息')
    const conversationBody = findNode(tree, node => node.props?.className === 'conversation-body')

    expect(shortcut).toBeDefined()
    expect(conversationBody?.children).toContain(shortcut)
    expect(findNode(stream, node => node.props?.['aria-label'] === '回到最新消息')).toBeUndefined()
    ;(shortcut?.props?.onClick as () => void)()
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_600, behavior: 'smooth' })
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.['aria-label'] === '回到最新消息')).toBeUndefined()

    release()
    harness.dispose()
  })

  it('sanitizes and toggles durable workspace collapse preferences', () => {
    expect(parseCollapsedWorkspaceIds(null)).toEqual([])
    expect(parseCollapsedWorkspaceIds('not-json')).toEqual([])
    expect(parseCollapsedWorkspaceIds('["w1","w1",7,"",null,"w2"]')).toEqual(['w1', 'w2'])
    expect(toggleCollapsedWorkspaceId(['w1'], 'w1')).toEqual([])
    expect(toggleCollapsedWorkspaceId(['w1'], 'w2')).toEqual(['w1', 'w2'])
  })

  it('submits plain Enter while preserving Shift+Enter and IME composition', () => {
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, isComposing: false })).toBe('submit')
    expect(composerKeyAction({ key: 'Enter', shiftKey: true, isComposing: false })).toBe('newline')
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, isComposing: true })).toBe('newline')
    expect(composerKeyAction({ key: 'Escape', shiftKey: false, isComposing: false })).toBe('ignore')
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, isComposing: false, behavior: 'ctrl-enter-send' })).toBe('newline')
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, isComposing: false, ctrlKey: true, behavior: 'ctrl-enter-send' })).toBe('submit')
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, isComposing: false, metaKey: true, behavior: 'ctrl-enter-send' })).toBe('submit')
  })

  it('uses platform-correct shortcuts and deterministic keyboard navigation', () => {
    expect(platformCommandShortcut('MacIntel')).toBe('⌘ K')
    expect(platformCommandShortcut('Win32')).toBe('Ctrl K')
    expect(choiceMenuKeyboardIndex('ArrowDown', 1, 4)).toBe(2)
    expect(choiceMenuKeyboardIndex('ArrowUp', 0, 4)).toBe(3)
    expect(choiceMenuKeyboardIndex('Home', 3, 4)).toBe(0)
    expect(choiceMenuKeyboardIndex('End', 0, 4)).toBe(3)
    expect(tabKeyboardTarget('memory', 'ArrowRight')).toBe('system')
    expect(tabKeyboardTarget('status', 'ArrowLeft')).toBe('system')
    expect(dialogTabTarget(3, 2, false)).toBe(0)
    expect(dialogTabTarget(3, 0, true)).toBe(2)
    expect(dialogTabTarget(3, 1, false)).toBeUndefined()
    expect(dialogTabTarget(3, -1, false)).toBe(0)
  })

  it('owns only leading slash expressions and filters real commands in stable order', () => {
    expect(parseSlashCommandQuery('/')).toBe('')
    expect(parseSlashCommandQuery('/MEM')).toBe('mem')
    expect(parseSlashCommandQuery('请运行 /memory')).toBeUndefined()
    expect(parseSlashCommandQuery('/memory\n继续')).toBeUndefined()
    expect(filterSlashCommandIds('')).toEqual(['new', 'stop', 'fork', 'compact', 'status', 'memory', 'capabilities', 'plugins'])
    expect(filterSlashCommandIds('mem')).toEqual(['memory'])
    expect(filterSlashCommandIds('插件')).toEqual(['plugins'])
    expect(filterSlashCommandIds('missing')).toEqual([])
  })

  it('grows the text area to a cap and validates image batches before upload', () => {
    const style = { height: '', overflowY: '' } as CSSStyleDeclaration
    expect(resizeComposerTextarea({ scrollHeight: 96, style })).toBe(96)
    expect(style).toMatchObject({ height: '96px', overflowY: 'hidden' })
    expect(resizeComposerTextarea({ scrollHeight: 260, style })).toBe(168)
    expect(style).toMatchObject({ height: '168px', overflowY: 'auto' })
    expect(imageMediaTypeOf({ name: 'screen.JPEG', type: '' })).toBe('image/jpeg')
    expect(bytesToBase64(new Uint8Array([1, 2, 3, 4]))).toBe('AQIDBA==')
    expect(draftImageBatchError([], [{ name: 'note.txt', bytes: 10 }], DEFAULT_DRAFT_IMAGE_LIMITS)).toContain('不是支持的')
    expect(draftImageBatchError([], [{ name: 'large.png', bytes: DEFAULT_DRAFT_IMAGE_LIMITS.maxImageBytes + 1, mediaType: 'image/png' }], DEFAULT_DRAFT_IMAGE_LIMITS)).toContain('超过单图')
  })

  it('validates editable project and session titles before calling DSH', () => {
    expect(normalizeSideEntityTitle('  新名字  ')).toBe('新名字')
    expect(() => normalizeSideEntityTitle('   ')).toThrow('名称不能为空')
    expect(() => normalizeSideEntityTitle('a'.repeat(121))).toThrow('120')
  })

  it('redacts the one-time token from every prepared plugin presentation', () => {
    const view = pluginChallengePresentation({
      id: 'challenge-1', token: 'private-token-not-rendered',
      expiresAt: '2026-08-26T06:00:00.000Z', action: 'add',
      profile: 'xiaoshe-managed-lab', packageName: '@x/demo', version: '1.0.0',
      identity: { displayName: '演示插件', description: '处理示例任务', developer: 'Example Studio', license: 'MIT', keywords: [] },
      provenance: { kind: 'registry', selection: 'exact-version', label: '软件源 @x/demo@1.0.0', assurance: 'unverified' },
      disclosures: ['来源核验：未签名', 'Host 进程内运行；系统沙箱未启用'], osSandboxEnforced: false,
    })
    expect(view.heading).toBe('安装 演示插件')
    expect(view.facts).toContain('包标识：@x/demo@1.0.0')
    expect(view.facts).toContain('来源：软件源 @x/demo@1.0.0')
    expect(view.facts).toContain('来源核验：未签名 · 固定版本')
    expect(view.facts).toContain('运行边界：本机进程内 · 系统沙箱未启用')
    expect(view.disclosures).toEqual(['来源核验：未签名', '本机进程内运行；系统沙箱未启用'])
    expect(JSON.stringify(view)).not.toContain('private-token-not-rendered')
  })

  it('presents audited candidates with human identity first and package identity second', () => {
    const view = pluginCandidatePresentation({
      id: 'candidate-1', packageName: '@x/demo', version: '1.0.0', sha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
      identity: { displayName: '演示插件', description: '处理示例任务', developer: 'Example Studio', license: 'MIT', keywords: [] },
      provenance: { kind: 'registry', selection: 'exact-version', label: '软件源 @x/demo@1.0.0', assurance: 'unverified' },
      audit: { risk: 'high' }, osSandboxEnforced: false,
    })
    expect(view.heading).toBe('演示插件')
    expect(view.facts[0]).toBe('用途：处理示例任务')
    expect(view.facts).toContain('包标识：@x/demo@1.0.0')
    expect(view.facts).toContain('开发者：Example Studio · 许可证：MIT')
    expect(view.facts).toContain('来源核验：未签名 · 固定版本')
    expect(view.facts).toContain('运行边界：本机进程内 · 系统沙箱未启用')
    expect(JSON.stringify(view)).not.toContain('trusted')
  })

  it('routes stop and project-scoped memory through their public services', async () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'running' } } })
    const stopRun = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
    const refresh = vi.fn(async () => ctx.memoryLifecycle.getSnapshot().memory as never)
    ctx.agentRuntimeSession.stopRun = stopRun
    ctx.memoryLifecycle.refresh = refresh

    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    const composer = findNode(tree, node => node.props?.className === 'composer')
    const stop = findNode(tree, node => node.props?.['aria-label'] === '停止生成')
    expect(stop).toBeDefined()
    expect(composer?.children).toContain(findNode(composer, node => node.props?.className === 'cbox'))
    expect(findNode(composer, node => node.props?.['aria-label'] === '停止生成')).toBe(stop)
    expect(findNodes(tree, node => node.props?.['aria-label'] === '停止生成')).toHaveLength(1)
    expect(JSON.stringify(stop)).toContain('停止')
    const steer = findNode(tree, node => node.props?.['aria-label'] === '调整方向')
    expect(steer).toBeDefined()
    expect(JSON.stringify(steer)).toContain('调整方向')
    expect(JSON.stringify(findNode(tree, node => node.props?.className === 'hint'))).toContain('运行中 · 发送将调整方向')
    await (stop?.props?.onClick as () => Promise<void> | void)()
    expect(stopRun).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(refresh).toHaveBeenCalledWith({ scope: 'all', project: 'C:\\work', include_inactive: true })

    release()
    harness.dispose()
  })

  it.each([
    ['idle', 'queue'],
    ['running', 'steer'],
  ] as const)('routes a %s composer submission through %s mode', async (state, mode) => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state } } })
    const sendTurn = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
    const removeItem = vi.fn()
    ctx.agentRuntimeSession.sendTurn = sendTurn
    vi.stubGlobal('FormData', class {
      get(name: string): string | null { return name === 'content' ? '补充新的执行方向' : null }
    })
    vi.stubGlobal('HTMLTextAreaElement', class {})
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem })

    const release = apply(ctx, harness.react)
    const tree = harness.render(component!)
    const form = findNode(tree, node => node.type === 'form' && node.props?.className === 'cbox')
    const reset = vi.fn()
    ;(form?.props?.onSubmit as (event: unknown) => void)({
      preventDefault() {},
      currentTarget: { reset, elements: { namedItem: () => null } },
    })

    await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledWith({
      sessionId: 's1', content: '补充新的执行方向', mode,
    }))
    expect(reset).toHaveBeenCalledOnce()
    expect(removeItem).toHaveBeenCalledWith(`${COMPOSER_DRAFT_STORAGE_PREFIX}${encodeURIComponent('s1')}`)
    release()
    harness.dispose()
  })

  it('uses the official line mark as a conversation-only lower-right watermark', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    const conversationGhost = findNode(tree, node => node.props?.className === 'conversation-ghost')
    expect(conversationGhost?.type).toBe('svg')
    expect(JSON.stringify(conversationGhost)).toContain(legacyAdaptedClient.BROWSER_BRAND_RASTER_HREF)
    expect(findNodes(conversationGhost, node => node.type === 'feMorphology').map(node => node.props?.radius)).toEqual(['.4', '.4'])
    expect(findNode(tree, node => node.props?.className === 'stage-ghost')).toBeUndefined()

    ctx.taskTimeline.getSnapshot = () => ({ items: [] })
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.className === 'stage-ghost')).toBeDefined()
    expect(findNode(tree, node => node.props?.className === 'conversation-ghost')).toBeUndefined()

    release()
    harness.dispose()
  })

  it('keeps the empty-state identity copy in one independently positioned cluster', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    ctx.taskTimeline.getSnapshot = () => ({ items: [] })

    const release = apply(ctx, harness.react)
    const tree = harness.render(component!)
    const stage = findNode(tree, node => node.props?.className === 'stage-empty')
    const cluster = findNode(stage, node => node.props?.className === 'stage-cluster')

    expect(stage?.children.map(child => (child as TreeNode)?.props?.className)).toEqual(['stage-ghost', 'stage-cluster'])
    expect(findNode(cluster, node => node.props?.className === 'stage-word')?.children).toEqual(['小蛇'])
    expect(findNode(cluster, node => node.props?.className === 'stage-badge')).toBeDefined()
    expect(findNode(cluster, node => node.props?.className === 'stage-chips')).toBeDefined()

    release()
    harness.dispose()
  })

  it('routes project adoption, model controls, and real permission presets through public services', async () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    const addFromNativePicker = vi.fn(async () => ({ ok: true as const, value: { cancelled: false, workspace: { workspaceId: 'w2', path: 'C:\\new', title: 'new', sessionIds: [], createdAt: 'x', updatedAt: 'x' } } }))
    const createAndOpenSession = vi.fn(async () => ({ ok: true as const, value: { sessionId: 's2' } }))
    const select = vi.fn(async (input: { provider: string; model: string; reasoningEffort?: string }) => ({ ok: true as const, value: { selected: input } }))
    const selectPermission = vi.fn(async (value: string) => ({ ok: true as const, value: { selected: value } }))
    ctx.workspaceCatalog.addFromNativePicker = addFromNativePicker
    ctx.workspaceCatalog.createAndOpenSession = createAndOpenSession
    ctx.modelCatalog.select = select
    ctx.permissionPresets.select = selectPermission

    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    const project = findNode(tree, node => node.type === 'button' && node.children.includes('＋ 项目'))
    await (project?.props?.onClick as () => void)()
    await Promise.resolve()
    expect(addFromNativePicker).toHaveBeenCalledOnce()
    expect(createAndOpenSession).toHaveBeenCalledWith('w2')

    const model = findNode(tree, node => node.type === 'select' && node.props?.className === 'model-select')
    ;(model?.props?.onChange as (event: unknown) => void)({ currentTarget: { value: '["deepseek","deepseek-v4-pro"]' } })
    await Promise.resolve()
    expect(select).toHaveBeenCalledWith({ sessionId: 's1', provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' })

    const effort = findNode(tree, node => node.type === 'button' && node.props?.['aria-label'] === '思考强度：高')
    expect(effort?.props?.['aria-haspopup']).toBe('menu')
    ;(effort?.props?.onClick as () => void)()
    tree = harness.render(component!)
    const effortMenu = findNode(tree, node => node.props?.role === 'menu' && node.props?.['aria-label'] === '选择思考强度')
    expect(effortMenu?.props?.['data-placement']).toBe('top')
    const effortOptions = findNodes(effortMenu, node => node.props?.role === 'menuitemradio')
    expect(effortOptions).toHaveLength(4)
    expect(effortOptions.find(node => node.props?.['aria-checked'] === true)?.props?.autoFocus).toBe(true)
    expect(JSON.stringify(effortMenu)).toContain('关闭额外推理')
    expect(JSON.stringify(effortMenu)).toContain('最大')
    expect(JSON.stringify(effortMenu)).not.toContain('"Off"')
    const returnFocus = vi.fn()
    ;(findNode(effortMenu, node => node.type === 'button' && node.props?.['data-value'] === 'low')?.props?.onClick as (event: unknown) => void)({
      currentTarget: { closest: () => ({ querySelector: () => ({ focus: returnFocus }) }) },
    })
    await Promise.resolve()
    expect(returnFocus).toHaveBeenCalledOnce()
    expect(select).toHaveBeenLastCalledWith({ sessionId: 's1', provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'low' })

    tree = harness.render(component!)
    const permission = findNode(tree, node => node.type === 'button' && node.props?.['aria-label'] === '权限：工作区写入')
    expect(permission?.props?.['aria-haspopup']).toBe('menu')
    ;(permission?.props?.onClick as () => void)()
    tree = harness.render(component!)
    const permissionMenu = findNode(tree, node => node.props?.role === 'menu' && node.props?.['aria-label'] === '选择权限')
    expect(permissionMenu?.props?.['data-placement']).toBe('top')
    expect(JSON.stringify(permissionMenu)).toContain('仅允许工作区写入')
    ;(findNode(permissionMenu, node => node.type === 'button' && node.props?.['data-value'] === 'read-only')?.props?.onClick as () => void)()
    await Promise.resolve()
    expect(selectPermission).toHaveBeenCalledWith('read-only')

    tree = harness.render(component!)
    ;(findNode(tree, node => node.type === 'button' && node.props?.['aria-label'] === '权限：工作区写入')?.props?.onClick as () => void)()
    tree = harness.render(component!)
    ;(findNode(tree, node => node.type === 'button' && node.props?.['data-value'] === 'danger-full-access')?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.['aria-label'] === '确认完全访问权限')).toBeDefined()
    expect(selectPermission).not.toHaveBeenCalledWith('danger-full-access')
    const confirm = findNode(tree, node => node.type === 'button' && node.children.includes('确认完全访问'))
    ;(confirm?.props?.onClick as () => void)()
    await Promise.resolve()
    expect(selectPermission).toHaveBeenCalledWith('danger-full-access')

    tree = harness.render(component!)
    ;(findNode(tree, node => node.type === 'button' && node.props?.['aria-label'] === '思考强度：高')?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.['aria-label'] === '选择思考强度')).toBeDefined()
    const root = findNode(tree, node => node.props?.['data-xiaoshe-legacy-adapted'] === '')
    ;(root?.props?.onKeyDown as (event: unknown) => void)({ key: 'Escape' })
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.['aria-label'] === '选择思考强度')).toBeUndefined()
    expect(findNode(tree, node => node.type === 'select' && (node.props?.className === 'effort-select' || node.props?.className === 'permission-select'))).toBeUndefined()

    release()
    harness.dispose()
  })

  it('keeps workspace identity in the sidebar while rendering a two-level composer and the official legacy sheen', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    const release = apply(ctx, harness.react)
    const tree = harness.render(component!)

    expect(findNode(tree, node => node.props?.className === 'proj-name')?.children).toContain('工作区')
    expect(findNodes(tree, node => node.children.includes('工作区'))).toHaveLength(1)
    expect(findNode(tree, node => node.props?.className === 'meta')).toBeUndefined()
    expect(findNode(tree, node => node.props?.className === 'pill')).toBeUndefined()
    expect(findNode(tree, node => node.props?.className === 'model-select-wrap')?.props?.title).toBe('模型：DeepSeek V4 Pro')
    expect(findNode(tree, node => node.props?.className === 'model-name')?.children).toContain('DeepSeek V4 Pro')
    expect(findNode(tree, node => node.props?.className === 'effort-select-wrap')?.props?.title).toBe('推理档位：高')
    expect(findNode(tree, node => node.props?.className === 'permission-select-wrap')?.props?.title).toBe('权限：工作区写入')
    expect(findNode(tree, node => node.props?.className === 'composer-content')).toBeDefined()
    expect(findNode(tree, node => node.props?.className === 'composer-toolbar')).toBeDefined()
    expect(findNode(tree, node => node.props?.className === 'attachment-input')?.props?.accept).toContain('image/png')
    expect(findNode(tree, node => node.props?.id === 'xsla-brand-sheen')).toBeDefined()
    expect(findNode(tree, node => node.props?.stroke === 'url(#xsla-brand-sheen)')).toBeDefined()

    release()
    harness.dispose()
  })

  it('renders two accessible splitters, resizes independently, and persists only user changes', () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>()
    const browserWindow = {
      innerWidth: 1440,
      innerHeight: 900,
      addEventListener(type: string, listener: (event: unknown) => void) {
        const group = listeners.get(type) ?? new Set()
        group.add(listener)
        listeners.set(type, group)
      },
      removeEventListener(type: string, listener: (event: unknown) => void) {
        listeners.get(type)?.delete(listener)
      },
    }
    vi.stubGlobal('window', browserWindow)
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem })
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })

    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    let splitters = findNodes(tree, node => node.props?.role === 'separator')
    expect(splitters).toHaveLength(2)
    expect(splitters.map(node => node.props?.['aria-label'])).toEqual(['调整左侧会话栏宽度', '调整右侧工作台宽度'])
    expect(findNode(tree, node => node.props?.className === 'main')?.props?.style).toMatchObject({
      '--xsla-side-width': '232px',
      '--xsla-insp-width': '292px',
    })
    expect(setItem).not.toHaveBeenCalledWith(PANEL_WIDTH_STORAGE_KEY, expect.any(String))

    let prevented = false
    ;(splitters[0]?.props?.onKeyDown as (event: unknown) => void)({ key: 'ArrowRight', shiftKey: false, preventDefault: () => { prevented = true } })
    tree = harness.render(component!)
    expect(prevented).toBe(true)
    expect(findNode(tree, node => String(node.props?.className).split(' ').includes('main'))?.props?.style).toMatchObject({
      '--xsla-side-width': '240px',
      '--xsla-insp-width': '292px',
    })
    expect(setItem).toHaveBeenCalledWith(PANEL_WIDTH_STORAGE_KEY, '{"side":240,"inspector":292}')

    splitters = findNodes(tree, node => node.props?.role === 'separator')
    ;(splitters[1]?.props?.onKeyDown as (event: unknown) => void)({ key: 'ArrowLeft', shiftKey: true, preventDefault() {} })
    tree = harness.render(component!)
    expect(findNode(tree, node => String(node.props?.className).split(' ').includes('main'))?.props?.style).toMatchObject({
      '--xsla-side-width': '240px',
      '--xsla-insp-width': '324px',
    })

    browserWindow.innerWidth = 740
    for (const listener of listeners.get('resize') ?? []) listener({})
    tree = harness.render(component!)
    expect(findNode(tree, node => String(node.props?.className).split(' ').includes('main'))?.props?.style).toMatchObject({
      '--xsla-side-width': '240px',
      '--xsla-insp-width': '324px',
    })
    browserWindow.innerWidth = 1440

    splitters = findNodes(tree, node => node.props?.role === 'separator')
    ;(splitters[0]?.props?.onDoubleClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => String(node.props?.className).split(' ').includes('main'))?.props?.style).toMatchObject({ '--xsla-side-width': '232px' })

    release()
    harness.dispose()
  })

  it('collapses a workspace as one persistent group while keeping its create action independent', async () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem })
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    const createAndOpenSession = vi.fn(async () => ({ ok: true as const, value: { sessionId: 'workspace-session' } }))
    ctx.workspaceCatalog.createAndOpenSession = createAndOpenSession

    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    let toggle = findNode(tree, node => node.type === 'button' && node.props?.className === 'proj-toggle')
    expect(toggle?.props?.['aria-expanded']).toBe(true)
    const panelId = toggle?.props?.['aria-controls']
    expect(typeof panelId).toBe('string')

    ;(toggle?.props?.onClick as () => void)()
    tree = harness.render(component!)
    toggle = findNode(tree, node => node.type === 'button' && node.props?.className === 'proj-toggle')
    const panel = findNode(tree, node => node.props?.id === panelId)
    expect(toggle?.props?.['aria-expanded']).toBe(false)
    expect(toggle?.props?.['aria-label']).toBe('展开 工作区 会话')
    expect(panel?.props?.['aria-hidden']).toBe(true)
    expect(panel?.props?.inert).toBe(true)
    expect(setItem).toHaveBeenLastCalledWith(WORKSPACE_GROUP_COLLAPSE_STORAGE_KEY, '["w1"]')

    const create = findNode(tree, node => node.type === 'button' && node.props?.['aria-label'] === '在 工作区 新建会话')
    ;(create?.props?.onClick as () => void)()
    await Promise.resolve()
    expect(createAndOpenSession).toHaveBeenCalledWith('w1')
    tree = harness.render(component!)
    expect(findNode(tree, node => node.type === 'button' && node.props?.className === 'proj-toggle')?.props?.['aria-expanded']).toBe(false)

    release()
    harness.dispose()
  })

  it('removes the project count and routes project/session rename and safe removal through DSH', async () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    const renameWorkspace = vi.fn(async (_id: string, title: string) => ({ ok: true as const, value: { workspace: { ...ctx.workspaceCatalog.getSnapshot().items[0]!, title } } }))
    const removeWorkspace = vi.fn(async () => ({ ok: true as const, value: { removed: true as const } }))
    const renameSession = vi.fn(async (_id: string, title: string) => ({ ok: true as const, value: { title } }))
    const archiveSession = vi.fn(async () => ({ ok: true as const, value: { archived: true as const } }))
    ctx.workspaceCatalog.renameWorkspace = renameWorkspace
    ctx.workspaceCatalog.removeWorkspace = removeWorkspace
    ctx.sessionCatalog.renameSession = renameSession
    ctx.sessionCatalog.archiveSession = archiveSession

    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.className === 'proj-count')).toBeUndefined()
    const compactSession = findNode(tree, node => node.props?.['data-session-id'] === 's1')
    const compactSessionButton = findNode(compactSession, node => node.type === 'button' && node.props?.className === 'sess')
    expect(compactSessionButton?.props?.title).toBe('整理交接\nC:\\work')
    expect(findNode(compactSession, node => node.props?.className === 't2')).toBeUndefined()
    expect(findNode(compactSession, node => node.props?.title === '编辑“整理交接”')).toBeDefined()

    const projectMenu = findNode(tree, node => node.props?.['aria-label'] === '工作区 项目操作')
    ;(projectMenu?.props?.onClick as () => void)()
    tree = harness.render(component!)
    ;(findNode(tree, node => node.type === 'button' && node.children.includes('重命名项目'))?.props?.onClick as () => void)()
    tree = harness.render(component!)
    const projectInput = findNode(tree, node => node.props?.['aria-label'] === '重命名项目 工作区')
    ;(projectInput?.props?.onChange as (event: unknown) => void)({ currentTarget: { value: '新项目' } })
    tree = harness.render(component!)
    const editedProjectInput = findNode(tree, node => node.props?.['aria-label'] === '重命名项目 工作区')
    ;(editedProjectInput?.props?.onKeyDown as (event: unknown) => void)({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
    await vi.waitFor(() => expect(renameWorkspace).toHaveBeenCalledWith('w1', '新项目'))

    tree = harness.render(component!)
    const sessionMenu = findNode(tree, node => node.props?.['aria-label'] === '整理交接 会话操作')
    ;(sessionMenu?.props?.onClick as () => void)()
    tree = harness.render(component!)
    ;(findNode(tree, node => node.type === 'button' && node.children.includes('重命名会话'))?.props?.onClick as () => void)()
    tree = harness.render(component!)
    const sessionInput = findNode(tree, node => node.props?.['aria-label'] === '重命名会话 整理交接')
    ;(sessionInput?.props?.onChange as (event: unknown) => void)({ currentTarget: { value: '新会话' } })
    tree = harness.render(component!)
    ;(findNode(tree, node => node.props?.['aria-label'] === '重命名会话 整理交接')?.props?.onKeyDown as (event: unknown) => void)({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
    await vi.waitFor(() => expect(renameSession).toHaveBeenCalledWith('s1', '新会话'))

    tree = harness.render(component!)
    ;(findNode(tree, node => node.props?.['aria-label'] === '整理交接 会话操作')?.props?.onClick as () => void)()
    tree = harness.render(component!)
    ;(findNode(tree, node => node.type === 'button' && node.children.includes('归档并移出列表'))?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(JSON.stringify(tree)).toContain('记录仍由 DSH 保存')
    ;(findNode(tree, node => node.type === 'button' && node.children.includes('归档会话'))?.props?.onClick as () => void)()
    await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledWith('s1'))

    tree = harness.render(component!)
    ;(findNode(tree, node => node.props?.['aria-label'] === '工作区 项目操作')?.props?.onClick as () => void)()
    tree = harness.render(component!)
    ;(findNode(tree, node => node.type === 'button' && node.children.includes('从侧栏移除'))?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(JSON.stringify(tree)).toContain('用户文件和会话日志都不会被删除')
    ;(findNode(tree, node => node.type === 'button' && node.children.includes('移除项目'))?.props?.onClick as () => void)()
    await vi.waitFor(() => expect(removeWorkspace).toHaveBeenCalledWith('w1'))

    release()
    harness.dispose()
  })

  it('reveals the active workspace once when a stored preference starts collapsed', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => key === WORKSPACE_GROUP_COLLAPSE_STORAGE_KEY ? '["w1"]' : null),
      setItem: vi.fn(),
    })
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })

    const release = apply(ctx, harness.react)
    harness.render(component!)
    const tree = harness.render(component!)
    expect(findNode(tree, node => node.type === 'button' && node.props?.className === 'proj-toggle')?.props?.['aria-expanded']).toBe(true)

    release()
    harness.dispose()
  })

  it('shows every pending approval and opens only real command actions', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    ctx.userApproval.getSnapshot = () => ({ approvals: [
      { key: 'a1', toolName: 'write_file', reason: '写入文件' },
      { key: 'a2', toolName: 'run_command', reason: '运行命令' },
    ] })
    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    expect(findNodes(tree, node => node.props?.['aria-label'] === '行动审批')).toHaveLength(2)
    expect(JSON.stringify(findNode(tree, node => node.props?.className === 'hint'))).toContain('Y 允许一次 · N 拒绝')
    expect(findNode(tree, node => node.props?.['aria-label'] === '打开命令面板')).toBeUndefined()
    const root = findNode(tree, node => node.props?.['data-xiaoshe-legacy-adapted'] === '')
    ;(root?.props?.onKeyDown as (event: unknown) => void)({ key: 'k', ctrlKey: true, preventDefault() {} })
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.['aria-label'] === '命令面板')).toBeDefined()
    expect(JSON.stringify(tree)).toContain('从当前会话分支')
    expect(JSON.stringify(tree)).not.toContain('图片入口由桌面能力插件提供')
    release()
    harness.dispose()
  })

  it('renders and answers a real pending question before approvals while locking ordinary input', async () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'blocked' } } })
    ctx.userApproval.getSnapshot = () => ({ approvals: [{ key: 'a1', toolName: 'bash', reason: '稍后审批' }] })
    ctx.userQuestionInteraction.getSnapshot = () => ({
      sessionId: 's1',
      requests: [{
        key: 'q:r1', sessionId: 's1', questions: [{
          id: 'scope', header: '确认范围', question: '要删除哪一组匹配行？', detail: '源文件输入仍会保留。',
          options: [{ label: '只删输出行（推荐）', description: '保留源文件输入' }, { label: '两组都删' }],
        }],
      }],
    })
    const answer = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
    ctx.userQuestionInteraction.answer = answer

    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    const card = findNode(tree, node => node.props?.['data-question-key'] === 'q:r1')
    expect(card).toBeDefined()
    expect(JSON.stringify(card)).toContain('要删除哪一组匹配行？')
    expect(JSON.stringify(card)).toContain('推荐')
    expect(findNode(tree, node => node.props?.['aria-label'] === '行动审批')).toBeUndefined()
    const composer = findNode(tree, node => node.props?.['aria-label'] === '输入消息')
    expect(composer?.props?.disabled).toBe(true)
    expect(composer?.props?.placeholder).toBe('请先回答上方问题')

    const option = findNode(card, node => node.props?.role === 'radio' && node.props?.['aria-checked'] === false)
    ;(option?.props?.onClick as () => void)()
    tree = harness.render(component!)
    const selected = findNode(tree, node => node.props?.role === 'radio' && node.props?.['aria-checked'] === true)
    expect(selected).toBeDefined()
    ;(findNode(tree, node => node.type === 'button' && node.children.includes('提交回答'))?.props?.onClick as () => void)()
    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith('q:r1', {
      answers: [{ id: 'scope', selected: ['只删输出行（推荐）'] }],
    }))

    release()
    harness.dispose()
  })

  it('keeps a malformed pending question visible and cancellable', async () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    ctx.userQuestionInteraction.getSnapshot = () => ({
      requests: [{ key: 'q:broken', sessionId: 's1', questions: [], error: '问题请求格式异常，可取消后让小蛇重试。' }],
    })
    const cancel = vi.fn(async () => ({ ok: true as const, value: { cancelled: true as const } }))
    ctx.userQuestionInteraction.cancel = cancel
    const release = apply(ctx, harness.react)
    const tree = harness.render(component!)
    expect(JSON.stringify(tree)).toContain('问题没有正确显示')
    ;(findNode(tree, node => node.type === 'button' && node.children.includes('取消请求'))?.props?.onClick as () => void)()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('q:broken'))
    release()
    harness.dispose()
  })

  it('opens and filters slash commands without sending command text to the model', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    const sendTurn = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
    ctx.agentRuntimeSession.sendTurn = sendTurn

    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    const textarea = findNode(tree, node => node.props?.['aria-label'] === '输入消息')
    const style = { height: '', overflowY: '' } as CSSStyleDeclaration
    ;(textarea?.props?.onInput as (event: unknown) => void)({ currentTarget: { value: '/mem', scrollHeight: 24, style } })
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.role === 'listbox' && node.props?.['aria-label'] === '斜杠命令')).toBeDefined()
    const commands = findNodes(tree, node => node.props?.role === 'option')
    expect(commands).toHaveLength(1)
    expect(commands[0]?.props?.['data-command']).toBe('/memory')
    ;(commands[0]?.props?.onClick as () => void)()

    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.['aria-label'] === '斜杠命令')).toBeUndefined()
    expect(findNode(tree, node => node.props?.role === 'tab' && node.children.includes('记忆'))?.props?.['aria-selected']).toBe(true)
    expect(sendTurn).not.toHaveBeenCalled()

    release()
    harness.dispose()
  })

  it('routes compact through the real Host command seam instead of sending it to the model', async () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    const execute = vi.fn(async () => ({ ok: true as const, value: { matched: true } }))
    const sendTurn = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
    ctx.sessionCommand.execute = execute
    ctx.agentRuntimeSession.sendTurn = sendTurn

    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    const textarea = findNode(tree, node => node.props?.['aria-label'] === '输入消息')
    ;(textarea?.props?.onInput as (event: unknown) => void)({ currentTarget: { value: '/compact', scrollHeight: 24, style: {} } })
    tree = harness.render(component!)
    const compact = findNode(tree, node => node.props?.['data-command'] === '/compact')
    ;(compact?.props?.onClick as () => void)()

    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith({ sessionId: 's1', line: '/compact' }))
    expect(sendTurn).not.toHaveBeenCalled()
    release()
    harness.dispose()
  })

  it('keeps runtime facts out of the composer hint and exposes one command-palette entry', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    const release = apply(ctx, harness.react)
    const tree = harness.render(component!)
    const hint = JSON.stringify(findNode(tree, node => node.props?.className === 'hint'))
    expect(hint).toContain('Enter 发送 · Shift+Enter 换行')
    expect(hint).not.toContain('上下文')
    expect(hint).not.toContain('事件')
    expect(hint).not.toContain('已连接')
    expect(hint).not.toContain('允许一次')
    expect(findNodes(tree, node => node.type === 'button' && node.children.includes(' 命令面板'))).toHaveLength(0)
    expect(JSON.stringify(tree)).not.toContain('任务 · 记忆 · 系统')
    expect(findNode(tree, node => node.props?.['aria-label'] === '打开命令面板')).toBeUndefined()
    release()
    harness.dispose()
  })

  it('edits, forgets, and restores revision-guarded memory through the Memory plugin', async () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    const remember = vi.fn(async () => ctx.memoryLifecycle.getSnapshot().memory)
    const setState = vi.fn(async () => ctx.memoryLifecycle.getSnapshot().memory)
    Object.assign(ctx.memoryLifecycle, { remember, setState })

    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    ;(findNode(tree, node => node.props?.role === 'tab' && node.children.includes('记忆'))?.props?.onClick as () => void)()
    tree = harness.render(component!)

    const editor = findNode(tree, node => node.props?.['aria-label'] === '记忆编辑器')
    expect(editor).toBeDefined()
    expect(JSON.stringify(tree)).toContain('默认使用中文')
    expect(JSON.stringify(tree)).toContain('当前项目使用插件架构')
    expect(JSON.stringify(tree)).toContain('已经遗忘的旧偏好')

    ;(findNode(editor, node => node.props?.['aria-label'] === '记忆内容')?.props?.onChange as (event: unknown) => void)({ currentTarget: { value: '新的长期偏好' } })
    tree = harness.render(component!)
    await (findNode(tree, node => node.props?.['aria-label'] === '记忆编辑器')?.props?.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} })
    expect(remember).toHaveBeenCalledWith({ scope: 'global', text: '新的长期偏好' }, 6)

    tree = harness.render(component!)
    const globalItem = findNode(tree, node => node.props?.['data-memory-id'] === 'memory-global')
    ;(findNode(globalItem, node => node.type === 'button' && node.children.includes('编辑'))?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.['aria-label'] === '记忆内容')?.props?.value).toBe('默认使用中文')
    ;(findNode(tree, node => node.props?.['aria-label'] === '记忆内容')?.props?.onChange as (event: unknown) => void)({ currentTarget: { value: '默认始终使用中文' } })
    tree = harness.render(component!)
    await (findNode(tree, node => node.props?.['aria-label'] === '记忆编辑器')?.props?.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} })
    expect(remember).toHaveBeenLastCalledWith({ scope: 'global', text: '默认始终使用中文', replaces_id: 'memory-global' }, 6)

    tree = harness.render(component!)
    ;(findNode(findNode(tree, node => node.props?.['data-memory-id'] === 'memory-project'), node => node.type === 'button' && node.children.includes('遗忘'))?.props?.onClick as () => void)()
    await Promise.resolve()
    expect(setState).toHaveBeenCalledWith('memory-project', 'forgotten', 6)

    tree = harness.render(component!)
    ;(findNode(findNode(tree, node => node.props?.['data-memory-id'] === 'memory-forgotten'), node => node.type === 'button' && node.children.includes('恢复'))?.props?.onClick as () => void)()
    await Promise.resolve()
    expect(setState).toHaveBeenCalledWith('memory-forgotten', 'active', 6)

    release()
    harness.dispose()
  })

  it('refreshes a conflicting memory revision without discarding the draft', async () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    const conflict = Object.assign(new Error('memory revision changed'), { status: 409, kind: 'revision_conflict' })
    const remember = vi.fn(async () => { throw conflict })
    const refresh = vi.fn(async () => ctx.memoryLifecycle.getSnapshot().memory)
    Object.assign(ctx.memoryLifecycle, { remember, refresh })

    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    ;(findNode(tree, node => node.props?.role === 'tab' && node.children.includes('记忆'))?.props?.onClick as () => void)()
    tree = harness.render(component!)
    refresh.mockClear()
    ;(findNode(tree, node => node.props?.['aria-label'] === '记忆内容')?.props?.onChange as (event: unknown) => void)({ currentTarget: { value: '不能丢失的草稿' } })
    tree = harness.render(component!)
    await (findNode(tree, node => node.props?.['aria-label'] === '记忆编辑器')?.props?.onSubmit as (event: unknown) => Promise<void>)({ preventDefault() {} })
    tree = harness.render(component!)

    expect(refresh).toHaveBeenCalledWith({ scope: 'all', project: 'C:\\work', include_inactive: true })
    expect(findNode(tree, node => node.props?.['aria-label'] === '记忆内容')?.props?.value).toBe('不能丢失的草稿')
    expect(JSON.stringify(tree)).toContain('已刷新，请重新确认后保存')

    release()
    harness.dispose()
  })

  it('declares and renders the plugin-owned settings seat in the old sidebar foot', () => {
    type ShellProps = { readonly renderSlot: (name: string, props: Record<string, unknown>) => unknown }
    let component: ((props?: ShellProps) => unknown) | undefined
    let registration: Record<string, unknown> | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (options, value) => {
        registration = options as unknown as Record<string, unknown>
        component = value as (props?: ShellProps) => unknown
        return () => { component = undefined }
      },
    })
    const renderSlot = vi.fn((name: string, props: Record<string, unknown>) => ({ type: 'div', props: { 'data-settings-seat': name, ...props }, children: [] }))

    const release = apply(ctx, harness.react)
    const tree = harness.render(() => component?.({ renderSlot }))

    expect(registration?.children).toEqual({ 'sidebar.settings': { kind: 'single', scope: 'root' } })
    expect(renderSlot).toHaveBeenCalledWith('sidebar.settings', { wide: true })
    expect(findNode(tree, node => node.props?.['data-settings-seat'] === 'sidebar.settings')).toBeDefined()
    expect(JSON.stringify(tree)).not.toContain('命令面板')

    release()
    harness.dispose()
  })

  it('contributes real security, shortcut, and diagnostics pages through settings slots', () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem })
    const registrations: Array<{ options: Record<string, unknown>; component: () => unknown }> = []
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (options, value) => {
        registrations.push({
          options: options as unknown as Record<string, unknown>,
          component: value as () => unknown,
        })
        return () => {}
      },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })

    const release = apply(ctx, harness.react)
    const settingsHeader = registrations.find(entry => entry.options.name === 'settings.header')
    expect(settingsHeader?.options).toMatchObject({ id: 'xiaoshe-settings-header', priority: -1200 })
    const headerTree = harness.render(settingsHeader!.component)
    expect(findNode(headerTree, node => node.props?.className === 'xsla-settings-brand-mark')?.props?.['aria-label']).toBe('小蛇')
    expect(JSON.stringify(headerTree)).toContain('设置中心')

    const composerPreference = registrations.find(entry => entry.options.name === 'settings.general.item')
    expect(composerPreference?.options).toMatchObject({ id: 'xiaoshe-composer-enter', order: 18 })
    let preferenceTree = harness.render(composerPreference!.component)
    expect(JSON.stringify(preferenceTree)).toContain('Enter 发送')
    const ctrlEnter = findNode(preferenceTree, node => node.type === 'button' && node.children.includes('Ctrl+Enter 发送'))
    ;(ctrlEnter?.props?.onClick as () => void)()
    preferenceTree = harness.render(composerPreference!.component)
    expect(ctrlEnter).toBeDefined()
    expect(findNode(preferenceTree, node => node.type === 'button' && node.children.includes('Ctrl+Enter 发送'))?.props?.['aria-checked']).toBe(true)
    expect(setItem).toHaveBeenCalledWith(COMPOSER_ENTER_STORAGE_KEY, 'ctrl-enter-send')
    ;(findNode(preferenceTree, node => node.type === 'button' && node.children.includes('Enter 发送'))?.props?.onClick as () => void)()

    const sections = registrations.filter(entry => entry.options.name === 'settings.section')
    expect(sections.map(entry => entry.options.id)).toEqual([
      'security',
      'shortcuts',
      'about',
    ])
    expect(sections.map(entry => entry.options.label)).toEqual([
      '权限与安全',
      '快捷键',
      '高级与关于',
    ])

    const securityTree = harness.render(sections[0]!.component)
    expect(JSON.stringify(securityTree)).toContain('当前会话权限')
    expect(JSON.stringify(securityTree)).toContain('工作区写入')
    expect(JSON.stringify(securityTree)).toContain('不提供无效的跨会话默认权限开关')
    expect(findNode(securityTree, node => node.props?.className === 'xsla-settings-badge')?.children).toContain('工作区写入')

    const shortcutsTree = harness.render(sections[1]!.component)
    expect(JSON.stringify(shortcutsTree)).toContain('Ctrl K')
    expect(JSON.stringify(shortcutsTree)).toContain('Shift+Enter')
    expect(JSON.stringify(shortcutsTree)).toContain('斜杠命令')

    const aboutTree = harness.render(sections[2]!.component)
    const aboutMark = findNode(aboutTree, node => node.props?.className === 'xsla-about-mark')
    expect(aboutMark?.type).toBe('svg')
    expect(aboutMark?.props?.['aria-label']).toBe('小蛇')
    expect(aboutMark?.children).not.toContain('S')
    expect(platformLogLocation('darwin')).toBe('~/Library/Logs/小蛇')
    expect(platformLogLocation('win32')).toBe('%LOCALAPPDATA%\\Xiaoshe\\Logs')
    expect(platformLogLocation('linux')).toBe('~/.local/state/xiaoshe/logs')

    const rootRegistration = registrations.at(-1)?.options
    expect(rootRegistration?.name).toBe('root')
    expect(rootRegistration?.children).toEqual({ 'sidebar.settings': { kind: 'single', scope: 'root' } })

    release()
    harness.dispose()
  })

  it('opens plugin governance in the old modal layer and closes without mutation', async () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    const release = apply(ctx, harness.react)
    let tree = harness.render(component!)
    const manage = findNode(tree, node => node.type === 'button' && node.children.includes('管理插件'))
    expect(manage).toBeDefined()
    ;(manage?.props?.onClick as () => void)()
    // The inventory is supplied asynchronously by plugin governance; settle
    // that public-service read before asserting the grouped presentation.
    await Promise.resolve()
    tree = harness.render(component!)
    const dialog = findNode(tree, node => node.props?.role === 'dialog' && node.props?.['aria-label'] === '插件管理')
    expect(dialog).toBeDefined()
    const serialized = JSON.stringify(dialog)
    expect(serialized).not.toContain('private-token-not-rendered')
    expect(serialized).not.toContain('Host 插件')
    expect(serialized).not.toContain('目标 Profile')
    expect(serialized).not.toContain('xiaoshe-managed-lab')
    expect(serialized).not.toContain('受信任')
    expect(serialized).toContain('Host 进程')
    expect(serialized).toContain('没有独立的系统沙箱')
    expect(findNode(dialog, node => node.type === 'details' && node.props?.className === 'plugin-inventory')?.props?.open).toBe(true)
    expect(findNode(dialog, node => node.type === 'details' && node.props?.className === 'plugin-inventory-group')).toBeDefined()

    const close = findNode(tree, node => node.type === 'button' && node.children.includes('关闭'))
    ;(close?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.role === 'dialog' && node.props?.['aria-label'] === '插件管理')).toBeUndefined()

    release()
    harness.dispose()
  })

  it('opens the same editable memory draft in a full-size editor', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    const release = apply(ctx, harness.react)

    let tree = harness.render(component!)
    const expand = findNode(tree, node => node.type === 'button' && node.children.includes('放大编辑'))
    expect(expand).toBeDefined()
    ;(expand?.props?.onClick as () => void)()
    tree = harness.render(component!)
    const editor = findNode(tree, node => node.props?.role === 'dialog' && node.props?.['aria-label'] === '完整记忆编辑器')
    expect(editor).toBeDefined()
    expect(findNode(editor, node => node.props?.['aria-label'] === '完整记忆内容')).toBeDefined()

    ;(findNode(editor, node => node.type === 'button' && node.children.includes('返回侧栏'))?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.['aria-label'] === '完整记忆编辑器')).toBeUndefined()

    release()
    harness.dispose()
  })

  it('closes an overlay rail instead of leaving a collapsed mobile blocker', () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    })
    const release = apply(ctx, harness.react)

    let tree = harness.render(component!)
    const inspectorToggle = findNode(tree, node => node.props?.['aria-controls'] === 'xsla-insp')
    ;(inspectorToggle?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.id === 'xsla-insp')?.props?.className).toBe('insp mobile-open')

    const overlayCollapse = findNode(tree, node => node.props?.['aria-label'] === '收缩状态面板')
    ;(overlayCollapse?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.id === 'xsla-insp')?.props?.className).toBe('insp')
    expect(findNode(tree, node => node.props?.className === 'overlay-scrim')).toBeUndefined()

    const desktopCollapse = findNode(tree, node => node.props?.['aria-label'] === '收缩状态面板')
    ;(desktopCollapse?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.id === 'xsla-insp')?.props?.className).toBe('insp collapsed')

    ;(findNode(tree, node => node.props?.['aria-controls'] === 'xsla-insp')?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.id === 'xsla-insp')?.props?.className).toBe('insp mobile-open')

    const root = findNode(tree, node => node.props?.['data-xiaoshe-legacy-adapted'] === '')
    const onRootKeyDown = root?.props?.onKeyDown as (event: unknown) => void
    onRootKeyDown({ key: 'Escape', target: { closest: () => ({ role: 'dialog' }) } })
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.id === 'xsla-insp')?.props?.className).toBe('insp mobile-open')

    onRootKeyDown({ key: 'Escape', target: { closest: () => null } })
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.id === 'xsla-insp')?.props?.className).toBe('insp')

    release()
    harness.dispose()
  })
})
