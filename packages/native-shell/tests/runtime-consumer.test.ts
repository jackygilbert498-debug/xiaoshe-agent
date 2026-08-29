import { describe, expect, it } from 'vitest'
import { apply, heartbeatPresentation, pluginTransactionPresentation } from '../src/client/index.js'
import { contextFixture, reactFixture } from './fixture.js'

describe('native shell runtime consumer', () => {
  it('renders runtime state, receipt and native information architecture', () => {
    let component: (() => unknown) | undefined
    const ctx = contextFixture({ inject: (_name, setup) => setup(), register: (_options, value) => { component = value as () => unknown; return () => { component = undefined } } }, {
      currentSessionId: 's1', sessions: { s1: { state: 'completed', completionReceipt: { outcome: 'verified', sourceSeq: 9 } } },
    })
    const dispose = apply(ctx, reactFixture())
    const tree = JSON.stringify(component?.())
    expect(tree).toContain('data-xiaoshe-native-shell')
    expect(tree).toContain('巢册')
    expect(tree).toContain('任务结束 · 已验证')
    expect(tree).toContain('小蛇控制中心')
    expect(tree).toContain('2 条可用 · revision 4')
    expect(tree).toContain('全局 1 · 项目 1')
    expect(tree).not.toContain('data-xiaoshe-shell-probe')
    dispose()
    expect(component).toBeUndefined()
  })

  it('renders an answerable approval instead of leaving the task permanently blocked', () => {
    let component: (() => unknown) | undefined
    const ctx = contextFixture({ inject: (_name, setup) => setup(), register: (_options, value) => { component = value as () => unknown; return () => {} } })
    ctx.userApproval.getSnapshot = () => ({ approvals: [{ key: 'a:1', toolName: 'bash', reason: '需要执行命令' }] })
    const dispose = apply(ctx, reactFixture())
    const tree = JSON.stringify(component?.())
    expect(tree).toContain('等待确认：bash')
    expect(tree).toContain('仅允许一次')
    expect(tree).toContain('拒绝')
    dispose()
  })

  it('shows only memories visible to the current exact project query', () => {
    let component: (() => unknown) | undefined
    const ctx = contextFixture({ inject: (_name, setup) => setup(), register: (_options, value) => { component = value as () => unknown; return () => {} } })
    ctx.memoryLifecycle.getSnapshot = () => ({
      status: 'ready',
      memory: {
        revision: 5,
        counts: { active: 2, global: 1, project: 1, forgotten: 0, superseded: 1 },
        entries: [{ scope: 'global', state: 'active' }],
      },
    }) as never

    const dispose = apply(ctx, reactFixture())
    const tree = JSON.stringify(component?.())
    expect(tree).toContain('1 条可用 · revision 5')
    expect(tree).toContain('全局 1 · 项目 0')
    expect(tree).not.toContain('2 条可用 · revision 5')
    dispose()
  })

  it('derives background text only from the redacted heartbeat projection', () => {
    expect(heartbeatPresentation({ schemaVersion: 2, status: 'idle', running: false, checks: [] })).toEqual({
      status: 'idle',
      detail: '0 个检查 · 无任务运行',
      running: false,
    })
    expect(heartbeatPresentation({
      schemaVersion: 2,
      status: 'backoff',
      running: false,
      checks: [{ id: 'runtime', status: 'backoff', intervalMs: 60_000, failureCount: 2, nextRunAt: 12_000 }],
    })).toEqual({
      status: 'backoff',
      detail: 'runtime [backoff] · 失败 2 · 下次 12000',
      running: false,
    })
  })

  it('summarizes only Host transaction states without exposing commands', () => {
    expect(pluginTransactionPresentation({
      status: 'ready', pendingRequests: 0,
      transactions: [
        { state: 'healthy', action: 'add', packageName: '@x/a', profile: 'xiaoshe-managed-proof' },
        { state: 'rolled-back', action: 'update', packageName: '@x/b', profile: 'xiaoshe-managed-proof' },
        { state: 'healthy', action: 'remove', packageName: '@x/c', profile: 'xiaoshe-managed-proof' },
      ],
    })).toEqual({ total: 3, detail: 'healthy 2 · rolled-back 1' })
  })
})
