import { expect, it } from 'vitest'
import { DeepSeekSearchProvider } from '../src/provider.ts'

const options = { apiKey: 'secret-api-key', baseURL: 'https://api.example.com/v1', model: 'model', apiVersion: '2023-06-01', maxTokens: 32, maxUses: 1 }
const fault = (code: string) => new TypeError('fetch failed secret-api-key', { cause: Object.assign(new Error('https://user:password@proxy.test/?token=secret'), { code }) })
async function failure(transport: typeof fetch, baseURL = options.baseURL): Promise<Error> {
  return new DeepSeekSearchProvider(() => ({ ...options, baseURL }), transport).search({ query: 'q' }).then(() => { throw new Error('expected failure') }, (error: unknown) => {
    if (!(error instanceof Error)) throw new Error('expected Error instance')
    return error
  })
}

it.each([
  ['ENOTFOUND', 'DNS'], ['CERT_HAS_EXPIRED', 'TLS'], ['ECONNRESET', 'transport'],
  ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['UND_ERR_PRX_TLS', 'proxy'],
])('retains %s as bounded diagnostics without treating transport failure as endpoint configuration failure', async (code, category) => {
  const error = await failure(async () => { throw fault(code) })
  expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  expect(error.message).toContain(category)
  expect(error.message).toContain(code)
  expect(error.message).not.toMatch(/Settings >|change and save|secret-api-key|password|token=secret/)
  expect(error.message).toContain('does not establish')
})

it.each([[401, 'authentication'], [403, 'authorization'], [429, 'rate limit'], [503, 'server'], [404, 'HTTP']])('classifies HTTP %i without echoing the untrusted response', async (status, category) => {
  const error = await failure(async () => Response.json({ error: { message: 'secret-api-key user:password token=secret' } }, { status }))
  expect(error.message).toContain(`HTTP ${status}`)
  expect(error.message).toContain(category)
  expect(error.message).not.toMatch(/secret-api-key|password|token=secret|Settings >/)
})

it('does not expose malformed success bodies or credential-bearing endpoint details', async () => {
  const error = await failure(async () => new Response('secret-api-key invalid JSON'), 'https://user:password@api.example.com/secret-api-key?token=secret')
  expect(error.message).toContain('invalid response')
  expect(error.message).not.toMatch(/secret-api-key|password|token=secret/)
})

it('bounds cyclic aggregate causes and ignores arbitrary codes', async () => {
  const cause: Error & { code: string } = Object.assign(new Error('secret-api-key'), { code: 'secret-api-key' })
  cause.cause = cause
  const error = await failure(async () => { throw new AggregateError([cause, fault('ENOTFOUND')], 'secret-api-key') })
  expect(error.message).toContain('ENOTFOUND')
  expect(error.message).not.toContain('secret-api-key')
  expect(error.message.length).toBeLessThan(1500)
})

it('preserves a successful result when the next identical search suffers a transport failure', async () => {
  let calls = 0
  const provider = new DeepSeekSearchProvider(() => options, async () => {
    if (++calls > 1) throw fault('ECONNRESET')
    return Response.json({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://source.example/' }] }] })
  })
  const result = await provider.search({ query: 'q' })
  await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  expect(result.sources).toEqual([{ url: 'https://source.example/' }])
})

it('classifies a dropped success-body stream as transport failure, not malformed JSON', async () => {
  const error = await failure(async () => new Response(new ReadableStream({ start(controller) { controller.error(fault('ECONNRESET')) } })))
  expect(error.message).toContain('ECONNRESET')
  expect(error.message).toContain('transport')
  expect(error.message).not.toContain('invalid response')
})

it('does not consume unbounded HTTP error bodies after receiving the status', async () => {
  let cancelled = false
  const operation = failure(async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 503 }))
  const error = await Promise.race([operation, new Promise<Error>((resolve) => { setTimeout(() => { resolve(new Error('status handling hung')) }, 100) })])
  expect(error.message).toContain('HTTP 503')
  expect(cancelled).toBe(true)
})

it('redacts credential backend failures before transport dispatch', async () => {
  const provider = new DeepSeekSearchProvider(() => ({ ...options, apiKey: '', resolveApiKey: async () => { throw new Error('secret-api-key https://user:password@vault') } }))
  const error: unknown = await provider.search({ query: 'q' }).catch((error: unknown) => error)
  if (!(error instanceof Error)) throw new Error('expected credential error')
  expect(error.message).toContain('credential resolution failed')
  expect(error.message).not.toMatch(/secret-api-key|password/)
})
