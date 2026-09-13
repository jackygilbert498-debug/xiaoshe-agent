/** Explicitly gated local acceptance; never imported by ordinary app startup. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { callAcceptanceRpc } from './interaction-acceptance.mjs'
import { desktopCapturer, systemPreferences } from 'electron'

export async function runBrowserUiAcceptance({ target, workspace, requestBrowser, productUrl, reportDirectory }) {
  const checks = []; let ownerId; let server; const created = []
  const rpc = (method, payload) => callAcceptanceRpc(productUrl, method, payload)
  const inspect = code => target.webContents.executeJavaScript(code)
  const waitFor = async (fn, label, timeout = 15000) => {
    const until = Date.now() + timeout
    while (Date.now() < until) { if (await fn()) return; await delay(150) }
    const detail = await inspect(`(()=>{const el=document.querySelector('.browser-page-slot');const box=el?.getBoundingClientRect();return {visibility:document.visibilityState,modalCount:document.querySelectorAll('[aria-modal="true"]').length,slot:box?{x:box.x,y:box.y,width:box.width,height:box.height}:null}})()`).catch(() => null)
    throw new Error(`Timed out: ${label}; windowVisible=${target.isVisible()}; detail=${JSON.stringify(detail)}`)
  }
  const click = async label => {
    const query = `[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(label)}&&!el.disabled)`
    await waitFor(() => inspect(`!!(${query})`), `button ${label}`)
    return inspect(`(()=>{const button=${query};if(!button)return false;button.click();return true})()`)
  }
  const step = async (name, fn) => { await fn(); checks.push({ name, passed: true }); process.stdout.write(`[通过] ${name}\n`) }
  const browser = (command, args = {}) => requestBrowser({ origin: productUrl, ownerId, command, args })
  let saved = ''
  try {
    await mkdir(reportDirectory, { recursive: true })
    await waitFor(() => inspect('!!document.querySelector("button.primary-session")'), 'product shell')
    const baseline = (await rpc('session.list', {})).items.map(row => row.sessionId)
    assert.equal(await inspect('(()=>{document.querySelector("button.primary-session").click();return true})()'), true)
    await waitFor(async () => {
      const rows = (await rpc('session.list', {})).items.filter(row => !baseline.includes(row.sessionId))
      if (rows.length === 1) { ownerId = rows[0].sessionId; created.push(ownerId); return true }
      return false
    }, 'owned test session')
    await rpc('session.rename', { sessionId: ownerId, title: '小蛇专用浏览器 · 本机验收' })
    await waitFor(() => inspect('!!document.querySelector("button[aria-controls=xsla-browser-dock]:not(:disabled)")'), 'browser launcher')
    server = createServer((request, response) => {
      if (request.url === '/saved') { request.setEncoding('utf8'); request.on('data', value => { saved += value }); request.on('end', () => response.end('ok')); return }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<!doctype html><meta charset="utf-8"><title>松果项目 · 验收页面</title><style>body{font:15px system-ui;line-height:1.8;color:#244036;margin:32px;background:#f7faf8}h1{font-size:25px}input,button{font:inherit;padding:10px;border:1px solid #a8c1b2;border-radius:8px}label{display:block;margin:25px 0}p{padding:16px;background:#e8f2ec}</style><h1>松果资料工作台</h1><p>这是小蛇自己的网页。你可以继续使用其他应用。</p><form id="form"><label>项目名称 <input id="project" aria-label="项目名称"></label><button>保存项目</button></form><p id="result">等待保存</p><script>form.onsubmit=e=>{e.preventDefault();result.textContent='已保存：'+project.value;fetch('/saved',{method:'POST',body:project.value})}</script>`)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`
    let snapshot
    await step('真实产品界面自动显示本会话浏览器及原生网页', async () => {
      snapshot = await browser('open', { url })
      await waitFor(() => inspect('!!document.querySelector("#xsla-browser-dock")'), 'browser dock')
      await waitFor(() => workspace.bounds?.width > 250, 'native mounted bounds')
      assert.equal(workspace.activeOwner, ownerId)
      assert.ok(await inspect('document.querySelector(".browser-address input").getBoundingClientRect().width>100'))
    })
    await step('界面暂停/接管/交回按钮控制真实工具，不是空按钮', async () => {
      assert.equal(await click('我来接管'), true)
      await waitFor(() => workspace.status(ownerId).mode === 'user', 'takeover')
      await assert.rejects(browser('snapshot', { tab_id: snapshot.tab_id }), { code: 'BROWSER_PAUSED' })
      assert.equal(await click('交给小蛇'), true)
      await waitFor(() => workspace.status(ownerId).mode === 'agent', 'handback')
      assert.equal(await click('暂停'), true)
      await waitFor(() => workspace.status(ownerId).mode === 'paused', 'pause')
      assert.equal(await click('交给小蛇'), true)
      await waitFor(() => workspace.status(ownerId).mode === 'agent', 'resume')
    })
    await step('确认框出现时原生网页让位，取消后恢复', async () => {
      assert.equal(await click('桌面控制…'), true)
      await waitFor(() => !workspace.bounds, 'native view hidden behind modal')
      assert.equal(workspace.status(ownerId).desktop_allowed, false)
      assert.equal(await click('保持隔离'), true)
      await waitFor(() => !!workspace.bounds, 'native view restored')
    })
    if (process.env.XIAOSHE_BROWSER_LIVE_AGENT === '1') {
      await step('真实小蛇模型完成网页填写、提交及回读核对', async () => {
        await rpc('session.prompt', { sessionId: ownerId, mode: 'queue', content: [{ type: 'text', text: `打开这个网页 ${url}，填写项目名称“独立工作台-7429”，保存并核对实际显示的结果。不要抢我的电脑。只操作这个验收页面，不要用命令行访问接口，也不要改任何环境配置。` }] })
        await waitFor(async () => !(await rpc('session.list', {})).items.find(row => row.sessionId === ownerId)?.running, 'agent task completion', 140000)
        const history = await rpc('session.history', { sessionId: ownerId, maxMessages: 30 })
        const events = history.events.map(row => row.event)
        const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
        const answers = events.filter(event => event.type === 'assistant/message').flatMap(event => (event.data.message?.content ?? event.data.content ?? []).filter(block => block.type === 'text').map(block => block.text))
        await writeFile(join(reportDirectory, 'agent-task.json'), JSON.stringify({ ownerId, calls, answer: answers.join('\n'), serverSavedValue: saved }, null, 2))
        assert.equal(saved, '独立工作台-7429')
        assert.ok(calls.includes('browser_type') && calls.includes('browser_click'))
        assert.ok(!calls.some(name => name.startsWith('screen_') || name === 'bash'))
        assert.match(answers.join('\n'), /已保存|保存成功|保存.*核对|完成/)
      })
    }
    const activeTab = workspace.status(ownerId).active_tab
    await step('收起后仍能后台工作，再次展开不丢网页', async () => {
      assert.equal(await click('收起'), true)
      await waitFor(() => !workspace.bounds, 'dock unmount')
      assert.match((await browser('snapshot', { tab_id: activeTab })).text, /松果资料/)
      assert.equal(await click('浏览器'), true)
      await waitFor(() => !!workspace.bounds, 'dock reopen')
    })
    await delay(600)
    await writeFile(join(reportDirectory, 'product-controls.png'), (await target.capturePage()).toPNG())
    const shot = await browser('screenshot', { tab_id: activeTab })
    const { readFile } = await import('node:fs/promises')
    await writeFile(join(reportDirectory, 'product-browser-page.png'), await readFile(shot.path))
    let nativeVisual = 'not_run_no_existing_screen_permission'
    // A renderer capture deliberately omits sibling native views. When screen
    // permission already exists, capture ONLY this owned test window instead;
    // do not request a new permission or include the user's desktop.
    if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'granted') {
      target.setOpacity(1); target.showInactive(); await delay(400)
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1440, height: 940 }, fetchWindowIcons: false })
      const own = sources.find(source => source.id === target.getMediaSourceId())
      if (own && !own.thumbnail.isEmpty()) { await writeFile(join(reportDirectory, 'native-window.png'), own.thumbnail.toPNG()); nativeVisual = 'captured_owned_window' }
      target.setOpacity(0.01)
    }
    process.stdout.write(`[视觉] ${nativeVisual}\n`)
    await writeFile(join(reportDirectory, 'report.json'), JSON.stringify({ accepted: true, checks, ownerId, nativeBounds: workspace.bounds, nativeVisual, authenticatedExternalSiteTested: false }, null, 2))
  } catch (error) {
    await writeFile(join(reportDirectory, 'report.json'), JSON.stringify({ accepted: false, checks, error: error.stack }, null, 2)); throw error
  } finally {
    for (const sessionId of created) {
      await rpc('session.cancel', { sessionId }).catch(() => {})
      await rpc('workspace.archiveSession', { sessionId }).catch(() => {})
    }
    server?.closeAllConnections(); server?.close()
  }
}
