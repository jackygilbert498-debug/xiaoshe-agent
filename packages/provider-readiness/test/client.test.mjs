import assert from 'node:assert/strict'
import test from 'node:test'

import { ProviderReadinessClient, projectProviderReadiness } from './.generated/client.mjs'

const directory = [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm.pi-ai', settingsPath: ['providers', 'deepseek'], active: true, declared: true }]
const settings = [{ ns: 'llm.pi-ai', value: { providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } }, base: {}, user: {}, schema: {}, applies: [], secrets: [], revision: 1 }]
const modelSnapshot = { status: 'ready', sessionId: 's1', routable: true, groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'Chat' }] }], failures: [] }

test('projectProviderReadiness keeps the five facts independent', () => {
  const snapshot = projectProviderReadiness({
    directory,
    settings,
    credentials: { DEEPSEEK_API_KEY: { configured: true } },
    modelSnapshot,
    probes: [{ status: 'succeeded', provider: 'deepseek', model: 'deepseek-chat', routeRevision: 'a'.repeat(64), startedAt: 10, completedAt: 20, latencyMs: 10, finishReason: 'stop', usage: {}, cost: { status: 'unavailable' } }],
    routeRevisions: { 'deepseek\u0000deepseek-chat': 'a'.repeat(64) },
    now: 30,
    verificationTtlMs: 1_000,
  })
  const route = snapshot.providers[0].routes[0]
  assert.deepEqual(route.facts, { catalogued: true, supported: true, configured: true, available: true, verified: true })

  const missingKey = projectProviderReadiness({
    directory, settings, credentials: {}, modelSnapshot, probes: [], now: 30, verificationTtlMs: 1_000,
  }).providers[0].routes[0]
  assert.equal(missingKey.facts.catalogued, true)
  assert.equal(missingKey.facts.supported, true)
  assert.equal(missingKey.facts.configured, false)
  assert.equal(missingKey.facts.available, false)
  assert.equal(missingKey.facts.verified, false)
  assert.ok(missingKey.reasons.includes('credential_missing'))
})

test('ProviderReadinessClient probes the exact route and refreshes truth', async () => {
  const fetchCalls = []
  const fetcher = async (path, init = {}) => {
    fetchCalls.push({ path, init })
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    if (path.endsWith('/probe')) {
      assert.deepEqual(body, { provider: 'deepseek', model: 'deepseek-chat', timeoutMs: 2_000 })
      return response({ probe: { status: 'succeeded', provider: body.provider, model: body.model, startedAt: 1, completedAt: 2, latencyMs: 1, finishReason: 'stop', usage: {}, cost: { status: 'unavailable' } } })
    }
    return response({ probes: [] })
  }
  const client = new ProviderReadinessClient({
    connection: {
      api: {
        llm: { async providers() { return { result: { ok: true, value: { providers: directory } } } } },
        credentials: {
          async describe() {
            return { result: { ok: true, value: { credentials: { DEEPSEEK_API_KEY: { configured: true } } } } }
          },
        },
      },
    },
    settings: { async ensure() {}, getSnapshot() { return { status: 'ready', view: { namespaces: settings } } }, subscribe() { return () => {} } },
    modelCatalog: { getSnapshot() { return modelSnapshot }, subscribe() { return () => {} }, async refresh() { return { ok: true, value: modelSnapshot } } },
    fetcher,
    now: () => 100,
  })
  const result = await client.probe({ provider: 'deepseek', model: 'deepseek-chat', timeoutMs: 2_000 })
  assert.equal(result.ok, true)
  assert.equal(result.value.probe.status, 'succeeded')
  assert.equal(fetchCalls.some(call => call.path.endsWith('/probe')), true)
  client.dispose()
})

test('ProviderReadinessClient does not auto-retry transient settings failures', async () => {
  let settingsSnapshot = { status: 'idle', view: undefined, error: null }
  const settingsListeners = new Set()
  let ensureCalls = 0
  const client = new ProviderReadinessClient({
    connection: {
      api: {
        llm: { async providers() { return { result: { ok: true, value: { providers: directory } } } } },
        credentials: { async describe() { return { result: { ok: true, value: { credentials: {} } } } } },
      },
    },
    settings: {
      async ensure() {
        ensureCalls += 1
        settingsSnapshot = { status: 'loading', view: undefined, error: null }
        for (const listener of settingsListeners) listener()
        await Promise.resolve()
        settingsSnapshot = { status: 'idle', view: undefined, error: 'offline' }
        for (const listener of settingsListeners) listener()
      },
      getSnapshot() { return settingsSnapshot },
      subscribe(listener) { settingsListeners.add(listener); return () => settingsListeners.delete(listener) },
    },
    modelCatalog: { getSnapshot() { return modelSnapshot }, subscribe() { return () => {} }, async refresh() { return { ok: true, value: modelSnapshot } } },
    fetcher: async () => response({ probes: [] }),
  })

  const result = await client.refresh('s1')
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(result.ok, false)
  assert.equal(ensureCalls, 1)
  client.dispose()
})

test('ProviderReadinessClient coalesces a newly ready settings view', async () => {
  let settingsSnapshot = { status: 'idle', view: undefined, error: null }
  const settingsListeners = new Set()
  let providerCalls = 0
  const client = new ProviderReadinessClient({
    connection: {
      api: {
        llm: { async providers() { providerCalls += 1; return { result: { ok: true, value: { providers: directory } } } } },
        credentials: { async describe() { return { result: { ok: true, value: { credentials: {} } } } } },
      },
    },
    settings: {
      async ensure() {},
      getSnapshot() { return settingsSnapshot },
      subscribe(listener) { settingsListeners.add(listener); return () => settingsListeners.delete(listener) },
    },
    modelCatalog: { getSnapshot() { return modelSnapshot }, subscribe() { return () => {} }, async refresh() { return { ok: true, value: modelSnapshot } } },
    fetcher: async () => response({ probes: [] }),
  })

  settingsSnapshot = { status: 'ready', view: { namespaces: settings }, error: null }
  for (const listener of settingsListeners) listener()
  for (const listener of settingsListeners) listener()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(providerCalls, 1)
  client.dispose()
})

test('ProviderReadinessClient does not let a superseded credential lookup overwrite a newer session', async () => {
  const firstCredentialResult = deferred()
  const firstCredentialStarted = deferred()
  let credentialCalls = 0
  let activeModelSnapshot = { ...modelSnapshot, sessionId: 'session-a' }
  const client = new ProviderReadinessClient({
    connection: {
      api: {
        llm: { async providers() { return { result: { ok: true, value: { providers: directory } } } } },
        credentials: {
          async describe() {
            credentialCalls += 1
            if (credentialCalls === 1) {
              firstCredentialStarted.resolve()
              return firstCredentialResult.promise
            }
            return { result: { ok: true, value: { credentials: { DEEPSEEK_API_KEY: { configured: true } } } } }
          },
        },
      },
    },
    settings: { async ensure() {}, getSnapshot() { return { status: 'ready', view: { namespaces: settings } } }, subscribe() { return () => {} } },
    modelCatalog: { getSnapshot() { return activeModelSnapshot }, subscribe() { return () => {} }, async refresh() { return { ok: true, value: activeModelSnapshot } } },
    fetcher: async () => response({ probes: [] }),
  })

  const refreshA = client.refresh('session-a')
  await firstCredentialStarted.promise
  activeModelSnapshot = { ...modelSnapshot, sessionId: 'session-b' }
  const refreshB = await client.refresh('session-b')
  assert.equal(refreshB.ok, true)
  assert.equal(client.getSnapshot().sessionId, 'session-b')
  assert.equal(client.getSnapshot().providers[0].routes[0].facts.configured, true)

  firstCredentialResult.resolve({ result: { ok: true, value: { credentials: { DEEPSEEK_API_KEY: { configured: false } } } } })
  const staleA = await refreshA
  assert.equal(staleA.ok, false)
  assert.equal(staleA.error.kind, 'conflict')
  assert.equal(client.getSnapshot().sessionId, 'session-b')
  assert.equal(client.getSnapshot().providers[0].routes[0].facts.configured, true)
  client.dispose()
})

test('ProviderReadinessClient does not relabel previous-session routes while the next session is loading', async () => {
  const nextCredentialResult = deferred()
  const nextCredentialStarted = deferred()
  let credentialCalls = 0
  let activeModelSnapshot = { ...modelSnapshot, sessionId: 'session-a' }
  const client = new ProviderReadinessClient({
    connection: {
      api: {
        llm: { async providers() { return { result: { ok: true, value: { providers: directory } } } } },
        credentials: {
          async describe() {
            credentialCalls += 1
            if (credentialCalls === 1) return { result: { ok: true, value: { credentials: { DEEPSEEK_API_KEY: { configured: true } } } } }
            nextCredentialStarted.resolve()
            return nextCredentialResult.promise
          },
        },
      },
    },
    settings: { async ensure() {}, getSnapshot() { return { status: 'ready', view: { namespaces: settings } } }, subscribe() { return () => {} } },
    modelCatalog: { getSnapshot() { return activeModelSnapshot }, subscribe() { return () => {} }, async refresh() { return { ok: true, value: activeModelSnapshot } } },
    fetcher: async () => response({ probes: [] }),
  })

  assert.equal((await client.refresh('session-a')).ok, true)
  assert.equal(client.getSnapshot().providers.length, 1)
  activeModelSnapshot = { ...modelSnapshot, sessionId: 'session-b' }
  const refreshB = client.refresh('session-b')
  await nextCredentialStarted.promise
  assert.equal(client.getSnapshot().sessionId, 'session-b')
  assert.equal(client.getSnapshot().status, 'loading')
  assert.deepEqual(client.getSnapshot().providers, [])

  nextCredentialResult.resolve({ result: { ok: true, value: { credentials: { DEEPSEEK_API_KEY: { configured: true } } } } })
  assert.equal((await refreshB).ok, true)
  client.dispose()
})

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return value } }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
