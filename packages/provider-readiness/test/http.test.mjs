import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROVIDER_PROBE_CANCEL_PATH,
  PROVIDER_PROBE_PATH,
  PROVIDER_READINESS_PATH,
  registerProviderReadinessHttpRoutes,
} from '../lib/http.js'

class Server {
  routes = new Map()
  register(route) { this.routes.set(route.path, route.handler); return () => this.routes.delete(route.path) }
}

function request(method, body, headers = {}) {
  const bytes = body === undefined ? [] : [JSON.stringify(body)]
  return {
    method,
    headers: { host: '127.0.0.1:31889', origin: 'http://127.0.0.1:31889', ...headers },
    async *[Symbol.asyncIterator]() { yield* bytes },
  }
}

function response() {
  return {
    status: 0, headers: {}, body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this },
    end(data = '') { this.body = String(data) },
    json() { return JSON.parse(this.body) },
  }
}

test('provider readiness routes expose facts and guarded probe controls', async () => {
  const server = new Server()
  let cancelled = false
  const service = {
    async ready() {},
    snapshot() { return { probes: [], running: undefined } },
    async probe(input) { return { status: 'succeeded', ...input, startedAt: 1, completedAt: 2, latencyMs: 1, finishReason: 'stop', usage: {}, cost: { status: 'unavailable' } } },
    cancel() { cancelled = true; return true },
  }
  registerProviderReadinessHttpRoutes(server, service)

  const status = response()
  await server.routes.get(PROVIDER_READINESS_PATH)(request('GET'), status)
  assert.equal(status.status, 200)
  assert.deepEqual(status.json().probes, [])

  const probe = response()
  await server.routes.get(PROVIDER_PROBE_PATH)(request('POST', { provider: 'p', model: 'm', timeoutMs: 2_000 }, { 'content-type': 'application/json' }), probe)
  assert.equal(probe.status, 200)
  assert.equal(probe.json().probe.status, 'succeeded')

  const cancel = response()
  await server.routes.get(PROVIDER_PROBE_CANCEL_PATH)(request('POST', {}, { 'content-type': 'application/json' }), cancel)
  assert.equal(cancel.status, 200)
  assert.equal(cancelled, true)
})

test('provider readiness routes reject cross-site and malformed requests', async () => {
  const server = new Server()
  registerProviderReadinessHttpRoutes(server, {
    async ready() {}, snapshot() { return { probes: [] } }, async probe() { throw new Error('must not run') }, cancel() { return false },
  })

  const crossSite = response()
  await server.routes.get(PROVIDER_READINESS_PATH)(request('GET', undefined, { origin: 'https://evil.example' }), crossSite)
  assert.equal(crossSite.status, 403)

  const extra = response()
  await server.routes.get(PROVIDER_PROBE_PATH)(request('POST', { provider: 'p', model: 'm', extra: true }, { 'content-type': 'application/json' }), extra)
  assert.equal(extra.status, 400)

  const media = response()
  await server.routes.get(PROVIDER_PROBE_PATH)(request('POST', { provider: 'p', model: 'm' }), media)
  assert.equal(media.status, 415)
})
