import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadClient() {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, strict: true },
  }).outputText
  return await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

test('client projection keeps health gates, rollback facts and known degraded states', async () => {
  const client = await loadClient()
  assert.equal(typeof client.projectPluginTransaction, 'function')

  const projected = client.projectPluginTransaction({
    id: 'tx-1', action: 'update', profile: 'managed', packageName: '@scope/example', version: '1.2.3',
    state: 'partial-health', consent: { confirmed: true, expiresAt: 1 }, osSandboxEnforced: false,
    health: [{ gate: 'functional-probe', ok: false, detail: 'HTTP 503' }],
    rollback: {
      attempted: true,
      succeeded: false,
      operation: 'restore',
      restoredSpec: '@scope/example@1.2.2',
      health: [{ gate: 'profile-start', ok: true, detail: 'ready' }],
      residuals: ['@scope/example'],
    },
    events: [{ at: 1, kind: 'health', message: 'probe failed' }],
  })

  assert.deepEqual(projected.health, [{ gate: 'functional-probe', ok: false, detail: 'HTTP 503' }])
  assert.deepEqual(projected.rollback, {
    attempted: true,
    succeeded: false,
    operation: 'restore',
    restoredSpec: '@scope/example@1.2.2',
    health: [{ gate: 'profile-start', ok: true, detail: 'ready' }],
    residuals: ['@scope/example'],
  })
  assert.deepEqual(projected.events, [{ at: 1, kind: 'health', message: 'probe failed' }])
  assert.equal(projected.state, 'partial-health')
})

test('confirm public path returns the bounded projected transaction', async () => {
  const client = await loadClient()
  const transaction = {
    id: 'tx-public', action: 'update', profile: 'managed', packageName: '@scope/example', version: '1.2.3',
    state: 'rollback-failed', consent: { confirmed: true, expiresAt: 1 }, osSandboxEnforced: false,
    health: [], rollback: { attempted: false, succeeded: false, residuals: ['restart'] },
    events: [{ at: 1, kind: 'error', message: 'restart' }], unexpected: 'must not escape the projection',
  }
  const provider = new client.PluginGovernanceProvider(
    { list: async () => ({ ok: true, value: { entries: [] } }) },
    async () => new Response(JSON.stringify({ transaction }), { status: 200, headers: { 'content-type': 'application/json' } }),
  )

  const result = await provider.confirmChange({ challengeId: 'challenge', token: 'token' })

  assert.equal(result.ok, true)
  assert.equal(Object.isFrozen(result.value.transaction), true)
  assert.equal('unexpected' in result.value.transaction, false)
  assert.deepEqual(result.value.transaction.events, [{ at: 1, kind: 'error', message: 'restart' }])
})

test('an older concurrent refresh cannot overwrite a newer transaction snapshot', async () => {
  const client = await loadClient()
  const pending = []
  const fetcher = () => new Promise(resolve => pending.push(resolve))
  const provider = new client.PluginGovernanceProvider(
    { list: async () => ({ ok: true, value: { entries: [] } }) },
    fetcher,
  )
  const transaction = state => ({
    id: 'tx-race', action: 'update', profile: 'managed', packageName: '@scope/example', version: '1.2.3',
    state, consent: { confirmed: true, expiresAt: 1 }, osSandboxEnforced: false, events: [],
  })

  const older = provider.refreshTransactions()
  const newer = provider.refreshTransactions()
  pending[1](new Response(JSON.stringify({ transactions: [transaction('healthy')] }), { status: 200 }))
  await newer
  pending[0](new Response(JSON.stringify({ transactions: [transaction('running')] }), { status: 200 }))
  await older

  assert.equal(provider.getSnapshot().transactions[0].state, 'healthy')
  assert.equal(provider.getSnapshot().pendingRequests, 0)
})
