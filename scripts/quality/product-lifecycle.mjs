#!/usr/bin/env node
/** Real macOS launcher + Electron main acceptance. No model or user Profile. */
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { captureCandidate } from './internal-beta.mjs'
import { productRuntimeIdentity } from '../product-runtime-identity.mjs'
import { acceptanceServiceEnvironment } from '../../apps/desktop-shell/src/acceptance-isolation.mjs'

const exec = promisify(execFile)
const productDefault = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u
const PRODUCT_PACKAGES = ['verification-policy', 'native-shell-legacy-adapted', 'runtime-dsh-provider',
  'completion-receipt', 'runtime-contract', 'heartbeat', 'memory', 'project-knowledge', 'plugin-governance', 'provider-readiness',
  'migration-recovery', 'agent-experience', 'coding-workbench', 'task-timeline', 'product-bundle']
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const save = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })

/** Pure, independently tested closure check over facts captured by real main. */
export function validatePhaseReport(raw, { runId, phase, pid, runtimeIdentity, startedAt, finishedAt, servicePid }) {
  const bad = () => { throw new Error('native phase evidence is incomplete or incorrectly bound') }
  if (raw?.schema !== 'xiaoshe-lifecycle-acceptance/v1' || raw.runId !== runId || raw.phase !== phase || raw.pid !== pid
    || raw.accepted !== true || raw.failure !== undefined || raw.scope !== 'real-main-isolated-no-model' || raw.shutdown !== 'pending-parent-observation'
    || !Number.isFinite(Date.parse(raw.startedAt)) || !Number.isFinite(Date.parse(raw.finishedAt))
    || Date.parse(raw.startedAt) < startedAt || Date.parse(raw.finishedAt) > finishedAt
    || Date.parse(raw.finishedAt) < Date.parse(raw.startedAt) || !Array.isArray(raw.checks)) bad()
  const required = ['loaded-product-version', 'session-persistence', 'memory-persistence', 'browser-storage-persistence',
    'browser-storage-flush', 'no-active-model-work', 'no-model-guard-before', 'no-model-guard-after',
    ...(phase === 'seed' ? ['session-create-rename', 'memory-created', 'browser-storage-initially-empty'] : [])]
  if (new Set(raw.checks.map(row => row?.name)).size !== raw.checks.length
    || raw.checks.length !== required.length || raw.checks.some(row => !required.includes(row?.name) || row.passed !== true || !row.observed)) bad()
  const facts = Object.fromEntries(raw.checks.map(row => [row.name, row.observed]))
  if (phase === 'seed') {
    const session = facts['session-create-rename'], memory = facts['memory-created'], browser = facts['browser-storage-initially-empty']
    if (session.createdIdMatches !== true || session.renamedTitleMatches !== true || !Number.isSafeInteger(session.renameSequence)
      || memory.matchingEntries !== 1 || memory.revisionIncreased !== true || memory.entryIdPresent !== true
      || browser.localStoragePresent !== false || browser.cookiePresent !== false) bad()
  }
  const version = facts['loaded-product-version']
  if (version.backendIdentity !== runtimeIdentity || version.candidateIdentity !== runtimeIdentity || version.expectedRootProfileIdentity !== runtimeIdentity
    || !/^[a-f\d]{64}$/u.test(version.loadedFrontendIdentity ?? '') || version.loadedFrontendIdentity !== version.frontendBuildIdentity
    || version.aboutStatus !== 'current' || version.diagnosticStatus !== 'current' || version.identityMatches !== true || version.frontendMatches !== true
    || version.aboutRendered !== true || version.shellPresent !== true || version.loadedOriginMatches !== true || version.aboutHttpStatus !== 200) bad()
  if (facts['session-persistence'].matchingTitleEvents !== 1 || facts['session-persistence'].modelOrTurnEvents !== 0
    || facts['memory-persistence'].matchingEntries !== 1 || facts['memory-persistence'].revisionMatches !== true
    || facts['memory-persistence'].persistenceStatus !== 'ready' || !/^[a-f\d]{64}$/u.test(facts['memory-persistence'].markerDigest ?? '')
    || facts['no-active-model-work'].runningSessions !== 0) bad()
  const browser = facts['browser-storage-persistence'], flush = facts['browser-storage-flush']
  if (browser.localStorageMatches !== true || browser.cookieMatches !== true || browser.nativeCookieMatches !== true
    || !Number.isSafeInteger(browser.rendererPid) || browser.rendererPid < 1 || browser.restoredWithoutWriting !== (phase === 'restore')
    || flush.cookieFlushCompleted !== true || flush.storageFlushCompleted !== true) bad()
  for (const name of ['no-model-guard-before', 'no-model-guard-after']) {
    const guard = facts[name]
    if (guard.runId !== runId || guard.mode !== 'no_model' || guard.attemptedRequests !== 0 || guard.reservedRequests !== 0
      || guard.mountCount !== (phase === 'seed' ? 1 : 2) || !Array.isArray(guard.mounts) || guard.mounts.length !== guard.mountCount) bad()
    const own = guard.mounts.filter(row => row.pid === servicePid && row.runId === runId
      && Date.parse(row.at) >= startedAt && Date.parse(row.at) <= finishedAt)
    if (own.length !== 1) bad()
  }
  return facts
}

/** Even an already-exited parent can leave an unref'ed child in its group. */
export async function runOwnedProcess(command, args, { cwd, env, timeoutMs = 300_000, onSpawn = () => {} } = {}) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let bytes = 0, timedOut = false, timer, killer, signalError
  child.stdout.on('data', chunk => { bytes += chunk.length })
  child.stderr.on('data', chunk => { bytes += chunk.length })
  const signal = value => { if (child.pid) { try { process.kill(-child.pid, value) } catch (error) { if (error.code !== 'ESRCH') signalError = error } } }
  const completion = new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ code, signal })) })
  try {
    timer = setTimeout(() => { timedOut = true; signal('SIGTERM') }, timeoutMs)
    const deadline = new Promise(done => {
      killer = setTimeout(() => { signal('SIGKILL'); done({ code: null, signal: null }) }, timeoutMs + 2_000)
    })
    onSpawn(child.pid)
    const exit = await Promise.race([completion, deadline])
    return { ...exit, pid: child.pid, bytes, timedOut }
  } finally {
    clearTimeout(timer); clearTimeout(killer)
    signal('SIGKILL')
    child.stdout.destroy(); child.stderr.destroy()
    if (child.pid) {
      let released = false
      for (let attempt = 0; attempt < 50; attempt++) {
        try { process.kill(-child.pid, 0) } catch (error) { if (error.code === 'ESRCH') { released = true; break }; signalError = error }
        await delay(100)
      }
      if (!released) throw new Error(`owned native process group cleanup could not be proven (${signalError?.code ?? 'still-present'})`, { cause: signalError })
    }
  }
}

export function publicProfilePatch({ productRoot, ledgerDirectory, runId }) {
  if (!UUID.test(runId)) throw new Error('invalid acceptance run id')
  return [
    // No credential provider, external adapter, title generation or telemetry
    // is mounted. The stream guard independently rejects any hidden caller.
    ...['credentials', 'llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'session-title-llm', 'session-telemetry-otel']
      .map(id => ({ id, disabled: true })),
    { insert: [{ id: 'acceptance-no-model', name: pathToFileURL(join(productRoot, 'scripts/acceptance/live-request-budget.mjs')).href,
      config: { ledgerDirectory, runId, maxRequests: 0, provider: 'acceptance-disabled', model: 'acceptance-disabled', sessionIds: [] } }] },
  ]
}

/** Only public package payloads are linked; never copy a user's configuration. */
export async function createPublicProfile({ productRoot, acceptanceRoot, runId, environment }) {
  const dshRoot = join(productRoot, 'runtime/DSH')
  const profileRoot = join(acceptanceRoot, 'dsh-home/profiles/web')
  await mkdir(join(profileRoot, 'node_modules'), { recursive: true, mode: 0o700 })
  const roots = [productRoot, ...PRODUCT_PACKAGES.map(name => join(productRoot, 'packages', name)),
    join(dshRoot, 'packages/session-query/tool-session-query'), join(dshRoot, 'packages/web/web-fetch-http')]
  const dependencies = {}
  for (const packageRoot of roots) {
    const manifest = await json(join(packageRoot, 'package.json'))
    if (!/^@(?:xiaoshe|deepseek-ai)\/[a-z\d-]+$/u.test(manifest.name)) throw new Error('unexpected product package name')
    const target = join(profileRoot, 'node_modules', manifest.name)
    await mkdir(dirname(target), { recursive: true })
    await symlink(await realpath(packageRoot), target, 'dir')
    dependencies[manifest.name] = `link:${await realpath(packageRoot)}`
  }
  await save(join(profileRoot, 'package.json'), { name: 'xiaoshe-isolated-product-acceptance', private: true,
    dependencies, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      '@xiaoshe/dsh-desktop-control', '@xiaoshe/product-bundle'] } } })
  await save(join(profileRoot, 'cordis.patch.yml'), publicProfilePatch({ productRoot, runId, ledgerDirectory: join(acceptanceRoot, 'budget') }))
  // The real CLI rewrites its public root config at boot. Prepare it with the
  // same implementation BEFORE computing identity, so boot cannot stale itself.
  // The CLI bundles profile-boot into hashed chunks. Its documented dump entry
  // composes without booting or evaluating !!js; do not guess an internal path.
  await exec(process.execPath, [join(dshRoot, 'apps/cli/lib/bin.js'), '--profile', 'web', '--dump-config'],
    { cwd: join(acceptanceRoot, 'workspace'), env: environment, timeout: 30_000, maxBuffer: 1_048_576 })
  return profileRoot
}

async function freePort() {
  const server = createNetServer()
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const port = server.address().port
  await new Promise((done, fail) => server.close(error => error ? fail(error) : done()))
  if (port === 3080) return freePort()
  return port
}

/** Distinguish a missing owned label from permission/launchctl failure. */
export async function serviceAbsent(label) {
  try { await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { timeout: 5_000, maxBuffer: 262_144 }); return false }
  catch (error) {
    if (error.code === 113 && /Could not find service/u.test(error.stderr ?? '')) return true
    throw new Error('cannot establish acceptance service ownership state')
  }
}

async function portAbsent(port) {
  const server = createNetServer()
  try { await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done) }); return true }
  catch (error) { if (error.code === 'EADDRINUSE') return false; throw error }
  finally { if (server.listening) await new Promise(done => server.close(done)) }
}

export function inspectGracefulExit(records) {
  const shutdown = records.filter(row => row.event === 'shutdown-complete').at(-1)
  return records.some(row => row.event === 'ui-ready') && shutdown?.service?.stopped === true
    && !records.some(row => ['shutdown-failed', 'boot-failed'].includes(row.event))
}

async function runPhase({ productRoot, acceptanceRoot, environment, phase, onProgress }) {
  const path = join(acceptanceRoot, `${phase}-report.json`)
  // A second run may never reuse a successful report from an earlier attempt.
  if (await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('phase report already exists')
  const token = randomUUID()
  const env = { ...environment, XIAOSHE_LAUNCH_TOKEN: token, XIAOSHE_DESKTOP_ACCEPTANCE_PHASE: phase }
  onProgress({ phase, status: 'starting' })
  const startedAt = Date.now()
  let outcome, servicePid, done = false
  const observer = (async () => {
    while (!done) {
      const value = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${environment.XIAOSHE_DSH_SERVICE_LABEL}`], { timeout: 5_000, maxBuffer: 262_144 }).catch(() => null)
      if (value && new RegExp(`XIAOSHE_LAUNCH_TOKEN(?:\\s*(?:=>|=)\\s*)${token}`, 'u').test(value.stdout)) {
        const pid = Number(value.stdout.match(/^\s*pid = (\d+)\s*$/mu)?.[1])
        if (Number.isSafeInteger(pid) && pid > 0) { servicePid = pid; break }
      }
      await delay(150)
    }
  })()
  try {
    outcome = await runOwnedProcess('/bin/bash', [join(productRoot, '启动小蛇.command'), '--acceptance-lifecycle'], { cwd: productRoot, env })
  } finally {
    done = true; await observer
    // launchd is outside the child group; compensate ONLY this launch token,
    // including spawn/timeout failure. Never infer absence from an API error.
    if (!(await serviceAbsent(environment.XIAOSHE_DSH_SERVICE_LABEL))) {
      await exec('/bin/bash', [join(productRoot, 'scripts/stop-xiaoshe-web.sh'), '--ownership-token', token],
        { cwd: productRoot, env, timeout: 30_000, maxBuffer: 262_144 })
      throw new Error(`${phase}: main did not release its service; compensated owned token`)
    }
  }
  if (outcome.timedOut || outcome.code !== 0) throw new Error(`${phase}: native launcher failed (exit=${outcome.code}, timeout=${outcome.timedOut}, logBytes=${outcome.bytes})`)
  if (!(await portAbsent(Number(environment.XIAOSHE_DSH_PORT)))) throw new Error(`${phase}: acceptance port still occupied`)
  const records = (await readFile(join(environment.XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA, 'logs/desktop-shell.jsonl'), 'utf8'))
    .trim().split('\n').map(JSON.parse)
  const latestStart = records.findLastIndex(row => row.event === 'boot-started')
  const ownRecords = records.slice(latestStart)
  if (!inspectGracefulExit(ownRecords)) throw new Error(`${phase}: graceful main shutdown not proven`)
  const report = await json(path)
  if (!servicePid) throw new Error(`${phase}: native service PID/token ownership was not observed`)
  const runtimeIdentity = await productRuntimeIdentity({ root: productRoot, dshRoot: join(productRoot, 'runtime/DSH'), profileRoot: join(environment.DSH_HOME, 'profiles/web') })
  validatePhaseReport(report, { runId: environment.XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID, phase, pid: outcome.pid,
    runtimeIdentity, startedAt, finishedAt: Date.now(), servicePid })
  onProgress({ phase, status: 'exited', graceful: true })
  return { report, records: ownRecords, exit: outcome, servicePid, ownedServiceReleased: true }
}

export async function runProductLifecycle({ productRoot = productDefault, onProgress = value => process.stdout.write(`${JSON.stringify(value)}\n`) } = {}) {
  if (process.platform !== 'darwin') throw new Error('real macOS acceptance requires macOS; no simulated platform pass')
  productRoot = await realpath(productRoot)
  const runId = randomUUID(), createdAt = new Date().toISOString()
  const outputParent = join(productRoot, 'output/stabilization')
  await mkdir(outputParent, { recursive: true, mode: 0o700 })
  if (await realpath(outputParent) !== outputParent) throw new Error('acceptance output must not traverse a symlink')
  const outputDirectory = join(outputParent, `product-lifecycle-${runId}`)
  await exec('git', ['check-ignore', '--quiet', '--no-index', outputDirectory], { cwd: productRoot, timeout: 5_000 })
  // Every attempt has a fresh directory; previous failure evidence is retained.
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 })
  const acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  let rootOwned = false, port, fixture, environment, sourceBefore, sourceAfter, runtimeIdentity, seed, restore, budget
  const failures = [], cleanup = []
  const settle = async (id, action) => {
    try { await action(); cleanup.push({ id, state: 'pass' }) }
    catch (error) { failures.push(`${id}: ${error.message}`); cleanup.push({ id, state: 'fail' }) }
  }
  try {
    await mkdir(acceptanceRoot, { mode: 0o700 }); rootOwned = true
    await chmod(acceptanceRoot, 0o700)
    const directories = ['dsh-home', 'state', 'logs', 'xiaoshe-windows-acceptance-user-data', 'budget', 'workspace']
    for (const name of directories) await mkdir(join(acceptanceRoot, name), { mode: 0o700 })
    await mkdir(join(acceptanceRoot, 'dsh-home/profiles/web'), { recursive: true, mode: 0o700 })
    port = await freePort()
    fixture = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end('<!doctype html><html><head><title>Xiaoshe lifecycle fixture</title></head><body><h1>Owned lifecycle storage fixture</h1></body></html>') })
    await new Promise((done, fail) => { fixture.once('error', fail); fixture.listen(0, '127.0.0.1', done) })
    environment = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1',
      XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: acceptanceRoot, XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: runId,
      XIAOSHE_ACCEPTANCE_WORKSPACE: join(acceptanceRoot, 'workspace'),
      XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(acceptanceRoot, 'xiaoshe-windows-acceptance-user-data'),
      XIAOSHE_STATE_ROOT: join(acceptanceRoot, 'state'), XIAOSHE_DSH_LOG_DIR: join(acceptanceRoot, 'logs'),
      DSH_HOME: join(acceptanceRoot, 'dsh-home'), XIAOSHE_DSH_PORT: String(port),
      XIAOSHE_DSH_SERVICE_LABEL: `com.xiaoshe.acceptance.${runId}`, XIAOSHE_NODE: await realpath(process.execPath),
      XIAOSHE_PYTHON: process.env.XIAOSHE_PYTHON ?? '/opt/miniconda3/bin/python3',
      XIAOSHE_PNPM_CLI: join(process.env.HOME, '.local/share/xiaoshe/pnpm-11.7.0/node_modules/pnpm/bin/pnpm.cjs'),
      XIAOSHE_DESKTOP_URL: `http://127.0.0.1:${port}/`, XIAOSHE_DESKTOP_ACTIONS: 'off',
      XIAOSHE_DSH_NO_OPEN: '1', XIAOSHE_DSH_NO_PAUSE: '1', DSH_TELEMETRY_DISABLED: '1',
      XIAOSHE_DESKTOP_START_HIDDEN: '1',
      XIAOSHE_DESKTOP_ACCEPTANCE_FIXTURE_URL: `http://127.0.0.1:${fixture.address().port}/`,
    }
    acceptanceServiceEnvironment(environment, { temporaryRoot: tmpdir(), platform: process.platform })
    if (!(await serviceAbsent(environment.XIAOSHE_DSH_SERVICE_LABEL))) throw new Error('acceptance label already exists')
    const profileRoot = await createPublicProfile({ productRoot, acceptanceRoot, runId, environment })
    sourceBefore = await captureCandidate(productRoot)
    runtimeIdentity = await productRuntimeIdentity({ root: productRoot, dshRoot: join(productRoot, 'runtime/DSH'), profileRoot })
    seed = await runPhase({ productRoot, acceptanceRoot, environment, phase: 'seed', onProgress })
    await save(join(outputDirectory, 'seed.json'), seed)
    if (runtimeIdentity !== await productRuntimeIdentity({ root: productRoot, dshRoot: join(productRoot, 'runtime/DSH'), profileRoot })) throw new Error('runtime payload changed during seed')
    restore = await runPhase({ productRoot, acceptanceRoot, environment, phase: 'restore', onProgress })
    await save(join(outputDirectory, 'restore.json'), restore)
    if (runtimeIdentity !== await productRuntimeIdentity({ root: productRoot, dshRoot: join(productRoot, 'runtime/DSH'), profileRoot })) throw new Error('runtime payload changed during restore')
    const { readBudgetLedger } = await import('../acceptance/live-request-budget.mjs')
    budget = await readBudgetLedger(join(acceptanceRoot, 'budget'))
    if (!budget.mounted || budget.mountCount !== 2 || budget.attemptedRequests !== 0 || budget.reservedRequests !== 0 || budget.mode !== 'no_model') throw new Error('no-model guard not proven')
  } catch (error) { failures.push(error.message) }
  finally {
    await settle('owned-fixture-closed', async () => {
      if (fixture?.listening) await new Promise((done, fail) => { fixture.close(error => error ? fail(error) : done()); fixture.closeAllConnections() })
    })
    const absent = environment ? await serviceAbsent(environment.XIAOSHE_DSH_SERVICE_LABEL).catch(() => false) : true
    const released = port ? await portAbsent(port).catch(() => false) : true
    cleanup.push({ id: 'owned-service-released', state: absent && released ? 'pass' : 'fail' })
    // Preserve an owned failure directory if service ownership is uncertain;
    // deleting runtime data underneath a live launchd service is never cleanup.
    if (absent && released) {
      await settle('owned-evidence-retained', async () => {
        const files = ['seed-report.json', 'restore-report.json', 'logs/web.error.log', 'logs/web.log', 'xiaoshe-windows-acceptance-user-data/logs/desktop-shell.jsonl']
        for (const name of files) await copyFile(join(acceptanceRoot, name), join(outputDirectory, `raw-${name.replaceAll('/', '-')}`)).catch(error => { if (error.code !== 'ENOENT') throw error })
      })
      await settle('owned-profile-removed', async () => { if (rootOwned) await rm(acceptanceRoot, { recursive: true }) })
    } else cleanup.push({ id: 'owned-profile-removed', state: 'fail' })
  }
  try {
    sourceAfter = await captureCandidate(productRoot)
    if (!sourceBefore || sourceBefore.sha256 !== sourceAfter.sha256) throw new Error('candidate source changed or was not captured')
  } catch (error) { failures.push(error.message) }
  const report = { schema: 'xiaoshe-product-lifecycle/v1', runId, createdAt, finishedAt: new Date().toISOString(),
    sourceBefore, sourceAfter, runtimeIdentity, executionKind: 'product_no_model', modelCalls: budget?.attemptedRequests ?? null,
    phases: { seed: !!seed, restore: !!restore }, budget, cleanup,
    status: !failures.length && cleanup.every(row => row.state === 'pass') ? 'pass' : 'fail',
    failures, retainedRoot: cleanup.some(row => row.id === 'owned-profile-removed' && row.state === 'fail') ? acceptanceRoot : null }
  await save(join(outputDirectory, 'report.json'), report)
  if (report.status === 'pass') {
    const provenChecks = {
      'version-start-current': ['launcher-target-matched', 'profile-matched', 'runtime-identity-matched', 'frontend-build-matched', 'product-ready'],
      'version-session-restart': ['persistent-state-seeded', 'graceful-exit', 'owned-service-released', 'state-restored', 'browser-store-restored'],
    }
    // Adding a catalog requirement must not silently pass an unobserved check.
    const tasks = Object.entries(provenChecks).map(([taskId, checks]) => ({ taskId, state: 'pass',
      checks: checks.map(id => ({ id, state: 'pass' })),
      metrics: { durationMs: Date.parse(report.finishedAt) - Date.parse(createdAt), retryCount: 0, humanInterventions: 0,
        inputTokens: 0, outputTokens: 0, cost: null } }))
    // Only the two complete real-product contracts are exported, never the
    // model task contracts. Source, runtime and cleanup bind this exact run.
    await save(join(outputDirectory, 'task-run.json'), { schema: 'xiaoshe-task-run/v1', runId, createdAt,
      finishedAt: report.finishedAt, binding: { sourceSha256: sourceBefore.sha256, runtimeIdentity },
      executionKind: 'product_no_model', tasks, cleanup })
  }
  onProgress({ status: report.status, outputDirectory })
  return { report, outputDirectory }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('product-lifecycle.mjs takes no arguments; outputs are unique and never overwritten')
  runProductLifecycle().then(({ report }) => { if (report.status !== 'pass') process.exitCode = 1 }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
