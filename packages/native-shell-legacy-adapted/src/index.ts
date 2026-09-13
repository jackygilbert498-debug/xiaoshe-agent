import { readFileSync } from 'node:fs'

export const name = 'xiaoshe-native-shell-legacy-adapted'
export const BRAND_ICON_PATH = '/api/xiaoshe/legacy-adapted-brand-icon'
export const BRAND_RASTER_PATH = '/api/xiaoshe/legacy-adapted-brand-raster'

interface ResponseLike {
  writeHead(status: number, headers: Record<string, string>): ResponseLike
  end(data?: string | Uint8Array): void
}

interface ContextLike {
  readonly settings: {
    register(namespace: string, schema: typeof appearanceSettingsSchema, options: {
      base: Record<string, string>; applies: 'live'; recoverInvalidStored: boolean
    }): unknown
  }
  readonly webServer: {
    register(route: {
      name: string
      kind: 'exact'
      path: string
      handler(request: unknown, response: ResponseLike): void
    }): () => void
  }
  effect(execute: () => () => void, label?: string): unknown
}

export const inject = ['webServer', 'settings']

/** A separate durable namespace: appearance cannot change model or permission settings. */
export const appearanceSettingsSchema = Object.assign((value: unknown): Record<string, string> => {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('外观设置必须是对象')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some(key => key !== 'preset' && key !== 'customAccent')) throw new TypeError('未知的外观设置字段')
  const result: Record<string, string> = {}
  if (fields.preset !== undefined) {
    if (typeof fields.preset !== 'string' || !['moss', 'graphite', 'ocean', 'sand', 'custom'].includes(fields.preset)) throw new TypeError('无效的配色方案')
    result.preset = fields.preset
  }
  if (fields.customAccent !== undefined) {
    if (typeof fields.customAccent !== 'string' || !/^#[0-9a-f]{6}$/iu.test(fields.customAccent)) throw new TypeError('强调色必须是六位十六进制颜色')
    result.customAccent = fields.customAccent.toLowerCase()
  }
  return result
}, {
  toJSON: () => ({ uid: 0, refs: { 0: { type: 'object', dict: {
    preset: { type: 'string', meta: { default: 'moss' } },
    customAccent: { type: 'string', meta: { default: '#4d6e54' } },
  } } } }),
})

/** Serve only canonical legacy assets; product behavior remains in public services. */
export function apply(ctx: ContextLike): void {
  ctx.settings.register('xiaoshe-appearance', appearanceSettingsSchema, {
    base: { preset: 'moss', customAccent: '#4d6e54' }, applies: 'live', recoverInvalidStored: true,
  })
  const icon = readFileSync(new URL('../ui/assets/snake.svg', import.meta.url), 'utf8')
  const raster = readFileSync(new URL('../ui/assets/icon-256.png', import.meta.url))
  ctx.effect(() => {
    const releases: Array<() => void> = []
    try {
      releases.push(ctx.webServer.register({
        name: 'xiaoshe-legacy-adapted-brand-icon',
        kind: 'exact',
        path: BRAND_ICON_PATH,
        handler(_request, response) {
          response.writeHead(200, {
            'content-type': 'image/svg+xml; charset=utf-8',
            'cache-control': 'public, max-age=3600',
          }).end(icon)
        },
      }))
      releases.push(ctx.webServer.register({
        name: 'xiaoshe-legacy-adapted-brand-raster',
        kind: 'exact',
        path: BRAND_RASTER_PATH,
        handler(_request, response) {
          response.writeHead(200, {
            'content-type': 'image/png',
            'content-length': String(raster.byteLength),
            'cache-control': 'public, max-age=3600',
          }).end(raster)
        },
      }))
    } catch (error) {
      for (const release of releases.reverse()) release()
      throw error
    }
    return () => { for (const release of releases.reverse()) release() }
  }, 'xiaoshe-native-shell-legacy-adapted: canonical legacy brand assets')
}
