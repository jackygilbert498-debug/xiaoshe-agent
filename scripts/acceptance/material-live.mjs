#!/usr/bin/env node
/** Real launcher + Electron main + official paid model + owned loopback app. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, lstat, realpath, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { createPublicProfile, runOwnedProcess, serviceAbsent, inspectGracefulExit } from '../quality/product-lifecycle.mjs'
import { captureCandidate } from '../quality/internal-beta.mjs'
import { productRuntimeIdentity } from '../product-runtime-identity.mjs'
import { readBudgetLedger } from './live-request-budget.mjs'
import { selectedCredential, unusedPort } from './same-session-files-live.mjs'
import { MATERIAL_SCENARIOS, startMaterialFixture, materialSource } from './material-fixture.mjs'
import { acceptanceServiceEnvironment } from '../../apps/desktop-shell/src/acceptance-isolation.mjs'
import { proveMaterialTask } from './material-task-proof.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const exec = promisify(execFile)
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })

/** The proof must consume the final queue, not a snapshot taken while a late
 * request can still finish. close() stops bodies and waits for queued writes. */
export async function readFinalMaterialServerEvidence(fixture) {
  await fixture.close()
  const evidence = await fixture.evidence()
  if (evidence.closed !== true) throw new Error('material fixture closure is unproven')
  return evidence
}

/** A missing launchd label is not proof that its former listener has exited. */
export async function assertMaterialBackendPortReleased(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || port === 3080) throw new Error('invalid isolated backend port')
  const probe = createServer()
  try {
    await new Promise((done, fail) => { probe.once('error', fail); probe.listen(port, '127.0.0.1', done) })
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error('isolated backend port is still occupied; unknown listeners were not signalled')
    throw error
  } finally {
    if (probe.listening) await new Promise((done, fail) => probe.close(error => error ? fail(error) : done()))
  }
}

export async function removeOwnedMaterialRoot({ acceptanceRoot, ownedStat, cleanup, childFinished }) {
  if (!childFinished || cleanup.length === 0 || cleanup.some(row => row.state !== 'pass')) throw new Error('resource release or evidence retention is unproven; isolated root retained')
  const stat = await lstat(acceptanceRoot)
  if (stat.dev !== ownedStat.dev || stat.ino !== ownedStat.ino || stat.isSymbolicLink() || await realpath(acceptanceRoot) !== acceptanceRoot) throw new Error('owned root replaced')
  await rm(acceptanceRoot, { recursive: true })
  try { await lstat(acceptanceRoot); throw new Error('isolated root still exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
}

/** Freeze observable failures before persisting the authoritative final status. */
export async function finishMaterialEvidence(report, { outputDirectory, onProgress, note, capture = () => captureCandidate(root) }) {
  try { report.sourceAfter = await capture() } catch (error) { note('source-snapshot-after', error); report.sourceAfter = null }
  if (!report.sourceBefore || report.sourceBefore.sha256 !== report.sourceAfter?.sha256) note('source-binding', new Error('source changed or absent'))
  // This is a pre-publication progress event, not a prematurely announced PASS.
  // Await it so asynchronous observer rejection cannot mutate an already saved
  // report or leave a successful task-run beside a failed final status.
  try { await onProgress({ stage: 'evidence-finalizing', scenario: report.scenario, outputDirectory, modelRequests: report.budget?.reservedRequests ?? null }) }
  catch (error) { note('progress-observer', error) }
  report.finishedAt = new Date().toISOString()
  report.status = report.failures.length || report.proof?.status !== 'pass' || report.cleanup.some(row => row.state !== 'pass') ? 'fail' : 'pass'
  await save(join(outputDirectory, 'report.json'), report)
  if (report.proof) await save(join(outputDirectory, 'proof.json'), report.proof)
  if (report.status === 'pass' && report.proof.tasks?.length) await save(join(outputDirectory, 'task-run.json'), {
    schema: 'xiaoshe-task-run/v1', runId: report.runId, createdAt: report.createdAt, finishedAt: report.finishedAt,
    binding: { sourceSha256: report.sourceBefore.sha256, runtimeIdentity: report.runtimeIdentity }, executionKind: 'live_model', cleanup: report.cleanup,
    tasks: report.proof.tasks, sharedJourneyMetrics: { durationMs: Date.parse(report.finishedAt) - Date.parse(report.createdAt),
      inputTokens: report.budget.usage.totalUsage?.inputTokens ?? null, cacheReadTokens: report.budget.usage.totalUsage?.cacheReadTokens ?? null,
      outputTokens: report.budget.usage.totalUsage?.outputTokens ?? null, cost: null } })
  return report
}

export function materialProfilePatch(options) {
  const { productRoot, acceptanceRoot, runId, sessionId, fixtureUrl } = options
  const batch = sessionId === `xiaoshe-batch-${runId}`
  const descriptor = Object.getOwnPropertyDescriptor(options, 'scenario')
  if (batch ? descriptor !== undefined : !descriptor || !Object.hasOwn(descriptor, 'value')
    || !['normal', 'missing_input', 'response_lost', 'takeover'].includes(descriptor.value)) {
    throw new Error('material Profile requires an explicit scenario; batch forbids scenario')
  }
  const scenario = descriptor?.value
  return [
    ...['credentials', 'llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'session-title-llm', 'session-telemetry-otel'].map(id => ({ id, disabled: true })),
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'agent-presets', config: { default: 'standard', includeUserRoot: false } },
    { insert: [
      { id: 'acceptance-material-policy', name: pathToFileURL(join(productRoot, 'scripts/acceptance/live-material-policy.mjs')).href,
        config: { workspaceRealPath: join(acceptanceRoot, 'workspace'), ledgerDirectory: join(acceptanceRoot, 'tool-policy'), runId, sessionIds: [sessionId], fixtureUrl,
          ...(!batch ? { scenario } : {}) } },
      { id: 'acceptance-native-official', name: pathToFileURL(join(productRoot, 'scripts/acceptance/live-native-official.mjs')).href,
        config: { acceptanceRoot, runId, sessionId } },
    ] },
  ]
}

export async function runMaterialLive({ scenario, onProgress = value => process.stdout.write(`${JSON.stringify(value)}\n`) }) {
  if (process.platform !== 'darwin' || !MATERIAL_SCENARIOS.includes(scenario)) throw new Error('explicit supported scenario and macOS required')
  const runId = randomUUID(), sessionId = `xiaoshe-material-${runId}`, createdAt = new Date().toISOString()
  const outputDirectory = join(root, 'output/stabilization', `material-live-${runId}`)
  const acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  const token = randomUUID(), label = `com.xiaoshe.acceptance.${runId}`
  const failures = [], cleanup = [], pendingProgress = []
  let fixture, env, sourceBefore, runtimeIdentity, nativeReport, history, budget, proof, serverEvidence, ownedStat,
    exit, servicePid, secret, sourceBytes, port, childFinished = true, childPid, interrupted = false
  const note = (stage, error) => failures.push({ stage, message: String(error?.message ?? error).replaceAll(secret ?? '\0', '[REDACTED]').slice(0, 1600) })
  const progress = value => {
    try { pendingProgress.push(Promise.resolve(onProgress(value)).catch(error => note('progress-observer', error))) }
    catch (error) { note('progress-observer', error) }
  }
  const settle = async (id, action) => { try { await action(); cleanup.push({ id, state: 'pass' }) } catch (error) { cleanup.push({ id, state: 'fail' }); note(id, error) } }
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 })
  if (await realpath(dirname(outputDirectory)) !== dirname(outputDirectory)) throw new Error('unsafe output parent')
  await exec('git', ['check-ignore', '--quiet', outputDirectory], { cwd: root })
  await mkdir(outputDirectory, { mode: 0o700 })
  const interrupt = () => {
    interrupted = true
    if (childPid && !childFinished) {
      try { process.kill(-childPid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') note('signal-owned-main', error) }
    }
  }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  try {
    progress({ stage: 'setup', scenario, outputDirectory })
    await mkdir(acceptanceRoot, { mode: 0o700 }); ownedStat = await lstat(acceptanceRoot)
    for (const name of ['home', 'workspace/output', 'dsh-home/profiles/web', 'state', 'logs', 'budget', 'tool-policy', 'server', 'xiaoshe-windows-acceptance-user-data']) await mkdir(join(acceptanceRoot, name), { recursive: true, mode: 0o700 })
    sourceBytes = Buffer.from(materialSource().map(row => JSON.stringify(row)).join('\n') + '\n')
    await writeFile(join(acceptanceRoot, 'workspace/input.jsonl'), sourceBytes, { flag: 'wx', mode: 0o600 })
    fixture = await startMaterialFixture({ runId, scenario, directory: join(acceptanceRoot, 'server') })
    port = await unusedPort()
    env = {
      PATH: process.env.PATH, HOME: join(acceptanceRoot, 'home'), TMPDIR: await realpath(tmpdir()),
      DSH_HOME: join(acceptanceRoot, 'dsh-home'), DSH_TELEMETRY_DISABLED: '1',
      XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: acceptanceRoot,
      XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: runId, XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(acceptanceRoot, 'xiaoshe-windows-acceptance-user-data'),
      XIAOSHE_ACCEPTANCE_WORKSPACE: join(acceptanceRoot, 'workspace'), XIAOSHE_STATE_ROOT: join(acceptanceRoot, 'state'),
      XIAOSHE_DSH_LOG_DIR: join(acceptanceRoot, 'logs'), XIAOSHE_DSH_SERVICE_LABEL: label,
      XIAOSHE_DSH_PORT: String(port), XIAOSHE_DESKTOP_URL: `http://127.0.0.1:${port}/`,
      XIAOSHE_NODE: await realpath(process.execPath), XIAOSHE_PYTHON: process.env.XIAOSHE_PYTHON ?? '/opt/miniconda3/bin/python3',
      XIAOSHE_PNPM_CLI: join(process.env.HOME, '.local/share/xiaoshe/pnpm-11.7.0/node_modules/pnpm/bin/pnpm.cjs'),
      XIAOSHE_DESKTOP_ACTIONS: 'off', XIAOSHE_DSH_NO_OPEN: '1', XIAOSHE_DSH_NO_PAUSE: '1', XIAOSHE_DESKTOP_START_HIDDEN: '1',
      XIAOSHE_MATERIAL_SCENARIO: scenario, XIAOSHE_MATERIAL_FIXTURE_URL: fixture.url, XIAOSHE_LAUNCH_TOKEN: token,
    }
    acceptanceServiceEnvironment(env)
    if (!(await serviceAbsent(label))) throw new Error('own launch label already exists')
    const profileRoot = await createPublicProfile({ productRoot: root, acceptanceRoot, runId, environment: env })
    await writeFile(join(profileRoot, 'cordis.patch.yml'), JSON.stringify(materialProfilePatch({ productRoot: root, acceptanceRoot, runId, sessionId, fixtureUrl: fixture.url, scenario }), null, 2))
    await exec(process.execPath, [join(root, 'runtime/DSH/apps/cli/lib/bin.js'), '--profile', 'web', '--dump-config'], { cwd: join(acceptanceRoot, 'workspace'), env, timeout: 30_000, maxBuffer: 1024 * 1024 })
    sourceBefore = await captureCandidate(root)
    runtimeIdentity = await productRuntimeIdentity({ root, dshRoot: join(root, 'runtime/DSH'), profileRoot })
    secret = await selectedCredential('/Users/zfy/.dsh/.credentials.yaml') // parent uses it only to redact retained diagnostics
    if (interrupted) throw new Error('material acceptance interrupted before launch')
    childFinished = false
    const observer = (async () => {
      let nextProgress = Date.now() + 15_000
      while (!childFinished) {
        if (!servicePid) {
          const service = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { timeout: 5000, maxBuffer: 262144 }).catch(() => null)
          if (service && new RegExp(`XIAOSHE_LAUNCH_TOKEN(?:\\s*(?:=>|=)\\s*)${token}`, 'u').test(service.stdout)) {
            const pid = Number(service.stdout.match(/^\s*pid = (\d+)\s*$/mu)?.[1])
            if (Number.isSafeInteger(pid) && pid > 0) servicePid = pid
          }
        }
        if (Date.now() > nextProgress) {
          const log = await readFile(join(acceptanceRoot, 'xiaoshe-windows-acceptance-user-data/logs/desktop-shell.jsonl'), 'utf8').catch(() => '')
          const events = log.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
          const stage = events.filter(row => row.event === 'material-acceptance-step').at(-1)?.step ?? 'native-startup'
          progress({ stage, scenario, status: 'running' }); nextProgress = Date.now() + 20_000
        }
        await delay(300)
      }
    })()
    try {
      exit = await runOwnedProcess('/bin/bash', [join(root, '启动小蛇.command'), '--acceptance-material'],
        { cwd: root, env, timeoutMs: 570_000, onSpawn: pid => { childPid = pid; progress({ stage: 'native-main', pid, port, scenario }); if (interrupted) interrupt() } })
    } finally { childFinished = true; await observer }
    if (exit.code !== 0 || exit.timedOut) throw new Error(`native launcher failed (exit=${exit.code}, timeout=${exit.timedOut}, logBytes=${exit.bytes})`)
    const records = (await readFile(join(acceptanceRoot, 'xiaoshe-windows-acceptance-user-data/logs/desktop-shell.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    if (!inspectGracefulExit(records)) throw new Error('native graceful shutdown unproven')
    nativeReport = JSON.parse(await readFile(join(acceptanceRoot, 'material-native.json'), 'utf8'))
    history = JSON.parse(await readFile(join(acceptanceRoot, 'material-history.json'), 'utf8'))
    if (!nativeReport.accepted || nativeReport.runId !== runId || nativeReport.sessionId !== sessionId || nativeReport.pid !== exit.pid
      || nativeReport.frontend?.backendIdentity !== runtimeIdentity || !nativeReport.frontend?.identityMatches || !nativeReport.frontend?.frontendMatches) throw new Error('native evidence identity mismatch')
    if (!servicePid || !nativeReport.budgetBefore?.mounts?.some(row => row.pid === servicePid && row.runId === runId && Date.parse(row.at) >= Date.parse(createdAt))
      || !nativeReport.policyBefore?.mounts?.some(row => row.kind === 'agent' && row.pid === servicePid && row.runId === runId
        && row.sessionId === sessionId && Date.parse(row.at) >= Date.parse(createdAt))) throw new Error('native pre-dispatch guards not bound to the observed launchd host')
    if (runtimeIdentity !== await productRuntimeIdentity({ root, dshRoot: join(root, 'runtime/DSH'), profileRoot })) throw new Error('runtime changed during native task')
  } catch (error) { note('execution', error) }
  finally {
    await settle('owned-main-group-released', async () => {
      if (!childPid) return
      try { process.kill(-childPid, 0); throw new Error('owned native process group still alive') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    })
    if (env) await settle('owned-service-released', async () => {
      if (!(await serviceAbsent(label))) {
        await exec('/bin/bash', [join(root, 'scripts/stop-xiaoshe-web.sh'), '--ownership-token', token], { cwd: root, env, timeout: 30_000, maxBuffer: 262144 })
        if (!(await serviceAbsent(label))) throw new Error('owned launch service still present')
        note('compensated-shutdown', new Error('main did not complete normal service release'))
      }
      if (servicePid) { try { process.kill(servicePid, 0); throw new Error('owned service process still alive') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    })
    if (port !== undefined) await settle('owned-backend-port-released', () => assertMaterialBackendPortReleased(port))
    if (fixture) await settle('owned-fixture-closed', async () => { serverEvidence = await readFinalMaterialServerEvidence(fixture) })
    // Only the closed server snapshot is authoritative. Keep the actual
    // workspace alive until this proof finishes; a late duplicate must fail
    // before any successful task evidence can be published.
    if (serverEvidence?.closed === true && nativeReport && history && sourceBytes) {
      try {
        proof = await proveMaterialTask({ runId, sessionId, scenario, workspaceRoot: join(acceptanceRoot, 'workspace'), sourceBytes, history, serverEvidence, nativeReport })
        if (proof.status !== 'pass') throw new Error('independent material task proof failed')
      } catch (error) { note('final-task-proof', error) }
    }
    if (ownedStat) {
      try { budget = await readBudgetLedger(join(acceptanceRoot, 'budget')) } catch (error) { note('budget-unknown', error) }
      for (const name of ['workspace', 'tool-policy', 'budget', 'server']) await settle(`retained-${name}`, () => cp(join(acceptanceRoot, name), join(outputDirectory, name), { recursive: true, force: false, errorOnExist: true }))
      for (const name of ['material-native.json', 'material-history.json', 'logs/web.log', 'logs/web.error.log', 'xiaoshe-windows-acceptance-user-data/logs/desktop-shell.jsonl']) {
        await settle(`retained-${name.replaceAll('/', '-')}`, async () => {
          let text
          try { text = await readFile(join(acceptanceRoot, name), 'utf8') } catch (error) { if (error.code === 'ENOENT') return; throw error }
          await writeFile(join(outputDirectory, `raw-${name.replaceAll('/', '-')}`), text.replaceAll(secret ?? '\0', '[REDACTED]'), { flag: 'wx', mode: 0o600 })
        })
      }
      for (const name of ['material-product.png', 'material-page.png']) {
        try { await cp(join(acceptanceRoot, name), join(outputDirectory, name), { force: false, errorOnExist: true }) }
        catch (error) { if (error.code !== 'ENOENT') note('screenshot-retention', error) }
      }
      if (cleanup.every(row => row.state === 'pass') && childFinished) await settle('isolated-profile-removed',
        () => removeOwnedMaterialRoot({ acceptanceRoot, ownedStat, cleanup, childFinished }))
    }
  }
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  if (interrupted) note('interrupted', new Error('material acceptance interrupted; cleanup attempted'))
  // Progress cannot produce a late rejection after the authoritative report
  // has frozen its failures, including promises returned by onSpawn observers.
  await Promise.all(pendingProgress)
  if (!budget?.mounted || !servicePid || !budget.mounts.some(row => row.pid === servicePid && row.runId === runId)
    || !budget.reservedRequests || budget.deniedRequests || budget.requests.some(row => row.outcome !== 'finished')) note('model-ledger', new Error('paid dispatch/finish or owned service binding incomplete'))
  const report = { schema: 'xiaoshe-material-live/v1', runId, sessionId, scenario, createdAt, finishedAt: new Date().toISOString(),
    sourceBefore, runtimeIdentity, executionKind: 'live_model', model: nativeReport?.model?.current ?? null,
    servicePid, exit, budget, proof, serverEvidence, cleanup, failures, status: failures.length || !proof || cleanup.some(row => row.state !== 'pass') ? 'fail' : 'pass',
    scope: 'real-macos-main-official-model-owned-loopback-site-not-authenticated-business-site',
    retainedRoot: cleanup.some(row => row.id === 'isolated-profile-removed' && row.state === 'pass') ? null : acceptanceRoot }
  await finishMaterialEvidence(report, { outputDirectory, onProgress, note })
  return { report, outputDirectory }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.length !== 3 || args[0] !== '--live-authorized' || args[1] !== '--scenario' || !MATERIAL_SCENARIOS.includes(args[2])) throw new Error('requires --live-authorized --scenario normal|missing_input|response_lost|takeover')
  runMaterialLive({ scenario: args[2] }).then(({ report, outputDirectory }) => {
    process.stdout.write(`${JSON.stringify({ status: report.status, scenario: report.scenario, outputDirectory, modelRequests: report.budget?.reservedRequests ?? null, failures: report.failures })}\n`)
    if (report.status !== 'pass') process.exitCode = 1
  }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
