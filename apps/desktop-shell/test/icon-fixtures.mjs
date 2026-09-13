// Small, strict decoder for the non-interlaced RGBA PNGs we ship. Keeping this
// in test utilities avoids adding a renderer/image dependency to the desktop.
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'

export function rgbaPng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20)
  assert.ok(width > 0 && width <= 512 && height > 0 && height <= 512)
  assert.deepEqual([...bytes.subarray(24, 29)], [8, 6, 0, 0, 0], 'export must be 8-bit non-interlaced RGBA')
  const chunks = []
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    assert.ok(offset + length + 12 <= bytes.length, 'truncated PNG chunk')
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
  }
  const stride = width * 4
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height })
  assert.equal(raw.length, (stride + 1) * height)
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    assert.ok(filter >= 0 && filter <= 4)
    for (let x = 0; x < stride; x += 1) {
      const index = y * stride + x
      const left = x >= 4 ? pixels[index - 4] : 0
      const up = y > 0 ? pixels[index - stride] : 0
      const upperLeft = y > 0 && x >= 4 ? pixels[index - stride - 4] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      if (filter === 2) predictor = up
      if (filter === 3) predictor = Math.floor((left + up) / 2)
      if (filter === 4) {
        const p = left + up - upperLeft
        const distances = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upperLeft)]
        predictor = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : upperLeft
      }
      pixels[index] = raw[y * (stride + 1) + x + 1] + predictor
    }
  }
  return { width, height, pixels }
}

export function icoPngFrames(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0, 'Windows icon must be a multi-resolution ICO, not a renamed PNG')
  assert.equal(bytes.readUInt16LE(2), 1)
  const count = bytes.readUInt16LE(4)
  assert.ok(count > 0 && count <= 20)
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16
    const size = bytes[entry] || 256
    assert.equal(bytes[entry + 1] || 256, size)
    const length = bytes.readUInt32LE(entry + 8); const offset = bytes.readUInt32LE(entry + 12)
    assert.ok(offset >= 6 + count * 16 && offset + length <= bytes.length)
    const png = bytes.subarray(offset, offset + length)
    const decoded = rgbaPng(png)
    assert.equal(decoded.width, size); assert.equal(decoded.height, size)
    return { size, png, ...decoded }
  })
}

export function visibleBounds({ width, height, pixels }) {
  let left = width; let top = height; let right = -1; let bottom = -1
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (pixels[(y * width + x) * 4 + 3] < 128) continue
    left = Math.min(left, x); right = Math.max(right, x)
    top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  assert.ok(right >= left && bottom >= top, 'export must have visible pixels')
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}
