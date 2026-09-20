#!/usr/bin/env node
/** Real packaged Xiaoshe lifecycle acceptance for macOS. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer, createConnection } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { verifyPackagedApplicationSourceIdentity } from '../../apps/desktop-shell/scripts/verify-artifact.mjs'
import { acceptanceRunMetadataFromEnvironment, assertCurrentMacosAcceptanceReport } from './macos-acceptance-run.mjs'

const SERVICE_LABEL = 'com.xiaoshe.dsh.web'
const PRODUCT_BUNDLE_ID = 'com.xiaoshe.desktop'
const MAX_CAPTURE = 128 * 1024
const MAX_ACTION_REPORT = 64 * 1024
const RUNTIME_MARKER = '.xiaoshe-product-runtime.json'
export const PACKAGED_RUNTIME_STARTUP_TIMEOUT_MS = 15 * 60_000
export const PACKAGED_INTERACTION_CHILD_TIMEOUT_MS = 20 * 60_000
export const PACKAGED_INTERACTION_READY_TIMEOUT_MS = 10 * 60_000
const PACKAGED_INTERACTION_POST_READY_RESERVE_MS = 6 * 60_000
const APPLICATION_ROLES = new Set(['built-distribution', 'installed-application'])
const REQUIRED_MATERIALIZED_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'runtime/DSH/apps/cli/lib/bin.js',
  'scripts/start-xiaoshe-web.sh',
]

function parseArgs(argv) {
  return new Map(argv.map(value => {
    const separator = value.indexOf('=')
    if (!value.startsWith('--') || separator < 3) throw new Error(`invalid argument: ${value}`)
    return [value.slice(2, separator), value.slice(separator + 1)]
  }))
}

async function findFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close()
        reject(new Error('could not allocate an isolated loopback port'))
        return
      }
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

function serviceIsRegistered() {
  const domain = `gui/${process.getuid()}/${SERVICE_LABEL}`
  return spawnSync('/bin/launchctl', ['print', domain], { stdio: 'ignore' }).status === 0
}

async function portIsOpen(port) {
  return await new Promise(resolveOpen => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = value => { socket.destroy(); resolveOpen(value) }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitUntil(predicate, timeoutMs, description, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs))
  }
  throw new Error(`timed out waiting for ${description}; last=${String(last)}`)
}

async function readProductStatus(url) {
  try {
    const response = await fetch(new URL('xiaoshe/desktop/status', url), { signal: AbortSignal.timeout(2_000) })
    const body = await response.json()
    return response.ok && body?.product === '小蛇' && body?.bridge?.state === 'ready' ? body : undefined
  } catch {
    return undefined
  }
}

function appendTail(current, chunk) {
  return `${current}${String(chunk)}`.slice(-MAX_CAPTURE)
}

function launch(binary, argv, environment, cwd = dirname(binary)) {
  const child = spawn(binary, argv, {
    cwd,
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = { stdout: '', stderr: '' }
  child.stdout?.on('data', chunk => { capture.stdout = appendTail(capture.stdout, chunk) })
  child.stderr?.on('data', chunk => { capture.stderr = appendTail(capture.stderr, chunk) })
  return { child, capture }
}

async function waitForExit(child, timeoutMs, description) {
  if (child.exitCode !== null) return child.exitCode
  return await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${description} did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
    const onExit = code => { cleanup(); resolveExit(code ?? -1) }
    const onError = error => { cleanup(); reject(error) }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function terminate(child, description) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForExit(child, 5_000, `${description} graceful termination`)
  } catch {
    if (child.exitCode === null) child.kill('SIGKILL')
    await waitForExit(child, 5_000, `${description} forced termination`)
  }
}

/** Run ordered cleanup to completion; one failure must never skip later steps. */
export async function runLifecycleCleanup(steps) {
  const failures = []
  for (const [description, action] of steps) {
    try { await action() } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(new Error(`${description}: ${message}`, { cause: error }))
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'macOS lifecycle cleanup failed')
}

function windowFact(pid) {
  const script = `tell application "System Events"
set matches to every application process whose unix id is ${Number(pid)}
if (count matches) is 0 then return ""
tell item 1 of matches
  set windowCount to count of windows
  set windowTitle to ""
  if windowCount > 0 then set windowTitle to name of front window as text
  return (name as text) & "|" & (windowCount as text) & "|" & windowTitle
end tell
end tell`
  const result = spawnSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout: 5_000 })
  if (result.status !== 0) return undefined
  const [processName, rawCount, title] = String(result.stdout).trim().split('|')
  const count = Number(rawCount)
  return processName && Number.isInteger(count) && count > 0 ? { processName, count, title } : undefined
}

function brandedWindowFact(pid) {
  const fact = windowFact(pid)
  if (!fact) return undefined
  return fact.title.includes('小蛇') && !/(?:DSH Local Build|DeepSeek Harness)/iu.test(fact.title) ? fact : undefined
}

async function stopOwnedService(root, port, environment, ownershipToken) {
  const script = join(root, 'scripts', 'stop-xiaoshe-web.sh')
  const result = spawnSync('/bin/bash', [script, '--ownership-token', ownershipToken], {
    cwd: root,
    env: { ...process.env, HOME: environment.HOME, DSH_HOME: environment.DSH_HOME, XIAOSHE_DSH_PORT: String(port), XIAOSHE_DSH_NO_PAUSE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`owned service stop failed (exit ${String(result.status)})`)
  return { status: result.status }
}

async function findOwnedRuntimeRoot(userData) {
  const canonicalUserData = await realpath(userData)
  const runtimeParent = join(canonicalUserData, 'runtime')
  const candidates = []
  for (const entry of await readdir(runtimeParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const candidate = await realpath(join(runtimeParent, entry.name))
    const remainder = relative(canonicalUserData, candidate)
    if (remainder === '' || isAbsolute(remainder) || remainder === '..' || remainder.startsWith(`..${sep}`)) continue
    try { await access(join(candidate, RUNTIME_MARKER)); candidates.push(candidate) } catch { /* incomplete staging is not an owned runtime */ }
  }
  if (candidates.length !== 1) throw new Error(`expected one owned packaged runtime, found ${candidates.length}`)
  return candidates[0]
}

async function startupEvents(userData) {
  const path = join(userData, 'logs', 'desktop-shell.jsonl')
  const text = await readFile(path, 'utf8')
  const rows = text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
  return { path, events: rows.map(row => row.event), rows }
}

async function failureDiagnostics(userData, primary, second, interaction, desktopAction) {
  let desktopLog = ''
  try { desktopLog = (await readFile(join(userData, 'logs', 'desktop-shell.jsonl'), 'utf8')).slice(-12_000) } catch { /* startup may fail before logging */ }
  const primaryStdout = primary?.capture.stdout ?? ''
  const primaryStderr = primary?.capture.stderr ?? ''
  const secondStderr = second?.capture.stderr ?? ''
  const interactionStderr = interaction?.capture.stderr ?? ''
  const desktopActionStderr = desktopAction?.capture.stderr ?? ''
  return safeCaptureDiagnostics({
    'desktop-log': desktopLog,
    'primary-stdout': primaryStdout,
    'primary-stderr': primaryStderr,
    'second-stderr': secondStderr,
    'interaction-stderr': interactionStderr,
    'desktop-action-stderr': desktopActionStderr,
  })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function applicationRole(value) {
  if (!APPLICATION_ROLES.has(value)) throw new Error('macOS lifecycle application role is invalid')
  return value
}

/** Convert any caught error into bounded, content-free durable evidence. */
export function contentFreeFailureEvidence(stage, error) {
  const safeStage = typeof stage === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(stage)
    ? stage
    : 'acceptance'
  const raw = Buffer.from(error instanceof Error ? error.message : String(error), 'utf8')
  const observedType = error?.constructor?.name
  const errorType = typeof observedType === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(observedType)
    ? observedType
    : 'Error'
  return Object.freeze({
    stage: safeStage,
    errorType,
    diagnosticBytes: raw.byteLength,
    diagnosticSha256: sha256(raw),
  })
}

/** Allowlist lifecycle facts before they cross into a durable report. */
export function contentFreeLifecycleEvidence(evidence) {
  const status = evidence?.status ?? {}
  const runtime = evidence?.runtime ?? {}
  return Object.freeze({
    applicationRole: applicationRole(evidence?.applicationRole),
    bundleId: evidence?.bundleId,
    bundleExecutable: evidence?.bundleExecutable,
    primaryPid: evidence?.primaryPid,
    secondPid: evidence?.secondPid,
    primaryExitCode: evidence?.primaryExitCode,
    secondExitCode: evidence?.secondExitCode,
    port: evidence?.port,
    status: Object.freeze({
      product: status.product,
      version: status.version,
      bridge: status.bridge,
      platform: status.platform,
    }),
    window: Object.freeze({ branded: evidence?.window !== undefined, count: evidence?.window?.count }),
    startupEvents: Object.freeze(Array.isArray(evidence?.startupEvents) ? [...evidence.startupEvents] : []),
    runtime: Object.freeze({
      source: runtime.source,
      materializedUnderUserData: runtime.materializedUnderUserData,
      version: runtime.version,
      markerSchemaVersion: runtime.markerSchemaVersion,
      fingerprintVerified: runtime.fingerprintVerified,
      matchesPackagedRuntime: runtime.matchesPackagedRuntime,
      fingerprint: runtime.fingerprint,
    }),
    portReleased: evidence?.portReleased,
    serviceReleased: evidence?.serviceReleased,
    ...(evidence?.packagedAppAction === undefined ? {} : { packagedAppAction: evidence.packagedAppAction }),
  })
}

/** Preserve useful capture size/digest diagnostics without report content. */
export function safeCaptureDiagnostics(captures) {
  return Object.entries(captures).flatMap(([label, value]) => {
    if (typeof value !== 'string' || value === '') return []
    return [`${label}-bytes=${Buffer.byteLength(value, 'utf8')},${label}-sha256=${sha256(value)}`]
  }).join('; ')
}

function digest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function timestamp(value, label) {
  const milliseconds = Date.parse(value ?? '')
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} time is invalid`)
  return milliseconds
}

function exactInteractionFacts(interaction) {
  return interaction?.schema === 'xiaoshe-packaged-ui-interaction/v1'
    && interaction.shellReady === true
    && interaction.composerAcceptedInput === true
    && interaction.draftSurvivedRendererRetirement === true
    && interaction.rendererGenerationChanged === true
    && interaction.rendererProcessChanged === true
    && interaction.externalDesktopActionObserved === true
    && interaction.newSessionAcceptedClick === true
    && interaction.modelControlEnabled === true
    && interaction.modelControlOpened === true
    && interaction.modelSelectionPresent === true
    && interaction.modelControlClosed === true
    && interaction.permissionControlEnabled === true
    && interaction.paidModelRequestSent === false
    && Number.isSafeInteger(interaction.archivedAcceptanceSessions)
    && interaction.archivedAcceptanceSessions >= 1
}

function packagedMaterialFacts(release, actual) {
  const packaged = release?.packagedApplication
  const validRelease = release?.schema === 'xiaoshe-macos-release-source/v1'
    && release.state === 'clean'
    && release.verified === true
    && /^[a-f0-9]{40,64}$/u.test(release.commit ?? '')
    && Number.isSafeInteger(release.files) && release.files > 0
    && digest(release.sha256)
    && digest(release.materialsSha256)
  const validApplication = packaged?.schema === 'xiaoshe-packaged-application-source/v1'
    && actual?.schema === 'xiaoshe-packaged-application-source/v1'
    && packaged.source?.state === 'clean'
    && actual.source?.state === 'clean'
    && packaged.source?.commit === release.commit
    && actual.source?.commit === release.commit
    && packaged.source?.files === release.files
    && actual.source?.files === release.files
    && packaged.source?.sha256 === release.sha256
    && actual.source?.sha256 === release.sha256
  if (!validRelease || !validApplication) throw new Error('packaged application source or material digest is invalid')

  const identities = {}
  for (const name of ['runtime', 'desktop', 'bundle']) {
    const expected = packaged.identities?.[name]
    const observed = actual.identities?.[name]
    if (!Number.isSafeInteger(expected?.files) || expected.files <= 0
        || !digest(expected?.sha256) || expected.matchesPackaged !== true
        || observed?.files !== expected.files || observed?.sha256 !== expected.sha256
        || observed?.matchesPackaged !== true) {
      throw new Error(`packaged application ${name} material identity does not match the final release`)
    }
    identities[name] = { files: expected.files, sha256: expected.sha256 }
  }

  const artifacts = {}
  for (const [name, expectedPath] of [['appAsar', 'Resources/app.asar'], ['executable', undefined], ['applicationBundle', '.']]) {
    const expected = packaged.artifacts?.[name]
    const observed = actual.artifacts?.[name]
    const bundleShape = name !== 'applicationBundle'
      || (Number.isSafeInteger(expected?.entries) && expected.entries > 0
        && Number.isSafeInteger(expected?.files) && expected.files > 0
        && observed?.entries === expected.entries && observed?.files === expected.files)
    if ((expectedPath !== undefined && expected?.path !== expectedPath)
        || typeof expected?.path !== 'string' || expected.path === ''
        || !Number.isSafeInteger(expected?.bytes) || expected.bytes < 1_024
        || !digest(expected?.sha256)
        || !bundleShape
        || observed?.path !== expected.path || observed?.bytes !== expected.bytes || observed?.sha256 !== expected.sha256) {
      const label = name === 'appAsar' ? 'app.asar' : name === 'applicationBundle' ? 'full bundle' : name
      throw new Error(`packaged application ${label} material identity does not match the final release`)
    }
    artifacts[name] = {
      path: expected.path,
      ...(name === 'applicationBundle' ? { entries: expected.entries, files: expected.files } : {}),
      bytes: expected.bytes,
      sha256: expected.sha256,
    }
  }
  return { sourceSha256: release.sha256, materialsSha256: release.materialsSha256, identities, artifacts }
}

function verifiedExternalDesktopAction(context, expected) {
  const report = context?.report
  if (report?.schema !== 'xiaoshe-macos-packaged-app-ax-action/v1'
      || report.challenge !== expected?.challenge
      || report.runId !== expected?.runId
      || report.targetPid !== expected?.childPid) {
    throw new Error('external desktop action identity does not match the known packaged child')
  }
  const startedMs = timestamp(report.startedAt, 'external desktop action start')
  const completedMs = timestamp(report.completedAt, 'external desktop action completion')
  const launchedMs = timestamp(expected.launchedAt, 'known child launch')
  const collectedMs = timestamp(expected.collectedAt, 'known child collection')
  const action = report.action
  if (startedMs < launchedMs - 2_000 || completedMs < startedMs || completedMs > collectedMs + 2_000
      || action?.collector !== 'macos-desktop-bridge'
      || action.targetRole !== 'AXTextArea'
      || action.clickCompleted !== true
      || action.pressCompleted !== true
      || action.typedCharacters !== 25
      || !digest(action.initialSha256)
      || !digest(action.finalSha256)
      || !digest(context?.reportSha256)) {
    throw new Error('external desktop AX action facts are incomplete or stale')
  }
  return Object.freeze({
    schema: 'xiaoshe-macos-packaged-app-ax-action-receipt/v1',
    collector: action.collector,
    targetRole: action.targetRole,
    targetPid: report.targetPid,
    clickCompleted: true,
    pressCompleted: true,
    typedCharacters: action.typedCharacters,
    initialSha256: action.initialSha256,
    finalSha256: action.finalSha256,
    reportSha256: context.reportSha256,
  })
}

/** Ensure the final app bytes matched the release report both before and after the known child. */
export function requireSamePackagedApplicationMaterials(release, before, after) {
  const expected = packagedMaterialFacts(release, before)
  const observed = packagedMaterialFacts(release, after)
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error('packaged application materials changed during interaction collection')
  }
  return after
}

/**
 * Validate an app-authored report against facts known only by the lifecycle
 * collector, then project a content-free receipt for the aggregate verifier.
 */
export function createPackagedAppActionReceipt(report, context) {
  const expected = context?.expected
  const release = context?.releaseSource
  const packaged = release?.packagedApplication
  const packagedRuntime = packaged?.identities?.runtime
  const packagedExecutable = packaged?.artifacts?.executable
  const runtime = context?.runtime
  const persistedApplicationRole = applicationRole(expected?.applicationRole)
  if (report?.schema !== 'xiaoshe-packaged-app-interaction/v1' || report.schemaVersion !== 1 || report.accepted !== true) {
    throw new Error('packaged app interaction report schema is invalid')
  }
  if (!/^[a-f0-9]{64}$/u.test(expected?.challenge ?? '') || report.challenge !== expected.challenge) {
    throw new Error('packaged app interaction challenge does not match the known child launch')
  }
  if (report.runId !== expected?.runId) throw new Error('packaged app interaction run identity does not match the lifecycle run')
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(expected?.acceptanceRunId ?? '')) {
    throw new Error('packaged app interaction acceptance run identity is invalid')
  }
  if (report.application?.pid !== expected.childPid) throw new Error('packaged app interaction process does not match the known child pid')
  if (report.application?.isPackaged !== true) throw new Error('interaction report was not authored by a packaged application process')
  if (expected?.bundleId !== PRODUCT_BUNDLE_ID
      || report.application?.bundleId !== expected.bundleId
      || report.application?.executablePath !== expected.executablePath
      || report.application?.bundlePath !== expected.appPath
      || report.application?.bundleExecutable !== expected.bundleExecutable) {
    throw new Error('packaged app interaction executable or bundle path does not match the launched child')
  }
  const startedMs = timestamp(report.startedAt, 'packaged app interaction start')
  const completedMs = timestamp(report.completedAt, 'packaged app interaction completion')
  const launchedMs = timestamp(expected.launchedAt, 'known child launch')
  const collectedMs = timestamp(expected.collectedAt, 'known child collection')
  if (startedMs < launchedMs - 2_000 || completedMs < startedMs || completedMs > collectedMs + 2_000) {
    throw new Error('packaged app interaction report is not fresh for the known child lifetime')
  }
  if (!exactInteractionFacts(report.interaction)) throw new Error('packaged app interaction facts are incomplete')
  const desktopAction = verifiedExternalDesktopAction(context?.desktopAction, expected)

  const applicationMaterials = requireSamePackagedApplicationMaterials(
    release,
    context?.applicationMaterials,
    context?.applicationMaterials,
  )

  const validMaterials = release?.schema === 'xiaoshe-macos-release-source/v1'
    && release.state === 'clean'
    && release.verified === true
    && /^[a-f0-9]{40,64}$/u.test(release.commit ?? '')
    && packaged?.schema === 'xiaoshe-packaged-application-source/v1'
    && packaged.source?.state === 'clean'
    && packaged.source?.commit === release.commit
    && packagedExecutable?.path === `MacOS/${expected.bundleExecutable}`
    && digest(packagedExecutable?.sha256)
    && packagedExecutable.sha256 === context.executableSha256
    && packagedRuntime?.matchesPackaged === true
    && digest(packagedRuntime?.sha256)
    && runtime?.markerSchemaVersion === 3
    && runtime.fingerprintVerified === true
    && runtime.matchesPackagedRuntime === true
    && digest(runtime.fingerprint)
    && digest(expected.interactionReportSha256)
  if (!validMaterials) throw new Error('packaged app interaction material or runtime digest is invalid')

  const interaction = Object.freeze({
    schema: 'xiaoshe-packaged-ui-interaction/v1',
    shellReady: true,
    composerAcceptedInput: true,
    draftSurvivedRendererRetirement: true,
    rendererGenerationChanged: true,
    rendererProcessChanged: true,
    externalDesktopActionObserved: true,
    newSessionAcceptedClick: true,
    modelControlEnabled: true,
    modelControlOpened: true,
    modelSelectionPresent: true,
    modelControlClosed: true,
    permissionControlEnabled: true,
    paidModelRequestSent: false,
    archivedAcceptanceSessions: report.interaction.archivedAcceptanceSessions,
  })
  return Object.freeze({
    schema: 'xiaoshe-macos-packaged-app-action/v1',
    initiator: 'packaged-app',
    trust: Object.freeze({
      schema: 'xiaoshe-macos-packaged-app-action-trust/v1',
      collector: 'macos-app-lifecycle',
      collection: 'known-child',
      challengeVerified: true,
      runIdVerified: true,
      childProcessVerified: true,
      executableVerified: true,
      reportTimeVerified: true,
      materialsVerified: true,
      interactionVerified: true,
      desktopActionVerified: true,
    }),
    runId: report.runId,
    acceptanceRunId: expected.acceptanceRunId,
    appProcessPid: expected.childPid,
    applicationRole: persistedApplicationRole,
    bundleId: expected.bundleId,
    bundleExecutable: expected.bundleExecutable,
    executableSha256: context.executableSha256,
    sourceCommit: release.commit,
    sourceSha256: release.sha256,
    materialsSha256: release.materialsSha256,
    appAsarSha256: applicationMaterials.artifacts.appAsar.sha256,
    applicationBundleSha256: applicationMaterials.artifacts.applicationBundle.sha256,
    productBundleSha256: applicationMaterials.identities.bundle.sha256,
    packagedDesktopSha256: applicationMaterials.identities.desktop.sha256,
    packagedRuntimeSha256: packagedRuntime.sha256,
    runtimeSha256: runtime.fingerprint,
    interactionReportSha256: expected.interactionReportSha256,
    challengeSha256: sha256(expected.challenge),
    desktopAction,
    reportStartedAt: report.startedAt,
    reportCompletedAt: report.completedAt,
    interaction,
  })
}

export function packagedAppActionCheck(receipt) {
  return {
    id: 'real-desktop-action-loop',
    state: 'pass',
    detail: '外部 macOS AX/OS 输入驱动已对 lifecycle 启动的最终打包小蛇.app 子进程完成点击与键盘输入；应用内报告另行证明 UI 与 renderer 恢复事实。',
    evidence: {
      receiptReference: {
        schema: 'xiaoshe-macos-packaged-app-action-reference/v1',
        collectorCheckId: 'macos-app-lifecycle',
        receiptSha256: sha256(JSON.stringify(receipt)),
      },
    },
  }
}

function packagedAppActionCollection(receipt) {
  const receiptSha256 = sha256(JSON.stringify(receipt))
  return Object.freeze({
    schema: 'xiaoshe-macos-packaged-app-action-collection/v1',
    child: Object.freeze({
      pid: receipt.appProcessPid,
      applicationRole: receipt.applicationRole,
      bundleExecutable: receipt.bundleExecutable,
      exitCode: 0,
    }),
    receipt,
    receiptSha256,
  })
}

async function readBoundedJson(path, ownedRoot, label) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > MAX_ACTION_REPORT) {
    throw new Error(`${label} is not a bounded regular file`)
  }
  const canonicalRoot = await realpath(ownedRoot)
  const canonicalPath = await realpath(path)
  const remainder = relative(canonicalRoot, canonicalPath)
  if (remainder === '' || isAbsolute(remainder) || remainder === '..' || remainder.startsWith(`..${sep}`)) {
    throw new Error(`${label} escaped isolated lifecycle storage`)
  }
  const raw = await readFile(canonicalPath)
  return { value: JSON.parse(raw.toString('utf8')), sha256: sha256(raw) }
}

async function waitForPackagedActionReady(path, ownedRoot, expected, timeoutMs) {
  return await waitUntil(async () => {
    if (expected.child?.exitCode !== null) throw new Error(`packaged app interaction child exited ${expected.child.exitCode} before external-action readiness`)
    let ready
    try {
      ready = await readBoundedJson(path, ownedRoot, 'packaged app external-action readiness')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
    const value = ready.value
    const readyMs = Date.parse(value?.readyAt ?? '')
    if (value?.schema !== 'xiaoshe-packaged-app-external-action-ready/v1'
        || value.challenge !== expected.challenge
        || value.runId !== expected.runId
        || value.applicationPid !== expected.childPid
        || !Number.isFinite(readyMs)
        || readyMs < Date.parse(expected.launchedAt) - 2_000
        || readyMs > Date.now() + 5 * 60_000) {
      throw new Error('packaged app external-action readiness identity is invalid')
    }
    return ready
  }, timeoutMs, 'packaged app external-action readiness', 100)
}

async function loadReleaseSource(path, runContext) {
  path = resolve(path)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 8 * 1024 * 1024) {
    throw new Error('macOS source identity report is not a bounded regular file')
  }
  const report = JSON.parse(await readFile(path, 'utf8'))
  if (report?.schemaVersion !== 1 || report.platform !== 'macos'
      || report.sourceIdentity?.schema !== 'xiaoshe-macos-release-source/v1') {
    throw new Error('macOS source identity report is invalid')
  }
  assertCurrentMacosAcceptanceReport(report, runContext, 'source')
  return report.sourceIdentity
}

function isRuntimeFileList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50_000) return false
  const normalized = []
  for (const path of value) {
    if (typeof path !== 'string' || path === '' || path.includes('\\') || isAbsolute(path)) return false
    const parts = path.split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..')) return false
    normalized.push(path)
  }
  const sorted = [...new Set(normalized)].sort()
  return sorted.length === normalized.length
    && JSON.stringify(sorted) === JSON.stringify(normalized)
    && REQUIRED_MATERIALIZED_FILES.every(path => sorted.includes(path))
}

async function runtimeFingerprint(root, files) {
  const canonicalRoot = await realpath(root)
  const hashes = []
  for (const relativePath of files) {
    const path = join(canonicalRoot, relativePath)
    const info = await lstat(path)
    const canonicalPath = await realpath(path)
    const remainder = relative(canonicalRoot, canonicalPath)
    if (!info.isFile() || info.isSymbolicLink() || remainder === '' || isAbsolute(remainder) || remainder === '..' || remainder.startsWith(`..${sep}`)) {
      throw new Error(`packaged runtime marker references an unsafe file: ${relativePath}`)
    }
    hashes.push(createHash('sha256').update(await readFile(canonicalPath)).digest('hex'))
  }
  return createHash('sha256').update(JSON.stringify(files.map((path, index) => [path, hashes[index]]))).digest('hex')
}

export async function inspectMaterializedRuntime(userData, version, packagedProductRoot) {
  const expected = join(userData, 'runtime', version)
  const canonicalUserData = await realpath(userData)
  const canonicalRuntime = await realpath(expected)
  const remainder = relative(canonicalUserData, canonicalRuntime)
  if (remainder === '' || isAbsolute(remainder) || remainder === '..' || remainder.startsWith(`..${sep}`)) {
    throw new Error('packaged runtime was not materialized below isolated userData')
  }
  for (const path of REQUIRED_MATERIALIZED_FILES) await access(join(canonicalRuntime, path))
  const marker = JSON.parse(await readFile(join(canonicalRuntime, RUNTIME_MARKER), 'utf8'))
  // Historical v1/v2 materializations remain inspectable for diagnostics. The
  // formal packaged lifecycle separately requires the current v3 inventory.
  const v3 = marker?.schemaVersion === 3
    && /^[a-f0-9]{64}$/u.test(marker.fingerprint ?? '')
    && isRuntimeFileList(marker.files)
  const supportedMarker = marker?.schemaVersion === 1 ||
    (marker?.schemaVersion === 2 && /^[a-f0-9]{64}$/u.test(marker.fingerprint ?? '')) || v3
  if (!supportedMarker || marker.version !== version) throw new Error('packaged runtime marker is invalid')
  if (v3 && await runtimeFingerprint(canonicalRuntime, marker.files) !== marker.fingerprint) {
    throw new Error('packaged runtime marker fingerprint mismatch')
  }
  const matchesPackagedRuntime = v3 && packagedProductRoot !== undefined
    ? await runtimeFingerprint(packagedProductRoot, marker.files) === marker.fingerprint
    : false
  if (v3 && packagedProductRoot !== undefined && !matchesPackagedRuntime) {
    throw new Error('materialized runtime fingerprint does not match the final packaged runtime')
  }
  return {
    source: 'per-user-copy',
    materializedUnderUserData: true,
    version: marker.version,
    requiredFiles: REQUIRED_MATERIALIZED_FILES,
    markerSchemaVersion: marker.schemaVersion,
    fingerprintVerified: v3,
    matchesPackagedRuntime,
    fingerprint: v3 ? marker.fingerprint : undefined,
  }
}

export function requireCurrentRuntimeMarker(runtime) {
  if (runtime?.markerSchemaVersion !== 3 || runtime.fingerprintVerified !== true) {
    throw new Error('formal macOS lifecycle requires the current v3 runtime marker with a verified content fingerprint')
  }
  if (runtime.matchesPackagedRuntime !== true) throw new Error('formal macOS lifecycle requires the materialized runtime to match the final packaged runtime')
  return runtime
}

export function requireSameMaterializedRuntime(before, after) {
  requireCurrentRuntimeMarker(before)
  requireCurrentRuntimeMarker(after)
  if (before.fingerprint !== after.fingerprint) throw new Error('packaged runtime fingerprint changed during interaction collection')
  return after
}

/** Read launch identity from the final application bundle, not package config. */
export async function inspectMacosBundleIdentity(appPath, runCommand = spawnSync) {
  appPath = resolve(appPath)
  const infoPlist = join(appPath, 'Contents', 'Info.plist')
  await access(infoPlist)
  const readValue = key => {
    const result = runCommand('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, infoPlist], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`could not read ${key} from final application Info.plist`)
    return String(result.stdout ?? '').trim()
  }
  const bundleId = readValue('CFBundleIdentifier')
  const bundleExecutable = readValue('CFBundleExecutable')
  if (bundleId !== PRODUCT_BUNDLE_ID) throw new Error(`unexpected final application bundle identifier: ${bundleId || '<empty>'}`)
  if (bundleExecutable === '' || bundleExecutable === '.' || bundleExecutable === '..' || /[\\/\0]/u.test(bundleExecutable)) {
    throw new Error('final application bundle executable is invalid')
  }
  const binary = join(appPath, 'Contents', 'MacOS', bundleExecutable)
  await access(binary, constants.X_OK)
  return { bundleId, bundleExecutable, binary }
}

async function inspectFinalApplicationMaterials(root, appPath, binary, releaseSource) {
  const contents = join(appPath, 'Contents')
  return await verifyPackagedApplicationSourceIdentity({
    repositoryRoot: root,
    applicationRoot: contents,
    applicationBundleRoot: appPath,
    resourcesDir: join(contents, 'Resources'),
    executablePath: binary,
    expectedSource: releaseSource?.packagedApplication?.source,
  })
}

export async function runMacosAppLifecycle({ root, appPath, applicationRole: requestedApplicationRole, keepUserData = false, usePackagedRuntime = false, actionContext }) {
  if (process.platform !== 'darwin') throw new Error('macOS application lifecycle acceptance requires Darwin')
  root = resolve(root)
  appPath = resolve(appPath)
  const persistedApplicationRole = applicationRole(requestedApplicationRole)
  const bundle = await inspectMacosBundleIdentity(appPath)
  const { binary } = bundle
  const packagedProductRoot = join(appPath, 'Contents', 'Resources', 'product')
  if (serviceIsRegistered()) throw new Error(`${SERVICE_LABEL} already exists; refusing to disturb an unrelated service`)

  const port = await findFreePort()
  if (await portIsOpen(port)) throw new Error(`isolated port ${port} unexpectedly has a listener`)
  const userData = await mkdtemp(join(tmpdir(), 'xiaoshe-desktop-lifecycle-'))
  const isolatedHome = join(userData, 'home')
  await mkdir(isolatedHome, { recursive: true })
  const url = `http://127.0.0.1:${port}/`
  const commonArgs = [`--user-data-dir=${userData}`]
  const environment = {
    ...process.env,
    XIAOSHE_DSH_PORT: String(port),
    XIAOSHE_DESKTOP_URL: url,
    XIAOSHE_DESKTOP_ACCEPTANCE: '1',
  }
  const ownershipToken = randomUUID()
  environment.XIAOSHE_LAUNCH_TOKEN = ownershipToken
  if (usePackagedRuntime) {
    environment.HOME = isolatedHome
    environment.DSH_HOME = join(isolatedHome, '.dsh')
    for (const key of ['XIAOSHE_PRODUCT_ROOT', 'XIAOSHE_DSH_ROOT', 'XIAOSHE_LEGACY_ROOT', 'XIAOSHE_PNPM_CLI']) delete environment[key]
  } else {
    environment.XIAOSHE_PRODUCT_ROOT = root
  }
  let primary
  let second
  let interactionProcess
  let desktopActionProcess
  let succeeded = false
  let ownedRuntimeRoot = usePackagedRuntime ? undefined : root
  let evidence
  let operationError
  let ownedPortReleased = false
  let ownedServiceReleased = false
  try {
    primary = launch(binary, [...commonArgs, '--acceptance-hide-show', '--acceptance-quit-after=15000'], environment)
    const health = await waitUntil(
      () => {
        if (primary.child.exitCode !== null) throw new Error(`primary desktop exited early (${primary.child.exitCode})`)
        return readProductStatus(url)
      },
      usePackagedRuntime ? PACKAGED_RUNTIME_STARTUP_TIMEOUT_MS : 120_000,
      'packaged Xiaoshe product readiness',
      250,
    )
    // Never derive an executable cleanup path from an HTTP response. Resolve
    // the one marker-backed runtime below isolated userData instead.
    ownedRuntimeRoot = usePackagedRuntime ? await findOwnedRuntimeRoot(userData) : root
    const visibleWindow = await waitUntil(() => brandedWindowFact(primary.child.pid), 12_000, 'branded packaged Xiaoshe window')
    const runtime = usePackagedRuntime
      ? requireCurrentRuntimeMarker(await inspectMaterializedRuntime(userData, String(health.version), packagedProductRoot))
      : { source: 'explicit-override', materializedUnderUserData: false }

    second = launch(binary, commonArgs, environment)
    const secondExitCode = await waitForExit(second.child, 10_000, 'second packaged instance')
    if (secondExitCode !== 0) throw new Error(`second packaged instance exited ${secondExitCode}`)
    if (primary.child.exitCode !== null) throw new Error('primary packaged instance exited during single-instance arbitration')

    const primaryExitCode = await waitForExit(primary.child, 45_000, 'primary packaged instance')
    if (primaryExitCode !== 0) throw new Error(`primary packaged instance exited ${primaryExitCode}`)
    let portReleased = await waitUntil(async () => !(await portIsOpen(port)), 15_000, 'owned product port release')
    let serviceReleased = await waitUntil(() => !serviceIsRegistered(), 15_000, 'owned launchd service release')
    const log = await startupEvents(userData)
    // A healthy listener is not sufficient: Electron can still be showing a
    // blank page after a one-shot ERR_CONNECTION_REFUSED.  Keep the renderer
    // navigation completion in the release gate so that failure cannot drift
    // back into a false-positive desktop acceptance.
    const requiredEvents = ['boot-started', 'runtime-ready', 'service-ready', 'ui-renderer-ready', 'ui-ready', 'ui-recovery-deferred', 'ui-recovered', 'ui-visual-proof']
    for (const event of requiredEvents) {
      if (!log.events.includes(event)) throw new Error(`desktop lifecycle log is missing ${event}`)
    }
    const visualProof = log.rows.find(row => row.event === 'ui-visual-proof')
    if (visualProof?.nonBlank !== true) throw new Error('desktop lifecycle visual proof is blank')
    const runtimeReady = log.rows.find(row => row.event === 'runtime-ready')
    if (runtimeReady?.source !== runtime.source) throw new Error(`desktop reported unexpected runtime source: ${String(runtimeReady?.source)}`)

    let packagedAppAction
    if (actionContext !== undefined) {
      if (!usePackagedRuntime) throw new Error('packaged app action collection requires the verified packaged runtime')
      const applicationMaterialsBefore = await inspectFinalApplicationMaterials(root, appPath, binary, actionContext.releaseSource)
      // Validate before launch as well as after it: the lifecycle report must
      // bind the exact final signed/notarized app, not a later replacement.
      requireSamePackagedApplicationMaterials(actionContext.releaseSource, applicationMaterialsBefore, applicationMaterialsBefore)
      const challenge = randomBytes(32).toString('hex')
      const actionRunId = randomUUID()
      const reportPath = join(userData, 'acceptance', 'packaged-app-interaction.json')
      const readyPath = join(userData, 'acceptance', 'packaged-app-external-action-ready.json')
      const desktopActionReportPath = join(userData, 'acceptance', 'packaged-app-external-action.json')
      const launchedAt = new Date().toISOString()
      const actionEnvironment = {
        ...environment,
        XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: actionRunId,
        XIAOSHE_DESKTOP_ACCEPTANCE_CHALLENGE: challenge,
        XIAOSHE_DESKTOP_ACCEPTANCE_REPORT: reportPath,
        XIAOSHE_DESKTOP_ACCEPTANCE_READY: readyPath,
      }
      const executableSha256 = sha256(await readFile(binary))
      interactionProcess = launch(binary, [...commonArgs, '--acceptance-interaction'], actionEnvironment)
      const actionDeadline = Date.now() + PACKAGED_INTERACTION_CHILD_TIMEOUT_MS
      await waitForPackagedActionReady(readyPath, userData, {
        challenge,
        runId: actionRunId,
        childPid: interactionProcess.child.pid,
        child: interactionProcess.child,
        launchedAt,
      }, Math.min(
        PACKAGED_INTERACTION_READY_TIMEOUT_MS,
        Math.max(1, actionDeadline - Date.now() - PACKAGED_INTERACTION_POST_READY_RESERVE_MS),
      ))
      const python = process.env.XIAOSHE_PYTHON?.trim() || 'python3'
      desktopActionProcess = launch(python, [
        join(root, 'scripts', 'acceptance', 'macos-desktop-actions.py'),
        '--root', root,
        '--output', desktopActionReportPath,
        '--target-pid', String(interactionProcess.child.pid),
        '--challenge', challenge,
        '--run-id', actionRunId,
        '--ready', readyPath,
      ], actionEnvironment, root)
      const desktopActionExitCode = await waitForExit(
        desktopActionProcess.child,
        Math.min(90_000, Math.max(1, actionDeadline - Date.now())),
        'packaged app external desktop action driver',
      )
      if (desktopActionExitCode !== 0) throw new Error(`packaged app external desktop action driver exited ${desktopActionExitCode}`)
      const desktopActionReport = await readBoundedJson(desktopActionReportPath, userData, 'packaged app external desktop action report')
      const actionExitCode = await waitForExit(
        interactionProcess.child,
        Math.max(1, actionDeadline - Date.now()),
        'packaged app interaction child',
      )
      if (actionExitCode !== 0) {
        throw new Error(`packaged app interaction child exited ${actionExitCode}`)
      }
      const collectedAt = new Date().toISOString()
      portReleased = await waitUntil(async () => !(await portIsOpen(port)), 15_000, 'interaction product port release')
      serviceReleased = await waitUntil(() => !serviceIsRegistered(), 15_000, 'interaction launchd service release')
      const actionReport = await readBoundedJson(reportPath, userData, 'packaged app interaction report')
      const postActionRuntime = requireSameMaterializedRuntime(
        runtime,
        await inspectMaterializedRuntime(userData, String(health.version), packagedProductRoot),
      )
      const applicationMaterials = requireSamePackagedApplicationMaterials(
        actionContext.releaseSource,
        applicationMaterialsBefore,
        await inspectFinalApplicationMaterials(root, appPath, binary, actionContext.releaseSource),
      )
      if (applicationMaterials.artifacts.executable.sha256 !== executableSha256) throw new Error('packaged executable changed during interaction collection')
      const receipt = createPackagedAppActionReceipt(actionReport.value, {
        expected: {
          runId: actionRunId,
          acceptanceRunId: actionContext.runContext.runId,
          challenge,
          childPid: interactionProcess.child.pid,
          applicationRole: persistedApplicationRole,
          appPath,
          executablePath: binary,
          bundleId: bundle.bundleId,
          bundleExecutable: bundle.bundleExecutable,
          launchedAt,
          collectedAt,
          interactionReportSha256: actionReport.sha256,
        },
        releaseSource: actionContext.releaseSource,
        runtime: postActionRuntime,
        applicationMaterials,
        executableSha256,
        desktopAction: { report: desktopActionReport.value, reportSha256: desktopActionReport.sha256 },
      })
      packagedAppAction = packagedAppActionCollection(receipt)
    }

    evidence = {
      applicationRole: persistedApplicationRole,
      appPath,
      bundleId: bundle.bundleId,
      bundleExecutable: bundle.bundleExecutable,
      primaryPid: primary.child.pid,
      secondPid: second.child.pid,
      primaryExitCode,
      secondExitCode,
      port,
      status: { product: health.product, version: health.version, bridge: health.bridge?.state, platform: health.bridge?.platform },
      window: visibleWindow,
      startupEvents: requiredEvents,
      runtime,
      portReleased: Boolean(portReleased),
      serviceReleased: Boolean(serviceReleased),
      userData,
      ...(packagedAppAction === undefined ? {} : { packagedAppAction }),
    }
    succeeded = true
  } catch (error) {
    const diagnostics = await failureDiagnostics(userData, primary, second, interactionProcess, desktopActionProcess)
    const message = error instanceof Error ? error.message : String(error)
    operationError = new Error(diagnostics === '' ? message : `${message}; ${diagnostics}`, { cause: error })
  } finally {
    try {
      await runLifecycleCleanup([
        ['interaction packaged process cleanup', () => terminate(interactionProcess?.child, 'packaged app interaction child')],
        ['external desktop action process cleanup', () => terminate(desktopActionProcess?.child, 'packaged app external desktop action driver')],
        ['secondary packaged process cleanup', () => terminate(second?.child, 'second packaged instance')],
        ['primary packaged process cleanup', () => terminate(primary?.child, 'primary packaged instance')],
        ['owned service cleanup', async () => {
          if (!serviceIsRegistered()) return
          if (ownedRuntimeRoot === undefined) ownedRuntimeRoot = await findOwnedRuntimeRoot(userData)
          await stopOwnedService(ownedRuntimeRoot, port, environment, ownershipToken)
        }],
        ['owned service port release', async () => {
          await waitUntil(async () => !(await portIsOpen(port)), 15_000, 'owned service port release')
          ownedPortReleased = true
        }],
        ['owned launchd service release', async () => {
          await waitUntil(() => !serviceIsRegistered(), 15_000, 'owned launchd service release')
          ownedServiceReleased = true
        }],
        ['isolated userData cleanup', async () => {
          if (!ownedPortReleased || !ownedServiceReleased) {
            throw new Error(`isolated userData retained because owned service release was not verified: ${userData}`)
          }
          if (!keepUserData || !succeeded) await rm(userData, { recursive: true, force: true })
        }],
      ])
    } catch (cleanupError) {
      const failures = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]
      operationError = operationError === undefined
        ? cleanupError
        : new AggregateError([operationError, ...failures], 'macOS lifecycle operation and cleanup failed')
    }
  }
  if (operationError !== undefined) throw operationError
  return evidence
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = resolve(args.get('root') || process.cwd())
  const appPath = resolve(args.get('app') || join(root, 'apps', 'desktop-shell', 'dist-desktop', 'mac-arm64', '小蛇.app'))
  const output = resolve(args.get('output') || join(root, 'artifacts', 'acceptance', 'macos-app-lifecycle.json'))
  const usePackagedRuntime = args.get('runtime') === 'packaged'
  const runContext = acceptanceRunMetadataFromEnvironment()
  const actionContext = args.has('source')
    ? { runContext, releaseSource: await loadReleaseSource(args.get('source'), runContext) }
    : undefined
  let lifecycleCheck
  let actionCheck
  try {
    const evidence = await runMacosAppLifecycle({ root, appPath, applicationRole: 'built-distribution', usePackagedRuntime, actionContext })
    lifecycleCheck = {
      id: 'macos-app-lifecycle',
      state: 'pass',
      detail: '真实打包应用完成窗口启动、产品就绪、单实例仲裁、正常退出和自有服务回收。',
      evidence: contentFreeLifecycleEvidence(evidence),
    }
    actionCheck = evidence.packagedAppAction === undefined
      ? {
          id: 'real-desktop-action-loop',
          state: 'pending_external',
          detail: '未提供当前运行的发布源身份；最终打包小蛇.app 动作回执待正式 macOS 验收。',
          evidence: {},
        }
      : packagedAppActionCheck(evidence.packagedAppAction.receipt)
  } catch (error) {
    const failure = contentFreeFailureEvidence('packaged-lifecycle', error)
    lifecycleCheck = {
      id: 'macos-app-lifecycle',
      state: 'fail',
      detail: 'macOS application lifecycle failed; sensitive diagnostics omitted.',
      evidence: { applicationRole: 'built-distribution', ...failure },
    }
    actionCheck = actionContext === undefined
      ? { id: 'real-desktop-action-loop', state: 'pending_external', detail: '最终打包小蛇.app 动作回执未执行。', evidence: {} }
      : {
          id: 'real-desktop-action-loop',
          state: 'fail',
          detail: 'Packaged application interaction collection failed; sensitive diagnostics omitted.',
          evidence: { applicationRole: 'built-distribution', ...failure },
        }
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify({ schemaVersion: 1, platform: 'macos', generatedAt: new Date().toISOString(), ...runContext, checks: [lifecycleCheck, actionCheck] }, null, 2)}\n`)
  process.stdout.write(`macOS app lifecycle: ${output}\n`)
  if ([lifecycleCheck, actionCheck].some(check => check.state === 'fail')) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
