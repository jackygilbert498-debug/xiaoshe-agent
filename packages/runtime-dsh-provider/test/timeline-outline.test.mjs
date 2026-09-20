import assert from 'node:assert/strict'
import test from 'node:test'
import { DshTaskTimeline } from './.generated/client.mjs'

test('outline includes all loaded authoritative user turns and reveal expands only the selected session', () => {
  let current = 'a'
  let notify
  const nodes = Array.from({ length: 500 }, (_, seq) => ({ seq, kind: seq % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `turn ${seq}` }] }))
  const timeline = new DshTaskTimeline({
    list: { getSnapshot: () => ({ current, byId: {} }), subscribe: fn => { notify = fn; return () => {} } },
    binding: id => ({ session: { getSnapshot: () => ({ projectionReady: true, nodes: id === 'a' ? nodes : [] }) } }),
  })
  assert.equal(timeline.getSnapshot().items.length, 160)
  assert.equal(timeline.getOutline().length, 250)
  const first = timeline.getOutline()[0]
  assert.equal(first.text, 'turn 0')
  timeline.reveal(first.seq)
  assert.equal(timeline.getSnapshot().items[0].key, first.key)
  assert.equal(timeline.getSnapshot().items.length, 500)
  for (const seq of [-1, NaN, Infinity]) timeline.reveal(seq)
  current = 'b'; notify()
  assert.deepEqual(timeline.getOutline(), [])
  timeline.reveal(first.seq)
  assert.equal(timeline.getSnapshot().sessionId, 'b')
  timeline.dispose()
})

test('older-history pages expand by 320 records and retain the oldest visible record during streaming', () => {
  let current = 'a', notify
  const nodes = Array.from({ length: 1000 }, (_, seq) => ({ seq, kind: seq % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `turn ${seq}` }] }))
  const timeline = new DshTaskTimeline({
    list: { getSnapshot: () => ({ current, byId: {} }), subscribe: fn => { notify = fn; return () => {} } },
    binding: () => ({ session: { getSnapshot: () => ({ projectionReady: true, nodes }) } }),
  })
  timeline.loadEarlier()
  assert.equal(timeline.getSnapshot().items.length, 480)
  const first = timeline.getSnapshot().items[0].key
  nodes.push({ seq: 1000, kind: 'assistant', content: [{ type: 'text', text: 'new reply' }] })
  notify()
  assert.equal(timeline.getSnapshot().items[0].key, first)
  assert.equal(timeline.getSnapshot().items.length, 481)
  current = 'b'; notify()
  assert.equal(timeline.getSnapshot().items.length, 160, 'another session does not inherit the expanded window')
  current = 'a'; notify()
  while (timeline.getSnapshot().hasEarlier) timeline.loadEarlier()
  assert.equal(timeline.getSnapshot().items.length, 1001)
  timeline.loadEarlier()
  assert.equal(timeline.getSnapshot().items.length, 1001)
  timeline.dispose()
})
