import type { NativeShellClientContext } from '../src/client/index.js'

export function contextFixture(slots: NativeShellClientContext['slots'], runtime: { currentSessionId?: string; sessions: Record<string, { state: string; completionReceipt?: { outcome?: string; sourceSeq?: number } }> } = { sessions: {} }): NativeShellClientContext {
  const source = { getSnapshot: () => runtime, subscribe: (_listener: () => void) => () => {} }
  return {
    slots,
    agentRuntimeSession: { ...source, sendTurn: async () => ({ ok: true }), stopRun: async () => ({ ok: true }), forkSession: async () => ({ ok: true, value: { sessionId: 'fork' } }) },
    sessionCatalog: { getSnapshot: () => ({ sessions: {} }), subscribe: () => () => {}, createLooseSession: async () => ({ ok: true, value: { sessionId: 'new' } }), openSession: () => ({ ok: true }), search: async () => ({ ok: true, value: { items: [] } }) },
    taskTimeline: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
    contextGovernance: { getSnapshot: () => ({ sessions: {} }), subscribe: () => () => {} },
    userApproval: { getSnapshot: () => ({ approvals: [] }), subscribe: () => () => {}, answer: async () => ({ ok: true, value: { accepted: true } }) },
    pluginGovernance: {
      listHostPlugins: async () => ({ ok: true, value: { entries: [] } }),
      getSnapshot: () => ({ status: 'ready', transactions: [], pendingRequests: 0 }),
      subscribe: () => () => {},
      refreshTransactions: async () => undefined,
    },
    memoryLifecycle: {
      getSnapshot: () => ({
        status: 'ready',
        memory: {
          revision: 4,
          counts: { active: 2, global: 1, project: 1, forgotten: 0, superseded: 1 },
        },
      }),
      subscribe: () => () => {},
      refresh: async () => undefined,
    },
  }
}

export function reactFixture() {
  return {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
    useState: <T>(initial: T): [T, (_value: T | ((current: T) => T)) => void] => [initial, () => {}],
    useEffect: (effect: () => void | (() => void)) => { effect() },
  }
}
