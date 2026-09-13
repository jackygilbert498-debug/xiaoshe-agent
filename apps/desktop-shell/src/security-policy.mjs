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

/**
 * Electron's Windows toast activator persists the executable with no app args.
 * A development electron.exe would therefore reopen default_app.asar, and its
 * generic Electron.lnk can also conflict with the packaged Xiaoshe identity.
 * An asar passed to default Electron can still report isPackaged=true; exclude
 * that launch mode too. Only a standalone packaged executable is a valid target.
 */
export function allowNativeNotifications({ platform, packaged, defaultApp }) {
  return platform !== 'win32' || (packaged === true && defaultApp !== true)
}

export function allowPermission(permission, requestingOrigin, expectedOrigin, nativeNotificationsEnabled = true) {
  return permission === 'notifications' && requestingOrigin === expectedOrigin && nativeNotificationsEnabled === true
}

export function browserPreferences(preload) {
  return Object.freeze({
    preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
    webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false,
    spellcheck: true,
  })
}
