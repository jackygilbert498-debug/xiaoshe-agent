/* Actual product UI acceptance in an isolated, hidden Electron window. No model
   requests, no draft submission, no replacement UI or injected feature code. */
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../..')
const scale = process.argv.find(arg => arg.startsWith('--scale='))?.slice('--scale='.length)
if (scale !== undefined && !['1', '1.5', '2'].includes(scale)) throw Error('Acceptance scale must be 1, 1.5 or 2')
if (scale !== undefined) app.commandLine.appendSwitch('force-device-scale-factor', scale)
const artifacts = path.join(root, `output/acceptance/desktop-appearance-20260913${scale ? `-scale-${scale}` : ''}`)
const base = 'http://127.0.0.1:3080/'
const report = { schema: 'xiaoshe-appearance-live/v1', checks: [], screenshots: [], errors: [] }
app.on('window-all-closed', () => {}) // finish() owns cleanup and the test exit code.
let win
let profile
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const safe = error => String(error?.message ?? error).replace(/([?&]token=)[^\s'"&]+/gi, '$1[REDACTED]')

async function read(expression) { return win.webContents.executeJavaScript(expression, true) }
function sizeWindow(width, height) {
  win.setContentSize(width, height)
  // Offscreen Electron may ignore a fractional command-line scale on Windows.
  // Explicit renderer emulation measures CSS at that DPR, not OS-level DPI.
  if (scale !== undefined) win.webContents.enableDeviceEmulation({
    screenPosition: 'desktop', screenSize: { width, height },
    viewPosition: { x: 0, y: 0 }, viewSize: { width, height }, deviceScaleFactor: Number(scale), scale: 1,
  })
}
async function until(expression, label, timeout = 25000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await read(expression)) return; await delay(100) }
  throw Error(`UI timeout: ${label}`)
}
async function clickText(selector, text) {
  const result = await read(`(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.textContent.trim() === ${JSON.stringify(text)}); if (!node || node.disabled) return false; node.click(); return true })()`)
  assert.equal(result, true, `enabled ${selector}: ${text}`)
}
async function screenshot(name) {
  // Hidden windows may return their previous compositor frame. Offscreen paint
  // and a forced invalidation capture the settled UI, not a stale modal frame.
  win.webContents.invalidate()
  await delay(400)
  const file = path.join(artifacts, `${name}.png`)
  await fs.writeFile(file, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  report.screenshots.push(file)
}
async function visualEvidence(mode) {
  const detail = await read(`(() => {
    const svg=document.querySelector('.stage-symbol'), title=getComputedStyle(document.querySelector('.chat-title'));
    const ancestors=[];for(let n=svg;n;n=n.parentElement){const s=getComputedStyle(n);ancestors.push({tag:n.tagName,class:n.getAttribute('class'),opacity:s.opacity,filter:s.filter})}
    const r=svg.getBoundingClientRect();
    return {mode:${JSON.stringify(mode)},title:{font:title.fontSize,padding:title.padding,background:title.backgroundColor},logo:{rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},ancestors,stops:[...svg.querySelectorAll('stop')].map(n=>getComputedStyle(n).stopColor),mask:getComputedStyle(svg.querySelector('mask')).maskType,href:svg.querySelector('image').getAttribute('href')}}
  })()`)
  win.webContents.invalidate(); await delay(200)
  const bitmap = (await win.webContents.capturePage(detail.logo.rect, { stayHidden: true, stayAwake: true })).toBitmap()
  const luminance = offset => {
    const linear = i => { const c=bitmap[offset+i]/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4 }
    return .2126*linear(2)+.7152*linear(1)+.0722*linear(0)
  }
  const bg=luminance(0);let peak=1,visible=0
  for(let i=0;i<bitmap.length;i+=4){const l=luminance(i),ratio=(Math.max(bg,l)+.05)/(Math.min(bg,l)+.05);peak=Math.max(peak,ratio);if(ratio>=3)visible++}
  detail.logo.peakContrast=peak; detail.logo.visiblePixels=visible
  ;(report.visualEvidence??=[]).push(detail)
  assert.ok(parseFloat(detail.title.font)<=18 && detail.title.padding==='0px' && detail.title.background==='rgba(0, 0, 0, 0)', 'compact unboxed title overrides legacy frosting')
  assert.ok(visible>=50, `${mode} welcome outline has visible strokes: ${JSON.stringify({peak,visible})}`)
}
async function openAppearance() {
  await clickText('button', '设置')
  await until(`!!document.querySelector('[data-xs-settings-nav-item="appearance"]')`, 'appearance navigation')
  await read(`document.querySelector('[data-xs-settings-nav-item="appearance"]').click()`)
  await until(`!!document.querySelector('[data-native-settings="appearance"]')`, 'appearance page')
  await until(`document.querySelector('[data-appearance-save]')?.dataset.appearanceSave === 'ready'`, 'durable appearance loaded')
}
async function choosePalette(id) {
  const labels = { moss: '竹影', graphite: '墨灰', ocean: '雾蓝', sand: '暖砂' }
  await read(`(() => { const b=[...document.querySelectorAll('.xsla-palette-options button')].find(node=>node.querySelector('b')?.textContent===${JSON.stringify(labels[id])}); if(!b||b.disabled)throw Error('palette unavailable');b.click() })()`)
  await until(`document.querySelector('.xsla-shell')?.dataset.appearancePreset === ${JSON.stringify(id)} && document.querySelector('[data-appearance-save]')?.dataset.appearanceSave === 'ready'`, `palette ${id} persisted`)
}
async function setMode(id) {
  await read(`document.querySelectorAll('.xsla-mode-options button')[${['light', 'dark', 'system'].indexOf(id)}].click()`)
  await until(`document.querySelectorAll('.xsla-mode-options button')[${['light', 'dark', 'system'].indexOf(id)}].getAttribute('aria-pressed') === 'true'`, `mode ${id}`)
  if (id !== 'system') await until(`document.querySelector('.xsla-shell').dataset.theme === '${id === 'dark' ? 'ink-jade' : 'light'}'`, 'theme propagation')
}

async function run() {
  await fs.mkdir(artifacts, { recursive: true })
  profile = await fs.mkdtemp(path.join(artifacts, 'isolated-profile-'))
  app.setPath('userData', profile)
  await app.whenReady()
  win = new BrowserWindow({ show: false, width: 1440, height: 960, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } })
  win.webContents.on('console-message', (...args) => { const event = args[0]; const level = event?.level ?? args[1]; const message = event?.message ?? args[2]; if (level === 'error' || level === 3) report.errors.push(safe(message)) })
  const owner = JSON.parse(await fs.readFile(path.join(process.env.LOCALAPPDATA, 'Xiaoshe/dsh-web-state.json'), 'utf8'))
  assert.equal(path.resolve(owner.xsRoot), root, 'daily Host belongs to this source checkout')
  const { readDshLaunchUrl } = await import(pathToFileURL(path.join(root, 'scripts/dsh-launch-auth.mjs')).href)
  const login = await readDshLaunchUrl({ baseUrl: base, expectedRuntimeIdentity: owner.runtimeIdentity, logPath: path.join(process.env.LOCALAPPDATA, 'Xiaoshe/Logs/dsh-web-3080.stdout.log') })
  await win.loadURL(login)
  sizeWindow(1440, 960)
  await until(`!!document.querySelector('.xsla-shell')`, 'real shell')
  await until(`!!document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest('.xsla-shell')`, 'boot overlay dismissed')
  const identity = await read(`document.querySelector('.xsla-shell').dataset.xslaSourceIdentity`)
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'packages/native-shell-legacy-adapted/lib/client.version.json'), 'utf8'))
  assert.equal(identity, manifest.source_identity, 'rendered frontend matches current built artifact')
  report.frontendIdentity = identity
  report.deviceScaleFactor = await read('devicePixelRatio')
  report.requestedScale = scale ?? 'system'
  report.chromiumScale = app.commandLine.getSwitchValue('force-device-scale-factor')
  report.zoomFactor = win.webContents.getZoomFactor()
  if (scale !== undefined) assert.equal(report.deviceScaleFactor, Number(scale))
  report.checks.push('actual-built-client-loaded')
  await openAppearance()
  await choosePalette('graphite')
  await choosePalette('sand')
  await choosePalette('ocean')
  await setMode('dark')
  await screenshot('appearance-dark')
  report.darkMask = await read(`getComputedStyle(document.querySelector('[data-xs-settings-mask]')).backgroundColor`)
  assert.ok(report.darkMask.replace(/\s/g,'').startsWith('rgba(0,0,0,'), 'dark settings dim the backdrop, never wash it white')
  win.reload()
  await until(`!!document.querySelector('.xsla-shell')`, 'reload')
  await openAppearance()
  assert.equal(await read(`document.querySelector('.xsla-shell').dataset.appearancePreset`), 'ocean')
  assert.equal(await read(`document.querySelector('.xsla-shell').dataset.theme`), 'ink-jade')
  report.checks.push('host-palette-and-theme-survive-reload')
  // Extreme input exercises the same controlled text field and real persistence path.
  await read(`(() => { const input=document.querySelector('.xsla-color-inputs input[type="text"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'#FFFF00');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await clickText('.xsla-color-inputs button', '应用')
  await until(`document.querySelector('.xsla-shell').dataset.appearancePreset === 'custom' && document.querySelector('[data-appearance-save]').dataset.appearanceSave === 'ready'`, 'custom color saved')
  win.reload()
  await until(`!!document.querySelector('.xsla-shell')`, 'custom reload')
  await openAppearance()
  assert.equal(await read(`document.querySelector('.xsla-color-inputs input[type="text"]').value.toLowerCase()`), '#ffff00')
  report.checks.push('custom-color-survives-reload')
  await clickText('.xsla-appearance-footer button', '恢复默认配色')
  await until(`document.querySelector('.xsla-shell').dataset.appearancePreset === 'moss' && document.querySelector('[data-appearance-save]').dataset.appearanceSave === 'ready'`, 'restore default palette')
  await setMode('light')
  await screenshot('appearance-light')
  // Close with the product's actual Escape handler, never remove the dialog DOM.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await until(`!document.querySelector('[data-native-settings="appearance"]')`, 'close settings')
  await screenshot('desktop-light')
  await visualEvidence('light')
  // No task submission: exercise the empty view created by the actual application.
  await until(`!!document.querySelector('.stage-starters')`, 'new conversation stage')
  const bounds = await read(`(() => {const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};return {cards:box('.stage-starters'),composer:box('.cbox'),logo:box('.stage-symbol')}})()`)
  assert.ok(Math.abs(bounds.cards.w - bounds.composer.w) <= 2, 'cards and composer share a content grid')
  assert.ok(bounds.composer.y - (bounds.cards.y + bounds.cards.h) >= 35, 'welcome and composer remain independent')
  const before = bounds.composer.y
  await clickText('.stage-starters button b', '整理一份资料')
  await until(`document.querySelector('.stage-starters').dataset.drafting === 'true'`, 'starter stages a draft')
  assert.ok(await read(`document.querySelector('textarea[name="content"]').value.includes('资料')`))
  assert.ok(Math.abs(await read(`document.querySelector('.cbox').getBoundingClientRect().y`) - before) <= 2, 'draft does not shift composer')
  await read(`(() => {const input=document.querySelector('textarea[name="content"]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await until(`document.querySelector('.stage-starters').dataset.drafting === 'false'`, 'clear restores starters')
  report.checks.push('starter-draft-clearing-and-stable-composer')
  await clickText('.surface-launchers button', '工作台')
  await until(`document.querySelector('[data-workbench-launcher]').getAttribute('aria-expanded') === 'true'`, 'workbench opens')
  await clickText('.surface-launchers button', '工作台')
  await until(`document.querySelector('[data-workbench-launcher]').getAttribute('aria-expanded') === 'false'`, 'workbench closes')
  report.checks.push('workbench-still-opens-and-closes')
  await openAppearance(); await setMode('dark')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await until(`!document.querySelector('[data-native-settings="appearance"]')`, 'close dark settings')
  await screenshot('desktop-dark')
  await visualEvidence('dark')
  report.checks.push('compact-title-and-theme-visible-outline')
  for (const [width, height] of [[1024, 780], [768, 820], [392, 820], [320, 780]]) {
    sizeWindow(width, height)
    await delay(200)
    const result = await read(`(() => {const c=document.querySelector('.cbox').getBoundingClientRect();return {width:innerWidth,doc:document.documentElement.scrollWidth,x:c.x,right:c.right,bottom:c.bottom,h:innerHeight}})()`)
    assert.equal(result.width, width, 'actual responsive viewport matches requested width')
    assert.equal(result.h, height, 'actual responsive viewport matches requested height')
    assert.ok(result.doc <= result.width && result.x >= 0 && result.right <= result.width + 1 && result.bottom <= result.h, `responsive ${width}: ${JSON.stringify(result)}`)
  }
  await screenshot('desktop-compact')
  await visualEvidence('dark-compact')
  report.checks.push('responsive-1024-768-392-320')
  sizeWindow(1440, 960)
  await openAppearance(); await setMode('system')
  win.reload()
  await until(`!!document.querySelector('.xsla-shell')`, 'system mode reload')
  await openAppearance()
  assert.equal(await read(`document.querySelectorAll('.xsla-mode-options button')[2].getAttribute('aria-pressed')`), 'true', 'system mode survives reload')
  assert.equal(await read(`document.querySelector('.xsla-shell').dataset.appearancePreset`), 'moss')
  // Electron emits the same prefers-color-scheme change as the OS, confined to
  // this test process. No Windows settings or other application themes change.
  nativeTheme.themeSource = 'light'
  await until(`document.querySelector('.xsla-shell').dataset.theme === 'light'`, 'system light change')
  nativeTheme.themeSource = 'dark'
  await until(`document.querySelector('.xsla-shell').dataset.theme === 'ink-jade'`, 'system dark change')
  nativeTheme.themeSource = 'system'
  report.checks.push('system-mode-survives-reload-and-follows-color-scheme')
  assert.deepEqual(report.errors, [], 'no browser console errors during acceptance')
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ ...report, status: 'passed' }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks: report.checks, errors: report.errors, artifacts }))
}

run().then(() => finish(0), async error => {
  report.failure = safe(error)
  if (win) { try { await screenshot('failure'); report.dom = await read(`document.body.innerText.slice(0,4000)`); } catch {} }
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ ...report, status: 'failed' }, null, 2)).catch(() => {})
  console.error(JSON.stringify({ status: 'failed', reason: report.failure, artifacts }))
  await finish(1)
})
async function finish(code) {
  if (win && !win.isDestroyed()) win.destroy()
  // Cache belongs only to this test. Never remove the user's Electron profile.
  if (profile && path.dirname(path.resolve(profile)) === artifacts && path.basename(profile).startsWith('isolated-profile-')) {
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {})
  }
  app.exit(code)
}
