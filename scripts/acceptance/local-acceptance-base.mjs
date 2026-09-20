const DEFAULT_ACCEPTANCE_BASE_URL = 'http://127.0.0.1:3080'

/**
 * Resolve the local Xiaoshe service used by live acceptance.
 *
 * Acceptance may use an isolated dynamic port, but it must never be redirected
 * to a remote host where the test could mutate an unrelated service.
 */
export function resolveLocalAcceptanceBase(value = process.env.XIAOSHE_ACCEPTANCE_BASE_URL) {
  const candidate = typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : DEFAULT_ACCEPTANCE_BASE_URL
  let url
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('XIAOSHE_ACCEPTANCE_BASE_URL must be a valid HTTP loopback URL')
  }
  const hostname = url.hostname.toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('XIAOSHE_ACCEPTANCE_BASE_URL must be an origin-only HTTP loopback URL')
  }
  return url.origin
}

/**
 * Bind a live RPC result to both the HTTP response and the request identity.
 * A stale JSON body or a proxy-generated success envelope must never count as
 * evidence for the current acceptance action.
 */
export function unwrapLocalAcceptanceRpcResponse(response, body, { method, rpcId }) {
  if (response?.ok !== true) {
    throw new Error(`${method}: HTTP ${Number.isInteger(response?.status) ? response.status : 'error'}`)
  }
  if (body?.type !== 'server-response' || body?.rpcId !== rpcId
    || body.result === null || typeof body.result !== 'object' || Array.isArray(body.result)
    || typeof body.result.ok !== 'boolean') {
    throw new Error(`${method}: invalid or mismatched response envelope`)
  }
  if (!body.result.ok) throw new Error(`${method}: ${body.result.error?.message ?? 'RPC failed'}`)
  return body.result.value
}
