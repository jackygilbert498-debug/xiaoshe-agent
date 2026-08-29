import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('macOS multi-display safety acceptance driver', () => {
  it('filters secondary AX elements and rejects both unavailable targets and out-of-primary coordinates', async () => {
    const source = await readFile(new URL('../scripts/run-macos-multidisplay-safety-acceptance.mjs', import.meta.url), 'utf8')
    expect(source).toContain("screenCount < 2")
    expect(source).toContain("spawn(executable, [resultPath, '1']")
    expect(source).toContain('attempt < 12')
    expect(source).toContain("message.includes('outside the captured primary screen')")
    expect(source).toContain("element_id: 'secondary-display-target-must-not-resolve'")
    expect(source).toContain("image_x: observed.pixel_size.width")
    expect(source).toContain("coordinateKind !== 'INVALID_PARAMS'")
    expect(source).toContain('noSecondaryBusinessAction: true')
  })
})
