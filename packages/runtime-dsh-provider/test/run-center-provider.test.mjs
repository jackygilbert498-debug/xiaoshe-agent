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
  assert.equal(snapshot.skills[0].name, 'review')
  assert.equal(snapshot.deliverables[0].title, 'report.md')
  assert.deepEqual(f.refreshed, ['session-1'])

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
