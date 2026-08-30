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
    probes: [{ status: 'succeeded', provider: 'deepseek', model: 'deepseek-chat', startedAt: 10, completedAt: 20, latencyMs: 10, finishReason: 'stop', usage: {}, cost: { status: 'unavailable' } }],
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

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return value } }
}
