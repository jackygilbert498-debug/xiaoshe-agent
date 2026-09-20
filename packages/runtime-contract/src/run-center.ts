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

/** Public limits of the v1 taskGraph wire projection. Keep aligned with the runtime domain. */
export const GRAPH_LIMITS = Object.freeze({ nodes: 64, acceptance: 8, evidence: 16, feedback: 8, text: 2_000, history: 10_000, snapshot: 400_000 })
export type NodeStatus = 'pending' | 'running' | 'verifying' | 'completed' | 'blocked' | 'interrupted'
export interface Acceptance { readonly id: string; readonly text: string }
export interface Feedback { readonly text: string; readonly outcome: 'failed' | 'needs-work' | 'passed' | 'interrupted' }
export interface Evidence {
  readonly callId: string
  readonly resultSeq: number
  readonly toolName: string
  readonly attempt: number
  readonly kind: 'execution' | 'reviewer-assessment'
  readonly acceptanceId?: string
  readonly assertion?: string
  readonly sourceExcerpt?: string
}
export interface GraphNode {
  readonly id: string
  readonly title: string
  readonly dependencies: readonly string[]
  readonly acceptance: readonly Acceptance[]
  readonly status: NodeStatus
  readonly attempt: number
  readonly startSeq: number | null
  readonly evidence: readonly Evidence[]
  readonly feedback: readonly Feedback[]
}
export interface GraphSnapshot {
  readonly version: 1
  readonly id: string
  readonly revision: number
  readonly sessionId: string
  readonly taskGeneration: number
  readonly goalId: string | null
  readonly objective: string
  readonly runtimeInstance: string
  readonly durability: 'pending' | 'durable'
  readonly nodes: readonly GraphNode[]
  readonly feedback: readonly Feedback[]
}
export interface TaskGraphView extends GraphSnapshot {
  readonly status: 'ready' | 'active' | 'waiting' | 'completed'
  readonly stale: boolean
  readonly recoveryRequired: boolean
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
  readonly taskGraph?: TaskGraphView
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
  setGoalPhase(input: {
    readonly sessionId: string
    readonly action: 'pause' | 'resume'
  }): Promise<RuntimeCommandResult<{ accepted: true }>>
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
const NODE_STATUSES = new Set<NodeStatus>(['pending', 'running', 'verifying', 'completed', 'blocked', 'interrupted'])
const FEEDBACK_OUTCOMES = new Set<Feedback['outcome']>(['failed', 'needs-work', 'passed', 'interrupted'])
const GRAPH_STATUSES = new Set<TaskGraphView['status']>(['ready', 'active', 'waiting', 'completed'])

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
  const taskGraph = value.taskGraph === undefined ? undefined : parseTaskGraphView(value.taskGraph, sessionId)
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
    ...(taskGraph === undefined ? {} : { taskGraph }),
    ...(error === undefined ? {} : { error }),
  })
}

/**
 * Parse the authoritative v1 taskGraph view for UI/terminal consumption.
 * The output is a detached whitelist projection: unknown runtime-private fields
 * are stripped, malformed DAGs fail closed, and the display status/order are
 * recomputed from node facts rather than trusted from the wire.
 */
export function parseTaskGraphView(value: unknown, expectedSessionId?: string): TaskGraphView | undefined {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || serialized.length > GRAPH_LIMITS.snapshot) return undefined
    const row = graphRecord(value)
    if (row.version !== 1 || !GRAPH_STATUSES.has(row.status as TaskGraphView['status'])
      || typeof row.stale !== 'boolean' || typeof row.recoveryRequired !== 'boolean'
      || (row.durability !== 'pending' && row.durability !== 'durable')) return undefined
    const revision = graphInteger(row.revision)
    if (revision < 1) return undefined
    const sessionId = graphText(row.sessionId, 256)
    if (expectedSessionId !== undefined && sessionId !== expectedSessionId) return undefined
    const nodes = parseGraphNodes(row.nodes)
    const stale = row.stale
    const recoveryRequired = row.recoveryRequired
    const durability = row.durability
    const status = graphStatus(nodes, durability, stale, recoveryRequired, row.status as TaskGraphView['status'])
    return deepFreeze({
      version: 1,
      id: graphId(row.id),
      revision,
      sessionId,
      taskGeneration: graphInteger(row.taskGeneration),
      goalId: row.goalId === null ? null : graphText(row.goalId, 256),
      objective: graphText(row.objective),
      runtimeInstance: graphId(row.runtimeInstance),
      durability,
      nodes,
      feedback: graphArray(row.feedback, GRAPH_LIMITS.feedback).map(parseGraphFeedback),
      status,
      stale,
      recoveryRequired,
    })
  } catch {
    return undefined
  }
}

function parseGraphNodes(value: unknown): readonly GraphNode[] {
  const nodes = graphArray(value, GRAPH_LIMITS.nodes).map(item => {
    const row = graphRecord(item)
    if (!NODE_STATUSES.has(row.status as NodeStatus)) throw new TypeError('invalid task graph node status')
    const acceptance = graphArray(row.acceptance, GRAPH_LIMITS.acceptance).map(item => {
      const criterion = graphRecord(item)
      return { id: graphId(criterion.id), text: graphText(criterion.text) }
    })
    if (acceptance.length === 0 || new Set(acceptance.map(item => item.id)).size !== acceptance.length) throw new TypeError('invalid task graph acceptance')
    const dependencies = graphArray(row.dependencies, GRAPH_LIMITS.nodes).map(graphId)
    if (new Set(dependencies).size !== dependencies.length) throw new TypeError('duplicate task graph dependency')
    const status = row.status as NodeStatus
    const attempt = graphInteger(row.attempt)
    const startSeq = row.startSeq === null ? null : graphInteger(row.startSeq)
    const evidence = graphArray(row.evidence, GRAPH_LIMITS.evidence).map(parseGraphEvidence)
    const feedback = graphArray(row.feedback, GRAPH_LIMITS.feedback).map(parseGraphFeedback)
    return { id: graphId(row.id), title: graphText(row.title, 300), dependencies, acceptance, status, attempt, startSeq, evidence, feedback }
  })
  if (nodes.length === 0 || new Set(nodes.map(node => node.id)).size !== nodes.length) throw new TypeError('invalid task graph nodes')
  const byId = new Map(nodes.map(node => [node.id, node]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const ordered: GraphNode[] = []
  const visit = (node: GraphNode): void => {
    if (visiting.has(node.id)) throw new TypeError('task graph dependency cycle')
    if (visited.has(node.id)) return
    visiting.add(node.id)
    for (const dependencyId of node.dependencies) {
      const dependency = byId.get(dependencyId)
      if (dependency === undefined) throw new TypeError('missing task graph dependency')
      visit(dependency)
    }
    visiting.delete(node.id)
    visited.add(node.id)
    ordered.push(node)
  }
  for (const node of nodes) visit(node)
  if (nodes.filter(node => node.status === 'running' || node.status === 'verifying').length > 1) throw new TypeError('multiple active task graph nodes')
  for (const node of nodes) {
    if (node.status !== 'pending' && (node.attempt < 1 || node.startSeq === null)) throw new TypeError('missing task graph attempt identity')
    if (node.evidence.some(item => item.attempt !== node.attempt)) throw new TypeError('stale task graph evidence')
    if (node.status === 'completed' && !node.acceptance.every(criterion => node.evidence.some(item => item.kind === 'reviewer-assessment' && item.acceptanceId === criterion.id))) {
      throw new TypeError('incomplete task graph acceptance')
    }
    if ((node.status === 'running' || node.status === 'verifying' || node.status === 'completed')
      && !node.dependencies.every(dependencyId => byId.get(dependencyId)?.status === 'completed')) throw new TypeError('unfinished task graph prerequisite')
  }
  return ordered
}

function parseGraphFeedback(value: unknown): Feedback {
  const row = graphRecord(value)
  if (!FEEDBACK_OUTCOMES.has(row.outcome as Feedback['outcome'])) throw new TypeError('invalid task graph feedback')
  return { text: graphText(row.text), outcome: row.outcome as Feedback['outcome'] }
}

function parseGraphEvidence(value: unknown): Evidence {
  const row = graphRecord(value)
  if (row.kind !== 'execution' && row.kind !== 'reviewer-assessment') throw new TypeError('invalid task graph evidence kind')
  const base: Evidence = {
    callId: graphText(row.callId, 256), resultSeq: graphInteger(row.resultSeq), toolName: graphText(row.toolName, 256),
    attempt: graphInteger(row.attempt), kind: row.kind,
  }
  if (row.kind === 'execution') {
    if (row.acceptanceId !== undefined || row.assertion !== undefined || row.sourceExcerpt !== undefined) throw new TypeError('execution cannot claim acceptance')
    return base
  }
  return { ...base, acceptanceId: graphId(row.acceptanceId), assertion: graphText(row.assertion), sourceExcerpt: graphText(row.sourceExcerpt, 1_000) }
}

function graphStatus(nodes: readonly GraphNode[], durability: GraphSnapshot['durability'], stale: boolean, recoveryRequired: boolean,
  authoritative: TaskGraphView['status']): TaskGraphView['status'] {
  // `waiting` may encode a private replay failure that the public wire does
  // not otherwise expose. Never upgrade that conservative producer verdict.
  if (authoritative === 'waiting') return 'waiting'
  if (durability === 'pending' || stale || recoveryRequired) return 'waiting'
  if (nodes.every(node => node.status === 'completed')) return 'completed'
  if (nodes.some(node => node.status === 'running' || node.status === 'verifying')) return 'active'
  const completed = new Set(nodes.filter(node => node.status === 'completed').map(node => node.id))
  return nodes.some(node => node.status === 'pending' && node.dependencies.every(id => completed.has(id))) ? 'ready' : 'waiting'
}

function graphRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError('expected task graph object')
  return value
}

function graphArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError('invalid task graph list')
  return value
}

function graphText(value: unknown, maximum: number = GRAPH_LIMITS.text): string {
  if (typeof value !== 'string' || value.length > maximum || value.trim() === '') throw new TypeError('invalid task graph text')
  return value.trim()
}

function graphId(value: unknown): string {
  const result = graphText(value, 128)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(result)) throw new TypeError('invalid task graph id')
  return result
}

function graphInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError('invalid task graph counter')
  return Number(value)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
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
