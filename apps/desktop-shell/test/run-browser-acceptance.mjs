/** Run with Electron, not node:test. All accounts/data are synthetic and local. */
import { app, BrowserWindow, screen, session } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { BrowserWorkspace } from '../src/browser-workspace.mjs'
import { prepareAcceptanceTabCapture, captureAcceptancePng } from '../src/browser-acceptance-ready.mjs'
import { createBrowserEndpoint, requestBrowser } from '../../../scripts/isolated-browser-protocol.mjs'
process.on('uncaughtException', error => { process.stderr.write(`Native acceptance uncaught: ${error.stack}\n`); app.exit(1) })

const output = resolve(process.env.XIAOSHE_BROWSER_ACCEPTANCE_OUTPUT || 'output/acceptance/isolated-browser-native')
const storageProbe = process.env.XIAOSHE_BROWSER_STORAGE_PROBE === '1' ? JSON.parse(await readFile(join(output, 'storage-probe.json'), 'utf8')) : undefined
const profile = storageProbe?.profile || process.env.XIAOSHE_BROWSER_ACCEPTANCE_PROFILE || await mkdtemp(join(tmpdir(), 'xiaoshe-browser-native-'))
app.setPath('userData', profile)
const checks = []
const popupFocusObservations = []
const startupFocusObservations = []
const windowFocusEvents = []
const popupLifecycleEvents = []
app.on('browser-window-focus', (_event, window) => windowFocusEvents.push({ id: window.id, at: Date.now() }))
let workspace; let endpoint; let host; let userWindow; let server
const fixture = `<!doctype html><meta charset="utf-8"><title>专用浏览器验收 · 松果资料</title>
<style>body{font:16px system-ui;line-height:1.7;margin:32px;color:#253f31;background:#f3f8f5}input,button{font:inherit;padding:10px;border:1px solid #bdcdc3;border-radius:8px}label{display:block;margin:20px 0}h1{font-size:24px}#result{padding:20px;background:#e3f0e8}footer{margin-top:800px}</style>
<h1>松果资料工作台</h1><p>仅用于本机验收，不连接真实账号。</p><form id="form"><label>项目名称 <input id="project" aria-label="项目名称"></label><button type="submit">保存项目</button></form><p id="result">等待保存</p>
<label>密码 <input id="password" type="password" value="synthetic-password"></label><label>验证码 <input id="otp" autocomplete="one-time-code"></label><label>文件 <input id="file" type="file"></label>
<a href="/popup" target="_blank">打开子页面</a><button onclick="window.lastPopupReturned=window.open('/popup?opener=1','xs-sso','width=600,height=480')!==null">打开登录子页面</button><footer>底部校验：PINE-7429</footer>
<script>form.onsubmit=e=>{e.preventDefault();result.textContent='已保存：'+project.value;fetch('/saved',{method:'POST',body:project.value})};project.addEventListener('input',()=>{if(!document.getElementById('dynamic-validation')){const hint=document.createElement('button');hint.id='dynamic-validation';hint.type='button';hint.textContent='校验提示';form.prepend(hint)}});localStorage.setItem('synthetic-login','fixture-only');document.cookie='fixture_session=saved; Max-Age=86400; SameSite=Lax';window.addEventListener('message',event=>{if(event.origin===location.origin)window.popupReply=event.data});</script>`
let saved = ''
function frontmost() { try { return process.platform === 'darwin' ? execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8', timeout: 2000 }).trim() : BrowserWindow.getFocusedWindow()?.id ?? null } catch { return 'unavailable' } }
function popupFocusSnapshot() {
  const identity = frontmost()
  let ownApplication = process.platform === 'darwin' ? undefined : identity === 'unavailable' ? undefined : identity !== null
  if (process.platform === 'darwin' && identity !== 'unavailable') {
    try {
      const info = execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'pid', identity], { encoding: 'utf8', timeout: 2000 })
      const pid = Number(info.match(/"pid"=(\d+)/u)?.[1])
      if (Number.isSafeInteger(pid) && pid > 0) ownApplication = pid === process.pid
    } catch {}
  }
  return { at: Date.now(), identity, ownApplication, hostFocused: host?.isFocused() ?? false, focusEvents: windowFocusEvents.length }
}
function focusChangeClassification(before, after) {
  if (after.hostFocused || after.focusEvents > before.focusEvents || (after.ownApplication === true && before.ownApplication !== true)) return 'test-application-focus'
  if (before.identity === 'unavailable' || after.identity === 'unavailable') return 'observation-unavailable'
  if (before.identity !== after.identity) return after.ownApplication === false ? 'external-application-change' : 'unattributed-focus-change'
  return 'unchanged'
}
async function step(name, fn) { await fn(); checks.push({ name, passed: true }); process.stdout.write(`[通过] ${name}\n`) }
const owner = 'native-browser-acceptance'
let snapshot
function element(name) { const result = snapshot.elements.find(row => row.name === name); assert.ok(result, `missing element ${name}`); return { tab_id: snapshot.tab_id, snapshot_id: snapshot.snapshot_id, element_id: result.element_id } }
async function call(command, args = {}, extra = {}) { return requestBrowser({ origin: 'http://127.0.0.1:38991', root: join(profile, 'bridge'), ownerId: owner, command, args, ...extra }) }

async function run() {
try {
  startupFocusObservations.push({ stage: 'before-ready', ...popupFocusSnapshot() })
  await app.whenReady(); await mkdir(output, { recursive: true })
  startupFocusObservations.push({ stage: 'ready', ...popupFocusSnapshot() })
  server = createServer((request, response) => {
    if (request.url === '/slow') { request.on('close', () => response.destroy()); return }
    if (request.url === '/saved') { request.setEncoding('utf8'); request.on('data', value => { saved += value }); request.on('end', () => response.end('ok')); return }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(request.url === '/stored' ? '<title>登录保存检查</title><p>不写入存储，只检查上次运行保留的数据。</p>' : request.url?.startsWith('/popup') ? '<title>独立子页面</title><h1>子页面成功</h1><script>if(window.opener)window.opener.postMessage("XS-SSO-READY",location.origin)</script>' : request.url === '/capture-second' ? fixture.replace('<h1>', '<h1>第二标签 · ') : fixture)
  })
  await new Promise(resolveListen => server.listen(storageProbe ? Number(new URL(storageProbe.origin).port) : 0, '127.0.0.1', resolveListen))
  const url = `http://127.0.0.1:${server.address().port}/`
  host = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  // Synthetic host markup for the independent capture preflight, not a claim
  // that this component test loaded the full product frontend.
  await host.loadURL('data:text/html,' + encodeURIComponent(`<title>小蛇浏览器验收</title><body style="background:#f2f7f3;font:20px system-ui">
    仅操作右侧的独立网页<div data-session-id="${owner}" class="on"></div><div class="xsla-shell"><form class="cbox"><textarea name="content"></textarea></form></div>
    <div id="xsla-browser-dock"><div class="browser-page-slot" style="position:absolute;left:300px;top:55px;width:670px;height:680px"></div></div></body>`))
  // An almost transparent fixture must not intercept real user clicks. Keep
  // the window focusable so programmatic application activation still fails.
  host.setIgnoreMouseEvents(true)
  host.setOpacity(0.01); host.showInactive()
  startupFocusObservations.push({ stage: 'host-shown-inactive', ...popupFocusSnapshot() })
  workspace = new BrowserWorkspace({ window: host, productUrl: 'http://127.0.0.1:38991', userDataPath: profile, partition: 'persist:acceptance-browser' })
  const nativeAttach = host.contentView.addChildView.bind(host.contentView)
  host.contentView.addChildView = (view, ...args) => {
    const result = nativeAttach(view, ...args)
    popupLifecycleEvents.push({ stage: 'native-view-attached', at: Date.now(), webContentsId: view.webContents?.id })
    return result
  }
  const createTab = workspace.createTab.bind(workspace)
  workspace.createTab = (...args) => {
    const popup = !!args[2]?.webContents
    if (popup) popupLifecycleEvents.push({ stage: 'popup-create-start', at: Date.now(), webContentsId: args[2].webContents.id })
    const tab = createTab(...args)
    if (popup) popupLifecycleEvents.push({ stage: 'popup-create-return', at: Date.now(), webContentsId: tab.view.webContents.id })
    return tab
  }
  endpoint = await createBrowserEndpoint({ origin: 'http://127.0.0.1:38991', root: join(profile, 'bridge'), dispatch: (...args) => workspace.agent(...args) })
  // This component fixture supplies its own dock geometry (the product UI has
  // a separate auto-expand journey). Establish real native layout before the
  // first snapshot; a never-presented 0x0 page is now correctly rejected.
  workspace.mount(owner, { x: 300, y: 55, width: 670, height: 680 })
  if (storageProbe) {
    await step('退出并重启 Electron 后，专用登录 Cookie 与本地存储仍保留', async () => {
      const current = await call('open', { url: url + 'stored' })
      assert.equal((await workspace.session.cookies.get({ name: 'fixture_session' }))[0]?.value, 'saved')
      assert.equal(await workspace.tab(current.tab_id, owner).view.webContents.executeJavaScript('localStorage.getItem("synthetic-login")'), 'fixture-only')
      assert.equal((await session.defaultSession.cookies.get({ name: 'fixture_session' })).length, 0)
    })
    await writeFile(join(output, 'storage-restart-report.json'), JSON.stringify({ accepted: true, checks, profile }, null, 2))
    return
  }
  const frontBefore = frontmost(); const cursorBefore = screen.getCursorScreenPoint()
  await step('真实浏览器打开、读取正文与元素', async () => {
    snapshot = await call('open', { url }); assert.match(snapshot.text, /松果资料工作台/); assert.ok(snapshot.elements.length >= 6)
    assert.equal(snapshot.next_verification.status, 'pending_not_verified')
    assert.deepEqual(snapshot.next_verification.arguments, { tab_id: snapshot.tab_id, after_snapshot_id: snapshot.snapshot_id, expect_url: url })
    const wc = workspace.tab(snapshot.tab_id, owner).view.webContents
    assert.equal(await wc.executeJavaScript('typeof require'), 'undefined')
    assert.equal(await wc.executeJavaScript('typeof window.xiaosheDesktop'), 'undefined')
  })
  await step('打开页面缺少网址断言时拒绝假成功，补全条件仍可验证原基线', async () => {
    const original = snapshot.snapshot_id
    await assert.rejects(call('verify', { tab_id: snapshot.tab_id, after_snapshot_id: original, expect_text: '松果资料工作台' }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
    assert.equal(workspace.tab(snapshot.tab_id, owner).lastSnapshot.id, original)
    const verified = await call('verify', { ...snapshot.next_verification.arguments, expect_text: '松果资料工作台' })
    assert.equal(verified.status, 'verified')
    assert.equal(verified.baseline_snapshot_id, original)
    assert.notEqual(verified.snapshot_id, original)
    snapshot = verified.current
  })
  await step('原动作文本断言的字面转义错误在回读前拒绝，修正后仍独立验证同一基线', async () => {
    snapshot = await call('open', { url, tab_id: snapshot.tab_id })
    const tab = workspace.tab(snapshot.tab_id, owner), baseline = tab.lastSnapshot
    const expected = snapshot.text.slice(0, 300)
    assert.ok(expected.includes('\n'))
    await assert.rejects(call('verify', { ...snapshot.next_verification.arguments, expect_text: expected.replaceAll('\n', '\\n') }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
    assert.strictEqual(tab.lastSnapshot, baseline)
    assert.equal(saved, '', 'an assertion rejection must not cause a submit')
    const verified = await call('verify', { ...snapshot.next_verification.arguments, expect_text: expected })
    assert.equal(verified.status, 'verified')
    assert.equal(verified.baseline_snapshot_id, baseline.id)
    assert.notEqual(verified.current.snapshot_id, baseline.id)
    snapshot = verified.current
  })
  await step('后台输入、点击并核对服务器实际保存结果', async () => {
    const inputId = element('项目名称').element_id
    snapshot = await call('type', { ...element('项目名称'), text: '小蛇独立工作区-7429', replace: true })
    assert.equal(element('项目名称').element_id, inputId, 'the actual input retains identity when an input event prepends a new control')
    assert.equal(snapshot.elements[0].name, '校验提示')
    assert.notEqual(snapshot.elements[0].element_id, inputId)
    const typedBaseline = snapshot.snapshot_id
    await assert.rejects(call('verify', { tab_id: snapshot.tab_id, after_snapshot_id: typedBaseline, expect_text: '松果资料工作台' }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
    assert.equal(workspace.tab(snapshot.tab_id, owner).lastSnapshot.id, typedBaseline)
    const typedProof = await call('verify', snapshot.next_verification.arguments)
    assert.equal(typedProof.status, 'verified')
    assert.equal(typedProof.baseline_snapshot_id, typedBaseline)
    assert.deepEqual(typedProof.assertions, { expect_element_id: inputId, expect_value: '小蛇独立工作区-7429' })
    assert.deepEqual(typedProof.assertion_source, { kind: 'browser_type_input', owner_id: owner, tab_id: snapshot.tab_id,
      baseline_snapshot_id: typedBaseline, expect_element_id: inputId,
      input_sha256: createHash('sha256').update('小蛇独立工作区-7429', 'utf8').digest('hex') })
    snapshot = typedProof.current
    snapshot = await call('click', element('保存项目'))
    assert.match(snapshot.text, /已保存：小蛇独立工作区-7429/)
    assert.equal(saved, '小蛇独立工作区-7429')
    const proof = await call('verify', {
      tab_id: snapshot.tab_id,
      after_snapshot_id: snapshot.snapshot_id,
      expect_text: '已保存：小蛇独立工作区-7429',
    })
    assert.equal(proof.status, 'verified')
    assert.notEqual(proof.current.snapshot_id, snapshot.snapshot_id)
    assert.equal(proof.snapshot_id, proof.current.snapshot_id)
    assert.notEqual(proof.snapshot_id, proof.baseline_snapshot_id)
    await assert.rejects(call('click', { ...element('保存项目'), snapshot_id: proof.baseline_snapshot_id }), { code: 'BROWSER_STALE' })
    assert.equal(saved, '小蛇独立工作区-7429')
    snapshot = { ...proof.current, snapshot_id: proof.snapshot_id }
  })
  await step('显式引用待验输入仍独立读取真实DOM，错误参数不消耗基线且手写验证兼容', async () => {
    const input = JSON.stringify({ title: '松果', value: 12.375, note: '完整核对'.repeat(120) })
    const inputId = element('项目名称').element_id
    snapshot = await call('type', { ...element('项目名称'), text: input, replace: true })
    const baseline = snapshot.snapshot_id, tabId = snapshot.tab_id
    const reference = { tab_id: tabId, after_snapshot_id: baseline, use_action_input: true }
    assert.deepEqual(snapshot.next_verification.arguments, reference)
    assert.deepEqual(snapshot.next_verification.required_assertions, ['use_action_input'])
    for (const extra of [{ use_action_input: false }, { use_action_input: 'true' }, { expect_element_id: inputId }, { expect_value: input },
      { expect_closed: false }, { expectElementId: inputId }, { expectValue: input }, { expectClosed: false }]) {
      await assert.rejects(call('verify', { ...reference, ...extra }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
      assert.equal(workspace.tab(tabId, owner).lastSnapshot.id, baseline)
    }
    await assert.rejects(call('verify', { tab_id: tabId, after_snapshot_id: baseline,
      expect_element_id: inputId, expect_value: input.replace('12.375', '12.376') }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
    assert.equal(workspace.tab(tabId, owner).lastSnapshot.id, baseline)
    assert.equal(await workspace.tab(tabId, owner).view.webContents.executeJavaScript('document.querySelector("#project").value'), input)
    const verified = await call('verify', { ...reference, expect_text: '松果资料工作台' })
    assert.equal(verified.status, 'verified'); assert.notEqual(verified.current.snapshot_id, baseline)
    assert.deepEqual(verified.assertions, { expect_text: '松果资料工作台', expect_element_id: inputId, expect_value: input })
    assert.deepEqual(verified.assertion_source, { kind: 'browser_type_input', owner_id: owner, tab_id: tabId,
      baseline_snapshot_id: baseline, expect_element_id: inputId, input_sha256: createHash('sha256').update(input, 'utf8').digest('hex') })
    await assert.rejects(call('verify', reference), { code: 'BROWSER_STALE' })
    await assert.rejects(call('verify', { ...reference, after_snapshot_id: verified.current.snapshot_id }), { code: 'BROWSER_VERIFICATION_ARGUMENT' })
    snapshot = verified.current

    snapshot = await call('type', { ...element('项目名称'), text: input, replace: true })
    // Change only this synthetic page after the type snapshot. The verifier
    // must read the actual new DOM, not its stored input or returned hint.
    const changed = input.replace('12.375', '12.376')
    await workspace.tab(tabId, owner).view.webContents.executeJavaScript(`document.querySelector('#project').value=${JSON.stringify(changed)}`)
    const mismatch = await call('verify', snapshot.next_verification.arguments)
    assert.equal(mismatch.status, 'mismatch'); assert.equal(mismatch.assertions.expect_value, input)
    assert.equal(mismatch.current.elements.find(row => row.element_id === inputId).value, changed)
    assert.notEqual(mismatch.current.snapshot_id, snapshot.snapshot_id)
    snapshot = mismatch.current
    snapshot = await call('type', { ...element('项目名称'), text: '小蛇独立工作区-7429', replace: true })
    const manual = await call('verify', { tab_id: tabId, after_snapshot_id: snapshot.snapshot_id,
      expect_element_id: inputId, expect_value: '小蛇独立工作区-7429' })
    assert.equal(manual.status, 'verified'); assert.equal(manual.assertion_source, undefined)
    assert.equal(saved, '小蛇独立工作区-7429', 'verification and input-only probes must not submit the form')
    snapshot = manual.current
  })
  await step('超出可验证范围的输入和网址在修改前拒绝', async () => {
    const original = snapshot.snapshot_id, inputValue = snapshot.elements.find(row => row.name === '项目名称').value
    const tabCount = workspace.tabs.size
    await assert.rejects(call('type', { ...element('项目名称'), text: 'x'.repeat(2001), replace: true }), { code: 'BROWSER_ARGUMENT' })
    assert.equal(workspace.tab(snapshot.tab_id, owner).lastSnapshot.id, original)
    assert.equal(await workspace.tab(snapshot.tab_id, owner).view.webContents.executeJavaScript('document.querySelector("#project").value'), inputValue)
    await assert.rejects(call('open', { url: url + 'x'.repeat(2048) }), { code: 'BROWSER_ARGUMENT' })
    assert.equal(workspace.tabs.size, tabCount)
    assert.equal(workspace.tab(snapshot.tab_id, owner).lastSnapshot.id, original)
  })
  await step(process.platform === 'darwin' ? '系统前台应用保持不变（用户鼠标移动另行记录）' : '测试窗口没有取得焦点（不等同于系统级前台窗口探测）', async () => {
    assert.equal(frontmost(), frontBefore)
  })
  await step('窗口隐藏、面板收起后仍可连续输入、点击和核对保存', async () => {
    workspace.mount(undefined, undefined); host.hide()
    snapshot = await call('type', { ...element('项目名称'), text: '后台继续工作-7429', replace: true })
    snapshot = await call('click', element('保存项目'))
    assert.match(snapshot.text, /已保存：后台继续工作-7429/)
    assert.ok(saved.endsWith('后台继续工作-7429'))
    const proof = await call('verify', {
      tab_id: snapshot.tab_id,
      after_snapshot_id: snapshot.snapshot_id,
      expect_text: '已保存：后台继续工作-7429',
    })
    assert.equal(proof.status, 'verified')
    snapshot = proof.current
    assert.equal(frontmost(), frontBefore)
    host.showInactive(); workspace.mount(owner, { x: 300, y: 55, width: 670, height: 680 })
  })
  await step('独立输入通道不会改写另一窗口草稿', async () => {
    userWindow = new BrowserWindow({ width: 400, height: 240, show: false, webPreferences: { sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    await userWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<meta charset="utf-8"><textarea id="draft" autofocus>用户草稿：</textarea>'))
    await userWindow.webContents.executeJavaScript('(()=>{ const el=document.querySelector("textarea"); el.focus(); el.setSelectionRange(el.value.length,el.value.length) })()')
    // This synthetic user stream is directed to its own native contents. The
    // agent uses CDP in a different view concurrently, never system keystrokes.
    const writing = call('type', { ...element('项目名称'), text: '浏览器独立输入', replace: true })
    for (const char of 'ABCDE') { userWindow.webContents.sendInputEvent({ type: 'char', keyCode: char }); await delay(20) }
    snapshot = await writing
    assert.equal(await userWindow.webContents.executeJavaScript('document.querySelector("textarea").value'), '用户草稿：ABCDE')
    assert.equal(snapshot.elements.find(row => row.name === '项目名称').value, '浏览器独立输入')
  })
  await step('旧快照和跨会话标签无法操作', async () => {
    await assert.rejects(call('click', { ...element('保存项目'), snapshot_id: 'stale' }), { code: 'BROWSER_STALE' })
    await assert.rejects(call('snapshot', { tab_id: snapshot.tab_id }, { ownerId: 'other-session' }), { code: 'BROWSER_TAB' })
  })
  await step('密码、验证码、文件选择交给用户，密码不进入快照', async () => {
    assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-password/)
    for (const name of ['密码', '验证码', '文件']) await assert.rejects(call('click', element(name)), /用户接管/)
  })
  await step('暂停及接管禁止继续行动和另开标签绕过', async () => {
    for (const mode of ['paused', 'user']) {
      await workspace.ui(owner, 'mode', { mode })
      await assert.rejects(call('snapshot', { tab_id: snapshot.tab_id }), { code: 'BROWSER_PAUSED' })
      await assert.rejects(call('open', { url }), { code: 'BROWSER_PAUSED' })
      await assert.rejects(call('verify', { tab_id: snapshot.tab_id, after_snapshot_id: snapshot.snapshot_id, use_action_input: true }), { code: 'BROWSER_PAUSED' })
      assert.equal((await call('status')).mode, mode)
    }
    await workspace.ui(owner, 'mode', { mode: 'agent' }); snapshot = await call('snapshot', { tab_id: snapshot.tab_id })
  })
  await step('真实页面弹窗仍在独立浏览器中且不取得测试窗口焦点', async () => {
    for (const variant of [{ name: '打开子页面', opener: false }, { name: '打开登录子页面', opener: true }]) {
      const before = popupFocusSnapshot()
      snapshot = await call('click', element(variant.name))
      const immediate = popupFocusSnapshot()
      await delay(500)
      const after = popupFocusSnapshot()
      const observation = { variant: variant.opener ? 'opener-sso' : 'noopener-link', before, immediate, after,
        immediateClassification: focusChangeClassification(before, immediate), finalClassification: focusChangeClassification(before, after) }
      popupFocusObservations.push(observation)
      // An external user switch is inconclusive for the unchanged-foreground
      // claim, not evidence that the browser stole focus and never a green run.
      assert.equal(observation.immediateClassification, 'unchanged', `popup focus observation failed: ${JSON.stringify(observation)}`)
      assert.equal(observation.finalClassification, 'unchanged', `popup focus observation failed: ${JSON.stringify(observation)}`)
      assert.equal(after.identity, before.identity, `popup focus changed: ${JSON.stringify(observation)}`)
      assert.equal(immediate.identity, before.identity, `popup transiently changed focus: ${JSON.stringify(observation)}`)
      assert.equal(after.hostFocused, false, `popup focused its host: ${JSON.stringify(observation)}`)
      assert.equal(after.focusEvents, before.focusEvents, `popup emitted native window focus: ${JSON.stringify(observation)}`)
      const tabs = (await call('status')).tabs
      assert.equal(tabs.length, 2)
      const popup = tabs.find(tab => new URL(tab.url).pathname === '/popup')
      assert.ok(popup)
      if (variant.opener) {
        assert.equal(await workspace.tab(popup.tab_id, owner).view.webContents.executeJavaScript('Boolean(window.opener)'), true)
        const parent = workspace.tab(snapshot.tab_id, owner).view.webContents
        assert.equal(await parent.executeJavaScript('window.lastPopupReturned'), true)
        assert.equal(await parent.executeJavaScript('window.popupReply'), 'XS-SSO-READY', 'SSO opener postMessage must survive tab adoption')
      }
      await call('close', { tab_id: popup.tab_id })
      const proof = await call('verify', { tab_id: popup.tab_id, expect_closed: true })
      assert.equal(proof.status, 'verified')
    }
  })
  await step('滚动动作通过同标签的新快照独立核对', async () => {
    snapshot = await call('scroll', { tab_id: snapshot.tab_id, delta_y: 800 })
    const proof = await call('verify', {
      tab_id: snapshot.tab_id,
      after_snapshot_id: snapshot.snapshot_id,
      expect_scroll_y: snapshot.viewport.scroll_y,
    })
    assert.equal(proof.status, 'verified')
    snapshot = proof.current
  })
  await step('断线取消和用户暂停会终止慢页面等待并允许恢复', async () => {
    const controller = new AbortController()
    const pending = call('open', { url: url + 'slow', tab_id: snapshot.tab_id }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 160)
    await assert.rejects(pending, { code: 'BROWSER_CANCELLED' }); await delay(160)
    assert.equal((await call('status')).tabs.find(tab => tab.tab_id === snapshot.tab_id).busy, false)
    const waiting = call('open', { url: url + 'slow', tab_id: snapshot.tab_id })
    setTimeout(() => { void workspace.ui(owner, 'mode', { mode: 'paused' }) }, 160)
    await assert.rejects(waiting, { code: 'BROWSER_CANCELLED' })
    await workspace.ui(owner, 'mode', { mode: 'agent' }); snapshot = await call('open', { url, tab_id: snapshot.tab_id })
  })
  await step('桌面控制默认关闭，只有用户入口可临时授权', async () => {
    assert.equal((await call('status')).desktop_allowed, false)
    await assert.rejects(call('desktop', { allowed: true }), /tab_id|不支持/)
    await workspace.ui(owner, 'desktop', { allowed: true }); assert.equal((await call('status')).desktop_allowed, true)
    await workspace.ui(owner, 'desktop', { allowed: false }); assert.equal((await call('status')).desktop_allowed, false)
  })
  await step('页面不能调用小蛇服务、系统文件或原生桥', async () => {
    const wc = workspace.tab(snapshot.tab_id, owner).view.webContents
    assert.equal(await wc.executeJavaScript('fetch("http://127.0.0.1:38991/api/session.list").then(()=>true,()=>false)'), false)
    await assert.rejects(call('open', { url: 'file:///etc/passwd' }), /仅支持/)
    await assert.rejects(call('open', { url: 'http://localhost:38991' }), /控制界面/)
  })
  await step('网页截图有真实图像且不截系统桌面', async () => {
    const shot = await call('screenshot', { tab_id: snapshot.tab_id })
    const bytes = await readFile(shot.path); assert.ok(bytes.length > 10_000)
    await writeFile(join(output, 'private-browser-page.png'), bytes)
    assert.equal(shot.source, 'isolated-browser-only')
  })
  await step('独立回读截图先选择已有后台标签，真实合成表面可连续切换捕获', async () => {
    const first = workspace.tab(snapshot.tab_id, owner)
    const secondResult = await call('open', { url: url + 'capture-second' })
    const second = workspace.tab(secondResult.tab_id, owner)
    assert.equal(first.view.getVisible(), false)
    const mode = workspace.status(owner).mode, wasFocused = host.isFocused(), focusEvents = windowFocusEvents.length
    const captureHashes = new Map()
    for (let round = 0; round < 2; round++) for (const tab of [first, second]) {
      assert.equal(tab.view.getVisible(), false, 'the next capture starts on an inactive tab')
      const proof = await prepareAcceptanceTabCapture({ target: host, workspace, sessionId: owner, tab, expectedUrl: tab.view.webContents.getURL() })
      assert.equal(proof.tabId, tab.id); assert.equal(proof.viewport.visibility, 'visible')
      assert.equal(workspace.status(owner).mode, mode)
      const png = await captureAcceptancePng(tab.view.webContents)
      assert.ok(png.length > 10_000)
      assert.equal((await tab.view.webContents.executeJavaScript('document.querySelector("h1").textContent')).includes('第二标签'), tab === second)
      captureHashes.set(tab.id, createHash('sha256').update(png).digest('hex'))
      await writeFile(join(output, `inactive-tab-${round}-${tab === first ? 'first' : 'second'}.png`), png, { flag: 'wx' })
    }
    assert.notEqual(captureHashes.get(first.id), captureHashes.get(second.id), 'visually distinct tabs cannot reuse a stale screenshot')
    assert.equal(host.isFocused(), wasFocused, 'capture must not activate the host window')
    assert.equal(windowFocusEvents.length, focusEvents, 'capture must not transiently activate any test window')
    await workspace.ui(owner, 'close', { tab_id: second.id })
    await workspace.ui(owner, 'select', { tab_id: first.id })
  })
  await step('专用登录存储可保存，与产品及系统浏览器隔离', async () => {
    const cookies = await workspace.session.cookies.get({ name: 'fixture_session' })
    assert.equal(cookies[0]?.value, 'saved')
    assert.equal((await session.defaultSession.cookies.get({ name: 'fixture_session' })).length, 0)
    await workspace.session.cookies.flushStore(); workspace.session.flushStorageData()
    await writeFile(join(output, 'storage-probe.json'), JSON.stringify({ profile, origin: url, partition: 'persist:acceptance-browser' }))
  })
  await writeFile(join(output, 'report.json'), JSON.stringify({ accepted: true, completedAt: new Date().toISOString(), checks,
    platform: process.platform, electronVersion: process.versions.electron,
    focusObservation: process.platform === 'darwin' ? 'system-frontmost-application' : 'electron-test-window',
    focusBefore: frontBefore, focusAfter: frontmost(), popupFocusObservations, popupLifecycleEvents, startupFocusObservations, windowFocusEvents, cursorBefore, cursorAfter: screen.getCursorScreenPoint(), profile, authenticatedExternalSiteTested: false }, null, 2))
} catch (error) {
  process.stderr.write(`${error.stack}\n`)
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'report.json'), JSON.stringify({ accepted: false, checks, error: error.message, popupFocusObservations,
    focusFailure: popupFocusSnapshot(), popupLifecycleEvents, startupFocusObservations, windowFocusEvents, testProcessId: process.pid, profile }, null, 2))
  process.exitCode = 1
} finally {
  await endpoint?.close(); await workspace?.dispose()
  userWindow?.destroy(); host?.destroy(); server?.closeAllConnections(); server?.close()
  app.exit(process.exitCode || 0)
}
}
void run()
