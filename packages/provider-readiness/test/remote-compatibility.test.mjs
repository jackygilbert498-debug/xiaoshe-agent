import test from 'node:test'
import assert from 'node:assert/strict'
import * as client from './.generated/client.mjs'

test('new provider and credentials Remotes retain active/declared distinction and failures', async () => {
  assert.equal(typeof client.createReadinessRemoteConnection, 'function')
  const remote = {
    llm: { listProviders: async () => ({ ok: true, value: [{ id: 'active', name: 'Active' }] }), listConfigurableProviders: async () => ({ ok: true, value: [{ provider: 'configured', displayName: 'Configured', settingsNs: 'llm', settingsPath: [], declared: true }, { provider: 'builtin', displayName: 'Builtin', settingsNs: 'llm', settingsPath: [], declared: false }] }) },
    credentials: { describe: async refs => { assert.deepEqual(refs, ['KEY']); return { ok: false, error: { message: 'denied' } } } },
  }
  const connection = client.createReadinessRemoteConnection(remote)
  const result = await connection.api.llm.providers({})
  assert.deepEqual(result.result.value.providers.map(row => [row.provider, row.active, row.declared]), [['configured', false, true], ['builtin', false, false], ['active', true, false]])
  assert.equal((await connection.api.credentials.describe({ refs: ['KEY'] })).result.error.message, 'denied')
})
