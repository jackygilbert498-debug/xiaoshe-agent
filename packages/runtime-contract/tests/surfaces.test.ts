import { describe, expect, it } from 'vitest'
import type { WorkSurfaceRegistry, WorkSurfaceRegistrySnapshot } from '../src/index.js'

describe('WorkSurfaceRegistry contract', () => {
  it('keeps the registry read-only and current-session scoped', () => {
    const snapshot: WorkSurfaceRegistrySnapshot = {
      sessionId: 's1',
      items: [{
        id: 's1:c1:web', sessionId: 's1', callId: 'c1', seq: 4, updatedAt: 10,
        type: 'web', title: '本地工具', source: 'http://127.0.0.1:3080/', status: 'ready', trust: 'loopback',
        capabilities: { embedded: true, interactive: true, refresh: true, externalOpen: true, copySource: true, pinnable: true },
        view: { kind: 'web', url: 'http://127.0.0.1:3080/', embed: 'loopback' },
      }],
    }
    const service: WorkSurfaceRegistry = { getSnapshot: () => snapshot, subscribe: () => () => {} }
    expect(service.getSnapshot()).toBe(snapshot)
    expect(service.getSnapshot().items[0]?.view.kind).toBe('web')
  })
})
