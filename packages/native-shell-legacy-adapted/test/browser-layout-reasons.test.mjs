import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { setImmediate as flushMicrotasks } from 'node:timers/promises'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the actual component/effects, not a duplicate of their conditions.
// The extra export exists only in the in-memory test input. Every fixture gets
// its own VM, DOM and timer queues; this is not Electron/compositor evidence.
const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(`${source}\nexport { createBrowserDock as testOnlyCreateBrowserDock };\n`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
})
assert.deepEqual(compiled.diagnostics?.filter(row => row.category === ts.DiagnosticCategory.Error), [])

const plain = value => JSON.parse(JSON.stringify(value))
const rect = { x: 100, y: 200, left: 100, top: 200, right: 700, bottom: 700, width: 600, height: 500 }

function fixture(t, options = {}) {
  const state = { slot: true, hidden: false, modal: false, hits: [true, true, true], ...options }
  const reads = { visibility: 0, modal: 0, rect: 0, points: [] }
  const effects = [], bounds = [], requests = [], intervals = new Map(), cleared = [], observers = [], subscriptions = new Set()
  const listeners = { window: new Map(), document: new Map() }
  const cleanup = new Set()
  let intervalSequence = 0, unsubscribed = 0
  const eventsFor = name => ({
    addEventListener(type, callback, capture = false) {
      const values = listeners[name].get(type) ?? []
      values.push({ callback, capture }); listeners[name].set(type, values)
    },
    removeEventListener(type, callback, capture = false) {
      listeners[name].set(type, (listeners[name].get(type) ?? []).filter(row => row.callback !== callback || row.capture !== capture))
    },
  })
  const element = {
    getBoundingClientRect() { reads.rect++; return { ...rect } },
    contains(hit) { return hit?.inside === true },
  }
  const document = {
    ...eventsFor('document'), body: {},
    get visibilityState() { reads.visibility++; return state.hidden ? 'hidden' : 'visible' },
    querySelector(selector) {
      assert.equal(selector, '[aria-modal="true"]')
      reads.modal++; return state.modal ? { modal: true } : null
    },
    elementFromPoint(x, y) {
      reads.points.push([x, y])
      const points = [[rect.left + 2, rect.top + 2], [rect.right - 2, rect.bottom - 2], [rect.left + rect.width / 2, rect.top + rect.height / 2]]
      const index = points.findIndex(point => point[0] === x && point[1] === y)
      assert.notEqual(index, -1, 'the product must use its existing three hit-test points')
      return { inside: state.hits[index] }
    },
  }
  const bridge = {
    bounds(...args) { bounds.push(args) },
    async request(owner, action, args) {
      requests.push({ owner, action, args })
      return { ok: true, value: { tabs: [], mode: 'agent', desktop_allowed: false, active_tab: null } }
    },
    subscribe(fn) { subscriptions.add(fn); return () => { subscriptions.delete(fn); unsubscribed++ } },
  }
  const window = { ...eventsFor('window'), ...(state.bridge === false ? {} : { xiaosheDesktop: { browser: bridge } }) }
  const observerClass = kind => class {
    constructor(callback) { this.kind = kind; this.callback = callback; this.disconnected = false; observers.push(this) }
    observe(target, opts) { this.target = target; this.options = opts }
    disconnect() { this.disconnected = true }
  }
  const exported = {}
  const context = vm.createContext({ exports: exported, window, document, URL,
    ResizeObserver: observerClass('resize'), MutationObserver: observerClass('mutation'),
    setInterval(callback, ms) { const id = ++intervalSequence; intervals.set(id, { callback, ms }); return id },
    clearInterval(id) { cleared.push(id); intervals.delete(id) },
    require(name) { throw new Error(`unexpected test module import: ${name}`) },
  })
  vm.runInContext(compiled.outputText, context, { timeout: 3000, filename: 'actual-client-layout-reasons.cjs' })
  let stateIndex = 0
  const stateWrites = []
  const react = {
    createElement(type, props, ...children) {
      // React assigns DOM refs before committing useEffect callbacks.
      if (props?.className === 'browser-page-slot' && props.ref) props.ref.current = state.slot ? element : null
      return { type, props, children }
    },
    useState(initial) { const index = stateIndex++; return [index === 2 ? options.address ?? initial : initial, value => stateWrites.push({ index, value })] },
    useRef(initial) { return { current: initial } },
    useEffect(fn, dependencies) { effects.push({ fn, dependencies }) },
  }
  const props = { ownerId: 'owned-layout-session', open: true, resizing: false, resizer: null, onOpen() {}, onClose() {}, ...options.props }
  const component = exported.testOnlyCreateBrowserDock(react)
  const tree = component(props)
  const runEffect = size => {
    const matches = effects.filter(row => row.dependencies.length === size)
    assert.equal(matches.length, 1, `one actual effect with ${size} dependencies expected`)
    const release = matches[0].fn()
    if (typeof release !== 'function') return undefined
    let active = true
    const dispose = () => { if (active) { active = false; cleanup.delete(dispose); release() } }
    cleanup.add(dispose); return dispose
  }
  t.after(() => { for (const dispose of [...cleanup].reverse()) dispose(); intervals.clear() })
  return { state, reads, bounds, requests, intervals, cleared, observers, listeners, subscriptions, props, tree, stateWrites,
    get unsubscribed() { return unsubscribed },
    startLayout: () => runEffect(4), startOwner: () => runEffect(1),
    tick(ms) { for (const row of [...intervals.values()]) if (row.ms === ms) row.callback() },
    emit(surface, name) { for (const row of [...(listeners[surface].get(name) ?? [])]) row.callback() },
    trigger(kind) { for (const observer of observers) if (observer.kind === kind && !observer.disconnected) observer.callback() },
  }
}

test('actual browser form rejects local paths before bridge navigation and still opens web URLs', async t => {
  const find = (node, type) => node && typeof node === 'object' && (node.type === type ? node : node.children?.flat(Infinity).map(child => find(child, type)).find(Boolean))
  for (const address of ['/Users/zfy/首帧', '"/Users/zfy/首帧"', 'https:///Users/zfy/首帧', 'https://example.com/']) {
    const f = fixture(t, { address })
    find(f.tree, 'form').props.onSubmit({ preventDefault() {} })
    await flushMicrotasks()
    if (address === 'https://example.com/') assert.equal(f.requests.find(row => row.action === 'open').args.url, address)
    else { assert.equal(f.requests.length, 0); assert.match(f.stateWrites.find(row => row.index === 1).value, /本地文件路径/) }
  }
})

function lastReason(f, reason, value) {
  const last = f.bounds.at(-1)
  assert.ok(last, 'the actual effect must report its bounds')
  assert.equal(last.length, 3)
  assert.equal(last[0], f.props.ownerId)
  assert.equal(last[2], reason)
  if (value === undefined) assert.equal(last[1], undefined)
  else assert.deepEqual(plain(last[1]), value)
}

test('actual layout effect preserves dock-closed before resizing and does not inspect DOM', t => {
  const f = fixture(t, { hidden: true, modal: true, props: { open: false, resizing: true } })
  assert.equal(f.startLayout(), undefined)
  lastReason(f, 'dock-closed')
  assert.equal(f.bounds.length, 1); assert.equal(f.intervals.size, 0)
  assert.deepEqual(f.reads, { visibility: 0, modal: 0, rect: 0, points: [] })
})

test('actual resizing branch precedes missing slot and hidden document without changing bounds', t => {
  const f = fixture(t, { slot: false, hidden: true, modal: true, props: { resizing: true } })
  assert.equal(f.startLayout(), undefined)
  lastReason(f, 'dock-resizing')
  assert.deepEqual(f.reads, { visibility: 0, modal: 0, rect: 0, points: [] })
  assert.equal(f.intervals.size, 0)
})

test('missing-slot branch precedes document visibility and modal, retaining the existing 400ms timer', t => {
  const f = fixture(t, { slot: false, hidden: true, modal: true })
  f.startLayout(); lastReason(f, 'slot-missing')
  assert.deepEqual(f.reads, { visibility: 0, modal: 0, rect: 0, points: [] })
  assert.deepEqual([...f.intervals.values()].map(row => row.ms), [400])
})

test('hidden-document branch precedes modal and geometry without claiming native occlusion', t => {
  const f = fixture(t, { hidden: true, modal: true })
  f.startLayout(); lastReason(f, 'document-hidden')
  assert.equal(f.reads.visibility, 1); assert.equal(f.reads.modal, 0); assert.equal(f.reads.rect, 0)
})

test('visible document with a modal clears the same owner and never reads page geometry', t => {
  const f = fixture(t, { modal: true })
  f.startLayout(); lastReason(f, 'modal-present')
  assert.equal(f.reads.visibility, 1); assert.equal(f.reads.modal, 1); assert.equal(f.reads.rect, 0)
})

test('each of the three actual hit-test failures reports only hit-test-blocked and preserves short-circuiting', t => {
  for (let failed = 0; failed < 3; failed++) {
    const hits = [true, true, true]; hits[failed] = false
    const f = fixture(t, { hits })
    f.startLayout(); lastReason(f, 'hit-test-blocked')
    assert.equal(f.reads.rect, 1); assert.equal(f.reads.points.length, failed + 1)
  }
})

test('clear hit-test reports the original exact geometry, with no normalization or viewport override', t => {
  const f = fixture(t)
  f.startLayout()
  lastReason(f, 'layout-visible', { x: 100, y: 200, width: 600, height: 500 })
  assert.deepEqual(f.reads.points, [[102, 202], [698, 698], [400, 450]])
})

test('identical visible and unavailable 400ms heartbeats all renew bounds; only host logs may deduplicate', t => {
  const f = fixture(t)
  f.startLayout()
  for (let i = 0; i < 4; i++) f.tick(400)
  assert.equal(f.bounds.length, 5)
  assert.ok(f.bounds.every(row => row[2] === 'layout-visible'))
  f.state.hidden = true
  for (let i = 0; i < 3; i++) f.tick(400)
  assert.equal(f.bounds.length, 8)
  assert.ok(f.bounds.slice(5).every(row => row[1] === undefined && row[2] === 'document-hidden'))
  f.state.hidden = false; f.tick(400)
  assert.equal(f.bounds.length, 9)
  lastReason(f, 'layout-visible', { x: 100, y: 200, width: 600, height: 500 })
})

test('real observer and event registrations retain their callbacks and cleanup clears bounds with its own reason', t => {
  const f = fixture(t), dispose = f.startLayout()
  assert.equal(f.observers.length, 2)
  assert.deepEqual(plain(f.observers.find(row => row.kind === 'mutation').options),
    { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-modal', 'hidden'] })
  assert.equal(f.listeners.document.get('scroll')[0].capture, true)
  for (const [surface, name] of [['window', 'resize'], ['document', 'scroll'], ['document', 'visibilitychange']]) f.emit(surface, name)
  f.trigger('resize'); f.trigger('mutation')
  assert.equal(f.bounds.length, 6)
  dispose(); lastReason(f, 'layout-effect-cleanup')
  assert.equal(f.intervals.size, 0); assert.ok(f.observers.every(row => row.disconnected))
  assert.ok(Object.values(f.listeners).every(map => [...map.values()].every(rows => rows.length === 0)))
  f.tick(400); f.emit('window', 'resize'); f.emit('document', 'scroll'); f.trigger('resize'); f.trigger('mutation')
  assert.equal(f.bounds.length, 7, 'cleaned effects cannot continue sending heartbeats')
})

test('owner effect cleanup keeps the old owner identity and its distinct reason, unsubscribing and clearing 5s status timer', async t => {
  const f = fixture(t), dispose = f.startOwner()
  // Cross-realm await adopts the host bridge promise before the VM continuation.
  // Drain that job queue before manually advancing the product's fake timer.
  await flushMicrotasks()
  assert.equal(f.requests[0].action, 'bind'); assert.equal(f.subscriptions.size, 1)
  assert.deepEqual([...f.intervals.values()].map(row => row.ms), [5000])
  f.tick(5000); await flushMicrotasks()
  assert.equal(f.requests.at(-1).action, 'status')
  dispose(); lastReason(f, 'owner-effect-cleanup')
  assert.equal(f.bounds[0][0], 'owned-layout-session')
  assert.equal(f.unsubscribed, 1); assert.equal(f.subscriptions.size, 0); assert.equal(f.intervals.size, 0)
  const count = f.requests.length; f.tick(5000)
  assert.equal(f.requests.length, count)
})

test('missing bridge or owner emits no layout or owner bounds and creates no timer', t => {
  for (const options of [{ bridge: false }, { props: { ownerId: undefined } }]) {
    const f = fixture(t, options)
    assert.equal(f.startOwner(), undefined); assert.equal(f.startLayout(), undefined)
    assert.equal(f.bounds.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.intervals.size, 0)
  }
})

test('separate VM fixtures do not share DOM state, observer queues, timers or bridge outputs', t => {
  const blocked = fixture(t, { modal: true }), visible = fixture(t)
  blocked.startLayout(); visible.startLayout()
  blocked.state.hidden = true; blocked.tick(400)
  assert.equal(blocked.bounds.length, 2); assert.equal(visible.bounds.length, 1)
  lastReason(blocked, 'document-hidden')
  lastReason(visible, 'layout-visible', { x: 100, y: 200, width: 600, height: 500 })
})
