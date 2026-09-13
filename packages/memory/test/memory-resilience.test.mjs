import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '../../../runtime/DSH/vendor/cordis/lib/index.js'
import { FileSettingsProvider } from '../../../runtime/DSH/packages/settings/settings-file/lib/index.js'
import {
  apply as applyMemory,
  createMemoryToolDefinitions,
  createMemoryService,
  memorySettingsSchema,
  registerMemoryHttpRoute,
} from '../lib/index.js'

let memoryClientModule
globalThis.window = {
  __ModuleLoader__: {
    load(definition) { memoryClientModule = definition.factory(() => ({})) },
  },
}
await import('../lib/client.js')
delete globalThis.window
const { MemoryLifecycleProvider } = memoryClientModule

const BASE = { revision: 0, entries: [], audit: [], usage: [] }
const TIMESTAMP = '2026-09-06T00:00:00.000Z'

function entry(id, text) {
  return {
    id,
    scope: 'global',
    text,
    state: 'active',
    version: 1,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  }
}

async function openSettings(filename) {
  const ctx = new Context()
  await ctx.plugin(FileSettingsProvider, { path: filename, watch: false })
  return ctx
}

function registerMemoryScope(ctx) {
  return ctx.settings.register('xiaoshe-memory', memorySettingsSchema, {
    base: BASE,
    applies: 'live',
    recoverInvalidStored: true,
  })
}

function memorySnapshot(diagnostics) {
  return {
    api_version: 1,
    revision: 0,
    counts: { active: 0, global: 0, project: 0, forgotten: 0, superseded: 0 },
    entries: [],
    audit: [],
    usage: [],
    ...(diagnostics === undefined ? {} : { diagnostics }),
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

test('memory list confines legacy and explicit model queries to global plus the caller project', async () => {
  const state = {
    revision: 3,
    entries: [
      entry('global-entry', 'Global memory'),
      { ...entry('project-a-entry', 'Project A memory'), scope: 'project', project: 'C:/work/a' },
      { ...entry('project-b-entry', 'Project B memory'), scope: 'project', project: 'C:/work/b' },
    ],
    audit: [],
    usage: [],
  }
  const service = createMemoryService({
    get: () => state,
    getSnapshot: () => ({ value: state, revision: 0, status: 'ready' }),
    watch: () => () => {},
    async update() { throw new Error('list must stay read-only') },
  })
  const list = createMemoryToolDefinitions(service).find(tool => tool.name === 'xiaoshe_memory_list')
  assert.ok(list)
  const signal = new AbortController().signal

  const scoped = await list.execute({}, {
    signal,
    agent: { session: { header: { cwd: 'C:/work/a' } } },
  })
  assert.deepEqual(scoped.entries.map(item => item.id), ['global-entry', 'project-a-entry'])

  const legacyAll = await list.execute({ scope: 'all' }, {
    signal,
    agent: { session: { header: { cwd: 'C:/work/a' } } },
  })
  assert.deepEqual(legacyAll.entries.map(item => item.id), ['global-entry', 'project-a-entry'])

  const globalOnly = await list.execute({ scope: 'global' }, {
    signal,
    agent: { session: { header: { cwd: 'C:/work/a' } } },
  })
  assert.deepEqual(globalOnly.entries.map(item => item.id), ['global-entry'])

  const currentProjectOnly = await list.execute({ scope: 'project', project: 'C:/work/a' }, {
    signal,
    agent: { session: { header: { cwd: 'C:/work/a' } } },
  })
  assert.deepEqual(currentProjectOnly.entries.map(item => item.id), ['project-a-entry'])

  const trustedManagementView = service.snapshot({ scope: 'all' })
  assert.deepEqual(trustedManagementView.entries.map(item => item.id), [
    'global-entry',
    'project-a-entry',
    'project-b-entry',
  ])

  await assert.rejects(
    list.execute({ scope: 'project', project: 'C:/must-not-leak-other-project' }, {
      signal,
      agent: { session: { header: { cwd: 'C:/work/a' } } },
    }),
    (error) => {
      assert.match(error.message, /current project/iu)
      assert.doesNotMatch(error.message, /must-not-leak/iu)
      return true
    },
  )

  await assert.rejects(
    list.execute({ scope: 'project' }, {
      signal,
      agent: { session: { header: { cwd: 'C:/work/a' } } },
    }),
    /project must be provided/u,
  )

  const withoutCallerProject = await list.execute({}, { signal })
  assert.deepEqual(withoutCallerProject.entries.map(item => item.id), ['global-entry'])
})

test('memory remember confines model writes to global plus the caller project without narrowing the trusted service', async () => {
  let state = { ...BASE }
  let settingsRevision = 0
  const ids = ['project-a-new', 'global-new', 'trusted-project-b-new']
  const service = createMemoryService({
    get: () => state,
    getSnapshot: () => ({ value: state, revision: settingsRevision, status: 'ready' }),
    watch: () => () => {},
    async update(section, expectedRevision) { return this.replace(section, expectedRevision) },
    async replace(section, expectedRevision) {
      assert.equal(expectedRevision, settingsRevision)
      state = section
      settingsRevision += 1
    },
  }, {
    createId: () => ids.shift(),
    now: () => new Date(TIMESTAMP),
  })
  const remember = createMemoryToolDefinitions(service).find(tool => tool.name === 'xiaoshe_memory_remember')
  assert.ok(remember)
  const signal = new AbortController().signal
  const projectA = { signal, agent: { session: { header: { cwd: 'C:/work/a' } } } }

  await assert.rejects(
    remember.execute({
      expected_revision: 0,
      scope: 'project',
      project: 'C:/must-not-leak-project-b',
      text: 'Cross-project write',
    }, projectA),
    (error) => {
      assert.match(error.message, /current project/iu)
      assert.doesNotMatch(error.message, /must-not-leak|project-b/iu)
      return true
    },
  )
  assert.equal(state.revision, 0)
  assert.deepEqual(state.entries, [])

  await assert.rejects(
    remember.execute({
      expected_revision: 0,
      scope: 'project',
      project: 'C:/work/a',
      text: 'Project write without a project context',
    }, { signal }),
    /current project/iu,
  )

  const currentProject = await remember.execute({
    expected_revision: 0,
    scope: 'project',
    project: 'C:\\WORK\\A\\',
    text: 'Current project memory',
  }, projectA)
  assert.deepEqual(currentProject.entries.map(item => item.id), ['project-a-new'])
  assert.equal(currentProject.entries[0].project, 'c:\\work\\a')

  const global = await remember.execute({
    expected_revision: 1,
    scope: 'global',
    text: 'Global memory',
  }, { signal })
  assert.deepEqual(global.entries.map(item => item.id), ['global-new'])

  await service.remember({
    scope: 'project',
    project: 'C:/work/b',
    text: 'Trusted project B memory',
  }, 2)
  assert.deepEqual(
    service.snapshot({ scope: 'all' }).entries.map(item => item.id),
    ['project-a-new', 'global-new', 'trusted-project-b-new'],
  )
})

test('memory set-state confines model writes to global plus the caller project without narrowing the trusted service', async () => {
  let state = {
    revision: 3,
    entries: [
      entry('global-entry', 'Global memory'),
      { ...entry('project-a-entry', 'Project A memory'), scope: 'project', project: 'c:\\work\\a' },
      { ...entry('project-b-entry', 'Project B memory'), scope: 'project', project: 'c:\\work\\b' },
    ],
    audit: [],
    usage: [],
  }
  let settingsRevision = 0
  const service = createMemoryService({
    get: () => state,
    getSnapshot: () => ({ value: state, revision: settingsRevision, status: 'ready' }),
    watch: () => () => {},
    async update(section, expectedRevision) { return this.replace(section, expectedRevision) },
    async replace(section, expectedRevision) {
      assert.equal(expectedRevision, settingsRevision)
      state = section
      settingsRevision += 1
    },
  }, { now: () => new Date(TIMESTAMP) })
  const setState = createMemoryToolDefinitions(service).find(tool => tool.name === 'xiaoshe_memory_set_state')
  assert.ok(setState)
  const signal = new AbortController().signal
  const projectA = { signal, agent: { session: { header: { cwd: 'C:/work/a' } } } }

  await assert.rejects(
    setState.execute({ expected_revision: 3, id: 'project-b-entry', state: 'forgotten' }, projectA),
    (error) => {
      assert.match(error.message, /current project/iu)
      assert.doesNotMatch(error.message, /project-b-entry/iu)
      return true
    },
  )
  assert.equal(state.revision, 3)
  assert.equal(state.entries.find(item => item.id === 'project-b-entry').state, 'active')

  await assert.rejects(
    setState.execute({ expected_revision: 3, id: 'project-a-entry', state: 'forgotten' }, { signal }),
    /current project/iu,
  )

  const currentProject = await setState.execute({
    expected_revision: 3,
    id: 'project-a-entry',
    state: 'forgotten',
  }, projectA)
  assert.deepEqual(
    currentProject.entries.map(item => [item.id, item.scope, item.project, item.state]),
    [['global-entry', 'global', undefined, 'active'], ['project-a-entry', 'project', 'c:\\work\\a', 'forgotten']],
  )

  const global = await setState.execute({
    expected_revision: 4,
    id: 'global-entry',
    state: 'forgotten',
  }, { signal })
  assert.deepEqual(
    global.entries.map(item => [item.id, item.scope, item.project, item.state]),
    [['global-entry', 'global', undefined, 'forgotten']],
  )

  await service.setState('project-b-entry', 'forgotten', 5)
  assert.deepEqual(
    service.snapshot({ scope: 'all', include_inactive: true }).entries.map(item => [item.id, item.state]),
    [
      ['global-entry', 'forgotten'],
      ['project-a-entry', 'forgotten'],
      ['project-b-entry', 'forgotten'],
    ],
  )
})

test('a project projection filters counts, audit ids, and usage metadata to global plus the exact project', () => {
  const state = {
    revision: 5,
    entries: [
      entry('global-entry', 'Global memory'),
      { ...entry('project-a-entry', 'Project A memory'), scope: 'project', project: 'c:\\work\\a' },
      { ...entry('project-a-forgotten', 'Forgotten A memory'), scope: 'project', project: 'c:\\work\\a', state: 'forgotten' },
      { ...entry('project-b-entry', 'Project B secret'), scope: 'project', project: 'c:\\work\\b' },
      { ...entry('project-b-forgotten', 'Forgotten B secret'), scope: 'project', project: 'c:\\work\\b', state: 'forgotten' },
    ],
    audit: [
      { revision: 1, action: 'create', entry_id: 'global-entry', at: TIMESTAMP },
      { revision: 2, action: 'create', entry_id: 'project-a-entry', at: TIMESTAMP },
      { revision: 3, action: 'forget', entry_id: 'project-a-forgotten', at: TIMESTAMP },
      { revision: 4, action: 'create', entry_id: 'project-b-entry', at: TIMESTAMP },
      { revision: 5, action: 'forget', entry_id: 'project-b-forgotten', at: TIMESTAMP },
    ],
    usage: [
      { entry_id: 'global-entry', count: 2, last_used_at: TIMESTAMP, last_session_id: 'session-global', last_project: 'c:\\work\\b' },
      { entry_id: 'project-a-entry', count: 1, last_used_at: TIMESTAMP, last_session_id: 'session-a', last_project: 'c:\\work\\a' },
      { entry_id: 'project-b-entry', count: 1, last_used_at: TIMESTAMP, last_session_id: 'session-b', last_project: 'c:\\work\\b' },
    ],
  }
  const service = createMemoryService({
    get: () => state,
    getSnapshot: () => ({ value: state, revision: 0, status: 'ready' }),
    watch: () => () => {},
    async update() { assert.fail('snapshot must stay read-only') },
  })

  const scoped = service.snapshot({ scope: 'all', project: 'C:\\WORK\\A\\', include_inactive: true })

  assert.deepEqual(scoped.entries.map(item => item.id), [
    'global-entry',
    'project-a-entry',
    'project-a-forgotten',
  ])
  assert.deepEqual(scoped.counts, {
    active: 2,
    global: 1,
    project: 1,
    forgotten: 1,
    superseded: 0,
  })
  assert.equal(scoped.project, 'c:\\work\\a')
  assert.deepEqual(scoped.audit.map(item => item.entry_id), [
    'global-entry',
    'project-a-entry',
    'project-a-forgotten',
  ])
  assert.deepEqual(scoped.usage, [
    { entry_id: 'global-entry', count: 2, last_used_at: TIMESTAMP, last_session_id: 'session-global' },
    { entry_id: 'project-a-entry', count: 1, last_used_at: TIMESTAMP, last_session_id: 'session-a', last_project: 'c:\\work\\a' },
  ])
  assert.doesNotMatch(JSON.stringify(scoped), /project-b|Project B|Forgotten B|work\\\\b|session-b/u)
})

test('a global-only projection does not disclose the last project that used a global memory', () => {
  const state = {
    revision: 1,
    entries: [entry('global-entry', 'Global memory')],
    audit: [{ revision: 1, action: 'create', entry_id: 'global-entry', at: TIMESTAMP }],
    usage: [{
      entry_id: 'global-entry',
      count: 1,
      last_used_at: TIMESTAMP,
      last_session_id: 'session-global',
      last_project: 'c:\\work\\private-project',
    }],
  }
  const service = createMemoryService({
    get: () => state,
    getSnapshot: () => ({ value: state, revision: 0, status: 'ready' }),
    watch: () => () => {},
    async update() { assert.fail('snapshot must stay read-only') },
  })

  const scoped = service.snapshot({ scope: 'global', include_inactive: true })

  assert.deepEqual(scoped.usage, [{
    entry_id: 'global-entry',
    count: 1,
    last_used_at: TIMESTAMP,
    last_session_id: 'session-global',
  }])
  assert.doesNotMatch(JSON.stringify(scoped), /private-project/u)
})

test('project remember and setState persist other projects but never return their content', async () => {
  let state = {
    revision: 2,
    entries: [
      entry('global-entry', 'Global memory'),
      { ...entry('project-a-entry', 'Project A memory'), scope: 'project', project: 'c:\\work\\a' },
      { ...entry('project-b-entry', 'Project B secret'), scope: 'project', project: 'c:\\work\\b' },
    ],
    audit: [
      { revision: 1, action: 'create', entry_id: 'project-a-entry', at: TIMESTAMP },
      { revision: 2, action: 'create', entry_id: 'project-b-entry', at: TIMESTAMP },
    ],
    usage: [],
  }
  let settingsRevision = 0
  const service = createMemoryService({
    get: () => state,
    getSnapshot: () => ({ value: state, revision: settingsRevision, status: 'ready' }),
    watch: () => () => {},
    async update(section, expectedRevision) { return this.replace(section, expectedRevision) },
    async replace(section, expectedRevision) {
      assert.equal(expectedRevision, settingsRevision)
      state = section
      settingsRevision += 1
    },
  }, { createId: () => 'project-a-new', now: () => new Date(TIMESTAMP) })

  const remembered = await service.remember({
    scope: 'project',
    project: 'C:\\WORK\\A\\',
    text: 'New A memory',
  }, 2)
  assert.deepEqual(remembered.entries.map(item => item.id), [
    'global-entry',
    'project-a-entry',
    'project-a-new',
  ])
  assert.equal(remembered.project, 'c:\\work\\a')
  assert.doesNotMatch(JSON.stringify(remembered), /project-b|Project B/u)
  assert.ok(state.entries.some(item => item.id === 'project-b-entry'), 'writeback must retain the hidden project')

  const forgotten = await service.setState('project-a-entry', 'forgotten', remembered.revision)
  assert.equal(forgotten.project, 'c:\\work\\a')
  assert.deepEqual(forgotten.entries.map(item => [item.id, item.state]), [
    ['global-entry', 'active'],
    ['project-a-entry', 'forgotten'],
    ['project-a-new', 'active'],
  ])
  assert.doesNotMatch(JSON.stringify(forgotten), /project-b|Project B/u)
  assert.ok(state.entries.some(item => item.id === 'project-b-entry'), 'state writeback must retain the hidden project')
})

async function invokeMemoryRoute(service, { method = 'GET', url = '/api/xiaoshe/memory', body } = {}) {
  let route
  registerMemoryHttpRoute({
    register(candidate) {
      route = candidate
      return () => {}
    },
  }, service)
  let status
  let payload = ''
  const request = {
    method,
    url,
    headers: {
      host: '127.0.0.1:3180',
      origin: 'http://127.0.0.1:3180',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield JSON.stringify(body)
    },
  }
  const response = {
    writeHead(nextStatus) {
      status = nextStatus
      return this
    },
    end(data = '') { payload = String(data) },
  }
  await route.handler(request, response)
  return { status, body: payload === '' ? undefined : JSON.parse(payload) }
}

test('settings registration remains fail-fast for corrupt sections unless recovery is explicitly enabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-settings-strict-'))
  const filename = join(directory, 'settings.json')
  await writeFile(filename, JSON.stringify({
    'xiaoshe-memory': { revision: 'broken' },
  }), 'utf8')
  const ctx = await openSettings(filename)
  try {
    assert.throws(
      () => ctx.settings.register('xiaoshe-memory', memorySettingsSchema, {
        base: BASE,
        applies: 'live',
      }),
      /memory revision must be a non-negative integer/u,
    )
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('two independent file providers merge concurrent usage writes instead of silently dropping one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-memory-cas-'))
  const filename = join(directory, 'settings.json')
  const initial = {
    'xiaoshe-memory': {
      revision: 2,
      entries: [entry('memory-a', 'first'), entry('memory-b', 'second')],
      audit: [],
      usage: [],
    },
  }
  await writeFile(filename, `${JSON.stringify(initial, null, 2)}\n`, 'utf8')

  const first = await openSettings(filename)
  const second = await openSettings(filename)
  try {
    const firstMemory = createMemoryService(registerMemoryScope(first))
    const secondMemory = createMemoryService(registerMemoryScope(second))

    await Promise.all([
      firstMemory.recordInjection({ sessionId: 'session-a', itemIds: ['memory-a'], at: TIMESTAMP }),
      secondMemory.recordInjection({ sessionId: 'session-b', itemIds: ['memory-b'], at: TIMESTAMP }),
    ])

    const stored = JSON.parse(await readFile(filename, 'utf8'))
    assert.deepEqual(
      stored['xiaoshe-memory'].usage.map(row => row.entry_id).sort(),
      ['memory-a', 'memory-b'],
    )
  } finally {
    await Promise.all([first.fiber.dispose(), second.fiber.dispose()])
    await rm(directory, { recursive: true, force: true })
  }
})

test('prompt assembly does not wait for the serialized usage audit and its rejection is observed safely', async () => {
  let promptRow
  let assemblyListener
  let provided
  const warnings = []
  const writeStarted = deferred()
  const releaseWrite = deferred()
  const state = {
    revision: 1,
    entries: [entry('memory-a', 'Keep replies concise.')],
    audit: [],
    usage: [],
  }
  const scope = {
    get: () => state,
    getSnapshot: () => ({ value: state, revision: 0, status: 'ready' }),
    watch: () => () => {},
    async update() {
      writeStarted.resolve()
      await releaseWrite.promise
      throw new Error('password=must-not-leak')
    },
    async replace() {
      writeStarted.resolve()
      await releaseWrite.promise
      throw new Error('password=must-not-leak')
    },
  }
  const ctx = {
    tools: { register: () => () => {} },
    settings: { register: () => scope },
    systemPrompt: {
      context(row) {
        promptRow = row
        return () => {}
      },
    },
    webServer: { register: () => () => {} },
    on(_event, listener) {
      assemblyListener = listener
      return () => {}
    },
    effect(execute) { return execute() },
    provide(_name, value) { provided = value },
    logger: { warn(message) { warnings.push(message) } },
  }
  applyMemory(ctx)

  const assemblyContext = { agent: { id: 'session-a', session: { header: {} } } }
  const text = promptRow.text(assemblyContext)
  const assembly = { contexts: [{ name: 'xiaoshe:memory', text }] }
  const assemblyCall = assemblyListener(assembly, assemblyContext, async () => assembly)
  const outcome = await Promise.race([
    assemblyCall.then(() => 'assembled'),
    new Promise(resolve => setTimeout(() => resolve('blocked-on-audit'), 50)),
  ])
  await writeStarted.promise
  releaseWrite.resolve()
  const result = await assemblyCall
  await waitFor(
    () => provided.service.snapshot().diagnostics.usage_persistence_failures === 1,
    'background usage audit did not publish a degraded diagnostic',
  )

  assert.equal(outcome, 'assembled')
  assert.strictEqual(result, assembly)
  assert.deepEqual(provided.service.snapshot().diagnostics, {
    persistence_status: 'degraded',
    usage_audit_status: 'degraded',
    usage_persistence_failures: 1,
    last_usage_persistence_error: 'MEMORY_USAGE_PERSISTENCE_FAILED',
    last_usage_persistence_error_at: provided.service.snapshot().diagnostics.last_usage_persistence_error_at,
  })
  assert.ok(Number.isFinite(Date.parse(provided.service.snapshot().diagnostics.last_usage_persistence_error_at)))
  assert.deepEqual(warnings, ['xiaoshe memory usage audit persistence is degraded'])
  assert.doesNotMatch(JSON.stringify(provided.service.snapshot().diagnostics), /password|must-not-leak/u)
})

test('every usage-audit failure degrades sanitized diagnostics and emits only the fixed warning', async () => {
  let promptRow
  let assemblyListener
  let provided
  const warnings = []
  let state = {
    revision: 1,
    entries: [entry('memory-secret-id', 'Keep replies concise.')],
    audit: [],
    usage: [],
  }
  let settingsRevision = 0
  const scope = {
    get: () => state,
    getSnapshot: () => ({ value: state, revision: settingsRevision, status: 'ready' }),
    watch: () => () => {},
    async update(section) { return this.replace(section) },
    async replace(section) { state = section; settingsRevision += 1 },
  }
  applyMemory({
    tools: { register: () => () => {} },
    settings: { register: () => scope },
    systemPrompt: { context(row) { promptRow = row; return () => {} } },
    webServer: { register: () => () => {} },
    on(_event, listener) { assemblyListener = listener; return () => {} },
    effect(execute) { return execute() },
    provide(_name, value) { provided = value },
    logger: { warn(message) { warnings.push(message) } },
  })

  const assemblyContext = { agent: { id: 'session-with-secret', session: { header: {} } } }
  const text = promptRow.text(assemblyContext)
  state = { revision: 1, entries: [], audit: [], usage: [] }
  const assembly = { contexts: [{ name: 'xiaoshe:memory', text }] }
  assert.strictEqual(await assemblyListener(assembly, assemblyContext, async () => assembly), assembly)
  await waitFor(
    () => provided.service.snapshot().diagnostics.usage_persistence_failures === 1,
    'validation failure was not reflected in usage diagnostics',
  )

  assert.equal(provided.service.snapshot().diagnostics.persistence_status, 'ready')
  assert.equal(provided.service.snapshot().diagnostics.usage_audit_status, 'degraded')
  assert.deepEqual(warnings, ['xiaoshe memory usage audit persistence is degraded'])
  assert.doesNotMatch(JSON.stringify({ warnings, diagnostics: provided.service.snapshot().diagnostics }), /secret|memory-secret-id/u)

  await assert.rejects(
    provided.service.recordInjection({ sessionId: 'password=must-not-leak', itemIds: 'not-an-array' }),
    /itemIds/u,
  )
  assert.equal(provided.service.snapshot().diagnostics.usage_persistence_failures, 2)
  assert.deepEqual(warnings, [
    'xiaoshe memory usage audit persistence is degraded',
    'xiaoshe memory usage audit persistence is degraded',
  ])
  assert.doesNotMatch(JSON.stringify({ warnings, diagnostics: provided.service.snapshot().diagnostics }), /password|must-not-leak/u)

  await provided.service.recordInjection({ sessionId: 'no-op', itemIds: [] })
  assert.equal(provided.service.snapshot().diagnostics.usage_audit_status, 'degraded')
  assert.equal(provided.service.snapshot().diagnostics.usage_persistence_failures, 2)

  state = {
    revision: 1,
    entries: [entry('memory-secret-id', 'Keep replies concise.')],
    audit: [],
    usage: [],
  }
  await provided.service.recordInjection({
    sessionId: 'session-recovered', itemIds: ['memory-secret-id'], at: TIMESTAMP,
  })
  assert.equal(provided.service.snapshot().diagnostics.usage_audit_status, 'ready')
  assert.equal(provided.service.snapshot().diagnostics.persistence_status, 'ready')
  assert.equal(provided.service.snapshot().diagnostics.usage_persistence_failures, 2)
  assert.equal(provided.service.snapshot().usage[0].count, 1)
})

test('memory marks ENOSPC, permission, writer-lock, and exhausted CAS writes degraded', async () => {
  const failures = [
    Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    new Error('atomic-write: timed out waiting for the writer lock at C:/private/settings.lock'),
    Object.assign(new Error('sustained contention'), { code: 'SETTINGS_CONFLICT' }),
  ]
  for (const [index, failure] of failures.entries()) {
    const state = { revision: 0, entries: [], audit: [], usage: [] }
    const service = createMemoryService({
      get: () => state,
      getSnapshot: () => ({ value: state, revision: 0, status: 'ready' }),
      watch: () => () => {},
      async update() { throw failure },
      async replace() { throw failure },
    }, { createId: () => `memory-${index}`, now: () => new Date(TIMESTAMP) })
    await assert.rejects(service.remember({ scope: 'global', text: 'safe' }, 0))
    assert.equal(service.snapshot().diagnostics.persistence_status, 'degraded')
    assert.doesNotMatch(JSON.stringify(service.snapshot().diagnostics), /private|settings\.lock|permission|disk/u)
  }
})

test('a faulty audit clock cannot suppress the degraded diagnostic or fixed failure observer', async () => {
  const state = { revision: 0, entries: [], audit: [], usage: [] }
  let failures = 0
  const service = createMemoryService({
    get: () => state,
    getSnapshot: () => ({ value: state, revision: 0, status: 'ready' }),
    watch: () => () => {},
    async update() { assert.fail('invalid audit must not write') },
    async replace() { assert.fail('invalid audit must not write') },
  }, {
    now: () => new Date(Number.NaN),
    onUsageAuditFailure() { failures += 1 },
  })

  await assert.rejects(service.recordInjection({ sessionId: 'session-a', itemIds: ['missing'] }))
  const diagnostics = service.snapshot().diagnostics
  assert.equal(failures, 1)
  assert.equal(diagnostics.usage_audit_status, 'degraded')
  assert.equal(diagnostics.usage_persistence_failures, 1)
  assert.ok(Number.isFinite(Date.parse(diagnostics.last_usage_persistence_error_at)))
})

test('memory persistence status follows the latest real write failure and recovers after a successful write', async () => {
  let state = { revision: 0, entries: [], audit: [], usage: [] }
  let settingsRevision = 0
  let failWrites = true
  const scope = {
    get: () => state,
    getSnapshot: () => ({ value: state, revision: settingsRevision, status: 'ready' }),
    watch: () => () => {},
    async update(section) { return this.replace(section) },
    async replace(section) {
      if (failWrites) throw Object.assign(new Error('disk path and token must-not-leak'), { code: 'ENOSPC' })
      state = section
      settingsRevision += 1
    },
  }
  const service = createMemoryService(scope, { createId: () => 'memory-a', now: () => new Date(TIMESTAMP) })

  await assert.rejects(service.remember({ scope: 'global', text: 'first' }, 0), /memory persistence failed/u)
  assert.equal(service.snapshot().diagnostics.persistence_status, 'degraded')

  failWrites = false
  const repaired = await service.remember({ scope: 'global', text: 'first' }, 0)
  assert.equal(repaired.diagnostics.persistence_status, 'ready')
  assert.equal(service.snapshot().diagnostics.persistence_status, 'ready')
})

test('memory HTTP uses a fixed 500 response and forwards ready or degraded diagnostics without leaking storage errors', async () => {
  const secret = 'C:/private/profile token=must-not-leak'
  const failingService = {
    snapshot() { throw new Error(secret) },
    async remember() { throw new Error(secret) },
    async setState() { throw new Error(secret) },
    injection() { throw new Error('not used') },
    async recordInjection() {},
  }
  const getFailure = await invokeMemoryRoute(failingService)
  const postFailure = await invokeMemoryRoute(failingService, {
    method: 'POST',
    body: { action: 'remember', expected_revision: 0, scope: 'global', text: 'safe' },
  })
  assert.equal(getFailure.status, 500)
  assert.equal(postFailure.status, 500)
  assert.deepEqual(getFailure.body, { error: 'memory service is temporarily unavailable', kind: 'MEMORY_RUNTIME_ERROR' })
  assert.deepEqual(postFailure.body, getFailure.body)
  assert.doesNotMatch(JSON.stringify([getFailure, postFailure]), /private|token|must-not-leak/u)

  for (const persistence_status of ['ready', 'degraded']) {
    const diagnostics = { persistence_status, usage_audit_status: 'ready', usage_persistence_failures: 0 }
    const response = await invokeMemoryRoute({ ...failingService, snapshot: () => memorySnapshot(diagnostics) })
    assert.equal(response.status, 200)
    assert.equal(response.body.diagnostics.persistence_status, persistence_status)
  }
})

test('memory Client distinguishes ready and degraded Hosts, tolerates an old Host, and rejects malformed diagnostics', async () => {
  async function load(snapshot) {
    const provider = new MemoryLifecycleProvider(async () => new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    try {
      await provider.refresh()
      return provider.getSnapshot()
    } finally {
      provider.dispose()
    }
  }

  const ready = await load(memorySnapshot({
    persistence_status: 'ready', usage_audit_status: 'ready', usage_persistence_failures: 0,
  }))
  assert.equal(ready.status, 'ready')

  const degraded = await load(memorySnapshot({
    persistence_status: 'degraded', usage_audit_status: 'ready', usage_persistence_failures: 0,
  }))
  assert.equal(degraded.status, 'degraded')
  assert.equal(degraded.memory.diagnostics.persistence_status, 'degraded')

  const oldHost = await load(memorySnapshot())
  assert.equal(oldHost.status, 'degraded')
  assert.equal(oldHost.memory.diagnostics.persistence_status, 'degraded')

  const malformed = new MemoryLifecycleProvider(async () => new Response(JSON.stringify(memorySnapshot({
    persistence_status: 'unknown', usage_audit_status: 'ready', usage_persistence_failures: 0,
  })), { status: 200 }))
  await assert.rejects(malformed.refresh(), /invalid diagnostics/u)
  assert.equal(malformed.getSnapshot().status, 'error')
  malformed.dispose()

  const explicitNull = new MemoryLifecycleProvider(async () => new Response(JSON.stringify({
    ...memorySnapshot(), diagnostics: null,
  }), { status: 200 }))
  await assert.rejects(explicitNull.refresh(), /invalid diagnostics/u)
  assert.equal(explicitNull.getSnapshot().status, 'error')
  explicitNull.dispose()
})

test('memory Client preserves the Host-canonical project key for native consumers', async () => {
  const provider = new MemoryLifecycleProvider(async () => new Response(JSON.stringify({
    ...memorySnapshot({
      persistence_status: 'ready', usage_audit_status: 'ready', usage_persistence_failures: 0,
    }),
    project: 'c:\\work\\mixed-case',
  }), { status: 200 }))
  try {
    const snapshot = await provider.refresh({ scope: 'all', project: 'C:\\Work\\Mixed-Case' })
    assert.equal(snapshot.project, 'c:\\work\\mixed-case')
    assert.equal(provider.getSnapshot().memory.project, 'c:\\work\\mixed-case')
  } finally {
    provider.dispose()
  }
})

test('corrupt memory namespace boots degraded, rejects malformed writes, and is repaired by a strict service write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-memory-recovery-'))
  const filename = join(directory, 'settings.json')
  await writeFile(filename, JSON.stringify({
    'xiaoshe-memory': { revision: 'broken', entries: [{ password: 'must-not-leak' }] },
  }), 'utf8')
  const providerContext = await openSettings(filename)
  let scope
  let provided
  try {
    applyMemory({
      tools: { register: () => () => {} },
      settings: {
        register(namespace, schema, options) {
          scope = providerContext.settings.register(namespace, schema, options)
          return scope
        },
      },
      systemPrompt: { context: () => () => {} },
      webServer: { register: () => () => {} },
      on: () => () => {},
      effect: () => undefined,
      provide(_name, value) { provided = value },
    })

    assert.equal(provided.service.snapshot().diagnostics.persistence_status, 'degraded')
    assert.deepEqual(provided.service.snapshot().entries, [])
    assert.doesNotMatch(JSON.stringify(provided.service.snapshot()), /password|must-not-leak/u)
    await assert.rejects(
      scope.update(BASE, scope.getSnapshot().revision),
      /is degraded and requires a valid replacement/u,
    )
    await assert.rejects(
      scope.replace({ revision: 'still-broken' }, scope.getSnapshot().revision),
      /memory revision must be a non-negative integer/u,
    )

    const repaired = await provided.service.remember({ scope: 'global', text: 'Recovered.' }, 0)
    assert.equal(repaired.diagnostics.persistence_status, 'ready')
    assert.equal(repaired.entries.length, 1)
    const stored = await readFile(filename, 'utf8')
    assert.doesNotMatch(stored, /password|must-not-leak|still-broken/u)
  } finally {
    await providerContext.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
