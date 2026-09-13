import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function client() {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}
const row = (key, kind, text, more = {}) => ({ key, kind, text, ...more })
const run = more => ({ status: 'ready', jobs: [], subagents: [], queue: [], todos: [], skills: [], deliverables: [], ...more })
const element = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) })
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(nodes)] : []

test('settled user cancellation is labeled separately from completion and real failure', async () => {
  const app = await client()
  const base = { runtimeState: 'idle', stopping: false, questionCount: 0, approvalCount: 0, queued: 0, active: 0, loading: false, attention: false }
  const cancelled = app.taskStatePresentation({ ...base, receipt: 'cancelled' })
  assert.equal(cancelled.label, '已取消')
  assert.match(cancelled.detail, /未完成|未验证/u)
  assert.equal(app.taskStatePresentation({ ...base, receipt: 'failed' }).label, '失败')
})

test('lost backend suppresses running and controls through retry, then recovers from fresh health', async () => {
  const app = await client()
  assert.equal(typeof app.runtimeConnectionPresentation, 'function')
  const lost = { status: 'error', value: { heartbeat: { running: true } }, errors: [
    { source: 'desktop', kind: 'NETWORK_ERROR', message: 'Failed to fetch' },
    { source: 'heartbeat', kind: 'NETWORK_ERROR', message: 'Failed to fetch' },
  ] }
  const offline = app.runtimeConnectionPresentation(lost)
  assert.equal(offline.unavailable, true)
  assert.equal(offline.label, '连接中断，任务状态待确认')
  assert.equal(app.runtimeConnectionPresentation({ status: 'loading', value: lost.value }, offline.unavailable).unavailable, true)
  assert.equal(app.runtimeConnectionPresentation({ status: 'ready', value: {} }, true).unavailable, false)
  assert.equal(app.runtimeConnectionPresentation({ status: 'degraded', errors: [{ source: 'heartbeat', kind: 'HEARTBEAT_CHECK_DEGRADED', message: 'lost' }] }).unavailable, false)
})

test('real provider needs_verification receipt stays unknown, not a definite failed send', async () => {
  const app = await client()
  assert.equal(app.sendFailurePhase({kind:'needs_verification',message:'sendTurn did not return a verifiable result'}), 'unknown')
  assert.equal(app.sendFailurePhase({kind:'conflict',message:'not allowed'}), 'failed')
})

test('running model picker keeps current-route effort actionable but prevents route switching', async () => {
  const app = await client()
  const choices = []
  const view = app.renderModelControl(element, {
    snapshot: { status: 'ready', current: { provider: 'p', model: 'm', reasoningEffort: 'high' }, failures: [], groups: [
      { id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model', efforts: [{ id: 'high' }, { id: 'max' }] }] },
    ] },
    running: true, disabled: false, open: true, onToggle() {}, onDismiss() {}, onSelect: value => choices.push(value),
  })
  const all = nodes(view)
  const route = all.find(item => item.props['data-model-route'])
  assert.ok(route, 'real model choice must render')
  assert.equal(route.props.disabled, true)
  route.props.onClick()
  assert.equal(choices.length, 0)
  const effort = all.find(item => item.props['data-effort'] === 'max')
  assert.equal(effort.props.disabled, false)
  effort.props.onClick()
  assert.deepEqual(choices, [{ provider: 'p', model: 'm', reasoningEffort: 'max' }])
})

test('tool chatter collapses while user, answer and actionable errors stay in order', async () => {
  const app = await client()
  assert.equal(typeof app.conversationDisplayEntries, 'function', 'conversation needs a real grouped rendering projection')
  const entries = app.conversationDisplayEntries([
    row('u', 'user', '核对报表'), row('t1', 'tool', 'read input'), row('t2', 'tool', 'search done'),
    row('err', 'tool', 'permission denied', { isError: true }), row('a', 'assistant', 'final answer'),
  ])
  assert.deepEqual(entries.map(item => item.kind), ['message', 'tools', 'message', 'message'])
  assert.deepEqual(entries[1].items.map(item => item.item.key), ['t1', 't2'])
  assert.equal(entries[2].item.text, 'permission denied')
  assert.equal(entries[3].item.text, 'final answer')
  assert.equal(entries[3].eventIndex, 4)
})

test('progress uses public plan and observed errors, never raw reasoning or fabricated completion', async () => {
  const app = await client()
  assert.equal(typeof app.taskProgressSummary, 'function')
  const items = [row('u', 'user', '核对三个报表'), row('a', 'assistant', '', { reasoning: 'PRIVATE_REASONING' })]
  const summary = app.taskProgressSummary({ state: 'running', items, run: run({ todos: [
    { id: '1', text: '读取报表', status: 'completed' }, { id: '2', text: '核对总计', status: 'in_progress' },
  ] }) })
  assert.equal(summary.activity, '核对总计')
  assert.equal(summary.progress, '已完成 1 / 2 项计划')
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_REASONING|100%|已验证/)
  const quiet = app.taskProgressSummary({ state: 'running', items, run: run() })
  assert.equal(quiet.warning, undefined, 'no elapsed-time-based loop accusation')
})

test('repeated failures are an advisory for this turn only, successful polling is not a loop', async () => {
  const app = await client()
  assert.equal(typeof app.taskProgressSummary, 'function')
  const repeated = ['1', '2', '3'].map(id => row(id, 'tool', 'timeout querying service', { isError: true }))
  const summary = app.taskProgressSummary({ state: 'running', items: [row('u', 'user', '查资料'), ...repeated], run: run() })
  assert.match(summary.warning, /3 次/)
  const nextTurn = app.taskProgressSummary({ state: 'running', items: [...repeated, row('new', 'user', '下一题')], run: run() })
  assert.equal(nextTurn.warning, undefined)
  const polling = app.taskProgressSummary({ state: 'running', items: repeated.map(item => ({ ...item, text: 'pending', isError: false })), run: run() })
  assert.equal(polling.warning, undefined)
})

test('a delayed acknowledgement cannot erase text typed meanwhile or another session draft', async () => {
  const app = await client()
  assert.equal(typeof app.shouldClearAcknowledgedDraft, 'function')
  assert.equal(app.shouldClearAcknowledgedDraft('s1', 's1', 'sent', 'sent'), true)
  assert.equal(app.shouldClearAcknowledgedDraft('s1', 's1', 'sent', 'new draft'), false)
  assert.equal(app.shouldClearAcknowledgedDraft('s1', 's2', 'same', 'same'), false)
})

test('send acknowledgement distinguishes local transport from Host admission', async () => {
  const app = await client()
  assert.equal(typeof app.sendStatusPresentation, 'function')
  assert.equal(app.sendStatusPresentation('sending', 'queue').label, '正在发送')
  assert.equal(app.sendStatusPresentation('accepted', 'queue').label, '已接收 · 按顺序执行')
  assert.equal(app.sendStatusPresentation('accepted', 'steer').label, '已接收 · 正在调整方向')
  assert.match(app.sendStatusPresentation('unknown', 'queue').detail, /核对/)
  assert.doesNotMatch(app.sendStatusPresentation('unknown', 'queue').label, /已接收/)
})
