import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { BRAND_ICON_PATH, BRAND_RASTER_PATH, apply, name } from '../src/index.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Legacy-adapted host boundary', () => {
  it('serves the canonical old-shell vector and raster assets and releases both on unload', () => {
    const routes = new Map<string, {
      handler(request: unknown, response: {
        writeHead(status: number, headers: Record<string, string>): unknown
        end(data?: string | Uint8Array): void
      }): void
    }>()
    const unregister = vi.fn()
    const effect = vi.fn((execute: () => () => void) => execute())

    apply({
      webServer: {
        register(route) {
          routes.set(route.path, route)
          return unregister
        },
      },
      effect,
    })

    expect(name).toBe('xiaoshe-native-shell-legacy-adapted')
    expect(BRAND_ICON_PATH).toBe('/api/xiaoshe/legacy-adapted-brand-icon')
    expect(BRAND_RASTER_PATH).toBe('/api/xiaoshe/legacy-adapted-brand-raster')
    expect([...routes.keys()]).toEqual([BRAND_ICON_PATH, BRAND_RASTER_PATH])

    const invoke = (path: string): { body: string | Uint8Array | undefined; headers: Record<string, string> } => {
      let body: string | Uint8Array | undefined
      let headers: Record<string, string> = {}
      routes.get(path)?.handler(undefined, {
        writeHead(status, values) { expect(status).toBe(200); headers = values; return this },
        end(value) { body = value },
      })
      return { body, headers }
    }
    const vector = invoke(BRAND_ICON_PATH)
    const raster = invoke(BRAND_RASTER_PATH)
    expect(vector.headers['content-type']).toBe('image/svg+xml; charset=utf-8')
    expect(raster.headers['content-type']).toBe('image/png')
    expect(String(vector.body)).toContain('<svg')
    const official = readFileSync(resolve(packageRoot, '../../runtime/xiaoshe-legacy/ui/assets/snake.svg'), 'utf8')
    const copied = readFileSync(resolve(packageRoot, 'ui/assets/snake.svg'), 'utf8')
    expect(copied).toBe(official)
    expect(vector.body).toBe(copied)
    const officialRaster = readFileSync(resolve(packageRoot, '../../runtime/xiaoshe-legacy/ui/assets/icon-256.png'))
    const copiedRaster = readFileSync(resolve(packageRoot, 'ui/assets/icon-256.png'))
    expect(copiedRaster).toEqual(officialRaster)
    expect(raster.body).toEqual(copiedRaster)
    expect(raster.headers['content-length']).toBe(String(copiedRaster.byteLength))
    expect(effect).toHaveBeenCalledOnce()
    effect.mock.results[0]?.value()
    expect(unregister).toHaveBeenCalledTimes(2)
  })
})
