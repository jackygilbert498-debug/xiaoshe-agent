import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { register } from '../../../runtime/DSH/node_modules/tsx/dist/esm/api/index.mjs'
import { DshApiClient, MuxConnection } from '../lib/api.js'
register({ tsconfig: fileURLToPath(new URL('../../../runtime/DSH/tsconfig.base.json', import.meta.url)) })
const dsh = '../../../runtime/DSH/'
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
  const queue = []
  let wake
  ctx.typertGateway.registerRemoteEvents(async function* (signal) {
    const onAbort = () => wake?.()
    signal.addEventListener('abort', onAbort)
    try { while (!signal.aborted) { if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve }) } }
    finally { signal.removeEventListener('abort', onAbort) }
  }, { home: '/fixture' })
  return { ctx, api: new DshApiClient(base, fetch, cookie), observedApi(onResponse) { return new DshApiClient(base, fetch, cookie, { onResponse }) }, disconnect() { for (const socket of sockets) socket.destroy() }, push(event) { queue.push(event); wake?.() } }
}

test('isolated HostConnection + Gateway + generated Session Remote: list, history, follow, approval result', { timeout: 15000 }, async t => {
  const { ctx, api, push } = await host(t)
  const session = ctx.sessions.create('terminal-fixture', { meta: { cwd: '/fixture' } })
  const rows = await api.listSessions()
  assert.equal(rows[0].sessionId, session.id)
  session.append('turn/start', { turn: 1 })
  const history = await api.history(session.id)
  assert.equal(history.events.at(-1).event.seq, session.seq - 1)
  const feed = new MuxConnection(api)
  t.after(() => feed.close())
  await feed.opened
  feed.subscribe(session.id)
  while (!feed.hasSubscription(session.id)) await feed.next()
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  let frame
  do { frame = await feed.next() } while (frame.payload.type !== 'session/event')
  assert.equal(frame.payload.event.type, 'turn/end')
  const outcome = Promise.withResolvers()
  const subject = { ctx }
  push({ event: 'approval/request', request: { agent: subject, toolName: 'write' }, context: { value: ctx, subject, agentId: session.id }, resolve: outcome.resolve, reject: outcome.reject })
  do { frame = await feed.next() } while (frame.payload.type !== 'approval/requested')
  await feed.respond(frame.rpcId, 'allowed-once')
  assert.deepEqual(await outcome.promise, { kind: 'result', value: 'allowed-once' })
  await assert.rejects(feed.respond(frame.rpcId, 'allowed-once'), /已完成|失效/)
})

test('real stream raw retention precedes history folding and a failed retention rejects the call', { timeout: 15000 }, async t => {
  const { ctx, observedApi } = await host(t)
  const session = ctx.sessions.create('terminal-retain', { meta: { cwd: '/fixture' } })
  session.append('turn/start', { turn: 1 })
  const wire = []
  const history = await observedApi(async row => { await Promise.resolve(); wire.push(row) }).history(session.id)
  assert.equal(history.events[0].event.type, 'turn/start')
  assert.equal(wire[0].endpoint, 'session/follow')
  assert.equal(wire[0].status, 101)
  const frame = JSON.parse(wire[0].bytes)
  assert.equal(frame.streamId, wire[0].rpcId)
  assert.equal(frame.value.type, 'snapshot')
  assert.deepEqual(frame.value.records.map(row => row.event), history.events.map(row => row.event))
  await assert.rejects(observedApi(() => { throw new Error('retention failed') }).history(session.id), /retention failed/)
})

test('opening terminal does not decline an existing approval before choosing its session', { timeout: 15000 }, async t => {
  const { ctx, api, push } = await host(t)
  const session = ctx.sessions.create('terminal-existing-question', { meta: { cwd: '/fixture' } })
  const subject = { ctx }
  let settled = false
  const outcome = Promise.withResolvers()
  push({ event: 'approval/request', request: { agent: subject, toolName: 'write' }, context: { value: ctx, subject, agentId: session.id }, resolve(value) { settled = true; outcome.resolve(value) }, reject: outcome.reject })
  const feed = new MuxConnection(api)
  t.after(() => feed.close())
  await feed.opened
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(settled, false, 'selection has not assigned the terminal an Agent scope yet')
  feed.subscribe(session.id)
  await feed.waitSubscribed(session.id)
  let frame
  do { frame = await feed.next() } while (frame.payload.type !== 'approval/requested')
  await feed.respond(frame.rpcId, 'rejected')
  assert.deepEqual(await outcome.promise, { kind: 'result', value: 'rejected' })
})

test('real Remote event cancellation invalidates input; disconnect reconnects follow without duplicating events', { timeout: 15000 }, async t => {
  const { ctx, api, push, disconnect } = await host(t)
  const session = ctx.sessions.create('terminal-reconnect', { meta: { cwd: '/fixture' } })
  const feed = new MuxConnection(api)
  t.after(() => feed.close())
  await feed.opened
  feed.subscribe(session.id)
  while (!feed.hasSubscription(session.id)) await feed.next()
  const cancellation = new AbortController()
  const outcome = Promise.withResolvers()
  outcome.promise.catch(() => {})
  const subject = { ctx }
  push({ event: 'user-questions/request', request: { agent: subject, questions: [{ id: 'q', question: 'choice?', options: [{ label: 'yes' }] }], signal: cancellation.signal }, context: { value: ctx, subject, agentId: session.id }, resolve: outcome.resolve, reject: outcome.reject })
  let frame
  do { frame = await feed.next() } while (frame.payload.type !== 'question/requested')
  const inputLifetime = feed.interactionSignal(frame.rpcId)
  cancellation.abort(new Error('test cancelled'))
  await assert.rejects(outcome.promise, /test cancelled/)
  await new Promise(resolve => { if (inputLifetime.aborted) resolve(); else inputLifetime.addEventListener('abort', resolve, { once: true }) })
  await assert.rejects(feed.respond(frame.rpcId, { answers: [] }), /失效|已完成/)
  disconnect()
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const replay = []
  while (replay.length < 2) { frame = await feed.next(); if (frame.payload.type === 'session/event') replay.push(frame.payload.event.seq) }
  assert.deepEqual(replay, [0, 1])
  const answered = Promise.withResolvers()
  push({ event: 'user-questions/request', request: { agent: subject, questions: [{ id: 'q2', question: 'after reconnect?' }] }, context: { value: ctx, subject, agentId: session.id }, resolve: answered.resolve, reject: answered.reject })
  do { frame = await feed.next() } while (frame.payload.type !== 'question/requested')
  await feed.respond(frame.rpcId, { answers: [{ id: 'q2', selected: [], custom: 'safe' }] })
  assert.deepEqual(await answered.promise, { kind: 'result', value: { answers: [{ id: 'q2', selected: [], custom: 'safe' }] } })
})
