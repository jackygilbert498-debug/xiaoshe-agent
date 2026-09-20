#!/usr/bin/env node
/** Own the runtime around the original five complex scenarios. --prepare-only
 * proves mounting/identity/cleanup without a prompt or a credential read.
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { captureCandidate } from '../quality/internal-beta.mjs'
import { createPublicProfile, runOwnedProcess } from '../quality/product-lifecycle.mjs'
import { productRuntimeIdentity } from '../product-runtime-identity.mjs'
import { rpcClient, selectedCredential, startOwnedHost, unusedPort } from './same-session-files-live.mjs'
import { observeOwnedProcess, verifyProcessObservation } from './owned-process-identity.mjs'
import { complexPolicy, complexSessionIds, readComplexToolPolicy } from './complex-tool-policy.mjs'
import { readBudgetLedger } from './live-request-budget.mjs'
import { readComplexSearchLedger } from './complex-search-budget.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const exec = promisify(execFile)
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
const filePlugin = file => pathToFileURL(join(root, 'scripts/acceptance', file)).href
export function complexProfilePatch(config, liveAuthorized) {
  const policy = complexPolicy(config)
  const sandbox = { nodePath: config.nodePath, npmPath: config.npmPath,
    fixtureRoot: policy.fixtureRoot, temporaryRoot: policy.temporaryRoot }
  return [
    ...['credentials', 'llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'session-title-llm', 'session-telemetry-otel'].map(id => ({ id, disabled: true })),
    // Patch `name` only asserts an existing entry's identity; it cannot replace
    // an implementation. Disable the old service and insert the new provider.
    { id: 'sandbox', disabled: true },
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: policy.fixtureRoot } },
    { id: 'bash-sandbox', config: { timeoutMs: 30_000, maxTimeoutMs: 30_000, maxOutputBytes: 64_000 } },
    { id: 'tool-bash', config: { enableRunInBackground: false } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'agent-presets', config: { default: 'standard', includeUserRoot: false } },
    { insert: [
      { id: 'complex-execution-sandbox', name: filePlugin('complex-execution-sandbox.mjs'), config: sandbox },
      { id: 'complex-tool-policy', name: filePlugin('complex-tool-policy.mjs'), config },
      { id: 'complex-official-budget', name: filePlugin('complex-official-budget.mjs'), config: { ...config, liveAuthorized } },
      { id: 'complex-search-budget', name: filePlugin('complex-search-budget.mjs'), config: {
        ledgerDirectory: join(config.acceptanceRoot, 'search-budget'), runId: config.runId,
        sessionId: complexSessionIds(config.runId)[2], liveAuthorized } },
    ] },
  ]
}

async function assertPortAbsent(port) {
  const server = createServer()
  try { await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done) }) }
  finally { if (server.listening) await new Promise(done => server.close(done)) }
}

export function mayRemoveComplexRoot(failures, cleanup) {
  return failures.length === 0 && cleanup.every(row => row.state === 'pass')
    && cleanup.some(row => row.id === 'owned-host-released' && row.state === 'pass')
    && cleanup.some(row => row.id === 'original-evidence-retained' && row.state === 'pass')
}

/** Only a PID handed back by our own spawn is signalable. A cancellation also
 * escalates a non-cooperating smoke; releasing ownership cancels that timer. */
export function createOwnedSmokeCancellation({ kill = process.kill.bind(process), graceMs = 2000, onError = () => {} } = {}) {
  let pid, timer, cancelled = false
  const signal = value => {
    if (!pid) return
    try { kill(-pid, value) } catch (error) { if (error.code !== 'ESRCH') onError(error) }
  }
  return {
    own(value) {
      if (pid || !Number.isSafeInteger(value) || value < 1) throw new Error('invalid owned smoke pid')
      pid = value
    },
    cancel() {
      if (!pid || cancelled) return
      cancelled = true; signal('SIGTERM')
      timer = setTimeout(() => signal('SIGKILL'), graceMs); timer.unref?.()
    },
    release() { clearTimeout(timer); pid = undefined },
  }
}

function assertLedgers(budget, searchBudget, liveAuthorized) {
  if (!budget?.mounted || budget.deniedRequests || (liveAuthorized ? !budget.reservedRequests : budget.attemptedRequests !== 0)
    || (liveAuthorized && budget.requests.some(row => row.outcome !== 'finished'))) throw new Error('chat dispatch ledger incomplete or unexpected')
  // A known failed public search may be handled honestly by the original task.
  // Missing dispatch/receipt evidence is never equivalent to that known failure.
  if (!searchBudget?.mounts?.length || searchBudget.deniedRequests || searchBudget.unknownDispatchRequests
    || (liveAuthorized ? searchBudget.dispatchedRequests < 1 : searchBudget.reservedRequests !== 0)) throw new Error('search dispatch ledger incomplete or unexpected')
}

export async function runComplexLive({ liveAuthorized = false, onProgress = value => process.stdout.write(`${JSON.stringify(value)}\n`) } = {}) {
  if (typeof liveAuthorized !== 'boolean' || process.platform !== 'darwin') throw new Error('complex-live: explicit macOS run required')
  const runId = randomUUID(), createdAt = new Date().toISOString()
  const acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  const outputDirectory = join(root, 'output/stabilization', `complex-live-${runId}`)
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 })
  if (await realpath(dirname(outputDirectory)) !== dirname(outputDirectory)) throw new Error('unsafe evidence parent')
  await exec('git', ['check-ignore', '--quiet', '--no-index', outputDirectory], { cwd: root })
  await mkdir(outputDirectory, { mode: 0o700 })
  const evidenceDirectory = join(outputDirectory, 'scenarios')
  await mkdir(evidenceDirectory, { mode: 0o700 })
  const failures = [], cleanup = [], sessionsCreated = []
  let host, rpc, port, ownedIdentity, sourceBefore, sourceAfter, runtimeIdentity, budget, searchBudget, toolPolicy, smoke, scenarioReport, processEvidence
  let interrupted = false
  const smokeCancellation = createOwnedSmokeCancellation({ onError: error => failure('smoke-interrupt', error) })
  const interrupt = () => { interrupted = true; smokeCancellation.cancel() }
  const assertActive = () => { if (interrupted) throw new Error('complex-live: interrupted') }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  const failure = (stage, error) => failures.push({ stage, reason: error instanceof Error ? error.message : String(error) })
  try {
    await mkdir(acceptanceRoot, { mode: 0o700 }); ownedIdentity = await lstat(acceptanceRoot)
    for (const name of ['workspace', 'dsh-home', 'home', 'state', 'budget', 'tool-policy', 'search-budget', 'execution-temp',
      'workspace/code-repair', 'workspace/research', 'workspace/recovery', 'workspace/steer']) await mkdir(join(acceptanceRoot, name), { mode: 0o700 })
    const nodePath = await realpath(process.execPath)
    const npmPath = await realpath(join(dirname(nodePath), '../lib/node_modules/npm/bin/npm-cli.js'))
    const config = { acceptanceRoot, runId, nodePath, npmPath }, policy = complexPolicy(config)
    port = await unusedPort()
    const endpoint = `http://127.0.0.1:${port}`
    const environment = { PATH: `${dirname(nodePath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: join(acceptanceRoot, 'home'), TMPDIR: await realpath(tmpdir()), DSH_HOME: join(acceptanceRoot, 'dsh-home'),
      DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write',
      XIAOSHE_PRODUCT_ROOT: root, XIAOSHE_DSH_ROOT: join(root, 'runtime/DSH'),
      XIAOSHE_LEGACY_ROOT: join(root, 'runtime/xiaoshe-legacy'), XIAOSHE_STATE_ROOT: join(acceptanceRoot, 'state'),
      XIAOSHE_DSH_HOST: '127.0.0.1', XIAOSHE_DSH_PORT: String(port), XIAOSHE_NODE: nodePath,
      XIAOSHE_DESKTOP_ACTIONS: 'off', XIAOSHE_ACCEPTANCE_WORKSPACE: policy.fixtureRoot }
    const profileRoot = await createPublicProfile({ productRoot: root, acceptanceRoot, runId, environment })
    await writeFile(join(profileRoot, 'cordis.patch.yml'), JSON.stringify(complexProfilePatch(config, liveAuthorized), null, 2), { mode: 0o600 })
    await exec(nodePath, [join(root, 'runtime/DSH/apps/cli/lib/bin.js'), '--profile', 'web', '--dump-config'],
      { cwd: policy.fixtureRoot, env: environment, timeout: 30_000, maxBuffer: 1_048_576 })
    sourceBefore = await captureCandidate(root)
    runtimeIdentity = await productRuntimeIdentity({ root, dshRoot: environment.XIAOSHE_DSH_ROOT, profileRoot })
    await save(join(outputDirectory, 'source-before.json'), sourceBefore)
    await cp(join(profileRoot, 'cordis.patch.yml'), join(outputDirectory, 'profile-patch.json'), { force: false, errorOnExist: true })
    await save(join(outputDirectory, 'manifest.json'), { runId, createdAt, liveAuthorized, acceptanceRoot, endpoint,
      runtimeIdentity, sourceBefore, config, sessionIds: complexSessionIds(runId) })
    assertActive()
    // This key is only held in memory to redact the child log. The host resolves
    // it through the ordinary read-only credential provider, never argv/env.
    const redactionKey = liveAuthorized ? await selectedCredential('/Users/zfy/.dsh/.credentials.yaml') : undefined
    host = startOwnedHost(nodePath, [join(root, 'runtime/DSH/apps/cli/lib/bin.js'), 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)],
      { cwd: policy.fixtureRoot, env: { ...environment, XIAOSHE_PROFILE_ROOT: profileRoot, XIAOSHE_RUNTIME_IDENTITY: runtimeIdentity },
        secret: redactionKey, authOrigin: endpoint, timeoutMs: 1_320_000 })
    onProgress({ stage: 'isolated-host', runId, pid: host.pid, port, liveAuthorized, outputDirectory })
    rpc = rpcClient(endpoint, { authUrl: () => host.authUrl })
    let status, ready = false
    for (let i = 0; i < 120; i++) {
      assertActive()
      if (host.exited) throw new Error('owned host exited before readiness; see private host.log')
      status = await fetch(`${endpoint}/xiaoshe/desktop/status`, { redirect: 'error', signal: AbortSignal.timeout(1000) }).then(r => r.ok ? r.json() : null).catch(() => null)
      if (status?.runtime_identity === runtimeIdentity && status?.bridge?.state === 'ready') {
        budget = await readBudgetLedger(join(acceptanceRoot, 'budget')).catch(() => null)
        searchBudget = await readComplexSearchLedger(join(acceptanceRoot, 'search-budget')).catch(() => null)
        try { toolPolicy = readComplexToolPolicy(join(acceptanceRoot, 'tool-policy')) } catch { toolPolicy = null }
        if (budget?.mounts?.some(row => row.pid === host.pid && row.runId === runId)
          && searchBudget?.mounts?.some(row => row.pid === host.pid && row.runId === runId)
          && toolPolicy?.mounts.some(row => row.kind === 'host' && row.pid === host.pid)) { ready = true; break }
      }
      await delay(500)
    }
    if (!ready) throw new Error('isolated runtime identity or guards not ready')
    await save(join(outputDirectory, 'runtime-before.json'), status)
    processEvidence = { schema: 'xiaoshe-owned-host-process/v1', ...await observeOwnedProcess(host.pid), runId, endpoint, runtimeIdentity }
    if (host.exited || processEvidence.cwd !== policy.fixtureRoot) throw new Error('isolated owned host cwd mismatch or exited')
    await save(join(acceptanceRoot, 'host-process.json'), processEvidence)
    await save(join(outputDirectory, 'host-before.json'), processEvidence)
    if (!liveAuthorized) {
      for (const scenario of policy.scenarios) {
        const result = await rpc('session.create', { sessionId: scenario.sessionId, cwd: scenario.cwd, agentPreset: 'standard' })
        if (result.sessionId !== scenario.sessionId) throw new Error('prepare session identity mismatch')
        sessionsCreated.push(scenario.sessionId)
      }
      toolPolicy = readComplexToolPolicy(join(acceptanceRoot, 'tool-policy'))
      if (toolPolicy.mountedSessionIds.length !== 5) throw new Error('five scenario guards not mounted')
      budget = await readBudgetLedger(join(acceptanceRoot, 'budget'))
      searchBudget = await readComplexSearchLedger(join(acceptanceRoot, 'search-budget'))
      assertLedgers(budget, searchBudget, false)
      await save(join(outputDirectory, 'tool-policy-prepared.json'), toolPolicy)
      onProgress({ stage: 'prepared', scopes: 5, modelRequests: budget.reservedRequests, searchRequests: searchBudget.reservedRequests })
    } else {
      const manifestPath = join(acceptanceRoot, 'complex-run.json')
      await save(manifestPath, { runId, fixtureRoot: policy.fixtureRoot, expectedHostCwd: policy.fixtureRoot,
        endpoint, runtimeIdentity, reportPath: join(evidenceDirectory, 'report.json'), evidenceDirectory,
        nodePath, npmPath, temporaryRoot: policy.temporaryRoot })
      const timer = setInterval(() => onProgress({ stage: 'original-five-scenarios', status: 'running' }), 30_000)
      try {
        smoke = await runOwnedProcess(nodePath, [join(root, 'scripts/acceptance/harness-performance-complex-smoke.mjs')], {
          cwd: root, env: { ...environment, XIAOSHE_AUTH_URL: host.authUrl, XIAOSHE_COMPLEX_RUN_CONFIG: manifestPath, XIAOSHE_ACCEPTANCE_BASE_URL: endpoint,
            XIAOSHE_ACCEPTANCE_BINDING: JSON.stringify({ runId, runtimeIdentity, sourceSha256: sourceBefore.sha256 }) },
          timeoutMs: 1_200_000, onSpawn: pid => {
            smokeCancellation.own(pid)
            if (interrupted) smokeCancellation.cancel()
            onProgress({ stage: 'original-five-scenarios', pid })
          } })
      } finally { clearInterval(timer); smokeCancellation.release() }
      assertActive()
      scenarioReport = JSON.parse(await readFile(join(evidenceDirectory, 'report.json'), 'utf8'))
      if (smoke.code !== 0 || smoke.timedOut || scenarioReport.scenarios.length !== 5
        || scenarioReport.scenarios.some(row => row.state !== 'pass')) throw new Error('original complex scenarios did not all pass')
    }
    if (runtimeIdentity !== await productRuntimeIdentity({ root, dshRoot: environment.XIAOSHE_DSH_ROOT, profileRoot })) throw new Error('runtime changed during run')
  } catch (error) { failure('execution', error) }
  finally {
    if (rpc) for (const sessionId of complexSessionIds(runId)) {
      try { await rpc('session.cancel', { sessionId }) } catch { /* Host cleanup proves process release independently. */ }
      if (sessionsCreated.includes(sessionId)) try { await rpc('workspace.archiveSession', { sessionId }) } catch (error) { failure('archive-owned-session', error) }
    }
    if (host) {
      if (processEvidence) try {
        if (host.exited) throw new Error('original owned Host exited before final identity observation')
        const after = await verifyProcessObservation(processEvidence)
        await save(join(outputDirectory, 'host-after.json'), after)
        cleanup.push({ id: 'owned-host-identity-retained', state: 'pass' })
      } catch (error) { failure('host-identity-after', error); cleanup.push({ id: 'owned-host-identity-retained', state: 'fail' }) }
      try { const result = await host.stop(); if (!result.absent) throw new Error('owned host absence unproven'); cleanup.push({ id: 'owned-host-released', state: 'pass', pid: host.pid }) }
      catch (error) { failure('host-cleanup', error); cleanup.push({ id: 'owned-host-released', state: 'fail' }) }
      try { await writeFile(join(outputDirectory, 'host.log'), host.output, { flag: 'wx', mode: 0o600 }) } catch (error) { failure('host-log', error) }
    }
    if (port) try { await assertPortAbsent(port); cleanup.push({ id: 'owned-port-released', state: 'pass', port }) }
    catch (error) { failure('port-cleanup', error); cleanup.push({ id: 'owned-port-released', state: 'fail', port }) }
    try {
      sourceAfter = await captureCandidate(root)
      if (!sourceBefore || sourceBefore.sha256 !== sourceAfter.sha256) failure('source', new Error('source changed or capture missing'))
    } catch (error) { failure('source-after', error) }
    if (ownedIdentity) {
      try {
        budget = await readBudgetLedger(join(acceptanceRoot, 'budget'))
        searchBudget = await readComplexSearchLedger(join(acceptanceRoot, 'search-budget'))
        toolPolicy = readComplexToolPolicy(join(acceptanceRoot, 'tool-policy'))
        try { assertLedgers(budget, searchBudget, liveAuthorized) } catch (error) { failure('final-ledger', error) }
        for (const directory of ['workspace', 'budget', 'search-budget', 'tool-policy']) await cp(join(acceptanceRoot, directory), join(outputDirectory, directory), { recursive: true, force: false, errorOnExist: true })
        cleanup.push({ id: 'original-evidence-retained', state: 'pass' })
        const current = await lstat(acceptanceRoot)
        if (current.dev !== ownedIdentity.dev || current.ino !== ownedIdentity.ino || !current.isDirectory()
          || current.isSymbolicLink() || await realpath(acceptanceRoot) !== acceptanceRoot) throw new Error('owned root identity changed')
        // Keep original JSONL/Profile after any failure, including a killed
        // smoke or failed full-history/log capture. Do not delete its sole copy.
        if (!mayRemoveComplexRoot(failures, cleanup)) throw new Error('retain owned root because run or evidence is incomplete')
        await rm(acceptanceRoot, { recursive: true })
        try { await lstat(acceptanceRoot); throw new Error('owned root remains') } catch (error) { if (error.code !== 'ENOENT') throw error }
        cleanup.push({ id: 'owned-root-removed', state: 'pass' })
      } catch (error) { failure('retain-or-remove-owned-root', error); cleanup.push({ id: 'owned-root-removed', state: 'fail' }) }
    }
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  }
  const report = { schema: 'xiaoshe-complex-live/v1', runId, createdAt, finishedAt: new Date().toISOString(),
    mode: liveAuthorized ? 'live-model-original-five-scenarios' : 'prepare-only-no-model', sourceBefore, sourceAfter,
    runtimeIdentity, budget, searchBudget, toolPolicy, smoke, scenarioReport, cleanup, failures,
    status: failures.length ? 'fail' : liveAuthorized ? 'pass' : 'prepared',
    retainedRoot: cleanup.some(row => row.id === 'owned-root-removed' && row.state === 'pass') ? null : acceptanceRoot }
  await save(join(outputDirectory, 'report.json'), report)
  onProgress({ stage: 'terminal', status: report.status, outputDirectory, failures,
    modelRequests: budget?.reservedRequests ?? null })
  return { report, outputDirectory }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = process.argv.slice(2).join(' ')
  if (!['--prepare-only', '--live-authorized'].includes(arg)) throw new Error('Use --prepare-only or explicitly --live-authorized')
  runComplexLive({ liveAuthorized: arg === '--live-authorized' }).then(({ report }) => {
    if (!['pass', 'prepared'].includes(report.status)) process.exitCode = 1
  }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
