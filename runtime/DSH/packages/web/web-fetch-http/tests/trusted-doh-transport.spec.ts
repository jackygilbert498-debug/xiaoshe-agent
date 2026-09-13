import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ request: transport.request }))
import { resolveWithTrustedDoh } from '../src/trusted-doh.ts'

afterEach(() => { vi.unstubAllGlobals(); transport.request.mockReset() })

it('cancels and settles a hung sibling before returning a failed address-family query', async () => {
  const caller = new AbortController()
  let pending = 0
  transport.request.mockImplementation((options) => {
    const request = new EventEmitter() as EventEmitter & { end(): void }
    request.end = () => {
      const type = new URL(options.path, 'https://example.com').searchParams.get('type')
      if (type === '1') { queueMicrotask(() => request.emit('error', new Error('A lookup failed'))); return }
      pending++
      options.signal.addEventListener('abort', () => { pending--; request.emit('error', options.signal.reason) }, { once: true })
    }
    return request
  })
  try {
    await expect(resolveWithTrustedDoh('example.com', caller.signal)).rejects.toThrow('trusted DoH lookup failed')
    expect(pending).toBe(0)
    expect(caller.signal.aborted).toBe(false)
  } finally {
    caller.abort() // RED-path cleanup only; production must own sibling cleanup.
  }
})

it.each(['oversized', 'status', 'certificate'] as const)('rejects %s failures across both fixed endpoints', async (failure) => {
  const streams: Readable[] = []
  transport.request.mockImplementation((_options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end(): void }
    request.end = () => queueMicrotask(() => {
      if (failure === 'certificate') { request.emit('error', Object.assign(new Error('untrusted certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })); return }
      const incoming = Readable.from([Buffer.alloc(65537)]) as Readable & { statusCode: number }
      incoming.statusCode = failure === 'status' ? 302 : 200
      streams.push(incoming); callback(incoming)
    })
    return request
  })
  await expect(resolveWithTrustedDoh('example.com', new AbortController().signal)).rejects.toThrow('trusted DoH lookup failed')
  expect(transport.request).toHaveBeenCalledTimes(4)
  expect(new Set(transport.request.mock.calls.map(([options]) => options.hostname))).toEqual(new Set(['1.0.0.1', '1.1.1.1']))
  expect(streams.every(stream => stream.destroyed)).toBe(true)
})

it('uses only fixed IP HTTPS with verified service identity and caller cancellation', async () => {
  const fallbackFetch = vi.fn().mockRejectedValue(new Error('OS DNS must not be used'))
  vi.stubGlobal('fetch', fallbackFetch)
  const signal = new AbortController().signal
  transport.request.mockImplementation((options, callback) => {
    const request = new EventEmitter() as EventEmitter & { end(): void }
    request.end = () => queueMicrotask(() => {
      const type = Number(new URL(options.path, 'https://example.com').searchParams.get('type'))
      const incoming = Readable.from([Buffer.from(JSON.stringify({
        Status: 0, Question: [{ name: 'example.com', type }],
        Answer: type === 1 ? [{ name: 'example.com', type, data: '8.8.8.8' }] : [],
      }))]) as Readable & { statusCode: number }
      incoming.statusCode = 200
      callback(incoming)
    })
    return request
  })
  await expect(resolveWithTrustedDoh('example.com', signal)).resolves.toEqual([{ address: '8.8.8.8', family: 4 }])
  expect(fallbackFetch).not.toHaveBeenCalled()
  expect(transport.request).toHaveBeenCalledTimes(2)
  for (const [options] of transport.request.mock.calls) {
    expect(options).toMatchObject({ hostname: '1.0.0.1', servername: 'cloudflare-dns.com', rejectUnauthorized: true, agent: false })
    expect(options.signal.aborted).toBe(false)
    expect(options.headers.host).toBe('cloudflare-dns.com')
  }
})
