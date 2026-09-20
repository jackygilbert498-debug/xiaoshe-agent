import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readDshLaunchUrl } from './dsh-launch-auth.mjs'

const token = 's'.repeat(43), identity = 'a'.repeat(64), base = 'http://127.0.0.1:4288/'
async function fixture(t, line) {
  const root = await mkdtemp(join(tmpdir(), 'xs-auth-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logPath = join(root, 'web.log')
  await writeFile(logPath, line, { mode: 0o600 })
  return { logPath, baseUrl: base, expectedRuntimeIdentity: identity }
}
function fetcher({ wrongIdentity = false, status = 303, location = '/', cookie = 'dsh-auth-test=signed; HttpOnly' } = {}) {
  return async (url, options) => {
    assert.equal(new URL(url).origin, new URL(base).origin)
    assert.equal(options.redirect, 'manual')
    if (new URL(url).pathname.endsWith('/status')) return Response.json({ product: '小蛇', runtime_identity: wrongIdentity ? 'b'.repeat(64) : identity, bridge: { state: 'ready' } })
    return new Response(null, { status, headers: { location, 'set-cookie': cookie } })
  }
}
test('reads only the official same-origin login line and verifies Host identity plus the real exchange', async t => {
  const f = await fixture(t, 'startup\ndsh web: ' + base + '?token=' + token + ' (LAN: http://192.168.1.2:4288/?token=' + token + ')\n')
  assert.equal(await readDshLaunchUrl({ ...f, fetcher: fetcher() }), base + '?token=' + token)
})
test('never trusts a foreign host, ambiguous token, failed exchange or mismatched runtime', async t => {
  for (const line of ['dsh web: https://example.com/?token=' + token, 'dsh web: ' + base + '?token=' + token + '&token=' + token, 'dsh web: ' + base + 'secret?token=' + token, 'dsh web: ' + base + '?token=short']) {
    const f = await fixture(t, line)
    await assert.rejects(readDshLaunchUrl({ ...f, fetcher: () => { throw new Error('must not fetch') } }), /登录链接/u)
  }
  const f = await fixture(t, 'dsh web: ' + base + '?token=' + token)
  for (const options of [{ wrongIdentity: true }, { status: 401 }, { location: 'https://example.com/' }, { cookie: 'other=no' }]) {
    await assert.rejects(readDshLaunchUrl({ ...f, fetcher: fetcher(options) }), error => {
      assert.ok(!error.message.includes(token)); return true
    })
  }
})
test('linked logs and empty runtime identity cannot become login authority', async t => {
  const f = await fixture(t, 'dsh web: ' + base + '?token=' + token)
  await link(f.logPath, f.logPath + '.alias')
  await assert.rejects(readDshLaunchUrl({ ...f, fetcher: fetcher() }), /日志/u)
  await assert.rejects(readDshLaunchUrl({ ...f, expectedRuntimeIdentity: '', fetcher: fetcher() }), /身份/u)
})

