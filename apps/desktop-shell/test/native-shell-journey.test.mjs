import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createRequire } from 'node:module'

const testRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testRoot, '../../..')
const clientBuilder = resolve(repositoryRoot, 'packages/native-shell-legacy-adapted/scripts/build-client.mjs')
const journeyRunner = resolve(testRoot, 'run-native-shell-journey.mjs')
const electron = createRequire(import.meta.url)('electron')
// Three viewports capture the fused workbench as well as stable-theme frames. Waiting for the real
// finite animations is intentional; only the opt-in screenshot run needs
// a larger bounded budget, not the ordinary desktop gate.
const screenshotRun = Boolean(process.env.XIAOSHE_NATIVE_SHELL_SCREENSHOT_DIR?.trim())

test('真实 Native Shell 在窄屏与宽屏桌面 viewport 完成无付费模型关键旅程', { timeout: screenshotRun ? 330_000 : 210_000 }, async t => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xiaoshe-native-shell-journey-'))
  t.after(async () => { await rm(temporaryRoot, { recursive: true, force: true }) })

  const clientArtifact = join(temporaryRoot, 'client.js')
  const build = await run(process.execPath, [clientBuilder, '--output', clientArtifact], {
    cwd: repositoryRoot,
    timeoutMs: 30_000,
  })
  assert.equal(build.code, 0, `Native Shell client build failed:\n${build.stderr}\n${build.stdout}`)

  const reportPath = join(temporaryRoot, 'report.json')
  const { materialJourneyEvidence } = await import('../../../packages/runtime-dsh-provider/test/helpers/nested-surfaces.mjs')
  const materialEvidencePath = join(temporaryRoot, 'actual-tool-materials.json')
  await writeFile(materialEvidencePath, JSON.stringify(await materialJourneyEvidence()), 'utf8')
  const electronEnvironment = { ...process.env }
  delete electronEnvironment.ELECTRON_RUN_AS_NODE
  const child = await run(electron, [journeyRunner], {
    cwd: repositoryRoot,
    timeoutMs: screenshotRun ? 300_000 : 180_000,
    env: {
      ...electronEnvironment,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      XIAOSHE_NATIVE_SHELL_CLIENT_ARTIFACT: clientArtifact,
      XIAOSHE_NATIVE_SHELL_JOURNEY_OUTPUT: reportPath,
      XIAOSHE_NATIVE_SHELL_MATERIAL_EVIDENCE: materialEvidencePath,
    },
  })
  const reportText = await readFile(reportPath, 'utf8')
  assert.notEqual(reportText, '', `Electron wrote an empty report:\n${child.stderr}\n${child.stdout}`)
  const report = JSON.parse(reportText)
  if (process.env.XIAOSHE_NATIVE_SHELL_SCREENSHOT_DIR?.trim()) {
    await mkdir(resolve(process.env.XIAOSHE_NATIVE_SHELL_SCREENSHOT_DIR), { recursive: true })
    await writeFile(resolve(process.env.XIAOSHE_NATIVE_SHELL_SCREENSHOT_DIR, 'native-shell-journey-report.json'), reportText, 'utf8')
  }
  assert.equal(child.code, 0, `Electron acceptance failed:\n${child.stderr}\n${child.stdout}`)
  assert.equal(report.schema, 'xiaoshe-native-shell-journey/v1')
  assert.equal(report.accepted, true)
  assert.equal(report.paidModelRequests, 0)
  assert.deepEqual(report.blockedNetworkRequests, [])
  assert.deepEqual(report.viewports.map(({ width, height }) => [width, height]), [[390, 844], [1280, 720], [1440, 900]])
  for (const viewport of report.viewports) {
    assert.equal(viewport.independentReset, true)
    assert.deepEqual(viewport.root, {
      moduleId: '@xiaoshe/native-shell-legacy-adapted',
      registrationId: 'xiaoshe-native-shell-legacy-adapted',
    })
    assert.equal(viewport.paidModelRequests, 0)
    assert.deepEqual(viewport.networkGuard, {
      installed: true,
      blockedRequests: [],
    })
    assert.deepEqual(viewport.consoleErrors, [])
    assert.equal(viewport.queue.mode, 'queue')
    assert.equal(viewport.queue.durableUserEvent, true)
    assert.equal(viewport.steer.mode, 'steer')
    assert.equal(viewport.steer.durableUserEvent, true)
    assert.equal(viewport.stop.stopRunCalls, 1)
    assert.equal(viewport.stop.cancelCalls, 1)
    assert.equal(viewport.failedSend.draftPreserved, true)
    assert.equal(viewport.failedSend.exactStoragePreserved, true)
    assert.equal(viewport.failedSend.hydratedAfterRemount, true)
    assert.equal(viewport.ambiguousSend.draftPreserved, true)
    assert.equal(viewport.ambiguousSend.exactStoragePreserved, true)
    assert.equal(viewport.ambiguousSend.hydratedAfterRemount, true)
    assert.equal(viewport.ambiguousSend.correctFailureSemantics, true)
    assert.equal(viewport.modelControl.triggerVisible, true)
    assert.equal(viewport.modelControl.popoverVisible, true)
    assert.equal(viewport.modelControl.withinViewport, true)
    assert.equal(viewport.modelControl.nativeSelectCount, 0)
    assert.equal(viewport.modelControl.modelCount, 2)
    assert.equal(viewport.modelControl.effortCount, 3)
    assert.equal(viewport.modelControl.selectedModel, 'no-paid-model')
    assert.equal(viewport.modelControl.selectedEffort, 'max')
    assert.match(viewport.modelControl.triggerText, /Fixture Logic.*最大/u)
    assert.equal(viewport.modelControl.selectionCount, 3)
    assert.equal(viewport.modelControl.readiness.matchingRouteSelectable, true)
    assert.equal(viewport.modelControl.readiness.staleRouteIgnored, true)
    assert.equal(viewport.modelControl.readiness.unavailableRouteBlocked, true)
    assert.equal(viewport.modelControl.runningLock.triggerFocusable, true)
    assert.equal(viewport.modelControl.runningLock.reasonDescribed, true)
    assert.equal(viewport.modelControl.runningLock.visibleReason, true)
    assert.equal(viewport.modelControl.runningLock.actionsBlocked, true)
    assert.equal(viewport.modelControl.runningLock.selectionUnchanged, true)
    assert.equal(viewport.layout.clientWidth, viewport.width)
    assert.equal(viewport.layout.clientHeight, viewport.height)
    assert.equal(viewport.layout.composerVisible, true)
    assert.equal(viewport.layout.primaryActionVisible, true)
    assert.equal(viewport.layout.horizontalOverflow, false)
    assert.deepEqual(viewport.taskInteraction, { questionFocus: true, approvalFocus: true, stoppingObserved: true, oldReceiptSuppressed: true })
    assert.deepEqual(viewport.settingsManagement, { draftPreserved: true, projectIsolated: true, forgottenRestored: true, nestedEscape: true, keyboardContained: true })
    assert.deepEqual(viewport.versionDiagnostics, { currentObserved: true, staleAlert: true, legacy404Unknown: true, incomplete200Unknown: true, retryReachable: true })
    assert.deepEqual(viewport.unifiedWorkbench, {
      singleLauncher: true, panelsExclusive: true, taskMaterialsAbsent: true, browserComponentStable: true,
      takeoverAcrossViews: true, approvalAcrossViewsFocused: true, selectedViewRetained: true,
      narrowBrowserNonModal: viewport.width <= 900, narrowBrowserFocusContained: viewport.width <= 900, keyboardViewNavigation: true, noHorizontalOverflow: true,
      resizedModes: viewport.width > 900 ? ['task', 'materials', 'browser'] : [],
    })
    assert.deepEqual(viewport.actualMaterials, { source: 'actual-offline-tools-host-history-provider', genericChatNodes: 0, openedKinds: ['text', 'diff', 'terminal'], passiveArrivalClosed: true, selectionPreserved: true, hiddenRecordsRecovered: true, emptyStateRecovered: true, registryUnchanged: true, closedArrivalStayedClosed: true, fileTooltipsPreserved: true, controls: { closeReachable: true, composerAfterClose: true, composerContained: true, controlGroupsSeparated: true, closedLayoutRestored: true, desktopFitChecked: viewport.width > 900, resizeFitChecked: viewport.width > 900 } })
    assert.deepEqual(viewport.screenshots.map(scene => scene.name), ['empty-light', 'empty-ink-jade', 'settings-memory-light', 'memory-editor-light', 'unified-browser-takeover', 'unified-materials', 'workbench-light', 'workbench-ink-jade', ...(viewport.width === 1280 ? ['materials-passive-ink-jade', 'materials-read-ink-jade'] : [])])
  }
})

test('Electron 验收门会阻止外网请求并拒绝 renderer console.error', { timeout: 105_000 }, async t => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'xiaoshe-native-shell-journey-gates-'))
  t.after(async () => { await rm(temporaryRoot, { recursive: true, force: true }) })

  const builtArtifact = join(temporaryRoot, 'client.js')
  const build = await run(process.execPath, [clientBuilder, '--output', builtArtifact], {
    cwd: repositoryRoot,
    timeoutMs: 30_000,
  })
  assert.equal(build.code, 0, `Native Shell client build failed:\n${build.stderr}\n${build.stdout}`)
  const builtSource = await readFile(builtArtifact, 'utf8')
  const mutations = [
    {
      name: 'network',
      source: `${builtSource}\nvoid fetch('https://model-gate.invalid/v1/acceptance').catch(() => {})\n`,
      expectedFailure: /model-gate\.invalid/u,
      expectedPaidModelRequests: 1,
    },
    {
      name: 'console',
      source: `${builtSource}\nconsole.error('synthetic-native-shell-console-error')\n`,
      expectedFailure: /synthetic-native-shell-console-error/u,
      expectedPaidModelRequests: 0,
    },
  ]
  for (const mutation of mutations) {
    const caseRoot = join(temporaryRoot, mutation.name)
    const artifact = join(caseRoot, 'client.js')
    const reportPath = join(caseRoot, 'report.json')
    await mkdir(caseRoot, { recursive: true })
    await writeFile(artifact, mutation.source, 'utf8')
    const electronEnvironment = { ...process.env }
    delete electronEnvironment.ELECTRON_RUN_AS_NODE
    // Negative gate fixtures must not overwrite the accepted journey images.
    delete electronEnvironment.XIAOSHE_NATIVE_SHELL_SCREENSHOT_DIR
    const child = await run(electron, [journeyRunner], {
      cwd: repositoryRoot,
      timeoutMs: 60_000,
      env: {
        ...electronEnvironment,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        XIAOSHE_NATIVE_SHELL_CLIENT_ARTIFACT: artifact,
        XIAOSHE_NATIVE_SHELL_JOURNEY_OUTPUT: reportPath,
      },
    })
    assert.notEqual(child.code, 0, `${mutation.name} mutation unexpectedly passed acceptance`)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.equal(report.accepted, false)
    assert.equal(report.paidModelRequests, mutation.expectedPaidModelRequests)
    assert.match(report.error, mutation.expectedFailure)
  }
})

function run(command, args, { cwd, env = process.env, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    let timedOut = false
    const timer = setTimeout(async () => {
      timedOut = true
      await terminateProcessTree(child.pid)
      reject(new Error(`Timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}\n${stderr}\n${stdout}`))
    }, timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) return
      resolvePromise({ code, signal, stdout, stderr })
    })
  })
}

function terminateProcessTree(pid) {
  if (!Number.isInteger(pid)) return Promise.resolve()
  if (process.platform === 'win32') {
    return new Promise(resolvePromise => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => resolvePromise())
      killer.once('exit', () => resolvePromise())
    })
  }
  try { process.kill(-pid, 'SIGKILL') } catch {}
  return Promise.resolve()
}
