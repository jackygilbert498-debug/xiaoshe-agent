import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { lifecycleAcceptanceConfig, lifecycleRpc, noModelGuardEvidence, observeLoadedFrontend, prepareLifecycleBrowser, runLifecycleAcceptance, sessionEvidence, versionEvidence } from '../src/lifecycle-acceptance.mjs'
import { prepareVisionComposer } from '../src/vision-acceptance.mjs'

const backendIdentity = 'a'.repeat(64)
const frontendIdentity = 'b'.repeat(64)
const argv = ['electron', '--acceptance-lifecycle']

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'xs-lifecycle-unit-')))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const runId = randomUUID()
  const root = join(temporary, `xiaoshe-product-acceptance-${runId}`)
  await mkdir(root, { mode: 0o700 })
  for (const name of ['dsh-home/profiles/web', 'state', 'logs', 'workspace', 'xiaoshe-windows-acceptance-user-data']) await mkdir(join(root, name), { recursive: true })
  const environment = { XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1',
    XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: root, XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: runId,
    XIAOSHE_DESKTOP_ACCEPTANCE_PHASE: 'seed', XIAOSHE_DESKTOP_ACCEPTANCE_FIXTURE_URL: 'http://127.0.0.1:49202/',
    DSH_HOME: join(root, 'dsh-home'), XIAOSHE_STATE_ROOT: join(root, 'state'), XIAOSHE_DSH_LOG_DIR: join(root, 'logs'),
    XIAOSHE_ACCEPTANCE_WORKSPACE: join(root, 'workspace'),
    XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(root, 'xiaoshe-windows-acceptance-user-data'),
    XIAOSHE_DSH_SERVICE_LABEL: `com.xiaoshe.acceptance.${runId}`, XIAOSHE_DSH_PORT: '49201' }
  const options = { temporaryRoot: temporary, platform: 'darwin' }
  return { root, environment, options, config: lifecycleAcceptanceConfig(argv, environment, options) }
}

function goodVersion() {
  return { status: 'current', candidate: { identity: backendIdentity }, backend: { identity: backendIdentity },
    frontend: { source_identity: frontendIdentity, build_identity: frontendIdentity, loaded_identity: frontendIdentity,
      artifact_identity: 'c'.repeat(64), state: 'current', loaded_state: 'current' } }
}
function goodUi(productUrl) {
  return { identity: frontendIdentity, aboutRendered: true, shellPresent: true, httpStatus: 200,
    renderedStatus: 'current', productOrigin: new URL(productUrl).origin }
}

test('real-main lifecycle mode needs its flag, double gate, matching run and fixed isolated paths', async t => {
  const f = await fixture(t)
  assert.equal(lifecycleAcceptanceConfig([], f.environment), undefined)
  assert.throws(() => lifecycleAcceptanceConfig(argv, {}), /requires the isolated/u)
  assert.equal(f.config.statePath, join(f.root, 'state/lifecycle-state.json'))
  assert.equal(f.config.reportPath, join(f.root, 'seed-report.json'))
  assert.ok(Object.isFrozen(f.config))
  for (const patch of [{ XIAOSHE_DESKTOP_ACCEPTANCE: '0' }, { XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: randomUUID() },
    { XIAOSHE_DESKTOP_ACCEPTANCE_PHASE: 'other' }, { XIAOSHE_DSH_PORT: '3080' },
    { XIAOSHE_DESKTOP_ACCEPTANCE_FIXTURE_URL: 'https://example.com/' },
    { XIAOSHE_DESKTOP_ACCEPTANCE_FIXTURE_URL: 'http://127.0.0.1:3080/' },
    { XIAOSHE_DESKTOP_ACCEPTANCE_FIXTURE_URL: 'http://127.0.0.1:49201/' },
    { XIAOSHE_DESKTOP_ACCEPTANCE_FIXTURE_URL: 'http://user:secret@127.0.0.1:49202/' },
    { XIAOSHE_DESKTOP_ACCEPTANCE_FIXTURE_URL: 'http://127.0.0.1:49202/path' }]) {
    assert.throws(() => lifecycleAcceptanceConfig(argv, { ...f.environment, ...patch }, f.options))
  }
})

test('no-model RPC allowlist rejects prompt, tools and arbitrary methods before fetch', async () => {
  for (const method of ['session.prompt', 'tools.call', 'settings.update', '../secret']) {
    await assert.rejects(lifecycleRpc('http://127.0.0.1:49201/', method, {}, () => { throw new Error('network must not run') }), /no-model allowlist/u)
  }
})

test('identity evidence never treats HTTP 200, old loaded code or missing roots as current', () => {
  const input = { ui: goodUi('http://127.0.0.1:49201/'), desktop: { runtime_identity: backendIdentity },
    version: goodVersion(), expectedIdentity: backendIdentity, productUrl: 'http://127.0.0.1:49201/' }
  assert.equal(versionEvidence(input).identityMatches, true)
  assert.equal(versionEvidence(input).frontendMatches, true)
  assert.equal(versionEvidence({ ...input, expectedIdentity: undefined }).identityMatches, false)
  assert.equal(versionEvidence({ ...input, desktop: { runtime_identity: 'd'.repeat(64) } }).identityMatches, false)
  assert.equal(versionEvidence({ ...input, ui: { ...input.ui, identity: 'e'.repeat(64) } }).frontendMatches, false)
  assert.equal(versionEvidence({ ...input, version: {} }).frontendMatches, false)
})

test('About evidence clicks actual settings controls and observes the loaded fetch query without replacing its result', async () => {
  let settingsClicked = 0; let aboutClicked = 0; let requests = 0
  const original = async () => { requests++; return { status: 200 } }
  const window = { fetch: original }
  const versionButton = { disabled: false }
  const panel = { querySelector: selector => selector.endsWith('button') ? versionButton : { dataset: { versionStatus: 'current' } } }
  const context = vm.createContext({ window, URL, location: { href: 'http://127.0.0.1:49201/', origin: 'http://127.0.0.1:49201' },
    document: { querySelector(selector) {
      if (selector === '.xsla-shell') return {}
      if (selector === '[data-xsla-settings-trigger-content]') return { closest: () => ({ click() { settingsClicked++ } }) }
      if (selector === '[data-xs-settings-nav-item=about]') return { click() { aboutClicked++; void window.fetch(`/xiaoshe/desktop/version?frontend_identity=${frontendIdentity}`) } }
      if (selector === '[data-native-settings=about]') return panel
      return null
    } } })
  const observed = await observeLoadedFrontend({ webContents: { executeJavaScript: async code => vm.runInContext(code, context) } })
  assert.equal(observed.identity, frontendIdentity)
  assert.equal(observed.httpStatus, 200)
  assert.equal(settingsClicked, 1)
  assert.equal(aboutClicked, 1)
  assert.equal(requests, 1)
  assert.equal(window.fetch, original)
  assert.equal(window.__xsLifecycleVersionCapture, undefined)
})

test('session evidence distinguishes a persisted rename from model work', () => {
  assert.deepEqual(sessionEvidence({ events: [{ event: { type: 'session/title', data: { title: 'owned' } } }] }, 'owned'),
    { eventCount: 1, matchingTitleEvents: 1, modelOrTurnEvents: 0 })
  assert.equal(sessionEvidence({ events: [{ event: { type: 'turn/start' } }] }, 'owned').modelOrTurnEvents, 1)
})

test('no-model evidence requires the matching run, observed mount PID and current phase timestamp', () => {
  const config = { runId: 'owned-run', phase: 'restore' }
  const ledger = { runId: config.runId, mode: 'no_model', mountCount: 2, attemptedRequests: 0, reservedRequests: 0,
    mounts: [{ runId: config.runId, pid: 111, at: '2026-09-07T01:00:00Z' }, { runId: config.runId, pid: 222, at: '2026-09-07T02:00:00Z' }] }
  const observed = noModelGuardEvidence(ledger, config, '2026-09-07T01:59:59Z', Date.parse('2026-09-07T02:00:01Z'))
  assert.equal(observed.latestMountPid, 222)
  assert.equal(observed.latestMountInPhase, true)
  assert.equal(observed.phaseMountCountMatches, true)
  assert.equal(noModelGuardEvidence({ ...ledger, mounts: undefined }, config, '2026-09-07T01:59:59Z').phaseMountCountMatches, false)
  assert.equal(noModelGuardEvidence(ledger, config, '2026-09-07T02:00:01Z').latestMountInPhase, false)
  assert.equal(noModelGuardEvidence({ ...ledger, runId: 'another' }, config, '2026-09-07T01:59:59Z').runMatches, false)
})

function fakeRuntime(config) {
  const requests = []; const events = []; const entries = []; const localValues = new Map()
  let revision = 0; let cookie = ''; let storageWrites = 0; let cookieFlushes = 0; let storageFlushes = 0
  const renderer = vm.createContext({ location: { origin: new URL(config.fixtureUrl).origin },
    document: { readyState: 'complete', get cookie() { return cookie.split(';')[0] }, set cookie(value) { cookie = value; storageWrites++ } },
    localStorage: { getItem: key => localValues.get(key) ?? null, setItem(key, value) { localValues.set(key, value); storageWrites++ } } })
  const snapshot = () => ({ revision, entries, diagnostics: { persistence_status: 'ready' } })
  const fetcher = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl)
    requests.push({ path: url.pathname, method: options.method ?? 'GET' })
    if (url.pathname.endsWith('/desktop/status')) return Response.json({ product: '小蛇', api_version: 1, bridge: { state: 'ready' }, runtime_identity: backendIdentity })
    if (url.pathname.endsWith('/desktop/version')) return Response.json(goodVersion())
    if (url.pathname === '/xiaoshe/memory') {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        assert.equal(body.expected_revision, revision)
        assert.equal(body.action, 'remember')
        entries.push({ id: 'synthetic-memory', text: body.text, scope: body.scope, state: 'active' }); revision++
      }
      return Response.json(snapshot())
    }
    const body = JSON.parse(options.body)
    let value
    if (body.method === 'session.create') value = { sessionId: body.payload.sessionId }
    else if (body.method === 'session.rename') {
      events.push({ event: { type: 'session/title', data: { title: body.payload.title } } })
      value = { title: body.payload.title, seq: 1 }
    } else if (body.method === 'session.history') value = { events }
    else if (body.method === 'session.list') value = { items: [{ running: false }] }
    else assert.fail(`unexpected API ${body.method}`)
    return Response.json({ rpcId: body.rpcId, result: { ok: true, value } })
  }
  return { fetcher, requests, localValues,
    // Test seam models the lifecycle, not the replaced HTTP/WS carrier (covered by physical transport tests).
    rpcTransport: async (productUrl, method, payload) => {
      const response = await fetcher(new URL('api/' + method, productUrl), { method: 'POST', body: JSON.stringify({ method, payload }) })
      return (await response.json()).result.value
    },
    observeFrontend: async () => goodUi(config.productUrl),
    prepareBrowser: async ({ sessionId }) => ({ stage: 'ready', sessionId }),
    requestBrowser: async request => { assert.equal(request.command, 'open'); assert.equal(request.args.url, config.fixtureUrl); return { tab_id: 'owned-tab' } },
    workspace: { tab: () => ({ view: { webContents: { executeJavaScript: async code => vm.runInContext(code, renderer), getOSProcessId: () => 12345 } } }),
      session: { cookies: { get: async () => cookie ? [{ value: cookie.split(';')[0].split('=')[1], session: false }] : [],
        flushStore: async () => { cookieFlushes++ } }, flushStorageData: async () => { storageFlushes++ } } },
    counters: () => ({ storageWrites, cookieFlushes, storageFlushes }),
  }
}

function guardFixture(config) {
  const phaseStartedAt = new Date(Date.now() - 10_000).toISOString()
  const at = new Date(Date.now() - 5_000).toISOString()
  return { phaseStartedAt, readBudgetLedger: async () => ({ runId: config.runId, mode: 'no_model',
    mountCount: config.phase === 'seed' ? 1 : 2, attemptedRequests: 0, reservedRequests: 0,
    mounts: [...(config.phase === 'restore' ? [{ runId: config.runId, pid: 111, at: new Date(Date.now() - 20_000).toISOString() }] : []),
      { runId: config.runId, pid: 222, at }] }) }
}

test('seed and restore preserve synthetic state; restore never rewrites a session, memory or browser storage', async t => {
  const f = await fixture(t)
  const runtime = fakeRuntime(f.config)
  const options = { config: f.config, target: {}, expectedIdentity: backendIdentity, ...runtime, ...guardFixture(f.config) }
  const seed = await runLifecycleAcceptance(options)
  assert.equal(seed.accepted, true)
  assert.equal(seed.shutdown, 'pending-parent-observation')
  assert.equal(seed.checks.every(check => check.passed), true)
  const writesAfterSeed = runtime.counters().storageWrites
  runtime.requests.length = 0
  const restoreConfig = lifecycleAcceptanceConfig(argv, { ...f.environment, XIAOSHE_DESKTOP_ACCEPTANCE_PHASE: 'restore' }, f.options)
  const restore = await runLifecycleAcceptance({ ...options, config: restoreConfig, ...guardFixture(restoreConfig) })
  assert.equal(restore.accepted, true)
  assert.equal(runtime.counters().storageWrites, writesAfterSeed)
  assert.deepEqual(runtime.counters(), { storageWrites: 2, cookieFlushes: 2, storageFlushes: 2 })
  assert.ok(!runtime.requests.some(request => ['/api/session.create', '/api/session.rename'].includes(request.path)
    || (request.path === '/xiaoshe/memory' && request.method === 'POST')))
  const reportText = await readFile(restoreConfig.reportPath, 'utf8')
  assert.equal(JSON.parse(reportText).checks.find(check => check.name === 'browser-storage-persistence').observed.restoredWithoutWriting, true)
  assert.ok(!reportText.includes(f.root))
  assert.ok(!reportText.includes(`xs-lifecycle-${f.config.runId}`))
})

test('restore fails and records actual missing browser state instead of reseeding it', async t => {
  const f = await fixture(t)
  const runtime = fakeRuntime(f.config)
  const options = { config: f.config, target: {}, expectedIdentity: backendIdentity, ...runtime, ...guardFixture(f.config) }
  await runLifecycleAcceptance(options)
  runtime.localValues.clear()
  const restoreConfig = lifecycleAcceptanceConfig(argv, { ...f.environment, XIAOSHE_DESKTOP_ACCEPTANCE_PHASE: 'restore' }, f.options)
  await assert.rejects(runLifecycleAcceptance({ ...options, config: restoreConfig, ...guardFixture(restoreConfig) }), /browser-storage-persistence/u)
  const report = JSON.parse(await readFile(restoreConfig.reportPath, 'utf8'))
  assert.equal(report.accepted, false)
  assert.equal(report.checks.at(-1).observed.localStorageMatches, false)
  assert.equal(runtime.localValues.size, 0)
})

test('a denied model attempt fails the preflight before UI, RPC or browser actions', async t => {
  const f = await fixture(t)
  const guard = guardFixture(f.config)
  await assert.rejects(runLifecycleAcceptance({ config: f.config, expectedIdentity: backendIdentity,
    phaseStartedAt: guard.phaseStartedAt,
    readBudgetLedger: async () => ({ ...await guard.readBudgetLedger(), attemptedRequests: 1 }),
    observeFrontend: async () => assert.fail('must not operate the UI'),
    fetcher: async () => assert.fail('must not call any API'),
    requestBrowser: async () => assert.fail('must not open a browser'),
  }), /no-model-guard-before/u)
  const report = JSON.parse(await readFile(f.config.reportPath, 'utf8'))
  assert.equal(report.accepted, false)
  assert.equal(report.checks.length, 1)
  assert.equal(report.checks[0].observed.attemptedRequests, 1)
})

test('main validates the new mode before locking and lets app.quit use its official cleanup', async () => {
  const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
  assert.ok(main.indexOf('const lifecycleAcceptance = lifecycleAcceptanceConfig') < main.indexOf('app.requestSingleInstanceLock'))
  assert.match(main, /await runLifecycleAcceptance\([\s\S]*?app\.quit\(\); return/u)
  assert.match(main, /app\.on\('before-quit',[\s\S]*?shutdownOwnedProduct/u)
})

test('browser UI preparation completes before the one owned fixture open', async t => {
  const f = await fixture(t), runtime = fakeRuntime(f.config), calls = []
  const report = await runLifecycleAcceptance({ config: f.config, target: {}, expectedIdentity: backendIdentity,
    ...runtime, ...guardFixture(f.config),
    prepareBrowser: async ({ sessionId, onObservation }) => {
      calls.push('prepare')
      assert.equal(sessionId, `session-${f.config.runId}`)
      assert.equal(runtime.requests.at(-1).path, '/xiaoshe/memory')
      assert.equal(runtime.requests.at(-1).method, 'GET')
      onObservation({ stage: 'browser-dock', ready: true })
      return { stage: 'ready', sessionId }
    },
    requestBrowser: async request => { calls.push('open'); return runtime.requestBrowser(request) },
  })
  assert.deepEqual(calls, ['prepare', 'open'])
  assert.equal(report.browserPreparation.stage, 'ready')
})

test('failed browser UI preparation retains its stage and never opens the fixture', async t => {
  const f = await fixture(t), runtime = fakeRuntime(f.config)
  let opens = 0
  await assert.rejects(runLifecycleAcceptance({ config: f.config, target: {}, expectedIdentity: backendIdentity,
    ...runtime, ...guardFixture(f.config),
    prepareBrowser: async ({ onObservation }) => {
      onObservation({ stage: 'session-selection', selected: false })
      throw new Error('owned session is not selected')
    },
    requestBrowser: async request => { opens++; return runtime.requestBrowser(request) },
  }), /owned session is not selected/u)
  assert.equal(opens, 0)
  const report = JSON.parse(await readFile(f.config.reportPath, 'utf8'))
  assert.equal(report.failure.stage, 'browser-preparation')
  assert.deepEqual(report.browserPreparation, { stage: 'session-selection', selected: false })
})

function lifecycleUi(config, { modal = config.phase === 'seed' ? 'beta' : null, delayedNotice = false,
  rows = [`session-${config.runId}`, 'unrelated-session'], selectWorks = true, hidden = false } = {}) {
  const calls = [], sessionId = `session-${config.runId}`
  let selected, dockOpen = false, acknowledgements = 0, dialogReads = 0
  const workspace = { activeOwner: undefined, bounds: undefined }
  const composer = { disabled: false, isConnected: true, getClientRects: () => [{}], closest: () => null,
    focus() { doc.activeElement = composer; calls.push('composer-focus') } }
  const notice = { querySelector: () => ({ textContent: '内测声明' }),
    querySelectorAll: () => [{ textContent: '继续', disabled: false, click() { modal = null; acknowledgements++; calls.push('acknowledge') } }] }
  const otherDialog = { querySelector: () => ({ textContent: '确认审批' }) }
  const rowElements = rows.map(id => ({ dataset: { sessionId: id }, querySelector: () => ({ disabled: false,
    click() { calls.push(`select:${id}`); if (selectWorks) { selected = id; workspace.activeOwner = id } } }) }))
  const rect = { x: 600, y: 100, width: 600, height: 500 }
  const dock = { querySelector: () => ({ getBoundingClientRect: () => rect }) }
  const dockButton = { disabled: false, getAttribute: () => dockOpen ? 'true' : 'false', click() {
    assert.equal(selected, sessionId)
    assert.equal(modal, null)
    dockOpen = true; workspace.bounds = { ...rect }; calls.push('open-dock')
  } }
  const doc = {
    activeElement: null, visibilityState: hidden ? 'hidden' : 'visible',
    querySelector(selector) {
      if (selector === '.xsla-shell form.cbox textarea[name="content"]') return composer
      if (selector === '#xsla-browser-dock') return dockOpen ? dock : null
      if (selector === '[role="dialog"][aria-modal="true"]') return modal === 'beta' ? notice : modal ? otherDialog : null
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[role="dialog"][aria-modal="true"]') {
        dialogReads++
        if (delayedNotice && dialogReads === 1) return []
        return modal === 'beta' ? [notice] : modal ? [otherDialog] : []
      }
      if (selector === '[data-session-id]') return rowElements
      if (selector === '[data-session-id].on') return rowElements.filter(row => row.dataset.sessionId === selected)
      if (selector === 'button[aria-controls="xsla-browser-dock"]') return [dockButton]
      return []
    },
  }
  const context = vm.createContext({ document: doc })
  const target = { isVisible: () => !hidden, isMinimized: () => false,
    loadURL: async url => { assert.equal(url, config.productUrl); calls.push('load-product') },
    webContents: { executeJavaScript: async code => vm.runInContext(code, context) } }
  return { target, workspace, calls, sessionId, counts: () => ({ acknowledgements, dialogReads }) }
}

const waitOnce = async (observe, description) => {
  const value = await observe()
  if (!value) throw new Error(`test readiness unavailable: ${description}`)
  return value
}

test('real preparation helpers acknowledge fresh UI, select only the owned row and observe native dock bounds', async () => {
  const config = { phase: 'seed', runId: randomUUID(), productUrl: 'http://127.0.0.1:49201/' }
  const ui = lifecycleUi(config, { delayedNotice: true }), observed = []
  const result = await prepareLifecycleBrowser({ config, ...ui, onObservation: value => observed.push(value) })
  assert.equal(ui.calls[0], 'load-product')
  assert.equal(ui.counts().acknowledgements, 1)
  assert.ok(ui.counts().dialogReads >= 3, 'an initially unobstructed composer cannot bypass fresh acknowledgement')
  assert.ok(ui.calls.indexOf('acknowledge') < ui.calls.indexOf(`select:${ui.sessionId}`))
  assert.ok(ui.calls.indexOf(`select:${ui.sessionId}`) < ui.calls.indexOf('open-dock'))
  assert.equal(ui.calls.filter(value => value.startsWith('select:')).length, 1)
  assert.equal(result.stage, 'ready')
  assert.equal(result.browser.activeOwner, ui.sessionId)
  assert.equal(result.browser.dom.selected, true)
  assert.equal(result.browser.dom.dockPresent, true)
  assert.equal(result.browser.bounds.width, 600)
  assert.deepEqual([...new Set(observed.map(value => value.stage))], ['product-page', 'composer', 'session-selection', 'browser-dock', 'ready'])
})

test('restore real composer readiness does not demand a second persisted notice acknowledgement', async () => {
  const config = { phase: 'restore', runId: randomUUID(), productUrl: 'http://127.0.0.1:49201/' }
  const ui = lifecycleUi(config)
  const result = await prepareLifecycleBrowser({ config, ...ui }, { wait: waitOnce,
    loadComposer: async () => ({ prepareVisionComposer,
      waitForFreshVisionComposer: () => assert.fail('restore must not require fresh onboarding') }) })
  assert.equal(result.stage, 'ready')
  assert.equal(ui.counts().acknowledgements, 0)
  assert.equal(ui.calls.filter(value => value === 'open-dock').length, 1)
})

test('other modal, wrong or duplicate rows, unselected owner and hidden window cannot reach a prepared dock', async () => {
  const config = { phase: 'restore', runId: randomUUID(), productUrl: 'http://127.0.0.1:49201/' }
  const sessionId = `session-${config.runId}`
  for (const [options, error] of [[{ modal: 'approval' }, /interactive composer/u],
    [{ rows: ['unrelated-session'] }, /session in sidebar/u],
    [{ rows: [sessionId, sessionId] }, /session in sidebar/u],
    [{ selectWorks: false }, /session selected/u], [{ hidden: true }, /window is hidden/u]]) {
    const ui = lifecycleUi(config, options)
    await assert.rejects(prepareLifecycleBrowser({ config, ...ui }, { wait: waitOnce }), error)
    assert.equal(ui.calls.includes('open-dock'), false)
    assert.equal(ui.calls.includes('select:unrelated-session'), false)
  }
  const ui = lifecycleUi(config)
  await assert.rejects(prepareLifecycleBrowser({ config, ...ui, sessionId: 'unrelated-session' }), /session or phase mismatch/u)
  assert.deepEqual(ui.calls, [])
})

test('the default lifecycle path uses actual UI preparation and preserves restore data without a second open attempt', async t => {
  const f = await fixture(t), runtime = fakeRuntime(f.config)
  const { prepareBrowser: _unused, ...runtimeWithoutPreparation } = runtime
  let opens = 0
  const execute = async config => {
    const ui = lifecycleUi(config)
    const workspace = Object.assign(ui.workspace, runtime.workspace)
    return runLifecycleAcceptance({ config, expectedIdentity: backendIdentity, ...runtimeWithoutPreparation,
      ...guardFixture(config), target: ui.target, workspace,
      requestBrowser: async request => {
        assert.equal(ui.calls.at(-1), 'open-dock')
        assert.equal(request.ownerId, ui.sessionId)
        opens++
        return runtime.requestBrowser(request)
      } })
  }
  const seed = await execute(f.config)
  assert.equal(seed.browserPreparation.stage, 'ready')
  const afterSeed = runtime.counters().storageWrites
  runtime.requests.length = 0
  const restoreConfig = lifecycleAcceptanceConfig(argv, { ...f.environment, XIAOSHE_DESKTOP_ACCEPTANCE_PHASE: 'restore' }, f.options)
  const restored = await execute(restoreConfig)
  assert.equal(restored.accepted, true)
  assert.equal(opens, 2, 'one fixture open per phase, not an automatic retry')
  assert.equal(runtime.counters().storageWrites, afterSeed)
  assert.ok(!runtime.requests.some(request => ['/api/session.create', '/api/session.rename'].includes(request.path)
    || request.path === '/xiaoshe/memory' && request.method === 'POST'))
})

test('real preparation failure in the default lifecycle path stops before any fixture open', async t => {
  const f = await fixture(t), runtime = fakeRuntime(f.config), ui = lifecycleUi(f.config)
  const { prepareBrowser: _unused, ...runtimeWithoutPreparation } = runtime
  ui.target.loadURL = async () => { throw new Error('owned product navigation failed') }
  await assert.rejects(runLifecycleAcceptance({ config: f.config, expectedIdentity: backendIdentity,
    ...runtimeWithoutPreparation, ...guardFixture(f.config), target: ui.target,
    requestBrowser: () => assert.fail('unprepared UI must never open fixture'),
  }), /owned product navigation failed/u)
  const report = JSON.parse(await readFile(f.config.reportPath, 'utf8'))
  assert.equal(report.failure.stage, 'browser-preparation')
  assert.equal(report.browserPreparation.stage, 'product-page')
  assert.equal(report.accepted, false)
})
