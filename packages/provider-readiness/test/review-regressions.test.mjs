import assert from 'node:assert/strict'
import test from 'node:test'
import { providerRouteRevision } from '../lib/route-revision.js'
import { ProviderReadinessClient } from './.generated/client.mjs'

const directory = [{ provider: 'p', displayName: 'Provider', settingsNs: 'llm', settingsPath: ['p'], active: true, declared: true }]
const modelSnapshot = { status: 'ready', sessionId: 's', routable: true, groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }] }], failures: [] }
const settings = config => [{ ns: 'llm', revision: 0, value: { p: config } }]

test('arbitrary header credentials never contribute their values to a persisted route digest', async () => {
  const revision = secret => providerRouteRevision('p', 'm', directory, settings({
    baseURL: 'https://gateway.example/v1', headers: { 'X-Api-Key': secret, 'arbitrary-header': secret },
  }))
  assert.equal(await revision('synthetic-private-a'), await revision('synthetic-private-b'))
})

test('URL userinfo, query and fragment credentials are excluded while the public endpoint still binds', async () => {
  const revision = endpoint => providerRouteRevision('p', 'm', directory, settings({ baseURL: endpoint }))
  const first = await revision('https://user:synthetic-a@gateway.example/v1?token=synthetic-a#synthetic-a')
  assert.equal(first, await revision('https://other:synthetic-b@gateway.example/v1?token=synthetic-b#synthetic-b'))
  assert.notEqual(first, await revision('https://gateway.example/v2'))
})

test('loading and failed refresh revoke verified but retain the historical probe record', async t => {
  const configurationEpoch = '00000000-0000-4000-8000-000000000001'
  let revision = 0, endpoint = 'https://first.example/v1', fail = false
  const currentSettings = () => [{ ns: 'llm', revision, value: { p: { baseURL: endpoint } } }]
  const routeRevision = await providerRouteRevision('p', 'm', directory, currentSettings(), configurationEpoch)
  const probe = { status: 'succeeded', provider: 'p', model: 'm', routeRevision, startedAt: 10, completedAt: 20, latencyMs: 10, finishReason: 'stop', usage: {}, cost: { status: 'unavailable' } }
  const client = new ProviderReadinessClient({
    now: () => 30,
    connection: { api: {
      llm: { async providers() { return { result: { ok: true, value: { providers: directory } } } } },
      credentials: { async describe() { return { result: { ok: true, value: { credentials: {} } } } } },
    } },
    settings: { async ensure() {}, getSnapshot() { return { status: 'ready', view: { namespaces: currentSettings() } } }, subscribe: () => () => {} },
    modelCatalog: { getSnapshot: () => modelSnapshot, subscribe: () => () => {} },
    fetcher: async () => {
      if (fail) throw new Error('synthetic transport failure')
      return new Response(JSON.stringify({ configurationEpoch, probes: [probe] }))
    },
  })
  t.after(() => client.dispose())
  assert.equal((await client.refresh('s')).ok, true)
  assert.equal(client.getSnapshot().providers[0].routes[0].facts.verified, true)
  endpoint = 'https://changed.example/v1'; revision += 1; fail = true
  const refresh = client.refresh('s')
  assert.equal(client.getSnapshot().status, 'loading')
  assert.equal(client.getSnapshot().providers[0].routes[0].facts.verified, false)
  assert.equal((await refresh).ok, false)
  assert.equal(client.getSnapshot().providers[0].routes[0].facts.verified, false)
  assert.deepEqual(client.getSnapshot().providers[0].routes[0].probe, probe)
})

test('ready mirror with a held view and an error revokes verification, rejects refresh, and recovers without retry loops', async t => {
  const configurationEpoch = '00000000-0000-4000-8000-000000000002'
  const view = { namespaces: settings({ baseURL: 'https://first.example/v1' }) }
  const routeRevision = await providerRouteRevision('p', 'm', directory, view.namespaces, configurationEpoch)
  const probe = { status: 'succeeded', provider: 'p', model: 'm', routeRevision, startedAt: 10, completedAt: 20, latencyMs: 10, finishReason: 'stop', usage: {}, cost: { status: 'unavailable' } }
  let mirror = { status: 'ready', view, error: null }, fetches = 0, heldResolve
  const listeners = new Set()
  const client = new ProviderReadinessClient({
    now: () => 30,
    connection: { api: {
      llm: { async providers() { return { result: { ok: true, value: { providers: directory } } } } },
      credentials: { async describe() { return { result: { ok: true, value: { credentials: {} } } } } },
    } },
    settings: { async ensure() {}, getSnapshot: () => mirror, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) } },
    modelCatalog: { getSnapshot: () => modelSnapshot, subscribe: () => () => {} },
    fetcher: async () => {
      fetches += 1
      if (fetches === 2) await new Promise(resolve => { heldResolve = resolve })
      return new Response(JSON.stringify({ configurationEpoch, probes: [probe] }))
    },
  })
  t.after(() => { heldResolve?.(); client.dispose() })
  const verified = () => client.getSnapshot().providers[0].routes[0].facts.verified
  assert.equal((await client.refresh('s')).ok, true)
  assert.equal(verified(), true)
  const pending = client.refresh('s')
  while (!heldResolve) await new Promise(resolve => setImmediate(resolve))
  // Actual SettingsDescribeMirror failure contract: ready + same view + error.
  mirror = { status: 'ready', view, error: 'synthetic settings reload failed' }
  for (const listener of listeners) listener()
  assert.equal(verified(), false)
  assert.equal(client.getSnapshot().status, 'error')
  heldResolve()
  assert.equal((await pending).ok, false, 'late work must not overwrite the mirror failure')
  assert.equal((await client.refresh('s')).ok, false)
  assert.equal(verified(), false)
  assert.deepEqual(client.getSnapshot().providers[0].routes[0].probe, probe)
  const fetchesAfterFailure = fetches
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fetches, fetchesAfterFailure, 'a failed held mirror must not auto-retry itself')
  // A recovered mirror may reuse the same immutable view object.
  mirror = { status: 'ready', view, error: null }
  for (const listener of listeners) listener()
  for (let attempt = 0; attempt < 100 && !verified(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(verified(), true)
  assert.equal(client.getSnapshot().status, 'ready')
})
