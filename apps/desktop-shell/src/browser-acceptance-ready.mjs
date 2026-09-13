import { setTimeout as delay } from 'node:timers/promises'

// Prepare only the empty dock through normal UI, never a business page or write.
export function inspectAcceptanceBrowser(doc, sessionId, openDock = false) {
  const composer = doc.querySelector('.xsla-shell form.cbox textarea[name="content"]')
  const selected = [...doc.querySelectorAll('[data-session-id].on')].some(el => el.dataset.sessionId === sessionId)
  const interactive = !!composer && !composer.disabled && composer.isConnected && composer.getClientRects().length > 0
    && !composer.closest('[inert],[hidden],[aria-hidden="true"]') && !doc.querySelector('[role="dialog"][aria-modal="true"]')
  let dock = doc.querySelector('#xsla-browser-dock')
  if (openDock && !dock && selected && interactive && doc.visibilityState === 'visible') {
    const buttons = [...doc.querySelectorAll('button[aria-controls="xsla-browser-dock"]')]
    if (buttons.length === 1 && !buttons[0].disabled && buttons[0].getAttribute('aria-expanded') === 'false') buttons[0].click()
    dock = doc.querySelector('#xsla-browser-dock')
  }
  const rect = dock?.querySelector('.browser-page-slot')?.getBoundingClientRect()
  return { visibility: doc.visibilityState, selected, interactive, dockPresent: !!dock,
    slot: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null }
}
export function validAcceptanceBrowserEnvironment({ windowVisible, minimized, dom, activeOwner, bounds }, sessionId) {
  const size = rect => !!rect && Number.isFinite(rect.width) && rect.width > 100 && Number.isFinite(rect.height) && rect.height > 100
  return windowVisible === true && minimized === false && dom?.visibility === 'visible' && dom.selected === true
    && dom.interactive === true && dom.dockPresent === true && size(dom.slot) && size(bounds) && activeOwner === sessionId
}
export async function prepareAcceptanceBrowser({ target, workspace, sessionId, onObservation = () => {} }) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const native = { windowVisible: target.isVisible(), minimized: target.isMinimized() }
    let timer, dom
    try {
      dom = await Promise.race([
        target.webContents.executeJavaScript(`(${inspectAcceptanceBrowser.toString()})(document,${JSON.stringify(sessionId)},${native.windowVisible && !native.minimized})`),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('browser preparation renderer did not respond before paid prompt')), 5000) }),
      ])
    } finally { clearTimeout(timer) }
    const value = { ...native, dom, activeOwner: workspace.activeOwner, bounds: workspace.bounds ? { ...workspace.bounds } : null, at: new Date().toISOString() }
    await onObservation(value)
    if (!native.windowVisible || native.minimized || dom.visibility !== 'visible') throw new Error('acceptance window is hidden; browser preparation stopped before paid prompt')
    if (validAcceptanceBrowserEnvironment(value, sessionId)) return value
    await delay(100)
  }
  throw new Error('owned browser dock did not acquire a real mounted viewport before paid prompt')
}
export async function captureAcceptancePng(contents) {
  const image = await contents.capturePage(), size = image.getSize()
  if (image.isEmpty() || !Number.isFinite(size.width) || size.width <= 0 || !Number.isFinite(size.height) || size.height <= 0) throw new Error('native capture returned an empty image')
  const png = image.toPNG()
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('native capture returned invalid PNG bytes')
  return png
}

/** A background tab can have a DOM but no capturable compositor surface.
 * Select through the existing UI action before an independent screenshot;
 * never focus/show the window, navigate, submit, or change control mode. */
export async function prepareAcceptanceTabCapture({ target, workspace, sessionId, tab, expectedUrl }) {
  const assertOwner = () => {
    if (!target.isVisible() || target.isMinimized() || workspace.activeOwner !== sessionId
      || workspace.tabs.get(tab?.id) !== tab || tab.ownerId !== sessionId || tab.operation
      || tab.view.webContents.isDestroyed() || tab.view.webContents.getURL() !== expectedUrl) {
      throw new Error('independent capture requires an idle owned visible tab')
    }
  }
  assertOwner()
  let domTimer, dom
  try {
    dom = await Promise.race([
      target.webContents.executeJavaScript(`(${inspectAcceptanceBrowser.toString()})(document,${JSON.stringify(sessionId)},false)`),
      new Promise((_, reject) => { domTimer = setTimeout(() => reject(new Error('independent capture host renderer did not respond')), 3000) }),
    ])
  } finally { clearTimeout(domTimer) }
  if (!validAcceptanceBrowserEnvironment({ windowVisible: target.isVisible(), minimized: target.isMinimized(),
    dom, activeOwner: workspace.activeOwner, bounds: workspace.bounds }, sessionId)) throw new Error('independent capture dock is not visible')
  const mode = workspace.status(sessionId).mode
  await workspace.ui(sessionId, 'select', { tab_id: tab.id })
  assertOwner()
  if (workspace.status(sessionId).active_tab !== tab.id || workspace.status(sessionId).mode !== mode
    || !tab.view.getVisible()) throw new Error('independent capture tab selection was not applied')
  let timer, viewport
  try {
    viewport = await Promise.race([
      tab.view.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({width:innerWidth,height:innerHeight,visibility:document.visibilityState,url:location.href}))))'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('independent capture paint did not settle')), 3000) }),
    ])
  } finally { clearTimeout(timer) }
  assertOwner()
  const bounds = tab.view.getBounds(), status = workspace.status(sessionId)
  if (status.active_tab !== tab.id || status.mode !== mode || !tab.view.getVisible()
    || ![bounds, viewport].every(value => Number.isFinite(value?.width) && value.width > 100
      && Number.isFinite(value?.height) && value.height > 100)
    || viewport.visibility !== 'visible' || viewport.url !== expectedUrl) throw new Error('independent capture lost its mounted viewport')
  return { tabId: tab.id, url: expectedUrl, mode, bounds, viewport, selectedAt: new Date().toISOString() }
}
