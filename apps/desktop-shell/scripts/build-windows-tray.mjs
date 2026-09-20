// Build-time export only. The application ships the resulting PNGs and does
// not depend on a rasterizer. Default: the same rsvg-convert used by app icons.
// Windows build hosts with an existing sharp installation may pass its module
// path via --sharp-module; no machine-specific path is embedded in the output.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(desktopRoot, '../../runtime/xiaoshe-legacy/ui/assets/snake.svg')
const output = resolve(desktopRoot, 'src/assets')
const args = process.argv.slice(2)
if (!(args.length === 1 && args[0] === '--rasterize') &&
    !(args.length === 3 && args[0] === '--rasterize' && args[1] === '--sharp-module' && args[2]?.trim())) {
  throw new Error('Usage: build-windows-tray.mjs --rasterize [--sharp-module <existing module path>]')
}
const sharp = args.length === 3 ? createRequire(import.meta.url)(resolve(args[2])) : undefined
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const source = await readFile(sourcePath)
const svg = `<!-- GENERATED from runtime/xiaoshe-legacy/ui/assets/snake.svg.
  Preserve the embedded source byte-for-byte; never redraw a second mark. -->
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24">
  <defs>
    <mask id="formal-tray-mark" maskUnits="userSpaceOnUse" mask-type="alpha" x="0" y="0" width="24" height="24" style="mask-type:alpha">
      <image href="data:image/svg+xml;base64,${source.toString('base64')}" x="0" y="0" width="24" height="24" preserveAspectRatio="xMidYMid meet"/>
    </mask>
  </defs>
  <rect width="24" height="24" fill="#ffffff" mask="url(#formal-tray-mark)"/>
</svg>
`
await mkdir(output, { recursive: true })
const svgPath = resolve(output, 'tray-white.svg')
await writeFile(svgPath, svg, 'utf8')
const outputs = {}
for (const size of [32, 64]) {
  const name = `tray-white-${size}.png`
  const path = resolve(output, name)
  if (sharp) {
    await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path)
    // Catch a lost alpha mask or incorrect tint at the renderer boundary,
    // including partially covered edge pixels, before recording provenance.
    const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const formal = await sharp(source).resize(size, size).ensureAlpha().raw().toBuffer()
    let transparent = 0; let solid = 0
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const alpha = data[offset + 3]
      if (alpha !== formal[offset + 3]) throw new Error(`${name}: formal silhouette or pupil changed`)
      if (alpha === 0) { transparent += 1; continue }
      if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255) throw new Error(`${name}: non-white pixel`)
      if (alpha === 255) solid += 1
    }
    if (transparent === 0 || solid === 0) throw new Error(`${name}: missing transparent background or solid mark`)
  } else {
    const rendered = spawnSync('rsvg-convert', ['--width', String(size), '--height', String(size), '--format', 'png', '--output', path, svgPath], { stdio: 'inherit', windowsHide: true })
    if (rendered.error) throw rendered.error
    if (rendered.status !== 0) throw new Error(`rsvg-convert exited with ${rendered.status}`)
  }
  outputs[name] = sha(await readFile(path))
}
await writeFile(resolve(output, 'tray-white.manifest.json'), `${JSON.stringify({
  schemaVersion: 1, source: 'runtime/xiaoshe-legacy/ui/assets/snake.svg', sourceSha256: sha(source),
  renderer: sharp ? `sharp ${sharp.versions.sharp} / librsvg ${sharp.versions.rsvg}` : 'rsvg-convert', outputs,
}, null, 2)}\n`, 'utf8')
process.stdout.write('Exported formal white Windows tray icons (32px / 64px).\n')
