import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function clientModule() {
  const artifact = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  vm.runInNewContext(artifact, { window: { __ModuleLoader__: { load(value) { registration = value } } } })
  return registration.factory(() => { throw new Error('unexpected dependency') })
}

test('ambiguous confirmation becomes durable recovery UI state; recover and revert refresh normally', async () => {
  const { CodingWorkbenchClient } = await clientModule()
  const calls = []; let state = 'prepared'; let failConfirm = true
  const client = new CodingWorkbenchClient({}, async (url, init) => {
    calls.push({ url, init }); const suffix = url.replace('/api/xiaoshe/workbench', '')
    if (suffix === '/status') return Response.json({ workspaces: [{ id: 'w1', title: 'W', path: '/w' }], transactions: [{ id: 'tx1', relativePath: 'a.txt', state }] })
    if (suffix === '/write/prepare') return Response.json({ id: 'tx1', token: 'private-token', relativePath: 'a.txt', expiresAt: '2099-01-01T00:00:00Z' })
    if (suffix === '/write/confirm' && failConfirm) { state = 'applying'; return Response.json({ error: '文件可能已生效，请恢复对账', recoveryRequired: true, transactionId: 'tx1' }, { status: 409 }) }
    if (suffix === '/write/recover') { state = 'applied'; failConfirm = false; return Response.json({ state }) }
    if (suffix === '/write/revert') { state = 'reverted'; return Response.json({ state }) }
    throw new Error(`unexpected route ${suffix}`)
  })
  await client.load(); await client.prepare('a.txt', 'new text')
  assert.ok(!JSON.stringify(client.getSnapshot()).includes('private-token'))
  await assert.rejects(() => client.confirm(), /恢复对账/)
  assert.equal(client.getSnapshot().state, 'error'); assert.equal(client.getSnapshot().challenge, undefined)
  assert.equal(client.getSnapshot().transactions[0].state, 'applying')
  await client.recover('tx1')
  assert.equal(client.getSnapshot().state, 'ready'); assert.equal(client.getSnapshot().transactions[0].state, 'applied')
  await client.revert('tx1')
  assert.equal(client.getSnapshot().state, 'ready'); assert.equal(client.getSnapshot().transactions[0].state, 'reverted')
  assert.equal(calls.filter(row => row.url.endsWith('/write/confirm')).length, 1)
  assert.equal(calls.filter(row => row.url.endsWith('/write/recover')).length, 1)
})

test('pending receipts remain visible beyond the normal history display limit', async () => {
  const { visibleTransactions, transactionStateLabel } = await clientModule()
  const rows = [...Array.from({ length: 30 }, (_, i) => ({ id: `done-${i}`, state: 'applied' })), { id: 'pending-1', state: 'applying' }, { id: 'pending-2', state: 'reverting' }]
  const visible = visibleTransactions(rows)
  assert.equal(visible[0].id, 'pending-1'); assert.equal(visible[1].id, 'pending-2'); assert.equal(visible.length, 22)
  assert.match(transactionStateLabel('applying'), /写入待恢复对账/)
  assert.match(transactionStateLabel('reverting'), /撤销待恢复对账/)
})
