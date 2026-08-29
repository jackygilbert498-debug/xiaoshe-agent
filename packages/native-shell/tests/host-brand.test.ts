import { describe, expect, it, vi } from 'vitest'
import { apply, BRAND_ICON_PATH } from '../src/index.js'

describe('native shell host brand asset', () => {
  it('serves the approved snake logo and releases the route with the plugin effect', () => {
    let route: { path: string; handler(request: unknown, response: { writeHead(status: number, headers: Record<string, string>): unknown; end(data?: string): void }): void } | undefined
    const release = vi.fn()
    apply({
      webServer: { register(value) { route = value; return release } },
      effect(execute) { return execute() },
    })
    expect(route?.path).toBe(BRAND_ICON_PATH)
    let body = ''; let status = 0; let headers: Record<string, string> = {}
    route?.handler({}, { writeHead(value, next) { status = value; headers = next; return this }, end(value = '') { body = value } })
    expect(status).toBe(200)
    expect(headers['content-type']).toContain('image/svg+xml')
    expect(body).toContain('aria-label="小蛇"')
  })
})
