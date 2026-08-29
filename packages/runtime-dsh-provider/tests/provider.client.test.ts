import { describe, expect, it } from 'vitest'
import {
  DshAgentRuntimeSession,
  DshContextGovernance,
  DshModelCatalog,
  parseDshImageInputLimits,
  DshPermissionPresets,
  DshSessionCommand,
  DshSessionCatalog,
  DshTaskTimeline,
  DshUserApproval,
  DshUserQuestions,
  DshWorkspaceCatalog,
} from '../src/client/index.js'

describe('DSH AgentRuntimeSession provider', () => {
  it('maps public sessions/workspaces operations and list facts', async () => {
    const state = fixture()
    const runtime = new DshAgentRuntimeSession(state.sessions, state.workspaces)
    expect(runtime.getSnapshot()).toBe(runtime.getSnapshot())
    expect(runtime.getSnapshot().sessions.s1).toMatchObject({ sessionId: 's1', state: 'blank' })
    expect(runtime.getSnapshot().sessions.s1?.completionReceipt).toEqual({ outcome: 'verified', sourceSeq: 9 })
    expect(runtime.getSnapshot().sessions.s1?.imageInputLimits).toMatchObject({ maxImageBytes: 3_670_016, maxImagesPerMessage: 20 })
    await expect(runtime.createSession({ workspaceId: 'w1' })).resolves.toEqual({ ok: true, value: { sessionId: 's2' } })
    await expect(runtime.createSession({})).resolves.toMatchObject({ ok: false, error: { kind: 'unsupported' } })
    await expect(runtime.sendTurn({ sessionId: 's1', content: 'hello', mode: 'queue' }))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    await expect(runtime.stopRun({ sessionId: 's1' })).resolves.toEqual({ ok: true, value: { accepted: true } })
    await expect(runtime.forkSession({ sessionId: 's1', atSourceSeq: 8 }))
      .resolves.toEqual({ ok: true, value: { sessionId: 'fork-1' } })
    expect(state.calls).toEqual([
      ['connect', 'w1'], ['prompt', [{ type: 'text', text: 'hello' }], 'queue'],
      ['cancel'], ['fork', { sessionId: 's1', atSeq: 8, increaseTitle: false }],
    ])
    runtime.dispose()
    expect(state.subscriptionCount()).toBe(0)
  })

  it('passes image and text parts to the public DSH prompt face without a product-side fake upload', async () => {
    const state = fixture()
    const runtime = new DshAgentRuntimeSession(state.sessions, state.workspaces)
    await expect(runtime.sendTurn({
      sessionId: 's1', content: '看这张图', mode: 'steer',
      images: [{ mediaType: 'image/png', data: 'AQ==', name: 'screen.png' }],
    })).resolves.toEqual({ ok: true, value: { accepted: true } })
    await expect(runtime.sendTurn({
      sessionId: 's1', content: '', mode: 'queue',
      images: [{ mediaType: 'image/jpeg', data: 'Ag==' }],
    })).resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(state.calls).toContainEqual(['prompt', [
      { type: 'image', mediaType: 'image/png', data: 'AQ==', name: 'screen.png' },
      { type: 'text', text: '看这张图' },
    ], 'steer'])
    expect(state.calls).toContainEqual(['prompt', [
      { type: 'image', mediaType: 'image/jpeg', data: 'Ag==' },
    ], 'queue'])
    runtime.dispose()
  })

  it('rejects malformed image-limit projections instead of trusting partial limits', () => {
    expect(parseDshImageInputLimits({ maxImageBytes: 1, mediaTypes: ['image/png'] })).toBeUndefined()
    expect(parseDshImageInputLimits({
      maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1,
      maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/svg+xml'],
    })).toBeUndefined()
  })

  it('preserves folded RPC errors and treats an unknown fork outcome as needing verification', async () => {
    const state = fixture({ promptError: true, forkThrows: true })
    const runtime = new DshAgentRuntimeSession(state.sessions, state.workspaces)
    await expect(runtime.sendTurn({ sessionId: 's1', content: 'x', mode: 'steer' }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'conflict', code: 'busy' } })
    await expect(runtime.forkSession({ sessionId: 's1' }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'needs_verification' } })
    await expect(runtime.stopRun({ sessionId: 'missing' }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } })
    runtime.dispose()
  })

  it('adapts loose sessions, open, move and Chinese search through a separate catalog service', async () => {
    const state = fixture()
    const catalog = new DshSessionCatalog(state.sessions, state.workspaces)
    expect(catalog.getSnapshot().sessions.s1).toMatchObject({
      sessionId: 's1', title: '会话一', cwd: 'C:/work', parentId: 'parent',
    })
    await expect(catalog.createLooseSession()).resolves.toEqual({ ok: true, value: { sessionId: 'loose-1' } })
    expect(catalog.openSession('s1')).toEqual({ ok: true, value: { opened: true } })
    await expect(catalog.renameSession('s1', '  新名字  ')).resolves.toEqual({ ok: true, value: { title: '新名字' } })
    await expect(catalog.archiveSession('s1')).resolves.toEqual({ ok: true, value: { archived: true } })
    await expect(catalog.search('中文检索', new AbortController().signal)).resolves.toEqual({
      ok: true, value: { items: [{ sessionId: 's1', snippet: '命中中文' }], hasMore: false },
    })
    await expect(catalog.moveSessionToWorkspace('s1', 'w1')).resolves.toEqual({ ok: true, value: { sessionId: 's1' } })
    expect(state.calls).toEqual([
      ['create', { loose: true }], ['open', 's1'], ['rename-session', '新名字'], ['archive-session', 's1'],
      ['search', '中文检索'], ['move', 's1', 'w1'],
    ])
    catalog.dispose()
  })

  it('projects DSH context pressure, breakdown and token usage without owning compaction', () => {
    const state = fixture()
    const context = new DshContextGovernance(state.sessions)
    expect(context.getSnapshot().sessions.s1).toEqual({
      sessionId: 's1',
      pressure: { pressureTokens: 70, projectedTokens: 72, contextWindow: 100 },
      breakdown: { systemTokens: 10, toolsTokens: 12, messageTokens: 50 },
      usage: { inputTokens: 100 },
      budget: { source: 'dsh-token-meter', usedTokens: 72, capacityTokens: 100, ratio: 0.72, level: 'elevated' },
      compactions: [],
    })
    context.dispose()
  })

  it('reads the canonical Host task timeline projection without the DSH conversation UI', () => {
    const state = fixture()
    const timeline = new DshTaskTimeline(state.sessions)
    expect(timeline.getSnapshot()).toEqual({ sessionId: 's1', items: [{ key: 'user:1', seq: 1, kind: 'user', text: '你好' }], total: 1, hasEarlier: false })
    timeline.dispose()
  })

  it('keeps legacy assistant reasoning outside the visible response text', () => {
    const state = fixture({ legacyTimeline: true })
    const timeline = new DshTaskTimeline(state.sessions)

    expect(timeline.getSnapshot()).toEqual({
      sessionId: 's1',
      items: [{
        key: 'assistant:2:0', seq: 2, kind: 'assistant',
        text: '**最终回答**', reasoning: '仅供折叠查看的思考',
      }],
      total: 1,
      hasEarlier: false,
    })
    timeline.dispose()
  })

  it('pages older timeline records without losing the durable total', () => {
    const state = fixture({ timelineItemCount: 350 })
    const timeline = new DshTaskTimeline(state.sessions)
    const first = timeline.getSnapshot()

    expect(first.total).toBe(350)
    expect(first.hasEarlier).toBe(true)
    expect(first.items.length).toBeLessThan(350)
    expect(first.items.at(-1)).toMatchObject({ seq: 350, text: '消息 350' })

    timeline.loadEarlier()
    const second = timeline.getSnapshot()
    expect(second.items.length).toBeGreaterThan(first.items.length)
    expect(second.items.at(-1)).toEqual(first.items.at(-1))
    timeline.loadEarlier()
    expect(timeline.getSnapshot()).toMatchObject({ total: 350, hasEarlier: false })
    expect(timeline.getSnapshot().items).toHaveLength(350)
    timeline.dispose()
  })

  it('projects and answers a public pending approval without the DSH product composer', async () => {
    const state = fixture({ approval: true })
    const approvals = new DshUserApproval(state.sessions)
    expect(approvals.getSnapshot()).toMatchObject({ approvals: [{ key: 'a:r1', toolName: 'bash', reason: '危险命令' }] })
    await expect(approvals.answer('a:r1', 'allowed-once')).resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(state.calls).toContainEqual(['approval', { ok: true, value: { sessionId: 's1', approvalId: 'ap1', outcome: 'allowed-once' } }])
    approvals.dispose()
  })

  it('projects and answers every DSH question through the Xiaoshe interaction seam', async () => {
    const state = fixture({ question: {
      questions: [
        {
          id: 'scope', header: '范围', question: '要处理哪些目录？', detail: '只会读取，不会修改。',
          options: [
            { label: '全部（推荐）', description: '扫描全部子目录' },
            { label: '当前目录', description: '仅扫描一层' },
          ],
        },
        { id: 'formats', question: '包含哪些格式？', options: [{ label: 'JSONL' }, { label: 'JSON' }], multiSelect: true },
      ],
    } })
    const questions = new DshUserQuestions(state.sessions)
    expect(questions.getSnapshot()).toEqual({
      sessionId: 's1',
      requests: [{
        key: 'q:r1', sessionId: 's1',
        questions: [
          {
            id: 'scope', header: '范围', question: '要处理哪些目录？', detail: '只会读取，不会修改。',
            options: [
              { label: '全部（推荐）', description: '扫描全部子目录' },
              { label: '当前目录', description: '仅扫描一层' },
            ],
          },
          { id: 'formats', question: '包含哪些格式？', options: [{ label: 'JSONL' }, { label: 'JSON' }], multiSelect: true },
        ],
      }],
    })
    const answer = {
      answers: [
        { id: 'scope', selected: ['全部（推荐）'] },
        { id: 'formats', selected: ['JSONL'], custom: 'TXT' },
      ],
    }
    await expect(questions.answer('q:r1', answer)).resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(state.calls).toContainEqual(['question', { ok: true, value: { sessionId: 's1', answer } }])
    questions.dispose()
  })

  it('rejects forged answers but keeps malformed question waits cancellable', async () => {
    const state = fixture({ question: { questions: [{ id: 'confirm', question: '继续吗？', options: [{ label: '继续' }] }] } })
    const questions = new DshUserQuestions(state.sessions)
    await expect(questions.answer('q:r1', { answers: [{ id: 'confirm', selected: ['伪造选项'] }] }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    expect(state.calls.some(call => Array.isArray(call) && call[0] === 'question')).toBe(false)
    questions.dispose()

    const malformedState = fixture({ question: { questions: [{ id: '', question: '' }] } })
    const malformed = new DshUserQuestions(malformedState.sessions)
    expect(malformed.getSnapshot().requests[0]).toMatchObject({ questions: [], error: '问题请求格式异常，可取消后让小蛇重试。' })
    await expect(malformed.cancel('q:r1')).resolves.toEqual({ ok: true, value: { cancelled: true } })
    expect(malformedState.calls).toContainEqual(['question', {
      ok: false,
      error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
    }])
    malformed.dispose()
  })

  it('projects and switches the real DSH permission preset through the host command', async () => {
    const state = fixture()
    const permissions = new DshPermissionPresets(state.sessions)
    expect(permissions.getSnapshot()).toMatchObject({
      sessionId: 's1', status: 'ready', currentValue: 'read-only',
      options: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'danger-full-access' }],
    })
    await expect(permissions.select('workspace-write')).resolves.toEqual({ ok: true, value: { selected: 'workspace-write' } })
    expect(permissions.getSnapshot()).toMatchObject({ status: 'ready', currentValue: 'workspace-write' })
    expect(state.calls).toContainEqual(['command', '/permission workspace-write'])
    await expect(permissions.select('custom')).resolves.toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    permissions.dispose()
  })

  it('executes real Host slash commands through a separate session-command seam', async () => {
    const state = fixture()
    const commands = new DshSessionCommand(state.sessions)
    await expect(commands.execute({ sessionId: 's1', line: '/compact' }))
      .resolves.toEqual({ ok: true, value: { matched: false } })
    await expect(commands.execute({ sessionId: 'missing', line: '/compact' }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'not_found' } })
    await expect(commands.execute({ sessionId: 's1', line: 'compact' }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    expect(state.calls).toContainEqual(['command', '/compact'])
  })

  it('loads and changes the Host model route without mounting DSH model UI', async () => {
    const state = fixture()
    const models = new DshModelCatalog(state.sessions, state.connection)
    await expect(models.refresh('s1')).resolves.toMatchObject({
      ok: true,
      value: {
        sessionId: 's1', status: 'ready', routable: true,
        current: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      },
    })
    expect(models.getSnapshot().groups[0]?.models[0]?.efforts).toEqual([{ id: 'high', name: '高' }])
    await expect(models.select({ sessionId: 's1', provider: 'deepseek', model: 'deepseek-v4-pro' }))
      .resolves.toEqual({ ok: true, value: { selected: { provider: 'deepseek', model: 'deepseek-v4-pro' } } })
    expect(state.calls).toContainEqual(['models', 's1'])
    expect(state.calls).toContainEqual(['select-model', { sessionId: 's1', provider: 'deepseek', model: 'deepseek-v4-pro' }])
    models.dispose()
  })

  it('uses the native directory picker and opens a real workspace session', async () => {
    const state = fixture()
    const workspaces = new DshWorkspaceCatalog(state.sessions, state.workspaces)
    expect(workspaces.getSnapshot()).toMatchObject({ state: 'ready', items: [{ workspaceId: 'w1', path: 'C:/work' }] })
    await expect(workspaces.addFromNativePicker()).resolves.toMatchObject({ ok: true, value: { cancelled: false, workspace: { workspaceId: 'w1' } } })
    await expect(workspaces.createAndOpenSession('w1')).resolves.toEqual({ ok: true, value: { sessionId: 's2' } })
    await expect(workspaces.renameWorkspace('w1', '  新项目  ')).resolves.toMatchObject({ ok: true, value: { workspace: { title: '新项目' } } })
    await expect(workspaces.removeWorkspace('w1')).resolves.toEqual({ ok: true, value: { removed: true } })
    expect(state.calls).toContainEqual(['pick-directory'])
    expect(state.calls).toContainEqual(['create-workspace', { path: 'C:/work' }])
    expect(state.calls).toContainEqual(['open', 's2'])
    expect(state.calls).toContainEqual(['rename-workspace', 'w1', '新项目'])
    expect(state.calls).toContainEqual(['delete-workspace', 'w1'])
    workspaces.dispose()
  })
})

function fixture(options: { promptError?: boolean; forkThrows?: boolean; approval?: boolean; question?: unknown; legacyTimeline?: boolean; timelineItemCount?: number } = {}) {
  const calls: unknown[] = []
  const subscribers = new Set<() => void>()
  const workspaceSubscribers = new Set<() => void>()
  const permissionSubscribers = new Set<() => void>()
  let permissionValue = 'read-only'
  const permissionOptions = [
    { value: 'read-only', name: '只读', description: '禁止写入' },
    { value: 'workspace-write', name: '工作区写入', description: '仅允许工作区' },
    { value: 'danger-full-access', name: '完全访问', description: '不限制文件写入' },
  ]
  const face = {
    prompt: async (content: unknown, mode: unknown) => {
      calls.push(['prompt', content, mode])
      return options.promptError
        ? { ok: false as const, error: { code: 'busy', message: 'already running' } }
        : { ok: true as const, value: { accepted: true as const } }
    },
    cancel: async () => { calls.push(['cancel']); return { ok: true as const, value: { accepted: true as const } } },
    rename: async (title: string) => { calls.push(['rename-session', title]); return { ok: true as const, value: { title, seq: 2 } } },
    command: async (line: string) => {
      calls.push(['command', line])
      const selected = line.startsWith('/permission ') ? line.slice('/permission '.length) : undefined
      if (selected !== undefined && permissionOptions.some(option => option.value === selected)) {
        permissionValue = selected
        for (const listener of permissionSubscribers) listener()
        return { ok: true as const, value: { matched: true } }
      }
      return { ok: true as const, value: { matched: false } }
    },
    projections: {
      faceOf: (key: string) => ({
        getSnapshot: () => key === 'permissions' ? { currentValue: permissionValue, options: permissionOptions } : undefined,
        subscribe(listener: () => void) { permissionSubscribers.add(listener); return () => { permissionSubscribers.delete(listener) } },
      }),
    },
    getSnapshot: () => ({
      ...(options.legacyTimeline ? { nodes: [{
        kind: 'assistant', seq: 2,
        blocks: [
          { kind: 'reasoning', text: '仅供折叠查看的思考' },
          { kind: 'text', text: '**最终回答**' },
        ],
      }] } : {}),
      pending: [
      ...(options.approval ? [{ kind: 'approval', key: 'a:r1', sessionId: 's1', payload: { approvalId: 'ap1', toolName: 'bash', reason: '危险命令' }, respond: async (value: unknown) => { calls.push(['approval', value]); return { accepted: true } } }] : []),
      ...(options.question === undefined ? [] : [{ kind: 'question', key: 'q:r1', sessionId: 's1', payload: options.question, respond: async (value: unknown) => { calls.push(['question', value]); return { accepted: true } } }]),
      ],
    }),
    subscribe: (_listener: () => void) => () => {},
  }
  const sessions = {
    list: {
      getSnapshot: () => ({ current: 's1', ids: ['s1'], byId: { s1: {
        id: 's1', title: '会话一', cwd: 'C:/work', parentId: 'parent', blank: true, running: false, updatedAt: 1,
        projectionValues: {
          completionReceipt: { outcome: 'verified', sourceSeq: 9 },
          imageLimits: {
            maxImageBytes: 3_670_016, maxImagesPerMessage: 20, maxMessageImageBytes: 104_857_600,
            maxImagePixels: 40_000_000, maxImageDimension: 2000,
            mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
          },
          contextPressure: { pressureTokens: 70, projectedTokens: 72, contextWindow: 100 },
          contextBreakdown: { systemTokens: 10, toolsTokens: 12, messageTokens: 50 },
          tokenUsage: { inputTokens: 100 },
          ...(options.legacyTimeline ? {} : {
            taskTimeline: { schemaVersion: 1, items: Array.from({ length: options.timelineItemCount ?? 1 }, (_, index) => ({
              key: `user:${index + 1}`, seq: index + 1, kind: 'user', text: options.timelineItemCount === undefined ? '你好' : `消息 ${index + 1}`,
            })) },
          }),
        },
      } } }),
      subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener) } },
    },
    binding: (id: string) => id === 's1' ? { session: face } : undefined,
    async create(input: unknown) { calls.push(['create', input]); return 'loose-1' },
    open(id: string) { calls.push(['open', id]) },
    async search(query: string, _signal: AbortSignal) {
      calls.push(['search', query])
      return { ok: true as const, value: { items: [{ sessionId: 's1', snippet: '命中中文' }], hasMore: false } }
    },
    async fork(input: unknown) { calls.push(['fork', input]); if (options.forkThrows) throw new Error('timeout'); return 'fork-1' },
  }
  const workspaces = {
    list: {
      getSnapshot: () => ({
        items: [{ workspaceId: 'w1', path: 'C:/work', title: 'work', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }],
        archivedSessionIds: [], state: 'idle' as const, baselinesReady: true, error: null,
      }),
      subscribe(listener: () => void) { workspaceSubscribers.add(listener); return () => { workspaceSubscribers.delete(listener) } },
    },
    async connectWorkspace(id: string) { calls.push(['connect', id]); return 's2' },
    async moveSessionToWorkspace(sessionId: string, workspaceId: string) {
      calls.push(['move', sessionId, workspaceId]); return sessionId
    },
    async pickDirectory() { calls.push(['pick-directory']); return 'C:/work' },
    async create(input: { path: string }) {
      calls.push(['create-workspace', input])
      return { workspaceId: 'w1', path: input.path, title: 'work', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
    },
    async rename(workspaceId: string, title: string) {
      calls.push(['rename-workspace', workspaceId, title])
      return { workspaceId, path: 'C:/work', title, sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' }
    },
    async delete(workspaceId: string) { calls.push(['delete-workspace', workspaceId]) },
    async archiveSession(sessionId: string) { calls.push(['archive-session', sessionId]) },
  }
  const connection = {
    api: {
      sessions: {
        async models(input: { sessionId: string }) {
          calls.push(['models', input.sessionId])
          return { result: { ok: true as const, value: {
            current: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
            routable: true,
            groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoning: { efforts: [{ id: 'high', name: '高' }], defaultEffort: 'high' } }] }],
            failures: [],
          } } }
        },
        async selectModel(input: { sessionId: string; provider: string; model: string; reasoningEffort?: string }) {
          calls.push(['select-model', input])
          return { result: { ok: true as const, value: { selected: { provider: input.provider, model: input.model, ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) } } } }
        },
      },
    },
  }
  return { sessions, workspaces, connection, calls, subscriptionCount: () => subscribers.size }
}
