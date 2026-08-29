import { describe, expect, it } from 'vitest'
import { completionReceiptProjection, foldCompletionReceipt } from '../src/index.js'

const event = (type: string, data: unknown, seq: number, time = seq * 10) => ({ type, data, seq, time })

describe('completion receipt projection', () => {
  it('folds a completed turn with tool and approval evidence into a verified receipt', () => {
    const receipt = foldCompletionReceipt([
      event('turn/start', { turn: 1 }, 0),
      event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'desktop_click', arguments: '{}' }, 1),
      event('approval/asked', { id: 'a1', toolName: 'desktop_click', callId: 'c1' }, 2),
      event('approval/decided', { id: 'a1', outcome: 'allowed-once' }, 3),
      event('tool/result', { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: 'ok' }, meta: { evidence: 'shot.png' } }, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ])

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      turn: 1,
      outcome: 'verified',
      startedAt: 0,
      completedAt: 50,
      sourceSeq: 5,
      tools: [{ callId: 'c1', name: 'desktop_click', status: 'succeeded', evidence: [{ path: 'shot.png' }] }],
      approvals: [{ id: 'a1', toolName: 'desktop_click', outcome: 'allowed-once' }],
      requirements: [],
      verificationResults: [],
      unverified: [],
    })
  })

  it('marks unknown tool results and interrupted turns as needs verification', () => {
    const receipt = foldCompletionReceipt([
      event('turn/start', { turn: 2 }, 6),
      event('tool/call', { turn: 2, step: 1, callId: 'c2', name: 'write_file', arguments: '{}' }, 7),
      event('turn/end', { turn: 2, reason: { kind: 'interrupted' } }, 8),
    ])

    expect(receipt?.outcome).toBe('partial')
    expect(receipt?.tools[0]?.status).toBe('needs_verification')
    expect(receipt?.unverified).toContain('工具 write_file 的结果未知')
    expect(receipt?.unverified).toContain('任务在完成前中断')
  })

  it('returns the same projection state reference for unrelated events', () => {
    const initial = completionReceiptProjection.init()
    const next = completionReceiptProjection.apply(initial, event('request/header', {}, 0))
    expect(next).toBe(initial)
  })

  it('raises the completion gate when a high-risk mutation has no evidence', () => {
    const receipt = foldCompletionReceipt([
      event('turn/start', { turn: 3 }, 10),
      event('tool/call', { callId: 'c3', name: 'write_file' }, 11),
      event('tool/result', { message: { source: { callId: 'c3' }, isError: false } }, 12),
      event('turn/end', { turn: 3, reason: { kind: 'completed' } }, 13),
    ])
    expect(receipt?.outcome).toBe('partial')
    expect(receipt?.unverified).toContain('高风险工具 write_file 未提供可复查证据')
  })

  it('treats a DSH error content block as a failed tool result', () => {
    const receipt = foldCompletionReceipt([
      event('turn/start', { turn: 4 }, 20),
      event('tool/call', { callId: 'c4', name: 'bash' }, 21),
      event('tool/result', { message: { source: { callId: 'c4' }, content: [{ type: 'text', text: 'denied', isError: true }] } }, 22),
      event('turn/end', { turn: 4, reason: { kind: 'completed' } }, 23),
    ])
    expect(receipt?.tools[0]?.status).toBe('failed')
    expect(receipt?.outcome).toBe('failed')
    expect(receipt?.unverified).toContain('工具 bash 执行失败')
  })

  it('keeps code mutation partial until every required gate is explicitly reported', () => {
    const receipt = foldCompletionReceipt([
      event('turn/start', { turn: 5 }, 30),
      event('tool/call', { callId: 'c5', name: 'write_file' }, 31),
      event('tool/result', {
        message: { source: { callId: 'c5' } },
        meta: { evidence: 'patch.diff', verification: [{ gate: 'typecheck', status: 'passed' }] },
      }, 32),
      event('turn/end', { turn: 5, reason: { kind: 'completed' } }, 33),
    ])
    expect(receipt).toMatchObject({
      outcome: 'partial',
      requirements: ['typecheck', 'test', 'build'],
      verificationResults: [{ gate: 'typecheck', status: 'passed' }],
    })
    expect(receipt?.unverified).toContain('验证门禁 test 未通过')
    expect(receipt?.unverified).toContain('验证门禁 build 未通过')
  })

  it('requires browser evidence for an explicitly declared UI mutation', () => {
    const receipt = foldCompletionReceipt([
      event('turn/start', { turn: 6 }, 40),
      event('tool/call', { callId: 'c6', name: 'write_file' }, 41),
      event('tool/result', {
        message: { source: { callId: 'c6' } },
        meta: {
          evidence: 'ui.patch',
          change: { kind: 'ui', risk: 'medium' },
          verification: [
            { gate: 'typecheck', status: 'passed' },
            { gate: 'test', status: 'passed' },
            { gate: 'build', status: 'passed' },
            { gate: 'browser', status: 'passed' },
          ],
        },
      }, 42),
      event('turn/end', { turn: 6, reason: { kind: 'completed' } }, 43),
    ])
    expect(receipt?.outcome).toBe('partial')
    expect(receipt?.requirements).toContain('browser')
    expect(receipt?.unverified).toContain('验证门禁 browser 未通过')
  })

  it('fails on an explicitly failed required gate', () => {
    const receipt = foldCompletionReceipt([
      event('turn/start', { turn: 7 }, 50),
      event('tool/call', { callId: 'c7', name: 'write_file' }, 51),
      event('tool/result', {
        message: { source: { callId: 'c7' } },
        meta: {
          evidence: 'patch.diff',
          verification: [
            { gate: 'typecheck', status: 'passed' },
            { gate: 'test', status: 'failed', evidence: 'test.log' },
            { gate: 'build', status: 'not-run' },
          ],
        },
      }, 52),
      event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 53),
    ])
    expect(receipt?.outcome).toBe('failed')
  })

  it('holds release work without explicit confirmation and verifies a complete code plan', () => {
    const release = foldCompletionReceipt([
      event('turn/start', { turn: 8 }, 60),
      event('tool/call', { callId: 'c8', name: 'workflow' }, 61),
      event('tool/result', {
        message: { source: { callId: 'c8' } },
        meta: {
          change: { kind: 'release', risk: 'low' },
          verification: [
            { gate: 'typecheck', status: 'passed' },
            { gate: 'test', status: 'passed' },
            { gate: 'build', status: 'passed' },
            { gate: 'profile-dump', status: 'passed', evidence: 'dump.yml' },
            { gate: 'profile-start', status: 'passed', evidence: 'start.json' },
            { gate: 'functional-probe', status: 'passed', evidence: 'probe.json' },
            { gate: 'release-confirmation', status: 'not-run' },
          ],
        },
      }, 62),
      event('turn/end', { turn: 8, reason: { kind: 'completed' } }, 63),
    ])
    expect(release?.outcome).toBe('release_held')

    const code = foldCompletionReceipt([
      event('turn/start', { turn: 9 }, 70),
      event('tool/call', { callId: 'c9', name: 'write_file' }, 71),
      event('tool/result', {
        message: { source: { callId: 'c9' } },
        meta: {
          evidence: 'patch.diff',
          verification: [
            { gate: 'typecheck', status: 'passed' },
            { gate: 'test', status: 'passed' },
            { gate: 'build', status: 'passed' },
          ],
        },
      }, 72),
      event('turn/end', { turn: 9, reason: { kind: 'completed' } }, 73),
    ])
    expect(code?.outcome).toBe('verified')
  })

  it('does not treat arbitrary result text as gate evidence and migrates schema v1 on read', () => {
    const receipt = foldCompletionReceipt([
      event('turn/start', { turn: 10 }, 80),
      event('tool/call', { callId: 'c10', name: 'write_file' }, 81),
      event('tool/result', {
        message: { source: { callId: 'c10' }, content: 'typecheck passed; test passed; build passed' },
        meta: { evidence: 'patch.diff' },
      }, 82),
      event('turn/end', { turn: 10, reason: { kind: 'completed' } }, 83),
    ])
    expect(receipt?.outcome).toBe('partial')
    expect(receipt?.verificationResults).toEqual([])

    const migrated = completionReceiptProjection.schema.parse({
      schemaVersion: 1,
      turn: 1,
      outcome: 'verified',
      startedAt: 0,
      sourceSeq: 0,
      tools: [],
      approvals: [],
      unverified: [],
    })
    expect(migrated).toMatchObject({ schemaVersion: 2, requirements: [], verificationResults: [] })
  })
})
