import { describe, expect, it } from 'vitest'
import {
  heartbeatPresentation,
  pluginTransactionPresentation,
  validatePluginIntent,
} from '../src/client/index.js'

describe('V6 public capability projections', () => {
  it('keeps heartbeat and plugin projections redacted and state based', () => {
    expect(heartbeatPresentation({ schemaVersion: 2, status: 'idle', running: false, checks: [] })).toEqual({
      status: 'idle', detail: '0 个检查 · 无任务运行', running: false,
    })
    expect(pluginTransactionPresentation({
      status: 'ready', pendingRequests: 0,
      transactions: [
        { state: 'healthy', action: 'add', packageName: '@x/a', profile: 'candidate' },
        { state: 'rolled-back', action: 'update', packageName: '@x/b', profile: 'candidate' },
      ],
    })).toEqual({ total: 2, detail: 'healthy 1 · rolled-back 1' })
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
    })).toThrow(/受管非活动 Profile/)
  })
})
