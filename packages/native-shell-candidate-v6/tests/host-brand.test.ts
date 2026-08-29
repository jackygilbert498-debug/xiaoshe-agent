import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { BRAND_ICON_PATH, apply, name } from '../src/index.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('V6 host boundary', () => {
  it('serves the canonical icon from a V6-only route and releases it on unload', () => {
    let registeredPath = ''
    let body = ''
    const unregister = vi.fn()
    const effect = vi.fn((execute: () => () => void) => execute())

    apply({
      webServer: {
        register(route) {
          registeredPath = route.path
          route.handler(undefined, {
            writeHead(status, headers) {
              expect(status).toBe(200)
              expect(headers['content-type']).toBe('image/svg+xml; charset=utf-8')
              return this
            },
            end(value) { body = value ?? '' },
          })
          return unregister
        },
      },
      effect,
    })

    expect(name).toBe('xiaoshe-native-shell-candidate-v6')
    expect(BRAND_ICON_PATH).toBe('/api/xiaoshe/candidate-v6-brand-icon')
    expect(registeredPath).toBe(BRAND_ICON_PATH)
    expect(body).toContain('<svg')
    expect(body).toBe(readFileSync(resolve(packageRoot, '../../runtime/xiaoshe-legacy/ui/assets/snake.svg'), 'utf8'))
    expect(effect).toHaveBeenCalledOnce()
    effect.mock.results[0]?.value()
    expect(unregister).toHaveBeenCalledOnce()
  })
})
