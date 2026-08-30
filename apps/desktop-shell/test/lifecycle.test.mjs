import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acceptanceQuitDelay, defaultProductRoot, launchCommand, prepareProductRoot, productRootOverride, resolvePowerShell, waitForReady } from '../src/lifecycle.mjs'

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
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-product-root-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resourcesPath = join(root, 'signed-app', 'resources')
  const source = join(resourcesPath, 'product')
  const userDataPath = join(root, 'user-data')
  for (const relative of ['runtime/DSH', 'setup', 'scripts']) await mkdir(join(source, relative), { recursive: true })
  await writeFile(join(source, 'package.json'), '{"name":"xiaoshe"}\n')
  await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(source, 'runtime/DSH/package.json'), '{"name":"dsh"}\n')
  await writeFile(join(source, 'setup/install-windows.ps1'), '# installer\n')
  await writeFile(join(source, 'scripts/start-xiaoshe-web.sh'), '#!/bin/bash\n')

  const prepared = await prepareProductRoot({ packaged: true, resourcesPath, userDataPath, version: '0.2.0' })
  assert.notEqual(prepared, source)
  assert.equal(prepared.startsWith(userDataPath), true)
  assert.equal(await readFile(join(prepared, 'package.json'), 'utf8'), '{"name":"xiaoshe"}\n')
  await writeFile(join(prepared, '.runtime-state'), 'preserved')
  assert.equal(await prepareProductRoot({ packaged: true, resourcesPath, userDataPath, version: '0.2.0' }), prepared)
  assert.equal(await readFile(join(prepared, '.runtime-state'), 'utf8'), 'preserved')
  assert.equal(await readFile(join(source, 'package.json'), 'utf8'), '{"name":"xiaoshe"}\n')
})

test('readiness requires the Xiaoshe product and ready bridge facts', async () => {
  let calls = 0
  const value = await waitForReady('http://127.0.0.1:3080/', { timeoutMs: 200, intervalMs: 1, fetcher: async () => {
    calls += 1
    return { ok: true, status: 200, async json() { return calls < 2 ? { product: '小蛇', bridge: { state: 'starting' } } : { product: '小蛇', bridge: { state: 'ready' } } } }
  } })
  assert.equal(value.bridge.state, 'ready')
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
