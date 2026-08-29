import { describe, expect, it, vi } from 'vitest'
import { ProductHealthProvider } from '../src/client/index.js'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const heartbeat = {
  schemaVersion: 2 as const,
  status: 'healthy',
  running: false,
  checks: [{ id: 'xiaoshe-product-runtime', status: 'healthy', intervalMs: 300_000, failureCount: 0 }],
}

const desktop = {
  api_version: 1 as const,
  product: '小蛇',
  version: '0.1.0',
  response_style: 'pragmatic',
  bridge: { state: 'ready', protocol: '1', platform: 'win32' },
  actions: { deployment_allowed: true, enabled: true, persistent: true },
  modlens_available: false,
  last_probe: { state: 'unknown', message: '尚未检测', checked_at: null },
}

describe('Product health Client service', () => {
  it('publishes one immutable aggregate snapshot from both capability sources', async () => {
    const fetcher = vi.fn(async (path: string) => response(path.includes('heartbeat') ? heartbeat : desktop))
    const service = new ProductHealthProvider(fetcher)
    const initial = service.getSnapshot()
    const listener = vi.fn()
    service.subscribe(listener)

    await expect(service.refresh()).resolves.toMatchObject({
      status: 'ready',
      value: { heartbeat: { schemaVersion: 2 }, desktop: { api_version: 1 } },
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/xiaoshe/heartbeat', expect.objectContaining({
      method: 'GET', cache: 'no-store', signal: expect.any(AbortSignal),
    }))
    expect(fetcher).toHaveBeenNthCalledWith(2, '/xiaoshe/desktop/status', expect.objectContaining({
      method: 'GET', cache: 'no-store', signal: expect.any(AbortSignal),
    }))
    expect(service.getSnapshot()).not.toBe(initial)
    expect(service.getSnapshot()).toBe(service.getSnapshot())
    expect(Object.isFrozen(service.getSnapshot())).toBe(true)
    expect(Object.isFrozen(service.getSnapshot().value)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('attributes a single-source failure without discarding the healthy source', async () => {
    const fetcher = vi.fn(async (path: string) => path.includes('heartbeat')
      ? response(heartbeat)
      : response({ error: '桌面桥离线', kind: 'BRIDGE_OFFLINE' }, 503))
    const service = new ProductHealthProvider(fetcher)

    await expect(service.refresh()).resolves.toMatchObject({
      status: 'degraded',
      value: { heartbeat: { status: 'healthy' } },
      errors: [{ source: 'desktop', status: 503, kind: 'BRIDGE_OFFLINE', message: '桌面桥离线' }],
    })
    expect('desktop' in (service.getSnapshot().value ?? {})).toBe(false)
  })

  it('rejects malformed or oversized source payloads and preserves the previous value', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(heartbeat))
      .mockResolvedValueOnce(response(desktop))
      .mockResolvedValueOnce(response({ schemaVersion: 2, status: 'healthy', running: false, checks: 'bad' }))
      .mockResolvedValueOnce(new Response('x'.repeat(256 * 1024 + 1)))
    const service = new ProductHealthProvider(fetcher)
    await service.refresh()

    await expect(service.refresh()).resolves.toMatchObject({
      status: 'error',
      value: { heartbeat: { schemaVersion: 2 }, desktop: { api_version: 1 } },
      errors: [
        { source: 'heartbeat', message: expect.stringMatching(/invalid|missing/iu) },
        { source: 'desktop', message: expect.stringMatching(/limit/iu) },
      ],
    })
  })

  it('aborts superseded work and prevents late publication after disposal', async () => {
    const pending: Array<(value: Response) => void> = []
    const fetcher = vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      pending.push(resolve)
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const service = new ProductHealthProvider(fetcher)
    const first = service.refresh()
    const second = service.refresh()
    expect(await first).toBe(service.getSnapshot())
    service.dispose()
    pending.splice(2).forEach(resolve => resolve(response(heartbeat)))
    await expect(second).resolves.toBe(service.getSnapshot())
    await expect(service.refresh()).rejects.toThrow(/disposed/iu)
  })
})
