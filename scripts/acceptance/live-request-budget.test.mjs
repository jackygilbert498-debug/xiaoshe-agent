import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { LlmRuntime, LlmAdapter } from '../../runtime/DSH/packages/llm/llm/lib/index.js'
import { apply, createBudgetGate, installBudgetGate, readBudgetLedger } from './live-request-budget.mjs'

const runChild = promisify(execFile)
const policy = () => ({ mode: 'normal', maxRetries: 0 })
const request = changes => ({ provider: 'offline', model: 'fixture', sessionId: 'acceptance-session',
  messages: [], maxTokens: 2048, ...changes })
const consume = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const complete = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }

async function fixture(t, changes = {}, dependencies = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'xs-request-budget-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = { ledgerDirectory: join(root, 'budget'), runId: 'offline-test', maxRequests: 8,
    provider: 'offline', model: 'fixture', sessionIds: ['acceptance-session'], ...changes }
  const gate = createBudgetGate(config, { retryPolicy: policy, ...dependencies })
  await gate.ready
  return { root, config, gate }
}

test('zero mode mounts twice with no provider and distinguishes no model from unknown usage', async t => {
  const { config, gate } = await fixture(t, { maxRequests: 0, sessionIds: [] }, { retryPolicy: () => { throw Error('must not inspect provider') } })
  const first = await gate.snapshot()
  assert.equal(first.mountCount, 1)
  assert.equal(first.mounts[0].runId, config.runId)
  assert.equal(first.mounts[0].pid, process.pid)
  assert.equal(new Date(first.mounts[0].at).toISOString(), first.mounts[0].at)
  assert.equal(first.attemptedRequests, 0)
  assert.deepEqual(first.usage, { status: 'no_model', unknownUsageRequests: 0, knownUsage: null, totalUsage: null })
  const second = createBudgetGate(config)
  await second.ready
  assert.equal((await second.snapshot()).mountCount, 2)
  let called = false
  await assert.rejects(consume(second.stream(request(), () => { called = true; return complete() })), /no_model/)
  assert.equal(called, false)
  const report = await readBudgetLedger(config.ledgerDirectory)
  assert.equal(report.attemptedRequests, 1)
  assert.equal(report.reservedRequests, 0)
  assert.equal(report.usage.status, 'no_model')
})

test('all concurrent callers share eight durable slots, and restart does not refill them', async t => {
  const { gate, config } = await fixture(t)
  let dispatched = 0
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => consume(gate.stream(request(), () => { dispatched++; return complete() }))))
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 8)
  assert.equal(dispatched, 8)
  const reopened = createBudgetGate(config, { retryPolicy: policy })
  await reopened.ready
  await assert.rejects(consume(reopened.stream(request(), complete)), /budget_exhausted/)
  const report = await reopened.snapshot()
  assert.equal(report.reservedRequests, 8)
  assert.equal(report.deniedRequests, 13)
  assert.equal(report.usage.status, 'unknown')
  assert.equal(report.usage.totalUsage, null)
  assert.equal(report.requests[0].outcome, 'finished')
})

test('sixteen-slot live journeys preserve old eight-slot manifests and cannot refill on restart', async t => {
  const { gate, config } = await fixture(t, { maxRequests: 16 })
  let dispatched = 0
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => consume(gate.stream(request(), () => {
    dispatched++; return complete()
  }))))
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 16)
  assert.equal(dispatched, 16)
  const report = await readBudgetLedger(config.ledgerDirectory)
  assert.equal(report.maxRequests, 16)
  assert.equal(report.reservedRequests, 16)
  assert.equal(report.remainingRequests, 0)
  const reopened = createBudgetGate(config, { retryPolicy: policy })
  await reopened.ready
  await assert.rejects(consume(reopened.stream(request(), complete)), /budget_exhausted/u)
  const changed = createBudgetGate({ ...config, maxRequests: 8 }, { retryPolicy: policy })
  await assert.rejects(changed.ready, /identity_mismatch/u)
  for (const maxRequests of [9, 17, Infinity]) {
    const invalid = createBudgetGate({ ...config, maxRequests }, { retryPolicy: policy })
    await assert.rejects(invalid.ready, /invalid_config/u)
  }
})

test('a wider supported maximum does not accept a ninth reservation inside an eight-slot manifest', async t => {
  const { config } = await fixture(t)
  await fs.writeFile(join(config.ledgerDirectory, 'request-9.json'), '{}\n', { flag: 'wx', mode: 0o600 })
  await assert.rejects(readBudgetLedger(config.ledgerDirectory), /invalid_ledger/u)
})

test('opt-in material journeys account for all 64 slots and never refill them', async t => {
  const { gate, config } = await fixture(t, { maxRequests: 64 })
  let dispatched = 0
  const results = await Promise.allSettled(Array.from({ length: 66 }, () => consume(gate.stream(request(), async function* () {
    dispatched++
    yield { type: 'usage', usage: { inputTokens: 3, cacheReadTokens: 2, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }))))
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 64)
  assert.equal(dispatched, 64)
  const report = await readBudgetLedger(config.ledgerDirectory)
  assert.equal(report.reservedRequests, 64)
  assert.equal(report.deniedRequests, 2)
  assert.equal(report.requests.at(-1).ordinal, 64)
  assert.equal(report.usage.totalUsage.inputTokens, 192)
  const reopened = createBudgetGate(config, { retryPolicy: policy })
  await reopened.ready
  await assert.rejects(consume(reopened.stream(request(), complete)), /budget_exhausted/u)
  await fs.writeFile(join(config.ledgerDirectory, 'request-65.json'), '{}', { flag: 'wx' })
  await assert.rejects(readBudgetLedger(config.ledgerDirectory), /invalid_ledger/u)
})

test('whitelists reject missing/foreign identities, auxiliary calls and absent or oversized output caps before dispatch', async t => {
  const { gate } = await fixture(t)
  const invalid = [{ provider: 'other' }, { model: 'other' }, { sessionId: 'other' }, { sessionId: undefined },
    { purpose: 'session-title' }, { purpose: 'compaction' }, { maxTokens: undefined }, { maxTokens: 2049 }, { maxTokens: 0 }, { maxTokens: NaN }]
  let dispatched = 0
  for (const changes of invalid) await assert.rejects(consume(gate.stream(request(changes), () => { dispatched++; return complete() })))
  assert.equal(dispatched, 0)
  assert.equal((await gate.snapshot()).reservedRequests, 0)
})

test('provider default, nonzero and always retry policies fail closed, and a later route change is rechecked', async t => {
  for (const policyValue of [undefined, { mode: 'normal', maxRetries: 1 }, { mode: 'always' }]) {
    const root = await fs.mkdtemp(join(tmpdir(), 'xs-invalid-retry-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const gate = createBudgetGate({ ledgerDirectory: join(root, 'budget'), runId: 'bad-retry', maxRequests: 8,
      provider: 'offline', model: 'fixture', sessionIds: ['acceptance-session'] }, { retryPolicy: () => policyValue })
    await assert.rejects(gate.ready, /retry_policy_not_zero/)
    await assert.rejects(consume(gate.stream(request(), complete)), /retry_policy_not_zero/)
  }
  let current = policy()
  const { gate } = await fixture(t, {}, { retryPolicy: () => current })
  current = { mode: 'normal', maxRetries: 4 }
  await assert.rejects(consume(gate.stream(request(), complete)), /retry_policy_not_zero/)
  assert.equal((await gate.snapshot()).reservedRequests, 0)
})

test('agent/request caps the resolved proposal and rejects foreign sessions', async t => {
  const { gate } = await fixture(t)
  const agent = { session: { id: 'acceptance-session' } }
  assert.equal((await gate.requestConfig(agent, async () => request({ maxTokens: 99999 }))).maxTokens, 2048)
  assert.equal((await gate.requestConfig(agent, async () => request({ maxTokens: 17 }))).maxTokens, 17)
  await assert.rejects(gate.requestConfig({ session: { id: 'outside' } }, async () => request()), /route_not_allowed/)
})

test('transport errors, cancelled iterators and malformed usage do not refund reservations or invent zero usage', async t => {
  const { gate } = await fixture(t)
  await assert.rejects(consume(gate.stream(request(), async function* () { throw Error('offline transport') })), /offline transport/)
  const iterator = gate.stream(request(), async function* () { yield { type: 'text-delta', index: 0, text: 'fixture' }; yield { type: 'finish', reason: { kind: 'stop' } } })[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return()
  await consume(gate.stream(request(), async function* () {
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: NaN } }
    yield* complete()
  }))
  const report = await gate.snapshot()
  assert.equal(report.reservedRequests, 3)
  assert.equal(report.usage.unknownUsageRequests, 3)
  assert.equal(report.usage.totalUsage, null)
  assert.equal(report.requests[1].outcome, 'interrupted')
})

test('usage is the latest cumulative observation, preserving missing optional usage fields', async t => {
  const { gate } = await fixture(t)
  await consume(gate.stream(request(), async function* () {
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 30 } }
    yield* complete()
  }))
  const report = await gate.snapshot()
  assert.equal(report.usage.status, 'reported')
  assert.equal(report.usage.knownUsage.inputTokens, 10)
  assert.equal(report.usage.knownUsage.outputTokens, 7)
  assert.equal(report.requests[0].usage.cacheWriteTokens, undefined)
  assert.equal(report.usage.knownUsage.cacheWriteTokens, null)
  assert.equal(report.usage.totalUsage.cacheWriteTokens, null)
  assert.equal(report.monetaryHardCap, false)
})

test('partial reservation write consumes the slot without sending, and process restart cannot reuse it', async t => {
  let injected = false
  const io = { ...fs, async open(path, ...args) {
    const file = await fs.open(path, ...args)
    if (String(path).endsWith('request-1.json') && !injected) {
      injected = true
      return { writeFile: async () => { throw Object.assign(Error('offline disk fault'), { code: 'EIO' }) }, sync: () => file.sync(), close: () => file.close() }
    }
    return file
  } }
  const { gate, config } = await fixture(t, {}, { io })
  let sent = false
  await assert.rejects(consume(gate.stream(request(), () => { sent = true; return complete() })), /ledger_unavailable/)
  assert.equal(sent, false)
  await assert.rejects(consume(gate.stream(request(), complete)), /ledger_unavailable/)
  const reopened = createBudgetGate(config, { retryPolicy: policy })
  await reopened.ready
  await consume(reopened.stream(request(), complete))
  const report = await reopened.snapshot()
  assert.equal(report.reservedRequests, 2)
  assert.equal(report.requests[0].usage, null)
})

test('receipt persistence failure latches closed and survives restart as consumed, unknown usage', async t => {
  const io = { ...fs, async open(path, ...args) {
    if (String(path).endsWith('receipt-1.json')) throw Object.assign(Error('offline receipt fault'), { code: 'EIO' })
    return fs.open(path, ...args)
  } }
  const { gate, config } = await fixture(t, {}, { io })
  await assert.rejects(consume(gate.stream(request(), complete)), /ledger_unavailable/)
  await assert.rejects(consume(gate.stream(request(), complete)), /ledger_unavailable/)
  assert.equal((await readBudgetLedger(config.ledgerDirectory)).reservedRequests, 1)
  const reopened = createBudgetGate(config, { retryPolicy: policy }); await reopened.ready
  assert.equal((await reopened.snapshot()).remainingRequests, 7)
})

test('invalid identity or corrupt manifest never reinitializes the budget', async t => {
  const { gate, config } = await fixture(t)
  await consume(gate.stream(request(), complete))
  const wrong = createBudgetGate({ ...config, runId: 'new-run-is-not-a-refill' }, { retryPolicy: policy })
  await assert.rejects(wrong.ready, /identity_mismatch/)
  // This is fault injection in an isolated test fixture, not a product edit.
  await fs.writeFile(join(config.ledgerDirectory, 'manifest.json'), '{')
  const corrupt = createBudgetGate(config, { retryPolicy: policy })
  await assert.rejects(corrupt.ready, /ledger_unavailable/)
  assert.equal(await fs.readFile(join(config.ledgerDirectory, 'manifest.json'), 'utf8'), '{')
})

test('independent reader fails closed for corrupt, foreign, PID-mismatched or malformed mount observations', async t => {
  const { gate, config } = await fixture(t, { maxRequests: 0, sessionIds: [] })
  const report = await gate.snapshot()
  const file = join(config.ledgerDirectory, report.mounts[0].file)
  const valid = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const invalid of ['{', JSON.stringify({ ...valid, runId: 'foreign' }), JSON.stringify({ ...valid, pid: process.pid + 1 }),
    JSON.stringify({ ...valid, at: 'today' }), JSON.stringify({ ...valid, secret: 'not-recorded-by-gate' })]) {
    await fs.writeFile(file, invalid)
    await assert.rejects(readBudgetLedger(config.ledgerDirectory), /invalid_mount_record/)
  }
})

test('request route and token cap cannot change while reservation persistence is pending', async t => {
  let entered
  let release
  const held = new Promise(resolve => { entered = resolve })
  const resume = new Promise(resolve => { release = resolve })
  const io = { ...fs, async open(path, ...args) {
    if (String(path).endsWith('request-1.json')) { entered(); await resume }
    return fs.open(path, ...args)
  } }
  const { gate } = await fixture(t, {}, { io })
  const options = request()
  let sentMax
  const pending = consume(gate.stream(options, () => { sentMax = options.maxTokens; return complete() }))
  await held
  assert.throws(() => { options.maxTokens = 99999 }, TypeError)
  assert.throws(() => { options.provider = 'outside' }, TypeError)
  release()
  await pending
  assert.equal(sentMax, 2048)
  const getterRequest = { ...request(), get maxTokens() { return 2048 } }
  await assert.rejects(consume(gate.stream(getterRequest, complete)), /invalid_request_object/)
})

test('mount publication failure leaves no completed mount and a closed gate', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'xs-mount-fault-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = { ledgerDirectory: join(root, 'budget'), runId: 'mount-fault', maxRequests: 0,
    provider: 'disabled', model: 'disabled', sessionIds: [] }
  const io = { ...fs, async rename() { throw Object.assign(Error('offline rename fault'), { code: 'EIO' }) } }
  const gate = createBudgetGate(config, { io })
  await assert.rejects(gate.ready, /ledger_unavailable/)
  await assert.rejects(consume(gate.stream(request(), complete)), /ledger_unavailable/)
  const report = await readBudgetLedger(config.ledgerDirectory)
  assert.equal(report.mounted, false)
  assert.equal(report.attemptedRequests, 0)
})

test('provider output-cap finish is recorded as limited, not successful task completion', async t => {
  const { gate } = await fixture(t)
  await consume(gate.stream(request(), async function* () { yield { type: 'finish', reason: { kind: 'max-tokens' } } }))
  assert.equal((await gate.snapshot()).requests[0].outcome, 'output_limit')
})

class OfflineAdapter extends LlmAdapter {
  calls = 0
  providerRetryPolicy() { return { ...policy(), initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, retryableCodes: ['TRANSPORT'] } }
  async *stream() { this.calls++; yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }; yield* complete() }
}

test('actual Cordis hook caps agent requests and catches direct, prepared and auxiliary LlmRuntime calls', async t => {
  const { config } = await fixture(t)
  const ctx = new Context(); t.after(() => ctx.fiber.dispose())
  new LlmRuntime(ctx)
  const adapter = new OfflineAdapter(); ctx.llm.registerAdapter(['offline'], adapter)
  const gate = installBudgetGate(ctx, config); await gate.ready
  const limited = await ctx.waterfall('agent/request', { agent: { session: { id: 'acceptance-session' } } }, async () => ({ provider: 'offline', model: 'fixture', maxTokens: 5000 }))
  assert.equal(limited.maxTokens, 2048)
  await consume(ctx.llm.stream(request()))
  const prepared = await ctx.llm.prepareCall({ provider: 'offline', model: 'fixture', maxTokens: 2048 })
  await consume(prepared.stream(request()))
  await assert.rejects(consume(ctx.llm.stream(request({ purpose: 'session-title' }))), /route_not_allowed/)
  assert.equal(adapter.calls, 2)
  assert.equal((await gate.snapshot()).reservedRequests, 2)
})

test('real Cordis zero-mode plugin works with no registered adapters and initialization failure leaves a rejecting hook', async t => {
  const { config } = await fixture(t, { maxRequests: 0, sessionIds: [] })
  const ctx = new Context(); t.after(() => ctx.fiber.dispose()); new LlmRuntime(ctx)
  await ctx.plugin({ name: 'budget-offline-plugin', inject: ['llm'], apply }, config)
  await assert.rejects(consume(ctx.llm.stream(request())), /no_model/)
  assert.equal((await readBudgetLedger(config.ledgerDirectory)).mountCount, 2)
  const broken = new Context(); t.after(() => broken.fiber.dispose()); new LlmRuntime(broken)
  installBudgetGate(broken, { ...config, maxRequests: 9 })
  await assert.rejects(consume(broken.llm.stream(request())), /invalid_config/)
})

test('real child exit after reservation keeps unknown consumed slot; concurrent child processes cannot exceed eight', async t => {
  const { config } = await fixture(t)
  const moduleUrl = pathToFileURL(join(import.meta.dirname, 'live-request-budget.mjs')).href
  const common = `import {createBudgetGate} from ${JSON.stringify(moduleUrl)}; const gate=createBudgetGate(${JSON.stringify(config)}, {retryPolicy:()=>({mode:'normal',maxRetries:0})}); await gate.ready; const req=${JSON.stringify(request())};`
  await runChild(process.execPath, ['--input-type=module', '-e', `${common} for await (const x of gate.stream(req, async function*(){process.exit(0)})) {}`], { env: { PATH: process.env.PATH } })
  const afterCrash = await readBudgetLedger(config.ledgerDirectory)
  assert.equal(afterCrash.reservedRequests, 1)
  assert.equal(afterCrash.requests[0].usage, null)
  const attempts = `${common} await Promise.allSettled(Array.from({length:7}, async()=>{for await(const x of gate.stream(req, async function*(){yield {type:'finish',reason:{kind:'stop'}}})) {}}));`
  await Promise.all([1, 2, 3].map(() => runChild(process.execPath, ['--input-type=module', '-e', attempts], { env: { PATH: process.env.PATH } })))
  const report = await readBudgetLedger(config.ledgerDirectory)
  assert.equal(report.reservedRequests, 8)
  assert.equal(report.remainingRequests, 0)
  assert.equal(report.deniedRequests, 14)
})
