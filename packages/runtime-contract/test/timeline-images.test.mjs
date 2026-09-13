import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTaskTimelineImage } from '../lib/index.js'

const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 123, width: 600, height: 400, name: '图.png' }
test('timeline image contract copies only durable image fields', () => {
  assert.deepEqual(parseTaskTimelineImage({ ...ref, url: 'https://x', path: '/x', data: 'abc' }), ref)
  assert.notEqual(parseTaskTimelineImage(ref), ref)
  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) assert.equal(parseTaskTimelineImage({ ...ref, mediaType }).mediaType, mediaType)
})
test('timeline image contract rejects unsafe IDs/types/dimensions and strips local display paths', () => {
  for (const bad of [null, [], 'x', { ...ref, attachmentId: 'file:///x' }, { ...ref, mediaType: 'image/svg+xml' }, { ...ref, bytes: 0 }, { ...ref, width: NaN }, { ...ref, height: 0.5 }]) assert.equal(parseTaskTimelineImage(bad), undefined)
  for (const name of ['/private/x.png', 'C:\\x.png', 'x\n.png', 'x'.repeat(256)]) assert.equal(parseTaskTimelineImage({ ...ref, name }).name, undefined)
})
