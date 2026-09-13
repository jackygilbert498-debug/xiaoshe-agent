import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parse } from 'yaml'
import * as layout from '../src/icon-layout.mjs'
import { icoPngFrames, rgbaPng, visibleBounds } from './icon-fixtures.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productRoot = resolve(desktopRoot, '../..')
const assets = resolve(desktopRoot, 'src/assets')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const config = parse(await readFile(resolve(desktopRoot, 'electron-builder.yml'), 'utf8'))

function coloredBounds(frame) {
  let left = frame.width
  let top = frame.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 4
      const [red, green, blue, alpha] = frame.pixels.subarray(offset, offset + 4)
      // The application tile is neutral white. Counting only visibly coloured
      // pixels measures the formal S itself, independent of the outer tile.
      if (alpha <= 16 || (red >= 235 && green >= 235 && blue >= 235)) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  assert.ok(right >= left && bottom >= top, 'formal mark must contain visible coloured pixels')
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

test('Windows packaged app tile uses the taskbar canvas without the Dock-sized transparent border', async () => {
  const bytes = await readFile(resolve(desktopRoot, config.win.icon))
  // Inspect the actual selected build input, including the existing PNG path,
  // so the regression fails on the observed 81.25% footprint before a fix.
  const frames = bytes.subarray(0, 4).toString('hex') === '89504e47' ? [rgbaPng(bytes)] : icoPngFrames(bytes)
  for (const frame of frames) {
    const bounds = visibleBounds(frame)
    // Explorer already supplies the taskbar's outer breathing room. Leaving a
    // second transparent border in our bitmap made the live mark 39px while
    // neighbouring square icons occupied 47-48px at 200% scaling.
    assert.ok(bounds.width >= Math.floor(frame.width * 0.98), `${frame.width}px: tile is too small (${bounds.width}px visible)`)
    assert.ok(bounds.width <= frame.width, 'tile cannot extend beyond its native frame')
    assert.equal(bounds.width, bounds.height)
    assert.ok(Math.abs(bounds.x - (frame.width - bounds.width) / 2) <= 1, 'tile must stay centered')
    // A one-level alpha fringe is normal when the 16px frame is antialiased;
    // it must not become an opaque square background.
    assert.ok(frame.pixels[3] <= 8, 'rounded corner must remain visually transparent')
  }
})

test('Windows formal mark remains visually substantial inside the compact taskbar tile', async () => {
  const frame = rgbaPng(await readFile(resolve(assets, 'app-icon-win-256.png')))
  const bounds = coloredBounds(frame)
  // At 32px this keeps the narrow S from reading as a tiny badge while still
  // preserving clear white breathing room around the reviewed formal mark.
  assert.ok(bounds.width >= 0.52 * frame.width, `formal mark is too narrow (${bounds.width}px)`)
  assert.ok(bounds.height >= 0.78 * frame.height, `formal mark is too short (${bounds.height}px)`)
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - frame.width / 2) <= 3, 'formal mark must stay optically centered')
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - frame.height / 2) <= 3, 'formal mark must stay vertically centered')
})

test('Windows executable supplies crisp native icon frames for common taskbar scales', async () => {
  const frames = icoPngFrames(await readFile(resolve(desktopRoot, config.win.icon)))
  assert.deepEqual(frames.map(frame => frame.size), [16, 20, 24, 32, 40, 48, 64, 128, 256])
})

test('Windows window icon is the same artwork as the executable, not the old padded app tile', async () => {
  assert.equal(typeof layout.appIconPath, 'function', 'application icon selection must distinguish Windows from macOS')
  const path = layout.appIconPath({ platform: 'win32', size: 256, productRoot, desktopRoot })
  assert.equal(path, resolve(assets, 'app-icon-win-256.png'))
  const png = await readFile(path)
  const frame = icoPngFrames(await readFile(resolve(desktopRoot, config.win.icon))).find(item => item.size === 256)
  assert.deepEqual(png, frame.png, 'window and EXE must not show different icon padding')
})

test('Windows taskbar identity does not reuse the cached pre-resize artwork identity', () => {
  assert.equal(typeof layout.applicationUserModelId, 'function', 'Windows taskbar identity selection must be explicit')
  assert.equal(layout.applicationUserModelId('win32'), config.win.appId)
  assert.notEqual(config.win.appId, config.appId, 'the resized Windows icon needs a fresh taskbar cache identity')
  assert.equal(layout.applicationUserModelId('darwin'), config.appId, 'macOS application identity must remain unchanged')
  assert.equal(config.nsis.guid, 'ba0f3e97-dae3-539b-9849-e666817b715c', 'Windows identity migration must preserve silent installer upgrades')
})

test('packaged Windows assigns the reviewed artwork directly to its taskbar window', () => {
  assert.equal(typeof layout.browserWindowIconOptions, 'function', 'window icon policy must be explicit and testable')
  const icon = { identity: 'reviewed-mark' }
  assert.deepEqual(layout.browserWindowIconOptions({ platform: 'win32', packaged: true, icon }), { icon })
  assert.deepEqual(layout.browserWindowIconOptions({ platform: 'win32', packaged: false, icon }), { icon })
  assert.deepEqual(layout.browserWindowIconOptions({ platform: 'darwin', packaged: true, icon }), { icon })
})

test('macOS keeps its reviewed Dock artwork and padding', async () => {
  assert.equal(typeof layout.appIconPath, 'function')
  const path = layout.appIconPath({ platform: 'darwin', size: 512, productRoot, desktopRoot })
  assert.equal(path, resolve(productRoot, 'runtime/xiaoshe-legacy/ui/assets/app-icon-512.png'))
  assert.equal(resolve(desktopRoot, config.mac.icon), path)
  assert.deepEqual(visibleBounds(rgbaPng(await readFile(path))), { x: 48, y: 48, width: 416, height: 416 })
})

test('Windows resizing does not blur the approved mark through nested SVG rasterization', async () => {
  const frame = rgbaPng(await readFile(resolve(assets, 'app-icon-win-256.png')))
  // Sample a straight left edge proportionally so the sharpness check remains
  // valid when Windows framing changes. A single master resize needs no more
  // than two mixed pixels between the white tile and the dark formal mark.
  const y = Math.round(frame.height * 0.39)
  const x = Math.round(frame.width * 0.19)
  const edge = Array.from({ length: Math.round(frame.width * 0.10) }, (_, index) => frame.pixels[(y * frame.width + x + index) * 4])
  assert.ok(edge.filter(red => red > 90 && red < 250).length <= 2, 'formal mark edge became unnecessarily soft')
})

test('Windows artwork optically scales only the exact approved formal mark', async () => {
  const svg = await readFile(resolve(assets, 'app-icon-win.svg'), 'utf8').catch(() => '')
  const sourceSvg = await readFile(resolve(productRoot, 'runtime/xiaoshe-legacy/ui/assets/app-icon.svg'))
  const source = await readFile(resolve(productRoot, 'runtime/xiaoshe-legacy/ui/assets/app-icon-512.png'))
  const formal = await readFile(resolve(productRoot, 'runtime/xiaoshe-legacy/ui/assets/snake.svg'))
  const embedded = svg.match(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/u)?.[1]
  assert.ok(embedded, 'Windows icon must embed the approved formal mark')
  assert.deepEqual(Buffer.from(embedded, 'base64'), formal, 'formal geometry must never be redrawn')
  assert.match(svg, /<rect x="48" y="48" width="416" height="416" rx="94" fill="#ffffff"\/>/u, 'approved white tile must not change')
  assert.match(svg, /viewBox="48 48 416 416"/u, 'Windows must let Explorer own the outer taskbar padding')
  assert.equal(svg.split('x="8" y="8" width="496" height="496"').length - 1, 3, 'mask, formal source and gradient surface must share one optical scale')
  const manifest = JSON.parse(await readFile(resolve(assets, 'app-icon-win.manifest.json'), 'utf8'))
  assert.equal(manifest.sourceSha256, sha(sourceSvg))
  assert.equal(manifest.approvedPngSourceSha256, sha(source))
  assert.equal(manifest.formalSourceSha256, sha(formal))
  assert.deepEqual(manifest.viewBox, [48, 48, 416, 416])
  assert.deepEqual(manifest.windowsMarkLayout, { x: 8, y: 8, size: 496, scale: 496 / 432 })
  for (const [name, hash] of Object.entries(manifest.outputs)) assert.equal(sha(await readFile(resolve(assets, name))), hash, `${name} has drifted from the export`)
})
