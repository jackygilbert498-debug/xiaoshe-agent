/**
 * Full-package, non-GUI acceptance. Exercises the ASAR's actual materializer,
 * a legacy same-version runtime, every shipped file and the real private IPC
 * transport. It deliberately does not certify Electron window/tray appearance.
 * Usage: node test/run-runtime-acceptance.mjs <win-unpacked> <report.json>
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [input, output, ...extra] = process.argv.slice(2)
if (!input || !output || extra.length) throw new Error('Usage: run-runtime-acceptance.mjs <package directory> <report.json>')
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(input)
const resourcesPath = join(packageRoot, 'resources')
const source = join(resourcesPath, 'product')
const requireApp = createRequire(join(desktopRoot, 'package.json'))
const requireBuilder = createRequire(requireApp.resolve('electron-builder'))
const asar = createRequire(requireBuilder.resolve('app-builder-lib'))('@electron/asar')
const archive = join(resourcesPath, 'app.asar')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { schemaVersion: 1, scope: 'full-package-runtime-and-private-protocol', nativeGuiAcceptance: 'not-run', checks: [], passed: false }
const root = await mkdtemp(join(tmpdir(), 'xiaoshe-runtime-acceptance-'))
report.isolation = { userDataPath: join(root, 'user-data'), productRootOverride: 'not-used' }
let endpoint
async function isolatedPort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.equal(typeof address, 'object')
  const port = address.port
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return port
}
async function check(name, action) {
  const started = performance.now()
  const detail = await action()
  report.checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - started), ...(detail === undefined ? {} : { detail }) })
  process.stdout.write(`${name}: passed\n`)
}
try {
  const lifecycleBytes = asar.extractFile(archive, join('src', 'lifecycle.mjs'))
  assert.equal(sha(lifecycleBytes), sha(await readFile(join(desktopRoot, 'src/lifecycle.mjs'))), 'candidate lifecycle is stale')
  await writeFile(join(root, 'packaged-lifecycle.mjs'), lifecycleBytes)
  const { prepareProductRoot } = await import(pathToFileURL(join(root, 'packaged-lifecycle.mjs')).href)
  const { version } = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  const options = { packaged: true, resourcesPath, userDataPath: join(root, 'user-data'), version }
  const target = join(options.userDataPath, 'runtime', version)

  await check('legacy missing-module startup is reproduced', async () => {
    await cp(source, target, { recursive: true, force: false, errorOnExist: true })
    await writeFile(join(target, '.xiaoshe-product-runtime.json'), JSON.stringify({ schemaVersion: 1, version }))
    await rm(join(target, 'scripts/isolated-browser-protocol.mjs'))
    await assert.rejects(import(pathToFileURL(join(target, 'scripts/isolated-browser-protocol.mjs')).href), { code: 'ERR_MODULE_NOT_FOUND' })
  })
  await check('ASAR materializer repairs the legacy full runtime', async () => {
    assert.equal(await prepareProductRoot(options), target)
    const recovery = (await readdir(join(options.userDataPath, 'runtime'))).filter(name => name.startsWith(`${version}.recovery-`))
    assert.equal(recovery.length, 1)
    await assert.rejects(readFile(join(options.userDataPath, 'runtime', recovery[0], 'scripts/isolated-browser-protocol.mjs')), { code: 'ENOENT' })
  })
  await check('every shipped file matches the activated runtime', async () => {
    let checked = 0
    async function visit(relative = '') {
      for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
        const file = join(relative, entry.name)
        assert.equal(entry.isSymbolicLink(), false, `unexpected shipped link: ${file}`)
        if (entry.isDirectory()) await visit(file)
        else {
          assert.equal(sha(await readFile(join(source, file))), sha(await readFile(join(target, file))), `runtime mismatch: ${file}`)
          checked += 1
        }
      }
    }
    await visit()
    assert.ok(checked > 100, 'acceptance must use the real product bundle')
    return { files: checked }
  })
  await check('repeated startup reuses the verified runtime without state loss', async () => {
    const marker = join(target, '.xiaoshe-product-runtime.json')
    const before = (await stat(marker)).mtimeMs
    await writeFile(join(target, '.acceptance-state'), 'preserved')
    await prepareProductRoot(options)
    await prepareProductRoot(options)
    assert.equal((await stat(marker)).mtimeMs, before)
    assert.equal(await readFile(join(target, '.acceptance-state'), 'utf8'), 'preserved')
    assert.equal((await readdir(join(options.userDataPath, 'runtime'))).filter(name => name.includes('.recovery-')).length, 1)
  })
  await check('repaired protocol imports and completes a real private transport roundtrip', async () => {
    const protocol = await import(pathToFileURL(join(target, 'scripts/isolated-browser-protocol.mjs')).href)
    const bridgeRoot = join(root, 'private-test-bridge')
    const port = await isolatedPort()
    const origin = `http://127.0.0.1:${port}`
    report.isolation.privateProtocolPort = port
    endpoint = await protocol.createBrowserEndpoint({ origin, root: bridgeRoot,
      dispatch: async (owner, command) => ({ owner, command, ready: true }) })
    const result = await protocol.requestBrowser({ origin, root: bridgeRoot, ownerId: 'acceptance-only', command: 'status' })
    assert.deepEqual(result, { owner: 'acceptance-only', command: 'status', ready: true })
    await endpoint.close(); endpoint = undefined
    assert.deepEqual(await readdir(bridgeRoot), [])
  })
  report.archiveSha256 = sha(await readFile(archive))
  report.passed = true
} catch (error) {
  report.error = String(error?.stack || error)
  process.exitCode = 1
} finally {
  await endpoint?.close()
  // Only remove the fresh fixture, never a caller-supplied product/user path.
  const canonicalTemporary = await realpath(tmpdir())
  const canonicalRoot = await realpath(root)
  assert.ok(canonicalRoot.startsWith(`${canonicalTemporary}${sep}xiaoshe-runtime-acceptance-`))
  assert.equal((await lstat(root)).isSymbolicLink(), false)
  await rm(root, { recursive: true, force: true })
  report.temporaryFixtureRemoved = true
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`)
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
