import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { CLIENT_INPUTS, clientSourceIdentity } from './runtime-version-status.mjs'
import { productRuntimeIdentity } from './product-runtime-identity.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

async function sourceModule(path, imports) {
  let source = await readFile(new URL(path, import.meta.url), 'utf8')
  for (const [from, to] of Object.entries(imports)) source = source.replace(`from '${from}'`, `from '${to}'`)
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
}

async function productionModules() {
  const control = await sourceModule('../src/runtime-control.ts', {
    './bridge-client.js': new URL('../dist/bridge-client.js', import.meta.url).href,
    './memory-service.js': new URL('../dist/memory-service.js', import.meta.url).href,
  })
  return { ...await import(control), ...await import(await sourceModule('../src/plugins/runtime-routes.ts', { '../runtime-control.js': control })) }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xs-version-http-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const clientRoot = join(root, 'packages/native-shell-legacy-adapted')
  const dshRoot = join(root, 'runtime/DSH'); const profileRoot = join(root, 'fixture-profile')
  const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  for (const relative of CLIENT_INPUTS) {
    const destination = join(clientRoot, relative)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(repositoryRoot, 'packages/native-shell-legacy-adapted', relative), destination)
  }
  await put(join(root, 'package.json'), '{"name":"@xiaoshe/version-http-fixture","version":"0.2.0"}')
  await put(join(dshRoot, 'package.json'), '{}')
  await put(join(profileRoot, 'package.json'), '{"dependencies":{}}')
  await mkdir(join(root, 'scripts'))
  for (const file of ['runtime-version-status.mjs', 'product-runtime-identity.mjs']) await copyFile(join(repositoryRoot, 'scripts', file), join(root, 'scripts', file))
  // Compile the real UI with the real builder, but never overwrite lib/ or
  // invoke the user's launchers. The Profile above contains no user settings.
  await promisify(execFile)(process.execPath, [join(repositoryRoot, 'packages/native-shell-legacy-adapted/scripts/build-client.mjs'), '--output', join(clientRoot, 'lib/client.js')], { timeout: 30_000 })
  const manifest = JSON.parse(await readFile(join(clientRoot, 'lib/client.version.json'), 'utf8'))
  assert.equal(manifest.source_identity, await clientSourceIdentity(clientRoot))
  const backendIdentity = await productRuntimeIdentity({ root, dshRoot, profileRoot })
  return { root, clientRoot, loadedIdentity: manifest.source_identity, artifactIdentity: manifest.artifact_identity,
    environment: { XIAOSHE_PRODUCT_ROOT: root, XIAOSHE_DSH_ROOT: dshRoot, XIAOSHE_PROFILE_ROOT: profileRoot, XIAOSHE_RUNTIME_IDENTITY: backendIdentity } }
}

async function componentServer(t, registerRuntimeRoutes, runtimeVersion) {
  const routes = new Map()
  const dispose = registerRuntimeRoutes({ register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }, { runtimeVersion })
  const server = createServer((request, response) => {
    const handler = routes.get(new URL(request.url, 'http://127.0.0.1').pathname)
    if (!handler) { response.writeHead(404).end(); return }
    Promise.resolve(handler(request, response)).catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, request: async (query = '', options = {}) => fetch(`${base}/xiaoshe/desktop/version${query}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) }) }
}

test('component HTTP serves actual built frontend evidence and detects old or missing loaded identities', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const { registerRuntimeRoutes, createRuntimeVersionDiagnostic } = await productionModules()
  const service = await componentServer(t, registerRuntimeRoutes, createRuntimeVersionDiagnostic(f.environment))
  const response = await service.request(`?frontend_identity=${f.loadedIdentity}`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const current = await response.json()
  assert.equal(current.status, 'current')
  assert.equal(current.frontend.artifact_identity, f.artifactIdentity)
  assert.equal(current.frontend.source_identity, f.loadedIdentity)
  assert.equal(current.backend.identity, f.environment.XIAOSHE_RUNTIME_IDENTITY)
  assert.ok(!JSON.stringify(current).includes(f.root), 'HTTP report never includes absolute fixture paths')
  const old = (f.loadedIdentity[0] === 'a' ? 'b' : 'a') + f.loadedIdentity.slice(1)
  assert.equal((await (await service.request(`?frontend_identity=${old}`)).json()).status, 'stale')
  assert.equal((await (await service.request()).json()).status, 'unknown')
  await writeFile(join(f.clientRoot, 'lib/client.js'), 'modified artifact without rebuilding manifest')
  const altered = await (await service.request(`?frontend_identity=${f.loadedIdentity}`)).json()
  assert.equal(altered.status, 'stale')
  assert.equal(altered.frontend.state, 'stale')
  t.diagnostic('Component HTTP only: temporary loopback server and isolated real UI build; no DSH, models, credentials or daily instance deployment.')
})

test('component HTTP rejects foreign origins and path arguments, and missing launcher roots remain unknown', { timeout: 10_000 }, async t => {
  const { registerRuntimeRoutes, createRuntimeVersionDiagnostic } = await productionModules()
  const service = await componentServer(t, registerRuntimeRoutes, createRuntimeVersionDiagnostic({}))
  const unknown = await (await service.request()).json()
  assert.equal(unknown.status, 'unknown')
  assert.deepEqual(unknown.reasons, ['launcher-roots-unavailable'])
  const forbidden = await service.request('', { headers: { origin: 'https://foreign.example' } })
  assert.equal(forbidden.status, 403)
  assert.equal((await forbidden.json()).kind, 'UNTRUSTED_REQUEST')
  const crossSite = await service.request('', { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  assert.equal((await service.request('', { headers: { origin: service.base } })).status, 200)
  assert.equal((await service.request('?root=/private')).status, 400)
  assert.equal((await service.request('?frontend_identity=invalid')).status, 400)
  assert.equal((await service.request('', { method: 'POST' })).status, 405)
})
