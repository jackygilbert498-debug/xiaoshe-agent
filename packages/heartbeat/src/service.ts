import {
  parseHeartbeatState,
  validateActiveHours,
  validateCheckId,
  validateHeartbeatInterval,
  type HeartbeatActiveHours,
  type StoredHeartbeatCheck,
  type StoredHeartbeatLease,
  type StoredHeartbeatState,
} from './schema.js'

export type HeartbeatStatus = 'idle' | 'running' | 'healthy' | 'delayed' | 'lost' | 'paused' | 'backoff'
export type HeartbeatLease = StoredHeartbeatLease

export interface HeartbeatCheckState extends StoredHeartbeatCheck {
  readonly status: HeartbeatStatus
}

export interface HeartbeatSnapshot {
  readonly schemaVersion: 2
  readonly checks: readonly HeartbeatCheckState[]
}

export interface HeartbeatStore {
  get(): Record<string, unknown>
  update(patch: Record<string, unknown>): Promise<void>
  watch(callback: (next: Record<string, unknown>) => void): () => void
}

export interface HeartbeatService {
  snapshot(): HeartbeatSnapshot
  subscribe(listener: () => void): () => void
  ensureCheck(input: { readonly id: string; readonly intervalMs: number; readonly activeHours?: HeartbeatActiveHours }): Promise<void>
  acquire(checkId: string, leaseId: string): Promise<void>
  checkpoint(checkId: string, leaseId: string): Promise<void>
  succeed(checkId: string, leaseId: string, evidence?: string): Promise<void>
  fail(checkId: string, leaseId: string, reason: string): Promise<void>
  pause(checkId: string, reason: string): Promise<void>
  resume(checkId: string): Promise<void>
  recoverInterruptedLeases(): Promise<readonly string[]>
  dispose(): void
}

const MAX_BACKOFF_MS = 60 * 60 * 1_000
const MAX_TEXT_LENGTH = 2_048
const STORE_WRITE_RETRY_DELAYS_MS = [50, 150] as const
const LEGACY_TOMBSTONES = {
  status: null,
  activeLease: null,
  activeHours: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailure: null,
  lastEvidence: null,
  nextRunAt: null,
  pauseReason: null,
  failureCount: null,
} as const

/** Profile-scoped cross-session check ledger. Actual execution belongs to a coordinator and DSH Jobs. */
export function createHeartbeatService(
  store: HeartbeatStore,
  options: {
    readonly now?: () => number
    readonly sleep?: (milliseconds: number) => Promise<void>
  } = {},
): HeartbeatService {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)))
  const listeners = new Set<() => void>()
  let state = parseHeartbeatState(store.get())
  let queue: Promise<void> = Promise.resolve()
  let writing = false
  let pendingStoreState: StoredHeartbeatState | undefined
  let disposed = false

  const notify = (): void => { for (const listener of listeners) listener() }
  const unsubscribe = store.watch((next) => {
    const parsed = parseHeartbeatState(next)
    if (writing) {
      pendingStoreState = parsed
      return
    }
    state = parsed
    notify()
  })

  function mutate<T>(operation: (current: StoredHeartbeatState) => { readonly next: StoredHeartbeatState; readonly result: T }): Promise<T> {
    const run = queue.then(async () => {
      assertLive()
      const { next, result } = operation(state)
      writing = true
      pendingStoreState = undefined
      try {
        await updateStoreWithRetry({
          ...LEGACY_TOMBSTONES,
          schemaVersion: 2,
          checks: cloneChecks(next.checks) as unknown as Record<string, unknown>[],
        })
        state = pendingStoreState ?? parseHeartbeatState(store.get())
      } finally {
        writing = false
        pendingStoreState = undefined
      }
      notify()
      return result
    })
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  function assertLive(): void {
    if (disposed) throw new Error('heartbeat service is disposed')
  }

  /**
   * The Profile settings writer serializes independent plugin writes with a short-lived lock.
   * Retry only that exact transient contention; malformed settings and all other failures stay
   * fail-fast, and persistent/orphan locks remain an explicit operator-recovery condition.
   */
  async function updateStoreWithRetry(patch: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await store.update(patch)
        return
      } catch (error) {
        const retryDelay = STORE_WRITE_RETRY_DELAYS_MS[attempt]
        if (!isWriterLockTimeout(error) || retryDelay === undefined) throw error
        await sleep(retryDelay)
      }
    }
  }

  return {
    snapshot() {
      const at = now()
      return {
        schemaVersion: 2,
        checks: state.checks.map(check => ({ ...cloneCheck(check), status: statusOf(check, at) })),
      }
    },
    subscribe(listener) {
      assertLive()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async ensureCheck(input) {
      validateCheckId(input.id)
      validateHeartbeatInterval(input.intervalMs)
      if (input.activeHours !== undefined) validateActiveHours(input.activeHours)
      await mutate(current => {
        const existing = current.checks.find(check => check.id === input.id)
        const at = now()
        const check: StoredHeartbeatCheck = existing === undefined
          ? {
              id: input.id,
              intervalMs: input.intervalMs,
              ...(input.activeHours === undefined ? {} : { activeHours: { ...input.activeHours } }),
              nextRunAt: at + input.intervalMs,
              failureCount: 0,
            }
          : {
              ...(input.activeHours === undefined
                ? without(existing, 'activeHours')
                : { ...existing, activeHours: { ...input.activeHours } }),
              intervalMs: input.intervalMs,
              ...(existing.nextRunAt === undefined && existing.activeLease === undefined && existing.pauseReason === undefined
                ? { nextRunAt: at + input.intervalMs }
                : {}),
            }
        return { next: replaceCheck(current, check), result: undefined }
      })
    },
    async acquire(checkId, leaseId) {
      validateCheckId(checkId)
      const normalizedLeaseId = boundedText(leaseId, 'leaseId')
      await mutate(current => {
        const check = expectCheck(current, checkId)
        if (check.pauseReason !== undefined) throw new Error(`heartbeat check is paused: ${checkId}`)
        if (check.activeLease !== undefined) throw new Error(`heartbeat check already has an active lease: ${checkId}`)
        const at = now()
        return {
          next: replaceCheck(current, {
            ...without(check, 'nextRunAt'),
            activeLease: { leaseId: normalizedLeaseId, acquiredAt: at, lastHeartbeatAt: at },
          }),
          result: undefined,
        }
      })
    },
    async checkpoint(checkId, leaseId) {
      validateCheckId(checkId)
      await mutate(current => {
        const check = expectCheck(current, checkId)
        const lease = assertLease(check, leaseId)
        return {
          next: replaceCheck(current, { ...check, activeLease: { ...lease, lastHeartbeatAt: now() } }),
          result: undefined,
        }
      })
    },
    async succeed(checkId, leaseId, evidence) {
      validateCheckId(checkId)
      const normalizedEvidence = evidence === undefined ? undefined : boundedText(evidence, 'evidence')
      await mutate(current => {
        const check = expectCheck(current, checkId)
        assertLease(check, leaseId)
        const at = now()
        const clean = without(without(without(without(check, 'activeLease'), 'lastFailure'), 'lastFailureAt'), 'pauseReason')
        const withEvidence = normalizedEvidence === undefined
          ? without(clean, 'lastEvidence')
          : { ...clean, lastEvidence: normalizedEvidence }
        return {
          next: replaceCheck(current, {
            ...withEvidence,
            lastSuccessAt: at,
            nextRunAt: at + check.intervalMs,
            failureCount: 0,
          }),
          result: undefined,
        }
      })
    },
    async fail(checkId, leaseId, reason) {
      validateCheckId(checkId)
      const message = boundedText(reason, 'failure reason')
      await mutate(current => {
        const check = expectCheck(current, checkId)
        assertLease(check, leaseId)
        const failureCount = Math.min(check.failureCount + 1, Number.MAX_SAFE_INTEGER)
        const at = now()
        const clean = without(check, 'activeLease')
        return {
          next: replaceCheck(current, {
            ...clean,
            lastFailureAt: at,
            lastFailure: message,
            failureCount,
            nextRunAt: at + backoffFor(failureCount),
          }),
          result: undefined,
        }
      })
    },
    async pause(checkId, reason) {
      validateCheckId(checkId)
      const message = boundedText(reason, 'pause reason')
      await mutate(current => {
        const check = expectCheck(current, checkId)
        return {
          next: replaceCheck(current, { ...without(check, 'nextRunAt'), pauseReason: message }),
          result: undefined,
        }
      })
    },
    async resume(checkId) {
      validateCheckId(checkId)
      await mutate(current => {
        const check = expectCheck(current, checkId)
        const resumed = without(check, 'pauseReason')
        return {
          next: replaceCheck(current, check.activeLease === undefined ? { ...resumed, nextRunAt: now() } : resumed),
          result: undefined,
        }
      })
    },
    async recoverInterruptedLeases() {
      return await mutate(current => {
        const interrupted: string[] = []
        const at = now()
        const checks = current.checks.map((check) => {
          if (check.activeLease === undefined) return check
          interrupted.push(check.id)
          const failureCount = Math.min(check.failureCount + 1, Number.MAX_SAFE_INTEGER)
          return {
            ...without(check, 'activeLease'),
            lastFailureAt: at,
            lastFailure: 'interrupted by process restart',
            failureCount,
            nextRunAt: at + Math.max(60_000, backoffFor(failureCount)),
          }
        })
        return { next: { schemaVersion: 2, checks }, result: interrupted }
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      unsubscribe()
    },
  }
}

function isWriterLockTimeout(error: unknown): error is Error {
  return error instanceof Error
    && /^atomic-write: timed out waiting for the writer lock at /u.test(error.message)
}

function expectCheck(state: StoredHeartbeatState, id: string): StoredHeartbeatCheck {
  const check = state.checks.find(candidate => candidate.id === id)
  if (check === undefined) throw new Error(`unknown heartbeat check: ${id}`)
  return check
}

function assertLease(check: StoredHeartbeatCheck, leaseId: string): StoredHeartbeatLease {
  if (check.activeLease?.leaseId !== leaseId) throw new Error(`lease mismatch for ${check.id}: ${leaseId}`)
  return check.activeLease
}

function replaceCheck(state: StoredHeartbeatState, replacement: StoredHeartbeatCheck): StoredHeartbeatState {
  const found = state.checks.some(check => check.id === replacement.id)
  return {
    schemaVersion: 2,
    checks: [...state.checks.map(check => check.id === replacement.id ? replacement : check), ...(found ? [] : [replacement])]
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function statusOf(check: StoredHeartbeatCheck, at: number): HeartbeatStatus {
  if (check.pauseReason !== undefined) return 'paused'
  if (check.activeLease !== undefined) {
    const elapsed = Math.max(0, at - check.activeLease.lastHeartbeatAt)
    if (elapsed > check.intervalMs * 3) return 'lost'
    if (elapsed > check.intervalMs * 1.5) return 'delayed'
    return 'running'
  }
  if (check.failureCount > 0 && check.nextRunAt !== undefined && check.nextRunAt > at) return 'backoff'
  if (check.lastSuccessAt !== undefined && (check.lastFailureAt === undefined || check.lastSuccessAt >= check.lastFailureAt)) return 'healthy'
  return 'idle'
}

function backoffFor(failureCount: number): number {
  return Math.min(1_000 * (2 ** Math.min(Math.max(failureCount - 1, 0), 30)), MAX_BACKOFF_MS)
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const normalized = value.trim()
  if (normalized === '' || normalized.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`${label} must contain 1 to ${MAX_TEXT_LENGTH} characters`)
  }
  return normalized
}

function cloneChecks(checks: readonly StoredHeartbeatCheck[]): readonly StoredHeartbeatCheck[] {
  return checks.map(cloneCheck)
}

function cloneCheck(check: StoredHeartbeatCheck): StoredHeartbeatCheck {
  return {
    ...check,
    ...(check.activeHours === undefined ? {} : { activeHours: { ...check.activeHours } }),
    ...(check.activeLease === undefined ? {} : { activeLease: { ...check.activeLease } }),
  }
}

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value }
  delete copy[key]
  return copy
}
