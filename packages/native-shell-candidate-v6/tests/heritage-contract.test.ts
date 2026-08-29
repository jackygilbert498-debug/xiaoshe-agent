import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.js'
import { contextFixture, reactFixture } from './fixture.js'

describe('V6 Heritage shell contract', () => {
  it('renders the approved old-shell structure around authoritative Product facts', () => {
    let component: (() => unknown) | undefined
    const ctx = contextFixture({
      inject: (_name, setup) => setup(),
      register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } },
    }, {
      currentSessionId: 's1',
      sessions: { s1: { state: 'completed', completionReceipt: { outcome: 'verified', sourceSeq: 17 } } },
    })

    const dispose = apply(ctx, reactFixture())
    const tree = JSON.stringify(component?.())

    expect(tree).toContain('data-xiaoshe-shell-v6')
    expect(tree).toContain('"className":"app"')
    expect(tree).toContain('"className":"main"')
    expect(tree).toContain('"className":"side"')
    expect(tree).toContain('"className":"chat"')
    expect(tree).toContain('"className":"insp"')
    expect(tree).toContain('"className":"statusbar"')
    expect(tree).toContain('HARNESS · ATELIER')
    expect(tree).toContain('＋ 新会话')
    expect(tree).toContain('＋ 项目')
    expect(tree).toContain('搜索会话/项目')
    expect(tree).toContain('整理交接')
    expect(tree).toContain('C:\\\\work')
    expect(tree).toContain('任务结束 · 已验证')
    expect(tree).toContain('状态')
    expect(tree).toContain('记忆')
    expect(tree).toContain('系统')
    expect(tree).toContain('2 条可用')
    expect(tree).toContain('1 笔受控变更')
    expect(tree).toContain('小蛇 UI · 候选 V6')
    expect(tree).toContain('"data-theme":"light"')
    expect(tree).not.toContain('xsc-shell')
    expect(tree).not.toContain('巢册')
    expect(tree).not.toContain('脉册')

    dispose()
    expect(component).toBeUndefined()
  })
})
