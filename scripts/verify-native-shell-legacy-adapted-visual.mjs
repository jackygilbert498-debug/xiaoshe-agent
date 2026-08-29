import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const attachmentFixture = join(root, 'runtime', 'xiaoshe-legacy', 'ui', 'assets', 'icon-256.png')
const requireFromWeb = createRequire(join(root, 'runtime', 'DSH', 'apps', 'web', 'package.json'))
const { chromium } = requireFromWeb('playwright')

const expectedDiagnosticsPath = process.platform === 'darwin'
  ? '~/Library/Logs/小蛇'
  : process.platform === 'win32'
    ? '%LOCALAPPDATA%\\Xiaoshe\\Logs'
    : '~/.local/state/xiaoshe/logs'

const args = process.argv.slice(2)
const urlIndex = args.indexOf('--url')
const outputIndex = args.indexOf('--output')
const balanceOnly = args.includes('--balance-only')
const adaptiveOnly = args.includes('--adaptive-only')
if (urlIndex < 0 || args[urlIndex + 1] === undefined) throw new Error('--url <loopback-url> is required')
const url = new URL(args[urlIndex + 1])
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('visual verification only accepts loopback URLs')
const output = resolve(outputIndex < 0 || args[outputIndex + 1] === undefined
  ? join(root, 'artifacts', 'native-shell-legacy-adapted-visual')
  : args[outputIndex + 1])
await mkdir(output, { recursive: true })

const executablePath = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : undefined
const browser = await chromium.launch({ headless: true, ...(executablePath === undefined ? {} : { executablePath }) })
const records = []

try {
  if (balanceOnly) {
    await verifyVisualBalance()
  } else if (adaptiveOnly) {
    await verifyAdaptiveShell()
  } else {
    await verifyDesktop({ width: 2269, height: 1214, name: 'desktop-wide' })
    await verifyDesktop({ width: 1440, height: 900, name: 'desktop-standard' })
    await verifyTablet()
    await verifyMobile({ width: 740, height: 900, name: 'mobile-wide' })
    await verifyMobile({ width: 390, height: 844, name: 'mobile-narrow' })
  }
} finally {
  await browser.close()
}

/**
 * Focused regression suite for the whole-page proportion and settings issues
 * found during the 2026-08-27 adaptive audit. It intentionally observes the
 * mounted product instead of accepting CSS source text as evidence.
 */
async function verifyAdaptiveShell() {
  await verifyCompactDesktop()
  await verifyWideAdaptive()
  await verifyAspectLayout({ width: 1920, height: 1080, name: 'adaptive-desktop-16-9' })
  await verifyAspectLayout({ width: 1280, height: 1024, name: 'adaptive-desktop-5-4' })
  await verifyMobileAdaptive({ width: 740, height: 900, name: 'adaptive-mobile-wide' })
  await verifyMobileAdaptive({ width: 390, height: 844, name: 'adaptive-mobile-narrow' })
  await verifyMobileAdaptive({ width: 375, height: 667, name: 'adaptive-mobile-small' })
  await verifySettingsAdaptive()
  await verifyLightThemeAdaptive()
}

async function verifyAspectLayout(viewport) {
  const { context, page, failures } = await openPage(viewport)
  try {
    await assertVisible(page.locator('#xsla-side'), `${viewport.name}: left rail`)
    await assertVisible(page.locator('#xsla-insp'), `${viewport.name}: inspector`)
    const metrics = await page.evaluate(() => {
      const rect = selector => {
        const node = document.querySelector(selector)
        if (!(node instanceof HTMLElement)) return undefined
        const box = node.getBoundingClientRect()
        return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), right: Math.round(box.right), bottom: Math.round(box.bottom) }
      }
      return {
        side: rect('#xsla-side'), chat: rect('.chat'), inspector: rect('#xsla-insp'),
        header: rect('.chat-head'), composer: rect('.composer'),
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      }
    })
    invariant((metrics.chat?.width ?? 0) >= 680, `${viewport.name}: central task surface is too narrow (${metrics.chat?.width})`)
    invariant((metrics.header?.right ?? Infinity) <= viewport.width + 1 && (metrics.composer?.bottom ?? Infinity) <= viewport.height, `${viewport.name}: core work surface escapes the viewport`)
    invariant(metrics.scrollWidth <= viewport.width + 1 && metrics.scrollHeight <= viewport.height + 1, `${viewport.name}: page overflow ${metrics.scrollWidth}x${metrics.scrollHeight}`)
    invariant(failures.length === 0, `${viewport.name}: browser errors: ${failures.join(' | ')}`)
    await page.screenshot({ path: join(output, `${viewport.name}.png`), fullPage: false })
    records.push({ viewport: viewport.name, metrics })
  } finally {
    await context.close()
  }
}

async function verifyCompactDesktop() {
  const viewport = { width: 1180, height: 720, name: 'adaptive-compact-desktop' }
  const { context, page, failures } = await openPage(viewport)
  try {
    await assertVisible(page.locator('#xsla-side'), `${viewport.name}: left rail`)
    await assertHidden(page.locator('#xsla-insp'), `${viewport.name}: inspector should move to an overlay`)
    await assertVisible(page.getByRole('button', { name: /状态面板/ }), `${viewport.name}: inspector toggle`)
    const metrics = await page.evaluate(() => {
      const box = selector => {
        const node = document.querySelector(selector)
        if (!(node instanceof HTMLElement)) return undefined
        const rect = node.getBoundingClientRect()
        return { width: Math.round(rect.width), height: Math.round(rect.height) }
      }
      return {
        chat: box('.chat'), header: box('.chat-head'), composer: box('.composer'),
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      }
    })
    invariant((metrics.chat?.width ?? 0) >= 900, `${viewport.name}: central task surface remains cramped (${metrics.chat?.width})`)
    invariant((metrics.header?.height ?? Infinity) <= 84, `${viewport.name}: short-screen header is too tall (${metrics.header?.height})`)
    invariant((metrics.composer?.height ?? Infinity) <= 150, `${viewport.name}: short-screen composer consumes too much height (${metrics.composer?.height})`)
    invariant(metrics.scrollWidth <= viewport.width + 1 && metrics.scrollHeight <= viewport.height + 1, `${viewport.name}: page overflow ${metrics.scrollWidth}x${metrics.scrollHeight}`)
    invariant(failures.length === 0, `${viewport.name}: browser errors: ${failures.join(' | ')}`)
    await page.screenshot({ path: join(output, `${viewport.name}.png`), fullPage: false })
    records.push({ viewport: viewport.name, metrics })
  } finally {
    await context.close()
  }
}

async function verifyWideAdaptive() {
  const viewport = { width: 2560, height: 1080, name: 'adaptive-ultrawide' }
  const { context, page, failures } = await openPage(viewport)
  try {
    const metrics = await page.evaluate(() => {
      const composer = document.querySelector('.cbox')?.getBoundingClientRect()
      const events = document.querySelector('.events')?.getBoundingClientRect()
      const chat = document.querySelector('.chat')?.getBoundingClientRect()
      return {
        composerWidth: composer === undefined ? 0 : Math.round(composer.width),
        eventsWidth: events === undefined ? 0 : Math.round(events.width),
        chatWidth: chat === undefined ? 0 : Math.round(chat.width),
        scrollWidth: document.documentElement.scrollWidth,
      }
    })
    invariant(metrics.composerWidth >= 880 && metrics.composerWidth <= 960, `${viewport.name}: composer is not proportionate (${metrics.composerWidth}/${metrics.chatWidth})`)
    invariant(metrics.eventsWidth <= 840, `${viewport.name}: reading column became too wide (${metrics.eventsWidth})`)
    invariant(metrics.scrollWidth <= viewport.width + 1, `${viewport.name}: horizontal overflow ${metrics.scrollWidth}/${viewport.width}`)
    invariant(failures.length === 0, `${viewport.name}: browser errors: ${failures.join(' | ')}`)
    await page.screenshot({ path: join(output, `${viewport.name}.png`), fullPage: false })
    records.push({ viewport: viewport.name, metrics })
  } finally {
    await context.close()
  }
}

async function verifyMobileAdaptive(viewport) {
  const { context, page, failures } = await openPage(viewport)
  try {
    // Model and permission projections arrive from live client services just
    // after the shell mount; measure only once all current-session controls
    // have joined the toolbar.
    await page.locator('.permission-select-wrap').waitFor({ state: 'attached' })
    await page.locator('.effort-select-wrap').waitFor({ state: 'attached' })
    await page.locator('.send').waitFor({ state: 'attached' })
    const metrics = await page.evaluate(() => {
      const size = selector => {
        const node = document.querySelector(selector)
        if (!(node instanceof HTMLElement)) return undefined
        const rect = node.getBoundingClientRect()
        return { width: Math.round(rect.width), height: Math.round(rect.height) }
      }
      const visibleHeaderFacts = Array.from(document.querySelectorAll('.chat-head .right > span'))
        .filter(node => node instanceof HTMLElement && getComputedStyle(node).display !== 'none').length
      const session = document.querySelector('.status-session')
      return {
        visibleHeaderFacts,
        sessionExists: session !== null,
        sessionVisible: session instanceof HTMLElement && getComputedStyle(session).display !== 'none',
        task: size('.task-mobile-toggle'), inspector: size('.inspector-mobile-toggle'), theme: size('.theme-toggle'),
        permission: size('.permission-select-wrap'), effort: size('.effort-select-wrap'), send: size('.send'),
        scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      }
    })
    invariant(metrics.visibleHeaderFacts === 1, `${viewport.name}: low-priority runtime facts still duplicate the inspector (${metrics.visibleHeaderFacts})`)
    invariant(metrics.sessionExists && !metrics.sessionVisible, `${viewport.name}: long session id remains visible in the compact status bar`)
    for (const [name, size] of Object.entries({ task: metrics.task, inspector: metrics.inspector, theme: metrics.theme, permission: metrics.permission, effort: metrics.effort, send: metrics.send })) {
      invariant((size?.height ?? 0) >= 40 && (size?.width ?? 0) >= 40, `${viewport.name}: ${name} touch target is too small (${JSON.stringify(size)})`)
    }
    invariant(metrics.scrollWidth <= viewport.width + 1 && metrics.scrollHeight <= viewport.height + 1, `${viewport.name}: page overflow ${metrics.scrollWidth}x${metrics.scrollHeight}`)
    invariant(failures.length === 0, `${viewport.name}: browser errors: ${failures.join(' | ')}`)
    await page.screenshot({ path: join(output, `${viewport.name}.png`), fullPage: false })
    records.push({ viewport: viewport.name, metrics })
  } finally {
    await context.close()
  }
}

async function verifySettingsAdaptive() {
  const viewport = { width: 1440, height: 900, name: 'adaptive-settings' }
  const { context, page, failures } = await openPage(viewport)
  try {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '小蛇设置' })
    await dialog.waitFor({ state: 'visible' })
    await settleSettingsDialog(page, dialog)
    const desktop = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      const inspector = document.querySelector('#xsla-insp')
      if (!(dialog instanceof HTMLElement) || !(inspector instanceof HTMLElement)) return undefined
      const rect = dialog.getBoundingClientRect()
      const inspectorRect = inspector.getBoundingClientRect()
      const top = document.elementFromPoint(inspectorRect.left + inspectorRect.width / 2, inspectorRect.top + inspectorRect.height / 2)
      return {
        height: Math.round(rect.height), width: Math.round(rect.width),
        layerCoversInspector: top !== null && dialog.parentElement?.contains(top) === true,
        panelBackground: getComputedStyle(dialog).backgroundColor,
        shellBackground: getComputedStyle(document.querySelector('.chat')).backgroundColor,
        borderRadius: getComputedStyle(dialog).borderRadius,
        dialogText: dialog.innerText,
        brandStops: dialog.querySelectorAll('.xsla-settings-brand-mark linearGradient stop').length,
        brandPathStroke: dialog.querySelector('.xsla-settings-brand-mark path[stroke]')?.getAttribute('stroke') ?? '',
        visibleNavIcons: Array.from(dialog.querySelectorAll(':scope > nav button > svg')).filter(node => node instanceof SVGElement && getComputedStyle(node).display !== 'none').length,
        navNumbers: Array.from(dialog.querySelectorAll(':scope > nav button')).map(button => getComputedStyle(button, '::before').content.replaceAll('"', '')),
        navLabels: Array.from(dialog.querySelectorAll(':scope > nav button')).map(button => button.textContent?.trim() ?? ''),
      }
    })
    invariant(desktop !== undefined, `${viewport.name}: settings metrics unavailable`)
    invariant(desktop.layerCoversInspector, `${viewport.name}: inspector is painted above the settings mask`)
    invariant(desktop.height >= 680 && desktop.height <= 722, `${viewport.name}: settings panel height escaped the Xiaoshe desktop frame (${desktop.height})`)
    invariant(desktop.width >= 940 && desktop.width <= 982, `${viewport.name}: settings panel width escaped the Xiaoshe desktop frame (${desktop.width})`)
    invariant(desktop.panelBackground === desktop.shellBackground, `${viewport.name}: settings is visually detached from the dark shell (${desktop.panelBackground}/${desktop.shellBackground})`)
    invariant(desktop.borderRadius !== '24px', `${viewport.name}: original DSH panel radius is still visible`)
    invariant(!desktop.dialogText.includes('DSH'), `${viewport.name}: DSH remains visible inside Xiaoshe settings`)
    invariant(desktop.brandStops === 4 && desktop.brandPathStroke.includes('xsla-brand-sheen-settings'), `${viewport.name}: settings header is not using the official Xiaoshe gradient mark`)
    invariant(desktop.visibleNavIcons === 0, `${viewport.name}: original DSH navigation glyphs remain visible (${desktop.visibleNavIcons})`)
    invariant(JSON.stringify(desktop.navNumbers) === JSON.stringify(['01', '02', '03', '04', '05', '06', '07']), `${viewport.name}: Xiaoshe numbered navigation is incomplete (${JSON.stringify(desktop.navNumbers)})`)
    invariant(JSON.stringify(desktop.navLabels) === JSON.stringify(['小蛇偏好', '模型', '权限与安全', '插件', '能力方案', '快捷键', '高级与关于']), `${viewport.name}: settings navigation is not fully adapted (${JSON.stringify(desktop.navLabels)})`)
    await page.screenshot({ path: join(output, `${viewport.name}-desktop.png`), fullPage: false })

    await dialog.locator(':scope > nav button').filter({ hasText: '高级与关于' }).click()
    await dialog.locator('.xsla-about-mark').waitFor({ state: 'visible' })
    const about = await dialog.locator('.xsla-about-mark').evaluate(node => ({
      tag: node.tagName.toLowerCase(),
      background: getComputedStyle(node).backgroundImage,
      label: node.getAttribute('aria-label'),
    }))
    invariant(about.tag === 'svg' && about.label === '小蛇', `${viewport.name}: about page substituted the official Xiaoshe mark (${JSON.stringify(about)})`)
    invariant(about.background === 'none', `${viewport.name}: about mark still has an invented tile background (${about.background})`)
    invariant((await dialog.innerText()).includes(expectedDiagnosticsPath), `${viewport.name}: platform diagnostics path is missing (${expectedDiagnosticsPath})`)
    await dialog.locator(':scope > nav button').filter({ hasText: '小蛇偏好' }).click()

    await page.setViewportSize({ width: 390, height: 844 })
    await dialog.waitFor({ state: 'visible' })
    await settleSettingsDialog(page, dialog)
    const mobile = await page.evaluate(() => {
      const rect = selector => {
        const node = document.querySelector(selector)
        if (!(node instanceof HTMLElement)) return undefined
        const box = node.getBoundingClientRect()
        return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
      }
      const themeButtons = ['浅色', '深色', '跟随系统'].map(label => Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === label))
      const themeBoxes = themeButtons.map(button => button instanceof HTMLElement ? (() => { const box = button.getBoundingClientRect(); return { y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } })() : undefined)
      return {
        dialog: rect('[role="dialog"][aria-modal="true"]'),
        close: rect('[role="dialog"][aria-modal="true"] button:last-of-type'),
        themeBoxes,
        scrollWidth: document.documentElement.scrollWidth,
      }
    })
    invariant(mobile.dialog !== undefined, `${viewport.name}: settings disappeared while crossing the mobile breakpoint`)
    invariant(mobile.dialog.x === 0 && mobile.dialog.y === 0 && mobile.dialog.width === 390 && mobile.dialog.height === 844, `${viewport.name}: mobile settings does not own the full viewport (${JSON.stringify(mobile.dialog)})`)
    const themes = mobile.themeBoxes.filter(Boolean)
    invariant(themes.length === 3 && Math.max(...themes.map(item => item.y)) - Math.min(...themes.map(item => item.y)) <= 2, `${viewport.name}: mobile theme choices do not share one row (${JSON.stringify(themes)})`)
    invariant(themes.every(item => item.width >= 84 && item.height >= 64), `${viewport.name}: mobile theme choices are not compact touch targets (${JSON.stringify(themes)})`)
    const close = page.getByRole('button', { name: '关闭', exact: true })
    const closeBox = await close.boundingBox()
    invariant((closeBox?.width ?? 0) >= 40 && (closeBox?.height ?? 0) >= 40, `${viewport.name}: mobile settings close target is too small (${JSON.stringify(closeBox)})`)
    invariant(mobile.scrollWidth <= 391, `${viewport.name}: mobile settings overflow ${mobile.scrollWidth}/390`)
    invariant(failures.length === 0, `${viewport.name}: browser errors: ${failures.join(' | ')}`)
    await page.screenshot({ path: join(output, `${viewport.name}-mobile.png`), fullPage: false })
    records.push({ viewport: viewport.name, desktop, mobile })
  } finally {
    await context.close()
  }
}

async function verifyLightThemeAdaptive() {
  const viewport = { width: 1440, height: 900, name: 'adaptive-light-desktop' }
  const { context, page, failures } = await openPage(viewport)
  try {
    const shell = page.locator('.xsla-shell')
    if (await shell.getAttribute('data-theme') !== 'light') {
      await page.getByRole('button', { name: '切换为亮色主题' }).click()
      await page.locator('.xsla-shell[data-theme="light"]').waitFor({ state: 'visible' })
    }
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '小蛇设置' })
    await dialog.waitFor({ state: 'visible' })
    await settleSettingsDialog(page, dialog)
    const metrics = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      const chat = document.querySelector('.chat')
      return {
        panelBackground: dialog instanceof HTMLElement ? getComputedStyle(dialog).backgroundColor : '',
        shellBackground: chat instanceof HTMLElement ? getComputedStyle(chat).backgroundColor : '',
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      }
    })
    invariant(metrics.panelBackground === metrics.shellBackground, `${viewport.name}: settings is visually detached from the light shell (${metrics.panelBackground}/${metrics.shellBackground})`)
    invariant(metrics.scrollWidth <= viewport.width + 1 && metrics.scrollHeight <= viewport.height + 1, `${viewport.name}: page overflow ${metrics.scrollWidth}x${metrics.scrollHeight}`)
    invariant(failures.length === 0, `${viewport.name}: browser errors: ${failures.join(' | ')}`)
    await page.screenshot({ path: join(output, `${viewport.name}-settings.png`), fullPage: false })
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.screenshot({ path: join(output, `${viewport.name}-shell.png`), fullPage: false })
    records.push({ viewport: viewport.name, metrics })
  } finally {
    await context.close()
  }
}

async function settleSettingsDialog(page, dialog) {
  // The shell deliberately animates settings in. Sampling before that motion
  // settles produces false geometry and contrast failures rather than a real
  // product observation.
  await page.waitForTimeout(420)
  await dialog.waitFor({ state: 'visible' })
}

process.stdout.write(`${JSON.stringify({ status: 'PASS', url: url.href, output, records })}\n`)

async function openPage(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'no-preference' })
  const page = await context.newPage()
  const failures = []
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`)
  })
  // Xiaoshe intentionally polls heartbeat state, so "networkidle" is not a
  // valid readiness signal. The adapted root is the public mount contract.
  await page.goto(url.href, { waitUntil: 'domcontentloaded' })
  await page.locator('.xsla-shell[data-xiaoshe-legacy-adapted]').waitFor({ state: 'visible' })
  return { context, page, failures }
}

/**
 * Product-level visual contract for the two rails and conversation header.
 * This catches the regression where the left rail carries all visual weight
 * while the inspector is rendered as transparent, low-contrast wireframes.
 */
async function verifyVisualBalance() {
  const viewport = { width: 1280, height: 720, name: 'desktop-balance' }
  const { context, page, failures } = await openPage(viewport)
  try {
    const metrics = await page.evaluate(() => {
      const box = selector => {
        const node = document.querySelector(selector)
        if (!(node instanceof HTMLElement)) return undefined
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return {
          width: Math.round(rect.width), height: Math.round(rect.height),
          centerY: Math.round((rect.top + rect.bottom) / 2),
          background: style.backgroundColor, borderStyle: style.borderStyle,
          color: style.color, fontWeight: Number(style.fontWeight),
        }
      }
      const fact = document.querySelector('#xsla-insp .panel.on .panel-fact')
      const accent = fact === null ? undefined : getComputedStyle(fact, '::before')
      return {
        header: box('.chat-head'), title: box('.chat-head h1'), headerFacts: box('.chat-head .right'),
        side: box('#xsla-side'), inspector: box('#xsla-insp'),
        fact: box('#xsla-insp .panel.on .panel-fact'),
        factTitle: box('#xsla-insp .panel.on .panel-fact b'),
        factDetail: box('#xsla-insp .panel.on .panel-fact span'),
        sectionLabel: box('#xsla-insp .panel.on .psec h4'),
        accentWidth: accent === undefined ? 0 : Number.parseFloat(accent.width),
        pageWidth: document.documentElement.scrollWidth,
      }
    })
    const typography = await page.evaluate(() => {
      const shell = document.querySelector('.xsla-shell')
      const title = document.querySelector('.chat-head h1')
      if (!(shell instanceof HTMLElement) || !(title instanceof HTMLElement)) return undefined

      // Empty sessions are not guaranteed during a live acceptance run. Mount
      // the real stage class off-canvas so the browser still resolves the
      // shipped CSS and font stack instead of inspecting source text.
      const stage = document.createElement('div')
      stage.className = 'stage-word'
      stage.textContent = '小蛇'
      stage.style.cssText = 'position:fixed;left:-10000px;top:-10000px'
      shell.append(stage)
      try {
        const shellStyle = getComputedStyle(shell)
        const titleStyle = getComputedStyle(title)
        const stageStyle = getComputedStyle(stage)
        return {
          shellFamily: shellStyle.fontFamily,
          titleFamily: titleStyle.fontFamily,
          titleWeight: Number(titleStyle.fontWeight),
          titleTracking: Number.parseFloat(titleStyle.letterSpacing),
          stageFamily: stageStyle.fontFamily,
          stageWeight: Number(stageStyle.fontWeight),
          stageTracking: Number.parseFloat(stageStyle.letterSpacing),
        }
      } finally {
        stage.remove()
      }
    })
    invariant(metrics.side?.width === 232, `desktop-balance: left rail width drifted (${metrics.side?.width})`)
    invariant(metrics.inspector?.width === 292, `desktop-balance: inspector width drifted (${metrics.inspector?.width})`)
    invariant((metrics.header?.height ?? Infinity) <= 100, `desktop-balance: conversation header is still banner-height (${metrics.header?.height})`)
    invariant(Math.abs((metrics.title?.centerY ?? 0) - (metrics.headerFacts?.centerY ?? Infinity)) <= 3, 'desktop-balance: title and runtime facts do not share one visual axis')
    invariant(metrics.fact?.background !== 'rgba(0, 0, 0, 0)', 'desktop-balance: inspector facts still have a transparent background')
    invariant(metrics.fact?.borderStyle === 'solid', `desktop-balance: inspector fact still reads as a dashed placeholder (${metrics.fact?.borderStyle})`)
    invariant((metrics.sectionLabel?.fontWeight ?? 0) >= 500, `desktop-balance: inspector section labels remain too light (${metrics.sectionLabel?.fontWeight})`)
    invariant((metrics.accentWidth ?? 0) >= 2, `desktop-balance: inspector fact has no state accent (${metrics.accentWidth})`)
    invariant((metrics.factTitle?.fontWeight ?? 0) > (metrics.factDetail?.fontWeight ?? Infinity), 'desktop-balance: fact title and detail lack a clear weight hierarchy')
    invariant(typography !== undefined, 'desktop-balance: display typography could not be measured')
    invariant(typography.titleFamily !== typography.shellFamily, 'desktop-balance: conversation title still inherits the utility sans face')
    invariant(typography.stageFamily === typography.titleFamily, 'desktop-balance: title and Xiaoshe wordmark do not share one display family')
    invariant(typography.titleFamily.includes('Noto Serif SC'), `desktop-balance: display family is not the approved CJK serif stack (${typography.titleFamily})`)
    invariant(typography.titleWeight >= 600, `desktop-balance: conversation title lacks editorial authority (${typography.titleWeight})`)
    invariant(typography.stageWeight > typography.titleWeight, `desktop-balance: Xiaoshe wordmark is not distinguished from the title (${typography.stageWeight}/${typography.titleWeight})`)
    invariant(typography.stageTracking > -6, `desktop-balance: Xiaoshe wordmark remains cramped (${typography.stageTracking}px)`)
    invariant(metrics.pageWidth <= viewport.width + 1, `desktop-balance: page overflow ${metrics.pageWidth}/${viewport.width}`)
    invariant(failures.length === 0, `desktop-balance: browser errors: ${failures.join(' | ')}`)
    await page.screenshot({ path: join(output, 'desktop-balance.png'), fullPage: false })
    records.push({ viewport: viewport.name, metrics, typography })
  } finally {
    await context.close()
  }
}

async function verifyDesktop(viewport) {
  const { context, page, failures } = await openPage(viewport)
  try {
    await assertCommon(page, viewport, failures)
    await assertVisible(page.locator('#xsla-side'), `${viewport.name}: left rail`)
    await assertVisible(page.locator('#xsla-insp'), `${viewport.name}: inspector`)
    const layout = await measureLayout(page)
    invariant(layout.side.width >= 220, `${viewport.name}: left rail unexpectedly narrow (${layout.side.width})`)
    invariant(layout.inspector.width >= 280, `${viewport.name}: inspector unexpectedly narrow (${layout.inspector.width})`)
    invariant(Math.abs(layout.stageCenter - layout.chatCenter) <= 2, `${viewport.name}: empty stage is not centered in the work area`)

    if (viewport.name === 'desktop-standard') await verifyPanelResizing(page)

    const workspaceToggle = page.locator('#xsla-side .proj-toggle').first()
    const workspacePanelId = await workspaceToggle.getAttribute('aria-controls')
    invariant(workspacePanelId !== null, `${viewport.name}: workspace toggle does not control a session group`)
    const workspacePanel = page.locator(`#${workspacePanelId}`)
    await workspaceToggle.click()
    await page.locator('#xsla-side .proj[data-collapsed="true"]').first().waitFor({ state: 'attached' })
    invariant(await workspaceToggle.getAttribute('aria-expanded') === 'false', `${viewport.name}: workspace group did not collapse`)
    invariant(await workspacePanel.getAttribute('aria-hidden') === 'true', `${viewport.name}: collapsed workspace sessions remain exposed`)
    await settleMotion(page)
    await page.screenshot({ path: join(output, `${viewport.name}-workspace-collapsed.png`), fullPage: false })
    await workspaceToggle.click()
    await page.locator('#xsla-side .proj[data-collapsed="false"]').first().waitFor({ state: 'attached' })
    invariant(await workspaceToggle.getAttribute('aria-expanded') === 'true', `${viewport.name}: workspace group did not expand`)

    await page.getByRole('button', { name: '收缩侧栏' }).click()
    await page.locator('#xsla-side.collapsed').waitFor()
    await page.getByRole('button', { name: '展开侧栏' }).click()
    await page.locator('#xsla-side:not(.collapsed)').waitFor()
    await page.getByRole('button', { name: '收缩状态面板' }).click()
    await page.locator('#xsla-insp.collapsed').waitFor()
    await page.getByRole('button', { name: '展开状态面板' }).click()
    await page.locator('#xsla-insp:not(.collapsed)').waitFor()

    await page.keyboard.press('Control+K')
    const palette = page.getByRole('dialog', { name: '命令面板' })
    await palette.waitFor({ state: 'visible' })
    invariant((await palette.getByRole('button').count()) >= 7, `${viewport.name}: command palette is incomplete`)
    await page.screenshot({ path: join(output, `${viewport.name}-command.png`), fullPage: false })
    await page.keyboard.press('Escape')
    await palette.waitFor({ state: 'hidden' })

    if (viewport.name === 'desktop-standard') {
      await verifySidebarManagement(page)
      await verifyComposerInteraction(page)
      await verifySlashCommands(page)
    }

    // Exercise the real DSH permission projection on one desktop viewport.
    // The wide viewport still covers layout; repeating stateful permission
    // commands there would only add noise to the live session.
    if (viewport.name === 'desktop-standard') {
      const permission = page.locator('.composer .permission-select-wrap')
      const originalPermission = await permission.getAttribute('data-value')
      await selectPermission(page, '只读')
      await page.waitForFunction(() => document.querySelector('.permission-select-wrap')?.getAttribute('data-value') === 'read-only')
      invariant((await permission.getAttribute('aria-label')) === '权限：只读', `${viewport.name}: read-only permission did not reach the live projection`)

      await selectPermission(page, '工作区写入')
      await page.waitForFunction(() => document.querySelector('.permission-select-wrap')?.getAttribute('data-value') === 'workspace-write')
      invariant((await permission.getAttribute('aria-label')) === '权限：工作区写入', `${viewport.name}: workspace-write permission did not reach the live projection`)

      await selectPermission(page, '完全访问')
      const permissionDialog = page.getByRole('dialog', { name: '确认完全访问权限' })
      await permissionDialog.waitFor({ state: 'visible' })
      invariant((await permission.getAttribute('data-value')) === 'workspace-write', `${viewport.name}: dangerous permission changed before confirmation`)
      await permissionDialog.getByRole('button', { name: '取消' }).click()
      await permissionDialog.waitFor({ state: 'hidden' })

      // Preserve a pre-existing read-only session; all other live states leave
      // the safer product default selected after this acceptance run.
      if (originalPermission === 'read-only') {
        await selectPermission(page, '只读')
        await page.waitForFunction(() => document.querySelector('.permission-select-wrap')?.getAttribute('data-value') === 'read-only')
      }
    }

    await page.getByRole('tab', { name: '能力' }).click()
    invariant((await page.locator('#xsla-insp .panel.on').innerText()).includes('能力中心'), `${viewport.name}: system facts did not render`)
    await page.getByRole('tab', { name: '状态' }).click()
    await settleMotion(page)
    invariant((await page.locator('#xsla-insp .panel.on').innerText()).includes('行动与审批'), `${viewport.name}: status facts did not render`)
    await page.screenshot({ path: join(output, `${viewport.name}.png`), fullPage: false })
    records.push({ viewport: viewport.name, ...layout })
  } finally {
    await context.close()
  }
}

async function verifyTablet() {
  const viewport = { width: 1024, height: 768, name: 'tablet' }
  const { context, page, failures } = await openPage(viewport)
  try {
    await assertCommon(page, viewport, failures)
    await assertVisible(page.locator('#xsla-side'), 'tablet: left rail')
    await assertHidden(page.locator('#xsla-insp'), 'tablet: inspector should be an overlay')
    const toggle = page.getByRole('button', { name: /状态面板/ })
    await assertVisible(toggle, 'tablet: inspector toggle')
    await toggle.click()
    await page.locator('#xsla-insp.mobile-open').waitFor({ state: 'visible' })
    await settleMotion(page)
    await page.screenshot({ path: join(output, 'tablet-inspector.png'), fullPage: false })
    await page.getByRole('button', { name: '关闭浮层' }).click()
    await assertHidden(page.locator('#xsla-insp'), 'tablet: inspector closes')
    records.push({ viewport: viewport.name, ...(await measureLayout(page)) })
  } finally {
    await context.close()
  }
}

async function verifyMobile(viewport) {
  const { context, page, failures } = await openPage(viewport)
  try {
    await assertCommon(page, viewport, failures)
    await assertHidden(page.locator('#xsla-side'), `${viewport.name}: left rail should be an overlay`)
    await assertHidden(page.locator('#xsla-insp'), `${viewport.name}: inspector should be an overlay`)
    const taskToggle = page.getByRole('button', { name: '任务' })
    await assertVisible(taskToggle, `${viewport.name}: task toggle`)
    await taskToggle.click()
    await page.locator('#xsla-side.mobile-open').waitFor({ state: 'visible' })
    await settleMotion(page)
    await page.screenshot({ path: join(output, `${viewport.name}-tasks.png`), fullPage: false })
    await clickExposedScrim(page, viewport.height)
    await page.locator('#xsla-side.mobile-open').waitFor({ state: 'hidden' })

    const inspectorToggle = page.getByRole('button', { name: /状态面板/ })
    await inspectorToggle.click()
    await page.locator('#xsla-insp.mobile-open').waitFor({ state: 'visible' })
    await clickExposedScrim(page, viewport.height)
    await page.screenshot({ path: join(output, `${viewport.name}.png`), fullPage: false })
    records.push({ viewport: viewport.name, ...(await measureLayout(page)) })
  } finally {
    await context.close()
  }
}

async function assertCommon(page, viewport, failures) {
  invariant((await page.title()).includes('小蛇'), `${viewport.name}: document title is not Xiaoshe`)
  const favicon = page.locator('link[rel="icon"][href*="legacy-adapted-brand-icon"]')
  await favicon.waitFor({ state: 'attached' })
  invariant(await favicon.count() === 1, `${viewport.name}: official favicon route is missing or duplicated`)
  // On narrow screens the whole rail is intentionally hidden until its
  // overlay opens; asset provenance still has to be present in the DOM.
  const brandMark = page.locator('.brand svg.brand-mark')
  await brandMark.waitFor({ state: 'attached' })
  await brandMark.locator('linearGradient#xsla-brand-sheen stop').first().waitFor({ state: 'attached' })
  invariant(await brandMark.locator('linearGradient#xsla-brand-sheen stop').count() === 4, `${viewport.name}: official four-stop brand sheen is missing`)
  invariant(await brandMark.locator('path[stroke="url(#xsla-brand-sheen)"]').count() === 1, `${viewport.name}: official gradient is not applied to the brand geometry`)
  await page.locator('.stage-ghost image[href*="legacy-adapted-brand-raster"]').waitFor({ state: 'attached' })
  await page.locator('.stage-ghost rect[mask="url(#xsla-stage-icon-outline)"]').waitFor({ state: 'attached' })
  const stageComposition = await page.evaluate(() => {
    const mark = document.querySelector('.stage-ghost')
    const word = document.querySelector('.stage-word')
    if (!(mark instanceof SVGElement) || !(word instanceof HTMLElement)) return null
    const markBox = mark.getBoundingClientRect()
    const wordBox = word.getBoundingClientRect()
    return {
      mark: {
        left: markBox.left,
        right: markBox.right,
        top: markBox.top,
        bottom: markBox.bottom,
        width: markBox.width,
        height: markBox.height,
        centerY: (markBox.top + markBox.bottom) / 2,
      },
      word: {
        left: wordBox.left,
        right: wordBox.right,
        top: wordBox.top,
        bottom: wordBox.bottom,
        centerY: (wordBox.top + wordBox.bottom) / 2,
      },
    }
  })
  invariant(stageComposition !== null, `${viewport.name}: empty-stage composition is missing`)
  invariant(stageComposition.mark.width <= 281, `${viewport.name}: empty-stage line mark is oversized (${stageComposition.mark.width})`)
  invariant(stageComposition.mark.left >= stageComposition.word.right - 40, `${viewport.name}: empty-stage line mark crowds the Xiaoshe word (${stageComposition.mark.left}/${stageComposition.word.right})`)
  invariant(stageComposition.mark.centerY >= stageComposition.word.centerY + 28, `${viewport.name}: empty-stage line mark is not intentionally lower than the Xiaoshe word (${stageComposition.mark.centerY}/${stageComposition.word.centerY})`)
  invariant(await page.locator('#xsla-side .proj-name').count() >= 1, `${viewport.name}: workspace identity is missing from the left rail`)
  invariant(await page.locator('#xsla-side .proj-folder-mark').count() >= 1, `${viewport.name}: workspace grouping mark is missing`)
  invariant(await page.locator('#xsla-side .proj-count').count() === 0, `${viewport.name}: workspace session count should not be rendered`)
  invariant(await page.locator('.chat-head .meta').count() === 0, `${viewport.name}: workspace/model subtitle is duplicated below the title`)
  invariant(await page.locator('.composer .pill').count() === 0, `${viewport.name}: workspace identity is duplicated in the composer`)
  const workspaceNames = (await page.locator('#xsla-side .proj-name').allInnerTexts()).map(value => value.trim()).filter(Boolean)
  const nonRailText = await page.locator('.chat-head, .composer, #xsla-insp').allInnerTexts()
  for (const workspaceName of workspaceNames) {
    invariant(nonRailText.every(value => !value.includes(workspaceName)), `${viewport.name}: workspace identity ${JSON.stringify(workspaceName)} is duplicated outside the left rail`)
  }
  const modelControl = page.locator('.composer .model-select-wrap')
  const effortControl = page.locator('.composer .effort-select-wrap')
  const permissionControl = page.locator('.composer .permission-select-wrap')
  await modelControl.waitFor({ state: 'attached' })
  await effortControl.waitFor({ state: 'attached' })
  await permissionControl.waitFor({ state: 'attached' })
  invariant(await modelControl.locator('select.model-select').count() === 1, `${viewport.name}: model name control is missing its independent selector`)
  invariant((await modelControl.locator('.model-name').innerText()).trim().length > 3, `${viewport.name}: readable model name is missing`)
  invariant(await modelControl.locator('svg.ic').count() === 0, `${viewport.name}: obsolete model glyph is still rendered`)
  invariant(await page.locator('button.effort-select-wrap[aria-haspopup="menu"]').count() === 1, `${viewport.name}: reasoning control is missing its independent custom menu trigger`)
  invariant(await page.locator('button.permission-select-wrap[aria-haspopup="menu"]').count() === 1, `${viewport.name}: permission control is missing its real custom menu trigger`)
  invariant(await page.locator('.composer-content').count() === 1, `${viewport.name}: composer content layer is missing`)
  invariant(await page.locator('.composer-toolbar').count() === 1, `${viewport.name}: composer toolbar layer is missing`)
  invariant(await page.locator('.attachment-input[accept*="image/png"]').count() === 1, `${viewport.name}: real image chooser is missing`)
  invariant(await page.locator('.composer .shortcut-command').count() === 0, `${viewport.name}: command palette trigger is duplicated in the composer`)
  invariant(await page.locator('.shortcut-command').count() === 0, `${viewport.name}: the removed persistent command-palette label returned to the product shell`)
  const composerHint = (await page.locator('.composer .hint').innerText()).trim()
  invariant(composerHint.includes('/ 命令'), `${viewport.name}: slash command affordance is missing from the composer hint`)
  invariant(await page.getByRole('listbox', { name: '斜杠命令' }).count() === 0, `${viewport.name}: slash command menu is open without a slash expression`)
  for (const duplicatedFact of ['上下文', '事件', '已连接', '已验证', '待审批', '压缩']) {
    invariant(!composerHint.includes(duplicatedFact), `${viewport.name}: composer hint duplicates ${duplicatedFact}`)
  }
  const controlMetrics = await page.evaluate(() => {
    const dimensions = selector => {
      const node = document.querySelector(selector)
      if (!(node instanceof HTMLElement)) return null
      const box = node.getBoundingClientRect()
      return { width: Math.round(box.width), height: Math.round(box.height) }
    }
    return {
      model: dimensions('.model-select-wrap'),
      effort: dimensions('.effort-select-wrap'),
      permission: dimensions('.permission-select-wrap'),
    }
  })
  const compactControlSize = 40
  invariant(controlMetrics.model?.width >= 86 && controlMetrics.model?.width <= 190 && controlMetrics.model?.height === compactControlSize, `${viewport.name}: model name control is not compact and readable (${JSON.stringify(controlMetrics.model)})`)
  invariant(controlMetrics.effort?.width >= compactControlSize && controlMetrics.effort?.width <= 144 && controlMetrics.effort?.height === compactControlSize, `${viewport.name}: reasoning control is not compact (${JSON.stringify(controlMetrics.effort)})`)
  invariant(controlMetrics.permission?.width >= compactControlSize && controlMetrics.permission?.width <= 144 && controlMetrics.permission?.height === compactControlSize, `${viewport.name}: permission control is not compact (${JSON.stringify(controlMetrics.permission)})`)
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }))
  invariant(metrics.scrollWidth <= metrics.innerWidth + 1, `${viewport.name}: horizontal overflow ${metrics.scrollWidth}/${metrics.innerWidth}`)
  invariant(metrics.scrollHeight <= metrics.innerHeight + 1, `${viewport.name}: page-level vertical overflow ${metrics.scrollHeight}/${metrics.innerHeight}`)
  invariant(failures.length === 0, `${viewport.name}: browser errors: ${failures.join(' | ')}`)
}

async function selectPermission(page, label) {
  await page.locator('.composer .permission-select-wrap').click()
  const menu = page.getByRole('menu', { name: '选择权限' })
  await menu.waitFor({ state: 'visible' })
  await menu.getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click()
  await menu.waitFor({ state: 'hidden' })
}

async function verifyComposerInteraction(page) {
  const textarea = page.getByRole('textbox', { name: '输入消息' })
  const toolbar = page.locator('.composer-toolbar')
  const initial = await composerGeometry(page)
  await textarea.fill(Array.from({ length: 18 }, (_, index) => `第 ${index + 1} 行用于验证输入框自动增高`).join('\n'))
  const expanded = await composerGeometry(page)
  invariant(expanded.textareaHeight > initial.textareaHeight, 'composer textarea did not grow with multiline content')
  invariant(expanded.textareaHeight <= 168, `composer textarea exceeded its cap (${expanded.textareaHeight})`)
  invariant(expanded.overflowY === 'auto', 'composer textarea did not switch to inner scrolling at its cap')
  invariant(expanded.toolbarTop >= expanded.textareaBottom, 'composer toolbar overlaps the text input')
  invariant(expanded.toolbarHeight === initial.toolbarHeight, 'composer toolbar changed height with message content')
  await page.screenshot({ path: join(output, 'desktop-standard-composer-expanded.png'), fullPage: false })
  await textarea.fill('')
  const collapsed = await composerGeometry(page)
  invariant(collapsed.textareaHeight <= 25, `composer textarea did not collapse after clearing (${collapsed.textareaHeight})`)

  const chooser = page.locator('.attachment-input')
  await chooser.setInputFiles(attachmentFixture)
  const attachment = page.locator('.attachment-item')
  await attachment.waitFor({ state: 'visible' })
  invariant(await attachment.locator('img[src^="blob:"]').count() === 1, 'selected image does not have a real browser preview')
  invariant((await attachment.innerText()).includes('icon-256.png'), 'selected image name is not visible')
  invariant(await toolbar.isVisible(), 'composer toolbar disappeared after adding an image')
  await page.screenshot({ path: join(output, 'desktop-standard-composer-image.png'), fullPage: false })
  await attachment.getByRole('button', { name: /移除/ }).click()
  await attachment.waitFor({ state: 'detached' })
}

async function verifySlashCommands(page) {
  const textarea = page.getByRole('textbox', { name: '输入消息' })
  await textarea.fill('/')
  const menu = page.getByRole('listbox', { name: '斜杠命令' })
  await menu.waitFor({ state: 'visible' })
  invariant(await menu.getByRole('option').count() === 8, 'slash menu does not expose the complete real command set')
  invariant(await textarea.getAttribute('aria-expanded') === 'true', 'slash menu is not exposed from the composer accessibility state')
  await settleMotion(page)
  await page.screenshot({ path: join(output, 'desktop-standard-slash-command.png'), fullPage: false })

  await textarea.fill('/mem')
  invariant(await menu.getByRole('option').count() === 1, 'slash command filtering is not deterministic')
  invariant(await menu.getByRole('option').first().getAttribute('data-command') === '/memory', 'slash command filtering selected the wrong action')
  await textarea.press('Enter')
  await menu.waitFor({ state: 'hidden' })
  invariant(await textarea.inputValue() === '', 'executed slash command text leaked into the model draft')
  invariant(await page.locator('#xsla-insp .itab', { hasText: '记忆' }).getAttribute('aria-selected') === 'true', 'slash command did not execute its real UI action')

  await textarea.fill('/missing')
  await menu.waitFor({ state: 'visible' })
  invariant((await menu.innerText()).includes('没有匹配'), 'slash menu does not explain an empty result')
  await textarea.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  await textarea.fill('')
  await page.locator('#xsla-insp .itab', { hasText: '状态' }).click()
}

async function composerGeometry(page) {
  return await page.evaluate(() => {
    const textarea = document.querySelector('.composer textarea')
    const toolbar = document.querySelector('.composer-toolbar')
    if (!(textarea instanceof HTMLTextAreaElement) || !(toolbar instanceof HTMLElement)) throw new Error('composer geometry target missing')
    const textBox = textarea.getBoundingClientRect()
    const toolbarBox = toolbar.getBoundingClientRect()
    return {
      textareaHeight: Math.round(textBox.height),
      textareaBottom: Math.round(textBox.bottom),
      overflowY: getComputedStyle(textarea).overflowY,
      toolbarTop: Math.round(toolbarBox.top),
      toolbarHeight: Math.round(toolbarBox.height),
    }
  })
}

async function verifyPanelResizing(page) {
  const sideSeparator = page.locator('[data-panel-resizer="side"]')
  const inspectorSeparator = page.locator('[data-panel-resizer="inspector"]')
  await assertVisible(sideSeparator, 'desktop-standard: left splitter is not visible')
  await assertVisible(inspectorSeparator, 'desktop-standard: right splitter is not visible')
  invariant(await sideSeparator.getAttribute('role') === 'separator', 'left splitter is missing separator semantics')
  invariant(await inspectorSeparator.getAttribute('role') === 'separator', 'right splitter is missing separator semantics')

  const initial = await measureLayout(page)
  await dragHorizontal(page, sideSeparator, 72)
  const afterSide = await measureLayout(page)
  invariant(afterSide.side.width >= initial.side.width + 64, `left splitter did not resize its rail (${initial.side.width} -> ${afterSide.side.width})`)
  invariant(Math.abs(afterSide.inspector.width - initial.inspector.width) <= 1, 'left splitter moved the inspector rail')

  await dragHorizontal(page, inspectorSeparator, -64)
  const afterBoth = await measureLayout(page)
  invariant(afterBoth.inspector.width >= afterSide.inspector.width + 56, `right splitter did not resize its rail (${afterSide.inspector.width} -> ${afterBoth.inspector.width})`)
  invariant(Math.abs(afterBoth.side.width - afterSide.side.width) <= 1, 'right splitter moved the session rail')
  invariant(afterBoth.chat.width >= 520, `splitters violated the central work-area minimum (${afterBoth.chat.width})`)

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('xsla-panel-widths-v1') ?? 'null'))
  invariant(stored?.side === afterBoth.side.width && stored?.inspector === afterBoth.inspector.width, `dragged widths were not persisted (${JSON.stringify(stored)})`)
  await page.screenshot({ path: join(output, 'desktop-standard-resized-rails.png'), fullPage: false })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.xsla-shell[data-xiaoshe-legacy-adapted]').waitFor({ state: 'visible' })
  const restored = await measureLayout(page)
  invariant(restored.side.width === afterBoth.side.width, `left width was lost after reload (${afterBoth.side.width} -> ${restored.side.width})`)
  invariant(restored.inspector.width === afterBoth.inspector.width, `right width was lost after reload (${afterBoth.inspector.width} -> ${restored.inspector.width})`)

  // Keyboard users receive the same live constraints. Enter restores the
  // density-tier defaults so the remaining visual suite starts deterministically.
  await page.locator('[data-panel-resizer="side"]').focus()
  await page.keyboard.press('ArrowRight')
  await settleMotion(page)
  const keyboardSide = await measureLayout(page)
  invariant(keyboardSide.side.width === restored.side.width + 8, 'left splitter keyboard step is not 8 px')
  await page.keyboard.press('Enter')
  await page.locator('[data-panel-resizer="inspector"]').focus()
  await page.keyboard.press('Enter')
  await settleMotion(page)
  const reset = await measureLayout(page)
  invariant(reset.side.width === 232 && reset.inspector.width === 292, `separator reset did not restore desktop defaults (${reset.side.width}/${reset.inspector.width})`)
}

async function dragHorizontal(page, locator, deltaX) {
  const box = await locator.boundingBox()
  invariant(box !== null, 'splitter has no drag geometry')
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + deltaX, startY, { steps: 8 })
  await page.mouse.up()
  await settleMotion(page)
}

async function verifySidebarManagement(page) {
  const workspace = page.locator('#xsla-side .proj[data-workspace-id]').first()
  const workspaceId = await workspace.getAttribute('data-workspace-id')
  invariant(workspaceId !== null, 'workspace management target is missing its stable id')
  const stableWorkspace = () => page.locator(`#xsla-side .proj[data-workspace-id="${workspaceId}"]`)
  const originalWorkspaceTitle = (await workspace.locator('.proj-name').innerText()).trim()
  const workspaceCandidate = `验收项目-${Date.now().toString().slice(-5)}`
  let workspaceChanged = false
  try {
    await openRowMenu(workspace.locator('.proj-head'), '项目操作')
    const workspaceMenu = page.getByRole('menu', { name: `${originalWorkspaceTitle} 项目操作` })
    invariant((await workspaceMenu.getByRole('menuitem').allInnerTexts()).join('|') === '新建会话|重命名项目|从侧栏移除', 'workspace action menu is incomplete')
    await workspaceMenu.getByRole('menuitem', { name: '重命名项目' }).click()
    const workspaceInput = workspace.locator('.side-rename-input')
    await workspaceInput.fill(workspaceCandidate)
    await workspaceInput.press('Enter')
    await workspace.locator('.proj-name', { hasText: workspaceCandidate }).waitFor()
    workspaceChanged = true
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.xsla-shell[data-xiaoshe-legacy-adapted]').waitFor({ state: 'visible' })
    await page.locator('#xsla-side .proj-name', { hasText: workspaceCandidate }).waitFor({ state: 'visible' })
    invariant(await page.locator('#xsla-side .proj-name', { hasText: workspaceCandidate }).count() === 1, 'workspace rename did not persist after reload')
  } finally {
    if (workspaceChanged) {
      const renamedWorkspace = stableWorkspace()
      await openRowMenu(renamedWorkspace.locator('.proj-head'), '项目操作')
      await page.getByRole('menuitem', { name: '重命名项目' }).click()
      // Keep locating by the stable entity id: entering edit mode intentionally
      // replaces `.proj-name`, so a title-filtered locator cannot see the input.
      const restoreInput = stableWorkspace().locator('.side-rename-input')
      await restoreInput.fill(originalWorkspaceTitle)
      await restoreInput.press('Enter')
      await stableWorkspace().locator('.proj-name', { hasText: originalWorkspaceTitle }).waitFor()
    }
  }

  const project = page.locator('#xsla-side .proj[data-workspace-id]').first()
  await openRowMenu(project.locator('.proj-head'), '项目操作')
  await page.getByRole('menuitem', { name: '从侧栏移除' }).click()
  const projectRemoval = page.getByRole('dialog', { name: /从侧栏移除/ })
  await projectRemoval.waitFor({ state: 'visible' })
  invariant((await projectRemoval.innerText()).includes('用户文件和会话日志都不会被删除'), 'workspace removal safety disclosure is missing')
  await projectRemoval.getByRole('button', { name: '取消' }).click()

  const sessionRows = page.locator('#xsla-side .sess-row')
  let session
  let originalSessionTitle = ''
  for (let index = 0; index < await sessionRows.count(); index += 1) {
    const candidate = sessionRows.nth(index)
    const title = (await candidate.locator('.prev').innerText()).trim()
    // Restoring through DSH must be lossless. Its durable title contract is
    // bounded by UTF-8 bytes, so do not mutate an older over-limit title.
    if (title !== '' && title !== '未命名任务' && Buffer.byteLength(title, 'utf8') <= 80) {
      session = candidate
      originalSessionTitle = title
      break
    }
  }
  invariant(session !== undefined, 'no named session is available for reversible rename acceptance')
  const sessionId = await session.getAttribute('data-session-id')
  invariant(sessionId !== null, 'session management target is missing its stable id')
  const compactSessionChrome = await session.evaluate(row => {
    const primary = row.querySelector('.sess')
    const menu = row.querySelector('.session-menu-trigger')
    if (!(primary instanceof HTMLElement) || !(menu instanceof HTMLElement)) return null
    return {
      rowHeight: Math.round(row.getBoundingClientRect().height),
      secondaryRows: row.querySelectorAll('.t2').length,
      menuOpacity: Number.parseFloat(getComputedStyle(menu).opacity),
      tooltip: primary.getAttribute('title') ?? '',
    }
  })
  invariant(compactSessionChrome !== null && compactSessionChrome.rowHeight <= 38, `session row is not compact (${JSON.stringify(compactSessionChrome)})`)
  invariant(compactSessionChrome.secondaryRows === 0, 'workspace path is still repeated as a second session row')
  invariant(compactSessionChrome.menuOpacity >= 0.65, 'session edit control is not persistently discoverable')
  invariant(compactSessionChrome.tooltip.includes(originalSessionTitle), 'compact session lost its full title tooltip')
  const stableSession = () => page.locator(`#xsla-side .sess-row[data-session-id="${sessionId}"]`)
  const sessionCandidate = `验收会话-${Date.now().toString().slice(-5)}`
  let sessionChanged = false
  try {
    await openRowMenu(session, '会话操作')
    const sessionMenu = page.getByRole('menu', { name: `${originalSessionTitle} 会话操作` })
    invariant((await sessionMenu.getByRole('menuitem').allInnerTexts()).join('|') === '重命名会话|归档并移出列表', 'session action menu is incomplete')
    const menuPlacement = await sessionMenu.evaluate(menu => {
      const side = document.querySelector('#xsla-side')
      if (!(side instanceof HTMLElement)) return null
      const menuBox = menu.getBoundingClientRect()
      const sideBox = side.getBoundingClientRect()
      const center = document.elementFromPoint(menuBox.x + menuBox.width / 2, menuBox.y + 12)
      return {
        menuLeft: Math.round(menuBox.left), menuRight: Math.round(menuBox.right),
        sideLeft: Math.round(sideBox.left), sideRight: Math.round(sideBox.right),
        centerOwned: center instanceof Element && center.closest('.side-action-menu') === menu,
      }
    })
    invariant(menuPlacement !== null && menuPlacement.menuLeft >= menuPlacement.sideLeft && menuPlacement.menuRight <= menuPlacement.sideRight, `session action menu escapes the sidebar (${JSON.stringify(menuPlacement)})`)
    invariant(menuPlacement.centerOwned, 'session action menu is visually covered by another region')
    await settleMotion(page)
    await page.screenshot({ path: join(output, 'desktop-standard-session-edit-menu.png'), fullPage: false })
    await sessionMenu.getByRole('menuitem', { name: '重命名会话' }).click()
    const sessionInput = session.locator('.side-rename-input')
    await sessionInput.fill(sessionCandidate)
    await sessionInput.press('Enter')
    await session.locator('.prev', { hasText: sessionCandidate }).waitFor()
    sessionChanged = true
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.xsla-shell[data-xiaoshe-legacy-adapted]').waitFor({ state: 'visible' })
    await page.locator('#xsla-side .prev', { hasText: sessionCandidate }).waitFor({ state: 'visible' })
    invariant(await page.locator('#xsla-side .prev', { hasText: sessionCandidate }).count() === 1, 'session rename did not persist after reload')
  } finally {
    if (sessionChanged) {
      const renamedSession = stableSession()
      await openRowMenu(renamedSession, '会话操作')
      await page.getByRole('menuitem', { name: '重命名会话' }).click()
      // As with projects, edit mode swaps out the title node. Re-resolve the
      // row by the immutable DSH session id before finding the input.
      const restoreInput = stableSession().locator('.side-rename-input')
      await restoreInput.fill(originalSessionTitle)
      await restoreInput.press('Enter')
      await stableSession().locator('.prev', { hasText: originalSessionTitle }).waitFor()
    }
  }

  const restoredSession = page.locator('#xsla-side .sess-row').filter({ has: page.locator('.prev', { hasText: originalSessionTitle }) }).first()
  await openRowMenu(restoredSession, '会话操作')
  await page.getByRole('menuitem', { name: '归档并移出列表' }).click()
  const sessionRemoval = page.getByRole('dialog', { name: /归档/ })
  await sessionRemoval.waitFor({ state: 'visible' })
  invariant((await sessionRemoval.innerText()).includes('记录仍由 DSH 保存'), 'session archive recovery disclosure is missing')
  await sessionRemoval.getByRole('button', { name: '取消' }).click()

  const sidebarChrome = await page.evaluate(() => {
    const list = document.querySelector('#xsla-side .sess-list')
    const add = document.querySelector('#xsla-side .side-add-session')
    const menu = document.querySelector('#xsla-side .proj-head > .side-menu-trigger')
    if (!(list instanceof HTMLElement) || !(add instanceof HTMLElement) || !(menu instanceof HTMLElement)) return null
    const addBox = add.getBoundingClientRect()
    const menuBox = menu.getBoundingClientRect()
    return {
      scrollLeft: list.scrollLeft,
      controlCenterDelta: Math.abs((addBox.top + addBox.height / 2) - (menuBox.top + menuBox.height / 2)),
      menuOpacity: Number.parseFloat(getComputedStyle(menu).opacity),
    }
  })
  invariant(sidebarChrome !== null && sidebarChrome.scrollLeft === 0, 'sidebar management caused horizontal drift')
  invariant(sidebarChrome.controlCenterDelta <= 1, 'workspace add and menu controls are not vertically aligned')
  invariant(sidebarChrome.menuOpacity >= 0.7, 'workspace management control is not persistently discoverable')
}

async function openRowMenu(container, suffix) {
  await container.hover()
  await container.getByRole('button', { name: new RegExp(`${suffix}$`) }).click()
}

async function measureLayout(page) {
  return await page.evaluate(() => {
    const rect = selector => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) return { x: 0, width: 0, display: 'missing' }
      const box = element.getBoundingClientRect()
      return { x: Math.round(box.x), width: Math.round(box.width), display: getComputedStyle(element).display }
    }
    const chat = rect('.chat')
    const stage = rect('.stage-empty')
    return {
      side: rect('#xsla-side'),
      chat,
      inspector: rect('#xsla-insp'),
      chatCenter: Math.round(chat.x + chat.width / 2),
      stageCenter: Math.round(stage.x + stage.width / 2),
    }
  })
}

async function assertVisible(locator, message) {
  invariant(await locator.isVisible(), message)
}

async function assertHidden(locator, message) {
  invariant(!(await locator.isVisible()), message)
}

async function clickExposedScrim(page, viewportHeight) {
  await page.getByRole('button', { name: '关闭浮层' }).waitFor({ state: 'visible' })
  // At 390 px the drawer deliberately leaves only a 12 px outer gutter, so
  // click that real exposed target instead of Playwright's covered center.
  await page.mouse.click(5, Math.round(viewportHeight / 2))
}

async function settleMotion(page) {
  await page.waitForTimeout(260)
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}
