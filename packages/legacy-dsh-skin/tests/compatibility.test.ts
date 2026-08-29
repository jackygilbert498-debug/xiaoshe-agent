import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(packageRoot, '../..')
const artifactPath = resolve(packageRoot, 'lib/client.js')

afterEach(async () => {
  await rm(resolve(packageRoot, 'lib'), { recursive: true, force: true })
})

describe('legacy DSH skin compatibility package', () => {
  it('builds a byte-preserving compatibility artifact with its own module id', async () => {
    await execFileAsync(process.execPath, ['./scripts/build-client.mjs'], {
      cwd: packageRoot,
      windowsHide: true,
    })

    const source = await readFile(resolve(workspaceRoot, 'client.js'), 'utf8')
    const artifact = await readFile(artifactPath, 'utf8')
    const expected = source.replace(
      "id: '@xiaoshe/dsh-desktop-control'",
      "id: '@xiaoshe/legacy-dsh-skin'",
    )

    expect(source.match(/id: '@xiaoshe\/dsh-desktop-control'/g)).toHaveLength(1)
    expect(artifact).toBe(expected)
    expect(artifact).toContain("id: '@xiaoshe/legacy-dsh-skin'")
  })

  it('declares a browser face and a compatibility-only self-mounting Bundle', async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
      dependencies?: Record<string, string>
    }
    const patch = await readFile(resolve(packageRoot, 'cordis.patch.yml'), 'utf8')

    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toBeUndefined()
    expect(patch).toContain("name: '@xiaoshe/legacy-dsh-skin'")
    expect(patch).not.toContain('@xiaoshe/dsh-desktop-control')
  })
})
