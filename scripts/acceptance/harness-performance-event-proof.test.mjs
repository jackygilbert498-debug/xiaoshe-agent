import assert from 'node:assert/strict'
import test from 'node:test'
import * as eventProof from './harness-performance-event-proof.mjs'
import { onlineResearchEvidence } from './harness-performance-policy.mjs'

test('V3 durable compact assistant stream supplies final text, not hidden reasoning or live drafts', () => {
  const event = { seq: 2, type: 'assistant/message', data: { stream: [{ type: 'text-chunks', texts: ['actual ', 'answer'] }, { type: 'reasoning-chunks', texts: ['hidden'] }] } }
  assert.equal(eventProof.latestVisibleAssistantAnswer([event]), 'actual answer')
  assert.equal(eventProof.latestVisibleAssistantAnswer([{ ...event, type: 'assistant/attempt' }]), '')
})

import {
  buildHarnessToolRecords,
  callUsesSessionDirectory,
  successfulCallsSettledAfterBoundary,
} from './harness-performance-event-proof.mjs'

function rootCall(seq, callId = 'call-1', name = 'read', argumentsValue = { path: 'input.txt' }) {
  return { seq, type: 'tool/call', data: { callId, name, arguments: argumentsValue } }
}

function rootResult(seq, callId = 'call-1', overrides = {}) {
  return {
    seq,
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [{ type: 'text', text: 'ok' }] }],
        isError: false,
      },
      ...overrides,
    },
  }
}

test('root tool evidence requires one later identity-consistent explicit result', () => {
  assert.equal(buildHarnessToolRecords([rootCall(1), rootResult(2)])[0].succeeded, true)
  assert.equal(buildHarnessToolRecords([rootResult(1), rootCall(2)])[0].succeeded, false)
  assert.equal(buildHarnessToolRecords([rootCall(1), rootResult(2), rootResult(3)])[0].succeeded, false)

  const divergent = rootResult(2)
  divergent.data.toolCallId = 'different-call'
  assert.equal(buildHarnessToolRecords([rootCall(1), divergent])[0].succeeded, false)

  const implicit = rootResult(2)
  delete implicit.data.message.isError
  delete implicit.data.message.content[0].isError
  assert.equal(buildHarnessToolRecords([rootCall(1), implicit])[0].succeeded, false)
})

test('a successful pre-boundary call whose result arrives later remains visible', () => {
  const records = buildHarnessToolRecords([
    rootCall(3, 'old-route', 'read', { path: 'initial-c.md' }),
    { seq: 5, type: 'user/message', data: { message: { role: 'user', content: [] } } },
    rootResult(7, 'old-route'),
    rootCall(8, 'new-route', 'read', { path: 'steer-note.md' }),
    rootResult(9, 'new-route'),
  ])
  assert.deepEqual(
    successfulCallsSettledAfterBoundary(records, 5).map(call => call.callId),
    ['old-route'],
  )
})

test('all supported root error projections and non-zero shell exits fail closed', () => {
  for (const overrides of [
    { error: { message: 'failed' } },
    { result: { error: { message: 'failed' } } },
    { output: { isError: true } },
  ]) {
    const [record] = buildHarnessToolRecords([rootCall(1), rootResult(2, 'call-1', overrides)])
    assert.equal(record.failed, true)
    assert.equal(record.succeeded, false)
  }
  const shell = rootResult(2)
  shell.data.message.content[0].content[0].text = 'command failed\n[exit code: 2]'
  const [record] = buildHarnessToolRecords([rootCall(1, 'call-1', 'pwsh', { command: 'npm run test' }), shell])
  assert.equal(record.failed, true)
  assert.equal(record.succeeded, false)
})

test('nested Code Mode evidence requires exact start/result identity, arguments and ordering', () => {
  const start = {
    seq: 2,
    type: 'tool/code-dispatch-start',
    data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'nested', name: 'write', arguments: { path: 'src/a.ts' } },
  }
  const result = {
    seq: 3,
    type: 'tool/code-dispatch',
    data: { ...start.data, isError: false, content: [] },
  }
  assert.equal(buildHarnessToolRecords([start, result])[0].succeeded, true)
  assert.equal(buildHarnessToolRecords([result, start])[0].succeeded, false)
  assert.equal(buildHarnessToolRecords([start, result, { ...result, seq: 4 }])[0].succeeded, false)
  assert.equal(buildHarnessToolRecords([start, { ...result, data: { ...result.data, name: 'edit' } }])[0].succeeded, false)
  assert.equal(buildHarnessToolRecords([start, { ...result, data: { ...result.data, arguments: { path: 'src/b.ts' } } }])[0].succeeded, false)
})

test('verification commands inherit the scenario cwd or name the exact same cwd', () => {
  const cwd = 'C:\\Temp\\xiaoshe-fixture'
  assert.equal(callUsesSessionDirectory({ arguments: { command: 'npm run test' } }, cwd), true)
  assert.equal(callUsesSessionDirectory({ arguments: { command: 'npm run test', cwd } }, cwd), true)
  assert.equal(callUsesSessionDirectory({ arguments: { command: 'npm run test', workdir: cwd.toLowerCase() } }, cwd), true)
  assert.equal(callUsesSessionDirectory({ arguments: { command: 'npm run test', workdir: 'c:/temp/xiaoshe-fixture' } }, cwd), true)
  assert.equal(callUsesSessionDirectory({ arguments: { command: 'npm run test', cwd: 'C:\\Temp\\other' } }, cwd), false)
  assert.equal(callUsesSessionDirectory({ arguments: { command: 'npm run test', cwd, workdir: 'C:\\Temp\\other' } }, cwd), false)
  assert.equal(callUsesSessionDirectory({ arguments: { command: 'npm run test', cwd: '/tmp/Xiaoshe-fixture' } }, '/tmp/Xiaoshe-fixture'), true)
  assert.equal(callUsesSessionDirectory({ arguments: { command: 'npm run test', cwd: '/tmp/xiaoshe-fixture' } }, '/tmp/Xiaoshe-fixture'), false)
})

function assistantMessage(seq, text, extraBlocks = []) {
  return {
    seq, type: 'assistant/message',
    data: { turn: 1, step: seq, message: {
      role: 'assistant', source: { provider: 'synthetic', model: 'fixture' },
      content: [...(text === undefined ? [] : [{ type: 'text', text }]), ...extraBlocks],
    } },
  }
}

const researchNow = new Date('2026-09-05T08:00:00.000Z')
const researchSource = 'https://weather.example/shanghai'
const sourceOnlySearch = [{
  name: 'web_search', arguments: { query: 'Shanghai weather today 2026-09-05' },
  result: { text: `Sources:\n- [Shanghai weather](${researchSource})` },
}]

test('final visible correction replaces retracted weather claims instead of contaminating source-only proof', () => {
  const correction = `部分完成：来源正文未能读取，因此不提供具体天气数值。可核验来源：${researchSource}`
  const events = [
    assistantMessage(2, `今天上海最高 30°C，页面日期 2025 年 4 月 7 日。来源：https://old.example/weather`),
    assistantMessage(4, correction),
  ]
  const answer = eventProof.latestVisibleAssistantAnswer(events)
  assert.equal(answer, correction)
  const proof = onlineResearchEvidence(sourceOnlySearch, answer, researchNow)
  assert.deepEqual(proof.answerUrls, [researchSource])
  assert.equal(proof.answerTemporalMismatch, false)
  assert.equal(proof.bodyReady, false)
  assert.equal(proof.sourceOnlyPartialReady, true)
  assert.equal(proof.passed, true)
})

test('a withdrawn final citation cannot borrow an earlier source even when actual body evidence exists', () => {
  const events = [
    assistantMessage(2, `来源：${researchSource}`),
    assistantMessage(4, '撤回前面的结论；本轮尚不能给出可核验的天气回答。'),
  ]
  const proof = onlineResearchEvidence(sourceOnlySearch, eventProof.latestVisibleAssistantAnswer(events), researchNow, [{
    name: 'web_fetch', arguments: { url: researchSource },
    result: { text: '上海当前天气页面给出实时气温、逐小时降雨概率、风力和当天趋势。' },
  }])
  assert.equal(proof.bodyReady, true)
  assert.deepEqual(proof.cited, [])
  assert.equal(proof.passed, false)
})

test('final answer keeps text blocks from one message only and skips non-visible assistant and tool content', () => {
  const events = [
    assistantMessage(1, '旧答案'),
    assistantMessage(3, '最后一条', [{ type: 'text', text: '可见正文' }, { type: 'reasoning', text: '隐藏推理' }]),
    assistantMessage(4, '  ', [{ type: 'tool-call', name: 'web_search', arguments: '{}', text: '工具不可作为正文' }]),
    assistantMessage(5, undefined, [{ type: 'reasoning', text: '并非最终回答' }]),
    { seq: 6, type: 'tool/result', data: { content: [{ type: 'text', text: 'public source result' }] } },
    { seq: 7, type: 'assistant/chunk', data: { content: [{ type: 'text', text: '未持久化片段' }] } },
    { seq: 8, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  assert.equal(eventProof.latestVisibleAssistantAnswer(events), '最后一条\n可见正文')
  assert.equal(eventProof.latestVisibleAssistantAnswer([assistantMessage(1, undefined)]), '')
  assert.equal(eventProof.latestVisibleAssistantAnswer([]), '')
})

test('final-answer extraction does not relax HTTPS or actual returned-source requirements', () => {
  for (const text of [
    '部分完成：正文无法读取。来源：http://weather.example/shanghai',
    '部分完成：正文无法读取。来源：https://not-returned.example/shanghai',
  ]) {
    const proof = onlineResearchEvidence(sourceOnlySearch,
      eventProof.latestVisibleAssistantAnswer([assistantMessage(1, text)]), researchNow)
    assert.equal(proof.passed, false)
    assert.equal(proof.sourceOnlyPartialReady, false)
  }
})

test('turn diagnostics preserve concrete failure and obligation facts without exporting tools or configuration', () => {
  const events = [
    { seq: 1, type: 'xiaoshe/obligation-state', data: {
      version: 1, generation: 2, turn: 1, kind: 'research', status: 'blocked', reason: 'body-missing',
      sourceResultSeqs: [3], bodyResultSeqs: [], citedBodyResultSeqs: [],
      env: { API_KEY: 'synthetic-private-config' },
    } },
    { seq: 2, type: 'xiaoshe/research-evidence', data: {
      version: 1, generation: 2, turn: 1, kind: 'body', callId: 'public-source-call',
      url: researchSource, rawBody: 'synthetic-do-not-save-body',
    } },
    { seq: 3, type: 'tool/result', data: { content: [{ type: 'text', text: 'synthetic-do-not-save-tool-result' }] } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: {
      kind: 'aborted', reason: { kind: 'hook', reason: 'research source body missing', config: 'synthetic-private-config' },
    } } },
  ]
  const diagnostics = eventProof.harnessTurnDiagnostics(events)
  assert.deepEqual(diagnostics, {
    turnEnd: { seq: 4, turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'research source body missing' } } },
    reliabilityEvents: [
      { seq: 1, type: 'xiaoshe/obligation-state', data: {
        version: 1, generation: 2, turn: 1, kind: 'research', status: 'blocked', reason: 'body-missing',
        sourceResultSeqs: [3], bodyResultSeqs: [], citedBodyResultSeqs: [],
      } },
      { seq: 2, type: 'xiaoshe/research-evidence', data: { version: 1, generation: 2, turn: 1, kind: 'body', callId: 'public-source-call' } },
    ],
  })
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-private|do-not-save/u)
  assert.deepEqual(eventProof.harnessTurnDiagnostics([]), { turnEnd: null, reliabilityEvents: [] })
})

test('turn diagnostics keep error code and safe message while redacting credential-shaped strings', () => {
  const diagnostics = eventProof.harnessTurnDiagnostics([{ seq: 5, type: 'turn/end', data: { turn: 2, reason: {
    kind: 'error', error: {
      code: 'UNKNOWN', status: 503,
      message: 'guard failed; Authorization: Bearer synthetic-bearer-value; api_key=synthetic-key-value',
      headers: { authorization: 'synthetic-private-header' }, config: 'synthetic-private-config',
    },
  } } }])
  assert.equal(diagnostics.turnEnd.reason.kind, 'error')
  assert.equal(diagnostics.turnEnd.reason.error.code, 'UNKNOWN')
  assert.equal(diagnostics.turnEnd.reason.error.status, 503)
  assert.match(diagnostics.turnEnd.reason.error.message, /guard failed/u)
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-/u)
})
