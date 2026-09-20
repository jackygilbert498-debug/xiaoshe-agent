import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertUpdateDisabled, assertWindowsSigningEvidence } from '../../apps/desktop-shell/scripts/verify-artifact.mjs'
import { macosAcceptanceImplementationSha256 } from './macos-acceptance-run.mjs'

const argumentsList = process.argv.slice(2)
const allowPendingExternal = argumentsList.includes('--allow-pending-external')
const allowArchivedRun = argumentsList.includes('--allow-archived-run')
const knownOptions = new Set(['--allow-pending-external', '--allow-archived-run'])
const unknownOptions = argumentsList.filter(value => value.startsWith('--') && !knownOptions.has(value))
if (unknownOptions.length > 0) throw new Error(`unknown option: ${unknownOptions[0]}`)
const paths = argumentsList.filter(value => !value.startsWith('--'))
if (paths.length === 0) throw new Error('provide one or more acceptance report paths')

const verifierRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const currentCommit = execFileSync('git', ['-C', verifierRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim()
const MAX_CURRENT_RUN_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000

const REQUIRED_CHECKS = {
  windows: [
    'desktop-unit-tests', 'release-manifest', 'unpacked-artifact', 'windows-code-signing',
    'product-health', 'embedded-runtime-startup', 'single-instance-and-graceful-quit',
    'windows-install-uninstall', 'desktop-update',
  ],
  macos: [
    'desktop-unit-tests', 'real-desktop-action-loop', 'macos-app-lifecycle', 'macos-signing-and-notarization',
    'macos-install-uninstall', 'release-source-identity', 'desktop-update-policy',
  ],
}

for (const path of paths) {
  // Windows PowerShell 5.1 emits a UTF-8 BOM for `Set-Content -Encoding UTF8`.
  // Accept that standards-compatible transport marker while keeping the JSON
  // schema itself strict and cross-platform.
  const report = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''))
  if (report?.schemaVersion !== 1 || !['windows', 'macos'].includes(report.platform) || !Array.isArray(report.checks)) throw new Error(`${path}: invalid report schema`)
  if (typeof report.commit !== 'string' || !/^[0-9a-f]{40,64}$/iu.test(report.commit)) throw new Error(`${path}: invalid commit identity`)
  if (report.commit.toLowerCase() !== currentCommit.toLowerCase()) throw new Error(`${path}: report commit does not match the current checkout`)
  const runStartedMs = Date.parse(report.runStartedAt ?? '')
  const generatedMs = Date.parse(report.generatedAt ?? '')
  const now = Date.now()
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(report.runId ?? '')
      || !Number.isFinite(runStartedMs) || !Number.isFinite(generatedMs)
      || generatedMs < runStartedMs || generatedMs > now + MAX_CLOCK_SKEW_MS) {
    throw new Error(`${path}: invalid or stale acceptance run identity`)
  }
  if (!allowArchivedRun && now - generatedMs > MAX_CURRENT_RUN_AGE_MS) {
    throw new Error(`${path}: stale acceptance report is not evidence for the current run; use --allow-archived-run only for archival inspection`)
  }
  const ids = new Set(); let failures = 0; let pending = 0
  for (const check of report.checks) {
    if (typeof check?.id !== 'string' || ids.has(check.id) || !['pass', 'fail', 'pending_external'].includes(check.state) || typeof check.detail !== 'string') throw new Error(`${path}: invalid or duplicate check`)
    ids.add(check.id)
    if (check.state === 'fail') failures += 1
    if (check.state === 'pending_external') pending += 1
  }
  for (const required of REQUIRED_CHECKS[report.platform]) {
    if (!ids.has(required)) throw new Error(`${path}: missing ${required}`)
  }
  if (report.platform === 'windows') {
    const releaseCheck = report.checks.find(check => check.id === 'release-manifest')
    if (releaseCheck?.state === 'pass') {
      if (report.workingTreeDirty !== false || releaseCheck.evidence?.sourceCommit !== report.commit) {
        throw new Error(`${path}: passing Windows release requires clean source bound to the report commit`)
      }
    }
    const installCheck = report.checks.find(check => check.id === 'windows-install-uninstall')
    if (installCheck?.state === 'pass') {
      const evidence = installCheck.evidence
      const releaseEvidence = report.checks.find(check => check.id === 'release-manifest')?.evidence
      const unpackedEvidence = report.checks.find(check => check.id === 'unpacked-artifact')?.evidence
      const shortcuts = evidence?.shortcutsCreatedAndRemoved
      const validInstallEvidence = /^[a-f0-9]{64}$/iu.test(evidence?.installerSha256 ?? '')
        && /^[a-f0-9]{64}$/iu.test(evidence?.executableSha256 ?? '')
        && /^[a-f0-9]{64}$/iu.test(releaseEvidence?.sourceSha256 ?? '')
        && evidence.installerSha256 === releaseEvidence?.installerSha256
        && evidence.executableSha256 === releaseEvidence?.executableSha256
        && evidence.executableSha256 === unpackedEvidence?.sha256
        && typeof evidence?.isolatedInstallRoot === 'string'
        && /[\\/]xiaoshe-nsis-acceptance-[a-f0-9]{32}[\\/]installed$/iu.test(evidence.isolatedInstallRoot)
        && evidence.installedLifecycleExitCode === 0
        && evidence.installedRuntimeMaterialized === true
        && evidence.installedVisualProof === true
        && evidence.installedPortReleased === true
        && Array.isArray(shortcuts) && shortcuts.length === 2
        && new Set(shortcuts).size === shortcuts.length
        && shortcuts.every(shortcut => typeof shortcut === 'string' && /\.lnk$/iu.test(shortcut))
        && evidence.uninstallRegistryRemoved === true
        && evidence.installRootRemoved === true
      if (!validInstallEvidence) {
        throw new Error(`${path}: passing Windows install/uninstall requires matching material identity and complete removal evidence`)
      }
    }
    const signingCheck = report.checks.find(check => check.id === 'windows-code-signing')
    if (signingCheck?.state === 'pass') {
      const unpacked = report.checks.find(check => check.id === 'unpacked-artifact')
      if (releaseCheck?.state !== 'pass' || unpacked?.state !== 'pass' || unpacked.evidence?.sha256 !== releaseCheck.evidence?.executableSha256) {
        throw new Error(`${path}: passing Windows signing requires the matching verified source and unpacked artifact`)
      }
      assertWindowsSigningEvidence(signingCheck.evidence, releaseCheck.evidence)
    }
  }
  if (report.platform === 'macos') {
    const currentImplementationSha256 = await macosAcceptanceImplementationSha256(verifierRoot)
    if (report.acceptanceImplementationTrust !== 'current-checkout-content-digest-not-cryptographic-attestation'
        || report.acceptanceImplementationSha256 !== currentImplementationSha256) {
      throw new Error(`${path}: macOS acceptance implementation digest does not match the current checkout`)
    }
    const updateCheck = report.checks.find(check => check.id === 'desktop-update-policy')
    if (updateCheck?.state === 'pass') {
      const configurationPath = 'apps/desktop-shell/electron-builder.yml'
      const configuration = await readFile(resolve(verifierRoot, configurationPath))
      const policy = assertUpdateDisabled(configuration.toString('utf8'))
      const evidence = updateCheck.evidence
      const validUpdatePolicy = evidence?.enabled === policy.enabled
        && evidence?.publish === policy.publish
        && evidence?.configurationPath === configurationPath
        && evidence?.configurationSha256 === createHash('sha256').update(configuration).digest('hex')
      if (!validUpdatePolicy) throw new Error(`${path}: passing macOS update policy must be bound to the current packaging config`)
    }
    const aggregatePermissionCheck = report.checks.find(check => check.id === 'screen-and-accessibility-permissions')
    if (aggregatePermissionCheck !== undefined && aggregatePermissionCheck.state !== 'pending_external') {
      throw new Error(`${path}: aggregate macOS permission placeholder must remain pending_external; passing acceptance requires live evidence`)
    }
    const aggregatePermissions = aggregatePermissionCheck?.state === 'pending_external'
    const livePermissions = ['screen-recording-permission', 'accessibility-permission', 'real-desktop-action-loop']
      .every(id => ids.has(id))
    if (!aggregatePermissions && !livePermissions) throw new Error(`${path}: missing macOS permission and real-action checks`)
    const screenCheck = report.checks.find(check => check.id === 'screen-recording-permission')
    if (screenCheck?.state === 'pass') {
      const logicalSize = screenCheck.evidence?.logicalSize
      if (screenCheck.evidence?.captureSucceeded !== true
          || !Array.isArray(logicalSize) || logicalSize.length !== 2
          || !logicalSize.every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new Error(`${path}: passing screen-recording permission requires content-free native capture evidence`)
      }
    }
    const accessibilityCheck = report.checks.find(check => check.id === 'accessibility-permission')
    if (accessibilityCheck?.state === 'pass' && accessibilityCheck.evidence?.axElementsReadable !== true) {
      throw new Error(`${path}: passing accessibility permission requires content-free AX evidence`)
    }
    const sourceCheck = report.checks.find(check => check.id === 'release-source-identity')
    if (sourceCheck?.state === 'pass') {
      const source = report.releaseSource
      const validSource = source?.schema === 'xiaoshe-macos-release-source/v1'
        && source.state === 'clean' && source.verified === true
        && source.commit === report.commit
        && Number.isSafeInteger(source.files) && source.files > 0
        && /^[a-f0-9]{64}$/u.test(source.sha256 ?? '')
        && /^[a-f0-9]{64}$/u.test(source.materialsSha256 ?? '')
        && source.dmg?.role === 'final-release-dmg'
        && /^[a-f0-9]{64}$/u.test(source.dmg?.sha256 ?? '')
        && Number.isSafeInteger(source.dmg?.bytes) && source.dmg.bytes >= 1_024
      if (report.workingTreeDirty !== false || !validSource) {
        throw new Error(`${path}: passing macOS release requires clean source and verified material identity`)
      }
    }
    const signingCheck = report.checks.find(check => check.id === 'macos-signing-and-notarization')
    if (signingCheck?.state === 'pass') {
      const evidence = signingCheck.evidence
      const signed = evidence?.signedMaterials
      const source = report.releaseSource
      const packaged = source?.packagedApplication
      const validSigning = evidence?.developerId === true
        && evidence.notarizedApp === true
        && evidence.notarizedDmg === true
        && evidence.gatekeeperApp === true
        && evidence.gatekeeperDmg === true
        && signed?.sourceSha256 === source?.sha256
        && signed?.materialsSha256 === source?.materialsSha256
        && signed?.dmgSha256 === source?.dmg?.sha256
        && signed?.executableSha256 === packaged?.artifacts?.executable?.sha256
        && signed?.appAsarSha256 === packaged?.artifacts?.appAsar?.sha256
        && signed?.applicationBundleSha256 === packaged?.artifacts?.applicationBundle?.sha256
        && signed?.productBundleSha256 === packaged?.identities?.bundle?.sha256
        && signed?.desktopSha256 === packaged?.identities?.desktop?.sha256
        && signed?.runtimeSha256 === packaged?.identities?.runtime?.sha256
        && Object.values(signed ?? {}).every(value => /^[a-f0-9]{64}$/u.test(value))
      if (!validSigning) throw new Error(`${path}: passing macOS signing requires native verification bound to the final release materials`)
    }
    const actionCheck = report.checks.find(check => check.id === 'real-desktop-action-loop')
    if (actionCheck?.state === 'pass') {
      const lifecycleCheck = report.checks.find(check => check.id === 'macos-app-lifecycle')
      const lifecycle = lifecycleCheck?.evidence
      const reference = actionCheck.evidence?.receiptReference
      const collection = lifecycle?.packagedAppAction
      const receipt = collection?.receipt
      const packaged = report.releaseSource?.packagedApplication
      const packagedRuntime = packaged?.identities?.runtime
      const packagedBundle = packaged?.identities?.bundle
      const packagedDesktop = packaged?.identities?.desktop
      const packagedAppAsar = packaged?.artifacts?.appAsar
      const applicationBundle = packaged?.artifacts?.applicationBundle
      const packagedExecutable = packaged?.artifacts?.executable
      const receiptSha256 = receipt === undefined
        ? undefined
        : createHash('sha256').update(JSON.stringify(receipt)).digest('hex')
      const trust = receipt?.trust
      const interaction = receipt?.interaction
      const desktopAction = receipt?.desktopAction
      // Release inventory and the per-user runtime marker intentionally use
      // different canonical forms, so bind and validate both digests.
      const validReceipt = reference?.schema === 'xiaoshe-macos-packaged-app-action-reference/v1'
        && reference.collectorCheckId === 'macos-app-lifecycle'
        && /^[a-f0-9]{64}$/u.test(reference.receiptSha256 ?? '')
        && collection?.schema === 'xiaoshe-macos-packaged-app-action-collection/v1'
        && reference.receiptSha256 === collection.receiptSha256
        && reference.receiptSha256 === receiptSha256
        && receipt?.schema === 'xiaoshe-macos-packaged-app-action/v1'
        && receipt.initiator === 'packaged-app'
        && trust?.schema === 'xiaoshe-macos-packaged-app-action-trust/v1'
        && trust.collector === 'macos-app-lifecycle'
        && trust.collection === 'known-child'
        && trust.challengeVerified === true
        && trust.runIdVerified === true
        && trust.childProcessVerified === true
        && trust.executableVerified === true
        && trust.reportTimeVerified === true
        && trust.materialsVerified === true
        && trust.interactionVerified === true
        && trust.desktopActionVerified === true
        && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(receipt.runId ?? '')
        && receipt.acceptanceRunId === report.runId
        && Number.isSafeInteger(receipt.appProcessPid) && receipt.appProcessPid > 0
        && collection.child?.pid === receipt.appProcessPid
        && receipt.applicationRole === 'built-distribution'
        && collection.child?.applicationRole === receipt.applicationRole
        && collection.child?.exitCode === 0
        && receipt.bundleId === 'com.xiaoshe.desktop'
        && receipt.bundleId === lifecycle?.bundleId
        && typeof receipt.bundleExecutable === 'string' && receipt.bundleExecutable !== ''
        && !/[\\/]/u.test(receipt.bundleExecutable)
        && receipt.bundleExecutable === lifecycle?.bundleExecutable
        && collection.child?.bundleExecutable === receipt.bundleExecutable
        && lifecycle?.applicationRole === receipt.applicationRole
        && /^[a-f0-9]{64}$/u.test(receipt.executableSha256 ?? '')
        && receipt.executableSha256 === packagedExecutable?.sha256
        && packagedExecutable?.path === `MacOS/${receipt.bundleExecutable}`
        && receipt.sourceCommit === report.commit
        && receipt.sourceCommit === packaged?.source?.commit
        && /^[a-f0-9]{64}$/u.test(receipt.sourceSha256 ?? '')
        && receipt.sourceSha256 === report.releaseSource?.sha256
        && receipt.sourceSha256 === packaged?.source?.sha256
        && /^[a-f0-9]{64}$/u.test(receipt.materialsSha256 ?? '')
        && receipt.materialsSha256 === report.releaseSource?.materialsSha256
        && /^[a-f0-9]{64}$/u.test(receipt.appAsarSha256 ?? '')
        && receipt.appAsarSha256 === packagedAppAsar?.sha256
        && packagedAppAsar?.path === 'Resources/app.asar'
        && /^[a-f0-9]{64}$/u.test(receipt.applicationBundleSha256 ?? '')
        && receipt.applicationBundleSha256 === applicationBundle?.sha256
        && applicationBundle?.path === '.'
        && Number.isSafeInteger(applicationBundle?.entries) && applicationBundle.entries > 0
        && Number.isSafeInteger(applicationBundle?.files) && applicationBundle.files > 0
        && /^[a-f0-9]{64}$/u.test(receipt.productBundleSha256 ?? '')
        && receipt.productBundleSha256 === packagedBundle?.sha256
        && packagedBundle?.matchesPackaged === true
        && /^[a-f0-9]{64}$/u.test(receipt.packagedDesktopSha256 ?? '')
        && receipt.packagedDesktopSha256 === packagedDesktop?.sha256
        && packagedDesktop?.matchesPackaged === true
        && /^[a-f0-9]{64}$/u.test(receipt.packagedRuntimeSha256 ?? '')
        && receipt.packagedRuntimeSha256 === packagedRuntime?.sha256
        && /^[a-f0-9]{64}$/u.test(receipt.runtimeSha256 ?? '')
        && receipt.runtimeSha256 === lifecycle?.runtime?.fingerprint
        && /^[a-f0-9]{64}$/u.test(receipt.interactionReportSha256 ?? '')
        && /^[a-f0-9]{64}$/u.test(receipt.challengeSha256 ?? '')
        && desktopAction?.schema === 'xiaoshe-macos-packaged-app-ax-action-receipt/v1'
        && desktopAction.collector === 'macos-desktop-bridge'
        && desktopAction.targetRole === 'AXTextArea'
        && desktopAction.targetPid === receipt.appProcessPid
        && desktopAction.clickCompleted === true
        && desktopAction.pressCompleted === true
        && desktopAction.typedCharacters === 25
        && /^[a-f0-9]{64}$/u.test(desktopAction.initialSha256 ?? '')
        && /^[a-f0-9]{64}$/u.test(desktopAction.finalSha256 ?? '')
        && /^[a-f0-9]{64}$/u.test(desktopAction.reportSha256 ?? '')
        && Number.isFinite(Date.parse(receipt.reportStartedAt ?? ''))
        && Number.isFinite(Date.parse(receipt.reportCompletedAt ?? ''))
        && Date.parse(receipt.reportCompletedAt) >= Date.parse(receipt.reportStartedAt)
        && interaction?.schema === 'xiaoshe-packaged-ui-interaction/v1'
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
        && lifecycleCheck?.state === 'pass'
        && lifecycle?.runtime?.markerSchemaVersion === 3
        && lifecycle?.runtime?.fingerprintVerified === true
        && lifecycle?.runtime?.matchesPackagedRuntime === true
        && sourceCheck?.state === 'pass'
        && packaged?.schema === 'xiaoshe-packaged-application-source/v1'
        && packaged?.source?.state === 'clean'
        && packagedRuntime?.matchesPackaged === true
      if (!validReceipt) {
        throw new Error(`${path}: passing macOS real actions require a lifecycle-collected known-child receipt reference with verified trust, interaction, and material identity`)
      }
    }
    const installCheck = report.checks.find(check => check.id === 'macos-install-uninstall')
    if (installCheck?.state === 'pass') {
      const evidence = installCheck.evidence
      const sourceManifest = evidence?.sourceManifest
      const installedManifest = evidence?.installedManifest
      const lifecycle = evidence?.lifecycle
      const applicationBundle = report.releaseSource?.packagedApplication?.artifacts?.applicationBundle
      const validManifest = manifest => /^[a-f0-9]{64}$/u.test(manifest?.digest ?? '')
        && Number.isSafeInteger(manifest?.entries) && manifest.entries > 0
        && Number.isSafeInteger(manifest?.files) && manifest.files > 0
        && Number.isSafeInteger(manifest?.bytes) && manifest.bytes >= 1_024
      const validInstall = /^[a-f0-9]{64}$/u.test(evidence?.dmgSha256 ?? '')
        && evidence.dmgSha256 === report.releaseSource?.dmg?.sha256
        && evidence.dmgRole === 'final-release-dmg'
        && report.releaseSource?.dmg?.role === evidence.dmgRole
        && evidence.mountedApplicationRole === 'dmg-application'
        && evidence.installedApplicationRole === 'installed-application'
        && evidence.installPath === '/Applications/小蛇.app'
        && validManifest(sourceManifest) && validManifest(installedManifest)
        && sourceManifest.digest === applicationBundle?.sha256
        && JSON.stringify(sourceManifest) === JSON.stringify(installedManifest)
        && lifecycle?.applicationRole === evidence.installedApplicationRole
        && lifecycle?.bundleId === 'com.xiaoshe.desktop'
        && lifecycle?.bundleExecutable === '小蛇'
        && lifecycle?.primaryExitCode === 0
        && lifecycle?.secondExitCode === 0
        && lifecycle?.status?.product === '小蛇'
        && typeof lifecycle?.status?.version === 'string' && lifecycle.status.version !== ''
        && lifecycle?.status?.bridge === 'ready'
        && lifecycle?.status?.platform === 'darwin'
        && lifecycle?.runtime?.source === 'per-user-copy'
        && lifecycle?.runtime?.materializedUnderUserData === true
        && lifecycle?.runtime?.version === lifecycle.status.version
        && lifecycle?.runtime?.markerSchemaVersion === 3
        && lifecycle?.runtime?.fingerprintVerified === true
        && lifecycle?.runtime?.matchesPackagedRuntime === true
        && /^[a-f0-9]{64}$/u.test(lifecycle?.runtime?.fingerprint ?? '')
        && lifecycle?.portReleased === true
        && lifecycle?.serviceReleased === true
        && evidence.applicationRemoved === true
        && evidence.mountReleased === true
        && evidence.userDataRetainedAtUninstall === true
        && evidence.userDataPolicy === 'retain'
      if (!validInstall) throw new Error(`${path}: passing macOS install/uninstall requires matching full-bundle, lifecycle, and removal evidence`)
    }
  }

  const passed = report.checks.length - failures - pending
  const status = failures > 0 ? 'FAIL' : pending > 0 ? 'INCOMPLETE' : 'PASS'
  process.stdout.write(`${path}: passed=${passed}/${report.checks.length}, failed=${failures}, pending=${pending}, status=${status}\n`)
  if (failures > 0 || (pending > 0 && !allowPendingExternal)) process.exitCode = 1
}
