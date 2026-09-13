import test from 'node:test'
import assert from 'node:assert/strict'
import { captureAcceptancePng, inspectAcceptanceBrowser, prepareAcceptanceBrowser, prepareAcceptanceTabCapture, validAcceptanceBrowserEnvironment } from '../src/browser-acceptance-ready.mjs'
const valid = () => ({ windowVisible: true, minimized: false, activeOwner: 'owned', bounds: { width: 600, height: 500 },
  dom: { visibility: 'visible', selected: true, interactive: true, dockPresent: true, slot: { width: 600, height: 500 } } })
test('preflight requires visible same-session dock and finite real geometry', () => {
  assert.equal(validAcceptanceBrowserEnvironment(valid(), 'owned'), true)
  for (const change of [v => { v.windowVisible = false }, v => { v.minimized = true }, v => { v.activeOwner = 'foreign' },
    v => { v.dom.visibility = 'hidden' }, v => { v.dom.selected = false }, v => { v.dom.interactive = false },
    v => { v.dom.dockPresent = false }, v => { v.dom.slot.width = 0 }, v => { v.bounds.height = NaN }, v => { v.bounds.width = Infinity }]) {
    const value = valid(); change(value); assert.equal(validAcceptanceBrowserEnvironment(value, 'owned'), false)
  }
})
test('hidden window fails before dispatch; no show, navigation or tools required', async () => {
  let observations = 0
  const target = { isVisible: () => false, isMinimized: () => false, webContents: { executeJavaScript: async () => ({ ...valid().dom, visibility: 'hidden' }) } }
  await assert.rejects(prepareAcceptanceBrowser({ target, workspace: {}, sessionId: 'owned', onObservation: () => observations++ }), /before paid prompt/u)
  assert.equal(observations, 1)
})
test('only selected interactive exact dock launcher is clicked', () => {
  let clicked = 0
  const composer = { disabled: false, isConnected: true, getClientRects: () => [1], closest: () => null }
  const button = { disabled: false, getAttribute: () => 'false', click: () => clicked++ }
  const doc = { visibilityState: 'visible', querySelector: s => s.includes('textarea') ? composer : null,
    querySelectorAll: s => s === '[data-session-id].on' ? [{ dataset: { sessionId: 'owned' } }] : [button] }
  inspectAcceptanceBrowser(doc, 'foreign', true); assert.equal(clicked, 0)
  doc.visibilityState = 'hidden'; inspectAcceptanceBrowser(doc, 'owned', true); assert.equal(clicked, 0)
  doc.visibilityState = 'visible'; inspectAcceptanceBrowser(doc, 'owned', true); assert.equal(clicked, 1)
})
test('empty images cannot become screenshot evidence', async () => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)])
  const capture = value => ({ capturePage: async () => value })
  const image = { isEmpty: () => false, getSize: () => ({ width: 400, height: 300 }), toPNG: () => png }
  assert.deepEqual(await captureAcceptancePng(capture(image)), png)
  for (const value of [{ ...image, isEmpty: () => true }, { ...image, getSize: () => ({ width: 0, height: 10 }) },
    { ...image, toPNG: () => Buffer.alloc(0) }]) await assert.rejects(captureAcceptancePng(capture(value)), /empty|invalid/u)
})

function tabCaptureFixture() {
  const expectedUrl = 'http://127.0.0.1:49201/owned/', calls = []
  let active = 'other', visible = false
  const tab = { id: 'first', ownerId: 'owned', view: { getVisible: () => visible,
    getBounds: () => ({ width: 600, height: 500 }), webContents: { isDestroyed: () => false,
      getURL: () => expectedUrl, executeJavaScript: async () => ({ width: 600, height: 500, visibility: 'visible', url: expectedUrl }) } } }
  const target = { isVisible: () => true, isMinimized: () => false,
    webContents: { executeJavaScript: async () => valid().dom } }
  const workspace = { activeOwner: 'owned', bounds: valid().bounds, tabs: new Map([[tab.id, tab]]),
    status: () => ({ active_tab: active, mode: 'agent' }),
    ui: async (...args) => { calls.push(args); active = tab.id; visible = true } }
  return { target, workspace, sessionId: 'owned', tab, expectedUrl, calls }
}
test('independent page capture selects an existing tab without any focus, navigation, or control change', async () => {
  const f = tabCaptureFixture(), result = await prepareAcceptanceTabCapture(f)
  assert.deepEqual(f.calls, [['owned', 'select', { tab_id: 'first' }]])
  assert.equal(result.tabId, 'first'); assert.equal(result.mode, 'agent')
  assert.equal(result.viewport.url, f.expectedUrl)
})
test('capture selection fails closed for hidden, foreign, busy, detached, or changed tabs', async () => {
  for (const mutate of [f => { f.target.isVisible = () => false }, f => { f.workspace.activeOwner = 'foreign' },
    f => { f.tab.ownerId = 'foreign' }, f => { f.tab.operation = {} }, f => { f.workspace.tabs.clear() },
    f => { f.tab.view.webContents.getURL = () => 'https://foreign.invalid/' },
    f => { f.workspace.ui = async () => {} }, f => { f.tab.view.webContents.executeJavaScript = async () => ({ width: 0, height: 0 }) },
    f => { f.tab.view.webContents.executeJavaScript = async () => { f.target.isVisible = () => false; return {} } }]) {
    const f = tabCaptureFixture(); mutate(f)
    await assert.rejects(prepareAcceptanceTabCapture(f), /capture/u)
  }
})
test('a stalled host renderer cannot leave independent capture waiting indefinitely', async () => {
  const f = tabCaptureFixture(), started = Date.now()
  f.target.webContents.executeJavaScript = () => new Promise(() => {})
  await assert.rejects(prepareAcceptanceTabCapture(f), /host renderer did not respond/u)
  assert.ok(Date.now() - started < 6000)
  assert.deepEqual(f.calls, [])
})
