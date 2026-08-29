export const name = 'xiaoshe-plugin-governance-healthy-fixture'
export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    name: 'xiaoshe-plugin-governance-fixture-health',
    kind: 'exact',
    path: '/api/xiaoshe/plugin-governance-fixture',
    handler(_request, response) {
      const body = '{"ok":true,"fixture":"plugin-governance"}'
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      }).end(body)
    },
  }), 'plugin-governance healthy fixture route')
}
