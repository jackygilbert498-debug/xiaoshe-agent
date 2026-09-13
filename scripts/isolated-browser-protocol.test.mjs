import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, chmod, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { browserOrigin, descriptorPath, createBrowserEndpoint, requestBrowser } from './isolated-browser-protocol.mjs'

const origin = 'http://127.0.0.1:38080'
async function endpoint(t, dispatch) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-browser-protocol-'))
  const server = await createBrowserEndpoint({ origin, root, dispatch })
  t.after(() => server.close())
  return { root, server, request: (command, extra = {}) => requestBrowser({ origin, root, ownerId: 'test-session', command, ...extra }) }
}
test('normalizes product origins but never permits external credentials or servers', () => {
  assert.equal(browserOrigin({ XIAOSHE_DESKTOP_URL: 'http://localhost:3080/' }), 'http://127.0.0.1:3080')
  assert.equal(descriptorPath(origin, '/tmp'), descriptorPath(origin.replace('127.0.0.1', 'localhost'), '/tmp'))
  for (const url of ['https://example.com', 'http://user:pass@localhost:3080', 'http://192.168.1.1']) assert.throws(() => browserOrigin({ XIAOSHE_DESKTOP_URL: url }))
})
test('real private transport scopes each command to its owner, preserves errors and protects descriptor', async t => {
  const { request, server } = await endpoint(t, async (ownerId, command, args) => {
    if (command === 'fail') throw Object.assign(new Error('Controlled failure'), { code: 'TEST_FAILURE' })
    return { ownerId, command, args }
  })
  assert.deepEqual(await request('snapshot', { args: { tab_id: 't1' } }), { ownerId: 'test-session', command: 'snapshot', args: { tab_id: 't1' } })
  await assert.rejects(request('fail'), { code: 'TEST_FAILURE' })
  if (process.platform !== 'win32') {
    assert.equal((await stat(server.path)).mode & 0o777, 0o600)
    await chmod(server.path, 0o644)
    await assert.rejects(request('status'), { code: 'BROWSER_NOT_CONNECTED' })
  }
})
test('bad tokens, Unicode tokens, malformed and oversized frames cannot reach dispatcher', async t => {
  let calls = 0
  const { server, request } = await endpoint(t, () => { calls++; return {} })
  const record = JSON.parse(await readFile(server.path, 'utf8'))
  async function raw(value) {
    await new Promise((resolve, reject) => {
      const socket = createConnection(record.port, record.host)
      socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('server did not reject invalid frame')) })
      socket.on('error', () => {}); socket.on('close', resolve)
      socket.on('connect', () => socket.write(value))
    })
  }
  for (const token of ['a'.repeat(64), '界'.repeat(64), null]) await raw(JSON.stringify({ version: 1, id: 'a', ownerId: 'x', command: 'status', token }) + '\n')
  await raw('not json\n'); await raw('x'.repeat(1024 * 1024 + 2))
  assert.equal(calls, 0)
  await request('status'); assert.equal(calls, 1)
})
test('user cancellation and timeouts close the connection and abort the native operation', async t => {
  let aborted = 0
  const { request } = await endpoint(t, async (_owner, _command, _args, signal) => {
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted++; resolve() }, { once: true }))
    return {}
  })
  const controller = new AbortController()
  const pending = request('slow', { signal: controller.signal }); setTimeout(() => controller.abort(), 40)
  await assert.rejects(pending, { code: 'BROWSER_CANCELLED' })
  await delay(30); assert.equal(aborted, 1)
  await assert.rejects(request('slow', { timeoutMs: 40 }), { code: 'BROWSER_TIMEOUT' })
  await delay(30); assert.equal(aborted, 2)
})
test('output limit is explicit and stale descriptor never redirects to a remote endpoint', async t => {
  const { request, server } = await endpoint(t, () => ({ text: 'x'.repeat(1024 * 1024) }))
  await assert.rejects(request('huge'), { code: 'BROWSER_OUTPUT_LIMIT' })
  const record = JSON.parse(await readFile(server.path, 'utf8'))
  await writeFile(server.path, JSON.stringify({ ...record, host: 'example.com' }), { mode: 0o600 })
  await assert.rejects(request('status'), { code: 'BROWSER_NOT_CONNECTED' })
})
