import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CURRENT_RENDERER_PROBE_ATTEMPTS, CURRENT_RENDERER_PROBE_SETTLE_MS, CURRENT_RENDERER_PROBE_TIMEOUT_MS, acceptanceQuitDelay, defaultProductRoot, launchCommand, loadProductPage, prepareProductRoot, productRootOverride, rendererExitAction, rendererProbePassed, resolvePowerShell, waitForReady } from '../src/lifecycle.mjs'

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
  for (const relative of ['runtime/DSH', 'runtime/xiaoshe-legacy/ui/assets', 'setup', 'scripts']) {
    await mkdir(join(source, relative), { recursive: true })
  }
  await writeFile(join(source, 'package.json'), '{"name":"xiaoshe"}\n')
  await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(source, 'runtime/DSH/package.json'), '{"name":"dsh"}\n')
  await writeFile(join(source, 'setup/install-windows.ps1'), '# installer\n')
  await writeFile(join(source, 'scripts/start-xiaoshe-web.sh'), '#!/bin/bash\n')
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

test('development and packaged product roots remain explicit', () => {
  assert.match(defaultProductRoot({ packaged: true, resourcesPath: 'C:\\Program Files\\Xiaoshe\\resources' }), /resources[\\/]product$/u)
  assert.match(defaultProductRoot({ packaged: false, resourcesPath: '', moduleUrl: 'file:///C:/repo/apps/desktop-shell/src/lifecycle.mjs' }), /C:[\\/]repo$/iu)
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

test('readiness requires the Xiaoshe product and ready bridge facts', async () => {
  let calls = 0
  const value = await waitForReady('http://127.0.0.1:3080/', { timeoutMs: 200, intervalMs: 1, fetcher: async () => {
    calls += 1
    return { ok: true, status: 200, async json() { return calls < 2 ? { product: '小蛇', bridge: { state: 'starting' } } : { product: '小蛇', bridge: { state: 'ready' } } } }
  } })
  assert.equal(value.bridge.state, 'ready')
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
