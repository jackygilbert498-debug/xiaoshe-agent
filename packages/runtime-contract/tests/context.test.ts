import { describe, expect, it } from 'vitest'
import {
  deriveCompactionCheckpoints,
  deriveContextBudget,
  parseContextGovernanceSnapshot,
} from '../src/index.js'

describe('ContextGovernance contract', () => {
  it('retains DSH projection payloads without inventing budget facts', () => {
    expect(parseContextGovernanceSnapshot({
      currentSessionId: 's1',
      sessions: { s1: { sessionId: 's1', pressure: { used: 10 }, breakdown: { system: 3 }, usage: { input: 7 } } },
    }).sessions.s1).toEqual({
      sessionId: 's1', pressure: { used: 10 }, breakdown: { system: 3 }, usage: { input: 7 },
      budget: { source: 'dsh-token-meter', level: 'unknown' },
      compactions: [],
    })
  })

  it('prefers projected tokens and derives threshold levels from canonical DSH fields', () => {
    const pressure = { pressureTokens: 60, projectedTokens: 70, contextWindow: 100 }

    expect(deriveContextBudget(pressure)).toEqual({
      source: 'dsh-token-meter', usedTokens: 70, capacityTokens: 100, ratio: 0.7, level: 'elevated',
    })
    expect(deriveContextBudget({ pressureTokens: 90, contextWindow: 100 }).level).toBe('critical')
    expect(pressure).toEqual({ pressureTokens: 60, projectedTokens: 70, contextWindow: 100 })
  })

  it('clamps only the derived presentation ratio and keeps unknown capacity honest', () => {
    expect(deriveContextBudget({ projectedTokens: 120, contextWindow: 100 })).toEqual({
      source: 'dsh-token-meter', usedTokens: 120, capacityTokens: 100, ratio: 1, level: 'critical',
    })
    expect(deriveContextBudget({ pressureTokens: 40 })).toEqual({
      source: 'dsh-token-meter', usedTokens: 40, level: 'unknown',
    })
    expect(deriveContextBudget({ contextWindow: 100 })).toEqual({
      source: 'dsh-token-meter', capacityTokens: 100, level: 'unknown',
    })
    expect(deriveContextBudget({ projectedTokens: -1, contextWindow: Number.NaN })).toEqual({
      source: 'dsh-token-meter', level: 'unknown',
    })
  })

  it('derives checkpoints only from canonical taskTimeline compaction rows', () => {
    expect(deriveCompactionCheckpoints({
      schemaVersion: 2,
      items: [
        { key: 'user:1', seq: 1, kind: 'user', text: '你好' },
        { key: 'compact:9', seq: 9, kind: 'compaction', text: '保留了关键决定' },
        { key: 'bad', seq: '9', kind: 'compaction', text: '错误序号' },
      ],
    })).toEqual([{ key: 'compact:9', seq: 9, summary: '保留了关键决定' }])
    expect(deriveCompactionCheckpoints({ nodes: [{ key: 'fallback', seq: 1, kind: 'compaction', text: '非规范来源' }] })).toEqual([])
  })
})
