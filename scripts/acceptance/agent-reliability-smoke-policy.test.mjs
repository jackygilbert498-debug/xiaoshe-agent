import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildToolCallRecords,
  decideScenarioState,
  hasExactFailedRead,
  hasFailedReadThenRecovery,
  hasExactWriteReadback,
  parseSmokeCliArgs,
  reportExitCode,
} from './agent-reliability-smoke-policy.mjs'

function call(seq, callId, name, argumentsValue) {
  return { seq, type: 'tool/call', data: { callId, name, arguments: argumentsValue } }
}

test('missing-input evidence requires a paired failed read of the exact target', () => {
  const missing = 'C:\\work\\missing.txt'
  const successfulRead = buildToolCallRecords([
    call(1, 'read-ok', 'read', { file_path: missing }),
    result(2, 'read-ok'),
  ])
  const failedRead = buildToolCallRecords([
    call(1, 'read-failed', 'read', { file_path: missing }),
    result(2, 'read-failed', { isError: true }),
  ])

  assert.equal(hasExactFailedRead([], missing), false)
  assert.equal(hasExactFailedRead(successfulRead, missing), false)
  assert.equal(hasExactFailedRead(failedRead, missing), true)
  assert.equal(hasExactFailedRead(failedRead, 'C:\\work\\other.txt'), false)
})

test('route recovery evidence binds one failed source read to a later successful fallback read', () => {
  const missing = 'C:\\work\\missing.txt'
  const fallback = 'C:\\work\\real.txt'
  const recovered = buildToolCallRecords([
    call(1, 'missing', 'read', { file_path: missing }),
    result(2, 'missing', { isError: true }),
    call(3, 'fallback', 'read', { file_path: fallback }),
    result(4, 'fallback'),
  ])
  assert.equal(hasFailedReadThenRecovery(recovered, missing, fallback), true)

  const skippedFailure = buildToolCallRecords([
    call(1, 'fallback', 'read', { file_path: fallback }),
    result(2, 'fallback'),
  ])
  assert.equal(hasFailedReadThenRecovery(skippedFailure, missing, fallback), false)

  const fallbackBeforeFailureSettles = buildToolCallRecords([
    call(1, 'missing', 'read', { file_path: missing }),
    call(2, 'fallback', 'read', { file_path: fallback }),
    result(3, 'fallback'),
    result(4, 'missing', { isError: true }),
  ])
  assert.equal(hasFailedReadThenRecovery(fallbackBeforeFailureSettles, missing, fallback), false)
})

function result(seq, callId, { isError = false } = {}) {
  return {
    seq,
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
          isError,
        }],
      },
    },
  }
}

test('a pass verdict requires both a settled session and turn/end completed', () => {
  assert.equal(decideScenarioState({ settled: true, turnEnd: 'completed', verdict: true }), 'pass')
  assert.equal(decideScenarioState({ settled: true, turnEnd: 'error', verdict: true }), 'fail')
  assert.equal(decideScenarioState({ settled: true, turnEnd: 'missing', verdict: true }), 'fail')
  assert.equal(decideScenarioState({ settled: false, turnEnd: 'completed', verdict: true }), 'fail')
  assert.equal(decideScenarioState({ settled: false, turnEnd: 'missing', verdict: 'pass' }), 'fail')
  assert.equal(decideScenarioState({ settled: false, turnEnd: 'missing', verdict: 'pending_external' }), 'pending_external')
})

test('tool calls are successful only when a non-error result has the same callId', () => {
  const calls = buildToolCallRecords([
    call(1, 'ok', 'read', { file_path: 'C:\\work\\right.txt' }),
    result(2, 'ok'),
    call(3, 'failed', 'read', { file_path: 'C:\\work\\failed.txt' }),
    result(4, 'failed', { isError: true }),
    call(5, 'missing', 'read', { file_path: 'C:\\work\\missing.txt' }),
    result(6, 'orphan'),
    call(7, 'malformed', 'read', { file_path: 'C:\\work\\malformed.txt' }),
    { seq: 8, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'malformed' }, content: [] } } },
  ])

  assert.deepEqual(calls.map(({ callId, succeeded }) => ({ callId, succeeded })), [
    { callId: 'ok', succeeded: true },
    { callId: 'failed', succeeded: false },
    { callId: 'missing', succeeded: false },
    { callId: 'malformed', succeeded: false },
  ])

  const duplicated = buildToolCallRecords([
    call(1, 'duplicate', 'read', { file_path: 'C:\\work\\first.txt' }),
    call(2, 'duplicate', 'read', { file_path: 'C:\\work\\second.txt' }),
    result(3, 'duplicate'),
  ])
  assert.deepEqual(duplicated.map(callRecord => callRecord.succeeded), [false, false])

  const reordered = buildToolCallRecords([
    result(2, 'reordered'),
    call(1, 'reordered', 'read', { file_path: 'C:\\work\\right.txt' }),
  ])
  assert.equal(reordered[0].succeeded, false)
})

test('write delivery requires successful exact-path write followed by exact-path readback', () => {
  const target = 'C:\\work\\out\\result.json'
  const good = buildToolCallRecords([
    call(1, 'write-ok', 'write', JSON.stringify({ file_path: target, content: '{}' })),
    result(2, 'write-ok'),
    call(3, 'read-ok', 'read', { file_path: target }),
    result(4, 'read-ok'),
  ])
  assert.equal(hasExactWriteReadback(good, target), true)

  const wrongDirectory = buildToolCallRecords([
    call(1, 'write-wrong', 'write', { file_path: 'C:\\other\\result.json', content: '{}' }),
    result(2, 'write-wrong'),
    call(3, 'read-wrong', 'read', { file_path: 'C:\\other\\result.json' }),
    result(4, 'read-wrong'),
  ])
  assert.equal(hasExactWriteReadback(wrongDirectory, target), false)

  const failedReadback = buildToolCallRecords([
    call(1, 'write-ok', 'write', { file_path: target, content: '{}' }),
    result(2, 'write-ok'),
    call(3, 'read-failed', 'read', { file_path: target }),
    result(4, 'read-failed', { isError: true }),
  ])
  assert.equal(hasExactWriteReadback(failedReadback, target), false)

  const readBeforeWriteSettles = buildToolCallRecords([
    call(1, 'write-late', 'write', { file_path: target, content: '{}' }),
    call(2, 'read-early', 'read', { file_path: target }),
    result(3, 'read-early'),
    result(4, 'write-late'),
  ])
  assert.equal(hasExactWriteReadback(readBeforeWriteSettles, target), false)
})

test('pending_external is non-zero unless explicitly allowed', () => {
  const checks = [{ id: 'vision', state: 'pending_external' }]
  assert.equal(reportExitCode(checks), 1)
  assert.equal(reportExitCode(checks, { allowPendingExternal: true }), 0)
  assert.equal(reportExitCode([{ id: 'broken', state: 'fail' }], { allowPendingExternal: true }), 1)
  assert.equal(reportExitCode([{ id: 'skipped', state: 'not_run' }], { allowPendingExternal: true }), 1)
  assert.equal(reportExitCode([{ id: 'good', state: 'pass' }]), 0)
})

test('the pending waiver is explicit and does not consume the optional image path', () => {
  assert.deepEqual(parseSmokeCliArgs(['C:\\Temp\\shot.png']), {
    allowPendingExternal: false,
    imagePath: 'C:\\Temp\\shot.png',
  })
  assert.deepEqual(parseSmokeCliArgs(['--allow-pending-external', 'C:\\Temp\\shot.png']), {
    allowPendingExternal: true,
    imagePath: 'C:\\Temp\\shot.png',
  })
})
