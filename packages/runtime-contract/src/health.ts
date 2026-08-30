/** Public, redacted heartbeat facts exposed to Product Clients. */
export interface ProductHeartbeatCheck {
  readonly id: string
  readonly status: 'idle' | 'running' | 'healthy' | 'delayed' | 'lost' | 'paused' | 'backoff'
  readonly intervalMs: number
  readonly failureCount: number
  readonly nextRunAt?: number
}

export interface ProductHeartbeatSnapshot {
  readonly schemaVersion: 2
  readonly status: ProductHeartbeatCheck['status']
  readonly running: boolean
  readonly checks: readonly ProductHeartbeatCheck[]
}

/** Public desktop-runtime facts. Private paths and bridge payloads are excluded. */
export interface ProductDesktopDiagnostic {
  readonly api_version: 1
  readonly product: string
  readonly version: string
  readonly response_style?: string
  readonly bridge: Readonly<Record<string, unknown>> & { readonly state: string; readonly platform?: string; readonly protocol?: string }
  readonly actions: Readonly<Record<string, unknown>> & { readonly persistent?: boolean; readonly enabled?: boolean; readonly deployment_allowed?: boolean }
  readonly modlens_available?: boolean
  readonly last_probe?: Readonly<Record<string, unknown>>
}

export interface ProductHealthValue {
  readonly heartbeat?: ProductHeartbeatSnapshot
  readonly desktop?: ProductDesktopDiagnostic
}

export interface ProductHealthSourceError {
  readonly source: 'heartbeat' | 'desktop'
  readonly message: string
  readonly status?: number
  readonly kind?: string
}

export type ProductHealthSnapshot =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly value?: ProductHealthValue }
  | { readonly status: 'ready'; readonly value: Required<ProductHealthValue> }
  | { readonly status: 'degraded'; readonly value: ProductHealthValue; readonly errors: readonly ProductHealthSourceError[] }
  | { readonly status: 'error'; readonly value?: ProductHealthValue; readonly errors: readonly ProductHealthSourceError[] }

/** Read-only Product health service implemented by the owning Client plugin. */
export interface ProductHealth {
  getSnapshot(): ProductHealthSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<ProductHealthSnapshot>
}
