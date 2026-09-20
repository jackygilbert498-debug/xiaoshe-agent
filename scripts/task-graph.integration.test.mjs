import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { SessionStore } from '../runtime/DSH/packages/core/session/lib/index.js'
import { ToolRuntime } from '../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt } from '../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { SessionProjectionRegistry } from '../runtime/DSH/packages/session/session-projection/lib/index.js'
import { createToolResultMessage, createUserMessage } from '../runtime/DSH/packages/llm/llm/lib/index.js'
import { scopeTarget } from '../runtime/DSH/packages/core/scope/lib/index.js'
import { apply } from '../dist/plugins/task-graph.js'
import { apply as applyReliability } from '../dist/plugins/agent-reliability.js'

const node = (id, dependencies = []) => ({ id, title: `Check ${id}`, dependencies, acceptance: [{ id: 'ok', text: 'The real check says ok.' }] })
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
async function fixture(t, withReliability = false) {
  const ctx = new Context()
  new SessionStore(ctx); new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx); new SessionProjectionRegistry(ctx)
  let generation = 1, goal = null, failFlush = false, succeeds = true, count = 0
  if (withReliability) applyReliability(ctx)
  else ctx.provide('xiaosheAgentReliability', { snapshot: () => ({ taskGeneration: generation }) })
  ctx.provide('goals', { get: () => goal })
  ctx.on('session/flush', () => { if (failFlush) throw new Error('disk failed') })
  apply(ctx)
  const session = ctx.sessions.create('graph-real-session')
  const agent = { id: 'graph-real-agent', session, ctx }
  const executed = []
  ctx.tools.register({ name: 'check', description: 'Actual deterministic verifier.', parameters: { type: 'object', properties: {} }, output,
    async execute() { executed.push('check'); return { exitCode: succeeds ? 0 : 1, check: succeeds ? 'ok' : 'failed' } } })
  ctx.tools.register({ name: 'update_goal', description: 'Complete goal.', parameters: { type: 'object', additionalProperties: true }, output,
    async execute() { goal = { ...goal, phase: 'complete' }; return goal } })
  ctx.tools.register({ name: 'read', description: 'Independent ordinary tool.', parameters: { type: 'object', properties: {} }, output,
    async execute() { executed.push('read'); return { ok: true } } })
  t.after(() => ctx.fiber.dispose())
  async function call(name, args = {}) {
    const callId = `call-${++count}`
    const event = session.append('tool/call', { turn: 1, step: count, callId, name, arguments: JSON.stringify(args) })
    const result = await ctx.tools.execute({ name, arguments: args, callId, agent, signal: new AbortController().signal })
    session.append('tool/result', { turn: 1, step: count, message: createToolResultMessage({ callId, content: result.content, isError: result.isError }) }, { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
    return { ...result, callId }
  }
  const read = () => ctx.xiaosheTaskGraph.read(agent)
  const command = (action, extra = {}) => {
    const graph = read().graph
    return call('xiaoshe_task_graph', { action, ...(graph ? { graphId: graph.id, revision: graph.revision } : {}), ...extra })
  }
  return { ctx, agent, session, call, read, command, executed, generation: value => { generation = value }, goal: value => { goal = value }, failFlush: value => { failFlush = value }, succeeds: value => { succeeds = value } }
}
async function ok(promise) { const result = await promise; assert.equal(result.isError, false, JSON.stringify(result)); return result }
async function complete(f, id, callId) {
  await ok(f.command('record', { nodeId: id, outcome: 'passed', feedback: 'check succeeded', evidence: [callId] }))
  await ok(f.command('verify', { nodeId: id, assessments: [{ acceptanceId: 'ok', callId, assertion: 'The observed check satisfies this explicit criterion.', sourceExcerpt: '"check":"ok"' }] }))
}

test('real tools bind evidence, fail and retry the same tool, preserving completed prerequisites', async t => {
  const f = await fixture(t)
  const before = await f.call('check')
  const created = await ok(f.command('create', { objective: 'Two stage check', nodes: [node('a'), node('b', ['a'])] }))
  await ok(f.command('start', { nodeId: 'a' }))
  for (const callId of [before.callId, created.callId, 'invented']) {
    assert.equal((await f.command('record', { nodeId: 'a', outcome: 'passed', feedback: 'claim', evidence: [callId] })).isError, true)
  }
  const a = await f.call('check')
  await complete(f, 'a', a.callId)
  await ok(f.command('start', { nodeId: 'b' }))
  f.succeeds(false)
  const failed = await f.call('check')
  assert.equal((await f.command('record', { nodeId: 'b', outcome: 'passed', feedback: 'false claim', evidence: [failed.callId] })).isError, true)
  await ok(f.command('record', { nodeId: 'b', outcome: 'failed', feedback: 'Actual check exit 1; correct the input and retry the same tool.', evidence: [] }))
  const assembly = await f.ctx.systemPrompt.assemble({ agent: f.agent })
  assert.match(assembly.contexts.find(row => row.name === 'xiaoshe:task-graph').text, /Actual check exit 1/)
  f.succeeds(true)
  await ok(f.command('start', { nodeId: 'b' }))
  assert.equal((await f.command('record', { nodeId: 'b', outcome: 'passed', feedback: 'reuse wrong node', evidence: [a.callId] })).isError, true)
  const b = await f.call('check')
  await complete(f, 'b', b.callId)
  const view = f.ctx.sessionProjections.snapshot(f.session).values.taskGraph
  assert.equal(view.status, 'completed')
  assert.deepEqual(view.nodes.map(node => node.attempt), [1, 2])
  assert.equal(view.nodes[1].evidence[0].kind, 'reviewer-assessment')
})

test('replan invalidates changed dependencies and assessments while preserving unrelated completed nodes', async t => {
  const f = await fixture(t)
  await ok(f.command('create', { objective: 'Branch check', nodes: [node('a'), node('b', ['a']), node('c')] }))
  for (const id of ['a', 'b', 'c']) { await ok(f.command('start', { nodeId: id })); await complete(f, id, (await f.call('check')).callId) }
  await ok(f.command('replan', { nodes: [{ ...node('a'), title: 'Changed prerequisite' }, node('b', ['a']), node('c')], feedback: 'Requirement changed for a.' }))
  assert.deepEqual(f.read().graph.nodes.map(node => node.status), ['pending', 'pending', 'completed'])
  assert.deepEqual(f.read().graph.nodes.slice(0, 2).map(node => node.evidence.length), [0, 0])
})

test('matching Goal completion waits for durable acceptance; independent tools and unmatched Goals remain available', async t => {
  const f = await fixture(t)
  f.goal({ id: 'goal-a', phase: 'active' })
  await ok(f.command('create', { objective: 'Goal check', nodes: [node('a')] }))
  assert.equal((await f.call('update_goal', { action: 'complete', goal_id: 'goal-a' })).isError, true)
  await ok(f.call('read'))
  await ok(f.command('start', { nodeId: 'a' }))
  const check = await f.call('check')
  await complete(f, 'a', check.callId)
  await ok(f.call('update_goal', { action: 'complete', goal_id: 'goal-a' }))
  assert.equal(f.executed.filter(name => name === 'read').length, 1)
})

test('a pending-durability fence survives a new task and can still be reconciled', async t => {
  const f = await fixture(t)
  f.failFlush(true)
  assert.equal((await f.command('create', { objective: 'Persist me', nodes: [node('a')] })).isError, true)
  f.generation(2)
  await ok(f.command('read'))
  f.failFlush(false)
  await ok(f.command('reconcile'))
  await ok(f.command('create', { objective: 'New task', nodes: [node('b')] }))
  assert.equal(f.read().graph.taskGeneration, 2)
})

test('late asynchronous results and other-session references cannot certify a newer attempt', async t => {
  const f = await fixture(t)
  let finish, admitted
  const started = new Promise(resolve => { admitted = resolve })
  f.ctx.tools.register({ name: 'slow_check', description: 'Delayed actual result.', parameters: { type: 'object', properties: {} }, output,
    async execute() { admitted(); return new Promise(resolve => { finish = () => resolve({ exitCode: 0, check: 'ok' }) }) } })
  await ok(f.command('create', { objective: 'Late result check', nodes: [node('a')] }))
  await ok(f.command('start', { nodeId: 'a' }))
  const pending = f.call('slow_check')
  await started
  await ok(f.command('record', { nodeId: 'a', outcome: 'failed', feedback: 'Abandon this attempt pending status inspection.', evidence: [] }))
  await ok(f.command('start', { nodeId: 'a' }))
  finish()
  const late = await pending
  assert.equal((await f.command('record', { nodeId: 'a', outcome: 'passed', feedback: 'late claim', evidence: [late.callId] })).isError, true)
  const other = await fixture(t)
  await ok(other.command('create', { objective: 'Other session', nodes: [node('a')] }))
  await ok(other.command('start', { nodeId: 'a' }))
  const foreign = await other.call('check')
  assert.equal((await f.command('record', { nodeId: 'a', outcome: 'passed', feedback: 'foreign claim', evidence: [foreign.callId] })).isError, true)
  await complete(f, 'a', (await f.call('check')).callId)
})

test('repeated failed checks retain bounded feedback and never permanently disable the same tool or node', async t => {
  const f = await fixture(t)
  await ok(f.command('create', { objective: 'Retry with new evidence', nodes: [node('a')] }))
  for (let attempt = 0; attempt < 12; attempt++) {
    await ok(f.command('start', { nodeId: 'a' }))
    f.succeeds(false)
    await ok(f.call('check'))
    await ok(f.command('record', { nodeId: 'a', outcome: 'failed', feedback: `Actual check failed at attempt ${attempt + 1}.`, evidence: [] }))
  }
  await ok(f.command('start', { nodeId: 'a' }))
  f.succeeds(true)
  await complete(f, 'a', (await f.call('check')).callId)
  assert.equal(f.read().graph.nodes[0].attempt, 13)
  assert.equal(f.read().graph.nodes[0].feedback.length, 8)
  assert.equal(f.read().graph.feedback.length, 8)
  assert.equal(f.read().graph.status, 'completed')
})

test('an inherited graph is visibly stale in a different Session and cannot admit work', async t => {
  const f = await fixture(t)
  await ok(f.command('create', { objective: 'Original session plan', nodes: [node('a')] }))
  const inherited = f.ctx.sessions.create('different-session')
  const other = { ...f.agent, id: 'different-agent', session: inherited }
  // Copy the actual whole-state records into a different live Session identity.
  for (const event of f.session.snapshotEvents().filter(event => event.type === 'xiaoshe/task-graph')) {
    inherited.append(event.type, event.data, { ignorable: true })
  }
  const view = f.ctx.sessionProjections.snapshot(inherited).values.taskGraph
  assert.equal(view.stale, true)
  assert.equal(f.ctx.xiaosheTaskGraph.read(other).graph.stale, true)
  await assert.rejects(f.ctx.xiaosheTaskGraph.execute(other, { action: 'start', graphId: view.id, revision: view.revision, nodeId: 'a' }), /stale/)
})

test('actual reliability accepts a canonical durable Graph plan without duplicate todo and retains independent read evidence', async t => {
  const f = await fixture(t, true)
  let writes = 0
  f.ctx.tools.register({ name: 'todo_write', description: 'Existing task planner.', parameters: { type: 'object', properties: { todos: { type: 'array' } } }, output,
    async execute() { throw new Error('Graph should avoid duplicate todo planning') } })
  f.ctx.tools.register({ name: 'write', description: 'Write project output.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, output,
    async execute() { writes++; return {} } })
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '全面检查现有项目，定位根因、修改实现并运行测试验证' }] })
  f.ctx.emit(scopeTarget(f.agent, f.agent), 'agent/inbox/claimed', { agent: f.agent, message })
  f.session.append('user/message', message, { surfaceOp: 'append' })
  f.ctx.emit(scopeTarget(f.agent, f.agent), 'agent/assistant-stream', { agent: f.agent, frame: { type: 'start' } })
  assert.equal((await f.call('write', { path: 'result.ts' })).isError, true)
  await ok(f.command('create', { objective: 'Inspect, modify and verify', nodes: [node('a')] }))
  assert.equal((await ok(f.call('xiaoshe_runtime_info'))).value.execution.preflight.plan_recorded, true,
    'canonical durable Graph planning must be recognized by the existing preparation state')
  assert.equal((await f.call('write', { path: 'result.ts' })).isError, true, 'planning alone must not replace independent read evidence')
  await ok(f.call('read', { path: 'result.ts' }))
  await ok(f.call('write', { path: 'result.ts' }))
  assert.equal(writes, 1)
})

test('actual reliability cold replay restores canonical Graph planning only for its original task generation', async t => {
  const first = await fixture(t, true)
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '全面检查现有项目，定位根因、修改实现并运行测试验证' }] })
  first.ctx.emit(scopeTarget(first.agent, first.agent), 'agent/inbox/claimed', { agent: first.agent, message })
  first.session.append('user/message', message, { surfaceOp: 'append' })
  first.ctx.emit(scopeTarget(first.agent, first.agent), 'agent/assistant-stream', { agent: first.agent, frame: { type: 'start' } })
  await ok(first.command('create', { objective: 'Durable plan', nodes: [node('a')] }))
  const cold = await fixture(t, true)
  for (const event of first.session.snapshotEvents()) {
    const opts = event.surfaceOp === undefined ? (event.ignorable ? { ignorable: true } : undefined)
      : { surfaceOp: event.surfaceOp, ...(event.sourceEventSeqs ? { sourceEventSeqs: event.sourceEventSeqs } : {}) }
    cold.session.append(event.type, event.data, opts)
  }
  cold.ctx.emit(scopeTarget(cold.agent, cold.agent), 'agent/session-start', { agent: cold.agent, source: 'resume' })
  assert.equal((await ok(cold.call('xiaoshe_runtime_info'))).value.execution.preflight.plan_recorded, true)
  const next = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '开始一个新任务：设计一个与旧项目无关的会议安排。' }] })
  cold.ctx.emit(scopeTarget(cold.agent, cold.agent), 'agent/inbox/claimed', { agent: cold.agent, message: next })
  cold.session.append('user/message', next, { surfaceOp: 'append' })
  cold.ctx.emit(scopeTarget(cold.agent, cold.agent), 'agent/assistant-stream', { agent: cold.agent, frame: { type: 'start' } })
  assert.equal((await ok(cold.call('xiaoshe_runtime_info'))).value.execution.preflight.plan_recorded, false)
  assert.equal(cold.read().stale, true)
})

for (const brokenEvent of ['xiaoshe/task-graph-call', 'xiaoshe/task-graph-result']) {
  test(`optional ${brokenEvent} append failure preserves actual tool execution and requires explicit graph recovery`, async t => {
    const f = await fixture(t)
    await ok(f.command('create', { objective: 'Optional bookkeeping failure', nodes: [node('a')] }))
    await ok(f.command('start', { nodeId: 'a' }))
    const earlier = await ok(f.call('check'))
    const append = f.session.append.bind(f.session)
    f.session.append = (type, data, options) => { if (type === brokenEvent) throw new Error('graph record unavailable'); return append(type, data, options) }
    const actual = await ok(f.call('check'))
    assert.equal(actual.value.exitCode, 0)
    assert.equal(f.executed.filter(name => name === 'check').length, 2)
    assert.match(f.read().error, /graph record unavailable/)
    assert.equal(f.read().graph.status, 'waiting')
    assert.equal((await f.command('record', { nodeId: 'a', outcome: 'passed', feedback: 'Cannot use earlier evidence to hide missing provenance', evidence: [earlier.callId] })).isError, true)
    f.session.append = append
    await ok(f.command('reconcile'))
    assert.equal(f.read().graph.nodes[0].status, 'interrupted')
    await ok(f.command('start', { nodeId: 'a' }))
    assert.equal((await f.command('record', { nodeId: 'a', outcome: 'passed', feedback: 'Lost result cannot certify new attempt', evidence: [actual.callId] })).isError, true)
    await complete(f, 'a', (await f.call('check')).callId)
  })
}

test('optional Graph log and Goal-read failures never break ordinary tools or prompt assembly', async t => {
  const f = await fixture(t)
  await ok(f.command('create', { objective: 'Provider failure', nodes: [node('a')] }))
  await ok(f.command('start', { nodeId: 'a' }))
  const snapshot = f.session.snapshotEvents.bind(f.session)
  f.session.snapshotEvents = () => { throw new Error('graph source unavailable') }
  await ok(f.call('read'))
  assert.match((await f.ctx.systemPrompt.assemble({ agent: f.agent })).contexts.find(row => row.name === 'xiaoshe:task-graph').text, /graph source unavailable/)
  f.session.snapshotEvents = snapshot
  await ok(f.command('reconcile'))
  const getGoal = f.ctx.goals.get
  f.ctx.goals.get = () => { throw new Error('Goal lookup unavailable') }
  await ok(f.call('read'))
  assert.match((await f.ctx.systemPrompt.assemble({ agent: f.agent })).contexts.find(row => row.name === 'xiaoshe:task-graph').text, /Goal lookup unavailable/)
  f.ctx.goals.get = getGoal
  await ok(f.command('reconcile'))
  assert.equal(f.read().error, null)
})

for (const status of ['passed', 'failed', 'unsupported', 'timeout', 'cancelled', 'error']) {
  test(`pure_js_probe ${status} keeps its actual terminal outcome separate from successful tool transport`, async t => {
    const f = await fixture(t)
    f.ctx.tools.register({ name: 'pure_js_probe', description: 'Production-shaped probe outcome.', parameters: { type: 'object', properties: {} }, output,
      async execute() { return { status, runtime: 'quickjs-snapshot', modules: [{ relativePath: 'fixture.mjs', sha256: 'a'.repeat(64) }],
        cases: status === 'passed' ? [{ index: 0, pass: true, actual: { status: 'error' } }] : [], limitations: [], ...(status === 'passed' ? {} : { error: 'interpreter-initialization-failed' }) } } })
    await ok(f.command('create', { objective: 'Probe outcome', nodes: [node('a')] }))
    await ok(f.command('start', { nodeId: 'a' }))
    const result = await ok(f.call('pure_js_probe'))
    const record = await f.command('record', { nodeId: 'a', outcome: 'passed', feedback: 'Check actual execution outcome.', evidence: [result.callId] })
    assert.equal(record.isError, status !== 'passed')
    if (status === 'passed') {
      await ok(f.command('verify', { nodeId: 'a', assessments: [{ acceptanceId: 'ok', callId: result.callId,
        assertion: 'The actual probe cases passed.', sourceExcerpt: '"status":"passed"' }] }))
      assert.equal(f.read().graph.status, 'completed')
    } else {
      assert.equal((await f.command('verify', { nodeId: 'a', assessments: [{ acceptanceId: 'ok', callId: result.callId,
        assertion: 'Failed probe is not proof.', sourceExcerpt: `"status":"${status}"` }] })).isError, true)
      await ok(f.command('record', { nodeId: 'a', outcome: 'failed', feedback: `Actual probe outcome: ${status}`, evidence: [] }))
      assert.equal(f.read().graph.nodes[0].status, 'blocked')
      assert.match((await f.ctx.systemPrompt.assemble({ agent: f.agent })).contexts.find(row => row.name === 'xiaoshe:task-graph').text, new RegExp(`Actual probe outcome: ${status}`))
    }
  })
}

test('ordinary business status fields are not interpreted as known probe execution statuses', async t => {
  const f = await fixture(t)
  f.ctx.tools.register({ name: 'business_read', description: 'Read an incident record.', parameters: { type: 'object', properties: {} }, output,
    async execute() { return { status: 'failed', message: 'timeout/error/cancelled are business data labels' } } })
  await ok(f.command('create', { objective: 'Inspect incident', nodes: [node('a')] }))
  await ok(f.command('start', { nodeId: 'a' }))
  const result = await ok(f.call('business_read'))
  await ok(f.command('record', { nodeId: 'a', outcome: 'passed', feedback: 'The incident record was read successfully.', evidence: [result.callId] }))
})

test('Graph preserves an existing kind=deny decision without recording execution', async t => {
  const f = await fixture(t)
  await ok(f.command('create', { objective: 'Respect dispatcher denial', nodes: [node('a')] }))
  await ok(f.command('start', { nodeId: 'a' }))
  f.ctx.on('tools/pre-execute', async (execution, next) => execution.name === 'check'
    ? { kind: 'deny', reason: 'fixture-owned denial' } : next())
  const denied = await f.call('check')
  assert.equal(denied.isError, true)
  assert.match(denied.error.message, /fixture-owned denial/)
  assert.equal(f.executed.includes('check'), false)
  assert.equal(f.session.snapshotEvents().some(event => event.type === 'xiaoshe/task-graph-call' && event.data.callId === denied.callId), false)
})

test('Graph records actual execution after ask approval without owning the approval decision', async t => {
  const f = await fixture(t)
  let approvals = 0
  f.ctx.provide('approval', { request: async () => { approvals++; return 'allowed-once' } })
  await ok(f.command('create', { objective: 'Respect approved dispatch', nodes: [node('a')] }))
  await ok(f.command('start', { nodeId: 'a' }))
  f.ctx.on('tools/pre-execute', async (execution, next) => execution.name === 'check'
    ? { kind: 'ask', reason: 'fixture-owned approval' } : next())
  const approved = await ok(f.call('check'))
  assert.equal(approvals, 1)
  assert.equal(f.executed.filter(name => name === 'check').length, 1)
  await complete(f, 'a', approved.callId)
})

test('optional Goal lookup degradation fences only matching completion and reconciliation preserves completed work', async t => {
  const f = await fixture(t)
  f.goal({ id: 'goal-a', phase: 'active' })
  await ok(f.command('create', { objective: 'Completion health fence', nodes: [node('a')] }))
  await ok(f.command('start', { nodeId: 'a' }))
  await complete(f, 'a', (await f.call('check')).callId)
  const getGoal = f.ctx.goals.get
  f.ctx.goals.get = () => { throw new Error('Goal lookup unavailable') }
  await ok(f.call('read'))
  const denied = await f.call('update_goal', { action: 'complete', goal_id: 'goal-a' })
  assert.equal(denied.isError, true)
  assert.match(denied.error.message, /taskGraph/)
  f.ctx.goals.get = getGoal
  await ok(f.command('reconcile'))
  assert.equal(f.read().graph.nodes[0].status, 'completed')
  assert.equal(f.read().graph.nodes[0].attempt, 1)
  await ok(f.call('update_goal', { action: 'complete', goal_id: 'goal-a' }))
})

for (const [name, action] of [['screen_click', 'click'], ['screen_type', 'type'], ['screen_press', 'press'], ['screen_focus_window', 'focus']]) {
  for (const status of ['failed', 'stale', 'completed']) {
    test(`${name} ${status} uses the desktop action outcome, not ordinary transport success`, async t => {
      const f = await fixture(t)
      const observation = { status: 'observed', viewport_id: 'after', parent_viewport_id: '', image_path: 'fixture.png',
        sha256: 'a'.repeat(64), captured_at: '2026-09-20T00:00:00Z', pixel_size: { width: 10, height: 10 },
        logical_size: { width: 10, height: 10 }, origin: { x: 0, y: 0 }, scale: 1, elements: [], warnings: [] }
      // ACTION_SCHEMA-shaped result, with changed:false valid even on completed
      // (an already-focused window need not change). No desktop is invoked.
      const value = { status, action, changed: false, message: `Action ${status}`, target: 'a',
        before_viewport_id: 'before', after: observation, added: [], removed: [] }
      f.ctx.tools.register({ name, description: 'Production-shaped desktop result.', parameters: { type: 'object', properties: {} }, output,
        async execute() { return value } })
      await ok(f.command('create', { objective: 'Desktop outcome check', nodes: [node('a')] }))
      await ok(f.command('start', { nodeId: 'a' }))
      const result = await ok(f.call(name))
      assert.deepEqual(result.value, value, 'Graph must preserve the real ordinary result')
      const record = await f.command('record', { nodeId: 'a', outcome: 'passed', feedback: 'Execution outcome check', evidence: [result.callId] })
      assert.equal(record.isError, status !== 'completed')
      const verify = await f.command('verify', { nodeId: 'a', assessments: [{ acceptanceId: 'ok', callId: result.callId,
        assertion: 'Assess actual desktop execution.', sourceExcerpt: `Action ${status}` }] })
      assert.equal(verify.isError, status !== 'completed')
      if (status === 'completed') assert.equal(f.read().graph.status, 'completed')
      else {
        await ok(f.command('record', { nodeId: 'a', outcome: 'failed', feedback: `Desktop ${status}; inspect then retry`, evidence: [] }))
        assert.equal(f.read().graph.nodes[0].status, 'blocked')
      }
    })
  }
}
