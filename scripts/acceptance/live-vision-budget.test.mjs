import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, chmod, mkdir, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { LlmRuntime, resolveRetryPolicy } from '../../runtime/DSH/packages/llm/llm/lib/index.js'
import { ToolRuntime } from '../../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt } from '../../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { installVisionBudget, visionBudgetConfig, VISION_CONNECTION, inject } from './live-vision-budget.mjs'
import { readBudgetLedger } from './live-request-budget.mjs'

const WRAPPER = 'deepseek-modlens', OFFICIAL = 'deepseek-official', MODEL = 'deepseek-v4-flash'
const consume = async stream => { const result = []; for await (const chunk of stream) result.push(chunk); return result }
const request = (config, changes = {}) => ({ provider: WRAPPER, model: MODEL, sessionId: config.sessionId,
  maxTokens: 2048, messages: [], ...changes })
const nested = options => ({ ...options, provider: OFFICIAL })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const wireResponse = () => new Response([
  { id: 'offline-vision-response', choices: [{ index: 0, delta: { role: 'assistant', content: 'synthetic output' }, finish_reason: null }] },
  { id: 'offline-vision-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
].map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })

async function fixture(t, options = {}) {
  const runId = randomUUID(), root = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  await mkdir(root, { mode: 0o700 })
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { acceptanceRoot: root, runId, sessionId: `xiaoshe-vision-${runId}` }
  const ctx = new Context(); new LlmRuntime(ctx)
  t.after(() => ctx.fiber.dispose())
  let wireCalls = 0, credentialCalls = 0
  const wire = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    wireCalls++
    // Never retain headers: even the offline credential seam is kept out of
    // receipts and test diagnostics. This replaces fetch, not a real request.
    wire.push({ url, body: JSON.parse(init.body) })
    return options.fetch ? options.fetch(url, init) : wireResponse()
  })
  const gate = installVisionBudget(ctx, config, { readCredential: async () => {
    credentialCalls++
    if (options.credentialError) throw new Error('do-not-leak-fixture-credential')
    return 'offline-only-credential'
  } })
  const ledgerDirectory = join(root, 'budget')
  const wrap = (stream = async function* (input) { await delay(1); yield* ctx.llm.stream(nested(input)) }, retry = 0) => ctx.llm.registerAdapter([WRAPPER], {
    providerInfo: provider => ({ id: provider, name: 'Offline wrapper' }),
    providerRetryPolicy: () => resolveRetryPolicy({ mode: 'normal', maxRetries: retry }, 'offline'),
    resolveModel: async (_provider, model) => ({ ...await ctx.llm.resolveModelInfo(OFFICIAL, model), provider: WRAPPER }), stream,
  })
  await gate.ready
  return { root, ctx, config, gate, wrap, ledgerDirectory, wire,
    wireCalls: () => wireCalls, credentialCalls: () => credentialCalls }
}

test('isolated identity is closed to extra config, daily roots, accessors and symlinks', async t => {
  const f = await fixture(t)
  assert.deepEqual(inject, ['llm'])
  for (const changes of [{ sessionId: 'daily' }, { runId: 'not-uuid' }, { maxRequests: 100 },
    { baseURL: 'https://untrusted.invalid' }, { apiKey: 'not-allowed' }, { acceptanceRoot: '/Users/zfy/.dsh' }]) {
    assert.throws(() => visionBudgetConfig({ ...f.config, ...changes }), /invalid_isolated_identity/)
  }
  const accessor = { ...f.config }
  Object.defineProperty(accessor, 'sessionId', { enumerable: true, get() { throw new Error('must not evaluate getter') } })
  assert.throws(() => visionBudgetConfig(accessor), /invalid_isolated_identity/)
  await chmod(f.root, 0o755)
  assert.throws(() => visionBudgetConfig(f.config), /unsafe_acceptance_root/)
  await chmod(f.root, 0o700)
  const linkRun = randomUUID(), link = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${linkRun}`)
  await symlink(f.root, link); t.after(() => rm(link))
  assert.throws(() => visionBudgetConfig({ acceptanceRoot: link, runId: linkRun, sessionId: `xiaoshe-vision-${linkRun}` }), /unsafe_acceptance_root/)
  assert.equal(f.wireCalls(), 0)
})

test('real official adapter registers with immutable origin/off/2048/retry0 without reading credentials', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.ctx.llm.listProviders().map(p => p.id), [OFFICIAL])
  const info = await f.ctx.llm.resolveModelInfo(OFFICIAL, MODEL)
  assert.deepEqual(info.reasoning.efforts.map(v => v.id), ['off'])
  assert.equal(info.defaultMaxTokens, 2048)
  assert.equal(f.ctx.llm.providerRetryPolicy(OFFICIAL).maxRetries, 0)
  assert.equal(VISION_CONNECTION.baseURL, 'https://api.deepseek.com')
  assert.throws(() => { VISION_CONNECTION.baseURL = 'https://different.invalid' }, TypeError)
  assert.throws(() => { VISION_CONNECTION.defaults.thinking = 'enabled' }, TypeError)
  assert.equal(f.credentialCalls(), 0)
  assert.equal(f.wireCalls(), 0)
  assert.equal((await f.gate.snapshot()).mountCount, 1)
})

test('awaited wrapper reaches the real official serializer once; wrapper does not consume a second API slot', async t => {
  const f = await fixture(t); f.wrap()
  const chunks = await consume(f.ctx.llm.stream(request(f.config)))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(f.wireCalls(), 1)
  assert.equal(f.wire[0].url, 'https://api.deepseek.com/chat/completions')
  assert.equal(f.wire[0].body.max_tokens, 2048)
  assert.deepEqual(f.wire[0].body.thinking, { type: 'disabled' })
  assert.equal(f.wire[0].body.model, MODEL)
  const ledger = await readBudgetLedger(f.ledgerDirectory)
  assert.equal(ledger.reservedRequests, 1)
  assert.equal(ledger.deniedRequests, 0)
  assert.equal(ledger.requests[0].outcome, 'finished')
  assert.equal(ledger.usage.totalUsage.inputTokens, 3)
  const files = await readdir(f.ledgerDirectory)
  assert.doesNotMatch((await Promise.all(files.map(file => readFile(join(f.ledgerDirectory, file), 'utf8')))).join(''), /offline-only-credential|synthetic output/)
})

test('direct/prepared official, foreign routes, auxiliary purpose and mismatched caps cannot bypass the token', async t => {
  const f = await fixture(t); f.wrap()
  for (const change of [{ provider: OFFICIAL }, { provider: 'fallback' }, { sessionId: 'foreign' },
    { model: 'other-model' }, { purpose: 'session-title' }, { purpose: 'compaction' },
    { maxTokens: 2049 }, { maxTokens: NaN }, { reasoningEffort: 'high' }]) {
    await assert.rejects(consume(f.ctx.llm.stream(request(f.config, change))), /vision-budget:/)
  }
  const prepared = await f.ctx.llm.prepareCall({ provider: OFFICIAL, model: MODEL, maxTokens: 2048 })
  await assert.rejects(consume(prepared.stream({ ...request(f.config, { provider: OFFICIAL }), ...prepared.config })), /missing_or_consumed_causal_permit/)
  assert.equal(f.wireCalls(), 0)
  assert.equal((await f.gate.snapshot()).reservedRequests, 0)
})

test('agent request proposal is wrapper-only, capped before preparation, and preserves all non-route fields', async t => {
  const f = await fixture(t); f.wrap()
  const proposal = { provider: WRAPPER, model: MODEL, maxTokens: 9000, temperature: 0.2 }
  const config = await f.ctx.waterfall('agent/request', { agent: { session: { id: f.config.sessionId } } }, async () => proposal)
  assert.equal(config.maxTokens, 2048); assert.equal(config.reasoningEffort, 'off'); assert.equal(config.temperature, 0.2)
  assert.equal(proposal.maxTokens, 9000)
  await assert.rejects(f.ctx.waterfall('agent/request', { agent: { session: { id: 'foreign' } } }, async () => proposal), /route_not_allowed/)
  await assert.rejects(f.ctx.waterfall('agent/request', { agent: { session: { id: f.config.sessionId } } }, async () => ({ ...proposal, provider: OFFICIAL })), /route_not_allowed/)
  assert.equal(f.wireCalls(), 0)
})

test('two concurrent wrappers in the same session have separate one-use permits', async t => {
  const f = await fixture(t); f.wrap()
  const [a, b] = await Promise.all([consume(f.ctx.llm.stream(request(f.config))), consume(f.ctx.llm.stream(request(f.config)))])
  assert.equal(a.at(-1).reason.kind, 'stop'); assert.equal(b.at(-1).reason.kind, 'stop')
  const ledger = await f.gate.snapshot()
  assert.equal(ledger.reservedRequests, 2); assert.equal(ledger.deniedRequests, 0); assert.equal(f.wireCalls(), 2)
})

test('one wrapper cannot spend its permit twice or mint a nested wrapper permit', async t => {
  const f = await fixture(t)
  let recurse = false
  f.wrap(async function* (input) {
    yield* f.ctx.llm.stream(nested(input))
    try { yield* f.ctx.llm.stream(recurse ? input : nested(input)) } catch { yield { type: 'finish', reason: { kind: 'stop' } } }
  })
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config))), /missing_or_consumed_causal_permit/)
  recurse = true
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config))), /route_not_allowed/)
  assert.equal(f.wireCalls(), 2)
  assert.equal((await f.gate.snapshot()).reservedRequests, 2)
})

test('racing nested streams consume the token before the first disk await', async t => {
  const f = await fixture(t)
  f.wrap(async function* (input) {
    const first = consume(f.ctx.llm.stream(nested(input)))
    const second = consume(f.ctx.llm.stream(nested(input)))
    await Promise.allSettled([first, second])
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config))), /missing_or_consumed_causal_permit|causal_permit_revoked/)
  assert.ok(f.wireCalls() <= 1)
  assert.ok((await f.gate.snapshot()).reservedRequests <= 1)
})

test('wrapper cannot fabricate output without upstream or replace upstream failure with success', async t => {
  const f = await fixture(t, { credentialError: true })
  let mode = 'none'
  f.wrap(async function* (input) {
    if (mode === 'swallow') for await (const _ of f.ctx.llm.stream(nested(input))) { /* Incorrect fallback. */ }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config))), /wrapper_changed_upstream_output/)
  mode = 'swallow'
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config))), /wrapper_changed_upstream_output/)
  const ledger = await f.gate.snapshot()
  assert.equal(ledger.reservedRequests, 1); assert.equal(ledger.requests[0].outcome, 'failed')
  assert.equal(ledger.usage.status, 'unknown'); assert.equal(f.wireCalls(), 0)
})

test('nested route, signal, cap or purpose changes are rejected even with an active wrapper', async t => {
  const f = await fixture(t)
  let change
  f.wrap(async function* (input) { yield* f.ctx.llm.stream({ ...nested(input), ...change }) })
  for (change of [{ sessionId: 'foreign' }, { maxTokens: 100 }, { purpose: 'session-title' },
    { signal: new AbortController().signal }, { model: 'other' }, { provider: 'fallback' }]) {
    await assert.rejects(consume(f.ctx.llm.stream(request(f.config))), /vision-budget:/)
  }
  assert.equal(f.wireCalls(), 0); assert.equal((await f.gate.snapshot()).reservedRequests, 0)
})

test('consumer close revokes permit inherited by a late async child; cancellation is not refunded', async t => {
  const f = await fixture(t), release = deferred(); let late
  f.wrap(async function* (input) {
    late = release.promise.then(() => consume(f.ctx.llm.stream(nested(input))))
    // Attach the observer immediately so a rejected delayed child cannot become
    // an unhandled rejection while the test is still closing the outer stream.
    late.catch(() => {})
    yield* f.ctx.llm.stream(nested(input))
  })
  const stream = f.ctx.llm.stream(request(f.config))[Symbol.asyncIterator]()
  await stream.next(); await stream.return()
  release.resolve()
  await assert.rejects(late, /missing_or_consumed_causal_permit/)
  assert.equal(f.wireCalls(), 1)
  const ledger = await f.gate.snapshot()
  assert.equal(ledger.reservedRequests, 1); assert.equal(ledger.requests[0].outcome, 'interrupted')
  assert.equal(ledger.usage.status, 'unknown')
})

test('missing/changed retry policies, already-aborted streams and scalar accessors fail before dispatch', async t => {
  const f = await fixture(t)
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config))), /retry_policy_not_zero/)
  const dispose = f.wrap(undefined, 1)
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config))), /retry_policy_not_zero/)
  dispose(); f.wrap()
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config, { signal: AbortSignal.abort() }))), /already_aborted/)
  const input = request(f.config)
  Object.defineProperty(input, 'provider', { enumerable: true, get() { throw new Error('getter must not run') } })
  await assert.rejects(consume(f.ctx.llm.stream(input)), /invalid_request_object/)
  assert.equal(f.wireCalls(), 0)
})

test('a concurrently suspended wrapper does not lend its permit to an unrelated direct official caller', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  f.wrap(async function* (input) { entered.resolve(); await release.promise; yield* f.ctx.llm.stream(nested(input)) })
  const running = consume(f.ctx.llm.stream(request(f.config)))
  await entered.promise
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config, { provider: OFFICIAL }))), /missing_or_consumed_causal_permit/)
  release.resolve()
  assert.equal((await running).at(-1).reason.kind, 'stop')
  assert.equal(f.wireCalls(), 1)
})

test('empty wrapper success and consumer throw cannot mint an upstream call during cleanup', async t => {
  const f = await fixture(t); let cleanup = false
  f.wrap(async function* (input) {
    if (!cleanup) return
    try { yield* f.ctx.llm.stream(nested(input)) }
    finally { await consume(f.ctx.llm.stream(nested(input))) }
  })
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config))), /wrapper_without_completed_upstream/)
  cleanup = true
  const stream = f.ctx.llm.stream(request(f.config))[Symbol.asyncIterator]()
  await stream.next()
  await assert.rejects(stream.throw(new Error('offline-consumer-stop')), /missing_or_consumed_causal_permit|offline-consumer-stop/)
  assert.equal(f.wireCalls(), 1)
  assert.equal((await f.gate.snapshot()).reservedRequests, 1)
})

test('failed ledger initialization leaves rejecting hooks installed instead of dispatching unguarded', async t => {
  const f = await fixture(t)
  const ctx = new Context(); new LlmRuntime(ctx); t.after(() => ctx.fiber.dispose())
  const path = join(f.ledgerDirectory, 'manifest.json')
  await writeFile(path, '{invalid')
  const gate = installVisionBudget(ctx, f.config, { readCredential: async () => { throw new Error('must not read') } })
  await assert.rejects(gate.ready, /ledger_unavailable/)
  await assert.rejects(consume(ctx.llm.stream(request(f.config))), /ledger_unavailable/)
  assert.equal(f.wireCalls(), 0)
})

test('persistent eight-slot cap survives rereads and a new runtime; manifest mutation closes the gate', async t => {
  const f = await fixture(t); f.wrap()
  for (let i = 0; i < 8; i++) await consume(f.ctx.llm.stream(request(f.config)))
  await assert.rejects(consume(f.ctx.llm.stream(request(f.config))), /budget_exhausted/)
  assert.equal((await f.gate.snapshot()).reservedRequests, 8)
  const ctx = new Context(); new LlmRuntime(ctx); t.after(() => ctx.fiber.dispose())
  const next = installVisionBudget(ctx, f.config, { readCredential: async () => { throw new Error('must not resolve') } })
  ctx.llm.registerAdapter([WRAPPER], { providerInfo: id => ({ id, name: id }),
    providerRetryPolicy: () => VISION_CONNECTION.retryPolicy, async *stream() { throw new Error('must not execute wrapper') } })
  await next.ready
  await assert.rejects(consume(ctx.llm.stream(request(f.config))), /budget_exhausted/)
  assert.equal((await next.snapshot()).mountCount, 2)
  assert.equal(f.wireCalls(), 8)
  const manifestPath = join(f.ledgerDirectory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.maxRequests = 16
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(consume(ctx.llm.stream(request(f.config))), /identity_mismatch/)
  assert.equal(f.wireCalls(), 8)
})

const installed = process.env.XIAOSHE_MODLENS_ROOT ?? join(homedir(), '.dsh/profiles/web/node_modules/@liustack/modlens')
const installedPresent = await access(join(installed, 'dsh/index.js')).then(() => true, () => false)
test('actual pinned ModLens text-only wrapper preserves the causal chain without any CLI engine', { skip: !installedPresent }, async t => {
  const f = await fixture(t)
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, '3.22.0')
  new SystemPrompt(f.ctx, {}); new ToolRuntime(f.ctx)
  const modlens = await import(pathToFileURL(join(installed, 'dsh/index.js')).href)
  modlens.apply(f.ctx, { upstream: OFFICIAL, autoRead: false, pasteToPath: false, settingsCard: false })
  assert.equal(f.ctx.llm.providerRetryPolicy(WRAPPER).maxRetries, 0)
  const chunks = await consume(f.ctx.llm.stream(request(f.config)))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(f.wireCalls(), 1)
  assert.equal((await f.gate.snapshot()).reservedRequests, 1)
})
