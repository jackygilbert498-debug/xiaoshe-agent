import { registerRuntimeRoutes } from '../runtime-control.js'
import type { DshContextLike, XiaosheDesktopRuntime, XiaosheMemoryRuntime } from '../types.js'

export const name = 'xiaoshe-runtime-routes'
export const inject = ['xiaosheDesktop', 'xiaosheMemory', 'webServer', 'tools']

/** Expose loopback routes while consuming, rather than owning, desktop and memory services. */
export function apply(ctx: DshContextLike): void {
  const desktop = required<XiaosheDesktopRuntime>(ctx, 'xiaosheDesktop')
  const memory = required<XiaosheMemoryRuntime>(ctx, 'xiaosheMemory')
  ctx.effect(
    () => registerRuntimeRoutes(ctx.webServer, {
      bridge: desktop.bridge,
      actions: desktop.actions,
      settings: desktop.settings,
      setActionsEnabled: desktop.setActionsEnabled,
      setResponseStyle: desktop.setResponseStyle,
      modlensAvailable: () => ctx.tools.schemas().some(schema => schema.name === 'modlens_read_image'),
      memory: memory.service,
      brandIconPath: desktop.brandIconPath,
      version: desktop.version,
    }),
    'xiaoshe-runtime-routes: loopback product API',
  )
}

function required<T>(ctx: DshContextLike, name: string): T {
  const value = ctx.get(name)
  if (value === undefined) throw new Error(`${name} provider is required`)
  return value as T
}
