import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { mountAgentLoopTestDependencies } from '../runtime/DSH/packages/test-support/agent-loop-testkit/lib/index.js'
import AgentLoop from '../runtime/DSH/packages/core/agent-loop/lib/index.js'
import GoalService from '../runtime/DSH/packages/goal/goal/lib/index.js'
import * as GoalDriver from '../runtime/DSH/packages/goal/goal-round-driver/lib/index.js'
import * as GoalTools from '../runtime/DSH/packages/goal/tool-goal/lib/index.js'
import JsonlSessionPersistence from '../runtime/DSH/packages/session/session-persistence-jsonl/lib/index.js'
import { LlmAdapter } from '../runtime/DSH/packages/llm/llm/lib/index.js'
import * as Graph from '../dist/plugins/task-graph.js'
import * as Reliability from '../dist/plugins/agent-reliability.js'

const node = (id, dependencies = []) => ({ id, title: id, dependencies, acceptance: [{ id: 'expected', text: 'The actual JSON value equals the expected value.' }] })
const textResponse = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const toolResponse = (id, name, args) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
class ScriptedAdapter extends LlmAdapter {
  requests = []; script = []
  async *stream(options) {
    this.requests.push(options)
    const next = this.script.shift()
    if (!next) throw new Error('graph script exhausted')
    for (const chunk of typeof next === 'function' ? next(options) : next) yield chunk
  }
}
async function mount(root, driver = true) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(Reliability)
  await ctx.plugin(Graph)
  await ctx.plugin(GoalTools)
  if (driver) await ctx.plugin(GoalDriver)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}
function waitGoal(ctx, agent, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { off(); reject(new Error('goal did not reach expected state')) }, 15000)
    const off = ctx.on('agent/status', ({ agent: subject }) => {
      if (subject === agent && predicate(ctx.goals.get(agent))) { clearTimeout(timeout); off(); resolve() }
    })
  })
}

test('real Agent and existing Goal driver use feedback next round, same-tool repair, and durable JSONL evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xs-graph-loop-'))
  const root = join(directory, 'sessions'), file = join(directory, 'value.json')
  await writeFile(file, '{"value":1}')
  const { ctx, adapter } = await mount(root)
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const agent = await ctx.agentLoop.create('graph-loop-real', { provider: 'mock', model: 'mock' }, { cwd: directory })
  const checks = []
  ctx.tools.register({ name: 'fixture_check', description: 'Read the fixture and optionally correct its numeric value.',
    parameters: { type: 'object', required: ['expected'], properties: { expected: { type: 'number' }, repair: { type: 'boolean' } } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      if (args.repair) await writeFile(file, JSON.stringify({ value: args.expected }))
      const actual = JSON.parse(await readFile(file, 'utf8')).value
      checks.push({ expected: args.expected, actual, repair: args.repair === true })
      return { exitCode: actual === args.expected ? 0 : 1, actual, expected: args.expected, check: actual === args.expected ? 'ok' : 'failed' }
    },
  })
  let serial = 0
  const graph = (action, extra = {}) => () => {
    const current = ctx.xiaosheTaskGraph.read(agent).graph
    return toolResponse(`graph-${++serial}`, 'xiaoshe_task_graph', { action, ...(current ? { graphId: current.id, revision: current.revision } : {}), ...extra })
  }
  const record = (id, callId) => graph('record', { nodeId: id, outcome: 'passed', feedback: 'Real JSON check passed.', evidence: [callId] })
  const verify = (id, callId) => graph('verify', { nodeId: id, assessments: [{ acceptanceId: 'expected', callId, assertion: 'The observed actual and expected JSON values match.', sourceExcerpt: '"check":"ok"' }] })
  adapter.script = [
    graph('create', { objective: 'Check initial value and then repair and verify value two.', nodes: [node('a'), node('b', ['a'])] }),
    graph('start', { nodeId: 'a' }), toolResponse('check-a', 'fixture_check', { expected: 1 }), record('a', 'check-a'), verify('a', 'check-a'),
    graph('start', { nodeId: 'b' }), toolResponse('check-b-failed', 'fixture_check', { expected: 2 }),
    graph('record', { nodeId: 'b', outcome: 'failed', feedback: 'Value is still one. Next round repair with the SAME fixture_check tool.', evidence: [] }),
    textResponse('The second node needs a corrected value.'),
    graph('start', { nodeId: 'b' }), toolResponse('check-b-repaired', 'fixture_check', { expected: 2, repair: true }), record('b', 'check-b-repaired'), verify('b', 'check-b-repaired'),
    () => { const goal = ctx.goals.get(agent); return toolResponse('complete-goal', 'update_goal', { action: 'complete', goal_id: goal.id, revision: goal.revision }) },
    textResponse('Both acceptance criteria now have actual result references and reviewer assessments.'),
  ]
  const done = waitGoal(ctx, agent, goal => goal?.phase === 'complete')
  ctx.goals.create(agent, { objective: 'Check initial value and repair final value.', maxGoalRounds: 3 })
  await done
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  assert.deepEqual(events.filter(event => event.type === 'tool/result' && event.data.message.content.some(block => block.isError === true)).map(event => event.data.message), [])
  assert.deepEqual(checks, [{ expected: 1, actual: 1, repair: false }, { expected: 2, actual: 1, repair: false }, { expected: 2, actual: 2, repair: true }])
  assert.equal(ctx.goals.get(agent).roundsStarted, 2)
  assert.deepEqual(ctx.xiaosheTaskGraph.read(agent).graph.nodes.map(node => node.attempt), [1, 2])
  const texts = adapter.requests[9].messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.match(texts, /SAME fixture_check/)
  await ctx.sessions.flush(agent.session)
  const handle = await ctx.sessionPersistence.open(agent.id, 'read')
  const stored = await handle.read(); await handle.close()
  const graphEvents = stored.events.filter(event => event.type === 'xiaoshe/task-graph')
  assert.ok(graphEvents.length > 0)
  assert.ok(graphEvents.every(event => event.ignorable === true))
  assert.equal(graphEvents.at(-1).data.graph.durability, 'durable')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).value, 2)
})

test('cold JSONL resume interrupts unfinished Graph and leaves the existing Goal disarmed without effects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xs-graph-resume-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const first = await mount(directory, false)
  const agent = await first.ctx.agentLoop.create('graph-cold-real', { provider: 'mock', model: 'mock' })
  first.ctx.goals.create(agent, { objective: 'Resume safely', maxGoalRounds: 3 })
  const created = await first.ctx.xiaosheTaskGraph.execute(agent, { action: 'create', objective: 'unfinished check', nodes: [node('a')] })
  await first.ctx.xiaosheTaskGraph.execute(agent, { action: 'start', graphId: created.graph.id, revision: created.graph.revision, nodeId: 'a' })
  await first.ctx.sessions.flush(agent.session)
  await first.ctx.fiber.dispose()
  const cold = await mount(directory)
  t.after(() => cold.ctx.fiber.dispose())
  const handle = await cold.ctx.agentLoop.resume(cold.ctx, { resumeSessionId: 'graph-cold-real', agentOptions: { provider: 'mock', model: 'mock' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cold.adapter.requests.length, 0)
  assert.equal(cold.ctx.goals.get(handle.agent).activation, 'disarmed')
  const view = cold.ctx.sessionProjections.snapshot(handle.agent.session).values.taskGraph
  assert.equal(view.nodes[0].status, 'interrupted')
  assert.equal(view.status, 'waiting')
  assert.equal(view.recoveryRequired, true)
  assert.equal(cold.ctx.xiaosheTaskGraph.read(handle.agent).recoveryRequired, true)
})
