import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { composeEntries, loadOverlayPatches } from '../runtime/DSH/packages/boot/app-boot/lib/index.js'
import { mountAgentLoopTestDependencies } from '../runtime/DSH/packages/test-support/agent-loop-testkit/lib/index.js'
import AgentLoop from '../runtime/DSH/packages/core/agent-loop/lib/index.js'
import JsonlPersistence from '../runtime/DSH/packages/session/session-persistence-jsonl/lib/index.js'
import { LlmAdapter } from '../runtime/DSH/packages/llm/llm/lib/index.js'
import * as schedule from '../runtime/DSH/packages/schedule/schedule/lib/index.js'
import * as timeContext from '../runtime/DSH/packages/context/time-context/lib/index.js'
import { parse } from 'yaml'
import { mergeProfile } from './ensure-profile-patch.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const template = await readFile(new URL('../setup/profile/cordis.patch.yml', import.meta.url), 'utf8')
const modules = new Map([
  ['@deepseek-ai/dsh-schedule', schedule],
  ['@deepseek-ai/dsh-time-context', timeContext],
])
const tools = ['schedule_create', 'schedule_delete', 'schedule_list']

/** Compose the shipped product layers, preserving the user's final overlay. */
function entries(profile = '') {
  return composeEntries([
    loadOverlayPatches('test', join(root, 'runtime/DSH/packages/bundle/base/cordis.patch.yml')),
    loadOverlayPatches('test', join(root, 'runtime/DSH/packages/bundle/web-app/cordis.patch.yml')),
    loadOverlayPatches('test', join(root, 'cordis.patch.yml')),
    loadOverlayPatches('test', join(root, 'packages/product-bundle/cordis.patch.yml')),
    parse(mergeProfile(profile, template)),
  ])
}

class OfflineAdapter extends LlmAdapter {
  requests = []
  async *stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '隔离测试提醒已处理。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Real sessions, tools, root lifecycle and JSONL; only the model transport is offline. */
async function fixture(t, profile = '') {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-schedule-'))
  const contexts = []
  t.after(async () => {
    await Promise.allSettled(contexts.map(ctx => ctx.fiber.dispose()))
    await rm(directory, { recursive: true, force: true })
  })
  const mount = async () => {
    const ctx = new Context(); contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: entries(profile).find(entry => entry.id === 'system-prompt')?.config ?? {} })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlPersistence, { root: directory, compression: 'none' })
    const adapter = new OfflineAdapter()
    ctx.llm.registerAdapter(['offline-schedule'], adapter)
    // Mount the actual reminder entries selected by the production composer;
    // unrelated web/desktop services have no part in this isolated boundary.
    for (const entry of entries(profile)) {
      const plugin = modules.get(entry.name)
      if (plugin && !entry.disabled) await ctx.plugin(plugin, entry.config ?? {})
    }
    const call = (agent, name, args = {}) => ctx.agents.withInitiator(agent, async () => {
      const result = await ctx.tools.execute({ name, arguments: args, callId: crypto.randomUUID(), agent,
        signal: new AbortController().signal })
      assert.equal(result.isError, false, JSON.stringify(result))
      return result.value
    })
    return { ctx, adapter, call }
  }
  return { mount }
}

async function create(runtime, id = crypto.randomUUID()) {
  return runtime.ctx.agents.create({ sessionId: id, agentOptions: { provider: 'offline-schedule', model: 'fixture' } })
}

/** Observe a durable dispatch boundary with a finite failure deadline. */
function dispatch(ctx, agent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('reminder did not dispatch')) }, 5000)
    const stop = ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'schedule/change' || event.data.operation !== 'dispatch') return
      clearTimeout(timer); stop(); resolve()
    })
  })
}

test('default product mounts discoverable session tools and creates/lists/cancels only the selected reminder', async t => {
  const { mount } = await fixture(t), runtime = await mount()
  const handle = await create(runtime), { agent } = handle
  const names = (await runtime.ctx.systemPrompt.assemble({ agent, scope: agent })).tools.map(tool => tool.name)
  assert.deepEqual(names.filter(name => name.startsWith('schedule_')).sort(), tools)
  const retained = await runtime.call(agent, 'schedule_create', { prompt: '保留的提醒', after_seconds: 3600 })
  const cancelled = await runtime.call(agent, 'schedule_create', { prompt: '取消的提醒', after_seconds: 120 })
  assert.equal(cancelled.kind, 'after'); assert.equal(cancelled.deliveryMode, 'session-local')
  assert.deepEqual((await runtime.call(agent, 'schedule_list')).map(item => item.prompt), ['保留的提醒', '取消的提醒'])
  assert.deepEqual(await runtime.call(agent, 'schedule_delete', { id: cancelled.id }), { id: cancelled.id, deleted: true })
  assert.deepEqual((await runtime.call(agent, 'schedule_list')).map(item => item.id), [retained.id])
  const invalid = await runtime.call(agent, 'schedule_create', { prompt: '不能创建', after_seconds: 0 })
  assert.equal(invalid.code, 'invalid_rule')
  const other = await create(runtime)
  assert.deepEqual(await runtime.call(other.agent, 'schedule_list'), [], 'reminders stay in their owning session')
  await other.dispose(); await handle.dispose()
})

test('idle one-shot dispatches without another human message and does not repeat after resume', async t => {
  const { mount } = await fixture(t), runtime = await mount()
  const handle = await create(runtime), { agent } = handle
  await runtime.call(agent, 'schedule_create', { prompt: '独立一次提醒', after_seconds: 1 })
  await dispatch(runtime.ctx, agent); await agent.whenIdle(); await runtime.ctx.sessions.flush(agent.session)
  assert.equal(runtime.adapter.requests.length, 1)
  assert.deepEqual(await runtime.call(agent, 'schedule_list'), [])
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 0)
  const id = agent.session.id
  await handle.dispose(); await runtime.ctx.fiber.dispose()
  const replay = await mount()
  const resumed = await replay.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'offline-schedule', model: 'fixture' } })
  await replay.call(resumed.agent, 'schedule_list'); await resumed.agent.whenIdle()
  assert.equal(replay.adapter.requests.length, 0)
  assert.equal(resumed.agent.session.snapshotEvents().filter(event => event.type === 'schedule/change' && event.data.operation === 'dispatch').length, 1)
  await resumed.dispose()
})

test('a pending JSONL reminder survives a fresh runtime and dispatches once when its session resumes overdue', async t => {
  const { mount } = await fixture(t), first = await mount()
  const handle = await create(first), id = handle.agent.session.id
  await first.call(handle.agent, 'schedule_create', { prompt: '重启后提醒', after_seconds: 120 })
  await handle.dispose(); await first.ctx.fiber.dispose()
  const future = Date.now() + 121000
  t.mock.method(Date, 'now', () => future)
  const restarted = await mount()
  const resumed = await restarted.ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'offline-schedule', model: 'fixture' } })
  if (!resumed.agent.session.snapshotEvents().some(event => event.type === 'schedule/change' && event.data.operation === 'dispatch')) {
    await dispatch(restarted.ctx, resumed.agent)
  }
  await resumed.agent.whenIdle()
  assert.deepEqual(await restarted.call(resumed.agent, 'schedule_list'), [])
  assert.equal(restarted.adapter.requests.length, 1)
  await resumed.dispose()
})

test('profile updater preserves explicit user disable through actual tool mounting', async t => {
  const { mount } = await fixture(t, '- id: schedule\n  disabled: true\n')
  const runtime = await mount(), handle = await create(runtime)
  const names = (await runtime.ctx.systemPrompt.assemble({ agent: handle.agent, scope: handle.agent })).tools.map(tool => tool.name)
  assert.deepEqual(names.filter(name => name.startsWith('schedule_')), [])
  await handle.dispose()
})

test('cancelled reminders never enter the follow-up alongside a due reminder', async t => {
  const { mount } = await fixture(t), runtime = await mount(), handle = await create(runtime)
  const cancelled = await runtime.call(handle.agent, 'schedule_create', { prompt: '已取消，不得交付', after_seconds: 1 })
  assert.deepEqual(await runtime.call(handle.agent, 'schedule_delete', { id: cancelled.id }), { id: cancelled.id, deleted: true })
  await runtime.call(handle.agent, 'schedule_create', { prompt: '本次保留', after_seconds: 1 })
  await dispatch(runtime.ctx, handle.agent); await handle.agent.whenIdle()
  assert.equal(runtime.adapter.requests.length, 1)
  const followups = handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'schedule')
  assert.equal(followups.length, 1)
  assert.match(followups[0].data.content[0].text, /本次保留/)
  assert.doesNotMatch(followups[0].data.content[0].text, /已取消/)
  await handle.dispose()
})

test('scope permission denies still prevent reminder mutations after default activation', async t => {
  const { mount } = await fixture(t), runtime = await mount(), handle = await create(runtime)
  // Schedule definitions are agent-local; the official restrict() masks global
  // registrations only. Guards are the real scoped pre-dispatch denial seam.
  handle.agent.ctx.tools.guard(exec => ['schedule_create', 'schedule_delete'].includes(exec.name) ? '只读会话' : undefined)
  const denied = await runtime.ctx.agents.withInitiator(handle.agent, () => runtime.ctx.tools.execute({
    name: 'schedule_create', arguments: { prompt: '不允许创建', after_seconds: 120 },
    agent: handle.agent, callId: crypto.randomUUID(), signal: new AbortController().signal,
  }))
  assert.equal(denied.isError, true)
  assert.deepEqual(await runtime.call(handle.agent, 'schedule_list'), [])
  assert.equal(handle.agent.session.snapshotEvents().filter(event => event.type === 'schedule/change').length, 0)
  const other = await create(runtime)
  assert.equal((await runtime.call(other.agent, 'schedule_create', { prompt: '另一个授权会话', after_seconds: 120 })).kind, 'after')
  await other.dispose()
  await handle.dispose()
})
