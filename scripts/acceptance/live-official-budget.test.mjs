import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { LlmRuntime } from '../../runtime/DSH/packages/llm/llm/lib/index.js'
import { apply, inject, installOfficialBudget, OFFICIAL_ADAPTER_CONFIG } from './live-official-budget.mjs'
import { readBudgetLedger } from './live-request-budget.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xs-official-budget-unit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  new LlmRuntime(ctx)
  const config = { ledgerDirectory: join(root, 'budget'), runId: 'offline-official-fixture', maxRequests: 8,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', sessionIds: ['owned-session'] }
  let networkCalls = 0
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('network forbidden in offline registration acceptance') })
  return { ctx, config, networkCalls: () => networkCalls }
}

test('real official adapter registers before guard initialization and advertises fixed Flash/off capabilities without network', async t => {
  const { ctx, config, networkCalls } = await fixture(t)
  const gate = installOfficialBudget(ctx, config)
  // This is deliberately BEFORE gate.ready: the startup race must be absent,
  // not merely unlikely because a file write happened to finish later.
  assert.deepEqual(ctx.llm.listProviders().map(row => row.id), ['deepseek-official'])
  assert.equal(ctx.llm.providerRetryPolicy('deepseek-official').mode, 'normal')
  assert.equal(ctx.llm.providerRetryPolicy('deepseek-official').maxRetries, 0)
  await gate.ready
  const catalog = await ctx.llm.listModels('deepseek-official')
  assert.deepEqual(catalog.map(row => row.id), ['deepseek-v4-flash'])
  const model = await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-flash')
  assert.equal(model.reasoning.defaultEffort, 'off')
  assert.deepEqual(model.reasoning.efforts.map(row => row.id), ['off'])
  assert.equal(model.defaultMaxTokens, 2048)
  const ledger = await readBudgetLedger(config.ledgerDirectory)
  assert.equal(ledger.mountCount, 1)
  assert.equal(ledger.mounts[0].pid, process.pid)
  assert.equal(ledger.runId, config.runId)
  assert.equal(ledger.attemptedRequests, 0)
  assert.equal(ledger.reservedRequests, 0)
  assert.equal(networkCalls(), 0)
})

test('fixed endpoint, credential ref, model, reasoning and retry facts cannot be supplied or mutated through fixture config', async t => {
  const { ctx, config, networkCalls } = await fixture(t)
  assert.deepEqual(inject, ['llm'])
  assert.equal(OFFICIAL_ADAPTER_CONFIG.baseURL, 'https://api.deepseek.com')
  assert.equal(OFFICIAL_ADAPTER_CONFIG.apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.equal(OFFICIAL_ADAPTER_CONFIG.thinking, 'disabled')
  for (const change of [{ baseURL: 'https://gateway.invalid' }, { apiKey: 'never-accepted' }, { adapter: {} },
    { provider: 'third-party' }, { model: 'different' }, { maxRequests: 0 }, { maxRequests: Infinity },
    { ledgerDirectory: 'relative' }, { sessionIds: [] }, { sessionIds: ['same', 'same'] }]) {
    assert.throws(() => installOfficialBudget(ctx, { ...config, ...change }), /invalid fixed-route/u)
    assert.deepEqual(ctx.llm.listProviders(), [])
  }
  assert.throws(() => { OFFICIAL_ADAPTER_CONFIG.baseURL = 'https://gateway.invalid' }, TypeError)
  assert.throws(() => { OFFICIAL_ADAPTER_CONFIG.retryPolicy.maxRetries = 5 }, TypeError)
  assert.throws(() => { OFFICIAL_ADAPTER_CONFIG.models[0].id = 'different' }, TypeError)
  assert.equal(networkCalls(), 0)
})

test('real Cordis plugin mounts, and foreign/auxiliary calls are denied before the real adapter can send', async t => {
  const { ctx, config, networkCalls } = await fixture(t)
  await ctx.plugin({ name: 'official-budget-offline', inject, apply }, config)
  const consume = async stream => { for await (const _chunk of stream) { /* No provider output is expected. */ } }
  const request = { provider: 'deepseek-official', model: 'deepseek-v4-flash', sessionId: 'foreign-session',
    messages: [], maxTokens: 2048 }
  await assert.rejects(consume(ctx.llm.stream(request)), /route_not_allowed/u)
  await assert.rejects(consume(ctx.llm.stream({ ...request, sessionId: 'owned-session', purpose: 'session-title' })), /route_not_allowed/u)
  const ledger = await readBudgetLedger(config.ledgerDirectory)
  assert.equal(ledger.mountCount, 1)
  assert.equal(ledger.reservedRequests, 0)
  assert.equal(ledger.deniedRequests, 2)
  assert.equal(networkCalls(), 0)
})
