import { redactDesktopLogin } from './desktop-login.mjs'
import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, screen, session, clipboard, ClipboardItem, dialog } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acceptanceUserDataPath } from './acceptance-isolation.mjs'
import { ProductServiceController, acceptanceQuitDelay, loadProductPage, prepareProductRoot, productRootOverride, rendererExitAction, rendererProbePassed, shutdownOwnedProduct } from './lifecycle.mjs'
import { configureAcceptanceRpc, interactionAcceptanceRequested, runInteractionAcceptance } from './interaction-acceptance.mjs'
import { lifecycleAcceptanceConfig, runLifecycleAcceptance } from './lifecycle-acceptance.mjs'
import { materialAcceptanceConfig } from './material-acceptance.mjs'
import { visionAcceptanceConfig } from './vision-acceptance.mjs'
import { batchAcceptanceConfig } from './batch-acceptance.mjs'
import { stabilityAcceptanceConfig } from './stability-acceptance.mjs'
import { alphaBounds, fittedWidth, trayHeightForDisplay, trayImagePaths, appIconPath, applicationUserModelId, browserWindowIconOptions } from './icon-layout.mjs'
import { allowNativeNotifications, allowPermission, browserPreferences, navigationDecision, productOrigin, resolveProductUrl } from './security-policy.mjs'
import { BrowserWorkspace } from './browser-workspace.mjs'
import { createBrowserLayoutReporter } from './browser-layout-observation.mjs'
import { trustedBrowserSender, validOwner } from './browser-policy.mjs'
import { captureDesktopWakeBaseline, createDesktopWakeCheck, desktopSourceIdentity, inspectDesktopWakeVersion } from './wake-version.mjs'
import { installFrontendVersion } from './frontend-version.mjs'

const PRODUCT_URL = resolveProductUrl(process.env)
let authenticatedProductUrl = PRODUCT_URL
const ORIGIN = productOrigin(PRODUCT_URL)
const nativeNotificationsEnabled = allowNativeNotifications({ platform: process.platform, packaged: app.isPackaged, defaultApp: process.defaultApp })
const RENDERER_HEARTBEAT = 'xiaoshe:renderer-heartbeat'
const INTERACTION_ACCEPTANCE_TIMEOUT_MS = 330_000
let productRoot; let controller; let window; let tray; let brandIcon; let pageRecovery; let trayRefreshTimer; let trayTargetHeight = 15; let rendererReadySequence = 0; let rendererRecoveryPending = false; let rendererUnresponsiveSequence = 0; let quitting = false
let browserWorkspace; let browserEndpoint; let browserOwner; let browserBoundsTimer; let browserChangeTimer
const reportBrowserLayout = createBrowserLayoutReporter(facts => recordStartup('browser-layout-state', facts))
const desktopAppRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const loadedDesktopIdentity = desktopSourceIdentity(desktopAppRoot).catch(() => undefined)
let checkDesktopWake
let frontendVersion
// A second Quit must not bypass the first Quit's asynchronous cleanup/logging.
let quitCleanupComplete = false

const lifecycleAcceptance = lifecycleAcceptanceConfig(process.argv, process.env)
const materialAcceptance = materialAcceptanceConfig(process.argv, process.env)
const visionAcceptance = visionAcceptanceConfig(process.argv, process.env)
const batchAcceptance = batchAcceptanceConfig(process.argv, process.env)
const stabilityAcceptance = stabilityAcceptanceConfig(process.argv, process.env)
const lifecycleAcceptanceStartedAt = new Date().toISOString()
const acceptanceUserData = acceptanceUserDataPath(process.env, tmpdir())
if (acceptanceUserData !== undefined) app.setPath('userData', acceptanceUserData)

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (controller === undefined) return
    showWindow()
    // A second launch must not stop a running task or silently reuse changed code.
    void checkDesktopWake?.().catch(error => recordStartup('wake-version-warning-failed', { message: safeMessage(error) }).catch(() => {}))
  })
  app.whenReady().then(boot).catch(async error => {
    let failure = error
    let cleanup
    try {
      cleanup = await shutdownOwnedProduct({
        closeBrowser,
        stopService: controller === undefined
          ? async () => ({ stopped: false, reason: 'service-controller-not-created' })
          : () => controller.stopOwned(),
      })
    } catch (cleanupError) {
      failure = new AggregateError([error, cleanupError], '小蛇启动失败，且启动补偿清理未全部完成')
      cleanup = { failed: true, message: safeMessage(cleanupError, 4_000) }
    }
    await recordStartup('boot-failed', { message: safeMessage(failure, 4_000), cleanup }).catch(() => {})
    showFailure(failure); app.exit(1)
  })
  app.on('activate', () => { if (controller !== undefined) showWindow() })
  app.on('before-quit', event => {
    if (trayRefreshTimer !== undefined) clearTimeout(trayRefreshTimer)
    if (quitCleanupComplete) return
    if (controller === undefined) { quitting = true; return }
    event.preventDefault()
    if (quitting) return
    quitting = true
    void shutdownOwnedProduct({ closeBrowser, stopService: () => controller.stopOwned() }).then(
      async cleanup => {
        await recordStartup('shutdown-complete', cleanup).catch(() => {})
        quitCleanupComplete = true
        app.quit()
      },
      async error => {
        await recordStartup('shutdown-failed', { message: safeMessage(error, 4_000) }).catch(() => {})
        showFailure(error)
        app.exit(1)
      },
    )
  })
  app.on('window-all-closed', event => { event?.preventDefault?.() })
}

async function boot() {
  app.setAppUserModelId(applicationUserModelId(process.platform))
  await recordStartup('boot-started', { packaged: app.isPackaged, version: app.getVersion(), nativeNotifications: nativeNotificationsEnabled })
  const configuredRoot = productRootOverride(process.env)
  productRoot = configuredRoot ?? await prepareProductRoot({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    version: app.getVersion(),
  })
  await recordStartup('runtime-ready', { source: configuredRoot !== undefined ? 'explicit-override' : app.isPackaged ? 'per-user-copy' : 'development-source' })
  applyBranding()
  const ownershipToken = process.env.XIAOSHE_DESKTOP_ACCEPTANCE === '1'
    ? process.env.XIAOSHE_LAUNCH_TOKEN?.trim() || undefined
    : undefined
  controller = new ProductServiceController({ productRoot, platform: process.platform, url: PRODUCT_URL, ownershipToken })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowPermission(permission, details.requestingOrigin ?? contents.getURL(), ORIGIN, nativeNotificationsEnabled)))
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowPermission(permission, requestingOrigin, ORIGIN, nativeNotificationsEnabled))
  const service = await controller.start()
  authenticatedProductUrl = service.loginUrl
  if (process.env.XIAOSHE_DESKTOP_ACCEPTANCE === '1') {
    const { DshApiClient } = await import(pathToFileURL(join(productRoot, 'packages/terminal-client/lib/api.js')).href)
    configureAcceptanceRpc({ ApiClient: DshApiClient, authenticatedUrl: authenticatedProductUrl })
  }
  const wakeBaseline = await captureDesktopWakeBaseline({ shellIdentity: await loadedDesktopIdentity, baseUrl: PRODUCT_URL })
  checkDesktopWake = createDesktopWakeCheck({
    inspect: () => inspectDesktopWakeVersion({ baseline: wakeBaseline, appRoot: desktopAppRoot, baseUrl: PRODUCT_URL,
      loadedFrontend: () => frontendVersion?.snapshot() }),
    warn: options => dialog.showMessageBox(window, options),
    record: result => recordStartup('wake-version-checked', result).catch(() => {}),
  })
  await recordStartup('service-ready', { origin: ORIGIN })
  const target = createWindow()
  await installBrowserWorkspace(target)
  installRendererHeartbeat(target)
  const loaded = await loadProductPage(target, authenticatedProductUrl, { onRetry: event => recordStartup('ui-load-retry', event) })
  await recordStartup('ui-ready', loaded)
  installPageRecovery(target)
  if (stabilityAcceptance !== undefined) {
    target.setIgnoreMouseEvents(true)
    target.setOpacity(0.01); target.showInactive()
    const { runStabilityAcceptance } = await import('./stability-acceptance.mjs')
    const { productRuntimeIdentity } = await import(pathToFileURL(join(productRoot, 'scripts/product-runtime-identity.mjs')).href)
    const { readBudgetLedger } = await import(pathToFileURL(join(productRoot, 'scripts/acceptance/live-request-budget.mjs')).href)
    const expectedIdentity = await productRuntimeIdentity({ root: productRoot,
      dshRoot: join(productRoot, 'runtime/DSH'), profileRoot: stabilityAcceptance.profileRoot })
    await runStabilityAcceptance({ config: stabilityAcceptance, target, expectedIdentity, readBudgetLedger,
      onStep: step => recordStartup('stability-acceptance-step', step) })
    app.quit(); return
  }
  if (batchAcceptance !== undefined) {
    target.setIgnoreMouseEvents(true)
    target.setOpacity(0.01); target.showInactive()
    const { runBatchAcceptance } = await import('./batch-acceptance.mjs')
    const { productRuntimeIdentity } = await import(pathToFileURL(join(productRoot, 'scripts/product-runtime-identity.mjs')).href)
    const expectedIdentity = await productRuntimeIdentity({ root: productRoot,
      dshRoot: join(productRoot, 'runtime/DSH'), profileRoot: batchAcceptance.profileRoot })
    await runBatchAcceptance({ config: batchAcceptance, productRoot, target, workspace: browserWorkspace, expectedIdentity,
      onStep: step => recordStartup('batch-acceptance-step', { step }) })
    app.quit(); return
  }
  if (visionAcceptance !== undefined) {
    target.setIgnoreMouseEvents(true)
    target.setOpacity(0.01); target.showInactive()
    const { runVisionAcceptance } = await import('./vision-acceptance.mjs')
    const { productRuntimeIdentity } = await import(pathToFileURL(join(productRoot, 'scripts/product-runtime-identity.mjs')).href)
    const expectedIdentity = await productRuntimeIdentity({ root: productRoot,
      dshRoot: join(productRoot, 'runtime/DSH'), profileRoot: visionAcceptance.profileRoot })
    await runVisionAcceptance({ config: visionAcceptance, productRoot, target, expectedIdentity, clipboard, ClipboardItem,
      onStep: step => recordStartup('vision-acceptance-step', { step }) })
    app.quit(); return
  }
  if (materialAcceptance !== undefined) {
    target.setIgnoreMouseEvents(true)
    target.setOpacity(0.01)
    target.showInactive()
    const { runMaterialAcceptance } = await import('./material-acceptance.mjs')
    const { productRuntimeIdentity } = await import(pathToFileURL(join(productRoot, 'scripts', 'product-runtime-identity.mjs')).href)
    const expectedIdentity = await productRuntimeIdentity({ root: productRoot,
      dshRoot: join(productRoot, 'runtime/DSH'), profileRoot: materialAcceptance.profileRoot })
    await runMaterialAcceptance({ config: materialAcceptance, productRoot, target, workspace: browserWorkspace, expectedIdentity,
      onStep: step => recordStartup('material-acceptance-step', { step }) })
    app.quit(); return
  }
  if (lifecycleAcceptance !== undefined) {
    target.setOpacity(0.01)
    target.showInactive()
    const { requestBrowser } = await import(pathToFileURL(join(productRoot, 'scripts', 'isolated-browser-protocol.mjs')).href)
    const { productRuntimeIdentity } = await import(pathToFileURL(join(productRoot, 'scripts', 'product-runtime-identity.mjs')).href)
    const { readBudgetLedger } = await import(pathToFileURL(join(productRoot, 'scripts', 'acceptance', 'live-request-budget.mjs')).href)
    const expectedIdentity = await productRuntimeIdentity({ root: productRoot,
      dshRoot: join(productRoot, 'runtime', 'DSH'), profileRoot: lifecycleAcceptance.profileRoot })
    await runLifecycleAcceptance({ config: lifecycleAcceptance, target, workspace: browserWorkspace,
      requestBrowser, expectedIdentity, readBudgetLedger, phaseStartedAt: lifecycleAcceptanceStartedAt,
      onStep: step => recordStartup('lifecycle-acceptance-step', step) })
    app.quit(); return
  }
  if (process.env.XIAOSHE_DESKTOP_ACCEPTANCE === '1' && process.argv.includes('--acceptance-browser')) {
    const reportDirectory = process.env.XIAOSHE_BROWSER_ACCEPTANCE_OUTPUT
    if (!reportDirectory) throw new Error('browser acceptance report directory is required')
    target.setOpacity(0.01)
    target.showInactive()
    const { runBrowserUiAcceptance } = await import('./browser-ui-acceptance.mjs')
    const { requestBrowser } = await import(pathToFileURL(join(productRoot, 'scripts', 'isolated-browser-protocol.mjs')).href)
    await runBrowserUiAcceptance({ target, workspace: browserWorkspace, requestBrowser, productUrl: PRODUCT_URL, reportDirectory })
    app.quit(); return
  }
  const interactionAcceptance = interactionAcceptanceRequested(process.argv, process.env)
  if (interactionAcceptance) {
    const reportPath = process.env.XIAOSHE_DESKTOP_ACCEPTANCE_REPORT?.trim()
    if (!reportPath) throw new Error('interaction acceptance report path is required')
    // macOS/Chromium may discard a fully transparent renderer. One-percent
    // opacity keeps the real compositor/event path alive while showInactive()
    // prevents the acceptance window from taking keyboard focus.
    target.setOpacity(0.01)
    target.showInactive()
    const guard = setTimeout(() => {
      void recordStartup('ui-interaction-failed', { message: `interaction acceptance exceeded ${INTERACTION_ACCEPTANCE_TIMEOUT_MS}ms` }).finally(() => app.exit(2))
    }, INTERACTION_ACCEPTANCE_TIMEOUT_MS)
    try {
      const report = await runInteractionAcceptance({
        target,
        productUrl: PRODUCT_URL,
        reportPath,
        challenge: process.env.XIAOSHE_DESKTOP_ACCEPTANCE_CHALLENGE?.trim(),
        runId: process.env.XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID?.trim(),
        application: { executablePath: process.execPath, isPackaged: app.isPackaged, pid: process.pid, bundleId: 'com.xiaoshe.desktop' },
        externalActionReadyPath: process.env.XIAOSHE_DESKTOP_ACCEPTANCE_READY?.trim(),
        retireRenderer: () => restartAcceptanceRenderer(target),
        onStep: step => recordStartup('ui-interaction-step', { step }),
      })
      await recordStartup('ui-interaction-accepted', { runId: report.runId, appProcessPid: report.application.pid })
      app.quit()
      return
    } finally {
      clearTimeout(guard)
    }
  }
  createTray()
  // An in-place update may preserve a deliberately hidden window. Explicit
  // tray/launcher activation still uses showWindow and restores normal focus.
  const startHidden = process.env.XIAOSHE_DESKTOP_START_HIDDEN === '1'
  if (!startHidden) showWindow()
  if (!startHidden && nativeNotificationsEnabled && Notification.isSupported()) new Notification({ title: '小蛇已就绪', body: '本地桌面服务已通过健康检查。', silent: true }).show()
  const quitAfter = acceptanceQuitDelay(process.argv, process.env)
  if (process.env.XIAOSHE_DESKTOP_ACCEPTANCE === '1' && process.argv.includes('--acceptance-hide-show')) {
    setTimeout(() => target.hide(), 1_000).unref()
    setTimeout(() => {
      if (quitting || target.isDestroyed()) return
      void recordStartup('ui-acceptance-renderer-termination', { hidden: !target.isVisible() }).finally(() => {
        if (!quitting && !target.isDestroyed()) target.webContents.forcefullyCrashRenderer()
      })
    }, 2_500).unref()
    setTimeout(() => showWindow(), 5_000).unref()
    setTimeout(() => { void recordVisualProof(target) }, 8_000).unref()
  }
  if (quitAfter !== undefined) setTimeout(() => app.quit(), quitAfter).unref()
}

async function restartAcceptanceRenderer(target) {
  const contents = target?.webContents
  const beforePid = contents?.getOSProcessId?.()
  if (!Number.isSafeInteger(beforePid) || beforePid <= 0 || target.isDestroyed()) {
    throw new Error('interaction acceptance renderer process identity is unavailable')
  }
  return await new Promise((resolveRestart, rejectRestart) => {
    let settled = false
    let timeout
    const finish = (error, afterPid) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      contents.removeListener('did-finish-load', onLoaded)
      target.removeListener('closed', onClosed)
      if (error !== undefined) rejectRestart(error)
      else resolveRestart({ beforePid, afterPid })
    }
    const onLoaded = () => {
      let afterPid
      try {
        afterPid = contents.getOSProcessId()
      } catch (error) {
        finish(error)
        return
      }
      if (!Number.isSafeInteger(afterPid) || afterPid <= 0 || afterPid === beforePid) {
        finish(new Error('forced renderer retirement did not create a new renderer process'))
        return
      }
      finish(undefined, afterPid)
    }
    const onClosed = () => finish(new Error('window closed during renderer retirement'))
    timeout = setTimeout(() => finish(new Error('timed out waiting for renderer process replacement')), 60_000)
    contents.once('did-finish-load', onLoaded)
    target.once('closed', onClosed)
    try {
      contents.forcefullyCrashRenderer()
    } catch (error) {
      finish(error)
    }
  })
}

function createWindow() {
  if (window !== undefined && !window.isDestroyed()) return window
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 480, minHeight: 360, show: false, backgroundColor: '#f7f9f7', title: '小蛇', ...browserWindowIconOptions({ platform: process.platform, packaged: app.isPackaged, icon: brandIcon }), autoHideMenuBar: true, webPreferences: browserPreferences(join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs')) })
  const contents = window.webContents
  contents.on('before-input-event', (event, input) => {
    // Electron's default Ctrl/Cmd+Plus needs Shift on the main keyboard. Also
    // accept the unshifted '=' and numpad '+', using the same native zoom step.
    // Consuming handled keys prevents the menu accelerator from zooming twice.
    const command = process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
    const plus = input.key === '=' || input.key === '+' || input.code === 'NumpadAdd'
    if (input.type !== 'keyDown' || !command || input.alt || input.isComposing || !plus) return
    event.preventDefault()
    contents.zoomLevel += 0.5
  })
  frontendVersion = installFrontendVersion({ contents: window.webContents, ipcMain, origin: ORIGIN, record: recordStartup })
  if (interactionAcceptanceRequested(process.argv, process.env)) {
    window.webContents.on('console-message', event => {
      const message = event?.message
      // Acceptance diagnostics deliberately whitelist framework failures. This
      // prevents conversation text or ordinary application logs from crossing
      // into the native startup log.
      if (!/(?:maximum update depth|too many re-renders|getSnapshot should be cached|out of memory|heap limit)/iu.test(message ?? '')) return
      void recordStartup('ui-framework-error', {
        level: event?.level,
        message: safeMessage(message, 1_000),
        line: Number(event?.lineNumber ?? 0),
        sourceId: String(event?.sourceId ?? '').slice(-240),
      }).catch(() => {})
    })
  }
  window.webContents.setWindowOpenHandler(({ url }) => { if (navigationDecision(url, ORIGIN) === 'external-https') openBrowserLink(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => {
    const decision = navigationDecision(url, ORIGIN)
    void recordStartup('ui-will-navigate', { url, decision }).catch(() => {})
    if (decision !== 'allow-product') { event.preventDefault(); if (decision === 'external-https') openBrowserLink(url) }
  })
  window.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) { if (!isInPlace) { browserWorkspace?.mount(undefined, undefined); observeBrowserLayout('host', 'navigation') }; void recordStartup('ui-navigation-started', { url, isInPlace }).catch(() => {}) }
  })
  window.webContents.on('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
    void recordStartup('ui-navigation-finished', { url, httpResponseCode, httpStatusText }).catch(() => {})
  })
  window.on('close', event => {
    void recordStartup('window-close-requested', { quitting, visible: window.isVisible() }).catch(() => {})
    if (!quitting) { event.preventDefault(); window.hide() }
  })
  const visibilityFacts = () => ({ visible: window.isVisible(), minimized: window.isMinimized(),
    ...(process.platform === 'darwin' ? { applicationHidden: app.isHidden() } : {}) })
  // Record observations, not an inferred user action: native hide events alone
  // do not establish who hid a window or the renderer's viewport dimensions.
  window.on('hide', () => { void recordStartup('window-hidden', visibilityFacts()).catch(() => {}) })
  window.on('show', () => { void recordStartup('window-shown', visibilityFacts()).catch(() => {}) })
  return window
}

async function installBrowserWorkspace(target) {
  browserWorkspace = new BrowserWorkspace({ window: target, productUrl: PRODUCT_URL, userDataPath: app.getPath('userData'), onChange: () => {
    if (browserChangeTimer !== undefined || quitting) return
    browserChangeTimer = setTimeout(() => {
      browserChangeTimer = undefined
      if (!target.isDestroyed()) target.webContents.send('xiaoshe:browser-changed')
    }, 40)
  } })
  const { createBrowserEndpoint } = await import(pathToFileURL(join(productRoot, 'scripts', 'isolated-browser-protocol.mjs')).href)
  browserEndpoint = await createBrowserEndpoint({ origin: PRODUCT_URL,
    dispatch: (ownerId, command, args, signal) => browserWorkspace.agent(ownerId, command, args, signal) })
  ipcMain.handle('xiaoshe:browser-ui', async (event, request) => {
    if (!trustedBrowserSender(event, target.webContents, ORIGIN)) return { ok: false, error: '浏览器控制来源不可信。' }
    try {
      const ownerId = validOwner(request?.ownerId)
      if (request.action === 'bind') { browserOwner = ownerId; browserWorkspace.mount(ownerId, undefined); observeBrowserLayout('host', 'bind'); return { ok: true, value: browserWorkspace.status(ownerId) } }
      if (ownerId !== browserOwner) throw new Error('会话已切换，请刷新浏览器状态。')
      return { ok: true, value: await browserWorkspace.ui(ownerId, request.action, request.args) }
    } catch (error) { return { ok: false, error: safeMessage(error, 1200) } }
  })
  ipcMain.on('xiaoshe:browser-bounds', (event, request) => {
    if (!trustedBrowserSender(event, target.webContents, ORIGIN) || request?.ownerId !== browserOwner) return
    clearTimeout(browserBoundsTimer)
    browserWorkspace.mount(browserOwner, request.bounds)
    observeBrowserLayout('renderer', request.reason)
    // A vanished/frozen renderer must not leave a native view over recovery or
    // modal UI. The visible placeholder renews this lease, without input focus.
    browserBoundsTimer = setTimeout(() => { browserWorkspace?.mount(undefined, undefined); observeBrowserLayout('host', 'lease-expired') }, 1800)
  })
  target.webContents.on('render-process-gone', () => { browserWorkspace?.mount(undefined, undefined); observeBrowserLayout('host', 'renderer-gone') })
  target.webContents.on('unresponsive', () => { browserWorkspace?.mount(undefined, undefined); observeBrowserLayout('host', 'renderer-unresponsive') })
  await recordStartup('isolated-browser-ready', { isolated: true, desktopDefault: 'denied' })
}
function observeBrowserLayout(source, reason) {
  try {
    const owner = browserWorkspace?.owners.get(browserWorkspace.activeOwner)
    const usableWindow = window && !window.isDestroyed()
    reportBrowserLayout({ source, reason, ownerPresent: !!browserWorkspace?.activeOwner, boundsPresent: !!browserWorkspace?.bounds,
      selectedTabPresent: !!owner?.activeTab && browserWorkspace.tabs.has(owner.activeTab),
      windowVisible: usableWindow ? window.isVisible() : null, minimized: usableWindow ? window.isMinimized() : null,
      applicationHidden: process.platform === 'darwin' ? app.isHidden() : null })
  } catch { /* Observation must never interrupt an IPC handler or lease expiry. */ }
}
function openBrowserLink(url) {
  if (!browserWorkspace || !browserOwner || window?.isDestroyed()) return
  window.webContents.send('xiaoshe:browser-reveal')
  void browserWorkspace.ui(browserOwner, 'open', { url }).catch(error => {
    browserWorkspace.notice = safeMessage(error, 500); browserWorkspace.changed()
  })
}
async function closeBrowser() {
  clearTimeout(browserBoundsTimer); clearTimeout(browserChangeTimer)
  ipcMain.removeHandler('xiaoshe:browser-ui'); ipcMain.removeAllListeners('xiaoshe:browser-bounds')
  await browserEndpoint?.close(); browserEndpoint = undefined
  await browserWorkspace?.dispose(); browserWorkspace = undefined
}
function applyBranding() {
  app.setName('小蛇')
  brandIcon = loadAppIcon(256)
  if (process.platform === 'darwin' && app.dock !== undefined) app.dock.setIcon(loadAppIcon(512))
}
function loadAppIcon(size) {
  const iconPath = appIconPath({
    platform: process.platform, size, productRoot,
    desktopRoot: dirname(dirname(fileURLToPath(import.meta.url))),
  })
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) throw new Error(`小蛇正式应用图标不可用：${iconPath}`)
  return image
}
function loadTrayImage(targetHeight = 15) {
  const { standard: iconPath, retina: retinaPath } = trayImagePaths({
    platform: process.platform, productRoot,
    desktopRoot: dirname(dirname(fileURLToPath(import.meta.url))),
  })
  const sourceImage = nativeImage.createFromPath(iconPath)
  const retinaSource = nativeImage.createFromPath(retinaPath)
  if (sourceImage.isEmpty() || retinaSource.isEmpty()) {
    throw new Error(`小蛇正式菜单栏图标不可用：${sourceImage.isEmpty() ? iconPath : retinaPath}`)
  }
  // Crop only transparent padding and fit the existing menu-bar dimensions.
  // Windows exports are derived from snake.svg; never recolor the old favicon
  // or reconstruct its silhouette. macOS keeps its reviewed template inputs.
  const image = fitTrayGlyph(sourceImage, targetHeight)
  const retinaImage = fitTrayGlyph(retinaSource, targetHeight * 2)
  image.addRepresentation({ scaleFactor: 2, buffer: retinaImage.toPNG() })
  // Template tinting is macOS-only. Windows uses actual white PNG pixels so it
  // cannot accidentally display the source SVG's mint/gradient colors.
  image.setTemplateImage(process.platform === 'darwin')
  return image
}
function fitTrayGlyph(source, targetHeight) {
  const size = source.getSize()
  const bounds = alphaBounds(source.toBitmap({ scaleFactor: 1 }), size.width, size.height)
  return source.crop(bounds).resize({ width: fittedWidth(bounds, targetHeight), height: targetHeight, quality: 'best' })
}
function currentTrayProfile() {
  const display = screen.getPrimaryDisplay()
  return {
    displayId: display.id,
    menuBarHeight: Math.max(0, display.workArea.y - display.bounds.y),
    scaleFactor: display.scaleFactor,
    targetHeight: process.platform === 'darwin' ? trayHeightForDisplay(display) : 15,
  }
}
function scheduleTrayImageRefresh(reason) {
  if (quitting || tray === undefined || tray.isDestroyed()) return
  if (trayRefreshTimer !== undefined) clearTimeout(trayRefreshTimer)
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = undefined
    if (quitting || tray === undefined || tray.isDestroyed()) return
    const profile = currentTrayProfile()
    if (profile.targetHeight === trayTargetHeight) return
    tray.setImage(loadTrayImage(profile.targetHeight))
    trayTargetHeight = profile.targetHeight
    void recordStartup('tray-icon-resized', { reason, ...profile }).catch(() => {})
  }, 120)
  trayRefreshTimer.unref()
}
function installTrayDisplaySync() {
  screen.on('display-added', () => scheduleTrayImageRefresh('display-added'))
  screen.on('display-removed', () => scheduleTrayImageRefresh('display-removed'))
  screen.on('display-metrics-changed', (_event, _display, changedMetrics) => {
    if (changedMetrics.some(metric => ['bounds', 'workArea', 'scaleFactor'].includes(metric))) scheduleTrayImageRefresh('display-metrics-changed')
  })
}
function createTray() {
  if (tray !== undefined) return tray
  const profile = currentTrayProfile()
  trayTargetHeight = profile.targetHeight
  tray = new Tray(loadTrayImage(trayTargetHeight)); tray.setToolTip('小蛇')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开小蛇', click: showWindow }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]))
  tray.on('double-click', showWindow)
  if (process.platform === 'darwin') installTrayDisplaySync()
  void recordStartup('tray-icon-ready', profile).catch(() => {})
  return tray
}
function installPageRecovery(target) {
  target.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || quitting || target.isDestroyed()) return
    recoverProductPage(target, { trigger: 'did-fail-load', errorCode, errorDescription })
  })
  target.webContents.on('render-process-gone', (_event, details) => {
    void handleRendererGone(target, details)
  })
  target.webContents.on('unresponsive', () => { void handleRendererUnresponsive(target) })
  target.webContents.on('responsive', () => {
    rendererUnresponsiveSequence += 1
    void recordStartup('ui-responsive', { url: target.webContents.getURL() }).catch(() => {})
  })
  target.webContents.on('preload-error', (_event, preloadPath, error) => {
    void recordStartup('ui-preload-error', { preloadPath, message: safeMessage(error, 4_000) }).catch(() => {})
  })
}

async function handleRendererGone(target, details) {
  const visible = target.isVisible()
  const detail = { trigger: 'render-process-gone', reason: details.reason, exitCode: details.exitCode, visible }
  await recordStartup('ui-renderer-gone', detail).catch(() => {})
  const action = rendererExitAction({ reason: details.reason, visible })
  if (action === 'defer') {
    rendererRecoveryPending = true
    await recordStartup('ui-recovery-deferred', { ...detail, until: 'window-shown' }).catch(() => {})
    return
  }
  if (action === 'probe-current') {
    const alive = await probeCurrentRenderer(target)
    if (quitting || target.isDestroyed()) return
    if (alive) {
      rendererRecoveryPending = false
      await recordStartup('ui-renderer-retained', { ...detail, rendererReadySequence })
      return
    }
  }
  rendererRecoveryPending = true
  recoverProductPage(target, detail)
}

async function probeCurrentRenderer(target) {
  return await rendererProbePassed({
    probe: async () => {
      if (quitting || target.isDestroyed()) return false
      const state = await target.webContents.executeJavaScript(`(() => ({ readyState: document.readyState, origin: location.origin }))()`, true)
      return (state?.readyState === 'interactive' || state?.readyState === 'complete') && state?.origin === ORIGIN
    },
    wait: delay => new Promise(resolveWait => setTimeout(resolveWait, delay)),
  })
}

async function handleRendererUnresponsive(target) {
  const sequence = ++rendererUnresponsiveSequence
  const detail = { trigger: 'unresponsive', url: target.webContents.getURL(), visible: target.isVisible() }
  await recordStartup('ui-unresponsive', detail).catch(() => {})
  const alive = await probeCurrentRenderer(target)
  if (quitting || target.isDestroyed() || sequence !== rendererUnresponsiveSequence) return
  if (alive) {
    await recordStartup('ui-responsive-probe', detail).catch(() => {})
    return
  }
  rendererRecoveryPending = true
  if (!target.isVisible()) {
    await recordStartup('ui-recovery-deferred', { ...detail, until: 'window-shown' }).catch(() => {})
    return
  }
  await recoverProductPage(target, detail)
}

function installRendererHeartbeat(target) {
  const handler = (event, detail) => {
    if (quitting || target.isDestroyed() || event.sender !== target.webContents) return
    rendererReadySequence += 1
    rendererRecoveryPending = false
    const readyState = ['loading', 'interactive', 'complete'].includes(detail?.readyState) ? detail.readyState : 'unknown'
    // Record first paint and then one compact minute-level proof. No page text,
    // message metadata or user content crosses this channel.
    if (rendererReadySequence === 1 || rendererReadySequence % 20 === 0) {
      void recordStartup('ui-renderer-ready', { rendererReadySequence, readyState }).catch(() => {})
    }
  }
  ipcMain.on(RENDERER_HEARTBEAT, handler)
  target.once('closed', () => { ipcMain.off(RENDERER_HEARTBEAT, handler) })
}

function recoverProductPage(target, detail) {
  if (quitting || target.isDestroyed()) return Promise.resolve(false)
  if (pageRecovery !== undefined) {
    void recordStartup('ui-recovery-coalesced', detail).catch(() => {})
    return pageRecovery
  }
  pageRecovery = (async () => {
    await recordStartup('ui-recovery-started', detail)
    const result = await loadProductPage(target, authenticatedProductUrl, {
      onRetry: event => recordStartup('ui-reload-retry', { ...detail, ...event }),
    })
    await recordStartup('ui-recovered', { ...detail, ...result })
    return true
  })().catch(async error => {
    await recordStartup('ui-recovery-failed', { ...detail, message: safeMessage(error, 4_000) }).catch(() => {})
    showFailure(error)
    return false
  }).finally(() => { pageRecovery = undefined })
  return pageRecovery
}
function showWindow() {
  const target = createWindow()
  const reveal = () => {
    if (quitting || target.isDestroyed()) return
    if (target.isMinimized()) target.restore()
    if (process.env.XIAOSHE_DESKTOP_ACCEPTANCE === '1') target.showInactive()
    else { target.show(); target.focus() }
  }
  if (!rendererRecoveryPending) { reveal(); return }
  // Chromium may reclaim the hidden renderer. Reload while the window remains
  // hidden so users never see the empty native background during recovery.
  void recoverProductPage(target, { trigger: 'window-shown-after-renderer-exit' }).then(recovered => {
    if (recovered) reveal()
  })
}

async function recordVisualProof(target) {
  if (quitting || target.isDestroyed() || !target.isVisible()) return
  try {
    const image = await target.webContents.capturePage()
    const { width, height } = image.getSize()
    const bitmap = image.toBitmap()
    const colors = new Set()
    const pixelCount = Math.floor(bitmap.length / 4)
    const stride = Math.max(1, Math.floor(pixelCount / 10_000))
    for (let pixel = 0; pixel < pixelCount && colors.size <= 64; pixel += stride) {
      const offset = pixel * 4
      colors.add(`${bitmap[offset]},${bitmap[offset + 1]},${bitmap[offset + 2]}`)
    }
    await recordStartup('ui-visual-proof', { width, height, sampledColors: colors.size, nonBlank: width > 0 && height > 0 && colors.size > 8 })
  } catch (error) {
    await recordStartup('ui-visual-proof-failed', { message: safeMessage(error, 4_000) }).catch(() => {})
  }
}
function showFailure(error) { if (nativeNotificationsEnabled && Notification.isSupported()) new Notification({ title: '小蛇启动失败', body: safeMessage(error, 240) }).show() }
async function recordStartup(event, detail = {}) {
  const directory = join(app.getPath('userData'), 'logs')
  await mkdir(directory, { recursive: true })
  await appendFile(join(directory, 'desktop-shell.jsonl'), `${redactDesktopLogin(JSON.stringify({ at: new Date().toISOString(), event, ...detail }))}\n`, 'utf8')
}
function safeMessage(error, limit = 500) {
  const message = redactDesktopLogin(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, ' ')
  return message.length <= limit ? message : `…${message.slice(-(limit - 1))}`
}
