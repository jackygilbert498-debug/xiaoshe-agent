/** JSON value accepted by DSH's public structural tool/settings APIs. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface ToolRunContextLike {
  readonly signal: AbortSignal
}

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

export interface SettingsSchemaLike {
  (value: unknown): Record<string, JsonValue>
  toJSON(): unknown
}

export interface SettingsScopeLike {
  get(): Record<string, JsonValue>
  watch(callback: (next: Record<string, JsonValue>, previous: Record<string, JsonValue>) => void | Promise<void>): () => void
  update(patch: Record<string, JsonValue>): Promise<void>
}
