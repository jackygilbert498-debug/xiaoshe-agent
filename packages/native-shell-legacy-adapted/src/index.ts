import { readFileSync } from 'node:fs'

export const name = 'xiaoshe-native-shell-legacy-adapted'
export const BRAND_ICON_PATH = '/api/xiaoshe/legacy-adapted-brand-icon'
export const BRAND_RASTER_PATH = '/api/xiaoshe/legacy-adapted-brand-raster'

interface ResponseLike {
  writeHead(status: number, headers: Record<string, string>): ResponseLike
  end(data?: string | Uint8Array): void
}

interface ContextLike {
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

export const inject = ['webServer']

/** Serve only canonical legacy assets; product behavior remains in public services. */
export function apply(ctx: ContextLike): void {
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
