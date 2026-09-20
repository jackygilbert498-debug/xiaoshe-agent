#!/usr/bin/env node
/** Same real main/backend for thirty minutes; never model-task acceptance. */
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open, mkdir, lstat, realpath, readFile, cp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createPublicProfile, runOwnedProcess, serviceAbsent, inspectGracefulExit } from '../quality/product-lifecycle.mjs'
import { captureCandidate } from '../quality/internal-beta.mjs'
import { productRuntimeIdentity } from '../product-runtime-identity.mjs'
import { readBudgetLedger } from './live-request-budget.mjs'
import { unusedPort } from './same-session-files-live.mjs'
import { assertMaterialBackendPortReleased, removeOwnedMaterialRoot } from './material-live.mjs'
import { acceptanceServiceEnvironment } from '../../apps/desktop-shell/src/acceptance-isolation.mjs'
import { STABILITY_DURATION_MS, STABILITY_INTERVAL_MS, STABILITY_MAX_LAG_MS, assertStabilityGuard, stabilityText } from '../../apps/desktop-shell/src/stability-acceptance.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const exec = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => /^[a-f\d]{64}$/u.test(value ?? '')
async function save(path, value) {
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() } finally { await file.close() }
}

export function parseStabilityArgs(args) {
  if (args.length !== 1 || args[0] !== '--run-authorized') throw new Error('usage: stability-live.mjs --run-authorized (fixed thirty minutes; no duration or resume options)')
  return { runAuthorized: true }
}

export async function verifyStabilityDisk(workspaceRoot, row) {
  if (row.kind !== 'transaction' || !Number.isInteger(row.data?.index)) throw new Error('invalid independent disk observation')
  const path = join(workspaceRoot, 'soak.txt')
  if (await realpath(workspaceRoot) !== workspaceRoot || await realpath(path) !== path) throw new Error('stability workspace/file is a symlink')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > 4096) throw new Error('unsafe stability output file')
    const bytes = await file.readFile()
    const after = await file.stat(), current = await lstat(path)
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || current.ino !== after.ino || current.dev !== after.dev) throw new Error('stability output changed while observed')
    const sha256 = hash(bytes)
    if (sha256 !== hash(stabilityText(row.runId, row.data.index)) || sha256 !== row.data.afterSha256) throw new Error('independent disk bytes differ from workbench receipt')
    return { sha256, bytes: bytes.length, singleLink: true, canonical: true }
  } finally { await file.close() }
}

export async function assertStabilityJournals({ nativePath, observationsPath, samples, observations }) {
  const native = await readFile(nativePath, 'utf8'), observed = await readFile(observationsPath, 'utf8')
  const expected = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  if (!samples.length || !observations.length || native !== expected(samples) || observed !== expected(observations)) throw new Error('raw stability journals differ from the exact consumed observations')
  return { nativeSha256: hash(native), observationsSha256: hash(observed), nativeBytes: Buffer.byteLength(native), observationsBytes: Buffer.byteLength(observed) }
}

export function validateStabilityEvidence(native, samples, observations, { runId, pid, servicePid, runtimeIdentity, startedAt, finishedAt, elapsedMs }) {
  const bad = message => { throw new Error(`stability evidence incomplete: ${message}`) }
  if (native?.schema !== 'xiaoshe-stability-native/v1' || native.executionKind !== 'product_no_model' || native.accepted !== true
    || native.failure !== undefined || native.runId !== runId || native.sessionId !== `xiaoshe-stability-${runId}`
    || native.pid !== pid || native.backendPid !== servicePid || native.shutdown !== 'pending-parent-observation') bad('native run binding')
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt
    || !Number.isFinite(elapsedMs) || elapsedMs < STABILITY_DURATION_MS || !Number.isFinite(native.elapsedMs) || native.elapsedMs < STABILITY_DURATION_MS
    || !Number.isFinite(Date.parse(native.finishedAt))
    || !Number.isFinite(Date.parse(native.measuredStartedAt)) || Date.parse(native.measuredStartedAt) < startedAt
    || Date.parse(native.finishedAt) > finishedAt || Date.parse(native.finishedAt) - Date.parse(native.measuredStartedAt) < STABILITY_DURATION_MS) bad('thirty-minute clock binding')
  for (const version of [native.frontendBefore, native.frontendAfter]) {
    if (!version?.identityMatches || !version.frontendMatches || version.backendIdentity !== runtimeIdentity || version.expectedRootProfileIdentity !== runtimeIdentity
      || version.candidateIdentity !== runtimeIdentity || !digest(version.loadedFrontendIdentity) || version.loadedFrontendIdentity !== version.frontendBuildIdentity
      || version.aboutStatus !== 'current' || version.diagnosticStatus !== 'current' || version.aboutRendered !== true || version.shellPresent !== true
      || version.loadedOriginMatches !== true || version.aboutHttpStatus !== 200 || version.product !== '小蛇' || version.bridgeState !== 'ready') bad('loaded version')
  }
  if (native.frontendBefore.loadedFrontendIdentity !== native.frontendAfter.loadedFrontendIdentity) bad('frontend changed')
  for (const ledger of [native.budgetBefore, native.budgetAfter]) {
    assertStabilityGuard(ledger, runId, servicePid)
    if (!Number.isFinite(Date.parse(ledger.mounts[0].at)) || Date.parse(ledger.mounts[0].at) < startedAt || Date.parse(ledger.mounts[0].at) > finishedAt) bad('budget mount time')
  }
  if (native.noModelEvents !== true || native.runningSessions !== 0) bad('unexpected model work')
  if (native.onboarding?.acknowledged !== true || native.onboarding.ready !== true) bad('fresh-profile onboarding')
  if (!Array.isArray(samples) || !Array.isArray(observations) || samples.length !== 170 || observations.length !== 138) bad('sample counts')
  const health = [], resources = [], transactions = [], recovery = []
  let previousTime = -1, previousAt = startedAt
  const ids = new Set()
  for (let index = 0; index < samples.length; index++) {
    const row = samples[index]
    if (row.schema !== 'xiaoshe-stability-sample/v1' || row.runId !== runId || row.seq !== index + 1 || !Number.isFinite(row.elapsedMs)
      || row.elapsedMs < previousTime || !Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) < previousAt || Date.parse(row.at) > finishedAt) bad('ordered raw samples')
    previousTime = row.elapsedMs; previousAt = Date.parse(row.at)
    if (row.kind === 'health') health.push(row)
    else if (row.kind === 'resource') resources.push(row)
    else if (row.kind === 'transaction') transactions.push(row)
    else if (row.kind === 'recovery') recovery.push(row)
    else bad('unknown sample type')
  }
  const sameProcess = (actual, expected, expectedPid) => actual?.pid === expectedPid && actual.started === expected?.started && Number.isFinite(Date.parse(actual.started))
  if (health.length !== 121 || resources.length !== 31 || transactions.length !== 17 || recovery.length !== 1
    || JSON.stringify(native.counts) !== JSON.stringify({ health: 121, resource: 31, transaction: 17, recovery: 1 })) bad('required cadence/actions')
  for (let index = 0; index < health.length; index++) {
    const row = health[index], facts = row.data
    if (row.slot !== index || row.elapsedMs < index * STABILITY_INTERVAL_MS || row.elapsedMs > index * STABILITY_INTERVAL_MS + STABILITY_MAX_LAG_MS
      || !sameProcess(facts.main, native.processes?.main, pid) || !sameProcess(facts.backend, native.processes?.backend, servicePid)
      || facts.product !== '小蛇' || facts.bridgeState !== 'ready' || facts.runtimeIdentity !== runtimeIdentity
      || facts.renderer?.shellPresent !== true || facts.renderer.readyState !== 'complete' || facts.renderer.interactive !== true || facts.renderer.ownedSessionSelected !== true
      || !Number.isSafeInteger(facts.renderer.pid) || facts.renderer.pid < 1) bad('health identity/cadence')
  }
  for (let index = 0; index < resources.length; index++) {
    const row = resources[index]
    if (row.slot !== index * 4) bad('resource cadence')
    for (const role of ['main', 'backend']) {
      const value = row.data[role]
      if (!sameProcess(value, native.processes[role], role === 'main' ? pid : servicePid) || !Number.isSafeInteger(value.rssKiB) || value.rssKiB < 1
        || !Number.isFinite(value.cpuSeconds) || value.cpuSeconds < (resources[index - 1]?.data[role].cpuSeconds ?? 0)) bad('resource observation')
    }
  }
  let previousHash = hash(stabilityText(runId, -1))
  const expectedIndexes = [...Array.from({ length: 8 }, (_, index) => index), 1000, ...Array.from({ length: 8 }, (_, index) => index + 8)]
  for (let index = 0; index < transactions.length; index++) {
    const row = transactions[index], value = row.data, expectedIndex = expectedIndexes[index]
    if (value.index !== expectedIndex || row.slot !== (expectedIndex === 1000 ? 60 : expectedIndex * 8) || value.recovered !== (expectedIndex === 1000)
      || value.beforeSha256 !== previousHash || value.afterSha256 !== hash(stabilityText(runId, expectedIndex)) || value.apiReadSha256 !== value.afterSha256
      || value.confirmationRequests !== 1 || value.appliedReceipts !== 1 || typeof value.transactionId !== 'string' || ids.has(value.transactionId)) bad('transaction sequence/hash')
    ids.add(value.transactionId); previousHash = value.afterSha256
  }
  const resumed = transactions.find(row => row.data.recovered), restored = recovery[0]
  if (restored.slot !== 60 || restored.data.transactionId !== resumed.data.transactionId || restored.data.state !== 'prepared'
    || restored.data.beforeSha256 !== resumed.data.beforeSha256 || restored.data.afterSha256 !== resumed.data.afterSha256
    || restored.data.reloadCompleted !== true || restored.data.interactiveAfter !== true || restored.data.confirmationAbsent !== true) bad('renderer/pending transaction recovery')
  const observedSeq = new Set(); let previousObservationAt = startedAt, previousNativeSeq = 0
  for (const observed of observations) {
    const row = samples[observed.nativeSeq - 1]
    if (observed.runId !== runId || !Number.isSafeInteger(observed.nativeSeq) || observed.nativeSeq <= previousNativeSeq || observedSeq.has(observed.nativeSeq) || !row || !['health', 'transaction'].includes(row.kind)
      || !Number.isFinite(Date.parse(observed.at)) || Date.parse(observed.at) < previousObservationAt || Date.parse(observed.at) > finishedAt
      || Date.parse(observed.at) < Date.parse(row.at) || Date.parse(observed.at) > Date.parse(row.at) + STABILITY_MAX_LAG_MS) bad('independent observer coverage')
    previousObservationAt = Date.parse(observed.at); previousNativeSeq = observed.nativeSeq
    observedSeq.add(observed.nativeSeq)
    if (row.kind === 'health' && (observed.servicePid !== servicePid || observed.tokenMatches !== true || observed.runtimeIdentity !== runtimeIdentity
      || observed.product !== '小蛇' || observed.bridgeState !== 'ready')) bad('independent host observation')
    if (row.kind === 'transaction' && (observed.disk?.sha256 !== row.data.afterSha256 || observed.disk.canonical !== true || observed.disk.singleLink !== true)) bad('independent disk observation')
  }
  return { status: 'pass', scope: 'thirty-minute-host-soak-and-controlled-local-workflow-not-model-delivery',
    measuredMs: native.elapsedMs, healthSamples: health.length, resourceSamples: resources.length, workbenchTransactions: transactions.length,
    rendererReloadRecoveries: 1, modelRequests: 0,
    resourceAssessment: 'observed-only-not-a-leak-free-or-long-term-memory-stability-claim',
    resources: Object.fromEntries(['main', 'backend'].map(role => [role, { firstRssKiB: resources[0].data[role].rssKiB,
      lastRssKiB: resources.at(-1).data[role].rssKiB, peakRssKiB: Math.max(...resources.map(row => row.data[role].rssKiB)) }])) }
}

export async function finalizeStabilityReport(report, { outputDirectory, capture, onProgress = async () => {} }) {
  try { report.sourceAfter = await capture() } catch { report.failures.push({ stage: 'source-after', message: 'source snapshot unavailable' }); report.sourceAfter = null }
  if (!digest(report.sourceBefore?.sha256) || report.sourceBefore.sha256 !== report.sourceAfter?.sha256) report.failures.push({ stage: 'source-binding', message: 'source changed or missing' })
  try { await onProgress({ stage: 'evidence-finalizing', outputDirectory }) } catch { report.failures.push({ stage: 'progress-observer', message: 'progress observer failed' }) }
  report.finishedAt = new Date().toISOString()
  report.status = report.executionKind === 'product_no_model' && !report.failures.length && report.proof?.status === 'pass'
    && report.cleanup.length > 0 && report.cleanup.every(row => row.state === 'pass') ? 'pass' : 'fail'
  await save(join(outputDirectory, 'report.json'), report)
  return report
}

export async function runStabilityLive(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('explicit fixed stability run authorization required')
  const descriptors = Object.getOwnPropertyDescriptors(options)
  if (Reflect.ownKeys(descriptors).some(key => !['runAuthorized', 'onProgress'].includes(key))
    || Object.values(descriptors).some(value => value.get || value.set) || descriptors.runAuthorized?.value !== true) throw new Error('explicit fixed stability run authorization required')
  if (process.platform !== 'darwin') throw new Error('real macOS stability acceptance requires macOS')
  const onProgress = options.onProgress ?? (value => process.stdout.write(`${JSON.stringify(value)}\n`))
  if (typeof onProgress !== 'function') throw new Error('invalid progress observer')
  const runId = randomUUID(), createdAt = new Date().toISOString(), monotonicStart = performance.now()
  const outputDirectory = join(root, 'output/stabilization', `stability-live-${runId}`)
  const acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  const label = `com.xiaoshe.acceptance.${runId}`, token = randomUUID(), failures = [], cleanup = []
  let ownedStat, environment, port, sourceBefore, sourceAfter, runtimeIdentity, profileRoot, servicePid, childPid, childFinished = true,
    interrupted = false, escalation, exit, native, budget, proof, journal, observerError, journalBinding
  const samples = [], observations = []
  const note = (stage, error) => failures.push({ stage, message: String(error?.message ?? error).slice(0, 1000) })
  const settle = async (id, operation) => { try { await operation(); cleanup.push({ id, state: 'pass' }) } catch (error) { cleanup.push({ id, state: 'fail' }); note(id, error) } }
  const interrupt = () => {
    interrupted = true
    if (!childPid || childFinished) return
    const signal = value => { try { process.kill(-childPid, value) } catch (error) { if (error.code !== 'ESRCH') note('signal-owned-main', error) } }
    signal('SIGTERM')
    if (!escalation) escalation = setTimeout(() => { if (!childFinished) signal('SIGKILL') }, 8_000)
  }
  const inspectService = async () => {
    const value = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { timeout: 4_000, maxBuffer: 262144 })
    const tokenMatches = new RegExp(`XIAOSHE_LAUNCH_TOKEN(?:\\s*(?:=>|=)\\s*)${token}`, 'u').test(value.stdout)
    const pid = Number(value.stdout.match(/^\s*pid = (\d+)\s*$/mu)?.[1])
    if (!tokenMatches || !Number.isSafeInteger(pid) || pid < 1 || (servicePid !== undefined && servicePid !== pid)) throw new Error('same launchd token/backend PID no longer present')
    servicePid = pid
    return { servicePid, tokenMatches }
  }
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 })
  if (await realpath(dirname(outputDirectory)) !== dirname(outputDirectory)) throw new Error('unsafe output parent')
  await exec('git', ['check-ignore', '--quiet', '--no-index', outputDirectory], { cwd: root, timeout: 5_000 })
  await mkdir(outputDirectory, { mode: 0o700 })
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  try {
    await onProgress({ stage: 'setup', runId, outputDirectory, fixedDurationMs: STABILITY_DURATION_MS, modelRequests: 0 })
    await mkdir(acceptanceRoot, { mode: 0o700 }); ownedStat = await lstat(acceptanceRoot)
    for (const name of ['home', 'workspace', 'dsh-home/profiles/web', 'state', 'logs', 'budget', 'xiaoshe-windows-acceptance-user-data']) await mkdir(join(acceptanceRoot, name), { recursive: true, mode: 0o700 })
    const file = await open(join(acceptanceRoot, 'workspace/soak.txt'), 'wx', 0o600)
    try { await file.writeFile(stabilityText(runId, -1)); await file.sync() } finally { await file.close() }
    port = await unusedPort()
    environment = { PATH: process.env.PATH, HOME: join(acceptanceRoot, 'home'), TMPDIR: await realpath(tmpdir()),
      DSH_HOME: join(acceptanceRoot, 'dsh-home'), DSH_TELEMETRY_DISABLED: '1',
      XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: acceptanceRoot,
      XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: runId, XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(acceptanceRoot, 'xiaoshe-windows-acceptance-user-data'),
      XIAOSHE_ACCEPTANCE_WORKSPACE: join(acceptanceRoot, 'workspace'), XIAOSHE_STATE_ROOT: join(acceptanceRoot, 'state'),
      XIAOSHE_DSH_LOG_DIR: join(acceptanceRoot, 'logs'), XIAOSHE_DSH_SERVICE_LABEL: label, XIAOSHE_LAUNCH_TOKEN: token,
      XIAOSHE_DSH_PORT: String(port), XIAOSHE_DESKTOP_URL: `http://127.0.0.1:${port}/`,
      XIAOSHE_NODE: await realpath(process.execPath), XIAOSHE_PYTHON: process.env.XIAOSHE_PYTHON ?? '/opt/miniconda3/bin/python3',
      XIAOSHE_PNPM_CLI: join(process.env.HOME, '.local/share/xiaoshe/pnpm-11.7.0/node_modules/pnpm/bin/pnpm.cjs'),
      XIAOSHE_DESKTOP_ACTIONS: 'off', XIAOSHE_DSH_NO_OPEN: '1', XIAOSHE_DSH_NO_PAUSE: '1', XIAOSHE_DESKTOP_START_HIDDEN: '1' }
    acceptanceServiceEnvironment(environment)
    if (!(await serviceAbsent(label))) throw new Error('own service label already exists')
    profileRoot = await createPublicProfile({ productRoot: root, acceptanceRoot, runId, environment })
    sourceBefore = await captureCandidate(root)
    runtimeIdentity = await productRuntimeIdentity({ root, dshRoot: join(root, 'runtime/DSH'), profileRoot })
    journal = await open(join(outputDirectory, 'observations.jsonl'), 'wx', 0o600)
    if (interrupted) throw new Error('interrupted before native launch')
    childFinished = false
    const observe = async () => {
      let consumed = 0
      for (;;) {
        const drainingFinal = childFinished
        const text = await readFile(join(acceptanceRoot, 'stability-samples.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
        if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('native sample journal exceeds bound')
        const complete = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean)
        if (complete.length < consumed) throw new Error('native sample journal was truncated')
        for (; consumed < complete.length; consumed++) {
          const row = JSON.parse(complete[consumed]); samples.push(row)
          if (row.seq !== consumed + 1 || row.runId !== runId) throw new Error('native sample sequence mismatch')
          if (!['health', 'transaction'].includes(row.kind)) continue
          const observation = { runId, nativeSeq: row.seq, at: new Date().toISOString() }
          if (row.kind === 'transaction') observation.disk = await verifyStabilityDisk(join(acceptanceRoot, 'workspace'), row)
          else {
            Object.assign(observation, await inspectService())
            const response = await fetch(new URL('xiaoshe/desktop/status', environment.XIAOSHE_DESKTOP_URL), { redirect: 'error', signal: AbortSignal.timeout(4_000) })
            if (!response.ok) throw new Error('independent host health failed')
            const data = await response.json()
            Object.assign(observation, { product: data.product, bridgeState: data.bridge?.state, runtimeIdentity: data.runtime_identity })
          }
          observation.at = new Date().toISOString()
          observations.push(observation); await journal.write(`${JSON.stringify(observation)}\n`); await journal.sync()
          if (row.kind === 'health' && row.slot % 4 === 0) await onProgress({ stage: 'measuring', runId, seconds: Math.floor(row.elapsedMs / 1000), fixedSeconds: 1800, samples: row.slot + 1, modelRequests: 0 })
          if (row.seq === 170) await save(join(acceptanceRoot, 'stability-observer-ack.json'), { runId, seq: row.seq, observations: observations.length })
        }
        if (drainingFinal) break
        await delay(250)
      }
    }
    const observer = observe().catch(error => { observerError = error; interrupt() })
    try {
      exit = await runOwnedProcess('/bin/bash', [join(root, '启动小蛇.command'), '--acceptance-stability'], { cwd: root, env: environment,
        timeoutMs: STABILITY_DURATION_MS + 5 * 60_000, onSpawn: pid => { childPid = pid; if (interrupted) interrupt() } })
    } finally { childFinished = true; clearTimeout(escalation); await observer }
    if (observerError) throw observerError
    native = JSON.parse(await readFile(join(acceptanceRoot, 'stability-native.json'), 'utf8'))
    if (!native.accepted || native.failure) throw new Error(`native stability failed: ${native.failure?.stage ?? 'unknown'}: ${native.failure?.message ?? 'not accepted'}`)
    if (exit.code !== 0 || exit.timedOut) throw new Error('native main failed or timed out')
    const records = (await readFile(join(environment.XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA, 'logs/desktop-shell.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    if (!inspectGracefulExit(records)) throw new Error('formal main shutdown not proven')
    proof = validateStabilityEvidence(native, samples, observations, { runId, pid: childPid, servicePid, runtimeIdentity,
      startedAt: Date.parse(createdAt), finishedAt: Date.now(), elapsedMs: performance.now() - monotonicStart })
    journalBinding = await assertStabilityJournals({ nativePath: join(acceptanceRoot, 'stability-samples.jsonl'), observationsPath: join(outputDirectory, 'observations.jsonl'), samples, observations })
    if (runtimeIdentity !== await productRuntimeIdentity({ root, dshRoot: join(root, 'runtime/DSH'), profileRoot })) throw new Error('runtime changed during soak')
  } catch (error) { note('execution', error) }
  finally {
    clearTimeout(escalation)
    if (journal) await settle('observation-journal-closed', () => journal.close())
    await settle('owned-main-group-released', async () => {
      if (!childPid) return
      try { process.kill(-childPid, 0); throw new Error('owned main group remains') } catch (error) { if (error.code !== 'ESRCH') throw error }
    })
    if (environment) await settle('owned-service-released', async () => {
      if (!(await serviceAbsent(label))) {
        await exec('/bin/bash', [join(root, 'scripts/stop-xiaoshe-web.sh'), '--ownership-token', token], { cwd: root, env: environment, timeout: 30_000, maxBuffer: 262144 })
        if (!(await serviceAbsent(label))) throw new Error('service token cleanup failed')
        note('compensated-shutdown', new Error('normal main service release was not completed'))
      }
      if (servicePid) { try { process.kill(servicePid, 0); throw new Error('backend PID remains') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    })
    if (port) await settle('owned-backend-port-released', () => assertMaterialBackendPortReleased(port))
    await settle('source-before-cleanup', async () => {
      sourceAfter = await captureCandidate(root)
      if (!digest(sourceBefore?.sha256) || sourceBefore.sha256 !== sourceAfter.sha256) throw new Error('source changed or unknown; isolated root retained')
    })
    if (ownedStat) {
      await settle('no-model-final-ledger', async () => { budget = await readBudgetLedger(join(acceptanceRoot, 'budget')); assertStabilityGuard(budget, runId, servicePid) })
      for (const name of ['workspace', 'budget']) await settle(`retained-${name}`, () => cp(join(acceptanceRoot, name), join(outputDirectory, name), { recursive: true, force: false, errorOnExist: true }))
      for (const name of ['stability-native.json', 'stability-samples.jsonl', 'logs/web.log', 'logs/web.error.log', 'xiaoshe-windows-acceptance-user-data/logs/desktop-shell.jsonl']) {
        await settle(`retained-${name.replaceAll('/', '-')}`, async () => {
          try { await cp(join(acceptanceRoot, name), join(outputDirectory, `raw-${name.replaceAll('/', '-')}`), { force: false, errorOnExist: true }) }
          catch (error) { if (error.code !== 'ENOENT' || name.startsWith('stability-')) throw error }
        })
      }
      if (journalBinding) await settle('retained-journal-binding', async () => {
        const retained = await assertStabilityJournals({ nativePath: join(outputDirectory, 'raw-stability-samples.jsonl'), observationsPath: join(outputDirectory, 'observations.jsonl'), samples, observations })
        if (JSON.stringify(retained) !== JSON.stringify(journalBinding)) throw new Error('retained sample digest changed')
      })
      // Unknown or failed execution retains its entire owned root for diagnosis.
      if (!failures.length && !interrupted && cleanup.every(row => row.state === 'pass')) await settle('isolated-profile-removed', () => removeOwnedMaterialRoot({ acceptanceRoot, ownedStat, cleanup, childFinished }))
      else cleanup.push({ id: 'isolated-profile-removed', state: 'fail' })
    }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  }
  if (interrupted) note('interrupted', new Error('stability cancelled; no shortened pass'))
  const report = { schema: 'xiaoshe-stability-live/v1', runId, createdAt, executionKind: 'product_no_model',
    scope: 'host-soak-and-controlled-local-workflow-not-model-task-delivery', fixedDurationMs: STABILITY_DURATION_MS,
    sourceBefore, runtimeIdentity, servicePid, exit, native, budget, proof, journalBinding, cleanup, failures,
    modelRequests: budget?.attemptedRequests ?? null, modelTasksCompleted: 0,
    retainedRoot: cleanup.some(row => row.id === 'isolated-profile-removed' && row.state === 'pass') ? null : acceptanceRoot }
  await finalizeStabilityReport(report, { outputDirectory, capture: async () => sourceAfter, onProgress })
  return { report, outputDirectory }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStabilityLive(parseStabilityArgs(process.argv.slice(2))).then(({ report, outputDirectory }) => {
    process.stdout.write(`${JSON.stringify({ status: report.status, outputDirectory, modelRequests: report.modelRequests, modelTasksCompleted: 0 })}\n`)
    if (report.status !== 'pass') process.exitCode = 1
  }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
