import { describe, expect, it } from 'vitest'
import {
  apply,
  canEmbedWorkSurfaceInShell,
  dismissWorkSurface,
  parseWorkSurfaceDockPreference,
  reconcileWorkSurfaceDockPreference,
  updateWorkSurfaceDockPreferenceStore,
  workSurfaceDockWidth,
  WORK_SURFACE_DOCK_LIMITS,
  type WorkSurfaceDockPreference,
} from '../src/client/index.js'
import { contextFixture } from './fixture.js'

interface TreeNode {
  readonly type: unknown
  readonly props: Record<string, unknown> | null
  readonly children: readonly unknown[]
}

const closed: WorkSurfaceDockPreference = {
  open: false, width: 420, pinnedIds: [], dismissedIds: [], knownIds: [], mode: 'watch',
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

describe('work surface dock', () => {
  it('treats persisted state as untrusted and bounds session history', () => {
    expect(parseWorkSurfaceDockPreference('not-json', 's1')).toEqual(closed)
    const malicious = JSON.stringify({
      version: 1,
      sessions: [{ id: 's1', preference: {
        open: true, width: 99_999, mode: 'take-over', activeId: 'x',
        pinnedIds: ['x', 'x', 2], dismissedIds: ['z'], knownIds: Array.from({ length: 100 }, (_, index) => `id-${index}`),
      } }],
    })
    expect(parseWorkSurfaceDockPreference(malicious, 's1')).toMatchObject({
      open: true, width: WORK_SURFACE_DOCK_LIMITS.max, mode: 'watch', activeId: 'x', pinnedIds: ['x'], dismissedIds: ['z'],
    })
    expect(parseWorkSurfaceDockPreference(malicious, 's1').knownIds).toHaveLength(64)

    let stored: string | undefined
    for (let index = 0; index < 48; index += 1) {
      stored = updateWorkSurfaceDockPreferenceStore(stored, `session-${index}`, closed)
    }
    expect((JSON.parse(stored!) as { sessions: unknown[] }).sessions).toHaveLength(40)
  })

  it('opens for genuinely new results, remembers a closed result and preserves the source of truth', () => {
    const opened = reconcileWorkSurfaceDockPreference(closed, [{ id: 'file-1' }, { id: 'terminal-2' }])
    expect(opened).toMatchObject({ open: true, activeId: 'terminal-2', knownIds: ['file-1', 'terminal-2'] })

    const dismissed = reconcileWorkSurfaceDockPreference(dismissWorkSurface(opened, 'terminal-2'), [{ id: 'file-1' }, { id: 'terminal-2' }])
    expect(dismissed).toMatchObject({ open: true, activeId: 'file-1', dismissedIds: ['terminal-2'] })
    expect(reconcileWorkSurfaceDockPreference({ ...dismissed, open: false }, [{ id: 'file-1' }, { id: 'terminal-2' }]).open).toBe(false)
    expect(reconcileWorkSurfaceDockPreference({ ...dismissed, open: false }, [{ id: 'file-1' }, { id: 'terminal-2' }, { id: 'web-3' }])).toMatchObject({ open: true, activeId: 'web-3' })
  })

  it('keeps a useful conversation width while resizing the internal split', () => {
    expect(workSurfaceDockWidth(12)).toBe(WORK_SURFACE_DOCK_LIMITS.min)
    expect(workSurfaceDockWidth(900)).toBe(WORK_SURFACE_DOCK_LIMITS.max)
    expect(workSurfaceDockWidth(700, 860)).toBe(500)
    expect(workSurfaceDockWidth(500, 620)).toBe(WORK_SURFACE_DOCK_LIMITS.min)
  })

  it('never embeds a local page that shares the shell origin', () => {
    expect(canEmbedWorkSurfaceInShell('http://127.0.0.1:6181/tool', 'http://127.0.0.1:3080')).toBe(true)
    expect(canEmbedWorkSurfaceInShell('http://127.0.0.1:3080/tool', 'http://127.0.0.1:3080')).toBe(false)
    expect(canEmbedWorkSurfaceInShell('not-a-url', 'http://127.0.0.1:3080')).toBe(false)
  })

  it('renders a loopback page behind an explicit observation guard', () => {
    let root: (() => unknown) | undefined
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (options, component) => {
        if (options.name === 'root') root = component as () => unknown
        return () => { if (options.name === 'root') root = undefined }
      },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'idle' } } })
    ctx.workSurfaceRegistry = {
      getSnapshot: () => ({ sessionId: 's1', items: [{
        id: 's1:web', sessionId: 's1', callId: 'web', seq: 7, updatedAt: 7,
        type: 'web', title: '本地结果', source: 'http://127.0.0.1:6181/', status: 'ready', trust: 'loopback',
        capabilities: { embedded: true, interactive: true, refresh: true, externalOpen: true, copySource: true, pinnable: true },
        view: { kind: 'web', url: 'http://127.0.0.1:6181/', embed: 'loopback' },
      }] }),
      subscribe: () => () => {},
    }
    const react = {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props, children }),
      useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
      useState: <T>(initial: T): [T, (_value: T | ((current: T) => T)) => void] => [initial, () => {}],
      useRef: <T>(initial: T) => ({ current: initial }),
      useEffect: (_effect: () => void | (() => void), _dependencies: readonly unknown[]) => {},
    }
    const release = apply(ctx, react)
    const tree = root?.()
    const dock = findNode(tree, node => node.props?.id === 'xsla-work-surface-dock')
    const iframe = findNode(dock, node => node.type === 'iframe')
    const guard = findNode(dock, node => node.props?.className === 'surface-web-guard')
    expect(dock).toBeDefined()
    expect(iframe?.props).toMatchObject({
      src: 'http://127.0.0.1:6181/',
      sandbox: 'allow-downloads allow-forms allow-same-origin allow-scripts',
      referrerPolicy: 'no-referrer', tabIndex: -1,
    })
    expect(JSON.stringify(guard)).toContain('观察中')
    expect(JSON.stringify(dock)).toContain('由你操作')
    release()
  })
})
