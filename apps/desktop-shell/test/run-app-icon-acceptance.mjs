/** Read-only package acceptance: checks the actual PE icon resources and ASAR.
 * Does not launch the application or certify the live Windows taskbar cache.
 * Usage: node test/run-app-icon-acceptance.mjs <win-unpacked> <report.json>
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { icoPngFrames, rgbaPng, visibleBounds } from './icon-fixtures.mjs'

const [input, output, ...extra] = process.argv.slice(2)
if (!input || !output || extra.length) throw new Error('Usage: run-app-icon-acceptance.mjs <package directory> <report.json>')
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = resolve(input)
const requireApp = createRequire(join(desktopRoot, 'package.json'))
const requireBuilder = createRequire(requireApp.resolve('electron-builder'))
const requirePackaging = createRequire(requireBuilder.resolve('app-builder-lib'))
const asar = requirePackaging('@electron/asar')
const { NtExecutable, NtExecutableResource, Resource } = requirePackaging('resedit')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { schemaVersion: 1, scope: 'Windows packaged application icon', packageRoot, nativeGuiAcceptance: 'not-run', passed: false, checks: [] }
async function check(name, action) {
  const detail = await action()
  report.checks.push({ name, passed: true, detail })
  process.stdout.write(`${name}: passed\n`)
}
try {
  await check('EXE actually contains all nine approved Windows icon frames', async () => {
    const bytes = await readFile(join(packageRoot, '小蛇.exe'))
    const resources = NtExecutableResource.from(NtExecutable.from(bytes))
    const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
    assert.equal(groups.length, 1, 'unexpected additional app icon groups')
    const actual = groups[0].getIconItemsFromEntries(resources.entries)
    const expected = icoPngFrames(await readFile(join(desktopRoot, 'src/assets/app-icon-win.ico')))
    assert.equal(actual.length, expected.length, 'EXE still carries the old icon set')
    const frames = []
    for (const item of expected) {
      // PE/ICO directory dimensions encode 256 as zero; resedit preserves
      // those raw group values instead of normalizing them to PNG dimensions.
      const embedded = actual.find(icon => (icon.width || 256) === item.size && (icon.height || 256) === item.size)
      assert.ok(embedded?.isRaw(), `${item.size}px PNG resource is missing`)
      assert.equal(sha(Buffer.from(embedded.bin)), sha(item.png), `${item.size}px EXE icon is stale`)
      const bounds = visibleBounds(rgbaPng(Buffer.from(embedded.bin)))
      frames.push({ size: item.size, bounds })
    }
    return { executableSha256: sha(bytes), frames }
  })
  const archive = join(packageRoot, 'resources/app.asar')
  await check('ASAR window artwork and icon selection match the verified source', async () => {
    for (const name of ['main.mjs', 'icon-layout.mjs', 'assets/app-icon-win-256.png', 'assets/app-icon-win-512.png', 'assets/app-icon-win.ico', 'assets/app-icon-win.svg', 'assets/app-icon-win.manifest.json', 'assets/tray-white-32.png', 'assets/tray-white-64.png']) {
      assert.equal(sha(asar.extractFile(archive, join('src', ...name.split('/')))), sha(await readFile(join(desktopRoot, 'src', name))), `${name} was not packaged correctly`)
    }
    const module = asar.extractFile(archive, join('src', 'icon-layout.mjs'))
    const { appIconPath, applicationUserModelId, browserWindowIconOptions, trayImagePaths } = await import(`data:text/javascript;base64,${module.toString('base64')}`)
    const args = { desktopRoot: archive, productRoot: join(packageRoot, 'resources/product'), size: 256 }
    assert.equal(appIconPath({ ...args, platform: 'win32' }), join(archive, 'src/assets/app-icon-win-256.png'))
    assert.equal(appIconPath({ ...args, platform: 'darwin', size: 512 }), join(args.productRoot, 'runtime/xiaoshe-legacy/ui/assets/app-icon-512.png'))
    assert.equal(trayImagePaths({ ...args, platform: 'win32' }).standard, join(archive, 'src/assets/tray-white-32.png'))
    assert.equal(applicationUserModelId('win32'), 'com.xiaoshe.desktop.icon-v4', 'package must use the taskbar identity that invalidates the stale icon cache')
    assert.deepEqual(browserWindowIconOptions({ platform: 'win32', packaged: true, icon: 'reviewed-mark' }), { icon: 'reviewed-mark' }, 'packaged Windows must assign the reviewed icon directly to the taskbar window')
    return { asarSha256: sha(await readFile(archive)), windowPixelBounds: visibleBounds(rgbaPng(asar.extractFile(archive, join('src', 'assets', 'app-icon-win-256.png')))) }
  })
  await check('approved mark, macOS assets and existing tray images are unchanged', async () => {
    const assets = 'runtime/xiaoshe-legacy/ui/assets'
    const hashes = {}
    for (const name of ['snake.svg', 'app-icon.svg', 'app-icon-256.png', 'app-icon-512.png', 'icon-16.png', 'icon-32.png']) {
      const shipped = await readFile(join(packageRoot, 'resources/product', assets, name))
      assert.equal(sha(shipped), sha(await readFile(join(desktopRoot, '../..', assets, name))), `${name} changed during packaging`)
      hashes[name] = sha(shipped)
    }
    assert.equal(hashes['snake.svg'], '3a919a69c3b6f425545957aacaccd0199364a233bb3a0f4db827f3b5d1efdd75')
    assert.equal(hashes['app-icon-512.png'], 'c6727d0bc3002187834ac56c0fa56d5d0401a66733a1b4c5b7afbffcb472e4c6')
    return hashes
  })
  report.passed = true
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ passed: report.passed, nativeGuiAcceptance: report.nativeGuiAcceptance, error: report.error })}\n`)
}
