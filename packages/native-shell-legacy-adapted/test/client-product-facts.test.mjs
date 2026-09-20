import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadClient() {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, strict: true },
  }).outputText
  return await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

test('browser address does not turn quoted, encoded or native local paths into web hosts', async () => {
  const { browserAddress } = await loadClient()
  for (const value of ['/Users/zfy/首帧', '"/Users/zfy/首帧"', "'/Volumes/media/a.jpg'", '~/Desktop/image.jpg',
    './image.jpg', '../首帧', 'C:\\Users\\test\\image.jpg', '\\\\server\\share', 'file:///tmp/image.jpg',
    '%2FUsers%2Fzfy%2Fimage.jpg', 'https:///Users/zfy/image.jpg']) {
    assert.match(browserAddress(value).error, /本地文件路径/, value)
    assert.equal(browserAddress(value).url, undefined, value)
  }
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'https://user:pass@example.com', 'bad space']) {
    assert.ok(browserAddress(value).error, value)
  }
  assert.equal(browserAddress('example.com/a').url, 'https://example.com/a')
  assert.equal(browserAddress('http://127.0.0.1:3080/').url, 'http://127.0.0.1:3080/')
  assert.deepEqual(browserAddress(' '), {})
})

test('browser width preserves its default and clamps saved splits without corrupting the preference', async () => {
  const { browserDockWidth } = await loadClient()
  assert.equal(browserDockWidth(undefined, 1200), 540)
  assert.equal(browserDockWidth(undefined, 1600), 640)
  assert.equal(browserDockWidth(900, 1600), 900)
  assert.equal(browserDockWidth(900, 1000), 426)
  assert.equal(browserDockWidth(900, 1600), 900, 'fitting never overwrites the requested width')
  assert.equal(browserDockWidth(1, 1200), 320)
  for (const invalid of [undefined, NaN, Infinity, -1, 0]) assert.equal(browserDockWidth(invalid, 1200), 540)
  for (const invalid of [NaN, Infinity, -1, 0]) assert.ok(Number.isFinite(browserDockWidth(undefined, invalid)))
})

test('passive material hydration leaves a new session dock closed', async () => {
  const client = await loadClient()
  const preference = client.parseWorkSurfaceDockPreference(undefined, 'new-session')
  const items = ['read', 'diff', 'terminal'].map(id => ({ id }))
  const hydrated = client.reconcileWorkSurfaceDockPreference(preference, items)
  assert.equal(hydrated.open, false)
  assert.equal(hydrated.activeId, 'terminal')
  assert.deepEqual(hydrated.knownIds, ['read', 'diff', 'terminal'])
})

test('passive arrivals neither reopen a closed dock nor steal the chosen material', async () => {
  const client = await loadClient()
  const preference = { ...client.parseWorkSurfaceDockPreference(undefined, 's1'), open: true, activeId: 'read', knownIds: ['read'] }
  const next = client.reconcileWorkSurfaceDockPreference(preference, [{ id: 'read' }, { id: 'diff' }])
  assert.equal(next.open, true, 'an existing user-open dock remains open')
  assert.equal(next.activeId, 'read', 'new passive results cannot replace the selected content')
  const closed = client.reconcileWorkSurfaceDockPreference({ ...next, open: false }, [{ id: 'read' }, { id: 'diff' }, { id: 'terminal' }])
  assert.equal(closed.open, false)
  assert.equal(closed.activeId, 'read')
  const restored = client.parseWorkSurfaceDockPreference(client.updateWorkSurfaceDockPreferenceStore(undefined, 's1', next), 's1')
  assert.equal(client.reconcileWorkSurfaceDockPreference(restored, [{ id: 'read' }]).open, true)
})

test('material tooltip preserves full file sources and actual read range without renaming terminal commands', async () => {
  const client = await loadClient()
  assert.equal(typeof client.workSurfaceTooltip, 'function')
  const source = 'C:\\Users\\fixture\\workspace\\requirements.md'
  const tooltip = client.workSurfaceTooltip({ title: 'requirements.md · 读取', source,
    view: { kind: 'text', lines: [{ number: 12, text: 'a' }, { number: 13, text: 'b' }], totalLines: 80, truncated: false } })
  assert.ok(tooltip.includes(source))
  assert.match(tooltip, /12–13.*80/u)
  const diff = client.workSurfaceTooltip({ title: 'requirements.md · 改动', source,
    view: { kind: 'diff', diffs: [{ path: source }, { path: 'C:\\Users\\fixture\\workspace\\src\\app.ts' }] } })
  assert.ok(diff.includes('C:\\Users\\fixture\\workspace\\src\\app.ts'))
  assert.match(client.workSurfaceTooltip({ title: 'Get-Content C:\\project\\data.txt', source: 'C:\\project', view: { kind: 'terminal' } }), /^Get-Content C:\\project\\data.txt/u)
})

test('task summary follows the active turn before historical receipts and background job counts', async () => {
  const client = await loadClient()
  assert.equal(typeof client.taskStatePresentation, 'function')
  const base = { runtimeState: 'idle', stopping: false, questionCount: 0, approvalCount: 0, queued: 0, active: 0, loading: false, attention: false }
  for (const [change, expected] of [
    [{ runtimeState: 'running' }, '正在执行'],
    [{ runtimeState: 'running', receipt: 'verified' }, '正在执行'],
    [{ runtimeState: 'running', stopping: true }, '正在停止'],
    [{ questionCount: 1, runtimeState: 'running', stopping: true }, '需要回答'],
    [{ approvalCount: 1, runtimeState: 'running' }, '需要确认'],
    [{ runtimeState: 'blocked', receipt: 'verified' }, '等待交互信息'],
    [{ runtimeState: 'blocked', questionCount: 1, receipt: 'verified' }, '需要回答'],
    [{ runtimeState: 'blocked', approvalCount: 1, receipt: 'verified' }, '需要确认'],
    [{ receipt: 'verified' }, '已验证'],
    [{}, '等待任务'],
  ]) assert.equal(client.taskStatePresentation({ ...base, ...change }).label, expected)
  assert.match(client.taskStatePresentation({ ...base, attention: true, active: 2 }).detail, /需要关注/u)
  assert.match(client.taskStatePresentation({ ...base, active: 2 }).detail, /正在推进/u)
  assert.match(client.taskStatePresentation({ ...base, queued: 1 }).detail, /等待/u)
  assert.doesNotMatch(client.taskStatePresentation({ ...base, attention: true, active: 2 }).detail, /发送一项任务/u)
  assert.match(client.taskStatePresentation({ ...base, runtimeState: 'blocked' }).detail, /同步/u)
})

test('task starters refuse to overwrite text or attachments and only produce editable drafts', async () => {
  const client = await loadClient()
  assert.equal(typeof client.taskStarterDraft, 'function')
  assert.match(client.taskStarterDraft('', 0, 'organize'), /整理/u)
  assert.equal(client.taskStarterDraft('已写好的任务', 0, 'organize'), undefined)
  assert.equal(client.taskStarterDraft('', 1, 'organize'), undefined)
  assert.equal(client.taskStarterDraft('', 0, 'untrusted-id'), undefined)
})

test('empty-stage setup guidance only follows a known unavailable model catalog', async () => {
  const client = await loadClient()
  assert.equal(typeof client.emptyStageNeedsModelSetup, 'function')
  assert.equal(client.emptyStageNeedsModelSetup({ status: 'loading', routable: false, groups: [] }), false)
  assert.equal(client.emptyStageNeedsModelSetup({ status: 'idle', groups: [] }), false)
  assert.equal(client.emptyStageNeedsModelSetup({ status: 'ready', routable: false, groups: [] }), true)
  assert.equal(client.emptyStageNeedsModelSetup({ status: 'ready', routable: true, groups: [] }), false)
  const catalog = { sessionId: 'current', status: 'ready', routable: true, groups: [], current: { provider: 'fixture', model: 'chat' } }
  const readiness = { sessionId: 'current', status: 'ready', providers: [{ id: 'fixture', routes: [{ provider: 'fixture', model: 'chat', facts: { available: false } }] }] }
  assert.equal(client.emptyStageNeedsModelSetup(catalog, readiness), true)
  assert.equal(client.emptyStageNeedsModelSetup(catalog, { ...readiness, sessionId: 'previous' }), false)
})

test('changed provider configuration asks for fresh verification without disabling an available route', async () => {
  const client = await loadClient()
  const view = client.modelControlPresentation({
    sessionId: 'current', status: 'ready', routable: true, failures: [], current: { provider: 'fixture', model: 'chat' },
    groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'chat', name: 'Chat', efforts: [] }] }],
  }, { sessionId: 'current', status: 'ready', providers: [{ id: 'fixture', displayName: 'Fixture', active: true, declared: true,
    routes: [{ provider: 'fixture', model: 'chat', name: 'Chat', facts: { catalogued: true, supported: true, configured: true, available: true, verified: false }, reasons: ['probe_configuration_changed'] }],
  }] })
  assert.equal(view.modelGroups[0].models[0].disabled, false)
  assert.equal(view.modelGroups[0].models[0].statusDetail, '模型配置已更改，请重新验证')
})

test('transaction presentation names partial health and rollback failures', async () => {
  const client = await loadClient()
  const presentation = client.pluginTransactionPresentation({
    status: 'ready', pendingRequests: 0,
    transactions: [
      { state: 'partial-health', id: 'one' },
      { state: 'rollback-failed', id: 'two' },
      { state: 'committed', id: 'three' },
      { state: 'pending', id: 'four' },
    ],
  })
  assert.match(presentation.detail, /健康不完整 1/u)
  assert.match(presentation.detail, /回滚失败 1/u)
  assert.match(presentation.detail, /已完成 1/u)
  assert.match(presentation.detail, /处理中 1/u)
})

test('completed transaction keeps health, rollback and the latest event visible', async () => {
  const client = await loadClient()
  assert.equal(typeof client.pluginTransactionFactLines, 'function')
  assert.deepEqual(client.pluginTransactionFactLines({
    health: [{ gate: 'functional-probe', ok: false, detail: 'HTTP 503' }],
    rollback: {
      attempted: true,
      succeeded: false,
      operation: 'restore',
      restoredSpec: '@scope/example@1.2.2',
      health: [{ gate: 'profile-start', ok: true, detail: 'ready' }],
      residuals: ['@scope/example'],
    },
    events: [
      { at: 1, kind: 'prepared', message: 'ready' },
      { at: 2, kind: 'rollback', message: 'probe failed' },
    ],
  }), [
    '健康门禁：functional-probe 失败（HTTP 503）',
    '回滚：失败；操作 restore；恢复 @scope/example@1.2.2；验证 profile-start 通过（ready）；残留 @scope/example',
    '最近事件：rollback · probe failed',
  ])
})

test('an unattempted rollback is not presented as a failed attempt', async () => {
  const client = await loadClient()
  assert.deepEqual(client.pluginTransactionFactLines({
    rollback: { attempted: false, succeeded: false, residuals: ['process restarted'] },
  }), ['回滚：未尝试；残留 process restarted'])
})

test('inventory retains same-named instances and exposes their phases', async () => {
  const client = await loadClient()
  const [group] = client.pluginInventoryPresentation([
    { entryId: 'plugin-a', moduleName: '@scope/plugin', fiberPhase: 'active' },
    { entryId: 'plugin-b', moduleName: '@scope/plugin', fiberPhase: 'failed' },
  ])
  assert.deepEqual(group.duplicates, [{
    moduleName: '@scope/plugin',
    entries: [
      { entryId: 'plugin-a', fiberPhase: 'active' },
      { entryId: 'plugin-b', fiberPhase: 'failed' },
    ],
  }])
})

test('network capability is unconfirmed without trustworthy runtime facts', async () => {
  const client = await loadClient()
  assert.deepEqual(client.networkCapabilityPresentation({}), {
    state: 'unconfirmed',
    label: '未确认',
    detail: '当前预设：未确认 · 来源：尚未读到可信运行组件事实 · 网络能力独立于文件权限',
  })
})

test('network capability reports preset, source and bounded scope from live facts', async () => {
  const client = await loadClient()
  const view = client.networkCapabilityPresentation({
    desktop: { preset: 'standard' },
    plugins: [
      { entryId: 'tool', moduleName: '@deepseek-ai/dsh-tool-web', enabled: true, fiberPhase: 'active' },
      { entryId: 'fetch', moduleName: '@deepseek-ai/dsh-web-fetch-http', enabled: true, fiberPhase: 'active' },
    ],
  })
  assert.equal(view.state, 'available')
  assert.equal(view.label, '已确认可用')
  assert.match(view.detail, /当前预设：standard/u)
  assert.match(view.detail, /Host 运行组件/u)
  assert.match(view.detail, /公开 HTTP\(S\)/u)
  assert.match(view.detail, /不携带浏览器 Cookie/u)
  assert.match(view.detail, /不等同于文件权限/u)
})

test('network capability reports a present but failed runtime route as unavailable', async () => {
  const client = await loadClient()
  const view = client.networkCapabilityPresentation({
    plugins: [
      { entryId: 'tool', moduleName: '@deepseek-ai/dsh-tool-web', enabled: true, fiberPhase: 'active' },
      { entryId: 'fetch', moduleName: '@deepseek-ai/dsh-web-fetch-http', enabled: true, fiberPhase: 'failed' },
    ],
  })
  assert.equal(view.state, 'unavailable')
  assert.equal(view.label, '当前不可用')
})

test('transaction history remains bounded and keeps each degraded receipt locatable', async () => {
  const client = await loadClient()
  const history = client.pluginTransactionHistoryPresentation([
    {
      id: 'tx-one', action: 'update', packageName: '@scope/one', version: '2.0.0', state: 'partial-health',
      health: [{ gate: 'functional-probe', ok: false, detail: 'HTTP 503' }],
      events: [{ at: 1, kind: 'health', message: 'probe failed' }],
    },
    {
      id: 'tx-two', action: 'remove', packageName: '@scope/two', version: '1.0.0', state: 'rollback-failed',
      rollback: { attempted: false, succeeded: false, residuals: ['restart'] },
    },
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `old-${index}`, action: 'add', packageName: `old-${index}`, version: '1.0.0', state: 'healthy',
    })),
  ], 20)
  assert.equal(history.length, 20)
  assert.equal(history[0].id, 'tx-one')
  assert.match(history[0].heading, /tx-one/u)
  assert.match(history[0].facts.join('\n'), /HTTP 503/u)
  assert.equal(history[1].id, 'tx-two')
  assert.match(history[1].facts.join('\n'), /未尝试/u)
})

test('draft persistence wording states the current-window recovery boundary', async () => {
  const client = await loadClient()
  assert.equal(typeof client.COMPOSER_DRAFT_CURRENT_WINDOW_NOTICE, 'string')
  assert.match(client.COMPOSER_DRAFT_CURRENT_WINDOW_NOTICE, /当前窗口/u)
  assert.match(client.COMPOSER_DRAFT_CURRENT_WINDOW_NOTICE, /关闭窗口/u)
})

test('degraded memory remains usable and is presented as a persistence warning instead of unread', async () => {
  const client = await loadClient()
  const presentation = client.memoryPresentation({
    status: 'degraded',
    memory: {
      api_version: 1,
      revision: 7,
      counts: { active: 2, global: 1, project: 1, forgotten: 0, superseded: 0 },
      entries: [
        { id: 'global', scope: 'global', text: 'one', state: 'active', version: 1 },
        { id: 'project', scope: 'project', project: 'C:/work', text: 'two', state: 'active', version: 1 },
      ],
      audit: [],
      usage: [],
    },
  })
  assert.match(presentation.value, /2 条可用/u)
  assert.match(presentation.value, /需注意/u)
  assert.match(presentation.detail, /持久化降级/u)
  assert.doesNotMatch(presentation.detail, /尚未读取/u)
})

test('memory panel uses the Host-canonical Windows project key instead of comparing a raw cwd', async () => {
  const client = await loadClient()
  const groups = client.memoryPanelEntryGroups({
    api_version: 1,
    revision: 3,
    project: 'c:\\work\\mixed-case',
    counts: { active: 3, global: 1, project: 2, forgotten: 0, superseded: 0 },
    entries: [
      { id: 'global', scope: 'global', text: 'global', state: 'active', version: 1 },
      { id: 'same-project', scope: 'project', project: 'c:\\work\\mixed-case', text: 'same', state: 'active', version: 1 },
      { id: 'other-project', scope: 'project', project: 'c:\\work\\other', text: 'other', state: 'active', version: 1 },
    ],
    audit: [],
    usage: [],
  }, 'C:\\Work\\Mixed-Case')

  assert.deepEqual(groups.global.map(item => item.id), ['global'])
  assert.deepEqual(groups.project.map(item => item.id), ['same-project'])
  assert.deepEqual(groups.forgotten, [])
})

test('memory panel hides a retained snapshot after the selected project changes', async () => {
  const client = await loadClient()
  const groups = client.memoryPanelEntryGroups({
    api_version: 1,
    revision: 2,
    project: 'c:\\work\\project-a',
    counts: { active: 2, global: 1, project: 1, forgotten: 0, superseded: 0 },
    entries: [
      { id: 'global', scope: 'global', text: 'global', state: 'active', version: 1 },
      { id: 'project-a', scope: 'project', project: 'c:\\work\\project-a', text: 'A secret', state: 'active', version: 1 },
    ],
    audit: [],
    usage: [],
  }, 'C:\\Work\\Project-B')

  assert.deepEqual(groups.global.map(item => item.id), ['global'])
  assert.deepEqual(groups.project, [])
  assert.doesNotMatch(JSON.stringify(groups), /A secret/u)
})

test('memory panel keeps old-Host Windows projections visible across cwd casing differences', async () => {
  const client = await loadClient()
  const groups = client.memoryPanelEntryGroups({
    api_version: 1,
    revision: 1,
    counts: { active: 1, global: 0, project: 1, forgotten: 0, superseded: 0 },
    entries: [
      { id: 'same-project', scope: 'project', project: 'c:\\work\\mixed-case', text: 'same', state: 'active', version: 1 },
    ],
    audit: [],
    usage: [],
  }, 'C:\\Work\\Mixed-Case\\')

  assert.deepEqual(groups.project.map(item => item.id), ['same-project'])
})

test('task workbench collapses repeated maintenance jobs without hiding actionable work', async () => {
  const client = await loadClient()
  const view = client.runCenterWorkbenchPresentation({
    status: 'ready',
    jobs: [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `check-${index}`,
        kind: 'xiaoshe-heartbeat',
        label: 'Xiaoshe check xiaoshe-product-runtime',
        status: 'completed',
        detail: 'check completed',
        startedAt: 100 + index,
        finishedAt: 101 + index,
        cancellable: false,
      })),
      {
        id: 'active-test', kind: 'command', label: '运行完整测试', status: 'running',
        startedAt: 500, cancellable: false,
      },
      {
        id: 'failed-build', kind: 'command', label: '构建桌面端', status: 'failed',
        detail: '退出码 1', startedAt: 400, finishedAt: 450, cancellable: false,
      },
    ],
    subagents: [
      { kind: 'child', id: 'child-1', label: '核对产物', activity: 'running', canOpen: true, canInterrupt: true },
    ],
    queue: [{ id: 'queue-1', placement: 'queued', preview: '补充验证深色模式', editable: true, removable: true, steerable: true }],
    todos: [
      { id: 'todo-active', text: '验证窄屏', status: 'in_progress' },
      { id: 'todo-done', text: '整理文案', status: 'completed' },
    ],
    skills: [],
    deliverables: [{ id: 'surface-1', title: '验收报告', kind: 'file', status: 'ready' }],
  })

  assert.deepEqual(view.activeJobs.map(job => job.id), ['active-test'])
  assert.deepEqual(view.activeTodos.map(todo => todo.id), ['todo-active'])
  assert.deepEqual(view.attentionGroups.map(group => ({ label: group.label, count: group.count, detail: group.detail })), [
    { label: '构建桌面端', count: 1, detail: '退出码 1' },
  ])
  assert.deepEqual(view.recentGroups.map(group => ({ label: group.label, count: group.count, status: group.status })), [
    { label: '运行巡检', count: 8, status: 'completed' },
  ])
  assert.equal(JSON.stringify(view).includes('Xiaoshe check'), false)
  assert.equal(JSON.stringify(view).includes('check completed'), false)
  assert.equal(view.counts.active, 3)
  assert.equal(view.counts.pending, 1)
  assert.equal(view.counts.deliverables, 1)
})

test('task workbench keeps repeated failures compact and orders latest evidence first', async () => {
  const client = await loadClient()
  const view = client.runCenterWorkbenchPresentation({
    status: 'ready',
    jobs: [
      { id: 'old', kind: 'command', label: '同步项目', status: 'failed', detail: '旧错误', startedAt: 1, finishedAt: 2, cancellable: false },
      { id: 'new', kind: 'command', label: '同步项目', status: 'failed', detail: '新错误', startedAt: 3, finishedAt: 4, cancellable: false },
      { id: 'stopped', kind: 'command', label: '旧任务', status: 'killed', startedAt: 5, finishedAt: 6, cancellable: false },
    ],
    subagents: [], queue: [], todos: [], skills: [], deliverables: [],
  })

  assert.equal(view.attentionGroups.length, 1)
  assert.equal(view.attentionGroups[0].count, 2)
  assert.equal(view.attentionGroups[0].detail, '新错误')
  assert.deepEqual(view.recentGroups.map(group => [group.label, group.status]), [['旧任务', 'killed']])
})

test('task workbench does not keep a recovered historical failure as a current warning', async () => {
  const client = await loadClient()
  const view = client.runCenterWorkbenchPresentation({
    status: 'ready',
    jobs: [
      { id: 'failed', kind: 'command', label: '同步项目', status: 'failed', detail: '网络中断', startedAt: 1, finishedAt: 2, cancellable: false },
      { id: 'recovered', kind: 'command', label: '同步项目', status: 'completed', detail: '同步完成', startedAt: 3, finishedAt: 4, cancellable: false },
    ],
    subagents: [], queue: [], todos: [], skills: [], deliverables: [],
  })

  assert.deepEqual(view.attentionGroups, [])
  assert.deepEqual(view.recentGroups.map(group => [group.label, group.status, group.count]), [
    ['同步项目', 'completed', 1],
    ['同步项目', 'failed', 1],
  ])
})

test('task workbench resolves failures only after the same operation succeeds', async () => {
  const client = await loadClient()
  const base = {
    status: 'ready', subagents: [], queue: [], todos: [], skills: [], deliverables: [],
  }
  const unrelatedSuccess = client.runCenterWorkbenchPresentation({
    ...base,
    jobs: [
      { id: 'check-a-failed', kind: 'xiaoshe-heartbeat', label: 'Xiaoshe check workspace', status: 'failed', detail: 'workspace failed', startedAt: 1, finishedAt: 2, cancellable: false },
      { id: 'check-b-ok', kind: 'xiaoshe-heartbeat', label: 'Xiaoshe check runtime', status: 'completed', startedAt: 3, finishedAt: 4, cancellable: false },
    ],
  })
  assert.equal(unrelatedSuccess.attentionGroups.length, 1)
  assert.equal(unrelatedSuccess.attentionGroups[0].detail, 'workspace failed')

  const retryRunning = client.runCenterWorkbenchPresentation({
    ...base,
    jobs: [
      { id: 'failed', kind: 'command', label: '同步项目', status: 'failed', detail: '网络中断', startedAt: 1, finishedAt: 2, cancellable: false },
      { id: 'retry', kind: 'command', label: '同步项目', status: 'running', startedAt: 3, cancellable: false },
    ],
  })
  assert.equal(retryRunning.attentionGroups.length, 1)
  assert.equal(retryRunning.activeJobs[0].id, 'retry')
})

test('task workbench uses append order when terminal timestamps tie', async () => {
  const client = await loadClient()
  const base = { status: 'ready', subagents: [], queue: [], todos: [], skills: [], deliverables: [] }
  const recovered = client.runCenterWorkbenchPresentation({
    ...base,
    jobs: [
      { id: 'failed', kind: 'command', label: '构建', status: 'failed', startedAt: 1, finishedAt: 10, cancellable: false },
      { id: 'success', kind: 'command', label: '构建', status: 'completed', startedAt: 2, finishedAt: 10, cancellable: false },
    ],
  })
  assert.deepEqual(recovered.attentionGroups, [])
  const regressed = client.runCenterWorkbenchPresentation({
    ...base,
    jobs: [
      { id: 'success', kind: 'command', label: '构建', status: 'completed', startedAt: 1, finishedAt: 10, cancellable: false },
      { id: 'failed', kind: 'command', label: '构建', status: 'failed', startedAt: 2, finishedAt: 10, cancellable: false },
    ],
  })
  assert.equal(regressed.attentionGroups.length, 1)
})

test('task workbench bounds hidden history while preserving real totals', async () => {
  const client = await loadClient()
  const view = client.runCenterWorkbenchPresentation({
    status: 'ready',
    jobs: Array.from({ length: 80 }, (_, index) => ({
      id: `job-${index}`, kind: 'command', label: `任务 ${index}`, status: 'completed',
      startedAt: index, finishedAt: index + 1, cancellable: false,
    })),
    subagents: [], queue: [], todos: [], skills: [], deliverables: [],
  })
  assert.equal(view.recentGroups.length, client.RUN_CENTER_HISTORY_GROUP_LIMIT)
  assert.equal(view.counts.history, 80)
  assert.equal(view.counts.historyGroups, 80)
})

test('session scoped interactions fail closed during navigation', async () => {
  const client = await loadClient()
  const rows = Object.freeze([{ key: 'approval-old' }])
  assert.equal(client.sessionScopedRows(rows, 'session-a', 'session-a'), rows)
  assert.deepEqual(client.sessionScopedRows(rows, 'session-a', 'session-b'), [])
  assert.deepEqual(client.sessionScopedRows(rows, undefined, 'session-a'), [])
  assert.deepEqual(client.sessionScopedRows(rows, 'session-a', undefined), [])
})

test('run center facts fail closed while the selected session is changing', async () => {
  const client = await loadClient()
  const stale = {
    sessionId: 'old-session', status: 'ready',
    jobs: [{ id: 'old-job', kind: 'command', label: '旧会话任务', status: 'running', startedAt: 1, cancellable: false }],
    subagents: [], queue: [{ id: 'old-queue', placement: 'queued', preview: '旧方向', editable: true, removable: true, steerable: true }],
    todos: [], skills: [], deliverables: [{ id: 'old-output', title: '旧产物', kind: 'file', status: 'ready' }],
  }

  const changing = client.runCenterForSession(stale, 'new-session')
  assert.equal(changing.status, 'loading')
  assert.deepEqual(changing.jobs, [])
  assert.deepEqual(changing.queue, [])
  assert.deepEqual(changing.deliverables, [])
  assert.equal(client.runCenterForSession(stale, 'old-session'), stale)
  assert.equal(client.runCenterForSession(stale, undefined).status, 'idle')
})

test('right rail defaults preserve a useful central workspace and clamp old oversized preferences', async () => {
  const client = await loadClient()
  assert.deepEqual(client.defaultPanelWidths(1440, 900), { side: 232, inspector: 280 })
  assert.deepEqual(client.defaultPanelWidths(1920, 1080), { side: 256, inspector: 300 })
  assert.equal(client.parsePanelWidths('{"side":232,"inspector":480}', { side: 232, inspector: 280 }).inspector, 400)
  assert.equal(client.PANEL_RESIZE_DESKTOP_BREAKPOINT, 1240)
})

test('inspector overlay opens on compact viewports and clears across the desktop breakpoint', async () => {
  const client = await loadClient()
  assert.deepEqual(client.openInspectorOverlayState({ side: true, inspector: false }, 390), { side: false, inspector: true })
  assert.deepEqual(client.openInspectorOverlayState({ side: false, inspector: true }, 1440), { side: false, inspector: false })
  assert.deepEqual(client.overlayStateAfterViewportResize({ side: true, inspector: false }, 1241), { side: false, inspector: false })
  const compact = { side: false, inspector: true }
  assert.equal(client.overlayStateAfterViewportResize(compact, 1239), compact)
})

test('heartbeat persistence degradation is visible even when checks are healthy', async () => {
  const client = await loadClient()
  const presentation = client.heartbeatPresentation({
    schemaVersion: 2,
    status: 'healthy',
    running: false,
    persistenceStatus: 'degraded',
    checks: [{ id: 'runtime', status: 'healthy', intervalMs: 1_000, failureCount: 0 }],
  })
  assert.equal(presentation.status, '持久化降级')
  assert.equal(presentation.tone, 'warn')
  assert.match(presentation.detail, /持久化降级/u)
  assert.match(presentation.detail, /小蛇运行服务/u)
})

test('heartbeat source failure never presents a retained healthy snapshot as currently normal', async () => {
  const client = await loadClient()
  const presentation = client.heartbeatHealthPresentation({
    status: 'degraded',
    value: {
      heartbeat: {
        schemaVersion: 2,
        status: 'healthy',
        running: false,
        persistenceStatus: 'ready',
        checks: [{ id: 'health', status: 'healthy', intervalMs: 1_000, failureCount: 0 }],
      },
    },
    errors: [{ source: 'heartbeat', message: '连接已中断', kind: 'NETWORK_ERROR' }],
  })

  assert.equal(presentation.status, '读取降级')
  assert.equal(presentation.tone, 'warn')
  assert.equal(presentation.running, false)
  assert.match(presentation.detail, /连接已中断/u)
  assert.match(presentation.detail, /上次状态.*正常/u)

  const currentFailure = client.heartbeatHealthPresentation({
    status: 'degraded',
    value: {
      heartbeat: {
        schemaVersion: 2,
        status: 'lost',
        running: false,
        persistenceStatus: 'ready',
        checks: [{ id: 'health', status: 'lost', intervalMs: 1_000, failureCount: 1 }],
      },
    },
    errors: [{
      source: 'heartbeat',
      message: 'heartbeat check status is lost',
      kind: 'HEARTBEAT_CHECK_DEGRADED',
    }],
  })
  assert.equal(currentFailure.status, '连接中断')
  assert.equal(currentFailure.tone, 'warn')
})

test('project transition invalidates memory editing and never presents counts from the old project', async () => {
  const client = await loadClient()
  assert.equal(client.memoryProjectContextChanged(
    { cwd: 'C:\\Work\\A', canonical: 'c:\\work\\a' },
    { cwd: 'C:\\Work\\B', canonical: 'c:\\work\\a' },
  ), true)
  assert.equal(client.memoryProjectContextChanged(
    { cwd: 'C:\\Work\\A', canonical: 'c:\\work\\a' },
    { cwd: 'c:/work/a', canonical: 'c:\\work\\a' },
  ), false)
  assert.equal(client.memoryProjectContextChanged(
    { cwd: '/workspace/link', canonical: '/workspace/real-a' },
    { cwd: '/workspace/link', canonical: '/workspace/real-b' },
  ), true)
  assert.equal(client.memoryProjectContextChanged(
    { cwd: '/workspace/link' },
    { cwd: '/workspace/link', canonical: '/workspace/real-a' },
  ), false)

  const stale = {
    status: 'ready',
    memory: {
      api_version: 1,
      revision: 3,
      project: 'c:\\work\\a',
      counts: { active: 2, global: 1, project: 1, forgotten: 0, superseded: 0 },
      entries: [], audit: [], usage: [],
    },
  }
  const presentation = client.memoryPresentation(stale, { currentProject: 'C:\\Work\\B' })
  assert.equal(presentation.value, '正在读取')
  assert.match(presentation.detail, /正在切换项目记忆/u)
  assert.doesNotMatch(`${presentation.value}\n${presentation.detail}`, /项目 1|2 条可用/u)
  const loadingPresentation = client.memoryPresentation({ ...stale, status: 'loading' }, { currentProject: 'C:\\Work\\B' })
  assert.doesNotMatch(`${loadingPresentation.value}\n${loadingPresentation.detail}`, /项目 1|2 条可用/u)
  const failedPresentation = client.memoryPresentation({ ...stale, status: 'error' }, { currentProject: 'C:\\Work\\B' })
  assert.equal(failedPresentation.value, '读取失败')
})

test('user-turn navigation is derived only from user messages and bounds its preview', async () => {
  const client = await loadClient()
  const longMessage = '小蛇'.repeat(60)
  const items = client.buildUserTurnNavigation([
    { key: 'assistant-1', kind: 'assistant', text: '不应出现' },
    { key: 'user-1', kind: 'user', text: '  第一条\n我的消息  ' },
    { key: 'tool-1', kind: 'tool', text: '也不应出现' },
    { key: 'user-2', kind: 'user', text: longMessage },
  ])

  assert.deepEqual(items.map(item => ({ key: item.key, eventIndex: item.eventIndex, ordinal: item.ordinal })), [
    { key: 'user-1', eventIndex: 1, ordinal: 1 },
    { key: 'user-2', eventIndex: 3, ordinal: 2 },
  ])
  assert.equal(items[0].preview, '第一条 我的消息')
  assert.ok(Array.from(items[1].preview).length <= 96)
  assert.match(items[1].preview, /…$/u)
})

test('conversation navigation follows the reading line and keeps jump-to-latest unobtrusive near the bottom', async () => {
  const client = await loadClient()
  assert.equal(client.activeUserTurnOrdinalAtScroll([100, 500, 900], 0, 600), 1)
  assert.equal(client.activeUserTurnOrdinalAtScroll([100, 500, 900], 420, 600), 2)
  assert.equal(client.activeUserTurnOrdinalAtScroll([100, 500, 900], 800, 600), 3)

  assert.equal(client.shouldOfferJumpToLatest({ scrollHeight: 2_000, scrollTop: 1_450, clientHeight: 500 }), false)
  assert.equal(client.shouldOfferJumpToLatest({ scrollHeight: 2_000, scrollTop: 900, clientHeight: 500 }), true)
  assert.equal(client.shouldOfferJumpToLatest({ scrollHeight: 500, scrollTop: 0, clientHeight: 500 }), false)
})

test('bottom-follow ownership pins within the floor threshold and releases on upward scroll', async () => {
  const client = await loadClient()
  // At the exact floor.
  assert.equal(client.isPinnedAtBottom({ scrollHeight: 2_000, scrollTop: 1_500, clientHeight: 500 }), true)
  // Inside the 24px threshold.
  assert.equal(client.isPinnedAtBottom({ scrollHeight: 2_000, scrollTop: 1_480, clientHeight: 500 }), true)
  // Just beyond it: the reader has moved away and owns the position.
  assert.equal(client.isPinnedAtBottom({ scrollHeight: 2_000, scrollTop: 1_470, clientHeight: 500 }), false)
  // Degenerate metrics (no overflow, invalid numbers) stay pinned so a fresh
  // transcript opens following its floor.
  assert.equal(client.isPinnedAtBottom({ scrollHeight: 500, scrollTop: 0, clientHeight: 500 }), true)
  assert.equal(client.isPinnedAtBottom({ scrollHeight: Number.NaN, scrollTop: 0, clientHeight: 500 }), true)
})

test('model control derives its label and effort rail only from the advertised current model', async () => {
  const client = await loadClient()
  const view = client.modelControlPresentation({
    status: 'ready',
    current: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' },
    routable: true,
    groups: [{
      id: 'deepseek', name: 'DeepSeek',
      models: [{
        id: 'reasoner', name: 'DeepSeek Reasoner', description: '适合复杂任务', defaultEffort: 'high',
        efforts: [
          { id: 'low', name: '低' },
          { id: 'high', name: '高' },
          { id: 'max', name: '最大' },
        ],
      }],
    }],
    failures: [],
  })

  assert.equal(view.triggerLabel, 'DeepSeek Reasoner · 高')
  assert.equal(view.modelGroups[0].models[0].selected, true)
  assert.deepEqual(view.efforts.map(item => ({ value: item.value, selected: item.selected })), [
    { value: 'low', selected: false },
    { value: 'high', selected: true },
    { value: 'max', selected: false },
  ])
  assert.equal(view.efforts.some(item => item.value === 'off'), false)

  const advertisedOff = client.modelControlPresentation({
    status: 'ready', current: { provider: 'local', model: 'fast' }, routable: true, failures: [],
    groups: [{ id: 'local', name: 'Local', models: [{ id: 'fast', name: 'Fast', efforts: [{ id: 'off', name: 'Off' }] }] }],
  })
  assert.equal(advertisedOff.triggerLabel, 'Fast · 默认')
  assert.deepEqual(advertisedOff.efforts.map(item => ({ value: item.value, description: item.description })), [
    { value: 'off', description: '关闭额外推理，直接生成回答' },
  ])
})

test('model control renders one accessible combined trigger and an upward picker', async () => {
  const client = await loadClient()
  const calls = []
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  const tree = client.renderModelControl(createElement, {
    snapshot: {
      status: 'ready',
      current: { provider: 'deepseek', model: 'chat', reasoningEffort: 'low' },
      routable: true,
      groups: [{
        id: 'deepseek', name: 'DeepSeek',
        models: [
          { id: 'chat', name: 'DeepSeek Chat', efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' },
          { id: 'reasoner', name: 'DeepSeek Reasoner', efforts: [{ id: 'high', name: '高' }, { id: 'max', name: '最大' }], defaultEffort: 'high' },
        ],
      }],
      failures: [],
    },
    disabled: false,
    open: true,
    onToggle: () => calls.push('toggle'),
    onDismiss: () => calls.push('dismiss'),
    onSelect: selection => calls.push(selection),
  })
  const nodes = []
  const visit = value => {
    if (value === null || value === undefined || typeof value !== 'object') return
    nodes.push(value)
    for (const child of value.children ?? []) visit(child)
  }
  visit(tree)

  const trigger = nodes.find(node => node.props.className === 'model-reasoning-trigger')
  assert.ok(trigger)
  assert.equal(trigger.props['aria-haspopup'], 'dialog')
  assert.equal(trigger.props['aria-expanded'], true)
  assert.match(trigger.props['aria-label'], /DeepSeek Chat.*低/u)
  const popover = nodes.find(node => node.props.className === 'model-reasoning-popover')
  assert.ok(popover)
  assert.equal(popover.props.role, 'dialog')
  assert.equal(popover.props['data-placement'], 'top')
  assert.ok(nodes.some(node => node.props.role === 'radiogroup' && node.props['aria-label'] === '选择模型'))
  assert.ok(nodes.some(node => node.props.role === 'radiogroup' && node.props['aria-label'] === '选择思考强度'))
  assert.equal(nodes.some(node => node.type === 'select'), false)

  let prevented = false
  popover.props.onKeyDown({
    key: 'Escape', currentTarget: { closest: () => undefined },
    preventDefault: () => { prevented = true }, stopPropagation() {},
  })
  assert.equal(prevented, true)
  assert.equal(calls.at(-1), 'dismiss')

  const reasoner = nodes.find(node => node.props['data-model-route'] === '["deepseek","reasoner"]')
  let triggerFocused = 0
  const selectionEvent = {
    currentTarget: {
      closest: () => ({ querySelector: () => ({ focus: () => { triggerFocused += 1 } }) }),
    },
  }
  reasoner.props.onClick(selectionEvent)
  await Promise.resolve()
  assert.deepEqual(calls.at(-1), { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
  assert.equal(triggerFocused, 0)
  const maximum = nodes.find(node => node.props['data-effort'] === 'high')
  maximum.props.onClick(selectionEvent)
  await Promise.resolve()
  assert.deepEqual(calls.at(-1), { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })
  assert.equal(triggerFocused, 0)
})

test('model control uses provider readiness without pretending unknown legacy routes are verified', async () => {
  const client = await loadClient()
  const view = client.modelControlPresentation({
    sessionId: 'session-a', status: 'ready', current: { provider: 'alpha', model: 'verified' }, routable: true, failures: [],
    groups: [{ id: 'alpha', name: 'Alpha', models: [
      { id: 'verified', name: 'Verified', efforts: [] },
      { id: 'missing-key', name: 'Missing key', efforts: [] },
      { id: 'legacy', name: 'Legacy route', efforts: [] },
    ] }],
  }, {
    sessionId: 'session-a', status: 'ready', providers: [{
      id: 'alpha', displayName: 'Alpha', active: true, declared: true,
      routes: [
        { provider: 'alpha', model: 'verified', name: 'Verified', facts: { catalogued: true, supported: true, configured: true, available: true, verified: true }, reasons: [] },
        { provider: 'alpha', model: 'missing-key', name: 'Missing key', facts: { catalogued: true, supported: true, configured: false, available: false, verified: false }, reasons: ['missing_credential'] },
      ],
    }],
  })

  assert.deepEqual(view.modelGroups[0].models.map(model => ({
    model: model.model, disabled: model.disabled, status: model.statusLabel,
  })), [
    { model: 'verified', disabled: false, status: '已验证' },
    { model: 'missing-key', disabled: true, status: '未配置' },
    { model: 'legacy', disabled: false, status: '状态未确认' },
  ])
})

test('native shell ignores provider readiness from another or untagged session', async () => {
  const client = await loadClient()
  const current = {
    sessionId: 'session-b', status: 'ready', providers: [{
      id: 'deepseek', displayName: 'DeepSeek', active: true, declared: true,
      routes: [{
        provider: 'deepseek', model: 'chat', name: 'Chat',
        facts: { catalogued: true, supported: true, configured: false, available: false, verified: false },
        reasons: ['credential_missing'],
      }],
    }],
  }
  assert.equal(client.providerReadinessForSession(current, 'session-b'), current)

  const stale = client.providerReadinessForSession({ ...current, sessionId: 'session-a' }, 'session-b')
  assert.equal(stale.status, 'loading')
  assert.equal(stale.sessionId, 'session-b')
  assert.deepEqual(stale.providers, [])

  const legacy = client.providerReadinessForSession({ status: 'ready', providers: current.providers }, 'session-b')
  assert.equal(legacy.status, 'error')
  assert.deepEqual(legacy.providers, [])
  assert.match(legacy.error, /未标注.*会话/u)

  const modelView = client.modelControlPresentation({
    sessionId: 'session-b', status: 'ready', current: { provider: 'deepseek', model: 'chat' }, routable: true, failures: [],
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat', efforts: [] }] }],
  }, { ...current, sessionId: 'session-a' })
  assert.equal(modelView.modelGroups[0].models[0].disabled, false)
  assert.equal(modelView.modelGroups[0].models[0].statusLabel, '状态未确认')
})

test('native shell never projects a stale or untagged model directory into the current session', async () => {
  const client = await loadClient()
  const current = {
    sessionId: 'session-b', status: 'ready', current: { provider: 'deepseek', model: 'chat' }, routable: true, failures: [],
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat', efforts: [] }] }],
  }
  assert.equal(client.modelCatalogForSession(current, 'session-b'), current)

  const stale = client.modelCatalogForSession({ ...current, sessionId: 'session-a' }, 'session-b')
  assert.equal(stale.status, 'loading')
  assert.equal(stale.sessionId, 'session-b')
  assert.deepEqual(stale.groups, [])
  assert.equal(stale.current, undefined)
  assert.match(stale.error, /当前会话/u)

  const legacy = client.modelCatalogForSession({ ...current, sessionId: undefined }, 'session-b')
  assert.equal(legacy.status, 'error')
  assert.equal(legacy.sessionId, 'session-b')
  assert.deepEqual(legacy.groups, [])
  assert.equal(legacy.current, undefined)
  assert.match(legacy.error, /Host.*未标注.*会话/u)
})

test('model picker remains openable for directory recovery and exposes the settings entry', async () => {
  const client = await loadClient()
  const calls = []
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  const tree = client.renderModelControl(createElement, {
    snapshot: {
      status: 'error', groups: [],
      failures: [{ id: 'deepseek', name: 'DeepSeek', message: '缺少服务商配置' }],
      error: '模型目录读取失败',
    },
    providerReadiness: { status: 'error', providers: [], error: '服务商状态不可用' },
    disabled: false, open: true,
    onToggle: () => calls.push('toggle'), onDismiss: () => calls.push('dismiss'),
    onSelect: selection => calls.push(selection), onOpenModelSettings: () => calls.push('settings'),
  })
  const nodes = []
  const visit = value => {
    if (value === null || value === undefined || typeof value !== 'object') return
    nodes.push(value)
    for (const child of value.children ?? []) visit(child)
  }
  const textOf = value => value === null || value === undefined ? ''
    : typeof value === 'string' ? value
      : typeof value === 'object' ? (value.children ?? []).map(textOf).join('') : ''
  visit(tree)

  const trigger = nodes.find(node => node.props.className === 'model-reasoning-trigger')
  assert.equal(trigger.props.disabled, false)
  const recovery = nodes.find(node => node.props.className === 'model-directory-state')
  assert.ok(recovery)
  assert.match(textOf(recovery), /模型目录读取失败/u)
  assert.match(textOf(recovery), /缺少服务商配置/u)
  assert.match(textOf(recovery), /设置 → 模型与服务商/u)
  const settings = nodes.find(node => node.props['data-action'] === 'open-model-settings')
  settings.props.onClick()
  assert.equal(calls.at(-1), 'settings')
})

test('running tasks lock model changes with an explicit idle-only explanation', async () => {
  const client = await loadClient()
  const calls = []
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  const tree = client.renderModelControl(createElement, {
    snapshot: { status: 'ready', groups: [], failures: [] },
    disabled: true, disabledReason: '任务运行中；模型与思考强度只能在任务空闲时切换', open: false,
    onToggle: () => calls.push('toggle'), onDismiss() {}, onSelect() {},
  })
  const trigger = tree.children.find(node => node?.props?.className === 'model-reasoning-trigger')
  assert.equal(trigger.props.disabled, false)
  assert.equal(trigger.props['aria-disabled'], true)
  assert.equal(trigger.props['aria-describedby'], 'xsla-model-reasoning-availability')
  assert.match(trigger.props.title, /只能在任务空闲时切换/u)
  trigger.props.onClick()
  assert.deepEqual(calls, ['toggle'])
  const description = tree.children.find(node => node?.props?.id === 'xsla-model-reasoning-availability')
  assert.equal(description.props.className, 'visually-hidden')
  assert.match(description.children.join(''), /只能在任务空闲时切换/u)

  const openTree = client.renderModelControl(createElement, {
    snapshot: { status: 'ready', groups: [], failures: [] },
    disabled: true, disabledReason: '任务运行中；模型与思考强度只能在任务空闲时切换', open: true,
    onToggle() {}, onDismiss() {}, onSelect() {},
  })
  const popover = openTree.children.find(node => node?.props?.className === 'model-reasoning-popover')
  const visibleReason = popover.children.find(node => node?.props?.className === 'model-control-lock-note')
  assert.equal(visibleReason.props.role, 'status')
  assert.match(visibleReason.children.join(''), /只能在任务空闲时切换/u)
})

test('model selection persistence distinguishes saved, session-only and legacy hosts', async () => {
  const client = await loadClient()
  assert.equal(client.modelSelectionPersistenceNotice({ status: 'saved' }), undefined)
  assert.deepEqual(client.modelSelectionPersistenceNotice({ status: 'session-only', warning: '默认模型未能写入配置。' }), {
    tone: 'warning',
    message: '当前会话已切换，但默认选择未保存。默认模型未能写入配置。',
  })
  assert.deepEqual(client.modelSelectionPersistenceNotice(undefined), {
    tone: 'neutral',
    message: '当前会话已切换；旧版 Host 未报告默认保存状态。',
  })
})

test('model control keyboard navigation stays inside its enabled control group', async () => {
  const client = await loadClient()
  assert.equal(client.modelControlKeyboardIndex('ArrowRight', 0, 3), 1)
  assert.equal(client.modelControlKeyboardIndex('ArrowLeft', 0, 3), 2)
  assert.equal(client.modelControlKeyboardIndex('Home', 2, 3), 0)
  assert.equal(client.modelControlKeyboardIndex('End', 0, 3), 2)
  assert.equal(client.modelControlKeyboardIndex('ArrowDown', 1, 0), undefined)
})

test('model picker gives exactly one focus entry when the current route is no longer advertised', async () => {
  const client = await loadClient()
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  const tree = client.renderModelControl(createElement, {
    snapshot: {
      status: 'ready', current: { provider: 'legacy', model: 'retired' }, routable: true, failures: [],
      groups: [
        { id: 'one', name: 'One', models: [{ id: 'first', name: 'First', efforts: [] }] },
        { id: 'two', name: 'Two', models: [{ id: 'second', name: 'Second', efforts: [] }] },
      ],
    },
    disabled: false, open: true, onToggle() {}, onDismiss() {}, onSelect() {},
  })
  const nodes = []
  const visit = value => {
    if (value === null || value === undefined || typeof value !== 'object') return
    nodes.push(value)
    for (const child of value.children ?? []) visit(child)
  }
  visit(tree)
  const modelButtons = nodes.filter(node => node.props['data-model-route'] !== undefined)
  assert.equal(modelButtons.filter(node => node.props.tabIndex === 0).length, 1)
  assert.equal(modelButtons.filter(node => node.props.autoFocus === true).length, 1)
  assert.equal(modelButtons[0].props.tabIndex, 0)
})

test('model picker never focuses a selected route that readiness has disabled', async () => {
  const client = await loadClient()
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  const tree = client.renderModelControl(createElement, {
    snapshot: {
      sessionId: 'session-a', status: 'ready', current: { provider: 'one', model: 'blocked' }, routable: true, failures: [],
      groups: [{ id: 'one', name: 'One', models: [
        { id: 'blocked', name: 'Blocked', efforts: [{ id: 'high', name: '高' }] },
        { id: 'ready', name: 'Ready', efforts: [] },
      ] }],
    },
    providerReadiness: { sessionId: 'session-a', status: 'ready', providers: [{
      id: 'one', displayName: 'One', active: true, declared: true,
      routes: [
        { provider: 'one', model: 'blocked', name: 'Blocked', facts: { catalogued: true, supported: true, configured: false, available: false, verified: false }, reasons: ['credential_missing'] },
        { provider: 'one', model: 'ready', name: 'Ready', facts: { catalogued: true, supported: true, configured: true, available: true, verified: true }, reasons: [] },
      ],
    }] },
    disabled: false, open: true, onToggle() {}, onDismiss() {}, onSelect() {},
  })
  const nodes = []
  const visit = value => {
    if (value === null || value === undefined || typeof value !== 'object') return
    nodes.push(value)
    for (const child of value.children ?? []) visit(child)
  }
  visit(tree)
  const modelButtons = nodes.filter(node => node.props['data-model-route'] !== undefined)
  assert.equal(modelButtons[0].props.disabled, true)
  assert.equal(modelButtons[0].props.tabIndex, -1)
  assert.equal(modelButtons[0].props.autoFocus, false)
  assert.equal(modelButtons[1].props.tabIndex, 0)
  assert.equal(modelButtons[1].props.autoFocus, true)
  const effort = nodes.find(node => node.props['data-effort'] === 'high')
  assert.equal(effort.props.disabled, true)
})

test('session catalog keeps meaningful titles and bounds long sidebar lists without losing the selected session', async () => {
  const client = await loadClient()
  assert.equal(client.sessionDisplayTitle('项目调研', 'session-abcdef', Date.UTC(2026, 8, 6, 8, 30)), '项目调研')
  assert.equal(client.sessionDisplayTitle('未命名', 'session-abcdef', Date.UTC(2026, 8, 6, 8, 30)), '未命名 · 09/06 08:30 · abcdef')

  const rows = Array.from({ length: 140 }, (_, index) => ({ sessionId: `session-${index}` }))
  const catalog = client.windowSessionCatalog(rows, 100, 'session-139')
  assert.equal(catalog.total, 140)
  assert.equal(catalog.hasMore, true)
  assert.equal(catalog.items.length, 101)
  assert.equal(catalog.items.at(-1).sessionId, 'session-139')
})
