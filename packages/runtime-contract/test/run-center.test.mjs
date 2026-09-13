import assert from 'node:assert/strict'
import test from 'node:test'

import { parseRunCenterSnapshot } from '../lib/run-center.js'

test('parseRunCenterSnapshot fails closed for an unknown payload', () => {
  const snapshot = parseRunCenterSnapshot({ status: 'invented', jobs: 'not-an-array' })

  assert.deepEqual(snapshot, {
    status: 'error',
    jobs: [],
    subagents: [],
    queue: [],
    todos: [],
    skills: [],
    deliverables: [],
    error: '运行中心快照无效',
  })
  assert.ok(Object.isFrozen(snapshot))
})

test('parseRunCenterSnapshot keeps bounded product facts and derives real actions', () => {
  const snapshot = parseRunCenterSnapshot({
    sessionId: ' session-1 ',
    status: 'ready',
    jobs: [
      { id: 'job-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 100 },
      { id: 'job-2', kind: 'subagent', label: 'review', status: 'made-up', startedAt: 101 },
    ],
    subagents: [
      { kind: 'child', id: 'child-1', mode: 'continuable', label: '审查', activity: 'running', hasChildren: false, parentAvailable: true },
      { kind: 'diagnostic', id: 'bad-child', reason: 'corrupt' },
    ],
    queue: [
      { id: 'q1', messageId: 'm1', placement: 'queued', preview: '先测试', text: '先测试' },
      { id: 'q2', messageId: 'm2', placement: 'context', preview: '图片', text: null },
    ],
    goal: { id: 'g1', revision: 2, objective: '发布', phase: 'active', roundsStarted: 1, maxGoalRounds: 6 },
    plan: { active: true, pending: false },
    todos: [{ id: 't1', text: '完成测试', status: 'in_progress' }],
    skills: [
      { name: 'review', description: '检查代码', modelInvocable: true },
      { name: 'review', description: '重复项', modelInvocable: false },
    ],
    deliverables: [
      { id: 'd1', title: 'report.md', kind: 'file', source: 'C:/work/report.md', status: 'ready' },
      { id: 'd1', title: 'duplicate', kind: 'file', status: 'ready' },
    ],
  })

  assert.equal(snapshot.sessionId, 'session-1')
  assert.equal(snapshot.jobs.length, 1)
  assert.equal(snapshot.jobs[0].cancellable, false)
  assert.equal(snapshot.subagents[0].canOpen, true)
  assert.equal(snapshot.subagents[0].canInterrupt, true)
  assert.equal(snapshot.subagents[1].canOpen, false)
  assert.equal(snapshot.queue[0].editable, true)
  assert.equal(snapshot.queue[0].steerable, true)
  assert.equal(snapshot.queue[1].editable, false)
  assert.equal(snapshot.skills.length, 1)
  assert.equal(snapshot.deliverables.length, 1)
  assert.equal(snapshot.goal.objective, '发布')
  assert.ok(Object.isFrozen(snapshot.jobs))
})

test('parseRunCenterSnapshot strips unsafe or oversized optional fields', () => {
  const snapshot = parseRunCenterSnapshot({
    status: 'ready',
    jobs: [{
      id: 'job-1',
      kind: 'bash',
      label: `hello\u0000${'x'.repeat(1_000)}`,
      status: 'failed',
      detail: 'z'.repeat(4_000),
      startedAt: -1,
    }],
    subagents: [], queue: [], todos: [], skills: [], deliverables: [],
  })

  assert.equal(snapshot.jobs.length, 0)
})
