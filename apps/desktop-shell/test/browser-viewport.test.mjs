import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import test from 'node:test'

// Import the real workspace method without starting Electron. The production
// constructor is not invoked; only the renderer reply boundary is simulated.
const electron = 'data:text/javascript,' + encodeURIComponent('export class WebContentsView {}; export const session = {}')
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'electron' ? { url: electron, shortCircuit: true } : next(specifier, context)
} })
const { BrowserWorkspace } = await import('../src/browser-workspace.mjs')
hooks.deregister()

function fixture(reply) {
  let calls = 0
  const tab = { id: 'owned-tab', ownerId: 'owned-session', epoch: 1, lastSnapshot: { id: 'obsolete' }, view: { webContents: {
    executeJavaScriptInIsolatedWorld: async (_world, [{ code }]) => {
      calls++
      const id = JSON.parse(code.slice(code.lastIndexOf(')(') + 2, -1))
      const value = await reply(calls, tab)
      return { snapshot_id: id, url: 'http://127.0.0.1:49100/', elements: [], text: 'synthetic', viewport: value }
    },
  } } }
  const workspace = Object.create(BrowserWorkspace.prototype)
  workspace.settled = async () => {}
  return { workspace, tab, calls: () => calls, snapshot: signal => workspace.snapshot(tab, signal) }
}

test('initial 0x0 waits for actual positive layout and publishes only the ready snapshot', async () => {
  const f = fixture(async call => call < 3 ? { width: 0, height: 0 } : { width: 650, height: 650 })
  const result = await f.snapshot()
  assert.equal(f.calls(), 3)
  assert.deepEqual(result.viewport, { width: 650, height: 650 })
  assert.equal(f.tab.lastSnapshot.id, result.snapshot_id)
  assert.equal(result.physical_input_used, false)
})

test('continuous zero geometry fails within the fixed wait window instead of returning success', async () => {
  const f = fixture(async () => ({ width: 0, height: 0 }))
  await assert.rejects(f.snapshot(), { code: 'BROWSER_NOT_VISIBLE' })
  assert.equal(f.tab.lastSnapshot, undefined)
  assert.ok(f.calls() > 1 && f.calls() < 80, 'one fixed two-second budget, not a fresh timeout per probe')
})

test('NaN, non-finite, nonnumeric, negative and absent viewport values are never accepted', async () => {
  for (const viewport of [{ width: NaN, height: 10 }, { width: 10, height: Infinity },
    { width: '650', height: 650 }, { width: -1, height: 650 }, { width: 650 }, undefined]) {
    const f = fixture(async () => viewport)
    await assert.rejects(f.snapshot(), { code: 'BROWSER_NOT_VISIBLE' })
    assert.equal(f.calls(), 1); assert.equal(f.tab.lastSnapshot, undefined)
  }
})

test('already valid geometry does not require visible host or a new mount', async () => {
  const f = fixture(async () => ({ width: 650, height: 650 }))
  // No show/focus/mount methods exist in the fixture: calling any would fail.
  assert.equal((await f.snapshot()).viewport.width, 650)
  assert.equal(f.calls(), 1)
})

test('a positive reply observed after the deadline cannot beat a delayed timeout callback', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const f = fixture(async () => { now = 2_001; return { width: 650, height: 650 } })
  await assert.rejects(f.snapshot(), { code: 'BROWSER_NOT_VISIBLE' })
  assert.equal(f.calls(), 1); assert.equal(f.tab.lastSnapshot, undefined)
})

test('cancellation before a probe or during the layout wait never publishes a snapshot', async () => {
  const first = new AbortController(); first.abort()
  const f = fixture(async () => ({ width: 650, height: 650 }))
  await assert.rejects(f.snapshot(first.signal), { code: 'BROWSER_CANCELLED' }); assert.equal(f.calls(), 0)
  const controller = new AbortController()
  const pending = fixture(async () => { setTimeout(() => controller.abort(), 5); return { width: 0, height: 0 } })
  await assert.rejects(pending.snapshot(controller.signal), { code: 'BROWSER_CANCELLED' })
  assert.equal(pending.calls(), 1); assert.equal(pending.tab.lastSnapshot, undefined)
})

test('navigation during a response or between probes cannot publish a later positive viewport', async () => {
  const changed = fixture(async (_call, tab) => { tab.epoch++; return { width: 650, height: 650 } })
  await assert.rejects(changed.snapshot(), { code: 'BROWSER_STALE' })
  assert.equal(changed.tab.lastSnapshot, undefined)
  const delayed = fixture(async (call, tab) => {
    if (call === 1) setTimeout(() => { tab.epoch++ }, 5)
    return call === 1 ? { width: 0, height: 0 } : { width: 650, height: 650 }
  })
  await assert.rejects(delayed.snapshot(), { code: 'BROWSER_STALE' })
  assert.equal(delayed.calls(), 1); assert.equal(delayed.tab.lastSnapshot, undefined)
})

test('incomplete action assertions reject before snapshot and the same baseline remains repairable', async () => {
  const f = fixture(async () => ({ width: 650, height: 650 }))
  f.workspace.owner = () => ({ mode: 'agent' })
  f.workspace.tab = () => f.tab
  f.workspace.run = async (_tab, _actor, signal, operation) => operation(signal)
  const opened = await f.workspace.snapshot(f.tab, undefined, { command: 'open', args: { url: 'http://127.0.0.1:49100/' } })
  const baseline = f.tab.lastSnapshot
  await assert.rejects(f.workspace.agent('owned-session', 'verify', {
    tab_id: f.tab.id, after_snapshot_id: opened.snapshot_id, expect_text: 'synthetic',
  }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  assert.strictEqual(f.tab.lastSnapshot, baseline)
  assert.equal(f.calls(), 1, 'no new observation consumed the repairable baseline')
  const repaired = await f.workspace.agent('owned-session', 'verify', {
    tab_id: f.tab.id, after_snapshot_id: opened.snapshot_id,
    expect_url: opened.url, expect_text: 'synthetic',
  })
  assert.equal(repaired.status, 'verified')
  assert.equal(repaired.baseline_snapshot_id, opened.snapshot_id)
  assert.notEqual(repaired.snapshot_id, opened.snapshot_id)
  assert.equal(f.calls(), 2)
  assert.equal(f.tab.lastSnapshot.verification, undefined, 'observation does not invent another action')
})

test('unverifiable input and normalized URLs are rejected before any page mutation', async () => {
  const f = fixture(async () => ({ width: 650, height: 650 }))
  f.workspace.owner = () => ({ mode: 'agent' })
  f.workspace.tab = () => f.tab
  f.workspace.run = async (_tab, _actor, signal, operation) => operation(signal)
  f.workspace.productUrl = 'http://127.0.0.1:3080/'
  f.workspace.createTab = () => { throw new Error('must not create a tab') }
  const baseline = f.tab.lastSnapshot
  await assert.rejects(f.workspace.agent('owned-session', 'type', { tab_id: f.tab.id, text: 'x'.repeat(2001) }), { code: 'BROWSER_ARGUMENT' })
  for (const url of ['https://example.org/' + 'x'.repeat(2048), 'https://example.org/' + '字'.repeat(300)]) {
    await assert.rejects(f.workspace.open('owned-session', { url }, 'agent'), { code: 'BROWSER_ARGUMENT' })
  }
  assert.equal(f.calls(), 0)
  assert.strictEqual(f.tab.lastSnapshot, baseline)
})

// A synthetic post-type renderer boundary; verification below uses the real
// agent/run/snapshot methods, never Electron or a fabricated native PASS.
async function typeVerificationFixture(input = '{"amount":69.8,"owner":"林"}\n', command = 'type') {
  let reads = 0
  const dom = { value: input, elementId: 'e1', text: 'synthetic task', beforeRead: undefined }
  const tab = { id: 'owned-tab', ownerId: 'owned-session', epoch: 1, view: { webContents: {
    isDestroyed: () => false, stop() {},
    async executeJavaScriptInIsolatedWorld(_world, [{ code }]) {
      if (code === 'globalThis.__xiaosheBrowserSnapshot = undefined') return undefined
      reads++; await dom.beforeRead?.()
      const id = JSON.parse(code.slice(code.lastIndexOf(')(') + 2, -1))
      return { snapshot_id: id, url: 'http://127.0.0.1:49100/', text: dom.text,
        elements: [{ element_id: dom.elementId, value: dom.value }], viewport: { width: 650, height: 650 } }
    },
  } } }
  const workspace = Object.create(BrowserWorkspace.prototype)
  workspace.tabs = new Map([[tab.id, tab]]); workspace.owners = new Map()
  workspace.changed = () => {}; workspace.settled = async () => {}
  workspace.owner(tab.ownerId)
  const action = await workspace.snapshot(tab, undefined, { command, args: { element_id: 'e1', text: input } })
  const args = { tab_id: tab.id, after_snapshot_id: action.snapshot_id, ...(command === 'type' ? { use_action_input: true } : {}) }
  return { workspace, tab, dom, input, action, args, reads: () => reads,
    verify: (overrides = {}, signal) => workspace.agent(tab.ownerId, 'verify', { ...args, ...overrides }, signal) }
}

test('referenced type input still requires a new exact DOM read and returns fully expanded assertions', async () => {
  const f = await typeVerificationFixture('字'.repeat(1999) + '\n')
  const result = await f.verify({ expect_text: 'synthetic task', expect_url: f.action.url })
  assert.equal(result.status, 'verified'); assert.equal(f.reads(), 2)
  assert.notEqual(result.snapshot_id, f.action.snapshot_id)
  assert.equal(result.snapshot_id, result.current.snapshot_id)
  assert.deepEqual(result.assertions, { expect_url: f.action.url, expect_text: 'synthetic task', expect_element_id: 'e1', expect_value: f.input })
  assert.deepEqual(result.assertion_source, { kind: 'browser_type_input', owner_id: f.tab.ownerId, tab_id: f.tab.id,
    baseline_snapshot_id: f.action.snapshot_id, expect_element_id: 'e1', input_sha256: createHash('sha256').update(f.input, 'utf8').digest('hex') })
  assert.equal(f.args.expect_value, undefined)
  await assert.rejects(f.verify(), { code: 'BROWSER_STALE' })
  await assert.rejects(f.verify({ after_snapshot_id: result.snapshot_id }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  assert.equal(f.reads(), 2, 'a verification snapshot cannot become a new input contract')
})

test('referenced expectations are not copied from changed DOM or substituted by another element/task condition', async () => {
  for (const [change, extra] of [
    [f => { f.dom.value = f.input.replace('69.8', '69.7') }, {}],
    [f => { f.dom.elementId = 'other' }, {}],
  ]) {
    const f = await typeVerificationFixture(); change(f)
    const result = await f.verify(extra)
    assert.equal(result.status, 'mismatch'); assert.equal(f.reads(), 2)
    assert.equal(result.assertions.expect_value, f.input)
  }
  for (const extra of [{ expect_text: 'absent condition' }, { expect_url: 'https://different.example/' }]) {
    const f = await typeVerificationFixture(), baseline = f.tab.lastSnapshot
    await assert.rejects(f.verify(extra), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
    assert.equal(f.reads(), 1); assert.strictEqual(f.tab.lastSnapshot, baseline)
  }
})

test('a click assertion typo preserves the exact action baseline and original deadline without another DOM read', async () => {
  const f = await typeVerificationFixture('', 'click')
  f.dom.text = '查询状态\n\n已保存'
  const action = await f.workspace.snapshot(f.tab, undefined, { command: 'click', args: { element_id: 'e1' } })
  const baseline = f.tab.lastSnapshot, reads = f.reads()
  const args = { tab_id: f.tab.id, after_snapshot_id: action.snapshot_id, expect_text: '查询状态\\n\\n已保存' }
  await assert.rejects(f.workspace.agent(f.tab.ownerId, 'verify', args), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  assert.strictEqual(f.tab.lastSnapshot, baseline); assert.equal(f.reads(), reads)
  action.text = 'caller-modified snapshot is not the baseline'
  const repaired = await f.workspace.agent(f.tab.ownerId, 'verify', { ...args, expect_text: '查询状态\n\n已保存' })
  assert.equal(repaired.status, 'verified'); assert.equal(f.reads(), reads + 1)
  assert.equal(repaired.baseline_snapshot_id, action.snapshot_id)
  assert.notEqual(repaired.current.snapshot_id, action.snapshot_id)
  assert.equal(Object.hasOwn(f.tab.lastSnapshot, 'actionObservation'), false, 'the new observation is not another action')
})

test('a real fresh DOM mismatch consumes the action baseline and never suggests retrying the old action', async () => {
  const f = await typeVerificationFixture('', 'click')
  f.dom.text = 'different current state'
  const mismatch = await f.verify({ expect_text: 'synthetic task' })
  assert.equal(mismatch.status, 'mismatch'); assert.equal(f.reads(), 2)
  assert.match(mismatch.instruction, /已独立回读.*原 after_snapshot_id 已消费.*不能回填旧动作/u)
  assert.equal(mismatch.next_verification, undefined)
  await assert.rejects(f.verify({ expect_text: 'synthetic task' }), { code: 'BROWSER_STALE' })
  assert.equal(f.reads(), 2)
})

test('a rejected action assertion cannot renew TTL or survive navigation, takeover or cancellation', async () => {
  for (const boundary of ['ttl', 'navigation', 'user', 'paused', 'cancel']) {
    const f = await typeVerificationFixture('', 'click'), baseline = f.tab.lastSnapshot
    await assert.rejects(f.verify({ expect_text: 'absent' }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
    assert.strictEqual(f.tab.lastSnapshot, baseline)
    const signal = new AbortController()
    if (boundary === 'ttl') baseline.at -= 45_001
    if (boundary === 'navigation') f.tab.epoch++
    if (boundary === 'user' || boundary === 'paused') { f.workspace.setMode(f.tab.ownerId, boundary); f.workspace.setMode(f.tab.ownerId, 'agent') }
    if (boundary === 'cancel') signal.abort()
    await assert.rejects(f.verify({ expect_text: 'synthetic task' }, signal.signal), { code: boundary === 'cancel' ? 'BROWSER_CANCELLED' : 'BROWSER_STALE' })
    assert.equal(f.reads(), 1)
  }
})

test('a plain observation retains its existing fresh-current verification semantics without action admission', async () => {
  const f = await typeVerificationFixture('', 'click')
  const observed = await f.workspace.snapshot(f.tab)
  assert.equal(Object.hasOwn(f.tab.lastSnapshot, 'actionObservation'), false)
  f.dom.text = 'new state not in ordinary baseline'
  const verified = await f.verify({ after_snapshot_id: observed.snapshot_id, expect_text: f.dom.text })
  assert.equal(verified.status, 'verified'); assert.equal(f.reads(), 3)
})

test('invalid reference arguments and incorrect handwritten values leave the original baseline repairable', async () => {
  const f = await typeVerificationFixture(), baseline = f.tab.lastSnapshot
  for (const extra of [{ use_action_input: false }, { use_action_input: 'true' }, { use_action_input: null },
    { expect_element_id: 'e1' }, { expect_value: f.input }, { expect_closed: true }, { expect_closed: false },
    { expectElementId: 'e1' }, { expectValue: f.input }, { expectClosed: false }]) {
    await assert.rejects(f.verify(extra), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
    assert.strictEqual(f.tab.lastSnapshot, baseline); assert.equal(f.reads(), 1)
  }
  await assert.rejects(f.workspace.agent(f.tab.ownerId, 'verify', {
    tab_id: f.tab.id, after_snapshot_id: f.action.snapshot_id, expect_element_id: 'e1', expect_value: f.input.replace('69.8', '69.7'),
  }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  assert.strictEqual(f.tab.lastSnapshot, baseline); assert.equal(f.reads(), 1)
  assert.equal((await f.verify()).status, 'verified'); assert.equal(f.reads(), 2)
})

test('references cannot cross owner/tab/baseline/epoch/TTL boundaries or use a non-action snapshot', async () => {
  const f = await typeVerificationFixture(), baseline = f.tab.lastSnapshot
  await assert.rejects(f.workspace.agent('other-session', 'verify', f.args), { code: 'BROWSER_TAB' })
  await assert.rejects(f.verify({ tab_id: 'other-tab' }), { code: 'BROWSER_TAB' })
  await assert.rejects(f.verify({ after_snapshot_id: 'other-baseline' }), { code: 'BROWSER_STALE' })
  f.tab.epoch++
  await assert.rejects(f.verify(), { code: 'BROWSER_STALE' }); f.tab.epoch--
  baseline.at -= 45_001
  await assert.rejects(f.verify(), { code: 'BROWSER_STALE' }); baseline.at = Date.now()
  const contract = baseline.verification; delete baseline.verification
  await assert.rejects(f.verify(), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  baseline.verification = { ...contract, command: 'click' }
  await assert.rejects(f.verify(), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  assert.equal(f.reads(), 1); assert.strictEqual(f.tab.lastSnapshot, baseline)
})

test('takeover/paused invalidate references and returning control cannot revive the old action', async () => {
  for (const mode of ['user', 'paused']) {
    const f = await typeVerificationFixture()
    f.workspace.setMode(f.tab.ownerId, mode)
    await assert.rejects(f.verify(), { code: 'BROWSER_PAUSED' })
    f.workspace.setMode(f.tab.ownerId, 'agent')
    await assert.rejects(f.verify(), { code: 'BROWSER_STALE' })
    assert.equal(f.reads(), 1)
  }
})

test('cancellation and navigation while a referenced DOM read is pending never return verified', async () => {
  const early = await typeVerificationFixture(), stopped = new AbortController(); stopped.abort()
  await assert.rejects(early.verify({}, stopped.signal), { code: 'BROWSER_CANCELLED' }); assert.equal(early.reads(), 1)
  for (const mode of ['cancel', 'navigation', 'takeover']) {
    const f = await typeVerificationFixture(), controller = new AbortController()
    f.dom.beforeRead = () => {
      if (mode === 'cancel') controller.abort()
      else if (mode === 'navigation') f.tab.epoch++
      else f.workspace.setMode(f.tab.ownerId, 'user')
    }
    await assert.rejects(f.verify({}, controller.signal), { code: mode === 'navigation' ? 'BROWSER_STALE' : 'BROWSER_CANCELLED' })
    assert.equal(f.reads(), 2); assert.equal(f.tab.lastSnapshot, undefined)
  }
})

test('the explicit full-value verification path remains compatible without reference source metadata', async () => {
  const f = await typeVerificationFixture('')
  const result = await f.workspace.agent(f.tab.ownerId, 'verify', {
    tab_id: f.tab.id, after_snapshot_id: f.action.snapshot_id, expect_element_id: 'e1', expect_value: '',
  })
  assert.equal(result.status, 'verified'); assert.equal(result.assertion_source, undefined)
  assert.deepEqual(result.assertions, { expect_element_id: 'e1', expect_value: '' }); assert.equal(f.reads(), 2)
})
