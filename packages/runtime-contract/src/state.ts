import { RUNTIME_SESSION_SCHEMA_VERSION } from './version.js'
import type { RuntimeImageInputLimits } from './commands.js'

export type RuntimeSessionState = 'blank' | 'idle' | 'running' | 'blocked' | 'completed' | 'error' | 'unknown'

export interface RuntimeSessionProjection {
  readonly schemaVersion: typeof RUNTIME_SESSION_SCHEMA_VERSION
  readonly sessionId: string
  readonly state: RuntimeSessionState
  readonly sourceSeq?: number
  readonly rawState?: string
  readonly imageInputLimits?: RuntimeImageInputLimits
  readonly [extension: string]: unknown
}

export interface RuntimeSessionSnapshot {
  readonly currentSessionId?: string
  readonly sessions: Readonly<Record<string, RuntimeSessionProjection>>
}

const KNOWN_STATES = new Set<RuntimeSessionState>([
  'blank', 'idle', 'running', 'blocked', 'completed', 'error', 'unknown',
])

/** Validate identity/version while retaining extension fields from newer providers. */
export function parseRuntimeSessionProjection(value: unknown): RuntimeSessionProjection {
  if (!isRecord(value)) throw new TypeError('runtime projection must be an object')
  if (value.schemaVersion !== RUNTIME_SESSION_SCHEMA_VERSION) {
    throw new TypeError(`schemaVersion must be ${RUNTIME_SESSION_SCHEMA_VERSION}`)
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.trim() === '') {
    throw new TypeError('sessionId must be a non-empty string')
  }
  if (typeof value.state !== 'string' || value.state === '') throw new TypeError('state must be a non-empty string')
  if (value.sourceSeq !== undefined && (!Number.isSafeInteger(value.sourceSeq) || Number(value.sourceSeq) < 0)) {
    throw new TypeError('sourceSeq must be a non-negative safe integer')
  }
  if (KNOWN_STATES.has(value.state as RuntimeSessionState)) return { ...value } as RuntimeSessionProjection
  return { ...value, state: 'unknown', rawState: value.state } as RuntimeSessionProjection
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
