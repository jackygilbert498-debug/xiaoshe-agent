import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertStabilityGuard, parseStabilityProcess, runStabilityAcceptance, runStabilityAcceptanceForTest,
  stabilityAcceptanceConfig, stabilitySessionFacts, stabilityText, STABILITY_DURATION_MS } from '../src/stability-acceptance.mjs'

const identity = 'a'.repeat(64), frontend = 'b'.repeat(64)
const hash = value => createHash('sha256').update(value).digest('hex')
async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'xs-stability-unit-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const runId = randomUUID(), root = join(temporary, `xiaoshe-product-acceptance-${runId}`)
  await mkdir(root, { mode: 0o700 })
  for (const name of ['dsh-home/profiles/web', 'state', 'logs', 'workspace', 'xiaoshe-windows-acceptance-user-data']) await mkdir(join(root, name), { recursive: true })
  const env = { XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1',
    XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: root, XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: runId,
    DSH_HOME: join(root, 'dsh-home'), XIAOSHE_STATE_ROOT: join(root, 'state'), XIAOSHE_DSH_LOG_DIR: join(root, 'logs'),
    XIAOSHE_ACCEPTANCE_WORKSPACE: join(root, 'workspace'), XIAOSHE_DSH_PORT: '49103',
    XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(root, 'xiaoshe-windows-acceptance-user-data'), XIAOSHE_DSH_SERVICE_LABEL: `com.xiaoshe.acceptance.${runId}` }
  const options = { temporaryRoot: temporary, platform: 'darwin' }
  const config = stabilityAcceptanceConfig(['--acceptance-stability'], env, options)
  return { temporary, env, options, config }
}

function fake(config) {
  let elapsed = 0, text = stabilityText(config.runId, -1), reloaded = 0, confirmations = 0
  const rows = [], calls = []
  const guard = { mounted: true, runId: config.runId, mode: 'no_model', mountCount: 1, attemptedRequests: 0, reservedRequests: 0,
    mounts: [{ runId: config.runId, pid: 43210, at: new Date().toISOString() }] }
  const ports = {
    now: () => elapsed, sleep: async ms => { elapsed += ms },
    process: async pid => ({ pid, started: '2026-09-07T01:00:00.000Z', rssKiB: 10000, cpuSeconds: elapsed / 1000 }),
    onboarding: async () => ({ acknowledged: true, ready: true }), prepareSession: async () => {}, awaitObserver: async (_config, seq) => { assert.equal(seq, 170) },
    observeFrontend: async () => ({ identity: frontend, aboutRendered: true, shellPresent: true, productOrigin: new URL(config.productUrl).origin, httpStatus: 200, renderedStatus: 'current' }),
    reload: async () => { assert.equal(rows.at(-1).state, 'prepared'); reloaded++ },
    rpc: async (_url, method, input) => {
      calls.push(method)
      if (method === 'workspace.create') { assert.equal(input.path, config.workspaceRoot); return { workspace: { workspaceId: 'owned-workspace', path: config.workspaceRoot }, created: true } }
      if (method === 'session.create') { assert.equal(input.agentPreset, 'standard'); return { sessionId: config.sessionId } }
      if (method === 'session.list') return { items: [{ sessionId: config.sessionId, running: false }] }
      if (method === 'session.history') return { events: [], hasMore: false }
      throw new Error('unexpected RPC')
    },
    fetch: async (url, options) => {
      const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined
      calls.push(path)
      if (path.endsWith('/desktop/status')) return Response.json({ product: '小蛇', api_version: 1, bridge: { state: 'ready' }, runtime_identity: identity })
      if (path.endsWith('/desktop/version')) return Response.json({ status: 'current', candidate: { identity }, backend: { identity },
        frontend: { source_identity: frontend, build_identity: frontend, loaded_identity: frontend, artifact_identity: 'c'.repeat(64), state: 'current', loaded_state: 'current' } })
      if (path.endsWith('/workbench/status')) return Response.json({ workspaces: [{ id: 'owned-workspace', path: config.workspaceRoot }], running: [], transactions: rows })
      if (path.endsWith('/write/prepare')) {
        assert.equal(body.workspaceId, 'owned-workspace'); assert.equal(body.path, 'soak.txt')
        const row = { id: `tx-${rows.length}`, token: 'private-confirmation-token', state: 'prepared', workspaceId: body.workspaceId,
          relativePath: body.path, beforeSha256: hash(text), afterSha256: hash(body.newText), newText: body.newText, challenge: {} }
        rows.push(row); return Response.json(row)
      }
      if (path.endsWith('/write/confirm')) {
        const row = rows.find(row => row.id === body.id)
        assert.equal(row.state, 'prepared'); assert.equal(body.token, row.token)
        row.state = 'applied'; row.challenge.confirmedAt = elapsed; text = row.newText; confirmations++
        return Response.json(row)
      }
      if (path.endsWith('/workbench/read')) return Response.json({ path: 'soak.txt', text, truncated: false })
      throw new Error('unexpected HTTP call')
    },
  }
  const target = { webContents: { executeJavaScript: async () => ({ origin: new URL(config.productUrl).origin, shellPresent: true, readyState: 'complete', interactive: true, ownedSessionSelected: true }), getOSProcessId: () => 9999 } }
  return { config, target, expectedIdentity: identity, readBudgetLedger: async () => guard, ports,
    inspect: () => ({ rows, calls, elapsed, reloaded, confirmations }), guard }
}

test('stability requires isolated gate and forbids duration/cadence overrides', async t => {
  const f = await fixture(t)
  assert.equal(stabilityAcceptanceConfig([], {}), undefined)
  assert.equal(STABILITY_DURATION_MS, 1_800_000)
  assert.ok(Object.isFrozen(f.config))
  for (const patch of [{ XIAOSHE_STABILITY_DURATION_MS: '1' }, { XIAOSHE_DSH_PORT: '3080' }, { XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: randomUUID() }, { XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '0' }]) {
    assert.throws(() => stabilityAcceptanceConfig(['--acceptance-stability'], { ...f.env, ...patch }, f.options))
  }
  assert.throws(() => runStabilityAcceptance({ config: { ...f.config } }), /validated isolated/u)
})

test('process parser requires exact PID, creation time, positive RSS and numeric CPU', () => {
  assert.deepEqual(parseStabilityProcess(' 42 Mon Sep  7 16:03:01 2026 12345 1:02.30\n', 42), {
    pid: 42, started: new Date('Mon Sep 7 16:03:01 2026').toISOString(), rssKiB: 12345, cpuSeconds: 62.3,
  })
  assert.equal(parseStabilityProcess('42 Mon Sep 7 16:03:01 2026 12345 1-01:02:03.00', 42).cpuSeconds, 90123)
  for (const text of ['', '43 Mon Sep 7 16:03:01 2026 2 1:00', '42 Mon Sep 7 16:03:01 2026 0 1:00', '42 unknown 20 0']) assert.throws(() => parseStabilityProcess(text, 42))
})

test('zero-model guard rejects unknown counters, extra mounts and changed host', () => {
  const ledger = { mounted: true, runId: 'owned', mode: 'no_model', mountCount: 1, attemptedRequests: 0, reservedRequests: 0, mounts: [{ pid: 123, runId: 'owned' }] }
  assert.equal(assertStabilityGuard(ledger, 'owned', 123), 123)
  for (const change of [{ attemptedRequests: null }, { reservedRequests: 1 }, { mountCount: 2 }, { mounts: [] }, { mode: 'live' }]) assert.throws(() => assertStabilityGuard({ ...ledger, ...change }, 'owned', 123))
  assert.throws(() => assertStabilityGuard(ledger, 'owned', 124))
})

test('unknown or paginated history/session shape cannot prove absence of model work', () => {
  const sessions = { items: [{ sessionId: 'own', running: false }] }, history = { events: [], hasMore: false }
  assert.deepEqual(stabilitySessionFacts(sessions, history, 'own'), { noModelEvents: true, runningSessions: 0 })
  for (const value of [{}, { events: [] }, { events: [], hasMore: true }, { events: [{}], hasMore: false }]) assert.throws(() => stabilitySessionFacts(sessions, value, 'own'))
  for (const value of [{}, { items: [] }, { items: [{ sessionId: 'own' }] }]) assert.throws(() => stabilitySessionFacts(value, history, 'own'))
  assert.equal(stabilitySessionFacts(sessions, { events: [{ event: { type: 'turn/start' } }], hasMore: false }, 'own').noModelEvents, false)
})

test('offline clock traverses all fixed slots and recovery but remains explicitly test evidence', async t => {
  const { config } = await fixture(t), f = fake(config)
  const report = await runStabilityAcceptanceForTest(f)
  assert.equal(report.accepted, true); assert.equal(report.executionKind, 'test')
  assert.equal(report.elapsedMs, STABILITY_DURATION_MS)
  assert.deepEqual(report.counts, { health: 121, resource: 31, transaction: 17, recovery: 1 })
  assert.equal(f.inspect().reloaded, 1); assert.equal(f.inspect().confirmations, 17)
  const journal = await readFile(config.samplesPath, 'utf8')
  assert.equal(journal.trim().split('\n').length, 170)
  assert.doesNotMatch(journal, /private-confirmation-token/u)
  assert.equal(JSON.parse(await readFile(config.reportPath, 'utf8')).executionKind, 'test')
  assert.ok(f.inspect().calls.every(value => !/prompt|model|\/run$|browser/u.test(value)))
})

test('public workspace.create workspaceId is distinct from workbench status id; an id-only RPC cannot pass', async t => {
  const proxySource = await readFile(new URL('../../../runtime/DSH/packages/host/apiproxy/src/api-proxy.ts', import.meta.url), 'utf8')
  const workbenchSource = await readFile(new URL('../../../packages/coding-workbench/src/service.ts', import.meta.url), 'utf8')
  // Source checks pin the actual public producer; this is not native API proof.
  assert.match(proxySource, /function workspaceView[\s\S]*?workspaceId: workspace\.id/u)
  assert.match(workbenchSource, /snapshot\(\)[\s\S]*?id: row\.id/u)
  const { config } = await fixture(t), f = fake(config), rpc = f.ports.rpc
  f.ports.rpc = (url, method, input) => method === 'workspace.create' ? { workspace: { id: 'owned-workspace' } } : rpc(url, method, input)
  const report = await runStabilityAcceptanceForTest(f)
  assert.equal(report.accepted, false); assert.match(report.failure.message, /public workspaceId/u)
  assert.equal(report.counts.health, 0)
})

test('missed observation slot fails instead of shortening or catching up samples', async t => {
  const { config } = await fixture(t), f = fake(config), sleep = f.ports.sleep
  f.ports.sleep = ms => sleep(ms + 8000)
  const report = await runStabilityAcceptanceForTest(f)
  assert.equal(report.accepted, false); assert.match(report.failure.message, /slot missed/u)
  assert.equal(report.counts.health, 0)
})

test('same PID with changed process start time aborts without a replacement pass', async t => {
  const { config } = await fixture(t), f = fake(config), observe = f.ports.process
  let reads = 0
  f.ports.process = async pid => ({ ...await observe(pid), started: ++reads > 4 ? '2026-09-07T02:00:00.000Z' : '2026-09-07T01:00:00.000Z' })
  const report = await runStabilityAcceptanceForTest(f)
  assert.equal(report.accepted, false); assert.match(report.failure.message, /same-process identity/u)
})

test('a lost confirmation response fails with exactly one attempt and retained raw evidence', async t => {
  const { config } = await fixture(t), f = fake(config), fetch = f.ports.fetch
  let attempted = 0
  f.ports.fetch = async (url, options) => {
    if (new URL(url).pathname.endsWith('/write/confirm')) { attempted++; await fetch(url, options); throw new Error('synthetic response loss') }
    return fetch(url, options)
  }
  const report = await runStabilityAcceptanceForTest(f)
  assert.equal(report.accepted, false); assert.equal(attempted, 1)
  assert.equal(f.inspect().rows[0].state, 'applied')
  assert.equal(JSON.parse(await readFile(config.reportPath, 'utf8')).failure.stage, 'workbench-transaction')
})
