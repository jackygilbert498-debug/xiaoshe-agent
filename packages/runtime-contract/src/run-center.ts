import type { RuntimeCommandResult } from './commands.js'

export type RunJobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** One DSH background job projected without inventing unavailable controls. */
export interface RunCenterJob {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: RunJobStatus
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
  /** DSH has no public generic job-cancel face at this boundary. */
  readonly cancellable: false
}

export type RunCenterSubagent =
  | {
    readonly kind: 'child'
    readonly id: string
    readonly mode: 'one-shot' | 'continuable'
    readonly label?: string
    readonly activity: 'running' | 'inactive'
    readonly hasChildren: boolean
    readonly parentAvailable: boolean
    readonly canOpen: true
    readonly canInterrupt: boolean
  }
  | {
    readonly kind: 'diagnostic'
    readonly id: string
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    readonly canOpen: false
    readonly canInterrupt: false
  }

export interface RunCenterQueueItem {
  readonly id: string
  readonly messageId: string
  readonly placement: 'queued' | 'steering' | 'context'
  readonly preview: string
  readonly text: string | null
  readonly editable: boolean
  readonly removable: boolean
  readonly steerable: boolean
}

export interface RunCenterGoal {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: string
  readonly roundsStarted: number
  readonly maxGoalRounds: number
  readonly blockedReason?: string
}

export interface RunCenterPlan {
  readonly active: boolean
  readonly pending: boolean
}

export interface RunCenterTodo {
  readonly id: string
  readonly text: string
  readonly status: string
}

export interface RunCenterSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}

export interface RunCenterDeliverable {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly status: 'running' | 'ready' | 'error' | 'blocked'
  readonly source?: string
}

export interface RunCenterSnapshot {
  readonly sessionId?: string
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly jobs: readonly RunCenterJob[]
  readonly subagents: readonly RunCenterSubagent[]
  readonly queue: readonly RunCenterQueueItem[]
  readonly goal?: RunCenterGoal
  readonly plan?: RunCenterPlan
  readonly todos: readonly RunCenterTodo[]
  readonly skills: readonly RunCenterSkill[]
  readonly deliverables: readonly RunCenterDeliverable[]
  readonly error?: string
}

export type RunCenterQueueAction =
  | { readonly kind: 'edit'; readonly text: string }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }

/** Product seam over public DSH run facts and the controls that actually exist. */
export interface RunCenter {
  getSnapshot(): RunCenterSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<RuntimeCommandResult<RunCenterSnapshot>>
  updateQueue(input: {
    readonly sessionId: string
    readonly itemId: string
    readonly action: RunCenterQueueAction
  }): Promise<RuntimeCommandResult<{ accepted: true }>>
  openSubagent(input: {
    readonly parentSessionId: string
    readonly childSessionId: string
  }): RuntimeCommandResult<{ opened: true }>
  interruptSubagent(input: {
    readonly parentSessionId: string
    readonly childSessionId: string
  }): Promise<RuntimeCommandResult<{ accepted: true }>>
}

const JOB_STATUSES = new Set<RunJobStatus>(['running', 'stopping', 'completed', 'killed', 'failed'])
const PLACEMENTS = new Set<RunCenterQueueItem['placement']>(['queued', 'steering', 'context'])
const DELIVERABLE_STATUSES = new Set<RunCenterDeliverable['status']>(['running', 'ready', 'error', 'blocked'])
const SNAPSHOT_STATUSES = new Set<RunCenterSnapshot['status']>(['idle', 'loading', 'ready', 'error'])
const MAX_ROWS = 1_000

/**
 * Validate an untyped run-center projection at a product boundary.
 * Invalid rows are omitted; an invalid top-level lifecycle fails closed.
 */
export function parseRunCenterSnapshot(value: unknown): RunCenterSnapshot {
  if (!isRecord(value) || !SNAPSHOT_STATUSES.has(value.status as RunCenterSnapshot['status'])) {
    return emptyErrorSnapshot()
  }
  const status = value.status as RunCenterSnapshot['status']
  const sessionId = boundedText(value.sessionId, 512)
  const jobs = frozenRows(value.jobs, parseJob)
  const subagents = frozenRows(value.subagents, parseSubagent)
  const queue = frozenRows(value.queue, parseQueueItem)
  const todos = frozenRows(value.todos, parseTodo)
  const skills = uniqueRows(value.skills, parseSkill, row => row.name)
  const deliverables = uniqueRows(value.deliverables, parseDeliverable, row => row.id)
  const goal = parseGoal(value.goal)
  const plan = parsePlan(value.plan)
  const error = boundedText(value.error, 1_000)
  return Object.freeze({
    ...(sessionId === undefined ? {} : { sessionId }),
    status,
    jobs,
    subagents,
    queue,
    ...(goal === undefined ? {} : { goal }),
    ...(plan === undefined ? {} : { plan }),
    todos,
    skills,
    deliverables,
    ...(error === undefined ? {} : { error }),
  })
}

function emptyErrorSnapshot(): RunCenterSnapshot {
  return Object.freeze({
    status: 'error',
    jobs: Object.freeze([]),
    subagents: Object.freeze([]),
    queue: Object.freeze([]),
    todos: Object.freeze([]),
    skills: Object.freeze([]),
    deliverables: Object.freeze([]),
    error: '运行中心快照无效',
  })
}

function parseJob(value: unknown): RunCenterJob | undefined {
  if (!isRecord(value)) return undefined
  const id = boundedText(value.id, 256)
  const kind = boundedText(value.kind, 128)
  const label = boundedText(value.label, 500)
  const status = JOB_STATUSES.has(value.status as RunJobStatus) ? value.status as RunJobStatus : undefined
  const startedAt = nonNegativeNumber(value.startedAt)
  const finishedAt = nonNegativeNumber(value.finishedAt)
  const detail = boundedText(value.detail, 1_000)
  if (id === undefined || kind === undefined || label === undefined || status === undefined || startedAt === undefined) return undefined
  return Object.freeze({
    id, kind, label, status,
    ...(detail === undefined ? {} : { detail }),
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    cancellable: false,
  })
}

function parseSubagent(value: unknown): RunCenterSubagent | undefined {
  if (!isRecord(value)) return undefined
  const id = boundedText(value.id, 512)
  if (id === undefined) return undefined
  if (value.kind === 'diagnostic') {
    if (value.reason !== 'corrupt' && value.reason !== 'unsupported' && value.reason !== 'unavailable') return undefined
    return Object.freeze({ kind: 'diagnostic', id, reason: value.reason, canOpen: false, canInterrupt: false })
  }
  if (value.kind !== 'child'
    || (value.mode !== 'one-shot' && value.mode !== 'continuable')
    || (value.activity !== 'running' && value.activity !== 'inactive')
    || typeof value.hasChildren !== 'boolean') return undefined
  const label = boundedText(value.label, 240)
  const parentAvailable = value.parentAvailable === true
  return Object.freeze({
    kind: 'child', id, mode: value.mode,
    ...(label === undefined ? {} : { label }),
    activity: value.activity,
    hasChildren: value.hasChildren,
    parentAvailable,
    canOpen: true,
    canInterrupt: value.mode === 'continuable' && parentAvailable && value.activity === 'running',
  })
}

function parseQueueItem(value: unknown): RunCenterQueueItem | undefined {
  if (!isRecord(value)) return undefined
  const id = boundedText(value.id, 512)
  const messageId = boundedText(value.messageId, 512)
  const placement = PLACEMENTS.has(value.placement as RunCenterQueueItem['placement'])
    ? value.placement as RunCenterQueueItem['placement']
    : undefined
  const preview = boundedText(value.preview, 500)
  if (id === undefined || messageId === undefined || placement === undefined || preview === undefined) return undefined
  const text = value.text === null ? null : boundedText(value.text, 32_000) ?? null
  const mutable = placement === 'queued'
  return Object.freeze({ id, messageId, placement, preview, text, editable: mutable && text !== null, removable: mutable, steerable: mutable })
}

function parseGoal(value: unknown): RunCenterGoal | undefined {
  if (!isRecord(value)) return undefined
  const id = boundedText(value.id, 256)
  const objective = boundedText(value.objective, 8_000)
  const phase = boundedText(value.phase, 64)
  const revision = nonNegativeInteger(value.revision)
  const roundsStarted = nonNegativeInteger(value.roundsStarted)
  const maxGoalRounds = positiveInteger(value.maxGoalRounds)
  const blockedReason = boundedText(value.blockedReason, 2_000)
  if (id === undefined || objective === undefined || phase === undefined || revision === undefined || roundsStarted === undefined || maxGoalRounds === undefined) return undefined
  return Object.freeze({ id, revision, objective, phase, roundsStarted, maxGoalRounds, ...(blockedReason === undefined ? {} : { blockedReason }) })
}

function parsePlan(value: unknown): RunCenterPlan | undefined {
  return isRecord(value) && typeof value.active === 'boolean' && typeof value.pending === 'boolean'
    ? Object.freeze({ active: value.active, pending: value.pending })
    : undefined
}

function parseTodo(value: unknown): RunCenterTodo | undefined {
  if (!isRecord(value)) return undefined
  const id = boundedText(value.id, 256)
  const text = boundedText(value.text, 4_000)
  const status = boundedText(value.status, 64)
  return id === undefined || text === undefined || status === undefined ? undefined : Object.freeze({ id, text, status })
}

function parseSkill(value: unknown): RunCenterSkill | undefined {
  if (!isRecord(value) || typeof value.modelInvocable !== 'boolean') return undefined
  const name = boundedText(value.name, 128)
  const description = boundedText(value.description, 1_000)
  const whenToUse = boundedText(value.whenToUse, 2_000)
  return name === undefined || description === undefined ? undefined : Object.freeze({
    name, description, ...(whenToUse === undefined ? {} : { whenToUse }), modelInvocable: value.modelInvocable,
  })
}

function parseDeliverable(value: unknown): RunCenterDeliverable | undefined {
  if (!isRecord(value)) return undefined
  const id = boundedText(value.id, 512)
  const title = boundedText(value.title, 500)
  const kind = boundedText(value.kind, 64)
  const status = DELIVERABLE_STATUSES.has(value.status as RunCenterDeliverable['status'])
    ? value.status as RunCenterDeliverable['status']
    : undefined
  const source = boundedText(value.source, 2_000)
  return id === undefined || title === undefined || kind === undefined || status === undefined ? undefined : Object.freeze({
    id, title, kind, status, ...(source === undefined ? {} : { source }),
  })
}

function frozenRows<T>(value: unknown, parse: (item: unknown) => T | undefined): readonly T[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const rows: T[] = []
  for (const item of value.slice(0, MAX_ROWS)) {
    const row = parse(item)
    if (row !== undefined) rows.push(row)
  }
  return Object.freeze(rows)
}

function uniqueRows<T>(value: unknown, parse: (item: unknown) => T | undefined, key: (item: T) => string): readonly T[] {
  const rows = frozenRows(value, parse)
  const seen = new Set<string>()
  return Object.freeze(rows.filter(row => {
    const id = key(row)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }))
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return normalized === '' ? undefined : normalized.slice(0, maximum).trimEnd()
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
