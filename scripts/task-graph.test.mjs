import test from 'node:test'
import assert from 'node:assert/strict'

const api = await import('../dist/plugins/task-graph-domain.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
  throw error
})
const definition = (id = 'check', dependencies = []) => ({ id, title: id, dependencies,
  acceptance: [{ id: 'works', text: 'The actual check reports ok.' }] })

test('graph parser rejects malformed, cyclic and oversized plans and detaches snapshots', () => {
  assert.equal(typeof api.parseNodes, 'function', 'Task Graph domain parser must exist')
  for (const nodes of [[], [definition(), definition()], [definition('a', ['missing'])],
    [definition('a', ['b']), definition('b', ['a'])], Array.from({ length: 65 }, (_, i) => definition(`n${i}`))]) {
    assert.throws(() => api.parseNodes(nodes))
  }
  const input = [definition('a'), definition('b', ['a'])]
  const parsed = api.parseNodes(input)
  input[0].title = 'changed'
  assert.equal(parsed[0].title, 'a')
  assert.ok(Object.isFrozen(parsed[0].acceptance))
})

function fixture() {
  assert.equal(typeof api.TaskGraphController, 'function', 'Task Graph controller must exist')
  let generation = 1, failure = false, goal = null
  const events = []
  const session = { id: 'session-a', header: { id: 'session-a' }, snapshotEvents: () => events.slice(),
    append(type, data, opts) { const event = Object.freeze({ type, data: structuredClone(data), seq: events.length, time: 1, ...opts }); events.push(event); return event } }
  const agent = { id: 'agent-a', session }
  const controller = new api.TaskGraphController({ instanceId: 'live-a', flush: async () => {
    if (failure) throw new Error('disk unavailable')
    return true
  }, generation: () => generation, goal: () => goal })
  const command = (action, extra = {}) => { const graph = controller.read(agent).graph; return controller.execute(agent, {
    action, ...(graph ? { graphId: graph.id, revision: graph.revision } : {}), ...extra,
  }) }
  return { controller, agent, session, events, command, fail: value => { failure = value }, generation: value => { generation = value }, goal: value => { goal = value } }
}

test('revision race and pending flush retain a fence until explicit reconciliation', async () => {
  const f = fixture()
  await f.command('create', { objective: 'verify task', nodes: [definition('a'), definition('b', ['a'])] })
  const ref = f.controller.read(f.agent).graph
  const concurrent = await Promise.allSettled([1, 2].map(() => f.command('start', { graphId: ref.id, revision: ref.revision, nodeId: 'a' })))
  assert.deepEqual(concurrent.map(row => row.status).sort(), ['fulfilled', 'rejected'])
  f.fail(true)
  await assert.rejects(f.command('record', { nodeId: 'a', outcome: 'failed', feedback: 'check failed', evidence: [] }), /durab|disk/i)
  assert.equal(f.controller.read(f.agent).graph.durability, 'pending')
  await assert.rejects(f.command('start', { nodeId: 'b' }), /durab/i)
  f.fail(false)
  await f.command('reconcile')
  assert.equal(f.controller.read(f.agent).graph.durability, 'durable')
  await f.command('start', { nodeId: 'a' })
  assert.equal(f.controller.read(f.agent).graph.nodes[0].attempt, 2)
  assert.ok(f.events.filter(event => event.type.startsWith('xiaoshe/task-graph')).every(event => event.ignorable === true))
})

test('new task and cold process fence old work without any automatic retry', async () => {
  const f = fixture()
  await f.command('create', { objective: 'verify task', nodes: [definition()] })
  await f.command('start', { nodeId: 'check' })
  const cold = new api.TaskGraphController({ instanceId: 'cold', flush: async () => true, generation: () => 1, goal: () => null })
  assert.equal(cold.read(f.agent).graph.nodes[0].status, 'interrupted')
  assert.equal(cold.read(f.agent).recoveryRequired, true)
  f.generation(2)
  assert.equal(f.controller.read(f.agent).stale, true)
  await assert.rejects(f.command('record', { nodeId: 'check', outcome: 'failed', feedback: 'late', evidence: [] }), /task|stale/i)
})

test('a hung durability backend is bounded and cannot hold the graph command forever', async () => {
  const f = fixture()
  const controller = new api.TaskGraphController({ instanceId: 'bounded', flushTimeoutMs: 20,
    flush: () => new Promise(() => {}), generation: () => 1, goal: () => null })
  await assert.rejects(controller.execute(f.agent, { action: 'create', objective: 'bounded flush', nodes: [definition()] }), /durab|timeout/i)
  assert.equal(controller.read(f.agent).graph.durability, 'pending')
  await assert.rejects(controller.execute(f.agent, { action: 'start', graphId: controller.read(f.agent).graph.id,
    revision: controller.read(f.agent).graph.revision, nodeId: 'check' }), /durab/i)
})

test('completed graph replacement is CAS protected and a corrupted owned event cannot claim completion', async () => {
  const f = fixture()
  await f.command('create', { objective: 'replace CAS', nodes: [definition()] })
  f.generation(2)
  await assert.rejects(f.command('create', { graphId: 'wrong', revision: 999, objective: 'new task', nodes: [definition()] }), /revision|stale/i)
  f.session.append(api.GRAPH_EVENT, { version: 999, action: 'change', graph: f.controller.read(f.agent).graph }, { ignorable: true })
  assert.match(f.controller.read(f.agent).error, /replay/)
  assert.equal(f.controller.read(f.agent).graph.status, 'waiting')
})

test('replay rejects a whole-state completion with invented execution evidence', async () => {
  const f = fixture()
  await f.command('create', { objective: 'No forged completion', nodes: [definition()] })
  await f.command('start', { nodeId: 'check' })
  const { status, stale, recoveryRequired, ...snapshot } = f.controller.read(f.agent).graph
  const forged = { ...snapshot, revision: snapshot.revision + 1, durability: 'pending', nodes: snapshot.nodes.map(node => ({
    ...node, status: 'completed', evidence: [{ callId: 'invented', resultSeq: 0, toolName: 'check', attempt: 1,
      kind: 'reviewer-assessment', acceptanceId: 'works', assertion: 'It passed.', sourceExcerpt: 'ok' }],
  })) }
  f.session.append(api.GRAPH_EVENT, { version: 1, action: 'change', graph: forged }, { ignorable: true })
  assert.match(f.controller.read(f.agent).error, /evidence|acceptance|transition/i)
  assert.equal(f.controller.read(f.agent).graph.status, 'waiting')
})

test('Goal replacement fences both host reads and projected wire state', async () => {
  const f = fixture()
  f.goal({ id: 'goal-old', phase: 'active' })
  await f.command('create', { objective: 'Old goal graph', nodes: [definition()] })
  f.goal({ id: 'goal-new', phase: 'active' })
  f.session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'goal-new' } })
  assert.equal(f.controller.read(f.agent).graph.stale, true)
  const state = f.events.reduce(api.applyGraphEvent, api.initialGraphState())
  assert.equal(api.graphView(state, 'live-a', 1).stale, true)
  await assert.rejects(f.command('start', { nodeId: 'check' }), /stale/)
})
