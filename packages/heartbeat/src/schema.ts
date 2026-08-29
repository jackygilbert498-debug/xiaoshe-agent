export const MIN_HEARTBEAT_INTERVAL_MS = 100
export const MAX_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1_000
export const MAX_HEARTBEAT_CHECKS = 128
export const LEGACY_CHECK_ID = 'xiaoshe-product-runtime'

export interface StoredHeartbeatLease {
  readonly leaseId: string
  readonly acquiredAt: number
  readonly lastHeartbeatAt: number
}

export interface HeartbeatActiveHours {
  readonly startHour: number
  readonly endHour: number
}

export interface StoredHeartbeatCheck {
  readonly id: string
  readonly intervalMs: number
  readonly activeHours?: HeartbeatActiveHours
  readonly activeLease?: StoredHeartbeatLease
  readonly lastSuccessAt?: number
  readonly lastFailureAt?: number
  readonly lastFailure?: string
  readonly lastEvidence?: string
  readonly nextRunAt?: number
  readonly pauseReason?: string
  readonly failureCount: number
}

export interface StoredHeartbeatState {
  readonly schemaVersion: 2
  readonly checks: readonly StoredHeartbeatCheck[]
}

const TOP_LEVEL_FIELDS = new Set(['schemaVersion', 'checks'])
const CHECK_FIELDS = new Set([
  'id', 'intervalMs', 'activeHours', 'activeLease', 'lastSuccessAt', 'lastFailureAt',
  'lastFailure', 'lastEvidence', 'nextRunAt', 'pauseReason', 'failureCount',
])
const LEASE_FIELDS = new Set(['leaseId', 'acquiredAt', 'lastHeartbeatAt'])
const LEGACY_FIELDS = new Set([
  'schemaVersion', 'status', 'activeLease', 'activeHours', 'lastSuccessAt', 'lastFailureAt',
  'lastFailure', 'lastEvidence', 'nextRunAt', 'pauseReason', 'failureCount',
])
const V2_TOP_LEVEL_FIELDS = new Set([...TOP_LEVEL_FIELDS, ...LEGACY_FIELDS])

/** Strictly validate v2 settings or migrate the former single-ledger shape. */
export function parseHeartbeatState(value: unknown): StoredHeartbeatState {
  const input = record(value, 'heartbeat state')
  if (input.schemaVersion === 2) return parseV2(input)
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    throw new TypeError(`unsupported heartbeat schemaVersion: ${String(input.schemaVersion)}`)
  }
  return migrateV1(input)
}

export const heartbeatSettingsSchema = Object.assign(
  (value: unknown): StoredHeartbeatState => parseHeartbeatState(value),
  {
    toJSON: () => ({
      uid: 0,
      refs: {
        0: {
          type: 'object',
          meta: { default: { schemaVersion: 2, checks: [] } },
          dict: {},
        },
      },
    }),
  },
)

export function validateCheckId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) {
    throw new TypeError('check id must use 1 to 64 lowercase letters, numbers, dot, underscore or hyphen')
  }
}

export function validateHeartbeatInterval(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < MIN_HEARTBEAT_INTERVAL_MS || Number(value) > MAX_HEARTBEAT_INTERVAL_MS) {
    throw new RangeError(`intervalMs must be between ${MIN_HEARTBEAT_INTERVAL_MS} and ${MAX_HEARTBEAT_INTERVAL_MS}`)
  }
}

export function validateActiveHours(value: unknown): asserts value is HeartbeatActiveHours {
  const input = record(value, 'activeHours')
  assertOnly(input, new Set(['startHour', 'endHour']), 'heartbeat activeHours')
  if (!Number.isInteger(input.startHour) || Number(input.startHour) < 0 || Number(input.startHour) > 23
    || !Number.isInteger(input.endHour) || Number(input.endHour) < 1 || Number(input.endHour) > 24
    || input.startHour === input.endHour) {
    throw new RangeError('activeHours requires startHour 0..23 and distinct endHour 1..24')
  }
}

function parseV2(input: Record<string, unknown>): StoredHeartbeatState {
  assertOnly(input, V2_TOP_LEVEL_FIELDS, 'heartbeat state')
  for (const field of LEGACY_FIELDS) {
    if (field === 'schemaVersion') continue
    if (input[field] !== undefined && input[field] !== null) {
      throw new TypeError(`heartbeat v2 legacy field must be cleared: ${field}`)
    }
  }
  if (!Array.isArray(input.checks) || input.checks.length > MAX_HEARTBEAT_CHECKS) {
    throw new TypeError(`heartbeat checks must be an array of at most ${MAX_HEARTBEAT_CHECKS} items`)
  }
  const checks = input.checks.map(parseCheck)
  if (new Set(checks.map(check => check.id)).size !== checks.length) {
    throw new TypeError('heartbeat check ids must be unique')
  }
  return { schemaVersion: 2, checks: checks.sort((a, b) => a.id.localeCompare(b.id)) }
}

function parseCheck(value: unknown): StoredHeartbeatCheck {
  const input = record(value, 'heartbeat check')
  assertOnly(input, CHECK_FIELDS, 'heartbeat check')
  validateCheckId(input.id)
  validateHeartbeatInterval(input.intervalMs)
  const activeHours = input.activeHours === undefined ? undefined : parseActiveHours(input.activeHours)
  const activeLease = input.activeLease === undefined ? undefined : parseLease(input.activeLease)
  const lastSuccessAt = optionalTimestamp(input.lastSuccessAt, 'lastSuccessAt')
  const lastFailureAt = optionalTimestamp(input.lastFailureAt, 'lastFailureAt')
  const nextRunAt = optionalTimestamp(input.nextRunAt, 'nextRunAt')
  const lastFailure = optionalBoundedText(input.lastFailure, 'lastFailure')
  const lastEvidence = optionalBoundedText(input.lastEvidence, 'lastEvidence')
  const pauseReason = optionalBoundedText(input.pauseReason, 'pauseReason')
  if (!Number.isSafeInteger(input.failureCount) || Number(input.failureCount) < 0) {
    throw new TypeError('heartbeat failureCount must be a non-negative safe integer')
  }
  return {
    id: input.id,
    intervalMs: input.intervalMs,
    ...(activeHours === undefined ? {} : { activeHours }),
    ...(activeLease === undefined ? {} : { activeLease }),
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
    ...(lastFailureAt === undefined ? {} : { lastFailureAt }),
    ...(lastFailure === undefined ? {} : { lastFailure }),
    ...(lastEvidence === undefined ? {} : { lastEvidence }),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    ...(pauseReason === undefined ? {} : { pauseReason }),
    failureCount: input.failureCount as number,
  }
}

function migrateV1(input: Record<string, unknown>): StoredHeartbeatState {
  assertOnly(input, LEGACY_FIELDS, 'legacy heartbeat state')
  const failureCount = input.failureCount === undefined ? 0 : input.failureCount
  if (!Number.isSafeInteger(failureCount) || Number(failureCount) < 0) {
    throw new TypeError('legacy heartbeat failureCount must be a non-negative safe integer')
  }
  const legacyLease = input.activeLease === undefined ? undefined : parseLegacyLease(input.activeLease)
  const activeHours = input.activeHours === undefined ? undefined : parseActiveHours(input.activeHours)
  const lastSuccessAt = optionalTimestamp(input.lastSuccessAt, 'lastSuccessAt')
  const lastFailureAt = optionalTimestamp(input.lastFailureAt, 'lastFailureAt')
  const nextRunAt = optionalTimestamp(input.nextRunAt, 'nextRunAt')
  const lastFailure = optionalBoundedText(input.lastFailure, 'lastFailure')
  const lastEvidence = optionalBoundedText(input.lastEvidence, 'lastEvidence')
  const pauseReason = optionalBoundedText(input.pauseReason, 'pauseReason')
  const meaningful = legacyLease !== undefined || activeHours !== undefined || lastSuccessAt !== undefined
    || lastFailureAt !== undefined || nextRunAt !== undefined || lastFailure !== undefined
    || lastEvidence !== undefined || pauseReason !== undefined || Number(failureCount) > 0
  if (!meaningful) return { schemaVersion: 2, checks: [] }
  const intervalMs = legacyLease?.intervalMs ?? 60_000
  return {
    schemaVersion: 2,
    checks: [{
      id: LEGACY_CHECK_ID,
      intervalMs,
      ...(activeHours === undefined ? {} : { activeHours }),
      ...(legacyLease === undefined ? {} : { activeLease: legacyLease.lease }),
      ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
      ...(lastFailureAt === undefined ? {} : { lastFailureAt }),
      ...(lastFailure === undefined ? {} : { lastFailure }),
      ...(lastEvidence === undefined ? {} : { lastEvidence }),
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
      ...(pauseReason === undefined ? {} : { pauseReason }),
      failureCount: Number(failureCount),
    }],
  }
}

function parseLease(value: unknown): StoredHeartbeatLease {
  const input = record(value, 'heartbeat lease')
  assertOnly(input, LEASE_FIELDS, 'heartbeat lease')
  const leaseId = boundedText(input.leaseId, 'leaseId', 128)
  return {
    leaseId,
    acquiredAt: timestamp(input.acquiredAt, 'acquiredAt'),
    lastHeartbeatAt: timestamp(input.lastHeartbeatAt, 'lastHeartbeatAt'),
  }
}

function parseLegacyLease(value: unknown): { readonly lease: StoredHeartbeatLease; readonly intervalMs: number } {
  const input = record(value, 'legacy heartbeat lease')
  assertOnly(input, new Set(['leaseId', 'task', 'acquiredAt', 'lastHeartbeatAt', 'expectedEveryMs']), 'legacy heartbeat lease')
  validateHeartbeatInterval(input.expectedEveryMs)
  return {
    lease: {
      leaseId: boundedText(input.leaseId, 'leaseId', 128),
      acquiredAt: timestamp(input.acquiredAt, 'acquiredAt'),
      lastHeartbeatAt: timestamp(input.lastHeartbeatAt, 'lastHeartbeatAt'),
    },
    intervalMs: input.expectedEveryMs,
  }
}

function parseActiveHours(value: unknown): HeartbeatActiveHours {
  validateActiveHours(value)
  return { startHour: value.startHour, endHour: value.endHour }
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : timestamp(value, field)
}

function timestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${field} must be a non-negative safe integer`)
  return Number(value)
}

function optionalBoundedText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : boundedText(value, field, 2_048)
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new TypeError(`${field} must contain 1 to ${max} characters`)
  }
  return value
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function assertOnly(input: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const extra = Object.keys(input).filter(key => !allowed.has(key))
  if (extra.length > 0) throw new TypeError(`Unknown ${label} field: ${extra.join(', ')}`)
}
