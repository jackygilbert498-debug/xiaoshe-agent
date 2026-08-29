import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('runtime DSH provider artifact', () => {
  it('builds one public-contract-only dynamic Client row', async () => {
    await execFileAsync(process.execPath, ['./scripts/build-client.mjs'], { cwd: process.cwd() })
    const source = await readFile('lib/client.js', 'utf8')
    expect(source.match(/__ModuleLoader__\.load\(/g)).toHaveLength(1)
    expect(source).toContain("id: '@xiaoshe/runtime-dsh-provider'")
    expect(source).not.toMatch(/runtime[\\/]DSH|querySelector|MutationObserver|SessionRuntime/)
    expect(source).not.toMatch(/require\(["']@xiaoshe\/runtime-contract["']\)/)
  })
})
