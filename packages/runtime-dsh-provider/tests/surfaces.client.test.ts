import { describe, expect, it } from 'vitest'
import {
  DshWorkSurfaceRegistry,
  isLoopbackHost,
  projectDshWorkSurfaces,
  safeSurfaceUrl,
} from '../src/client/surfaces.js'

describe('DSH WorkSurfaceRegistry provider', () => {
  it('allows only credential-free exact loopback HTTP(S) pages to embed', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('localhost.evil.example')).toBe(false)
    expect(safeSurfaceUrl('http://127.0.0.1:3080/tool?q=ok')).toMatchObject({
      url: 'http://127.0.0.1:3080/tool?q=ok', trust: 'loopback', embed: 'loopback',
    })
    expect(safeSurfaceUrl('https://example.com/tool')).toMatchObject({
      url: 'https://example.com/tool', trust: 'external', embed: 'external-only',
    })
    const sensitive = safeSurfaceUrl('http://127.0.0.1:3080/?token=secret-value#private')
    expect(sensitive).toMatchObject({ trust: 'loopback', embed: 'blocked' })
    expect(sensitive.url).toBeUndefined()
    expect(sensitive.displayUrl).not.toContain('secret-value')
    expect(safeSurfaceUrl('file:///etc/passwd')).toMatchObject({ embed: 'blocked', trust: 'unknown' })
  })

  it('projects replayable web, terminal, read, diff and media tool results', () => {
    const items = projectDshWorkSurfaces('s1', '/work', {
      nodes: [
        result('web', 10, {
          call: { name: 'web_fetch', argsRaw: '{}' },
          resultView: { card: 'web', kind: 'fetch', url: 'http://127.0.0.1:6187/' },
        }),
        result('term', 20, {
          call: { name: 'bash', argsRaw: '{}' },
          callView: { card: 'terminal', title: 'pnpm dev', cwd: '/work' },
          resultView: { card: 'terminal', output: 'ready http://localhost:4123/app', exitCode: 0 },
        }),
        result('read', 30, {
          call: { name: 'read', argsRaw: '{}' },
          resultView: { card: 'read', title: 'Read src/a.ts', path: 'src/a.ts', offset: 4, totalLines: 8, lang: 'ts', lines: [{ number: 4, text: 'export {}' }] },
        }),
        result('diff', 40, {
          call: { name: 'edit', argsRaw: '{}' },
          resultView: { card: 'diff', title: 'Edit src/a.ts', diffs: [{ path: '/work/src/a.ts', oldText: 'a', newText: 'b' }] },
        }),
        result('screen', 50, {
          call: { name: 'screen_observe', argsRaw: '{}' },
          content: [{ type: 'image', mediaType: 'image/png', data: 'AQ==' }],
        }),
      ],
    })
    expect(items.map(item => [item.type, item.status])).toEqual([
      ['web', 'ready'], ['terminal', 'ready'], ['web', 'ready'], ['file', 'ready'], ['file', 'ready'], ['desktop', 'ready'],
    ])
    expect(items.find(item => item.id.endsWith(':read'))).toMatchObject({
      source: 'src/a.ts', trust: 'workspace', view: { kind: 'text', totalLines: 8, truncated: false },
    })
    expect(items.find(item => item.id.endsWith(':diff'))).toMatchObject({ trust: 'workspace', view: { kind: 'diff' } })
    expect(items.find(item => item.type === 'desktop')).toMatchObject({ view: { kind: 'media', mediaType: 'desktop' } })
  })

  it('bounds retained surface count and text payloads', () => {
    const nodes = Array.from({ length: 40 }, (_, index) => result(`c${index}`, index, {
      call: { name: 'bash', argsRaw: '{}' },
      callView: { card: 'terminal', title: `run ${index}`, cwd: '/work' },
      resultView: { card: 'terminal', output: 'x'.repeat(300_000), exitCode: 0 },
    }))
    const items = projectDshWorkSurfaces('s1', '/work', { nodes })
    expect(items).toHaveLength(24)
    const terminal = items.at(-1)
    expect(terminal?.view).toMatchObject({ kind: 'terminal', truncated: true })
    if (terminal?.view.kind !== 'terminal') throw new Error('expected terminal surface')
    expect(new TextEncoder().encode(terminal.view.output).byteLength).toBeLessThanOrEqual(256 * 1024 + 3)
  })

  it('rebinds across sessions, publishes new snapshots and releases subscriptions', () => {
    const fixture = registryFixture()
    const registry = new DshWorkSurfaceRegistry(fixture.sessions)
    const seen: string[] = []
    const release = registry.subscribe(() => { seen.push(registry.getSnapshot().sessionId ?? 'none') })
    expect(registry.getSnapshot()).toMatchObject({ sessionId: 's1', items: [{ type: 'web' }] })
    fixture.switchTo('s2')
    expect(registry.getSnapshot()).toMatchObject({ sessionId: 's2', items: [{ type: 'file' }] })
    expect(seen).toContain('s2')
    release()
    registry.dispose()
    expect(fixture.subscriptionCount()).toBe(0)
    expect(() => registry.subscribe(() => {})).toThrow('disposed')
  })
})

function result(callId: string, seq: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { kind: 'tool-result', callId, seq, time: 1_000 + seq, isError: false, content: [], subCalls: [], ...extra }
}

function registryFixture() {
  let current = 's1'
  const listListeners = new Set<() => void>()
  const faceListeners = { s1: new Set<() => void>(), s2: new Set<() => void>() }
  const snapshots = {
    s1: { nodes: [result('web', 1, { call: { name: 'web_fetch' }, resultView: { card: 'web', kind: 'fetch', url: 'http://127.0.0.1:3000/' } })] },
    s2: { nodes: [result('read', 2, { call: { name: 'read' }, resultView: { card: 'read', path: 'README.md', lines: [], totalLines: 0 } })] },
  }
  const sessions = {
    list: {
      getSnapshot: () => ({ current, byId: { s1: { cwd: '/one' }, s2: { cwd: '/two' } } }),
      subscribe(listener: () => void) { listListeners.add(listener); return () => { listListeners.delete(listener) } },
    },
    binding(id: string) {
      if (id !== 's1' && id !== 's2') return undefined
      return { session: {
        getSnapshot: () => snapshots[id],
        subscribe(listener: () => void) { faceListeners[id].add(listener); return () => { faceListeners[id].delete(listener) } },
      } }
    },
  }
  return {
    sessions,
    switchTo(id: 's1' | 's2') { current = id; for (const listener of listListeners) listener() },
    subscriptionCount() { return listListeners.size + faceListeners.s1.size + faceListeners.s2.size },
  }
}
