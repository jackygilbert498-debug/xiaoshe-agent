import assert from 'node:assert/strict'
import test from 'node:test'

import { taskGraphStatusLines } from '../lib/presentation.js'

function graph(overrides = {}) {
  return {
    version: 1, id: 'graph-1', revision: 1, sessionId: 'session-a', taskGeneration: 1,
    goalId: null, objective: '终端共享任务图', runtimeInstance: 'runtime-a', durability: 'durable', status: 'active', stale: false, recoveryRequired: false,
    nodes: [
      { id: 'build', title: '构建', dependencies: [], acceptance: [{ id: 'a1', text: '构建成功' }], status: 'completed', attempt: 1, startSeq: 2,
        evidence: [{ callId: 'c1', resultSeq: 3, toolName: 'exec', attempt: 1, kind: 'reviewer-assessment', acceptanceId: 'a1', assertion: '通过', sourceExcerpt: 'test' }], feedback: [] },
      { id: 'ship', title: '交付', dependencies: ['build'], acceptance: [{ id: 'a2', text: '交付成功' }], status: 'running', attempt: 2, startSeq: 4, evidence: [], feedback: [] },
    ], feedback: [], ...overrides,
  }
}

test('taskGraphStatusLines uses the shared strict parser and names dependencies/attempts', () => {
  const lines = taskGraphStatusLines({ asOfSeq: 9, values: { taskGraph: graph() } }, 'session-a')
  assert.match(lines[0], /1 \/ 2/u)
  assert.match(lines.join('\n'), /交付.*进行中.*第 2 次/u)
  assert.match(lines.join('\n'), /依赖：构建/u)
  assert.doesNotMatch(lines.join('\n'), /独立验证/u)
})

test('taskGraphStatusLines keeps missing and cross-session projections absent', () => {
  assert.deepEqual(taskGraphStatusLines({ asOfSeq: 1, values: {} }, 'session-a'), [])
  assert.deepEqual(taskGraphStatusLines({ asOfSeq: 1, values: { taskGraph: graph({ sessionId: 'session-b' }) } }, 'session-a'), [])
})

test('taskGraphStatusLines shows the retained graph feedback after a replan', () => {
  const value = graph({ feedback: [{ text: '先确认来源\n再形成汇总', outcome: 'needs-work' }] })
  const lines = taskGraphStatusLines({ asOfSeq: 10, values: { taskGraph: value } }, 'session-a')
  assert.match(lines.join('\n'), /图的最近反馈：先确认来源 再形成汇总/u)
  assert.doesNotMatch(lines.join('\n'), /独立验证/u)
})

test('taskGraphStatusLines preserves authoritative waiting for a ready-looking pending node', () => {
  const pending = { id: 'next', title: '等待恢复', dependencies: [], acceptance: [{ id: 'a1', text: '恢复完成' }], status: 'pending', attempt: 0, startSeq: null, evidence: [], feedback: [] }
  const lines = taskGraphStatusLines({ asOfSeq: 10, values: { taskGraph: graph({ status: 'waiting', nodes: [pending] }) } }, 'session-a')
  assert.match(lines[0], /等待检查/u)
  assert.match(lines.join('\n'), /节点状态为最近记录/u)
  assert.match(lines.join('\n'), /等待恢复 · 等待中/u)
  assert.doesNotMatch(lines.join('\n'), /可开始|等待依赖/u)
})

test('taskGraphStatusLines qualifies retained running, verifying and completed facts while waiting', () => {
  for (const [status, expected] of [['running', '上次记录：进行中'], ['verifying', '上次记录：待验收']]) {
    const waiting = graph({ status: 'waiting', nodes: graph().nodes.map(node => node.id === 'ship' ? { ...node, status } : node) })
    const lines = taskGraphStatusLines({ asOfSeq: 11, values: { taskGraph: waiting } }, 'session-a')
    assert.match(lines[0], /等待检查/u)
    assert.match(lines.join('\n'), new RegExp(expected, 'u'))
    assert.match(lines.join('\n'), /节点状态为最近记录/u)
  }

  const completedNodes = graph().nodes.map(node => node.status === 'completed' ? node : ({ ...node, status: 'completed', attempt: Math.max(1, node.attempt), startSeq: node.startSeq ?? 7,
    evidence: node.acceptance.map((criterion, index) => ({ callId: `done-${node.id}-${index}`, resultSeq: 20 + index, toolName: 'review', attempt: Math.max(1, node.attempt), kind: 'reviewer-assessment', acceptanceId: criterion.id, assertion: '通过', sourceExcerpt: 'fixture' })) }))
  const lines = taskGraphStatusLines({ asOfSeq: 12, values: { taskGraph: graph({ status: 'waiting', nodes: completedNodes }) } }, 'session-a')
  assert.equal(lines[0], '任务图：节点记录 2 / 2 已完成 · 等待检查')
  assert.equal(lines.filter(line => line.includes('节点记录：已完成')).length, 2)
  assert.match(lines.join('\n'), /节点状态为最近记录/u)
})
