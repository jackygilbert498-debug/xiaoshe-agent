import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { LlmRuntime } from '../../runtime/DSH/packages/llm/llm/lib/index.js'
import { installComplexOfficial, complexOfficialConfig } from './complex-official-budget.mjs'
import { complexProfilePatch, mayRemoveComplexRoot, createOwnedSmokeCancellation } from './complex-live.mjs'
import { complexSessionIds } from './complex-tool-policy.mjs'
import { composeEntries, loadOverlayPatches } from '../../runtime/DSH/packages/boot/app-boot/lib/index.js'

async function fixture(t, liveAuthorized) {
  const runId = randomUUID(), acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  await mkdir(acceptanceRoot, { mode: 0o700 })
  t.after(() => rm(acceptanceRoot, { recursive: true, force: true }))
  for (const name of ['workspace', 'tool-policy', 'execution-temp', 'workspace/code-repair', 'workspace/research', 'workspace/recovery', 'workspace/steer']) {
    await mkdir(join(acceptanceRoot, name), { mode: 0o700 })
  }
  const config = { acceptanceRoot, runId, nodePath: process.execPath, npmPath: '/fixed/npm/bin/npm-cli.js', liveAuthorized }
  const ctx = new Context(); new LlmRuntime(ctx); t.after(() => ctx.fiber.dispose())
  let network = 0
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('no network in component test') })
  return { config, ctx, network: () => network }
}

test('prepare-only registers the fixed adapter but cannot resolve a credential or dispatch a request', { skip: process.platform === 'win32' ? 'POSIX uid/private-mode sandbox gate requires macOS/Linux' : false }, async t => {
  const { ctx, config, network } = await fixture(t, false)
  let reads = 0
  const gate = installComplexOfficial(ctx, config, { readCredential: async () => { reads++; return 'synthetic-key' } })
  await gate.ready
  assert.deepEqual(ctx.llm.listProviders().map(row => row.id), ['deepseek-official'])
  assert.equal(await ctx.credentials.resolve('DEEPSEEK_API_KEY'), undefined)
  assert.deepEqual(await ctx.credentials.describe('DEEPSEEK_API_KEY'), { configured: false, writable: false })
  let dispatched = 0
  await assert.rejects(async () => {
    for await (const _chunk of gate.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash',
      maxTokens: 2048, sessionId: complexSessionIds(config.runId)[0] }, async function* () { dispatched++ })) { /* no chunks */ }
  }, /no_model/u)
  assert.equal(reads, 0); assert.equal(dispatched, 0); assert.equal(network(), 0)
  assert.equal((await gate.snapshot()).reservedRequests, 0)
  assert.equal((await gate.snapshot()).deniedRequests, 1)
})

test('live opt-in binds exactly five sessions and keeps credential/endpoint out of Profile inputs', { skip: process.platform === 'win32' ? 'POSIX uid/private-mode sandbox gate requires macOS/Linux' : false }, async t => {
  const { ctx, config, network } = await fixture(t, true)
  let reads = 0
  const gate = installComplexOfficial(ctx, config, { readCredential: async () => { reads++; return 'synthetic-only-key' } })
  await gate.ready
  assert.equal(reads, 0)
  const budget = complexOfficialConfig(config)
  assert.deepEqual(budget.sessionIds, complexSessionIds(config.runId))
  assert.equal(budget.maxRequests, 64)
  assert.equal(await ctx.credentials.resolve('UNRELATED_KEY'), undefined)
  assert.equal(reads, 0)
  assert.equal((await ctx.credentials.resolve('DEEPSEEK_API_KEY')).value, 'synthetic-only-key')
  await assert.rejects(ctx.credentials.set('DEEPSEEK_API_KEY', 'forbidden'), /forbidden/u)
  await assert.rejects(ctx.credentials.unset('DEEPSEEK_API_KEY'), /forbidden/u)
  for (const change of [{ apiKey: 'must-not-enter-profile' }, { baseURL: 'https://example.com' }, { runId: randomUUID() }, { liveAuthorized: 'true' }]) {
    assert.throws(() => complexOfficialConfig({ ...config, ...change }))
  }
  assert.equal(network(), 0)
})

test('profile replaces the real sandbox node, disables ambient paid routes and preserves the ordinary five-scenario tools', { skip: process.platform === 'win32' ? 'POSIX uid/private-mode sandbox gate requires macOS/Linux' : false }, async t => {
  const { config } = await fixture(t, false), { liveAuthorized, ...policy } = config
  const patch = complexProfilePatch(policy, false)
  assert.equal(patch.find(row => row.id === 'sandbox').disabled, true)
  assert.equal(patch.find(row => row.id === 'sandbox-policy').config.mode, 'workspace-write')
  assert.equal(patch.find(row => row.id === 'agent-presets').config.default, 'standard')
  assert.equal(patch.find(row => row.id === 'tools').config.mode, 'native')
  for (const id of ['credentials', 'llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'session-title-llm']) assert.equal(patch.find(row => row.id === id).disabled, true)
  const inserts = patch.flatMap(row => row.insert ?? [])
  assert.equal(inserts.length, 4)
  assert.equal(inserts.find(row => row.id === 'complex-execution-sandbox').name.endsWith('/complex-execution-sandbox.mjs'), true)
  assert.equal(inserts.find(row => row.id === 'complex-official-budget').config.liveAuthorized, false)
  assert.equal(inserts.find(row => row.id === 'complex-search-budget').config.liveAuthorized, false)
  assert.equal(inserts.find(row => row.id === 'complex-search-budget').config.sessionId, complexSessionIds(config.runId)[2])
  assert.equal(patch.some(row => row.id === 'tool-web' && row.disabled), false)
  assert.doesNotMatch(JSON.stringify(patch), /synthetic-only-key|DEEPSEEK_API_KEY/u)
})

test('any execution, source or retention failure preserves the original owned Profile and sessions', () => {
  const passed = ['owned-host-released', 'owned-port-released', 'original-evidence-retained'].map(id => ({ id, state: 'pass' }))
  assert.equal(mayRemoveComplexRoot([], passed), true)
  for (const stage of ['execution', 'host-log', 'source-after', 'full-history', 'archive-owned-session']) {
    assert.equal(mayRemoveComplexRoot([{ stage, reason: 'synthetic failure' }], passed), false)
  }
  assert.equal(mayRemoveComplexRoot([], passed.filter(row => row.id !== 'original-evidence-retained')), false)
  assert.equal(mayRemoveComplexRoot([], [...passed, { id: 'extra', state: 'fail' }]), false)
})

test('real composition disables the stock sandbox and activates exactly one owned provider', { skip: process.platform === 'win32' ? 'POSIX owned sandbox composition requires macOS/Linux' : false }, async t => {
  const { config } = await fixture(t, false), { liveAuthorized, ...policy } = config
  const base = loadOverlayPatches('complex-test', new URL('../../runtime/DSH/packages/bundle/base/cordis.patch.yml', import.meta.url).pathname)
  const webApp = loadOverlayPatches('complex-test', new URL('../../runtime/DSH/packages/bundle/web-app/cordis.patch.yml', import.meta.url).pathname)
  const warnings = []
  const entries = composeEntries([base, webApp, complexProfilePatch(policy, false)], message => warnings.push(message))
  const flatten = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])])
  const all = flatten(entries)
  assert.equal(all.find(row => row.id === 'sandbox').disabled, true)
  const active = all.filter(row => !row.disabled && (row.name === '@deepseek-ai/dsh-sandbox-local' || row.name?.endsWith('/complex-execution-sandbox.mjs')))
  assert.equal(active.length, 1)
  assert.equal(active[0].id, 'complex-execution-sandbox')
  assert.equal(all.find(row => row.id === 'sandbox-policy').config.mode, 'workspace-write')
  assert.deepEqual(warnings, [])
})

test('cancellation signals only the owned group and escalates unless ownership was released', async () => {
  const signals = []
  const cancellation = createOwnedSmokeCancellation({ kill: (...args) => signals.push(args), graceMs: 10 })
  cancellation.cancel(); assert.deepEqual(signals, [])
  cancellation.own(123456); cancellation.cancel(); cancellation.cancel()
  assert.deepEqual(signals, [[-123456, 'SIGTERM']])
  await delay(30)
  assert.deepEqual(signals, [[-123456, 'SIGTERM'], [-123456, 'SIGKILL']])
  cancellation.release()
  const released = createOwnedSmokeCancellation({ kill: (...args) => signals.push(args), graceMs: 10 })
  released.own(234567); released.cancel(); released.release()
  await delay(30)
  assert.equal(signals.filter(row => row[0] === -234567).length, 1)
})
