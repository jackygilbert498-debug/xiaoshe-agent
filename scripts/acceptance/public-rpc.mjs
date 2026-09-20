import { DshApiClient } from '../../packages/terminal-client/lib/api.js'
import { authenticatedOptions } from '../../packages/terminal-client/lib/options.js'

/** Acceptance owns a non-daily loopback Host; all RPC bytes use the product's single transport. */
export function acceptanceRpc(base, { authUrl = () => process.env.XIAOSHE_AUTH_URL, fetcher = fetch, onResponse } = {}) {
  const url = new URL(base)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.port === '3080'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('explicit isolated loopback origin required; daily port is forbidden')
  let client
  const getClient = () => {
    if (client) return client
    const supplied = typeof authUrl === 'function' ? authUrl() : authUrl
    if (!supplied) throw new Error('explicit same-origin XIAOSHE_AUTH_URL or owned Host login URL required')
    const options = authenticatedOptions({ baseUrl: url.origin }, supplied)
    client = new DshApiClient(options.baseUrl, fetcher, undefined, { onResponse })
    return client
  }
  return async (method, payload, signal = AbortSignal.timeout(20_000)) => getClient().call(method, payload, signal)
}

/** Parse only an official, canonical, same-origin login URL from an owned child's complete log line. */
export function ownedLoginUrl(line, base) {
  if (!base) return undefined
  const clean = line.replace(/\u001b\[[0-9;]*m/gu, '')
  for (const candidate of clean.matchAll(/https?:\/\/[^\s<>"']+/gu)) {
    try {
      const url = authenticatedOptions({ baseUrl: base }, candidate[0]).baseUrl
      const token = new URL(url).searchParams.get('token')
      if (Buffer.from(token, 'base64url').length === 32 && Buffer.from(token, 'base64url').toString('base64url') === token) return url
    } catch { /* A log URL is not authority unless it satisfies every binding. */ }
  }
  return undefined
}

/** Remove authentication query values before stdout/stderr enter an evidence buffer. */
export function redactLoginUrls(line) {
  return String(line).replace(/([?&])([^=&#\s"'<>\\]+)=([^&#\s"'<>\\]+)/gu, (match, separator, key) => {
    try { return decodeURIComponent(key).toLowerCase() === 'token' ? separator + 'token=[REDACTED]' : match }
    catch { return match }
  })
}
