import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('root integration gate isolation', () => {
  it('serializes test files that share generated workspace artifacts', async () => {
    const source = await readFile('vitest.config.ts', 'utf8')

    expect(source).toMatch(/fileParallelism:\s*false/u)
  })
})
