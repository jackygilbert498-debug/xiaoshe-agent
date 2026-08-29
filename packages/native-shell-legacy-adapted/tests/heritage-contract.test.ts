import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.js'
import { contextFixture, reactFixture } from './fixture.js'

describe('Legacy-adapted Heritage shell contract', () => {
  it('renders the approved old-shell structure around authoritative Product facts', () => {
    let component: (() => unknown) | undefined
    const baseContext = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, {
      currentSessionId: 's1',
      sessions: { s1: { state: 'completed', completionReceipt: { outcome: 'verified', sourceSeq: 17 } } },
    })
    const ctx = {
      ...baseContext,
      taskTimeline: { ...baseContext.taskTimeline, getSnapshot: () => ({ items: [] }) },
    }

    const dispose = apply(ctx, reactFixture())
    const tree = JSON.stringify(component?.())

    expect(tree).toContain('data-xiaoshe-legacy-adapted')
    expect(tree).toContain('"className":"app"')
    expect(tree).toContain('"className":"main"')
    expect(tree).toContain('"className":"side"')
    expect(tree).toContain('"className":"chat"')
    expect(tree).toContain('"className":"insp"')
    expect(tree).toContain('"className":"statusbar"')
    expect(tree).toContain('HARNESS · ATELIER')
    expect(tree).toContain('/api/xiaoshe/legacy-adapted-brand-raster?v=')
    expect(tree).toContain('xsla-stage-icon-outline')
    expect(tree).toContain('feMorphology')
    expect(tree.match(/"radius":"\.4"/gu)).toHaveLength(2)
    expect(tree).toContain('＋ 新会话')
    expect(tree).toContain('＋ 项目')
    expect(tree).toContain('搜索会话/项目')
    expect(tree).toContain('整理交接')
    expect(tree).toContain('C:\\\\work')
    expect(tree).toContain('任务结束 · 已验证')
    expect(tree).toContain('状态')
    expect(tree).toContain('记忆')
    expect(tree).toContain('能力')
    expect(tree).toContain('2 条可用')
    expect(tree).toContain('1 笔受控变更')
    expect(tree).toContain('小蛇桌面端')
    expect(tree).toContain('DeepSeek V4 Pro')
    expect(tree).toContain('工作区')
    expect(tree).toContain('上下文 72K / 128K · 56%')
    expect(tree).toContain('缓存读取 99K')
    expect(tree).toContain('权限：工作区写入')
    expect(tree).not.toContain('打开命令面板')
    expect(tree).not.toContain('允许一次 · N 拒绝')
    expect(tree).toContain('"data-theme":"ink-jade"')
    expect(tree).not.toContain('工具 0/60')
    expect(tree).not.toContain('y/n/a/p')
    expect(tree).not.toContain('xsc-shell')
    expect(tree).not.toContain('巢册')
    expect(tree).not.toContain('脉册')

    dispose()
    expect(component).toBeUndefined()
  })
})
