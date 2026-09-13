import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDesktopLoginUrl, redactDesktopLogin, cleanDesktopLoginUrl } from '../src/desktop-login.mjs'
const base = 'http://127.0.0.1:3080/', token = 's'.repeat(43), url = base + '?token=' + token
test('desktop handoff only accepts a canonical current-origin process token', () => {
  assert.equal(validateDesktopLoginUrl(url, base), url)
  for (const bad of [base, 'http://127.0.0.1:4080/?token=' + token, url + '&x=1', url + '#x', url + '&token=' + token, 'http://user@127.0.0.1:3080/?token=' + token]) {
    assert.throws(() => validateDesktopLoginUrl(bad, base))
  }
})
test('success telemetry and failures never retain a process login token', () => {
  assert.equal(cleanDesktopLoginUrl(url), base)
  for (const text of [url, 'navigation failed: ' + url, JSON.stringify({ url, nested: { url } })]) {
    assert.ok(!redactDesktopLogin(text).includes(token))
  }
})


test('encoded query keys are canonicalized and defensively redacted', () => {
  const encoded = base + '?%74o%6ben=' + token
  assert.equal(validateDesktopLoginUrl(encoded, base), url)
  for (const text of [encoded, JSON.stringify({ url: encoded }), base + '?%54OKEN=' + token]) {
    assert.ok(!redactDesktopLogin(text).includes(token))
  }
})
