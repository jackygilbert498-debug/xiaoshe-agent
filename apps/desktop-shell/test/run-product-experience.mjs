/** Real Chromium + built shell + actual React; only Host service ports are controlled fixtures. */
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
await mkdir(dirname(output), { recursive: true })
const results = []
const keepAlive = setInterval(() => {}, 1000)

async function run(width, height) {
  const browser = new BrowserWindow({ width, height, show: false, useContentSize: true, webPreferences: {
    nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false,
    partition: `product-experience-${process.pid}-${width}`,
  } })
  const errors = [], requests = [], screenshots = []
  browser.webContents.session.protocol.handle('file', async request => {
    const path = new URL(request.url).pathname
    if (path.endsWith('/api/xiaoshe/legacy-adapted-brand-raster')) return new Response(await readFile(resolve(root, 'packages/native-shell-legacy-adapted/ui/assets/icon-256.png')), { headers: { 'content-type': 'image/png' } })
    if (path.endsWith('/api/xiaoshe/legacy-adapted-brand-icon')) return new Response(await readFile(resolve(root, 'packages/native-shell-legacy-adapted/ui/assets/snake.svg')), { headers: { 'content-type': 'image/svg+xml' } })
    return net.fetch(request, { bypassCustomProtocolHandlers: true })
  })
  browser.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (request, callback) => {
    requests.push({ url: request.url, type: request.resourceType }); callback({ cancel: true })
  })
  browser.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const evaluate = source => browser.webContents.executeJavaScript(source)
  const wait = source => fixture.waitFor(browser, source)
  const click = selector => fixture.click(browser, selector)
  const button = (selector, label) => evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('missing button '+${JSON.stringify(label)});b.click()})()`)
  try {
    process.stdout.write(`Checking product viewport ${width}x${height}\n`)
    const html = resolve(dirname(output), `experience-${width}.html`)
    await writeFile(html, `<!doctype html><meta charset="utf-8"><div id="root"></div><script>${fixture.createRendererBootstrap().replaceAll('</script', '<\\/script')}</script><script src="${pathToFileURL(artifact).href}"></script>`)
    await browser.loadFile(html)
    browser.webContents.debugger.attach('1.3')
    await browser.webContents.debugger.sendCommand('Page.enable')
    await fixture.setExactViewport(browser, width, height)
    await wait('window.__journey?.state.client !== undefined')
    await evaluate('console.error("xs-acceptance-console-probe")')
    assert.ok(errors.includes('xs-acceptance-console-probe'), 'real Electron console-error collection must be live')
    errors.splice(errors.indexOf('xs-acceptance-console-probe'), 1)
    await evaluate(`(() => {
      const j=window.__journey,p=j.ports,s=j.state.snapshots;
      window.__browserOwners=['acceptance-session','other-session','new-session'];
      s.runCenter={...s.runCenter,queue:[],goal:{id:'goal-1',phase:'active',objective:'核对报表',text:'核对报表'}};
      j.uploads=[];j.reads=[];j.heldUploads=false;
      p.runtimeFiles={limits:{maxFileBytes:33554432,maxFilesPerMessage:10,maxMessageFileBytes:134217728},
        async upload(input){j.uploads.push(input.name); input.onProgress({loaded:input.file.size/2,total:input.file.size});
          if(j.heldUploads) await new Promise((res,rej)=>{input.signal.addEventListener('abort',()=>rej(new Error('已取消')),{once:true});j.releaseUpload=res});
          if(j.failUpload){j.failUpload=false;return {ok:false,error:{message:'上传失败，可重试'}}}
          return {ok:true,value:{receiptId:'receipt-'+j.uploads.length,name:input.name,bytes:input.file.size,mediaType:input.file.type}}},
        async read(input){j.reads.push(input.path);if(input.path.endsWith('.png')){const data=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P8z8BQDwAFgwJ/lVgJNwAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0));return {ok:true,value:{...input,name:'image.png',data,bytes:data.length,mediaType:'image/png',version:'v2'}}}const html=input.path.endsWith('.html');
          const text=html?'<h1>静态报告</h1><script>parent.__escaped=true<'+ '/script><img src="https://invalid.example/secret"><iframe src="https://invalid.example/frame"></iframe><p onclick="alert(1)">保留内容</p>':'# 当前文件\\n磁盘修订二\\n\\n~~~js\\nconst disk = 2\\n~~~';
          const data=new TextEncoder().encode(text);return {ok:true,value:{...input,name:input.path.split('/').at(-1),data,bytes:data.length,mediaType:html?'text/html':'text/markdown',version:'v2'}}}};
      const send=p.agentRuntimeSession.sendTurn;
      p.agentRuntimeSession.sendTurn=async input=>{if(j.holdSend)await new Promise(res=>j.releaseSend=res);const result=await send(input);
        if(result.ok&&s.runtime.sessions[input.sessionId]?.state==='running') {s.runCenter={...s.runCenter,queue:[...s.runCenter.queue,{id:'q-'+j.state.ledger.sends.length,placement:'queued',preview:input.content,text:input.content,editable:true,removable:true,steerable:true}]};j.notify()}return result};
      p.runCenter.updateQueue=async input=>{j.queueCommand=input;s.runCenter={...s.runCenter,queue:input.action.kind==='edit'?s.runCenter.queue.map(q=>q.id===input.itemId?{...q,text:input.action.text,preview:input.action.text}:q):s.runCenter.queue.filter(q=>q.id!==input.itemId)};j.notify();return {ok:true,value:{accepted:true}}};
      p.runCenter.setGoalPhase=async input=>{s.runCenter={...s.runCenter,goal:{...s.runCenter.goal,phase:input.action==='pause'?'paused':'active'}};j.notify();return {ok:true,value:{accepted:true}}};
      j.switchTo=id=>{s.runtime={...s.runtime,currentSessionId:id,sessions:{...s.runtime.sessions,[id]:{state:'idle'}}};s.catalog={sessions:{...s.catalog.sessions,[id]:{sessionId:id,title:'验收 '+id,cwd:'C:/synthetic-workspace'}}};j.notify()};
      p.sessionCatalog.createLooseSession=async()=>({ok:true,value:{sessionId:'new-session'}});
      p.sessionCatalog.openSession=id=>{j.switchTo(id);return {ok:true,value:{opened:true}}};
      j.mount();
    })()`)
    await wait('document.querySelector("textarea[name=content]") !== null')
    await evaluate('window.__journey.setRunning(true);window.__journey.holdSend=true')
    await fixture.fillComposer(browser, '第一条请求')
    await click('button.send')
    await wait('document.querySelector(".composer-send-status[data-phase=sending]") !== null')
    await fixture.fillComposer(browser, '发送等待期间的新草稿')
    assert.equal(await evaluate('document.querySelector("textarea[name=content]").disabled'), false)
    await evaluate('window.__journey.holdSend=false;window.__journey.releaseSend()')
    await wait('document.querySelector(".composer-send-status[data-phase=accepted]") !== null')
    assert.equal(await evaluate('document.querySelector("textarea[name=content]").value'), '发送等待期间的新草稿')
    await click('button.send')
    await wait('window.__journey.state.ledger.sends.length===2 && document.querySelector("textarea[name=content]").value===""')
    assert.deepEqual(await evaluate('window.__journey.state.ledger.sends.map(s=>s.mode)'), ['queue','queue'])
    await button('.composer-queue button', '编辑')
    await fixture.fillTextarea(browser, '.queue-edit-form textarea', '更新后的队列文本')
    await button('.queue-edit-form button', '保存')
    await wait('window.__journey.state.snapshots.runCenter.queue[0].text==="更新后的队列文本"')
    await button('.composer-queue button', '移除')
    await wait('window.__journey.state.snapshots.runCenter.queue.length===1')
    await click('.model-reasoning-trigger')
    await wait('document.querySelector(".model-reasoning-popover")!==null')
    assert.equal(await evaluate('[...document.querySelectorAll(".model-choice-option")].every(b=>b.disabled)'), true)
    await click('[data-effort=max]')
    await wait('window.__journey.state.snapshots.models.current.reasoningEffort==="max"')
    await fixture.pressKey(browser, 'Escape')
    await evaluate(`(()=>{const j=window.__journey,s=j.state.snapshots;s.timeline={total:5,hasEarlier:false,items:[
      {key:'u',seq:1,kind:'user',text:'检查报告'}, {key:'t1',seq:2,kind:'tool',text:'read details'},
      {key:'t2',seq:3,kind:'tool',text:'search details'}, {key:'err',seq:4,kind:'tool',text:'权限错误',isError:true},
      {key:'a',seq:5,kind:'assistant',text:'已核对两份文件，接下来检查差异。',reasoning:'PRIVATE_NOT_DISPLAYED'}]};j.notify()})()`)
    await wait('document.querySelector(".tool-disclosure")!==null')
    assert.equal(await evaluate('document.querySelector(".tool-disclosure").open'), false)
    assert.equal(await evaluate('document.querySelector(".stream").textContent.includes("PRIVATE_NOT_DISPLAYED")'), false)
    await evaluate('document.querySelector("[data-error=true]").scrollIntoView({block:"center"})')
    await wait('document.querySelector("[data-error=true]").innerText.includes("权限错误")')
    const controls = await evaluate(`(()=>{const selectors=['.attachment-control','.permission-select-wrap','.model-reasoning-trigger','.stop-generation','button.send'];const rows=selectors.map(selector=>({selector,rect:document.querySelector(selector).getBoundingClientRect()}));return rows.flatMap((a,i)=>rows.slice(i+1).filter(b=>Math.min(a.rect.right,b.rect.right)-Math.max(a.rect.left,b.rect.left)>1&&Math.min(a.rect.bottom,b.rect.bottom)-Math.max(a.rect.top,b.rect.top)>1).map(b=>a.selector+' overlaps '+b.selector))})()`)
    assert.deepEqual(controls,[],'running composer controls must not overlap')
    for (const theme of ['light','ink-jade']) {
      if(theme==='ink-jade') await click('.theme-toggle')
      screenshots.push(await fixture.captureScene(browser,width,height,'experience-'+theme))
    }
    await click('.theme-toggle')
    await evaluate(`window.__journey.state.snapshots.runCenter={...window.__journey.state.snapshots.runCenter,queue:[]};window.__journey.setRunning(false)`)
    // Real file input/change and upload progress/cancel/retry, not a helper-only assertion.
    const attach = names => evaluate(`(()=>{const dt=new DataTransfer();${names.map(name=>`dt.items.add(new File(['file content'],${JSON.stringify(name)},{type:'text/plain'}));`).join('')}const input=document.querySelector('input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await evaluate('window.__journey.heldUploads=true')
    await attach(['说明.txt'])
    await wait('document.querySelector(".file-attachment")!==null')
    await button('.file-attachment button', '取消')
    await wait('document.querySelector(".file-attachment").textContent.includes("重试")')
    await evaluate('window.__journey.heldUploads=false;window.__journey.failUpload=true')
    await button('.file-attachment button', '重试')
    await wait('document.querySelector(".file-attachment").textContent.includes("上传失败")')
    await button('.file-attachment button', '重试')
    await wait('document.querySelector(".file-attachment[data-upload-state=ready]")!==null')
    await click('button.send')
    await wait('document.querySelector(".file-attachment")===null')
    assert.equal(await evaluate('window.__journey.state.ledger.sends.at(-1).files[0].name'),'说明.txt')
    // Fullscreen uses the existing workbench, never another document system.
    await fixture.openWorkbench(browser,'materials')
    await wait('document.querySelector(".document-reader[data-file-state=ready]")!==null')
    assert.match(await evaluate('document.querySelector(".document-reader").innerText'), /磁盘修订二/)
    await wait('document.querySelector(".document-reader pre code")?.textContent.includes("const disk = 2")===true')
    await button('.surface-actions button','全屏阅读')
    await wait('document.querySelector(".material-fullscreen")!==null')
    assert.equal(await evaluate('document.querySelector(".material-fullscreen").contains(document.activeElement)'),true,'fullscreen must contain keyboard focus')
    assert.ok(await evaluate('document.querySelector(".surface-reading-panes").getBoundingClientRect().bottom <= document.querySelector("#xsla-insp").getBoundingClientRect().bottom'),'reading panes remain inside fullscreen viewport')
    await evaluate(`(()=>{const j=window.__journey,s=j.state.snapshots,original=s.surfaces.items[0];s.surfaces={...s.surfaces,items:[original,{...original,id:'image-file',source:'C:/synthetic-workspace/image.png',title:'图片',type:'image',seq:35}]};j.notify()})()`)
    await click('[data-run-deliverable-id="image-file"]')
    await wait('document.querySelector(".surface-content .image-expand")!==null')
    await click('.surface-content .image-expand')
    await wait('document.querySelector(".image-lightbox")!==null')
    await fixture.pressKey(browser,'Escape')
    await wait('document.querySelector(".image-lightbox")===null')
    assert.ok(await evaluate('document.querySelector(".material-fullscreen")!==null'),'image Escape closes only top image modal')
    await fixture.pressKey(browser,'Escape')
    await wait('document.querySelector(".material-fullscreen")===null')
    const source='C:/synthetic-workspace/report.html'
    await evaluate(`(()=>{const j=window.__journey,s=j.state.snapshots;const original=s.surfaces.items[0];s.surfaces={...s.surfaces,items:[original,{...original,id:'html-file',source:${JSON.stringify(source)},title:'静态 HTML',seq:40}]};j.notify()})()`)
    await click('[data-run-deliverable-id="html-file"]')
    await wait('document.querySelector(".document-html")!==null')
    assert.equal(await evaluate('document.querySelector(".document-html").getAttribute("sandbox")'),'')
    const srcdoc=await evaluate('document.querySelector(".document-html").srcdoc')
    assert.match(srcdoc,/静态报告/)
    assert.doesNotMatch(srcdoc,/<script|<iframe|onclick=|invalid\.example/)
    assert.equal(await evaluate('window.__escaped===true'),false)
    if(width>=1024){await button('.surface-actions button','双栏对照');await wait('document.querySelector(".surface-reading-panes.split")!==null');screenshots.push(await fixture.captureScene(browser,width,height,'reading-split'));await fixture.pressKey(browser,'Escape')}
    await fixture.closeWorkbench(browser)
    // Closing one current-file tab never revives an older record of the same path.
    await evaluate(`(()=>{const j=window.__journey,s=j.state.snapshots,old=s.surfaces.items[0];s.surfaces={...s.surfaces,items:[old,{...old,id:'new-report',seq:100}]};j.notify()})()`)
    await fixture.openWorkbench(browser,'materials')
    await wait('document.querySelector("[data-run-deliverable-id=new-report]")!==null')
    await evaluate('document.querySelector("[data-run-deliverable-id=new-report]").parentElement.querySelector(".surface-tab-close").click()')
    await wait('document.querySelector(".workbench-empty")!==null')
    assert.equal(await evaluate('document.querySelector("[data-run-deliverable-id=surface-1]")===null'),true)
    await click('[data-restore-materials]')
    await wait('document.querySelector("[data-run-deliverable-id=new-report]")!==null')
    assert.equal(await evaluate('window.__journey.state.snapshots.surfaces.items.length'),2,'hiding must preserve both historical records')
    await fixture.closeWorkbench(browser)
    // Delayed acknowledgements cannot erase a replacement draft after A -> B -> A.
    await evaluate('window.__journey.holdSend=true')
    await fixture.fillComposer(browser,'会话返回后的同文草稿')
    await click('button.send')
    await wait('document.querySelector(".composer-send-status[data-phase=sending]")!==null')
    await evaluate('window.__journey.switchTo("other-session")')
    await wait('window.__journey.state.snapshots.runtime.currentSessionId==="other-session"')
    await evaluate('window.__journey.switchTo("acceptance-session")')
    await fixture.fillComposer(browser,'会话返回后的同文草稿')
    await evaluate('window.__journey.holdSend=false;window.__journey.releaseSend()')
    await new Promise(resolve=>setTimeout(resolve,120))
    assert.equal(await evaluate('document.querySelector("textarea[name=content]").value'),'会话返回后的同文草稿')
    await fixture.fillComposer(browser,'')
    // Read B starts before send A, finishes before A's acknowledgement: only B remains.
    await evaluate(`(()=>{const j=window.__journey;const original=File.prototype.arrayBuffer;File.prototype.arrayBuffer=function(){if(this.name==='B.png')return new Promise(resolve=>{j.releaseImage=()=>original.call(this).then(resolve)});return original.call(this)};j.attachImage=name=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P8z8BQDwAFgwJ/lVgJNwAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0))],name,{type:'image/png'}));const input=document.querySelector('input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))};j.attachImage('A.png')})()`)
    await wait('document.querySelectorAll(".attachment-item").length===1')
    await evaluate('window.__journey.attachImage("B.png");window.__journey.holdSend=true')
    await click('button.send')
    await wait('document.querySelector(".composer-send-status[data-phase=sending]")!==null')
    await evaluate('window.__journey.releaseImage()')
    await wait('document.querySelectorAll(".attachment-item").length===2')
    await evaluate('window.__journey.holdSend=false;window.__journey.releaseSend()')
    await wait('document.querySelector(".composer-send-status[data-phase=accepted]")!==null')
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".attachment-item figcaption")].map(x=>x.textContent)'),['B.png'])
    await evaluate('window.__journey.switchTo("other-session")')
    await wait('document.querySelectorAll(".attachment-item").length===0')
    await evaluate('window.__journey.switchTo("acceptance-session")')
    await wait('document.querySelector(".model-reasoning-trigger")!==null')
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".attachment-item figcaption")].map(x=>x.textContent)'),['B.png'],'new unsent image survives switching away and back after acknowledgement')
    await click('.attachment-remove')
    await evaluate('window.__journey.state.snapshots.runtime={sessions:{}};window.__journey.notify()')
    await wait('document.querySelector(".model-reasoning-trigger")?.getAttribute("aria-disabled")==="true"')
    await fixture.fillComposer(browser,'新会话混合附件')
    await evaluate(`(()=>{const dt=new DataTransfer();dt.items.add(new File(['text'],'mixed.txt',{type:'text/plain'}));dt.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P8z8BQDwAFgwJ/lVgJNwAAAABJRU5ErkJggg=='),c=>c.charCodeAt(0))],'mixed.png',{type:'image/png'}));const input=document.querySelector('input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await wait('document.querySelector(".file-attachment[data-upload-state=ready]")!==null && document.querySelectorAll(".attachment-item").length===1')
    assert.equal(await evaluate('document.querySelector("textarea[name=content]").value'),'新会话混合附件')
    await evaluate('window.__journey.state.snapshots.timeline={...window.__journey.state.snapshots.timeline,items:[{key:"markdown-proof",seq:99,kind:"assistant",text:"# 真实 Markdown\\n\\n```js\\nconst answer = 42\\n```\\n\\n说明[^a]\\n\\n[^a]: 来源脚注"}]};window.__journey.notify()')
    await wait('document.querySelector(".event-markdown pre code")?.textContent.includes("const answer = 42")===true')
    assert.equal(await evaluate('document.querySelector(".event-markdown h1")?.textContent'),'真实 Markdown')
    assert.equal(await evaluate('document.querySelector(".event-markdown")?.textContent.includes("来源脚注")'),true)
    assert.equal(await evaluate('[...document.querySelectorAll(".event-markdown button")].some(b=>b.getAttribute("aria-label")==="复制代码" || b.textContent.includes("复制代码"))'),true)
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth+1'),false)
    assert.deepEqual(await evaluate('window.__journey.state.rendererErrors'),[])
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
    return {width,height,passed:true,screenshots,checks:['immediate admission','new draft preserved','running FIFO','queue edit/remove','running effort','tool collapse/error visibility','upload cancel/retry/file-only send','current file read','fullscreen keyboard','static HTML isolation','session return race'],consoleErrors:errors,networkRequests:requests}
  } catch(error) {try{await fixture.captureScene(browser,width,height,'product-failure');process.stderr.write(JSON.stringify(await evaluate('({errors:window.__journey?.state.rendererErrors,body:document.body.innerText.slice(0,1000)})'))+'\n')}catch{};throw error}
  finally {if(!browser.isDestroyed())browser.destroy()}
}
async function main() { try {
  await app.whenReady()
  for(const [width,height] of [[375,812],[768,1024],[1024,768],[1440,900]]) results.push(await run(width,height))
  await writeFile(output,JSON.stringify({accepted:true,scope:'built shell with controlled runtime ports, not production Host',results},null,2))
  clearInterval(keepAlive);app.exit(0)
} catch(error) {
  process.stderr.write(String(error.stack||error)+'\n')
  await writeFile(output,JSON.stringify({accepted:false,error:String(error.stack||error),results},null,2))
  clearInterval(keepAlive);app.exit(1)
} }
void main()
