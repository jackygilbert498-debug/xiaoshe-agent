import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT = resolve('client.js')

describe('xiaoshe product visual shell', () => {
  it('scopes a reversible light/dark theme to stable DSH contracts', async () => {
    const source = await readFile(CLIENT, 'utf8')

    expect(source).toContain("body[data-xiaoshe-shell] {")
    expect(source).toContain("body[data-xiaoshe-shell][data-ds-dark-theme]")
    expect(source).toContain("[data-conversation-scroll]")
    expect(source).toContain("[data-composer-seat]")
    expect(source).toContain("[data-composer-card]")
    expect(source).toContain("--xiaoshe-focus:")
    expect(source).toContain(":where(button, [role='button']):focus-visible")
    expect(source).toContain("outline: 1px solid var(--xiaoshe-focus)")
    expect(source).toContain("box-shadow: 0 0 0 3px var(--xiaoshe-focus-glow)")
    expect(source).toContain("[data-xiaoshe-tool-card]")
    expect(source).toContain("[data-xiaoshe-inspector]")
    expect(source).toContain("[data-xiaoshe-inspector-tabs]")
    expect(source).toContain("[data-xiaoshe-inspector-head]")
    expect(source).toContain("[data-xiaoshe-stage-header]")
    expect(source).toContain("[data-xiaoshe-stage-title]")
    expect(source).toContain("[data-xiaoshe-hero-brand]")
    expect(source).toContain("--xiaoshe-sheen-1:")
    expect(source).toContain("--xiaoshe-sheen-4:")
    expect(source).toContain('@keyframes stage-sheen')
    expect(source).toContain("--xiaoshe-active-mark-opacity:")
    expect(source).toContain("[data-xiaoshe-active-mark]")
    expect(source).toContain("[data-xiaoshe-hero-outline-mark]")
    expect(source).toContain("[data-xiaoshe-hero-description]")
    expect(source).toContain("[data-xiaoshe-hero-capabilities]")
    expect(source).toContain("[data-xiaoshe-inspector-collapse]")
    expect(source).toContain("[data-rail-collapsed='true']")
    expect(source).toContain("button[aria-label='收起侧边栏']")
    expect(source).toContain("[data-slot='root'] > div")
    expect(source).toContain('@media (max-width: 1180px)')
    expect(source).toContain("@media (max-width: 760px)")
    expect(source).toContain("@media (prefers-reduced-motion: reduce)")
    expect(source).toMatch(
      /\[data-xiaoshe-hero-word\][^{]*\{[^}]*background-size:\s*280% 100%;[^}]*animation:\s*stage-sheen 9s ease-in-out infinite;/s,
    )
    expect(source).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-xiaoshe-hero-word\][^{]*\{[^}]*animation-duration:\s*9s !important;[^}]*animation-iteration-count:\s*infinite !important;/s,
    )
    expect(source).toContain("document.body.setAttribute('data-xiaoshe-shell', 'product-v1')")
    expect(source).toContain("document.body.removeAttribute('data-xiaoshe-shell')")
  })

  it('replaces the shipped preview hero through slots and keeps a responsive inspector', async () => {
    const source = await readFile(CLIENT, 'utf8')

    expect(source).toContain("name: 'shell.overlay'")
    expect(source).toContain("id: 'xiaoshe-inspector'")
    expect(source).toContain("'data-xiaoshe-hero-kicker': '', translate: 'no' }, '小蛇待命 · DESKTOP AGENT'")
    expect(source).toContain("'data-xiaoshe-hero-description': '' }, '看懂你的屏幕，接手电脑里的任务；关键动作先问你，做完再验证。'")
    expect(source).toContain("'data-xiaoshe-stage-title': '' }, '新会话'")
    expect(source).toContain("'data-xiaoshe-hero-word': '' }, '小蛇'")
    expect(source).not.toContain("'data-xiaoshe-hero-logo': ''")
    expect(source).not.toContain("'data-xiaoshe-hero-glyph': 'xiao'")
    expect(source).not.toContain("'data-xiaoshe-hero-glyph': 'she'")
    expect(source).not.toContain("'data-xiaoshe-hero-ghost': ''")
    expect(source).toContain("'data-xiaoshe-active-mark': ''")
    expect(source).toContain('href: XIAOSHE_MARK_URL')
    expect(source).toContain('font-family: "Noto Serif SC", "Songti SC", serif')
    expect(source).toContain('background-clip: text')
    expect(source).toContain('var(--xiaoshe-sheen-1) 0%, var(--xiaoshe-sheen-2) 28%')
    expect(source).toContain('var(--xiaoshe-sheen-4) 62%, var(--xiaoshe-sheen-2) 78%')
    expect(source).toContain('var(--xiaoshe-sheen-1) 100%')
    expect(source).toContain("filter: 'url(#xiaoshe-hero-alpha-outline)'")
    expect(source).toContain("width: '300'")
    expect(source).toContain("height: '300'")
    expect(source).toContain("viewBox: '0 0 300 300'")
    expect(source).toContain("radius: '0.7'")
    expect(source).toContain("operator: 'dilate'")
    expect(source).toContain("operator: 'erode'")
    expect(source).toContain("in: 'SourceAlpha'")
    expect(source).toContain('filter: drop-shadow(0 4px 9px')
    expect(source).toContain("'data-xiaoshe-hero-capabilities': '', 'aria-label': '小蛇特点'")
    expect(source).toMatch(
      /\[data-xiaoshe-hero-brand\][^{]*\{[^}]*--xiaoshe-feature-track:\s*min\(420px, calc\(100vw - 48px\)\);/s,
    )
    expect(source).toMatch(
      /\[data-xiaoshe-hero-title\][^{]*\{[^}]*width:\s*var\(--xiaoshe-feature-track\);/s,
    )
    expect(source).toContain("ui.phaseKey === 'active' && ui.messages > 0")
    expect(source).toMatch(
      /\[data-xiaoshe-hero-capabilities\][^{]*\{[^}]*display:\s*grid;[^}]*width:\s*var\(--xiaoshe-feature-track\);[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s,
    )
    expect(source).toContain("...['看得见桌面', '真能动手做', '关键操作可控'].map")
    expect(source).not.toContain("'data-xiaoshe-quick-prompt': ''")
    expect(source).not.toContain("onClick: () => prefillPrompt(prompt.text)")
    expect(source).toContain("'aria-label': railCollapsed ? '展开工作台' : '收起工作台'")
    expect(source).toContain("new ResizeObserver(update)")
    expect(source).not.toContain("'data-xiaoshe-hero-badge': ''")
    expect(source).toContain("'data-xiaoshe-brand-subtitle': '', translate: 'no', lang: 'en'")
    expect(source).toContain("span:has(> [data-slot='conversation.hero.brand.mark']) ~ span")
    expect(source).toContain("div:has(> span > [data-slot='conversation.hero.brand.mark'])")
    expect(source).toContain('white-space: nowrap;')
    expect(source).toContain("'data-xiaoshe-inspector-close': ''")
    expect(source).toContain("'data-xiaoshe-inspector-title': '' }, '小蛇工作台'")
    expect(source).toContain("'data-state': bridgeReady ? 'ready' : status ? 'error' : 'loading'")
    expect(source).toContain("setInterval(refresh, 15000)")
    expect(source).toContain("'/xiaoshe/memory?scope=all&include_inactive=true")
    expect(source).toContain("'data-xiaoshe-memory-form': ''")
    expect(source).toContain("'data-xiaoshe-memory-item': ''")
    expect(source).toContain("'data-xiaoshe-memory-scope': ''")
    expect(source).toContain("'data-xiaoshe-panel-section': ''")
    expect(source).not.toContain("[data-xiaoshe-inspector-body] > [data-xiaoshe-panel-card]:first-child")
  })

  it('loads every mark from the approved legacy master instead of recreating an S', async () => {
    const source = await readFile(CLIENT, 'utf8')

    expect(source).toContain("'data-xiaoshe-brand-mark': ''")
    expect(source).toContain("var XIAOSHE_MARK_URL = '/xiaoshe/brand/favicon.svg?v=0.2.0'")
    expect(source).toContain('WebkitMaskImage: `url(${XIAOSHE_MARK_URL})`')
    expect(source).toContain('maskImage: `url(${XIAOSHE_MARK_URL})`')
    expect(source).toContain('href: XIAOSHE_MARK_URL')
    expect(source).toContain("{ name: 'sidebar.brand.mark', priority: -100 }")
    expect(source).toContain("{ name: 'sidebar.brand.name', priority: -100 }")
    expect(source).toContain("{ name: 'conversation.hero.brand.mark', priority: -100 }")
    expect(source).toContain('var brandIconHref = XIAOSHE_MARK_URL')
    expect(source).not.toContain('M16.8 6.8 C14.4 4.3 9.9 4.4')
    expect(source).not.toContain("strokeWidth: '4.45'")
    expect(source).not.toContain("maskUnits: 'userSpaceOnUse'")
    expect(source).not.toContain("content: 'S'")
    expect(source).not.toContain("h('circle', { cx: '16.3'")
    expect(source).not.toContain("borderRadius: `${Math.max(6, Math.round(size * 0.28))}px`")
  })

  it('uses the stable DSH runtime state instead of treating every active session as running', async () => {
    const source = await readFile(CLIENT, 'utf8')

    expect(source).toContain("[data-session-runtime-state]")
    expect(source).toContain("'awaiting-approval': '等待审批'")
    expect(source).toContain("'tool-running': '工具执行中'")
    expect(source).toContain("'waiting-model': '等待模型'")
    expect(source).toContain("'model-running': '模型运行中'")
    expect(source).toContain("stopped: '已停止'")
    expect(source).toContain("idle: '空闲'")
    expect(source).not.toContain("phaseKey === 'active'\n          ? '任务进行中'")
  })

  it('locks and clips the conversation viewport before the first turn', async () => {
    const source = await readFile(CLIENT, 'utf8')

    expect(source).toContain("body[data-xiaoshe-shell] [data-phase='hero'] [data-conversation-scroll]")
    expect(source).toMatch(
      /body\[data-xiaoshe-shell\] \[data-phase='hero'\] \[data-conversation-scroll\] \{[^}]*overflow:\s*hidden;[^}]*scrollbar-gutter:\s*auto;/s,
    )
    expect(source).not.toMatch(
      /body\[data-xiaoshe-shell\] \[data-phase='hero'\] \[data-conversation-scroll\] \{[^}]*overflow:\s*hidden auto;/s,
    )
    expect(source).toMatch(
      /body\[data-xiaoshe-shell\] \[data-phase='hero'\] \[data-composer-seat\] svg\[aria-hidden='true'\]\[viewBox='0 0 1051 468'\] \{[^}]*display:\s*none;/s,
    )
  })

  it('gives the inspector a persistent accessible horizontal resize boundary', async () => {
    const source = await readFile(CLIENT, 'utf8')

    expect(source).toContain("if (value === null || value === undefined || value === '') return 300")
    expect(source).toContain("globalThis.localStorage?.getItem('xiaoshe.inspector.width')")
    expect(source).toContain("globalThis.localStorage?.setItem('xiaoshe.inspector.width'")
    expect(source).toContain("'data-xiaoshe-inspector-resizer': ''")
    expect(source).toContain("role: 'separator'")
    expect(source).toContain("'aria-orientation': 'vertical'")
    expect(source).toContain("--xiaoshe-inspector-width")
    expect(source).toMatch(/\[data-xiaoshe-inspector-resizer\][^{]*\{[^}]*cursor:\s*col-resize;/s)
  })

  it('uses one panel glyph language and a compact left-aligned brand lockup', async () => {
    const source = await readFile(CLIENT, 'utf8')

    expect(source).toContain("'data-xiaoshe-panel-icon': ''")
    expect(source).not.toContain("railCollapsed ? '‹' : '›'")
    expect(source).toMatch(/\[data-xiaoshe-brand-name\][^{]*\{[^}]*align-items:\s*flex-start;[^}]*text-align:\s*left;/s)
    expect(source).toMatch(/\[data-xiaoshe-brand-subtitle\][^{]*\{[^}]*margin-top:\s*4px;/s)
  })

  it('balances the empty-state brand and composer lower in the middle canvas', async () => {
    const source = await readFile(CLIENT, 'utf8')

    expect(source).toContain('--xiaoshe-hero-balance-shift: clamp(24px, 3.2vh, 52px)')
    expect(source).toMatch(
      /\[data-phase='hero'\] \[data-composer-seat\][^{]*\{[^}]*top:\s*calc\(clamp\(94px, 12vh, 158px\) \+ var\(--xiaoshe-hero-balance-shift\)\);/s,
    )
    expect(source).toMatch(
      /\[data-phase='hero'\] div:has\(> span > \[data-slot='conversation\.hero\.brand\.mark'\]\)[^{]*\{[^}]*top:\s*calc\(clamp\(-156px, -12vh, -94px\) \+ var\(--xiaoshe-hero-balance-shift\)\);/s,
    )
  })

  it('keeps the workbench collapse control visually unboxed', async () => {
    const source = await readFile(CLIENT, 'utf8')

    expect(source).toMatch(
      /\[data-xiaoshe-inspector-collapse\][^{]*\{[^}]*border-color:\s*transparent;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
    )
  })

  it('gives the legal active-conversation mark a large quiet footprint', async () => {
    const source = await readFile(CLIENT, 'utf8')

    expect(source).toMatch(
      /\[data-xiaoshe-active-mark\][^{]*\{[^}]*width:\s*300px;[^}]*height:\s*300px;/s,
    )
  })
})
