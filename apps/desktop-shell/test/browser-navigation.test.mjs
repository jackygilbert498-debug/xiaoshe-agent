import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Exercise the real workspace open/run/snapshot/verify chain. Only Electron's
// load completion and renderer responses are controlled; no browser is opened.
const electron = 'data:text/javascript,' + encodeURIComponent('export class BaseWindow {}; export class WebContentsView {}; export const session = {}')
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'electron' ? { url: electron, shortCircuit: true } : next(specifier, context)
} })
const { BrowserWorkspace } = await import('../src/browser-workspace.mjs')
hooks.deregister()

function fixture({ pending = false, observed = 'https://example.org/zh-Hans-CN/news/' } = {}) {
  const dispatched = [], dom = { url: observed, text: 'Article title', reads: 0, stops: 0 }
  let resolveLoad, resolveRead
  const load = pending ? new Promise(resolve => { resolveLoad = resolve }) : Promise.resolve()
  const tab = { id: 'owned-tab', ownerId: 'owned-session', epoch: 0, url: observed, loading: false, error: '', view: { webContents: {
    isDestroyed: () => false, isLoadingMainFrame: () => false,
    stop() { dom.stops++ },
    loadURL(url) { dispatched.push(url); tab.epoch++; tab.lastSnapshot = undefined; return load },
    async executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
      if (code === 'globalThis.__xiaosheBrowserSnapshot = undefined') return undefined
      dom.reads++
      if (dom.holdRead) await new Promise(resolve => { resolveRead = resolve })
      const id = JSON.parse(code.slice(code.lastIndexOf(')(') + 2, -1))
      return { snapshot_id: id, url: dom.url, title: 'Article', text: dom.text, elements: [],
        viewport: { width: 650, height: 650, scroll_y: 0 }, source: 'isolated-browser-dom', content_is_untrusted: true }
    },
  } } }
  const workspace = Object.create(BrowserWorkspace.prototype)
  workspace.productUrl = 'http://127.0.0.1:3080'
  workspace.tabs = new Map([[tab.id, tab]]); workspace.owners = new Map()
  workspace.changed = () => {}; workspace.owner(tab.ownerId)
  return { workspace, tab, dom, dispatched, resolveLoad: () => resolveLoad?.(), resolveRead: () => resolveRead?.(),
    open: signal => workspace.agent(tab.ownerId, 'open', { tab_id: tab.id, url: 'https://example.org/news/' }, signal) }
}

test('a real redirect hint verifies its same action baseline with one independent read', async () => {
  const f = fixture(), opened = await f.open(), baseline = f.tab.lastSnapshot
  assert.equal(opened.next_verification.status, 'pending_not_verified')
  assert.equal(opened.next_verification.arguments.expect_url, 'https://example.org/zh-Hans-CN/news/')
  assert.equal(f.dom.reads, 1)
  await assert.rejects(f.workspace.agent(f.tab.ownerId, 'verify', {
    ...opened.next_verification.arguments, expect_url: 'https://example.org/news/', expect_text: 'Article title',
  }), error => error.code === 'BROWSER_VERIFICATION_ARGUMENT' && /expect_url/u.test(error.message)
    && !/expect_text/u.test(error.message))
  assert.strictEqual(f.tab.lastSnapshot, baseline); assert.equal(f.dom.reads, 1)
  const verified = await f.workspace.agent(f.tab.ownerId, 'verify', opened.next_verification.arguments)
  assert.equal(verified.status, 'verified'); assert.equal(verified.current.url, 'https://example.org/zh-Hans-CN/news/')
  assert.equal(f.dom.reads, 2); assert.deepEqual(f.dispatched, ['https://example.org/news/'])
})

test('the open deadline is a timeout, never cancellation or a fabricated navigation proof', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ pending: true })
  const done = assert.rejects(f.open(), error => error.code === 'BROWSER_TIMEOUT'
    && /BROWSER_TIMEOUT/u.test(error.message) && /未.*验证/u.test(error.message) && /browser_snapshot/u.test(error.message))
  t.mock.timers.tick(22_000)
  await done
  assert.equal(f.tab.operation, undefined); assert.equal(f.tab.lastSnapshot, undefined)
  assert.equal(f.dom.reads, 0); assert.ok(f.dom.stops > 0)
  assert.deepEqual(f.dispatched, ['https://example.org/news/'], 'deadline must not repeat navigation')
  f.resolveLoad(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.tab.lastSnapshot, undefined, 'late load settlement cannot publish an action after timeout')
  const observation = await f.workspace.agent(f.tab.ownerId, 'snapshot', { tab_id: f.tab.id })
  assert.equal(observation.url, 'https://example.org/zh-Hans-CN/news/')
  assert.equal(observation.status, undefined); assert.equal(observation.next_verification, undefined)
  assert.equal(f.tab.lastSnapshot.verification, undefined, 'a later read is not proof of the timed-out navigation')
})

test('external cancellation and user takeover before the deadline remain cancellation', async t => {
  for (const cause of ['signal', 'user', 'paused']) await t.test(cause, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture({ pending: true }), controller = new AbortController()
    const done = assert.rejects(f.open(controller.signal), { code: 'BROWSER_CANCELLED' })
    if (cause === 'signal') controller.abort({ code: 'BROWSER_TIMEOUT' }) // caller reasons cannot impersonate a host deadline
    else f.workspace.setMode(f.tab.ownerId, cause)
    t.mock.timers.tick(30_000)
    await done
    assert.equal(f.tab.operation, undefined); assert.equal(f.tab.lastSnapshot, undefined)
    assert.equal(f.dom.reads, 0); assert.deepEqual(f.dispatched, ['https://example.org/news/'])
  })
})

test('the enclosing operation deadline also distinguishes timeout from external cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const done = assert.rejects(f.workspace.run(f.tab, 'agent', undefined, async () => new Promise(() => {})), { code: 'BROWSER_TIMEOUT' })
  t.mock.timers.tick(28_000)
  await done
  assert.equal(f.tab.operation, undefined); assert.ok(f.dom.stops > 0)
})

test('the navigation budget includes a pending DOM snapshot and never publishes its late response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture({ pending: true }); f.dom.holdRead = true
  const done = assert.rejects(f.open(), { code: 'BROWSER_TIMEOUT' })
  t.mock.timers.tick(21_000); f.resolveLoad()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.dom.reads, 1)
  t.mock.timers.tick(1_000); await done
  f.resolveRead(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.tab.lastSnapshot, undefined); assert.equal(f.tab.operation, undefined)
})

test('timeout reports an existing snapshot only when its epoch and original lifetime remain valid', async t => {
  for (const kind of ['fresh', 'navigated', 'expired']) await t.test(kind, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const f = fixture()
    f.tab.lastSnapshot = { id: 'known-observation', epoch: kind === 'navigated' ? 10 : f.tab.epoch,
      at: Date.now() - (kind === 'expired' ? 46_000 : 0) }
    const baseline = f.tab.lastSnapshot
    const done = assert.rejects(f.workspace.run(f.tab, 'agent', undefined, async () => new Promise(() => {})), error => {
      assert.equal(error.code, 'BROWSER_TIMEOUT')
      assert.equal(/已有.*快照/u.test(error.message), kind === 'fresh')
      assert.match(error.message, /未.*验证/u)
      return true
    })
    t.mock.timers.tick(28_000); await done
    assert.strictEqual(f.tab.lastSnapshot, baseline, 'reporting availability cannot refresh or manufacture a snapshot')
  })
})

test('a completed open clears its deadline without cancelling the next operation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const opened = await f.open()
  t.mock.timers.tick(30_000)
  assert.equal(f.dom.stops, 0); assert.equal(f.tab.lastSnapshot.id, opened.snapshot_id)
  assert.equal((await f.workspace.agent(f.tab.ownerId, 'verify', opened.next_verification.arguments)).status, 'verified')
})
