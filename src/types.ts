/** JSON value accepted by the DSH tool runtime and the bridge protocol. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Minimal execution identity used by an out-of-tree raw DSH tool. */
export interface ToolRunContextLike {
  readonly signal: AbortSignal
}

/** DSH pre-execution decision vocabulary used by this bundle's approval policy. */
export type PreToolDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason?: string }

/** Readonly fields needed to classify a DSH tool call. */
export interface ToolExecutionLike {
  readonly name: string
}

/** Raw JSON-Schema tool definition accepted by the DSH registry. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: JsonValue): Array<{ readonly type: 'text'; readonly text: string }>
    presentationMeta?(args: unknown, value: JsonValue): JsonValue
  }
  readonly timeoutMs?: number
  execute(args: unknown, exec: ToolRunContextLike): Promise<JsonValue>
  presentCall?(args: unknown): Record<string, unknown>
  presentResult?(
    args: unknown,
    result: {
      readonly content: ReadonlyArray<{ readonly type: string; readonly [key: string]: unknown }>
      readonly isError: boolean
      readonly meta?: JsonValue
    },
  ): Record<string, unknown> | undefined
}

/** Minimal callable settings schema understood by DSH's settings service. */
export interface SettingsSchemaLike {
  (value: unknown): Record<string, JsonValue>
  toJSON(): unknown
}

/** Persisted settings scope owned by this plugin's namespace. */
export interface SettingsScopeLike {
  get(): Record<string, JsonValue>
  watch(callback: (next: Record<string, JsonValue>, previous: Record<string, JsonValue>) => void | Promise<void>): () => void
  update(patch: Record<string, JsonValue>): Promise<void>
}

/** Node HTTP request surface used without importing DSH preview internals. */
export interface HttpRequestLike extends AsyncIterable<Uint8Array | string> {
  readonly method?: string
  readonly url?: string
  readonly headers?: Record<string, string | string[] | undefined>
  once(event: 'aborted', listener: () => void): unknown
  destroy(error?: Error): void
}

/** Narrow response surface used by the local settings routes. */
export interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string | number>): HttpResponseLike
  end(data?: string | Uint8Array): void
}

/** DSH loopback Web server surface used by the product-status routes. */
export interface WebServerLike {
  register(route: {
    readonly name: string
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (request: HttpRequestLike, response: HttpResponseLike) => void | Promise<void>
  }): () => void
}

/** Product-level prompt contribution that remains visible inside scoped agent presets. */
export interface SystemPromptLike {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string | (() => string)
  }): () => void
  context(context: {
    readonly name: string
    readonly order: number
    readonly text: string | ((context: PromptAssemblyContextLike) => string)
  }): () => void
}

export interface PromptAssemblyContextLike {
  readonly agent?: {
    readonly id: string
    readonly session: { readonly header: { readonly cwd?: string } }
  }
}

export interface PromptAssemblyLike {
  readonly contexts: ReadonlyArray<{ readonly name: string; readonly text: string }>
}

/** Narrow Cordis context used to avoid a runtime dependency on preview-only DSH internals. */
export interface DshContextLike {
  readonly tools: {
    register(definition: ToolDefinitionLike): () => void
    schemas(): ReadonlyArray<{ readonly name: string }>
  }
  readonly settings: {
    register(
      namespace: string,
      schema: SettingsSchemaLike,
      options?: { readonly base?: Record<string, JsonValue>; readonly applies?: 'live' | 'restart' },
    ): SettingsScopeLike
  }
  readonly webServer: WebServerLike
  readonly systemPrompt: SystemPromptLike
  on(
    event: 'tools/pre-execute',
    listener: (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>,
  ): unknown
  on(
    event: 'system-prompt/assemble',
    listener: (
      assembly: PromptAssemblyLike,
      context: PromptAssemblyContextLike,
      next: () => Promise<PromptAssemblyLike>,
    ) => Promise<PromptAssemblyLike>,
  ): unknown
  effect(execute: () => () => void | Promise<void>, label?: string): unknown
  provide(name: string, value: unknown): () => void
  get(name: string): unknown
}

/** Shared desktop capability exposed to other Xiaoshe Host plugin rows. */
export interface XiaosheDesktopRuntime {
  readonly bridge: import('./tools.js').BridgeRequester
  readonly actions: import('./action-controller.js').ActionToolController
  readonly settings: SettingsScopeLike
  readonly version: string
  readonly brandIconPath: string
  setActionsEnabled(enabled: boolean): Promise<void>
  setResponseStyle(responseStyle: 'pragmatic' | 'friendly'): Promise<void>
}

/** Shared memory capability exposed to the runtime-routes row. */
export interface XiaosheMemoryRuntime {
  readonly service: import('./memory-service.js').MemoryService
}

/** User-configurable bundle values supplied by cordis.patch.yml. */
export interface PluginConfig {
  readonly xiaosheRoot?: unknown
  readonly pythonExecutable?: unknown
  readonly actionsEnabled?: unknown
  readonly requestTimeoutMs?: unknown
}

/** Validated values used for every tool registration and bridge request. */
export interface ResolvedConfig {
  readonly xiaosheRoot: string
  readonly pythonExecutable: string
  readonly actionsEnabled: boolean
  readonly requestTimeoutMs: number
}

/** Mutable defense-in-depth gate shared by action tools and their registry controller. */
export interface RuntimeActionGate {
  enabled: boolean
}
