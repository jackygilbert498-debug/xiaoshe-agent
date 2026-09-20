import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKBENCH_BASE_PATH, registerCodingWorkbenchHttpRoutes } from '../lib/http.js'
import { WorkbenchRecoveryError } from '../lib/patch.js'
import { WorkbenchStorageError } from '../lib/transactions.js'

function fixture() {
  const routes = new Map()
  const calls = []
  const server = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const service = new Proxy({}, {
    get(_target, property) {
      return (...args) => {
        calls.push({ property, args })
        return property === 'cancel' ? true : { operation: property, args }
      }
    },
  })
  const release = registerCodingWorkbenchHttpRoutes(server, service)
  return { routes, calls, release }
}

function request({ method = 'GET', headers = {}, body = '' } = {}) {
  const iterator = (async function * chunks() { if (body !== '') yield body })()
  return Object.assign(iterator, {
    method,
    headers: {
      host: '127.0.0.1:3180',
      origin: 'http://127.0.0.1:3180',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
  })
}

function response() {
  const result = { status: undefined, headers: undefined, body: undefined }
  const target = {
    writeHead(status, headers) { result.status = status; result.headers = headers; return target },
    end(body) { result.body = body },
  }
  return { target, result }
}

async function invoke(route, input) {
  const output = response()
  await route.handler(input, output.target)
  return output.result
}

test('coding workbench routes expose bounded same-origin operations and release cleanly', async () => {
  const { routes, calls, release } = fixture()
  assert.equal(routes.size, 12)
  const status = await invoke(routes.get(`${WORKBENCH_BASE_PATH}/status`), request())
  assert.equal(status.status, 200)
  assert.equal(JSON.parse(status.body).operation, 'snapshot')

  const read = await invoke(routes.get(`${WORKBENCH_BASE_PATH}/read`), request({
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ workspaceId: 'workspace-1', path: 'src/index.ts' }),
  }))
  assert.equal(read.status, 200)
  assert.deepEqual(calls.at(-1), { property: 'read', args: ['workspace-1', 'src/index.ts'] })
  const recovered = await invoke(routes.get(`${WORKBENCH_BASE_PATH}/write/recover`), request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'write-1' }) }))
  assert.equal(recovered.status, 200)
  assert.deepEqual(calls.at(-1), { property: 'recoverWrite', args: ['write-1'] })
  release()
  assert.equal(routes.size, 0)
})

test('coding workbench routes reject cross-site, scheme-mismatched, oversized, and wrong-method requests', async () => {
  const { routes, calls } = fixture()
  const tree = routes.get(`${WORKBENCH_BASE_PATH}/tree`)

  const crossSite = await invoke(tree, request({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' }))
  assert.equal(crossSite.status, 403)

  const schemeMismatch = await invoke(tree, request({ method: 'POST', headers: { origin: 'https://127.0.0.1:3180', 'content-type': 'application/json' }, body: '{}' }))
  assert.equal(schemeMismatch.status, 403)

  const wrongMethod = await invoke(tree, request())
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')

  const oversized = await invoke(tree, request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"workspaceId":"${'x'.repeat(2 * 1024 * 1024)}"}` }))
  assert.equal(oversized.status, 400)
  assert.equal(JSON.parse(oversized.body).kind, 'INVALID_WORKBENCH_REQUEST')
  assert.equal(calls.length, 0)
})

test('HTTP distinguishes durable recovery intent from failed intent persistence', async () => {
  for (const error of [new WorkbenchRecoveryError('write-1'), new WorkbenchStorageError()]) {
    const routes = new Map()
    registerCodingWorkbenchHttpRoutes({ register(route) { routes.set(route.path, route); return () => {} } }, { confirmWrite() { throw error } })
    const output = await invoke(routes.get(`${WORKBENCH_BASE_PATH}/write/confirm`), request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'write-1', token: 'private-request-token' }) }))
    const value = JSON.parse(output.body)
    assert.equal(value.kind, error.code)
    assert.equal(output.status, error instanceof WorkbenchRecoveryError ? 409 : 503)
    assert.equal(value.recoveryRequired, error instanceof WorkbenchRecoveryError ? true : undefined)
    assert.ok(!output.body.includes('private-request-token'))
  }
})
