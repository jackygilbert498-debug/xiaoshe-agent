import assert from 'node:assert/strict'
import test from 'node:test'
import { allowNativeNotifications, allowPermission, browserPreferences, navigationDecision, productOrigin, resolveProductUrl } from '../src/security-policy.mjs'

test('desktop product URL treats empty environment overrides as absent', () => {
  assert.equal(resolveProductUrl({}), 'http://127.0.0.1:3080/')
  assert.equal(resolveProductUrl({ XIAOSHE_DESKTOP_URL: '' }), 'http://127.0.0.1:3080/')
  assert.equal(resolveProductUrl({ XIAOSHE_DESKTOP_URL: '   ', XIAOSHE_DSH_PORT: '3192' }), 'http://127.0.0.1:3192/')
  assert.equal(resolveProductUrl({ XIAOSHE_DESKTOP_URL: ' http://localhost:4400/ ' }), 'http://localhost:4400/')
  assert.throws(() => resolveProductUrl({ XIAOSHE_DSH_PORT: 'not-a-port' }), /valid TCP port/u)
  assert.throws(() => resolveProductUrl({ XIAOSHE_DSH_PORT: '65536' }), /valid TCP port/u)
})

test('desktop security policy accepts only credential-free loopback product URLs', () => {
  assert.equal(productOrigin('http://127.0.0.1:3080/path?token=hidden'), 'http://127.0.0.1:3080')
  for (const value of ['https://example.com', 'http://192.168.1.2:3080', 'http://user:pass@127.0.0.1:3080']) assert.throws(() => productOrigin(value))
})

test('navigation, permissions and renderer preferences fail closed', () => {
  const origin = 'http://127.0.0.1:3080'
  assert.equal(navigationDecision(`${origin}/settings`, origin), 'allow-product')
  assert.equal(navigationDecision('https://electronjs.org/', origin), 'external-https')
  assert.equal(navigationDecision('file:///etc/passwd', origin), 'deny')
  assert.equal(allowPermission('notifications', origin, origin), true)
  assert.equal(allowPermission('media', origin, origin), false)
  assert.deepEqual(browserPreferences('/preload.mjs'), {
    preload: '/preload.mjs', contextIsolation: true, sandbox: true, nodeIntegration: false,
    webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, spellcheck: true,
  })
})

test('Windows development notifications cannot register a bare Electron activator', () => {
  assert.equal(allowNativeNotifications({ platform: 'win32', packaged: false }), false)
  assert.equal(allowNativeNotifications({ platform: 'win32', packaged: undefined }), false)
  assert.equal(allowNativeNotifications({ platform: 'win32', packaged: 'false' }), false)
})

test('an asar passed to default Electron is not a standalone Windows toast target', () => {
  assert.equal(allowNativeNotifications({ platform: 'win32', packaged: true, defaultApp: true }), false)
})

test('packaged Windows and macOS retain native notifications', () => {
  for (const context of [
    { platform: 'win32', packaged: true },
    { platform: 'darwin', packaged: true },
    { platform: 'darwin', packaged: false },
    { platform: 'linux', packaged: false },
  ]) assert.equal(allowNativeNotifications(context), true)
})

test('renderer notifications obey the native gate without granting other permissions', () => {
  const origin = 'http://127.0.0.1:3080'
  assert.equal(allowPermission('notifications', origin, origin, false), false)
  assert.equal(allowPermission('notifications', origin, origin, true), true)
  assert.equal(allowPermission('notifications', 'https://example.com', origin, true), false)
  assert.equal(allowPermission('media', origin, origin, true), false)
})
