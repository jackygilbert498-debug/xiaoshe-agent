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

test('late workspaceFiles namespace cannot leave a mounted file reader permanently unsupported', async () => {
  const { Context } = await loadUpstream('vendor/cordis/src/index.ts')
  const ctx = new Context()
  let reader
  const sessions = { list: { getSnapshot: () => ({ current: 'one' }), subscribe: () => () => {} }, binding: () => ({}) }
  ctx.inject(provider.inject, scope => {
    reader = new provider.DshRuntimeFiles(sessions, undefined, scope.remote.workspaceFiles, {
      getSnapshot: () => ({ sessionId: 'one', items: [{ sessionId: 'one', type: 'file', source: '/work/report.md' }] }),
    })
  })
  for (const name of provider.inject.filter(name => name !== 'remote.workspaceFiles')) ctx.provide(name, {})
  await new Promise(resolve => setImmediate(resolve))
  const identity = { absolutePath: '/work/report.md', version: 'v1', bytes: 5 }
  const workspaceFiles = {
    stat: async () => ({ ok: true, value: identity }),
    readBytes: async () => ({ ok: true, value: { ...identity, offset: 0, eof: true, data: 'aGVsbG8=' } }),
  }
  ctx.remote.workspaceFiles = workspaceFiles
  ctx.provide('remote.workspaceFiles', workspaceFiles)
  await new Promise(resolve => setImmediate(resolve))
  try {
    const result = await reader.read({ sessionId: 'one', path: '/work/report.md' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(new TextDecoder().decode(result.value.data), 'hello')
  } finally { reader?.dispose(); await ctx.fiber.dispose() }
})

for (const code of ['interrupted', 'ABORTED', 'ABORTED_BEFORE_DISPATCH']) test(`${code} tool is retained as a canceled action rather than an actionable tool failure`, () => {
  const sessions = { list: { getSnapshot: () => ({ current: 'one', byId: {} }), subscribe: () => () => {} }, binding: () => ({ session: {
    getSnapshot: () => ({ nodes: [{ kind: 'tool-result', seq: 7, call: { name: 'pwsh' }, content: [], isError: true, error: { name: 'AbortError', code } }] }), subscribe: () => () => {},
  } }) }
  const timeline = new provider.DshTaskTimeline(sessions)
  assert.equal(timeline.getSnapshot().items[0].text, '已取消：pwsh')
  assert.notEqual(timeline.getSnapshot().items[0].isError, true)
  timeline.dispose()
})

test('abort words in an ordinary failed tool cannot impersonate structured cancellation', () => {
  const sessions = { list: { getSnapshot: () => ({ current: 'one', byId: {} }), subscribe: () => () => {} }, binding: () => ({ session: {
    getSnapshot: () => ({ nodes: [{ kind: 'tool-result', seq: 7, call: { name: 'pwsh' }, isError: true,
      error: { name: 'AbortError', code: 'EXIT_1', message: 'tool call aborted' } }] }), subscribe: () => () => {},
  } }) }
  const timeline = new provider.DshTaskTimeline(sessions)
  assert.equal(timeline.getSnapshot().items[0].text, '失败：pwsh')
  assert.equal(timeline.getSnapshot().items[0].isError, true)
  timeline.dispose()
})

async function loadUpstream(relative) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../../../runtime/DSH/${relative}`, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

test('canonical and real DSH chat assembly both preserve structured cancellation and prior true failure', async () => {
  const { ConversationNodeAssembler } = await loadUpstream('packages/client/ui-conversation/src/client/conversation/assembler.ts')
  const { toolDefinition } = await loadUpstream('packages/client/ui-chat/src/client/conversation-nodes/tool.ts')
  const { chatViewDefinition } = await loadUpstream('packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts')
  const { foldTaskTimeline } = await loadUpstream('../../packages/task-timeline/src/index.ts')
  const event = (type, seq, data) => ({ type, seq, time: seq, data, ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}) })
  const events = [
    event('turn/start', 1, { turn: 1 }), event('step/start', 2, { turn: 1, step: 1 }),
    event('tool/call', 3, { turn: 1, step: 1, name: 'pwsh', callId: 'old', arguments: '{}' }),
    event('tool/result', 4, { turn: 1, step: 1, error: { code: 'EXIT_1', message: 'tool call aborted' }, message: {
      source: { kind: 'tool', callId: 'old' }, content: [{ type: 'tool-result', toolCallId: 'old', content: [], isError: true }] } }),
    event('step/end', 5, { turn: 1, step: 1 }), event('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', 66, { turn: 4 }), event('step/start', 68, { turn: 4, step: 1 }),
    event('tool/call', 75, { turn: 4, step: 1, name: 'pwsh', callId: 'call_00_VVzSpC3kYm1IySSxpkjL4464', arguments: '{}' }),
    event('tool/result', 76, { turn: 4, step: 1, error: { name: 'AbortError', code: 'ABORTED' }, message: {
      source: { kind: 'tool', callId: 'call_00_VVzSpC3kYm1IySSxpkjL4464' }, content: [{ type: 'tool-result', toolCallId: 'call_00_VVzSpC3kYm1IySSxpkjL4464', content: [{ type: 'text', text: 'Error: tool call aborted' }], isError: true }] } }),
    event('step/end', 77, { turn: 4, step: 1 }), event('turn/end', 78, { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  ]
  const assembler = new ConversationNodeAssembler({ entries: () => [toolDefinition], fallbackEntry: () => undefined }, { entries: () => [chatViewDefinition] })
  assembler.replaceWindow(events.map(event => ({ type: 'event', event })), false)
  assembler.activateTarget('chat'); assembler.flush()
  const chat = assembler.snapshot('chat')
  for (const canonical of [false, true]) {
    const sessions = { list: { getSnapshot: () => ({ current: 'qa', byId: { qa: { projectionValues: canonical ? { taskTimeline: foldTaskTimeline(events) } : {} } } }), subscribe: () => () => {} },
      binding: () => ({ session: { getSnapshot: () => chat.legacy, subscribe: () => () => {} } }) }
    const timeline = new provider.DshTaskTimeline(sessions)
    try {
      const rows = timeline.getSnapshot().items
      assert.equal(rows.find(row => row.seq === 76).text, '已取消：pwsh', `canonical=${canonical}`)
      assert.notEqual(rows.find(row => row.seq === 76).isError, true)
      assert.equal(rows.find(row => row.seq === 4).isError, true)
    } finally { timeline.dispose() }
  }
})

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
