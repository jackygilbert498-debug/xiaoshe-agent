/** Fixed-duration real-main soak. Local Host actions are not model task delivery. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { open, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { acceptanceServiceEnvironment } from './acceptance-isolation.mjs'
import { callAcceptanceRpc } from './interaction-acceptance.mjs'
import { observeLoadedFrontend, versionEvidence } from './lifecycle-acceptance.mjs'
import { waitForFreshVisionComposer } from './vision-acceptance.mjs'

export const STABILITY_DURATION_MS = 30 * 60_000
export const STABILITY_INTERVAL_MS = 15_000
export const STABILITY_MAX_LAG_MS = 7_500
const hash = value => createHash('sha256').update(value).digest('hex')
const exec = promisify(execFile)
const configs = new WeakSet()
export const stabilityText = (runId, index) => `XS stability ${runId} revision ${index}\n`

export function stabilityAcceptanceConfig(argv, environment, isolationOptions) {
  if (!argv.includes('--acceptance-stability')) return undefined
  const isolated = acceptanceServiceEnvironment(environment, isolationOptions)
  if (!isolated) throw new Error('stability requires isolated acceptance')
  if (Object.keys(environment).some(key => /^XIAOSHE_STABILITY_/u.test(key))) throw new Error('stability duration and cadence cannot be overridden')
  const root = isolated.XIAOSHE_DESKTOP_ACCEPTANCE_ROOT
  const runId = basename(root).slice('xiaoshe-product-acceptance-'.length)
  if (environment.XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID !== runId) throw new Error('stability run ID mismatch')
  const config = Object.freeze({ root, runId, sessionId: `xiaoshe-stability-${runId}`,
    productUrl: `http://127.0.0.1:${isolated.XIAOSHE_DSH_PORT}/`, workspaceRoot: isolated.XIAOSHE_ACCEPTANCE_WORKSPACE,
    reportPath: join(root, 'stability-native.json'), samplesPath: join(root, 'stability-samples.jsonl'),
    profileRoot: join(isolated.DSH_HOME, 'profiles/web') })
  configs.add(config)
  return config
}

export function parseStabilityProcess(text, pid) {
  const match = text.trim().match(/^(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+([\d:.-]+)$/u)
  if (!match || Number(match[1]) !== pid || !Number.isFinite(Date.parse(match[2])) || Number(match[3]) < 1) throw new Error('process identity/resource observation unavailable')
  const cpu = match[4].match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u)
  if (!cpu) throw new Error('process CPU observation unavailable')
  return { pid, started: new Date(Date.parse(match[2])).toISOString(), rssKiB: Number(match[3]),
    cpuSeconds: Number(cpu[1] ?? 0) * 86400 + Number(cpu[2] ?? 0) * 3600 + Number(cpu[3]) * 60 + Number(cpu[4]) }
}

async function processFact(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid process identity')
  const value = await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,lstart=,rss=,time='], { timeout: 3_000, maxBuffer: 2048 })
  return parseStabilityProcess(value.stdout, pid)
}

export function assertStabilityGuard(ledger, runId, backendPid) {
  if (!ledger?.mounted || ledger.runId !== runId || ledger.mode !== 'no_model' || ledger.mountCount !== 1
    || ledger.attemptedRequests !== 0 || ledger.reservedRequests !== 0 || ledger.mounts?.length !== 1
    || ledger.mounts[0].runId !== runId || !Number.isSafeInteger(ledger.mounts[0].pid) || ledger.mounts[0].pid < 1
    || (backendPid !== undefined && ledger.mounts[0].pid !== backendPid)) throw new Error('same-host zero-model guard is not proven')
  return ledger.mounts[0].pid
}

async function bounded(promise, ms, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })]) }
  finally { clearTimeout(timer) }
}

async function reloadRenderer(target) {
  // A deliberate reload is a controlled recovery exercise, not a crash claim.
  const contents = target.webContents
  let clean = () => {}
  try { await bounded(new Promise((done, fail) => {
    const loaded = () => { clean(); done() }
    const failed = (_event, code) => { clean(); fail(new Error(`renderer reload failed (${code})`)) }
    clean = () => { contents.off('did-finish-load', loaded); contents.off('did-fail-load', failed) }
    contents.once('did-finish-load', loaded); contents.once('did-fail-load', failed)
    contents.reload()
  }), 10_000, 'renderer reload') } finally { clean() }
}

export function stabilitySessionFacts(sessions, history, sessionId) {
  if (!Array.isArray(sessions?.items) || sessions.items.some(row => typeof row.sessionId !== 'string' || typeof row.running !== 'boolean')
    || sessions.items.filter(row => row.sessionId === sessionId).length !== 1 || !Array.isArray(history?.events) || history.hasMore !== false
    || history.events.some(row => typeof row.event?.type !== 'string')) throw new Error('session evidence is unknown or incomplete')
  return { noModelEvents: !history.events.some(row => /^(?:turn\/|assistant\/|tool\/|user\/message)/u.test(row.event.type)),
    runningSessions: sessions.items.filter(row => row.running).length }
}

async function awaitObserver(config, seq) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
      const text = await readFile(join(config.root, 'stability-observer-ack.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      if (text) {
        const value = JSON.parse(text)
        if (value.runId !== config.runId || value.seq !== seq || value.observations !== 138) throw new Error('independent observer acknowledgement mismatch')
        return
      }
      await delay(100)
  }
  throw new Error('independent observer final sample timed out')
}

async function prepareOwnedSession(target, config) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const ready = await bounded(target.webContents.executeJavaScript(`(() => {
      const row=document.querySelector(${JSON.stringify(`[data-session-id="${config.sessionId}"]`)})
      if (!row) return false
      if (!row.classList.contains('on')) { const button=row.querySelector('button.sess'); if (!button || button.disabled) return false; button.click(); return false }
      const el=document.querySelector('.xsla-shell form.cbox textarea[name="content"]')
      return !!el && !el.disabled && el.isConnected && el.getClientRects().length>0 && !el.closest('[inert],[hidden],[aria-hidden="true"]') && !document.querySelector('[role="dialog"][aria-modal="true"]')
    })()`), 5_000, 'owned session selection')
    if (ready === true) return
    await delay(100)
  }
  throw new Error('owned session is not selected and interactive')
}

async function run(config, target, expectedIdentity, readBudgetLedger, onStep, ports, executionKind) {
  const report = { schema: 'xiaoshe-stability-native/v1', runId: config.runId, sessionId: config.sessionId,
    pid: process.pid, executionKind, scope: 'same-main-backend-30-minute-local-host-soak-not-model-delivery',
    startedAt: new Date().toISOString(), accepted: false, shutdown: 'pending-parent-observation' }
  let journal, stage = 'initialize', seq = 0, start, workspaceId, backendPid, previousHash = hash(stabilityText(config.runId, -1))
  let healthCount = 0, resourceCount = 0, transactionCount = 0, recoveryCount = 0
  const request = async (path, body) => {
    const response = await ports.fetch(new URL(path, config.productUrl), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5_000),
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(config.productUrl).origin }, body: JSON.stringify(body) }) })
    if (!response.ok) throw new Error(`stability HTTP ${response.status} at ${path.split('?')[0]}`)
    const text = await response.text()
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('stability response exceeds bound')
    return JSON.parse(text)
  }
  const record = async (kind, slot, data) => {
    const row = { schema: 'xiaoshe-stability-sample/v1', runId: config.runId, seq: ++seq, kind, slot,
      at: new Date().toISOString(), elapsedMs: ports.now() - start, data }
    await journal.write(`${JSON.stringify(row)}\n`); await journal.sync()
    await onStep({ kind, slot, seq, elapsedMs: row.elapsedMs })
  }
  const inspectRenderer = async () => {
    const value = await bounded(target.webContents.executeJavaScript(`(() => { const el=document.querySelector('.xsla-shell form.cbox textarea[name="content"]'); return {origin: location.origin, shellPresent: !!document.querySelector('.xsla-shell'), readyState: document.readyState,
      ownedSessionSelected: !!document.querySelector(${JSON.stringify(`[data-session-id="${config.sessionId}"].on`)}),
      interactive: !!el && !el.disabled && el.isConnected && el.getClientRects().length>0 && !el.closest('[inert],[hidden],[aria-hidden="true"]') && !document.querySelector('[role="dialog"][aria-modal="true"]')}; })()`), 5_000, 'renderer heartbeat')
    if (value?.origin !== new URL(config.productUrl).origin || value.shellPresent !== true || value.readyState !== 'complete'
      || value.interactive !== true || value.ownedSessionSelected !== true) throw new Error('renderer heartbeat failed')
    return { ...value, pid: target.webContents.getOSProcessId() }
  }
  const version = async () => {
    const ui = await ports.observeFrontend(target)
    const desktop = await request('xiaoshe/desktop/status')
    const diagnostic = await request(`xiaoshe/desktop/version?frontend_identity=${encodeURIComponent(ui.identity ?? '')}`)
    const facts = versionEvidence({ ui, desktop, version: diagnostic, expectedIdentity, productUrl: config.productUrl })
    if (facts.product !== '小蛇' || facts.bridgeState !== 'ready' || !facts.identityMatches || !facts.frontendMatches
      || facts.aboutStatus !== 'current' || facts.diagnosticStatus !== 'current' || !facts.aboutRendered || !facts.shellPresent
      || !facts.loadedOriginMatches || facts.aboutHttpStatus !== 200) throw new Error('loaded product identity is not current')
    await target.webContents.executeJavaScript(`document.querySelector('[data-xs-settings-close]')?.click()`)
    return facts
  }
  const transaction = async (index, slot, recover = false) => {
    stage = recover ? 'prepared-reload-recovery' : 'workbench-transaction'
    const newText = stabilityText(config.runId, index), expectedHash = hash(newText)
    const prepared = await request('api/xiaoshe/workbench/write/prepare', { workspaceId, path: 'soak.txt', newText })
    if (typeof prepared.id !== 'string' || typeof prepared.token !== 'string' || prepared.beforeSha256 !== previousHash
      || prepared.afterSha256 !== expectedHash || prepared.workspaceId !== workspaceId || prepared.relativePath !== 'soak.txt') throw new Error('workbench prepare is not bound to synthetic bytes')
    if (recover) {
      const before = await inspectRenderer()
      const unchanged = await request('api/xiaoshe/workbench/read', { workspaceId, path: 'soak.txt' })
      if (hash(unchanged.text) !== previousHash) throw new Error('prepared write applied before confirmation')
      await ports.reload(target)
      await ports.prepareSession(target, config)
      const after = await inspectRenderer()
      const status = await request('api/xiaoshe/workbench/status')
      const rows = status.transactions?.filter(row => row.id === prepared.id) ?? []
      if (rows.length !== 1 || rows[0].state !== 'prepared' || rows[0].beforeSha256 !== previousHash || rows[0].afterSha256 !== expectedHash
        || rows[0].challenge?.confirmedAt !== undefined) throw new Error('prepared transaction did not survive renderer reload unchanged')
      await record('recovery', slot, { transactionId: prepared.id, state: rows[0].state, beforeSha256: previousHash,
        afterSha256: expectedHash, beforeRendererPid: before.pid, afterRendererPid: after.pid, reloadCompleted: true, interactiveAfter: after.interactive, confirmationAbsent: true })
      recoveryCount++
    }
    // Exactly one confirmation; do not hide a lost response with an automatic retry.
    const confirmed = await request('api/xiaoshe/workbench/write/confirm', { id: prepared.id, token: prepared.token })
    const read = await request('api/xiaoshe/workbench/read', { workspaceId, path: 'soak.txt' })
    if (confirmed.id !== prepared.id || confirmed.state !== 'applied' || confirmed.afterSha256 !== expectedHash
      || read.truncated !== false || read.path !== 'soak.txt' || read.text !== newText) throw new Error('workbench confirmed bytes mismatch')
    const status = await request('api/xiaoshe/workbench/status')
    const rows = status.transactions?.filter(row => row.id === prepared.id) ?? []
    if (rows.length !== 1 || rows[0].state !== 'applied' || rows[0].afterSha256 !== expectedHash) throw new Error('workbench completion receipt missing or duplicated')
    await record('transaction', slot, { index, transactionId: prepared.id, recovered: recover, confirmationRequests: 1,
      beforeSha256: previousHash, afterSha256: expectedHash, apiReadSha256: hash(read.text), appliedReceipts: rows.length, bytes: Buffer.byteLength(newText) })
    previousHash = expectedHash; transactionCount++
  }
  try {
    journal = await open(config.samplesPath, 'wx', 0o600)
    report.budgetBefore = await readBudgetLedger(join(config.root, 'budget'))
    backendPid = assertStabilityGuard(report.budgetBefore, config.runId)
    report.backendPid = backendPid
    report.onboarding = await ports.onboarding(target)
    if (report.onboarding?.acknowledged !== true || report.onboarding.ready !== true) throw new Error('fresh-profile onboarding is not complete')
    report.frontendBefore = await version()
    const workspace = await ports.rpc(config.productUrl, 'workspace.create', { path: config.workspaceRoot })
    // Public RPC calls it workspaceId; the workbench registry projection uses
    // id. Do not let self-consistent test doubles erase this wire distinction.
    workspaceId = workspace.workspace?.workspaceId
    if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('workspace.create returned no public workspaceId')
    const status = await request('api/xiaoshe/workbench/status')
    const owned = status.workspaces?.filter(row => row.path === config.workspaceRoot) ?? []
    if (owned.length !== 1 || owned[0].id !== workspaceId) throw new Error('private workbench registry binding failed')
    const created = await ports.rpc(config.productUrl, 'session.create', { sessionId: config.sessionId, cwd: config.workspaceRoot, agentPreset: 'standard' })
    if (created.sessionId !== config.sessionId) throw new Error('unexpected isolated session identity')
    await ports.prepareSession(target, config)
    await inspectRenderer()
    const initialProcesses = await Promise.all([ports.process(process.pid), ports.process(backendPid)])
    report.processes = { main: initialProcesses[0], backend: initialProcesses[1] }
    report.measuredStartedAt = new Date().toISOString(); start = ports.now()
    for (let slot = 0; slot <= 120; slot++) {
      stage = 'heartbeat'
      await ports.sleep(Math.max(0, slot * STABILITY_INTERVAL_MS - (ports.now() - start)))
      if (ports.now() - start - slot * STABILITY_INTERVAL_MS > STABILITY_MAX_LAG_MS) throw new Error('heartbeat observation slot missed')
      const [desktop, renderer, main, backend] = await Promise.all([request('xiaoshe/desktop/status'), inspectRenderer(), ports.process(process.pid), ports.process(backendPid)])
      if (desktop.product !== '小蛇' || desktop.bridge?.state !== 'ready' || desktop.runtime_identity !== expectedIdentity
        || main.pid !== report.processes.main.pid || main.started !== report.processes.main.started
        || backend.pid !== report.processes.backend.pid || backend.started !== report.processes.backend.started) throw new Error('health or same-process identity changed')
      assertStabilityGuard(await readBudgetLedger(join(config.root, 'budget')), config.runId, backendPid)
      await record('health', slot, { main: { pid: main.pid, started: main.started }, backend: { pid: backend.pid, started: backend.started },
        product: desktop.product, bridgeState: desktop.bridge.state, runtimeIdentity: desktop.runtime_identity, renderer })
      healthCount++
      if (slot % 4 === 0) { await record('resource', slot, { main, backend }); resourceCount++ }
      if (slot % 8 === 0) await transaction(slot / 8, slot)
      if (slot === 60) await transaction(1000, slot, true)
    }
    report.elapsedMs = ports.now() - start
    if (report.elapsedMs < STABILITY_DURATION_MS) throw new Error('thirty real minutes were not measured')
    await ports.awaitObserver(config, seq)
    report.frontendAfter = await version()
    report.budgetAfter = await readBudgetLedger(join(config.root, 'budget'))
    assertStabilityGuard(report.budgetAfter, config.runId, backendPid)
    const sessions = await ports.rpc(config.productUrl, 'session.list', {})
    const history = await ports.rpc(config.productUrl, 'session.history', { sessionId: config.sessionId, maxMessages: 100 })
    Object.assign(report, stabilitySessionFacts(sessions, history, config.sessionId))
    if (!report.noModelEvents || report.runningSessions !== 0) throw new Error('unexpected model/session work')
    report.accepted = true
  } catch (error) { report.failure = { stage, message: String(error?.message ?? error).slice(0, 1000) } }
  finally {
    report.counts = { health: healthCount, resource: resourceCount, transaction: transactionCount, recovery: recoveryCount }
    report.finishedAt = new Date().toISOString()
    if (journal) await journal.close()
    const file = await open(config.reportPath, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(report, null, 2)}\n`); await file.sync() } finally { await file.close() }
  }
  return report
}

/** Production entry has no clock, duration, transport or process injection. */
export function runStabilityAcceptance({ config, target, expectedIdentity, readBudgetLedger, onStep = async () => {} }) {
  if (!configs.has(config)) throw new Error('stability requires a validated isolated config')
  return run(config, target, expectedIdentity, readBudgetLedger, onStep, {
    now: () => performance.now(), sleep: ms => delay(ms), process: processFact, fetch: globalThis.fetch,
    observeFrontend: observeLoadedFrontend, reload: reloadRenderer, rpc: callAcceptanceRpc,
    onboarding: target => waitForFreshVisionComposer(code => target.webContents.executeJavaScript(code)), awaitObserver, prepareSession: prepareOwnedSession,
  }, 'product_no_model')
}

/** Explicit offline seam: its report can never be promoted as live evidence. */
export function runStabilityAcceptanceForTest({ config, target, expectedIdentity, readBudgetLedger, ports, onStep = async () => {} }) {
  return run(config, target, expectedIdentity, readBudgetLedger, onStep, ports, 'test')
}
