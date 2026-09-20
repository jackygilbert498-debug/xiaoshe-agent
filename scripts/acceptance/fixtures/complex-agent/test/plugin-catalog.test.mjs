import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePlugins } from '../src/plugin-catalog.mjs'

test('normalizes, merges, deduplicates and preserves first-seen order', () => {
  const input = [
    { id: ' FS ', name: 'File tools', capabilities: [' read ', 'write', 'read'] },
    { id: 'web', name: '', capabilities: ['search'] },
    { id: 'fs', name: 'ignored later name', capabilities: ['write', ' grep ', ''] },
    { id: ' WEB ', name: 'Web tools', capabilities: ['fetch', 'search'] },
  ]
  assert.deepEqual(normalizePlugins(input), [
    { id: 'fs', name: 'File tools', capabilities: ['read', 'write', 'grep'] },
    { id: 'web', name: 'Web tools', capabilities: ['search', 'fetch'] },
  ])
})

test('does not mutate inputs and returns detached objects and arrays', () => {
  const input = [{ id: 'One', name: 'One', capabilities: ['a'] }]
  const snapshot = structuredClone(input)
  const output = normalizePlugins(input)
  assert.deepEqual(input, snapshot)
  assert.notEqual(output, input)
  assert.notEqual(output[0], input[0])
  assert.notEqual(output[0].capabilities, input[0].capabilities)
})

test('rejects malformed top-level values and entries', () => {
  assert.throws(() => normalizePlugins(null), TypeError)
  assert.throws(() => normalizePlugins([null]), TypeError)
  assert.throws(() => normalizePlugins([{ id: '  ', capabilities: [] }]), TypeError)
  assert.throws(() => normalizePlugins([{ id: 'ok', capabilities: 'read' }]), TypeError)
})
