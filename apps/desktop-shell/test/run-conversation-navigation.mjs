/** Real Chromium + React + built shell + real DshTaskTimeline. Only session
 * data and unrelated Host ports are fixtures; no real conversations or API use. */
import assert from 'node:assert/strict'
import { app, BrowserWindow, net } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

process.env.XIAOSHE_NATIVE_SHELL_FIXTURE_ONLY = '1'
const fixture = await import('./run-native-shell-journey.mjs')
const output = resolve(process.env.XIAOSHE_NATIVE_SHELL_JOURNEY_OUTPUT)
const artifact = resolve(process.env.XIAOSHE_NATIVE_SHELL_CLIENT_ARTIFACT)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const provider = pathToFileURL(resolve(root, 'packages/runtime-dsh-provider/test/.generated/client.mjs')).href
await mkdir(dirname(output), { recursive: true })
const checks = [], screenshots = [], errors = [], requests = []
const keepAlive = setInterval(() => {}, 1000)
let browser
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  try {
    await app.whenReady()
    browser = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false, offscreen: true } })
    browser.webContents.session.protocol.handle('file', async request => {
      const path = new URL(request.url).pathname
      if (path.endsWith('/api/xiaoshe/legacy-adapted-brand-raster')) return new Response(await readFile(resolve(root, 'packages/native-shell-legacy-adapted/ui/assets/icon-256.png')), { headers: { 'content-type': 'image/png' } })
      if (path.endsWith('/api/xiaoshe/legacy-adapted-brand-icon')) return new Response(await readFile(resolve(root, 'packages/native-shell-legacy-adapted/ui/assets/snake.svg')), { headers: { 'content-type': 'image/svg+xml' } })
      return net.fetch(request, { bypassCustomProtocolHandlers: true })
    })
    browser.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, callback) => {
      requests.push(request.url); callback({ cancel: true })
    })
    browser.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
    const evaluate = source => browser.webContents.executeJavaScript(source)
    const wait = source => fixture.waitFor(browser, source)
    const html = resolve(dirname(output), 'conversation-navigation.html')
    await writeFile(html, `<!doctype html><meta charset="utf-8"><div id="root"></div><script>${fixture.createRendererBootstrap().replaceAll('</script', '<\\/script')}</script><script src="${pathToFileURL(artifact).href}"></script>`)
    await browser.loadFile(html)
    browser.webContents.debugger.attach('1.3')
    await browser.webContents.debugger.sendCommand('Page.enable')
    await browser.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await wait('window.__journey?.state.client !== undefined')
    await evaluate(`(async()=>{
      const {DshTaskTimeline}=await import(${JSON.stringify(provider)});
      const j=window.__journey, s=j.state.snapshots;
      window.__browserOwners=['acceptance-session','retry-session','error-reveal-session','other-session'];
      j.historySession='acceptance-session'; j.loadCalls=0; j.historyHold=false; j.historyFail=false;
      j.nodes=Array.from({length:1000},(_,seq)=>({seq,kind:seq%2?'assistant':'user',content:[{type:'text',text:seq%2?'答复 '+seq+'：这是用于验证历史滚动位置的多行内容。'.repeat(seq%5+1):'消息 '+seq}]}));
      j.otherNodes=[{seq:1,kind:'user',content:[{type:'text',text:'另一会话的独立内容'}]}];
      const sessions={list:{getSnapshot:()=>({current:j.historySession,byId:{}}),subscribe:fn=>{j.historyChanged=fn;return()=>{}}},binding:id=>({session:{getSnapshot:()=>({projectionReady:true,nodes:id==='other-session'?j.otherNodes:j.nodes})}})};
      j.history=new DshTaskTimeline(sessions);
      j.ports.taskTimeline={getSnapshot:()=>j.history.getSnapshot(),getOutline:()=>j.history.getOutline(),reveal:seq=>j.history.reveal(seq),subscribe:fn=>j.history.subscribe(fn),loadEarlier(){
        j.loadCalls++;
        const stream=document.querySelector('.stream'),top=stream.getBoundingClientRect().top;
        const anchor=[...stream.querySelectorAll('.events>[data-event-key]')].find(n=>n.getBoundingClientRect().bottom>top+1);
        j.historyAnchor={key:anchor?.dataset.eventKey,top:anchor?.getBoundingClientRect().top-top};
        if(j.historyFail)throw Error('controlled history failure');
        if(j.historyHold){j.releaseHistory=()=>j.history.loadEarlier();return}
        j.history.loadEarlier();
      }};
      j.switchHistory=id=>{j.historySession=id;s.runtime={...s.runtime,currentSessionId:id,sessions:{...s.runtime.sessions,[id]:{state:'idle'}}};j.historyChanged();j.notify()};
      j.mount();
    })()`)
    await wait('document.querySelectorAll(".event").length===160')
    await pause(300)
    assert.equal(await evaluate('window.__journey.loadCalls'), 0, 'opening a session must not drain history')
    assert.equal(await evaluate('document.querySelector(".timeline-load-earlier")'), null)
    const metrics = () => evaluate(`(()=>{const nav=document.querySelector('.turn-index'),markers=[...document.querySelectorAll('.turn-index-marker')];return {
      width:nav?.getBoundingClientRect().width,height:nav?.getBoundingClientRect().height,
      count:markers.length,scrollable:nav?[nav,...nav.querySelectorAll('*')].some(n=>/auto|scroll/.test(getComputedStyle(n).overflowY)):false,
      centers:markers.map(n=>{const s=getComputedStyle(n,'::before'),m=new DOMMatrix(s.transform);return n.getBoundingClientRect().left+parseFloat(s.left)+m.m41+parseFloat(s.width)/2}),
      viewport:document.querySelector('.stream').clientHeight, current:document.querySelector('.turn-index-marker[data-current=true]')?.dataset.turnIndex
    }})()`)
    const firstMetrics = await metrics()
    assert.equal(firstMetrics.width, 24)
    assert.equal(firstMetrics.count, 5)
    assert.ok(firstMetrics.height <= 168)
    assert.equal(firstMetrics.scrollable, false)
    assert.ok(Math.max(...firstMetrics.centers) - Math.min(...firstMetrics.centers) < 0.1)
    checks.push('compact centered navigation without nested scroll')
    await evaluate(`window.__historyScrollEvents=[];document.querySelector('.stream').addEventListener('scroll',e=>window.__historyScrollEvents.push({top:e.currentTarget.scrollTop,time:performance.now()}))`)

    // Read upward in two actual scroll steps; the second approaches the edge.
    const nearTop = async () => {
      const observed=await evaluate('window.__historyScrollEvents.length')
      await evaluate(`document.querySelector('.stream').scrollTo({top:600,behavior:'instant'})`)
      await wait(`window.__historyScrollEvents.length>${observed} && document.querySelector('.stream').scrollTop>400 && document.querySelector('.stream').scrollTop<850`)
      await evaluate(`document.querySelector('.stream').scrollTo({top:120,behavior:'instant'})`)
    }
    await nearTop()
    await wait('window.__journey.history.getSnapshot().items.length===480')
    await pause(500)
    const anchorDelta = () => evaluate(`(()=>{const j=window.__journey,stream=document.querySelector('.stream');const a=[...document.querySelectorAll('.events>[data-event-key]')].find(n=>n.dataset.eventKey===j.historyAnchor.key);return a.getBoundingClientRect().top-stream.getBoundingClientRect().top-j.historyAnchor.top})()`)
    assert.ok(Math.abs(await anchorDelta()) <= 2, 'prepend must retain the same visible message; delta='+await anchorDelta())
    assert.equal(await evaluate('window.__journey.loadCalls'), 1, 'one scroll must not cascade through every page')
    checks.push('upward scroll automatically loads 320 earlier records with stable anchor')

    // Delayed pages coalesce repeated scroll/wheel events; concurrent replies
    // are not counted as prepended height.
    await evaluate('window.__journey.historyHold=true')
    await nearTop()
    await wait('window.__journey.loadCalls===2')
    await evaluate(`(()=>{const stream=document.querySelector('.stream');for(let i=0;i<8;i++)stream.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));window.__journey.nodes.push({seq:1000,kind:'assistant',content:[{type:'text',text:'concurrent streamed reply'}]});window.__journey.historyChanged()})()`)
    assert.equal(await evaluate('window.__journey.loadCalls'), 2)
    await evaluate(`document.querySelector('.stream').scrollTo({top:900,behavior:'instant'})`)
    await wait('window.__historyScrollEvents.at(-1)?.top===900')
    await evaluate(`(()=>{const j=window.__journey,s=document.querySelector('.stream'),top=s.getBoundingClientRect().top,a=[...s.querySelectorAll('.events>[data-event-key]')].find(n=>n.getBoundingClientRect().bottom>top+1);j.historyAnchor={key:a.dataset.eventKey,top:a.getBoundingClientRect().top-top}})()`)
    await evaluate('window.__journey.releaseHistory();window.__journey.historyHold=false')
    await wait('window.__journey.history.getSnapshot().items.length===801')
    await pause(500)
    assert.ok(Math.abs(await anchorDelta()) <= 2, 'concurrent replies must not move the reading anchor')
    checks.push('rapid input coalesced; delayed page and concurrent reply preserve reading position')

    // Read a middle section without loading the final page, then inspect both
    // themes and zoom sizes against the real built stylesheet.
    await evaluate(`document.querySelector('.stream').scrollTo({top:3000,behavior:'instant'})`)
    await pause(100)
    for (const [width,height,zoom,theme] of [[1440,900,1,'light'],[1440,900,1,'ink-jade'],[1440,900,1.5,'ink-jade'],[500,700,1,'light']]) {
      browser.setContentSize(width,height);browser.webContents.setZoomFactor(zoom)
      await evaluate(`(()=>{if(document.querySelector('.xsla-shell').dataset.theme!==${JSON.stringify(theme)})document.querySelector('.theme-toggle').click()})()`)
      await wait(`document.querySelector('.xsla-shell').dataset.theme===${JSON.stringify(theme)}`)
      await pause(200)
      const current = await metrics()
      assert.equal(current.width,24)
      assert.ok(current.count > 0 && current.count <= 5)
      assert.ok(current.height <= current.viewport - 16)
      assert.equal(current.scrollable,false)
      assert.ok(Math.max(...current.centers)-Math.min(...current.centers)<0.1)
      const path=resolve(dirname(output),`navigation-${width}-${zoom}-${theme}.png`)
      await writeFile(path,(await browser.webContents.capturePage()).toPNG());screenshots.push(path)
    }
    checks.push('light/dark, narrow window and 150% zoom remain bounded and aligned')
    browser.setContentSize(1440,900);browser.webContents.setZoomFactor(1)
    await pause(150)
    // Walk every page without moving the conversation: all 500 user turns
    // remain reachable even though only a subset of records was rendered.
    await evaluate(`document.querySelector('.stream').scrollTo({top:500,behavior:'instant'})`)
    await pause(150)
    while (await evaluate('!document.querySelector(".turn-index-page[data-direction=previous]").disabled')) {
      const before = await evaluate('document.querySelector(".turn-index-marker").dataset.turnIndex')
      await evaluate('document.querySelector(".turn-index-page[data-direction=previous]").click()')
      await wait(`document.querySelector('.turn-index-marker').dataset.turnIndex!==${JSON.stringify(before)}`)
    }
    const reached=[]
    for (;;) {
      reached.push(...await evaluate('[...document.querySelectorAll(".turn-index-marker")].map(n=>Number(n.dataset.turnIndex))'))
      if (await evaluate('document.querySelector(".turn-index-page[data-direction=next]").disabled')) break
      const before=await evaluate('document.querySelector(".turn-index-marker").dataset.turnIndex')
      await evaluate('document.querySelector(".turn-index-page[data-direction=next]").click()')
      await wait(`document.querySelector('.turn-index-marker').dataset.turnIndex!==${JSON.stringify(before)}`)
    }
    assert.deepEqual(reached,Array.from({length:500},(_,i)=>i+1))
    await evaluate('document.querySelector(".turn-index-marker").focus()')
    await wait('document.querySelector(".turn-index-preview")!==null')
    assert.ok(await evaluate('document.activeElement.getAttribute("aria-describedby")==="xsla-turn-index-preview"'))
    await evaluate('document.querySelector(".turn-index-marker").click()')
    await pause(350)
    assert.ok(await evaluate('document.querySelector(".turn-index-marker[data-current=true]")!==null'))
    checks.push('all 500 user messages reachable; focus preview and click-to-message work')

    while (await evaluate('!document.querySelector(".turn-index-page[data-direction=previous]").disabled')) {
      const before=await evaluate('document.querySelector(".turn-index-marker").dataset.turnIndex')
      await evaluate('document.querySelector(".turn-index-page[data-direction=previous]").click()')
      await wait(`document.querySelector('.turn-index-marker').dataset.turnIndex!==${JSON.stringify(before)}`)
    }
    await evaluate(`document.querySelector('.turn-index-marker[data-turn-index="1"]').click()`)
    await wait('window.__journey.history.getSnapshot().items.length===1001')
    await pause(350)
    await wait(`document.querySelector('.stream').scrollTop<100`)
    assert.ok(await evaluate(`document.querySelector('.event-user[data-event-seq="0"]').getBoundingClientRect().top>=document.querySelector('.stream').getBoundingClientRect().top-2`))
    checks.push('outline jump reveals an old message outside the rendered window')

    // Failure is explicit and retryable, not silent repeated requests.
    await evaluate('window.__journey.switchHistory("retry-session")')
    await wait('document.querySelectorAll(".event").length===160')
    await evaluate('window.__journey.historyFail=true')
    await nearTop()
    await wait('document.querySelector(".timeline-history-status button")!==null')
    assert.equal(await evaluate('document.querySelector(".timeline-history-status button").textContent'),'旧消息暂未接上，点此重试')
    await evaluate('window.__journey.historyFail=false;document.querySelector(".timeline-history-status button").click()')
    await wait('window.__journey.history.getSnapshot().items.length===480')
    while (await evaluate('window.__journey.history.getSnapshot().hasEarlier')) {
      const before=await evaluate('window.__journey.history.getSnapshot().items.length')
      await nearTop()
      await wait(`window.__journey.history.getSnapshot().items.length>${before}`)
      await pause(100)
    }
    await pause(250)
    assert.equal(await evaluate('document.querySelector(".timeline-history-status")'),null)
    checks.push('provider failure offers retry; end of history stops loading')
    await evaluate('window.__journey.switchHistory("error-reveal-session")')
    await wait('document.querySelectorAll(".event").length===160')
    await evaluate('window.__journey.historyFail=true')
    await nearTop()
    await wait('document.querySelector(".timeline-history-status button")!==null')
    await evaluate('window.__journey.ports.taskTimeline.reveal(0)')
    await wait('window.__journey.history.getSnapshot().hasEarlier===false && document.querySelector(".timeline-history-status")===null')
    checks.push('successful outline recovery clears an earlier loading error')
    await evaluate('window.__journey.switchHistory("other-session")')
    await wait('document.querySelectorAll(".event").length===1')
    assert.equal(await evaluate('document.querySelectorAll(".turn-index-marker").length'),1)
    assert.equal(await evaluate('document.querySelector(".turn-index-page")'),null)
    assert.deepEqual(await evaluate('window.__journey.state.rendererErrors'),[])
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
    checks.push('session switch resets pager without leaking old navigation')
    await writeFile(output,JSON.stringify({accepted:true,scope:'real renderer and provider, synthetic sessions; not a full release gate',checks,screenshots,errors,requests},null,2))
    process.stdout.write(JSON.stringify({accepted:true,checks})+'\n')
    browser.destroy();clearInterval(keepAlive);app.exit(0)
  } catch(error) {
    let diagnostic
    if(browser&&!browser.isDestroyed()){
      diagnostic=await browser.webContents.executeJavaScript(`(()=>{const j=window.__journey,s=document.querySelector('.stream');return {loadCalls:j?.loadCalls,loaded:j?.history?.getSnapshot().items.length,scrollTop:s?.scrollTop,height:s?.clientHeight,scrollHeight:s?.scrollHeight,status:document.querySelector('.timeline-history-status')?.textContent,rendererErrors:j?.state.rendererErrors,scrollEvents:window.__historyScrollEvents}})()`).catch(()=>undefined)
      await writeFile(resolve(dirname(output),'failure.png'),(await browser.webContents.capturePage()).toPNG()).catch(()=>{})
      browser.destroy()
    }
    await writeFile(output,JSON.stringify({accepted:false,error:String(error.stack||error),diagnostic,checks,screenshots,errors,requests},null,2))
    process.stderr.write(String(error.stack||error)+'\n');clearInterval(keepAlive);app.exit(1)
  }
}
void main()
