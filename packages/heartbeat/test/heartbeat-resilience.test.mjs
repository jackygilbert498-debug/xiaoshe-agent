import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '../../../runtime/DSH/vendor/cordis/lib/index.js'
import { FileSettingsProvider } from '../../../runtime/DSH/packages/settings/settings-file/lib/index.js'
import {
  apply as applyHeartbeat,
  createHeartbeatCoordinator,
  createHeartbeatService,
  publicHeartbeatSnapshot,
  registerHeartbeatHttpRoute,
} from '../lib/index.js'

let heartbeatClientModule
globalThis.window = {
  __ModuleLoader__: {
    load(definition) { heartbeatClientModule = definition.factory(() => ({})) },
  },
}
await import('../lib/client.js')
delete globalThis.window
const { ProductHealthProvider } = heartbeatClientModule

async function openSettings(filename) {
  const ctx = new Context()
  await ctx.plugin(FileSettingsProvider, { path: filename, watch: false })
  return ctx
}

async function invokeHeartbeatRequest(service, {
  method = 'GET',
  body,
  coordinator = {
    runNow: async () => ({ jobId: 'not-used' }),
    pause: async () => {},
    resume: async () => {},
  },
} = {}) {
  let route
  registerHeartbeatHttpRoute({
    register(candidate) { route = candidate; return () => {} },
  }, service, coordinator)
  let status
  let payload = ''
  const response = {
    writeHead(nextStatus) { status = nextStatus; return this },
    end(data = '') { payload = String(data) },
  }
  await route.handler({
    method,
    url: '/api/xiaoshe/heartbeat',
    headers: {
      host: '127.0.0.1:3180',
      origin: 'http://127.0.0.1:3180',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield JSON.stringify(body)
    },
  }, response)
  return { status, body: JSON.parse(payload) }
}

async function invokeHeartbeatRoute(snapshot) {
  return await invokeHeartbeatRequest({ snapshot: () => snapshot })
}

function heartbeatPayload(persistenceStatus) {
  return {
    schemaVersion: 2,
    status: 'idle',
    running: false,
    ...(persistenceStatus === undefined ? {} : { persistenceStatus }),
    checks: [],
  }
}

function heartbeatStatusPayload(status) {
  return {
    schemaVersion: 2,
    status,
    running: false,
    persistenceStatus: 'ready',
    checks: [{ id: 'health', status, intervalMs: 1_000, failureCount: status === 'backoff' ? 1 : 0 }],
  }
}

const DESKTOP_PAYLOAD = {
  api_version: 1,
  product: '小蛇',
  version: '0.2.0',
  bridge: { state: 'ready' },
  actions: {},
}

test('health deadline aborts hanging reads at five seconds and retry supersedes late responses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = []
  let recover = false
  const provider = new ProductHealthProvider((path, init) => {
    if (recover) return Promise.resolve(new Response(JSON.stringify(path.includes('heartbeat') ? heartbeatPayload('ready') : DESKTOP_PAYLOAD)))
    return new Promise(resolve => pending.push({ path, signal: init.signal, resolve }))
  })
  t.after(() => provider.dispose())
  const first = provider.refresh()
  t.mock.timers.tick(4_999)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(provider.getSnapshot().status, 'loading')
  assert.ok(pending.every(request => !request.signal.aborted))
  t.mock.timers.tick(1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(provider.getSnapshot().status, 'error', 'deadline must settle even a transport that ignores abort')
  assert.ok(pending.every(request => request.signal.aborted), 'timeout must cancel the actual health request signals')
  assert.deepEqual((await first).errors.map(error => error.kind), ['HEALTH_REQUEST_TIMEOUT', 'HEALTH_REQUEST_TIMEOUT'])
  recover = true
  const recovered = await provider.refresh()
  assert.equal(recovered.status, 'ready')
  for (const request of pending) request.resolve(new Response(JSON.stringify(request.path.includes('heartbeat') ? heartbeatPayload('ready') : { ...DESKTOP_PAYLOAD, version: 'stale' })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(provider.getSnapshot().value.desktop.version, '0.2.0')
  assert.equal(provider.getSnapshot().status, 'ready')
})

test('health deadline covers a stalled response body and preserves successful sibling diagnostics', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let healthSignal
  const provider = new ProductHealthProvider(async (path, init) => {
    if (!path.includes('heartbeat')) return new Response(JSON.stringify(DESKTOP_PAYLOAD))
    healthSignal = init.signal
    return new Response(new ReadableStream({ start() {} }))
  })
  t.after(() => provider.dispose())
  const refresh = provider.refresh()
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(5_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(provider.getSnapshot().status, 'degraded')
  assert.equal(healthSignal.aborted, true)
  const snapshot = await refresh
  assert.equal(snapshot.value.desktop.product, '小蛇')
  assert.equal(snapshot.errors[0].kind, 'HEALTH_REQUEST_TIMEOUT')
})

async function productHealth(heartbeat) {
  const provider = new ProductHealthProvider(async (path) => new Response(JSON.stringify(
    path.includes('heartbeat') ? heartbeat : DESKTOP_PAYLOAD,
  ), { status: 200, headers: { 'content-type': 'application/json' } }))
  try {
    return await provider.refresh()
  } finally {
    provider.dispose()
  }
}

test('heartbeat public state and aggregate health fail closed for unhealthy check states', async () => {
  for (const status of ['lost', 'delayed', 'backoff']) {
    const published = publicHeartbeatSnapshot({
      schemaVersion: 2,
      persistenceStatus: 'ready',
      checks: [{ id: 'health', status, intervalMs: 1_000, failureCount: status === 'backoff' ? 1 : 0 }],
    })
    assert.equal(published.status, status)
    assert.equal(published.running, false)

    const health = await productHealth(heartbeatStatusPayload(status))
    assert.equal(health.status, 'degraded')
    assert.equal(health.value.heartbeat.status, status)
    assert.deepEqual(health.errors, [{
      source: 'heartbeat',
      message: `heartbeat check status is ${status}`,
      kind: 'HEARTBEAT_CHECK_DEGRADED',
    }])
  }
})

test('a running check never hides a sibling in backoff from aggregate health', async () => {
  const published = publicHeartbeatSnapshot({
    schemaVersion: 2,
    persistenceStatus: 'ready',
    checks: [
      { id: 'active', status: 'running', intervalMs: 1_000, failureCount: 0 },
      { id: 'recovering', status: 'backoff', intervalMs: 1_000, failureCount: 1, nextRunAt: 2_000 },
    ],
  })
  assert.equal(published.status, 'backoff')
  assert.equal(published.running, true)

  const health = await productHealth(published)
  assert.equal(health.status, 'degraded')
  assert.equal(health.value.heartbeat.status, 'backoff')
  assert.equal(health.value.heartbeat.running, true)
})

test('health Client rejects top-level heartbeat facts that contradict the checks', async () => {
  const inconsistent = [
    {
      schemaVersion: 2,
      status: 'healthy',
      running: false,
      persistenceStatus: 'ready',
      checks: [{ id: 'health', status: 'lost', intervalMs: 1_000, failureCount: 0 }],
    },
    {
      schemaVersion: 2,
      status: 'running',
      running: false,
      persistenceStatus: 'ready',
      checks: [{ id: 'health', status: 'running', intervalMs: 1_000, failureCount: 0 }],
    },
  ]
  for (const payload of inconsistent) {
    const health = await productHealth(payload)
    assert.equal(health.status, 'degraded')
    assert.equal(health.value.heartbeat, undefined)
    assert.equal(health.value.desktop.product, '小蛇')
    assert.equal(health.errors.length, 1)
    assert.equal(health.errors[0].source, 'heartbeat')
    assert.match(health.errors[0].message, /contradict/iu)
  }
})

test('coordinator renews a long-running lease and retires its renewal timer on settlement', async () => {
  let now = 0
  let nextTimerId = 0
  const timers = new Map()
  const setTimer = (callback, delay) => {
    const handle = {
      id: ++nextTimerId,
      dueAt: now + delay,
      callback,
      unref() {},
    }
    timers.set(handle.id, handle)
    return handle
  }
  const clearTimer = (handle) => { timers.delete(handle.id) }
  const advanceTo = async (target) => {
    while (true) {
      const due = [...timers.values()]
        .filter(timer => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt)[0]
      if (due === undefined) break
      timers.delete(due.id)
      now = due.dueAt
      due.callback()
      await new Promise(resolve => setImmediate(resolve))
    }
    now = target
    await new Promise(resolve => setImmediate(resolve))
  }

  let stored = { schemaVersion: 2, checks: [] }
  let revision = 0
  let onStoreChange = () => {}
  const service = createHeartbeatService({
    get: () => stored,
    getSnapshot: () => ({ value: stored, revision, status: 'ready' }),
    watch(callback) { onStoreChange = callback; return () => { onStoreChange = () => {} } },
    async update(patch) { return await this.replace({ ...stored, ...patch }) },
    async replace(section) { stored = section; revision += 1; onStoreChange(stored) },
  }, { now: () => now })

  let finish
  let activeJob
  const jobs = {
    attachController: () => () => {},
    start(spec) { activeJob = spec.run(); return 'job-long' },
    kill(_id, _caller, reason) { activeJob.cancel(reason); return 'requested' },
  }
  const coordinator = createHeartbeatCoordinator(service, jobs, { now: () => now, setTimer, clearTimer })
  coordinator.register({
    id: 'long-check',
    intervalMs: 100,
    run: async () => await new Promise(resolve => { finish = resolve }),
  })

  try {
    await coordinator.start()
    await coordinator.runNow('long-check')
    await advanceTo(400)
    assert.equal(service.snapshot().checks[0].status, 'running')
    assert.ok(service.snapshot().checks[0].activeLease.lastHeartbeatAt >= 300)

    finish({ summary: 'long check completed' })
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(service.snapshot().checks[0].status, 'healthy')
    assert.equal(service.snapshot().checks[0].activeLease, undefined)
    assert.ok([...timers.values()].every(timer => timer.dueAt >= 500))
  } finally {
    finish?.({ summary: 'test cleanup' })
    await new Promise(resolve => setImmediate(resolve))
    await coordinator.dispose()
    service.dispose()
  }
})

test('corrupt heartbeat namespace boots degraded and only a strictly valid replacement can repair it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-heartbeat-recovery-'))
  const filename = join(directory, 'settings.json')
  await writeFile(filename, JSON.stringify({
    'xiaoshe-heartbeat': { schemaVersion: 2, checks: [{ token: 'must-not-leak' }] },
  }), 'utf8')
  const providerContext = await openSettings(filename)
  let scope
  let provided
  try {
    applyHeartbeat({
      settings: {
        register(namespace, schema, options) {
          scope = providerContext.settings.register(namespace, schema, options)
          return scope
        },
      },
      webServer: { register: () => () => {} },
      jobs: {
        attachController: () => () => {},
        start: () => { throw new Error('not used') },
        kill: () => 'already-finished',
      },
      xiaosheVerificationPolicy: {},
      provide(_name, value) { provided = value },
      effect: () => undefined,
    })

    assert.equal(provided.service.snapshot().persistenceStatus, 'degraded')
    assert.equal(publicHeartbeatSnapshot(provided.service.snapshot()).persistenceStatus, 'degraded')
    assert.deepEqual(provided.service.snapshot().checks, [])
    assert.doesNotMatch(JSON.stringify(provided.service.snapshot()), /token|must-not-leak/u)
    await assert.rejects(
      scope.replace({ schemaVersion: 2, checks: [{ id: 'bad', intervalMs: 1_000 }] }, scope.getSnapshot().revision),
      /heartbeat failureCount must be a non-negative safe integer/u,
    )

    await provided.service.ensureCheck({ id: 'healthy', intervalMs: 1_000 })
    assert.equal(provided.service.snapshot().persistenceStatus, 'ready')
    assert.ok(provided.service.snapshot().checks.some(check => check.id === 'healthy'))
    const stored = await readFile(filename, 'utf8')
    assert.doesNotMatch(stored, /token|must-not-leak/u)
  } finally {
    await providerContext.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('heartbeat persistence status follows a terminal real write failure and recovers on the next successful write', async () => {
  let value = { schemaVersion: 2, checks: [] }
  let revision = 0
  let failWrites = true
  const store = {
    get: () => value,
    getSnapshot: () => ({ value, revision, status: 'ready' }),
    watch: () => () => {},
    async update(section) { return this.replace(section) },
    async replace(section) {
      if (failWrites) throw Object.assign(new Error('C:/private/profile token=must-not-leak'), { code: 'ENOSPC' })
      value = section
      revision += 1
    },
  }
  const service = createHeartbeatService(store, { now: () => 1_000 })
  try {
    await assert.rejects(service.ensureCheck({ id: 'health', intervalMs: 1_000 }), /must-not-leak/u)
    assert.equal(service.snapshot().persistenceStatus, 'degraded')
    assert.equal((await invokeHeartbeatRoute(service.snapshot())).body.persistenceStatus, 'degraded')

    failWrites = false
    await service.ensureCheck({ id: 'health', intervalMs: 1_000 })
    assert.equal(service.snapshot().persistenceStatus, 'ready')
    assert.equal((await invokeHeartbeatRoute(service.snapshot())).body.persistenceStatus, 'ready')
  } finally {
    service.dispose()
  }
})

test('a legacy heartbeat store without persistence diagnostics never reports ready', async () => {
  let value = { schemaVersion: 2, checks: [] }
  const service = createHeartbeatService({
    get: () => value,
    watch: () => () => {},
    async update(patch) { value = { ...value, ...patch } },
  }, { now: () => 1_000 })
  try {
    assert.equal(service.snapshot().persistenceStatus, 'degraded')
    await service.ensureCheck({ id: 'legacy-health', intervalMs: 1_000 })
    assert.equal(service.snapshot().persistenceStatus, 'degraded')
  } finally {
    service.dispose()
  }
})

test('heartbeat retries the writer lock but exposes permission, lock, and exhausted CAS failures as degraded', async () => {
  const failures = [
    { error: Object.assign(new Error('permission denied'), { code: 'EACCES' }), expectedWrites: 1 },
    { error: new Error('atomic-write: timed out waiting for the writer lock at C:/private/settings.lock'), expectedWrites: 3 },
    { error: Object.assign(new Error('sustained contention'), { code: 'SETTINGS_CONFLICT' }), expectedWrites: 8 },
  ]
  for (const { error, expectedWrites } of failures) {
    let writes = 0
    const value = { schemaVersion: 2, checks: [] }
    const service = createHeartbeatService({
      get: () => value,
      getSnapshot: () => ({ value, revision: 0, status: 'ready' }),
      watch: () => () => {},
      async update() { writes += 1; throw error },
      async replace() { writes += 1; throw error },
    }, { now: () => 1_000, sleep: async () => {} })
    try {
      await assert.rejects(service.ensureCheck({ id: 'health', intervalMs: 1_000 }))
      assert.equal(writes, expectedWrites)
      assert.equal(service.snapshot().persistenceStatus, 'degraded')
      assert.doesNotMatch(JSON.stringify(service.snapshot()), /private|settings\.lock|permission/u)
    } finally {
      service.dispose()
    }
  }
})

test('health Client fails closed when an old Host cannot report heartbeat persistence health', async () => {
  const ready = await productHealth(heartbeatPayload('ready'))
  assert.equal(ready.status, 'ready')
  assert.equal(ready.value.heartbeat.persistenceStatus, 'ready')

  const degraded = await productHealth(heartbeatPayload('degraded'))
  assert.equal(degraded.status, 'degraded')
  assert.equal(degraded.value.heartbeat.persistenceStatus, 'degraded')
  assert.deepEqual(degraded.errors, [{
    source: 'heartbeat',
    message: 'heartbeat persistence is degraded',
    kind: 'HEARTBEAT_PERSISTENCE_DEGRADED',
  }])

  const oldHost = await productHealth(heartbeatPayload())
  assert.equal(oldHost.status, 'degraded')
  assert.equal(oldHost.value.heartbeat, undefined)
  assert.equal(oldHost.value.desktop.product, '小蛇')
  assert.equal(oldHost.errors[0].source, 'heartbeat')

  const malformed = await productHealth(heartbeatPayload('unknown'))
  assert.equal(malformed.status, 'degraded')
  assert.equal(malformed.value.desktop.product, '小蛇')
  assert.equal(malformed.value.heartbeat, undefined)
  assert.equal(malformed.errors.length, 1)
  assert.equal(malformed.errors[0].source, 'heartbeat')
  assert.match(malformed.errors[0].message, /invalid envelope/u)
})

test('heartbeat HTTP classifies only request parsing errors as 400 and never exposes internal TypeError details', async () => {
  const secret = 'C:/private/profile token=must-not-leak'
  const getFailure = await invokeHeartbeatRequest({ snapshot() { throw new TypeError(secret) } })
  assert.equal(getFailure.status, 500)
  assert.deepEqual(getFailure.body, {
    error: 'heartbeat service is temporarily unavailable',
    kind: 'HEARTBEAT_RUNTIME_ERROR',
  })

  const snapshot = {
    schemaVersion: 2,
    persistenceStatus: 'ready',
    checks: [{ id: 'health', intervalMs: 1_000, failureCount: 0, status: 'idle' }],
  }
  const postFailure = await invokeHeartbeatRequest({ snapshot: () => snapshot }, {
    method: 'POST',
    body: { action: 'pause', id: 'health' },
    coordinator: {
      runNow: async () => ({ jobId: 'not-used' }),
      pause: async () => { throw new TypeError(secret) },
      resume: async () => {},
    },
  })
  assert.equal(postFailure.status, 500)
  assert.deepEqual(postFailure.body, getFailure.body)
  assert.doesNotMatch(JSON.stringify([getFailure, postFailure]), /private|profile|token|must-not-leak/u)

  const invalid = await invokeHeartbeatRequest({ snapshot: () => snapshot }, {
    method: 'POST', body: { action: 'not-valid', id: 'health' },
  })
  assert.equal(invalid.status, 400)
  assert.deepEqual(invalid.body, { error: 'invalid heartbeat request', kind: 'INVALID_HEARTBEAT_REQUEST' })
})

test('dispose waits for a launch blocked in lease acquisition and prevents the job from starting', async () => {
  let releaseAcquire
  let reportAcquireStarted
  const acquireStarted = new Promise(resolve => { reportAcquireStarted = resolve })
  const acquireRelease = new Promise(resolve => { releaseAcquire = resolve })
  let activeLease
  let starts = 0
  const service = coordinatorService({
    async acquire(_id, leaseId) {
      reportAcquireStarted()
      await acquireRelease
      activeLease = leaseId
    },
    async fail(_id, leaseId) {
      assert.equal(activeLease, leaseId)
      activeLease = undefined
    },
  })
  const coordinator = createHeartbeatCoordinator(service, {
    attachController: () => () => {},
    start() { starts += 1; throw new Error('job must not start after disposal') },
    kill: () => 'already-finished',
  })
  coordinator.register({ id: 'race', intervalMs: 1_000, run: async () => ({ summary: 'ok' }) })
  await coordinator.start()

  const running = coordinator.runNow('race')
  await acquireStarted
  let disposalSettled = false
  const disposal = coordinator.dispose().then(() => { disposalSettled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposalSettled, false)

  releaseAcquire()
  await assert.rejects(running, /disposed/u)
  await disposal
  assert.equal(starts, 0)
  assert.equal(activeLease, undefined)
})

test('dispose re-entering from jobs.start kills and settles the just-started job', async () => {
  let activeLease
  let job
  let disposal
  let kills = 0
  const service = coordinatorService({
    async acquire(_id, leaseId) { activeLease = leaseId },
    async fail(_id, leaseId) {
      assert.equal(activeLease, leaseId)
      activeLease = undefined
    },
  })
  const jobs = {
    attachController: () => () => {},
    start(spec) {
      job = spec.run()
      disposal = coordinator.dispose()
      return 'job-race'
    },
    kill(id, _caller, reason) {
      assert.equal(id, 'job-race')
      assert.match(reason, /disposed/u)
      kills += 1
      job.cancel(reason)
      return 'requested'
    },
  }
  const coordinator = createHeartbeatCoordinator(service, jobs)
  coordinator.register({
    id: 'race',
    intervalMs: 1_000,
    run: async signal => await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }),
  })
  await coordinator.start()

  await assert.rejects(coordinator.runNow('race'), /disposed/u)
  await disposal
  assert.equal(kills, 1)
  assert.equal(activeLease, undefined)
  assert.equal((await job.done).status, 'killed')
})

test('a rejected durable settlement is internally observed after the job leaves active tracking', async t => {
  const unhandled = []
  const onUnhandled = reason => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  t.after(() => { process.off('unhandledRejection', onUnhandled) })
  const service = coordinatorService({
    async succeed() { throw new Error('durable settlement failed') },
  })
  const jobs = {
    attachController: () => () => {},
    start(spec) { this.job = spec.run(); return 'job-settlement' },
    kill() { this.job.cancel('cleanup'); return 'requested' },
  }
  const coordinator = createHeartbeatCoordinator(service, jobs)
  t.after(async () => { await coordinator.dispose() })
  coordinator.register({ id: 'settlement', intervalMs: 1_000, run: async () => ({ summary: 'ok' }) })
  await coordinator.start()

  await coordinator.runNow('settlement')
  await jobs.job.done
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(unhandled, [])
})

function coordinatorService(overrides = {}) {
  const check = { id: 'race', intervalMs: 1_000, failureCount: 0, status: 'idle' }
  return {
    snapshot: () => ({ schemaVersion: 2, persistenceStatus: 'ready', checks: [check] }),
    subscribe: () => () => {},
    ensureCheck: async () => {},
    acquire: async () => {},
    checkpoint: async () => {},
    succeed: async () => {},
    fail: async () => {},
    pause: async () => {},
    resume: async () => {},
    recoverInterruptedLeases: async () => [],
    dispose: () => {},
    ...overrides,
  }
}
