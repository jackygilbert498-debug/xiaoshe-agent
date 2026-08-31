import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, session, shell } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProductServiceController, acceptanceQuitDelay, loadProductPage, prepareProductRoot, productRootOverride, rendererExitAction, rendererProbePassed } from './lifecycle.mjs'
import { interactionAcceptanceRequested, runInteractionAcceptance } from './interaction-acceptance.mjs'
import { allowPermission, browserPreferences, navigationDecision, productOrigin, resolveProductUrl } from './security-policy.mjs'

const PRODUCT_URL = resolveProductUrl(process.env)
const ORIGIN = productOrigin(PRODUCT_URL)
const RENDERER_HEARTBEAT = 'xiaoshe:renderer-heartbeat'
let productRoot; let controller; let window; let tray; let brandIcon; let pageRecovery; let rendererReadySequence = 0; let rendererRecoveryPending = false; let rendererUnresponsiveSequence = 0; let quitting = false

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (controller !== undefined) showWindow() })
  app.whenReady().then(boot).catch(async error => {
    const cleanup = controller === undefined ? undefined : await controller.stopOwned().catch(cleanupError => ({ stopped: false, error: safeMessage(cleanupError) }))
    await recordStartup('boot-failed', { message: safeMessage(error, 4_000), cleanup }).catch(() => {})
    showFailure(error); app.exit(1)
  })
  app.on('activate', () => { if (controller !== undefined) showWindow() })
  app.on('before-quit', event => {
    if (quitting) return
    if (controller === undefined) { quitting = true; return }
    event.preventDefault(); quitting = true
    void controller.stopOwned().finally(() => app.quit())
  })
  app.on('window-all-closed', event => { event?.preventDefault?.() })
}

async function boot() {
  app.setAppUserModelId('com.xiaoshe.desktop')
  await recordStartup('boot-started', { packaged: app.isPackaged, version: app.getVersion() })
  const configuredRoot = productRootOverride(process.env)
  productRoot = configuredRoot ?? await prepareProductRoot({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    version: app.getVersion(),
  })
  await recordStartup('runtime-ready', { source: configuredRoot !== undefined ? 'explicit-override' : app.isPackaged ? 'per-user-copy' : 'development-source' })
  applyBranding()
  controller = new ProductServiceController({ productRoot, platform: process.platform, url: PRODUCT_URL })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowPermission(permission, details.requestingOrigin ?? contents.getURL(), ORIGIN)))
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowPermission(permission, requestingOrigin, ORIGIN))
  await controller.start()
  await recordStartup('service-ready', { origin: ORIGIN })
  const target = createWindow()
  installRendererHeartbeat(target)
  const loaded = await loadProductPage(target, PRODUCT_URL, { onRetry: event => recordStartup('ui-load-retry', event) })
  await recordStartup('ui-ready', loaded)
  installPageRecovery(target)
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
      void recordStartup('ui-interaction-failed', { message: 'interaction acceptance exceeded 30000ms' }).finally(() => app.exit(2))
    }, 30_000)
    try {
      const report = await runInteractionAcceptance({
        target,
        productUrl: PRODUCT_URL,
        reportPath,
        simulateCleanExit: () => handleRendererGone(target, { reason: 'clean-exit', exitCode: 0 }),
        onStep: step => recordStartup('ui-interaction-step', { step }),
      })
      await recordStartup('ui-interaction-accepted', report)
      app.quit()
      return
    } finally {
      clearTimeout(guard)
    }
  }
  createTray(); showWindow()
  if (Notification.isSupported()) new Notification({ title: '小蛇已就绪', body: '本地桌面服务已通过健康检查。', silent: true }).show()
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

function createWindow() {
  if (window !== undefined && !window.isDestroyed()) return window
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 960, minHeight: 680, show: false, backgroundColor: '#f7f9f7', title: '小蛇', icon: brandIcon, autoHideMenuBar: true, webPreferences: browserPreferences(join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs')) })
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
  window.webContents.setWindowOpenHandler(({ url }) => { const decision = navigationDecision(url, ORIGIN); if (decision === 'external-https') void shell.openExternal(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => {
    const decision = navigationDecision(url, ORIGIN)
    void recordStartup('ui-will-navigate', { url, decision }).catch(() => {})
    if (decision !== 'allow-product') event.preventDefault()
  })
  window.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) void recordStartup('ui-navigation-started', { url, isInPlace }).catch(() => {})
  })
  window.webContents.on('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
    void recordStartup('ui-navigation-finished', { url, httpResponseCode, httpStatusText }).catch(() => {})
  })
  window.on('close', event => {
    void recordStartup('window-close-requested', { quitting, visible: window.isVisible() }).catch(() => {})
    if (!quitting) { event.preventDefault(); window.hide() }
  })
  window.on('hide', () => { void recordStartup('window-hidden').catch(() => {}) })
  window.on('show', () => { void recordStartup('window-shown').catch(() => {}) })
  return window
}
function applyBranding() {
  app.setName('小蛇')
  brandIcon = loadAppIcon(256)
  if (process.platform === 'darwin' && app.dock !== undefined) app.dock.setIcon(loadAppIcon(512))
}
function loadAppIcon(size) {
  const iconPath = join(productRoot, 'runtime', 'xiaoshe-legacy', 'ui', 'assets', `app-icon-${size}.png`)
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) throw new Error(`小蛇正式应用图标不可用：${iconPath}`)
  return image
}
function loadTrayImage() {
  const assets = join(productRoot, 'runtime', 'xiaoshe-legacy', 'ui', 'assets')
  const iconPath = join(assets, 'icon-16.png')
  const retinaPath = join(assets, 'icon-32.png')
  const image = nativeImage.createFromPath(iconPath)
  const retinaImage = nativeImage.createFromPath(retinaPath)
  if (image.isEmpty() || retinaImage.isEmpty()) {
    throw new Error(`小蛇正式菜单栏图标不可用：${image.isEmpty() ? iconPath : retinaPath}`)
  }
  // 只使用正式 UI 目录中的 16/32px 标识原件；32px 原件作为 2x Retina
  // 表示加入，避免 Electron 自行放大或把正式几何重绘成近似字母。
  image.addRepresentation({ scaleFactor: 2, buffer: retinaImage.toPNG() })
  // 不启用 macOS Template 着色：Template 会抹掉正式标识的四色渐变，
  // 在菜单栏中重新退化成用户已否决的纯白近似“S”。
  return image
}
function createTray() {
  if (tray !== undefined) return tray
  tray = new Tray(loadTrayImage()); tray.setToolTip('小蛇')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开小蛇', click: showWindow }, { type: 'separator' }, { label: '退出', click: () => { quitting = true; void controller.stopOwned().finally(() => app.quit()) } }]))
  tray.on('double-click', showWindow); return tray
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
    const result = await loadProductPage(target, PRODUCT_URL, {
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
function showFailure(error) { if (Notification.isSupported()) new Notification({ title: '小蛇启动失败', body: safeMessage(error, 240) }).show() }
async function recordStartup(event, detail = {}) {
  const directory = join(app.getPath('userData'), 'logs')
  await mkdir(directory, { recursive: true })
  await appendFile(join(directory, 'desktop-shell.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`, 'utf8')
}
function safeMessage(error, limit = 500) {
  const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, ' ')
  return message.length <= limit ? message : `…${message.slice(-(limit - 1))}`
}
