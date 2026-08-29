import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Windows capability package boundary', () => {
  it('publishes a Host Bundle without an implicit browser face', async () => {
    const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
      exports?: Record<string, unknown>
      files?: string[]
      dsh?: { bundle?: unknown; client?: unknown }
    }

    expect(manifest.dsh?.bundle).toBeDefined()
    expect(manifest.dsh?.client).toBeUndefined()
    expect(manifest.exports?.['./client']).toBeUndefined()
    expect(manifest.files).not.toContain('client.js')
  })
})
