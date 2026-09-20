import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

// Use the actual client exports, as the existing client-product-facts suite
// does. These are pure UI-state tests, not native mounting or React lifecycle
// evidence; browser owner/lease integration remains a separate boundary.
async function loadClient() {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source + '\nexport { renderRunCenterPanel, renderTaskGraphSection };', {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, strict: true },
  }).outputText
  return await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

function emptyRun(overrides = {}) {
  return {
    sessionId: 'synthetic-workbench-session', status: 'ready',
    jobs: [], subagents: [], queue: [], todos: [], skills: [], deliverables: [],
    ...overrides,
  }
}

function noticeInput(client, overrides = {}) {
  return {
    questionCount: 0, approvalCount: 0, runCenter: emptyRun(),
    contextView: client.contextPresentation(undefined),
    heartbeat: { status: '正常', detail: '', running: false, tone: 'ok' },
    ...overrides,
  }
}

function job(status, overrides = {}) {
  return {
    id: `synthetic-${status}`, kind: 'command', label: '测试工作台', status,
    startedAt: 100, finishedAt: 200, cancellable: false,
    ...overrides,
  }
}

function taskGraph(overrides = {}) {
  return {
    version: 1, id: 'graph-1', revision: 4, sessionId: 'synthetic-workbench-session', taskGeneration: 1,
    goalId: 'goal-1', objective: '交付任务图', runtimeInstance: 'runtime-a', durability: 'durable', status: 'active', stale: false, recoveryRequired: false,
    nodes: [
      { id: 'build', title: '实现共享解析器', dependencies: [], acceptance: [{ id: 'a1', text: '测试通过' }], status: 'completed', attempt: 1, startSeq: 10,
        evidence: [{ callId: 'c1', resultSeq: 12, toolName: 'exec', attempt: 1, kind: 'reviewer-assessment', acceptanceId: 'a1', assertion: '符合验收项', sourceExcerpt: '12 tests' }], feedback: [] },
      { id: 'ui', title: '实现桌面任务面板', dependencies: ['build'], acceptance: [{ id: 'a2', text: '键盘可访问' }], status: 'running', attempt: 2, startSeq: 13,
        evidence: [{ callId: 'c2', resultSeq: 14, toolName: 'exec', attempt: 2, kind: 'execution' }], feedback: [{ text: '继续检查窄栏换行', outcome: 'needs-work' }] },
      { id: 'terminal', title: '实现终端视图', dependencies: ['ui'], acceptance: [{ id: 'a3', text: '共享同一快照' }], status: 'pending', attempt: 0, startSeq: null, evidence: [], feedback: [] },
    ], feedback: [],
    ...overrides,
  }
}

const treeElement = (tag, props, ...children) => ({ tag, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined) })
const treeNodes = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(treeNodes)] : []
const treeText = node => node && typeof node === 'object' ? node.children.map(treeText).join(' ') : String(node ?? '')
const renderTaskPanel = (client, runCenter, overrides = {}) => client.renderRunCenterPanel(treeElement, {
  runCenter, taskGoal: '当前任务 B', surfaces: [], runtimeState: 'running', stopping: false, questionCount: 0,
  approvalCount: 0, contextView: client.contextPresentation(undefined), heartbeat: { status: '正常', detail: '', running: false },
  ...overrides,
})

test('pending user interactions appear before a long graph', async () => {
  const client = await loadClient()
  const rendered = renderTaskPanel(client, emptyRun({ taskGraph: taskGraph() }), { questionCount: 1 })
  const nodes = treeNodes(rendered)
  assert.ok(nodes.findIndex(node => node.props['data-task-interaction'] === 'question')
    < nodes.findIndex(node => node.props['data-task-graph'] !== undefined))
})

test('stale graphs disclose their historical objective after the current task', async () => {
  const client = await loadClient()
  const rendered = renderTaskPanel(client, emptyRun({ taskGraph: taskGraph({ stale: true, status: 'waiting', objective: '旧任务 A' }),
    todos: [{ id: 'new-todo', text: '当前任务 B 的步骤', status: 'in_progress' }] }))
  const nodes = treeNodes(rendered)
  const history = nodes.find(node => node.props.className?.includes('task-graph-history'))
  assert.ok(history, 'stale graph remains available in a historical disclosure')
  assert.equal(history.tag, 'details')
  assert.notEqual(history.props.open, true)
  assert.match(treeText(history.children[0]), /历史任务图.*旧任务 A/u)
  assert.ok(nodes.findIndex(node => node.props['data-run-todo-id'] === 'new-todo') < nodes.indexOf(history))
})

test('long graphs keep active and blocked nodes visible while retaining every node in disclosure', async () => {
  const client = await loadClient()
  const nodes = Array.from({ length: 64 }, (_, index) => ({ id: `node-${index}`, title: `任务 ${index}`, dependencies: [],
    acceptance: [{ id: 'a1', text: '完成此步骤' }], status: index === 40 ? 'running' : index === 50 ? 'blocked' : index < 12 ? 'completed' : 'pending',
    attempt: index === 40 || index === 50 ? 1 : 0, startSeq: null, evidence: [], feedback: [] }))
  const input = taskGraph({ nodes })
  const before = JSON.stringify(input)
  const rendered = client.renderTaskGraphSection(treeElement, client.taskGraphPresentation(input))
  const all = treeNodes(rendered)
  const lists = all.filter(node => node.tag === 'ol')
  const visible = treeNodes(lists[0]).filter(node => node.props['data-task-node'] !== undefined)
  assert.ok(visible.length < 64)
  assert.ok(visible.some(node => node.props['data-task-node'] === 'node-40'))
  assert.ok(visible.some(node => node.props['data-task-node'] === 'node-50'))
  assert.ok(visible.every(node => node.props['data-task-node-status'] !== 'completed'), 'completed history does not fill the compact current list')
  assert.equal(all.filter(node => node.props['data-task-node'] !== undefined).length, 64)
  const disclosure = all.find(node => node.props.className?.includes('task-graph-more'))
  assert.ok(disclosure)
  assert.notEqual(disclosure.props.open, true)
  assert.equal(JSON.stringify(input), before)
})

test('graph feedback and blocked-node reasons are visible without opening node details', async () => {
  const client = await loadClient()
  const input = taskGraph({ status: 'waiting', feedback: [{ text: '调整为先核对来源，再生成汇总', outcome: 'needs-work' }],
    nodes: taskGraph().nodes.map(node => node.id === 'ui' ? { ...node, status: 'blocked', feedback: [{ text: '需要补充文件路径', outcome: 'failed' }] } : node) })
  const view = client.taskGraphPresentation(input)
  const rendered = client.renderTaskGraphSection(treeElement, view)
  const all = treeNodes(rendered)
  const graphFeedback = all.find(node => node.props.className === 'task-graph-feedback')
  assert.ok(graphFeedback)
  assert.match(treeText(graphFeedback.children[0]), /图的最近反馈.*调整为先核对来源/u)
  const blocked = all.find(node => node.props['data-task-node'] === 'ui')
  assert.ok(blocked.children.some(node => node?.props?.className === 'task-graph-feedback-preview' && treeText(node).includes('需要补充文件路径')))
  assert.equal(view.statusLabel, '等待检查')
  assert.equal(view.current, undefined)
})

test('the current blocked step exposes its feedback before the generic node list', async () => {
  const client = await loadClient()
  const input = taskGraph({ status: 'ready', nodes: [
    { ...taskGraph().nodes[2], id: 'next', dependencies: [], title: '其他可开始步骤' },
    { ...taskGraph().nodes[1], id: 'blocked-last', title: '补充来源文件', status: 'blocked', feedback: [{ text: '缺少原始文件路径', outcome: 'failed' }] },
  ] })
  const rendered = client.renderTaskGraphSection(treeElement, client.taskGraphPresentation(input))
  const feedbackIndex = rendered.children.findIndex(node => node.props?.className === 'task-graph-current-feedback')
  assert.ok(feedbackIndex >= 0)
  assert.match(treeText(rendered.children[feedbackIndex]), /最近反馈.*缺少原始文件路径/u)
  assert.ok(feedbackIndex < rendered.children.findIndex(node => node.tag === 'ol'))
})

test('reviewer evidence names the matching acceptance text even when evidence order differs', async () => {
  const client = await loadClient()
  const input = taskGraph()
  input.nodes[0] = { ...input.nodes[0], acceptance: [{ id: 'criterion-a', text: '核对来源' }, { id: 'criterion-b', text: '输出可打开' }],
    evidence: [{ ...input.nodes[0].evidence[0], acceptanceId: 'criterion-b', assertion: '能够打开', sourceExcerpt: 'file opened' },
      { ...input.nodes[0].evidence[0], acceptanceId: 'criterion-a', assertion: '来源一致', sourceExcerpt: 'source matches' }] }
  const labels = client.taskGraphPresentation(input).nodes[0].evidenceLabels
  assert.match(labels[0], /验收评估.*输出可打开.*file opened/u)
  assert.match(labels[1], /验收评估.*核对来源.*source matches/u)
  assert.doesNotMatch(labels.join(' '), /独立验证|criterion-[ab]/u)
})

test('a retained stale graph does not hide a new task todo or replace the actual current heading', async () => {
  const client = await loadClient()
  const todo = { id: 'task-b-todo', text: '处理当前简单任务 B', status: 'in_progress' }
  const run = emptyRun({ taskGraph: taskGraph({ stale: true, status: 'waiting', objective: '旧任务 A' }), todos: [todo] })
  const view = client.runCenterWorkbenchPresentation(run)
  assert.deepEqual(view.activeTodos, [todo])
  assert.ok(view.taskGraph, 'old graph remains an explicitly stale historical reference')
  const e = (tag, props, ...children) => ({ tag, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined) })
  const render = runCenter => client.renderRunCenterPanel(e, {
    runCenter, taskGoal: '当前任务 B', surfaces: [], runtimeState: 'running', stopping: false, questionCount: 0,
    approvalCount: 0, contextView: client.contextPresentation(undefined), heartbeat: { status: '正常', detail: '', running: false },
  })
  const find = (node, predicate) => node && typeof node === 'object'
    ? predicate(node) ? node : node.children?.map(child => find(child, predicate)).find(Boolean) : undefined
  const rendered = render(run)
  const heading = find(rendered, node => node.props.className === 'task-summary-head')
  assert.equal(heading.children[0].children[0], '当前任务 B')
  assert.ok(find(rendered, node => node.props['data-run-todo-id'] === todo.id))
  const current = emptyRun({ taskGraph: taskGraph({ stale: false, objective: '当前任务图' }), todos: [todo] })
  assert.deepEqual(client.runCenterWorkbenchPresentation(current).activeTodos, [])
  assert.equal(find(render(current), node => node.props.className === 'task-summary-head').children[0].children[0], '当前任务图')
})

test('task graph presentation names real dependencies and distinguishes assessment from independent verification', async () => {
  const client = await loadClient()
  const view = client.taskGraphPresentation(taskGraph())
  assert.equal(view.summary, '1 / 3 个节点完成')
  assert.equal(view.current, '实现桌面任务面板')
  assert.equal(view.nodes[1].statusLabel, '进行中')
  assert.deepEqual(view.nodes[2].dependencies, ['实现桌面任务面板'])
  assert.equal(view.nodes[2].statusLabel, '等待依赖')
  assert.match(view.nodes[0].evidenceLabels[0], /验收评估/u)
  assert.doesNotMatch(JSON.stringify(view), /独立验证/u)
  assert.equal(view.nodes[1].attemptLabel, '第 2 次尝试')
  assert.equal(view.nodes[1].latestFeedback, '继续检查窄栏换行')
})

test('task graph presentation preserves blocked, interrupted, recovered and complete distinctions', async () => {
  const client = await loadClient()
  const blocked = taskGraph({ status: 'waiting', nodes: taskGraph().nodes.map(node => node.id === 'ui' ? { ...node, status: 'blocked', feedback: [{ text: '等待用户输入', outcome: 'failed' }] } : node) })
  assert.equal(client.taskGraphPresentation(blocked).nodes[1].statusLabel, '已阻塞')
  assert.equal(client.taskGraphPresentation(blocked).nodes[1].latestFeedback, '等待用户输入')
  assert.deepEqual(client.workbenchNotice(noticeInput(client, { runCenter: emptyRun({ taskGraph: blocked }) })), { kind: 'task', label: '有运行事项需要关注' })

  const interrupted = { ...blocked, recoveryRequired: true, nodes: blocked.nodes.map(node => node.id === 'ui' ? { ...node, status: 'interrupted' } : node) }
  assert.equal(client.taskGraphPresentation(interrupted).nodes[1].statusLabel, '已中断 · 待检查')
  assert.match(client.taskGraphPresentation(interrupted).notices.join(' '), /恢复检查/u)

  const recovered = taskGraph({ status: 'ready', nodes: taskGraph().nodes.map(node => node.id === 'ui' ? { ...node, status: 'pending', attempt: 0, startSeq: null, evidence: [], feedback: [] } : node) })
  assert.equal(client.taskGraphPresentation(recovered).nodes[1].statusLabel, '可开始')

  const completedNodes = taskGraph().nodes.map(node => node.status === 'completed' ? node : ({ ...node, status: 'completed', attempt: Math.max(1, node.attempt), startSeq: node.startSeq ?? 20,
    evidence: node.acceptance.map((criterion, index) => ({ callId: `done-${node.id}-${index}`, resultSeq: 30 + index, toolName: 'review', attempt: Math.max(1, node.attempt), kind: 'reviewer-assessment', acceptanceId: criterion.id, assertion: '评估通过', sourceExcerpt: 'fixture' })) }))
  const complete = client.taskGraphPresentation(taskGraph({ status: 'completed', nodes: completedNodes }))
  assert.equal(complete.summary, '3 / 3 个节点完成')
  assert.equal(complete.current, undefined)
  assert.ok(complete.nodes.every(node => node.statusLabel === '已完成'))
})

test('task graph presentation preserves authoritative waiting without inventing a dependency', async () => {
  const client = await loadClient()
  const pending = { id: 'next', title: '等待恢复', dependencies: [], acceptance: [{ id: 'a1', text: '恢复完成' }], status: 'pending', attempt: 0, startSeq: null, evidence: [], feedback: [] }
  const view = client.taskGraphPresentation(taskGraph({ status: 'waiting', nodes: [pending] }))
  assert.equal(view.status, 'waiting')
  assert.equal(view.statusLabel, '等待检查')
  assert.equal(view.current, undefined)
  assert.match(view.notices.join(' '), /节点状态为最近记录/u)
  assert.equal(view.nodes[0].statusLabel, '等待中')
  assert.notEqual(view.nodes[0].statusLabel, '可开始')
  assert.notEqual(view.nodes[0].statusLabel, '等待依赖')
})

test('authoritative waiting marks running, verifying and completed nodes as retained facts', async () => {
  const client = await loadClient()
  for (const [status, expected] of [['running', '上次记录：进行中'], ['verifying', '上次记录：待验收']]) {
    const waiting = taskGraph({ status: 'waiting', nodes: taskGraph().nodes.map(node => node.id === 'ui' ? { ...node, status } : node) })
    const view = client.taskGraphPresentation(waiting)
    assert.equal(view.statusLabel, '等待检查')
    assert.equal(view.current, undefined)
    assert.equal(view.nodes[1].statusLabel, expected)
    assert.match(view.notices.join(' '), /节点状态为最近记录/u)
  }

  const completedNodes = taskGraph().nodes.map(node => node.status === 'completed' ? node : ({ ...node, status: 'completed', attempt: Math.max(1, node.attempt), startSeq: node.startSeq ?? 20,
    evidence: node.acceptance.map((criterion, index) => ({ callId: `done-${node.id}-${index}`, resultSeq: 30 + index, toolName: 'review', attempt: Math.max(1, node.attempt), kind: 'reviewer-assessment', acceptanceId: criterion.id, assertion: '评估通过', sourceExcerpt: 'fixture' })) }))
  const completeFacts = client.taskGraphPresentation(taskGraph({ status: 'waiting', nodes: completedNodes }))
  assert.equal(completeFacts.statusLabel, '等待检查')
  assert.equal(completeFacts.summary, '节点记录：3 / 3 已完成')
  assert.ok(completeFacts.nodes.every(node => node.statusLabel === '节点记录：已完成'))
  assert.doesNotMatch(completeFacts.summary, /个节点完成/u)
})

test('a graph replaces duplicate legacy todos without hiding unrelated live jobs', async () => {
  const client = await loadClient()
  const view = client.runCenterWorkbenchPresentation(emptyRun({ taskGraph: taskGraph(), todos: [{ id: 'todo-1', text: '实现桌面任务面板', status: 'in_progress' }], jobs: [job('running')] }))
  assert.equal(view.activeTodos.length, 0)
  assert.equal(view.activeJobs.length, 1)
  assert.equal(view.taskGraph.summary, '1 / 3 个节点完成')
})

test('completed execution is neutral and distinct from verified or failed work', async () => {
  const client = await loadClient()
  const input = {
    runtimeState: 'idle', stopping: false, questionCount: 0, approvalCount: 0,
    queued: 0, active: 0, loading: false, attention: false,
  }
  const completed = client.taskStatePresentation({ ...input, receipt: 'completed' })
  assert.equal(completed.label, '已结束')
  assert.equal(completed.tone, undefined)
  assert.match(completed.detail, /不代表所有执行影响均已独立验证/)
  assert.equal(client.taskStatePresentation({ ...input, receipt: 'verified' }).label, '已验证')
  assert.equal(client.taskStatePresentation({ ...input, receipt: 'partial' }).label, '部分验证')
  assert.equal(client.taskStatePresentation({ ...input, receipt: 'failed' }).label, '失败')
  assert.equal(client.taskStatePresentation({ ...input, receipt: 'completed', approvalCount: 1 }).label, '需要确认')
})

test('task width retains rail limits and reserves the conversation without rewriting saved preferences', async () => {
  const client = await loadClient()
  const preferences = Object.freeze({ task: 380, materials: 510, browser: 850 })
  for (const [available, expected] of [[1200, 380], [920, 346], [774, 248], [700, 248], [622, 248], [500, 248]]) {
    assert.equal(client.workbenchPanelWidth('task', preferences, available), expected)
  }
  assert.equal(client.workbenchPanelWidth('task', preferences, 1200), 380, 'fitting a smaller viewport is not a saved-width update')
  assert.deepEqual(preferences, { task: 380, materials: 510, browser: 850 })
})

test('task width clamps positive outliers and falls back for invalid requested widths', async () => {
  const client = await loadClient()
  for (const [requested, expected] of [[1, 248], [247, 248], [248, 248], [280, 280], [400, 400], [401, 400], [2000, 400]]) {
    assert.equal(client.workbenchPanelWidth('task', { task: requested, materials: 420, browser: undefined }, 1600), expected)
  }
  for (const requested of [0, -1, NaN, Infinity, -Infinity, undefined]) {
    assert.equal(client.workbenchPanelWidth('task', { task: requested, materials: 420, browser: undefined }, 1600), 280)
  }
})

test('materials and browser widths reuse their existing bounds and independent preferences', async () => {
  const client = await loadClient()
  for (const available of [500, 900, 1200, 1600, Infinity]) {
    for (const requested of [1, 320, 420, 680, 900, 2000]) {
      const preferences = Object.freeze({ task: 280, materials: requested, browser: requested })
      assert.equal(client.workbenchPanelWidth('materials', preferences, available), client.workSurfaceDockWidth(requested, available))
      assert.equal(client.workbenchPanelWidth('browser', preferences, available), client.browserDockWidth(requested, available))
      assert.equal(preferences.materials, requested)
      assert.equal(preferences.browser, requested)
    }
    assert.equal(client.workbenchPanelWidth('browser', { task: 280, materials: 420, browser: undefined }, available), client.browserDockWidth(undefined, available))
  }
  assert.equal(client.workbenchPanelWidth('materials', { task: 280, materials: 420, browser: 900 }, 1200), 420)
  assert.equal(client.workbenchPanelWidth('browser', { task: 280, materials: 420, browser: 900 }, 1600), 900)
})

test('workbench keyboard navigation cycles the three available views and supports Home and End', async () => {
  const client = await loadClient()
  const views = ['task', 'materials', 'browser']
  for (let index = 0; index < views.length; index++) {
    const current = views[index]
    assert.equal(client.workbenchTabKeyTarget(current, 'ArrowRight', true), views[(index + 1) % views.length])
    assert.equal(client.workbenchTabKeyTarget(current, 'ArrowLeft', true), views[(index + views.length - 1) % views.length])
    assert.equal(client.workbenchTabKeyTarget(current, 'Home', true), 'task')
    assert.equal(client.workbenchTabKeyTarget(current, 'End', true), 'browser')
  }
})

test('without a native bridge navigation excludes browser and normalizes a stale browser selection first', async () => {
  const client = await loadClient()
  for (const current of ['task', 'materials']) {
    const other = current === 'task' ? 'materials' : 'task'
    assert.equal(client.workbenchTabKeyTarget(current, 'ArrowRight', false), other)
    assert.equal(client.workbenchTabKeyTarget(current, 'ArrowLeft', false), other)
    assert.equal(client.workbenchTabKeyTarget(current, 'Home', false), 'task')
    assert.equal(client.workbenchTabKeyTarget(current, 'End', false), 'materials')
  }
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    assert.equal(client.workbenchTabKeyTarget('browser', key, false), client.workbenchTabKeyTarget('task', key, false))
  }
})

test('unhandled keys do not claim a workbench navigation action', async () => {
  const client = await loadClient()
  for (const browserAvailable of [true, false]) for (const current of ['task', 'materials', 'browser']) {
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'ArrowUp', 'ArrowDown', 'a', '']) {
      assert.equal(client.workbenchTabKeyTarget(current, key, browserAvailable), undefined)
    }
  }
})

test('questions have priority over approvals and all task attention without conflating their counts', async () => {
  const client = await loadClient()
  const input = noticeInput(client, {
    questionCount: 2, approvalCount: 3,
    runCenter: emptyRun({ status: 'error', error: 'session not attached', jobs: [job('failed')] }),
    contextView: { ...client.contextPresentation(undefined), level: 'critical' },
    heartbeat: { status: '异常', detail: '', running: true, tone: 'warn' },
  })
  assert.deepEqual(client.workbenchNotice(input), { kind: 'interaction', label: '2 项问题等待回答' })
  assert.deepEqual(client.workbenchNotice({ ...input, questionCount: 1 }), { kind: 'interaction', label: '1 项问题等待回答' })
})

test('approvals remain an interaction notice ahead of task errors when no question is pending', async () => {
  const client = await loadClient()
  const input = noticeInput(client, {
    approvalCount: 3,
    runCenter: emptyRun({ status: 'error', error: 'session not found', jobs: [job('failed')] }),
    contextView: { ...client.contextPresentation(undefined), level: 'critical' },
  })
  assert.deepEqual(client.workbenchNotice(input), { kind: 'interaction', label: '3 项操作等待确认' })
  assert.deepEqual(client.workbenchNotice({ ...input, approvalCount: 1 }), { kind: 'interaction', label: '1 项操作等待确认' })
})

test('missing attachment or session status is distinguished from other task-state failures', async () => {
  const client = await loadClient()
  for (const error of ['session not attached', 'session not found', 'Session NOT ATTACHED']) {
    assert.deepEqual(client.workbenchNotice(noticeInput(client, { runCenter: emptyRun({ status: 'error', error, jobs: [job('failed')] }) })),
      { kind: 'task', label: '任务状态未连接' })
  }
  for (const error of ['connection timed out', 'synthetic diagnostic detail', undefined]) {
    assert.deepEqual(client.workbenchNotice(noticeInput(client, { runCenter: emptyRun({ status: 'error', ...(error === undefined ? {} : { error }) }) })),
      { kind: 'task', label: '任务状态需要关注' })
  }
})

test('an unresolved failed operation creates task attention but successful history does not', async () => {
  const client = await loadClient()
  const failed = noticeInput(client, { runCenter: emptyRun({ jobs: [job('failed')] }) })
  const notice = client.workbenchNotice(failed)
  assert.equal(notice?.kind, 'task')
  assert.match(notice.label, /关注/u)
  assert.equal(client.workbenchNotice(noticeInput(client, { runCenter: emptyRun({ jobs: [job('completed')] }) })), undefined)
  assert.equal(client.workbenchNotice(noticeInput(client, { runCenter: emptyRun({ jobs: [job('running', { finishedAt: undefined })] }) })), undefined)
})

test('attention follows the existing exact-operation repair rule rather than any later success', async () => {
  const client = await loadClient()
  const failure = job('failed', { id: 'failed-operation', label: '同一操作', finishedAt: 200 })
  const success = job('completed', { id: 'repaired-operation', label: '同一操作', startedAt: 300, finishedAt: 400 })
  assert.equal(client.workbenchNotice(noticeInput(client, { runCenter: emptyRun({ jobs: [failure, success] }) })), undefined)
  const unrelated = { ...success, label: '另一操作' }
  assert.equal(client.workbenchNotice(noticeInput(client, { runCenter: emptyRun({ jobs: [failure, unrelated] }) }))?.kind, 'task')
})

test('critical context and warning heartbeat independently remain reachable task notices', async () => {
  const client = await loadClient()
  for (const overrides of [
    { contextView: { ...client.contextPresentation(undefined), level: 'critical' } },
    { heartbeat: { status: '异常', detail: '', running: true, tone: 'warn' } },
  ]) {
    const notice = client.workbenchNotice(noticeInput(client, overrides))
    assert.equal(notice?.kind, 'task')
    assert.match(notice.label, /关注/u)
  }
})

test('idle, loading and normal ready task states do not invent attention or claim verified completion', async () => {
  const client = await loadClient()
  for (const status of ['idle', 'loading', 'ready']) {
    assert.equal(client.workbenchNotice(noticeInput(client, {
      runCenter: emptyRun({ status, error: 'retained not attached diagnostic' }),
    })), undefined, 'a retained diagnostic is not a current error state')
  }
})

test('notice projection does not mutate task evidence or interaction counts', async () => {
  const client = await loadClient()
  const input = noticeInput(client, { questionCount: 1, approvalCount: 2, runCenter: emptyRun({ jobs: [job('failed')] }) })
  const before = JSON.stringify(input)
  assert.deepEqual(client.workbenchNotice(input), { kind: 'interaction', label: '1 项问题等待回答' })
  assert.equal(JSON.stringify(input), before)
})
