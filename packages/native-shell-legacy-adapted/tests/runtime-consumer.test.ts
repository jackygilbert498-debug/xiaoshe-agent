import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  heartbeatPresentation,
  inject,
  contextPresentation,
  modelPresentation,
  modelRouteKey,
  parseModelRouteKey,
  pluginInventoryPresentation,
  pluginTransactionPresentation,
  validatePluginIntent,
} from '../src/client/index.js'

describe('Legacy-adapted public capability projections', () => {
  it('consumes the Product health service instead of reaching through plugin HTTP routes', () => {
    const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    expect(inject).toContain('productHealth')
    expect(source).toContain('ctx.productHealth.subscribe')
    expect(source).not.toContain("fetch('/api/xiaoshe/heartbeat")
    expect(source).not.toContain("fetch('/xiaoshe/desktop/status")
  })

  it('keeps heartbeat and plugin projections redacted and state based', () => {
    expect(heartbeatPresentation({ schemaVersion: 2, status: 'idle', running: false, checks: [] })).toEqual({
      status: '待命', detail: '没有后台检查在运行', running: false,
    })
    expect(heartbeatPresentation({
      schemaVersion: 2, status: 'healthy', running: false,
      checks: [{ id: 'runtime', status: 'healthy', intervalMs: 15_000, failureCount: 0, nextRunAt: 1_787_716_444_725 }],
    })).toMatchObject({ tone: 'ok', detail: expect.stringMatching(/下次 \d{2}:\d{2}:\d{2}$/u) })
    expect(heartbeatPresentation({
      schemaVersion: 2, status: 'lost', running: true,
      checks: [{ id: 'runtime', status: 'lost', intervalMs: 15_000, failureCount: 2 }],
    })).toMatchObject({ tone: 'warn', status: '连接中断' })
    expect(pluginTransactionPresentation({
      status: 'ready', pendingRequests: 0,
      transactions: [
        { state: 'healthy', action: 'add', packageName: '@x/a', profile: 'candidate' },
        { state: 'rolled-back', action: 'update', packageName: '@x/b', profile: 'candidate' },
      ],
    })).toEqual({ total: 2, detail: '运行正常 1 · 已回滚 1' })
    expect(pluginInventoryPresentation([
      { moduleName: 'xiaoshe-session-continuity', fiberPhase: 'active' },
      { moduleName: '@deepseek-ai/dsh-tool-session-query', fiberPhase: 'active' },
      { moduleName: '@xiaoshe/memory', fiberPhase: 'active' },
      { moduleName: '@xiaoshe/memory', fiberPhase: 'active' },
      { moduleName: '@dsh/ui-theme', fiberPhase: 'active' },
    ])).toEqual([
      { key: 'continuity', name: '会话连续性', description: '按工作区查找并回溯既往会话', instances: 2, active: 2 },
      { key: 'memory', name: '记忆', description: '长期偏好与项目事实', instances: 1, active: 1 },
      { key: 'appearance', name: '设置与外观', description: '主题、语言与设置中心', instances: 1, active: 1 },
    ])
  })

  it('accepts only explicit inactive managed-Profile plugin intents', () => {
    expect(validatePluginIntent({
      action: 'add', profile: 'xiaoshe-managed-lab', sourceKind: 'registry', source: '@x/demo@1.0.0',
    })).toEqual({ action: 'add', profile: 'xiaoshe-managed-lab', source: { kind: 'registry', spec: '@x/demo@1.0.0' } })
    expect(validatePluginIntent({
      action: 'remove', profile: 'xiaoshe-managed-lab', sourceKind: 'registry', source: '@x/demo',
    })).toEqual({ action: 'remove', profile: 'xiaoshe-managed-lab', packageName: '@x/demo' })
    expect(() => validatePluginIntent({
      action: 'add', profile: 'xiaoshe-native-shell-proof', sourceKind: 'registry', source: '@x/demo',
    })).toThrow(/受管扩展环境/)
  })

  it('presents canonical context/cache facts and keeps model ids opaque', () => {
    expect(contextPresentation({
      budget: { usedTokens: 64_000, capacityTokens: 128_000, ratio: 0.5, level: 'normal' },
      usage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 9_900, cacheWriteTokens: 5 },
      compactions: [{ key: 'c1' }],
    })).toMatchObject({ short: '上下文 64K / 128K · 50%', cacheHitRatio: 0.99, level: 'normal' })
    const route = modelRouteKey('deep/seek', 'v4/pro')
    expect(parseModelRouteKey(route)).toEqual({ provider: 'deep/seek', model: 'v4/pro' })
    expect(modelPresentation({
      status: 'ready', current: { provider: 'deepseek', model: 'v4-pro', reasoningEffort: 'high' }, routable: true,
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'v4-pro', name: 'DeepSeek V4 Pro', efforts: [] }] }], failures: [],
    })).toEqual({ value: 'DeepSeek V4 Pro', detail: '服务商 DeepSeek\n思考强度 高\n模型目录可用 · 服务商异常 0', routable: true })
  })
})
