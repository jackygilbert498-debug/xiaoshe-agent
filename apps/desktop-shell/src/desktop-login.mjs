/** Validate an already-owned Host's login handoff; never infer or disable authentication. */
export function validateDesktopLoginUrl(value, baseUrl) {
  let url, base
  try { url = new URL(value); base = new URL(baseUrl) } catch { throw new Error('小蛇启动器未提供有效登录地址') }
  const token = url.searchParams.get('token')
  if (url.origin !== base.origin || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/' || url.username || url.password || url.hash || [...url.searchParams.keys()].join(',') !== 'token'
    || !/^[\w-]{43}$/u.test(token ?? '') || Buffer.from(token, 'base64url').toString('base64url') !== token) {
    throw new Error('小蛇登录地址与已验证服务不匹配')
  }
  // Canonicalize encoded query names before this sensitive URL crosses a boundary.
  url.search = ''
  url.searchParams.set('token', token)
  return url.href
}

/** The process token stays valid until the Host exits; strip it at every diagnostic boundary. */
export function redactDesktopLogin(value) {
  return String(value).replace(/([?&])([^=&#\s"'<>\\]+)=([^&#\s"'<>\\]+)/gu, (match, separator, key) => {
    try { return decodeURIComponent(key).toLowerCase() === 'token' ? separator + 'token=[redacted]' : match }
    catch { return match }
  })
}

export function cleanDesktopLoginUrl(value) {
  const url = new URL(value)
  url.searchParams.delete('token')
  return url.href
}
