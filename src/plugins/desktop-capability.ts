import { join } from 'node:path'
import { ActionToolController } from '../action-controller.js'
import { BridgeClient } from '../bridge-client.js'
import { resolveConfig } from '../config.js'
import { actionsPreference, desktopSettingsSchema } from '../runtime-control.js'
import { ACTION_TOOL_NAMES, createToolDefinitions } from '../tools.js'
import type { BridgeRequester } from '../tools.js'
import type { DshContextLike, PluginConfig, PreToolDecision, RuntimeActionGate, XiaosheDesktopRuntime } from '../types.js'

export const name = 'xiaoshe-desktop-capability'
export const inject = ['tools', 'settings']

const ACTION_RPC_METHODS = new Set(['click', 'type_text', 'press', 'focus_window'])
const SETTINGS_NAMESPACE = 'xiaoshe-desktop'
const PLUGIN_VERSION = '0.2.0'

/** Own the desktop bridge, its read/action tools and its fail-closed approval policy. */
export function apply(ctx: DshContextLike, config: PluginConfig = {}): void {
  const resolved = resolveConfig(config)
  const client = new BridgeClient(resolved)
  const gate: RuntimeActionGate = { enabled: false }
  const bridge: BridgeRequester = {
    async request(method, params, signal) {
      if (ACTION_RPC_METHODS.has(method) && !gate.enabled) {
        throw new Error('Desktop actions are disabled by the current Xiaoshe runtime setting')
      }
      return await client.request(method, params, signal)
    },
  }
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, desktopSettingsSchema, {
    base: { actionsEnabled: resolved.actionsEnabled, responseStyle: 'pragmatic' },
    applies: 'live',
  })
  const definitions = createToolDefinitions(bridge, { ...resolved, actionsEnabled: true })
  const readDefinitions = definitions.filter(definition => !ACTION_TOOL_NAMES.has(definition.name))
  const actionDefinitions = definitions.filter(definition => ACTION_TOOL_NAMES.has(definition.name))
  for (const definition of readDefinitions) {
    ctx.effect(() => ctx.tools.register(definition), `xiaoshe-desktop-capability: ${definition.name}`)
  }
  const initiallyEnabled = resolved.actionsEnabled && actionsPreference(settings, resolved.actionsEnabled)
  const actions = new ActionToolController(
    definition => ctx.tools.register(definition), actionDefinitions, resolved.actionsEnabled, gate, initiallyEnabled,
  )
  const setActionsEnabled = async (enabled: boolean): Promise<void> => {
    if (enabled && !resolved.actionsEnabled) throw new Error('Desktop actions are disabled by XIAOSHE_DESKTOP_ACTIONS=off')
    const previous = actions.enabled
    actions.setEnabled(enabled)
    try {
      await settings.update({ actionsEnabled: enabled })
    } catch (error: unknown) {
      actions.setEnabled(previous)
      throw error
    }
  }
  const runtime: XiaosheDesktopRuntime = {
    bridge,
    actions,
    settings,
    setActionsEnabled,
    setResponseStyle: async responseStyle => await settings.update({ responseStyle }),
    brandIconPath: join(resolved.xiaosheRoot, 'ui', 'assets', 'snake.svg'),
    version: PLUGIN_VERSION,
  }
  ctx.provide('xiaosheDesktop', runtime)
  ctx.effect(
    () => settings.watch((next) => {
      const requested = typeof next.actionsEnabled === 'boolean' ? next.actionsEnabled : false
      actions.setEnabled(resolved.actionsEnabled && requested)
    }),
    'xiaoshe-desktop-capability: watch action preference',
  )
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const downstream = await next()
    if (!ACTION_TOOL_NAMES.has(exec.name) || downstream.kind !== 'allow') return downstream
    if (!actions.enabled) return { kind: 'deny', reason: 'Xiaoshe desktop actions are disabled by deployment policy.' }
    return { kind: 'ask', reason: 'This action will control the real desktop. Review the target shown in the tool call.' }
  })
  ctx.effect(
    () => async () => {
      actions.dispose()
      await client.dispose()
    },
    'xiaoshe-desktop-capability: stop JSON-RPC bridge',
  )
}
