import type { RuntimeCommandResult } from './commands.js'

export interface ProviderReadinessFacts {
  readonly catalogued: boolean
  readonly supported: boolean
  readonly configured: boolean
  readonly available: boolean
  readonly verified: boolean
}

export type ProviderReadinessReason =
  | 'provider_not_catalogued'
  | 'route_unsupported'
  | 'settings_missing'
  | 'credential_missing'
  | 'route_unavailable'
  | 'probe_missing'
  | 'probe_running'
  | 'probe_failed'
  | 'probe_cancelled'
  | 'probe_expired'
  | 'probe_route_mismatch'

export interface ProviderProbeUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export type ProviderProbeCost =
  | { readonly status: 'unavailable' }
  | { readonly status: 'estimated'; readonly currency: string; readonly amount: number; readonly rateSource: string }

export type ProviderProbeRecord = {
  readonly provider: string
  readonly model: string
  readonly startedAt: number
  readonly completedAt?: number
  readonly latencyMs?: number
  readonly contextWindow?: number
  readonly cost: ProviderProbeCost
} & (
  | {
    readonly status: 'running'
  }
  | {
    readonly status: 'succeeded'
    readonly completedAt: number
    readonly latencyMs: number
    readonly finishReason: string
    readonly usage: ProviderProbeUsage
  }
  | {
    readonly status: 'failed'
    readonly completedAt: number
    readonly latencyMs: number
    readonly error: { readonly code: string; readonly message: string }
  }
  | {
    readonly status: 'cancelled'
    readonly completedAt: number
    readonly latencyMs: number
  }
)

export interface ProviderReadinessRoute {
  readonly provider: string
  readonly model: string
  readonly name: string
  readonly description?: string
  readonly facts: ProviderReadinessFacts
  readonly reasons: readonly ProviderReadinessReason[]
  readonly probe?: ProviderProbeRecord
}

export interface ProviderReadinessProvider {
  readonly id: string
  readonly displayName: string
  readonly active: boolean
  readonly declared: boolean
  readonly routes: readonly ProviderReadinessRoute[]
}

export interface ProviderReadinessSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'probing' | 'error'
  readonly sessionId?: string
  readonly providers: readonly ProviderReadinessProvider[]
  readonly verificationTtlMs: number
  readonly updatedAt?: number
  readonly error?: string
}

export interface ProviderReadiness {
  getSnapshot(): ProviderReadinessSnapshot
  subscribe(listener: () => void): () => void
  refresh(sessionId?: string): Promise<RuntimeCommandResult<ProviderReadinessSnapshot>>
  probe(input: {
    readonly provider: string
    readonly model: string
    readonly timeoutMs?: number
  }): Promise<RuntimeCommandResult<{ readonly probe: ProviderProbeRecord; readonly snapshot: ProviderReadinessSnapshot }>>
  cancelProbe(): RuntimeCommandResult<{ readonly cancelled: true }>
}

export interface DeriveProviderReadinessInput {
  readonly provider?: string
  readonly model?: string
  readonly catalogued: boolean
  readonly supported: boolean
  readonly settingsConfigured: boolean
  readonly credentialRequired: boolean
  readonly credentialConfigured: boolean
  readonly routeAvailable: boolean
  readonly probe?: ProviderProbeRecord
}

/**
 * Derive five independent facts without treating one optimistic signal as a
 * substitute for a stronger one. A successful probe only verifies the exact
 * route while it remains within the caller-supplied validity window.
 */
export function deriveProviderReadinessFacts(
  input: DeriveProviderReadinessInput,
  now: number,
  verificationTtlMs: number,
): { readonly facts: ProviderReadinessFacts; readonly reasons: readonly ProviderReadinessReason[] } {
  if (!Number.isFinite(now) || now < 0) throw new TypeError('now must be a non-negative finite number')
  if (!Number.isSafeInteger(verificationTtlMs) || verificationTtlMs <= 0) throw new TypeError('verificationTtlMs must be a positive integer')

  const catalogued = input.catalogued
  const supported = input.supported
  const configured = input.settingsConfigured && (!input.credentialRequired || input.credentialConfigured)
  const available = catalogued && supported && configured && input.routeAvailable
  const reasons: ProviderReadinessReason[] = []

  if (!catalogued) reasons.push('provider_not_catalogued')
  if (!supported) reasons.push('route_unsupported')
  if (!input.settingsConfigured) reasons.push('settings_missing')
  if (input.credentialRequired && !input.credentialConfigured) reasons.push('credential_missing')
  if (catalogued && supported && configured && !input.routeAvailable) reasons.push('route_unavailable')

  let verified = false
  const probe = input.probe
  if (probe === undefined) {
    reasons.push('probe_missing')
  } else if ((input.provider !== undefined && probe.provider !== input.provider)
    || (input.model !== undefined && probe.model !== input.model)) {
    reasons.push('probe_route_mismatch')
  } else if (probe.status === 'running') {
    reasons.push('probe_running')
  } else if (probe.status === 'failed') {
    reasons.push('probe_failed')
  } else if (probe.status === 'cancelled') {
    reasons.push('probe_cancelled')
  } else if (now - probe.completedAt > verificationTtlMs || probe.completedAt > now) {
    reasons.push('probe_expired')
  } else if (available) {
    verified = true
  }

  return Object.freeze({
    facts: Object.freeze({ catalogued, supported, configured, available, verified }),
    reasons: Object.freeze(reasons),
  })
}
