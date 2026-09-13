import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as layout from '../src/icon-layout.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productRoot = resolve(desktopRoot, '../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('Windows tray selects the white formal mark, not legacy colored favicons', () => {
  assert.equal(typeof layout.trayImagePaths, 'function', 'tray source must distinguish Windows monochrome assets')
  assert.deepEqual(layout.trayImagePaths({ platform: 'win32', productRoot, desktopRoot }), {
    standard: resolve(desktopRoot, 'src/assets/tray-white-32.png'),
    retina: resolve(desktopRoot, 'src/assets/tray-white-64.png'),
  })
})

test('macOS tray retains its reviewed template source', () => {
  assert.equal(typeof layout.trayImagePaths, 'function')
  assert.deepEqual(layout.trayImagePaths({ platform: 'darwin', productRoot, desktopRoot }), {
    standard: resolve(productRoot, 'runtime/xiaoshe-legacy/ui/assets/icon-16.png'),
    retina: resolve(productRoot, 'runtime/xiaoshe-legacy/ui/assets/icon-32.png'),
  })
})

test('Windows tray exports preserve the exact formal SVG and its generation provenance', async () => {
  const assets = resolve(desktopRoot, 'src/assets')
  const svg = await readFile(resolve(assets, 'tray-white.svg'), 'utf8').catch(() => '')
  const embedded = svg.match(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/u)?.[1]
  assert.ok(embedded, 'tray must derive its silhouette from the formal source, not a colored favicon')
  const source = await readFile(resolve(productRoot, 'runtime/xiaoshe-legacy/ui/assets/snake.svg'))
  assert.deepEqual(Buffer.from(embedded, 'base64'), source)
  // An alpha mask keeps the actual pupil cutout; luminance would weaken the
  // mark according to the legacy SVG color and is not an acceptable substitute.
  assert.match(svg, /mask-type="alpha"/u)
  assert.match(svg, /fill="#ffffff"/u)
  assert.doesNotMatch(svg, /<path\b/u, 'wrapper must not redraw the formal geometry')
  const manifest = JSON.parse(await readFile(resolve(assets, 'tray-white.manifest.json'), 'utf8'))
  assert.equal(manifest.sourceSha256, sha(source), 'formal mark changed: regenerate tray assets')
  for (const size of [32, 64]) {
    const name = `tray-white-${size}.png`
    const png = await readFile(resolve(assets, name))
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(png.readUInt32BE(16), size)
    assert.equal(png.readUInt32BE(20), size)
    assert.equal(sha(png), manifest.outputs[name], `${name} changed outside the formal export`)
  }
})
