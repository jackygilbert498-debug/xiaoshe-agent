import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { register } from '../../../runtime/DSH/node_modules/tsx/dist/esm/api/index.mjs'
import { TerminalApp } from '../lib/app.js'
import { DshApiClient } from '../lib/api.js'
register({ tsconfig: fileURLToPath(new URL('../../../runtime/DSH/tsconfig.base.json', import.meta.url)) })
const dsh = '../../../runtime/DSH/'
const { Context, Service } = await import(dsh + 'vendor/cordis/src/index.ts')
const { default: WebServer } = await import(dsh + 'packages/host/webserver/src/index.ts')
const { default: TypertRegistry } = await import(dsh + 'packages/typert/registry/src/index.ts')
const { bindTypertRemote } = await import(dsh + 'packages/typert/protocol/src/index.ts')
const { default: Gateway } = await import(dsh + 'packages/api/gateway/src/index.ts')
const Connection = await import(dsh + 'packages/client/connection/src/index.ts')
const { default: Sessions } = await import(dsh + 'packages/core/session/src/index.ts')
const { default: Projections } = await import(dsh + 'packages/session/session-projection/src/index.ts')
const { default: Query } = await import(dsh + 'packages/session-query/session-query/src/index.ts')
const { default: Agents } = await import(dsh + 'packages/core/agent/src/index.ts')
const { default: AgentLoop } = await import(dsh + 'packages/core/agent-loop/src/index.ts')
const { default: SystemPrompt } = await import(dsh + 'packages/core/system-prompt/src/index.ts')
const { default: Tools } = await import(dsh + 'packages/core/tools/src/index.ts')
const { default: Llm, LlmAdapter } = await import(dsh + 'packages/llm/llm/src/index.ts')
const { textResponse } = await import(dsh + 'packages/core/agent-loop/tests/mock-adapter.ts')
const { SessionHistoryController } = await import(dsh + 'packages/api/session-controller/src/history.ts')
const { ApiSessionList } = await import(dsh + 'packages/api/session-controller/src/list.ts')
const { SessionControlController } = await import(dsh + 'packages/api/session-controller/src/control.ts')
const { SessionCommandController } = await import(dsh + 'packages/api/session-controller/src/commands.ts')
const { ApiSessionAgentController } = await import(dsh + 'packages/api/session-controller/src/agent.ts')
const { buildModelCatalog } = await import(dsh + 'packages/api/session-controller/src/catalog.ts')
const { installModelSelectionProjection } = await import(dsh + 'packages/api/session-controller/src/model-selection-projection.ts')
const { TYPERT } = await import(dsh + 'packages/api/session-controller/lib/typert.host.js')

async function until(check, label) {
  const end = Date.now() + 5000
  while (!check() && Date.now() < end) await delay(10)
  assert.ok(check(), label)
}

test('terminal through real Host HTTP/WS and AgentLoop queues, edits, removes and changes the next request effort', { timeout: 20000 }, async t => {
  const ctx = new Context(), first = Promise.withResolvers(), captured = [], sockets = new Set()
  const previousCookie = process.env.XIAOSHE_AUTH_COOKIE
  let app, run
  t.after(async () => {
    first.resolve(); app?.rl.close(); app?.mux.close()
    await run?.catch(() => {})
    for (const socket of sockets) socket.destroy()
    await ctx.fiber.dispose()
    if (previousCookie === undefined) delete process.env.XIAOSHE_AUTH_COOKIE
    else process.env.XIAOSHE_AUTH_COOKIE = previousCookie
  })
  new Sessions(ctx); new Projections(ctx); new Query(ctx)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' }); await ctx.plugin(Llm); await ctx.plugin(Agents); await ctx.plugin(Tools)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'test', reasoningEffort: 'low' }), saveSelection: async () => {} })
  // Ordinary text fixture: no file receipt or attachment is admitted here.
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024, maxImagePixels: 100, maxImageDimension: 10, mediaTypes: ['image/png'] }, admitPromptContent: async content => content })
  ctx.provide('fileUploads', { bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }), retirePrompt() {} })
  ctx.llm.registerAdapter(['fixture'], new class extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Fixture' } }
    async listModels() { return [{ provider: 'fixture', id: 'test', name: 'Test' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } } }
    async *stream(options) {
      captured.push({ provider: options.provider, model: options.model, effort: options.reasoningEffort })
      if (captured.length === 1) await first.promise
      yield* textResponse('fixture result ' + captured.length)
    }
  }())
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = await ctx.agentLoop.create('terminal-running-fixture', { provider: 'fixture', model: 'test' }, { cwd: process.cwd() })
  const records = new Map()
  ctx.provide('credentials', { async modifyRecord(key, mutate) { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key) } })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  ctx.webServer.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await ctx.plugin(TypertRegistry); await ctx.plugin(Gateway, {}); await ctx.plugin({ inject: Connection.inject, apply: Connection.apply })
  ctx.typertGateway.registerRemoteEvents(async function* (signal) {
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
  }, { home: process.cwd() })
  installModelSelectionProjection(ctx)
  const agents = new ApiSessionAgentController(ctx), commands = new SessionCommandController(ctx, agents, process.cwd())
  const list = new ApiSessionList(ctx), history = new SessionHistoryController(ctx, observation => observation[Symbol.dispose]()), control = new SessionControlController(ctx)
  class Controller extends Service {
    constructor(ctx) { super(ctx, 'sessionController'); this.typertRemote = bindTypertRemote(this, 'sessionController', { namespace: 'session' }) }
    async list(_request, signal) { return { items: await list.list(signal) } }
    follow(request, signal) { return history.follow(request, signal) }
    page(request, signal) { return history.page(request, signal) }
    control(signal) { return control.control(signal) }
    modelCatalog() { return buildModelCatalog(ctx) }
    prompt(request) { return commands.prompt(request) }
    updateQueue(request) { return commands.updateQueue(request) }
    selectModel(request) { return commands.selectModel(request) }
    cancel(request) { return commands.cancel(request) }
  }
  await ctx.plugin(Controller)
  ctx.typert.register({ ...TYPERT, invocations: TYPERT.invocations.filter(row => row.namespace === 'session' && ['list', 'follow', 'page', 'control', 'modelCatalog', 'prompt', 'updateQueue', 'selectModel', 'cancel'].includes(row.method)) })
  const base = 'http://127.0.0.1:' + ctx.webServer.port, launch = new URL(ctx.connection.authenticatedUrl(base))
  ctx.connection.authorizeIndex({ method: 'GET', url: launch.pathname + launch.search, headers: { host: launch.host } }, { writeHead(_status, headers) { process.env.XIAOSHE_AUTH_COOKIE = headers['set-cookie'].split(';')[0] }, end() {} })
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough()
  let text = '', errors = ''
  output.on('data', chunk => { text += chunk }); error.on('data', chunk => { errors += chunk })
  app = new TerminalApp({ baseUrl: base, resume: agent.id, fresh: false, noColor: true, help: false }, { input, output, error, color: false })
  run = app.run(); run.catch(error => t.diagnostic(String(error)))
  await until(() => text.includes(':help'), 'terminal banner')
  input.write('first\n'); await until(() => captured.length === 1, 'first real AgentLoop request')
  input.write('second\n'); await until(() => agent.inbox.nextTurn.length === 1, 'second prompt enters real inbox before first ends')
  const secondId = agent.inbox.nextTurn[0].id
  input.write(':queue\n'); await until(() => text.includes(secondId), 'authoritative queue rendered')
  input.write(`:queue edit ${secondId} revised second\n`)
  await until(() => agent.inbox.nextTurn[0]?.content[0]?.text === 'revised second', 'real Host queue edit')
  input.write('remove me\n'); await until(() => agent.inbox.nextTurn.length === 2, 'third queued')
  input.write(`:queue remove ${agent.inbox.nextTurn[1].id}\n`)
  await until(() => agent.inbox.nextTurn.length === 1, 'real Host queue remove')
  input.write('removed from another client\n'); await until(() => agent.inbox.nextTurn.length === 2, 'external removal candidate queued')
  const externalId = agent.inbox.nextTurn[1].id
  input.write(':queue\n'); await until(() => text.includes(externalId), 'terminal observed external removal candidate')
  const otherClient = new DshApiClient(base, fetch, process.env.XIAOSHE_AUTH_COOKIE)
  await otherClient.call('session.updateQueue', { sessionId: agent.id, itemId: externalId, action: { kind: 'remove' } })
  await until(() => agent.inbox.nextTurn.length === 1, 'other client removed the queued message')
  input.write(':effort high\n'); await until(() => text.includes('下一次模型请求'), 'next-request receipt')
  assert.equal(agent.status, 'running')
  first.resolve()
  await until(() => captured.length === 2 && text.includes('fixture result 2'), 'both responses rendered')
  assert.deepEqual(captured, [{ provider: 'fixture', model: 'test', effort: 'low' }, { provider: 'fixture', model: 'test', effort: 'high' }])
  assert.equal(errors, '')
  input.end()
  await until(() => app.awaitingPrompt.size === 0, 'durable prompts retire admission tracking: ' + JSON.stringify(agent.session.snapshotEvents().filter(row => row.type === 'user/message')))
  await run
  assert.equal(input.listenerCount('data'), 0)
})
