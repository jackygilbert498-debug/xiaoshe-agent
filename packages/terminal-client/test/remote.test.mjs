import test from 'node:test'
import assert from 'node:assert/strict'
import { DshApiClient } from '../lib/api.js'
import { eventText } from '../lib/presentation.js'
import { authenticatedOptions } from '../lib/options.js'

test('launcher auth environment is same-origin strict loopback and never accepted cross-host', () => {
  const options = { baseUrl: 'http://127.0.0.1:1234', fresh: false, noColor: true, help: false }
  assert.equal(authenticatedOptions(options, 'http://127.0.0.1:1234/?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaY').baseUrl, 'http://127.0.0.1:1234/?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaY')
  for (const url of ['http://127.0.0.1:9999/?token=x', 'http://attacker.invalid/?token=x', 'http://127.0.0.1:1234/path?token=x', 'http://127.0.0.1:1234/?token=x&extra=y', 'http://127.0.0.1:1234/?token=x#fragment']) {
    assert.throws(() => authenticatedOptions(options, url), /启动认证地址无效/)
  }
})

test('V3 compact assistant stream displays text but not reasoning', () => {
  assert.equal(eventText({ type: 'assistant/message', data: { stream: [
    { type: 'text-chunks', texts: ['hello', ' world'] },
    { type: 'reasoning-chunks', texts: ['private'] },
    { type: 'chunk', chunk: { type: 'text-delta', text: '!' } },
  ] } }), 'hello world!')
})

test('business labels use exact generated Remote endpoint and named arguments', async () => {
  const seen = []
  const api = new DshApiClient('http://127.0.0.1:1234', async (url, init) => {
    const request = JSON.parse(init.body)
    seen.push([new URL(url).pathname, request.method, request.payload])
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [] } } })
  })
  await api.listSessions()
  assert.deepEqual(seen, [['/api/session/list', 'session/list', { args: { _request: {} } }]])
})

test('prompt has admission identity; no automatic write retry', async () => {
  let calls = 0
  const api = new DshApiClient('http://127.0.0.1:1234', async (_url, init) => {
    calls++
    const request = JSON.parse(init.body)
    assert.equal(request.method, 'session/prompt')
    assert.equal(typeof request.payload.args.request.requestId, 'string')
    assert.equal(request.payload.args.request.mode, 'steer')
    throw new Error('lost receipt')
  })
  await assert.rejects(api.call('session.prompt', { sessionId: 's', mode: 'steer', content: [] }), /lost receipt/)
  assert.equal(calls, 1)
})

test('HTTP raw retention is awaited and failures prevent success', async () => {
  const wire = []
  const fetcher = async (_url, init) => {
    const request = JSON.parse(init.body)
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } })
  }
  const api = new DshApiClient('http://127.0.0.1:1234', fetcher, undefined, { async onResponse(row) { wire.push(row); await Promise.resolve() } })
  await api.cancel('s')
  assert.equal(wire[0].endpoint, 'session/cancel')
  assert.equal(JSON.parse(wire[0].bytes).rpcId, wire[0].rpcId)
  assert.deepEqual(wire[0].args, { request: { sessionId: 's' } })
  const broken = new DshApiClient('http://127.0.0.1:1234', fetcher, undefined, { onResponse() { throw new Error('disk receipt failed') } })
  await assert.rejects(broken.cancel('s'), /disk receipt failed/)
})

test('workspace labels and select model preserve request and saved/session-only receipt', async () => {
  const seen = []
  const api = new DshApiClient('http://127.0.0.1:1234', async (_url, init) => {
    const request = JSON.parse(init.body); seen.push(request)
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { selected: request.payload.args.request, persistence: { status: 'session-only', warning: 'not saved' } } } })
  })
  const receipt = await api.selectModel('s', 'provider', 'model')
  assert.equal(receipt.persistence.status, 'session-only')
  await api.call('workspace.create', { path: '/fixture' })
  await api.call('workspace.archiveSession', { workspaceId: 'w', sessionId: 's' })
  assert.deepEqual(seen.map(row => row.method), ['session/selectModel', 'workspace/create', 'workspace/archiveSession'])
  assert.deepEqual(seen[0].payload.args.request, { sessionId: 's', provider: 'provider', model: 'model' })
  await assert.rejects(api.call('host.describe', {}), /未映射/)
})

test('strict correlation and business failure cannot look successful', async () => {
  const wrong = new DshApiClient('http://127.0.0.1:1234', async () => Response.json({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: {} } }))
  await assert.rejects(wrong.listSessions(), /无效 RPC/)
  const rejected = new DshApiClient('http://127.0.0.1:1234', async (_url, init) => Response.json({ type: 'server-response', rpcId: JSON.parse(init.body).rpcId, result: { ok: false, error: { code: 'session/busy', message: 'busy', details: {} } } }))
  await assert.rejects(rejected.cancel('s'), error => error.code === 'session/busy')
})

test('explicit launch URL exchanges only in memory, never follows a redirect carrying credentials', async () => {
  const seen = []
  const api = new DshApiClient('http://127.0.0.1:1234/?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaY', async (url, init) => {
    seen.push({ url: String(url), init })
    if (seen.length === 1) return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh-auth-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=v1.e30.ccccccccccccccccccccccccccccccccccccccccccc; Path=/', location: '/' } })
    const request = JSON.parse(init.body)
    assert.equal(init.headers.cookie, 'dsh-auth-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=v1.e30.ccccccccccccccccccccccccccccccccccccccccccc')
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { items: [] } } })
  })
  await api.listSessions(); await api.listSessions()
  assert.equal(seen[0].init.redirect, 'manual')
  assert.equal(seen.length, 3)
  assert.ok(seen.slice(1).every(row => !row.url.includes('token=')))
})

test('noncanonical login response is rejected without forwarding token or cookie', async () => {
  for (const [status, location] of [[200, '/'], [302, '/'], [303, 'https://attacker.invalid/']]) {
    const api = new DshApiClient('http://127.0.0.1:1234/?token=' + ('a'.repeat(42) + 'Y'), async () => new Response(null, {
      status, headers: { location, 'set-cookie': 'dsh-auth-' + 'b'.repeat(43) + '=v1.e30.' + 'c'.repeat(43) },
    }))
    await assert.rejects(api.authenticate(), /启动链接认证失败/)
  }
})
