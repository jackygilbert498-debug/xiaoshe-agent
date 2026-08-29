import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const officialRoot = resolve(packageRoot, '../../runtime/xiaoshe-legacy/ui')
const baselineRoot = resolve(packageRoot, 'ui-baseline')

async function filesUnder(root: string, at = root): Promise<string[]> {
  // Finder metadata is not part of the immutable UI provenance. Normalize the
  // remaining paths so the same contract runs on macOS and Windows.
  const entries = (await readdir(at, { withFileTypes: true }))
    .filter(entry => entry.name !== '.DS_Store')
  const files = await Promise.all(entries.map(entry => entry.isDirectory()
    ? filesUnder(root, resolve(at, entry.name))
    : Promise.resolve([relative(root, resolve(at, entry.name)).split(sep).join('/')])))
  return files.flat().sort()
}

async function treeHash(root: string): Promise<string> {
  const digest = createHash('sha256')
  for (const path of await filesUnder(root)) {
    digest.update(path).update('\0').update(await readFile(resolve(root, path))).update('\0')
  }
  return digest.digest('hex')
}

describe('immutable old-shell provenance', () => {
  it('keeps an exact copied baseline and an official-only working brand asset', async () => {
    const officialFiles = await filesUnder(officialRoot)
    const baselineFiles = await filesUnder(baselineRoot)
    expect(officialFiles).toHaveLength(57)
    expect(baselineFiles).toEqual(officialFiles)
    expect(await treeHash(baselineRoot)).toBe(await treeHash(officialRoot))
    expect(await readFile(resolve(packageRoot, 'ui/assets/snake.svg')))
      .toEqual(await readFile(resolve(officialRoot, 'assets/snake.svg')))
    expect(await readFile(resolve(packageRoot, 'ui/assets/icon-256.png')))
      .toEqual(await readFile(resolve(officialRoot, 'assets/icon-256.png')))
  })

  it('does not copy the retired legacy protocol into the working UI surface', async () => {
    const working = await filesUnder(resolve(packageRoot, 'ui'))
    expect(working.some(path => path.startsWith('js/'))).toBe(false)
    expect(working).not.toContain('index.html')
    expect(working).not.toContain('service-worker.js')
    expect(working).toContain('assets/snake.svg')
  })
})
