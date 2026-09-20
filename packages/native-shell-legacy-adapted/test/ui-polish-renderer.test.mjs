import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import ts from 'typescript'

const desktopRequire = createRequire(new URL('../../../apps/desktop-shell/package.json', import.meta.url))
const webRequire = createRequire(new URL('../../../runtime/DSH/apps/web/package.json', import.meta.url))
const settingsRequire = createRequire(new URL('../../../runtime/DSH/packages/client/ui-settings-general/package.json', import.meta.url))

// Serialized into an isolated renderer; no real user session or network.
function installFixture() {
  const e = React.createElement, root = ReactDOM.createRoot(document.getElementById('fixture'))
  window.draw = (empty, theme) => {
    const table = e('table', null, e('tbody', null, e('tr', null,
      ...Array.from({ length: 12 }, (_, i) => e('td', { key: i }, 'table-column-' + i)))))
    const hashes = e('div', { className: 'tableScroll tableFill' }, e('table', null, e('tbody', null, e('tr', null,
      e('td', null, 'fixture.md'), e('td', { className: 'hash-cell' }, e('code', null, 'ABC12345'.repeat(8))), e('td', null, '输入保持原样')))))
    const markdown = e('div', { className: 'event-markdown' }, e('div', null,
      e('p', null, e('a', { href: '#' }, 'https://example.test/' + 'long-path'.repeat(70))),
      e('pre', null, 'code'.repeat(500)), table, hashes))
    const content = empty ? uiPolish.renderEmptyStage(e, { drafting: false, onStarter() {} })
      : e('div', { className: 'events' }, e('article', { className: 'event' },
        e('div', { className: 'event-body' }, markdown)))
    ReactDOM.flushSync(() => root.render(e('div', { className: 'xsla-shell', 'data-theme': theme, style: { '--xsla-content-font-size': '17px' } },
      e('div', { className: 'app' }, e('div', { className: 'main workbench-layout insp-collapsed', style: { '--xsla-side-width': '232px' } },
        e('aside', { className: 'side' }, '会话'),
        e('section', { className: 'chat' + (empty ? ' chat-empty' : '') },
          e('header', { className: 'chat-head' }, '资料核对'),
          e('div', { className: 'conversation-body' }, e('div', { className: 'stream', 'data-empty': empty }, content)),
          e('div', { className: 'composer' }, e('div', { className: 'cbox' }, e('textarea', { 'aria-label': '输入任务' }), e('button', null, '发送')))),
        e('aside', { className: 'insp', hidden: true })), e('footer', { className: 'statusbar' }, '小蛇')))))
  }
  window.material = () => {
    const active = { id: 'a', type: 'file', title: '交付说明.md', source: 'C:/project/交付说明.md', status: 'ready', capabilities: {}, view: { kind: 'text', lines: [{ number: 1, text: '可阅读的正文' }], totalLines: 1 } }
    ReactDOM.flushSync(() => root.render(e('div', { className: 'xsla-shell' }, e('aside', { className: 'unified-workbench', style: { width: 420, height: 700 } },
      uiPolish.renderWorkSurfaceDock(e, {
        open: true, items: Array.from({ length: 12 }, (_, i) => ({ ...active, id: String(i), title: '文件' + i + '.md' })), active,
        preference: { pinnedIds: [], mode: 'watch' }, hiddenCount: 0, category: 'files', fileCount: 12, activityCount: 13, onCategory() {},
        onSelect() {}, onClose() {}, onCopy() {}, onTogglePin() {}, onRefresh() {},
        renderContent: () => e('p', null, '文档正文'),
      })))))
  }
  window.settingsNavigation = (theme = 'ink-jade', custom = false) => {
    const rows = ['general', 'appearance', 'shortcuts', 'models', 'plugins', 'agent-presets', 'memory', 'coding-workbench', 'security', 'migration-recovery', 'runtime', 'about'].map((id, order) => ({ id, order, label: ['通用设置', '外观', '快捷键', '模型', '插件与能力', 'Agent 预设', '记忆', '编码工作台', '权限与安全', '迁移与恢复', '运行与扩展', '高级与关于'][order] }))
    const sample = e('div', null,
      e('article', { className: 'provider_card_static', 'data-static-card': '' }, '仅供阅读的说明'),
      e('button', { className: 'provider_card_control', 'data-clickable-card': '' }, '可点击操作'),
      e('span', { className: 'xsla-settings-badge', 'data-status': 'stale' }, '版本不一致'),
      e('span', { className: 'xsla-settings-badge', 'data-status': 'current' }, '版本一致'),
      e('article', { className: 'xsla-settings-card', 'data-version-status': 'stale' },
        e('div', { className: 'xsla-settings-card-head' }, e('b', null, '版本一致性')),
        e('p', { 'data-version-detail': '' }, '检测到源码、后台或界面版本不一致。请先保存草稿，再按受控启动流程更新；检查不会自动刷新或重启。'),
        e('div', { className: 'xsla-settings-facts' }, e('div', { className: 'xsla-settings-fact' }, e('b', null, '当前界面'), e('span', null, 'ea63a4f168db'))),
        e('button', { className: 'xsla-settings-action' }, '重新检查版本')),
      e('article', { className: 'xsla-settings-card', 'data-information-card': '' },
        e('b', null, '产品默认值'), e('p', null, '这是默认值说明，不是本机开关状态读数。'), e('small', null, '已有个人配置可覆盖默认值。')))
    const appearance = uiPolish.normalizeAppearance({ preset: custom ? 'custom' : 'graphite', customAccent: '#b08f4c', customSurfaceDark: '#101b38', customBackgroundDark: '#243052' })
    ReactDOM.flushSync(() => root.render(e('div', { className: 'xsla-shell', 'data-theme': theme, 'data-appearance-preset': appearance.preset, style: uiPolish.appearanceTokens(appearance, theme === 'light' ? 'light' : 'dark') },
      e(settingsPanel.SettingsPanel, { rows, activeId: 'general', onSelect() {}, onClose() {},
        t: key => ({ 'group.preferences': '使用偏好', 'group.capabilities': '模型与能力', 'group.system': '安全与维护' })[key] ?? key,
        renderSlot: name => name === 'settings.section' ? sample : name === 'settings.header' ? '小蛇设置' : '关闭',
      }))))
  }
}

// Serialized into a hidden Electron process, not the user's application.
async function runHidden() {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', config.profile)
  await app.whenReady()
  const win = new BrowserWindow({ show: false, width: 1429, height: 936, webPreferences: { sandbox: true } })
  try {
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }))
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>' + config.css + '</style><div id="fixture"></div>'))
    await win.webContents.executeJavaScript(config.renderer)
    const failures = []
    for (const width of [1429, 1100, 760, 480]) for (const zoom of [1, 1.25]) for (const theme of ['light', 'ink-jade']) {
      win.setContentSize(width, 900)
      win.webContents.setZoomFactor(zoom)
      await win.webContents.executeJavaScript('draw(false,' + JSON.stringify(theme) + ')')
      await new Promise(r => setTimeout(r, 60))
      const reading = await win.webContents.executeJavaScript('(()=>{const s=document.querySelector(".stream"),p=s.querySelector("pre"),table=s.querySelector("table");return {stream:s.scrollWidth-s.clientWidth,pre:p.scrollWidth>p.clientWidth,table:table.scrollWidth>table.clientWidth,text:p.textContent.length}})()')
      if (reading.stream > 1 || !reading.pre || !reading.table || reading.text !== 2000) failures.push({ width, theme, reading })
      const overlap = await win.webContents.executeJavaScript('(()=>{const c=document.querySelector(".hash-cell");const r=document.createRange();r.selectNodeContents(c);return r.getBoundingClientRect().right>c.getBoundingClientRect().right+1})()')
      if (overlap) failures.push({ width, theme, overlap })
      await win.webContents.executeJavaScript('draw(true,' + JSON.stringify(theme) + ')')
      await new Promise(r => setTimeout(r, 60))
      const gap = await win.webContents.executeJavaScript('document.querySelector(".cbox").getBoundingClientRect().top-document.querySelector(".stage-starters").getBoundingClientRect().bottom')
      if (gap > 80 || gap < 0) failures.push({ width, theme, gap })
    }
    await win.webContents.executeJavaScript('material()')
    const directory = await win.webContents.executeJavaScript('(()=>{const d=document.querySelector(".surface-directory");if(!d)return false;const closed=!d.open;d.open=true;return closed&&d.querySelectorAll(".surface-tab").length===12})()')
    if (!directory) failures.push('material directory inaccessible')
    await win.webContents.executeJavaScript('window.closedByEscape=0;window.releaseDialog=uiPolish.mountNativeDialogAccessibility(document,document.querySelector(".surface-dock"),undefined,()=>closedByEscape++);document.querySelector(".surface-directory>summary").focus()')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await new Promise(r => setTimeout(r, 50))
    const keyboard = await win.webContents.executeJavaScript('(()=>{const button=document.activeElement;const reachesFile=button.classList.contains("surface-tab");button.addEventListener("keydown",e=>e.preventDefault());button.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));releaseDialog();return {reachesFile,closed:closedByEscape}})()')
    if (!keyboard.reachesFile || keyboard.closed !== 0) failures.push({ keyboard })
    win.setContentSize(1429, 900)
    win.webContents.setZoomFactor(1)
    await win.webContents.executeJavaScript('settingsNavigation()')
    // Force the renderer-only hover state without moving the user's pointer.
    win.webContents.debugger.attach('1.3')
    const documentNode = await win.webContents.debugger.sendCommand('DOM.getDocument')
    const navNode = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '[data-xs-settings-nav-item]' })
    await win.webContents.debugger.sendCommand('CSS.enable')
    await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId: navNode.nodeId, forcedPseudoClasses: ['hover'] })
    await new Promise(r => setTimeout(r, 200))
    const navigation = await win.webContents.executeJavaScript(`(()=>{
      const list=document.querySelector('[data-xs-settings-nav-list]'),nav=list.parentElement;
      const last=list.querySelector('[data-xs-settings-group]:last-child button:last-child');
      const overflow=list.scrollWidth-list.clientWidth;last.scrollIntoView({block:'nearest'});
      const caption=getComputedStyle(nav,'::after'),hasCaption=!['none','normal','""'].includes(caption.content)&&caption.display!=='none';
      const captionTop=nav.getBoundingClientRect().bottom-parseFloat(caption.bottom)-parseFloat(caption.lineHeight);
      return {overflow,lastVisible:last.getBoundingClientRect().height>0&&last.getBoundingClientRect().bottom<=list.getBoundingClientRect().bottom+1,
        captionOverlaps:hasCaption&&list.getBoundingClientRect().bottom>captionTop}
    })()`)
    if (navigation.overflow > 1 || !navigation.lastVisible || navigation.captionOverlaps) failures.push({ navigation })
    for (const theme of ['light', 'ink-jade']) for (const custom of [false, true]) {
      await win.webContents.executeJavaScript('settingsNavigation(' + JSON.stringify(theme) + ',' + custom + ')')
      const hierarchy = await win.webContents.executeJavaScript(`(()=>{
        const title=document.querySelector('[data-xs-settings-group-title]');
        const option=document.querySelector('[data-xs-settings-nav-item="appearance"]');
        const current=document.querySelector('[data-xs-settings-nav-item][aria-current="true"]');
        const headingStyle=getComputedStyle(title), optionStyle=getComputedStyle(option);
        const glyph=option.querySelector('svg');
        return {sizeGap:parseFloat(optionStyle.fontSize)-parseFloat(headingStyle.fontSize),
          distinctColor:headingStyle.color!==optionStyle.color, glyphVisible:!!glyph&&getComputedStyle(glyph).display!=='none'&&glyph.getBoundingClientRect().width>=14,
          labelOffset:option.querySelector('[data-xs-settings-nav-label]')?.getBoundingClientRect().left-title.getBoundingClientRect().left,
          checkVisible:!!current.querySelector('[data-xs-settings-nav-check]'),
          allGlyphsVisible:[...document.querySelectorAll('[data-xs-settings-nav-glyph]>svg')].filter(svg=>svg.getBoundingClientRect().width>=14).length===12,
          fullWidthDetails:document.querySelector('[data-version-detail]').getBoundingClientRect().width/document.querySelector('[data-version-status]').getBoundingClientRect().width>.8,
          informationStacked:document.querySelector('[data-information-card] p').getBoundingClientRect().top>=document.querySelector('[data-information-card] b').getBoundingClientRect().bottom,
          warningDistinct:getComputedStyle(document.querySelector('[data-status="stale"]')).color!==getComputedStyle(document.querySelector('[data-status="current"]')).color}
      })()`)
      if (hierarchy.sizeGap < 2 || !hierarchy.distinctColor || !hierarchy.glyphVisible || hierarchy.labelOffset < 20 || !hierarchy.checkVisible || !hierarchy.allGlyphsVisible || !hierarchy.warningDistinct || !hierarchy.fullWidthDetails || !hierarchy.informationStacked) failures.push({ theme, custom, hierarchy })
    }
    const pageNodes = await win.webContents.debugger.sendCommand('DOM.getDocument')
    const cardNode = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: pageNodes.root.nodeId, selector: '[data-static-card]' })
    const staticBefore = await win.webContents.executeJavaScript('getComputedStyle(document.querySelector("[data-static-card]")).backgroundColor')
    await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId: cardNode.nodeId, forcedPseudoClasses: ['hover'] })
    await new Promise(r => setTimeout(r, 200))
    const staticAfter = await win.webContents.executeJavaScript('getComputedStyle(document.querySelector("[data-static-card]")).backgroundColor')
    if (staticBefore !== staticAfter) failures.push('read-only settings card pretends to be clickable on hover')
    const controlNode = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: pageNodes.root.nodeId, selector: '[data-clickable-card]' })
    const controlBefore = await win.webContents.executeJavaScript('getComputedStyle(document.querySelector("[data-clickable-card]")).backgroundColor')
    await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId: controlNode.nodeId, forcedPseudoClasses: ['hover'] })
    await new Promise(r => setTimeout(r, 200))
    const controlAfter = await win.webContents.executeJavaScript('getComputedStyle(document.querySelector("[data-clickable-card]")).backgroundColor')
    if (controlBefore === controlAfter) failures.push('interactive settings card has no hover feedback')
    await win.webContents.executeJavaScript('document.querySelector("[data-clickable-card]").disabled=true')
    const disabledAfter = await win.webContents.executeJavaScript('getComputedStyle(document.querySelector("[data-clickable-card]")).backgroundColor')
    if (controlBefore !== disabledAfter) failures.push('disabled settings card retains an interactive hover')
    for (const width of [760, 480]) for (const zoom of [1, 1.25]) {
      win.setContentSize(width, 900); win.webContents.setZoomFactor(zoom)
      await win.webContents.executeJavaScript('settingsNavigation("ink-jade",true)')
      const small = await win.webContents.executeJavaScript(`(()=>{
        const panel=document.querySelector('[data-xs-settings-panel]'),list=document.querySelector('[data-xs-settings-nav-list]');
        const items=[...list.querySelectorAll('button')],last=items.at(-1);
        last.scrollIntoView({block:'nearest',inline:'nearest'});
        const a=last.getBoundingClientRect(),b=list.getBoundingClientRect();
        return {count:items.length,panelWidth:panel.getBoundingClientRect().width,viewport:innerWidth,
          lastVisible:a.width>0&&a.right<=b.right+1&&a.bottom<=b.bottom+1,
          titleVisible:document.querySelector('[data-xs-settings-group-title]').checkVisibility(),
          vertical:getComputedStyle(list).flexDirection==='column'}
      })()`)
      if (small.count !== 12 || small.panelWidth > small.viewport + 1 || !small.lastVisible || (small.vertical && !small.titleVisible)) failures.push({ width, zoom, small })
    }
    win.webContents.debugger.detach()
    if (win.isVisible() || win.isFocused()) failures.push('test took desktop focus')
    if (failures.length) throw Error(JSON.stringify(failures))
    console.log('UI_POLISH_RENDERER_PASS: 16 size/theme/zoom cases at 17px, real settings hierarchy in 4 palettes, 4 small-window cases, hover semantics and material directory')
    win.destroy(); app.exit(0)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}

test('real renderer preserves long content and a compact empty-state composition', { timeout: 40_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-layout-renderer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const css = (await Promise.all([
    // Keep CSS-module isolation, otherwise the unrelated legacy `.panel`
    // rule hides the test dialog and turns layout checks into zero-size checks.
    readFile(new URL('../../../runtime/DSH/packages/client/ui-settings-general/src/client/SettingsRoot.module.css', import.meta.url), 'utf8')
      .then(css => css.replace(/\.([A-Za-z_][\w-]*)\b/g, '._settings_$1_fixture')),
    readFile(new URL('../../../runtime/DSH/packages/client/ui-primitives/src/markdown/MarkdownText.module.css', import.meta.url), 'utf8'),
    ...['tokens', 'base', 'components', 'panels', 'observatory'].map(name => readFile(new URL('../ui/styles/' + name + '.css', import.meta.url), 'utf8')),
    readFile(new URL('../src/client/adapted.css', import.meta.url), 'utf8'),
  ])).join('\n')
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source + '\nexport { renderEmptyStage, renderWorkSurfaceDock, mountNativeDialogAccessibility };', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const react = await readFile(join(dirname(webRequire.resolve('react')), 'umd/react.production.min.js'), 'utf8')
  const reactDom = await readFile(join(dirname(webRequire.resolve('react-dom')), 'umd/react-dom.production.min.js'), 'utf8')
  // Exercise the production settings markup and glyphs with the real adapter CSS;
  // no copied navigation tree that could conceal integration regressions.
  const jsxOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
  const iconSource = await readFile(new URL('../../../runtime/DSH/packages/client/ui-primitives/src/icons/index.tsx', import.meta.url), 'utf8')
  const panelSource = await readFile(new URL('../../../runtime/DSH/packages/client/ui-settings-general/src/client/SettingsRoot.tsx', import.meta.url), 'utf8')
  const clsxSource = await readFile(settingsRequire.resolve('clsx'), 'utf8')
  const settingsRenderer = '\n(()=>{const exports={};' + ts.transpileModule(iconSource, { compilerOptions: jsxOptions }).outputText + ';window.settingsIcons=exports;})();'
    + '\n(()=>{const module={exports:{}};' + clsxSource + ';window.settingsClsx=module.exports;})();'
    + '\n(()=>{const exports={};const require=name=>name==="react"?React:name==="clsx"?{default:settingsClsx}:name.endsWith(".css")?{default:new Proxy({},{get:(_,key)=>"_settings_"+key+"_fixture"})}:settingsIcons;'
    + ts.transpileModule(panelSource + '\nexport { SettingsPanel };', { compilerOptions: jsxOptions }).outputText + ';window.settingsPanel=exports;})();'
  const config = { profile: join(root, 'profile'), css, renderer: react + '\n' + reactDom + settingsRenderer + '\n(()=>{const exports={};' + compiled + '\nwindow.uiPolish=exports;})();(' + installFixture.toString() + ')()' }
  const runner = join(root, 'runner.cjs')
  await writeFile(runner, 'const config=' + JSON.stringify(config) + ';(' + runHidden.toString() + ')()')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await promisify(execFile)(desktopRequire('electron'), [runner], { env, windowsHide: true, timeout: 35_000 })
  assert.match(result.stdout, /UI_POLISH_RENDERER_PASS/)
})
