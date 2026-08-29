import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  composerKeyAction,
  pluginChallengePresentation,
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
  let effectCursor = 0
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('V6 interaction contracts', () => {
  it('submits plain Enter while preserving Shift+Enter and IME composition', () => {
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, isComposing: false })).toBe('submit')
    expect(composerKeyAction({ key: 'Enter', shiftKey: true, isComposing: false })).toBe('newline')
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, isComposing: true })).toBe('newline')
    expect(composerKeyAction({ key: 'Escape', shiftKey: false, isComposing: false })).toBe('ignore')
  })

  it('redacts the one-time token from every prepared plugin presentation', () => {
    const view = pluginChallengePresentation({
      id: 'challenge-1', token: 'private-token-not-rendered',
      expiresAt: '2026-08-26T06:00:00.000Z', action: 'add',
      profile: 'xiaoshe-managed-lab', packageName: '@x/demo', version: '1.0.0',
      disclosures: ['受信任 Host 代码'], osSandboxEnforced: false,
    })
    expect(view).toEqual({
      heading: 'add @x/demo@1.0.0',
      facts: ['Profile xiaoshe-managed-lab', '到期 2026-08-26T06:00:00.000Z', 'OS sandbox false'],
      disclosures: ['受信任 Host 代码'],
    })
    expect(JSON.stringify(view)).not.toContain('private-token-not-rendered')
  })

  it('routes stop and project-scoped memory through their public services', async () => {
    let component: (() => unknown) | undefined
    const harness = hookHarness()
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'running' } } })
    const stopRun = vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } }))
    const refresh = vi.fn(async () => undefined)
    ctx.agentRuntimeSession.stopRun = stopRun
    ctx.memoryLifecycle.refresh = refresh

    const release = apply(ctx, harness.react)
    const tree = harness.render(component!)
    const stop = findNode(tree, node => node.props?.title === '停止当前任务')
    expect(stop).toBeDefined()
    await (stop?.props?.onClick as () => Promise<void> | void)()
    expect(stopRun).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(refresh).toHaveBeenCalledWith({ scope: 'all', project: 'C:\\work', include_inactive: false })

    release()
    harness.dispose()
  })

  it('opens plugin governance in the old modal layer and closes without mutation', () => {
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
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.role === 'dialog' && node.props?.['aria-label'] === '插件管理')).toBeDefined()
    expect(JSON.stringify(tree)).not.toContain('private-token-not-rendered')

    const close = findNode(tree, node => node.type === 'button' && node.children.includes('关闭'))
    ;(close?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.role === 'dialog' && node.props?.['aria-label'] === '插件管理')).toBeUndefined()

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
    const inspectorToggle = findNode(tree, node => node.props?.['aria-controls'] === 'xsv6-insp')
    ;(inspectorToggle?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.id === 'xsv6-insp')?.props?.className).toBe('insp mobile-open')

    const overlayCollapse = findNode(tree, node => node.props?.['aria-label'] === '收缩状态面板')
    ;(overlayCollapse?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.id === 'xsv6-insp')?.props?.className).toBe('insp')
    expect(findNode(tree, node => node.props?.className === 'overlay-scrim')).toBeUndefined()

    const desktopCollapse = findNode(tree, node => node.props?.['aria-label'] === '收缩状态面板')
    ;(desktopCollapse?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.id === 'xsv6-insp')?.props?.className).toBe('insp collapsed')

    ;(findNode(tree, node => node.props?.['aria-controls'] === 'xsv6-insp')?.props?.onClick as () => void)()
    tree = harness.render(component!)
    expect(findNode(tree, node => node.props?.id === 'xsv6-insp')?.props?.className).toBe('insp mobile-open')

    release()
    harness.dispose()
  })
})
