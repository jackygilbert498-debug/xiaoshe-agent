import assert from 'node:assert/strict'
import test from 'node:test'

import { SettingsScopeController } from '../src/client/settings-scope.ts'
import { SettingsDescribeMirror } from '../src/client/settings-mirror.ts'

const BASE_NAMESPACE = {
  ns: 'demo',
  schema: { type: 'object' },
  value: { enabled: true },
  applies: 'live',
  secrets: [],
  revision: 1,
}

function responseFor(namespace) {
  return {
      ok: true,
      value: { writable: true, hasDocument: true, namespaces: [namespace] },
  }
}

function openScope(initialNamespace) {
  let namespace = initialNamespace
  const api = {
    settings: {
      describe: async () => responseFor(namespace),
      mutate: async () => { throw new Error('not used') },
    },
  }
  const context = { remote: api }
  const mirror = new SettingsDescribeMirror(context)
  const scope = new SettingsScopeController(
    context,
    { namespace: 'demo' },
    mirror,
    'host',
    { rehydrate: value => value, validate: () => undefined },
  )
  return {
    mirror,
    scope,
    setNamespace(value) { namespace = value },
  }
}

test('settings scope exposes Host degradation without promoting the last good value to ready', async t => {
  const fixture = openScope({
    ...BASE_NAMESPACE,
    status: 'degraded',
    error: 'Stored settings are invalid; a safe fallback remains active until repaired.',
  })
  t.after(async () => { await fixture.scope.dispose() })

  await fixture.mirror.load()

  assert.deepEqual(fixture.scope.getSnapshot(), {
    status: 'degraded',
    value: { enabled: true },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: false,
    mode: 'host',
    error: 'Stored settings are invalid; a safe fallback remains active until repaired.',
  })

  fixture.setNamespace({
    ...BASE_NAMESPACE,
    value: { enabled: false },
    revision: 2,
    status: 'ready',
    error: null,
  })
  await fixture.mirror.load()
  assert.equal(fixture.scope.getSnapshot().status, 'ready')
  assert.equal(fixture.scope.getSnapshot().error, null)
  assert.equal(fixture.scope.getSnapshot().writable, true)
})

test('settings scope accepts a legacy Host namespace but does not invent healthy status', async t => {
  const fixture = openScope(BASE_NAMESPACE)
  t.after(async () => { await fixture.scope.dispose() })

  await fixture.mirror.load()

  assert.equal(fixture.scope.getSnapshot().status, 'degraded')
  assert.match(fixture.scope.getSnapshot().error, /invalid|unavailable|cannot report/u)
  assert.equal(fixture.scope.getSnapshot().writable, false)
})
