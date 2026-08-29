import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = resolve(packageRoot, 'lib/client.js')

afterEach(async () => { await rm(resolve(packageRoot, 'lib'), { recursive: true, force: true }) })

describe('candidate dynamic Client artifact', () => {
  it('builds an isolated public Client row with bounded browser branding and no body takeover', async () => {
    await execFileAsync(process.execPath, ['./scripts/build-client.mjs'], { cwd: packageRoot, windowsHide: true })
    const source = await readFile(artifact, 'utf8')
    expect(source.match(/__ModuleLoader__\.load\(/g)).toHaveLength(1)
    expect(source).toContain("id: '@xiaoshe/native-shell-candidate'")
    expect(source).toMatch(/require\(["']react["']\)/)
    expect(source).not.toContain('runtime/DSH')
    expect(source).not.toContain('runtime\\DSH')
    expect(source).toContain("link[rel~='icon']")
    expect(source).toContain('xiaoshe-candidate-browser-icon')
    expect(source).toContain('/api/xiaoshe/candidate-brand-icon?v=')
    expect(source).toContain('MutationObserver')
    expect(source).not.toContain('document.body')
  })
})
