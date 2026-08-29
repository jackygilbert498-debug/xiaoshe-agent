import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  RUNTIME_COMMANDS,
  RUNTIME_SESSION_SCHEMA_VERSION,
  type AgentRuntimeSession,
  type RuntimeCommandErrorKind,
  type RuntimeSessionState,
  type TaskTimeline,
  type TaskTimelineItem,
  type TaskTimelineSnapshot,
} from '../src/index.js'

describe('AgentRuntimeSession public boundary', () => {
  it('contains only the four minimal lifecycle commands', () => {
    expect(RUNTIME_COMMANDS).toEqual(['createSession', 'sendTurn', 'stopRun', 'forkSession'])
    expect(RUNTIME_SESSION_SCHEMA_VERSION).toBe(1)
  })

  it('keeps lifecycle state and error domains explicit', () => {
    expectTypeOf<RuntimeSessionState>().toEqualTypeOf<
      'blank' | 'idle' | 'running' | 'blocked' | 'completed' | 'error' | 'unknown'
    >()
    expectTypeOf<RuntimeCommandErrorKind>().toEqualTypeOf<
      'unsupported' | 'invalid_request' | 'not_found' | 'conflict' | 'transport' | 'provider' | 'needs_verification'
    >()
    expectTypeOf<keyof AgentRuntimeSession>().toEqualTypeOf<
      'getSnapshot' | 'subscribe' | 'createSession' | 'sendTurn' | 'stopRun' | 'forkSession'
    >()
  })

  it('keeps assistant reasoning and error diagnostics separate from visible text', () => {
    expectTypeOf<TaskTimelineItem>().toMatchTypeOf<{
      readonly seq: number
      readonly time?: number
      readonly reasoning?: string
      readonly errorCode?: string
    }>()
    expectTypeOf<TaskTimelineSnapshot>().toMatchTypeOf<{
      readonly total: number
      readonly hasEarlier: boolean
    }>()
    expectTypeOf<keyof TaskTimeline>().toEqualTypeOf<'getSnapshot' | 'subscribe' | 'loadEarlier'>()
  })
})
