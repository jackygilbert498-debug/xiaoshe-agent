#!/usr/bin/env node
/** Explicitly authorized real two-phase batch acceptance. No work at import. */
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual as equal } from 'node:util'
import { mkdir, lstat, realpath, readFile, writeFile, cp } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createPublicProfile, runOwnedProcess, serviceAbsent, inspectGracefulExit } from '../quality/product-lifecycle.mjs'
import { captureCandidate } from '../quality/internal-beta.mjs'
import { productRuntimeIdentity } from '../product-runtime-identity.mjs'
import { readBudgetLedger } from './live-request-budget.mjs'
import { selectedCredential, unusedPort } from './same-session-files-live.mjs'
import { materialProfilePatch, assertMaterialBackendPortReleased, removeOwnedMaterialRoot } from './material-live.mjs'
import { BATCH_ITEMS, batchSourceBytes, startBatchFixture } from './batch-fixture.mjs'
import { acceptanceServiceEnvironment } from '../../apps/desktop-shell/src/acceptance-isolation.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), exec = promisify(execFile)
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
const hash = value => createHash('sha256').update(value).digest('hex')
const goodPid = value => Number.isSafeInteger(value) && value > 1
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const failure = code => new Error(`batch-live: ${code}`)
const json = async path => JSON.parse(await readFile(path, 'utf8'))

export function assertBatchNativeExit(exit, native, phase) {
  // Preserve the earliest native failure instead of hiding it behind exit=1 or
  // a missing history file. Both are still failures; no seed may resume here.
  if (native?.failure) throw failure(`native_${phase}: ${native.failure.stage}: ${native.failure.message}`)
  if (exit?.code !== 0 || exit.timedOut) throw failure(`native_${phase}_exit_failed`)
}

export function validateBatchLiveOptions(options) {
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Reflect.ownKeys(options).some(key => !['liveAuthorized', 'onProgress', 'acceptanceMode'].includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))
    || options.acceptanceMode !== undefined && !['existing', 'bounded-admission-recovery'].includes(options.acceptanceMode)
    || options.liveAuthorized !== true || options.onProgress !== undefined && typeof options.onProgress !== 'function') throw failure('explicit_live_authorization_required')
  return options
}

export function parseBatchLiveArguments(args) {
  if (!Array.isArray(args) || args[0] !== '--live-authorized'
    || !(args.length === 1 || args.length === 2 && args[1] === '--bounded-admission-recovery')) throw failure('requires_only_--live-authorized_or_explicit_--bounded-admission-recovery')
  return { liveAuthorized: true, acceptanceMode: args.length === 2 ? 'bounded-admission-recovery' : 'existing' }
}

export function batchQualityFields(proof, seedProof) {
  // Seed observations cannot describe an unfinished or failed resume phase.
  return { quality: proof?.quality ?? null, seedQuality: seedProof?.quality ?? null }
}

export function batchProfilePatch(args) {
  if (args?.sessionId !== `xiaoshe-batch-${args?.runId}`) throw failure('batch_session_required')
  return materialProfilePatch(args)
}

export function ownedBatchServicePid(stdout, { label, token }) {
  if (typeof stdout !== 'string' || !stdout.includes(`/${label} = {`)) return undefined
  const observed = stdout.match(/^\s*XIAOSHE_LAUNCH_TOKEN\s*(?:=>|=)\s*"?([a-f0-9-]+)"?\s*$/mu)?.[1]
  const pid = Number(stdout.match(/^\s*pid = (\d+)\s*$/mu)?.[1])
  return observed === token && goodPid(pid) ? pid : undefined
}

export function batchPhaseLog(previous, current) {
  if (typeof previous !== 'string' || typeof current !== 'string' || !current.startsWith(previous)
    || previous && !previous.endsWith('\n')) throw failure('native_log_replaced')
  const fresh = current.slice(previous.length).trim()
  if (!fresh) throw failure('native_log_missing')
  const rows = fresh.split('\n').map(line => JSON.parse(line))
  if (!inspectGracefulExit(rows)) throw failure('normal_native_shutdown_unproven')
  return rows
}

export function validateBatchPhase(native, { runId, sessionId, phase, candidateId, profileRoot, runtimeIdentity,
  port, pid, servicePid, startedAt, finishedAt, previousBudget }) {
  const bad = () => { throw failure('native_phase_identity_or_guard_mismatch') }
  const inWindow = at => iso(at) && Date.parse(startedAt) <= Date.parse(at) && Date.parse(at) <= Date.parse(finishedAt)
  if (!iso(startedAt) || !iso(finishedAt) || !goodPid(pid) || !goodPid(servicePid) || pid === servicePid
    || native?.schema !== 'xiaoshe-batch-native/v1' || native.runId !== runId || native.sessionId !== sessionId || native.phase !== phase
    || native.candidateId !== candidateId || native.profileRoot !== profileRoot || native.runtimeIdentity !== runtimeIdentity
    || native.backendPort !== port || native.pid !== pid || native.backendPid !== servicePid || native.accepted !== true
    || native.failure !== undefined || native.retentionFailure !== undefined || native.injectionFailure !== undefined
    || !inWindow(native.startedAt) || !inWindow(native.finishedAt) || native.finishedAt < native.startedAt) bad()
  const f = native.frontend, b = native.budgetBefore, p = native.policyBefore
  if (f?.backendIdentity !== runtimeIdentity || f.candidateIdentity !== runtimeIdentity || f.expectedRootProfileIdentity !== runtimeIdentity
    || !/^[a-f0-9]{64}$/u.test(f.loadedFrontendIdentity ?? '') || f.loadedFrontendIdentity !== f.frontendBuildIdentity
    || f.identityMatches !== true || f.frontendMatches !== true || f.aboutRendered !== true || f.shellPresent !== true
    || f.loadedOriginMatches !== true || f.aboutHttpStatus !== 200 || f.aboutStatus !== 'current' || f.diagnosticStatus !== 'current'
    || native.model?.routable !== true || native.model.current?.provider !== 'deepseek-official'
    || native.model.current?.model !== 'deepseek-v4-flash' || native.model.current?.reasoningEffort !== 'off') bad()
  if (!b?.mounted || b.runId !== runId || b.maxRequests !== 64 || b.maxOutputTokens !== 2048 || b.deniedRequests !== 0
    || b.mountCount !== (phase === 'seed' ? 1 : 2) || !Array.isArray(b.mounts) || b.mounts.length !== b.mountCount
    || b.mounts.filter(row => row.runId === runId && row.pid === servicePid && inWindow(row.at)).length !== 1
    || !p?.mounted || p.runId !== runId || p.workspaceRealPath !== join(dirname(dirname(dirname(profileRoot))), 'workspace')
    || !Array.isArray(p.mounts) || p.mounts.filter(row => row.kind === 'agent' && row.runId === runId && row.pid === servicePid
      && row.sessionId === sessionId && inWindow(row.at)).length !== 1) bad()
  if (phase === 'seed') { if (previousBudget !== null || b.reservedRequests !== 0 || b.requests.length !== 0) bad() }
  else if (phase === 'resume') {
    if (!previousBudget || previousBudget.reservedRequests < 1 || previousBudget.mountCount !== 1
      || b.reservedRequests !== previousBudget.reservedRequests || !equal(b.requests, previousBudget.requests)
      || !previousBudget.mounts.every(row => b.mounts.some(current => equal(row, current)))
      || b.mounts.some(row => row.pid === servicePid && previousBudget.mounts.some(before => before.pid === row.pid))) bad()
  } else bad()
  return true
}

export function validateBatchCheckpoint(checkpoint, { runId, sessionId, candidateId, history, nativeReport }) {
  const events = history?.events?.map(row => row.event)
  if (history?.hasMore !== false || !events?.length || events.some((event, i) => event?.seq !== i)
    || checkpoint?.runId !== runId || checkpoint.sessionId !== sessionId || checkpoint.candidateId !== candidateId
    || checkpoint.lastSeq !== events.at(-1).seq || !iso(checkpoint.savedAt)
    || checkpoint.historySha256 !== hash(JSON.stringify(events)) || !equal(checkpoint, nativeReport?.checkpoint)
    || events.filter(row => row.type === 'turn/end' && row.data.reason?.kind === 'completed').length !== 1
    || events.findLast(row => row.type === 'turn/end').time > Date.parse(checkpoint.savedAt)
    || Date.parse(checkpoint.savedAt) > Date.parse(nativeReport.finishedAt)) throw failure('seed_checkpoint_mismatch')
  return { lastSeq: checkpoint.lastSeq, savedAt: checkpoint.savedAt, historySha256: checkpoint.historySha256 }
}

/** Only zero-signal probes, actual label absence and successful port rebinding
 * can create restart facts. Compensating stop belongs to failure cleanup only. */
export async function observeBatchStopped({ pid, backendPid, backendPort, label }, {
  probe = process.kill.bind(process), absent = serviceAbsent, portReleased = assertMaterialBackendPortReleased,
} = {}) {
  if (!goodPid(pid) || !goodPid(backendPid) || pid === backendPid || !Number.isSafeInteger(backendPort) || backendPort < 1
    || backendPort > 65535 || backendPort === 3080 || !/^com\.xiaoshe\.acceptance\.[a-f0-9-]{36}$/u.test(label ?? '')) throw failure('invalid_stop_identity')
  if (!(await absent(label))) throw failure('backend_label_still_present')
  for (const target of [-pid, pid, backendPid]) {
    try { probe(target, 0); throw failure('owned_process_still_present') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await portReleased(backendPort)
  return { desktopExited: true, backendExited: true, portReleased: true, backendPort, at: new Date().toISOString() }
}

export function validateBatchFinalBudget(budget, phases, runId) {
  const last = phases?.resume?.budgetAfter
  if (!budget?.mounted || budget.runId !== runId || budget.mountCount !== 2 || budget.mounts?.length !== 2
    || !budget.reservedRequests || budget.maxRequests !== 64 || budget.maxOutputTokens !== 2048 || budget.deniedRequests !== 0
    || budget.requests?.some(row => row.outcome !== 'finished') || !last || budget.reservedRequests !== last.reservedRequests
    || !equal(budget.requests, last.requests) || !equal(budget.mounts, last.mounts)
    || ['seed', 'resume'].some(phase => !goodPid(phases?.[phase]?.servicePid)
      || budget.mounts.filter(row => row.runId === runId && row.pid === phases[phase].servicePid).length !== 1)
    || phases.seed.servicePid === phases.resume.servicePid) throw failure('two_phase_global_budget_incomplete')
  return true
}

export async function finishBatchEvidence(report, { outputDirectory, onProgress, note, capture = () => captureCandidate(root) }) {
  try { report.sourceAfter = await capture() } catch (error) { note('source-after', error); report.sourceAfter = null }
  report.candidateStable = Boolean(report.sourceBefore && report.sourceAfter?.sha256 === report.sourceBefore.sha256)
  if (!report.candidateStable) note('candidate-stability', failure('source_changed_or_absent'))
  try { await onProgress({ stage: 'evidence-finalizing', outputDirectory, modelRequests: report.budget?.reservedRequests ?? null }) }
  catch (error) { note('progress-observer', error) }
  // Proof/task publication errors are folded into the final authoritative report.
  if (report.proof) try { await save(join(outputDirectory, 'proof.json'), report.proof) } catch (error) { note('proof-publication', error) }
  report.finishedAt = new Date().toISOString()
  report.status = report.failures.length || report.proof?.status !== 'pass' || report.cleanup.some(row => row.state !== 'pass') ? 'fail' : 'pass'
  if (report.status === 'pass') try { await save(join(outputDirectory, 'task-run.json'), { schema: 'xiaoshe-task-run/v1', runId: report.runId,
    createdAt: report.createdAt, finishedAt: report.finishedAt, executionKind: 'live_model',
    binding: { sourceSha256: report.sourceBefore.sha256, runtimeIdentity: report.runtimeIdentity }, cleanup: report.cleanup,
    tasks: report.proof.tasks, sharedJourneyMetrics: { durationMs: Date.parse(report.finishedAt) - Date.parse(report.createdAt),
      inputTokens: report.budget.usage.totalUsage?.inputTokens ?? null, outputTokens: report.budget.usage.totalUsage?.outputTokens ?? null,
      cacheReadTokens: report.budget.usage.totalUsage?.cacheReadTokens ?? null, cost: null } }) }
  catch (error) { note('task-publication', error); report.status = 'fail' }
  await save(join(outputDirectory, 'report.json'), report)
  return report
}

export async function runBatchLive(options) {
  validateBatchLiveOptions(options)
  const acceptanceMode = options.acceptanceMode ?? 'existing'
  if (process.platform !== 'darwin') throw failure('macos_required')
  const onProgress = options.onProgress ?? (value => process.stdout.write(`${JSON.stringify(value)}\n`))
  const runId = randomUUID(), sessionId = `xiaoshe-batch-${runId}`, createdAt = new Date().toISOString()
  const outputDirectory = join(root, 'output/stabilization', `batch-live-${runId}`), acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  const label = `com.xiaoshe.acceptance.${runId}`, failures = [], cleanup = [], pendingProgress = [], phases = {}
  let fixture, env, ownedStat, port, profileRoot, sourceBytes, sourceBefore, runtimeIdentity, budget, proof, seedProof,
    history, serverEvidence, checkpoint, restartEvidence, secret, current, interrupted = false
  const note = (stage, error) => failures.push({ stage, message: String(error?.message ?? error).replaceAll(secret || '\0', '[REDACTED]').slice(0, 1200) })
  const progress = value => { try { pendingProgress.push(Promise.resolve(onProgress(value)).catch(error => note('progress-observer', error))) } catch (error) { note('progress-observer', error) } }
  const settle = async (id, action) => { try { await action(); cleanup.push({ id, state: 'pass' }) } catch (error) { cleanup.push({ id, state: 'fail' }); note(id, error) } }
  const interrupt = () => {
    interrupted = true
    if (current?.pid && !current.finished) try { process.kill(-current.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') note('interrupt-owned-main', error) }
  }
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 })
  if (await realpath(dirname(outputDirectory)) !== dirname(outputDirectory)) throw failure('unsafe_output_parent')
  await exec('git', ['check-ignore', '--quiet', outputDirectory], { cwd: root }); await mkdir(outputDirectory, { mode: 0o700 })
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  try {
    progress({ stage: 'batch-setup', outputDirectory })
    await mkdir(acceptanceRoot, { mode: 0o700 }); ownedStat = await lstat(acceptanceRoot)
    for (const name of ['home', 'workspace/output', 'dsh-home/profiles/web', 'state', 'logs', 'budget', 'tool-policy', 'server', 'xiaoshe-windows-acceptance-user-data']) await mkdir(join(acceptanceRoot, name), { recursive: true, mode: 0o700 })
    sourceBytes = batchSourceBytes()
    await mkdir(join(outputDirectory, 'groundtruth'), { mode: 0o700 })
    for (const item of BATCH_ITEMS) await writeFile(join(acceptanceRoot, 'workspace', item.source), sourceBytes[item.itemId], { flag: 'wx', mode: 0o600 })
    for (const item of BATCH_ITEMS) await writeFile(join(outputDirectory, 'groundtruth', item.source), sourceBytes[item.itemId], { flag: 'wx', mode: 0o600 })
    fixture = await startBatchFixture({ runId, directory: join(acceptanceRoot, 'server') }); port = await unusedPort()
    env = { PATH: process.env.PATH, HOME: join(acceptanceRoot, 'home'), TMPDIR: await realpath(tmpdir()), DSH_HOME: join(acceptanceRoot, 'dsh-home'), DSH_TELEMETRY_DISABLED: '1',
      XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: acceptanceRoot,
      XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: runId, XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(acceptanceRoot, 'xiaoshe-windows-acceptance-user-data'),
      XIAOSHE_ACCEPTANCE_WORKSPACE: join(acceptanceRoot, 'workspace'), XIAOSHE_STATE_ROOT: join(acceptanceRoot, 'state'), XIAOSHE_DSH_LOG_DIR: join(acceptanceRoot, 'logs'),
      XIAOSHE_DSH_SERVICE_LABEL: label, XIAOSHE_DSH_PORT: String(port), XIAOSHE_DESKTOP_URL: `http://127.0.0.1:${port}/`,
      XIAOSHE_NODE: await realpath(process.execPath), XIAOSHE_PYTHON: process.env.XIAOSHE_PYTHON ?? '/opt/miniconda3/bin/python3',
      XIAOSHE_PNPM_CLI: join(process.env.HOME, '.local/share/xiaoshe/pnpm-11.7.0/node_modules/pnpm/bin/pnpm.cjs'),
      XIAOSHE_DESKTOP_ACTIONS: 'off', XIAOSHE_DSH_NO_OPEN: '1', XIAOSHE_DSH_NO_PAUSE: '1', XIAOSHE_DESKTOP_START_HIDDEN: '1', XIAOSHE_BATCH_FIXTURE_URL: fixture.url }
    acceptanceServiceEnvironment(env)
    if (!(await serviceAbsent(label))) throw failure('owned_label_already_present')
    profileRoot = await createPublicProfile({ productRoot: root, acceptanceRoot, runId, environment: env })
    await writeFile(join(profileRoot, 'cordis.patch.yml'), JSON.stringify(batchProfilePatch({ productRoot: root, acceptanceRoot, runId, sessionId, fixtureUrl: fixture.url }), null, 2))
    await exec(process.execPath, [join(root, 'runtime/DSH/apps/cli/lib/bin.js'), '--profile', 'web', '--dump-config'], { cwd: join(acceptanceRoot, 'workspace'), env, timeout: 30000, maxBuffer: 1048576 })
    sourceBefore = await captureCandidate(root); runtimeIdentity = await productRuntimeIdentity({ root, dshRoot: join(root, 'runtime/DSH'), profileRoot })
    secret = await selectedCredential('/Users/zfy/.dsh/.credentials.yaml') // retained diagnostics only; never written or passed as a model option
    const { proveBatchSeed, proveBatchTask } = await import('./batch-task-proof.mjs')
    if (typeof proveBatchSeed !== 'function') throw failure('strict_seed_proof_unavailable')
    let logBefore = '', previousBudget = null
    for (const phase of ['seed', 'resume']) {
      if (interrupted || failures.length) throw failure('stopped_before_next_phase')
      if (phase === 'resume' && (!seedProof || seedProof.status !== 'pass' || !restartEvidence?.stopped)) throw failure('unproven_seed_cannot_resume')
      current = { phase, token: randomUUID(), startedAt: new Date().toISOString(), pid: null, servicePid: null, finished: false }
      phases[phase] = current
      const phaseEnv = { ...env, XIAOSHE_LAUNCH_TOKEN: current.token, XIAOSHE_BATCH_PHASE: phase, XIAOSHE_BATCH_CANDIDATE_ID: sourceBefore.sha256 }
      current.environment = phaseEnv
      if (!(await serviceAbsent(label))) throw failure('service_not_absent_before_phase')
      await assertMaterialBackendPortReleased(port)
      const observed = (async () => {
        let nextProgress = Date.now() + 15000
        while (!current.finished) {
          if (!current.servicePid) {
            const service = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { timeout: 5000, maxBuffer: 262144 }).catch(() => null)
            if (service) current.servicePid = ownedBatchServicePid(service.stdout, { label, token: current.token }) ?? null
          }
          if (Date.now() >= nextProgress) { progress({ stage: `batch-${phase}-running`, phase, serviceObserved: !!current.servicePid }); nextProgress = Date.now() + 20000 }
          await delay(300)
        }
      })().catch(error => note('backend-observer', error))
      try { current.exit = await runOwnedProcess('/bin/bash', [join(root, '启动小蛇.command'), '--acceptance-batch'], { cwd: root, env: phaseEnv, timeoutMs: 570000,
        onSpawn: pid => { current.pid = pid; progress({ stage: 'native-main', phase, pid, port }); if (interrupted) interrupt() } }) }
      finally { current.finished = true; await observed; current.finishedAt = new Date().toISOString() }
      current.native = await json(join(acceptanceRoot, `batch-${phase}-native.json`)).catch(error => {
        if (current.exit.code !== 0 || current.exit.timedOut) return null
        throw error
      })
      assertBatchNativeExit(current.exit, current.native, phase)
      const log = await readFile(join(acceptanceRoot, 'xiaoshe-windows-acceptance-user-data/logs/desktop-shell.jsonl'), 'utf8')
      batchPhaseLog(logBefore, log); logBefore = log
      current.history = await json(join(acceptanceRoot, `batch-${phase}-history.json`)); history = current.history
      validateBatchPhase(current.native, { runId, sessionId, phase, candidateId: sourceBefore.sha256, profileRoot, runtimeIdentity, port,
        pid: current.pid, servicePid: current.servicePid, startedAt: current.startedAt, finishedAt: current.finishedAt, previousBudget })
      current.stopped = await observeBatchStopped({ pid: current.pid, backendPid: current.servicePid, backendPort: port, label })
      cleanup.push({ id: `${phase}-normal-main-backend-port-released`, state: 'pass' })
      if (runtimeIdentity !== await productRuntimeIdentity({ root, dshRoot: join(root, 'runtime/DSH'), profileRoot })
        || (await captureCandidate(root)).sha256 !== sourceBefore.sha256) throw failure('candidate_or_runtime_changed_between_phases')
      current.budgetAfter = await readBudgetLedger(join(acceptanceRoot, 'budget')); budget = current.budgetAfter
      if (budget.reservedRequests <= (previousBudget?.reservedRequests ?? 0) || budget.deniedRequests !== 0
        || budget.maxRequests !== 64 || budget.requests.some(row => row.outcome !== 'finished')) throw failure('phase_model_budget_incomplete')
      await save(join(outputDirectory, `${phase}-budget-after.json`), budget)
      if (phase === 'seed') {
        checkpoint = validateBatchCheckpoint(await json(join(acceptanceRoot, 'batch-checkpoint.json')), { runId, sessionId,
          candidateId: sourceBefore.sha256, history, nativeReport: current.native })
        serverEvidence = await fixture.evidence()
        seedProof = await proveBatchSeed({ runId, sessionId, candidateId: sourceBefore.sha256, workspaceRoot: join(acceptanceRoot, 'workspace'),
          sourceBytes, history, nativeReport: current.native, serverEvidence, acceptanceMode })
        await save(join(outputDirectory, 'seed-proof.json'), seedProof); await save(join(outputDirectory, 'seed-server.json'), serverEvidence)
        if (seedProof.status !== 'pass') throw failure(acceptanceMode === 'existing' ? 'strict_seed_proof_failed_no_resume' : 'bounded_seed_proof_failed_no_resume')
        restartEvidence = { runId, sessionId, candidateId: sourceBefore.sha256, profileRoot,
          seed: { pid: current.pid, backendPid: current.servicePid }, checkpoint, stopped: current.stopped }
      } else {
        if (new Set([phases.seed.pid, phases.seed.servicePid, current.pid, current.servicePid]).size !== 4) throw failure('restart_process_identity_reused')
        restartEvidence.resume = { pid: current.pid, backendPid: current.servicePid }
      }
      previousBudget = budget
    }
    await fixture.close(); serverEvidence = await fixture.evidence()
    proof = await proveBatchTask({ runId, sessionId, candidateId: sourceBefore.sha256, workspaceRoot: join(acceptanceRoot, 'workspace'), sourceBytes, history,
      nativeReports: { seed: phases.seed.native, resume: phases.resume.native }, restartEvidence, serverEvidence, acceptanceMode })
    if (proof.status !== 'pass') throw failure('independent_batch_proof_failed')
  } catch (error) { note('execution', error) }
  finally {
    for (const phase of Object.values(phases)) await settle(`${phase.phase}-owned-main-released`, async () => {
      if (!phase.pid) return
      for (const pid of [-phase.pid, phase.pid]) try { process.kill(pid, 0); throw failure('owned_main_alive') } catch (error) { if (error.code !== 'ESRCH') throw error }
    })
    if (env) await settle('owned-backend-released', async () => {
      if (!(await serviceAbsent(label))) {
        if (!current?.token) throw failure('backend_token_unobserved')
        await exec('/bin/bash', [join(root, 'scripts/stop-xiaoshe-web.sh'), '--ownership-token', current.token], { cwd: root, env: current.environment, timeout: 30000, maxBuffer: 262144 })
        if (!(await serviceAbsent(label))) throw failure('owned_backend_label_present')
        note('compensated-shutdown', failure('normal_main_release_was_not_completed'))
      }
      for (const phase of Object.values(phases)) {
        if (phase.pid && !phase.servicePid) throw failure('backend_pid_ownership_unobserved')
        if (phase.servicePid) try { process.kill(phase.servicePid, 0); throw failure('owned_backend_alive') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    })
    if (port !== undefined) await settle('owned-backend-port-released', () => assertMaterialBackendPortReleased(port))
    if (fixture) await settle('owned-fixture-closed', async () => { await fixture.close(); serverEvidence = await fixture.evidence() })
    if (ownedStat) {
      try { budget = await readBudgetLedger(join(acceptanceRoot, 'budget')) } catch (error) { budget = null; note('final-budget-unknown', error) }
      for (const name of ['workspace', 'tool-policy', 'budget', 'server']) await settle(`retained-${name}`, () => cp(join(acceptanceRoot, name), join(outputDirectory, name), { recursive: true, force: false, errorOnExist: true }))
      const names = ['batch-checkpoint.json', ...['seed', 'resume'].flatMap(phase => [`batch-${phase}-native.json`, `batch-${phase}-history.json`]),
        'logs/web.log', 'logs/web.error.log', 'xiaoshe-windows-acceptance-user-data/logs/desktop-shell.jsonl']
      for (const name of names) await settle(`retained-${name.replaceAll('/', '-')}`, async () => {
        let raw
        try { raw = await readFile(join(acceptanceRoot, name), 'utf8') } catch (error) {
          if (error.code === 'ENOENT' && (!name.startsWith('batch-') || !phases[name.includes('resume') ? 'resume' : 'seed']?.pid)) return
          throw error
        }
        await writeFile(join(outputDirectory, `raw-${name.replaceAll('/', '-')}`), raw.replaceAll(secret || '\0', '[REDACTED]'), { flag: 'wx', mode: 0o600 })
      })
      for (const phase of ['seed', 'resume']) for (const suffix of ['product', 'item-1', 'item-2']) {
        const name = `batch-${phase}-${suffix}.png`
        try { await cp(join(acceptanceRoot, name), join(outputDirectory, name), { force: false, errorOnExist: true }) }
        catch (error) { if (error.code !== 'ENOENT') { cleanup.push({ id: `retained-${name}`, state: 'fail' }); note('screenshot-retention', error) } }
      }
      if (restartEvidence) await settle('retained-restart-evidence', () => save(join(outputDirectory, 'restart-evidence.json'), restartEvidence))
      if (serverEvidence) await settle('retained-server-evidence', () => save(join(outputDirectory, 'server-evidence.json'), serverEvidence))
      if (cleanup.every(row => row.state === 'pass') && Object.values(phases).every(row => row.finished)) await settle('isolated-profile-removed',
        () => removeOwnedMaterialRoot({ acceptanceRoot, ownedStat, cleanup, childFinished: true }))
    }
  }
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  await Promise.all(pendingProgress)
  if (interrupted) note('interrupted', failure('batch_interrupted'))
  try { validateBatchFinalBudget(budget, phases, runId) } catch (error) { note('model-ledger', error) }
  const phaseReport = Object.fromEntries(Object.entries(phases).map(([name, value]) => [name, {
    startedAt: value.startedAt, finishedAt: value.finishedAt, pid: value.pid, servicePid: value.servicePid, token: value.token, exit: value.exit,
    native: value.native, budgetAfter: value.budgetAfter, stopped: value.stopped }]))
  const report = { schema: 'xiaoshe-batch-live/v1', runId, sessionId, createdAt, executionKind: 'live_model', sourceBefore, runtimeIdentity,
    phases: phaseReport, restartEvidence, seedProof, proof, budget, serverEvidence, cleanup, failures,
    acceptanceMode, ...batchQualityFields(proof, seedProof),
    scope: 'real-macos-two-main-processes-one-session-official-model-owned-loopback-batch-not-business-site',
    retainedRoot: cleanup.some(row => row.id === 'isolated-profile-removed' && row.state === 'pass') ? null : acceptanceRoot }
  await finishBatchEvidence(report, { outputDirectory, onProgress, note })
  return { report, outputDirectory }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseBatchLiveArguments(process.argv.slice(2))
  runBatchLive(options).then(({ report, outputDirectory }) => {
    process.stdout.write(`${JSON.stringify({ status: report.status, acceptanceMode: report.acceptanceMode, quality: report.quality, seedQuality: report.seedQuality, outputDirectory, modelRequests: report.budget?.reservedRequests ?? null, failures: report.failures })}\n`)
    if (report.status !== 'pass') process.exitCode = 1
  }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
