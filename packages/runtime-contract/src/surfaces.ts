export type WorkSurfaceKind = 'web' | 'file' | 'image' | 'video' | 'pdf' | 'terminal' | 'desktop'
export type WorkSurfaceStatus = 'running' | 'ready' | 'error' | 'blocked'
export type WorkSurfaceTrust = 'loopback' | 'workspace' | 'local' | 'external' | 'unknown'

export interface WorkSurfaceCapabilities {
  readonly embedded: boolean
  readonly interactive: boolean
  readonly refresh: boolean
  readonly externalOpen: boolean
  readonly copySource: boolean
  readonly pinnable: true
}

export interface WorkSurfaceTextLine {
  readonly number: number
  readonly text: string
}

export interface WorkSurfaceDiff {
  readonly path: string
  readonly oldText: string | null
  readonly newText: string
}

export type WorkSurfaceView =
  | {
      readonly kind: 'web'
      /** Credential-free URL. Omitted when the source was unsafe or sensitive. */
      readonly url?: string
      readonly embed: 'loopback' | 'external-only' | 'blocked'
      readonly reason?: string
    }
  | {
      readonly kind: 'text'
      readonly lines: readonly WorkSurfaceTextLine[]
      readonly totalLines: number
      readonly language?: string
      readonly truncated: boolean
    }
  | {
      readonly kind: 'diff'
      readonly diffs: readonly WorkSurfaceDiff[]
      readonly truncated: boolean
    }
  | {
      readonly kind: 'terminal'
      readonly output: string
      readonly truncated: boolean
      readonly exitCode?: number
      readonly signal?: string
      readonly cwd?: string
    }
  | {
      readonly kind: 'media'
      readonly mediaType: 'image' | 'video' | 'pdf' | 'desktop'
      readonly url?: string
      readonly description?: string
    }
  | {
      readonly kind: 'metadata'
      readonly description: string
    }

export interface WorkSurface {
  readonly id: string
  readonly sessionId: string
  readonly callId: string
  readonly seq: number
  readonly updatedAt: number
  readonly type: WorkSurfaceKind
  readonly title: string
  /** Safe display/copy source. It never contains credentials or sensitive query values. */
  readonly source?: string
  readonly status: WorkSurfaceStatus
  readonly trust: WorkSurfaceTrust
  readonly capabilities: WorkSurfaceCapabilities
  readonly view: WorkSurfaceView
}

export interface WorkSurfaceRegistrySnapshot {
  readonly sessionId?: string
  readonly items: readonly WorkSurface[]
}

/** Read-only current-session projection. DSH remains the durable source of truth. */
export interface WorkSurfaceRegistry {
  getSnapshot(): WorkSurfaceRegistrySnapshot
  subscribe(listener: () => void): () => void
}
