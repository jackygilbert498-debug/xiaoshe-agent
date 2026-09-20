import { afterEach, expect, it, vi } from 'vitest'
import { resolveWithTrustedDoh } from '../src/trusted-doh.ts'

interface DispatchOptions { headers: Record<string, string> }
interface RequestOptions {
  redirect: string
  dispatcher: { dispatch(options: DispatchOptions, handler: unknown): boolean }
  signal: AbortSignal
}
const io = vi.hoisted(() => ({
  route: vi.fn<(url: URL) => { proxied: boolean; proxy: string }>(),
  request: vi.fn<(url: URL, init: RequestOptions) => Promise<Response>>(),
  dispatch: vi.fn<(options: DispatchOptions, handler: unknown) => boolean>(),
  destroy: vi.fn(), agents: [] as unknown[],
}))
vi.mock('@deepseek-ai/dsh-http-proxy', () => ({ proxyRouteFor: io.route }))
vi.mock('node:https', () => ({ request: () => { throw new Error('direct egress must not be attempted for a configured proxy route') } }))
vi.mock('undici', () => ({
  fetch: io.request,
  ProxyAgent: class {
    constructor(options: unknown) { io.agents.push(options) }
    dispatch(options: DispatchOptions, handler: unknown) { return io.dispatch(options, handler) }
    destroy() { io.destroy(); return Promise.resolve() }
  },
}))
afterEach(() => { vi.resetAllMocks(); io.agents.length = 0 })

function setup() {
  io.route.mockReturnValue({ proxied: true, proxy: 'http://user:secret@127.0.0.1:1234' })
  io.request.mockImplementation(async (url, init) => {
    const parsed = new URL(url)
    expect(parsed.hostname).toMatch(/^1\.(0\.0|1\.1)\.1$/)
    expect(init.redirect).toBe('manual')
    init.dispatcher.dispatch({ headers: { accept: 'application/dns-json' } }, {})
    const type = Number(parsed.searchParams.get('type'))
    return Response.json({ Status: 0, Question: [{ name: 'example.com', type }], Answer: type === 1 ? [{ name: 'example.com', type: 1, data: '8.8.8.8' }] : [] })
  })
}

it('recovers fake-IP DNS through the configured proxy with fixed IP, original Host and verified TLS identity', async () => {
  setup()
  await expect(resolveWithTrustedDoh('example.com', new AbortController().signal)).resolves.toEqual([{ address: '8.8.8.8', family: 4 }])
  expect(io.agents).toHaveLength(2)
  for (const options of io.agents) expect(options).toMatchObject({ uri: 'http://user:secret@127.0.0.1:1234', requestTls: { servername: 'cloudflare-dns.com', rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } })
  expect(io.dispatch.mock.calls.every(([options]) => options.headers.host === 'cloudflare-dns.com')).toBe(true)
  expect(io.destroy).toHaveBeenCalledTimes(2)
})

it.each(['redirect', 'oversized'])('rejects %s DoH responses over the proxy and releases each dispatcher', async (mode) => {
  setup()
  io.request.mockImplementation(async () => mode === 'redirect' ? new Response(null, { status: 302, headers: { location: 'https://untrusted.example' } }) : new Response('x'.repeat(65537)))
  const caught: unknown = await resolveWithTrustedDoh('example.com', new AbortController().signal).catch((error: unknown) => error)
  expect(caught).toMatchObject({ message: 'trusted DoH lookup failed' })
  // One failed family may abort its sibling before the sibling's dynamic import settles.
  expect(io.agents.length).toBeGreaterThanOrEqual(2)
  expect(io.agents.length).toBeLessThanOrEqual(4)
  expect(io.destroy).toHaveBeenCalledTimes(io.agents.length)
})

it('cancels an in-flight proxy lookup without attempting another fixed IP', async () => {
  setup()
  const controller = new AbortController()
  io.request.mockImplementation(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { reject(new Error('caller cancelled')) }, { once: true })
  }))
  const operation = resolveWithTrustedDoh('example.com', controller.signal)
  void operation.catch(() => undefined)
  await vi.waitFor(() => { expect(io.request).toHaveBeenCalledTimes(2) })
  controller.abort(new Error('caller cancelled'))
  await expect(operation).rejects.toThrow('caller cancelled')
  expect(io.request).toHaveBeenCalledTimes(2)
  expect(io.agents).toHaveLength(2)
})
