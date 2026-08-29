import { describe, expect, it } from 'vitest'
import * as desktopPlugin from '../src/plugins/desktop-capability.js'
import * as memoryPlugin from '../src/plugins/memory.js'
import * as identityPlugin from '../src/plugins/product-identity.js'
import * as routesPlugin from '../src/plugins/runtime-routes.js'
import type {
  DshContextLike,
  JsonValue,
  PreToolDecision,
  PromptAssemblyContextLike,
  PromptAssemblyLike,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../src/types.js'

function harness() {
  const definitions: ToolDefinitionLike[] = []
  const providers = new Map<string, unknown>()
  const routes = new Set<string>()
  const prompts = new Set<string>()
  const promptContexts = new Set<string>()
  const settingsValues = new Map<string, Record<string, JsonValue>>()
  let activeCleanups: Array<() => void | Promise<void>> | undefined
  let listener: ((exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
  let assemblyListener: ((
    assembly: PromptAssemblyLike,
    context: PromptAssemblyContextLike,
    next: () => Promise<PromptAssemblyLike>,
  ) => Promise<PromptAssemblyLike>) | undefined

  const ctx: DshContextLike = {
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
      },
      schemas: () => definitions.map(definition => ({ name: definition.name })),
    },
    settings: {
      register(namespace, _schema, options) {
        const watchers: Array<(next: Record<string, JsonValue>, previous: Record<string, JsonValue>) => void | Promise<void>> = []
        settingsValues.set(namespace, { ...(options?.base ?? {}) })
        return {
          get: () => settingsValues.get(namespace) ?? {},
          watch(callback) {
            watchers.push(callback)
            return () => {
              const index = watchers.indexOf(callback)
              if (index >= 0) watchers.splice(index, 1)
            }
          },
          async update(patch) {
            const previous = settingsValues.get(namespace) ?? {}
            const next = { ...previous, ...patch }
            settingsValues.set(namespace, next)
            await Promise.all(watchers.map(async watcher => await watcher(next, previous)))
          },
        }
      },
    },
    webServer: {
      register(route) {
        routes.add(route.name)
        return () => { routes.delete(route.name) }
      },
    },
    systemPrompt: {
      section(section) {
        prompts.add(section.name)
        return () => { prompts.delete(section.name) }
      },
      context(row) {
        promptContexts.add(row.name)
        return () => { promptContexts.delete(row.name) }
      },
    },
    on(event: 'tools/pre-execute' | 'system-prompt/assemble', value: unknown) {
      if (event === 'tools/pre-execute') {
        listener = value as typeof listener
        return () => { listener = undefined }
      }
      assemblyListener = value as typeof assemblyListener
      return () => { assemblyListener = undefined }
    },
    effect(execute) {
      if (activeCleanups === undefined) throw new Error('effect registered outside a plugin mount')
      const cleanup = execute()
      activeCleanups.push(cleanup)
      return cleanup
    },
    provide(name, value) {
      if (activeCleanups === undefined) throw new Error('service provided outside a plugin mount')
      if (providers.has(name)) throw new Error(`duplicate provider: ${name}`)
      providers.set(name, value)
      const dispose = () => { providers.delete(name) }
      activeCleanups.push(dispose)
      return dispose
    },
    get: name => providers.get(name),
  }

  const mount = (plugin: { apply(ctx: DshContextLike): void }): (() => Promise<void>) => {
    const cleanups: Array<() => void | Promise<void>> = []
    activeCleanups = cleanups
    try {
      plugin.apply(ctx)
    } finally {
      activeCleanups = undefined
    }
    return async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
    }
  }

  return { ctx, definitions, providers, routes, prompts, promptContexts, mount, listener: () => listener }
}

describe('narrow Xiaoshe Host plugin rows', () => {
  it('releases identity and memory independently without withdrawing desktop tools', async () => {
    const state = harness()
    const unmountDesktop = state.mount(desktopPlugin)
    const desktopNames = state.definitions.map(item => item.name)
    const unmountMemory = state.mount(memoryPlugin)
    const unmountIdentity = state.mount(identityPlugin)

    expect(state.providers.has('xiaosheDesktop')).toBe(true)
    expect(state.providers.has('xiaosheMemory')).toBe(true)
    expect(state.prompts).toEqual(new Set(['xiaoshe:product-identity']))
    expect(state.promptContexts).toEqual(new Set(['xiaoshe:memory']))
    expect(state.definitions.length).toBeGreaterThan(desktopNames.length)

    await unmountIdentity()
    expect(state.prompts.size).toBe(0)
    expect(state.definitions.map(item => item.name)).toEqual(expect.arrayContaining(desktopNames))

    await unmountMemory()
    expect(state.providers.has('xiaosheMemory')).toBe(false)
    expect(state.promptContexts.size).toBe(0)
    expect(state.definitions.map(item => item.name)).toEqual(desktopNames)

    await unmountDesktop()
    expect(state.providers.has('xiaosheDesktop')).toBe(false)
    expect(state.definitions).toHaveLength(0)
  })

  it('releases routes without withdrawing desktop or memory services', async () => {
    const state = harness()
    const unmountDesktop = state.mount(desktopPlugin)
    const unmountMemory = state.mount(memoryPlugin)
    const unmountRoutes = state.mount(routesPlugin)

    expect(state.routes.size).toBeGreaterThan(0)
    await unmountRoutes()
    expect(state.routes).toEqual(new Set(['xiaoshe-product-memory']))
    expect(state.providers.has('xiaosheDesktop')).toBe(true)
    expect(state.providers.has('xiaosheMemory')).toBe(true)

    await unmountMemory()
    expect(state.routes.size).toBe(0)
    await unmountDesktop()
  })
})
