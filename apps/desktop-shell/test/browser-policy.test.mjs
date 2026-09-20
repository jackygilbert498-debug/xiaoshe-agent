import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { browserUrl, browserPreferences, browserBounds, trustedBrowserSender, validOwner, withBrowserVerificationHint, browserVerificationContract, assertBrowserVerificationContract, resolveBrowserVerificationInput, browserVerificationObservation, browserSnapshotSatisfies, assertBrowserVerificationObservation } from '../src/browser-policy.mjs'
const product = 'http://127.0.0.1:3080'
test('action observation admission compares literal assertions without converting escapes or retaining unrelated DOM metadata', () => {
  const snapshot = { url: 'https://example.org/', text: '保存状态\n\n已保存', title: 'untrusted title',
    elements: [{ element_id: 'e1', value: 'original', name: 'untrusted label', disabled: false }],
    viewport: { width: 900, height: 600, scroll_y: 17 } }
  const observation = browserVerificationObservation(snapshot)
  assert.deepEqual(observation, { url: snapshot.url, text: snapshot.text,
    elements: [{ element_id: 'e1', value: 'original' }], viewport: { scroll_y: 17 } })
  snapshot.text = 'replacement'; snapshot.elements[0].value = 'replacement'; snapshot.viewport.scroll_y = 99
  const valid = { expect_url: 'https://example.org/', expect_text: '保存状态\n\n已保存', expect_element_id: 'e1', expect_value: 'original', expect_scroll_y: 17 }
  assert.equal(browserSnapshotSatisfies(observation, valid), true)
  assert.doesNotThrow(() => assertBrowserVerificationObservation(observation, valid))
  for (const [changed, field] of [[{ expect_text: '保存状态\\n\\n已保存' }, 'expect_text'], [{ expect_url: 'https://example.org/other' }, 'expect_url'],
    [{ expect_element_id: 'e2' }, 'expect_element_id'], [{ expect_value: 'different' }, 'expect_value'], [{ expect_scroll_y: 18 }, 'expect_scroll_y']]) {
    assert.throws(() => assertBrowserVerificationObservation(observation, { ...valid, ...changed }), error =>
      error.code === 'BROWSER_VERIFICATION_ARGUMENT' && error.message.includes(field)
      && /尚未独立回读页面.*同一 after_snapshot_id.*不要重做动作/u.test(error.message))
  }
  assert.equal(Object.isFrozen(observation), true)
  assert.equal(Object.isFrozen(observation.elements[0]), true)
})
test('oversized or malformed action observations stay unavailable rather than being truncated into matching evidence', () => {
  const snapshot = { url: 'https://example.org/', text: 'baseline', elements: [{ element_id: 'e1', value: 'original' }] }
  for (const changed of [{ url: 'x'.repeat(8193) }, { text: 'x'.repeat(18001) }, { text: null },
    { elements: Array.from({ length: 161 }, (_, index) => ({ element_id: `e${index}` })) },
    { elements: [{ element_id: 'e1', value: 'x'.repeat(2001) }] }, { elements: [{ element_id: '' }] },
    { viewport: { scroll_y: { unbounded: 'not a number' } } }]) {
    const observation = browserVerificationObservation({ ...snapshot, ...changed })
    assert.equal(observation, undefined)
    assert.throws(() => assertBrowserVerificationObservation(observation, { expect_text: 'baseline' }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  }
})
test('action reminders name the exact next baseline without claiming verification or inventing save assertions', () => {
  const snapshot = { tab_id: 'tab', snapshot_id: 'fresh', url: 'https://example.org/login', elements: [{ element_id: 'e1', value: 'payload' }] }
  const opened = withBrowserVerificationHint('open', { url: 'https://example.org/form' }, snapshot, product)
  assert.equal(opened.next_verification.status, 'pending_not_verified')
  assert.deepEqual(opened.next_verification.required_assertions, ['expect_url'])
  assert.deepEqual(opened.next_verification.arguments, { tab_id: 'tab', after_snapshot_id: 'fresh', expect_url: 'https://example.org/login' })
  assert.equal(snapshot.next_verification, undefined)
  const typed = withBrowserVerificationHint('type', { element_id: 'e1', text: 'payload' }, snapshot)
  assert.deepEqual(typed.next_verification.arguments, { tab_id: 'tab', after_snapshot_id: 'fresh', use_action_input: true })
  assert.deepEqual(typed.next_verification.required_assertions, ['use_action_input'])
  assert.deepEqual(browserVerificationContract('type', { element_id: 'e1', text: 'payload' }, snapshot).required, ['expect_element_id', 'expect_value'], 'the host still requires both expanded DOM assertions')
  assert.match(typed.next_verification.instruction, /引用不代表已验证或已保存/u)
  const click = withBrowserVerificationHint('click', {}, snapshot)
  assert.deepEqual(click.next_verification.arguments, { tab_id: 'tab', after_snapshot_id: 'fresh' })
  assert(!JSON.stringify(click.next_verification.arguments).includes('expect_'))
  assert.strictEqual(withBrowserVerificationHint('verify', {}, snapshot), snapshot)
  assert.strictEqual(withBrowserVerificationHint('close', {}, { closed: true }).closed, true)
  const oversized = withBrowserVerificationHint('type', { element_id: 'e1', text: 'x'.repeat(2001) }, snapshot)
  assert.equal(oversized.next_verification.arguments.expect_value, undefined)
  assert.equal(oversized.next_verification.arguments.use_action_input, undefined)
  assert.deepEqual(oversized.next_verification.required_assertions, ['expect_element_id', 'expect_value'])
  for (const elements of [[], [{ element_id: 'e1', value: 'different' }], [{ element_id: 'other', value: 'payload' }]]) {
    const manual = withBrowserVerificationHint('type', { element_id: 'e1', text: 'payload' }, { ...snapshot, elements }).next_verification
    assert.equal(manual.arguments.use_action_input, undefined)
    assert.deepEqual(manual.required_assertions, ['expect_element_id', 'expect_value'])
  }
})

test('redirect hints bind the observed legal URL while strict verification still rejects the requested URL', () => {
  const snapshot = { tab_id: 'tab', snapshot_id: 'fresh', url: 'https://example.org/zh-Hans-CN/news/', text: 'Article title', elements: [] }
  const hint = withBrowserVerificationHint('open', { url: 'https://example.org/news/' }, snapshot, product).next_verification
  assert.equal(hint.arguments.expect_url, 'https://example.org/zh-Hans-CN/news/')
  assert.equal(hint.status, 'pending_not_verified')
  assert.equal(browserSnapshotSatisfies(snapshot, { expect_url: 'https://example.org/news/' }), false)
  assert.equal(browserSnapshotSatisfies(snapshot, hint.arguments), true)
  assert.equal(withBrowserVerificationHint('open', { url: 'https://example.org/news/' }, {
    ...snapshot, url: 'https://official.example.net/news/',
  }, product).next_verification.arguments.expect_url, 'https://official.example.net/news/')
})

test('redirect hints never promote credential, product-control, unsafe or unauthorized local targets', () => {
  const snapshot = { tab_id: 'tab', snapshot_id: 'fresh' }
  for (const url of ['https://user:SECRET@example.org/', 'http://localhost:3080/api', 'https://127.0.0.1:3080/',
    'http://127.0.0.1:8877/', 'http://example.org/', 'file:///secret', 'javascript:alert(1)', 'data:text/html,SECRET',
    'about:blank', 'https://example.org/' + 'x'.repeat(2048)]) {
    assert.throws(() => withBrowserVerificationHint('open', { url: 'https://example.org/' }, { ...snapshot, url }, product))
  }
  const local = { url: 'http://127.0.0.1:8877/form' }
  assert.equal(withBrowserVerificationHint('open', local, { ...snapshot, url: 'http://127.0.0.1:8877/done' }, product)
    .next_verification.arguments.expect_url, 'http://127.0.0.1:8877/done')
  assert.throws(() => withBrowserVerificationHint('open', local, { ...snapshot, url: 'http://127.0.0.1:8878/done' }, product))
})

test('observation mismatch diagnostics name all failed fields without leaking page or assertion values', () => {
  const snapshot = { url: 'https://example.org/?token=PRIVATE_URL', text: 'PRIVATE_BODY', elements: [{ element_id: 'e1', value: 'PRIVATE_VALUE' }], viewport: { scroll_y: 2 } }
  assert.throws(() => assertBrowserVerificationObservation(snapshot, { expect_url: 'https://different.example/?token=PRIVATE_EXPECTED',
    expect_text: 'PRIVATE_EXPECTED_TEXT', expect_element_id: 'e1', expect_value: 'PRIVATE_EXPECTED_VALUE', expect_scroll_y: 3 }), error => {
    assert.equal(error.code, 'BROWSER_VERIFICATION_ARGUMENT')
    for (const field of ['expect_url', 'expect_text', 'expect_value', 'expect_scroll_y']) assert.ok(error.message.includes(field))
    assert.doesNotMatch(error.message, /PRIVATE_|https:|example/u)
    return true
  })
})
test('action-specific assertions cannot be replaced by matching page text', () => {
  const snapshot = { viewport: { scroll_y: 400 }, next_verification: { required_assertions: [] } }
  for (const [command, args, assertions] of [
    ['open', { url: 'https://example.org/' }, { expect_url: 'https://example.org/' }],
    ['type', { element_id: 'e1', text: '' }, { expect_element_id: 'e1', expect_value: '' }],
    ['scroll', { delta_y: 400 }, { expect_scroll_y: 400 }],
  ]) {
    const contract = browserVerificationContract(command, args, snapshot)
    assert.throws(() => assertBrowserVerificationContract(contract, { expect_text: '已保存' }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
    assert.doesNotThrow(() => assertBrowserVerificationContract(contract, { ...assertions, expect_text: '已保存' }))
    for (const key of contract.required) {
      const partial = { ...assertions }; delete partial[key]
      assert.throws(() => assertBrowserVerificationContract(contract, partial), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
    }
  }
  const typed = browserVerificationContract('type', { element_id: 'e1', text: 'actual' }, snapshot)
  for (const assertions of [{ expect_element_id: 'e2', expect_value: 'actual' }, { expect_element_id: 'e1', expect_value: 'wrong' }]) {
    assert.throws(() => assertBrowserVerificationContract(typed, assertions), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  }
  assert.throws(() => assertBrowserVerificationContract(browserVerificationContract('scroll', {}, snapshot), { expect_scroll_y: 0 }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  assert.equal(browserVerificationContract('click', {}, snapshot), undefined)
  assert.doesNotThrow(() => assertBrowserVerificationContract(undefined, { expect_text: 'saved' }))
})
test('explicit action input expands only the host type contract and hashes exact UTF8 including a trailing newline', () => {
  const input = '{"items":[{"amount":69.8,"owner":"林"}]}\n'
  const args = { tab_id: 'tab', after_snapshot_id: 'baseline', use_action_input: true, expect_text: 'task condition' }
  const contract = browserVerificationContract('type', { element_id: 'e1', text: input }, {})
  const binding = { ownerId: 'owner', tabId: 'tab', baselineSnapshotId: 'baseline' }
  const before = structuredClone({ args, contract, binding })
  const result = resolveBrowserVerificationInput(args, contract, binding)
  assert.deepEqual(result.args, { ...args, expect_element_id: 'e1', expect_value: input })
  assert.deepEqual(result.assertionSource, { kind: 'browser_type_input', owner_id: 'owner', tab_id: 'tab',
    baseline_snapshot_id: 'baseline', expect_element_id: 'e1', input_sha256: createHash('sha256').update(input, 'utf8').digest('hex') })
  assert.notEqual(result.assertionSource.input_sha256, createHash('sha256').update(input.trim()).digest('hex'))
  assert.deepEqual({ args, contract, binding }, before)
  assert.doesNotThrow(() => assertBrowserVerificationContract(contract, result.args))
  const manual = { expect_element_id: 'e1', expect_value: input }
  assert.deepEqual(resolveBrowserVerificationInput(manual), { args: manual })
})
test('action input reference rejects false, other types, mixed explicit values and wrong host binding', () => {
  const args = { tab_id: 'tab', after_snapshot_id: 'baseline', use_action_input: true }
  const contract = browserVerificationContract('type', { element_id: 'e1', text: '' }, {})
  const binding = { ownerId: 'owner', tabId: 'tab', baselineSnapshotId: 'baseline' }
  for (const value of [false, undefined, null, 1, 'true', [], {}]) {
    assert.throws(() => resolveBrowserVerificationInput({ ...args, use_action_input: value }, contract, binding), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  }
  for (const extra of [{ expect_element_id: 'e1' }, { expect_element_id: undefined }, { expect_value: '' },
    { expect_closed: true }, { expect_closed: false }, { expect_closed: undefined },
    { expectElementId: 'e1' }, { expectValue: '' }, { expectClosed: false }]) {
    assert.throws(() => resolveBrowserVerificationInput({ ...args, ...extra }, contract, binding), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  }
  for (const changed of [{}, { ...binding, ownerId: '' }, { ...binding, tabId: 'other' }, { ...binding, baselineSnapshotId: 'other' }]) {
    assert.throws(() => resolveBrowserVerificationInput(args, contract, changed), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  }
  for (const unsupported of [undefined, browserVerificationContract('open', {}, {}), browserVerificationContract('scroll', {}, { viewport: { scroll_y: 0 } }),
    browserVerificationContract('type', { element_id: 'e1', text: 'x'.repeat(2001) }, {})]) {
    assert.throws(() => resolveBrowserVerificationInput(args, unsupported, binding), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
  }
  assert.equal(resolveBrowserVerificationInput(args, contract, binding).args.expect_value, '')
})
test('wrong assertion errors identify the request rather than falsely diagnosing page input', () => {
  assert.throws(() => assertBrowserVerificationContract(browserVerificationContract('type', { element_id: 'e1', text: 'correct' }, {}), {
    expect_element_id: 'e1', expect_value: 'mistyped assertion',
  }), error => error.code === 'BROWSER_VERIFICATION_ARGUMENT' && /断言参数错误/u.test(error.message)
    && /尚未独立回读页面/u.test(error.message) && /不表示此前输入错误/u.test(error.message) && /不要重做动作/u.test(error.message))
})
test('isolated pages cannot navigate to product control, local files, unsafe schemes or credential URLs', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,Hi', 'http://example.com', 'https://user:pass@example.com', 'http://localhost:3080/api', 'http://[::1]:3080', 'https://127.0.0.1:3080']) assert.throws(() => browserUrl(url, product))
  assert.equal(browserUrl('https://example.com', product), 'https://example.com/')
  assert.equal(browserUrl('http://127.0.0.1:8877', product), 'http://127.0.0.1:8877/')
  assert.equal(browserUrl('about:blank', product), 'about:blank')
})
test('remote web contents have no preload, node, permissions or insecure embedding', () => {
  const preferences = browserPreferences('persist:test')
  assert.equal(preferences.preload, undefined)
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.webviewTag, false)
  assert.equal(preferences.webSecurity, true); assert.equal(preferences.disableDialogs, true)
})
test('user controls accept only the exact trusted main frame', () => {
  const contents = { mainFrame: { url: product + '/' } }
  assert.equal(trustedBrowserSender({ sender: contents, senderFrame: contents.mainFrame }, contents, product), true)
  assert.equal(trustedBrowserSender({ sender: contents, senderFrame: { url: product + '/' } }, contents, product), false)
  contents.mainFrame.url = 'https://example.com'
  assert.equal(trustedBrowserSender({ sender: contents, senderFrame: contents.mainFrame }, contents, product), false)
})
test('native view bounds are zoom aware, finite and constrained to product content', () => {
  assert.deepEqual(browserBounds({ x: 500, y: 100, width: 600, height: 800 }, [1000, 900]), { x: 500, y: 100, width: 500, height: 800 })
  assert.deepEqual(browserBounds({ x: 100, y: 100, width: 100, height: 100 }, [1000, 900], 2), { x: 200, y: 200, width: 200, height: 200 })
  assert.equal(browserBounds({ x: NaN, y: 0, width: 10, height: 10 }, [1000, 900]), undefined)
  assert.equal(browserBounds(undefined, [1000, 900]), undefined)
  for (const owner of ['', null, 'x'.repeat(513)]) assert.throws(() => validOwner(owner))
})
test('agent browser code contains no system input, external-browser launch or native focus activation', async () => {
  const source = await readFile(new URL('../src/browser-workspace.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\.(?:focus|show|showInactive|sendInputEvent)\(|openExternal|osascript|pyautogui/)
  const main = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(main, /shell\.openExternal/)
  assert.match(main, /trustedBrowserSender/)
})
