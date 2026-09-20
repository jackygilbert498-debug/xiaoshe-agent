/** Deterministic, text-free visual challenge. No files, models or network I/O. */
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'

const digest = value => createHash('sha256').update(value).digest('hex')
const colors = [['red', [229, 57, 53]], ['blue', [25, 118, 210]], ['green', [46, 125, 50]], ['yellow', [253, 216, 53]]]
const shapes = ['circle', 'square', 'triangle']
const width = 600, height = 400

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}

/** Keep manifest (including nonce/answer) OUTSIDE the model-visible workspace. */
export function createVisionFixture({ nonce }) {
  if (typeof nonce !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{64})$/u.test(nonce)) throw new Error('vision-fixture: invalid_nonce')
  const seed = createHash('sha256').update(`vision-fixture/v1:${nonce}`).digest()
  const rows = [[], []], pixels = Buffer.alloc(width * height * 3, 255)
  for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
    const cell = row * 3 + col, [color, rgb] = colors[seed[cell * 2] % colors.length]
    const shape = shapes[seed[cell * 2 + 1] % shapes.length]
    rows[row].push({ color, shape })
    const cx = col * 200 + 100, cy = row * 200 + 100
    for (let dy = -60; dy <= 60; dy++) for (let dx = -60; dx <= 60; dx++) {
      const filled = shape === 'circle' ? dx * dx + dy * dy <= 55 * 55
        : shape === 'square' ? Math.abs(dx) <= 53 && Math.abs(dy) <= 53
          : Math.abs(dx) <= (dy + 60) / 2
      if (filled) for (let channel = 0; channel < 3; channel++) pixels[((cy + dy) * width + cx + dx) * 3 + channel] = rgb[channel]
    }
  }
  const scanlines = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  // Only IHDR/IDAT/IEND: no text, EXIF, nonce or ground-truth metadata.
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))])
  return { png, manifest: { schema: 'xiaoshe-vision-fixture/v1', nonce, mediaType: 'image/png', width, height,
    imageSha256: digest(png), pixelsSha256: digest(pixels), expected: { rows } } }
}

/** Reconstruct both pixels and answer from the private nonce; reject tampering. */
export function assertVisionFixture(fixture) {
  if (!fixture || !Buffer.isBuffer(fixture.png)) throw new Error('vision-fixture: invalid_png')
  const expected = createVisionFixture({ nonce: fixture.manifest?.nonce })
  if (!isDeepStrictEqual(fixture.manifest, expected.manifest) || !fixture.png.equals(expected.png)) throw new Error('vision-fixture: binding_mismatch')
  return fixture.manifest
}

export const VISION_QUESTION = '请只根据图片的实际视觉内容，按从上到下两行、每行从左到右三个物体，识别各物体的颜色和形状。颜色仅用 red、blue、green、yellow，形状仅用 circle、square、triangle。最终只输出原始 JSON，不加 Markdown 代码围栏或任何解释，顶层只有 rows，rows 是两行数组，每行三个对象，每个对象只有 color 和 shape。不要猜测或使用 OCR、终端、文本读取工具。若调用视觉桥，请要求其 summary 字段也只放上述 JSON 字符串，ocr.full_text 及 ocr.lines 保持为空；不能识别就明确说明失败。'

export function visionQuestion(input) {
  if (input?.kind === 'attachment') return VISION_QUESTION
  if (input?.kind === 'path' && typeof input.path === 'string') return `${VISION_QUESTION}\n图像路径：${input.path}`
  throw new Error('vision-fixture: invalid_input_kind')
}
