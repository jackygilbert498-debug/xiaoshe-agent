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

describe('V6 dynamic Client artifact', () => {
  it('builds a self-contained public Client row with Heritage CSS and bounded branding', async () => {
    await execFileAsync(process.execPath, ['./scripts/build-client.mjs'], { cwd: packageRoot, windowsHide: true })
    const source = await readFile(artifact, 'utf8')

    expect(source.match(/__ModuleLoader__\.load\(/g)).toHaveLength(1)
    expect(source).toContain("id: '@xiaoshe/native-shell-candidate-v6'")
    expect(source).toMatch(/require\(["']react["']\)/)
    expect(source).toContain('data-xiaoshe-shell-v6')
    expect(source).toContain('/api/xiaoshe/candidate-v6-brand-icon?v=')
    expect(source).toContain('xiaoshe-candidate-v6-browser-icon')
    expect(source).toContain('MutationObserver')
    expect(source).toContain('grid-template-columns:232px minmax(0,1fr) 292px')
    expect(source).toContain('grid-template-rows:minmax(0,1fr) 26px')
    expect(source).toContain('max-width:720px')
    expect(source).toContain('border-radius:var(--r-2xl)')
    expect(source).not.toContain('__XIAOSHE_V6_HERITAGE_CSS__')
    expect(source).not.toContain('runtime/DSH')
    expect(source).not.toContain('runtime\\DSH')
    expect(source).not.toContain('document.body')
  })
})
