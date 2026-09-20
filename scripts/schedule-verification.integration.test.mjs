import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { mountAgentLoopTestDependencies } from '../runtime/DSH/packages/test-support/agent-loop-testkit/lib/index.js'
import AgentLoop from '../runtime/DSH/packages/core/agent-loop/lib/index.js'
import JsonlPersistence from '../runtime/DSH/packages/session/session-persistence-jsonl/lib/index.js'
import * as schedule from '../runtime/DSH/packages/schedule/schedule/lib/index.js'
import { createToolResultMessage } from '../runtime/DSH/packages/llm/llm/lib/index.js'
import { createVerificationPolicy } from '../packages/verification-policy/lib/index.js'
import { scopeTarget } from '../runtime/DSH/packages/core/scope/lib/index.js'
import { foldCompletionReceipt } from '../packages/completion-receipt/lib/index.js'
const { apply } = await import(process.env.XIAOSHE_VERIFY_SOURCE === '1'
  ? '../src/plugins/verification-results.ts' : '../dist/plugins/verification-results.js')

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xs-schedule-proof-')), ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlPersistence, { root: directory, compression: 'none' })
  await ctx.plugin(schedule)
  ctx.provide('xiaosheVerificationPolicy', createVerificationPolicy())
  const generations = new Map()
  ctx.provide('xiaosheAgentReliability', { snapshot: agent => ({
    taskGeneration: agent.session.snapshotEvents().filter(event => event.type === 'xiaoshe/task-generation').at(-1)?.data.generation ?? 0,
    evidenceRevision: agent.session.snapshotEvents().length,
    callGeneration: id => generations.get(id),
  }) })
  apply(ctx)
  const handle = await ctx.agents.create({ sessionId: crypto.randomUUID() }), { agent } = handle, { session } = agent
  session.append('xiaoshe/task-generation', { version: 1, generation: 1, relation: 'new', triggerMessageId: 'task-1' })
  session.append('user/message', { id: 'task-1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '创建并验证提醒。' }] }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  let step = 0
  const appendResult = (event, result) => session.append('tool/result', { turn: 1, step,
    message: createToolResultMessage({ callId: event.data.callId, content: result.content, isError: result.isError }),
  }, { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
  const begin = (name, args) => {
    const event = session.append('tool/call', { turn: 1, step: ++step, callId: crypto.randomUUID(), name, arguments: JSON.stringify(args) })
    generations.set(event.data.callId, session.snapshotEvents().filter(event => event.type === 'xiaoshe/task-generation').at(-1).data.generation)
    return event
  }
  const call = async (name, args = {}) => {
    const event = begin(name, args)
    const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({ name, arguments: args,
      callId: event.data.callId, agent, signal: new AbortController().signal }))
    appendResult(event, result)
    assert.equal(result.isError, false, JSON.stringify(result))
    return { id: event.data.callId, value: result.value }
  }
  const synthetic = (name, args, value, event = begin(name, args)) => {
    appendResult(event, { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] })
    return event
  }
  return { ctx, agent, session, call, begin, synthetic, progress: () => ctx.xiaosheVerificationProgress.reconcile(agent) }
}

test('official cancel and independent empty list close functional proof without build/test/typecheck', async t => {
  const f = await fixture(t)
  const created = await f.call('schedule_create', { prompt: '两分钟提醒', after_seconds: 120 })
  await f.call('schedule_list')
  assert.equal(f.progress().status, 'verified')
  const removed = await f.call('schedule_delete', { id: created.value.id })
  assert.equal(removed.value.deleted, true)
  assert.deepEqual(f.progress().requiredGates, ['functional-probe'])
  assert.equal(f.progress().status, 'pending', 'delete success is not independent read-back')
  const list = await f.call('schedule_list')
  assert.deepEqual(list.value, [])
  assert.equal(f.progress().status, 'verified')
  const proof = f.session.snapshotEvents().find(event => event.type === 'verification/result' && event.data.mutationCallId === removed.id)
  assert.equal(proof.data.verifierCallId, list.id)
  assert.equal(proof.data.gate, 'functional-probe')
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(foldCompletionReceipt(f.session.snapshotEvents()).outcome, 'verified')
})

test('creating a future recurring record verifies registration only after exact independent list read', async t => {
  const f = await fixture(t)
  await f.call('schedule_create', { prompt: '定期观察', every_seconds: 3600 })
  assert.equal(f.progress().status, 'pending')
  await f.call('schedule_list')
  assert.equal(f.progress().status, 'verified')
  assert.equal(f.session.snapshotEvents().some(event => event.type === 'schedule/change' && event.data.operation === 'dispatch'), false)
  const proofs = f.session.snapshotEvents().filter(event => event.type === 'verification/result')
  assert.ok(proofs.every(event => !/delivered|executed/u.test(event.data.evidence)))
})

test('old, malformed, unrelated and error lists never certify a create', async t => {
  for (const mode of ['old', 'malformed', 'unrelated', 'wrong-prompt', 'wrong-time', 'uncertain']) await t.test(mode, async t => {
    const f = await fixture(t)
    const early = mode === 'old' ? f.begin('schedule_list', {}) : undefined
    const created = await f.call('schedule_create', { prompt: '目标提醒', after_seconds: 120 })
    const value = mode === 'malformed' ? { success: true, reminders: [created.value] }
      : mode === 'unrelated' ? []
      : mode === 'wrong-prompt' ? [{ ...created.value, prompt: '别的提醒' }]
      : mode === 'wrong-time' ? [{ ...created.value, scheduledAt: '2099-01-01T00:00:00.000Z' }]
      : mode === 'uncertain' ? { code: 'persistence_uncertain', message: 'uncertain', operation: 'list' }
      : [created.value]
    f.synthetic('schedule_list', {}, value, early)
    assert.equal(f.progress().status, 'pending')
  })
})

test('a different task generation cannot supply reminder proof for the earlier task', async t => {
  const f = await fixture(t)
  const created = await f.call('schedule_create', { prompt: '旧任务', after_seconds: 120 })
  f.session.append('xiaoshe/task-generation', { version: 1, generation: 2, relation: 'new', triggerMessageId: 'task-2' })
  f.session.append('user/message', { id: 'task-2', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '查询我的其他提醒。' }] }, { surfaceOp: 'append' })
  await f.call('schedule_list'); f.progress()
  assert.equal(f.session.snapshotEvents().some(event => event.type === 'verification/result' && event.data.mutationCallId === created.id), false)
})

test('delete cannot borrow a different id result or a list that still contains the target', async t => {
  for (const mode of ['wrong-id', 'still-present', 'uncertain', 'no-change-event']) await t.test(mode, async t => {
    const f = await fixture(t), created = await f.call('schedule_create', { prompt: '目标', after_seconds: 120 })
    await f.call('schedule_list'); f.progress()
    const deletion = f.synthetic('schedule_delete', { id: created.value.id }, mode === 'wrong-id'
      ? { id: 'schedule-other', deleted: true }
      : mode === 'uncertain' ? { code: 'persistence_uncertain', operation: 'delete', id: created.value.id }
      : { id: created.value.id, deleted: true })
    f.synthetic('schedule_list', {}, mode === 'still-present' ? [created.value] : [])
    f.progress()
    assert.equal(f.session.snapshotEvents().some(event => event.type === 'verification/result' && event.data.mutationCallId === deletion.data.callId), false)
  })
})

test('absolute targets and idempotent missing-id deletion require the same real list proof', async t => {
  const f = await fixture(t)
  const created = await f.call('schedule_create', { prompt: '绝对时间', at: '2099-01-01T09:00:00+08:00' })
  assert.equal(created.value.scheduledAt, '2099-01-01T01:00:00.000Z')
  await f.call('schedule_list'); assert.equal(f.progress().status, 'verified')
  await f.call('schedule_delete', { id: 'schedule-999' })
  assert.equal(f.progress().status, 'pending')
  await f.call('schedule_list'); assert.equal(f.progress().status, 'verified')
})

test('forged create success plus a matching list cannot replace a real canonical mutation event', async t => {
  const f = await fixture(t)
  const value = { id: 'schedule-1', kind: 'after', prompt: '伪造', afterSeconds: 120,
    scheduledAt: '2099-01-01T01:00:00.000Z', state: 'scheduled', deliveryMode: 'session-local' }
  f.synthetic('schedule_create', { prompt: '伪造', after_seconds: 120 }, value)
  f.synthetic('schedule_list', {}, [value])
  assert.equal(f.progress().status, 'pending')
})

test('another actual session cannot close the first session reminder debt', async t => {
  const first = await fixture(t), other = await fixture(t)
  await first.call('schedule_create', { prompt: '仅原会话', after_seconds: 120 })
  await other.call('schedule_create', { prompt: '仅原会话', after_seconds: 120 })
  await other.call('schedule_list')
  assert.equal(other.progress().status, 'verified')
  assert.equal(first.progress().status, 'pending')
})

test('missing reminder proof asks for the available schedule list instead of an impossible build', async t => {
  const f = await fixture(t), corrections = []
  t.mock.method(f.agent, 'steer', message => corrections.push(message))
  await f.call('schedule_create', { prompt: '需要回读', after_seconds: 120 })
  await f.ctx.serial(scopeTarget(f.agent, f.agent), 'agent/turn-stopping', {
    agent: f.agent, turn: 1, signal: new AbortController().signal,
  })
  assert.equal(corrections.length, 1)
  assert.match(corrections[0].content[0].text, /schedule_list/)
  assert.doesNotMatch(corrections[0].content[0].text, /本步没有匹配的独立验证工具/)
  await f.call('schedule_list')
  await f.ctx.serial(scopeTarget(f.agent, f.agent), 'agent/turn-stopping', {
    agent: f.agent, turn: 1, signal: new AbortController().signal,
  })
  assert.equal(corrections.length, 1, 'independent list proof stops further correction rounds')
})
