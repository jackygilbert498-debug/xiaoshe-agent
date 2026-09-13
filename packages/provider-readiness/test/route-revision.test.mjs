import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { ProviderReadinessClient, projectProviderReadiness } from './.generated/client.mjs'

const directory = [{ provider: 'p', displayName: 'Provider', settingsNs: 'llm', settingsPath: ['p'], active: true, declared: true }]
const modelSnapshot = { status: 'ready', sessionId: 's', routable: true, groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }] }], failures: [] }

test('host probe records bind endpoint and credential reference changes using only redacted settings', async t => {
  const dshHome = await mkdtemp(join(tmpdir(), 'xiaoshe-route-revision-'))
  let service, revision = 1, endpoint = 'https://a.example', ref = 'KEY_A', rawSecret = 'first-private-secret'
  const releases = []
  t.after(async () => { releases.forEach(release => release()); await rm(dshHome, { recursive: true, force: true }) })
  const publicSettings = () => [{ ns: 'llm', revision, value: { p: { baseURL: endpoint, apiKeyEnv: ref } }, secrets: [{ path: ['p', 'apiKey'], configured: !!rawSecret }] }]
  apply({
    llm: { listConfigurableProviders: () => directory, async resolveModelInfo() { return {} }, async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } } },
    settings: { describe(options) {
      assert.equal(options?.redactSecrets, true, 'probe must never request a verbatim credential-bearing descriptor')
      return publicSettings()
    } },
    webServer: { register() { return () => {} } },
    provide(_name, value) { service = value }, effect(callback) { releases.push(callback()) },
  }, { dshHome, activeProfile: 'web' })
  const first = await service.probe({ provider: 'p', model: 'm', timeoutMs: 500 })
  endpoint = 'https://b.example'; ref = 'KEY_B'; revision += 1
  const second = await service.probe({ provider: 'p', model: 'm', timeoutMs: 500 })
  assert.notEqual(first.routeRevision, second.routeRevision, 'old route evidence must not authenticate new configuration')
  assert.match(second.routeRevision, /^[a-f0-9]{64}$/u)
  rawSecret = 'rotated-private-secret'
  const rotated = await service.probe({ provider: 'p', model: 'm', timeoutMs: 500 })
  assert.equal(rotated.routeRevision, second.routeRevision, 'secret material is deliberately outside this public configuration revision')
  const ledger = await readFile(join(dshHome, 'profiles/web/.xiaoshe/provider-probes.json'), 'utf8')
  assert.equal(ledger.includes(rawSecret), false)
  const client = new ProviderReadinessClient({
    connection: { api: {
      llm: { async providers() { return { result: { ok: true, value: { providers: directory } } } } },
      credentials: { async describe() { return { result: { ok: true, value: { credentials: { KEY_B: { configured: true } } } } } } },
    } },
    settings: { async ensure() {}, getSnapshot() { return { status: 'ready', view: { namespaces: publicSettings() } } }, subscribe() { return () => {} } },
    modelCatalog: { getSnapshot: () => modelSnapshot, subscribe: () => () => {} },
    fetcher: async () => new Response(JSON.stringify(service.snapshot()), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  t.after(() => client.dispose())
  assert.equal((await client.refresh('s')).ok, true)
  assert.equal(client.getSnapshot().providers[0].routes[0].facts.verified, true, 'matching host and browser revisions verify the route')
  endpoint = 'https://changed-again.example'; revision += 1
  assert.equal((await client.refresh('s')).ok, true)
  assert.equal(client.getSnapshot().providers[0].routes[0].facts.verified, false, 'refresh must invalidate the previous success after public settings change')
})

test('readiness refuses old or missing route revisions even inside the verification TTL', () => {
  const settings = [{ ns: 'llm', value: { p: { apiKeyEnv: 'KEY_B', baseURL: 'https://b.example' } } }]
  const probe = { status: 'succeeded', provider: 'p', model: 'm', routeRevision: 'a'.repeat(64), startedAt: 10, completedAt: 20, latencyMs: 10, finishReason: 'stop', usage: {}, cost: { status: 'unavailable' } }
  const input = { directory, settings, credentials: { KEY_B: { configured: true } }, modelSnapshot, probes: [probe], now: 30, verificationTtlMs: 1000 }
  for (const routeRevisions of [{ 'p\u0000m': 'b'.repeat(64) }, {}]) {
    const facts = projectProviderReadiness({ ...input, routeRevisions }).providers[0].routes[0]
    assert.equal(facts.facts.verified, false)
    assert.ok(facts.reasons.includes('probe_configuration_changed'))
  }
})

test('a new host mount cannot reuse the previous launch route success until explicitly probed again', async t => {
  const dshHome = await mkdtemp(join(tmpdir(), 'xiaoshe-route-launch-'))
  let service
  const releases = []
  const namespaces = [{ ns: 'llm', revision: 0, value: { p: { apiKeyEnv: 'KEY_A' } } }]
  t.after(async () => { releases.forEach(release => release()); await rm(dshHome, { recursive: true, force: true }) })
  const mount = () => apply({
    llm: { listConfigurableProviders: () => directory, async resolveModelInfo() { return {} }, async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } } },
    settings: { describe: () => namespaces },
    webServer: { register: () => () => {} },
    provide(_name, value) { service = value }, effect(callback) { releases.push(callback()) },
  }, { dshHome, activeProfile: 'web' })
  mount()
  const first = await service.probe({ provider: 'p', model: 'm', timeoutMs: 500 })
  const firstEpoch = service.snapshot().configurationEpoch
  const client = new ProviderReadinessClient({
    connection: { api: {
      llm: { async providers() { return { result: { ok: true, value: { providers: directory } } } } },
      credentials: { async describe() { return { result: { ok: true, value: { credentials: { KEY_A: { configured: true } } } } } } },
    } },
    settings: { async ensure() {}, getSnapshot: () => ({ status: 'ready', view: { namespaces } }), subscribe: () => () => {} },
    modelCatalog: { getSnapshot: () => modelSnapshot, subscribe: () => () => {} },
    fetcher: async () => new Response(JSON.stringify(service.snapshot())),
  })
  t.after(() => client.dispose())
  assert.equal((await client.refresh('s')).ok, true)
  assert.equal(client.getSnapshot().providers[0].routes[0].facts.verified, true)
  releases.pop()()
  mount()
  assert.notEqual(service.snapshot().configurationEpoch, firstEpoch, 'a new owner must not inherit a previous environment binding')
  assert.equal((await client.refresh('s')).ok, true)
  assert.equal(client.getSnapshot().providers[0].routes[0].facts.verified, false)
  assert.deepEqual(client.getSnapshot().providers[0].routes[0].probe, first)
  const second = await service.probe({ provider: 'p', model: 'm', timeoutMs: 500 })
  assert.notEqual(second.routeRevision, first.routeRevision)
  assert.equal((await client.refresh('s')).ok, true)
  assert.equal(client.getSnapshot().providers[0].routes[0].facts.verified, true)
})
