import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { mergeProfile } from './ensure-profile-patch.mjs'

const template = '- id: modlens\n  config:\n    upstream: deepseek-official\n    timeoutMs: 60000\n'
test('fresh profiles receive complete config, idempotently', () => {
  for (const empty of ['', '# profile\n', '[]\n']) {
    const first = mergeProfile(empty, template)
    assert.deepEqual(parse(first)[0].config, { upstream: 'deepseek-official', timeoutMs: 60000 })
    assert.equal(mergeProfile(first, template), first)
  }
})
test('coalesces previous duplicate instead of erasing upstream or user config', () => {
  const old = '# user note\n- id: modlens\n  config:\n    upstream: custom-text\n    autoRead: true\n- id: modlens\n  config:\n    timeoutMs: 25000\n'
  const next = mergeProfile(old, template)
  assert.match(next, /# user note/)
  assert.deepEqual(parse(next), [{ id: 'modlens', config: { upstream: 'custom-text', autoRead: true, timeoutMs: 60000 } }])
  assert.equal(mergeProfile(next, template), next)
})
test('preserves other plugins, custom budgets, comments and inert js tags', () => {
  const old = '# keep\n- id: other\n  config:\n    timeoutMs: 25000\n    root: !!js process.env.PRIVATE_ROOT\n- id: modlens\n  config:\n    upstream: custom\n    timeoutMs: 90000\n'
  assert.equal(mergeProfile(old, template), old)
})
test('existing row is supplemented, not duplicated', () => {
  const next = parse(mergeProfile('- id: modlens\n  config:\n    upstream: custom\n', template))
  assert.equal(next.length, 1)
  assert.equal(next[0].config.upstream, 'custom')
  assert.equal(next[0].config.timeoutMs, 60000)
})
test('invalid and ambiguous profiles fail closed', () => {
  for (const old of ['broken: [', 'key: value', '- id: modlens\n  config: false', '- id: modlens\n  config: {}\n- id: modlens\n  disable: true\n  config: {}']) {
    assert.throws(() => mergeProfile(old, template))
  }
})
