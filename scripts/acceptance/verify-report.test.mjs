import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { macosAcceptanceImplementationSha256 } from './macos-acceptance-run.mjs'

const execFileAsync = promisify(execFile)
const verifier = resolve('scripts/acceptance/verify-report.mjs')
const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve('.'), encoding: 'utf8' }).trim()
const MACOS_APP_PATH = '/Applications/小蛇.app'
const MACOS_BUNDLE_ID = 'com.xiaoshe.desktop'
const MACOS_BUNDLE_EXECUTABLE = '小蛇'
const MACOS_EXECUTABLE_SHA256 = 'e'.repeat(64)
const MACOS_PACKAGED_RUNTIME_SHA256 = 'f'.repeat(64)
const MACOS_MATERIALIZED_RUNTIME_SHA256 = 'a'.repeat(64)
const MACOS_SOURCE_SHA256 = 'b'.repeat(64)
const MACOS_MATERIALS_SHA256 = 'c'.repeat(64)
const MACOS_APP_ASAR_SHA256 = '3'.repeat(64)
const MACOS_PRODUCT_BUNDLE_SHA256 = '4'.repeat(64)
const MACOS_PACKAGED_DESKTOP_SHA256 = '5'.repeat(64)
const MACOS_APPLICATION_BUNDLE_SHA256 = '6'.repeat(64)
const MACOS_RUN_ID = '11111111-1111-4111-8111-111111111111'
const MACOS_ACTION_RUN_ID = '22222222-2222-4222-8222-222222222222'
const MACOS_ACTION_PID = 4242
const MACOS_EXECUTABLE_PATH = `${MACOS_APP_PATH}/Contents/MacOS/${MACOS_BUNDLE_EXECUTABLE}`
const ELECTRON_BUILDER_PATH = 'apps/desktop-shell/electron-builder.yml'
const ELECTRON_BUILDER_SHA256 = createHash('sha256')
  .update(await readFile(resolve(ELECTRON_BUILDER_PATH)))
  .digest('hex')
const MACOS_ACCEPTANCE_IMPLEMENTATION_SHA256 = await macosAcceptanceImplementationSha256(resolve('.'))

const WINDOWS_IDS = [
  'desktop-unit-tests', 'release-manifest', 'unpacked-artifact', 'windows-code-signing',
  'product-health', 'embedded-runtime-startup', 'single-instance-and-graceful-quit',
  'windows-install-uninstall', 'desktop-update',
]
const MACOS_IDS = [
  'desktop-unit-tests', 'screen-recording-permission', 'accessibility-permission',
  'real-desktop-action-loop', 'macos-app-lifecycle', 'macos-signing-and-notarization',
  'macos-install-uninstall', 'release-source-identity', 'desktop-update-policy',
]

function macosActionReceipt(overrides = {}) {
  return {
    schema: 'xiaoshe-macos-packaged-app-action/v1',
    initiator: 'packaged-app',
    trust: {
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
    },
    runId: MACOS_ACTION_RUN_ID,
    acceptanceRunId: MACOS_RUN_ID,
    appProcessPid: MACOS_ACTION_PID,
    applicationRole: 'built-distribution',
    bundleId: MACOS_BUNDLE_ID,
    bundleExecutable: MACOS_BUNDLE_EXECUTABLE,
    executableSha256: MACOS_EXECUTABLE_SHA256,
    sourceCommit: currentCommit,
    sourceSha256: MACOS_SOURCE_SHA256,
    materialsSha256: MACOS_MATERIALS_SHA256,
    appAsarSha256: MACOS_APP_ASAR_SHA256,
    applicationBundleSha256: MACOS_APPLICATION_BUNDLE_SHA256,
    productBundleSha256: MACOS_PRODUCT_BUNDLE_SHA256,
    packagedDesktopSha256: MACOS_PACKAGED_DESKTOP_SHA256,
    packagedRuntimeSha256: MACOS_PACKAGED_RUNTIME_SHA256,
    runtimeSha256: MACOS_MATERIALIZED_RUNTIME_SHA256,
    interactionReportSha256: 'd'.repeat(64),
    challengeSha256: 'c'.repeat(64),
    reportStartedAt: '2026-09-06T00:00:01.000Z',
    reportCompletedAt: '2026-09-06T00:00:08.000Z',
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
    desktopAction: {
      schema: 'xiaoshe-macos-packaged-app-ax-action-receipt/v1',
      collector: 'macos-desktop-bridge',
      targetRole: 'AXTextArea',
      targetPid: MACOS_ACTION_PID,
      clickCompleted: true,
      pressCompleted: true,
      typedCharacters: 25,
      initialSha256: '7'.repeat(64),
      finalSha256: '8'.repeat(64),
      reportSha256: '9'.repeat(64),
    },
    ...overrides,
  }
}

function macosActionCollection(receipt = macosActionReceipt()) {
  const receiptSha256 = createHash('sha256').update(JSON.stringify(receipt)).digest('hex')
  return {
    schema: 'xiaoshe-macos-packaged-app-action-collection/v1',
    child: {
      pid: MACOS_ACTION_PID,
      applicationRole: 'built-distribution',
      bundleExecutable: MACOS_BUNDLE_EXECUTABLE,
      exitCode: 0,
    },
    receipt,
    receiptSha256,
  }
}

function macosActionReference(receipt = macosActionReceipt()) {
  return {
    schema: 'xiaoshe-macos-packaged-app-action-reference/v1',
    collectorCheckId: 'macos-app-lifecycle',
    receiptSha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),
  }
}

function reportCheck(platform, id, state = 'pass') {
  let evidence
  if (platform === 'windows' && id === 'release-manifest') {
    evidence = { installerSha256: '1'.repeat(64), executableSha256: '2'.repeat(64), sourceSha256: '3'.repeat(64), sourceCommit: currentCommit }
  } else if (platform === 'windows' && id === 'unpacked-artifact') {
    evidence = { sha256: '2'.repeat(64), bytes: 4096 }
  } else if (platform === 'windows' && id === 'windows-code-signing') {
    const facts = { executable: { sha256: '2'.repeat(64), kind: 'authenticode', state: 'valid', nativeStatus: 'Valid', signerCertificateSha256: '4'.repeat(64) },
      installer: { sha256: '1'.repeat(64), kind: 'authenticode', state: 'valid', nativeStatus: 'Valid', signerCertificateSha256: '4'.repeat(64) } }
    evidence = { schema: 'xiaoshe-windows-signing/v1', platform: 'win32', collector: 'Get-AuthenticodeSignature', sourceCommit: currentCommit,
      sourceSha256: '3'.repeat(64), original: facts, rechecked: structuredClone(facts) }
  } else if (platform === 'windows' && id === 'windows-install-uninstall') {
    evidence = {
      installerSha256: '1'.repeat(64), executableSha256: '2'.repeat(64),
      isolatedInstallRoot: `C:\\Temp\\xiaoshe-nsis-acceptance-${'a'.repeat(32)}\\installed`,
      installedLifecycleExitCode: 0, installedRuntimeMaterialized: true, installedVisualProof: true, installedPortReleased: true,
      shortcutsCreatedAndRemoved: [
        'C:\\Users\\tester\\Desktop\\小蛇.lnk',
        'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\小蛇.lnk',
      ],
      uninstallRegistryRemoved: true,
      installRootRemoved: true,
    }
  } else if (platform === 'macos' && id === 'real-desktop-action-loop') {
    evidence = { receiptReference: macosActionReference() }
  } else if (platform === 'macos' && id === 'screen-recording-permission') {
    evidence = { captureSucceeded: true, logicalSize: [1440, 900] }
  } else if (platform === 'macos' && id === 'accessibility-permission') {
    evidence = { axElementsReadable: true }
  } else if (platform === 'macos' && id === 'macos-app-lifecycle') {
    evidence = {
      applicationRole: 'built-distribution',
      bundleId: MACOS_BUNDLE_ID,
      bundleExecutable: MACOS_BUNDLE_EXECUTABLE,
      runtime: { markerSchemaVersion: 3, fingerprintVerified: true, matchesPackagedRuntime: true, fingerprint: MACOS_MATERIALIZED_RUNTIME_SHA256 },
      packagedAppAction: macosActionCollection(),
    }
  } else if (platform === 'macos' && id === 'macos-signing-and-notarization') {
    evidence = {
      developerId: true,
      notarizedApp: true,
      notarizedDmg: true,
      gatekeeperApp: true,
      gatekeeperDmg: true,
      signedMaterials: {
        sourceSha256: MACOS_SOURCE_SHA256,
        materialsSha256: MACOS_MATERIALS_SHA256,
        dmgSha256: 'd'.repeat(64),
        executableSha256: MACOS_EXECUTABLE_SHA256,
        appAsarSha256: MACOS_APP_ASAR_SHA256,
        applicationBundleSha256: MACOS_APPLICATION_BUNDLE_SHA256,
        productBundleSha256: MACOS_PRODUCT_BUNDLE_SHA256,
        desktopSha256: MACOS_PACKAGED_DESKTOP_SHA256,
        runtimeSha256: MACOS_PACKAGED_RUNTIME_SHA256,
      },
    }
  } else if (platform === 'macos' && id === 'macos-install-uninstall') {
    const manifest = { digest: MACOS_APPLICATION_BUNDLE_SHA256, entries: 20, files: 14, bytes: 32768 }
    evidence = {
      dmgRole: 'final-release-dmg',
      dmgSha256: 'd'.repeat(64),
      mountedApplicationRole: 'dmg-application',
      installedApplicationRole: 'installed-application',
      installPath: MACOS_APP_PATH,
      sourceManifest: { ...manifest },
      installedManifest: { ...manifest },
      lifecycle: {
        applicationRole: 'installed-application',
        bundleId: MACOS_BUNDLE_ID,
        bundleExecutable: MACOS_BUNDLE_EXECUTABLE,
        primaryExitCode: 0,
        secondExitCode: 0,
        portReleased: true,
        serviceReleased: true,
        status: { product: '小蛇', version: '0.2.0', bridge: 'ready', platform: 'darwin' },
        runtime: {
          source: 'per-user-copy',
          materializedUnderUserData: true,
          version: '0.2.0',
          markerSchemaVersion: 3,
          fingerprintVerified: true,
          matchesPackagedRuntime: true,
          fingerprint: MACOS_MATERIALIZED_RUNTIME_SHA256,
        },
      },
      applicationRemoved: true,
      mountReleased: true,
      userDataRetainedAtUninstall: true,
      userDataPolicy: 'retain',
    }
  } else if (platform === 'macos' && id === 'desktop-update-policy') {
    evidence = {
      enabled: false,
      publish: null,
      configurationPath: ELECTRON_BUILDER_PATH,
      configurationSha256: ELECTRON_BUILDER_SHA256,
    }
  }
  return { id, state, detail: `${id} evidence`, ...(evidence === undefined ? {} : { evidence }) }
}

async function runReport(platform, ids, states = {}, options = [], overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-report-verifier-'))
  const path = join(directory, `${platform}.json`)
  const generatedAt = new Date().toISOString()
  const runStartedAt = new Date(Date.parse(generatedAt) - 1_000).toISOString()
  try {
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      platform,
      generatedAt,
      runId: MACOS_RUN_ID,
      runStartedAt,
      commit: currentCommit,
      workingTreeDirty: false,
      ...(platform === 'macos' ? {
        acceptanceImplementationSha256: MACOS_ACCEPTANCE_IMPLEMENTATION_SHA256,
        acceptanceImplementationTrust: 'current-checkout-content-digest-not-cryptographic-attestation',
        releaseSource: {
          schema: 'xiaoshe-macos-release-source/v1', state: 'clean', verified: true,
          commit: currentCommit, files: 42, sha256: MACOS_SOURCE_SHA256,
          materialsSha256: MACOS_MATERIALS_SHA256, dmg: { role: 'final-release-dmg', sha256: 'd'.repeat(64), bytes: 4096 },
          packagedApplication: {
            schema: 'xiaoshe-packaged-application-source/v1',
            source: { state: 'clean', commit: currentCommit, files: 42, sha256: MACOS_SOURCE_SHA256 },
            identities: {
              runtime: { files: 42, sha256: MACOS_PACKAGED_RUNTIME_SHA256, matchesPackaged: true },
              bundle: { files: 6, sha256: MACOS_PRODUCT_BUNDLE_SHA256, matchesPackaged: true },
              desktop: { files: 12, sha256: MACOS_PACKAGED_DESKTOP_SHA256, matchesPackaged: true },
            },
            artifacts: {
              appAsar: { path: 'Resources/app.asar', bytes: 4096, sha256: MACOS_APP_ASAR_SHA256 },
              executable: { path: `MacOS/${MACOS_BUNDLE_EXECUTABLE}`, bytes: 4096, sha256: MACOS_EXECUTABLE_SHA256 },
              applicationBundle: { path: '.', entries: 20, files: 14, bytes: 32768, sha256: MACOS_APPLICATION_BUNDLE_SHA256 },
            },
          },
        },
      } : {}),
      checks: ids.map(id => reportCheck(platform, id, states[id] ?? 'pass')),
      ...overrides,
    })}\n`)
    return await execFileAsync(process.execPath, [verifier, ...options, path], { windowsHide: true })
      .then(result => ({ code: 0, stdout: result.stdout, stderr: result.stderr }))
      .catch(error => ({ code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('complete Windows report still passes when every required check passes', async () => {
  const windows = await runReport('windows', WINDOWS_IDS)
  assert.equal(windows.code, 0, windows.stderr)
  assert.match(windows.stdout, /status=PASS/u)
})

test('Windows report cannot pass with only the app signature or an unbound installer recheck', async () => {
  for (const change of [
    e => { delete e.original.installer }, e => { delete e.rechecked.installer },
    e => { e.rechecked.installer.nativeStatus = 'NotSigned' },
    e => { e.rechecked.installer.state = 'unsigned' },
    e => { e.original.installer.sha256 = '9'.repeat(64) },
    e => { e.rechecked.installer.sha256 = e.rechecked.executable.sha256 },
    e => { e.rechecked.installer.signerCertificateSha256 = '8'.repeat(64) },
    e => { e.original.installer.signerCertificateSha256 = e.rechecked.installer.signerCertificateSha256 = '8'.repeat(64) },
    e => { e.sourceSha256 = '7'.repeat(64) }, e => { e.platform = 'darwin' },
  ]) {
    const checks = WINDOWS_IDS.map(id => reportCheck('windows', id))
    change(checks.find(row => row.id === 'windows-code-signing').evidence)
    const result = await runReport('windows', WINDOWS_IDS, {}, [], { checks })
    assert.notEqual(result.code, 0); assert.match(result.stderr, /Windows signing/u)
  }
})

test('pending external is incomplete by default and never printed as PASS', async () => {
  const result = await runReport('windows', WINDOWS_IDS, { 'windows-code-signing': 'pending_external' })
  assert.equal(result.code, 1)
  assert.match(result.stdout, /status=INCOMPLETE/u)
  assert.doesNotMatch(result.stdout, /status=PASS/u)
})

test('explicit pending waiver remains visibly incomplete while allowing a diagnostic run', async () => {
  const result = await runReport('macos', MACOS_IDS, {
    'real-desktop-action-loop': 'pending_external',
    'macos-signing-and-notarization': 'pending_external',
  }, ['--allow-pending-external'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /status=INCOMPLETE/u)
  assert.doesNotMatch(result.stdout, /status=PASS/u)
})

test('macOS accepts a lifecycle-collected receipt from the known final packaged child', async () => {
  const result = await runReport('macos', MACOS_IDS)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /status=PASS/u)
})

test('macOS rejects lifecycle receipts without a verified external AX action against that child', async () => {
  for (const receipt of [
    macosActionReceipt({ desktopAction: undefined }),
    macosActionReceipt({ trust: { ...macosActionReceipt().trust, desktopActionVerified: false } }),
    macosActionReceipt({ desktopAction: { ...macosActionReceipt().desktopAction, targetPid: MACOS_ACTION_PID + 1 } }),
  ]) {
    const checks = MACOS_IDS.map(id => {
      if (id === 'real-desktop-action-loop') {
        return { ...reportCheck('macos', id), evidence: { receiptReference: macosActionReference(receipt) } }
      }
      if (id === 'macos-app-lifecycle') {
        return { ...reportCheck('macos', id), evidence: { ...reportCheck('macos', id).evidence, packagedAppAction: macosActionCollection(receipt) } }
      }
      return reportCheck('macos', id)
    })
    const result = await runReport('macos', MACOS_IDS, {}, [], { checks })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /desktop|AX|action|known-child|receipt/iu)
  }
})

test('macOS cannot pass with a claimed update policy that is not bound to the current packaging config', async () => {
  const checks = MACOS_IDS.map(id => id === 'desktop-update-policy'
    ? { ...reportCheck('macos', id), evidence: { publish: null } }
    : reportCheck('macos', id))
  const result = await runReport('macos', MACOS_IDS, {}, [], { checks })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /update policy|packaging config/iu)
})

test('macOS verifier recomputes the current checkout acceptance implementation digest', async () => {
  const forged = await runReport('macos', MACOS_IDS, {}, [], {
    acceptanceImplementationSha256: '0'.repeat(64),
  })
  assert.notEqual(forged.code, 0)
  assert.match(forged.stderr, /implementation|checkout|digest/iu)
})

test('macOS fixture actions remain pending_external and never satisfy packaged-app acceptance', async () => {
  const checks = MACOS_IDS.map(id => id === 'real-desktop-action-loop'
    ? { ...reportCheck('macos', id, 'pending_external'), evidence: { probe: 'swift-fixture' } }
    : reportCheck('macos', id))
  const result = await runReport('macos', MACOS_IDS, {}, ['--allow-pending-external'], { checks })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /status=INCOMPLETE/u)
  assert.doesNotMatch(result.stdout, /status=PASS/u)
})

test('macOS fixture evidence cannot claim pass without a packaged-app receipt', async () => {
  const checks = MACOS_IDS.map(id => id === 'real-desktop-action-loop'
    ? { ...reportCheck('macos', id), evidence: { probe: 'swift-fixture' } }
    : reportCheck('macos', id))
  const result = await runReport('macos', MACOS_IDS, {}, ['--allow-pending-external'], { checks })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /packaged.app.*receipt|receipt.*identity/iu)
})

test('macOS aggregate permission evidence cannot replace the final packaged-app action check', async () => {
  const ids = [
    ...MACOS_IDS.filter(id => !['screen-recording-permission', 'accessibility-permission', 'real-desktop-action-loop'].includes(id)),
    'screen-and-accessibility-permissions',
  ]
  const result = await runReport('macos', ids)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /missing real-desktop-action-loop/u)
})

test('macOS aggregate permission placeholder can only remain pending and cannot replace live permission evidence', async () => {
  const ids = [
    ...MACOS_IDS.filter(id => !['screen-recording-permission', 'accessibility-permission'].includes(id)),
    'screen-and-accessibility-permissions',
  ]
  const checks = ids.map(id => reportCheck('macos', id))
  const result = await runReport('macos', ids, {}, [], { checks })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /permission|pending|live/iu)
})

test('macOS rejects a direct self-reported receipt that bypasses the lifecycle collector', async () => {
  const checks = MACOS_IDS.map(id => id === 'real-desktop-action-loop'
    ? { ...reportCheck('macos', id), evidence: { receipt: macosActionReceipt() } }
    : reportCheck('macos', id))
  const result = await runReport('macos', MACOS_IDS, {}, [], { checks })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /lifecycle|collector|reference|self.report/iu)
})

test('macOS rejects a forged lifecycle trust marker or broken receipt reference', async () => {
  const untrustedReceipt = macosActionReceipt({
    trust: { ...macosActionReceipt().trust, challengeVerified: false },
  })
  const untrustedChecks = MACOS_IDS.map(id => {
    if (id === 'real-desktop-action-loop') {
      return { ...reportCheck('macos', id), evidence: { receiptReference: macosActionReference(untrustedReceipt) } }
    }
    if (id === 'macos-app-lifecycle') {
      return { ...reportCheck('macos', id), evidence: { ...reportCheck('macos', id).evidence, packagedAppAction: macosActionCollection(untrustedReceipt) } }
    }
    return reportCheck('macos', id)
  })
  const untrusted = await runReport('macos', MACOS_IDS, {}, [], { checks: untrustedChecks })
  assert.notEqual(untrusted.code, 0)
  assert.match(untrusted.stderr, /trust|challenge|collector/iu)

  const brokenChecks = MACOS_IDS.map(id => id === 'real-desktop-action-loop'
    ? {
        ...reportCheck('macos', id),
        evidence: { receiptReference: { ...macosActionReference(), receiptSha256: '0'.repeat(64) } },
      }
    : reportCheck('macos', id))
  const broken = await runReport('macos', MACOS_IDS, {}, [], { checks: brokenChecks })
  assert.notEqual(broken.code, 0)
  assert.match(broken.stderr, /receipt|reference|digest/iu)
})

test('macOS rejects a lifecycle receipt that is not bound to final source, app.asar, desktop, and bundle digests', async () => {
  for (const override of [
    { sourceSha256: '0'.repeat(64) },
    { materialsSha256: '0'.repeat(64) },
    { appAsarSha256: '0'.repeat(64) },
    { applicationBundleSha256: '0'.repeat(64) },
    { productBundleSha256: '0'.repeat(64) },
    { packagedDesktopSha256: '0'.repeat(64) },
    { applicationRole: 'installed-application' },
  ]) {
    const receipt = macosActionReceipt(override)
    const checks = MACOS_IDS.map(id => {
      if (id === 'real-desktop-action-loop') {
        return { ...reportCheck('macos', id), evidence: { receiptReference: macosActionReference(receipt) } }
      }
      if (id === 'macos-app-lifecycle') {
        return { ...reportCheck('macos', id), evidence: { ...reportCheck('macos', id).evidence, packagedAppAction: macosActionCollection(receipt) } }
      }
      return reportCheck('macos', id)
    })
    const result = await runReport('macos', MACOS_IDS, {}, [], { checks })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /receipt|material|identity|digest/iu)
  }
})

test('macOS permission and signing passes require content-free native evidence bound to final materials', async () => {
  const invalidEvidence = [
    ['screen-recording-permission', { captureSucceeded: true, logicalSize: [0, 900] }],
    ['accessibility-permission', { axElementsReadable: false }],
    ['macos-signing-and-notarization', {
      ...reportCheck('macos', 'macos-signing-and-notarization').evidence,
      gatekeeperDmg: false,
    }],
    ['macos-signing-and-notarization', {
      ...reportCheck('macos', 'macos-signing-and-notarization').evidence,
      signedMaterials: {
        ...reportCheck('macos', 'macos-signing-and-notarization').evidence.signedMaterials,
        applicationBundleSha256: '0'.repeat(64),
      },
    }],
  ]
  for (const [id, evidence] of invalidEvidence) {
    const checks = MACOS_IDS.map(checkId => checkId === id
      ? { ...reportCheck('macos', checkId), evidence }
      : reportCheck('macos', checkId))
    const result = await runReport('macos', MACOS_IDS, {}, [], { checks })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /permission|screen|accessibility|sign|material|evidence/iu)
  }
})

test('macOS install pass requires complete lifecycle, removal, and identical full-bundle evidence', async () => {
  const valid = reportCheck('macos', 'macos-install-uninstall').evidence
  const invalidEvidence = [
    { ...valid, applicationRemoved: false },
    { ...valid, mountReleased: false },
    { ...valid, userDataRetainedAtUninstall: false },
    { ...valid, installedApplicationRole: 'built-distribution' },
    { ...valid, lifecycle: { ...valid.lifecycle, applicationRole: 'built-distribution' } },
    { ...valid, lifecycle: { ...valid.lifecycle, portReleased: false } },
    { ...valid, lifecycle: { ...valid.lifecycle, runtime: { ...valid.lifecycle.runtime, source: 'explicit-override' } } },
    { ...valid, lifecycle: { ...valid.lifecycle, runtime: { ...valid.lifecycle.runtime, materializedUnderUserData: false } } },
    { ...valid, lifecycle: { ...valid.lifecycle, runtime: { ...valid.lifecycle.runtime, version: 'stale-version' } } },
    { ...valid, lifecycle: { ...valid.lifecycle, runtime: { ...valid.lifecycle.runtime, fingerprint: 'not-a-digest' } } },
    { ...valid, installedManifest: { ...valid.installedManifest, digest: '0'.repeat(64) } },
  ]
  for (const evidence of invalidEvidence) {
    const checks = MACOS_IDS.map(id => id === 'macos-install-uninstall'
      ? { ...reportCheck('macos', id), evidence }
      : reportCheck('macos', id))
    const result = await runReport('macos', MACOS_IDS, {}, [], { checks })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /install|uninstall|bundle|lifecycle|evidence|material/iu)
  }
})

test('missing required checks and explicit failures fail closed', async () => {
  const missing = await runReport('windows', WINDOWS_IDS.filter(id => id !== 'product-health'))
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /missing product-health/u)

  const failed = await runReport('macos', MACOS_IDS, { 'real-desktop-action-loop': 'fail' }, ['--allow-pending-external'])
  assert.equal(failed.code, 1)
  assert.match(failed.stdout, /status=FAIL/u)
})

test('Windows cannot pass without a real NSIS install and uninstall check', async () => {
  const missing = await runReport('windows', WINDOWS_IDS.filter(id => id !== 'windows-install-uninstall'))
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /missing windows-install-uninstall/u)

  const missingEvidence = await runReport('windows', WINDOWS_IDS, {}, [], {
    checks: WINDOWS_IDS.map(id => ({
      id,
      state: 'pass',
      detail: `${id} evidence`,
      ...(id === 'release-manifest' ? {
        evidence: { installerSha256: '1'.repeat(64), executableSha256: '2'.repeat(64), sourceSha256: '3'.repeat(64), sourceCommit: currentCommit },
      } : {}),
      ...(id === 'unpacked-artifact' ? { evidence: { sha256: '2'.repeat(64), bytes: 4096 } } : {}),
    })),
  })
  assert.notEqual(missingEvidence.code, 0)
  assert.match(missingEvidence.stderr, /install.*uninstall.*evidence/iu)

  const incompleteEvidence = await runReport('windows', WINDOWS_IDS, {}, [], {
    checks: WINDOWS_IDS.map(id => ({
      id,
      state: 'pass',
      detail: `${id} evidence`,
      ...(id === 'release-manifest' ? {
        evidence: { installerSha256: '1'.repeat(64), executableSha256: '2'.repeat(64), sourceSha256: '3'.repeat(64), sourceCommit: currentCommit },
      } : {}),
      ...(id === 'unpacked-artifact' ? { evidence: { sha256: '2'.repeat(64), bytes: 4096 } } : {}),
      ...(id === 'windows-install-uninstall' ? {
        evidence: {
          installerSha256: '1'.repeat(64), executableSha256: '2'.repeat(64),
          isolatedInstallRoot: `C:\\Temp\\xiaoshe-nsis-acceptance-${'a'.repeat(32)}\\installed`,
          installedLifecycleExitCode: 0, installedRuntimeMaterialized: true, installedVisualProof: true, installedPortReleased: true,
          shortcutsCreatedAndRemoved: ['C:\\Users\\tester\\Desktop\\小蛇.lnk'],
          uninstallRegistryRemoved: false,
          installRootRemoved: true,
        },
      } : {}),
    })),
  })
  assert.notEqual(incompleteEvidence.code, 0)
  assert.match(incompleteEvidence.stderr, /install.*uninstall.*evidence/iu)

  const mismatchedMaterials = await runReport('windows', WINDOWS_IDS, {}, [], {
    checks: WINDOWS_IDS.map(id => ({
      id,
      state: 'pass',
      detail: `${id} evidence`,
      ...(id === 'release-manifest' ? {
        evidence: { installerSha256: '1'.repeat(64), executableSha256: '2'.repeat(64), sourceSha256: '3'.repeat(64), sourceCommit: currentCommit },
      } : {}),
      ...(id === 'unpacked-artifact' ? { evidence: { sha256: '2'.repeat(64), bytes: 4096 } } : {}),
      ...(id === 'windows-install-uninstall' ? {
        evidence: {
          installerSha256: '4'.repeat(64), executableSha256: '5'.repeat(64),
          isolatedInstallRoot: `C:\\Temp\\xiaoshe-nsis-acceptance-${'a'.repeat(32)}\\installed`,
          installedLifecycleExitCode: 0, installedRuntimeMaterialized: true, installedVisualProof: true, installedPortReleased: true,
          shortcutsCreatedAndRemoved: [
            'C:\\Users\\tester\\Desktop\\小蛇.lnk',
            'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\小蛇.lnk',
          ],
          uninstallRegistryRemoved: true,
          installRootRemoved: true,
        },
      } : {}),
    })),
  })
  assert.notEqual(mismatchedMaterials.code, 0)
  assert.match(mismatchedMaterials.stderr, /material.*identity|digest.*match/iu)
})

test('macOS cannot pass without a clean verified source and material identity', async () => {
  const missing = await runReport('macos', MACOS_IDS.filter(id => id !== 'release-source-identity'))
  assert.notEqual(missing.code, 0)
  assert.match(missing.stderr, /missing release-source-identity/u)

  const dirty = await runReport('macos', MACOS_IDS, {}, [], { workingTreeDirty: true })
  assert.notEqual(dirty.code, 0)
  assert.match(dirty.stderr, /clean source|dirty/iu)

  const wrongMaterial = await runReport('macos', MACOS_IDS, {}, [], {
    releaseSource: {
      schema: 'xiaoshe-macos-release-source/v1', state: 'clean', verified: true,
      commit: currentCommit, files: 42, sha256: 'b'.repeat(64),
      materialsSha256: 'not-a-digest', dmg: { sha256: 'd'.repeat(64), bytes: 4096 },
    },
  })
  assert.notEqual(wrongMaterial.code, 0)
  assert.match(wrongMaterial.stderr, /source|material/iu)
})

test('macOS passing install evidence must identify the same final DMG as the clean release source', async () => {
  const mismatched = await runReport('macos', MACOS_IDS, {}, [], {
    checks: MACOS_IDS.map(id => {
      if (id === 'real-desktop-action-loop') return reportCheck('macos', id, 'pending_external')
      if (id === 'macos-install-uninstall') return { ...reportCheck('macos', id), evidence: { dmgSha256: '0'.repeat(64) } }
      return reportCheck('macos', id)
    }),
  })
  assert.notEqual(mismatched.code, 0)
  assert.match(mismatched.stderr, /DMG|material|install/iu)
})

test('macOS verifier rejects aggregate evidence without current-run identity', async () => {
  const missingRun = await runReport('macos', MACOS_IDS, {}, [], { runId: undefined })
  assert.notEqual(missingRun.code, 0)
  assert.match(missingRun.stderr, /run|identity/iu)

  const impossibleChronology = await runReport('macos', MACOS_IDS, {}, [], {
    generatedAt: '2026-09-06T00:00:00.000Z',
    runStartedAt: '2026-09-06T00:00:01.000Z',
  })
  assert.notEqual(impossibleChronology.code, 0)
  assert.match(impossibleChronology.stderr, /run|time|fresh/iu)
})

test('reports are bound to the current checkout commit', async () => {
  const wrongCommit = currentCommit.startsWith('a') ? 'b'.repeat(currentCommit.length) : 'a'.repeat(currentCommit.length)
  const result = await runReport('windows', WINDOWS_IDS, {}, [], { commit: wrongCommit })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /commit|checkout|source/iu)
})

test('Windows passing evidence requires current-run identity and clean source', async () => {
  const missingRun = await runReport('windows', WINDOWS_IDS, {}, [], { runId: undefined })
  assert.notEqual(missingRun.code, 0)
  assert.match(missingRun.stderr, /run|identity/iu)

  const impossibleChronology = await runReport('windows', WINDOWS_IDS, {}, [], {
    generatedAt: '2026-09-06T00:00:00.000Z',
    runStartedAt: '2026-09-06T00:00:01.000Z',
  })
  assert.notEqual(impossibleChronology.code, 0)
  assert.match(impossibleChronology.stderr, /run|time|fresh/iu)

  const dirty = await runReport('windows', WINDOWS_IDS, {}, [], { workingTreeDirty: true })
  assert.notEqual(dirty.code, 0)
  assert.match(dirty.stderr, /clean source|dirty/iu)
})

test('stale reports require an explicit archival acknowledgement', async () => {
  const stale = {
    generatedAt: '2020-01-01T00:00:01.000Z',
    runStartedAt: '2020-01-01T00:00:00.000Z',
  }
  const rejected = await runReport('windows', WINDOWS_IDS, {}, [], stale)
  assert.notEqual(rejected.code, 0)
  assert.match(rejected.stderr, /stale|current run|fresh/iu)

  const archived = await runReport('windows', WINDOWS_IDS, {}, ['--allow-archived-run'], stale)
  assert.equal(archived.code, 0, archived.stderr)
  assert.match(archived.stdout, /status=PASS/u)
})
