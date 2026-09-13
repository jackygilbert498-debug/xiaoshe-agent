import assert from 'node:assert/strict'
import test from 'node:test'
import { foldTaskTimeline, taskTimelineProjection } from '../lib/index.js'

const ref = (digit = 'a', extra = {}) => ({ attachmentId: `sha256:${digit.repeat(64)}`, mediaType: 'image/png', bytes: 123, width: 600, height: 400, name: `${digit}.png`, ...extra })
const image = attachment => ({ type: 'image', attachment })
const user = (seq, content, source = 'user') => ({ type: 'user/message', seq, time: seq, data: { source: { kind: source }, content } })

test('projection 4 replays text plus ordered durable images and image-only messages', () => {
  assert.equal(taskTimelineProjection.stateVersion, 4)
  const events = [user(9, [image(ref()), { type: 'text', text: '图片说明' }, image(ref('b'))]), user(10, [image(ref('c'))])]
  const before = structuredClone(events)
  const result = foldTaskTimeline(events)
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].text, '图片说明')
  assert.deepEqual(result.items[0].images, [ref(), ref('b')])
  assert.equal(result.items[1].text, '')
  assert.deepEqual(result.items[1].images, [ref('c')])
  assert.deepEqual(events, before, 'projection must never mutate original log facts')
})

test('only the durable reference whitelist survives, never raw bytes or URLs', () => {
  const dirty = ref('a', { url: 'https://untrusted/image.png', path: '/private/image.png', data: 'base64', extra: true })
  assert.deepEqual(foldTaskTimeline([user(1, [image(dirty)])]).items[0].images, [ref()])
  const invalid = [ref('a', { attachmentId: '/private/image.png' }), ref('a', { attachmentId: 'https://x/a' }),
    ref('a', { mediaType: 'image/svg+xml' }), ref('a', { width: -1 }), ref('a', { bytes: Infinity }), ref('a', { height: 1.5 })]
  assert.equal(foldTaskTimeline(invalid.map((attachment, index) => user(index, [image(attachment)]))).items.length, 0)
  const safeName = foldTaskTimeline([user(1, [image(ref('a', { name: '/private/a.png' }))])]).items[0].images[0]
  assert.equal(safeName.name, undefined)
})

test('non-user image messages cannot manufacture a user turn; full image history is retained', () => {
  const messages = Array.from({ length: 350 }, (_, index) => user(index, [image(ref())]))
  const projection = foldTaskTimeline([...messages, user(351, [image(ref())], 'tool'), { ...user(352, [image(ref())]), type: 'assistant/message' }])
  assert.equal(projection.items.length, 350)
  assert.ok(projection.items.every(item => item.kind === 'user' && item.images.length === 1))
})
