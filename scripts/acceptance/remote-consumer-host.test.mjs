import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { register } from '../../runtime/DSH/node_modules/tsx/dist/esm/api/index.mjs'
import { DshApiClient, MuxConnection } from '../../packages/terminal-client/lib/api.js'
register({ tsconfig: fileURLToPath(new URL('../../runtime/DSH/tsconfig.base.json', import.meta.url)) })
const dsh = '../../runtime/DSH/'
const { Context, Service } = await import(dsh + 'vendor/cordis/src/index.ts')
const { default: WebServer } = await import(dsh + 'packages/host/webserver/src/index.ts')
const { default: TypertRegistry } = await import(dsh + 'packages/typert/registry/src/index.ts')
const { bindTypertRemote } = await import(dsh + 'packages/typert/protocol/src/index.ts')
const { default: Gateway } = await import(dsh + 'packages/api/gateway/src/index.ts')
const Connection = await import(dsh + 'packages/client/connection/src/index.ts')
const { default: SessionStore } = await import(dsh + 'packages/core/session/src/index.ts')
const { default: Projections } = await import(dsh + 'packages/session/session-projection/src/index.ts')
const { default: Query } = await import(dsh + 'packages/session-query/session-query/src/index.ts')
const { SessionHistoryController } = await import(dsh + 'packages/api/session-controller/src/history.ts')
const { ApiSessionList } = await import(dsh + 'packages/api/session-controller/src/list.ts')
const { SessionControlController } = await import(dsh + 'packages/api/session-controller/src/control.ts')
const { TYPERT } = await import(dsh + 'packages/api/session-controller/lib/typert.host.js')

/** Real read controllers behind generated descriptors and real HTTP/WS carriers. No model or disk Profile. */
async function host(t) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new SessionStore(ctx); new Projections(ctx); new Query(ctx)
  ctx.provide('agents', { get: () => undefined })
  const records = new Map()
  ctx.provide('credentials', { async modifyRecord(key, mutate) { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) } })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const sockets = new Set()
  ctx.webServer.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(Gateway, {})
  await ctx.plugin({ inject: Connection.inject, apply: Connection.apply })
  const list = new ApiSessionList(ctx)
  const history = new SessionHistoryController(ctx, observation => observation[Symbol.dispose]())
  const control = new SessionControlController(ctx)
  class ReadController extends Service {
    constructor(ctx) { super(ctx, 'sessionController'); this.typertRemote = bindTypertRemote(this, 'sessionController', { namespace: 'session' }) }
    async list(_request, signal) { return { items: await list.list(signal) } }
    follow(request, signal) { return history.follow(request, signal) }
    page(request, signal) { return history.page(request, signal) }
    control(signal) { return control.control(signal) }
  }
  await ctx.plugin(ReadController)
  ctx.typert.register({ ...TYPERT, invocations: TYPERT.invocations.filter(row => row.namespace === 'session' && ['list', 'follow', 'page', 'control'].includes(row.method)) })
  const base = 'http://127.0.0.1:' + ctx.webServer.port
  const launch = new URL(ctx.connection.authenticatedUrl(base))
  let cookie
  ctx.connection.authorizeIndex({ method: 'GET', url: launch.pathname + launch.search, headers: { host: launch.host } }, {
    writeHead(_status, headers) { cookie = headers['set-cookie'].split(';')[0] }, end() {},
  })
  ctx.webServer.registerFallback((req, res) => { if (ctx.connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('fixture') } })
  const queue = []
  let wake
  ctx.typertGateway.registerRemoteEvents(async function* (signal) {
    const onAbort = () => wake?.()
    signal.addEventListener('abort', onAbort)
    try { while (!signal.aborted) { if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve }) } }
    finally { signal.removeEventListener('abort', onAbort) }
  }, { home: '/fixture' })
  return { ctx, base, launchUrl: launch.href, api: new DshApiClient(base, fetch, cookie), observedApi(onResponse) { return new DshApiClient(base, fetch, cookie, { onResponse }) }, disconnect() { for (const socket of sockets) socket.destroy() }, push(event) { queue.push(event); wake?.() } }
}

import { acceptanceRpc } from './public-rpc.mjs'
import { collectCompleteComplexHistory } from './complex-run-binding.mjs'

test('acceptance collector uses real authenticated Host follow+page raw evidence at one fixed cut', { timeout: 15000 }, async t => {
  const { ctx, base, launchUrl } = await host(t)
  const session = ctx.sessions.create('acceptance-paged', { meta: { cwd: '/fixture' } })
  for (let i = 0; i < 407; i++) session.append('user/message', { id: 'user-' + i, source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic ' + i }] }, { surfaceOp: 'append' })
  const originalLength = session.seq
  const wire = []
  const invoke = acceptanceRpc(base, { authUrl: launchUrl, onResponse: row => { wire.push(row) } })
  let opened = false
  const result = await collectCompleteComplexHistory(session.id, async (method, payload) => {
    const page = await invoke(method, payload)
    if (!opened) {
      opened = true
      session.append('user/message', { id: 'later', source: { kind: 'user' }, content: [{ type: 'text', text: 'outside fixed cut' }] }, { surfaceOp: 'append' })
    }
    return page
  })
  assert.equal(result.events, originalLength)
  assert.equal(result.throughSeq, originalLength - 1)
  assert.equal(result.pages, 3)
  assert.deepEqual(wire.map(row => row.endpoint), ['session/follow', 'session/page', 'session/page'])
  assert.equal(wire[0].status, 101)
  assert.equal(JSON.parse(wire[0].bytes).value.cursor, originalLength - 1)
  for (const row of wire.slice(1)) {
    assert.equal(row.args.request.throughSeq, originalLength - 1)
    assert.equal(JSON.parse(row.bytes).rpcId, row.rpcId)
    assert.equal(JSON.parse(row.bytes).result.ok, true)
  }
  assert.equal(wire.some(row => row.bytes.includes('outside fixed cut')), false)
})
