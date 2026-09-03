import assert from 'node:assert/strict'
import test from 'node:test'

import { alphaBounds, fittedWidth, trayHeightForDisplay } from '../src/icon-layout.mjs'

test('menu icon layout removes transparent padding without changing the visible geometry', () => {
  const bitmap = new Uint8Array(16 * 16 * 4)
  for (let y = 3; y < 15; y += 1) {
    for (let x = 4; x < 12; x += 1) bitmap[(y * 16 + x) * 4 + 3] = 255
  }
  const bounds = alphaBounds(bitmap, 16, 16)
  assert.deepEqual(bounds, { x: 4, y: 3, width: 8, height: 12 })
  assert.equal(fittedWidth(bounds, 15), 10)
})

test('menu icon layout rejects empty or malformed image data', () => {
  assert.throws(() => alphaBounds(new Uint8Array(16), 16, 16), /four bytes per pixel/u)
  assert.throws(() => alphaBounds(new Uint8Array(16 * 16 * 4), 16, 16), /no visible pixels/u)
  assert.throws(() => fittedWidth({ width: 0, height: 12 }, 15), /must be positive/u)
})

test('menu icon height follows the primary display menu-bar proportion within safe bounds', () => {
  assert.equal(trayHeightForDisplay({ bounds: { y: 0 }, workArea: { y: 24 } }), 15)
  assert.equal(trayHeightForDisplay({ bounds: { y: -900 }, workArea: { y: -878 } }), 14)
  assert.equal(trayHeightForDisplay({ bounds: { y: 0 }, workArea: { y: 28 } }), 17)
  assert.equal(trayHeightForDisplay({ bounds: { y: 0 }, workArea: { y: 38 } }), 17)
})

test('menu icon height preserves the reviewed baseline when display geometry is unavailable', () => {
  assert.equal(trayHeightForDisplay({ bounds: { y: 0 }, workArea: { y: 0 } }), 15)
  assert.equal(trayHeightForDisplay(undefined), 15)
  assert.throws(() => trayHeightForDisplay(undefined, 0), /positive integer/u)
})
