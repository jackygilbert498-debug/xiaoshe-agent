import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { apply, BRAND_ICON_PATH } from '../src/index.js'
import { BROWSER_BRAND_ICON_HREF } from '../src/client/index.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('candidate Host brand asset', () => {
  it('uses a candidate-only exact route and releases it', () => {
    let route: { path: string; handler(request: unknown, response: { writeHead(status: number, headers: Record<string, string>): unknown; end(data?: string): void }): void } | undefined
    const release = vi.fn()
    apply({ webServer: { register(value) { route = value; return release } }, effect(execute) { return execute() } })
    expect(route?.path).toBe('/api/xiaoshe/candidate-brand-icon')
    let body = ''; let status = 0
    route?.handler({}, { writeHead(value) { status = value; return this }, end(value = '') { body = value } })
    expect(status).toBe(200)
    expect(body).toContain('aria-label="小蛇"')
  })

  it('packages the canonical legacy UI brand asset without redrawing it', async () => {
    const [packaged, canonical] = await Promise.all([
      readFile(resolve(packageRoot, 'assets/snake.svg'), 'utf8'),
      readFile(resolve(packageRoot, '../../runtime/xiaoshe-legacy/ui/assets/snake.svg'), 'utf8'),
    ])
    expect(packaged).toBe(canonical)
    const cacheKey = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
    expect(BROWSER_BRAND_ICON_HREF).toBe(`${BRAND_ICON_PATH}?v=${cacheKey}`)
  })
})
