import { BaseWindow, WebContentsView, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { browserUrl, browserPreferences, browserBounds, validOwner, withBrowserVerificationHint, browserVerificationContract, assertBrowserVerificationContract, resolveBrowserVerificationInput, browserVerificationObservation, browserSnapshotSatisfies, assertBrowserVerificationObservation } from './browser-policy.mjs'
import { snapshotScript, targetScript, scrollScript } from './browser-page-scripts.mjs'

const WORLD = 12017
const LIMIT = 12
const fault = (code, message) => Object.assign(new Error(message), { code })
const text = (value, name, max = 8192) => { if (typeof value !== 'string' || !value || value.length > max) throw fault('BROWSER_ARGUMENT', `${name} 无效。`); return value }
function check(signal) { if (signal?.aborted) throw fault('BROWSER_CANCELLED', '浏览器操作已停止；请重新核对已发出的操作结果。') }
// Bound even a stalled renderer. Abandoning a response never means a submitted
// web action was rolled back, so callers must observe before retrying writes.
function bounded(promise, signal, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value) }
    const abort = () => finish(fault('BROWSER_CANCELLED', '浏览器操作已停止，请核对已发出的操作结果。'))
    const timer = setTimeout(() => finish(fault('BROWSER_TIMEOUT', '网页响应超时，请重新观察；不要直接重复写入。')), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(value => finish(undefined, value), error => finish(error))
    if (signal?.aborted) abort()
  })
}
const KEYS = ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']
const optionalText = (value, name, max, allowEmpty = false) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) throw fault('BROWSER_ARGUMENT', `${name} 无效。`)
  return value
}
function browserAssertions(args) {
  const expectClosed = args.expect_closed === true
  const expectUrl = optionalText(args.expect_url, 'expect_url', 2048)
  const expectText = optionalText(args.expect_text, 'expect_text', 1000)
  const expectElementId = optionalText(args.expect_element_id, 'expect_element_id', 64)
  const expectValue = optionalText(args.expect_value, 'expect_value', 2000, true)
  const expectScrollY = args.expect_scroll_y
  if (args.expect_closed !== undefined && typeof args.expect_closed !== 'boolean') throw fault('BROWSER_ARGUMENT', 'expect_closed 必须为布尔值。')
  if (expectScrollY !== undefined && !Number.isSafeInteger(expectScrollY)) throw fault('BROWSER_ARGUMENT', 'expect_scroll_y 必须为安全整数。')
  if (expectValue !== undefined && expectElementId === undefined) throw fault('BROWSER_ARGUMENT', 'expect_value 必须同时指定 expect_element_id。')
  const assertions = {
    ...(expectClosed ? { expect_closed: true } : {}),
    ...(expectUrl === undefined ? {} : { expect_url: expectUrl }),
    ...(expectText === undefined ? {} : { expect_text: expectText }),
    ...(expectElementId === undefined ? {} : { expect_element_id: expectElementId }),
    ...(expectValue === undefined ? {} : { expect_value: expectValue }),
    ...(expectScrollY === undefined ? {} : { expect_scroll_y: expectScrollY }),
  }
  if (expectClosed && Object.keys(assertions).length !== 1) throw fault('BROWSER_ARGUMENT', '关闭验证不能与页面内容断言混用。')
  if (Object.keys(assertions).length === 0) throw fault('BROWSER_ARGUMENT', 'browser_verify 至少需要一个明确的后置条件。')
  return assertions
}
export class BrowserWorkspace {
  constructor({ window, productUrl, userDataPath, partition = 'persist:xiaoshe-agent-browser-v1', onChange = () => {} }) {
    this.window = window; this.productUrl = productUrl; this.userDataPath = userDataPath; this.partition = partition; this.onChange = onChange
    this.tabs = new Map(); this.owners = new Map(); this.activeOwner = undefined; this.bounds = undefined; this.artifacts = 0; this.disposed = false
    this.session = session.fromPartition(partition)
    this.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false))
    this.session.setPermissionCheckHandler(() => false)
    this.session.setDevicePermissionHandler(() => false)
    this.session.on('will-download', this.downloadHandler = event => { event.preventDefault(); this.notice = '自动下载已阻止，请使用已授权的文件下载流程。'; this.changed() })
    this.session.webRequest.onBeforeRequest((details, callback) => {
      const tab = [...this.tabs.values()].find(row => row.view.webContents.id === details.webContentsId)
      try {
        const url = new URL(details.url)
        if (['data:', 'blob:', 'about:'].includes(url.protocol)) { callback({}); return }
        // External pages cannot reach the product API or probe arbitrary local
        // tools. A local tool origin must first be explicitly opened as a tab.
        if (['ws:', 'wss:'].includes(url.protocol)) url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:'
        browserUrl(url.href, productUrl)
        if (url.protocol === 'http:' && tab?.localOrigin !== url.origin) throw new Error('Local request not authorized')
        callback({})
      } catch { callback({ cancel: true }) }
    })
    this.shield = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    this.shield.setBackgroundColor('#00000000')
    this.window.contentView.addChildView(this.shield)
    this.shield.setVisible(false)
    void this.shield.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>html,body{margin:0;width:100%;height:100%;background:transparent;cursor:default}body:active{background:rgba(50,90,75,.06)}</style><body title="小蛇正在使用专用浏览器；点上方“我来接管”后可手动操作。"></body>')).catch(() => {})
    this.window.on('resize', this.resizeHandler = () => this.layout())
  }
  owner(id) {
    validOwner(id)
    if (!this.owners.has(id)) {
      if (this.owners.size >= 128) throw fault('BROWSER_LIMIT', '本次运行的浏览器会话过多，请重启专用浏览器。')
      this.owners.set(id, { mode: 'agent', activeTab: undefined, desktopUntil: 0, revision: 0 })
    }
    return this.owners.get(id)
  }
  status(id) {
    const owner = this.owner(id)
    return { connected: true, owner_id: id, mode: owner.mode, desktop_allowed: owner.desktopUntil > Date.now(), desktop_until: owner.desktopUntil,
      active_tab: owner.activeTab ?? null, notice: this.notice ?? '',
      tabs: [...this.tabs.values()].filter(tab => tab.ownerId === id).map(tab => ({ tab_id: tab.id, url: tab.url, title: tab.title, loading: tab.loading, error: tab.error, busy: !!tab.operation })) }
  }
  changed() { if (!this.disposed) { this.layout(); this.onChange() } }
  tab(id, ownerId) {
    const tab = this.tabs.get(id)
    if (!tab || tab.ownerId !== ownerId || !tab.view.webContents || tab.view.webContents.isDestroyed()) throw fault('BROWSER_TAB', '标签不存在或不属于当前会话。')
    return tab
  }
  setMode(id, mode) {
    if (!['agent', 'paused', 'user'].includes(mode)) throw fault('BROWSER_ARGUMENT', '控制模式无效。')
    const owner = this.owner(id); owner.mode = mode; owner.revision++
    if (mode !== 'agent') for (const tab of this.tabs.values()) if (tab.ownerId === id) {
      tab.lastSnapshot = undefined; tab.operation?.abort()
      const contents = tab.view.webContents
      if (contents && !contents.isDestroyed()) {
        contents.stop()
        void contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: 'globalThis.__xiaosheBrowserSnapshot = undefined' }]).catch(() => {})
      }
    }
    this.changed(); return this.status(id)
  }
  mount(id, bounds, activeTab) {
    this.activeOwner = id ? validOwner(id) : undefined
    this.bounds = browserBounds(bounds, this.window.getContentSize(), this.window.webContents.getZoomFactor())
    if (id && activeTab) { this.tab(activeTab, id); this.owner(id).activeTab = activeTab }
    this.layout()
  }
  layout() {
    if (this.disposed || this.window.isDestroyed()) return
    const owner = this.activeOwner ? this.owner(this.activeOwner) : undefined
    const selected = owner?.activeTab ? this.tabs.get(owner.activeTab) : undefined
    const active = selected?.attachmentPending ? undefined : selected
    const layoutKey = JSON.stringify([active?.id, this.bounds, owner?.mode])
    if (this.layoutKey === layoutKey) return
    this.layoutKey = layoutKey
    for (const tab of this.tabs.values()) {
      const visible = tab === active && !!this.bounds
      if (visible) tab.view.setBounds(this.bounds)
      tab.view.setVisible(visible)
    }
    if (active && this.bounds) {
      this.window.contentView.addChildView(active.view)
      this.window.contentView.addChildView(this.shield)
      this.shield.setBounds(this.bounds)
    }
    this.shield.setVisible(!!active && !!this.bounds && owner?.mode !== 'user')
  }
  createTab(ownerId, rawUrl, suppliedOptions) {
    if (this.disposed || this.window.isDestroyed()) throw fault('BROWSER_DISCONNECTED', '专用浏览器工作区已关闭。')
    if (this.tabs.size >= LIMIT || [...this.tabs.values()].filter(tab => tab.ownerId === ownerId).length >= 6) throw fault('BROWSER_LIMIT', '标签数量达到上限，请关闭不再使用的标签。')
    const url = browserUrl(rawUrl, this.productUrl)
    // Electron creates popup WebContents before this callback. Adopt that exact
    // object to retain window.opener/SSO messaging; replacing it throws a native
    // error and strands the parent. Its preferences are constrained below.
    const view = new WebContentsView(suppliedOptions?.webContents ? { webContents: suppliedOptions.webContents }
      : { webPreferences: browserPreferences(this.partition) })
    const wc = view.webContents
    const tab = { id: randomUUID(), ownerId, view, url, title: '新标签页', loading: true, error: '', epoch: 0, operation: undefined, lastSnapshot: undefined,
      attachmentPending: process.platform === 'win32' && !!suppliedOptions?.webContents,
      localOrigin: url.startsWith('http:') ? new URL(url).origin : undefined }
    this.tabs.set(tab.id, tab); this.owner(ownerId).activeTab = tab.id
    view.setBounds({ x: 0, y: 0, width: 1100, height: 760 }); view.setVisible(false)
    const safeNavigation = (event, target) => {
      try {
        const next = browserUrl(target, this.productUrl)
        if (next.startsWith('http:') && new URL(next).origin !== tab.localOrigin) throw new Error('跨本机服务跳转被阻止，请明确打开目标地址。')
      } catch (error) { event.preventDefault(); tab.error = error.message; this.changed() }
    }
    wc.on('will-navigate', safeNavigation); wc.on('will-redirect', safeNavigation)
    wc.on('will-frame-navigate', event => safeNavigation(event, event.url))
    wc.on('did-start-navigation', (_event, target, _inPlace, main) => { if (main) { tab.epoch++; tab.lastSnapshot = undefined; tab.url = target; tab.loading = true; tab.error = ''; this.changed() } })
    wc.on('did-stop-loading', () => { tab.loading = false; tab.url = wc.getURL(); this.changed() })
    wc.on('page-title-updated', (_event, title) => { tab.title = title.slice(0, 200); this.changed() })
    wc.on('did-fail-load', (_event, code, message, _url, main) => { if (main && code !== -3) { tab.error = `网页加载失败（${code}）：${message}`; tab.loading = false; this.changed() } })
    wc.on('render-process-gone', () => { tab.operation?.abort(); tab.error = '网页进程已退出，请重新打开页面。'; tab.loading = false; this.changed() })
    wc.on('will-prevent-unload', event => event.preventDefault())
    wc.setWindowOpenHandler(details => {
      try {
        browserUrl(details.url || 'about:blank', this.productUrl)
        if (this.tabs.size >= LIMIT || [...this.tabs.values()].filter(row => row.ownerId === ownerId).length >= 6) throw new Error('标签数量达到上限')
        return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: { webPreferences: browserPreferences(this.partition) },
          createWindow: options => this.createTab(ownerId, details.url || 'about:blank', options).view.webContents }
      } catch { return { action: 'deny' } }
    })
    wc.on('destroyed', () => { tab.operation?.abort(); this.tabs.delete(tab.id); if (this.owner(ownerId).activeTab === tab.id) this.owner(ownerId).activeTab = [...this.tabs.values()].filter(row => row.ownerId === ownerId).at(-1)?.id; this.changed() })
    // Chromium focuses a newly opened popup before createWindow returns. Keep
    // BOTH native initialization and product attachment deferred on Windows.
    // The supplied contents (and window.opener/SSO state) stay unchanged.
    if (tab.attachmentPending) setImmediate(() => {
      if (this.disposed || this.window.isDestroyed() || wc.isDestroyed()) { this.close(tab); return }
      try { this.attachTab(tab); tab.attachmentPending = false }
      catch (error) { this.notice = error.message }
      this.changed()
    })
    else this.attachTab(tab)
    this.changed(); return tab
  }
  /** Establish real Chromium geometry without presenting a page over product UI.
   * setBounds alone leaves a cold hidden WebContentsView at 0x0 on Windows.
   * A synchronous native attachment/visibility cycle initializes its renderer;
   * the helper never shows, focuses, hosts a renderer of its own, or gains a
   * placeholder lease. No asynchronous gap can expose the page in the host. */
  attachTab(tab) {
    const view = tab.view
    let initializer
    try {
      if (this.disposed || this.window.isDestroyed()) throw new Error('Workspace closed')
      initializer = this.initializer
      if (!initializer || initializer.isDestroyed()) {
        initializer = this.initializer = new BaseWindow({ show: false, focusable: false, skipTaskbar: true, width: 1100, height: 760 })
      }
      initializer.contentView.addChildView(view)
      try { view.setVisible(true) }
      finally {
        view.setVisible(false)
        if (!initializer.isDestroyed()) initializer.contentView.removeChildView(view)
      }
      if (initializer.isDestroyed() || this.window.isDestroyed()) throw new Error('Native host closed during initialization')
      this.window.contentView.addChildView(view)
    } catch {
      // A partial native initialization is not a usable tab. Destroy its own
      // resources; a later explicit open can lazily create a fresh helper.
      try { view.setVisible(false) } catch { /* Native teardown may already have invalidated this view; destroy its owners below. */ }
      if (initializer && !initializer.isDestroyed()) initializer.destroy()
      this.initializer = undefined
      this.close(tab)
      throw fault('BROWSER_INITIALIZATION', '专用浏览器页面初始化失败，请重新打开标签。')
    }
  }
  async debug(tab, method, args = {}, signal) {
    const wc = tab.view.webContents
    check(signal)
    if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }) }
    check(signal)
    return bounded(wc.debugger.sendCommand(method, args), signal)
  }
  async settled(tab, signal) {
    const deadline = Date.now() + 18_000
    while (tab.view.webContents.isLoadingMainFrame()) {
      check(signal)
      if (Date.now() >= deadline) throw fault('BROWSER_LOAD_TIMEOUT', '网页仍未完成加载，请查看页面状态；不自动切到系统浏览器。')
      await delay(80, undefined, { signal }).catch(() => check(signal))
    }
    check(signal)
    if (tab.error) throw fault('BROWSER_LOAD_FAILED', tab.error)
  }
  async snapshot(tab, signal, action) {
    await this.settled(tab, signal)
    const epoch = tab.epoch; const id = randomUUID()
    const deadline = performance.now() + 2_000
    // Native cold initialization runs before attachment. Still bound renderer
    // readiness and read real DOM geometry: never substitute native bounds or
    // override the visible-placeholder lease when Chromium is not ready.
    tab.lastSnapshot = undefined
    const notVisible = () => fault('BROWSER_NOT_VISIBLE', '专用浏览器尚未建立可操作的页面尺寸；请打开专用浏览器面板，等待页面显示后重新观察。')
    for (;;) {
      check(signal)
      if (epoch !== tab.epoch) throw fault('BROWSER_STALE', '页面已跳转，请重新观察。')
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw notVisible()
      const result = await bounded(tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: snapshotScript(id) }]), signal, remaining)
      check(signal)
      if (epoch !== tab.epoch) throw fault('BROWSER_STALE', '页面已跳转，请重新观察。')
      if (performance.now() >= deadline) throw notVisible()
      const width = result?.viewport?.width, height = result?.viewport?.height
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) throw notVisible()
      if (width > 0 && height > 0) {
        tab.lastSnapshot = { id, epoch, at: Date.now(),
          ...(action ? { verification: browserVerificationContract(action.command, action.args, result),
            actionObservation: browserVerificationObservation(result) } : {}) }
        return { ...result, tab_id: tab.id, owner_id: tab.ownerId, physical_input_used: false }
      }
      const wait = Math.min(50, Math.max(0, deadline - performance.now()))
      if (!wait) throw notVisible()
      await delay(wait, undefined, { signal }).catch(() => check(signal))
    }
  }
  async run(tab, actor, signal, operation) {
    const owner = this.owner(tab.ownerId)
    if (actor === 'agent' && owner.mode !== 'agent') throw fault('BROWSER_PAUSED', owner.mode === 'user' ? '用户正在接管浏览器。等待用户点“交给小蛇”，不能自行恢复。' : '浏览器已暂停，等待用户恢复。')
    if (tab.operation) throw fault('BROWSER_BUSY', '这个标签已有操作进行中，请稍后重新观察。')
    const controller = new AbortController(); tab.operation = controller
    const deadline = setTimeout(() => controller.abort(), 28_000)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const contents = tab.view.webContents
    const cancelled = () => { if (!contents.isDestroyed()) contents.stop() }
    combined.addEventListener('abort', cancelled, { once: true }); this.changed()
    try { check(combined); return await bounded(operation(combined), combined, 29_000) }
    catch (error) { controller.abort(); throw error }
    finally { clearTimeout(deadline); combined.removeEventListener('abort', cancelled); if (tab.operation === controller) tab.operation = undefined; this.changed() }
  }
  async agent(ownerId, command, args = {}, signal) {
    validOwner(ownerId)
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fault('BROWSER_ARGUMENT', '浏览器参数必须是对象。')
    if (command === 'status') return this.status(ownerId)
    if (this.owner(ownerId).mode !== 'agent') throw fault('BROWSER_PAUSED', '用户已暂停或接管本会话浏览器，不能自行恢复。')
    if (command === 'open') return this.open(ownerId, args, 'agent', signal)
    const tabId = text(args.tab_id, 'tab_id', 128)
    if (command === 'verify' && args.expect_closed === true) {
      const assertions = browserAssertions(resolveBrowserVerificationInput(args).args)
      const existing = this.tabs.get(tabId)
      if (existing && existing.ownerId !== ownerId) throw fault('BROWSER_TAB', '标签不存在或不属于当前会话。')
      const closed = !existing || existing.view.webContents.isDestroyed()
      return { status: closed ? 'verified' : 'mismatch', tab_id: tabId, owner_id: ownerId, assertions, observed: { closed } }
    }
    const tab = this.tab(tabId, ownerId)
    if (command === 'close') { this.close(tab); return { closed: true, tab_id: tab.id, owner_id: ownerId } }
    return this.run(tab, 'agent', signal, async activeSignal => {
      if (command === 'snapshot') return this.snapshot(tab, activeSignal)
      if (command === 'verify') {
        const baseline = optionalText(args.after_snapshot_id, 'after_snapshot_id', 128)
        if (baseline === undefined) throw fault('BROWSER_ARGUMENT', '页面验证必须指定动作返回的 after_snapshot_id。')
        const last = tab.lastSnapshot
        if (!last || baseline !== last.id || last.epoch !== tab.epoch || Date.now() - last.at > 45_000) throw fault('BROWSER_STALE', '验证基线已过期；请重新执行或重新观察后再行动。')
        const resolved = resolveBrowserVerificationInput(args, last.verification, { ownerId, tabId: tab.id, baselineSnapshotId: last.id })
        const assertions = browserAssertions(resolved.args)
        assertBrowserVerificationContract(last.verification, assertions)
        // Canonical action proof already requires these assertions to match
        // both observations. Reject an impossible baseline assertion before
        // consuming it; a real fresh-DOM mismatch still consumes the baseline.
        if (Object.hasOwn(last, 'actionObservation')) assertBrowserVerificationObservation(last.actionObservation, assertions)
        const current = await this.snapshot(tab, activeSignal)
        const matches = browserSnapshotSatisfies(current, assertions)
        return {
          status: matches ? 'verified' : 'mismatch',
          ...(matches ? {} : { instruction: '本次已独立回读页面且断言不匹配；原 after_snapshot_id 已消费，当前 snapshot_id 只用于后续观察或新动作，不能回填旧动作的验证。请依据真实状态决定下一步，不要盲目重发写入或提交。' }),
          tab_id: tab.id,
          owner_id: ownerId,
          baseline_snapshot_id: baseline,
          // Verification itself creates the latest observation. Expose its
          // ID consistently with other browser results, so a caller need not
          // accidentally reuse the now-stale input baseline on its next act.
          snapshot_id: current.snapshot_id,
          assertions,
          ...(resolved.assertionSource ? { assertion_source: resolved.assertionSource } : {}),
          current,
        }
      }
      if (command === 'screenshot') {
        if (this.artifacts >= 100) throw fault('BROWSER_LIMIT', '本次运行已生成 100 张网页截图，请重启后继续或改用正文读取。')
        await this.settled(tab, activeSignal)
        const result = await this.debug(tab, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, activeSignal)
        check(activeSignal)
        const bytes = Buffer.from(result.data, 'base64')
        if (bytes.length > 10 * 1024 * 1024) throw fault('BROWSER_LIMIT', '网页截图超过 10 MB。')
        const folder = join(this.userDataPath, 'browser-artifacts'); await mkdir(folder, { recursive: true, mode: 0o700 })
        const path = join(folder, `${randomUUID()}.png`); await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }); this.artifacts++
        return { tab_id: tab.id, path, source: 'isolated-browser-only', physical_input_used: false }
      }
      if (command === 'scroll') {
        if (!Number.isInteger(args.delta_y) || Math.abs(args.delta_y) > 2000) throw fault('BROWSER_ARGUMENT', 'delta_y 必须在 -2000 至 2000 之间。')
        await bounded(tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: scrollScript(args.delta_y) }]), activeSignal)
      } else if (['click', 'type', 'press'].includes(command)) {
        // The independent verifier and page value snapshot both cap at 2000.
        // Reject before dispatch instead of applying an unverifiable partial edit.
        if (command === 'type' && (typeof args.text !== 'string' || args.text.length > 2000)) throw fault('BROWSER_ARGUMENT', '输入文字不能超过可独立验证的 2000 字符；未执行输入，不会截断写入。')
        if (command === 'press' && !KEYS.includes(args.key)) throw fault('BROWSER_ARGUMENT', '不支持这个按键。')
        if (args.replace !== undefined && typeof args.replace !== 'boolean') throw fault('BROWSER_ARGUMENT', 'replace 必须为布尔值。')
        const last = tab.lastSnapshot
        if (!last || args.snapshot_id !== last.id || last.epoch !== tab.epoch || Date.now() - last.at > 45_000) throw fault('BROWSER_STALE', '元素快照已过期，请重新读取页面。')
        const point = await bounded(tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: targetScript(last.id, text(args.element_id, 'element_id', 64), command, args.replace) }]), activeSignal)
        check(activeSignal)
        if (command === 'click') {
          await this.debug(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, activeSignal)
          // Release within the private page even if a pause lands between the
          // pair, avoiding a stuck button. Never issue a new press after pause.
          await this.debug(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
        } else if (command === 'type') {
          if (args.text === '' && args.replace) await this.key(tab, 'Backspace', activeSignal)
          else await this.debug(tab, 'Input.insertText', { text: args.text }, activeSignal)
        } else {
          await this.key(tab, args.key, activeSignal)
        }
      } else throw fault('BROWSER_COMMAND', '不支持的浏览器操作。')
      await delay(180, undefined, { signal: activeSignal }).catch(() => check(activeSignal))
      return withBrowserVerificationHint(command, args, await this.snapshot(tab, activeSignal, { command, args }))
    })
  }
  async key(tab, key, signal) {
    const code = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key]
    await this.debug(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) }, signal)
    await this.debug(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
  }
  async open(ownerId, args, actor, signal) {
    const url = browserUrl(text(args.url, 'url'), this.productUrl)
    if (actor === 'agent' && url.length > 2048) throw fault('BROWSER_ARGUMENT', '网址超过可独立验证的 2048 字符；未创建或导航标签。')
    if (actor === 'user') this.setMode(ownerId, 'user')
    const tab = args.tab_id ? this.tab(args.tab_id, ownerId) : this.createTab(ownerId, url)
    // Takeover abort is synchronous but the old promise unwinds on a microtask.
    if (actor === 'user' && tab.operation) await delay(0)
    tab.localOrigin = url.startsWith('http:') ? new URL(url).origin : undefined
    return this.run(tab, actor, signal, async activeSignal => {
      const loading = tab.view.webContents.loadURL(url)
      const timeout = setTimeout(() => tab.operation?.abort(), 22_000)
      try { await bounded(loading, activeSignal); check(activeSignal); return actor === 'agent'
        ? withBrowserVerificationHint('open', args, await this.snapshot(tab, activeSignal, { command: 'open', args })) : this.status(ownerId) }
      finally { clearTimeout(timeout) }
    })
  }
  close(tab) {
    tab.operation?.abort()
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
  }
  async ui(ownerId, action, args = {}) {
    validOwner(ownerId)
    if (action === 'status') return this.status(ownerId)
    if (action === 'mode') return this.setMode(ownerId, args.mode)
    if (action === 'desktop') { this.owner(ownerId).desktopUntil = args.allowed === true ? Date.now() + 600_000 : 0; this.changed(); return this.status(ownerId) }
    if (action === 'open') return this.open(ownerId, args, 'user')
    if (action === 'select') { this.tab(args.tab_id, ownerId); this.owner(ownerId).activeTab = args.tab_id; this.changed(); return this.status(ownerId) }
    if (action === 'close') { this.close(this.tab(args.tab_id, ownerId)); return this.status(ownerId) }
    if (['back', 'forward', 'reload'].includes(action)) {
      const tab = this.tab(args.tab_id, ownerId); this.setMode(ownerId, 'user')
      if (action === 'reload') tab.view.webContents.reload()
      else if (action === 'back' && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack()
      else if (action === 'forward' && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward()
      return this.status(ownerId)
    }
    throw fault('BROWSER_COMMAND', '不支持的用户操作。')
  }
  async dispose() {
    if (this.disposed) return
    this.disposed = true; this.window.removeListener('resize', this.resizeHandler)
    for (const tab of [...this.tabs.values()]) this.close(tab)
    if (this.initializer && !this.initializer.isDestroyed()) this.initializer.destroy()
    this.initializer = undefined
    this.shield.webContents.close({ waitForBeforeUnload: false })
    this.session.webRequest.onBeforeRequest(null); this.session.removeListener('will-download', this.downloadHandler)
    await this.session.cookies.flushStore()
    this.session.flushStorageData()
  }
}
