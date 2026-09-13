/**
 * Narrow DNS-over-HTTPS recovery for fake-IP resolver environments.
 *
 * This module is not an alternate SSRF allow-list. The caller invokes it only
 * after the OS resolver returned an entirely synthetic RFC 2544 answer set,
 * then validates every address returned here with the ordinary public-address
 * policy before opening an IP-pinned target connection.
 */

import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import type { Dispatcher } from 'undici'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import type { PublicAddress as ResolvedFetchAddress } from './network.ts'

const TRUSTED_DOH_HOSTNAME = 'cloudflare-dns.com'
const TRUSTED_DOH_ADDRESSES = ['1.0.0.1', '1.1.1.1'] as const
const MAX_DOH_BODY_BYTES = 64 * 1024
const MAX_DOH_ANSWERS = 64

type DnsRecordType = 1 | 28

/**
 * Resolve both address families through a fixed TLS-authenticated DoH service.
 * Never resolve the recovery service through the resolver being recovered.
 * Fixed IP endpoints retain the service hostname for TLS verification.
 */
export async function resolveWithTrustedDoh(
  hostname: string,
  signal: AbortSignal,
): Promise<readonly ResolvedFetchAddress[]> {
  // A failed family must close its sibling before our caller releases its
  // deadline. Otherwise a quick rejection can leave an unbounded TLS request.
  const local = new AbortController()
  const combined = AbortSignal.any([signal, local.signal])
  const queries = [queryTrustedDoh(hostname, 1, combined), queryTrustedDoh(hostname, 28, combined)]
  let ipv4: readonly ResolvedFetchAddress[], ipv6: readonly ResolvedFetchAddress[]
  try {
    ;[ipv4, ipv6] = await Promise.all(queries) as [readonly ResolvedFetchAddress[], readonly ResolvedFetchAddress[]]
  } catch (error: unknown) {
    local.abort(error)
    await Promise.allSettled(queries)
    throw error
  }
  const unique = new Map<string, ResolvedFetchAddress>()
  for (const answer of [...ipv4, ...ipv6]) unique.set(`${answer.family}:${answer.address}`, answer)
  if (unique.size > MAX_DOH_ANSWERS) throw new Error('trusted DoH returned too many addresses')
  return [...unique.values()]
}

/** Parse and bind a DNS JSON reply to the exact question that was sent. */
export function parseTrustedDohResponse(
  hostname: string,
  type: DnsRecordType,
  text: string,
): readonly ResolvedFetchAddress[] {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (error: unknown) {
    throw new Error('trusted DoH returned invalid JSON', { cause: error })
  }
  if (!isRecord(payload) || payload.Status !== 0) throw new Error('trusted DoH query did not succeed')

  const questions = payload.Question
  if (!Array.isArray(questions) || questions.length !== 1) throw new Error('trusted DoH returned an invalid question')
  const question: unknown = questions[0]
  if (
    !isRecord(question)
    || normalizeDnsName(question.name) !== normalizeDnsName(hostname)
    || question.type !== type
  ) {
    throw new Error('trusted DoH response did not match the requested question')
  }

  const rawAnswers = payload.Answer ?? []
  if (!Array.isArray(rawAnswers) || rawAnswers.length > MAX_DOH_ANSWERS) {
    throw new Error('trusted DoH returned an invalid answer set')
  }
  const reachableNames = new Set<string>([hostname.toLowerCase().replace(/\.+$/u, '')])
  const aliases = new Map<string, string[]>()
  for (const rawAnswer of rawAnswers) {
    if (!isRecord(rawAnswer) || rawAnswer.type !== 5) continue
    const owner = normalizeDnsName(rawAnswer.name)
    const target = normalizeDnsName(rawAnswer.data)
    if (owner === undefined || target === undefined) throw new Error('trusted DoH returned a malformed CNAME')
    const targets = aliases.get(owner) ?? []
    targets.push(target)
    aliases.set(owner, targets)
  }
  // Answers can list a CNAME chain in any order, so compute the finite
  // transitive closure before admitting address records.
  for (let pass = 0; pass < rawAnswers.length; pass++) {
    let changed = false
    for (const [owner, targets] of aliases) {
      if (!reachableNames.has(owner)) continue
      for (const target of targets) {
        if (reachableNames.has(target)) continue
        reachableNames.add(target)
        changed = true
      }
    }
    if (!changed) break
  }

  const family = type === 1 ? 4 : 6
  const unique = new Map<string, ResolvedFetchAddress>()
  for (const rawAnswer of rawAnswers) {
    if (!isRecord(rawAnswer) || rawAnswer.type !== type) continue
    const owner = normalizeDnsName(rawAnswer.name)
    if (owner === undefined || !reachableNames.has(owner) || typeof rawAnswer.data !== 'string') {
      throw new Error('trusted DoH returned an unrelated or malformed address')
    }
    const address = rawAnswer.data.trim()
    if (isIP(address) !== family) throw new Error('trusted DoH returned a malformed address')
    unique.set(address, { address, family })
  }
  return [...unique.values()]
}

async function queryTrustedDoh(
  hostname: string,
  type: DnsRecordType,
  signal: AbortSignal,
): Promise<readonly ResolvedFetchAddress[]> {
  const url = new URL('https://cloudflare-dns.com/dns-query')
  url.searchParams.set('name', hostname)
  url.searchParams.set('type', String(type))

  const errors: unknown[] = []
  for (const address of TRUSTED_DOH_ADDRESSES) {
    signal.throwIfAborted()
    try {
      const text = await requestPinnedDoh(url, address, signal)
      return parseTrustedDohResponse(hostname, type, text)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      errors.push(error)
    }
  }
  throw new AggregateError(errors, 'trusted DoH lookup failed')
}

function requestPinnedDoh(url: URL, address: string, signal: AbortSignal): Promise<string> {
  // DNS recovery must honor the same installed proxy policy as the page fetch.
  // The proxy CONNECT destination remains a fixed trusted IP, never OS DNS.
  const route = proxyRouteFor(url)
  if (route.proxied) return requestProxiedDoh(url, address, route.proxy, signal)
  return new Promise<string>((resolve, reject) => {
    const request = httpsRequest({
      hostname: address,
      family: 4,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: TRUSTED_DOH_HOSTNAME,
      rejectUnauthorized: true,
      agent: false,
      maxHeaderSize: 16 * 1024,
      headers: {
        host: TRUSTED_DOH_HOSTNAME,
        accept: 'application/dns-json',
        'accept-encoding': 'identity',
      },
      signal,
    }, (incoming) => {
      if (incoming.statusCode !== 200) {
        incoming.destroy()
        reject(new Error(`trusted DoH returned HTTP ${String(incoming.statusCode)}`))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      incoming.on('data', (chunk: Buffer) => {
        total += chunk.byteLength
        if (total > MAX_DOH_BODY_BYTES) {
          incoming.destroy(new Error('trusted DoH response exceeded the body limit'))
          return
        }
        chunks.push(chunk)
      })
      incoming.once('end', () => { resolve(Buffer.concat(chunks, total).toString('utf8')) })
      incoming.once('error', reject)
    })
    request.once('error', reject)
    request.end()
  })
}

/** Fixed-IP DoH through the configured proxy; retain TLS identity and bound the response. */
async function requestProxiedDoh(url: URL, address: string, proxy: string, signal: AbortSignal): Promise<string> {
  const { ProxyAgent, fetch } = await import('undici')
  signal.throwIfAborted()
  const pinned = new URL(url)
  pinned.hostname = address
  // proxy-exempt: one fixed trusted resolver IP through the installed policy proxy.
  const dispatcher = new class extends ProxyAgent {
    override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      const headers = { accept: 'application/dns-json', 'accept-encoding': 'identity', host: TRUSTED_DOH_HOSTNAME }
      return super.dispatch({ ...options, headers }, handler)
    }
  }({
    uri: proxy,
    maxHeaderSize: 16 * 1024,
    requestTls: { servername: TRUSTED_DOH_HOSTNAME, rejectUnauthorized: true, signal },
    proxyTls: { rejectUnauthorized: true, signal },
  })
  const abort = () => { void dispatcher.destroy().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    // proxy-exempt: fixed IP and per-request dispatcher above; redirects are never followed.
    const response = await fetch(pinned, {
      method: 'GET', redirect: 'manual', signal, dispatcher,
      headers: { accept: 'application/dns-json', 'accept-encoding': 'identity' },
    })
    try {
      if (response.status !== 200) throw new Error(`trusted DoH returned HTTP ${response.status}`)
      const chunks: Uint8Array[] = []
      let total = 0
      if (response.body !== null) {
        for await (const rawChunk of response.body) {
          const chunk: unknown = rawChunk
          if (!(chunk instanceof Uint8Array)) throw new Error('trusted DoH returned a non-byte response')
          total += chunk.byteLength
          if (total > MAX_DOH_BODY_BYTES) throw new Error('trusted DoH response exceeded the body limit')
          chunks.push(chunk)
        }
      }
      return Buffer.concat(chunks, total).toString('utf8')
    } finally {
      await response.body?.cancel().catch(() => undefined)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await dispatcher.destroy()
  }
}

function normalizeDnsName(value: unknown): string | undefined {
  return typeof value === 'string' ? value.toLowerCase().replace(/\.+$/u, '') : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
