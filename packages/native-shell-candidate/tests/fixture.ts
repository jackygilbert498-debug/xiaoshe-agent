import type { NativeShellCandidateClientContext } from '../src/client/index.js'

export function contextFixture(
  slots: NativeShellCandidateClientContext['slots'],
  runtime: { currentSessionId?: string; sessions: Record<string, { state: string; completionReceipt?: { outcome?: string; sourceSeq?: number } }> } = { sessions: {} },
): NativeShellCandidateClientContext {
  const source = { getSnapshot: () => runtime, subscribe: (_listener: () => void) => () => {} }
  return {
    slots,
    agentRuntimeSession: {
      ...source,
      sendTurn: async () => ({ ok: true, value: { accepted: true } }),
      stopRun: async () => ({ ok: true, value: { accepted: true } }),
      forkSession: async () => ({ ok: true, value: { sessionId: 'fork' } }),
    },
    sessionCatalog: {
      getSnapshot: () => ({ sessions: { s1: { sessionId: 's1', title: '整理交接', cwd: 'C:\\work', updatedAt: 2 } } }),
      subscribe: () => () => {},
      createLooseSession: async () => ({ ok: true, value: { sessionId: 'new' } }),
      openSession: () => ({ ok: true, value: { opened: true } }),
      search: async () => ({ ok: true, value: { items: [] } }),
    },
    taskTimeline: {
      getSnapshot: () => ({ items: [{ key: 'u1', kind: 'user', text: '完成交接' }, { key: 'v1', kind: 'status', text: '验证通过' }] }),
      subscribe: () => () => {},
    },
    contextGovernance: { getSnapshot: () => ({ sessions: { s1: { pressure: 'normal', budget: { remaining: 42 } } } }), subscribe: () => () => {} },
    userApproval: { getSnapshot: () => ({ approvals: [] }), subscribe: () => () => {}, answer: async () => ({ ok: true, value: { accepted: true } }) },
    pluginGovernance: {
      listHostPlugins: async () => ({ ok: true, value: { entries: [{ moduleName: '@xiaoshe/memory', fiberPhase: 'active' }] } }),
      auditCandidate: async () => ({ ok: true, value: { candidate: { id: 'candidate-1', packageName: '@x/demo', version: '1.0.0', sha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), audit: { valid: true, risk: 'high' }, osSandboxEnforced: false } } }),
      prepareChange: async () => ({ ok: true, value: { challenge: { id: 'challenge-1', token: 'private-token-not-rendered', expiresAt: '2026-08-25T06:00:00.000Z', action: 'add', profile: 'xiaoshe-managed-lab', packageName: '@x/demo', version: '1.0.0', disclosures: ['受信任 Host 代码'], osSandboxEnforced: false } } }),
      confirmChange: async () => ({ ok: true, value: { transaction: { id: 'tx-1', action: 'add', profile: 'xiaoshe-managed-lab', packageName: '@x/demo', version: '1.0.0', state: 'healthy', consent: { confirmed: true, expiresAt: 1 }, osSandboxEnforced: false } } }),
      getSnapshot: () => ({ status: 'ready', transactions: [{ state: 'healthy', action: 'add', packageName: '@x/a', profile: 'candidate' }], pendingRequests: 0 }),
      subscribe: () => () => {},
      refreshTransactions: async () => undefined,
    },
    memoryLifecycle: {
      getSnapshot: () => ({ status: 'ready', memory: { revision: 6, counts: { active: 2, global: 1, project: 1, forgotten: 0, superseded: 0 }, entries: [{ scope: 'global', state: 'active' }, { scope: 'project', state: 'active' }] } }),
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
