import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { resolveWithTrustedDoh } from '../src/trusted-doh.ts'

it('sends real CONNECT only to fixed DoH IPs and cancels black-hole TLS tunnels without retrying', async () => {
  const authorities: string[] = []
  const sockets = new Set<Duplex>()
  const proxy = createServer((_request, response) => { response.writeHead(500).end() })
  proxy.on('connect', (request, socket) => {
    authorities.push(request.url ?? '')
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.once('end', () => socket.end())
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.resume()
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const dispose = await installProxyFromEnvironment({ get: name => name === 'HTTPS_PROXY' ? { value: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` } : undefined }, () => {})
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error('test deadline')) }, 500)
  try {
    await expect(resolveWithTrustedDoh('example.com', controller.signal)).rejects.toThrow('test deadline')
    expect(authorities).toEqual(['1.0.0.1:443', '1.0.0.1:443'])
    // Wait for the local TCP close events, independently of the provider's promise.
    await vi.waitFor(() => { expect(sockets.size).toBe(0) }, { timeout: 1000 })
  } finally {
    clearTimeout(timer)
    controller.abort()
    for (const socket of sockets) socket.destroy()
    await dispose()
    await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
  }
})
