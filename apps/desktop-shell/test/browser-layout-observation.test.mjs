import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { browserLayoutObservation, createBrowserLayoutReporter } from '../src/browser-layout-observation.mjs'
import { browserBounds, trustedBrowserSender } from '../src/browser-policy.mjs'

const state = { source: 'renderer', reason: 'layout-visible', ownerPresent: true, boundsPresent: true, selectedTabPresent: false,
  windowVisible: true, minimized: false, applicationHidden: false }
const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
const handlerStart = main.indexOf("  ipcMain.on('xiaoshe:browser-bounds'")
const handlerEnd = main.indexOf("  target.webContents.on('render-process-gone'", handlerStart)
assert.ok(handlerStart > 0 && handlerEnd > handlerStart)
const handlerSource = main.slice(handlerStart, handlerEnd)
const observationStart = main.indexOf('function observeBrowserLayout(')
const observationEnd = main.indexOf('\nfunction openBrowserLink(', observationStart)
assert.ok(observationStart > 0 && observationEnd > observationStart)
const observationSource = main.slice(observationStart, observationEnd)

test('layout facts retain only finite reasons and non-identifying booleans', () => {
  const facts = browserLayoutObservation({ ...state, ownerId: 'private-session', url: 'https://private.invalid', text: 'PRIVATE', bounds: { width: 123 }, input: 'SECRET' })
  assert.equal(facts.rendererReportedReason, 'layout-visible'); assert.equal(facts.boundsPresent, true)
  assert.equal(facts.selectedTabPresent, false, 'bounds do not prove a native page exists')
  assert.ok(Object.isFrozen(facts))
  for (const reason of [undefined, null, {}, 'SECRET\n'.repeat(1000), 'lease-expired', { toString() { throw new Error('must not stringify input') } }]) {
    const value = browserLayoutObservation({ ...state, reason })
    assert.equal(value.rendererReportedReason, 'renderer-unspecified')
    assert.doesNotMatch(JSON.stringify(value), /SECRET|PRIVATE|https|private-session/u)
  }
  const host = browserLayoutObservation({ ...state, source: 'host', reason: 'lease-expired' })
  assert.equal(host.hostReason, 'lease-expired'); assert.equal(host.rendererReportedReason, undefined)
  assert.equal(browserLayoutObservation({ ...state, windowVisible: 'true' }).windowVisible, null)
})

test('logging deduplicates steady heartbeats but retains transitions, source and native visibility changes', () => {
  const rows = [], report = createBrowserLayoutReporter(row => rows.push(row), { now: () => '2026-09-08T00:00:00.000Z' })
  for (let i = 0; i < 100; i++) report(state)
  assert.equal(rows.length, 1)
  report({ ...state, reason: 'document-hidden', boundsPresent: false })
  report(state)
  report({ ...state, windowVisible: false })
  report({ ...state, minimized: true })
  report({ ...state, applicationHidden: true })
  report({ ...state, source: 'host', reason: 'bind' })
  report({ ...state, source: 'host', reason: 'lease-expired' })
  assert.deepEqual(rows.map(row => row.sequence), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.ok(rows.every(row => row.observedAt === '2026-09-08T00:00:00.000Z' && Object.isFrozen(row)))
})

test('synchronous and asynchronous logging failures never escape to product actions', async () => {
  for (const sink of [() => { throw new Error('disk'); }, async () => { throw new Error('disk'); }]) {
    const report = createBrowserLayoutReporter(sink)
    assert.doesNotThrow(() => { report(state); report({ ...state, boundsPresent: false }) })
  }
  await new Promise(resolve => setImmediate(resolve))
})

function handlerFixture(sink) {
  const ipcMain = new EventEmitter(), rows = [], mounts = [], timers = [], cleared = []
  const contents = { mainFrame: { url: 'http://127.0.0.1:49200/' } }
  const workspace = { activeOwner: 'owner', bounds: undefined, owners: new Map([['owner', {}]]), tabs: new Map(),
    mount(owner, bounds) { mounts.push({ owner, bounds }); this.activeOwner = owner; this.bounds = browserBounds(bounds, [1400, 900], 1) } }
  const context = vm.createContext({ ipcMain, target: { webContents: contents }, ORIGIN: 'http://127.0.0.1:49200',
    browserWorkspace: workspace, browserOwner: 'owner', browserBoundsTimer: undefined, trustedBrowserSender,
    window: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false }, app: { isHidden: () => false }, process: { platform: 'darwin' },
    reportBrowserLayout: createBrowserLayoutReporter(sink ?? (row => rows.push(row))),
    clearTimeout: value => cleared.push(value), setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer } })
  vm.runInContext(observationSource + '\n' + handlerSource, context)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const send = (request, from = event) => ipcMain.emit('xiaoshe:browser-bounds', from, request)
  return { rows, mounts, timers, cleared, workspace, event, send }
}

test('actual main IPC keeps sender/owner checks and renews every heartbeat despite log deduplication', () => {
  const f = handlerFixture(), bounds = { x: 300, y: 50, width: 600, height: 600 }
  for (let i = 0; i < 100; i++) f.send({ ownerId: 'owner', bounds, reason: 'layout-visible' })
  assert.equal(f.mounts.length, 100); assert.equal(f.timers.length, 100); assert.equal(f.cleared.length, 100)
  assert.ok(f.timers.every(row => row.ms === 1800))
  assert.ok(f.mounts.every(row => row.owner === 'owner' && row.bounds === bounds), 'diagnostics never replace mounting arguments')
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].boundsPresent, true); assert.equal(f.rows[0].selectedTabPresent, false)
  f.send({ ownerId: 'wrong', bounds, reason: 'modal-present' })
  f.send({ ownerId: 'owner', bounds }, { ...f.event, sender: {} })
  f.send({ ownerId: 'owner', bounds }, { ...f.event, senderFrame: { url: f.event.senderFrame.url } })
  assert.equal(f.mounts.length, 100); assert.equal(f.timers.length, 100); assert.equal(f.rows.length, 1)
  f.timers.at(-1).fn()
  assert.deepEqual(f.mounts.at(-1), { owner: undefined, bounds: undefined })
  assert.equal(f.rows.at(-1).hostReason, 'lease-expired'); assert.equal(f.rows.at(-1).boundsPresent, false)
})

test('actual main reports rejected geometry truthfully and logging failures leave mount and lease intact', async () => {
  const f = handlerFixture()
  f.send({ ownerId: 'owner', bounds: { x: 1399, y: 0, width: 600, height: 600 }, reason: 'layout-visible' })
  assert.equal(f.rows[0].rendererReportedReason, 'layout-visible'); assert.equal(f.rows[0].boundsPresent, false)
  for (const sink of [() => { throw new Error('disk') }, async () => { throw new Error('disk') }]) {
    const failed = handlerFixture(sink)
    assert.doesNotThrow(() => failed.send({ ownerId: 'owner', reason: 'document-hidden' }))
    assert.equal(failed.mounts.length, 1); assert.equal(failed.timers[0].ms, 1800)
    assert.doesNotThrow(() => failed.timers[0].fn()); assert.equal(failed.mounts.length, 2)
  }
  await new Promise(resolve => setImmediate(resolve))
})

test('actual preload transports only the optional reason addition and supports old two-argument callers', async () => {
  const source = await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'), ipcRenderer = new EventEmitter(), rows = []
  let exposed
  ipcRenderer.send = (channel, value) => rows.push({ channel, value })
  const context = vm.createContext({ require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value } } }),
    process: { platform: 'darwin' }, document: { readyState: 'loading' }, window: { addEventListener() {} }, setInterval() {}, queueMicrotask })
  vm.runInContext(source, context)
  const bounds = { x: 10, y: 10, width: 500, height: 400 }
  exposed.browser.bounds('owner', bounds, 'layout-visible')
  exposed.browser.bounds('owner', undefined, 'document-hidden')
  exposed.browser.bounds('owner', bounds)
  assert.deepEqual(Object.keys(exposed.browser), ['request', 'bounds', 'subscribe'])
  assert.equal(rows[0].channel, 'xiaoshe:browser-bounds'); assert.equal(rows[0].value.bounds, bounds)
  assert.equal(rows[0].value.reason, 'layout-visible'); assert.equal(rows[1].value.bounds, undefined)
  assert.equal(rows[1].value.reason, 'document-hidden'); assert.equal(rows[2].value.reason, undefined)
  assert.equal(rows[2].value.bounds, bounds)
})

test('all existing non-IPC invalidation paths record distinct host observations after their original mounts', () => {
  assert.match(main, /mount\(undefined, undefined\); observeBrowserLayout\('host', 'navigation'\)/u)
  assert.match(main, /mount\(ownerId, undefined\); observeBrowserLayout\('host', 'bind'\)/u)
  for (const reason of ['renderer-gone', 'renderer-unresponsive']) {
    assert.ok(main.includes(`mount(undefined, undefined); observeBrowserLayout('host', '${reason}')`))
  }
})
