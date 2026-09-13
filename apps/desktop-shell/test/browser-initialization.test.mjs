import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Native ownership/failure boundaries only. Actual Chromium geometry is covered
// by run-browser-cold-start-acceptance.mjs, never inferred from these doubles.
const windows = [], contents = []
let failInitialization = false, failHiding = false
class NativeHost extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.destroyed = false; this.children = new Set(); windows.push(this)
    this.contentView = {
      addChildView: view => { view.parent?.children.delete(view); view.parent = this; this.children.add(view) },
      removeChildView: view => { this.children.delete(view); if (view.parent === this) view.parent = undefined },
    }
    this.webContents = { getZoomFactor: () => 1 }
  }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.options.show === true }
  getContentSize() { return [1400, 900] }
  destroy() { this.destroyed = true; for (const view of this.children) view.parent = undefined; this.children.clear() }
  show() { assert.fail('initialization must never show a native window') }
  showInactive() { assert.fail('initialization must never show an inactive native window') }
  focus() { assert.fail('initialization must never focus a native window') }
}
class Contents extends EventEmitter {
  constructor() { super(); this.id = contents.length + 1; this.destroyed = false; contents.push(this) }
  isDestroyed() { return this.destroyed }
  loadURL() { return Promise.resolve() }
  setWindowOpenHandler(handler) { this.popup = handler }
  stop() {}
  executeJavaScriptInIsolatedWorld() { return Promise.resolve() }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed') } }
}
class View {
  constructor(options) { this.webContents = options?.webContents ?? new Contents(); this.initialized = false }
  setBackgroundColor() {}
  setBounds(bounds) { this.bounds = bounds }
  setVisible(visible) {
    if (!visible && failHiding && this.parent?.options.focusable === false) throw new Error('native hide failed')
    if (visible && this.parent) {
      if (this.parent.options.show === true) assert.fail('unleased page was exposed over the visible host')
      if (failInitialization && this.parent.options.focusable === false) throw new Error('native initialization failed')
      this.initialized = true
    }
    this.visible = visible
  }
}
const nativeSession = new EventEmitter()
Object.assign(nativeSession, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
  webRequest: { onBeforeRequest() {} }, cookies: { async flushStore() {} }, flushStorageData() {} })
globalThis.__browserInitializationNative = { BaseWindow: NativeHost, WebContentsView: View, session: { fromPartition: () => nativeSession } }
const moduleUrl = 'data:text/javascript,' + encodeURIComponent('export const {BaseWindow,WebContentsView,session}=globalThis.__browserInitializationNative')
const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === 'electron' ? { url: moduleUrl, shortCircuit: true } : next(specifier, context) } })
const { BrowserWorkspace } = await import('../src/browser-workspace.mjs')
hooks.deregister(); delete globalThis.__browserInitializationNative

function fixture(t, visible = false) {
  windows.length = 0; contents.length = 0; failInitialization = false; failHiding = false
  const host = new NativeHost({ show: visible })
  const workspace = new BrowserWorkspace({ window: host, productUrl: 'http://127.0.0.1:38991', userDataPath: 'unused' })
  t.after(async () => { failInitialization = false; await workspace.dispose() })
  return { host, workspace }
}
test('cold tabs initialize without exposing the page over a visible or hidden host', async t => {
  for (const visible of [false, true]) await t.test(String(visible), async t => {
    const { host, workspace } = fixture(t, visible)
    assert.equal(windows.length, 1, 'the initialization host is lazy')
    for (let i = 0; i < 2; i++) {
      const tab = workspace.createTab('owner', 'https://example.org/')
      assert.equal(tab.view.initialized, true, 'a cold page needs native initialization')
      assert.equal(tab.view.parent, host); assert.equal(tab.view.visible, false)
      assert.equal(workspace.bounds, undefined); assert.equal(workspace.activeOwner, undefined)
    }
    assert.equal(windows.length, 2, 'one reusable native initialization host')
    assert.equal(windows[1].options.show, false); assert.equal(windows[1].options.focusable, false)
    assert.equal(windows[1].children.size, 0)
  })
})
test('native initialization failure closes the new contents and leaves no live helper or orphan tab', async t => {
  const { host, workspace } = fixture(t)
  failInitialization = true
  assert.throws(() => workspace.createTab('owner', 'https://example.org/'), /初始化|initialization/)
  assert.equal(workspace.tabs.size, 0); assert.equal(workspace.owner('owner').activeTab, undefined)
  assert.equal(contents.at(-1).isDestroyed(), true)
  assert.equal(host.children.size, 1, 'only the shield remains')
  assert.ok(windows.slice(1).every(window => window.isDestroyed()))
})
test('destroyed initialization host is replaced and dispose destroys its replacement', async t => {
  const { workspace } = fixture(t)
  workspace.createTab('owner', 'https://example.org/')
  assert.equal(windows.length, 2)
  windows[1].destroy()
  const tab = workspace.createTab('owner', 'https://example.org/')
  assert.equal(tab.view.initialized, true); assert.equal(windows.length, 3)
  await workspace.dispose(); assert.equal(windows[2].isDestroyed(), true)
})
test('a broken native hide cannot bypass helper and page destruction', async t => {
  const { workspace } = fixture(t)
  failHiding = true
  assert.throws(() => workspace.createTab('owner', 'https://example.org/'), /初始化/)
  assert.equal(workspace.tabs.size, 0); assert.equal(contents.at(-1).isDestroyed(), true)
  assert.ok(windows.slice(1).every(window => window.isDestroyed()))
})
test('supplied popup contents are retained and Windows attachment stays deferred', async t => {
  const { host, workspace } = fixture(t)
  const popup = new Contents()
  const tab = workspace.createTab('owner', 'https://example.org/', { webContents: popup })
  assert.equal(tab.view.webContents, popup)
  if (process.platform === 'win32') { assert.equal(tab.view.parent, undefined); assert.equal(tab.view.initialized, false) }
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(tab.view.initialized, true); assert.equal(tab.view.parent, host); assert.equal(tab.attachmentPending, false)
})
test('destroying the product host before deferred attachment closes the pending popup', async t => {
  if (process.platform !== 'win32') return
  const { host, workspace } = fixture(t)
  const popup = new Contents(); workspace.createTab('owner', 'https://example.org/', { webContents: popup })
  host.destroy(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(popup.isDestroyed(), true); assert.equal(workspace.tabs.size, 0)
})
test('deferred popup initialization failure is contained and closes its supplied contents', async t => {
  if (process.platform !== 'win32') return
  const { workspace } = fixture(t)
  const popup = new Contents(); workspace.createTab('owner', 'https://example.org/', { webContents: popup })
  failInitialization = true
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(popup.isDestroyed(), true); assert.equal(workspace.tabs.size, 0)
  assert.match(workspace.notice, /初始化/)
})
test('paused and user modes cannot create a tab or initialize a native host', async t => {
  const { workspace } = fixture(t)
  for (const mode of ['paused', 'user']) {
    workspace.setMode('owner', mode)
    await assert.rejects(workspace.agent('owner', 'open', { url: 'https://example.org/' }), { code: 'BROWSER_PAUSED' })
    assert.equal(workspace.owner('owner').mode, mode); assert.equal(workspace.tabs.size, 0); assert.equal(windows.length, 1)
  }
})
