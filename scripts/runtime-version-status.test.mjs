import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { CLIENT_INPUTS, clientSourceIdentity, inspectRuntimeVersion, loopbackVersionBase } from './runtime-version-status.mjs'
import { productRuntimeIdentity } from './product-runtime-identity.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xs-version-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dshRoot = join(root, 'runtime/DSH'); const profileRoot = join(root, 'profile')
  const clientRoot = join(root, 'packages/native-shell-legacy-adapted')
  const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  await put(join(root, 'package.json'), '{"name":"@xiaoshe/fixture","version":"0.2.0"}')
  await put(join(dshRoot, 'package.json'), '{}')
  await put(join(profileRoot, 'package.json'), '{"dependencies":{}}')
  for (const input of CLIENT_INPUTS) await put(join(clientRoot, input), input === 'package.json' ? '{}' : `fixture ${input}`)
  const source = await clientSourceIdentity(clientRoot)
  const artifact = 'compiled fixture client'
  await put(join(clientRoot, 'lib/client.js'), artifact)
  await put(join(clientRoot, 'lib/client.version.json'), JSON.stringify({ schema: 'xiaoshe-client-build/v1', source_identity: source,
    artifact_identity: createHash('sha256').update(artifact).digest('hex') }))
  const identity = await productRuntimeIdentity({ root, dshRoot, profileRoot })
  const options = { root, dshRoot, profileRoot, backendIdentity: identity, loadedFrontendIdentity: source }
  return { root, clientRoot, source, identity, put, options, report: (overrides = {}, dependencies) => inspectRuntimeVersion({ ...options, ...overrides }, dependencies) }
}

test('current requires the candidate, backend, artifact and loaded frontend to agree', async t => {
  const f = await fixture(t)
  const report = await f.report()
  assert.equal(report.status, 'current')
  assert.equal(report.backend.identity, f.identity)
  assert.equal(report.frontend.loaded_identity, f.source)
  assert.equal(report.source, 'developer-source')
  assert.equal(report.version, '0.2.0')
  assert.deepEqual(report.reasons, [])
  assert.ok(!JSON.stringify(report).includes(f.root), 'never expose machine paths')
})

test('old launchers and absent loaded-front evidence remain unknown, not current', async t => {
  const f = await fixture(t)
  for (const overrides of [{ backendIdentity: undefined }, { backendIdentity: 'old-version' }, { loadedFrontendIdentity: undefined }, { loadedFrontendIdentity: 'malformed' }]) {
    assert.equal((await f.report(overrides)).status, 'unknown')
  }
  assert.equal((await f.report({ backendIdentity: 'b'.repeat(64) })).status, 'stale')
  assert.equal((await f.report({ loadedFrontendIdentity: 'c'.repeat(64) })).status, 'stale')
})

test('editing source or built bytes cannot be hidden by an unchanged embedded marker', async t => {
  const f = await fixture(t)
  await f.put(join(f.clientRoot, 'src/client/adapted.css'), 'changed stylesheet')
  let report = await f.report()
  assert.equal(report.status, 'stale'); assert.equal(report.frontend.state, 'stale')
  await f.put(join(f.clientRoot, 'src/client/adapted.css'), 'fixture src/client/adapted.css')
  await f.put(join(f.clientRoot, 'lib/client.js'), 'changed compiled bytes with original source id')
  report = await f.report()
  assert.equal(report.status, 'stale'); assert.equal(report.frontend.state, 'stale')
})

test('missing or malformed build manifest and unavailable candidate fail closed', async t => {
  const f = await fixture(t)
  await rm(join(f.clientRoot, 'lib/client.version.json'))
  let report = await f.report({}, { identityReader: async () => f.identity })
  assert.equal(report.status, 'unavailable')
  assert.equal(report.frontend.state, 'unavailable')
  await f.put(join(f.clientRoot, 'lib/client.version.json'), '{"schema":"other"}')
  assert.equal((await f.report()).frontend.state, 'unavailable')
  report = await f.report({}, { identityReader: async () => { throw new Error('/private/profile/secret') } })
  assert.equal(report.candidate.state, 'unavailable')
  assert.ok(!JSON.stringify(report).includes('/private'))
})

test('HTTP 200 alone, foreign services, redirects and network failure never mean latest', async t => {
  const f = await fixture(t)
  const reportWith = value => f.report({ baseUrl: 'http://127.0.0.1:3080/' }, { fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3080/xiaoshe/desktop/status')
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    return new Response(JSON.stringify(value))
  } })
  assert.equal((await reportWith({ ok: true, private: '/private/profile' })).status, 'unknown')
  assert.equal((await reportWith({ product: '小蛇', api_version: 1 })).status, 'unknown')
  assert.equal((await reportWith({ product: '小蛇', api_version: 1, runtime_identity: f.identity })).status, 'current')
  const failed = await f.report({ baseUrl: 'http://127.0.0.1:3080' }, { fetchImpl: async () => { throw new Error('private detail') } })
  assert.equal(failed.status, 'unavailable')
  assert.ok(!JSON.stringify(failed).includes('private detail'))
})

test('CLI endpoint policy rejects external hosts, credentials and URL parameters', () => {
  for (const url of ['https://127.0.0.1', 'http://example.com', 'http://127.0.0.1/path', 'http://localhost?root=/private', 'http://user:secret@localhost', 'http://localhost#fragment']) {
    assert.throws(() => loopbackVersionBase(url), /loopback/u)
  }
  assert.equal(loopbackVersionBase('http://[::1]:3080'), 'http://[::1]:3080')
})

test('macOS backend receives the already resolved profile root, without changing startup flow', async () => {
  const launcher = await readFile(new URL('./start-xiaoshe-web.sh', import.meta.url), 'utf8')
  assert.match(launcher, /PROFILE_ROOT="\$\{DSH_HOME:-\$\{HOME\}\/\.dsh\}\/profiles\/\$\{PROFILE\}"/u)
  assert.match(launcher, /SERVICE_ENV=\([\s\S]*"XIAOSHE_PROFILE_ROOT=\$PROFILE_ROOT"/u)
})
