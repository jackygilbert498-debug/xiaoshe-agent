import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(new URL('../../../apps/desktop-shell/package.json', import.meta.url))
let electron
try { electron = require('electron') } catch { /* Renderer gate explicitly skips when the dev binary is unavailable. */ }

test('actual session row menu escapes containment, hit-tests above later rows, and restores optimization', { skip: !electron, timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-menu-renderer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/client/adapted.css', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source + '\nexport { renderSessionButton as testOnlySessionRow };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const renderer = `(() => {
    const exports = {};
    ${compiled}
    const nav = document.querySelector('nav');
    let active, sideMenu; const removed = [];
    const e = (type, props, ...children) => {
      const node = document.createElement(type);
      for (const [key, value] of Object.entries(props ?? {})) {
        if (key === 'key' || value === undefined) continue;
        if (key === 'className') node.className = value;
        else if (key === 'onClick') node.addEventListener('click', value);
        else if (key === 'disabled') node.disabled = value;
        else node.setAttribute(key, String(value));
      }
      for (const child of children.flat(Infinity)) if (child != null) node.append(child instanceof Node ? child : String(child));
      return node;
    };
    function draw() {
      nav.replaceChildren(...['first', 'second', 'third', 'fourth'].map(id => exports.testOnlySessionRow(e,
        {sessionId:id,title:id,updatedAt:1}, {currentId:active,status:'ready',sideMenu,workspaces:[],
          onOpen(){}, onMenu(target){sideMenu=target;draw()}, onBeginEdit(){},
          onRemove(target){removed.push(target.id);sideMenu=undefined;draw()}})));
    }
    window.menuFixture = { start(value){active=value;sideMenu=undefined;draw()}, removed };
  })()`
  const runner = join(root, 'runner.cjs')
  await writeFile(runner, `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(join(root, 'userdata'))});
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:500,height:600,webPreferences:{sandbox:true}});
      try {
        await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(${JSON.stringify(`<style>${css}</style><main class="xsla-shell" style="display:block;width:360px;height:500px"><nav class="sess-list" style="width:300px;height:400px"></nav></main>`)}));
        await win.webContents.executeJavaScript(${JSON.stringify(renderer)});
        for(const active of ['first','second']) {
          await win.webContents.executeJavaScript('menuFixture.start('+JSON.stringify(active)+')');
          const before=await win.webContents.executeJavaScript('getComputedStyle(document.querySelector(".sess-row")).contentVisibility');
          if(before!=='auto')throw Error('closed row lost content visibility optimization');
          await win.webContents.executeJavaScript('document.querySelector(".session-menu-trigger").click()');
          const hit=await win.webContents.executeJavaScript(${JSON.stringify(`new Promise(resolve=>requestAnimationFrame(()=>{
            const button=document.querySelector('.side-action-menu .danger'), rect=button.getBoundingClientRect();
            const row=document.querySelector('.sess-row'), x=rect.x+rect.width/2,y=rect.y+rect.height/2;
            resolve({x,y,hit:document.elementFromPoint(x,y)===button,visibility:getComputedStyle(row).contentVisibility,below:y>row.getBoundingClientRect().bottom});
          }))`)});
          if(!hit.hit||!hit.below)throw Error('menu clipped or occluded: '+JSON.stringify(hit));
          if(hit.visibility!=='visible')throw Error('open row retains containment');
          win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(hit.x),y:Math.round(hit.y),button:'left',clickCount:1});
          win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(hit.x),y:Math.round(hit.y),button:'left',clickCount:1});
          await new Promise(resolve=>setTimeout(resolve,50));
          const after=await win.webContents.executeJavaScript('({count:menuFixture.removed.length,open:!!document.querySelector(".side-action-menu"),visibility:getComputedStyle(document.querySelector(".sess-row")).contentVisibility})');
          if(after.open||after.visibility!=='auto'||after.count!==(['first','second'].indexOf(active)+1))throw Error('archive click/close failed: '+JSON.stringify(after));
        }
        console.log('SESSION_MENU_RENDERER_PASS');win.destroy();app.exit(0);
      }catch(error){console.error(error);win.destroy();app.exit(1)}
    });`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(electron, [runner], { env, windowsHide: true, timeout: 25_000 })
  assert.match(result.stdout, /SESSION_MENU_RENDERER_PASS/)
})
