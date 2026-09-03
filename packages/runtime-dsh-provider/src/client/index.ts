import type {
  AgentRuntimeSession,
  CreateSessionInput,
  ForkSessionInput,
  RuntimeCommandErrorKind,
  RuntimeCommandResult,
  RuntimeImageInputLimits,
  RuntimeSessionProjection,
  RuntimeSessionSnapshot,
  RunCenter,
  RunCenterQueueAction,
  RunCenterSnapshot,
  SendTurnInput,
  SessionCommand,
  SessionCommandInput,
  StopRunInput,
  SessionCatalog,
  SessionCatalogSnapshot,
  ContextGovernance,
  ContextGovernanceSnapshot,
  ModelCatalog,
  ModelCatalogSnapshot,
  ModelSelection,
  TaskTimeline,
  TaskTimelineItem,
  TaskTimelineSnapshot,
  UserQuestionAnswer,
  UserQuestionInteraction,
  UserQuestionInteractionSnapshot,
  UserQuestionItem,
  UserQuestionRequest,
  WorkspaceCatalog,
  WorkspaceCatalogEntry,
  WorkspaceCatalogSnapshot,
  WorkSurfaceRegistry,
} from '@xiaoshe/runtime-contract'
import { deriveCompactionCheckpoints, deriveContextBudget, parseRunCenterSnapshot } from '@xiaoshe/runtime-contract'
import { DshWorkSurfaceRegistry } from './surfaces.js'

export { DshWorkSurfaceRegistry, isLoopbackHost, projectDshWorkSurfaces, safeSurfaceUrl } from './surfaces.js'

interface RpcErrorLike { readonly code: string; readonly message: string; readonly details?: unknown }
type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcErrorLike }
interface ObservableSnapshotPort<T = unknown> {
  getSnapshot(): T
  subscribe?(listener: () => void): () => void
}
type DshPromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; readonly data: string; readonly name?: string }
interface SessionFacePort {
  prompt(content: readonly DshPromptContentPart[], mode: 'queue' | 'steer'): Promise<RpcResult<{ accepted: true }>>
  cancel(): Promise<RpcResult<{ accepted: true }>>
  rename(title: string): Promise<RpcResult<{ readonly title: string; readonly seq: number }>>
  command?(line: string): Promise<{ readonly ok: true; readonly value: { readonly matched: boolean } } | { readonly ok: false; readonly error: RpcErrorLike }>
  readonly projections?: { faceOf(key: string): ObservableSnapshotPort }
  getSnapshot?(): {
    readonly nodes?: readonly unknown[]
    readonly partial?: { readonly text?: string } | null
    readonly pending?: readonly PendingWaitPort[]
    readonly queue?: readonly QueueItemPort[]
  }
  subscribe?(listener: () => void): () => void
  updateQueue?(itemId: string, action: QueueActionPort): Promise<RpcResult<{ accepted: true }>>
}
type QueueActionPort =
  | { readonly kind: 'edit'; readonly content: readonly { readonly type: 'text'; readonly text: string }[] }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }
interface QueueItemPort {
  readonly id: string
  readonly messageId: string
  readonly placement: 'queued' | 'steering' | 'context'
  readonly preview: string
  readonly text: string | null
}
interface PendingWaitPort {
  readonly kind: string
  readonly key: string
  readonly sessionId: string
  readonly payload: unknown
  respond(result: unknown): Promise<{ readonly accepted: boolean; readonly reason?: string }>
}
export interface UserApprovalSnapshot {
  readonly sessionId?: string
  readonly approvals: readonly { readonly key: string; readonly toolName: string; readonly callId?: string; readonly reason?: string }[]
}
export interface PermissionPresetSnapshot {
  readonly sessionId?: string
  readonly status: 'unavailable' | 'ready' | 'switching' | 'error'
  readonly currentValue?: string
  readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
  readonly error?: string
}
interface SessionSummaryPort {
  readonly id: string
  readonly blank: boolean
  readonly running: boolean
  readonly completed?: boolean
  readonly pendingInteraction?: unknown
  readonly updatedAt: number
  readonly title?: string
  readonly cwd?: string
  readonly parentId?: string
  readonly origin?: string
  readonly projectionValues?: Readonly<Record<string, unknown>>
}
interface SessionsPort {
  readonly list: {
    getSnapshot(): {
      readonly current?: string
      readonly ids: readonly string[]
      readonly byId: Readonly<Record<string, SessionSummaryPort>>
      readonly jobsBySession?: Readonly<Record<string, readonly JobViewPort[]>>
      readonly subagentsByParent?: Readonly<Record<string, SubagentCatalogPort>>
    }
    subscribe(listener: () => void): () => void
  }
  binding(id: string): { readonly session: SessionFacePort } | undefined
  fork(input: { readonly sessionId: string; readonly atSeq?: number; readonly increaseTitle: boolean }): Promise<string>
  create(input: { readonly loose: true }): Promise<string>
  open(id: string): void
  refreshSubagents?(parentSessionId: string): Promise<void>
  selectSubagent?(address: SubagentAddressPort): void
  search(query: string, signal: AbortSignal): Promise<RpcResult<{
    readonly items: readonly { readonly sessionId: string; readonly snippet: string }[]
    readonly hasMore: boolean
  }>>
}
interface JobViewPort {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}
type SubagentAddressPort = {
  readonly parentSessionId: string
  readonly childSessionId: string
} & ({ readonly mode: 'one-shot' } | { readonly mode: 'continuable' })
type SubagentEntryPort =
  | {
    readonly kind: 'child'
    readonly id: string
    readonly activity: 'running' | 'inactive'
    readonly hasChildren: boolean
    readonly mode: 'one-shot' | 'continuable'
    readonly label?: string
  }
  | { readonly kind: 'diagnostic'; readonly id: string; readonly reason: 'corrupt' | 'unsupported' | 'unavailable' }
interface SubagentCatalogPort {
  readonly entries: readonly SubagentEntryPort[]
  readonly parentAvailable: boolean
  readonly state?: 'loading' | 'ready' | 'error'
  readonly error?: RpcErrorLike | null
}
interface WorkspacesPort {
  readonly list: {
    getSnapshot(): {
      readonly items: readonly WorkspaceViewPort[]
      readonly archivedSessionIds: readonly string[]
      readonly state: 'idle' | 'loading' | 'error'
      readonly baselinesReady: boolean
      readonly error: { readonly message?: string; readonly code?: string } | null
    }
    subscribe(listener: () => void): () => void
  }
  connectWorkspace(workspaceId: string): Promise<string>
  moveSessionToWorkspace(sessionId: string, workspaceId: string): Promise<string>
  pickDirectory(): Promise<string | null>
  create(input: { readonly path: string }): Promise<WorkspaceViewPort>
  rename(workspaceId: string, title: string): Promise<WorkspaceViewPort>
  delete(workspaceId: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
}
interface WorkspaceViewPort {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}
interface ModelSelectionPort {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}
interface SessionModelsPort {
  readonly current: ModelSelectionPort
  readonly routable: boolean
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly reasoning?: {
        readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
        readonly defaultEffort?: string
      }
    }[]
  }[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}
interface ConnectionPort {
  readonly api: {
    readonly sessions: {
      models(input: { readonly sessionId: string }): Promise<{ readonly result: RpcResult<SessionModelsPort> }>
      selectModel(input: ModelSelectionPort & { readonly sessionId: string }): Promise<{ readonly result: RpcResult<{ readonly selected: ModelSelectionPort }> }>
    }
    readonly skills?: {
      list(input: { readonly sessionId: string }, signal?: AbortSignal): Promise<{ readonly result: RpcResult<{ readonly skills: readonly SkillEntryPort[] }> }>
    }
    readonly subagents?: {
      interrupt(input: Extract<SubagentAddressPort, { readonly mode: 'continuable' }>): Promise<{ readonly result: RpcResult<{ readonly accepted: true }> }>
    }
  }
}
interface SkillEntryPort {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}
interface ClientContextLike {
  inject(names: readonly string[], mount: (scope: ClientScopeLike) => void): unknown
}
interface ClientScopeLike {
  readonly connection: ConnectionPort
  readonly sessions: SessionsPort
  readonly workspaces: WorkspacesPort
  provide(name: string, value: unknown): unknown
  effect(execute: () => () => void, label?: string): unknown
}

export const inject = ['sessions', 'workspaces', 'connection']

/** Map only the public DSH Client service faces into the Xiaoshe product contract. */
export class DshAgentRuntimeSession implements AgentRuntimeSession {
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeList: () => void
  private snapshot: RuntimeSessionSnapshot
  private disposed = false

  constructor(private readonly sessions: SessionsPort, private readonly workspaces: WorkspacesPort) {
    this.snapshot = this.projectSnapshot()
    this.unsubscribeList = sessions.list.subscribe(() => {
      this.snapshot = this.projectSnapshot()
      for (const listener of this.listeners) listener()
    })
  }

  getSnapshot(): RuntimeSessionSnapshot {
    return this.snapshot
  }

  private projectSnapshot(): RuntimeSessionSnapshot {
    const list = this.sessions.list.getSnapshot()
    const projections: Record<string, RuntimeSessionProjection> = {}
    for (const id of list.ids) {
      const summary = list.byId[id]
      if (summary === undefined) continue
      const imageInputLimits = parseDshImageInputLimits(summary.projectionValues?.imageLimits)
      projections[id] = {
        schemaVersion: 1,
        sessionId: id,
        state: summary.pendingInteraction !== undefined
          ? 'blocked'
          : summary.running
            ? 'running'
            : summary.completed === true
              ? 'completed'
              : summary.blank ? 'blank' : 'idle',
        updatedAt: summary.updatedAt,
        ...(summary.projectionValues?.completionReceipt === undefined
          ? {}
          : { completionReceipt: summary.projectionValues.completionReceipt }),
        ...(imageInputLimits === undefined ? {} : { imageInputLimits }),
      }
    }
    return { ...(list.current === undefined ? {} : { currentSessionId: list.current }), sessions: projections }
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error('AgentRuntimeSession provider is disposed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeCommandResult<{ sessionId: string }>> {
    if (input.workspaceId === undefined) return unsupported('Loose session creation is not exposed by the public DSH Client service')
    if (input.workspaceId.trim() === '') return invalid('workspaceId must not be blank')
    try {
      return { ok: true, value: { sessionId: await this.workspaces.connectWorkspace(input.workspaceId) } }
    } catch (error: unknown) {
      return ambiguous('createSession', error)
    }
  }

  async sendTurn(input: SendTurnInput): Promise<RuntimeCommandResult<{ accepted: true }>> {
    const images = input.images ?? []
    if (input.content.trim() === '' && images.length === 0) return invalid('content or images must not be blank')
    const session = this.sessions.binding(input.sessionId)?.session
    if (session === undefined) return missing(input.sessionId)
    try {
      const content: DshPromptContentPart[] = images.map(image => ({
        type: 'image', mediaType: image.mediaType, data: image.data,
        ...(image.name === undefined ? {} : { name: image.name }),
      }))
      if (input.content.trim() !== '') content.push({ type: 'text', text: input.content })
      return fold(await session.prompt(content, input.mode))
    } catch (error: unknown) {
      return ambiguous('sendTurn', error)
    }
  }

  async stopRun(input: StopRunInput): Promise<RuntimeCommandResult<{ accepted: true }>> {
    const session = this.sessions.binding(input.sessionId)?.session
    if (session === undefined) return missing(input.sessionId)
    try {
      return fold(await session.cancel())
    } catch (error: unknown) {
      return ambiguous('stopRun', error)
    }
  }

  async forkSession(input: ForkSessionInput): Promise<RuntimeCommandResult<{ sessionId: string }>> {
    if (this.sessions.binding(input.sessionId) === undefined) return missing(input.sessionId)
    try {
      const sessionId = await this.sessions.fork({
        sessionId: input.sessionId,
        ...(input.atSourceSeq === undefined ? {} : { atSeq: input.atSourceSeq }),
        increaseTitle: false,
      })
      return { ok: true, value: { sessionId } }
    } catch (error: unknown) {
      return ambiguous('forkSession', error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.unsubscribeList()
  }
}

/** Execute only commands implemented by the bound public DSH session face. */
export class DshSessionCommand implements SessionCommand {
  constructor(private readonly sessions: SessionsPort) {}

  async execute(input: SessionCommandInput): Promise<RuntimeCommandResult<{ readonly matched: boolean }>> {
    const line = input.line.trim()
    if (input.sessionId.trim() === '') return invalid('sessionId must not be blank')
    if (!line.startsWith('/') || line.includes('\n') || line.includes('\r') || line.length > 256) {
      return invalid('line must be one slash command of at most 256 characters')
    }
    const session = this.sessions.binding(input.sessionId)?.session
    if (session === undefined) return missing(input.sessionId)
    if (session.command === undefined) return unsupported('The active session does not expose Host commands')
    try {
      return fold(await session.command(line))
    } catch (error: unknown) {
      return ambiguous('sessionCommand', error)
    }
  }
}

/** Separate catalog/search/migration capability over the public DSH Client faces. */
export class DshSessionCatalog implements SessionCatalog {
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeList: () => void
  private snapshot: SessionCatalogSnapshot
  private disposed = false

  constructor(private readonly sessions: SessionsPort, private readonly workspaces: WorkspacesPort) {
    this.snapshot = this.projectSnapshot()
    this.unsubscribeList = sessions.list.subscribe(() => {
      this.snapshot = this.projectSnapshot()
      for (const listener of this.listeners) listener()
    })
  }

  getSnapshot(): SessionCatalogSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error('SessionCatalog provider is disposed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async createLooseSession(): Promise<RuntimeCommandResult<{ sessionId: string }>> {
    try { return { ok: true, value: { sessionId: await this.sessions.create({ loose: true }) } } }
    catch (error: unknown) { return ambiguous('createLooseSession', error) }
  }

  openSession(sessionId: string): RuntimeCommandResult<{ opened: true }> {
    if (this.snapshot.sessions[sessionId] === undefined) return missing(sessionId)
    try { this.sessions.open(sessionId); return { ok: true, value: { opened: true } } }
    catch (error: unknown) { return providerFailure('openSession', error) }
  }

  async renameSession(sessionId: string, title: string): Promise<RuntimeCommandResult<{ title: string }>> {
    const normalized = title.trim()
    if (normalized === '') return invalid('session title must not be blank')
    const session = this.sessions.binding(sessionId)?.session
    if (session === undefined) return missing(sessionId)
    try {
      const result = await session.rename(normalized)
      if (!result.ok) return rpcFailure(result.error)
      // DSH owns normalization and its UTF-8 byte limit. Return the host's
      // accepted value instead of pretending the raw client value persisted.
      return { ok: true, value: { title: result.value.title } }
    } catch (error: unknown) {
      return providerFailure('renameSession', error)
    }
  }

  async archiveSession(sessionId: string): Promise<RuntimeCommandResult<{ archived: true }>> {
    if (this.snapshot.sessions[sessionId] === undefined) return missing(sessionId)
    try {
      await this.workspaces.archiveSession(sessionId)
      return { ok: true, value: { archived: true } }
    } catch (error: unknown) {
      return providerFailure('archiveSession', error)
    }
  }

  async search(query: string, signal: AbortSignal): Promise<RuntimeCommandResult<{
    items: readonly { readonly sessionId: string; readonly snippet: string }[]
    hasMore: boolean
  }>> {
    if (query.trim() === '') return invalid('query must not be blank')
    try { return fold(await this.sessions.search(query, signal)) }
    catch (error: unknown) { return providerFailure('search', error) }
  }

  async moveSessionToWorkspace(sessionId: string, workspaceId: string): Promise<RuntimeCommandResult<{ sessionId: string }>> {
    if (this.snapshot.sessions[sessionId] === undefined) return missing(sessionId)
    if (workspaceId.trim() === '') return invalid('workspaceId must not be blank')
    try { return { ok: true, value: { sessionId: await this.workspaces.moveSessionToWorkspace(sessionId, workspaceId) } } }
    catch (error: unknown) { return ambiguous('moveSessionToWorkspace', error) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.unsubscribeList()
  }

  private projectSnapshot(): SessionCatalogSnapshot {
    const list = this.sessions.list.getSnapshot()
    const sessions: Record<string, SessionCatalogSnapshot['sessions'][string]> = {}
    for (const id of list.ids) {
      const row = list.byId[id]
      if (row === undefined) continue
      sessions[id] = {
        sessionId: id,
        updatedAt: row.updatedAt,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
        ...(row.parentId === undefined ? {} : { parentId: row.parentId }),
        ...(row.origin === undefined ? {} : { origin: row.origin }),
      }
    }
    return { ...(list.current === undefined ? {} : { currentSessionId: list.current }), sessions }
  }
}

/** Read-only context governance view over DSH's canonical token-meter projections. */
export class DshContextGovernance implements ContextGovernance {
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeList: () => void
  private snapshot: ContextGovernanceSnapshot
  private disposed = false

  constructor(private readonly sessions: SessionsPort) {
    this.snapshot = this.projectSnapshot()
    this.unsubscribeList = sessions.list.subscribe(() => {
      this.snapshot = this.projectSnapshot()
      for (const listener of this.listeners) listener()
    })
  }

  getSnapshot(): ContextGovernanceSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error('ContextGovernance provider is disposed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.unsubscribeList()
  }

  private projectSnapshot(): ContextGovernanceSnapshot {
    const list = this.sessions.list.getSnapshot()
    const sessions: Record<string, ContextGovernanceSnapshot['sessions'][string]> = {}
    for (const id of list.ids) {
      const projections = list.byId[id]?.projectionValues
      if (projections === undefined) continue
      sessions[id] = {
        sessionId: id,
        ...(projections.contextPressure === undefined ? {} : { pressure: projections.contextPressure }),
        ...(projections.contextBreakdown === undefined ? {} : { breakdown: projections.contextBreakdown }),
        ...(projections.tokenUsage === undefined ? {} : { usage: projections.tokenUsage }),
        budget: deriveContextBudget(projections.contextPressure),
        compactions: deriveCompactionCheckpoints(projections.taskTimeline),
      }
    }
    return { ...(list.current === undefined ? {} : { currentSessionId: list.current }), sessions }
  }
}

const TIMELINE_INITIAL_WINDOW = 160
const TIMELINE_PAGE_SIZE = 160

/** Minimal product timeline projected from DSH's public Session snapshot. */
export class DshTaskTimeline implements TaskTimeline {
  private readonly listeners = new Set<() => void>()
  private unsubscribeSession: (() => void) | undefined
  private readonly unsubscribeList: () => void
  private snapshot: TaskTimelineSnapshot = { items: [], total: 0, hasEarlier: false }
  private readonly visibleLimits = new Map<string, number>()
  private readonly lastTotals = new Map<string, number>()
  private disposed = false

  constructor(private readonly sessions: SessionsPort) {
    this.rebind()
    this.unsubscribeList = sessions.list.subscribe(() => { this.rebind(); this.publish() })
  }
  getSnapshot(): TaskTimelineSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  loadEarlier(): void {
    const sessionId = this.sessions.list.getSnapshot().current
    if (sessionId === undefined || !this.snapshot.hasEarlier) return
    this.visibleLimits.set(sessionId, Math.min(this.snapshot.total, this.snapshot.items.length + TIMELINE_PAGE_SIZE))
    this.publish()
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.unsubscribeSession?.(); this.unsubscribeList(); this.listeners.clear() }
  private rebind(): void {
    this.unsubscribeSession?.(); this.unsubscribeSession = undefined
    const current = this.sessions.list.getSnapshot().current
    const face = current === undefined ? undefined : this.sessions.binding(current)?.session
    if (face?.subscribe !== undefined) this.unsubscribeSession = face.subscribe(() => this.publish())
    const projected = current === undefined ? undefined : this.sessions.list.getSnapshot().byId[current]?.projectionValues?.taskTimeline
    this.snapshot = this.window(current, projectTimeline(current, projected, face?.getSnapshot?.()))
  }
  private publish(): void {
    const current = this.sessions.list.getSnapshot().current
    const projected = current === undefined ? undefined : this.sessions.list.getSnapshot().byId[current]?.projectionValues?.taskTimeline
    this.snapshot = this.window(current, projectTimeline(current, projected, current === undefined ? undefined : this.sessions.binding(current)?.session.getSnapshot?.()))
    for (const listener of this.listeners) listener()
  }
  private window(sessionId: string | undefined, full: TaskTimelineSnapshot): TaskTimelineSnapshot {
    if (sessionId === undefined) return { items: [], total: 0, hasEarlier: false }
    const previousTotal = this.lastTotals.get(sessionId)
    let limit = this.visibleLimits.get(sessionId) ?? TIMELINE_INITIAL_WINDOW
    // If new messages arrive while older history is open, grow the window by
    // the same delta so the oldest visible record does not disappear.
    if (previousTotal !== undefined && full.total > previousTotal) limit += full.total - previousTotal
    limit = Math.max(1, Math.min(limit, full.total || 1))
    this.visibleLimits.set(sessionId, limit)
    this.lastTotals.set(sessionId, full.total)
    const items = full.items.slice(Math.max(0, full.total - limit))
    return { sessionId, items, total: full.total, hasEarlier: items.length < full.total }
  }
}

/** Separate public interaction seam so Xiaoshe can answer approvals without mounting DSH product UI. */
export class DshUserApproval {
  private readonly listeners = new Set<() => void>()
  private unsubscribeSession: (() => void) | undefined
  private readonly unsubscribeList: () => void
  private snapshot: UserApprovalSnapshot = { approvals: [] }
  private disposed = false
  constructor(private readonly sessions: SessionsPort) {
    this.rebind()
    this.unsubscribeList = sessions.list.subscribe(() => { this.rebind(); this.publish() })
  }
  getSnapshot(): UserApprovalSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async answer(key: string, outcome: 'allowed-once' | 'rejected'): Promise<RuntimeCommandResult<{ accepted: true }>> {
    const current = this.sessions.list.getSnapshot().current
    const wait = current === undefined ? undefined : this.pending(current).find(item => item.kind === 'approval' && item.key === key)
    if (wait === undefined || !isRecord(wait.payload) || typeof wait.payload.approvalId !== 'string') return missing(key)
    try {
      const receipt = await wait.respond({ ok: true, value: { sessionId: wait.sessionId, approvalId: wait.payload.approvalId, outcome } })
      return receipt.accepted ? { ok: true, value: { accepted: true } } : { ok: false, error: { kind: 'conflict', message: `approval response rejected: ${receipt.reason ?? 'unknown'}` } }
    } catch (error: unknown) { return providerFailure('answerApproval', error) }
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.unsubscribeSession?.(); this.unsubscribeList(); this.listeners.clear() }
  private pending(sessionId: string): readonly PendingWaitPort[] { return this.sessions.binding(sessionId)?.session.getSnapshot?.().pending ?? [] }
  private rebind(): void {
    this.unsubscribeSession?.(); this.unsubscribeSession = undefined
    const current = this.sessions.list.getSnapshot().current
    const face = current === undefined ? undefined : this.sessions.binding(current)?.session
    if (face?.subscribe !== undefined) this.unsubscribeSession = face.subscribe(() => this.publish())
    this.snapshot = this.project(current)
  }
  private publish(): void { this.snapshot = this.project(this.sessions.list.getSnapshot().current); for (const listener of this.listeners) listener() }
  private project(sessionId: string | undefined): UserApprovalSnapshot {
    const approvals = sessionId === undefined ? [] : this.pending(sessionId).flatMap(item => {
      const payload = isRecord(item.payload) ? item.payload : undefined
      if (item.kind !== 'approval' || typeof payload?.toolName !== 'string') return []
      return [{ key: item.key, toolName: payload.toolName, ...(typeof payload.callId === 'string' ? { callId: payload.callId } : {}), ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}) }]
    })
    return { ...(sessionId === undefined ? {} : { sessionId }), approvals }
  }
}

const QUESTION_LIMITS = {
  requests: 8,
  questions: 12,
  options: 16,
  id: 256,
  question: 4_000,
  header: 256,
  detail: 16_000,
  label: 512,
  description: 2_000,
  custom: 4_000,
} as const

const MALFORMED_QUESTION_MESSAGE = '问题请求格式异常，可取消后让小蛇重试。'

/** Public question seam: keeps DSH wire envelopes behind a bounded product contract. */
export class DshUserQuestions implements UserQuestionInteraction {
  private readonly listeners = new Set<() => void>()
  private unsubscribeSession: (() => void) | undefined
  private readonly unsubscribeList: () => void
  private snapshot: UserQuestionInteractionSnapshot = { requests: [] }
  private disposed = false

  constructor(private readonly sessions: SessionsPort) {
    this.rebind()
    this.unsubscribeList = sessions.list.subscribe(() => { this.rebind(); this.publish() })
  }

  getSnapshot(): UserQuestionInteractionSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error('UserQuestionInteraction provider is disposed')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async answer(key: string, answer: UserQuestionAnswer): Promise<RuntimeCommandResult<{ accepted: true }>> {
    const sessionId = this.sessions.list.getSnapshot().current
    const wait = sessionId === undefined ? undefined : this.pending(sessionId).find(item => item.kind === 'question' && item.key === key)
    if (wait === undefined) return missing(key)
    const request = projectQuestionWait(wait)
    if (request.error !== undefined) return invalid(request.error)
    const validated = validateQuestionAnswer(request.questions, answer)
    if (!validated.ok) return validated
    try {
      const receipt = await wait.respond({ ok: true, value: { sessionId: wait.sessionId, answer: validated.value } })
      return receipt.accepted
        ? { ok: true, value: { accepted: true } }
        : conflict(`question response rejected: ${receipt.reason ?? 'unknown'}`)
    } catch (error: unknown) {
      return providerFailure('answerQuestion', error)
    }
  }

  async cancel(key: string): Promise<RuntimeCommandResult<{ cancelled: true }>> {
    const sessionId = this.sessions.list.getSnapshot().current
    const wait = sessionId === undefined ? undefined : this.pending(sessionId).find(item => item.kind === 'question' && item.key === key)
    if (wait === undefined) return missing(key)
    try {
      const receipt = await wait.respond({
        ok: false,
        error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
      })
      return receipt.accepted
        ? { ok: true, value: { cancelled: true } }
        : conflict(`question cancellation rejected: ${receipt.reason ?? 'unknown'}`)
    } catch (error: unknown) {
      return providerFailure('cancelQuestion', error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeSession?.()
    this.unsubscribeList()
    this.listeners.clear()
  }

  private pending(sessionId: string): readonly PendingWaitPort[] {
    return this.sessions.binding(sessionId)?.session.getSnapshot?.().pending ?? []
  }

  private rebind(): void {
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    const current = this.sessions.list.getSnapshot().current
    const face = current === undefined ? undefined : this.sessions.binding(current)?.session
    if (face?.subscribe !== undefined) this.unsubscribeSession = face.subscribe(() => this.publish())
    this.snapshot = this.project(current)
  }

  private publish(): void {
    this.snapshot = this.project(this.sessions.list.getSnapshot().current)
    for (const listener of this.listeners) listener()
  }

  private project(sessionId: string | undefined): UserQuestionInteractionSnapshot {
    const requests = sessionId === undefined
      ? []
      : this.pending(sessionId)
        .filter(item => item.kind === 'question')
        .slice(0, QUESTION_LIMITS.requests)
        .map(projectQuestionWait)
    return { ...(sessionId === undefined ? {} : { sessionId }), requests }
  }
}

function projectQuestionWait(wait: PendingWaitPort): UserQuestionRequest {
  const invalidRequest = (): UserQuestionRequest => ({
    key: wait.key,
    sessionId: wait.sessionId,
    questions: [],
    error: MALFORMED_QUESTION_MESSAGE,
  })
  if (!isRecord(wait.payload) || !Array.isArray(wait.payload.questions)) return invalidRequest()
  if (wait.payload.questions.length === 0 || wait.payload.questions.length > QUESTION_LIMITS.questions) return invalidRequest()
  const questions: UserQuestionItem[] = []
  const ids = new Set<string>()
  for (const raw of wait.payload.questions) {
    const question = projectQuestionItem(raw)
    if (question === undefined || ids.has(question.id)) return invalidRequest()
    ids.add(question.id)
    questions.push(question)
  }
  return { key: wait.key, sessionId: wait.sessionId, questions }
}

function projectQuestionItem(value: unknown): UserQuestionItem | undefined {
  if (!isRecord(value)) return undefined
  const id = wireText(value.id, QUESTION_LIMITS.id, false)
  const question = wireText(value.question, QUESTION_LIMITS.question, false)
  if (id === undefined || question === undefined) return undefined
  const header = value.header === undefined ? undefined : wireText(value.header, QUESTION_LIMITS.header, true)
  const detail = value.detail === undefined ? undefined : wireText(value.detail, QUESTION_LIMITS.detail, true)
  if (value.header !== undefined && header === undefined || value.detail !== undefined && detail === undefined) return undefined
  let options: UserQuestionItem['options']
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || value.options.length > QUESTION_LIMITS.options) return undefined
    const labels = new Set<string>()
    const projected = value.options.map(option => {
      if (!isRecord(option)) return undefined
      const label = wireText(option.label, QUESTION_LIMITS.label, false)
      const description = option.description === undefined ? undefined : wireText(option.description, QUESTION_LIMITS.description, true)
      if (label === undefined || labels.has(label) || option.description !== undefined && description === undefined) return undefined
      labels.add(label)
      return { label, ...(description === undefined ? {} : { description }) }
    })
    if (projected.some(option => option === undefined)) return undefined
    options = projected as readonly { readonly label: string; readonly description?: string }[]
  }
  let intent: UserQuestionItem['intent']
  if (value.intent !== undefined) {
    if (!isRecord(value.intent) || value.intent.kind !== 'plan-review') return undefined
    const approve = wireText(value.intent.approve, QUESTION_LIMITS.label, false)
    if (approve === undefined) return undefined
    intent = { kind: 'plan-review', approve }
  }
  if (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') return undefined
  return {
    id,
    question,
    ...(header === undefined ? {} : { header }),
    ...(detail === undefined ? {} : { detail }),
    ...(options === undefined ? {} : { options }),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
    ...(intent === undefined ? {} : { intent }),
  }
}

function validateQuestionAnswer(
  questions: readonly UserQuestionItem[],
  value: UserQuestionAnswer,
): RuntimeCommandResult<UserQuestionAnswer> {
  if (!isRecord(value) || !Array.isArray(value.answers) || value.answers.length !== questions.length) {
    return invalid('question answer must cover every question exactly once')
  }
  const byId = new Map(questions.map(question => [question.id, question]))
  const seen = new Set<string>()
  const answers: { id: string; selected: string[]; custom?: string }[] = []
  for (const raw of value.answers) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || seen.has(raw.id) || !Array.isArray(raw.selected)) {
      return invalid('question answer contains an invalid or duplicate id')
    }
    const question = byId.get(raw.id)
    if (question === undefined || raw.selected.some(item => typeof item !== 'string')) return invalid('question answer contains an unknown selection')
    const selected = raw.selected as string[]
    if (new Set(selected).size !== selected.length) return invalid('question answer contains duplicate selections')
    const offered = new Set(question.options?.map(option => option.label) ?? [])
    if (selected.some(label => !offered.has(label))) return invalid('question answer contains an unknown selection')
    if (question.multiSelect !== true && selected.length > 1) return invalid('single-choice question accepts at most one selection')
    const custom = raw.custom === undefined ? undefined : wireText(raw.custom, QUESTION_LIMITS.custom, false)
    if (raw.custom !== undefined && custom === undefined) return invalid('custom question answer is invalid or too long')
    if (question.multiSelect !== true && custom !== undefined && selected.length > 0) return invalid('single-choice custom answer cannot include an option selection')
    seen.add(raw.id)
    answers.push({ id: raw.id, selected: [...selected], ...(custom === undefined ? {} : { custom }) })
  }
  return seen.size === questions.length
    ? { ok: true, value: { answers } }
    : invalid('question answer must cover every question exactly once')
}

function wireText(value: unknown, maximum: number, allowEmpty: boolean): string | undefined {
  if (typeof value !== 'string' || value.length > maximum || !allowEmpty && value.trim() === '') return undefined
  return value
}

/** Public, projection-backed permission presets without mounting DSH product chrome. */
export class DshPermissionPresets {
  private readonly listeners = new Set<() => void>()
  private unsubscribeProjection: (() => void) | undefined
  private readonly unsubscribeList: () => void
  private snapshot: PermissionPresetSnapshot = { status: 'unavailable', options: [] }
  private disposed = false

  constructor(private readonly sessions: SessionsPort) {
    this.rebind()
    this.unsubscribeList = sessions.list.subscribe(() => { this.rebind(); this.publishProjection() })
  }

  getSnapshot(): PermissionPresetSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error('PermissionPresets provider is disposed')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async select(value: string): Promise<RuntimeCommandResult<{ selected: string }>> {
    const sessionId = this.sessions.list.getSnapshot().current
    if (sessionId === undefined) return invalid('permission selection requires a current session')
    const face = this.sessions.binding(sessionId)?.session
    if (face?.command === undefined) return unsupported('the current DSH session exposes no permission command')
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value) || value === 'custom') {
      return invalid('permission preset is not switchable')
    }
    if (!this.snapshot.options.some(option => option.value === value)) return invalid(`unknown permission preset: ${value}`)

    this.publish({ ...this.snapshot, status: 'switching' })
    try {
      const result = await face.command(`/permission ${value}`)
      if (!result.ok) {
        const failure = rpcFailure(result.error)
        this.publish({ ...this.snapshot, status: 'error', error: result.error.message })
        return failure
      }
      if (!result.value.matched) {
        const message = 'the current DSH host offers no /permission command'
        this.publish({ ...this.snapshot, status: 'error', error: message })
        return unsupported(message)
      }
      // A matched command is durably admitted by the Host. Mirror it now so
      // the control does not flicker while the authoritative projection push arrives.
      this.publish({ ...this.snapshot, status: 'ready', currentValue: value })
      return { ok: true, value: { selected: value } }
    } catch (error: unknown) {
      const message = errorMessage(error)
      this.publish({ ...this.snapshot, status: 'error', error: message })
      return providerFailure('selectPermissionPreset', error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeProjection?.()
    this.unsubscribeList()
    this.listeners.clear()
  }

  private projection(sessionId: string | undefined): ObservableSnapshotPort | undefined {
    if (sessionId === undefined) return undefined
    return this.sessions.binding(sessionId)?.session.projections?.faceOf('permissions')
  }

  private rebind(): void {
    this.unsubscribeProjection?.()
    this.unsubscribeProjection = undefined
    const projection = this.projection(this.sessions.list.getSnapshot().current)
    if (projection?.subscribe !== undefined) this.unsubscribeProjection = projection.subscribe(() => this.publishProjection())
    this.snapshot = this.project()
  }

  private publishProjection(): void { this.publish(this.project()) }
  private publish(next: PermissionPresetSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  private project(): PermissionPresetSnapshot {
    const sessionId = this.sessions.list.getSnapshot().current
    const source = this.projection(sessionId)?.getSnapshot()
    if (!isRecord(source) || typeof source.currentValue !== 'string' || !Array.isArray(source.options)) {
      return { ...(sessionId === undefined ? {} : { sessionId }), status: 'unavailable', options: [] }
    }
    const options = source.options.flatMap((entry): PermissionPresetSnapshot['options'][number][] => {
      if (!isRecord(entry) || typeof entry.value !== 'string' || typeof entry.name !== 'string') return []
      return [{ value: entry.value, name: entry.name, ...(typeof entry.description === 'string' ? { description: entry.description } : {}) }]
    })
    return { ...(sessionId === undefined ? {} : { sessionId }), status: 'ready', currentValue: source.currentValue, options }
  }
}

/** Host-backed current-session model directory without mounting DSH's model UI. */
export class DshModelCatalog implements ModelCatalog {
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeList: () => void
  private snapshot: ModelCatalogSnapshot = { status: 'idle', groups: [], failures: [] }
  private generation = 0
  private disposed = false

  constructor(private readonly sessions: SessionsPort, private readonly connection: ConnectionPort) {
    this.unsubscribeList = sessions.list.subscribe(() => { this.reconcileSession() })
    this.reconcileSession()
  }

  getSnapshot(): ModelCatalogSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error('ModelCatalog provider is disposed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async refresh(sessionId = this.sessions.list.getSnapshot().current): Promise<RuntimeCommandResult<ModelCatalogSnapshot>> {
    if (sessionId === undefined) return invalid('model refresh requires a current session')
    if (this.sessions.binding(sessionId) === undefined) return missing(sessionId)
    const generation = ++this.generation
    this.publish({
      ...clearModelError(this.snapshot.sessionId === sessionId ? this.snapshot : { status: 'idle', groups: [], failures: [] }),
      sessionId,
      status: 'loading',
    })
    try {
      const response = await this.connection.api.sessions.models({ sessionId })
      if (this.disposed || generation !== this.generation) return conflict('model refresh was superseded')
      if (!response.result.ok) {
        this.publish({ ...this.snapshot, status: 'error', error: response.result.error.message })
        return rpcFailure(response.result.error)
      }
      const next = projectModelSnapshot(sessionId, response.result.value)
      this.publish(next)
      return { ok: true, value: next }
    } catch (error: unknown) {
      if (!this.disposed && generation === this.generation) {
        this.publish({ ...this.snapshot, status: 'error', error: errorMessage(error) })
      }
      return providerFailure('refreshModels', error)
    }
  }

  async select(input: ModelSelection & { readonly sessionId?: string }): Promise<RuntimeCommandResult<{ selected: ModelSelection }>> {
    const sessionId = input.sessionId ?? this.sessions.list.getSnapshot().current
    if (sessionId === undefined) return invalid('model selection requires a current session')
    if (this.sessions.binding(sessionId) === undefined) return missing(sessionId)
    if (input.provider.trim() === '' || input.model.trim() === '') return invalid('provider and model must not be blank')
    const generation = ++this.generation
    this.publish({
      ...clearModelError(this.snapshot.sessionId === sessionId ? this.snapshot : { status: 'idle', groups: [], failures: [] }),
      sessionId,
      status: 'selecting',
    })
    try {
      const response = await this.connection.api.sessions.selectModel({
        sessionId,
        provider: input.provider,
        model: input.model,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      })
      if (this.disposed || generation !== this.generation) return conflict('model selection was superseded')
      if (!response.result.ok) {
        this.publish({ ...this.snapshot, status: 'error', error: response.result.error.message })
        return rpcFailure(response.result.error)
      }
      const selected = projectSelection(response.result.value.selected)
      this.publish({ ...clearModelError(this.snapshot), sessionId, current: selected, routable: true, status: 'ready' })
      return { ok: true, value: { selected } }
    } catch (error: unknown) {
      if (!this.disposed && generation === this.generation) {
        this.publish({ ...this.snapshot, status: 'error', error: errorMessage(error) })
      }
      return providerFailure('selectModel', error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.generation
    this.unsubscribeList()
    this.listeners.clear()
  }

  private reconcileSession(): void {
    const sessionId = this.sessions.list.getSnapshot().current
    if (sessionId === this.snapshot.sessionId) return
    ++this.generation
    this.publish({ ...(sessionId === undefined ? {} : { sessionId }), status: 'idle', groups: [], failures: [] })
    if (sessionId !== undefined) void this.refresh(sessionId)
  }

  private publish(next: ModelCatalogSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/** Real Workspace registry, native picker, and scoped-session entry for the replacement shell. */
export class DshWorkspaceCatalog implements WorkspaceCatalog {
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeList: () => void
  private snapshot: WorkspaceCatalogSnapshot
  private disposed = false

  constructor(private readonly sessions: SessionsPort, private readonly workspaces: WorkspacesPort) {
    this.snapshot = this.projectSnapshot()
    this.unsubscribeList = workspaces.list.subscribe(() => {
      this.snapshot = this.projectSnapshot()
      for (const listener of this.listeners) listener()
    })
  }

  getSnapshot(): WorkspaceCatalogSnapshot { return this.snapshot }
  subscribe(listener: () => void): () => void {
    if (this.disposed) throw new Error('WorkspaceCatalog provider is disposed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async addFromNativePicker(): Promise<RuntimeCommandResult<{ cancelled: boolean; workspace?: WorkspaceCatalogEntry }>> {
    try {
      const path = await this.workspaces.pickDirectory()
      if (path === null) return { ok: true, value: { cancelled: true } }
      const workspace = projectWorkspace(await this.workspaces.create({ path }))
      return { ok: true, value: { cancelled: false, workspace } }
    } catch (error: unknown) {
      return providerFailure('addWorkspaceFromNativePicker', error)
    }
  }

  async createAndOpenSession(workspaceId: string): Promise<RuntimeCommandResult<{ sessionId: string }>> {
    if (workspaceId.trim() === '') return invalid('workspaceId must not be blank')
    if (!this.snapshot.items.some(item => item.workspaceId === workspaceId)) return missing(workspaceId)
    try {
      const sessionId = await this.workspaces.connectWorkspace(workspaceId)
      this.sessions.open(sessionId)
      return { ok: true, value: { sessionId } }
    } catch (error: unknown) {
      return ambiguous('createAndOpenWorkspaceSession', error)
    }
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<RuntimeCommandResult<{ workspace: WorkspaceCatalogEntry }>> {
    const normalized = title.trim()
    if (workspaceId.trim() === '') return invalid('workspaceId must not be blank')
    if (normalized === '') return invalid('workspace title must not be blank')
    if (!this.snapshot.items.some(item => item.workspaceId === workspaceId)) return missing(workspaceId)
    try {
      return { ok: true, value: { workspace: projectWorkspace(await this.workspaces.rename(workspaceId, normalized)) } }
    } catch (error: unknown) {
      return providerFailure('renameWorkspace', error)
    }
  }

  async removeWorkspace(workspaceId: string): Promise<RuntimeCommandResult<{ removed: true }>> {
    if (workspaceId.trim() === '') return invalid('workspaceId must not be blank')
    if (!this.snapshot.items.some(item => item.workspaceId === workspaceId)) return missing(workspaceId)
    try {
      // DSH removes only the registry row. The directory, user files, and
      // session logs remain untouched and the sessions become ungrouped.
      await this.workspaces.delete(workspaceId)
      return { ok: true, value: { removed: true } }
    } catch (error: unknown) {
      return providerFailure('removeWorkspace', error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeList()
    this.listeners.clear()
  }

  private projectSnapshot(): WorkspaceCatalogSnapshot {
    const source = this.workspaces.list.getSnapshot()
    const state: WorkspaceCatalogSnapshot['state'] = source.state === 'loading'
      ? 'loading'
      : source.state === 'error'
        ? 'error'
        : source.baselinesReady ? 'ready' : 'idle'
    return {
      state,
      items: source.items.map(projectWorkspace),
      archivedSessionIds: [...source.archivedSessionIds],
      ...(source.error === null ? {} : { error: source.error.message ?? source.error.code ?? 'workspace registry failed' }),
    }
  }
}

/**
 * Product projection over the public DSH run surfaces. The provider never
 * owns job, queue, goal, skill, or subagent state; it only narrows those
 * authoritative faces into the stable Xiaoshe contract.
 */
export class DshRunCenter implements RunCenter {
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeList: () => void
  private readonly unsubscribeSurfaces: () => void
  private unsubscribeSession: (() => void) | undefined
  private boundSessionId: string | undefined
  private skills: readonly SkillEntryPort[] = Object.freeze([])
  private lifecycle: RunCenterSnapshot['status'] = 'idle'
  private failure: string | undefined
  private snapshot: RunCenterSnapshot
  private generation = 0
  private disposed = false

  constructor(
    private readonly sessions: SessionsPort,
    private readonly connection: ConnectionPort,
    private readonly surfaces: Pick<WorkSurfaceRegistry, 'getSnapshot' | 'subscribe'>,
  ) {
    this.boundSessionId = sessions.list.getSnapshot().current
    this.snapshot = this.projectSnapshot()
    this.unsubscribeList = sessions.list.subscribe(() => {
      const nextSessionId = sessions.list.getSnapshot().current
      if (nextSessionId !== this.boundSessionId) {
        this.generation += 1
        this.skills = Object.freeze([])
        this.failure = undefined
        this.lifecycle = nextSessionId === undefined ? 'idle' : 'ready'
        this.bindSession(nextSessionId)
      }
      this.publishProjection()
    })
    this.unsubscribeSurfaces = surfaces.subscribe(() => { this.publishProjection() })
    this.bindSession(this.boundSessionId)
  }

  getSnapshot(): RunCenterSnapshot { return this.snapshot }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async refresh(): Promise<RuntimeCommandResult<RunCenterSnapshot>> {
    if (this.disposed) return conflict('run center is disposed')
    const sessionId = this.sessions.list.getSnapshot().current
    if (sessionId === undefined) {
      this.skills = Object.freeze([])
      this.lifecycle = 'idle'
      this.failure = undefined
      this.publishProjection()
      return { ok: true, value: this.snapshot }
    }
    const generation = ++this.generation
    this.lifecycle = 'loading'
    this.failure = undefined
    this.publishProjection()
    const controller = new AbortController()
    try {
      await this.sessions.refreshSubagents?.(sessionId)
      const response = this.connection.api.skills === undefined
        ? { result: { ok: true as const, value: { skills: Object.freeze([]) } } }
        : await this.connection.api.skills.list({ sessionId }, controller.signal)
      if (!response.result.ok) return this.failRefresh(generation, sessionId, response.result.error)
      if (this.disposed || generation !== this.generation || this.sessions.list.getSnapshot().current !== sessionId) {
        return conflict('run center refresh became stale')
      }
      this.skills = Object.freeze(response.result.value.skills.map(skill => Object.freeze({ ...skill })))
      this.lifecycle = 'ready'
      this.failure = undefined
      this.publishProjection()
      return { ok: true, value: this.snapshot }
    } catch (error: unknown) {
      return this.failRefresh(generation, sessionId, { code: 'run-center-refresh', message: errorMessage(error) })
    } finally {
      controller.abort()
    }
  }

  async updateQueue(input: {
    readonly sessionId: string
    readonly itemId: string
    readonly action: RunCenterQueueAction
  }): Promise<RuntimeCommandResult<{ accepted: true }>> {
    if (input.sessionId.trim() === '' || input.itemId.trim() === '') return invalid('sessionId and itemId must not be blank')
    const item = this.snapshot.sessionId === input.sessionId
      ? this.snapshot.queue.find(candidate => candidate.id === input.itemId)
      : undefined
    if (item === undefined) return conflict('queue item is no longer present')
    if (item.placement !== 'queued') return conflict('only queued messages can be changed')
    const session = this.sessions.binding(input.sessionId)?.session
    if (session?.updateQueue === undefined) return unsupported('queue mutation is unavailable')
    let action: QueueActionPort
    if (input.action.kind === 'edit') {
      const text = input.action.text.trim()
      if (text === '' || Array.from(text).length > 32_000) return invalid('queue edit text is invalid')
      action = { kind: 'edit', content: [{ type: 'text', text }] }
    } else {
      action = input.action
    }
    try {
      return fold(await session.updateQueue(input.itemId, action))
    } catch (error: unknown) {
      return ambiguous('updateQueue', error)
    }
  }

  openSubagent(input: { readonly parentSessionId: string; readonly childSessionId: string }): RuntimeCommandResult<{ opened: true }> {
    const child = this.snapshot.sessionId === input.parentSessionId
      ? this.snapshot.subagents.find(candidate => candidate.kind === 'child' && candidate.id === input.childSessionId)
      : undefined
    if (child === undefined || child.kind !== 'child') return conflict('subagent is no longer available')
    if (this.sessions.selectSubagent === undefined) return unsupported('subagent navigation is unavailable')
    this.sessions.selectSubagent({ parentSessionId: input.parentSessionId, childSessionId: input.childSessionId, mode: child.mode })
    return { ok: true, value: { opened: true } }
  }

  async interruptSubagent(input: { readonly parentSessionId: string; readonly childSessionId: string }): Promise<RuntimeCommandResult<{ accepted: true }>> {
    const child = this.snapshot.sessionId === input.parentSessionId
      ? this.snapshot.subagents.find(candidate => candidate.kind === 'child' && candidate.id === input.childSessionId)
      : undefined
    if (child === undefined || child.kind !== 'child' || child.mode !== 'continuable' || !child.canInterrupt) {
      return conflict('subagent cannot be interrupted in its current state')
    }
    if (this.connection.api.subagents === undefined) return unsupported('subagent interruption is unavailable')
    try {
      const { result } = await this.connection.api.subagents.interrupt({
        parentSessionId: input.parentSessionId,
        childSessionId: input.childSessionId,
        mode: 'continuable',
      })
      return fold(result)
    } catch (error: unknown) {
      return ambiguous('interruptSubagent', error)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.unsubscribeList()
    this.unsubscribeSurfaces()
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    this.listeners.clear()
  }

  private bindSession(sessionId: string | undefined): void {
    this.unsubscribeSession?.()
    this.unsubscribeSession = undefined
    this.boundSessionId = sessionId
    if (sessionId === undefined) return
    const session = this.sessions.binding(sessionId)?.session
    if (session?.subscribe !== undefined) this.unsubscribeSession = session.subscribe(() => { this.publishProjection() })
  }

  private failRefresh(generation: number, sessionId: string, error: RpcErrorLike): RuntimeCommandResult<never> {
    if (!this.disposed && generation === this.generation && this.sessions.list.getSnapshot().current === sessionId) {
      this.lifecycle = 'error'
      this.failure = error.message.slice(0, 1_000)
      this.publishProjection()
    }
    return rpcFailure(error)
  }

  private publishProjection(): void {
    if (this.disposed) return
    this.snapshot = this.projectSnapshot()
    for (const listener of this.listeners) listener()
  }

  private projectSnapshot(): RunCenterSnapshot {
    const list = this.sessions.list.getSnapshot()
    const sessionId = list.current
    if (sessionId === undefined) {
      return parseRunCenterSnapshot({
        status: 'idle', jobs: [], subagents: [], queue: [], todos: [], skills: [], deliverables: [],
      })
    }
    const summary = list.byId[sessionId]
    const projections = summary?.projectionValues ?? {}
    const sessionSnapshot = this.sessions.binding(sessionId)?.session.getSnapshot?.()
    const catalog = list.subagentsByParent?.[sessionId]
    const surfaceSnapshot = this.surfaces.getSnapshot()
    const goal = projectRunCenterGoal(projections.goal)
    const plan = isRecord(projections.plan) ? projections.plan : undefined
    return parseRunCenterSnapshot({
      sessionId,
      status: this.lifecycle === 'idle' ? 'ready' : this.lifecycle,
      jobs: list.jobsBySession?.[sessionId] ?? [],
      subagents: (catalog?.entries ?? []).map(entry => entry.kind === 'child'
        ? { ...entry, parentAvailable: catalog?.parentAvailable === true }
        : entry),
      queue: sessionSnapshot?.queue ?? [],
      ...(goal === undefined ? {} : { goal }),
      ...(plan === undefined ? {} : { plan }),
      todos: projectRunCenterTodos(projections.todos),
      skills: this.skills,
      deliverables: surfaceSnapshot.sessionId === sessionId
        ? surfaceSnapshot.items.map(surface => ({
          id: surface.id,
          title: surface.title,
          kind: surface.type,
          status: surface.status,
          ...(surface.source === undefined ? {} : { source: surface.source }),
        }))
        : [],
      ...(this.failure === undefined ? {} : { error: this.failure }),
    })
  }
}

function projectRunCenterGoal(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.goal)) return undefined
  const goal = value.goal
  const blockedReason = isRecord(goal.blockedReason) && typeof goal.blockedReason.message === 'string'
    ? goal.blockedReason.message
    : undefined
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    roundsStarted: value.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds,
    ...(blockedReason === undefined ? {} : { blockedReason }),
  }
}

function projectRunCenterTodos(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return []
  return value.map((todo, index) => isRecord(todo)
    ? { id: `todo-${String(index + 1)}`, text: todo.content, status: todo.status }
    : todo)
}

export function apply(ctx: ClientContextLike): void {
  ctx.inject(inject, (scope) => {
    const runtime = new DshAgentRuntimeSession(scope.sessions, scope.workspaces)
    const catalog = new DshSessionCatalog(scope.sessions, scope.workspaces)
    const context = new DshContextGovernance(scope.sessions)
    const timeline = new DshTaskTimeline(scope.sessions)
    const approvals = new DshUserApproval(scope.sessions)
    const questions = new DshUserQuestions(scope.sessions)
    const permissions = new DshPermissionPresets(scope.sessions)
    const commands = new DshSessionCommand(scope.sessions)
    const models = new DshModelCatalog(scope.sessions, scope.connection)
    const workspaces = new DshWorkspaceCatalog(scope.sessions, scope.workspaces)
    const surfaces: WorkSurfaceRegistry & { dispose(): void } = new DshWorkSurfaceRegistry(scope.sessions)
    const runCenter = new DshRunCenter(scope.sessions, scope.connection, surfaces)
    scope.provide('agentRuntimeSession', runtime)
    scope.provide('sessionCatalog', catalog)
    scope.provide('contextGovernance', context)
    scope.provide('taskTimeline', timeline)
    scope.provide('userApproval', approvals)
    scope.provide('userQuestionInteraction', questions)
    scope.provide('permissionPresets', permissions)
    scope.provide('sessionCommand', commands)
    scope.provide('modelCatalog', models)
    scope.provide('workspaceCatalog', workspaces)
    scope.provide('workSurfaceRegistry', surfaces)
    scope.provide('runCenter', runCenter)
    scope.effect(() => {
      void runCenter.refresh()
      return () => { runtime.dispose(); catalog.dispose(); context.dispose(); timeline.dispose(); approvals.dispose(); questions.dispose(); permissions.dispose(); models.dispose(); workspaces.dispose(); runCenter.dispose(); surfaces.dispose() }
    }, 'xiaoshe-runtime-dsh-provider: public session projections')
  })
}

function projectModelSnapshot(sessionId: string, source: SessionModelsPort): ModelCatalogSnapshot {
  return {
    sessionId,
    status: 'ready',
    current: projectSelection(source.current),
    routable: source.routable,
    groups: source.groups.map(group => ({
      id: group.id,
      name: group.name,
      models: group.models.map(model => ({
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        efforts: model.reasoning?.efforts.map(effort => ({
          id: effort.id,
          name: effort.name,
          ...(effort.description === undefined ? {} : { description: effort.description }),
        })) ?? [],
        ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
      })),
    })),
    failures: source.failures.map(failure => ({ ...failure })),
  }
}

function projectSelection(source: ModelSelectionPort): ModelSelection {
  return {
    provider: source.provider,
    model: source.model,
    ...(source.reasoningEffort === undefined ? {} : { reasoningEffort: source.reasoningEffort }),
  }
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Narrow the untyped DSH projection before it crosses the product contract. */
export function parseDshImageInputLimits(value: unknown): RuntimeImageInputLimits | undefined {
  if (!isRecord(value) || !Array.isArray(value.mediaTypes)) return undefined
  const positiveInteger = (candidate: unknown): candidate is number => Number.isSafeInteger(candidate) && Number(candidate) > 0
  if (!positiveInteger(value.maxImageBytes)
    || !positiveInteger(value.maxImagesPerMessage)
    || !positiveInteger(value.maxMessageImageBytes)
    || !positiveInteger(value.maxImagePixels)
    || !positiveInteger(value.maxImageDimension)) return undefined
  const mediaTypes = value.mediaTypes.filter((item): item is 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' => typeof item === 'string' && IMAGE_MEDIA_TYPES.has(item))
  if (mediaTypes.length === 0 || mediaTypes.length !== value.mediaTypes.length) return undefined
  return {
    maxImageBytes: value.maxImageBytes,
    maxImagesPerMessage: value.maxImagesPerMessage,
    maxMessageImageBytes: value.maxMessageImageBytes,
    maxImagePixels: value.maxImagePixels,
    maxImageDimension: value.maxImageDimension,
    mediaTypes,
  }
}

function clearModelError(source: ModelCatalogSnapshot): ModelCatalogSnapshot {
  const { error: _error, ...rest } = source
  return rest
}

function projectWorkspace(source: WorkspaceViewPort): WorkspaceCatalogEntry {
  return {
    workspaceId: source.workspaceId,
    path: source.path,
    title: source.title,
    sessionIds: [...source.sessionIds],
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}

function projectTimeline(sessionId: string | undefined, projected: unknown, snapshot: { readonly nodes?: readonly unknown[]; readonly partial?: { readonly text?: string } | null } | undefined): TaskTimelineSnapshot {
  const canonical = isRecord(projected) && Array.isArray(projected.items) ? projected.items : undefined
  if (canonical !== undefined) {
    const items = canonical.flatMap((value, index): TaskTimelineItem[] => {
      if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.text !== 'string') return []
      const kind = value.kind === 'user' || value.kind === 'assistant' || value.kind === 'tool' || value.kind === 'error' || value.kind === 'compaction' ? value.kind : 'status'
      return [{
        key: typeof value.key === 'string' ? value.key : `${kind}:${index}`,
        seq: typeof value.seq === 'number' ? value.seq : index,
        ...(typeof value.time === 'number' ? { time: value.time } : {}),
        kind, text: value.text,
        ...(typeof value.reasoning === 'string' && value.reasoning !== '' ? { reasoning: value.reasoning } : {}),
        ...(typeof value.errorCode === 'string' && value.errorCode !== '' ? { errorCode: value.errorCode } : {}),
        ...(value.isError === true ? { isError: true } : {}),
      }]
    })
    return { ...(sessionId === undefined ? {} : { sessionId }), items, total: items.length, hasEarlier: false }
  }
  const items: TaskTimelineItem[] = []
  for (const [index, value] of (snapshot?.nodes ?? []).entries()) {
    if (!isRecord(value)) continue
    const seq = typeof value.seq === 'number' ? value.seq : index
    const kind = typeof value.kind === 'string' ? value.kind : 'status'
    const assistant = kind === 'assistant' ? legacyAssistantContent(value) : undefined
    const text = assistant?.text ?? timelineText(value)
    items.push({
      key: `${kind}:${seq}:${index}`, seq,
      kind: kind === 'user' ? 'user' : kind === 'assistant' ? 'assistant' : kind.includes('tool') ? 'tool' : kind.includes('error') ? 'error' : kind === 'compaction' ? 'compaction' : 'status',
      text,
      ...(assistant?.reasoning === undefined || assistant.reasoning === '' ? {} : { reasoning: assistant.reasoning }),
      ...(value.isError === true ? { isError: true } : {}),
    })
  }
  if (snapshot?.partial?.text !== undefined && snapshot.partial.text !== '') items.push({ key: 'partial', seq: Number.MAX_SAFE_INTEGER, kind: 'assistant', text: snapshot.partial.text })
  return { ...(sessionId === undefined ? {} : { sessionId }), items, total: items.length, hasEarlier: false }
}

/**
 * Older public conversation snapshots expose typed UI blocks rather than the
 * canonical Xiaoshe projection. Keep that explicit type boundary: only text
 * blocks become the visible answer and reasoning blocks stay in the optional
 * disclosure. Guessing from words would leak private rationale and break
 * localized content.
 */
function legacyAssistantContent(value: Readonly<Record<string, unknown>>): { readonly text: string; readonly reasoning: string } | undefined {
  if (!Array.isArray(value.blocks)) return undefined
  const text: string[] = []
  const reasoning: string[] = []
  for (const block of value.blocks) {
    if (!isRecord(block) || typeof block.text !== 'string') continue
    const kind = typeof block.kind === 'string' ? block.kind : block.type
    if (kind === 'text') text.push(block.text)
    else if (kind === 'reasoning') reasoning.push(block.text)
  }
  return { text: text.filter(Boolean).join('\n'), reasoning: reasoning.filter(Boolean).join('\n') }
}

function timelineText(value: Readonly<Record<string, unknown>>): string {
  if (typeof value.message === 'string') return value.message
  if (typeof value.summary === 'string') return value.summary
  if (Array.isArray(value.blocks)) return value.blocks.map(block => isRecord(block) && typeof block.text === 'string' ? block.text : isRecord(block) && typeof block.name === 'string' ? `调用 ${block.name}` : '').filter(Boolean).join('\n')
  if (Array.isArray(value.content)) return value.content.map(block => isRecord(block) && typeof block.text === 'string' ? block.text : '').filter(Boolean).join('\n')
  if (isRecord(value.call) && typeof value.call.name === 'string') return `${value.isError === true ? '失败' : '完成'}：${value.call.name}`
  return typeof value.kind === 'string' ? value.kind : '状态更新'
}

function fold<T>(result: RpcResult<T>): RuntimeCommandResult<T> {
  if (result.ok) return result
  return rpcFailure(result.error)
}

function rpcFailure(error: RpcErrorLike): RuntimeCommandResult<never> {
  return {
    ok: false,
    error: {
      kind: errorKind(error.code),
      code: error.code,
      message: error.message,
      ...(isRecord(error.details) ? { details: error.details } : {}),
    },
  }
}

function errorKind(code: string): RuntimeCommandErrorKind {
  if (/unsupported|unavailable/.test(code)) return 'unsupported'
  if (/not[-_]?found|unknown/.test(code)) return 'not_found'
  if (/invalid|schema|blank/.test(code)) return 'invalid_request'
  if (/busy|conflict|stale/.test(code)) return 'conflict'
  if (/transport|connection|network/.test(code)) return 'transport'
  return 'provider'
}

function unsupported(message: string): RuntimeCommandResult<never> {
  return { ok: false, error: { kind: 'unsupported', message } }
}
function invalid(message: string): RuntimeCommandResult<never> {
  return { ok: false, error: { kind: 'invalid_request', message } }
}
function missing(sessionId: string): RuntimeCommandResult<never> {
  return { ok: false, error: { kind: 'not_found', message: `unknown session: ${sessionId}` } }
}
function conflict(message: string): RuntimeCommandResult<never> {
  return { ok: false, error: { kind: 'conflict', message } }
}
function ambiguous(operation: string, error: unknown): RuntimeCommandResult<never> {
  return {
    ok: false,
    error: {
      kind: 'needs_verification',
      message: `${operation} did not return a verifiable result`,
      details: { cause: error instanceof Error ? error.message : String(error) },
    },
  }
}
function providerFailure(operation: string, error: unknown): RuntimeCommandResult<never> {
  return { ok: false, error: { kind: 'provider', message: `${operation} failed`, details: { cause: error instanceof Error ? error.message : String(error) } } }
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
