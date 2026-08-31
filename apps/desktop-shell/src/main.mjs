import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, session, shell } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProductServiceController, acceptanceQuitDelay, loadProductPage, prepareProductRoot, productRootOverride } from './lifecycle.mjs'
import { allowPermission, browserPreferences, navigationDecision, productOrigin, resolveProductUrl } from './security-policy.mjs'

const PRODUCT_URL = resolveProductUrl(process.env)
const ORIGIN = productOrigin(PRODUCT_URL)
let productRoot; let controller; let window; let tray; let brandIcon; let pageRecovery; let quitting = false

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
  await recordStartup('runtime-ready', { source: configuredRoot === undefined ? 'per-user-copy' : 'explicit-override' })
  applyBranding()
  controller = new ProductServiceController({ productRoot, platform: process.platform, url: PRODUCT_URL })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowPermission(permission, details.requestingOrigin ?? contents.getURL(), ORIGIN)))
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowPermission(permission, requestingOrigin, ORIGIN))
  await controller.start()
  await recordStartup('service-ready', { origin: ORIGIN })
  const target = createWindow()
  const loaded = await loadProductPage(target, PRODUCT_URL, { onRetry: event => recordStartup('ui-load-retry', event) })
  await recordStartup('ui-ready', loaded)
  installPageRecovery(target); createTray(); showWindow()
  if (Notification.isSupported()) new Notification({ title: '小蛇已就绪', body: '本地桌面服务已通过健康检查。', silent: true }).show()
  const quitAfter = acceptanceQuitDelay(process.argv, process.env)
  if (quitAfter !== undefined) setTimeout(() => app.quit(), quitAfter).unref()
}

function createWindow() {
  if (window !== undefined && !window.isDestroyed()) return window
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 960, minHeight: 680, show: false, backgroundColor: '#f7f9f7', title: '小蛇', icon: brandIcon, autoHideMenuBar: true, webPreferences: browserPreferences(join(dirname(fileURLToPath(import.meta.url)), 'preload.mjs')) })
  window.webContents.setWindowOpenHandler(({ url }) => { const decision = navigationDecision(url, ORIGIN); if (decision === 'external-https') void shell.openExternal(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => { if (navigationDecision(url, ORIGIN) !== 'allow-product') event.preventDefault() })
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide() } })
  return window
}
function applyBranding() {
  app.setName('小蛇')
  brandIcon = loadBrandImage(256)
  if (process.platform === 'darwin' && app.dock !== undefined) app.dock.setIcon(brandIcon)
}
function loadBrandImage(size) {
  const iconPath = join(productRoot, 'runtime', 'xiaoshe-legacy', 'ui', 'assets', `icon-${size}.png`)
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) throw new Error(`小蛇正式品牌图标不可用：${iconPath}`)
  return image
}
function createTray() {
  if (tray !== undefined) return tray
  tray = new Tray(loadBrandImage(32)); tray.setToolTip('小蛇')
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开小蛇', click: showWindow }, { type: 'separator' }, { label: '退出', click: () => { quitting = true; void controller.stopOwned().finally(() => app.quit()) } }]))
  tray.on('double-click', showWindow); return tray
}
function installPageRecovery(target) {
  target.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || quitting || target.isDestroyed()) return
    if (pageRecovery !== undefined) return
    pageRecovery = loadProductPage(target, PRODUCT_URL, {
      onRetry: event => recordStartup('ui-reload-retry', { errorCode, errorDescription, ...event }),
    }).then(result => recordStartup('ui-recovered', result)).catch(async error => {
      await recordStartup('ui-recovery-failed', { errorCode, errorDescription, message: safeMessage(error, 4_000) }).catch(() => {})
      showFailure(error)
    }).finally(() => { pageRecovery = undefined })
  })
}
function showWindow() { const target = createWindow(); if (target.isMinimized()) target.restore(); target.show(); target.focus() }
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
