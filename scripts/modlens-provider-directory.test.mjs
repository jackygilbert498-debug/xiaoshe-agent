import test from 'node:test'
import assert from 'node:assert/strict'
import { syncWrapperDirectory, releaseWrapperDirectory } from './modlens-provider-directory.mjs'

function fixture() {
  let upstream = { provider: 'deepseek-official', settingsNs: 'llm-deepseek', settingsPath: [] }
  let entries = [], writes = 0, reject = false
  const handle = () => { entries = [] }
  handle.replace = next => { if (reject) throw new Error('fixture'); entries = structuredClone(next); writes++ }
  const ctx = { llm: {
    listConfigurableProviders: () => upstream ? [upstream, ...entries] : [...entries],
    registerConfigurableProviders(next) { handle.replace(next); return handle },
  } }
  return { ctx, current: { providerId: 'deepseek-modlens' }, entries: () => entries, writes: () => writes,
    upstream: value => { upstream = value }, reject: () => { reject = true } }
}

test('wrapper uses its actual upstream settings without storing a duplicate key', () => {
  const f = fixture()
  syncWrapperDirectory(f.ctx, f.current, 'deepseek-official', 'DeepSeek (modlens vision)')
  assert.deepEqual(f.entries(), [{ provider: 'deepseek-modlens', displayName: 'DeepSeek (modlens vision)', settingsNs: 'llm-deepseek', settingsPath: [] }])
  syncWrapperDirectory(f.ctx, f.current, 'deepseek-official', 'DeepSeek (modlens vision)')
  assert.equal(f.writes(), 1, 'idempotent sync does not emit a provider refresh loop')
  releaseWrapperDirectory(f.current)
  assert.deepEqual(f.entries(), [])
})

test('upstream remapping or removal updates or withdraws the owned descriptor', () => {
  const f = fixture()
  syncWrapperDirectory(f.ctx, f.current, 'deepseek-official', 'Vision')
  f.upstream({ provider: 'deepseek-official', settingsNs: 'llm-custom', settingsPath: ['profiles', 'my-route'] })
  syncWrapperDirectory(f.ctx, f.current, 'deepseek-official', 'Vision')
  assert.equal(f.entries()[0].settingsNs, 'llm-custom')
  assert.deepEqual(f.entries()[0].settingsPath, ['profiles', 'my-route'])
  f.upstream(null)
  syncWrapperDirectory(f.ctx, f.current, 'deepseek-official', 'Vision')
  assert.deepEqual(f.entries(), [])
})

test('failed configuration remap cannot leave stale readiness and names cannot invent an upstream', () => {
  const f = fixture()
  syncWrapperDirectory(f.ctx, f.current, 'deepseek-official', 'Vision')
  f.reject()
  f.upstream({ provider: 'deepseek-official', settingsNs: 'new-config', settingsPath: [] })
  assert.throws(() => syncWrapperDirectory(f.ctx, f.current, 'deepseek-official', 'Vision'), /directory unavailable/)
  assert.deepEqual(f.entries(), [])
  const other = fixture()
  syncWrapperDirectory(other.ctx, other.current, 'not-the-configured-upstream', 'DeepSeek')
  assert.deepEqual(other.entries(), [])
})
