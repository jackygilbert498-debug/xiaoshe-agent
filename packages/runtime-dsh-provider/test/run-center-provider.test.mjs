import assert from 'node:assert/strict'
import test from 'node:test'

import { DshRunCenter } from './.generated/client.mjs'

function observable(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    publish(next) { value = next; for (const listener of listeners) listener() },
  }
}

function fixture() {
  const conversation = observable({
    queue: [
      { id: 'q1', messageId: 'm1', placement: 'queued', preview: '调整方向', text: '调整方向' },
      { id: 'q2', messageId: 'm2', placement: 'context', preview: '图片', text: null },
    ],
  })
  const projectionValues = {
    goal: {
      goal: { id: 'goal-1', revision: 2, objective: '完成产品', phase: 'active', maxGoalRounds: 8 },
      roundsStarted: 3,
    },
    plan: { active: true, pending: false },
    todos: [{ content: '跑测试', status: 'in_progress' }],
    taskGraph: {
      version: 1, id: 'graph-1', revision: 1, sessionId: 'session-1', taskGeneration: 0,
      goalId: 'goal-1', objective: '完成产品', runtimeInstance: 'runtime-a', durability: 'durable',
      nodes: [{ id: 'test', title: '跑测试', dependencies: [], acceptance: [{ id: 'a1', text: '测试通过' }], status: 'running', attempt: 1, startSeq: 7, evidence: [], feedback: [] }],
      feedback: [], status: 'active', stale: false, recoveryRequired: false,
    },
  }
  const list = observable({
    current: 'session-1',
    ids: ['session-1'],
    byId: {
      'session-1': { id: 'session-1', blank: false, running: true, updatedAt: 1, projectionValues },
    },
    jobsBySession: {
      'session-1': [{ id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 10 }],
    },
    subagentsByParent: {
      'session-1': {
        state: 'ready', error: null, parentAvailable: true,
        entries: [{ kind: 'child', id: 'child-1', mode: 'continuable', label: '复核', activity: 'running', hasChildren: false }],
      },
    },
  })
  const queueActions = []
  const selected = []
  const refreshed = []
  const session = {
    getSnapshot: conversation.getSnapshot,
    subscribe: conversation.subscribe,
    projections: { faceOf: key => ({ getSnapshot: () => projectionValues[key] }) },
    async updateQueue(itemId, action) { queueActions.push({ itemId, action }); return { ok: true, value: { accepted: true } } },
  }
  const sessions = {
    list,
    binding: id => id === 'session-1' ? { session } : undefined,
    refreshSubagents: async id => { refreshed.push(id) },
    selectSubagent: address => { selected.push(address) },
  }
  const interrupted = []
  const connection = {
    api: {
      skills: { list: async ({ sessionId }) => ({ result: { ok: true, value: { skills: [{ name: 'review', description: `检查 ${sessionId}`, modelInvocable: true }] } } }) },
      subagents: { interrupt: async address => { interrupted.push(address); return { result: { ok: true, value: { accepted: true } } } } },
    },
  }
  const surfaces = observable({
    sessionId: 'session-1',
    items: [{ id: 'file-1', title: 'report.md', type: 'file', status: 'ready', source: 'C:/work/report.md' }],
  })
  return { conversation, list, sessions, connection, surfaces, queueActions, selected, refreshed, interrupted }
}

test('stopped turns keep queue edits but cannot steer, and a new running turn restores steering', async () => {
  const f = fixture(), center = new DshRunCenter(f.sessions, f.connection, f.surfaces)
  const setRunning = running => {
    const list = f.list.getSnapshot()
    f.list.publish({ ...list, byId: { ...list.byId, 'session-1': { ...list.byId['session-1'], running } } })
  }
  setRunning(false)
  assert.equal(center.getSnapshot().queue[0].steerable, false)
  assert.equal((await center.updateQueue({ sessionId: 'session-1', itemId: 'q1', action: { kind: 'steer' } })).ok, false)
  assert.equal(f.queueActions.length, 0)
  assert.equal((await center.updateQueue({ sessionId: 'session-1', itemId: 'q1', action: { kind: 'edit', text: '保留下一条' } })).ok, true)
  setRunning(true)
  assert.equal(center.getSnapshot().queue[0].steerable, true)
  assert.equal((await center.updateQueue({ sessionId: 'session-1', itemId: 'q1', action: { kind: 'steer' } })).ok, true)
  center.dispose()
})

test('DshRunCenter projects public run facts and refreshes skills', async () => {
  const f = fixture()
  const center = new DshRunCenter(f.sessions, f.connection, f.surfaces)

  const result = await center.refresh()

  assert.equal(result.ok, true)
  const snapshot = center.getSnapshot()
  assert.equal(snapshot.sessionId, 'session-1')
  assert.equal(snapshot.jobs[0].cancellable, false)
  assert.equal(snapshot.subagents[0].canInterrupt, true)
  assert.equal(snapshot.queue[0].editable, true)
  assert.equal(snapshot.goal.objective, '完成产品')
  assert.equal(snapshot.todos[0].text, '跑测试')
  assert.equal(snapshot.taskGraph.nodes[0].dependencies.length, 0)
  assert.equal(snapshot.taskGraph.nodes[0].attempt, 1)
  assert.equal(snapshot.skills[0].name, 'review')
  assert.equal(snapshot.deliverables[0].title, 'report.md')
  assert.deepEqual(f.refreshed, ['session-1'])

  center.dispose()
})

test('DshRunCenter passes the raw graph projection through the shared parser and keeps old sessions compatible', () => {
  const f = fixture()
  const raw = f.list.getSnapshot().byId['session-1'].projectionValues.taskGraph
  raw.privateCheckpoint = { hidden: true }
  const center = new DshRunCenter(f.sessions, f.connection, f.surfaces)
  assert.equal(center.getSnapshot().taskGraph.id, 'graph-1')
  assert.equal('privateCheckpoint' in center.getSnapshot().taskGraph, false)

  raw.status = 'waiting'
  raw.nodes = [{ id: 'next', title: '等待恢复', dependencies: [], acceptance: [{ id: 'a1', text: '恢复完成' }], status: 'pending', attempt: 0, startSeq: null, evidence: [], feedback: [] }]
  f.list.publish(f.list.getSnapshot())
  assert.equal(center.getSnapshot().taskGraph.status, 'waiting', 'provider must not upgrade a conservative core view')

  delete f.list.getSnapshot().byId['session-1'].projectionValues.taskGraph
  f.list.publish(f.list.getSnapshot())
  assert.equal(center.getSnapshot().taskGraph, undefined)

  f.list.getSnapshot().byId['session-1'].projectionValues.taskGraph = { ...raw, sessionId: 'foreign-session' }
  f.list.publish(f.list.getSnapshot())
  assert.equal(center.getSnapshot().taskGraph, undefined)
  center.dispose()
})

test('Goal controls map public commands and require current-session phase readback', async () => {
  const f = fixture()
  const center = new DshRunCenter(f.sessions, f.connection, f.surfaces)
  const face = f.sessions.binding('session-1').session
  const commands = []
  face.command = async line => {
    commands.push(line)
    const goal = f.list.getSnapshot().byId['session-1'].projectionValues.goal.goal
    goal.phase = line === '/goal pause' ? 'paused' : 'active'
    return { ok: true, value: { matched: true } }
  }
  for (const action of ['pause', 'resume']) assert.equal((await center.setGoalPhase({ sessionId: 'session-1', action })).ok, true)
  assert.deepEqual(commands, ['/goal pause', '/goal resume'])
  face.command = async () => ({ ok: true, value: { matched: true } })
  assert.equal((await center.setGoalPhase({ sessionId: 'session-1', action: 'pause' })).ok, false, 'matched is not proof of phase change')
  assert.equal((await center.setGoalPhase({ sessionId: 'other', action: 'pause' })).ok, false)
  face.command = async () => {
    f.list.publish({ current: undefined, ids: [], byId: {} })
    return { ok: true, value: { matched: true } }
  }
  assert.equal((await center.setGoalPhase({ sessionId: 'session-1', action: 'pause' })).ok, false)
  center.dispose()
})

test('DshRunCenter exposes only queue and continuable-subagent controls that exist', async () => {
  const f = fixture()
  const center = new DshRunCenter(f.sessions, f.connection, f.surfaces)

  assert.equal((await center.updateQueue({ sessionId: 'session-1', itemId: 'q1', action: { kind: 'edit', text: '新方向' } })).ok, true)
  assert.deepEqual(f.queueActions, [{ itemId: 'q1', action: { kind: 'edit', content: [{ type: 'text', text: '新方向' }] } }])

  assert.equal(center.openSubagent({ parentSessionId: 'session-1', childSessionId: 'child-1' }).ok, true)
  assert.deepEqual(f.selected, [{ parentSessionId: 'session-1', childSessionId: 'child-1', mode: 'continuable' }])

  assert.equal((await center.interruptSubagent({ parentSessionId: 'session-1', childSessionId: 'child-1' })).ok, true)
  assert.deepEqual(f.interrupted, [{ parentSessionId: 'session-1', childSessionId: 'child-1', mode: 'continuable' }])

  const invalid = await center.updateQueue({ sessionId: 'session-1', itemId: 'q2', action: { kind: 'remove' } })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.kind, 'conflict')
  center.dispose()
})

test('DshRunCenter switches subscriptions with the current session and clears stale skills', async () => {
  const f = fixture()
  const center = new DshRunCenter(f.sessions, f.connection, f.surfaces)
  await center.refresh()

  f.list.publish({ current: undefined, ids: [], byId: {}, jobsBySession: {}, subagentsByParent: {} })

  const snapshot = center.getSnapshot()
  assert.equal(snapshot.status, 'idle')
  assert.equal(snapshot.skills.length, 0)
  assert.equal(snapshot.jobs.length, 0)
  center.dispose()
})
