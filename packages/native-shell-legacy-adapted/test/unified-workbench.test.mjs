import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

// Use the actual client exports, as the existing client-product-facts suite
// does. These are pure UI-state tests, not native mounting or React lifecycle
// evidence; browser owner/lease integration remains a separate boundary.
async function loadClient() {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, {
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
  for (const [available, expected] of [[1200, 380], [774, 380], [700, 326], [622, 248], [500, 248]]) {
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
