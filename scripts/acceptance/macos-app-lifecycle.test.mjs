import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import * as lifecycle from './macos-app-lifecycle.mjs'

const { inspectMaterializedRuntime, requireCurrentRuntimeMarker, runLifecycleCleanup } = lifecycle

const APP_PATH = '/Applications/小蛇.app'
const EXECUTABLE_PATH = `${APP_PATH}/Contents/MacOS/小蛇`
const ACCEPTANCE_RUN_ID = '11111111-1111-4111-8111-111111111111'
const ACTION_RUN_ID = '22222222-2222-4222-8222-222222222222'
const CHALLENGE = 'c'.repeat(64)
const EXECUTABLE_SHA256 = 'e'.repeat(64)
const PACKAGED_RUNTIME_SHA256 = 'f'.repeat(64)
const MATERIALIZED_RUNTIME_SHA256 = 'a'.repeat(64)
const SOURCE_SHA256 = '1'.repeat(64)
const MATERIALS_SHA256 = '2'.repeat(64)
const APP_ASAR_SHA256 = '3'.repeat(64)
const PRODUCT_BUNDLE_SHA256 = '4'.repeat(64)
const PACKAGED_DESKTOP_SHA256 = '5'.repeat(64)
const APPLICATION_BUNDLE_SHA256 = '6'.repeat(64)

function packagedApplicationMaterials(overrides = {}) {
  return {
    schema: 'xiaoshe-packaged-application-source/v1',
    source: { state: 'clean', commit: 'b'.repeat(40), files: 42, sha256: SOURCE_SHA256 },
    identities: {
      runtime: { files: 42, sha256: PACKAGED_RUNTIME_SHA256, packagedSha256: PACKAGED_RUNTIME_SHA256, matchesPackaged: true },
      desktop: { files: 12, sha256: PACKAGED_DESKTOP_SHA256, packagedSha256: PACKAGED_DESKTOP_SHA256, matchesPackaged: true },
      bundle: { files: 6, sha256: PRODUCT_BUNDLE_SHA256, packagedSha256: PRODUCT_BUNDLE_SHA256, matchesPackaged: true },
    },
    artifacts: {
      appAsar: { path: 'Resources/app.asar', bytes: 4096, sha256: APP_ASAR_SHA256 },
      executable: { path: 'MacOS/小蛇', bytes: 4096, sha256: EXECUTABLE_SHA256 },
      applicationBundle: { path: '.', entries: 20, files: 14, bytes: 32768, sha256: APPLICATION_BUNDLE_SHA256 },
    },
    ...overrides,
  }
}

function packagedInteractionReport(overrides = {}) {
  return {
    schema: 'xiaoshe-packaged-app-interaction/v1',
    schemaVersion: 1,
    accepted: true,
    challenge: CHALLENGE,
    runId: ACTION_RUN_ID,
    startedAt: '2026-09-06T00:00:01.000Z',
    completedAt: '2026-09-06T00:00:08.000Z',
    application: {
      pid: 4242,
      executablePath: EXECUTABLE_PATH,
      isPackaged: true,
      bundlePath: APP_PATH,
      bundleId: 'com.xiaoshe.desktop',
      bundleExecutable: '小蛇',
    },
    interaction: {
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
      archivedAcceptanceSessions: 1,
    },
    ...overrides,
  }
}

function packagedDesktopActionReport(overrides = {}) {
  return {
    schema: 'xiaoshe-macos-packaged-app-ax-action/v1',
    challenge: CHALLENGE,
    runId: ACTION_RUN_ID,
    targetPid: 4242,
    startedAt: '2026-09-06T00:00:02.000Z',
    completedAt: '2026-09-06T00:00:04.000Z',
    action: {
      collector: 'macos-desktop-bridge',
      targetRole: 'AXTextArea',
      clickCompleted: true,
      pressCompleted: true,
      typedCharacters: 25,
      initialSha256: '7'.repeat(64),
      finalSha256: '8'.repeat(64),
    },
    ...overrides,
  }
}

function packagedActionContext(overrides = {}) {
  return {
    expected: {
      runId: ACTION_RUN_ID,
      acceptanceRunId: ACCEPTANCE_RUN_ID,
      challenge: CHALLENGE,
      childPid: 4242,
      applicationRole: 'built-distribution',
      appPath: APP_PATH,
      executablePath: EXECUTABLE_PATH,
      bundleId: 'com.xiaoshe.desktop',
      bundleExecutable: '小蛇',
      launchedAt: '2026-09-06T00:00:00.000Z',
      collectedAt: '2026-09-06T00:00:09.000Z',
      interactionReportSha256: 'd'.repeat(64),
    },
    releaseSource: {
      schema: 'xiaoshe-macos-release-source/v1',
      state: 'clean',
      verified: true,
      commit: 'b'.repeat(40),
      files: 42,
      sha256: SOURCE_SHA256,
      materialsSha256: MATERIALS_SHA256,
      packagedApplication: packagedApplicationMaterials(),
    },
    runtime: {
      markerSchemaVersion: 3,
      fingerprintVerified: true,
      fingerprint: MATERIALIZED_RUNTIME_SHA256,
      matchesPackagedRuntime: true,
    },
    applicationMaterials: packagedApplicationMaterials(),
    executableSha256: EXECUTABLE_SHA256,
    desktopAction: {
      report: packagedDesktopActionReport(),
      reportSha256: '9'.repeat(64),
    },
    ...overrides,
  }
}

// Only the portable on-disk acceptance contract is tested on Windows. These
// tests do not claim to launch an actual macOS application.
async function runtimeFixture(t, marker) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-marker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = join(root, 'runtime/0.2.0')
  for (const file of ['package.json', 'pnpm-lock.yaml', 'runtime/DSH/apps/cli/lib/bin.js', 'scripts/start-xiaoshe-web.sh']) {
    await mkdir(dirname(join(runtime, file)), { recursive: true })
    await writeFile(join(runtime, file), 'fixture')
  }
  await writeFile(join(runtime, '.xiaoshe-product-runtime.json'), JSON.stringify(marker))
  return root
}

async function currentMarker(root, overrides = {}) {
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'runtime/DSH/apps/cli/lib/bin.js',
    'scripts/start-xiaoshe-web.sh',
  ]
  const hashes = await Promise.all(files.map(async file => createHash('sha256').update(await readFile(join(root, 'runtime/0.2.0', file))).digest('hex')))
  return {
    schemaVersion: 3,
    version: '0.2.0',
    fingerprint: createHash('sha256').update(JSON.stringify(files.map((file, index) => [file, hashes[index]]))).digest('hex'),
    files,
    ...overrides,
  }
}

test('macOS runtime inspection accepts the content-verified marker used by the current shell', async t => {
  const root = await runtimeFixture(t, {})
  const marker = await currentMarker(root)
  await writeFile(join(root, 'runtime/0.2.0/.xiaoshe-product-runtime.json'), JSON.stringify(marker))
  const inspected = await inspectMaterializedRuntime(root, '0.2.0', join(root, 'runtime/0.2.0'))
  assert.equal(inspected.materializedUnderUserData, true)
  assert.equal(inspected.markerSchemaVersion, 3)
  assert.equal(inspected.fingerprintVerified, true)
  assert.equal(inspected.fingerprint, marker.fingerprint)
  assert.equal(inspected.matchesPackagedRuntime, true)
})

test('packaged interaction child budget makes a slow warm start and the app interaction budget reachable', () => {
  assert.equal(typeof lifecycle.PACKAGED_RUNTIME_STARTUP_TIMEOUT_MS, 'number')
  assert.ok(lifecycle.PACKAGED_RUNTIME_STARTUP_TIMEOUT_MS >= 15 * 60_000)
  assert.equal(typeof lifecycle.PACKAGED_INTERACTION_CHILD_TIMEOUT_MS, 'number')
  assert.equal(typeof lifecycle.PACKAGED_INTERACTION_READY_TIMEOUT_MS, 'number')
  assert.ok(lifecycle.PACKAGED_INTERACTION_READY_TIMEOUT_MS >= 10 * 60_000)
  assert.ok(lifecycle.PACKAGED_INTERACTION_CHILD_TIMEOUT_MS >= 20 * 60_000)
  assert.ok(
    lifecycle.PACKAGED_INTERACTION_CHILD_TIMEOUT_MS
      >= lifecycle.PACKAGED_INTERACTION_READY_TIMEOUT_MS + 330_000 + 2 * 60_000,
    'known-child deadline must leave margin after the app interaction guard',
  )
})

test('macOS runtime inspection binds the materialized copy to the final packaged product bytes', async t => {
  const root = await runtimeFixture(t, {})
  const materialized = join(root, 'runtime/0.2.0')
  const packaged = join(root, 'packaged-product')
  const files = ['package.json', 'pnpm-lock.yaml', 'runtime/DSH/apps/cli/lib/bin.js', 'scripts/start-xiaoshe-web.sh']
  for (const file of files) {
    await mkdir(dirname(join(packaged, file)), { recursive: true })
    await writeFile(join(packaged, file), 'fixture')
  }
  await writeFile(join(materialized, '.xiaoshe-product-runtime.json'), JSON.stringify(await currentMarker(root)))

  assert.equal((await inspectMaterializedRuntime(root, '0.2.0', packaged)).matchesPackagedRuntime, true)
  await writeFile(join(packaged, 'package.json'), 'different packaged bytes')
  await assert.rejects(
    inspectMaterializedRuntime(root, '0.2.0', packaged),
    /packaged.*runtime|runtime.*packaged|fingerprint/iu,
  )
})

test('macOS lifecycle reads bundle identifier and executable from the final app Info.plist', async t => {
  assert.equal(typeof lifecycle.inspectMacosBundleIdentity, 'function', 'bundle identity inspector is required')
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-macos-bundle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const appPath = join(root, '小蛇.app')
  const contents = join(appPath, 'Contents')
  const binary = join(contents, 'MacOS', '小蛇')
  await mkdir(dirname(binary), { recursive: true })
  await writeFile(join(contents, 'Info.plist'), 'fixture plist bytes')
  await writeFile(binary, 'fixture executable')
  await chmod(binary, 0o755)

  const identity = await lifecycle.inspectMacosBundleIdentity(appPath, (_command, args) => ({
    status: 0,
    stdout: args[1].includes('CFBundleIdentifier') ? 'com.xiaoshe.desktop\n' : '小蛇\n',
    stderr: '',
  }))
  assert.deepEqual(identity, {
    bundleId: 'com.xiaoshe.desktop',
    bundleExecutable: '小蛇',
    binary,
  })
})

test('macOS runtime inspection can still inspect a historical version-only marker', async t => {
  const root = await runtimeFixture(t, { schemaVersion: 1, version: '0.2.0' })
  assert.equal((await inspectMaterializedRuntime(root, '0.2.0')).version, '0.2.0')
})

test('formal macOS lifecycle requires the current content-verified marker', () => {
  assert.equal(requireCurrentRuntimeMarker({ markerSchemaVersion: 3, fingerprintVerified: true, matchesPackagedRuntime: true }).markerSchemaVersion, 3)
  assert.throws(
    () => requireCurrentRuntimeMarker({ markerSchemaVersion: 2, fingerprintVerified: false }),
    /current v3 runtime marker/iu,
  )
  assert.throws(
    () => requireCurrentRuntimeMarker({ markerSchemaVersion: 3, fingerprintVerified: false }),
    /current v3 runtime marker/iu,
  )
  assert.throws(
    () => requireCurrentRuntimeMarker({ markerSchemaVersion: 3, fingerprintVerified: true, matchesPackagedRuntime: false }),
    /packaged.*runtime|runtime.*packaged/iu,
  )
})

test('packaged interaction collection rejects a runtime changed after child execution', () => {
  assert.equal(typeof lifecycle.requireSameMaterializedRuntime, 'function')
  const before = { markerSchemaVersion: 3, fingerprintVerified: true, matchesPackagedRuntime: true, fingerprint: MATERIALIZED_RUNTIME_SHA256 }
  assert.equal(lifecycle.requireSameMaterializedRuntime(before, { ...before }).fingerprint, MATERIALIZED_RUNTIME_SHA256)
  assert.throws(
    () => lifecycle.requireSameMaterializedRuntime(before, { ...before, fingerprint: '0'.repeat(64) }),
    /runtime.*changed|fingerprint/iu,
  )
})

for (const marker of [
  { schemaVersion: 2, version: '0.2.0' },
  { schemaVersion: 2, version: '0.2.0', fingerprint: 'not-a-digest' },
  { schemaVersion: 2, version: '0.1.0', fingerprint: 'ab'.repeat(32) },
  { schemaVersion: 3, version: '0.2.0', fingerprint: 'ab'.repeat(32), files: [] },
]) {
  test(`macOS runtime inspection rejects an invalid marker: ${JSON.stringify(marker)}`, async t => {
    const root = await runtimeFixture(t, marker)
    await assert.rejects(inspectMaterializedRuntime(root, '0.2.0'), /marker is invalid/u)
  })
}

test('macOS runtime inspection rejects a v3 marker whose file bytes no longer match', async t => {
  const root = await runtimeFixture(t, {})
  await writeFile(join(root, 'runtime/0.2.0/.xiaoshe-product-runtime.json'), JSON.stringify(await currentMarker(root)))
  await writeFile(join(root, 'runtime/0.2.0/package.json'), 'tampered')
  await assert.rejects(inspectMaterializedRuntime(root, '0.2.0'), /fingerprint.*mismatch/iu)
})

test('macOS runtime inspection rejects unsafe or incomplete v3 inventories', async t => {
  const root = await runtimeFixture(t, {})
  for (const files of [
    ['../outside'],
    ['package.json'],
    ['package.json', 'package.json'],
  ]) {
    const marker = await currentMarker(root, { files })
    await writeFile(join(root, 'runtime/0.2.0/.xiaoshe-product-runtime.json'), JSON.stringify(marker))
    await assert.rejects(inspectMaterializedRuntime(root, '0.2.0'), /marker is invalid/iu)
  }
})

test('macOS lifecycle cleanup attempts every step and reports every failure', async () => {
  const attempts = []
  await assert.rejects(
    runLifecycleCleanup([
      ['secondary process', async () => { attempts.push('secondary'); throw new Error('secondary failed') }],
      ['primary process', async () => { attempts.push('primary') }],
      ['owned service', async () => { attempts.push('service'); throw new Error('service failed') }],
      ['temporary data', async () => { attempts.push('temporary') }],
    ]),
    error => error instanceof AggregateError
      && error.errors.length === 2
      && /secondary process.*secondary failed/u.test(error.errors[0].message)
      && /owned service.*service failed/u.test(error.errors[1].message),
  )
  assert.deepEqual(attempts, ['secondary', 'primary', 'service', 'temporary'])
})

test('lifecycle turns a verified known packaged child report into a stable receipt and reference', () => {
  assert.equal(typeof lifecycle.createPackagedAppActionReceipt, 'function')
  assert.equal(typeof lifecycle.packagedAppActionCheck, 'function')

  const receipt = lifecycle.createPackagedAppActionReceipt(
    packagedInteractionReport(),
    packagedActionContext(),
  )
  assert.deepEqual(receipt.trust, {
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
  })
  assert.equal(receipt.interaction.schema, 'xiaoshe-packaged-ui-interaction/v1')
  assert.equal(receipt.appProcessPid, 4242)
  assert.equal(receipt.runId, ACTION_RUN_ID)
  assert.equal(receipt.acceptanceRunId, ACCEPTANCE_RUN_ID)
  assert.equal(receipt.applicationRole, 'built-distribution')
  assert.equal(receipt.appPath, undefined)
  assert.equal(receipt.executablePath, undefined)
  assert.doesNotMatch(JSON.stringify(receipt), /\/Applications\/小蛇\.app/u)
  assert.equal(receipt.executableSha256, EXECUTABLE_SHA256)
  assert.equal(receipt.sourceCommit, 'b'.repeat(40))
  assert.equal(receipt.sourceSha256, SOURCE_SHA256)
  assert.equal(receipt.materialsSha256, MATERIALS_SHA256)
  assert.equal(receipt.appAsarSha256, APP_ASAR_SHA256)
  assert.equal(receipt.applicationBundleSha256, APPLICATION_BUNDLE_SHA256)
  assert.equal(receipt.productBundleSha256, PRODUCT_BUNDLE_SHA256)
  assert.equal(receipt.packagedDesktopSha256, PACKAGED_DESKTOP_SHA256)
  assert.equal(receipt.packagedRuntimeSha256, PACKAGED_RUNTIME_SHA256)
  assert.equal(receipt.runtimeSha256, MATERIALIZED_RUNTIME_SHA256)
  assert.equal(receipt.challenge, undefined)
  assert.equal(receipt.challengeSha256, createHash('sha256').update(CHALLENGE).digest('hex'))
  assert.deepEqual(receipt.desktopAction, {
    schema: 'xiaoshe-macos-packaged-app-ax-action-receipt/v1',
    collector: 'macos-desktop-bridge',
    targetRole: 'AXTextArea',
    targetPid: 4242,
    clickCompleted: true,
    pressCompleted: true,
    typedCharacters: 25,
    initialSha256: '7'.repeat(64),
    finalSha256: '8'.repeat(64),
    reportSha256: '9'.repeat(64),
  })

  const check = lifecycle.packagedAppActionCheck(receipt)
  assert.equal(check.id, 'real-desktop-action-loop')
  assert.equal(check.state, 'pass')
  assert.deepEqual(check.evidence.receiptReference, {
    schema: 'xiaoshe-macos-packaged-app-action-reference/v1',
    collectorCheckId: 'macos-app-lifecycle',
    receiptSha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),
  })
  assert.equal(check.evidence.receipt, undefined)
})

test('lifecycle refuses to promote packaged DOM facts without an external AX action report', () => {
  assert.throws(
    () => lifecycle.createPackagedAppActionReceipt(
      packagedInteractionReport(),
      packagedActionContext({ desktopAction: undefined }),
    ),
    /external|desktop|AX|action/iu,
  )
})

test('lifecycle rejects an external AX report for another child or challenge', () => {
  for (const report of [
    packagedDesktopActionReport({ targetPid: 9999 }),
    packagedDesktopActionReport({ challenge: '0'.repeat(64) }),
  ]) {
    assert.throws(
      () => lifecycle.createPackagedAppActionReceipt(
        packagedInteractionReport(),
        packagedActionContext({ desktopAction: { report, reportSha256: '9'.repeat(64) } }),
      ),
      /external|desktop|AX|action|challenge|child|pid/iu,
    )
  }
})

test('formal lifecycle drives external AX input against the exact known packaged child', async () => {
  const source = await readFile(new URL('./macos-app-lifecycle.mjs', import.meta.url), 'utf8')
  assert.match(source, /XIAOSHE_DESKTOP_ACCEPTANCE_READY:\s*readyPath/u)
  assert.match(source, /--target-pid[^\n]*String\(interactionProcess\.child\.pid\)/u)
  assert.match(source, /--challenge[^\n]*challenge/u)
  assert.match(source, /--run-id[^\n]*actionRunId/u)
  assert.match(source, /macos-desktop-actions\.py/u)
  assert.match(source, /desktopAction:\s*\{\s*report:/u)
})

for (const [label, mutate, pattern] of [
  ['challenge mismatch', report => ({ ...report, challenge: '0'.repeat(64) }), /challenge/iu],
  ['run mismatch', report => ({ ...report, runId: '33333333-3333-4333-8333-333333333333' }), /run/iu],
  ['child pid mismatch', report => ({ ...report, application: { ...report.application, pid: 9999 } }), /process|pid|child/iu],
  ['executable mismatch', report => ({ ...report, application: { ...report.application, executablePath: '/tmp/fixture' } }), /executable/iu],
  ['bundle id mismatch', report => ({ ...report, application: { ...report.application, bundleId: 'com.example.fixture' } }), /bundle/iu],
  ['unpackaged process', report => ({ ...report, application: { ...report.application, isPackaged: false } }), /packaged/iu],
  ['report before launch', report => ({ ...report, startedAt: '2026-09-05T23:59:30.000Z' }), /time|fresh/iu],
  ['missing UI fact', report => ({ ...report, interaction: { ...report.interaction, modelControlEnabled: false } }), /interaction/iu],
]) {
  test(`lifecycle rejects ${label} from an app interaction report`, () => {
    assert.equal(typeof lifecycle.createPackagedAppActionReceipt, 'function')
    const report = packagedInteractionReport()
    assert.throws(
      () => lifecycle.createPackagedAppActionReceipt(mutate(report), packagedActionContext()),
      pattern,
    )
  })
}

test('lifecycle rejects release or runtime digests that do not match the launched bundle', () => {
  assert.equal(typeof lifecycle.createPackagedAppActionReceipt, 'function')
  assert.throws(
    () => lifecycle.createPackagedAppActionReceipt(
      packagedInteractionReport(),
      packagedActionContext({ executableSha256: '0'.repeat(64) }),
    ),
    /executable|material|digest/iu,
  )
  assert.throws(
    () => lifecycle.createPackagedAppActionReceipt(
      packagedInteractionReport(),
      packagedActionContext({ runtime: { markerSchemaVersion: 3, fingerprintVerified: true, matchesPackagedRuntime: true, fingerprint: 'not-a-digest' } }),
    ),
    /runtime|material|digest/iu,
  )
  assert.throws(
    () => lifecycle.createPackagedAppActionReceipt(
      packagedInteractionReport(),
      packagedActionContext({ releaseSource: { ...packagedActionContext().releaseSource, materialsSha256: 'not-a-digest' } }),
    ),
    /source|material|digest/iu,
  )
  assert.throws(
    () => lifecycle.createPackagedAppActionReceipt(
      packagedInteractionReport(),
      packagedActionContext({
        applicationMaterials: packagedApplicationMaterials({
          artifacts: {
            ...packagedApplicationMaterials().artifacts,
            appAsar: { ...packagedApplicationMaterials().artifacts.appAsar, sha256: '0'.repeat(64) },
          },
        }),
      }),
    ),
    /app\.asar|material|digest/iu,
  )
})

test('lifecycle detects packaged application material changes across the known child run', () => {
  assert.equal(typeof lifecycle.requireSamePackagedApplicationMaterials, 'function')
  const context = packagedActionContext()
  const before = context.applicationMaterials
  const unchanged = structuredClone(before)
  assert.deepEqual(lifecycle.requireSamePackagedApplicationMaterials(context.releaseSource, before, unchanged), unchanged)

  const changed = structuredClone(before)
  changed.artifacts.appAsar.sha256 = '0'.repeat(64)
  assert.throws(
    () => lifecycle.requireSamePackagedApplicationMaterials(context.releaseSource, before, changed),
    /app\.asar|material|changed/iu,
  )
})

test('lifecycle diagnostics retain bounded evidence without persisting captured secrets or user text', () => {
  assert.equal(typeof lifecycle.safeCaptureDiagnostics, 'function')
  const summary = lifecycle.safeCaptureDiagnostics({
    'desktop-log': 'private conversation text',
    'interaction-stderr': 'API_SECRET=super-secret-value',
  })
  assert.match(summary, /desktop-log-bytes=25/u)
  assert.match(summary, /interaction-stderr-sha256=[a-f0-9]{64}/u)
  assert.doesNotMatch(summary, /private conversation|API_SECRET|super-secret-value/u)
})

test('persisted lifecycle evidence allowlists facts and removes local paths and window text', () => {
  assert.equal(typeof lifecycle.contentFreeLifecycleEvidence, 'function')
  const evidence = lifecycle.contentFreeLifecycleEvidence({
    applicationRole: 'built-distribution',
    appPath: '/Users/private-builder/secret-workspace/小蛇.app',
    bundleId: 'com.xiaoshe.desktop',
    bundleExecutable: '小蛇',
    primaryPid: 41,
    secondPid: 42,
    primaryExitCode: 0,
    secondExitCode: 0,
    port: 43180,
    status: { product: '小蛇', version: '0.2.0', bridge: 'ready', platform: 'darwin', secret: 'omit-me' },
    window: { processName: '小蛇', count: 1, title: 'private conversation title' },
    startupEvents: ['boot-started', 'ui-ready'],
    runtime: {
      source: 'per-user-copy',
      materializedUnderUserData: true,
      version: '0.2.0',
      requiredFiles: ['private-user-file'],
      markerSchemaVersion: 3,
      fingerprintVerified: true,
      matchesPackagedRuntime: true,
      fingerprint: MATERIALIZED_RUNTIME_SHA256,
      secret: 'omit-me',
    },
    portReleased: true,
    serviceReleased: true,
    userData: '/var/folders/private-user-data',
    secret: 'omit-me',
  })

  assert.equal(evidence.applicationRole, 'built-distribution')
  assert.deepEqual(evidence.window, { branded: true, count: 1 })
  assert.deepEqual(evidence.status, { product: '小蛇', version: '0.2.0', bridge: 'ready', platform: 'darwin' })
  assert.equal(evidence.runtime.requiredFiles, undefined)
  assert.doesNotMatch(JSON.stringify(evidence), /private-builder|secret-workspace|private conversation|private-user|omit-me/u)
})

test('lifecycle failure evidence stores only a bounded stage, type, size, and digest', () => {
  assert.equal(typeof lifecycle.contentFreeFailureEvidence, 'function')
  const evidence = lifecycle.contentFreeFailureEvidence(
    'packaged-lifecycle',
    new Error('API_SECRET=super-secret-value at /Users/private-builder/workspace'),
  )

  assert.deepEqual(Object.keys(evidence), ['stage', 'errorType', 'diagnosticBytes', 'diagnosticSha256'])
  assert.equal(evidence.stage, 'packaged-lifecycle')
  assert.equal(evidence.errorType, 'Error')
  assert.ok(evidence.diagnosticBytes > 0)
  assert.match(evidence.diagnosticSha256, /^[a-f0-9]{64}$/u)
  assert.doesNotMatch(JSON.stringify(evidence), /API_SECRET|super-secret-value|private-builder/u)
})
