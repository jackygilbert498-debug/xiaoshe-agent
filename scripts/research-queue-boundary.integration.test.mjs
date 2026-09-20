import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { mountAgentLoopTestDependencies } from '../runtime/DSH/packages/test-support/agent-loop-testkit/lib/index.js'
import AgentLoop from '../runtime/DSH/packages/core/agent-loop/lib/index.js'
import JsonlPersistence from '../runtime/DSH/packages/session/session-persistence-jsonl/lib/index.js'
import { LlmAdapter, createUserMessage } from '../runtime/DSH/packages/llm/llm/lib/index.js'
const { apply } = await import(process.env.XIAOSHE_TEST_SOURCE === '1'
  ? '../src/plugins/agent-reliability.ts' : '../dist/plugins/agent-reliability.js')

const url = 'https://laboratory.example/architecture'
const article = 'The laboratory describes its inference architecture, evaluation methodology and deployment limitations. This synthetic document explains independent verification, reproducible evaluation and the separation between model performance and application reliability. It is a test fixture, not a real news article.'
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** Real driver/inbox/session boundaries; only external model and web I/O are substituted. */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-queue-boundary-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlPersistence, { root: directory, compression: 'none' })
  apply(ctx)
  const reached = Promise.withResolvers(), release = Promise.withResolvers()
  let requests = 0
  class Adapter extends LlmAdapter {
    async *stream() {
      requests++
      assert.ok(requests <= 6, 'a completed research answer must not restart indefinitely')
      if (requests === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'body-call', name: 'web_fetch', arguments: JSON.stringify({ url }) } }
      } else {
        if (requests === 2) { reached.resolve(); await release.promise }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: requests === 2 ? `已读取架构说明及其局限。[来源](${url})` : '后续任务完成。' } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['queue-fixture'], new Adapter())
  ctx.tools.register({ name: 'web_fetch', description: 'Read a public document body.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args) { assert.equal(args.url, url); return { url, text: article } },
  })
  const handle = await ctx.agents.create({ sessionId: crypto.randomUUID(), agentOptions: { provider: 'queue-fixture', model: 'fixture' } })
  const agent = handle.agent
  t.after(async () => {
    release.resolve(); agent.cancel({ kind: 'user' }); await agent.whenIdle()
    await handle.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true })
  })
  const events = () => agent.session.snapshotEvents()
  const generations = () => events().filter(e => e.type === 'xiaoshe/task-generation').map(e => e.data)
  const start = async () => {
    agent.followup(user('请联网研究实验室推理架构，阅读公开正文并提供来源链接。'))
    await Promise.race([reached.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('research never reached its final-answer boundary')), 5000); timer.unref() })])
    assert.equal(events().filter(e => e.type === 'xiaoshe/research-evidence' && e.data.kind === 'body').length, 1)
  }
  return { ctx, agent, events, generations, start, release: () => release.resolve(), requests: () => requests }
}

test('queued messages and edits do not reset current research; only claimed input starts the next generation', async t => {
  const f = await fixture(t); await f.start()
  const first = f.generations().at(-1)
  const queued = user('下一项任务只做离线总结，不要重新搜索。')
  f.agent.followup(queued)
  const changed = { ...queued, content: [{ type: 'text', text: '下一项任务只用一句话总结，不要联网。' }] }
  assert.equal(f.agent.inbox.replace(queued.id, changed), true)
  assert.deepEqual(f.generations(), [first], 'pending input must not become the active goal or erase its body evidence')
  const canceled = user('这条稍后取消，不应该执行。')
  f.agent.followup(canceled); assert.equal(f.agent.inbox.remove(canceled.id), true)
  assert.deepEqual(f.generations(), [first])
  f.release(); await f.agent.whenIdle()
  assert.equal(f.requests(), 3, 'one tool request, one final answer, one queued follow-up')
  const obligations = f.events().filter(e => e.type === 'xiaoshe/obligation-state' && e.data.kind === 'research')
  assert.equal(obligations.find(e => e.data.generation === first.generation)?.data.status, 'satisfied')
  assert.equal(f.generations().length, 2)
  assert.equal(f.generations()[1].triggerMessageId, queued.id)
  assert.equal(f.events().some(e => e.type === 'user/message' && e.data.id === canceled.id), false)
})

test('a canceled next-turn message never changes the current goal or spends a research completion retry', async t => {
  const f = await fixture(t); await f.start()
  const initial = f.generations()
  const pending = user('等当前任务结束后，禁止联网，处理本地文件。')
  f.agent.followup(pending); assert.equal(f.agent.inbox.remove(pending.id), true)
  assert.deepEqual(f.generations(), initial)
  f.release(); await f.agent.whenIdle()
  assert.equal(f.requests(), 2)
  assert.equal(f.events().filter(e => e.type === 'xiaoshe/obligation-state' && e.data.kind === 'research').at(-1)?.data.status, 'satisfied')
})

/** Exercise real publication, admission and JSONL replay; no native or network actions run. */
async function activationFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-input-activation-'))
  const contexts = [], handles = []
  t.after(async () => {
    for (const handle of handles) await handle.dispose()
    for (const ctx of contexts) await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const mount = async (resumeSessionId) => {
    const ctx = new Context(); contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlPersistence, { root: directory, compression: 'none' })
    apply(ctx)
    const requests = []
    let toolRequested = false, requestTool = false
    class Adapter extends LlmAdapter {
      async *stream(options) {
        requests.push(options)
        assert.ok(requests.length < 8, 'an admitted plain-text task must converge')
        if (requestTool && !toolRequested) {
          toolRequested = true
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'activation-observation', name: 'xiaoshe_runtime_info', arguments: '{}' } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello.' } }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['activation-fixture'], adapter)
    ctx.tools.register({ name: 'web_search', description: 'Search a public source.',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
      async execute() { throw new Error('this fixture must never perform network work') },
    })
    const options = { provider: 'activation-fixture', model: 'fixture' }
    const handle = resumeSessionId
      ? await ctx.agents.resume({ resumeSessionId, agentOptions: options })
      : await ctx.agents.create({ sessionId: crypto.randomUUID(), agentOptions: options })
    handles.push(handle)
    const { agent } = handle
    const events = () => agent.session.snapshotEvents()
    return {
      ctx, agent, handle, adapter, requests, events,
      generations: () => events().filter(event => event.type === 'xiaoshe/task-generation'),
      generation: () => ctx.xiaosheAgentReliability.snapshot(agent).taskGeneration,
      send: async text => { const message = user(text); agent.followup(message); await agent.whenIdle(); return message },
      requestTool: () => { requestTool = true },
      names: async () => (await ctx.systemPrompt.assemble({ agent, scope: agent })).tools.map(tool => tool.name),
      cold: async () => { const id = agent.session.id; await handle.dispose(); await ctx.fiber.dispose(); return mount(id) },
    }
  }
  return mount()
}

test('rejected claimed input cannot create an orphan identity or change the next task after cold replay', async t => {
  const f = await activationFixture(t)
  const first = await f.send('Please say hello.')
  const reject = f.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
  const rejected = await f.send('Please say a different greeting.')
  reject()
  const next = await f.send('Tell me a short joke.')
  assert.equal(f.requests.length, 2)
  assert.equal(f.events().some(event => event.type === 'user/message' && event.data.id === rejected.id), false)
  assert.deepEqual(f.generations().map(event => event.data.triggerMessageId), [first.id, next.id])
  assert.equal(f.generation(), 2)
  const cold = await f.cold()
  assert.equal(cold.generation(), 2)
  assert.deepEqual(cold.generations().map(event => event.data.generation), [1, 2])
})

for (const boundary of ['cancel pre-step', 'throw pre-step', 'cancel request', 'fail request']) {
  test(`${boundary} restores the preceding goal without committing the claimed user input`, async t => {
    const f = await activationFixture(t)
    await f.send('本任务禁止联网，只用一句中文问候。')
    const event = boundary.includes('pre-step') ? 'agent/pre-step' : 'agent/request'
    const stop = f.ctx.on(event, async ({ agent }, next) => {
      if (boundary.startsWith('cancel')) { agent.cancel({ kind: 'user' }); return next() }
      throw new Error('isolated admission failure')
    })
    await f.send('Tell me a short joke.')
    stop()
    assert.equal(f.requests.length, 1)
    assert.equal(f.generations().length, 1)
    assert.equal(f.generation(), 1)
    assert.ok(!(await f.names()).includes('web_search'), 'a rejected proposal must not erase the preceding offline constraint')
    const cold = await f.cold()
    assert.equal(cold.generation(), 1)
    assert.ok(!(await cold.names()).includes('web_search'))
  })
}

test('an adapter prepareCall failure rolls back its uncommitted direct input', async t => {
  const f = await activationFixture(t)
  await f.send('本任务禁止联网，只用一句中文问候。')
  t.mock.method(f.adapter, 'prepareCall', async () => { throw new Error('isolated adapter preparation failure') })
  await f.send('Tell me a short joke.')
  assert.equal(f.requests.length, 1)
  assert.equal(f.generations().length, 1)
  assert.ok(!(await f.names()).includes('web_search'))
  assert.equal((await f.cold()).generation(), 1)
})

test('a stream factory failure still commits the accepted identity outside session append', async t => {
  const f = await activationFixture(t)
  const prepare = f.adapter.prepareCall.bind(f.adapter)
  t.mock.method(f.adapter, 'prepareCall', async (...args) => ({ ...await prepare(...args), stream() { throw new Error('isolated stream factory failure') } }))
  const message = await f.send('Please say hello.')
  assert.equal(f.requests.length, 0)
  assert.equal(f.generations()[0].data.triggerMessageId, message.id)
  assert.ok(f.generations()[0].seq < f.events().find(event => event.type === 'turn/end').seq)
  assert.equal(f.events().some(event => event.type === 'tool/call'), false)
  assert.equal((await f.cold()).generation(), 1)
})

test('a partially committed batch binds only durable messages when the next user append fails', async t => {
  const f = await activationFixture(t)
  const accepted = user('Please say hello.'), failed = user('Tell me a short joke.')
  const append = f.agent.session.append.bind(f.agent.session)
  t.mock.method(f.agent.session, 'append', (type, data, ...args) => {
    if (type === 'user/message' && data.id === failed.id) throw new Error('isolated user append failure')
    return append(type, data, ...args)
  })
  f.agent.inject(accepted); f.agent.followup(failed); await f.agent.whenIdle()
  assert.deepEqual(f.generations().map(event => event.data.triggerMessageId), [accepted.id])
  assert.equal(f.events().some(event => event.type === 'user/message' && event.data.id === failed.id), false)
  assert.equal(f.requests.length, 0)
  assert.equal((await f.cold()).generation(), 1)
})

test('duplicate admitted direct-message ids cancel without minting an ambiguous identity', async t => {
  const f = await activationFixture(t); f.requestTool()
  f.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    return decision.kind !== 'enter' ? decision : { ...decision,
      messages: decision.messages.flatMap(message => message.source.kind === 'user' ? [message, message] : [message]) }
  })
  await f.send('Briefly inspect the current runtime information.')
  assert.equal(f.generations().length, 0)
  assert.equal(f.events().some(event => event.type === 'tool/call'), false)
  assert.equal(f.events().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted')
  const live = f.generation()
  assert.equal((await f.cold()).generation(), live)
})

test('an already resumed agent force-rebuilds after a partial identity batch fails', async t => {
  const first = await activationFixture(t)
  await first.send('Please say hello.')
  const f = await first.cold(), append = f.agent.session.append.bind(f.agent.session)
  let markers = 0
  t.mock.method(f.agent.session, 'append', (type, ...args) => {
    if (type === 'xiaoshe/task-generation' && ++markers === 2) throw new Error('isolated second identity append failure')
    return append(type, ...args)
  })
  f.agent.inject(user('继续。')); f.agent.followup(user('Tell me a short joke.')); await f.agent.whenIdle()
  assert.equal(f.events().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted')
  const live = f.generation()
  assert.equal((await f.cold()).generation(), live, 'the once-only resume guard must not suppress failure reconstruction')
})

test('a cold legacy orphan cannot poison a new direct research task or certify its old evidence', async t => {
  const first = await activationFixture(t)
  await first.send('Please say hello.')
  first.agent.session.append('xiaoshe/task-generation', { version: 1, generation: 90, relation: 'new', triggerMessageId: 'removed-legacy-queued-input' })
  const f = await first.cold()
  f.ctx.tools.register({ name: 'web_fetch', description: 'Read a complete public article.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute() { return { url, text: article } },
  })
  t.mock.method(f.adapter, 'stream', async function* (options) {
    f.requests.push(options)
    assert.ok(f.requests.length <= 4, 'a new trusted task must not loop on the quarantined prefix')
    if (f.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fresh-body', name: 'web_fetch', arguments: JSON.stringify({ url }) } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `The article describes architecture and its limitations. Source: ${url}` } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await f.send(`新任务：请联网研究实验室推理架构，阅读 ${url} 的公开正文并提供来源链接。`)
  assert.equal(f.requests.length, 2)
  const obligation = f.events().filter(event => event.type === 'xiaoshe/obligation-state' && event.data.kind === 'research').at(-1)
  assert.equal(obligation?.data.status, 'satisfied')
  assert.deepEqual(obligation.data.bodyResultSeqs, [f.events().find(event => event.type === 'tool/result').seq])
  assert.equal(f.generation(), 2, 'an orphan declaration does not own the task counter')
  assert.equal((await f.cold()).generation(), 2)
})

test('rewritten admitted content owns the task identity and restored constraints', async t => {
  const f = await activationFixture(t)
  await f.send('Please say hello.')
  const rewrite = f.ctx.on('agent/pre-step', async ({ messages }, next) => {
    const decision = await next()
    return decision.kind !== 'enter' ? decision : { ...decision, messages: decision.messages.map(message => message.id === messages[0]?.id
      ? { ...message, content: [{ type: 'text', text: '本任务禁止联网，只用一句中文问候。' }] } : message) }
  })
  const original = await f.send('Tell me a short joke.')
  rewrite()
  assert.ok(!(await f.names()).includes('web_search'))
  assert.equal(f.generation(), 2)
  const marker = f.generations().at(-1)
  const admitted = f.events().find(event => event.type === 'user/message' && event.data.id === original.id)
  assert.equal(marker.data.triggerMessageSeq, admitted.seq)
  assert.ok(marker.seq > admitted.seq)
  const cold = await f.cold()
  assert.equal(cold.generation(), 2)
  assert.ok(!(await cold.names()).includes('web_search'))
})

test('a proposal rewritten as plugin context does not acquire direct-user identity or replace constraints', async t => {
  const f = await activationFixture(t)
  await f.send('本任务禁止联网，只用一句中文问候。')
  const rewrite = f.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    return decision.kind !== 'enter' ? decision : { ...decision, messages: decision.messages.map(message => message.source.kind === 'user'
      ? { ...message, source: { kind: 'plugin', plugin: 'activation-fixture' } } : message) }
  })
  await f.send('Tell me a short joke.'); rewrite()
  assert.equal(f.generations().length, 1)
  assert.equal(f.generation(), 1)
  assert.ok(!(await f.names()).includes('web_search'))
  assert.equal((await f.cold()).generation(), 1)
})

for (const dropFirst of [false, true]) {
  test(`a claimed batch records only admitted user messages in order (drop first: ${dropFirst})`, async t => {
    const f = await activationFixture(t)
    const first = await f.send('Please say hello.')
    const pending = user('Tell me a short joke.'), final = user('Say a short farewell.')
    if (dropFirst) f.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind !== 'enter' ? decision : { ...decision, messages: decision.messages.filter(message => message.id !== pending.id) }
    })
    f.agent.inject(pending); f.agent.followup(final); await f.agent.whenIdle()
    assert.deepEqual(f.generations().map(event => event.data.triggerMessageId), dropFirst ? [first.id, final.id] : [first.id, pending.id, final.id])
    assert.deepEqual(f.generations().map(event => event.data.generation), dropFirst ? [1, 2] : [1, 2, 3])
    for (const marker of f.generations()) {
      const admitted = f.events().find(event => event.type === 'user/message' && event.data.id === marker.data.triggerMessageId)
      assert.equal(marker.data.triggerMessageSeq, admitted.seq)
      assert.ok(marker.seq > admitted.seq)
    }
    assert.equal((await f.cold()).generation(), dropFirst ? 2 : 3)
  })
}

test('all accepted batch identities precede the active conditional-read obligation', async t => {
  const f = await activationFixture(t)
  const pending = user('先读取 C:/sources/primary.txt。失败后，改为读取 C:/sources/fallback.txt。')
  const continued = user('继续。')
  f.agent.inject(pending); f.agent.followup(continued); await f.agent.whenIdle()
  assert.deepEqual(f.generations().map(event => [event.data.generation, event.data.relation]), [[1, 'new'], [1, 'continuation']])
  const obligation = f.events().find(event => event.type === 'xiaoshe/obligation-state')
  assert.ok(obligation.seq > f.generations().at(-1).seq)
  assert.equal(obligation.data.kind, 'ordered-read')
  assert.equal((await f.cold()).generation(), 1)
})

test('committed identity precedes the first real tool call and persistence failure cancels before tool effects', async t => {
  await t.test('normal commit', async t => {
    const f = await activationFixture(t); f.requestTool()
    await f.send('Briefly inspect the current runtime information.')
    const marker = f.generations().at(-1), call = f.events().find(event => event.type === 'tool/call')
    assert.equal(marker.data.version, 2)
    assert.ok(marker.data.triggerMessageSeq < marker.seq)
    assert.ok(marker.seq < call.seq)
  })
  await t.test('failed identity append', async t => {
    const f = await activationFixture(t); f.requestTool()
    const append = f.agent.session.append.bind(f.agent.session)
    t.mock.method(f.agent.session, 'append', (type, ...args) => {
      if (type === 'xiaoshe/task-generation') throw new Error('isolated identity append failure')
      return append(type, ...args)
    })
    await f.send('Briefly inspect the current runtime information.')
    // The official stream-start notification contains observer exceptions.
    // Explicit abort must stop execution even if an adapter yields once without
    // respecting its signal; do not mislabel that as no adapter invocation.
    assert.ok(f.requests.length <= 1)
    assert.equal(f.events().some(event => event.type === 'tool/call'), false)
    assert.equal(f.events().findLast(event => event.type === 'turn/end').data.reason.kind, 'aborted')
  })
})
