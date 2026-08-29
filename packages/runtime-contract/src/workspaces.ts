import type { RuntimeCommandResult } from './commands.js'

/** Minimal durable Workspace fact used by Xiaoshe's grouping surface. */
export interface WorkspaceCatalogEntry {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Read-only Workspace registry projection. */
export interface WorkspaceCatalogSnapshot {
  readonly state: 'idle' | 'loading' | 'ready' | 'error'
  readonly items: readonly WorkspaceCatalogEntry[]
  readonly archivedSessionIds: readonly string[]
  readonly error?: string
}

/** Public Workspace seam for shells that replace the DSH workspace UI. */
export interface WorkspaceCatalog {
  getSnapshot(): WorkspaceCatalogSnapshot
  subscribe(listener: () => void): () => void
  addFromNativePicker(): Promise<RuntimeCommandResult<{ cancelled: boolean; workspace?: WorkspaceCatalogEntry }>>
  createAndOpenSession(workspaceId: string): Promise<RuntimeCommandResult<{ sessionId: string }>>
  renameWorkspace(workspaceId: string, title: string): Promise<RuntimeCommandResult<{ workspace: WorkspaceCatalogEntry }>>
  removeWorkspace(workspaceId: string): Promise<RuntimeCommandResult<{ removed: true }>>
}
