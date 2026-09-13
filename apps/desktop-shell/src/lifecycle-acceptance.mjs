/** Real-main, no-model acceptance. The private temporary-root gate is mandatory. */
import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { acceptanceServiceEnvironment } from './acceptance-isolation.mjs'
import { callAcceptanceRpc } from './interaction-acceptance.mjs'
import { prepareAcceptanceBrowser } from './browser-acceptance-ready.mjs'

const DIGEST = /^[a-f0-9]{64}$/u
const hash = value => createHash('sha256').update(value).digest('hex')
const RPC_METHODS = new Set(['session.create', 'session.rename', 'session.list', 'session.history'])

export function lifecycleAcceptanceConfig(argv, environment, isolationOptions) {
  if (!argv.includes('--acceptance-lifecycle')) return undefined
  const isolation = acceptanceServiceEnvironment(environment, isolationOptions)
  if (isolation === undefined) throw new Error('lifecycle acceptance requires the isolated acceptance gate')
  const root = isolation.XIAOSHE_DESKTOP_ACCEPTANCE_ROOT
  const runId = basename(root).slice('xiaoshe-product-acceptance-'.length)
  if (environment.XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID !== runId) throw new Error('lifecycle acceptance run ID must match its isolated root')
  const phase = environment.XIAOSHE_DESKTOP_ACCEPTANCE_PHASE
  if (!['seed', 'restore'].includes(phase)) throw new Error('lifecycle acceptance phase must be seed or restore')
  const fixture = new URL(environment.XIAOSHE_DESKTOP_ACCEPTANCE_FIXTURE_URL)
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || !fixture.port || fixture.port === '3080'
    || fixture.port === isolation.XIAOSHE_DSH_PORT || fixture.username || fixture.password || fixture.pathname !== '/' || fixture.search || fixture.hash) {
    throw new Error('lifecycle acceptance fixture must use a distinct explicit loopback HTTP origin')
  }
  return Object.freeze({ root, runId, phase, fixtureUrl: fixture.href,
    productUrl: `http://127.0.0.1:${isolation.XIAOSHE_DSH_PORT}/`,
    profileRoot: join(isolation.DSH_HOME, 'profiles', 'web'),
    workspaceRoot: isolation.XIAOSHE_ACCEPTANCE_WORKSPACE,
    userDataPath: isolation.XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA,
    statePath: join(isolation.XIAOSHE_STATE_ROOT, 'lifecycle-state.json'),
    reportPath: join(root, `${phase}-report.json`),
  })
}

export async function lifecycleRpc(productUrl, method, payload, fetcher, transport = callAcceptanceRpc) {
  if (!RPC_METHODS.has(method)) throw new Error('lifecycle acceptance RPC is outside the no-model allowlist')
  return transport(productUrl, method, payload, fetcher)
}

async function jsonRequest(url, options = {}, fetcher = globalThis.fetch) {
  const response = await fetcher(url, { ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(40_000) })
  if (!response.ok) throw new Error(`lifecycle acceptance HTTP failed (${response.status})`)
  const text = await response.text()
  if (text.length > 1024 * 1024) throw new Error('lifecycle acceptance response exceeds its bound')
  return JSON.parse(text)
}

async function waitFor(observe, description, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await observe()
    if (result) return result
    await delay(100)
  }
  throw new Error(`lifecycle acceptance timed out: ${description}`)
}

/** Capture the loaded closure's real request; never substitute the disk hash. */
export async function observeLoadedFrontend(target) {
  const inspect = code => target.webContents.executeJavaScript(code)
  await waitFor(() => inspect('!!document.querySelector(".xsla-shell")'), 'product shell')
  await inspect(`(() => {
    if (window.__xsLifecycleVersionCapture) throw new Error('version capture already installed')
    const original = window.fetch
    const capture = { identity: null, completed: false, status: null, original, wrapper: null }
    capture.wrapper = async function(input, init) {
      let versionRequest = false
      try {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href)
        versionRequest = url.origin === location.origin && url.pathname === '/xiaoshe/desktop/version'
        if (versionRequest) capture.identity = url.searchParams.get('frontend_identity')
      } catch {}
      try {
        const response = await original.call(this, input, init)
        if (versionRequest) { capture.status = response.status; capture.completed = true }
        return response
      } catch (error) { if (versionRequest) capture.completed = true; throw error }
    }
    window.__xsLifecycleVersionCapture = capture
    window.fetch = capture.wrapper
  })()`)
  try {
    await waitFor(() => inspect(`(() => {
      const trigger = document.querySelector('[data-xsla-settings-trigger-content]')?.closest('button')
      if (!trigger || trigger.disabled) return false
      trigger.click(); return true
    })()`), 'settings trigger')
    await waitFor(() => inspect(`(() => {
      const about = document.querySelector('[data-xs-settings-nav-item=about]')
      if (!about || about.disabled) return false
      about.click(); return true
    })()`), 'About navigation')
    return await waitFor(() => inspect(`(() => {
      const capture = window.__xsLifecycleVersionCapture
      const panel = document.querySelector('[data-native-settings=about]')
      const button = panel?.querySelector('[data-version-status] button')
      if (!capture?.completed || !button || button.disabled) return null
      return { identity: capture.identity, httpStatus: capture.status,
        aboutRendered: true, renderedStatus: panel.querySelector('[data-version-status]')?.dataset.versionStatus,
        productOrigin: location.origin, shellPresent: !!document.querySelector('.xsla-shell') }
    })()`), 'About version response')
  } finally {
    await inspect(`(() => {
      const capture = window.__xsLifecycleVersionCapture
      if (capture && window.fetch === capture.wrapper) window.fetch = capture.original
      delete window.__xsLifecycleVersionCapture
    })()`).catch(() => {})
  }
}

export function versionEvidence({ ui, desktop, version, expectedIdentity, productUrl }) {
  return {
    product: desktop.product ?? null,
    apiVersion: desktop.api_version ?? null,
    bridgeState: desktop.bridge?.state ?? null,
    loadedFrontendIdentity: DIGEST.test(ui.identity ?? '') ? ui.identity : null,
    aboutRendered: ui.aboutRendered === true,
    shellPresent: ui.shellPresent === true,
    loadedOriginMatches: ui.productOrigin === new URL(productUrl).origin,
    aboutHttpStatus: ui.httpStatus,
    aboutStatus: ui.renderedStatus,
    backendIdentity: DIGEST.test(desktop.runtime_identity ?? '') ? desktop.runtime_identity : null,
    expectedRootProfileIdentity: DIGEST.test(expectedIdentity ?? '') ? expectedIdentity : null,
    candidateIdentity: version.candidate?.identity ?? null,
    frontendBuildIdentity: version.frontend?.build_identity ?? null,
    frontendArtifactIdentity: version.frontend?.artifact_identity ?? null,
    diagnosticStatus: version.status,
    identityMatches: DIGEST.test(expectedIdentity ?? '') && desktop.runtime_identity === expectedIdentity
      && version.candidate?.identity === expectedIdentity && version.backend?.identity === expectedIdentity,
    frontendMatches: DIGEST.test(ui.identity ?? '') && version.frontend?.loaded_identity === ui.identity
      && version.frontend?.source_identity === ui.identity && version.frontend?.build_identity === ui.identity
      && version.frontend?.loaded_state === 'current' && version.frontend?.state === 'current',
  }
}

export function noModelGuardEvidence(ledger, config, phaseStartedAt, now = Date.now()) {
  const mounts = Array.isArray(ledger.mounts) ? ledger.mounts.map(mount => ({ runId: mount.runId, pid: mount.pid, at: mount.at })) : []
  const latest = mounts.reduce((left, right) => Date.parse(right.at) > Date.parse(left?.at ?? '') || left === undefined ? right : left, undefined)
  return { runId: ledger.runId, mode: ledger.mode, mountCount: ledger.mountCount,
    attemptedRequests: ledger.attemptedRequests, reservedRequests: ledger.reservedRequests,
    mounts, latestMountPid: latest?.pid ?? null, latestMountAt: latest?.at ?? null,
    runMatches: ledger.runId === config.runId && mounts.every(mount => mount.runId === config.runId),
    phaseMountCountMatches: ledger.mountCount === (config.phase === 'seed' ? 1 : 2) && mounts.length === ledger.mountCount,
    latestMountInPhase: Number.isSafeInteger(latest?.pid) && latest.pid > 0
      && Number.isFinite(Date.parse(phaseStartedAt)) && Date.parse(latest.at) >= Date.parse(phaseStartedAt)
      && Date.parse(latest.at) <= now,
  }
}

export function sessionEvidence(history, title) {
  const events = history?.events?.map(entry => entry.event) ?? []
  return { eventCount: events.length,
    matchingTitleEvents: events.filter(event => event.type === 'session/title' && event.data?.title === title).length,
    modelOrTurnEvents: events.filter(event => /^(?:turn\/|assistant\/|tool\/|user\/message)/u.test(event.type)).length,
  }
}

async function readState(config) {
  const info = await lstat(config.statePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('lifecycle acceptance state is unsafe')
  const value = JSON.parse(await readFile(config.statePath, 'utf8'))
  if (value.schema !== 'xiaoshe-lifecycle-state/v1' || value.runId !== config.runId || value.fixtureUrl !== config.fixtureUrl
    || value.sessionId !== `session-${config.runId}` || typeof value.memoryId !== 'string' || value.memoryId.length > 128
    || !Number.isSafeInteger(value.memoryRevision) || value.memoryRevision < 1) throw new Error('lifecycle acceptance state does not belong to this run')
  return value
}

/** About does not select the API-created session or present its native dock.
 * Use normal UI readiness, never a fabricated mount or a retry of open. */
export async function prepareLifecycleBrowser({ config, target, workspace, sessionId, onObservation = () => {} },
  { wait = waitFor, loadComposer = () => import('./vision-acceptance.mjs'), prepareDock = prepareAcceptanceBrowser } = {}) {
  if (!['seed', 'restore'].includes(config.phase) || sessionId !== `session-${config.runId}`) throw new Error('lifecycle browser session or phase mismatch')
  const inspect = code => target.webContents.executeJavaScript(code)
  const state = { phase: config.phase, stage: 'product-page' }
  const observe = async (stage, facts = {}) => { Object.assign(state, facts, { stage }); await onObservation({ ...state }) }
  await observe('product-page')
  await target.loadURL(config.productUrl)
  // vision imports version observers from this module. Resolve its UI-only
  // helper after initialization, without invoking any vision/clipboard journey.
  const { waitForFreshVisionComposer, prepareVisionComposer } = await loadComposer()
  await observe('composer')
  if (config.phase === 'seed') {
    state.composer = await waitForFreshVisionComposer(inspect, value => { state.composer = value; onObservation({ ...state }) })
  } else {
    // Same Profile already acknowledged onboarding during seed. Requiring a
    // second fresh notice would make a valid restore wait forever.
    state.composer = await wait(async () => {
      const value = await inspect(`(${prepareVisionComposer.toString()})(document)`)
      await observe('composer', { composer: value })
      return value.ready === true ? value : undefined
    }, 'restored-profile interactive composer')
  }
  await observe('session-selection')
  await wait(() => inspect(`(() => {
    const rows = [...document.querySelectorAll('[data-session-id]')].filter(row => row.dataset.sessionId === ${JSON.stringify(sessionId)})
    if (rows.length !== 1) return false
    const button = rows[0].querySelector('button.sess')
    if (!button || button.disabled) return false
    button.click(); return true
  })()`), 'owned lifecycle session in sidebar')
  await wait(() => inspect(`(() => {
    const rows = [...document.querySelectorAll('[data-session-id].on')]
    return rows.length === 1 && rows[0].dataset.sessionId === ${JSON.stringify(sessionId)}
  })()`), 'owned lifecycle session selected')
  await observe('browser-dock', { selected: true })
  const browser = await prepareDock({ target, workspace, sessionId,
    onObservation: value => observe('browser-dock', { browser: value }) })
  await observe('ready', { browser })
  return { ...state }
}

/** The parent verifies shutdown AFTER this returns; this report cannot certify it. */
export async function runLifecycleAcceptance({ config, target, workspace, requestBrowser, expectedIdentity,
  readBudgetLedger, phaseStartedAt = new Date().toISOString(),
  fetcher = globalThis.fetch, rpcTransport = callAcceptanceRpc, observeFrontend = observeLoadedFrontend, prepareBrowser = prepareLifecycleBrowser, onStep = () => {} }) {
  const report = { schema: 'xiaoshe-lifecycle-acceptance/v1', phase: config.phase, runId: config.runId,
    pid: process.pid, startedAt: phaseStartedAt, hookStartedAt: new Date().toISOString(), accepted: false, scope: 'real-main-isolated-no-model',
    shutdown: 'pending-parent-observation', checks: [] }
  let stage = 'initialization'
  const check = async (name, observed, predicate) => {
    stage = name
    const passed = predicate(observed) === true
    report.checks.push({ name, passed, observed })
    await onStep({ name, passed })
    if (!passed) throw new Error(`lifecycle acceptance check failed: ${name}`)
  }
  const rpc = (method, payload) => lifecycleRpc(config.productUrl, method, payload, fetcher, rpcTransport)
  const title = `XS lifecycle ${config.runId}`
  const marker = `xs-lifecycle-${config.runId}`
  const sessionId = `session-${config.runId}`
  const memoryUrl = new URL('xiaoshe/memory?scope=global&include_inactive=true', config.productUrl)
  try {
    stage = 'no-model-guard-before'
    const guardBefore = noModelGuardEvidence(await readBudgetLedger(join(config.root, 'budget')), config, phaseStartedAt)
    const guardValid = observed => observed.runMatches && observed.mode === 'no_model' && observed.phaseMountCountMatches
      && observed.latestMountInPhase && observed.attemptedRequests === 0 && observed.reservedRequests === 0
    await check(stage, guardBefore, guardValid)
    stage = 'loaded-product-version'
    const ui = await observeFrontend(target)
    const desktop = await jsonRequest(new URL('xiaoshe/desktop/status', config.productUrl), {}, fetcher)
    const version = await jsonRequest(new URL(`xiaoshe/desktop/version?frontend_identity=${encodeURIComponent(ui.identity ?? '')}`, config.productUrl), {}, fetcher)
    await check(stage, versionEvidence({ ui, desktop, version, expectedIdentity, productUrl: config.productUrl }), observed =>
      observed.product === '小蛇' && observed.apiVersion === 1 && observed.bridgeState === 'ready'
      && observed.aboutRendered && observed.shellPresent && observed.loadedOriginMatches && observed.aboutHttpStatus === 200
      && observed.aboutStatus === 'current' && observed.diagnosticStatus === 'current' && observed.identityMatches && observed.frontendMatches)
    let state
    if (config.phase === 'restore') { stage = 'restore-state'; state = await readState(config) }
    if (config.phase === 'seed') {
      stage = 'session-create-rename'
      const created = await rpc('session.create', { sessionId, cwd: config.workspaceRoot })
      const renamed = await rpc('session.rename', { sessionId, title })
      await check(stage, { createdIdMatches: created.sessionId === sessionId, renamedTitleMatches: renamed.title === title,
        renameSequence: renamed.seq }, observed => observed.createdIdMatches && observed.renamedTitleMatches && Number.isSafeInteger(observed.renameSequence))
    }
    stage = 'session-persistence'
    const history = await rpc('session.history', { sessionId, maxMessages: 100 })
    await check(stage, sessionEvidence(history, title), observed => observed.matchingTitleEvents === 1 && observed.modelOrTurnEvents === 0)
    stage = 'memory-persistence'
    let memory = await jsonRequest(memoryUrl, {}, fetcher)
    if (config.phase === 'seed') {
      const baselineRevision = memory.revision
      if (!Number.isSafeInteger(baselineRevision) || baselineRevision < 0) throw new Error('lifecycle acceptance memory revision is invalid')
      memory = await jsonRequest(new URL('xiaoshe/memory', config.productUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'remember', expected_revision: baselineRevision, scope: 'global', text: marker }),
      }, fetcher)
      const entry = memory.entries?.find(item => item.text === marker && item.scope === 'global' && item.state === 'active')
      state = { schema: 'xiaoshe-lifecycle-state/v1', runId: config.runId, fixtureUrl: config.fixtureUrl,
        sessionId, memoryId: entry?.id, memoryRevision: memory.revision }
      await check('memory-created', { matchingEntries: memory.entries?.filter(item => item.text === marker).length ?? 0,
        revisionIncreased: memory.revision > baselineRevision, entryIdPresent: typeof entry?.id === 'string' },
      observed => observed.matchingEntries === 1 && observed.revisionIncreased && observed.entryIdPresent)
      memory = await jsonRequest(memoryUrl, {}, fetcher)
    }
    await check('memory-persistence', { matchingEntries: memory.entries?.filter(item => item.id === state.memoryId && item.text === marker && item.state === 'active' && item.scope === 'global').length ?? 0,
      revision: memory.revision, revisionMatches: memory.revision === state.memoryRevision,
      persistenceStatus: memory.diagnostics?.persistence_status, markerDigest: hash(marker) },
    observed => observed.matchingEntries === 1 && observed.revisionMatches && observed.persistenceStatus === 'ready')
    stage = 'browser-preparation'
    report.browserPreparation = await prepareBrowser({ config, target, workspace, sessionId,
      onObservation: value => { report.browserPreparation = value } })
    stage = 'browser-storage'
    const opened = await requestBrowser({ origin: config.productUrl, ownerId: sessionId, command: 'open', args: { url: config.fixtureUrl } })
    const contents = workspace.tab(opened.tab_id, sessionId).view.webContents
    const before = await contents.executeJavaScript(`({ origin: location.origin, ready: document.readyState,
      localStoragePresent: localStorage.getItem('xs-lifecycle') !== null, cookiePresent: document.cookie.split('; ').some(value => value.startsWith('xs_lifecycle=')) })`)
    if (config.phase === 'seed') {
      await check('browser-storage-initially-empty', before, observed => observed.origin === new URL(config.fixtureUrl).origin
        && !observed.localStoragePresent && !observed.cookiePresent)
      await contents.executeJavaScript(`(() => {
        localStorage.setItem('xs-lifecycle', ${JSON.stringify(marker)})
        document.cookie = 'xs_lifecycle=' + ${JSON.stringify(marker)} + '; Max-Age=86400; Path=/; SameSite=Lax'
      })()`)
    }
    const stored = await contents.executeJavaScript(`({ origin: location.origin,
      localStorageMatches: localStorage.getItem('xs-lifecycle') === ${JSON.stringify(marker)},
      cookieMatches: document.cookie.split('; ').includes('xs_lifecycle=' + ${JSON.stringify(marker)}) })`)
    const cookies = await workspace.session.cookies.get({ url: config.fixtureUrl, name: 'xs_lifecycle' })
    await check('browser-storage-persistence', { ...stored, nativeCookieMatches: cookies.filter(cookie => cookie.value === marker && cookie.session === false).length === 1,
      rendererPid: contents.getOSProcessId(), restoredWithoutWriting: config.phase === 'restore' }, observed =>
      observed.origin === new URL(config.fixtureUrl).origin && observed.localStorageMatches && observed.cookieMatches
      && observed.nativeCookieMatches && Number.isSafeInteger(observed.rendererPid) && observed.rendererPid > 0)
    // Flush before requesting normal app.quit(); the lifecycle still disposes
    // this same Workspace and stops its token-owned service in before-quit.
    stage = 'browser-storage-flush'
    await workspace.session.cookies.flushStore()
    await workspace.session.flushStorageData()
    await check(stage, { cookieFlushCompleted: true, storageFlushCompleted: true }, observed => observed.cookieFlushCompleted && observed.storageFlushCompleted)
    stage = 'no-active-model-work'
    const sessions = await rpc('session.list', {})
    await check(stage, { runningSessions: sessions.items.filter(item => item.running).length }, observed => observed.runningSessions === 0)
    stage = 'no-model-guard-after'
    const guardAfter = noModelGuardEvidence(await readBudgetLedger(join(config.root, 'budget')), config, phaseStartedAt)
    await check(stage, guardAfter, observed => guardValid(observed) && observed.latestMountPid === guardBefore.latestMountPid)
    if (config.phase === 'seed') {
      stage = 'seed-state-checkpoint'
      await writeFile(config.statePath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }
    report.accepted = true
    return report
  } catch (error) {
    report.failure = { stage, code: 'LIFECYCLE_ACCEPTANCE_FAILED' }
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
}
