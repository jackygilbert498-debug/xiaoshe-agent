import { afterEach, expect, it, vi } from 'vitest'
import { HttpFetchProvider } from '../src/provider.ts'
import { publicHttpNetwork } from '../src/network.ts'

const limits = { maxResponseBytes: 1000, maxBodyChars: 1000, timeoutMs: 1000, maxRedirects: 1, userAgent: 'test' }
afterEach(() => { vi.restoreAllMocks() })

it('identifies resolution failure and nested TLS cause without leaking proxy credentials', async () => {
  const provider = new HttpFetchProvider(limits, async () => {
    throw new AggregateError([Object.assign(new Error('https://user:password@proxy/?token=secret'), { code: 'CERT_HAS_EXPIRED' })], 'trusted DoH lookup failed')
  })
  const error: unknown = await provider.fetch({ url: 'https://example.com' }).catch((error: unknown) => error)
  if (!(error instanceof Error)) throw new Error('expected fetch error')
  expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  expect(error.message).toContain('DNS')
  expect(error.message).toContain('CERT_HAS_EXPIRED')
  expect(error.message).not.toMatch(/password|token=secret/)
})

it.each(['ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_PRX_TLS'])('retains %s for a failed pinned request without echoing transport messages', async (code) => {
  vi.spyOn(publicHttpNetwork, 'request').mockRejectedValue(new TypeError('secret-proxy-password', { cause: Object.assign(new Error('secret'), { code }) }))
  const provider = new HttpFetchProvider(limits, async () => [{ address: '8.8.8.8', family: 4 }])
  const error: unknown = await provider.fetch({ url: 'https://example.com' }).catch((error: unknown) => error)
  if (!(error instanceof Error)) throw new Error('expected fetch error')
  expect(error.message).toContain(code)
  expect(error.message).not.toContain('secret')
})
