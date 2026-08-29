import { describe, expect, it, vi } from 'vitest'
import { MemoryLifecycleProvider } from '../src/client/index.js'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const emptyMemory = {
  api_version: 1 as const,
  revision: 0,
  counts: { active: 0, global: 0, project: 0, forgotten: 0, superseded: 0 },
  entries: [],
  audit: [],
  usage: [],
}

describe('DOM-free memoryLifecycle Client service', () => {
  it('retains snapshot identity between updates and publishes immutable refresh replacement', async () => {
    const fetcher = vi.fn(async () => response(emptyMemory))
    const service = new MemoryLifecycleProvider(fetcher)
    const initial = service.getSnapshot()
    expect(service.getSnapshot()).toBe(initial)
    const listener = vi.fn()
    service.subscribe(listener)

    await service.refresh({ scope: 'project', project: 'C:\\XS', include_inactive: true })

    expect(fetcher).toHaveBeenCalledWith(
      '/api/xiaoshe/memory?scope=project&project=C%3A%5CXS&include_inactive=true',
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
    )
    expect(service.getSnapshot()).not.toBe(initial)
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', memory: emptyMemory })
    expect(Object.isFrozen(service.getSnapshot())).toBe(true)
    expect(Object.isFrozen(service.getSnapshot().memory)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(service.getSnapshot()).toBe(service.getSnapshot())
  })

  it('publishes mutation responses and reports bounded HTTP errors', async () => {
    const created = { ...emptyMemory, revision: 1, counts: { ...emptyMemory.counts, active: 1, global: 1 }, entries: [{ id: 'm1', scope: 'global', text: '中文', state: 'active', version: 1, created_at: '2026-08-25T00:00:00Z', updated_at: '2026-08-25T00:00:00Z' }] }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(created))
      .mockResolvedValueOnce(response({ error: 'revision changed', kind: 'MEMORY_REVISION_CONFLICT' }, 409))
    const service = new MemoryLifecycleProvider(fetcher)

    await expect(service.remember({ scope: 'global', text: '中文' }, 0)).resolves.toMatchObject({ revision: 1 })
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', memory: { revision: 1 } })
    await expect(service.setState('m1', 'forgotten', 0)).rejects.toThrow(/revision changed/)
    expect(service.getSnapshot()).toMatchObject({ status: 'error', error: { status: 409, kind: 'MEMORY_REVISION_CONFLICT' } })
  })

  it('aborts in-flight work and prevents late publication after disposal', async () => {
    let resolveFetch: ((value: Response) => void) | undefined
    const fetcher = vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      resolveFetch = resolve
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const service = new MemoryLifecycleProvider(fetcher)
    const listener = vi.fn()
    service.subscribe(listener)
    const pending = service.refresh()
    service.dispose()
    resolveFetch?.(response(emptyMemory))

    await expect(pending).rejects.toThrow(/aborted/i)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot().status).toBe('loading')
    await expect(service.refresh()).rejects.toThrow(/disposed/i)
  })
})
