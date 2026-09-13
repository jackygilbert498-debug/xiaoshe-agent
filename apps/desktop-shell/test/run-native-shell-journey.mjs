/**
 * Electron-only acceptance fixture for the built Native Shell client.
 *
 * It deliberately replaces only Cordis services with deterministic in-memory
 * ports. React, ReactDOM, the generated client artifact and its registered
 * `root` component all run inside a real Chromium renderer.
 */
import assert from 'node:assert/strict'
import { app, BrowserWindow, nativeImage, net } from 'electron'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { buildJourneyMarkdown } from './build-journey-markdown.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '../../..')
const outputPath = resolve(requiredEnvironment('XIAOSHE_NATIVE_SHELL_JOURNEY_OUTPUT'))
const clientArtifact = resolve(requiredEnvironment('XIAOSHE_NATIVE_SHELL_CLIENT_ARTIFACT'))
const markdownBundle = await buildJourneyMarkdown(repositoryRoot, dirname(outputPath))
const dshWebRoot = resolve(repositoryRoot, 'runtime/DSH/apps/web')
const requireFromDshWeb = createRequire(resolve(dshWebRoot, 'package.json'))
const reactPath = requireFromDshWeb.resolve('react')
const reactDomClientPath = requireFromDshWeb.resolve('react-dom/client')
const jsxRuntimePath = requireFromDshWeb.resolve('react/jsx-runtime')
const ts = createRequire(resolve(repositoryRoot, 'package.json'))('typescript')
// Exercise the real settings owner and icon geometry; only its external
// slot/services are fixture ports, just like the runtime ports below.
const settingsDirectory = resolve(repositoryRoot, 'runtime/DSH/packages/client/ui-settings-general/src/client')
const settingsCode = ts.transpileModule(await readFile(resolve(settingsDirectory, 'SettingsRoot.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const settingsCss = (await readFile(resolve(settingsDirectory, 'SettingsRoot.module.css'), 'utf8'))
  .replace(/\.([A-Za-z_][\w-]*)/gu, '.fixtureSettings_$1_')
const settingsIconsCode = ts.transpileModule(await readFile(resolve(repositoryRoot, 'runtime/DSH/packages/client/ui-primitives/src/icons/index.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const connectionIndicatorCode = ts.transpileModule(await readFile(resolve(repositoryRoot, 'runtime/DSH/packages/client/ui-primitives/src/ConnectionIndicator.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const profile = resolve(dirname(outputPath), 'electron-profile')
const viewports = [{ width: 390, height: 844 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }]
const materialEvidence = process.env.XIAOSHE_NATIVE_SHELL_MATERIAL_EVIDENCE
  ? JSON.parse(await readFile(process.env.XIAOSHE_NATIVE_SHELL_MATERIAL_EVIDENCE, 'utf8')) : undefined

app.setPath('userData', profile)
app.on('window-all-closed', () => {
  // The runner owns termination after its report has been flushed.
})

async function main() {
  await readFile(clientArtifact, 'utf8')
  await app.whenReady()
  // A pending Promise alone does not keep every Electron build alive before a
  // visible window exists. Keep only this acceptance process alive explicitly;
  // both success and failure paths clear it before their final exit.
  const keepAlive = setInterval(() => {}, 1_000)
  const results = []
  const blockedNetworkRequests = []
  try {
    for (const viewport of viewports) results.push(await runViewport(viewport, blockedNetworkRequests))
    await writeReport({
      schema: 'xiaoshe-native-shell-journey/v1',
      accepted: true,
      electronVersion: process.versions.electron,
      paidModelRequests: blockedNetworkRequests.length,
      blockedNetworkRequests,
      viewports: results,
    })
    clearInterval(keepAlive)
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    await writeReport({
      schema: 'xiaoshe-native-shell-journey/v1',
      accepted: false,
      paidModelRequests: blockedNetworkRequests.length,
      blockedNetworkRequests,
      viewports: results,
      error: error instanceof Error ? error.stack : String(error),
    })
    clearInterval(keepAlive)
    app.exit(1)
  }
}

async function runViewport({ width, height }, blockedNetworkRequests) {
  process.stdout.write(`Checking existing journey ${width}x${height}\n`)
  const screenshots = []
  const bootstrapSource = rendererBootstrap({ reactPath, reactDomClientPath, jsxRuntimePath, settingsCode, settingsCss, settingsIconsCode })
  new Script(bootstrapSource, { filename: 'renderer-bootstrap.js' })
  const fixturePath = resolve(dirname(outputPath), `journey-${width}x${height}.html`)
  await writeFile(fixturePath, `<!doctype html><html><head><meta charset="utf-8"><title>Native Shell journey</title></head><body><div id="root"></div><script>${bootstrapSource.replaceAll('</script', '<\\/script')}</script><script src="${pathToFileURL(clientArtifact).href}"></script></body></html>`, 'utf8')
  const blockedRequests = []
  const consoleErrors = []
  const browser = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: false,
      nodeIntegration: true,
      partition: `xiaoshe-native-shell-journey-${process.pid}-${width}x${height}`,
      sandbox: false,
    },
  })
  // The production web-server serves these exact canonical assets. A file://
  // fixture has no /api server; without this port, Chromium paints a broken
  // image glyph through the watermark's outline filter instead of the logo.
  browser.webContents.session.protocol.handle('file', async request => {
    const pathname = new URL(request.url).pathname
    if (pathname.endsWith('/api/xiaoshe/legacy-adapted-brand-raster')) return new Response(await readFile(resolve(repositoryRoot, 'packages/native-shell-legacy-adapted/ui/assets/icon-256.png')), { headers: { 'content-type': 'image/png' } })
    if (pathname.endsWith('/api/xiaoshe/legacy-adapted-brand-icon')) return new Response(await readFile(resolve(repositoryRoot, 'packages/native-shell-legacy-adapted/ui/assets/snake.svg')), { headers: { 'content-type': 'image/svg+xml' } })
    return net.fetch(request, { bypassCustomProtocolHandlers: true })
  })
  // The real Chromium session is the final safety boundary: a fixture bug or
  // future client change cannot reach a model endpoint or any other network.
  browser.webContents.session.webRequest.onBeforeRequest({
    urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'],
  }, (details, callback) => {
    const request = { url: networkRequestLabel(details.url), resourceType: details.resourceType }
    blockedRequests.push(request)
    blockedNetworkRequests.push({ viewport: `${width}x${height}`, ...request })
    callback({ cancel: true })
  })
  browser.webContents.on('console-message', (event, ...args) => {
    const details = typeof event.level === 'string' ? event : args.length === 1 && typeof args[0] === 'object' && args[0] !== null
      ? args[0]
      : { level: args[0], message: args[1], lineNumber: args[2], sourceId: args[3] }
    if (details.level === 'error' || details.level === 3) {
      consoleErrors.push({
        message: String(details.message ?? '').slice(0, 2_000),
        lineNumber: Number(details.lineNumber ?? 0),
        sourceId: String(details.sourceId ?? '').slice(0, 500),
      })
    }
  })
  browser.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(`[native-shell-journey] renderer gone: ${JSON.stringify(details)}\n`)
  })
  try {
    await browser.loadFile(fixturePath)
    await browser.webContents.executeJavaScript('console.error("xs-acceptance-console-probe")')
    const consoleProbe = consoleErrors.findIndex(item => item.message === 'xs-acceptance-console-probe')
    assert.ok(consoleProbe >= 0, 'real Electron console-error collection must be live')
    consoleErrors.splice(consoleProbe, 1)
    await setExactViewport(browser, width, height)
    const moduleProbe = await browser.webContents.executeJavaScript(`(() => { try { return { react: typeof require(${JSON.stringify(reactPath)}).createElement, reactDom: typeof require(${JSON.stringify(reactDomClientPath)}).createRoot } } catch (error) { return { error: String(error?.stack || error) } } })()`)
    assert.equal(moduleProbe.error, undefined, moduleProbe.error)
    assert.deepEqual(moduleProbe, { react: 'function', reactDom: 'function' })
    await waitFor(browser, 'window.__journey?.state?.client !== undefined')
    await browser.webContents.executeJavaScript('window.__journey.mount()')
    await waitFor(browser, 'document.querySelector("textarea[name=content]") !== null')
    assert.equal(await browser.webContents.executeJavaScript(`new Promise(resolve => {
      const image = new Image(); image.onload = () => resolve(image.naturalWidth === 256); image.onerror = () => resolve(false)
      image.src = window.__journey.state.client.BROWSER_BRAND_RASTER_HREF
    })`), true, 'canonical brand raster must load before visual acceptance')

    const initial = await browser.webContents.executeJavaScript('window.__journey.inspect()')
    assert.equal(initial.registeredRootId, 'xiaoshe-native-shell-legacy-adapted')
    assert.equal(initial.loadedModuleId, '@xiaoshe/native-shell-legacy-adapted')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".task-mobile-toggle").textContent'), '会话', 'session navigation must not duplicate the task-workbench label')
    await browser.webContents.executeJavaScript('window.__journey.setRuntimeState("blocked")')
    await waitFor(browser, 'document.querySelector(".task-summary-head>span")?.textContent === "等待交互信息"')
    assert.match(await browser.webContents.executeJavaScript('document.querySelector(".head-runtime").textContent'), /等待交互信息/u, 'unknown interaction kind must not be presented as a known approval')
    await browser.webContents.executeJavaScript('window.__journey.setInteraction("question")')
    await waitFor(browser, 'document.querySelector(".question-card") !== null')
    assert.match(await browser.webContents.executeJavaScript('document.querySelector(".head-runtime").textContent'), /需要回答/u, 'known questions replace the temporary header state too')
    await browser.webContents.executeJavaScript('window.__journey.setInteraction()')
    await browser.webContents.executeJavaScript('window.__journey.setRuntimeState("idle")')
    assert.deepEqual(initial.ledger, { sends: [], stopRunCalls: [], cancelCalls: [], durableEvents: [], modelSelections: [], paidModelRequests: [] })
    await browser.webContents.executeJavaScript('window.__journey.setEmptyTask(true)')
    await waitFor(browser, 'document.querySelector(".task-summary")?.textContent.includes("等待任务") === true')
    assert.equal(await browser.webContents.executeJavaScript('getComputedStyle(document.querySelector(".stage-ghost")).display === "none"'), width <= 520, 'only phone empty-state decoration yields space to task starters')
    assert.equal(await browser.webContents.executeJavaScript('getComputedStyle(document.querySelector(".stage-word")).display !== "none"'), true, 'the brand wordmark stays visible on every viewport')
    for (const theme of ['light', 'ink-jade']) {
      if (theme === 'ink-jade') await click(browser, '.theme-toggle')
      await waitFor(browser, `document.querySelector('.xsla-shell')?.dataset.theme === ${JSON.stringify(theme)}`)
      screenshots.push(await captureScene(browser, width, height, `empty-${theme}`))
    }
    await click(browser, '.theme-toggle')
    await browser.webContents.executeJavaScript('window.__journey.setEmptyTask(false)')

    await click(browser, '[data-task-starter="organize"]')
    const starter = await browser.webContents.executeJavaScript('window.__journey.inspect()')
    assert.match(starter.composerValue, /整理/u)
    assert.equal(starter.ledger.sends.length, 0)
    await click(browser, '[data-task-starter="image"]')
    assert.equal((await browser.webContents.executeJavaScript('window.__journey.inspect()')).composerValue, starter.composerValue)
    await fillComposer(browser, '')
    await browser.webContents.executeJavaScript(`(() => {
      const data = new DataTransfer()
      data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P8z8BQDwAFgwJ/lVgJNwAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))], 'draft.png', { type: 'image/png' }))
      document.querySelector('textarea[name=content]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }))
    })()`)
    await waitFor(browser, 'document.querySelectorAll(".attachment-item").length === 1')
    await click(browser, '[data-task-starter="organize"]')
    assert.equal((await browser.webContents.executeJavaScript('window.__journey.inspect()')).composerValue, '')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelectorAll(".attachment-item").length'), 1)
    await click(browser, '.attachment-remove')

    await browser.webContents.executeJavaScript('window.__journey.setModelUnavailable(true)')
    await waitFor(browser, 'document.querySelector(".stage-setup button") !== null')
    await click(browser, '.stage-setup button')
    await waitFor(browser, 'document.querySelector("[data-xs-settings-nav-item=models]")?.getAttribute("aria-current") === "true"')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-xs-settings-close] svg path") !== null'), true, 'settings fixture must render the real visible close icon')
    await pressKey(browser, 'Escape')
    await browser.webContents.executeJavaScript('window.__journey.setModelUnavailable(false)')
    await waitFor(browser, 'document.querySelector(".stage-setup") === null')

    assert.deepEqual(await browser.webContents.executeJavaScript(`({
      launchers: document.querySelectorAll('[data-workbench-launcher]').length,
      controls: document.querySelector('[data-workbench-launcher]')?.getAttribute('aria-controls'),
      defaultCollapsed: document.querySelector('#xsla-insp')?.classList.contains('collapsed'),
    })`), { launchers: 1, controls: 'xsla-insp', defaultCollapsed: width <= 900 })
    if (width <= 900) {
      await browser.webContents.executeJavaScript(`(() => {
        const trigger = document.querySelector('[data-workbench-launcher]')
        trigger?.focus()
        trigger?.click()
      })()`)
      await waitFor(browser, 'document.querySelector("#xsla-insp")?.classList.contains("mobile-open") === true')
      await waitFor(browser, 'document.querySelector("#xsla-insp")?.getAttribute("role") === "dialog"')
      const overlayAccessibility = await browser.webContents.executeJavaScript(`(() => {
        const inspector = document.querySelector('#xsla-insp')
        const backgrounds = [...document.querySelectorAll('.main > :not(#xsla-insp)')]
        return {
          role: inspector?.getAttribute('role'),
          modal: inspector?.getAttribute('aria-modal'),
          focusInside: inspector?.contains(document.activeElement) === true,
          backgroundsInert: backgrounds.length > 0 && backgrounds.every(node => node.hasAttribute('inert') && node.getAttribute('aria-hidden') === 'true'),
          closeCount: document.querySelectorAll('[aria-label="收起工作台"]').length,
        }
      })()`)
      assert.deepEqual(overlayAccessibility, {
        role: 'dialog', modal: 'true', focusInside: true, backgroundsInert: true, closeCount: 1,
      })

      await setExactViewport(browser, 901, height)
      await waitFor(browser, 'document.querySelector("#xsla-insp")?.classList.contains("mobile-open") === false && document.querySelector(".overlay-scrim") === null')
      await setExactViewport(browser, width, height)
      await openWorkbench(browser, 'task')
      await waitFor(browser, 'document.querySelector("#xsla-insp")?.classList.contains("mobile-open") === true')
    }
    const taskWorkbench = await browser.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('#xsla-panel-status')
      const history = panel?.querySelector('.run-history')
      const groups = [...(history?.querySelectorAll('[data-run-history-group]') || [])]
      return {
        tabs: [...document.querySelectorAll('[data-workbench-view]')].map(node => node.dataset.workbenchView),
        panelText: panel?.textContent || '',
        historyOpen: history instanceof HTMLDetailsElement ? history.open : undefined,
        historyGroups: groups.map(node => ({ label: node.getAttribute('data-run-history-group'), count: node.getAttribute('data-run-history-count') })),
        runningPresent: panel?.querySelector('[data-run-job-id="active-job"]') !== null,
        queuePresent: panel?.querySelector('[data-run-queue-id="queue-1"]') !== null,
        activeTodoPresent: panel?.querySelector('[data-run-todo-id="active-todo"]') !== null,
        completedTodoPresent: panel?.querySelector('[data-run-todo-id="done-todo"]') !== null,
        activeChildPresent: panel?.querySelector('[data-run-subagent-id="active-child"]') !== null,
        inactiveChildPresent: panel?.querySelector('[data-run-subagent-id="inactive-child"]') !== null,
        currentFailurePresent: panel?.querySelector('[data-run-attention-group="构建桌面端"]') !== null,
        duplicateMaterials: panel?.querySelectorAll('.task-deliverables,[data-run-deliverable-id]').length,
        passiveRowCursor: getComputedStyle(panel?.querySelector('[data-run-job-id="active-job"]')).cursor,
      }
    })()`)
    assert.deepEqual(taskWorkbench.tabs, ['task', 'materials', 'browser'])
    assert.doesNotMatch(taskWorkbench.panelText, /工作材料/u)
    assert.match(taskWorkbench.panelText, /有运行事项需要关注/u)
    assert.doesNotMatch(taskWorkbench.panelText, /发送一项任务后/u)
    assert.doesNotMatch(taskWorkbench.panelText, /Xiaoshe check|check completed/u)
    assert.equal(taskWorkbench.historyOpen, false)
    assert.deepEqual(taskWorkbench.historyGroups, [{ label: '运行巡检', count: '8' }])
    assert.equal(taskWorkbench.runningPresent, true)
    assert.equal(taskWorkbench.queuePresent, false, 'editable queue has a single owner beside the composer')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelectorAll(".composer-queue [data-composer-queue-id=queue-1]").length'), 1)
    assert.equal(taskWorkbench.activeTodoPresent, true)
    assert.equal(taskWorkbench.completedTodoPresent, false)
    assert.equal(taskWorkbench.activeChildPresent, true)
    assert.equal(taskWorkbench.inactiveChildPresent, true, 'inactive children remain available in the collapsed history group')
    assert.equal(taskWorkbench.currentFailurePresent, true)
    assert.equal(taskWorkbench.duplicateMaterials, 0)
    assert.notEqual(taskWorkbench.passiveRowCursor, 'pointer')

    // Management moves into the real settings owner and slash navigation
    // must select that section without changing or sending the task draft.
    if (width <= 900) await closeWorkbench(browser)
    await fillComposer(browser, '/memory')
    await click(browser, '#xsla-slash-command-memory')
    await waitFor(browser, 'document.querySelector("[data-xs-settings-nav-item=memory]")?.getAttribute("aria-current") === "true"')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-xs-settings-panel] .memory-workbench") !== null'), true)
    await fillTextarea(browser, '.memory-editor textarea', '尚未保存的偏好草稿')
    await click(browser, '[data-xs-settings-nav-item=runtime]')
    await click(browser, '[data-xs-settings-nav-item=memory]')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".memory-editor textarea").value'), '尚未保存的偏好草稿')
    await click(browser, '[data-memory-id=forgotten-entry] button')
    await waitFor(browser, 'document.querySelector("[data-memory-id=forgotten-entry]")?.dataset.state === "active"')
    screenshots.push(await captureScene(browser, width, height, 'settings-memory-light'))
    await browser.webContents.executeJavaScript(`(() => {
      const buttons = [...document.querySelectorAll('[data-xs-settings-panel] button:not(:disabled), [data-xs-settings-panel] textarea:not(:disabled)')].filter(node => node.getClientRects().length > 0)
      buttons.at(-1).focus()
    })()`)
    await pressKey(browser, 'Tab')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-xs-settings-panel]").contains(document.activeElement)'), true, 'Tab must stay inside settings')
    await click(browser, '.memory-actions button')
    await waitFor(browser, 'document.querySelector(".memory-modal")?.contains(document.activeElement) === true')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".memory-modal textarea").value'), '尚未保存的偏好草稿')
    assert.doesNotMatch(await browser.webContents.executeJavaScript('document.querySelector(".memory-modal-head").textContent'), /右侧记忆栏|返回侧栏/u)
    assert.equal(await browser.webContents.executeJavaScript(`Number(getComputedStyle(document.querySelector('.memory-modal-layer')).zIndex) > Number(getComputedStyle(document.querySelector('.side')).zIndex)`), true, 'nested memory editor paint layer must be above the settings host')
    assert.equal(await browser.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('.memory-modal textarea'), rect = editor.getBoundingClientRect()
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === editor
    })()`), true, 'nested memory editor must be visually above settings, not merely focused behind it')
    screenshots.push(await captureScene(browser, width, height, 'memory-editor-light'))
    await pressKey(browser, 'Escape')
    await waitFor(browser, 'document.querySelector(".memory-modal") === null')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-xs-settings-panel]") !== null'), true, 'Escape closes only the top memory editor')
    assert.equal(await browser.webContents.executeJavaScript('document.activeElement?.textContent?.slice(0, 100)'), '放大编辑', 'nested editor restores its own opener')
    await pressKey(browser, 'Escape')
    await waitFor(browser, 'document.querySelector("[data-xs-settings-panel]") === null')
    await fillComposer(browser, '/memory')
    await click(browser, '#xsla-slash-command-memory')
    await waitFor(browser, 'document.querySelector(".memory-editor textarea")?.value === "尚未保存的偏好草稿"')
    await browser.webContents.executeJavaScript('window.__journey.changeProject()')
    await waitFor(browser, 'document.querySelector(".memory-editor textarea")?.value === ""')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-memory-id=old-project]") === null'), true)
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-memory-id=forgotten-entry]")?.dataset.state'), 'active')
    await pressKey(browser, 'Escape')
    await fillComposer(browser, '/plugins')
    await click(browser, '#xsla-slash-command-plugins')
    await waitFor(browser, 'document.querySelector("[data-xs-settings-nav-item=runtime]")?.getAttribute("aria-current") === "true"')
    await click(browser, '[data-native-settings=runtime] .manager-toggle:last-of-type')
    await waitFor(browser, 'document.querySelector(".plugin-manager") !== null')
    await pressKey(browser, 'Escape')
    await waitFor(browser, 'document.querySelector(".plugin-manager") === null')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-xs-settings-panel]") !== null'), true)
    // Exercise the registered About page, including a backend too old to have
    // the endpoint. This is a read-only port fixture; no network is attempted.
    await click(browser, '[data-xs-settings-nav-item=about]')
    await waitFor(browser, 'document.querySelector("[data-version-status]")?.dataset.versionStatus === "current"')
    assert.match(await browser.webContents.executeJavaScript('document.querySelector("[data-native-settings=about]").textContent'), /磁盘候选.*运行后台.*当前界面.*磁盘界面/u)
    await browser.webContents.executeJavaScript('window.__versionFixtureMode = "stale"')
    await click(browser, '[data-version-status] button')
    await waitFor(browser, 'document.querySelector("[data-version-status]")?.dataset.versionStatus === "stale"')
    assert.match(await browser.webContents.executeJavaScript('document.querySelector("[data-version-status] [role=alert]").textContent'), /不会自动刷新或重启/u)
    await browser.webContents.executeJavaScript('window.__versionFixtureMode = "legacy"')
    await click(browser, '[data-version-status] button')
    await waitFor(browser, 'document.querySelector("[data-version-status] .xsla-settings-error")?.textContent.includes("当前后台尚不提供版本诊断") === true')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-version-status]").dataset.versionStatus'), 'unknown')
    await browser.webContents.executeJavaScript('window.__versionFixtureMode = "incomplete"')
    await click(browser, '[data-version-status] button')
    await waitFor(browser, 'document.querySelector("[data-version-status] button")?.disabled === false')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-version-status]").dataset.versionStatus'), 'unknown', 'a 200 without fingerprints is not current')
    assert.equal(await browser.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth'), true, 'About facts remain inside the viewport')
    await pressKey(browser, 'Escape')
    await openWorkbench(browser, 'materials')
    await click(browser, '[data-run-deliverable-id="surface-1"]')
    await waitFor(browser, 'document.querySelector("#xsla-panel-materials:not([hidden]) .surface-content") !== null')
    const openedSurface = await browser.webContents.executeJavaScript(`({
      title: document.querySelector('.surface-summary b')?.textContent || '',
      content: document.querySelector('.surface-content')?.textContent || '',
      inspectorOverlayOpen: document.querySelector('#xsla-insp')?.classList.contains('mobile-open') === true,
      overlayScrimVisible: document.querySelector('.overlay-scrim') !== null,
      materialPanelVisible: document.querySelector('#xsla-panel-materials')?.hidden === false,
    })`)
    assert.equal(openedSurface.title, '验收报告')
    assert.match(openedSurface.content, /右栏产物链验收通过/u)
    assert.equal(openedSurface.inspectorOverlayOpen, width <= 900)
    assert.equal(openedSurface.overlayScrimVisible, width <= 900)
    assert.equal(openedSurface.materialPanelVisible, true)
    await closeWorkbench(browser)
    const unifiedWorkbench = await assertUnifiedWorkbench(browser, width, height, screenshots)

    await click(browser, '.model-reasoning-trigger')
    await waitFor(browser, 'document.querySelector(".model-reasoning-popover") !== null')
    const modelControlOpen = await browser.webContents.executeJavaScript('window.__journey.modelControl()')
    assert.equal(modelControlOpen.triggerVisible, true)
    assert.equal(modelControlOpen.popoverVisible, true)
    assert.equal(modelControlOpen.withinViewport, true)
    assert.equal(modelControlOpen.nativeSelectCount, 0)
    assert.equal(modelControlOpen.modelCount, 2)
    assert.equal(modelControlOpen.effortCount, 3)

    const matchingRoute = await browser.webContents.executeJavaScript('window.__journey.modelRoute("Fixture Fast")')
    assert.equal(matchingRoute.disabled, false)
    assert.equal(matchingRoute.statusText, '已验证')
    await browser.webContents.executeJavaScript('window.__journey.setProviderReadiness("stale")')
    await waitFor(browser, 'window.__journey.modelRoute("Fixture Fast").statusText === "状态未确认"')
    const staleRoute = await browser.webContents.executeJavaScript('window.__journey.modelRoute("Fixture Fast")')
    assert.equal(staleRoute.disabled, false)
    await browser.webContents.executeJavaScript('window.__journey.setProviderReadiness("unavailable")')
    await waitFor(browser, 'window.__journey.modelRoute("Fixture Fast").disabled === true && window.__journey.modelRoute("Fixture Fast").statusText === "未配置"')
    const unavailableSelections = await browser.webContents.executeJavaScript(`(() => {
      const before = window.__journey.state.ledger.modelSelections.length
      const target = [...document.querySelectorAll('.model-choice-option')].find(node => node.textContent.includes('Fixture Fast'))
      target?.click()
      return { before, after: window.__journey.state.ledger.modelSelections.length }
    })()`)
    assert.deepEqual(unavailableSelections, { before: 0, after: 0 })
    await browser.webContents.executeJavaScript('window.__journey.setProviderReadiness("matching")')
    await waitFor(browser, 'window.__journey.modelRoute("Fixture Fast").disabled === false && window.__journey.modelRoute("Fixture Fast").statusText === "已验证"')

    await click(browser, '.model-choice-option:not(.selected)')
    await waitFor(browser, 'window.__journey.state.ledger.modelSelections.length === 1 && window.__journey.state.snapshots.models.current.model === "no-paid-fast"')
    await click(browser, '.model-choice-option:not(.selected)')
    await waitFor(browser, 'window.__journey.state.ledger.modelSelections.length === 2 && window.__journey.state.snapshots.models.current.model === "no-paid-model"')
    await click(browser, '.effort-rail-option[data-effort="max"]')
    await waitFor(browser, 'window.__journey.state.ledger.modelSelections.length === 3 && document.querySelector(".model-reasoning-trigger")?.textContent.includes("最大")')
    const modelControlSelected = await browser.webContents.executeJavaScript('window.__journey.modelControl()')
    assert.equal(modelControlSelected.selectedEffort, 'max')

    await browser.webContents.executeJavaScript('window.__journey.setRunning(true)')
    await waitFor(browser, '[...document.querySelectorAll(".model-choice-option")].every(node => node.disabled) && [...document.querySelectorAll(".effort-rail-option")].some(node => !node.disabled)')
    const runningLock = await browser.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('.model-reasoning-trigger')
      const before = window.__journey.state.ledger.modelSelections.length
      document.querySelector('.model-choice-option:not(.selected)')?.click()
      return {
        triggerFocusable: trigger instanceof HTMLButtonElement && !trigger.disabled && trigger.tabIndex >= 0,
        routeBlocked: [...document.querySelectorAll('.model-choice-option')].every(node => node.disabled),
        effortAvailable: [...document.querySelectorAll('.effort-rail-option')].some(node => !node.disabled),
        selectionUnchanged: window.__journey.state.ledger.modelSelections.length === before,
      }
    })()`)
    assert.deepEqual(runningLock, { triggerFocusable: true, routeBlocked: true, effortAvailable: true, selectionUnchanged: true })
    await browser.webContents.executeJavaScript('window.__journey.setRunning(false)')
    await waitFor(browser, 'document.querySelector(".model-reasoning-trigger")?.getAttribute("aria-disabled") === "false"')

    const queueText = `queue-${width}x${height}`
    await fillComposer(browser, queueText)
    await click(browser, 'button.send')
    await waitFor(browser, `window.__journey.state.ledger.sends.length === 1 && document.querySelector("textarea[name=content]").value === "" && [...document.querySelectorAll('[data-kind=user]')].some(node => node.textContent.includes(${JSON.stringify(queueText)}))`)
    const queued = await browser.webContents.executeJavaScript('window.__journey.inspect()')
    assert.equal(queued.ledger.sends[0].mode, 'queue')
    assert.ok(queued.ledger.durableEvents.some(event => event.kind === 'user' && event.text === queueText))
    assert.ok(queued.persistedDurableEvents.some(event => event.kind === 'user' && event.text === queueText))
    assert.ok(queued.timelineItems.some(event => event.kind === 'user' && event.text === queueText))
    assert.ok(queued.renderedUserTexts.some(text => text.includes(queueText)))

    await browser.webContents.executeJavaScript('window.__journey.setRunning(true)')
    await waitFor(browser, 'document.querySelector("button.send:not(.steer)") !== null && document.querySelector("button.stop-generation") !== null')
    await browser.webContents.executeJavaScript('window.__journey.setBareRun(true)')
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".task-summary-head>span").textContent'), '正在执行')
    assert.doesNotMatch(await browser.webContents.executeJavaScript('document.querySelector(".head-runtime").textContent'), /已验证/u)
    await fillComposer(browser, '交互同步期间保留的草稿')
    await browser.webContents.executeJavaScript('window.__journey.setRuntimeState("blocked")')
    await waitFor(browser, 'document.querySelector(".task-summary-head>span")?.textContent === "等待交互信息"')
    assert.doesNotMatch(await browser.webContents.executeJavaScript('document.querySelector(".head-runtime").textContent'), /已验证/u)
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("button.send").disabled'), true)
    assert.equal(await browser.webContents.executeJavaScript('document.querySelector("textarea[name=content]").disabled'), false, 'an unresolved interaction blocks sending, not draft preservation or editing')
    assert.match(await browser.webContents.executeJavaScript('document.querySelector(".interaction-sync-note").textContent'), /刷新.*连接/u)
    await browser.webContents.executeJavaScript('document.querySelector("form.cbox").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))')
    assert.equal((await browser.webContents.executeJavaScript('window.__journey.inspect()')).ledger.sends.length, 1, 'synthetic submits also fail closed before interaction details arrive')
    for (const kind of ['question', 'approval']) {
      // Pending interactions must survive a different selected workbench view.
      await openWorkbench(browser, kind === 'question' ? 'materials' : 'browser')
      await browser.webContents.executeJavaScript(`window.__journey.setInteraction(${JSON.stringify(kind)})`)
      await waitFor(browser, `document.querySelector('.task-summary-head>span')?.textContent === ${JSON.stringify(kind === 'question' ? '需要回答' : '需要确认')}`)
      assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".interaction-sync-note") === null'), true)
      await openWorkbench(browser, 'task')
      await click(browser, `[data-task-interaction="${kind}"]`)
      const cardSelector = kind === 'question' ? '.question-card' : '.approval'
      await waitFor(browser, `document.querySelector(${JSON.stringify(cardSelector)})?.contains(document.activeElement) === true`)
      assert.equal(await browser.webContents.executeJavaScript('document.querySelector("#xsla-insp").classList.contains("mobile-open")'), false)
      assert.equal(await browser.webContents.executeJavaScript('document.querySelector("textarea[name=content]").disabled'), true)
      await browser.webContents.executeJavaScript('window.__journey.setInteraction()')
      await waitFor(browser, 'document.querySelector(".task-summary-head>span")?.textContent === "等待交互信息"')
    }
    await browser.webContents.executeJavaScript('window.__journey.setRunning(true)')
    await waitFor(browser, 'document.querySelector("button.send").disabled === false && document.querySelector(".interaction-sync-note") === null')
    assert.equal((await browser.webContents.executeJavaScript('window.__journey.inspect()')).composerValue, '交互同步期间保留的草稿')
    await browser.webContents.executeJavaScript('window.__journey.setBareRun(false)')
    const steerText = `steer-${width}x${height}`
    await fillComposer(browser, steerText)
    await browser.webContents.executeJavaScript('[...document.querySelectorAll(".send-mode-control button")].find(button => button.textContent === "立即调整").click()')
    await click(browser, 'button.send.steer')
    await waitFor(browser, `window.__journey.state.ledger.sends.length === 2 && document.querySelector("textarea[name=content]").value === "" && [...document.querySelectorAll('[data-kind=user]')].some(node => node.textContent.includes(${JSON.stringify(steerText)}))`)
    const steered = await browser.webContents.executeJavaScript('window.__journey.inspect()')
    assert.equal(steered.ledger.sends[1].mode, 'steer')
    assert.ok(steered.ledger.durableEvents.some(event => event.kind === 'user' && event.text === steerText))
    assert.ok(steered.persistedDurableEvents.some(event => event.kind === 'user' && event.text === steerText))
    assert.ok(steered.renderedUserTexts.some(text => text.includes(steerText)))

    // The durable event can arrive before the send promise releases the
    // composer's pending flag; wait for the actual enabled control, not time.
    await waitFor(browser, 'document.querySelector("button.stop-generation")?.disabled === false')
    await click(browser, 'button.stop-generation')
    await waitFor(browser, 'document.querySelector(".task-summary-head>span")?.textContent === "正在停止"')
    await browser.webContents.executeJavaScript('window.__journey.finishStop()')
    await waitFor(browser, 'window.__journey.state.ledger.stopRunCalls.length === 1 && window.__journey.state.ledger.cancelCalls.length === 1')
    const stopped = await browser.webContents.executeJavaScript('window.__journey.inspect()')
    assert.equal(stopped.runtimeState, 'idle')

    await browser.webContents.executeJavaScript('window.__journey.setNextSendOutcome("failure")')
    const failedDraftText = `failed-draft-${width}x${height}`
    await browser.webContents.executeJavaScript(`window.__journey.seedDraftDecoy(${JSON.stringify(failedDraftText)})`)
    await fillComposer(browser, failedDraftText)
    await click(browser, 'button.send')
    await waitFor(browser, 'window.__journey.state.ledger.sends.length === 3 && document.querySelector("[role=alert]") !== null')
    const failed = await browser.webContents.executeJavaScript(`window.__journey.inspect(${JSON.stringify(failedDraftText)})`)
    assert.equal(failed.composerValue, failedDraftText)
    assert.equal(failed.exactStorageContainsDraft, true)
    assert.match(failed.alertText, /明确失败/u)
    await remountAndWaitForDraft(browser, failedDraftText)
    const failedHydrated = await browser.webContents.executeJavaScript(`window.__journey.inspect(${JSON.stringify(failedDraftText)})`)
    assert.equal(failedHydrated.composerValue, failedDraftText)
    assert.equal(failedHydrated.exactStorageContainsDraft, true)

    await browser.webContents.executeJavaScript('window.__journey.setNextSendOutcome("ambiguous")')
    const draftText = `preserve-draft-${width}x${height}`
    await browser.webContents.executeJavaScript(`window.__journey.seedDraftDecoy(${JSON.stringify(draftText)})`)
    await fillComposer(browser, draftText)
    await click(browser, 'button.send')
    await waitFor(browser, 'window.__journey.state.ledger.sends.length === 4 && document.querySelector("[role=alert]") !== null')
    const ambiguous = await browser.webContents.executeJavaScript(`window.__journey.inspect(${JSON.stringify(draftText)})`)
    assert.equal(ambiguous.composerValue, draftText)
    assert.equal(ambiguous.exactStorageContainsDraft, true)
    assert.match(ambiguous.alertText, /发送结果不明确|传输结果不明确/u)
    assert.doesNotMatch(ambiguous.alertText, /图片编码失败/u)
    await remountAndWaitForDraft(browser, draftText)
    const ambiguousHydrated = await browser.webContents.executeJavaScript(`window.__journey.inspect(${JSON.stringify(draftText)})`)
    assert.equal(ambiguousHydrated.composerValue, draftText)
    assert.equal(ambiguousHydrated.exactStorageContainsDraft, true)

    await openWorkbench(browser, 'materials')
    await click(browser, '[data-run-deliverable-id="surface-1"]')
    // The fused task view has no stale duplicate material card. Exercise the
    // equivalent registry invalidation after a real selection instead.
    await browser.webContents.executeJavaScript('window.__journey.setEmptyTask(true)')
    await waitFor(browser, 'document.querySelector("#xsla-panel-materials .surface-content") === null')
    const staleDeliverable = await browser.webContents.executeJavaScript(`({
      materialCount: document.querySelectorAll('#xsla-panel-materials [data-run-deliverable-id]').length,
      wrongSurfaceVisible: document.querySelector('.surface-summary b')?.textContent === '验收报告',
    })`)
    assert.equal(staleDeliverable.materialCount, 0)
    assert.equal(staleDeliverable.wrongSurfaceVisible, false)
    await closeWorkbench(browser)
    await browser.webContents.executeJavaScript('window.__journey.setEmptyTask(false)')

    const layout = await browser.webContents.executeJavaScript('window.__journey.layout()')
    assert.equal(layout.clientWidth, width)
    assert.equal(layout.clientHeight, height)
    assert.equal(layout.composerVisible, true)
    assert.equal(layout.primaryActionVisible, true)
    assert.equal(layout.horizontalOverflow, false)
    const final = await browser.webContents.executeJavaScript('window.__journey.inspect()')
    assert.deepEqual(final.rendererErrors, [])
    assert.deepEqual(consoleErrors, [])
    assert.deepEqual(final.ledger.paidModelRequests, [])
    assert.deepEqual(blockedRequests, [])
    for (const theme of ['light', 'ink-jade']) {
      if (theme === 'ink-jade') await click(browser, '.theme-toggle')
      await openWorkbench(browser, 'task')
      screenshots.push(await captureScene(browser, width, height, `workbench-${theme}`))
      await closeWorkbench(browser)
    }
    let actualMaterials
    if (materialEvidence) {
      // Reveal genuine tool records in stages: passive hydration, an arrival
      // while reading, then another arrival after an explicit close.
      const publishMaterials = async count => {
        const items = materialEvidence.surfaces.items.slice(0, count)
        const evidence = { ...materialEvidence, surfaces: { ...materialEvidence.surfaces, items },
          runCenter: { ...materialEvidence.runCenter, deliverables: materialEvidence.runCenter.deliverables.filter(row => items.some(item => item.id === row.id)) } }
        await browser.webContents.executeJavaScript(`window.__journey.setActualMaterials(${JSON.stringify(evidence)})`)
        await waitFor(browser, `window.__journey.state.snapshots.surfaces.items.length === ${count}`)
      }
      await publishMaterials(1)
      // The single shared launcher must remain a real hit target; hidden old
      // launchers must not silently remain in the header's accessibility tree.
      const assertHeaderLaunchers = async () => {
        const result = await browser.webContents.executeJavaScript(`(() => {
          const buttons = [...document.querySelectorAll('.chat-head [data-workbench-launcher]')]
          const rects = buttons.map(button => button.getBoundingClientRect())
          const head = document.querySelector('.chat-head').getBoundingClientRect()
          return {
            count: buttons.length,
            controls: buttons[0]?.getAttribute('aria-controls'),
            legacyLaunchers: document.querySelectorAll('.inspector-mobile-toggle,.chat-head [aria-controls="xsla-browser-dock"],.chat-head [aria-controls="xsla-work-surface-dock"]').length,
            contained: rects.every(r => r.left >= head.left && r.right <= Math.min(head.right, innerWidth) && r.top >= head.top && r.bottom <= head.bottom),
            reachable: buttons.every((button, i) => button.contains(document.elementFromPoint(rects[i].x + rects[i].width / 2, rects[i].y + rects[i].height / 2))),
          }
        })()`)
        assert.deepEqual(result, { count: 1, controls: 'xsla-insp', legacyLaunchers: 0, contained: true, reachable: true }, `header launcher at ${width}px`)
      }
      await assertHeaderLaunchers()
      assert.equal(await browser.webContents.executeJavaScript('document.querySelector("#xsla-insp").hidden'), true, 'passive history must not open the workbench')
      const passiveLayout = await browser.webContents.executeJavaScript('window.__journey.layout()')
      assert.equal(passiveLayout.composerVisible, true)
      assert.equal(passiveLayout.primaryActionVisible, true)
      const closedComposerSize = await browser.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.cbox').getBoundingClientRect(); return { width: rect.width, height: rect.height } })()`)
      await openWorkbench(browser, 'materials')
      const first = materialEvidence.surfaces.items[0]
      await click(browser, `[data-run-deliverable-id="${first.id}"]`)
      await waitFor(browser, 'document.querySelector("#xsla-work-surface-dock") !== null')
      await assertMaterialControlsReachable(browser, width > 900)
      if (width > 900) {
        await setExactViewport(browser, width === 1280 ? 1440 : 1280, 720)
        await assertMaterialControlsReachable(browser, true)
        await setExactViewport(browser, width, height)
        await assertMaterialControlsReachable(browser, true)
      }
      await publishMaterials(2)
      assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".surface-summary b")?.textContent'), first.title, 'a later diff must not replace the explicitly selected read')
      const second = materialEvidence.surfaces.items[1]
      const hideMaterial = async item => {
        await click(browser, `.surface-tab-wrap:has([data-run-deliverable-id="${item.id}"]) .surface-tab-close`)
        await waitFor(browser, `document.querySelector(${JSON.stringify(`[data-run-deliverable-id="${item.id}"]`)}) === null`)
      }
      const materialRegistryBeforeHide = await browser.webContents.executeJavaScript('JSON.stringify(window.__journey.state.snapshots.surfaces)')
      await hideMaterial(second)
      assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".surface-summary b")?.textContent'), first.title)
      await click(browser, '.surface-actions [data-restore-materials]')
      await waitFor(browser, 'document.querySelectorAll("#xsla-panel-materials [data-run-deliverable-id]").length === 2')
      assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".surface-summary b")?.textContent'), first.title, 'restoring a hidden sibling does not replace the selected material')
      await hideMaterial(second)
      await hideMaterial(first)
      await waitFor(browser, 'document.querySelector(".workbench-empty [data-restore-materials]") !== null')
      await click(browser, '.workbench-empty [data-restore-materials]')
      await waitFor(browser, 'document.querySelectorAll("#xsla-panel-materials [data-run-deliverable-id]").length === 2')
      assert.equal(await browser.webContents.executeJavaScript('JSON.stringify(window.__journey.state.snapshots.surfaces)'), materialRegistryBeforeHide, 'hide/restore changes presentation only, not the authoritative tool material records')
      await click(browser, `[data-run-deliverable-id="${first.id}"]`)
      assert.equal(await browser.webContents.executeJavaScript('document.querySelectorAll("#xsla-panel-status [data-run-deliverable-id]").length'), 0, 'material arrivals never recreate a second task list')
      assert.equal(await browser.webContents.executeJavaScript('document.querySelectorAll("#xsla-panel-materials [data-run-deliverable-id]").length'), 2)
      await closeWorkbench(browser)
      assert.equal(await browser.webContents.executeJavaScript(`(() => {
        const send = document.querySelector('button.send'), rect = send.getBoundingClientRect()
        return send.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
      })()`), true, 'closing a mobile overlay must restore the actual send hit target')
      assert.deepEqual(await browser.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.cbox').getBoundingClientRect(); return { width: rect.width, height: rect.height } })()`), closedComposerSize, 'closing the dock must restore the existing composer layout')
      await browser.webContents.executeJavaScript(`window.__journey.setActualMaterials(${JSON.stringify(materialEvidence)})`)
      await waitFor(browser, `window.__journey.state.snapshots.surfaces.items.length === ${materialEvidence.surfaces.items.length}`)
      assert.equal(await browser.webContents.executeJavaScript('document.querySelector("#xsla-insp").hidden'), true, 'next passive result must respect explicit close')
      if (width === 1280) screenshots.push(await captureScene(browser, width, height, 'materials-passive-ink-jade'))
      const openedKinds = []
      for (const item of materialEvidence.surfaces.items) {
        await openWorkbench(browser, 'materials')
        await waitFor(browser, `document.querySelector(${JSON.stringify(`[data-run-deliverable-id="${item.id}"]`)}) !== null`)
        await click(browser, `[data-run-deliverable-id="${item.id}"]`)
        await waitFor(browser, 'document.querySelector("#xsla-work-surface-dock") !== null')
        if (item.view.kind === 'text' || item.view.kind === 'diff') {
          const titles = await browser.webContents.executeJavaScript(`({
            card: document.querySelector(${JSON.stringify(`[data-run-deliverable-id="${item.id}"]`)}).title,
            tab: document.querySelector('.surface-tab-wrap.on .surface-tab').title,
            visible: document.querySelector('.surface-tab-wrap.on .surface-tab-title').textContent,
          })`)
          assert.ok(titles.visible.startsWith(item.source.split(/[\\/]/u).at(-1)))
          assert.ok(titles.card.includes(item.source))
          assert.ok(titles.tab.includes(item.source))
          if (item.view.kind === 'text') {
            assert.match(titles.card, /第 1 行/u)
            assert.match(titles.tab, /第 1 行/u)
            if (width === 1280) screenshots.push(await captureScene(browser, width, height, 'materials-read-ink-jade'))
          }
        }
        const body = await browser.webContents.executeJavaScript('document.querySelector("#xsla-work-surface-dock").textContent')
        assert.match(body, item.view.kind === 'text' ? /journey-before/u : item.view.kind === 'diff' ? /journey-after/u : /journey-terminal-ok/u)
        openedKinds.push(item.view.kind)
        assert.equal(await browser.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(`[data-run-deliverable-id="${item.id}"]`)}).length`), 1, 'each material is rendered once, not again in task status')
        await closeWorkbench(browser)
      }
      actualMaterials = { source: materialEvidence.evidence.source, genericChatNodes: materialEvidence.evidence.genericChatNodes, openedKinds, passiveArrivalClosed: true, selectionPreserved: true, hiddenRecordsRecovered: true, emptyStateRecovered: true, registryUnchanged: true, closedArrivalStayedClosed: true, fileTooltipsPreserved: true, controls: { closeReachable: true, composerAfterClose: true, composerContained: true, controlGroupsSeparated: true, closedLayoutRestored: true, desktopFitChecked: width > 900, resizeFitChecked: width > 900 } }
    }
    await browser.webContents.executeJavaScript('window.__journey.release()')

    return {
      width,
      height,
      screenshots,
      unifiedWorkbench,
      ...(actualMaterials === undefined ? {} : { actualMaterials }),
      taskInteraction: { questionFocus: true, approvalFocus: true, stoppingObserved: true, oldReceiptSuppressed: true },
      settingsManagement: { draftPreserved: true, projectIsolated: true, forgottenRestored: true, nestedEscape: true, keyboardContained: true },
      versionDiagnostics: { currentObserved: true, staleAlert: true, legacy404Unknown: true, incomplete200Unknown: true, retryReachable: true },
      independentReset: initial.ledger.sends.length === 0 && initial.ledger.durableEvents.length === 0 && initial.persistedDurableEvents.length === 0,
      root: { moduleId: initial.loadedModuleId, registrationId: initial.registeredRootId },
      queue: { mode: queued.ledger.sends[0].mode, durableUserEvent: queued.persistedDurableEvents.some(event => event.kind === 'user' && event.text === queueText), text: queueText },
      steer: { mode: steered.ledger.sends[1].mode, durableUserEvent: steered.persistedDurableEvents.some(event => event.kind === 'user' && event.text === steerText), text: steerText },
      stop: { stopRunCalls: stopped.ledger.stopRunCalls.length, cancelCalls: stopped.ledger.cancelCalls.length },
      failedSend: {
        draftPreserved: failed.composerValue === failedDraftText,
        exactStoragePreserved: failed.exactStorageContainsDraft,
        hydratedAfterRemount: failedHydrated.composerValue === failedDraftText,
      },
      ambiguousSend: {
        draftPreserved: ambiguous.composerValue === draftText,
        exactStoragePreserved: ambiguous.exactStorageContainsDraft,
        hydratedAfterRemount: ambiguousHydrated.composerValue === draftText,
        correctFailureSemantics: !ambiguous.alertText.includes('图片编码失败'),
      },
      modelControl: {
        ...modelControlOpen,
        selectedModel: modelControlSelected.selectedModel,
        selectedEffort: modelControlSelected.selectedEffort,
        triggerText: modelControlSelected.triggerText,
        selectionCount: modelControlSelected.selectionCount,
        readiness: {
          matchingRouteSelectable: matchingRoute.disabled === false && matchingRoute.statusText === '已验证',
          staleRouteIgnored: staleRoute.disabled === false && staleRoute.statusText === '状态未确认',
          unavailableRouteBlocked: unavailableSelections.before === unavailableSelections.after,
        },
        runningLock,
      },
      taskWorkbench: {
        ...taskWorkbench,
        openedSurface,
        staleDeliverable,
      },
      paidModelRequests: blockedRequests.length,
      networkGuard: { installed: true, blockedRequests },
      consoleErrors,
      layout,
    }
  } catch (error) {
    // Keep the actual failed viewport, not just a parent assertion after its
    // private fixture has been removed. Screenshot capture cannot mask failure.
    try { await captureScene(browser, width, height, 'failure') } catch {}
    throw error
  } finally {
    if (browser.webContents.debugger.isAttached()) browser.webContents.debugger.detach()
    if (!browser.isDestroyed()) browser.destroy()
  }
}

async function openWorkbench(browser, view) {
  if (await browser.webContents.executeJavaScript('document.querySelector("#xsla-insp").hidden')) await click(browser, '[data-workbench-launcher]')
  await click(browser, `[data-workbench-view="${view}"]`)
  await waitFor(browser, `document.querySelector('[data-workbench-view="${view}"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('#xsla-insp')?.hidden === false`)
  await settleLayout(browser)
}

async function closeWorkbench(browser) {
  if (!await browser.webContents.executeJavaScript('document.querySelector("#xsla-insp").hidden')) await click(browser, '#xsla-insp [aria-label="收起工作台"]')
  await waitFor(browser, 'document.querySelector("#xsla-insp")?.hidden === true && document.querySelector(".overlay-scrim") === null')
  await settleLayout(browser)
}

async function settleLayout(browser) {
  await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await browser.webContents.executeJavaScript(`Promise.all(document.querySelector('.main').getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`)
  await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

async function assertUnifiedWorkbench(browser, width, height, screenshots) {
  await openWorkbench(browser, 'task')
  await browser.webContents.executeJavaScript('window.__browser.passiveTab()')
  await waitFor(browser, 'window.__browser.inspect().state.tabs.length === 1')
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-workbench-view=task]").getAttribute("aria-selected")'), 'true', 'passive native state must not steal the selected workbench view')
  await openWorkbench(browser, 'browser')
  await waitFor(browser, 'document.querySelector(".browser-control")?.dataset.browserMode === "agent"')
  await waitFor(browser, 'window.__browserBounds.at(-1)?.width > 0 && window.__browserBounds.at(-1)?.height > 0')
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector("#xsla-insp").contains(document.querySelector("#xsla-browser-dock"))'), true)
  assert.equal(await browser.webContents.executeJavaScript('document.querySelectorAll("#xsla-browser-dock [role=separator]").length'), 0)
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector("#xsla-insp").getAttribute("aria-modal")'), null, 'browser view must not suppress its own guarded bounds through a modal ancestor')
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector(".chat").hasAttribute("inert")'), width <= 900, 'a narrow browser fences background focus without claiming aria-modal')
  if (width <= 900) {
    for (const reverse of [false, true]) {
      await browser.webContents.executeJavaScript(`(() => {
        const targets = [...document.querySelectorAll('#xsla-insp button:not(:disabled),#xsla-insp input:not(:disabled),#xsla-insp [tabindex="0"]')].filter(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')
        targets[${reverse ? '0' : 'targets.length - 1'}].focus()
      })()`)
      await pressKey(browser, 'Tab', reverse ? ['shift'] : [])
      assert.equal(await browser.webContents.executeJavaScript('document.querySelector("#xsla-insp").contains(document.activeElement) && document.activeElement.getClientRects().length > 0'), true, 'Tab and Shift+Tab stay inside the visible nonmodal browser pane')
    }
  }
  await browser.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[aria-label="专用浏览器网址"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://unsent.invalid/kept-draft')
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    window.__retainedBrowserPanel = document.querySelector('#xsla-panel-browser')
    document.querySelector('.browser-control button:nth-child(2)').click()
  })()`)
  await waitFor(browser, 'document.querySelector(".browser-control")?.dataset.browserMode === "user"')
  const before = await browser.webContents.executeJavaScript('window.__browser.inspect()')
  assert.equal(before.requests.filter(row => row.action === 'bind').length, 1)
  assert.deepEqual(before.requests.filter(row => row.action === 'mode').map(row => row.args.mode), ['user'])
  const panels = { task: 'xsla-panel-status', materials: 'xsla-panel-materials', browser: 'xsla-panel-browser' }
  for (const view of ['materials', 'task', 'browser']) {
    await openWorkbench(browser, view)
    const facts = await browser.webContents.executeJavaScript(`(() => {
      const inspector = document.querySelector('#xsla-insp')
      const visiblePanels = [...inspector.querySelectorAll('[role=tabpanel]')].filter(node => !node.hidden)
      return { panelIds: visiblePanels.map(node => node.id), noOverflow: document.documentElement.scrollWidth <= innerWidth,
        oneResizer: document.querySelectorAll('.workbench-resizer').length,
        samePanel: document.querySelector('#xsla-panel-browser') === window.__retainedBrowserPanel,
        taskMaterialCount: document.querySelectorAll('#xsla-panel-status [data-run-deliverable-id],#xsla-panel-status .task-deliverables').length,
        modal: inspector.getAttribute('aria-modal') }
    })()`)
    assert.deepEqual(facts, { panelIds: [panels[view]], noOverflow: true, oneResizer: 1, samePanel: true, taskMaterialCount: 0, modal: width <= 900 && view !== 'browser' ? 'true' : null })
    if (view !== 'browser') await waitFor(browser, 'window.__browserBounds.at(-1) === null')
    else await waitFor(browser, 'window.__browserBounds.at(-1)?.width > 0')
  }
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[aria-label=专用浏览器网址]").value'), 'https://unsent.invalid/kept-draft', 'same React BrowserDock retains its unsent local input across view changes')
  await click(browser, '[data-workbench-view=browser]')
  await pressKey(browser, 'Home')
  await waitFor(browser, 'document.activeElement?.dataset.workbenchView === "task" && document.querySelector("[data-workbench-view=task]").getAttribute("aria-selected") === "true"')
  await pressKey(browser, 'End')
  await waitFor(browser, 'document.activeElement?.dataset.workbenchView === "browser" && document.querySelector("[data-workbench-view=browser]").getAttribute("aria-selected") === "true"')
  await closeWorkbench(browser)
  await click(browser, '[data-workbench-launcher]')
  await waitFor(browser, 'document.querySelector(".browser-control")?.dataset.browserMode === "user"')
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[data-workbench-view=browser]").getAttribute("aria-selected")'), 'true', 'common close/reopen preserves the selected view')
  assert.equal(await browser.webContents.executeJavaScript('document.querySelector("[aria-label=专用浏览器网址]").value'), 'https://unsent.invalid/kept-draft')
  const after = await browser.webContents.executeJavaScript('window.__browser.inspect()')
  assert.deepEqual(after.requests.filter(row => ['bind', 'mode'].includes(row.action)), before.requests.filter(row => ['bind', 'mode'].includes(row.action)), 'view changes cannot bind an owner or change takeover mode')
  assert.deepEqual([after.subscriptions, after.unsubscriptions, after.activeSubscriptions], [before.subscriptions, before.unsubscriptions, 1], 'real React owner effect stays mounted once')
  screenshots.push(await captureScene(browser, width, height, 'unified-browser-takeover'))
  await browser.webContents.executeJavaScript('window.__journey.setRuntimeState("blocked"); window.__journey.setInteraction("approval")')
  await waitFor(browser, 'document.querySelector("[data-workbench-notice=interaction]") !== null')
  await click(browser, '[data-workbench-notice=interaction]')
  await waitFor(browser, 'document.querySelector(".approval")?.contains(document.activeElement) === true')
  assert.equal(await browser.webContents.executeJavaScript('window.__browser.inspect().state.mode'), 'user', 'approval focus must not relinquish browser takeover')
  assert.deepEqual(await browser.webContents.executeJavaScript('window.__browser.inspect().requests.filter(row => ["bind", "mode"].includes(row.action))'), before.requests.filter(row => ['bind', 'mode'].includes(row.action)), 'cross-view approval focus cannot rebind or change native mode')
  await browser.webContents.executeJavaScript('window.__journey.setInteraction(); window.__journey.setRuntimeState("idle")')
  await openWorkbench(browser, 'browser')
  await click(browser, '.browser-primary')
  await waitFor(browser, 'document.querySelector(".browser-control")?.dataset.browserMode === "agent"')
  const resizedModes = []
  if (width > 900) for (const view of ['task', 'materials', 'browser']) {
    await openWorkbench(browser, view)
    await assertWorkbenchResize(browser, view)
    resizedModes.push(view)
  }
  await openWorkbench(browser, 'materials')
  screenshots.push(await captureScene(browser, width, height, 'unified-materials'))
  await closeWorkbench(browser)
  return { singleLauncher: true, panelsExclusive: true, taskMaterialsAbsent: true, browserComponentStable: true,
    takeoverAcrossViews: true, approvalAcrossViewsFocused: true, selectedViewRetained: true,
    narrowBrowserNonModal: width <= 900, narrowBrowserFocusContained: width <= 900, keyboardViewNavigation: true, noHorizontalOverflow: true, resizedModes }
}

async function assertWorkbenchResize(browser, view) {
  await settleLayout(browser)
  // All three modes use the same real separator at the workbench boundary;
  // their pre-existing width preferences intentionally remain independent.
  await waitFor(browser, `(() => {
    const rect = document.querySelector('#xsla-insp').getBoundingClientRect()
    return Math.abs(rect.width - Number(document.querySelector('.workbench-resizer').getAttribute('aria-valuenow'))) < 1
  })()`)
  const geometry = () => browser.webContents.executeJavaScript(`(() => {
    const dock = document.querySelector('#xsla-insp').getBoundingClientRect()
    const handle = document.querySelector('[aria-label="调整工作台宽度"]')
    const rect = handle?.getBoundingClientRect()
    return { width: dock.width, x: rect ? Math.round(rect.x + rect.width / 2) : null,
      y: rect ? Math.round(rect.y + 120) : null,
      reachable: !!handle && handle.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 120)) }
  })()`)
  const initial = await geometry()
  assert.equal(initial.reachable, true, `${view} divider must be a real pointer target`)
  if (view === 'browser') {
    const expected = await browser.webContents.executeJavaScript(`(() => {
      const available = document.querySelector('.main').getBoundingClientRect().width - document.querySelector('.side').getBoundingClientRect().width
      return Math.round(Math.max(320, Math.min(available * .55, 680, Math.max(320, Math.floor(available - 374)))))
    })()`)
    assert.equal(initial.width, expected, 'browser width uses the entire main area less the sidebar, not an already-shrunk chat column')
  }
  const storage = () => browser.webContents.executeJavaScript(`({ task: localStorage.getItem('xsla-panel-widths-v1'), materials: localStorage.getItem('xsla-work-surface-dock-v1'), browser: localStorage.getItem('xsla-browser-width-v1') })`)
  const storageBefore = await storage()
  const drag = async delta => {
    const before = await geometry()
    browser.webContents.sendInputEvent({ type: 'mouseMove', x: before.x, y: before.y })
    browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: before.x, y: before.y })
    await waitFor(browser, 'document.querySelector(".chat").dataset.surfaceResizing === "true"')
    await waitFor(browser, 'window.__browserBounds.at(-1) === null')
    browser.webContents.sendInputEvent({ type: 'mouseMove', x: before.x + delta, y: before.y })
    await waitFor(browser, `Math.abs(document.querySelector('#xsla-insp').getBoundingClientRect().width - ${before.width}) > 20`)
    browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: before.x + delta, y: before.y })
    await waitFor(browser, 'document.querySelector(".chat").dataset.surfaceResizing === "false"')
    if (view === 'browser') await waitFor(browser, `(() => {
      const bounds = window.__browserBounds.at(-1)
      const slot = document.querySelector('.browser-page-slot').getBoundingClientRect()
      return bounds && Math.abs(bounds.width - slot.width) < 1 && Math.abs(bounds.x - slot.x) < 1
    })()`)
    return geometry()
  }
  const smaller = await drag(view === 'task' ? 24 : 60)
  assert.ok(smaller.width < initial.width - (view === 'task' ? 20 : 40), `drag right narrows ${view}`)
  const larger = await drag(view === 'task' ? -32 : -40)
  assert.ok(larger.width > smaller.width + 25, `drag left widens ${view}`)
  const storageAfter = await storage()
  for (const other of ['task', 'materials', 'browser'].filter(mode => mode !== view)) assert.equal(storageAfter[other], storageBefore[other], `${view} resizing must not overwrite ${other} preference`)
  assert.notEqual(storageAfter[view], storageBefore[view])
  await closeWorkbench(browser)
  await openWorkbench(browser, view)
  assert.equal((await geometry()).width, larger.width, `reopening retains ${view} width`)
  if (view === 'browser') {
    // A full root remount is explicit here, separate from the earlier assertion
    // that switching tabs never unmounts BrowserDock's owner effect.
    await browser.webContents.executeJavaScript('window.__journey.release(); window.__journey.mount()')
    await waitFor(browser, 'document.querySelector("[data-workbench-launcher]") !== null')
    await openWorkbench(browser, view)
    assert.equal((await geometry()).width, larger.width, 'browser width survives a real React root remount')
  }
  const position = await geometry()
  browser.webContents.sendInputEvent({ type: 'mouseMove', x: position.x, y: position.y })
  browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: position.x, y: position.y })
  browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: position.x, y: position.y })
  browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 2, x: position.x, y: position.y })
  browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 2, x: position.x, y: position.y })
  if (view === 'browser') await waitFor(browser, 'localStorage.getItem("xsla-browser-width-v1") === null')
  await waitFor(browser, `Math.abs(document.querySelector('#xsla-insp').getBoundingClientRect().width - ${initial.width}) < 1`)
}

function networkRequestLabel(rawUrl) {
  try {
    const url = new URL(rawUrl)
    return `${url.origin}${url.pathname}`
  } catch {
    return '<invalid-network-url>'
  }
}

async function fillComposer(browser, value) {
  await browser.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('textarea[name=content]')
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('composer textarea is unavailable')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(textarea, ${JSON.stringify(value)})
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }))
  })()`)
  await waitFor(browser, `document.querySelector('textarea[name=content]').value === ${JSON.stringify(value)}`)
}

async function fillTextarea(browser, selector, value) {
  await browser.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(value)})
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  })()`)
  await waitFor(browser, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
}

async function assertMaterialControlsReachable(browser, desktop) {
  await settleLayout(browser)
  const controls = await browser.webContents.executeJavaScript(`(() => {
    const close = document.querySelector('#xsla-insp [aria-label="收起工作台"]'), closeRect = close.getBoundingClientRect()
    const send = document.querySelector('button.send'), sendRect = send.getBoundingClientRect()
    const input = document.querySelector('.composer textarea'), inputRect = input.getBoundingClientRect()
    const dockRect = document.querySelector('#xsla-insp').getBoundingClientRect()
    const boxRect = document.querySelector('.cbox').getBoundingClientRect()
    const permissionRect = document.querySelector('.permission-select-wrap').getBoundingClientRect()
    const modelRect = document.querySelector('.model-reasoning-trigger').getBoundingClientRect()
    return {
      closeReachable: close.contains(document.elementFromPoint(closeRect.x + closeRect.width / 2, closeRect.y + closeRect.height / 2)),
      closeRect: { x: closeRect.x, y: closeRect.y, width: closeRect.width, height: closeRect.height },
      closeHit: document.elementFromPoint(closeRect.x + closeRect.width / 2, closeRect.y + closeRect.height / 2)?.outerHTML.slice(0, 600),
      sendReachable: send.contains(document.elementFromPoint(sendRect.right - 3, sendRect.y + sendRect.height / 2)),
      sendHit: document.elementFromPoint(sendRect.right - 3, sendRect.y + sendRect.height / 2)?.className,
      sendRight: sendRect.right, inputRight: inputRect.right, dockLeft: dockRect.left,
      boxRight: boxRect.right,
      composerContained: sendRect.left >= boxRect.left && sendRect.right <= boxRect.right && sendRect.top >= boxRect.top && sendRect.bottom <= boxRect.bottom,
      controlGroupsSeparated: permissionRect.right <= modelRect.left || modelRect.right <= permissionRect.left || permissionRect.bottom <= modelRect.top || modelRect.bottom <= permissionRect.top,
    }
  })()`)
  assert.equal(controls.closeReachable, true, `the work material close control must remain reachable: ${JSON.stringify(controls)}`)
  assert.equal(controls.composerContained, true, `send button must stay inside its composer frame: ${JSON.stringify(controls)}`)
  assert.equal(controls.controlGroupsSeparated, true, 'permission and model controls must not overlap')
  if (desktop) {
    assert.ok(controls.sendRight <= controls.dockLeft, `send button must not be hidden by dock: ${JSON.stringify(controls)}`)
    assert.ok(controls.inputRight <= controls.dockLeft, 'the task input must remain outside the dock')
    assert.equal(controls.sendReachable, true, `send button must remain the actual hit target: ${JSON.stringify(controls)}`)
  }
}

async function captureScene(browser, width, height, name) {
  const directory = process.env.XIAOSHE_NATIVE_SHELL_SCREENSHOT_DIR?.trim()
  if (!directory) return { name, captured: false }
  await mkdir(resolve(directory), { recursive: true })
  // Flush new React styles before enumerating transitions, then wait until the
  // compositor has had a frame after finite animations finish. Infinite brand
  // sheen remains untouched.
  await browser.webContents.executeJavaScript(`(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  const diagnostics = await browser.webContents.executeJavaScript(`(() => {
    const result = {}
    for (const selector of ['.xsla-shell', '.cbox', '.stage-starters button', '.task-workbench', '[data-xs-settings-panel]', '[data-xs-settings-mask]', '.memory-modal']) {
      const element = document.querySelector(selector)
      if (!element) continue
      const style = getComputedStyle(element), rect = element.getBoundingClientRect()
      result[selector] = { background: style.backgroundColor, backgroundImage: style.backgroundImage, color: style.color, opacity: style.opacity, zIndex: style.zIndex, surface: style.getPropertyValue('--surface'), cta: style.getPropertyValue('--cta'), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
    }
    return result
  })()`)
  const path = resolve(directory, `${width}x${height}-${name}.png`)
  // CDP forces a fresh renderer surface for a hidden window. capturePage can
  // retain the pre-transition paint for independently composited controls.
  const capture = await browser.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  const screenshot = nativeImage.createFromBuffer(Buffer.from(capture.data, 'base64'))
  if (name === 'empty-ink-jade') {
    const rect = diagnostics['.stage-starters button'].rect, scale = screenshot.getSize().width / width
    const pixel = screenshot.crop({ x: Math.round((rect.x + rect.width / 2) * scale), y: Math.round((rect.y + 6) * scale), width: 1, height: 1 }).toBitmap()
    assert.ok(Math.max(pixel[0], pixel[1], pixel[2]) < 80, 'dark starter screenshot must match its computed dark background, not a stale light compositor frame')
  }
  await writeFile(path, screenshot.toPNG())
  return { name, captured: true, path, diagnostics }
}

async function click(browser, selector) {
  assert.equal(await browser.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    return target instanceof HTMLButtonElement && !target.disabled
  })()`), true, `click target is unavailable: ${selector}`)
  await browser.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)})
    if (!(target instanceof HTMLButtonElement) || target.disabled) throw new Error('click target is unavailable: ' + ${JSON.stringify(selector)})
    target.focus()
    target.click()
  })()`)
}

async function pressKey(browser, keyCode, modifiers = []) {
  browser.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  browser.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

async function remountAndWaitForDraft(browser, expectedDraft) {
  await browser.webContents.executeJavaScript('window.__journey.release(); window.__journey.mount()')
  await waitFor(browser, `document.querySelector('textarea[name=content]')?.value === ${JSON.stringify(expectedDraft)}`)
}

async function waitFor(browser, expression, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await browser.webContents.executeJavaScript(`Boolean(${expression})`)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  throw new Error(`Timed out waiting for renderer condition: ${expression}`)
}

async function setExactViewport(browser, width, height) {
  if (!browser.webContents.debugger.isAttached()) browser.webContents.debugger.attach('1.3')
  await browser.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  })
  await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  const actual = await browser.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })')
  if (actual.width !== width || actual.height !== height) {
    throw new Error(`Could not calibrate Chromium viewport to ${width}x${height}; got ${actual.width}x${actual.height}`)
  }
}

function rendererBootstrap({ reactPath, reactDomClientPath, jsxRuntimePath, settingsCode, settingsCss, settingsIconsCode }) {
  return `(() => {
    const React = require(${JSON.stringify(reactPath)})
    const ReactDOM = require(${JSON.stringify(reactDomClientPath)})
    const markdownStyle = document.createElement('style'); markdownStyle.textContent = ${JSON.stringify(markdownBundle.css)}; document.head.append(markdownStyle)
    const markdownModule = { exports: {} }
    new Function('require', 'module', 'exports', ${JSON.stringify(markdownBundle.code)})(name => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return require(${JSON.stringify(jsxRuntimePath)})
      throw new Error('unprovided Markdown dependency: ' + name)
    }, markdownModule, markdownModule.exports)
    const originalFetch = window.fetch.bind(window)
    window.__versionFixtureMode = 'current'
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      if (!url.pathname.endsWith('/xiaoshe/desktop/version')) return originalFetch(input, options)
      if (window.__versionFixtureMode === 'legacy') return new Response('{}', { status: 404 })
      if (window.__versionFixtureMode === 'incomplete') return new Response(JSON.stringify({ version: '99', status: 'current' }))
      const frontend = url.searchParams.get('frontend_identity')
      const stale = window.__versionFixtureMode === 'stale'
      return new Response(JSON.stringify({ schema: 'xiaoshe-runtime-version/v1', status: stale ? 'stale' : 'current', source: 'developer-source',
        candidate: { identity: 'a'.repeat(64) }, backend: { identity: (stale ? 'b' : 'a').repeat(64) },
        frontend: { source_identity: frontend, build_identity: frontend, state: 'current', loaded_state: 'current' } }))
    }
    window.__browserBounds = []
    const browserListeners = new Set()
    const browserRequests = []
    let browserSubscriptions = 0, browserUnsubscriptions = 0
    let browserState = { mode: 'agent', desktop_allowed: false, desktop_until: 0, active_tab: null, notice: '', tabs: [] }
    const emitBrowser = event => { for (const listener of [...browserListeners]) listener(event) }
    window.__browser = {
      inspect: () => ({ requests: structuredClone(browserRequests), subscriptions: browserSubscriptions,
        unsubscriptions: browserUnsubscriptions, activeSubscriptions: browserListeners.size, state: structuredClone(browserState) }),
      passiveTab() {
        browserState = { ...browserState, active_tab: 'fixture-tab', tabs: [{ tab_id: 'fixture-tab', url: 'about:blank', title: '隔离夹具页', loading: false, error: '', busy: false }] }
        emitBrowser('state')
      },
      reveal: () => emitBrowser('reveal'),
    }
    window.xiaosheDesktop = { browser: {
      request: async (owner, action, args = {}) => {
        if (!(window.__browserOwners || ['acceptance-session']).includes(owner)) throw new Error('browser fixture owner mismatch')
        browserRequests.push({ owner, action, args: structuredClone(args) })
        if (action === 'mode' && ['agent', 'user', 'paused'].includes(args.mode)) browserState = { ...browserState, mode: args.mode }
        else if (!['bind', 'status'].includes(action)) throw new Error('unsupported browser fixture action: ' + action)
        return { ok: true, value: structuredClone(browserState) }
      },
      bounds: (owner, bounds) => { if (!(window.__browserOwners || ['acceptance-session']).includes(owner)) throw new Error('browser bounds owner mismatch'); window.__browserBounds.push(bounds || null) },
      subscribe: listener => { browserSubscriptions++; browserListeners.add(listener); return () => { browserUnsubscriptions++; browserListeners.delete(listener) } },
    } }
    const settingsStyle = document.createElement('style'); settingsStyle.textContent = ${JSON.stringify(settingsCss)}; document.head.append(settingsStyle)
    const iconsModule = { exports: {} }
    new Function('require', 'module', 'exports', ${JSON.stringify(settingsIconsCode)})(name => {
      if (name === 'react/jsx-runtime') return require(${JSON.stringify(jsxRuntimePath)})
      throw new Error('unprovided icon dependency: ' + name)
    }, iconsModule, iconsModule.exports)
    const connectionModule = { exports: {} }
    new Function('require', 'module', 'exports', ${JSON.stringify(connectionIndicatorCode)})(name => {
      if (name === 'react/jsx-runtime') return require(${JSON.stringify(jsxRuntimePath)})
      if (name === './icons/index.tsx') return iconsModule.exports
      if (name.endsWith('.module.css')) return { default: {} }
      throw new Error('unprovided connection indicator dependency: ' + name)
    }, connectionModule, connectionModule.exports)
    Object.assign(iconsModule.exports, connectionModule.exports)
    const settingsModule = { exports: {} }
    new Function('require', 'module', 'exports', ${JSON.stringify(settingsCode)})(name => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return require(${JSON.stringify(jsxRuntimePath)})
      if (name === 'clsx') return { default: (...names) => names.filter(Boolean).join(' ') }
      if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_object, name) => 'fixtureSettings_' + String(name) + '_' }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return iconsModule.exports
      throw new Error('unprovided settings dependency: ' + name)
    }, settingsModule, settingsModule.exports)
    const SettingsRoot = settingsModule.exports.SettingsRoot
    const registrations = new Map()
    const sectionRows = [{ id: 'models', label: '模型与服务商', order: 10 }]
    const renderSettingsSlot = (name, props = {}, filter = {}) => {
      const rows = [...registrations.values()].filter(row => row.options.name === name && (!filter.only || row.options.id === filter.only))
      return rows.map(row => React.createElement(row.component, { ...props, key: row.options.id || name }))
    }
    const Settings = props => React.createElement(SettingsRoot, {
      ...props, renderSlot: renderSettingsSlot,
      useSections: select => select(sectionRows), useOnboardingSteps: select => select([]),
      useConnectionState: select => select('connected'), reconnect() {}, t: key => key,
      useSessions: select => select({ phase: 'ready', current: 'acceptance-session', byId: { 'acceptance-session': { blank: false } } }),
    })
    const listeners = new Set()
    const ledger = { sends: [], stopRunCalls: [], cancelCalls: [], durableEvents: [], modelSelections: [], paidModelRequests: [] }
    const sessionId = 'acceptance-session'
    const durableEventKey = 'xiaoshe-acceptance-durable-user-events'
    const composerDraftKey = 'xsla-composer-draft-v1:' + encodeURIComponent(sessionId)
    const draftDecoyKey = 'xiaoshe-acceptance-unrelated-storage'
    localStorage.removeItem(durableEventKey)
    localStorage.setItem('xsla-work-surface-dock-v1', JSON.stringify({
      version: 1,
      sessions: [{ id: sessionId, preference: { open: false, width: 420, pinnedIds: [], dismissedIds: [], knownIds: ['surface-1'], mode: 'watch' } }],
    }))
    let themeSnapshot = { preference: 'light', active: { id: 'light', colorScheme: 'light' }, revision: 1 }
    const providerSnapshot = (owner = sessionId, fastAvailable = true) => ({
      sessionId: owner,
      status: 'ready',
      providers: [{
        id: 'fixture', displayName: 'Fixture Provider', active: true, declared: true,
        routes: [
          { provider: 'fixture', model: 'no-paid-model', name: 'Fixture Logic', facts: { catalogued: true, supported: true, configured: true, available: true, verified: true }, reasons: [] },
          { provider: 'fixture', model: 'no-paid-fast', name: 'Fixture Fast', facts: { catalogued: true, supported: true, configured: fastAvailable, available: fastAvailable, verified: fastAvailable }, reasons: fastAvailable ? [] : ['missing_credential'] },
        ],
      }],
    })
    const snapshots = {
      runtime: { currentSessionId: sessionId, sessions: { [sessionId]: { state: 'idle' } } },
      catalog: { sessions: { [sessionId]: { sessionId, title: '验收会话', cwd: 'C:/synthetic-workspace', updatedAt: 1 } } },
      timeline: { total: 0, hasEarlier: false, items: [] },
      surfaces: { sessionId, items: [{
        id: 'surface-1', sessionId, callId: 'call-surface-1', seq: 30, updatedAt: 30,
        type: 'file', title: '验收报告', source: 'C:/synthetic-workspace/report.md', status: 'ready', trust: 'workspace',
        capabilities: { embedded: true, interactive: false, refresh: false, externalOpen: false, copySource: true, pinnable: true },
        view: { kind: 'text', lines: [{ number: 1, text: '右栏产物链验收通过' }], totalLines: 1, language: 'markdown', truncated: false },
      }] },
      context: { sessions: {} },
      models: {
        sessionId,
        status: 'ready',
        current: { provider: 'fixture', model: 'no-paid-model', reasoningEffort: 'low' },
        routable: true,
        groups: [{
          id: 'fixture',
          name: 'Fixture Provider',
          models: [
            {
              id: 'no-paid-model',
              name: 'Fixture Logic',
              description: '本地验收模型，不会发起网络请求',
              defaultEffort: 'low',
              efforts: [
                { id: 'low', name: '低', description: '快速检查' },
                { id: 'high', name: '高', description: '深入分析' },
                { id: 'max', name: '最大', description: '完整验证' },
              ],
            },
            { id: 'no-paid-fast', name: 'Fixture Fast', description: '本地快速模型', efforts: [] },
          ],
        }],
        failures: [],
      },
      runCenter: {
        sessionId, status: 'ready',
        jobs: [
          ...Array.from({ length: 8 }, (_, index) => ({ id: 'heartbeat-' + index, kind: 'xiaoshe-heartbeat', label: 'Xiaoshe check xiaoshe-product-runtime', status: 'completed', detail: 'check completed', startedAt: index + 1, finishedAt: index + 2, cancellable: false })),
          { id: 'active-job', kind: 'command', label: '运行验收测试', status: 'running', startedAt: 50, cancellable: false },
          { id: 'failed-job', kind: 'command', label: '构建桌面端', status: 'failed', detail: '退出码 1', startedAt: 40, finishedAt: 41, cancellable: false },
        ],
        subagents: [
          { kind: 'child', id: 'active-child', label: '核对产物', activity: 'running', canOpen: true, canInterrupt: true },
          { kind: 'child', id: 'inactive-child', label: '旧子任务', activity: 'inactive', canOpen: true, canInterrupt: false },
        ],
        queue: [{ id: 'queue-1', placement: 'queued', preview: '补充验证深色模式', editable: true, removable: true, steerable: true }],
        todos: [
          { id: 'active-todo', text: '验证窄屏布局', status: 'in_progress' },
          { id: 'done-todo', text: '已经完成的旧待办', status: 'completed' },
        ],
        skills: [],
        deliverables: [
          { id: 'surface-1', title: '验收报告', kind: 'file', status: 'ready' },
          { id: 'surface-missing', title: '已更新的旧产物', kind: 'file', status: 'ready' },
        ],
      },
      providers: providerSnapshot(),
      workspaces: { state: 'ready', items: [{ workspaceId: 'fixture-workspace', path: 'C:/synthetic-workspace', title: '验收项目', sessionIds: [sessionId], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], archivedSessionIds: [] },
      approvals: { sessionId, approvals: [] },
      questions: { sessionId, requests: [] },
      permissions: { sessionId, status: 'ready', currentValue: 'workspace-write', options: [{ value: 'workspace-write', name: '工作区写入', description: '验收夹具' }] },
      plugins: { status: 'ready', transactions: [], pendingRequests: 0 },
      memory: { status: 'ready', memory: { api_version: 1, revision: 0, project: 'C:/synthetic-workspace', counts: { active: 1, global: 0, project: 1, forgotten: 1, superseded: 0 }, entries: [
        { id: 'forgotten-entry', scope: 'global', text: '默认使用中文沟通', state: 'forgotten', version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'old-project', scope: 'project', project: 'C:/synthetic-workspace', text: '旧项目的私有事实', state: 'active', version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      ], audit: [], usage: [] } },
      health: { status: 'ready', value: { heartbeat: { status: 'ready', checks: [] }, desktop: { product: '小蛇', version: 'acceptance', bridge: { state: 'ready', platform: process.platform }, actions: { persistent: true } } } },
    }
    const state = { ledger, snapshots, nextSendOutcome: 'success', rendererErrors: [], loadedModuleId: '', registeredRootId: '', root: null, release: null }
    const notify = () => { for (const listener of [...listeners]) listener() }
    const cancelRun = input => { ledger.cancelCalls.push({ sessionId: input.sessionId, source: 'stopRun' }) }
    const store = key => ({ getSnapshot: () => snapshots[key], subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } })
    const ok = value => ({ ok: true, value })
    const unsupported = async () => ({ ok: false, error: { message: 'acceptance fixture: unsupported path' } })
    const ctx = {
      slots: {
        inject(_name, setup) { return setup() },
        register(options, component) {
          registrations.set(options.name + ':' + (options.id || ''), { options, component })
          if (options.name === 'settings.section') sectionRows.push({ id: options.id, label: options.label, order: options.order || 0 })
          if (options.name === 'root') {
            state.registeredRootId = options.id || ''
            state.root = ReactDOM.createRoot(document.getElementById('root'))
            state.root.render(React.createElement(component, { renderSlot: (name, props) => name === 'sidebar.settings' ? React.createElement(Settings, props) : null }))
          }
          return () => {
            if (options.name === 'root' && state.root !== null) {
              state.root.unmount()
              state.root = null
            }
          }
        },
      },
      theme: { getTheme: () => themeSnapshot, setTheme(value) { themeSnapshot = { preference: value, active: { id: value, colorScheme: value }, revision: themeSnapshot.revision + 1 }; notify() } },
      on(_name, listener) { listeners.add(listener); return () => listeners.delete(listener) },
      agentRuntimeSession: {
        ...store('runtime'),
        async sendTurn(input) {
          ledger.sends.push({ ...input })
          if (state.nextSendOutcome === 'failure') {
            state.nextSendOutcome = 'success'
            return { ok: false, error: { message: '明确失败，草稿必须保留' } }
          }
          if (state.nextSendOutcome === 'ambiguous') {
            state.nextSendOutcome = 'success'
            throw new Error('传输结果不明确，草稿必须保留')
          }
          const event = { key: 'durable-' + (ledger.durableEvents.length + 1), seq: ledger.durableEvents.length + 1, time: Date.now(), kind: 'user', text: input.content }
          // This ledger is the fake SessionPort's authoritative append-only log;
          // its browser-backed commit survives UI rerenders, while the timeline
          // below is only a projection and is never accepted as durability.
          ledger.durableEvents.push(Object.freeze({ ...event, sessionId: input.sessionId }))
          localStorage.setItem(durableEventKey, JSON.stringify(ledger.durableEvents))
          const persistedEvents = JSON.parse(localStorage.getItem(durableEventKey) || '[]')
          snapshots.timeline = { total: persistedEvents.length, hasEarlier: false, items: persistedEvents.map(({ sessionId: _sessionId, ...item }) => ({ ...item })) }
          notify()
          return ok({ accepted: true })
        },
        async stopRun(input) {
          ledger.stopRunCalls.push({ ...input })
          cancelRun(input)
          await new Promise(resolve => { state.finishStop = resolve })
          snapshots.runtime = { currentSessionId: sessionId, sessions: { [sessionId]: { state: 'idle' } } }
          notify()
          return ok({ accepted: true })
        },
        forkSession: unsupported,
      },
      sessionCommand: { execute: unsupported },
      sessionCatalog: { ...store('catalog'), createLooseSession: unsupported, openSession: () => ok({ opened: true }), renameSession: unsupported, archiveSession: unsupported, search: async () => ok({ items: [] }) },
      taskTimeline: { ...store('timeline'), loadEarlier() {} },
      workSurfaceRegistry: store('surfaces'),
      contextGovernance: store('context'),
      modelCatalog: {
        ...store('models'),
        refresh: async () => ok(snapshots.models),
        async select(input) {
          const selected = {
            provider: input.provider,
            model: input.model,
            ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
          }
          ledger.modelSelections.push({ ...input })
          snapshots.models = { ...snapshots.models, status: 'ready', current: selected }
          notify()
          return ok({ selected })
        },
      },
      runCenter: { ...store('runCenter'), refresh: async () => ok(snapshots.runCenter), updateQueue: unsupported, openSubagent: () => ok({ opened: true }), interruptSubagent: unsupported },
      providerReadiness: { ...store('providers'), refresh: async () => ok(snapshots.providers), probe: unsupported, cancelProbe: () => ok({ cancelled: true }) },
      workspaceCatalog: { ...store('workspaces'), addFromNativePicker: unsupported, createAndOpenSession: unsupported, renameWorkspace: unsupported, removeWorkspace: unsupported },
      userApproval: { ...store('approvals'), answer: unsupported },
      userQuestionInteraction: { ...store('questions'), answer: unsupported, cancel: unsupported },
      permissionPresets: { ...store('permissions'), select: unsupported },
      pluginGovernance: { ...store('plugins'), listHostPlugins: async () => ok({ entries: [] }), auditCandidate: unsupported, prepareChange: unsupported, confirmChange: unsupported, refreshTransactions: async () => {} },
      memoryLifecycle: { ...store('memory'), refresh: async () => snapshots.memory.memory, remember: unsupported, async setState(id, entryState, revision) {
        if (revision !== snapshots.memory.memory.revision) throw new Error('revision conflict')
        const entries = snapshots.memory.memory.entries.map(entry => entry.id === id ? { ...entry, state: entryState } : entry)
        snapshots.memory = { ...snapshots.memory, memory: { ...snapshots.memory.memory, revision: revision + 1, entries } }; notify()
      } },
      productHealth: { ...store('health'), refresh: async () => snapshots.health },
    }
    window.addEventListener('error', event => state.rendererErrors.push(String(event.error?.stack || event.message)))
    window.addEventListener('unhandledrejection', event => state.rendererErrors.push(String(event.reason?.stack || event.reason)))
    window.__journey = {
      state,
      ports: ctx, notify,
      modules: { react: React },
      mount() { state.release = state.client.apply(ctx, React, { MarkdownText: markdownModule.exports.MarkdownText }) },
      setRunning(running) {
        snapshots.runtime = { currentSessionId: sessionId, sessions: { [sessionId]: { state: running ? 'running' : 'idle' } } }
        notify()
      },
      setRuntimeState(value) { snapshots.runtime = { currentSessionId: sessionId, sessions: { [sessionId]: { ...snapshots.runtime.sessions[sessionId], state: value } } }; notify() },
      setActualMaterials(evidence) {
        if (evidence.surfaces.sessionId !== sessionId) throw new Error('material evidence belongs to a different session')
        snapshots.surfaces = evidence.surfaces
        snapshots.runCenter = evidence.runCenter
        notify()
      },
      setModelUnavailable(unavailable) { snapshots.models = { ...snapshots.models, routable: !unavailable }; notify() },
      changeProject() {
        snapshots.catalog = { sessions: { [sessionId]: { ...snapshots.catalog.sessions[sessionId], cwd: 'C:/another-workspace' } } }
        snapshots.memory = { ...snapshots.memory, memory: { ...snapshots.memory.memory, project: 'C:/another-workspace' } }; notify()
      },
      setBareRun(bare) {
        if (bare) { state.previousRun = snapshots.runCenter; snapshots.runCenter = { sessionId, status: 'ready', jobs: [], subagents: [], queue: [], todos: [], skills: [], deliverables: [] }; snapshots.runtime = { currentSessionId: sessionId, sessions: { [sessionId]: { state: 'running', completionReceipt: { outcome: 'verified', sourceSeq: 1 } } } } }
        else snapshots.runCenter = state.previousRun
        notify()
      },
      setEmptyTask(empty) {
        if (empty) {
          state.emptyTaskPrevious = { runCenter: snapshots.runCenter, surfaces: snapshots.surfaces }
          snapshots.runCenter = { sessionId, status: 'ready', jobs: [], subagents: [], queue: [], todos: [], skills: [], deliverables: [] }
          snapshots.surfaces = { sessionId, items: [] }
        } else Object.assign(snapshots, state.emptyTaskPrevious)
        notify()
      },
      setInteraction(kind) {
        snapshots.questions = { sessionId, requests: kind === 'question' ? [{ key: 'question-1', sessionId, questions: [{ id: 'scope', question: '希望整理哪些内容？', options: [{ label: '重点事项' }, { label: '完整内容' }] }] }] : [] }
        snapshots.approvals = { sessionId, approvals: kind === 'approval' ? [{ key: 'approval-1', toolName: '保存文件', reason: '确认后将保存这份文档。' }] : [] }
        notify()
      },
      finishStop() { state.finishStop?.() },
      setProviderReadiness(mode) {
        snapshots.providers = mode === 'stale'
          ? providerSnapshot('stale-session', false)
          : mode === 'unavailable' ? providerSnapshot(sessionId, false) : providerSnapshot()
        notify()
      },
      setNextSendOutcome(value) { state.nextSendOutcome = value },
      seedDraftDecoy(value) { sessionStorage.setItem(draftDecoyKey, JSON.stringify({ text: value })) },
      release() { state.release?.(); state.release = null },
      inspect(expectedDraft = '') {
        const textarea = document.querySelector('textarea[name=content]')
        let exactStoredDraft
        try { exactStoredDraft = JSON.parse(sessionStorage.getItem(composerDraftKey) || 'null') } catch { exactStoredDraft = null }
        return {
          loadedModuleId: state.loadedModuleId,
          registeredRootId: state.registeredRootId,
          ledger: JSON.parse(JSON.stringify(ledger)),
          persistedDurableEvents: JSON.parse(localStorage.getItem(durableEventKey) || '[]'),
          timelineItems: JSON.parse(JSON.stringify(snapshots.timeline.items)),
          renderedUserTexts: [...document.querySelectorAll('[data-kind=user]')].map(node => node.textContent || ''),
          runtimeState: snapshots.runtime.sessions[sessionId].state,
          composerValue: textarea?.value || '',
          exactStorageContainsDraft: expectedDraft !== '' && exactStoredDraft?.version === 1
            && exactStoredDraft.text === expectedDraft && Array.isArray(exactStoredDraft.images),
          alertText: document.querySelector('[role=alert]')?.textContent || '',
          rendererErrors: [...state.rendererErrors],
        }
      },
      modelControl() {
        const trigger = document.querySelector('.model-reasoning-trigger')
        const popover = document.querySelector('.model-reasoning-popover')
        const visible = element => {
          if (!(element instanceof HTMLElement)) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        }
        const rect = popover?.getBoundingClientRect()
        return {
          triggerVisible: visible(trigger),
          popoverVisible: visible(popover),
          withinViewport: rect !== undefined && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          nativeSelectCount: document.querySelectorAll('.model-controls select').length,
          modelCount: document.querySelectorAll('.model-choice-option').length,
          effortCount: document.querySelectorAll('.effort-rail-option').length,
          selectedModel: snapshots.models.current?.model || '',
          selectedEffort: snapshots.models.current?.reasoningEffort || '',
          selectionCount: ledger.modelSelections.length,
          triggerText: trigger?.textContent || '',
        }
      },
      modelRoute(label) {
        const button = [...document.querySelectorAll('.model-choice-option')].find(node => node.textContent.includes(label))
        return {
          disabled: button instanceof HTMLButtonElement ? button.disabled : undefined,
          statusText: button?.querySelector('em')?.textContent || '',
        }
      },
      layout() {
        const textarea = document.querySelector('textarea[name=content]')
        const action = document.querySelector('button.send')
        const visible = element => {
          if (!(element instanceof HTMLElement)) return false
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight && style.visibility !== 'hidden' && style.display !== 'none'
        }
        return {
          clientWidth: innerWidth,
          clientHeight: innerHeight,
          composerVisible: visible(textarea),
          primaryActionVisible: visible(action),
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        }
      },
    }
    window.__ModuleLoader__ = { load(definition) {
      state.loadedModuleId = definition.id
      state.client = definition.factory(specifier => {
        if (specifier === 'react') return React
        throw new Error('fake module loader does not provide ' + specifier)
      })
    } }
  })()`
}

async function writeReport(report) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8')
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

// Reuse the real React/slot bootstrap for additional isolated product journeys.
export const createRendererBootstrap = () => rendererBootstrap({ reactPath, reactDomClientPath, jsxRuntimePath, settingsCode, settingsCss, settingsIconsCode })
export { waitFor, click, pressKey, fillComposer, fillTextarea, setExactViewport, openWorkbench, closeWorkbench, captureScene }

if (process.env.XIAOSHE_NATIVE_SHELL_FIXTURE_ONLY !== '1') void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
