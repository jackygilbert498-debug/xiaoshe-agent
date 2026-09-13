import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { LlmRuntime } from '../../runtime/DSH/packages/llm/llm/lib/index.js'
import { installNativeOfficial, nativeOfficialConfig } from './live-native-official.mjs'

async function fixture(t) {
  const runId = randomUUID(), acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  await mkdir(acceptanceRoot, { mode: 0o700 })
  t.after(() => rm(acceptanceRoot, { recursive: true, force: true }))
  const ctx = new Context(); new LlmRuntime(ctx); t.after(() => ctx.fiber.dispose())
  let network = 0
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('no network in offline test') })
  return { ctx, config: { acceptanceRoot, runId, sessionId: `xiaoshe-material-${runId}` }, network: () => network }
}

test('native launch uses a reference-only read-only credential service and the fixed real adapter', async t => {
  const { ctx, config, network } = await fixture(t)
  let reads = 0
  const gate = installNativeOfficial(ctx, config, { readCredential: async () => { reads++; return 'synthetic-test-key' } })
  await gate.ready
  assert.equal(reads, 0, 'registration must not read the credential')
  assert.equal(await ctx.credentials.resolve('UNRELATED_KEY'), undefined)
  assert.equal(reads, 0)
  assert.deepEqual(await ctx.credentials.describe('DEEPSEEK_API_KEY'), { configured: true, writable: false, source: 'acceptance-selected-read-only' })
  assert.deepEqual(await ctx.credentials.resolve('DEEPSEEK_API_KEY'), { value: 'synthetic-test-key', source: 'acceptance-selected-read-only' })
  assert.equal(reads, 2)
  await assert.rejects(ctx.credentials.set('DEEPSEEK_API_KEY', 'other'), /mutation forbidden/u)
  await assert.rejects(ctx.credentials.unset('DEEPSEEK_API_KEY'), /mutation forbidden/u)
  assert.equal((await gate.snapshot()).maxRequests, 64)
  assert.equal((await gate.snapshot()).reservedRequests, 0)
  assert.deepEqual(ctx.llm.listProviders().map(row => row.id), ['deepseek-official'])
  assert.equal(network(), 0)
})

test('invalid roots, extra configuration and overlapping credentials fail closed', async t => {
  const { ctx, config } = await fixture(t)
  for (const change of [{ acceptanceRoot: '/tmp' }, { runId: randomUUID() }, { sessionId: 'another' },
    { apiKey: 'not-accepted' }, { baseURL: 'https://not-allowed.invalid' }]) {
    assert.throws(() => nativeOfficialConfig({ ...config, ...change }))
  }
  const gate = installNativeOfficial(ctx, config, { readCredential: async () => { throw new Error('secret-ish source error must not propagate') } })
  await gate.ready
  await assert.rejects(ctx.credentials.resolve('DEEPSEEK_API_KEY'), error => error.message === 'native-official: selected credential unavailable')
  assert.deepEqual(await ctx.credentials.describe('DEEPSEEK_API_KEY'), { configured: false, writable: false })
  assert.throws(() => installNativeOfficial(ctx, config), /another credential provider/u)
})

test('fixed batch session reuses the same durable 64-request budget without admitting arbitrary sessions', async t => {
  const { config } = await fixture(t)
  const batch = nativeOfficialConfig({ ...config, sessionId: `xiaoshe-batch-${config.runId}` })
  assert.equal(batch.maxRequests, 64)
  assert.deepEqual(batch.sessionIds, [`xiaoshe-batch-${config.runId}`])
  assert.throws(() => nativeOfficialConfig({ ...config, sessionId: `xiaoshe-batch-${randomUUID()}` }))
})
