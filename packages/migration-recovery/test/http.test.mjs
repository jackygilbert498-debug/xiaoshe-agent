import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MIGRATION_CONFIRM_PATH, MIGRATION_INSPECT_PATH, MIGRATION_STATUS_PATH,
  registerMigrationRecoveryHttpRoutes,
} from '../lib/http.js'

class Server {
  routes = new Map()
  register(route) { this.routes.set(route.path, route); return () => this.routes.delete(route.path) }
}
function request(body, headers = {}) {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body) },
  }
}
function response() {
  return {
    status: 0, headers: {}, body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this },
    end(body = '') { this.body = String(body) },
  }
}

test('migration HTTP routes enforce loopback origin and bounded schemas', async () => {
  const server = new Server()
  const service = {
    snapshot: () => ({ state: 'idle', updatedAt: 1 }),
    async exportTo() {},
    async inspect(input) { return { bundlePath: input.bundlePath, bundleHash: 'a'.repeat(64), mappings: input.mappings, sessions: [], conflicts: [] } },
    async prepareImport() { throw new Error('not used') },
    async confirmImport() {},
  }
  const release = registerMigrationRecoveryHttpRoutes(server, service)

  const untrusted = response()
  await server.routes.get(MIGRATION_STATUS_PATH).handler(request(undefined, { host: 'example.com' }), untrusted)
  assert.equal(untrusted.status, 403)

  const invalid = response()
  await server.routes.get(MIGRATION_INSPECT_PATH).handler(request({ bundlePath: 'C:\\bundle', mappings: [], extra: true }), invalid)
  assert.equal(invalid.status, 400)

  const ok = response()
  await server.routes.get(MIGRATION_INSPECT_PATH).handler(request({ bundlePath: 'C:\\bundle', mappings: [{ from: 'C:\\old', to: 'D:\\new' }] }), ok)
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).preview.mappings[0].to, 'D:\\new')
  release()
  assert.equal(server.routes.size, 0)
})

test('migration confirmation never accepts URL encoded or cross-site bodies', async () => {
  const server = new Server()
  let confirmed = 0
  registerMigrationRecoveryHttpRoutes(server, {
    snapshot: () => ({ state: 'idle', updatedAt: 1 }),
    async exportTo() {}, async inspect() { throw new Error('not used') }, async prepareImport() { throw new Error('not used') },
    async confirmImport() { confirmed += 1 },
  })
  const wrongType = response()
  await server.routes.get(MIGRATION_CONFIRM_PATH).handler(request({ challengeId: 'c', token: 't' }, { 'content-type': 'application/x-www-form-urlencoded' }), wrongType)
  assert.equal(wrongType.status, 415)
  const crossSite = response()
  await server.routes.get(MIGRATION_CONFIRM_PATH).handler(request({ challengeId: 'c', token: 't' }, { 'sec-fetch-site': 'cross-site' }), crossSite)
  assert.equal(crossSite.status, 403)
  assert.equal(confirmed, 0)
})
