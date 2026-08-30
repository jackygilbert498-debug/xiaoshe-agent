import * as desktopCapability from './plugins/desktop-capability.js'
import * as memory from './plugins/memory.js'
import * as productIdentity from './plugins/product-identity.js'
import * as runtimeRoutes from './plugins/runtime-routes.js'
import type { DshContextLike, PluginConfig } from './types.js'

export const name = 'xiaoshe-desktop-control'
export const inject = ['tools', 'settings', 'webServer', 'systemPrompt']

/** Compatibility aggregator; new profiles should compose the four narrow plugin rows. */
export function apply(ctx: DshContextLike, config: PluginConfig = {}): void {
  desktopCapability.apply(ctx, config)
  memory.apply(ctx)
  productIdentity.apply(ctx)
  runtimeRoutes.apply(ctx)
}

export { ActionToolController } from './action-controller.js'
export { BridgeClient, BridgeRpcError } from './bridge-client.js'
export { resolveConfig } from './config.js'
export {
  createMemoryService,
  createMemoryToolDefinitions,
  memorySettingsSchema,
  MemoryRevisionConflictError,
} from './memory-service.js'
export { actionsPreference, desktopSettingsSchema, registerRuntimeRoutes, responseStylePreference } from './runtime-control.js'
export { ACTION_TOOL_NAMES, createToolDefinitions } from './tools.js'
export type { PluginConfig, ResolvedConfig } from './types.js'
export { desktopCapability, memory, productIdentity, runtimeRoutes }
