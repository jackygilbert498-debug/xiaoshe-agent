import {
  createMemoryService,
  createMemoryToolDefinitions,
  memorySettingsSchema,
  type MemoryInjection,
} from './service.js'
import { registerMemoryHttpRoute, type MemoryWebServer } from './http.js'
import type { JsonValue, SettingsSchemaLike, SettingsScopeLike, ToolDefinitionLike } from './types.js'

export const name = 'xiaoshe-memory'
export const inject = ['tools', 'settings', 'systemPrompt', 'webServer']

const SETTINGS_NAMESPACE = 'xiaoshe-memory'
const MEMORY_CONTEXT_NAME = 'xiaoshe:memory'

export interface MemoryAssemblyContext {
  readonly agent?: {
    readonly id: string
    readonly session: { readonly header: { readonly cwd?: string } }
  }
}

export interface MemoryPromptAssembly {
  readonly contexts: ReadonlyArray<{ readonly name: string; readonly text: string }>
}

export interface MemoryHostContext {
  readonly tools: {
    register(definition: ToolDefinitionLike): () => void
  }
  readonly settings: {
    register(
      namespace: string,
      schema: SettingsSchemaLike,
      options?: { readonly base?: Record<string, JsonValue>; readonly applies?: 'live' | 'restart' },
    ): SettingsScopeLike
  }
  readonly systemPrompt: {
    context(row: {
      readonly name: string
      readonly order: number
      readonly text: string | ((context: MemoryAssemblyContext) => string)
    }): () => void
  }
  readonly webServer: MemoryWebServer
  on(
    event: 'system-prompt/assemble',
    listener: (
      assembly: MemoryPromptAssembly,
      context: MemoryAssemblyContext,
      next: () => Promise<MemoryPromptAssembly>,
    ) => Promise<MemoryPromptAssembly>,
  ): () => void
  effect(execute: () => () => void | Promise<void>, label?: string): unknown
  provide(name: string, value: unknown): () => void
}

/** Own the durable memory namespace and tools from one independently composable row. */
export function apply(ctx: MemoryHostContext): void {
  const settings = ctx.settings.register(SETTINGS_NAMESPACE, memorySettingsSchema, {
    base: { revision: 0, entries: [], audit: [], usage: [] },
    applies: 'live',
  })
  const service = createMemoryService(settings)
  for (const definition of createMemoryToolDefinitions(service)) {
    ctx.effect(() => ctx.tools.register(definition), `xiaoshe-memory: ${definition.name}`)
  }
  const selected = new WeakMap<object, MemoryInjection>()
  ctx.effect(() => ctx.systemPrompt.context({
    name: MEMORY_CONTEXT_NAME,
    order: 40,
    text(context) {
      const agent = context.agent
      if (agent === undefined) return ''
      const injection = service.injection(agent.session.header.cwd)
      selected.set(context, injection)
      return injection.text
    },
  }), 'xiaoshe-memory: prompt context')
  ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    const injection = selected.get(context)
    selected.delete(context)
    const agent = context.agent
    if (agent === undefined || injection === undefined || injection.items.length === 0) return result
    const emitted = result.contexts.some(row => row.name === MEMORY_CONTEXT_NAME && row.text === injection.text)
    if (!emitted) return result
    await service.recordInjection({
      sessionId: agent.id,
      ...(injection.project === undefined ? {} : { project: injection.project }),
      itemIds: injection.items.map(item => item.id),
    })
    return result
  }), 'xiaoshe-memory: injection audit')
  ctx.effect(() => registerMemoryHttpRoute(ctx.webServer, service), 'xiaoshe-memory: Host API')
  ctx.provide('xiaosheMemory', { service })
}

export * from './http.js'
export * from './service.js'
