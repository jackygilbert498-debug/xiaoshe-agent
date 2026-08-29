import type { RuntimeCommandResult } from './commands.js'

export interface SessionCatalogEntry {
  readonly sessionId: string
  readonly title?: string
  readonly cwd?: string
  readonly parentId?: string
  readonly origin?: string
  readonly updatedAt: number
  readonly [extension: string]: unknown
}
export interface SessionCatalogSnapshot {
  readonly currentSessionId?: string
  readonly sessions: Readonly<Record<string, SessionCatalogEntry>>
}
export interface SessionSearchItem { readonly sessionId: string; readonly snippet: string }

export interface SessionCatalog {
  getSnapshot(): SessionCatalogSnapshot
  subscribe(listener: () => void): () => void
  createLooseSession(): Promise<RuntimeCommandResult<{ sessionId: string }>>
  openSession(sessionId: string): RuntimeCommandResult<{ opened: true }>
  renameSession(sessionId: string, title: string): Promise<RuntimeCommandResult<{ title: string }>>
  archiveSession(sessionId: string): Promise<RuntimeCommandResult<{ archived: true }>>
  search(query: string, signal: AbortSignal): Promise<RuntimeCommandResult<{ items: readonly SessionSearchItem[]; hasMore: boolean }>>
  moveSessionToWorkspace(sessionId: string, workspaceId: string): Promise<RuntimeCommandResult<{ sessionId: string }>>
}

/** Validate catalog identity while retaining newer provider fields. */
export function parseSessionCatalogSnapshot(value: unknown): SessionCatalogSnapshot {
  if (!isRecord(value) || !isRecord(value.sessions)) throw new TypeError('catalog snapshot must contain sessions')
  const sessions: Record<string, SessionCatalogEntry> = {}
  for (const [key, raw] of Object.entries(value.sessions)) {
    if (!isRecord(raw) || typeof raw.sessionId !== 'string' || raw.sessionId.trim() === '') {
      throw new TypeError(`sessionId must be non-blank for catalog entry ${key}`)
    }
    if (!Number.isFinite(raw.updatedAt)) throw new TypeError(`updatedAt must be finite for catalog entry ${key}`)
    sessions[key] = { ...raw } as SessionCatalogEntry
  }
  if (value.currentSessionId !== undefined && typeof value.currentSessionId !== 'string') {
    throw new TypeError('currentSessionId must be a string')
  }
  return { ...(value.currentSessionId === undefined ? {} : { currentSessionId: value.currentSessionId }), sessions }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
