import assert from 'node:assert/strict'
import test from 'node:test'

import { GRAPH_LIMITS, parseRunCenterSnapshot, parseTaskGraphView } from '../lib/run-center.js'

function graph(overrides = {}) {
  return {
    version: 1, id: 'graph-1', revision: 2, sessionId: 'session-1', taskGeneration: 3,
    goalId: 'goal-1', objective: '交付可验证的任务图', runtimeInstance: 'runtime-a', durability: 'durable',
    nodes: [
      { id: 'build', title: '实现', dependencies: [], acceptance: [{ id: 'a1', text: '实现完成' }], status: 'completed', attempt: 1, startSeq: 10,
        evidence: [{ callId: 'call-1', resultSeq: 12, toolName: 'exec', attempt: 1, kind: 'reviewer-assessment', acceptanceId: 'a1', assertion: '通过评估', sourceExcerpt: '9/9 tests' }], feedback: [] },
      { id: 'review', title: '复核', dependencies: ['build'], acceptance: [{ id: 'a2', text: '复核完成' }], status: 'running', attempt: 1, startSeq: 13,
        evidence: [], feedback: [{ text: '正在检查', outcome: 'needs-work' }] },
    ],
    feedback: [], status: 'completed', stale: false, recoveryRequired: false,
    ...overrides,
  }
}

test('parseTaskGraphView validates v1, strips private fields and recomputes status/topological order', () => {
  const value = graph({
    privateCheckpoint: { hidden: true },
    nodes: graph().nodes.toReversed().map(node => ({ ...node, privateFact: 'hidden' })),
  })
  const parsed = parseTaskGraphView(value, 'session-1')

  assert.equal(parsed.status, 'active', 'wire status is not trusted over node facts')
  assert.deepEqual(parsed.nodes.map(node => node.id), ['build', 'review'])
  assert.equal('privateCheckpoint' in parsed, false)
  assert.equal('privateFact' in parsed.nodes[0], false)
  assert.ok(Object.isFrozen(parsed.nodes))
})

test('parseTaskGraphView never upgrades an authoritative waiting view with private replay failure', () => {
  const pending = { id: 'next', title: '等待恢复', dependencies: [], acceptance: [{ id: 'a1', text: '完成恢复' }], status: 'pending', attempt: 0, startSeq: null, evidence: [], feedback: [] }
  assert.equal(parseTaskGraphView(graph({ status: 'waiting', nodes: [pending] }), 'session-1')?.status, 'waiting', 'ready-looking nodes cannot erase private producer failure')
  assert.equal(parseTaskGraphView(graph({ status: 'waiting' }), 'session-1')?.status, 'waiting', 'running nodes cannot erase private producer failure')
})

test('parseTaskGraphView rejects malformed, cyclic, oversized and cross-session graphs', () => {
  assert.equal(parseTaskGraphView({ ...graph(), version: 2 }, 'session-1'), undefined)
  assert.equal(parseTaskGraphView(graph({ nodes: graph().nodes.map(node => node.id === 'build' ? { ...node, dependencies: ['review'] } : node) }), 'session-1'), undefined)
  assert.equal(parseTaskGraphView(graph({ nodes: Array.from({ length: GRAPH_LIMITS.nodes + 1 }, (_, index) => ({ ...graph().nodes[0], id: `n-${index}` })) }), 'session-1'), undefined)
  assert.equal(parseTaskGraphView(graph(), 'session-other'), undefined)
})

test('parseRunCenterSnapshot keeps graph optional for old sessions and rejects a foreign graph only', () => {
  const old = parseRunCenterSnapshot({ sessionId: 'session-1', status: 'ready', jobs: [], subagents: [], queue: [], todos: [], skills: [], deliverables: [] })
  assert.equal(old.taskGraph, undefined)

  const current = parseRunCenterSnapshot({ sessionId: 'session-1', status: 'ready', jobs: [], subagents: [], queue: [], todos: [], skills: [], deliverables: [], taskGraph: graph() })
  assert.equal(current.taskGraph?.sessionId, 'session-1')
  assert.equal(current.taskGraph?.status, 'active')

  const foreign = parseRunCenterSnapshot({ sessionId: 'session-1', status: 'ready', jobs: [], subagents: [], queue: [], todos: [], skills: [], deliverables: [], taskGraph: graph({ sessionId: 'session-2' }) })
  assert.equal(foreign.status, 'ready')
  assert.equal(foreign.taskGraph, undefined)
})
