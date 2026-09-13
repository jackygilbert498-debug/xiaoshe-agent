import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import { Response } from 'undici'
import { installProxyFromEnvironment, proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { HttpFetchProvider } from '../src/provider.ts'
import { isSyntheticResolverAddress, publicHttpNetwork, resolvePublicAddresses } from '../src/network.ts'
import * as trustedDoh from '../src/trusted-doh.ts'

const limits = { maxResponseBytes: 32, maxBodyChars: 32, timeoutMs: 500, maxRedirects: 2, userAgent: 'security-test' }
const publicAnswer = [{ address: '8.8.8.8', family: 4 as const }]
const signal = () => new AbortController().signal
afterEach(() => { vi.restoreAllMocks() })

it('classifies exactly the synthetic IPv4 range, not neighboring or mapped addresses', () => {
  for (const address of ['198.18.0.0', '198.19.255.255']) expect(isSyntheticResolverAddress(address)).toBe(true)
  for (const address of ['198.17.255.255', '198.20.0.0', '::ffff:198.18.0.1', '198.18.999.1', 'example.test']) expect(isSyntheticResolverAddress(address)).toBe(false)
})

it('fails closed when trusted recovery returns no addresses', async () => {
  vi.spyOn(trustedDoh, 'resolveWithTrustedDoh').mockResolvedValue([])
  await expect(resolvePublicAddresses('example.test', signal(), async () => [{ address: '198.18.0.1', family: 4 }])).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
})

it('HTTP proxy preserves the original Host and retries only the validated address set', async () => {
  const attempts: Array<{ url: string | undefined; host: string | undefined }> = []
  const proxy = createServer((request, response) => {
    attempts.push({ url: request.url, host: request.headers.host })
    if (attempts.length === 1) { request.socket.destroy(); return }
    response.writeHead(200, { 'content-type': 'text/plain' }); response.end('ok')
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  const dispose = await installProxyFromEnvironment({ get: name => name === 'HTTP_PROXY' ? { value: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` } : undefined }, () => {})
  try {
    const resolver = vi.fn(async () => [...publicAnswer, { address: '1.1.1.1', family: 4 as const }])
    const provider = new HttpFetchProvider(limits, resolver)
    expect(await provider.fetch({ url: 'http://example.test:8080/page' })).toMatchObject({ body: { content: 'ok' } })
    expect(attempts).toEqual([{ url: 'http://8.8.8.8:8080/page', host: 'example.test:8080' }, { url: 'http://1.1.1.1:8080/page', host: 'example.test:8080' }])
    expect(resolver).toHaveBeenCalledTimes(1)
  } finally { await dispose(); await new Promise<void>(resolve => proxy.close(() => resolve())) }
})

it('recovers only a complete synthetic DNS set through trusted DoH', async () => {
  vi.spyOn(trustedDoh, 'resolveWithTrustedDoh').mockResolvedValue(publicAnswer)
  const answer = await resolvePublicAddresses('example.test', signal(), async () => [{ address: '198.18.0.1', family: 4 }, { address: '198.19.255.255', family: 4 }])
  expect(answer).toEqual(publicAnswer)
})

it.each([
  ['198.18.0.9', publicAnswer, publicAnswer],
  ['mixed.test', [{ address: '198.18.0.9', family: 4 }, ...publicAnswer], publicAnswer],
  ['private.test', [{ address: '198.18.0.9', family: 4 }, { address: '10.0.0.1', family: 4 }], publicAnswer],
  ['trusted-private.test', [{ address: '198.18.0.9', family: 4 }], [{ address: '127.0.0.1', family: 4 }]],
  ['trusted-mixed.test', [{ address: '198.18.0.9', family: 4 }], [...publicAnswer, { address: '10.0.0.1', family: 4 }]],
] as const)('rejects unsafe synthetic recovery for %s', async (hostname, os, trusted) => {
  const recover = vi.spyOn(trustedDoh, 'resolveWithTrustedDoh').mockResolvedValue(trusted as typeof publicAnswer)
  await expect(resolvePublicAddresses(hostname, signal(), async () => [...os])).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  expect(recover).toHaveBeenCalledTimes(hostname.startsWith('trusted-') ? 1 : 0)
})

it('rejects localhost names before DNS, even with a resolver returning a public address', async () => {
  const resolver = vi.fn(async () => publicAnswer)
  for (const hostname of ['localhost', 'localhost.', 'sub.localhost']) await expect(resolvePublicAddresses(hostname, signal(), resolver)).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  expect(resolver).not.toHaveBeenCalled()
})

it('pins each redirect after fresh DNS admission and blocks a private rebound', async () => {
  const dns = vi.fn().mockResolvedValueOnce(publicAnswer).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
  const transport = vi.spyOn(publicHttpNetwork, 'request').mockResolvedValue({ response: new Response(null, { status: 302, headers: { location: '/private' } }), close: async () => {} })
  const provider = new HttpFetchProvider(limits, (hostname, abort) => resolvePublicAddresses(hostname, abort, dns))
  await expect(provider.fetch({ url: 'https://example.test/' })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  expect(transport).toHaveBeenCalledTimes(1)
  expect(transport.mock.calls[0]?.[1]).toEqual(publicAnswer)
})

it('deadline and caller cancellation interrupt DNS without sending a request', async () => {
  const transport = vi.spyOn(publicHttpNetwork, 'request')
  const provider = new HttpFetchProvider({ ...limits, timeoutMs: 15 }, (hostname, abort) => resolvePublicAddresses(hostname, abort, async () => new Promise(() => {})))
  await expect(provider.fetch({ url: 'https://example.test/' })).rejects.toMatchObject({ code: 'WEB_FETCH_TIMEOUT' })
  const controller = new AbortController()
  const pending = provider.fetch({ url: 'https://example.test/' }, controller.signal)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  expect(transport).not.toHaveBeenCalled()
})

it('declared and streamed body caps preserve cleanup and truncation', async () => {
  const close = vi.fn(async () => {})
  const transport = vi.spyOn(publicHttpNetwork, 'request').mockResolvedValueOnce({ response: new Response('abcdef', { headers: { 'content-type': 'text/plain', 'content-length': '6' } }), close }).mockResolvedValueOnce({ response: new Response('abcdef', { headers: { 'content-type': 'text/plain' } }), close })
  const provider = new HttpFetchProvider({ ...limits, maxResponseBytes: 4 }, async () => publicAnswer)
  await expect(provider.fetch({ url: 'https://example.test/' })).rejects.toMatchObject({ code: 'WEB_FETCH_TOO_LARGE' })
  expect(await provider.fetch({ url: 'https://example.test/' })).toMatchObject({ body: { content: 'abcd' }, truncated: true })
  expect(close).toHaveBeenCalledTimes(transport.mock.calls.length)
})

it('NO_PROXY uses the current installed policy for suffix, port and IPv6 matches', async () => {
  for (const [bypass, url, expected] of [['*.example.com', 'https://api.example.com/', false], ['.example.com', 'https://example.com/', false], ['example.com:443', 'https://example.com/', false], ['example.com:4443', 'https://example.com/', true], ['[2001:4860:4860::8888]:443', 'https://[2001:4860:4860::8888]/', false], ['[2001:4860:4860::8888]:80', 'https://[2001:4860:4860::8888]/', true]] as const) {
    const dispose = await installProxyFromEnvironment({ get: name => name === 'HTTPS_PROXY' ? { value: 'http://127.0.0.1:9999' } : name === 'NO_PROXY' ? { value: bypass } : undefined }, () => {})
    try { expect(proxyRouteFor(new URL(url)).proxied).toBe(expected) } finally { await dispose() }
  }
})

it('HTTPS CONNECT pins authority and deadline closes a black-hole TLS tunnel', async () => {
  let authority = ''
  const sockets = new Set<Duplex>()
  const proxy = createServer()
  proxy.on('connect', (request, socket) => {
    authority = request.url ?? ''
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {})
    socket.once('end', () => socket.end())
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.resume()
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  const dispose = await installProxyFromEnvironment({ get: name => name === 'HTTPS_PROXY' ? { value: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` } : undefined }, () => {})
  try {
    const provider = new HttpFetchProvider({ ...limits, timeoutMs: 150 }, async () => publicAnswer)
    await expect(provider.fetch({ url: 'https://example.test/' })).rejects.toMatchObject({ code: 'WEB_FETCH_TIMEOUT' })
    expect(authority).toBe('8.8.8.8:443')
    await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1000 })
  } finally {
    for (const socket of sockets) socket.destroy()
    await dispose(); await new Promise<void>(resolve => proxy.close(() => resolve()))
  }
})
