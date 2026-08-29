import { describe, expect, it } from 'vitest'
import { CANDIDATE_CSS, apply, heartbeatPresentation, pluginTransactionPresentation, validatePluginIntent } from '../src/client/index.js'
import { contextFixture, reactFixture } from './fixture.js'

describe('independent Xiaoshe shell candidate', () => {
  it('renders the familiar conversation, task and workbench structure from authoritative services', () => {
    let component: (() => unknown) | undefined
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, { currentSessionId: 's1', sessions: { s1: { state: 'completed', completionReceipt: { outcome: 'verified', sourceSeq: 17 } } } })

    const dispose = apply(ctx, reactFixture())
    const tree = JSON.stringify(component?.())
    expect(tree).toContain('data-xiaoshe-shell-candidate')
    expect(tree).toContain('会话')
    expect(tree).toContain('任务过程')
    expect(tree).toContain('工作台')
    expect(tree).toContain('状态')
    expect(tree).toContain('记忆')
    expect(tree).toContain('系统')
    expect(tree).not.toContain('巢册')
    expect(tree).not.toContain('证据脊线')
    expect(tree).not.toContain('脉册')
    expect(tree).toContain('任务结束 · 已验证')
    expect(tree).toContain('2 条可用')
    expect(tree).toContain('1 笔受控变更')
    expect(tree).toContain('管理插件')
    expect(tree).toContain('切换为亮色主题')
    expect(tree).toContain('"data-theme":"dark"')
    expect(tree).not.toContain('data-xiaoshe-native-shell')
    dispose()
    expect(component).toBeUndefined()
  })

  it('uses one compact 32px control contract for both rail toggles', () => {
    expect(CANDIDATE_CSS).toMatch(/\.xsc-icon-button\{[^}]*width:32px;[^}]*height:32px/)
    let component: (() => unknown) | undefined
    const ctx = contextFixture({ inject: (_name, setup) => setup(), register: (_options, value) => { component = value as () => unknown; return () => {} } })
    const dispose = apply(ctx, reactFixture())
    const tree = JSON.stringify(component?.())
    expect(tree.match(/"className":"xsc-icon-button"/g)).toHaveLength(2)
    expect(tree).toContain('收起会话栏')
    expect(tree).toContain('收起工作台')
    dispose()
  })

  it('keeps the restrained detail system while restoring bounded V5 brand motion', () => {
    expect(CANDIDATE_CSS).toContain('--xsc-radius-sm:4px')
    expect(CANDIDATE_CSS).toContain('--xsc-radius-md:8px')
    expect(CANDIDATE_CSS).toContain('--xsc-radius-lg:12px')
    expect(CANDIDATE_CSS).not.toMatch(/font(?:-size)?:[^;}]*\b(?:8|9|10)px\b/)

    const radii = [...CANDIDATE_CSS.matchAll(/border-radius:([^;}]+)/g)].map(match => match[1]?.trim())
    expect(radii.length).toBeGreaterThan(0)
    expect(radii.every(value => value === '50%' || value?.startsWith('var(--xsc-radius-') === true)).toBe(true)

    expect(CANDIDATE_CSS.match(/linear-gradient\(/g) ?? []).toHaveLength(1)
    expect(CANDIDATE_CSS).not.toContain('box-shadow:0 24px 64px')
    expect(CANDIDATE_CSS).toContain('--xsc-sheen-1:#f0f4f1')
    expect(CANDIDATE_CSS).toContain('--xsc-sheen-4:#dbc788')
    expect(CANDIDATE_CSS).toMatch(/\.xsc-brand-mark,\.xsc-empty-word\{[^}]*animation:xsc-sheen 9s/)
    expect(CANDIDATE_CSS).toContain('@keyframes xsc-sheen')
    expect(CANDIDATE_CSS).toContain('@keyframes xsc-breathe')
    expect(CANDIDATE_CSS).toContain('@keyframes xsc-rise')
    expect(CANDIDATE_CSS).toMatch(/\.xsc-event\{[^}]*animation:xsc-rise/)
    expect(CANDIDATE_CSS).toMatch(/@media\(prefers-reduced-motion:reduce\)[\s\S]*animation:none!important/)

    let component: (() => unknown) | undefined
    const ctx = contextFixture({ inject: (_name, setup) => setup(), register: (_options, value) => { component = value as () => unknown; return () => {} } })
    const dispose = apply(ctx, reactFixture())
    expect(JSON.stringify(component?.())).not.toContain('LIVE')
    dispose()
  })

  it('keeps explicit desktop, drawer and compact-screen breakpoint contracts', () => {
    expect(CANDIDATE_CSS).toContain('@media(max-width:1180px)')
    expect(CANDIDATE_CSS).toMatch(/@media\(max-width:860px\)\{[^}]*grid-template-columns:52px minmax\(0,1fr\)/)
    expect(CANDIDATE_CSS).toMatch(/@media\(max-width:860px\)[\s\S]*\.xsc-pulse\{position:absolute/)
    expect(CANDIDATE_CSS).toContain('@media(max-width:620px)')
    expect(CANDIDATE_CSS).toContain('@media(prefers-reduced-motion:reduce)')
  })

  it('adapts the stage grid across standard, wide and ultrawide viewports', () => {
    expect(CANDIDATE_CSS).toContain('--xsc-nest-width:236px')
    expect(CANDIDATE_CSS).toContain('--xsc-pulse-width:292px')
    expect(CANDIDATE_CSS).toContain('--xsc-content-width:800px')
    expect(CANDIDATE_CSS).toMatch(/grid-template-columns:var\(--xsc-nest-width\) minmax\(0,1fr\) var\(--xsc-pulse-width\)/)
    expect(CANDIDATE_CSS).toContain('@media(min-width:1600px)')
    expect(CANDIDATE_CSS).toContain('--xsc-content-width:clamp(920px,58vw,1040px)')
    expect(CANDIDATE_CSS).toContain('@media(min-width:2200px)')
    expect(CANDIDATE_CSS).toContain('--xsc-content-width:1080px')
    expect(CANDIDATE_CSS).toContain('padding-inline:max(var(--xsc-stage-gutter),calc((100% - var(--xsc-content-width))/2))')
    expect(CANDIDATE_CSS).not.toContain('max-width:800px')
  })

  it('centers an empty task stage inside the remaining vertical workspace', () => {
    expect(CANDIDATE_CSS).toMatch(/\.xsc-flow\[data-empty=true\]\{[^}]*display:grid;[^}]*grid-template-rows:auto minmax\(0,1fr\)/)
    expect(CANDIDATE_CSS).toMatch(/\.xsc-empty\{[^}]*margin:0 auto/)

    let component: (() => unknown) | undefined
    const base = contextFixture({ inject: (_name, setup) => setup(), register: (_options, value) => { component = value as () => unknown; return () => {} } })
    const ctx = {
      ...base,
      taskTimeline: { ...base.taskTimeline, getSnapshot: () => ({ items: [] }) },
    }
    const dispose = apply(ctx, reactFixture())
    const tree = JSON.stringify(component?.())
    expect(tree).toContain('"data-empty":true')
    expect(tree).toContain('"type":"feMorphology"')
    expect(tree).toContain('/api/xiaoshe/candidate-brand-icon?v=')
    dispose()
  })

  it('keeps heartbeat and plugin projections redacted and state based', () => {
    expect(heartbeatPresentation({ schemaVersion: 2, status: 'idle', running: false, checks: [] })).toEqual({ status: 'idle', detail: '0 个检查 · 无任务运行', running: false })
    expect(pluginTransactionPresentation({ status: 'ready', pendingRequests: 0, transactions: [
      { state: 'healthy', action: 'add', packageName: '@x/a', profile: 'candidate' },
      { state: 'rolled-back', action: 'update', packageName: '@x/b', profile: 'candidate' },
    ] })).toEqual({ total: 2, detail: 'healthy 1 · rolled-back 1' })
  })

  it('accepts only explicit inactive managed-Profile plugin intents', () => {
    expect(validatePluginIntent({ action: 'add', profile: 'xiaoshe-managed-lab', sourceKind: 'registry', source: '@x/demo@1.0.0' })).toEqual({
      action: 'add', profile: 'xiaoshe-managed-lab', source: { kind: 'registry', spec: '@x/demo@1.0.0' },
    })
    expect(validatePluginIntent({ action: 'remove', profile: 'xiaoshe-managed-lab', sourceKind: 'registry', source: '@x/demo' })).toEqual({
      action: 'remove', profile: 'xiaoshe-managed-lab', packageName: '@x/demo',
    })
    expect(() => validatePluginIntent({ action: 'add', profile: 'xiaoshe-native-shell-proof', sourceKind: 'registry', source: '@x/demo' })).toThrow(/受管非活动 Profile/)
    expect(() => validatePluginIntent({ action: 'update', profile: 'ordinary', sourceKind: 'directory', source: 'C:\\candidate' })).toThrow(/受管非活动 Profile/)
  })
})
