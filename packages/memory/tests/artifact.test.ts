import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = resolve(packageRoot, 'lib/client.js')

afterEach(async () => await rm(resolve(packageRoot, 'lib'), { recursive: true, force: true }))

describe('memory Client artifact', () => {
  it('builds one DOM-free ModuleLoader row', async () => {
    await execFileAsync(process.execPath, ['./scripts/build-client.mjs'], { cwd: packageRoot, windowsHide: true })
    const source = await readFile(artifact, 'utf8')
    expect(source.match(/__ModuleLoader__\.load\(/g)).toHaveLength(1)
    expect(source).toContain("id: '@xiaoshe/memory'")
    expect(source).toContain("provide('memoryLifecycle'")
    expect(source).not.toContain('querySelector')
    expect(source).not.toContain('document.')
    expect(source).not.toContain('runtime/DSH')
  })

  it('declares the web Client row and export', async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>
      dsh?: { client?: { platform?: string; immediately?: boolean } }
    }
    expect(manifest.exports?.['./client']).toBe('./lib/client.js')
    expect(manifest.dsh?.client).toMatchObject({ platform: 'web', immediately: true })
  })
})
