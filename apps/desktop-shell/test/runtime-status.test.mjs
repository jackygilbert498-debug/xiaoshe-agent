import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { registerRuntimeRoutes } from '../../../dist/runtime-control.js'

test('desktop status returns the launcher-provided runtime identity', async () => {
  let statusRoute
  const server = { register(route) { if (route.name === 'xiaoshe-desktop-status') statusRoute = route; return () => {} } }
  registerRuntimeRoutes(server, {
    bridge: { request: async () => ({ protocol_version: '1', platform: 'test' }) },
    actions: { deploymentAllowed: true, enabled: true },
    settings: { get: () => ({ responseStyle: 'pragmatic' }) },
    setActionsEnabled: async () => {}, setResponseStyle: async () => {}, modlensAvailable: () => true,
    memory: {}, brandIconPath: 'unused.svg', version: '0.2.0', runtimeIdentity: 'a'.repeat(64),
  })
  assert.ok(statusRoute)
  const request = Object.assign(new EventEmitter(), { method: 'GET', headers: { host: '127.0.0.1:3080' } })
  let status; let body = ''
  const response = {
    writeHead(value) { status = value; return this },
    end(value = '') { body += String(value); return this },
  }
  await statusRoute.handler(request, response)
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).runtime_identity, 'a'.repeat(64))
})
