import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import filesystem from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'
import { CURRENT_RENDERER_PROBE_ATTEMPTS, CURRENT_RENDERER_PROBE_SETTLE_MS, CURRENT_RENDERER_PROBE_TIMEOUT_MS, ProductServiceController, acceptanceQuitDelay, defaultProductRoot, launchCommand, loadProductPage, prepareProductRoot, productRootOverride, rendererExitAction, rendererProbePassed, resolvePowerShell, safeEnvironment, shutdownOwnedProduct, waitForReady } from '../src/lifecycle.mjs'

const nativeBrandAssets = Object.freeze([
  ['app-icon-256.png', 'official-app-icon'],
  ['icon-16.png', 'official-tray-icon'],
  ['icon-32.png', 'official-tray-icon-retina'],
])

async function createPackagedProductFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-product-root-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resourcesPath = join(root, 'signed-app', 'resources')
  const source = join(resourcesPath, 'product')
  const userDataPath = join(root, 'user-data')
  for (const relative of ['runtime/DSH', 'runtime/xiaoshe-legacy/ui/assets', 'packages/agent-experience', 'setup', 'scripts', 'apps/desktop-shell/src']) {
    await mkdir(join(source, relative), { recursive: true })
  }
  await writeFile(join(source, 'package.json'), '{"name":"xiaoshe"}\n')
  await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(source, 'runtime/DSH/package.json'), '{"name":"dsh"}\n')
  await writeFile(join(source, 'packages/agent-experience/package.json'), '{"name":"@xiaoshe/agent-experience"}\n')
  await writeFile(join(source, 'setup/install-windows.ps1'), '# installer\n')
  await writeFile(join(source, 'scripts/start-xiaoshe-web.sh'), '#!/bin/bash\n')
  await writeFile(join(source, 'scripts/isolated-browser-protocol.mjs'), 'export const protocolVersion = 1\n')
  await writeFile(join(source, 'scripts/product-runtime-identity.mjs'), 'export const identityVersion = 1\n')
  await writeFile(join(source, 'apps/desktop-shell/src/acceptance-isolation.mjs'), 'export const isolated = true\n')
  for (const [name, content] of nativeBrandAssets) {
    await writeFile(join(source, 'runtime/xiaoshe-legacy/ui/assets', name), content)
  }
  return { resourcesPath, source, userDataPath }
}

test('empty packaged product-root overrides do not bypass per-user materialization', () => {
  assert.equal(productRootOverride({}), undefined)
  assert.equal(productRootOverride({ XIAOSHE_PRODUCT_ROOT: '' }), undefined)
  assert.equal(productRootOverride({ XIAOSHE_PRODUCT_ROOT: '   ' }), undefined)
  assert.equal(productRootOverride({ XIAOSHE_PRODUCT_ROOT: ' C:\\XS ' }), 'C:\\XS')
})

test('embedded isolation helper is required before materializing or reusing a packaged runtime', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const helper = 'apps/desktop-shell/src/acceptance-isolation.mjs'
  const target = await prepareProductRoot(options)
  assert.deepEqual(await readFile(join(target, helper)), await readFile(join(source, helper)))
  await rm(join(target, helper))
  assert.equal(await prepareProductRoot(options), target)
  assert.deepEqual(await readFile(join(target, helper)), await readFile(join(source, helper)))
  await rm(join(source, helper))
  await assert.rejects(prepareProductRoot(options), /acceptance-isolation/u)
})

test('development and packaged product roots remain explicit', () => {
  assert.match(defaultProductRoot({ packaged: true, resourcesPath: 'C:\\Program Files\\Xiaoshe\\resources' }), /resources[\\/]product$/u)
  assert.match(defaultProductRoot({ packaged: false, resourcesPath: '', moduleUrl: 'file:///C:/repo/apps/desktop-shell/src/lifecycle.mjs' }), /C:[\\/]repo$/iu)
})

test('desktop child environment normalizes supported proxy variables without widening the allowlist', () => {
  const environment = safeEnvironment({
    PATH: 'C:\\Windows\\System32',
    DSH_HOME: 'C:\\Users\\tester\\.dsh',
    XIAOSHE_DSH_PORT: '39871',
    XIAOSHE_PYTHON: '/custom/python3',
    HTTP_PROXY: 'http://upper.example:8080',
    http_proxy: 'http://lower-ignored.example:8080',
    https_proxy: 'http://lower-secure.example:8443',
    no_proxy: 'localhost,.internal.example',
    ALL_PROXY: 'socks5://unsupported.example:1080',
    XIAOSHE_UNRELATED_SECRET: 'must-not-cross-the-boundary',
  })

  assert.deepEqual(environment, {
    PATH: 'C:\\Windows\\System32',
    DSH_HOME: 'C:\\Users\\tester\\.dsh',
    XIAOSHE_DSH_PORT: '39871',
    XIAOSHE_PYTHON: '/custom/python3',
    HTTP_PROXY: 'http://upper.example:8080',
    HTTPS_PROXY: 'http://lower-secure.example:8443',
    NO_PROXY: 'localhost,.internal.example',
  })
})

test('packaged product is materialized outside the signed application resources', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)

  const prepared = await prepareProductRoot({ packaged: true, resourcesPath, userDataPath, version: '0.2.0' })
  assert.notEqual(prepared, source)
  assert.equal(prepared.startsWith(userDataPath), true)
  assert.equal(await readFile(join(prepared, 'package.json'), 'utf8'), '{"name":"xiaoshe"}\n')
  await writeFile(join(prepared, '.runtime-state'), 'preserved')
  assert.equal(await prepareProductRoot({ packaged: true, resourcesPath, userDataPath, version: '0.2.0' }), prepared)
  assert.equal(await readFile(join(prepared, '.runtime-state'), 'utf8'), 'preserved')
  assert.equal(await readFile(join(source, 'package.json'), 'utf8'), '{"name":"xiaoshe"}\n')
})

for (const [missingAsset, expectedContent] of nativeBrandAssets) {
  test(`packaged product rebuilds a same-version runtime missing ${missingAsset}`, async t => {
    const { resourcesPath, userDataPath } = await createPackagedProductFixture(t)
    const prepared = await prepareProductRoot({ packaged: true, resourcesPath, userDataPath, version: '0.2.0' })
    const assetPath = join('runtime/xiaoshe-legacy/ui/assets', missingAsset)
    await writeFile(join(prepared, '.runtime-state'), 'preserve-in-recovery')
    await rm(join(prepared, assetPath))

    const repaired = await prepareProductRoot({ packaged: true, resourcesPath, userDataPath, version: '0.2.0' })
    assert.equal(repaired, prepared)
    assert.equal(await readFile(join(repaired, assetPath), 'utf8'), expectedContent)
    const runtimeEntries = await readdir(join(userDataPath, 'runtime'))
    const recovery = runtimeEntries.find(name => name.startsWith('0.2.0.recovery-'))
    assert.ok(recovery, 'the incomplete runtime must remain recoverable')
    assert.equal(await readFile(join(userDataPath, 'runtime', recovery, '.runtime-state'), 'utf8'), 'preserve-in-recovery')
  })
}

// These exercise the production materializer on real files, including the
// same-version upgrade that the original version-only marker could not detect.
test('same-version runtime repairs a missing browser protocol before the shell imports it', async t => {
  const { resourcesPath, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const target = await prepareProductRoot(options)
  await rm(join(target, 'scripts/isolated-browser-protocol.mjs'))
  await writeFile(join(target, '.runtime-state'), 'keep-old-state')
  const repaired = await prepareProductRoot(options)
  const protocol = await import(pathToFileURL(join(repaired, 'scripts/isolated-browser-protocol.mjs')).href)
  assert.equal(protocol.protocolVersion, 1)
  const recovery = (await readdir(join(userDataPath, 'runtime'))).find(name => name.startsWith('0.2.0.recovery-'))
  assert.ok(recovery)
  assert.equal(await readFile(join(userDataPath, 'runtime', recovery, '.runtime-state'), 'utf8'), 'keep-old-state')
})

test('same-version package content changes replace stale code while retaining a recovery copy', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const target = await prepareProductRoot(options)
  await writeFile(join(source, 'scripts/isolated-browser-protocol.mjs'), 'export const protocolVersion = 2\n')
  await prepareProductRoot(options)
  assert.equal(await readFile(join(target, 'scripts/isolated-browser-protocol.mjs'), 'utf8'), 'export const protocolVersion = 2\n')
  const recovery = (await readdir(join(userDataPath, 'runtime'))).find(name => name.startsWith('0.2.0.recovery-'))
  assert.ok(recovery)
  assert.equal(await readFile(join(userDataPath, 'runtime', recovery, 'scripts/isolated-browser-protocol.mjs'), 'utf8'), 'export const protocolVersion = 1\n')
})

test('same-version package additions and removals do not leave a mixed runtime', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)
  await writeFile(join(source, 'scripts/obsolete-plugin.mjs'), 'export const old = true\n')
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const target = await prepareProductRoot(options)
  await rm(join(source, 'scripts/obsolete-plugin.mjs'))
  await writeFile(join(source, 'scripts/new-plugin.mjs'), 'export const current = true\n')
  await prepareProductRoot(options)
  assert.equal(await readFile(join(target, 'scripts/new-plugin.mjs'), 'utf8'), 'export const current = true\n')
  await assert.rejects(readFile(join(target, 'scripts/obsolete-plugin.mjs')), { code: 'ENOENT' })
})

test('runtime-wide recovery retention keeps the two newest verified fallbacks across versions', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  await prepareProductRoot(options)
  for (const revision of [2, 3]) {
    await writeFile(join(source, 'scripts/isolated-browser-protocol.mjs'), `export const protocolVersion = ${revision}\n`)
    await prepareProductRoot(options)
  }
  await prepareProductRoot({ ...options, version: '0.2.1' })
  await writeFile(join(source, 'scripts/isolated-browser-protocol.mjs'), 'export const protocolVersion = 4\n')
  await prepareProductRoot({ ...options, version: '0.2.1' })

  const runtime = join(userDataPath, 'runtime')
  await mkdir(join(runtime, 'untrusted.recovery-pretend'), { recursive: true })
  await writeFile(join(runtime, 'untrusted.recovery-pretend', '.runtime-state'), 'do-not-delete')

  const recoveries = []
  for (const name of await readdir(runtime)) {
    if (!name.includes('.recovery-')) continue
    try {
      const marker = JSON.parse(await readFile(join(runtime, name, '.xiaoshe-product-runtime.json'), 'utf8'))
      if (marker.schemaVersion === 3) recoveries.push(name)
    } catch { /* an unverified directory is not eligible for retention */ }
  }
  assert.equal(recoveries.length, 2)
  assert.ok(recoveries.some(name => name.startsWith('0.2.1.recovery-')), 'the newest recovery remains available')
  assert.equal(await readFile(join(runtime, 'untrusted.recovery-pretend', '.runtime-state'), 'utf8'), 'do-not-delete')
})

test('recovery retention orders verified fallbacks by the filename timestamp and preserves unsafe candidates', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  await prepareProductRoot(options)
  const runtime = join(userDataPath, 'runtime')
  const active = join(runtime, '0.2.0')
  const marker = JSON.parse(await readFile(join(active, '.xiaoshe-product-runtime.json'), 'utf8'))
  const names = [
    '0.1.0.recovery-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '0.1.0.recovery-200-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '0.1.0.recovery-300-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ]
  for (const name of names) {
    await cp(active, join(runtime, name), { recursive: true })
    await writeFile(join(runtime, name, '.xiaoshe-product-runtime.json'), `${JSON.stringify({ ...marker, version: '0.1.0' })}\n`)
  }
  const forged = '0.1.0.recovery-250-ffffffff-ffff-4fff-8fff-ffffffffffff'
  await mkdir(join(runtime, forged), { recursive: true })
  await writeFile(join(runtime, forged, '.xiaoshe-product-runtime.json'), `${JSON.stringify({ schemaVersion: marker.schemaVersion, version: '0.1.0', fingerprint: marker.fingerprint, files: marker.files })}\n`)
  await writeFile(join(runtime, forged, 'private.txt'), 'not a verified runtime')
  const missingMarker = '0.1.0.recovery-50-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const badMarker = '0.1.0.recovery-60-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  await mkdir(join(runtime, missingMarker), { recursive: true })
  await mkdir(join(runtime, badMarker), { recursive: true })
  await writeFile(join(runtime, badMarker, '.xiaoshe-product-runtime.json'), '{broken')
  await writeFile(join(source, 'scripts/isolated-browser-protocol.mjs'), 'export const protocolVersion = 2\n')
  await prepareProductRoot(options)
  const entries = await readdir(runtime)
  assert.equal(entries.includes(names[0]), false)
  assert.equal(entries.includes(names[1]), false)
  assert.equal(entries.includes(names[2]), true)
  assert.equal(entries.includes(forged), true, 'a copied marker without matching product bytes must never authorize recursive deletion')
  assert.equal(entries.includes(missingMarker), true)
  assert.equal(entries.includes(badMarker), true)
})

test('runtime content corruption is detected even when version and marker are unchanged', async t => {
  const { resourcesPath, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const target = await prepareProductRoot(options)
  await writeFile(join(target, 'scripts/isolated-browser-protocol.mjs'), 'broken module')
  await prepareProductRoot(options)
  assert.equal(await readFile(join(target, 'scripts/isolated-browser-protocol.mjs'), 'utf8'), 'export const protocolVersion = 1\n')
})

test('a broken shipped package is rejected before moving an existing runtime', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const target = await prepareProductRoot(options)
  await rm(join(source, 'scripts/isolated-browser-protocol.mjs'))
  await assert.rejects(prepareProductRoot(options), /isolated-browser-protocol/u)
  assert.equal(await readFile(join(target, 'scripts/isolated-browser-protocol.mjs'), 'utf8'), 'export const protocolVersion = 1\n')
  assert.deepEqual(await readdir(join(userDataPath, 'runtime')), ['0.2.0'])
})

test('a packaged runtime without the identity helper is rejected before activation', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)
  await rm(join(source, 'scripts/product-runtime-identity.mjs'))
  await assert.rejects(
    prepareProductRoot({ packaged: true, resourcesPath, userDataPath, version: '0.2.0' }),
    /product-runtime-identity/u,
  )
  await assert.rejects(readFile(join(userDataPath, 'runtime', '0.2.0', 'package.json')), { code: 'ENOENT' })
})

test('unchanged runtime keeps installed dependencies and local state without making recovery copies', async t => {
  const { resourcesPath, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const target = await prepareProductRoot(options)
  await mkdir(join(target, 'node_modules/local-dependency'), { recursive: true })
  await writeFile(join(target, 'node_modules/local-dependency/index.js'), 'installed dependency')
  await writeFile(join(target, '.runtime-state'), 'local state')
  assert.equal(await prepareProductRoot(options), target)
  assert.equal(await prepareProductRoot(options), target)
  assert.equal(await readFile(join(target, 'node_modules/local-dependency/index.js'), 'utf8'), 'installed dependency')
  assert.equal(await readFile(join(target, '.runtime-state'), 'utf8'), 'local state')
  assert.deepEqual(await readdir(join(userDataPath, 'runtime')), ['0.2.0'])
})

test('legacy version-only markers refresh once and retain the old copy', async t => {
  const { resourcesPath, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const target = await prepareProductRoot(options)
  await writeFile(join(target, '.xiaoshe-product-runtime.json'), '{"schemaVersion":1,"version":"0.2.0"}\n')
  await writeFile(join(target, '.runtime-state'), 'legacy state')
  await prepareProductRoot(options)
  const entries = await readdir(join(userDataPath, 'runtime'))
  const recovery = entries.find(name => name.startsWith('0.2.0.recovery-'))
  assert.ok(recovery, 'unverified legacy copies must remain recoverable')
  assert.equal(await readFile(join(userDataPath, 'runtime', recovery, '.runtime-state'), 'utf8'), 'legacy state')
  await prepareProductRoot(options)
  assert.deepEqual(await readdir(join(userDataPath, 'runtime')), entries)
})

test('an unsafe shipped link cannot move the old runtime or copy outside files', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const target = await prepareProductRoot(options)
  const outside = join(userDataPath, 'private-not-product')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'private.txt'), 'not a product file')
  await symlink(outside, join(source, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(prepareProductRoot(options), /symbolic|link|unsafe/iu)
  assert.equal(await readFile(join(target, 'package.json'), 'utf8'), '{"name":"xiaoshe"}\n')
  assert.deepEqual(await readdir(join(userDataPath, 'runtime')), ['0.2.0'])
})

for (const version of ['.', '..']) {
  test(`packaged version ${version} cannot select a parent directory as runtime target`, async t => {
    const { resourcesPath, userDataPath } = await createPackagedProductFixture(t)
    await assert.rejects(prepareProductRoot({ packaged: true, resourcesPath, userDataPath, version }), /version|target/iu)
  })
}

test('failed staged copy keeps the existing runtime in place and removes only its partial copy', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const target = await prepareProductRoot(options)
  await writeFile(join(source, 'scripts/new-code.mjs'), 'export const update = true\n')
  // The filesystem syscall is the fault boundary; all validation and recovery
  // still run through the real materializer on real temporary directories.
  t.mock.method(filesystem, 'cp', async (_source, destination) => {
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'partial-file'), 'incomplete')
    throw Object.assign(new Error('test disk full'), { code: 'ENOSPC' })
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(prepareProductRoot(options), { code: 'ENOSPC' })
  assert.equal(await readFile(join(target, 'package.json'), 'utf8'), '{"name":"xiaoshe"}\n')
  assert.deepEqual(await readdir(join(userDataPath, 'runtime')), ['0.2.0'])
})

test('failed activation restores the previous runtime to its original path', async t => {
  const { resourcesPath, source, userDataPath } = await createPackagedProductFixture(t)
  const options = { packaged: true, resourcesPath, userDataPath, version: '0.2.0' }
  const target = await prepareProductRoot(options)
  await writeFile(join(source, 'scripts/new-code.mjs'), 'export const update = true\n')
  const rename = filesystem.rename
  t.mock.method(filesystem, 'rename', async (from, to) => {
    if (from.includes('.partial-') && to === target) throw Object.assign(new Error('test activation denied'), { code: 'EACCES' })
    return rename(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(prepareProductRoot(options), { code: 'EACCES' })
  assert.equal(await readFile(join(target, 'package.json'), 'utf8'), '{"name":"xiaoshe"}\n')
  await assert.rejects(readFile(join(target, 'scripts/new-code.mjs')), { code: 'ENOENT' })
  assert.deepEqual(await readdir(join(userDataPath, 'runtime')), ['0.2.0'])
})

test('readiness requires the Xiaoshe product and ready bridge facts', async () => {
  let calls = 0
  const identity = 'c'.repeat(64)
  const value = await waitForReady('http://127.0.0.1:3080/', { timeoutMs: 200, intervalMs: 1, expectedRuntimeIdentity: identity, fetcher: async () => {
    calls += 1
    return { ok: true, status: 200, async json() { return calls < 2 ? { product: '小蛇', bridge: { state: 'starting' }, runtime_identity: identity } : { product: '小蛇', bridge: { state: 'ready' }, runtime_identity: identity } } }
  } })
  assert.equal(value.bridge.state, 'ready')
})

const expectedRuntimeIdentity = 'a'.repeat(64)
const otherRuntimeIdentity = 'b'.repeat(64)

test('readiness requires the exact launcher-authenticated runtime identity', async () => {
  await assert.rejects(
    waitForReady('http://127.0.0.1:3080/', {
      timeoutMs: 10,
      intervalMs: 1,
      expectedRuntimeIdentity,
      fetcher: async () => ({
        ok: true,
        status: 200,
        async json() { return { product: '小蛇', bridge: { state: 'ready' }, runtime_identity: otherRuntimeIdentity } },
      }),
    }),
    /runtime identity mismatch/u,
  )
})

test('readiness rejects a response with no runtime identity', async () => {
  await assert.rejects(
    waitForReady('http://127.0.0.1:3080/', {
      timeoutMs: 10,
      intervalMs: 1,
      expectedRuntimeIdentity,
      fetcher: async () => ({
        ok: true,
        status: 200,
        async json() { return { product: '小蛇', bridge: { state: 'ready' } } },
      }),
    }),
    /runtime identity mismatch/u,
  )
})

test('desktop service receives an owned launch contract before it may stop the service', async () => {
  const ownershipToken = '11111111-1111-4111-8111-111111111111'
  let launches = 0
  let processRuns = 0
  let readinessChecks = 0
  const controller = new ProductServiceController({
    productRoot: 'C:\\current-product',
    platform: 'win32',
    url: 'http://127.0.0.1:3080/',
    ownershipToken,
    launch: async () => { launches += 1; return { command: 'owned-launcher', args: [], cwd: 'C:\\current-product' } },
    run: async () => { processRuns += 1; return { exitCode: 0, stdout: `XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"started","token":"${ownershipToken}","identity":"${expectedRuntimeIdentity}","loginUrl":"http://127.0.0.1:3080/?token=${'s'.repeat(43)}"}\n`, stderr: '' } },
    ready: async (_url, options) => {
      readinessChecks += 1
      assert.equal(options.expectedRuntimeIdentity, expectedRuntimeIdentity)
      return { product: '小蛇', bridge: { state: 'ready' }, runtime_identity: expectedRuntimeIdentity }
    },
  })

  const result = await controller.start()

  assert.deepEqual(result, { reused: false, loginUrl: 'http://127.0.0.1:3080/?token=' + 's'.repeat(43) })
  assert.equal(launches, 1)
  assert.equal(processRuns, 1)
  assert.equal(readinessChecks, 1)
})

test('desktop service never stops a launcher-reused service', async () => {
  const commands = []
  const controller = new ProductServiceController({
    productRoot: 'C:\\current-product', platform: 'win32', url: 'http://127.0.0.1:3080/',
    launch: async () => ({ command: 'owned-launcher', args: [], cwd: 'C:\\current-product' }),
    run: async command => {
      commands.push(command.command)
      return { exitCode: 0, stdout: `XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"reused","identity":"${expectedRuntimeIdentity}","loginUrl":"http://127.0.0.1:3080/?token=${'s'.repeat(43)}"}\n`, stderr: '' }
    },
    ready: async () => ({ product: '小蛇', bridge: { state: 'ready' } }),
  })

  assert.deepEqual(await controller.start(), { reused: true, loginUrl: 'http://127.0.0.1:3080/?token=' + 's'.repeat(43) })
  assert.deepEqual(await controller.stopOwned(), { stopped: false, reason: 'reused-existing-service' })
  assert.deepEqual(commands, ['owned-launcher'])
})

for (const [name, stdout] of [
  ['missing', ''],
  ['duplicate', 'XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"started"}\nXIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"started"}\n'],
  ['malformed', 'XIAOSHE_LAUNCH_OWNERSHIP={broken\n'],
  ['invalid status', 'XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"unknown"}\n'],
  ['missing runtime identity', 'XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"reused"}\n'],
  ['malformed runtime identity', 'XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"reused","identity":"not-a-sha256"}\n'],
]) {
  test(`desktop service rejects ${name} ownership reports`, async () => {
    const commands = []
    const controller = new ProductServiceController({
      productRoot: 'C:\\current-product', platform: 'win32', url: 'http://127.0.0.1:3080/',
      launch: async () => ({ command: 'owned-launcher', args: [], cwd: 'C:\\current-product' }),
      ownershipToken: '11111111-1111-4111-8111-111111111111',
      run: async command => { commands.push(command); return { exitCode: 0, stdout, stderr: '' } },
      ready: async () => ({ product: '小蛇', bridge: { state: 'ready' } }),
    })
    await assert.rejects(controller.start(), /所有权/u)
    assert.equal(commands.length, 2, 'an invalid report must trigger one token-scoped compensation attempt')
    assert.ok(commands[1].args.some(value => value === '11111111-1111-4111-8111-111111111111'))
  })
}

test('desktop service compensates a newly started service when readiness fails', async () => {
  const ownershipToken = '22222222-2222-4222-8222-222222222222'
  const commands = []
  const controller = new ProductServiceController({
    productRoot: 'C:\\current-product', platform: 'win32', url: 'http://127.0.0.1:3080/',
    ownershipToken,
    launch: async () => ({ command: 'owned-launcher', args: [], cwd: 'C:\\current-product' }),
    run: async command => {
      commands.push(command.command)
      return command.command === 'owned-launcher'
        ? { exitCode: 0, stdout: `XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"started","token":"${ownershipToken}","identity":"${expectedRuntimeIdentity}","loginUrl":"http://127.0.0.1:3080/?token=${'s'.repeat(43)}"}\n`, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    },
    ready: async () => { throw new Error('identity never became ready') },
  })
  await assert.rejects(controller.start(), /identity never became ready/u)
  assert.equal(commands.length, 2)
  assert.match(commands[1], /powershell/iu)
  assert.deepEqual(await controller.stopOwned(), { stopped: false, reason: 'reused-existing-service' })
})

test('desktop service aggregates failed cleanup and retains ownership for a retry', async () => {
  const ownershipToken = '44444444-4444-4444-8444-444444444444'
  let runs = 0
  const controller = new ProductServiceController({
    productRoot: 'C:\\current-product', platform: 'win32', url: 'http://127.0.0.1:3080/',
    ownershipToken,
    launch: async () => ({ command: 'owned-launcher', args: [], cwd: 'C:\\current-product' }),
    run: async command => {
      runs += 1
      if (command.command === 'owned-launcher') return { exitCode: 0, stdout: `XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"started","token":"${ownershipToken}","identity":"${expectedRuntimeIdentity}","loginUrl":"http://127.0.0.1:3080/?token=${'s'.repeat(43)}"}\n`, stderr: '' }
      return runs === 2 ? { exitCode: 9, stdout: '', stderr: 'still alive' } : { exitCode: 0, stdout: '', stderr: '' }
    },
    ready: async () => { throw new Error('identity never became ready') },
  })

  await assert.rejects(controller.start(), error => error instanceof AggregateError && error.errors.length === 2)
  assert.deepEqual(await controller.stopOwned(), { stopped: true, exitCode: 0, stderr: '' })
  assert.equal(runs, 3)
})

test('desktop service fails closed when an owned stop command fails and can retry', async () => {
  const ownershipToken = '55555555-5555-4555-8555-555555555555'
  let stopAttempts = 0
  const controller = new ProductServiceController({
    productRoot: 'C:\\current-product', platform: 'win32', url: 'http://127.0.0.1:3080/',
    ownershipToken,
    launch: async () => ({ command: 'owned-launcher', args: [], cwd: 'C:\\current-product' }),
    run: async command => {
      if (command.command === 'owned-launcher') {
        return { exitCode: 0, stdout: `XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"started","token":"${ownershipToken}","identity":"${expectedRuntimeIdentity}","loginUrl":"http://127.0.0.1:3080/?token=${'s'.repeat(43)}"}\n`, stderr: '' }
      }
      stopAttempts += 1
      return stopAttempts === 1
        ? { exitCode: 9, stdout: '', stderr: 'still alive' }
        : { exitCode: 0, stdout: '', stderr: '' }
    },
    ready: async () => ({ product: '小蛇', bridge: { state: 'ready' } }),
  })

  await controller.start()
  await assert.rejects(controller.stopOwned(), /stop failed.*exit 9.*still alive/iu)
  assert.deepEqual(await controller.stopOwned(), { stopped: true, exitCode: 0, stderr: '' })
  assert.equal(stopAttempts, 2)
})

test('desktop shutdown attempts every owned cleanup and aggregates failures', async () => {
  const attempts = []
  await assert.rejects(
    shutdownOwnedProduct({
      closeBrowser: async () => { attempts.push('browser'); throw new Error('browser cleanup failed') },
      stopService: async () => { attempts.push('service'); throw new Error('service cleanup failed') },
    }),
    error => error instanceof AggregateError
      && error.errors.length === 2
      && error.errors.every(entry => /cleanup failed/u.test(entry.message)),
  )
  assert.deepEqual(attempts, ['browser', 'service'])
})

test('desktop shutdown still attempts service cleanup after a synchronous browser failure', async () => {
  const attempts = []
  await assert.rejects(shutdownOwnedProduct({
    closeBrowser: () => { attempts.push('browser'); throw new Error('synchronous browser failure') },
    stopService: () => { attempts.push('service'); return { stopped: true } },
  }), error => error instanceof AggregateError && error.errors.length === 1)
  assert.deepEqual(attempts, ['browser', 'service'])
})

test('Windows ownership records require a runtime content and Profile identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-owner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const helper = join(defaultProductRoot({ packaged: false }), 'scripts', 'windows-process-owner.mjs')
  const state = join(root, 'owner.json')
  const base = ['write', '--path', state, '--pid', '123', '--port', '3080', '--xs-root', 'C:\\XS', '--dsh-root', 'C:\\XS\\runtime\\DSH', '--creation-date', '1']
  const legacy = spawnSync(process.execPath, [helper, ...base], { encoding: 'utf8' })
  assert.notEqual(legacy.status, 0, 'legacy records must not be accepted')
  const identity = 'a'.repeat(64)
  const token = '33333333-3333-4333-8333-333333333333'
  const written = execFileSync(process.execPath, [helper, ...base, '--runtime-identity', identity, '--ownership-token', token], { encoding: 'utf8' })
  assert.equal(JSON.parse(written).runtimeIdentity, identity)
  assert.equal(JSON.parse(written).ownershipToken, token)
  const replaced = execFileSync(process.execPath, [helper, ...base.map(value => value === '123' ? '124' : value), '--runtime-identity', identity, '--ownership-token', token], { encoding: 'utf8' })
  assert.equal(JSON.parse(replaced).pid, 124)
  const source = await readFile(helper, 'utf8')
  assert.match(source, /randomUUID/u)
  assert.doesNotMatch(source, /await rm\(path,[\s\S]+await rename\(temporary, path\)/u, 'replacement must not create a crash window with no ownership record')
})

test('Windows launcher does not publish started ownership before the matching health identity arrives', async () => {
  const launcher = await readFile(join(defaultProductRoot({ packaged: false }), '启动小蛇.ps1'), 'utf8')
  assert.match(launcher, /if \(\$Health -and \$Health\.product -eq '小蛇' -and \$Health\.bridge\.state -eq 'ready' -and \$Health\.runtime_identity -eq \$RuntimeIdentity\)/u)
})

test('Windows ownership v1 publishes the authenticated runtime identity for started and reused services', async () => {
  const launcher = await readFile(join(defaultProductRoot({ packaged: false }), '启动小蛇.ps1'), 'utf8')
  assert.match(launcher, /function Write-OwnershipReport[\s\S]+\[string\]\$Identity[\s\S]+\$Fields\.identity = \$Identity/u)
  assert.equal((launcher.match(/Write-OwnershipReport 'reused' '' \$[A-Za-z]+/gu) ?? []).length, 2)
  assert.match(launcher, /Write-OwnershipReport 'started' \$LaunchToken \$RuntimeIdentity/u)
})

test('macOS ownership v1 publishes the authenticated runtime identity for started and reused services', async () => {
  const launcher = await readFile(join(defaultProductRoot({ packaged: false }), 'scripts', 'start-xiaoshe-web.sh'), 'utf8')
  assert.match(launcher, /"status":"started","token":"%s","identity":"%s"[\s\S]+"\$LAUNCH_TOKEN" "\$XIAOSHE_RUNTIME_IDENTITY"/u)
  assert.match(launcher, /"status":"reused","identity":"%s"[\s\S]+"\$XIAOSHE_RUNTIME_IDENTITY"/u)
})

test('runtime identity changes with executable dist, DSH provider lib, and controlled Profile packages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-runtime-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dsh = join(root, 'dsh'); const profile = join(root, 'profile')
  const fetchPackage = join(dsh, 'packages', 'web', 'web-fetch-http')
  await mkdir(join(root, 'src'), { recursive: true }); await mkdir(join(root, 'dist'), { recursive: true }); await mkdir(join(root, 'packages', 'product-bundle'), { recursive: true })
  await mkdir(join(dsh, 'apps', 'cli', 'lib'), { recursive: true }); await mkdir(join(fetchPackage, 'lib'), { recursive: true }); await mkdir(join(profile, 'node_modules', '@liustack', 'modlens', 'dist'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"name":"xiaoshe"}\n')
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lock-v1\n')
  await writeFile(join(root, 'packages', 'product-bundle', 'cordis.patch.yml'), 'bundles: [a]\n')
  await writeFile(join(dsh, 'package.json'), '{"name":"dsh"}\n')
  await writeFile(join(dsh, 'apps', 'cli', 'lib', 'bin.js'), 'console.log("dsh")\n')
  await writeFile(join(root, 'dist', 'index.js'), 'export const runtime = 1\n')
  await writeFile(join(fetchPackage, 'package.json'), '{"name":"@deepseek-ai/dsh-web-fetch-http","main":"lib/index.js"}\n')
  await writeFile(join(fetchPackage, 'lib', 'index.js'), 'export const fetchRuntime = 1\n')
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({ dependencies: { '@deepseek-ai/dsh-web-fetch-http': `link:${fetchPackage}`, '@liustack/modlens': '3.22.0' } })}\n`)
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(profile, 'node_modules', '@liustack', 'modlens', 'package.json'), '{"name":"@liustack/modlens","version":"3.22.0"}\n')
  await writeFile(join(profile, 'node_modules', '@liustack', 'modlens', 'dist', 'main.js'), 'export const modlens = 1\n')
  const helper = join(defaultProductRoot({ packaged: false }), 'scripts', 'product-runtime-identity.mjs')
  const invoke = () => JSON.parse(execFileSync(process.execPath, [helper, '--root', root, '--dsh-root', dsh, '--profile-root', profile], { encoding: 'utf8' }))
  const initial = invoke()
  await writeFile(join(root, 'dist', 'index.js'), 'export const runtime = 2\n')
  const distChanged = invoke(); assert.notEqual(distChanged.identity, initial.identity)
  await writeFile(join(fetchPackage, 'lib', 'index.js'), 'export const fetchRuntime = 2\n')
  const providerChanged = invoke(); assert.notEqual(providerChanged.identity, distChanged.identity)
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: changed\n')
  const profileChanged = invoke(); assert.notEqual(profileChanged.identity, providerChanged.identity)
  await writeFile(join(profile, 'node_modules', '@liustack', 'modlens', 'dist', 'main.js'), 'export const modlens = 2\n')
  assert.notEqual(invoke().identity, profileChanged.identity, 'direct registry package executable bytes must participate in identity')
})

test('desktop page loading recovers from a transient connection refusal', async () => {
  let calls = 0
  const retries = []
  const target = {
    isDestroyed: () => false,
    async loadURL(url) {
      calls += 1
      assert.equal(url, 'http://127.0.0.1:3080/')
      if (calls < 3) throw new Error('ERR_CONNECTION_REFUSED')
    },
  }
  const result = await loadProductPage(target, 'http://127.0.0.1:3080', {
    intervalMs: 0,
    wait: async () => {},
    onRetry: event => { retries.push(event) },
  })
  assert.equal(result.attempts, 3)
  assert.equal(retries.length, 2)
  assert.match(retries[0].message, /ERR_CONNECTION_REFUSED/u)
})

test('desktop page loading is bounded and reports the final navigation error', async () => {
  let calls = 0
  await assert.rejects(() => loadProductPage({
    isDestroyed: () => false,
    async loadURL() { calls += 1; throw new Error(`refused-${calls}`) },
  }, 'http://127.0.0.1:3080/', { maxAttempts: 3, intervalMs: 0, wait: async () => {} }), /连续 3 次加载失败：refused-3/u)
  assert.equal(calls, 3)
})

test('platform launch commands are argv-only and unsupported systems block', async () => {
  const win = await launchCommand('C:\\XS', 'win32')
  assert.equal(win.args.includes('-NoOpen'), true)
  assert.equal(win.args.includes('-ServerOnly'), true)
  assert.equal(win.args.includes('-OwnershipReport'), true)
  await assert.rejects(() => launchCommand('/tmp/xs', 'linux'), /unsupported/iu)
})

test('Windows launch resolves an installed PowerShell instead of assuming pwsh 7', () => {
  const environment = { ProgramFiles: 'C:\\Programs', SystemRoot: 'C:\\Windows' }
  assert.match(resolvePowerShell(environment, path => path.startsWith('C:\\Windows')), /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu)
  assert.match(resolvePowerShell(environment, path => path.startsWith('C:\\Programs')), /PowerShell[\\/]7[\\/]pwsh\.exe$/iu)
})

test('acceptance auto-quit is gated and bounded', () => {
  assert.equal(acceptanceQuitDelay(['app', '--acceptance-quit-after=1500'], {}), undefined)
  assert.equal(acceptanceQuitDelay(['app', '--acceptance-quit-after=1500'], { XIAOSHE_DESKTOP_ACCEPTANCE: '1' }), 1500)
  assert.equal(acceptanceQuitDelay(['app', '--acceptance-quit-after=1'], { XIAOSHE_DESKTOP_ACCEPTANCE: '1' }), undefined)
})

test('clean renderer retirement retries the current page instead of reloading user state', async () => {
  assert.equal(CURRENT_RENDERER_PROBE_ATTEMPTS, 4)
  assert.equal(CURRENT_RENDERER_PROBE_SETTLE_MS, 500)
  assert.equal(CURRENT_RENDERER_PROBE_TIMEOUT_MS, 750)
  assert.equal(rendererExitAction({ reason: 'clean-exit', visible: true }), 'probe-current')
  assert.equal(rendererExitAction({ reason: 'crashed', visible: true }), 'recover')
  assert.equal(rendererExitAction({ reason: 'clean-exit', visible: false }), 'defer')
  let probes = 0
  const waits = []
  const alive = await rendererProbePassed({
    probe: async () => { probes += 1; return probes === 2 },
    wait: async delay => { waits.push(delay) },
  })
  assert.equal(alive, true)
  assert.equal(probes, 2)
  assert.deepEqual(waits, [500, 750, 500, 750])
})

test('clean renderer retirement recovers after bounded probe failures', async () => {
  let probes = 0
  const unavailable = await rendererProbePassed({
    probe: async () => { probes += 1; throw new Error('disposed frame') },
    wait: async () => {},
    attempts: 3,
  })
  assert.equal(unavailable, false)
  assert.equal(probes, 3)
})

test('authenticated navigation keeps tokens out of receipts and retry errors', async () => {
  const url = 'http://127.0.0.1:3080/?token=' + 's'.repeat(43)
  const receipt = await loadProductPage({ async loadURL(actual) { assert.equal(actual, url) } }, url)
  assert.equal(receipt.url, 'http://127.0.0.1:3080/')
  const retries = []
  await assert.rejects(loadProductPage({ async loadURL() { throw new Error('failed ' + url) } }, url, {
    maxAttempts: 2, intervalMs: 0, onRetry: event => retries.push(event),
  }), error => !error.message.includes('s'.repeat(43)))
  assert.ok(!JSON.stringify(retries).includes('s'.repeat(43)))
})
