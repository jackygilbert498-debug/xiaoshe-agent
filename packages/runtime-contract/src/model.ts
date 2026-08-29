import type { RuntimeCommandResult } from './commands.js'

/** Provider-owned reasoning option for one exact model route. */
export interface ModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One selectable model row projected without importing DSH browser internals. */
export interface ModelCatalogEntry {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly efforts: readonly ModelReasoningEffort[]
  readonly defaultEffort?: string
}

/** One provider group in display order. */
export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelCatalogEntry[]
}

/** Complete provider route used for the next model turn. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Current-session model directory. The Host remains the source of truth. */
export interface ModelCatalogSnapshot {
  readonly sessionId?: string
  readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  readonly current?: ModelSelection
  readonly routable?: boolean
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
  readonly error?: string
}

/** Public model-selection seam for product shells that do not mount DSH model UI. */
export interface ModelCatalog {
  getSnapshot(): ModelCatalogSnapshot
  subscribe(listener: () => void): () => void
  refresh(sessionId?: string): Promise<RuntimeCommandResult<ModelCatalogSnapshot>>
  select(input: ModelSelection & { readonly sessionId?: string }): Promise<RuntimeCommandResult<{ selected: ModelSelection }>>
}
