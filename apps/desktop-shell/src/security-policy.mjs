const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Resolve optional desktop environment overrides without accepting an empty value as a URL. */
export function resolveProductUrl(environment) {
  const explicit = environment.XIAOSHE_DESKTOP_URL?.trim()
  if (explicit) return explicit
  const rawPort = environment.XIAOSHE_DSH_PORT?.trim() || '3080'
  const port = Number(rawPort)
  if (!/^\d{1,5}$/u.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError('XIAOSHE_DSH_PORT must be a valid TCP port')
  return `http://127.0.0.1:${port}/`
}

export function productOrigin(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username !== '' || url.password !== '' || url.hash !== '') throw new TypeError('desktop product URL must be credential-free loopback HTTP')
  url.pathname = '/'; url.search = ''; url.hash = ''
  return url.origin
}

export function navigationDecision(raw, expectedOrigin) {
  try {
    const url = new URL(raw)
    if (url.origin === expectedOrigin && url.protocol === 'http:') return 'allow-product'
    if (url.protocol === 'https:' && url.username === '' && url.password === '') return 'external-https'
  } catch { /* invalid URLs are denied */ }
  return 'deny'
}

export function allowPermission(permission, requestingOrigin, expectedOrigin) {
  return permission === 'notifications' && requestingOrigin === expectedOrigin
}

export function browserPreferences(preload) {
  return Object.freeze({
    preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
    webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false,
    spellcheck: true,
  })
}
