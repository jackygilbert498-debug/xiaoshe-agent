import type { LegacyAdaptedClientContext } from '../src/client/index.js'

export function contextFixture(
  slots: LegacyAdaptedClientContext['slots'],
  runtime: {
    currentSessionId?: string
    sessions: Record<string, {
      state: string
      completionReceipt?: { outcome?: string; sourceSeq?: number }
      imageInputLimits?: {
        maxImageBytes: number; maxImagesPerMessage: number; maxMessageImageBytes: number
        maxImagePixels: number; maxImageDimension: number
        mediaTypes: readonly ('image/png' | 'image/jpeg' | 'image/webp' | 'image/gif')[]
      }
    }>
  } = { sessions: {} },
): LegacyAdaptedClientContext {
  const source = { getSnapshot: () => runtime, subscribe: (_listener: () => void) => () => {} }
  return {
    slots,
    theme: {
      getTheme: () => ({ preference: 'dark', active: { id: 'dark', colorScheme: 'dark' }, revision: 1 }),
      setTheme: () => {},
    },
    on: () => () => {},
    agentRuntimeSession: {
      ...source,
      sendTurn: async () => ({ ok: true, value: { accepted: true } }),
      stopRun: async () => ({ ok: true, value: { accepted: true } }),
      forkSession: async () => ({ ok: true, value: { sessionId: 'fork' } }),
    },
    sessionCommand: {
      execute: async () => ({ ok: true, value: { matched: true } }),
    },
    sessionCatalog: {
      getSnapshot: () => ({
        sessions: {
          s1: { sessionId: 's1', title: '整理交接', cwd: 'C:\\work', updatedAt: 2 },
          s2: { sessionId: 's2', title: '检查方案', updatedAt: 1 },
        },
      }),
      subscribe: () => () => {},
      createLooseSession: async () => ({ ok: true, value: { sessionId: 'new' } }),
      openSession: () => ({ ok: true, value: { opened: true } }),
      renameSession: async (_sessionId, title) => ({ ok: true, value: { title: title.trim() } }),
      archiveSession: async () => ({ ok: true, value: { archived: true } }),
      search: async () => ({ ok: true, value: { items: [] } }),
    },
    taskTimeline: {
      getSnapshot: () => ({
        items: [
          { key: 'u1', seq: 1, time: 1, kind: 'user', text: '完成交接' },
          { key: 'v1', seq: 2, time: 2, kind: 'status', text: '验证通过' },
        ],
      }),
      subscribe: () => () => {},
      loadEarlier: () => {},
    },
    workSurfaceRegistry: {
      getSnapshot: () => ({ ...(runtime.currentSessionId === undefined ? {} : { sessionId: runtime.currentSessionId }), items: [] }),
      subscribe: () => () => {},
    },
    contextGovernance: {
      getSnapshot: () => ({ sessions: { s1: {
        pressure: { projectedTokens: 72_000, contextWindow: 128_000 },
        budget: { source: 'dsh-token-meter', usedTokens: 72_000, capacityTokens: 128_000, ratio: 0.5625, level: 'normal' },
        usage: { uncachedInputTokens: 1_000, outputTokens: 500, cacheReadTokens: 99_000, cacheWriteTokens: 20 },
        compactions: [],
      } } }),
      subscribe: () => () => {},
    },
    modelCatalog: {
      getSnapshot: () => ({
        sessionId: 's1', status: 'ready', current: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' }, routable: true,
        groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{
          id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', defaultEffort: 'high',
          efforts: [
            { id: 'off', name: 'Off', description: '关闭额外推理' },
            { id: 'low', name: '低', description: '更快的简短思考' },
            { id: 'high', name: '高', description: '更充分地分析任务' },
            { id: 'max', name: '最大', description: '最深入推理，耗时更长' },
          ],
        }] }], failures: [],
      }),
      subscribe: () => () => {},
      refresh: async () => ({ ok: true, value: { status: 'ready', groups: [], failures: [] } }),
      select: async input => ({ ok: true, value: { selected: input } }),
    },
    workspaceCatalog: {
      getSnapshot: () => ({
        state: 'ready', archivedSessionIds: [],
        items: [{ workspaceId: 'w1', path: 'C:\\work', title: '工作区', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
      }),
      subscribe: () => () => {},
      addFromNativePicker: async () => ({ ok: true, value: { cancelled: true } }),
      createAndOpenSession: async () => ({ ok: true, value: { sessionId: 'workspace-session' } }),
      renameWorkspace: async (_workspaceId, title) => ({ ok: true, value: { workspace: { workspaceId: 'w1', path: 'C:\\work', title: title.trim(), sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } } }),
      removeWorkspace: async () => ({ ok: true, value: { removed: true } }),
    },
    userApproval: {
      getSnapshot: () => ({ approvals: [] }),
      subscribe: () => () => {},
      answer: async () => ({ ok: true, value: { accepted: true } }),
    },
    userQuestionInteraction: {
      getSnapshot: () => ({ requests: [] }),
      subscribe: () => () => {},
      answer: async () => ({ ok: true, value: { accepted: true } }),
      cancel: async () => ({ ok: true, value: { cancelled: true } }),
    },
    permissionPresets: {
      getSnapshot: () => ({
        sessionId: 's1', status: 'ready', currentValue: 'workspace-write',
        options: [
          { value: 'read-only', name: 'Read only', description: '禁止写入' },
          { value: 'workspace-write', name: 'Workspace write', description: '仅允许工作区写入' },
          { value: 'danger-full-access', name: 'Full access', description: '完全访问文件系统' },
        ],
      }),
      subscribe: () => () => {},
      select: async value => ({ ok: true, value: { selected: value } }),
    },
    pluginGovernance: {
      listHostPlugins: async () => ({
        ok: true,
        value: { entries: [{ moduleName: '@xiaoshe/memory', fiberPhase: 'active' }] },
      }),
      auditCandidate: async () => ({
        ok: true,
        value: {
          candidate: {
            id: 'candidate-1', packageName: '@x/demo', version: '1.0.0',
            sha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
            identity: { displayName: '演示插件', description: '测试插件治理界面', developer: 'Example Studio', license: 'MIT', keywords: [] },
            provenance: { kind: 'registry', selection: 'exact-version', label: '软件源 @x/demo@1.0.0', assurance: 'unverified' },
            audit: { valid: true, risk: 'high' }, osSandboxEnforced: false,
          },
        },
      }),
      prepareChange: async () => ({
        ok: true,
        value: {
          challenge: {
            id: 'challenge-1', token: 'private-token-not-rendered',
            expiresAt: '2026-08-26T06:00:00.000Z', action: 'add',
            profile: 'xiaoshe-managed-lab', packageName: '@x/demo', version: '1.0.0',
            identity: { displayName: '演示插件', description: '测试插件治理界面', developer: 'Example Studio', license: 'MIT', keywords: [] },
            provenance: { kind: 'registry', selection: 'exact-version', label: '软件源 @x/demo@1.0.0', assurance: 'unverified' },
            disclosures: ['来源核验：未签名', 'Host 进程内运行；系统沙箱未启用'], osSandboxEnforced: false,
          },
        },
      }),
      confirmChange: async () => ({
        ok: true,
        value: {
          transaction: {
            id: 'tx-1', action: 'add', profile: 'xiaoshe-managed-lab',
            packageName: '@x/demo', version: '1.0.0', state: 'healthy',
            consent: { confirmed: true, expiresAt: 1 }, osSandboxEnforced: false,
          },
        },
      }),
      getSnapshot: () => ({
        status: 'ready', pendingRequests: 0,
        transactions: [{ state: 'healthy', action: 'add', packageName: '@x/a', profile: 'candidate' }],
      }),
      subscribe: () => () => {},
      refreshTransactions: async () => undefined,
    },
    memoryLifecycle: {
      getSnapshot: () => ({
        status: 'ready',
        memory: {
          api_version: 1,
          revision: 6,
          counts: { active: 2, global: 1, project: 1, forgotten: 1, superseded: 0 },
          entries: [
            { id: 'memory-global', scope: 'global', text: '默认使用中文', state: 'active', version: 1, created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-20T00:00:00Z' },
            { id: 'memory-project', scope: 'project', project: 'C:\\work', text: '当前项目使用插件架构', state: 'active', version: 2, created_at: '2026-08-21T00:00:00Z', updated_at: '2026-08-22T00:00:00Z' },
            { id: 'memory-forgotten', scope: 'global', text: '已经遗忘的旧偏好', state: 'forgotten', version: 1, created_at: '2026-08-19T00:00:00Z', updated_at: '2026-08-23T00:00:00Z' },
          ],
          audit: [],
          usage: [],
        },
      }),
      subscribe: () => () => {},
      refresh: async () => undefined as never,
      remember: async () => undefined as never,
      setState: async () => undefined as never,
    },
    productHealth: {
      getSnapshot: () => ({
        status: 'ready',
        value: {
          heartbeat: { schemaVersion: 2, status: 'healthy', running: false, checks: [] },
          desktop: {
            api_version: 1, product: '小蛇', version: '0.2.0',
            bridge: { state: 'ready', platform: 'win32', protocol: '1' },
            actions: { persistent: true, enabled: true, deployment_allowed: true },
          },
        },
      }),
      subscribe: () => () => {},
      refresh: async () => ({ status: 'ready', value: {} }),
    },
  }
}

export function reactFixture() {
  return {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
    useState: <T>(initial: T): [T, (_value: T | ((current: T) => T)) => void] => [initial, () => {}],
    useRef: <T>(initial: T) => ({ current: initial }),
    useEffect: (effect: () => void | (() => void)) => { effect() },
  }
}
