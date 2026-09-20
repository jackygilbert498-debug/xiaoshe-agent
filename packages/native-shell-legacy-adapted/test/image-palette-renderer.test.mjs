import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import ts from 'typescript'

const requireDesktop = createRequire(new URL('../../../apps/desktop-shell/package.json', import.meta.url))
const requireWeb = createRequire(new URL('../../../runtime/DSH/apps/web/package.json', import.meta.url))
let electron, reactPath, reactDomPath
try {
  electron = requireDesktop('electron')
  reactPath = join(dirname(requireWeb.resolve('react')), 'umd/react.production.min.js')
  reactDomPath = join(dirname(requireWeb.resolve('react-dom')), 'umd/react-dom.production.min.js')
} catch { /* Explicitly skipped on machines without the existing desktop test runtime. */ }

test('real renderer decodes local images, previews three editable colors and makes no network request', { skip: !electron || !reactDomPath, timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-palette-renderer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const [source, react, reactDom, css] = await Promise.all([
    readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'), readFile(reactPath, 'utf8'), readFile(reactDomPath, 'utf8'),
    readFile(new URL('../src/client/adapted.css', import.meta.url), 'utf8'),
  ])
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const setup = `${react}\n${reactDom}\n(() => {
    const client = (() => { const exports = {}; ${code}; return exports })();
    const listeners = new Set(), slots = [];
    let snapshot = {status:'ready',mode:'host',writable:true,value:client.normalizeAppearance({preset:'graphite'})};
    const scope = { getSnapshot:()=>snapshot, subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)}, async mutate(ops){
      window.testWrites.push(ops); const value={...snapshot.value}; for(const op of ops)value[op.path[0]]=op.value;
      snapshot={...snapshot,value}; listeners.forEach(fn=>fn());
    }};
    const theme={preference:'dark',active:{id:'ink-jade',colorScheme:'dark'},revision:0,fontSize:14};
    window.testWrites=[];
    client.apply({settingsScope:{bind:()=>scope},on:()=>()=>{},theme:{getTheme:()=>theme,setTheme(){},overrideTokens:()=>()=>{}},
      slots:{inject:(_n,install)=>install(),register:(definition,component)=>{slots.push({definition,component});return()=>{}}}},React,{MarkdownText:()=>null});
    Object.entries(client.appearanceTokens(snapshot.value,'dark')).forEach(([key,value])=>document.documentElement.style.setProperty(key,value));
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(slots.find(slot=>slot.definition.id==='appearance').component));
    window.uploadPaletteFixture=async(corrupt=false,illustration=false)=>{
      const canvas=document.createElement('canvas');canvas.width=illustration?256:128;canvas.height=canvas.width;
      const c=canvas.getContext('2d');
      if(illustration){
        let y=0;for(const [height,color] of [[87,'#f5eee2'],[72,'#f2c4a6'],[43,'#8facb8'],[36,'#1672a1'],[18,'#c06841']]){c.fillStyle=color;c.fillRect(0,y,256,height);y+=height;}
      }else{c.fillStyle='#eeeeee';c.fillRect(0,0,128,77);c.fillStyle='#222222';c.fillRect(0,77,128,38);c.fillStyle='#c84020';c.fillRect(0,115,128,13);}
      const blob=corrupt?new Blob(['broken png']):await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const transfer=new DataTransfer();transfer.items.add(new File([blob],(illustration?'areas-':'palette-')+ 'x'.repeat(120)+'.png',{type:'image/png'}));
      const input=document.querySelector('input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    };
    window.editPaletteHex=value=>{const input=document.querySelector('#xsla-custom-color-hex');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
  })()`
  const runner = join(root, 'runner.cjs')
  await writeFile(runner, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(join(root, 'userdata'))});
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true}});
      const errors=[],requests=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});
      win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{requests.push(details.url);callback({cancel:true})});
      const read=code=>win.webContents.executeJavaScript(code,true);
      const until=async(code)=>{const end=Date.now()+5000;while(Date.now()<end){if(await read(code))return;await new Promise(r=>setTimeout(r,25))}throw Error('renderer condition: '+code)};
      const mouse=(type,point)=>win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',buttons:type==='mouseReleased'?0:1,clickCount:1,...point});
      const key=async(name,code)=>{await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:name,windowsVirtualKeyCode:code,...(name==='Enter'?{text:String.fromCharCode(13),unmodifiedText:String.fromCharCode(13)}:{})});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:name,code:name,windowsVirtualKeyCode:code});};
      try {
        await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(${JSON.stringify(`<style>${css}</style><main id="root" style="padding:24px;max-width:680px"></main>`)}));
        win.webContents.debugger.attach('1.3');
        // Emulate page focus, never focus or show an OS window for keyboard tests.
        await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
        await read(${JSON.stringify(setup)});
        await until('document.querySelectorAll(".xsla-color-slots button").length===3');
        await read('uploadPaletteFixture()');
        await until('!!document.querySelector(".xsla-image-result")');
        assert.equal(await read('testWrites.length'),0,'extracting is not saving');
        assert.ok(await read('document.querySelector(".xsla-image-name").getBoundingClientRect().right<=document.querySelector(".xsla-appearance-controls").getBoundingClientRect().right+1'),'long image names stay inside the color controls');
        const colors=await read('[...document.querySelectorAll(".xsla-color-slots small")].map(n=>n.textContent)');
        assert.deepEqual(colors,['#c84020','#eeeeee','#222222']);
        assert.equal(await read('getComputedStyle(document.querySelector(".xsla-sample-window")).backgroundColor'),'rgb(238, 238, 238)');
        await read('document.querySelector("[aria-label=编辑主界面底色]").click()');
        await until('document.querySelector("#xsla-custom-color-hex").value==="#eeeeee"');
        await read('editPaletteHex("#141820")');
        await until('getComputedStyle(document.querySelector(".xsla-sample-window")).backgroundColor==="rgb(20, 24, 32)"');
        await read('document.querySelector("[aria-label=应用自定义配色]").click()');
        await until('document.querySelector("[data-appearance-save]").dataset.appearanceSave==="ready" && testWrites.length===1');
        assert.equal(await read('testWrites[0].find(op=>op.path[0]==="customSurfaceDark").value'),'#141820');
        await read('uploadPaletteFixture(false,true)');
        await until('document.querySelector(".xsla-image-name")?.textContent.startsWith("areas-")');
        const shares=await read('[...document.querySelectorAll(".xsla-image-shares>button")].map(n=>Number(n.textContent.match(/[0-9.]+/)[0]))');
        assert.equal(shares.length,5,'all five source colors remain selectable');
        // Literal known row counts / 256, rounded to the displayed precision.
        for(const [index,percent] of [34,28.1,16.8,14.1,7].entries())assert.ok(Math.abs(shares[index]-percent)<=.15,'decoded area '+index+': '+shares[index]);
        assert.deepEqual(await read('[...document.querySelectorAll(".xsla-color-slots small")].map(n=>n.textContent)'),['#f2c4a6','#f5eee2','#8facb8']);
        assert.equal(await read('testWrites.length'),1,'source statistics remain a draft');
        assert.equal(await read('getComputedStyle(document.querySelector(".xsla-sample-input>b")).backgroundColor'),'rgb(242, 196, 166)','preview fill exactly matches the extracted peach, not a darkened brown');
        // Optional visual evidence uses this isolated, hidden page only.
        if(${JSON.stringify(process.env.XIAOSHE_PALETTE_CAPTURE ?? '')}){
          win.setContentSize(1200,1350);
          await read('document.getElementById("root").style.maxWidth="1080px";document.body.style.backgroundColor=getComputedStyle(document.documentElement).getPropertyValue("--surface")');
          await new Promise(r=>setTimeout(r,100));
          require('node:fs').writeFileSync(${JSON.stringify(process.env.XIAOSHE_PALETTE_CAPTURE ?? '')},(await win.webContents.capturePage()).toPNG());
          await read('document.getElementById("root").style.maxWidth="680px"');
          win.setContentSize(1440,1000);
        }
        await read('document.querySelector("[aria-label=编辑强调色]").click()');
        await until('document.querySelector(".xsla-image-shares button").getAttribute("aria-label").endsWith("用于强调色")');
        await read('document.querySelectorAll(".xsla-image-shares button")[3].click()');
        await until('document.querySelector("#xsla-custom-color-hex").value==="#1672a1"');
        assert.equal(await read('testWrites.length'),1,'selecting a fourth candidate is still a preview');

        // Chromium input targets this hidden renderer only; no OS mouse/keyboard
        // focus, active Xiaoshe window or user settings are involved.
        const point=async index=>read('(()=>{const r=document.querySelectorAll(".xsla-color-slots button")['+index+'].getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+20)}})()');
        const start=await point(0),target=await point(2);
        await mouse('mousePressed',start);
        await until('!!document.querySelector("[data-color-drag-source=true]")');
        await mouse('mouseMoved',target);
        await until('document.querySelector("[data-color-drop-target=true]")?.getAttribute("data-palette-slot")==="2"');
        await mouse('mouseReleased',target);
        await until('!document.querySelector("[data-color-drag-source=true]")');
        assert.deepEqual(await read('[...document.querySelectorAll(".xsla-color-slots small")].map(n=>n.textContent)'),['#8facb8','#f5eee2','#1672a1']);
        assert.equal(await read('document.querySelector("#xsla-custom-color-hex").value'),'#8facb8','drag swaps colors, not the selected role');
        assert.deepEqual(await read('[...document.querySelectorAll(".xsla-color-slots button")].map(n=>n.getAttribute("aria-label"))'),['编辑强调色','编辑主界面底色','编辑侧栏底色']);
        assert.equal(await read('testWrites.length'),1);
        // Outside drop and Escape must both leave the previous colors untouched.
        const beforeCancel=await read('[...document.querySelectorAll(".xsla-color-slots small")].map(n=>n.textContent)');
        for(const cancel of ['outside','escape','blur','pointercancel','same']){
          const p=await point(1);await mouse('mousePressed',p);
          await until('!!document.querySelector("[data-color-drag-source=true]")');
          if(cancel==='escape'){await key('Escape',27);await until('!document.querySelector("[data-color-drag-source=true]")');}
          if(cancel==='blur')await read('window.dispatchEvent(new Event("blur"))');
          if(cancel==='pointercancel')await read('window.dispatchEvent(new PointerEvent("pointercancel",{pointerId:1}))');
          const end=cancel==='same'?p:cancel==='outside'?{x:2,y:2}:await point(2);
          await mouse('mouseMoved',end);
          await mouse('mouseReleased',end);
          await until('!document.querySelector("[data-color-drag-source=true]")');
          assert.deepEqual(await read('[...document.querySelectorAll(".xsla-color-slots small")].map(n=>n.textContent)'),beforeCancel,cancel+' cancels the swap');
        }
        const tap=await point(1);
        await mouse('mousePressed',tap);
        await mouse('mouseReleased',tap);
        await until('document.querySelector("[aria-label=编辑主界面底色]").getAttribute("aria-pressed")==="true"');
        await new Promise(r=>setTimeout(r,400));
        assert.equal(await read('!!document.querySelector("[data-color-drag-source=true]")'),false,'short click clears the hold timer');
        assert.deepEqual(await read('[...document.querySelectorAll(".xsla-color-slots small")].map(n=>n.textContent)'),beforeCancel);
        // The non-drag alternative is operable with ordinary keyboard buttons.
        await read('document.querySelector("[aria-label=交换颜色]").focus()');
        await key('Enter',13);
        await until('!!document.querySelector("[aria-label=取消颜色互换]")');
        await read('document.querySelector("[aria-label=编辑侧栏底色]").focus()');
        await key('Enter',13);
        await until('!document.querySelector("[aria-label=取消颜色互换]")');
        assert.deepEqual(await read('[...document.querySelectorAll(".xsla-color-slots small")].map(n=>n.textContent)'),['#8facb8','#1672a1','#f5eee2']);
        await read('document.querySelector("[aria-label=应用自定义配色]").click()');
        await until('testWrites.length===2 && document.querySelector("[data-appearance-save]").dataset.appearanceSave==="ready"');
        assert.deepEqual(await read('Object.fromEntries(testWrites[1].filter(op=>["customAccent","customSurfaceDark","customBackgroundDark"].includes(op.path[0])).map(op=>[op.path[0],op.value]))'),{customAccent:'#8facb8',customSurfaceDark:'#1672a1',customBackgroundDark:'#f5eee2'});
        await read('uploadPaletteFixture(true)');
        await until('!!document.querySelector("[role=alert]")');
        assert.equal(await read('testWrites.length'),2,'decode failure does not write');
        for(const width of [1440,768,375]){
          win.setContentSize(width,1000);await new Promise(r=>setTimeout(r,100));
          assert.ok(await read('document.documentElement.scrollWidth<=innerWidth'),'no horizontal overflow at '+width);
        }
        assert.deepEqual(requests,[],'no image or color data leaves the local renderer');
        assert.equal(win.isVisible(),false,'acceptance never opens a visible window');
        assert.equal(win.isFocused(),false,'acceptance never takes OS window focus');
        assert.deepEqual(errors,[],'no React or renderer errors');console.log('PALETTE_RENDERER_PASS');
        win.destroy();app.exit(0);
      }catch(error){console.error(error.stack);win.destroy();app.exit(1)}
    });`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(electron, [runner], { env, timeout: 25_000, windowsHide: true, maxBuffer: 128 * 1024 })
  assert.match(result.stdout, /PALETTE_RENDERER_PASS/)
})
