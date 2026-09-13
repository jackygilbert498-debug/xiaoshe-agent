import assert from 'node:assert/strict'
import test from 'node:test'

import { foldTaskTimeline } from '../lib/index.js'

const event = (type, seq, data) => ({ type, seq, time: seq, data })

for (const code of ['ABORTED', 'ABORTED_BEFORE_DISPATCH']) test(`canonical ${code} is cancelled without hiding a previous true failure`, () => {
  const result = (seq, callId, error) => event('tool/result', seq, { error, message: { source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'Error: tool call aborted' }], isError: true }] } })
  const projection = foldTaskTimeline([
    event('tool/call', 1, { name: 'pwsh', callId: 'failed' }),
    result(2, 'failed', { name: 'AbortError', code: 'EXIT_1' }),
    event('tool/call', 3, { name: 'pwsh', callId: 'stopped' }),
    result(4, 'stopped', { name: 'AbortError', code }),
    result(5, 'unknown', { name: 'AbortError', code }),
  ])
  assert.equal(projection.items[1].isError, true)
  assert.equal(projection.items[1].text, '失败 pwsh')
  assert.equal(projection.items[3].text, '已取消：pwsh')
  assert.notEqual(projection.items[3].isError, true)
  assert.equal(projection.items[4].text, '已取消：unknown', 'unmatched identity cannot cancel another call')
})

test('tool results bind only to an exact call id', () => {
  const projection = foldTaskTimeline([
    event('tool/call', 1, { name: 'delete_file', callId: 'call-real' }),
    event('tool/result', 2, { message: { content: [{ type: 'text', text: 'unrelated result' }] } }),
    event('tool/result', 3, { message: { source: { callId: 'call-other' }, content: [] } }),
    event('tool/result', 4, { message: { source: { callId: 'call-real' }, content: [] } }),
  ])

  assert.deepEqual(projection.items.map(item => item.text), [
    '调用 delete_file',
    '收到 未关联工具结果',
    '收到 call-other',
    '完成 delete_file',
  ])
  assert.equal(projection.items.filter(item => item.text === '完成 delete_file').length, 1)
})

test('an uncorrelated failing result cannot mark the previous tool as failed', () => {
  const projection = foldTaskTimeline([
    event('tool/call', 1, { name: 'write_file', callId: 'write-1' }),
    event('tool/result', 2, { message: { isError: true, content: [] } }),
  ])

  assert.deepEqual(projection.items.map(item => item.text), [
    '调用 write_file',
    '失败 未关联工具结果',
  ])
})
