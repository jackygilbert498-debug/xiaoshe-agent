import { readFileSync } from 'node:fs'

export const name = 'xiaoshe-native-shell'
export const BRAND_ICON_PATH = '/api/xiaoshe/brand-icon'

interface ResponseLike { writeHead(status: number, headers: Record<string, string>): ResponseLike; end(data?: string): void }
interface ContextLike {
  readonly webServer: { register(route: { name: string; kind: 'exact'; path: string; handler(request: unknown, response: ResponseLike): void }): () => void }
  effect(execute: () => () => void, label?: string): unknown
}

export const inject = ['webServer']

/** Serve the approved logo from the product bundle so Windows Host capability stays optional. */
export function apply(ctx: ContextLike): void {
  const icon = readFileSync(new URL('../assets/snake.svg', import.meta.url), 'utf8')
  ctx.effect(() => ctx.webServer.register({
    name: 'xiaoshe-native-brand-icon', kind: 'exact', path: BRAND_ICON_PATH,
    handler(_request, response) {
      response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' }).end(icon)
    },
  }), 'xiaoshe-native-shell: approved brand icon')
}
