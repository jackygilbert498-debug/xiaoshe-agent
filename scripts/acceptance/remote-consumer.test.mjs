import test from 'node:test'
import assert from 'node:assert/strict'
import { DshApiClient } from '../../packages/terminal-client/lib/api.js'
import { acceptanceRpc, ownedLoginUrl, redactLoginUrls } from './public-rpc.mjs'
import { validateProcessObservation, observeOwnedProcess } from './owned-process-identity.mjs'

test('acceptance transport refuses daily, external or unauthenticated hosts; owned log credentials are not retained', async () => {
  for (const url of ['http://127.0.0.1:3080', 'http://evil.invalid:3210', 'http://127.0.0.1:3210/path']) assert.throws(() => acceptanceRpc(url))
  const base = 'http://127.0.0.1:3210'
  const login = base + '/?token=' + Buffer.alloc(32, 1).toString('base64url')
  assert.equal(ownedLoginUrl('Web UI: ' + login, base), login)
  assert.equal(ownedLoginUrl('Web UI: ' + login, 'http://127.0.0.1:3211'), undefined)
  assert.ok(!redactLoginUrls(login).includes(new URL(login).searchParams.get('token')))
  await assert.rejects(acceptanceRpc(base, { authUrl: undefined })('session.list', {}), /explicit same-origin/)
  await assert.rejects(acceptanceRpc(base, { authUrl: login.replace('3210', '3211') })('session.list', {}), /启动认证地址无效/)
})

test('process evidence requires matching independent observation and never substitutes expected cwd', async () => {
  const config = { runId: 'r', expectedHostCwd: '/fixture', endpoint: 'http://127.0.0.1:3210', runtimeIdentity: 'a'.repeat(64) }
  const value = { schema: 'xiaoshe-owned-host-process/v1', pid: 123, cwd: '/fixture', creationIdentity: 'observed-test-start', platform: 'linux', runId: 'r', endpoint: config.endpoint, runtimeIdentity: config.runtimeIdentity }
  assert.equal(validateProcessObservation(value, config), value)
  for (const change of [{ cwd: '/other' }, { pid: 0 }, { creationIdentity: '' }, { runId: 'old' }, { runtimeIdentity: 'old' }, { platform: 'win32' }]) assert.throws(() => validateProcessObservation({ ...value, ...change }, config), /mismatch/)
  if (process.platform === 'win32') await assert.rejects(observeOwnedProcess(process.pid), error => error.code === 'PENDING_EXTERNAL')
  else assert.equal((await observeOwnedProcess(process.pid)).pid, process.pid)
})

test('history continuation uses its same-session opening cut and never reopens a moving tail', async () => {
  const calls = []
  const api = new DshApiClient('http://127.0.0.1:1234', async (_url, init) => {
    const request = JSON.parse(init.body); calls.push(request)
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { records: [], hasMore: false } } })
  })
  let opens = 0
  api.stream = async function* () { opens++; yield { type: 'snapshot', cursor: 7, records: [], hasMore: true, projections: { asOfSeq: 7, values: {} } } }
  await api.call('session.history', { sessionId: 's' })
  await api.call('session.history', { sessionId: 's', beforeSeq: 4 })
  assert.equal(opens, 1)
  assert.equal(calls[0].method, 'session/page')
  assert.deepEqual(calls[0].payload.args.request, { address: { kind: 'session', sessionId: 's' }, throughSeq: 7, beforeSeq: 4, maxMessages: 200 })
  await assert.rejects(api.call('session.history', { sessionId: 'other', beforeSeq: 4 }), /cutoff/)
  api.stream = async function* () { throw new Error('failed opening') }
  await assert.rejects(api.history('s'), /failed opening/)
  await assert.rejects(api.call('session.history', { sessionId: 's', beforeSeq: 4 }), /cutoff/)
})

test('authentication fetch failures cannot expose the launch URL through error or cause', async () => {
  const launch = 'http://127.0.0.1:1234/?token=' + Buffer.alloc(32, 1).toString('base64url')
  let signal
  const api = new DshApiClient(launch, async (url, init) => {
    signal = init.signal
    throw new Error('fetch ' + url)
  })
  await assert.rejects(api.authenticate(), error => !String(error).includes('token=') && error.cause === undefined)
  assert.ok(signal instanceof AbortSignal)
})

test('encoded authentication query names are canonicalized and redacted before evidence capture', () => {
  const base = 'http://127.0.0.1:3210', token = Buffer.alloc(32, 7).toString('base64url')
  const encoded = base + '/?%74o%6ben=' + token
  assert.equal(ownedLoginUrl('Web UI: ' + encoded, base), base + '/?token=' + token)
  for (const log of [encoded, JSON.stringify({ url: encoded }), base + '/?%54OKEN=' + token]) {
    assert.ok(!redactLoginUrls(log).includes(token))
    assert.match(redactLoginUrls(log), /token=\[REDACTED\]/u)
  }
})
