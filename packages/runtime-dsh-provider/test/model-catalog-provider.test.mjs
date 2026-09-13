import assert from 'node:assert/strict'
import test from 'node:test'

import { DshModelCatalog } from './.generated/client.mjs'

function fixture(response) {
  const listeners = new Set()
  const list = {
    getSnapshot: () => ({ current: 'session-1' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const sessions = { list, binding: id => id === 'session-1' ? {} : undefined }
  const connection = { api: { sessions: {
    models: async () => ({ result: { ok: true, value: { current: { provider: 'deepseek', model: 'chat' }, routable: true, groups: [], failures: [] } } }),
    selectModel: async () => ({ result: { ok: true, value: response } }),
  } } }
  return { sessions, connection }
}

test('model catalog preserves the Host persistence receipt on successful selection', async () => {
  const response = {
    effective: 'next-request',
    selected: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' },
    persistence: { status: 'session-only', warning: '模型已应用于当前会话，但没有保存为新会话默认值。' },
  }
  const f = fixture(response)
  const catalog = new DshModelCatalog(f.sessions, f.connection)

  const result = await catalog.select({ sessionId: 'session-1', provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })

  assert.equal(result.ok, true)
  assert.deepEqual(result.value, response)
  catalog.dispose()
})

test('a late selection receipt cannot restore a session after the user navigates away', async () => {
  let current = 'a'
  let changed
  let finish
  const catalog = new DshModelCatalog({
    list: { getSnapshot: () => ({ current }), subscribe: fn => { changed = fn; return () => {} } },
    binding: () => ({}),
  }, { api: { sessions: {
    models: async () => ({ result: { ok: true, value: { current: { provider: 'p', model: current }, routable: true, groups: [], failures: [] } } }),
    selectModel: () => new Promise(resolve => { finish = resolve }),
  } } })
  await new Promise(resolve => setImmediate(resolve))
  const pending = catalog.select({ provider: 'p', model: 'a', reasoningEffort: 'high' })
  current = 'b'; changed()
  finish({ result: { ok: true, value: { selected: { provider: 'p', model: 'a' }, effective: 'next-request' } } })
  assert.equal((await pending).ok, false)
  assert.equal(catalog.getSnapshot().sessionId, 'b')
  catalog.dispose()
})
