import assert from 'node:assert/strict'
import test from 'node:test'
import * as provider from './.generated/client.mjs'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

for (const failure of ['rpc', 'transport']) test(`model selection ${failure} failure still drains a newer authoritative projection`, async () => {
  const { ProjectionValueStore } = await loadUpstream('packages/api/session-controller/src/client/sessions/projection-store.ts')
  const store = new ProjectionValueStore()
  store.apply('modelSelection', { next: { provider: 'p', model: 'before' } }, 1)
  const sessions = { list: { getSnapshot: () => ({ current: 'one' }), subscribe: () => () => {} }, binding: () => ({ session: { projections: store } }) }
  let resolveSelection, rejectSelection
  const connection = provider.createRemoteConnection({ session: {
    modelCatalog: async () => ({ ok: true, value: { default: { provider: 'p', model: 'default' }, routableProviders: ['p'], groups: [], failures: [] } }),
    selectModel: () => new Promise((resolve, reject) => { resolveSelection = resolve; rejectSelection = reject }),
  } }, sessions)
  const catalog = new provider.DshModelCatalog(sessions, connection)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  await settle()
  const command = catalog.select({ provider: 'p', model: 'requested' })
  store.apply('modelSelection', { next: { provider: 'p', model: 'authoritative-after' } }, 2)
  if (failure === 'rpc') resolveSelection({ ok: false, error: { code: 'unavailable', message: 'receipt unavailable' } })
  else rejectSelection(new Error('receipt lost'))
  assert.equal((await command).ok, false, 'state readback must not forge a successful command receipt')
  await settle()
  assert.equal(catalog.getSnapshot().current.model, 'authoritative-after')
  catalog.dispose()
})

test('loading history does not count as a zero-item pagination baseline', () => {
  let snapshot = { projectionReady: false, nodes: [] }
  let changed
  const sessions = { list: { getSnapshot: () => ({ current: 'one', byId: {} }), subscribe: () => () => {} },
    binding: () => ({ session: { getSnapshot: () => snapshot, subscribe: fn => { changed = fn; return () => {} } } }) }
  const timeline = new provider.DshTaskTimeline(sessions)
  assert.equal(timeline.getSnapshot().loading, true)
  snapshot = { projectionReady: true, nodes: Array.from({ length: 500 }, (_, seq) => ({
    id: String(seq), kind: 'message', message: { id: String(seq), role: 'user', content: [{ type: 'text', text: String(seq) }] },
  })) }
  changed()
  assert.equal(timeline.getSnapshot().total, 500)
  assert.equal(timeline.getSnapshot().items.length, 160)
  assert.equal(timeline.getSnapshot().hasEarlier, true)
  timeline.dispose()
})

test('bootstrap waits only on new public service names', () => {
  assert.equal(provider.inject.includes('conversationEvents'), false)
  assert.equal(provider.inject.includes('conversationViews'), false)
  assert.equal(provider.inject.includes('uiConversation'), true)
  assert.equal(provider.inject.includes('remote.session'), true)
  assert.equal(provider.inject.includes('remote.skills'), true)
  assert.equal(provider.inject.includes('remote.subagents'), true)
})

async function loadUpstream(relative) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../../../runtime/DSH/${relative}`, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

test('new Remote namespaces preserve model result and session projection', async () => {
  assert.equal(typeof provider.createRemoteConnection, 'function')
  const connection = provider.createRemoteConnection({
    session: { modelCatalog: async () => ({ ok: true, value: { default: { provider: 'p', model: 'default' }, routableProviders: ['p'], groups: [], failures: [] } }), selectModel: async input => ({ ok: true, value: { selected: input, persistence: { status: 'session-only', warning: 'disk denied' } } }) },
  }, { binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => ({ next: { provider: 'p', model: 'selected' } }) }) } } }) })
  const models = await connection.api.sessions.models({ sessionId: 'one' })
  assert.equal(models.result.value.current.model, 'selected')
  assert.equal(models.result.value.routable, true)
  const selected = await connection.api.sessions.selectModel({ sessionId: 'one', provider: 'p', model: 'm' })
  assert.equal(selected.result.value.persistence.status, 'session-only')
})

test('missing scoped skill service rejects explicitly and preserves Remote failures', async () => {
  assert.equal(typeof provider.createRemoteConnection, 'function')
  const failure = { ok: false, error: { code: 'gateway/unavailable', message: 'offline' } }
  const connection = provider.createRemoteConnection({ session: { modelCatalog: async () => failure } }, { binding: () => undefined, scope: () => undefined })
  assert.deepEqual((await connection.api.sessions.models({ sessionId: 'one' })).result, failure)
  await assert.rejects(connection.api.skills.list({ sessionId: 'one' }), /skills.*unavailable/)
})

test('workspace adapter reads new phase and delegates navigation', async () => {
  assert.equal(typeof provider.createWorkspaceCompatibility, 'function')
  const workspaces = provider.createWorkspaceCompatibility({ list: { getSnapshot: () => ({ phase: 'ready', items: [], archivedSessionIds: [], state: 'idle', error: null }), subscribe: () => () => {} } }, { connectWorkspace: async id => `session:${id}`, pickDirectory: async () => 'C:/test' })
  assert.equal(workspaces.list.getSnapshot().baselinesReady, true)
  assert.equal(await workspaces.connectWorkspace('one'), 'session:one')
  await assert.rejects(workspaces.moveSessionToWorkspace('one', 'two'), /unavailable/)
})

test('workspace transfer preserves history and archives only after successful target creation', async () => {
  let blank = false
  let fail = false
  const calls = []
  const source = { list: { getSnapshot: () => ({ phase: 'ready', items: [{ workspaceId: 'target', path: 'C:/target' }] }), subscribe: () => () => {} }, archiveSession: async id => calls.push(['archive', id]) }
  const sessions = { list: { getSnapshot: () => ({ byId: { one: { blank } } }) },
    create: async input => { calls.push(['create', input]); return 'new-empty' },
    fork: async input => { calls.push(['fork', input]); if (fail) throw new Error('fork failed'); return 'new-history' },
    open: id => calls.push(['open', id]),
  }
  const workspaces = provider.createWorkspaceCompatibility(source, {}, sessions)
  assert.equal(await workspaces.moveSessionToWorkspace('one', 'target'), 'new-history')
  assert.deepEqual(calls, [['fork', { sessionId: 'one', workspaceId: 'target', increaseTitle: false }], ['archive', 'one'], ['open', 'new-history']])
  calls.length = 0; blank = true
  assert.equal(await workspaces.moveSessionToWorkspace('one', 'target'), 'new-empty')
  assert.deepEqual(calls[0], ['create', { workspaceId: 'target' }])
  calls.length = 0; blank = false; fail = true
  await assert.rejects(workspaces.moveSessionToWorkspace('one', 'target'), /fork failed/)
  assert.equal(calls.length, 1, 'failed transfer must leave original unarchived')
  calls.length = 0
  await assert.rejects(workspaces.moveSessionToWorkspace('one', 'unknown'), /unknown workspace/)
  assert.equal(calls.length, 0)
})

test('session adapter uses canonical chat target and interaction owner; releases every subscription', async () => {
  assert.equal(typeof provider.createSessionCompatibility, 'function')
  let subscriptions = 0
  const subscribe = () => { subscriptions++; return () => { subscriptions-- } }
  let outcome
  const interaction = { key: 'approval:1', sessionId: 'one', kind: 'approval', toolName: 'write', answer: async value => { outcome = value } }
  const pending = { getSnapshot: () => new Map([['one', interaction]]), subscribe }
  const legacy = { nodes: [{ kind: 'assistant', text: 'streamed' }], partial: { text: 'live' } }
  const views = { get: target => target === 'chat' ? { legacy } : undefined }
  const session = { getSnapshot: () => ({ queue: [] }), subscribe, cancel: async () => ({ ok: true, value: { accepted: true } }) }
  const source = { list: { getSnapshot: () => ({ current: 'one', ids: ['one'], byId: { one: { id: 'one' } } }), subscribe }, binding: () => ({ session }), create: async input => { assert.equal(input, undefined); return 'created' } }
  const adapted = provider.createSessionCompatibility(source, { binding: () => ({ activate() {}, snapshot: { getSnapshot: () => ({ views }), subscribe } }) }, pending)
  const face = adapted.binding('one').session
  const stop = face.subscribe(() => {})
  assert.equal(subscriptions, 3)
  assert.equal(face.getSnapshot().partial.text, 'live')
  assert.equal(adapted.list.getSnapshot().byId.one.pendingInteraction, interaction)
  await face.getSnapshot().pending[0].respond({ ok: true, value: { outcome: 'allowed-once' } })
  assert.equal(outcome, 'allowed-once')
  stop()
  assert.equal(subscriptions, 0)
  assert.equal(await adapted.create({ loose: true }), 'created')
})

test('late canonical chat registration remains observable without breaking startup', () => {
  let chat
  let changed
  const snapshot = { getSnapshot: () => ({ views: { get: () => chat } }), subscribe: listener => { changed = listener; return () => {} } }
  const sessions = provider.createSessionCompatibility({ binding: () => ({ session: { getSnapshot: () => ({ queue: [] }), subscribe: () => () => {} } }) },
    { binding: () => ({ activate() {}, snapshot }) }, { getSnapshot: () => new Map(), subscribe: () => () => {} })
  const face = sessions.binding('one').session
  assert.deepEqual(face.getSnapshot().nodes, [])
  assert.equal(face.getSnapshot().partial, null)
  let observed
  const release = face.subscribe(() => { observed = face.getSnapshot().nodes })
  chat = { legacy: { nodes: [{ text: 'restored history' }], partial: null } }
  changed()
  assert.deepEqual(observed, chat.legacy.nodes)
  release()
})

test('model catalog waits for projection readiness and follows same-session changes', async () => {
  const { ProjectionValueStore } = await loadUpstream('packages/api/session-controller/src/client/sessions/projection-store.ts')
  const store = new ProjectionValueStore()
  const sessions = { list: { getSnapshot: () => ({ current: 'one' }), subscribe: () => () => {} }, binding: () => ({ session: { projections: store } }) }
  let requests = 0
  const connection = provider.createRemoteConnection({ session: { modelCatalog: async () => {
    requests++
    return { ok: true, value: { default: { provider: 'p', model: 'default' }, routableProviders: ['p'], groups: [], failures: [] } }
  } } }, sessions)
  const catalog = new provider.DshModelCatalog(sessions, connection)
  const settle = () => new Promise(resolve => setImmediate(resolve))
  await settle()
  assert.equal(catalog.getSnapshot().status, 'loading')
  assert.equal(requests, 0)
  store.apply('modelSelection', { next: { provider: 'p', model: 'first' } }, 1)
  await settle()
  assert.equal(catalog.getSnapshot().status, 'ready')
  assert.equal(catalog.getSnapshot().current.model, 'first')
  store.apply('modelSelection', { next: { provider: 'p', model: 'changed-elsewhere' } }, 2)
  await settle()
  assert.equal(catalog.getSnapshot().current.model, 'changed-elsewhere')
  catalog.dispose()
  const count = requests
  store.apply('modelSelection', { next: { provider: 'p', model: 'after-dispose' } }, 3)
  await settle()
  assert.equal(requests, count)
})

test('real upstream approval and question carriers preserve one-shot settlement and cancellation', async () => {
  const { PendingApproval } = await loadUpstream('packages/client/ui-approval/src/client/contract/slots.ts')
  const { PendingQuestion } = await loadUpstream('packages/client/ui-user-questions/src/client/contract/slots.ts')
  let current = new PendingApproval('one', { toolName: 'write' })
  const source = { binding: () => ({ session: { getSnapshot: () => ({}), subscribe: () => () => {} } }) }
  const conversation = { binding: () => ({ activate() {}, snapshot: { getSnapshot: () => ({ views: { get: () => ({ legacy: { nodes: [] } }) } }) } }) }
  const sessions = provider.createSessionCompatibility(source, conversation, { getSnapshot: () => new Map([['one', current]]) })
  let wait = sessions.binding('one').session.getSnapshot().pending[0]
  await wait.respond({ ok: true, value: { outcome: 'allowed-once' } })
  assert.equal(await current.result, 'allowed-once')
  await assert.rejects(wait.respond({ ok: true, value: { outcome: 'allowed-once' } }), /already settled/)
  const controller = new AbortController()
  current = new PendingQuestion('one', [{ id: 'q', question: 'Proceed?' }], controller.signal)
  const aborted = assert.rejects(current.result, /aborted/)
  wait = sessions.binding('one').session.getSnapshot().pending[0]
  controller.abort()
  await aborted
  await assert.rejects(wait.respond({ ok: true, value: { answer: { answers: [] } } }), /already settled/)
})

test('late permission response cannot overwrite another session or a disposed provider', async () => {
  let id = 'one'
  let changed
  let settle
  const sessions = {
    list: { getSnapshot: () => ({ current: id }), subscribe: listener => { changed = listener; return () => {} } },
    binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => ({ currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'strict', name: 'Strict' }] }) }) }, command: () => new Promise(resolve => { settle = resolve }) } }),
  }
  const permissions = new provider.DshPermissionPresets(sessions)
  const first = permissions.select('strict')
  id = 'two'; changed()
  settle({ ok: true, value: { matched: true } })
  assert.equal((await first).ok, false)
  assert.equal(permissions.getSnapshot().currentValue, 'default')
  const second = permissions.select('strict')
  permissions.dispose()
  settle({ ok: true, value: { matched: true } })
  assert.equal((await second).ok, false)
})
