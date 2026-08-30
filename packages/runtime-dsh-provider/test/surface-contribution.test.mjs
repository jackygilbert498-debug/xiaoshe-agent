import assert from 'node:assert/strict'
import test from 'node:test'
import { DshWorkSurfaceRegistry } from './.generated/client.mjs'

test('ephemeral feature surfaces merge into the current session and release cleanly', () => {
  const listeners = new Set()
  const sessions = {
    list: {
      getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: 'C:\\project' } } }),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    },
    binding: () => ({ session: { getSnapshot: () => ({ nodes: [] }), subscribe: () => () => undefined } }),
  }
  const registry = new DshWorkSurfaceRegistry(sessions)
  const surface = {
    id: 's1:feature:1', sessionId: 's1', callId: 'feature', seq: 1, updatedAt: 1,
    type: 'file', title: 'Feature file', status: 'ready', trust: 'workspace',
    capabilities: { embedded: true, interactive: false, refresh: false, externalOpen: false, copySource: false, pinnable: true },
    view: { kind: 'metadata', description: 'test' },
  }
  const release = registry.publishContribution('xiaoshe-test', 's1', [surface, { ...surface, id: 'other', sessionId: 's2' }])
  assert.deepEqual(registry.getSnapshot().items.map(row => row.id), ['s1:feature:1'])
  release()
  assert.deepEqual(registry.getSnapshot().items, [])
  registry.dispose()
})
