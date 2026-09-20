/** Real Electron/DOM cold-start regression. No window is ever shown or focused. */
import { app, BaseWindow, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserWorkspace } from '../src/browser-workspace.mjs'

const output = resolve(process.argv[2] || 'output/acceptance/browser-cold-start')
const profile = await mkdtemp(join(tmpdir(), 'xiaoshe-cold-browser-'))
app.setPath('userData', profile)
const checks = [], nativeEvents = []
app.on('window-all-closed', () => {})
app.on('browser-window-focus', (_event, window) => nativeEvents.push({ event: 'focus', id: window.id }))
app.on('browser-window-created', (_event, window) => window.on('show', () => nativeEvents.push({ event: 'show', id: window.id })))
let host, workspace, server, success = false
const guard = setTimeout(() => { void writeFile(join(output, 'timeout.json'), JSON.stringify({ checks, nativeEvents })).finally(() => app.exit(2)) }, 60000)
async function step(name, run) { const detail = await run(); checks.push({ name, passed: true, ...detail }) }
async function run() {
try {
  await mkdir(output, { recursive: true }); await app.whenReady()
  server = createServer((request, response) => {
    if (request.url === '/slow') { request.on('close', () => response.destroy()); return }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(request.url.startsWith('/popup') ? '<h1>Cold popup</h1><script>if(window.opener)window.opener.postMessage("cold-popup-ready",location.origin)</script>'
      : '<!doctype html><style>body{margin:25px;font:20px sans-serif}input,button{font:inherit;padding:10px}</style><h1>Cold browser fixture</h1><input aria-label="Fixture input"><button onclick="document.querySelector(\'p\').textContent=\'Saved: \'+document.querySelector(\'input\').value">Save</button><p>Idle</p><button onclick="window.open(\'/popup\',\'cold-popup\')">Popup</button><script>window.addEventListener("message",e=>{if(e.origin===location.origin)window.popupReply=e.data})</script>')
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const url = `http://127.0.0.1:${server.address().port}/`, owner = 'cold-browser-owner'
  host = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false } })
  workspace = new BrowserWorkspace({ window: host, productUrl: 'http://127.0.0.1:38991', userDataPath: profile, partition: 'cold-browser-fixture' })
  const call = (command, args, signal) => workspace.agent(owner, command, args, signal)
  let snapshot
  const element = name => { const row = snapshot.elements.find(row => row.name === name); assert.ok(row, name); return { tab_id: snapshot.tab_id, snapshot_id: snapshot.snapshot_id, element_id: row.element_id } }
  await step('first unmounted open uses actual nonzero DOM geometry and independent verification', async () => {
    snapshot = await call('open', { url })
    assert.ok(snapshot.viewport.width > 0 && snapshot.viewport.height > 0)
    const tab = workspace.tab(snapshot.tab_id, owner)
    const dom = await tab.view.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})')
    assert.equal(snapshot.viewport.width, dom.width); assert.equal(snapshot.viewport.height, dom.height)
    const proof = await call('verify', snapshot.next_verification.arguments); assert.equal(proof.status, 'verified'); snapshot = proof.current
    assert.equal(host.isVisible(), false); assert.equal(tab.view.getVisible(), false); assert.equal(workspace.bounds, undefined)
    return { viewport: snapshot.viewport }
  })
  await step('unmounted snapshot type click and independent verify retain actual saved text', async () => {
    snapshot = await call('snapshot', { tab_id: snapshot.tab_id })
    snapshot = await call('type', { ...element('Fixture input'), text: 'cold hidden input', replace: true })
    let proof = await call('verify', snapshot.next_verification.arguments); assert.equal(proof.status, 'verified'); snapshot = proof.current
    snapshot = await call('click', element('Save'))
    proof = await call('verify', { tab_id: snapshot.tab_id, after_snapshot_id: snapshot.snapshot_id, expect_text: 'Saved: cold hidden input' })
    assert.equal(proof.status, 'verified'); snapshot = proof.current
  })
  await step('popup retains opener and initializes after deferred attachment without native focus', async () => {
    const before = nativeEvents.length
    snapshot = await call('click', element('Popup')); await delay(200)
    const popup = [...workspace.tabs.values()].find(tab => tab.id !== snapshot.tab_id); assert.ok(popup)
    const observation = await call('snapshot', { tab_id: popup.id }); assert.ok(observation.viewport.width > 0)
    assert.equal(await popup.view.webContents.executeJavaScript('Boolean(window.opener)'), true)
    assert.equal(await workspace.tab(snapshot.tab_id, owner).view.webContents.executeJavaScript('window.popupReply'), 'cold-popup-ready')
    assert.equal(nativeEvents.length, before); workspace.close(popup)
  })
  await step('cancellation and user takeover stop slow navigation without resuming control', async () => {
    const controller = new AbortController()
    const opening = call('open', { url: url + 'slow', tab_id: snapshot.tab_id }, controller.signal)
    setTimeout(() => controller.abort(), 100); await assert.rejects(opening, { code: 'BROWSER_CANCELLED' })
    for (const mode of ['paused', 'user']) {
      // Only the synthetic user's UI path returns control between test cases.
      await workspace.ui(owner, 'mode', { mode: 'agent' })
      const pending = call('open', { url: url + 'slow', tab_id: snapshot.tab_id })
      setTimeout(() => { void workspace.ui(owner, 'mode', { mode }) }, 100)
      await assert.rejects(pending, { code: 'BROWSER_CANCELLED' })
      await assert.rejects(call('open', { url }), { code: 'BROWSER_PAUSED' })
      await assert.rejects(call('snapshot', { tab_id: snapshot.tab_id }), { code: 'BROWSER_PAUSED' })
      assert.equal(workspace.status(owner).mode, mode)
    }
  })
  await step('workspace dispose destroys the initialization host and every owned page', async () => {
    const owned = [...workspace.tabs.values()].map(tab => tab.view.webContents)
    const initializerWindows = BaseWindow.getAllWindows().filter(window => window.id !== host.id)
    assert.equal(initializerWindows.length, 1); assert.equal(initializerWindows[0].isVisible(), false)
    await workspace.dispose(); workspace = undefined; await delay(100)
    assert.ok(owned.every(contents => contents.isDestroyed())); assert.ok(initializerWindows.every(window => window.isDestroyed()))
    assert.deepEqual(nativeEvents, [])
  })
  success = true
} catch (error) {
  checks.push({ passed: false, error: error.message, code: error.code, stack: error.stack })
} finally {
  clearTimeout(guard); await workspace?.dispose(); host?.destroy(); server?.closeAllConnections(); server?.close()
  await writeFile(join(output, 'report.json'), JSON.stringify({ accepted: success, electron: process.versions.electron, pid: process.pid,
    checks, nativeEvents, profile, visibleHostScenario: 'not-run-no-visible-window-authorization', realUserApplicationTouched: false }, null, 2))
  app.exit(success ? 0 : 1)
}
}
void run()
