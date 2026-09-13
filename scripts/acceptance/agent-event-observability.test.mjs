import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildEventDiagnostics,
  extractToolResultFailure,
  isExternalTransportBoundary,
  summarizeLlmRetries,
} from './agent-event-observability.mjs'

function toolResultEvent({ isError, error } = {}) {
  return {
    seq: 7,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 2,
      message: {
        id: 'message-7',
        role: 'user',
        source: { kind: 'tool', callId: 'call-7' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-7',
          content: [{ type: 'text', text: isError ? 'path not found' : 'ok' }],
          isError,
        }],
      },
      ...(error ? { error } : {}),
    },
  }
}

test('extractToolResultFailure reads the standard DSH message block and durable error identity', () => {
  assert.deepEqual(extractToolResultFailure(toolResultEvent({
    isError: true,
    error: { name: 'FileSystemError', code: 'ENOENT' },
  })), {
    isError: true,
    name: 'FileSystemError',
    code: 'ENOENT',
  })

  assert.deepEqual(extractToolResultFailure(toolResultEvent({ isError: true })), {
    isError: true,
  })
  assert.equal(extractToolResultFailure(toolResultEvent({ isError: false })), undefined)
})

test('transport exhaustion is kept separate from a Harness behavior failure', () => {
  assert.equal(isExternalTransportBoundary({
    errors: [],
    llmRetries: { count: 5, startedCount: 5, errorCodes: Array(5).fill('TRANSPORT'), backoffMs: [] },
  }, { turnEnd: 'error', answer: '' }), true)
  assert.equal(isExternalTransportBoundary({
    errors: [],
    llmRetries: { count: 1, startedCount: 1, errorCodes: ['RATE_LIMIT'], backoffMs: [] },
  }, { turnEnd: 'error', answer: '' }), false)
  assert.equal(isExternalTransportBoundary({
    errors: [],
    llmRetries: { count: 1, startedCount: 1, errorCodes: ['TRANSPORT'], backoffMs: [] },
  }, { turnEnd: 'completed', answer: 'done' }), false)
})

test('summarizeLlmRetries reports only retry facts carried by durable DSH events', () => {
  const summary = summarizeLlmRetries([
    {
      type: 'llm/retry',
      data: {
        retryId: 'retry-a',
        turn: 1,
        step: 3,
        provider: 'deepseek',
        mode: 'normal',
        policyKey: 'policy-a',
        retry: 1,
        maxRetries: 5,
        delayMs: 500,
        failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 },
      },
    },
    {
      type: 'llm/retry-started',
      data: { retryId: 'retry-a', turn: 1, step: 3, retry: 1 },
    },
    {
      type: 'llm/retry',
      data: {
        retryId: 'retry-b',
        turn: 2,
        step: 1,
        provider: 'deepseek',
        mode: 'normal',
        policyKey: 'policy-a',
        retry: 2,
        maxRetries: 5,
        delayMs: 1_250,
        failure: { message: 'transport interrupted', code: 'TRANSPORT' },
      },
    },
    // A malformed optional field must be omitted instead of coerced or guessed.
    {
      type: 'llm/retry',
      data: {
        retryId: 'retry-c',
        turn: 3,
        step: 1,
        provider: 'deepseek',
        mode: 'normal',
        policyKey: 'policy-a',
        retry: 3,
        maxRetries: 5,
        delayMs: 'unknown',
        failure: { message: 'unknown failure' },
      },
    },
    { type: 'tool/call', data: { name: 'read' } },
  ])

  assert.deepEqual(summary, {
    count: 3,
    startedCount: 1,
    errorCodes: ['RATE_LIMIT', 'TRANSPORT'],
    backoffMs: [500, 1_250],
  })
})

test('buildEventDiagnostics returns report-ready tool failures and retry telemetry', () => {
  const events = [
    toolResultEvent({ isError: true, error: { name: 'FileSystemError', code: 'ENOENT' } }),
    {
      type: 'llm/retry',
      data: {
        retryId: 'retry-z',
        turn: 4,
        step: 2,
        provider: 'deepseek',
        mode: 'normal',
        policyKey: 'policy-z',
        retry: 1,
        maxRetries: 5,
        delayMs: 750,
        failure: { message: 'timed out', code: 'TIMEOUT' },
      },
    },
  ]

  assert.deepEqual(buildEventDiagnostics(events), {
    errors: [{ isError: true, name: 'FileSystemError', code: 'ENOENT' }],
    llmRetries: {
      count: 1,
      startedCount: 0,
      errorCodes: ['TIMEOUT'],
      backoffMs: [750],
    },
  })
})
