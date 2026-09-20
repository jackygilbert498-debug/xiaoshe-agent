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
const appearanceColorDefaults = {
  customAccent: '#4d6e54', customSurfaceLight: '#fcfcfc', customBackgroundLight: '#f4f4f5',
  customSurfaceDark: '#1c1d1f', customBackgroundDark: '#17181a',
}

/** A separate durable namespace: appearance cannot change model or permission settings. */
export const appearanceSettingsSchema = Object.assign((value: unknown): Record<string, string> => {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('外观设置必须是对象')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some(key => key !== 'preset' && !Object.hasOwn(appearanceColorDefaults, key))) throw new TypeError('未知的外观设置字段')
  const result: Record<string, string> = {}
  if (fields.preset !== undefined) {
    if (typeof fields.preset !== 'string' || !['moss', 'graphite', 'ocean', 'sand', 'custom'].includes(fields.preset)) throw new TypeError('无效的配色方案')
    result.preset = fields.preset
  }
  for (const key of Object.keys(appearanceColorDefaults)) {
    if (fields[key] === undefined) continue
    if (typeof fields[key] !== 'string' || !/^#[0-9a-f]{6}$/iu.test(fields[key])) throw new TypeError('自定义颜色必须是六位十六进制颜色')
    result[key] = fields[key].toLowerCase()
  }
  return result
}, {
  toJSON: () => ({ uid: 0, refs: { 0: { type: 'object', dict: {
    preset: { type: 'string', meta: { default: 'moss' } },
    ...Object.fromEntries(Object.entries(appearanceColorDefaults).map(([key, value]) => [key, { type: 'string', meta: { default: value } }])),
  } } } }),
})

/** Serve only canonical legacy assets; product behavior remains in public services. */
export function apply(ctx: ContextLike): void {
  ctx.settings.register('xiaoshe-appearance', appearanceSettingsSchema, {
    base: { preset: 'moss', ...appearanceColorDefaults }, applies: 'live', recoverInvalidStored: true,
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
