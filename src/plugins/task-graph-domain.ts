import { randomUUID } from 'node:crypto'
import { ACTION_TOOL_NAMES } from '../tools.js'

export const GRAPH_EVENT = 'xiaoshe/task-graph'
export const GRAPH_CALL_EVENT = 'xiaoshe/task-graph-call'
export const GRAPH_RESULT_EVENT = 'xiaoshe/task-graph-result'
export const GRAPH_LIMITS = Object.freeze({ nodes: 64, acceptance: 8, evidence: 16, feedback: 8, text: 2000, history: 10000, snapshot: 400000 })
export type NodeStatus = 'pending' | 'running' | 'verifying' | 'completed' | 'blocked' | 'interrupted'
export interface Acceptance { readonly id: string; readonly text: string }
export interface Feedback { readonly text: string; readonly outcome: 'failed' | 'needs-work' | 'passed' | 'interrupted' }
export interface Evidence {
  readonly callId: string; readonly resultSeq: number; readonly toolName: string; readonly attempt: number
  readonly kind: 'execution' | 'reviewer-assessment'
  readonly acceptanceId?: string; readonly assertion?: string; readonly sourceExcerpt?: string
}
export interface GraphNode {
  readonly id: string; readonly title: string; readonly dependencies: readonly string[]; readonly acceptance: readonly Acceptance[]
  readonly status: NodeStatus; readonly attempt: number; readonly startSeq: number | null
  readonly evidence: readonly Evidence[]; readonly feedback: readonly Feedback[]
}
export interface GraphSnapshot {
  readonly version: 1; readonly id: string; readonly revision: number; readonly sessionId: string
  readonly taskGeneration: number; readonly goalId: string | null; readonly objective: string; readonly runtimeInstance: string
  readonly durability: 'pending' | 'durable'; readonly nodes: readonly GraphNode[]; readonly feedback: readonly Feedback[]
}
export interface TaskGraphView extends GraphSnapshot {
  readonly status: 'ready' | 'active' | 'waiting' | 'completed'
  readonly stale: boolean; readonly recoveryRequired: boolean
}
export interface GraphEvent { readonly type: string; readonly seq: number; readonly data: unknown; readonly ignorable?: true }
export interface GraphSession {
  readonly id?: string; readonly header: { readonly id: string }
  snapshotEvents(): readonly GraphEvent[]
  append(type: string, data: unknown, opts: { ignorable: true }): { readonly seq: number }
}
export interface GraphAgent { readonly id: string; readonly session: GraphSession }
interface GraphFact {
  readonly callId: string; readonly graphId: string; readonly nodeId: string; readonly attempt: number; readonly taskGeneration: number
  readonly runtimeInstance: string; readonly toolName: string; readonly admissionSeq: number; readonly observedSeq: number | null
  readonly resultSeq: number | null; readonly succeeded: boolean
}
export interface GraphState {
  readonly graph: GraphSnapshot | null; readonly failure: string | null; readonly generation: number | null; readonly facts: readonly GraphFact[]
  readonly goalIdentity: { readonly seen: boolean; readonly id: string | null }
  readonly sessionId: string | null
}
export interface GraphExecution { readonly name: string; readonly callId: string; readonly agent?: GraphAgent; readonly arguments?: unknown }
interface Dependencies {
  readonly instanceId?: string; readonly flush: (session: GraphSession) => Promise<boolean>
  readonly flushTimeoutMs?: number
  readonly generation: (agent: GraphAgent) => number; readonly goal: (agent: GraphAgent) => { readonly id: string; readonly phase: string } | null
  readonly warn?: (message: string) => void
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('task graph: expected object')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('task graph: unknown field')
}
function text(value: unknown, maximum: number = GRAPH_LIMITS.text): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error('task graph: invalid bounded text')
  return value.trim()
}
function id(value: unknown): string {
  const result = text(value, 128)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u.test(result)) throw new Error('task graph: invalid stable id')
  return result
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('task graph: invalid counter')
  return Number(value)
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('task graph: invalid bounded list')
  return value
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}
function feedback(value: unknown): Feedback {
  const row = object(value); keys(row, ['text', 'outcome'])
  if (!['failed', 'needs-work', 'passed', 'interrupted'].includes(String(row.outcome))) throw new Error('task graph: invalid feedback outcome')
  return { text: text(row.text), outcome: row.outcome as Feedback['outcome'] }
}
function evidence(value: unknown): Evidence {
  const row = object(value); keys(row, ['callId', 'resultSeq', 'toolName', 'attempt', 'kind', 'acceptanceId', 'assertion', 'sourceExcerpt'])
  if (!['execution', 'reviewer-assessment'].includes(String(row.kind))) throw new Error('task graph: invalid evidence kind')
  const result = { callId: text(row.callId, 256), resultSeq: integer(row.resultSeq), toolName: text(row.toolName, 256), attempt: integer(row.attempt), kind: row.kind as Evidence['kind'] }
  if (row.kind === 'execution') {
    if (row.acceptanceId !== undefined || row.assertion !== undefined || row.sourceExcerpt !== undefined) throw new Error('task graph: execution is not acceptance')
    return result
  }
  return { ...result, acceptanceId: id(row.acceptanceId), assertion: text(row.assertion), sourceExcerpt: text(row.sourceExcerpt, 1000) }
}

/** Parse a detached DAG with stable criterion identities; no caller-owned objects survive. */
export function parseNodes(input: unknown, snapshots = false): readonly GraphNode[] {
  const nodes = array(input, GRAPH_LIMITS.nodes).map(value => {
    const row = object(value)
    keys(row, snapshots ? ['id', 'title', 'dependencies', 'acceptance', 'status', 'attempt', 'startSeq', 'evidence', 'feedback'] : ['id', 'title', 'dependencies', 'acceptance'])
    const acceptance = array(row.acceptance, GRAPH_LIMITS.acceptance).map(value => {
      const item = object(value); keys(item, ['id', 'text']); return { id: id(item.id), text: text(item.text) }
    })
    if (!acceptance.length || new Set(acceptance.map(item => item.id)).size !== acceptance.length) throw new Error('task graph: duplicate or empty acceptance')
    const dependencies = array(row.dependencies, GRAPH_LIMITS.nodes).map(id)
    if (new Set(dependencies).size !== dependencies.length) throw new Error('task graph: duplicate dependency')
    const status = snapshots ? row.status : 'pending'
    if (!['pending', 'running', 'verifying', 'completed', 'blocked', 'interrupted'].includes(String(status))) throw new Error('task graph: invalid node status')
    return { id: id(row.id), title: text(row.title, 300), dependencies, acceptance, status: status as NodeStatus,
      attempt: snapshots ? integer(row.attempt) : 0, startSeq: snapshots && row.startSeq !== null ? integer(row.startSeq) : null,
      evidence: snapshots ? array(row.evidence, GRAPH_LIMITS.evidence).map(evidence) : [],
      feedback: snapshots ? array(row.feedback, GRAPH_LIMITS.feedback).map(feedback) : [] }
  })
  if (!nodes.length || new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error('task graph: duplicate or empty nodes')
  const byId = new Map(nodes.map(node => [node.id, node]))
  const visiting = new Set<string>(), visited = new Set<string>()
  function visit(node: GraphNode): void {
    if (visiting.has(node.id)) throw new Error('task graph: dependency cycle')
    if (visited.has(node.id)) return
    visiting.add(node.id)
    for (const ref of node.dependencies) { const dependency = byId.get(ref); if (!dependency) throw new Error('task graph: missing dependency'); visit(dependency) }
    visiting.delete(node.id); visited.add(node.id)
  }
  for (const node of nodes) visit(node)
  if (nodes.filter(node => ['running', 'verifying'].includes(node.status)).length > 1) throw new Error('task graph: only one active node allowed')
  for (const node of nodes) {
    if (snapshots && node.status !== 'pending' && (node.attempt < 1 || node.startSeq === null)) throw new Error('task graph: missing attempt identity')
    if (node.evidence.some(item => item.attempt !== node.attempt)) throw new Error('task graph: stale attempt evidence')
    if (node.status === 'completed' && !node.acceptance.every(item => node.evidence.some(ref => ref.kind === 'reviewer-assessment' && ref.acceptanceId === item.id))) throw new Error('task graph: incomplete acceptance')
    if (['running', 'verifying', 'completed'].includes(node.status) && !node.dependencies.every(ref => byId.get(ref)?.status === 'completed')) throw new Error('task graph: uncompleted prerequisite')
  }
  return freeze(nodes)
}

export function parseGraph(value: unknown): GraphSnapshot {
  if (JSON.stringify(value).length > GRAPH_LIMITS.snapshot) throw new Error('task graph: snapshot too large')
  const row = object(value)
  keys(row, ['version', 'id', 'revision', 'sessionId', 'taskGeneration', 'goalId', 'objective', 'runtimeInstance', 'durability', 'nodes', 'feedback'])
  if (row.version !== 1 || !['pending', 'durable'].includes(String(row.durability))) throw new Error('task graph: unsupported version or durability')
  const revision = integer(row.revision); if (revision < 1) throw new Error('task graph: revision starts at one')
  return freeze({ version: 1, id: id(row.id), revision, sessionId: text(row.sessionId, 256), taskGeneration: integer(row.taskGeneration),
    goalId: row.goalId === null ? null : text(row.goalId, 256), objective: text(row.objective), runtimeInstance: id(row.runtimeInstance),
    durability: row.durability as GraphSnapshot['durability'], nodes: parseNodes(row.nodes, true), feedback: array(row.feedback, GRAPH_LIMITS.feedback).map(feedback) })
}

export function initialGraphState(sessionId: string | null = null): GraphState { return freeze({ graph: null, failure: null, generation: null, facts: [], goalIdentity: { seen: false, id: null }, sessionId }) }

/** Checkpoint state is only a bounded fold shortcut, including actual dispatcher/result references. */
export function parseGraphState(value: unknown): GraphState {
  const row = object(value); keys(row, ['graph', 'failure', 'generation', 'facts', 'goalIdentity', 'sessionId'])
  const goalIdentity = object(row.goalIdentity); keys(goalIdentity, ['seen', 'id'])
  if (typeof goalIdentity.seen !== 'boolean') throw new Error('task graph: invalid goal identity')
  const facts = array(row.facts, 256).map(value => {
    const item = object(value)
    keys(item, ['callId', 'graphId', 'nodeId', 'attempt', 'taskGeneration', 'runtimeInstance', 'toolName', 'admissionSeq', 'observedSeq', 'resultSeq', 'succeeded'])
    if (typeof item.succeeded !== 'boolean') throw new Error('task graph: invalid proof outcome')
    return { callId: text(item.callId, 256), graphId: id(item.graphId), nodeId: id(item.nodeId), attempt: integer(item.attempt),
      taskGeneration: integer(item.taskGeneration), runtimeInstance: id(item.runtimeInstance), toolName: text(item.toolName, 256),
      admissionSeq: integer(item.admissionSeq), observedSeq: item.observedSeq === null ? null : integer(item.observedSeq),
      resultSeq: item.resultSeq === null ? null : integer(item.resultSeq), succeeded: item.succeeded }
  })
  return freeze({ graph: row.graph === null ? null : parseGraph(row.graph), failure: row.failure === null ? null : text(row.failure),
    generation: row.generation === null ? null : integer(row.generation), facts,
    goalIdentity: { seen: goalIdentity.seen, id: goalIdentity.id === null ? null : text(goalIdentity.id, 256) }, sessionId: row.sessionId === null ? null : text(row.sessionId, 256) })
}

/** Strict whole-state fold: malformed owned events poison writes instead of becoming silent successes. */
export function applyGraphEvent(state: GraphState, event: GraphEvent): GraphState {
  if (state.failure) return state
  if (event.type === 'goal/change') {
    try {
      const data = object(event.data)
      if (data.version !== 1) throw new Error('unknown goal event version')
      return freeze({ ...state, goalIdentity: { seen: true, id: data.operation === 'clear' ? null : text(object(data.goal).id, 256) } })
    } catch { return freeze({ ...state, failure: 'task graph: invalid goal identity event' }) }
  }
  if (event.type === 'xiaoshe/task-generation') {
    try {
      const value = object(event.data)
      return freeze({ ...state, generation: integer(value.generation) })
    } catch { return freeze({ ...state, failure: 'task graph: invalid task generation event' }) }
  }
  if ([GRAPH_CALL_EVENT, GRAPH_RESULT_EVENT, 'tool/result'].includes(event.type)) {
    try { return foldGraphFact(state, event) } catch (error) { return freeze({ ...state, failure: `task graph evidence replay at ${event.seq}: ${String(error)}` }) }
  }
  if (event.type !== GRAPH_EVENT) return state
  try {
    if (event.ignorable !== true) throw new Error('missing ignorable envelope')
    const data = object(event.data); keys(data, ['version', 'action', 'graph'])
    if (data.version !== 1 || !['change', 'durable'].includes(String(data.action))) throw new Error('invalid graph event')
    const next = parseGraph(data.graph), prior = state.graph
    if (data.action === 'durable') {
      if (!prior || prior.durability !== 'pending' || next.durability !== 'durable' || JSON.stringify({ ...next, durability: 'pending' }) !== JSON.stringify(prior)) throw new Error('invalid durability acknowledgement')
    } else {
      if (next.durability !== 'pending') throw new Error('changes must begin pending durability')
      if (prior?.id === next.id) {
        if (prior.durability !== 'durable' || next.revision !== prior.revision + 1 || next.sessionId !== prior.sessionId || next.taskGeneration !== prior.taskGeneration || next.goalId !== prior.goalId) throw new Error('invalid graph revision or binding')
      } else if (next.revision !== 1 || prior?.durability === 'pending' || next.nodes.some(node => node.status !== 'pending' || node.attempt !== 0 || node.evidence.length)) throw new Error('invalid graph replacement')
      for (const node of next.nodes) {
        const old = prior?.id === next.id ? prior.nodes.find(item => item.id === node.id) : undefined
        const unchanged = old?.status === 'completed' && node.status === 'completed' && sameDefinition(old, node)
          && old.attempt === node.attempt && JSON.stringify(old.evidence) === JSON.stringify(node.evidence)
        if (unchanged) continue
        if (node.evidence.some(ref => !state.facts.some(fact => fact.graphId === next.id && fact.nodeId === node.id
          && fact.attempt === node.attempt && fact.taskGeneration === next.taskGeneration && fact.runtimeInstance === next.runtimeInstance
          && fact.callId === ref.callId && fact.toolName === ref.toolName && fact.resultSeq === ref.resultSeq && fact.succeeded))) {
          throw new Error('snapshot evidence has no actual successful current attempt result')
        }
        if (node.status === 'completed' && old?.status !== 'verifying') throw new Error('completion requires a verifying transition')
      }
    }
    return freeze({ ...state, graph: next })
  } catch (error) { return freeze({ ...state, failure: `task graph replay at ${event.seq}: ${String(error)}` }) }
}

/** Fold only bounded provenance, never tool output bodies; old completed nodes retain their own evidence. */
function foldGraphFact(state: GraphState, event: GraphEvent): GraphState {
  if (event.type === 'tool/result') {
    const message = object(object(event.data).message), callId = object(message.source).callId
    const index = state.facts.findIndex(fact => fact.callId === callId)
    if (index < 0) return state
    const prior = state.facts[index]!
    if (prior.resultSeq !== null) throw new Error('duplicate canonical tool result')
    const blocks = array(message.content, 100)
    const valid = prior.observedSeq !== null && event.seq > prior.observedSeq && blocks.some(block => object(block).type === 'tool-result') && !blocks.some(block => object(block).isError === true)
    const facts = state.facts.map((fact, i) => i === index ? { ...fact, resultSeq: event.seq, succeeded: prior.succeeded && valid } : fact)
    return freeze({ ...state, facts })
  }
  const row = object(event.data)
  keys(row, ['version', 'graphId', 'nodeId', 'attempt', 'taskGeneration', 'runtimeInstance', 'callId', 'toolName', ...(event.type === GRAPH_RESULT_EVENT ? ['succeeded'] : [])])
  if (event.ignorable !== true || row.version !== 1) throw new Error('invalid evidence envelope')
  const graph = state.graph, node = graph?.nodes.find(node => node.id === row.nodeId)
  if (!graph || !node || graph.id !== row.graphId || graph.taskGeneration !== row.taskGeneration || graph.runtimeInstance !== row.runtimeInstance
    || node.attempt !== row.attempt || node.status !== 'running' || graph.durability !== 'durable' || row.toolName === 'xiaoshe_task_graph') throw new Error('stale evidence admission')
  if (event.type === GRAPH_CALL_EVENT) {
    if (state.facts.some(fact => fact.callId === row.callId)) throw new Error('duplicate tool admission')
    const fact: GraphFact = { callId: text(row.callId, 256), graphId: graph.id, nodeId: node.id, attempt: node.attempt, taskGeneration: graph.taskGeneration,
      runtimeInstance: graph.runtimeInstance, toolName: text(row.toolName, 256), admissionSeq: event.seq, observedSeq: null, resultSeq: null, succeeded: false }
    return freeze({ ...state, facts: [...state.facts, fact].slice(-256) })
  }
  const index = state.facts.findIndex(fact => fact.callId === row.callId && fact.graphId === graph.id && fact.nodeId === node.id && fact.attempt === node.attempt)
  if (index < 0 || state.facts[index]!.observedSeq !== null || typeof row.succeeded !== 'boolean') throw new Error('unbound tool outcome')
  return freeze({ ...state, facts: state.facts.map((fact, i) => i === index ? { ...fact, observedSeq: event.seq, succeeded: row.succeeded as boolean } : fact) })
}

/** Runtime ownership is volatile: replayed effects always require deliberate verification/retry. */
export function graphView(state: GraphState, instanceId: string, generation = state.generation,
  goalId: string | null | undefined = state.goalIdentity.seen ? state.goalIdentity.id : undefined): TaskGraphView | null {
  const graph = state.graph; if (!graph) return null
  const recoveryRequired = graph.runtimeInstance !== instanceId && graph.nodes.some(node => ['running', 'verifying'].includes(node.status))
  const nodes = recoveryRequired ? graph.nodes.map(node => ['running', 'verifying'].includes(node.status) ? { ...node, status: 'interrupted' as const } : node) : graph.nodes
  const stale = (generation !== null && generation !== graph.taskGeneration) || (graph.goalId !== null && goalId !== undefined && graph.goalId !== goalId)
    || (state.sessionId !== null && state.sessionId !== graph.sessionId)
  const ready = nodes.some(node => node.status === 'pending' && node.dependencies.every(ref => nodes.find(item => item.id === ref)?.status === 'completed'))
  const status = state.failure || graph.durability === 'pending' || stale || recoveryRequired ? 'waiting'
    : nodes.every(node => node.status === 'completed') ? 'completed' : nodes.some(node => ['running', 'verifying'].includes(node.status)) ? 'active' : ready ? 'ready' : 'waiting'
  return freeze({ ...graph, nodes, status, stale, recoveryRequired })
}

/** Existing preparation may credit a real durable plan, never a tool-returned claim. */
export function canonicalGraphPlan(state: GraphState, sessionId: string | undefined, generation: number): readonly { status: string }[] | undefined {
  const graph = state.graph
  if (state.failure || !graph || graph.durability !== 'durable' || graph.sessionId !== sessionId || graph.taskGeneration !== generation
    || (graph.goalId !== null && state.goalIdentity.seen && graph.goalId !== state.goalIdentity.id)) return undefined
  return graph.nodes.map(node => ({ status: ['running', 'verifying', 'interrupted', 'blocked'].includes(node.status) ? 'in_progress' : node.status }))
}

export function replayGraphPlan(events: readonly unknown[], sessionId: string | undefined, generation: number): readonly { status: string }[] | undefined {
  if (!sessionId) return undefined
  let state = initialGraphState(sessionId)
  for (const value of events) {
    if (value === null || typeof value !== 'object') continue
    const event = value as GraphEvent
    if (typeof event.type !== 'string' || !Number.isSafeInteger(event.seq)) continue
    state = applyGraphEvent(state, event)
  }
  return canonicalGraphPlan(state, sessionId, generation)
}

export class TaskGraphController {
  readonly instanceId: string
  private readonly folds = new WeakMap<GraphSession, { offset: number; state: GraphState }>()
  private readonly locks = new WeakSet<GraphSession>()
  // One bounded volatile diagnostic per live Session. A cold process already
  // interrupts unfinished attempts; no failed observer can grant durable proof.
  private readonly faults = new WeakMap<GraphSession, string>()
  constructor(private readonly dependencies: Dependencies) { this.instanceId = dependencies.instanceId ?? randomUUID() }

  private state(session: GraphSession): GraphState {
    const events = session.snapshotEvents()
    let cached = this.folds.get(session)
    if (!cached || cached.offset > events.length) cached = { offset: 0, state: initialGraphState(session.header.id) }
    for (let i = cached.offset; i < events.length; i++) cached.state = applyGraphEvent(cached.state, events[i]!)
    cached.offset = events.length; this.folds.set(session, cached)
    return cached.state
  }
  read(agent: GraphAgent): { graph: TaskGraphView | null; stale: boolean; recoveryRequired: boolean; error: string | null } {
    let state = this.folds.get(agent.session)?.state ?? initialGraphState(agent.session.header.id)
    let graph: TaskGraphView | null = null
    try {
      state = this.state(agent.session)
      const currentGoal = this.dependencies.goal(agent)
      graph = graphView(state, this.instanceId, this.dependencies.generation(agent), currentGoal?.id ?? null)
      if (state.graph === null) this.faults.delete(agent.session)
    } catch (error) {
      this.observerFailure(agent, error)
      graph = graphView(state, this.instanceId)
    }
    const error = state.failure ?? this.faults.get(agent.session) ?? null
    if (graph && error) graph = freeze({ ...graph, status: 'waiting', recoveryRequired: true })
    return { graph, stale: graph?.stale ?? false, recoveryRequired: Boolean(error) || (graph?.recoveryRequired ?? false), error }
  }
  /** Optional bookkeeping failures may fence Graph claims, never ordinary dispatch. */
  observerFailure(agent: GraphAgent, error: unknown): void {
    if (this.faults.has(agent.session)) return
    const message = `task graph degraded; reconcile before acceptance: ${error instanceof Error ? error.message : 'optional observer failed'}`.slice(0, GRAPH_LIMITS.text)
    this.faults.set(agent.session, message)
    try { this.dependencies.warn?.(message) } catch { /* Logging cannot gate the original tool either. */ }
  }
  private bound(agent: GraphAgent, args: Record<string, unknown>): GraphSnapshot {
    const state = this.state(agent.session), current = state.graph, view = this.read(agent)
    if (state.failure) throw new Error(state.failure)
    if (view.error && args.action !== 'reconcile') throw new Error(view.error)
    if (!current || current.id !== args.graphId || current.revision !== args.revision) throw new Error('task graph: stale graph revision; read current state')
    // Flushing an already-published log record changes no task authority. It
    // remains available after a new task arrives so a failed fence is recoverable.
    if (view.stale && args.action !== 'reconcile') throw new Error('task graph: stale task, session or goal binding')
    return current
  }
  /** A failed flush leaves the published pending state intact; only reconcile may release its fence. */
  private async persist(agent: GraphAgent, graph: GraphSnapshot, change: boolean): Promise<void> {
    if (change) {
      const candidate = { type: GRAPH_EVENT, data: { version: 1, action: 'change', graph }, seq: agent.session.snapshotEvents().length, ignorable: true as const }
      const validated = applyGraphEvent(this.state(agent.session), candidate)
      if (validated.failure) throw new Error(validated.failure)
      agent.session.append(GRAPH_EVENT, candidate.data, { ignorable: true })
    }
    let durable: boolean
    // This deadline bounds one storage operation, not task continuation. A late
    // flush may still persist the pending record, but can never release its fence.
    const timeoutMs = this.dependencies.flushTimeoutMs ?? 5000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('task graph: invalid flush deadline')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      durable = await Promise.race([this.dependencies.flush(agent.session), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('durability flush timeout')), timeoutMs)
      })])
    } catch (error) { throw new Error(`task graph pending durability; reconcile before continuing: ${String(error)}`) }
    finally { if (timer !== undefined) clearTimeout(timer) }
    if (!durable) throw new Error('task graph pending durability: no persistence listener; reconcile after storage is available')
    agent.session.append(GRAPH_EVENT, { version: 1, action: 'durable', graph: { ...graph, durability: 'durable' } }, { ignorable: true })
  }
  async execute(agent: GraphAgent, input: unknown): Promise<ReturnType<TaskGraphController['read']>> {
    const args = object(input)
    keys(args, ['action', 'graphId', 'revision', 'objective', 'nodes', 'nodeId', 'outcome', 'feedback', 'evidence', 'assessments'])
    if (args.action === 'read') return this.read(agent)
    if (this.locks.has(agent.session)) throw new Error('task graph: concurrent graph revision in progress; read and retry')
    this.locks.add(agent.session)
    try {
      if (args.action === 'create') {
        const current = this.state(agent.session)
        if (current.failure) throw new Error(current.failure)
        if (this.read(agent).error) throw new Error('task graph: degraded evidence; reconcile before creating another graph')
        if (current.graph && (args.graphId !== current.graph.id || args.revision !== current.graph.revision)) throw new Error('task graph: stale graph revision for replacement')
        if (current.graph?.durability === 'pending') throw new Error('task graph: pending durability must reconcile first')
        if (current.graph && !this.read(agent).stale && this.read(agent).graph?.status !== 'completed') throw new Error('task graph: current graph is unfinished; replan it')
        const goal = this.dependencies.goal(agent)
        const graph = parseGraph({ version: 1, id: randomUUID(), revision: 1, sessionId: agent.session.header.id,
          taskGeneration: this.dependencies.generation(agent), goalId: goal?.phase === 'active' ? goal.id : null,
          objective: text(args.objective), runtimeInstance: this.instanceId, durability: 'pending', nodes: parseNodes(args.nodes), feedback: [] })
        await this.persist(agent, graph, true)
        return this.read(agent)
      }
      const current = this.bound(agent, args)
      if (args.action === 'reconcile') {
        // Dependencies must be healthy now; a stale task may flush old state,
        // but an unavailable provider cannot silently release the local fence.
        this.dependencies.generation(agent); this.dependencies.goal(agent)
        if (current.durability === 'pending') await this.persist(agent, current, false)
        const fault = this.faults.get(agent.session)
        if (fault) {
          const stored = this.state(agent.session).graph!
          const note: Feedback = { outcome: 'interrupted', text: fault }
          const recovered = parseGraph({ ...stored, revision: stored.revision + 1, runtimeInstance: this.instanceId, durability: 'pending',
            nodes: stored.nodes.map(node => ['running', 'verifying'].includes(node.status)
              ? { ...node, status: 'interrupted', evidence: [], feedback: [...node.feedback, note].slice(-GRAPH_LIMITS.feedback) } : node),
            feedback: [...stored.feedback, note].slice(-GRAPH_LIMITS.feedback) })
          await this.persist(agent, recovered, true)
          this.faults.delete(agent.session)
        }
        return this.read(agent)
      }
      if (current.durability === 'pending') throw new Error('task graph: pending durability; reconcile first')
      const view = this.read(agent).graph!
      let nodes = [...view.nodes], notes = [...current.feedback]
      const node = nodes.find(node => node.id === args.nodeId)
      const replace = (replacement: GraphNode): void => { nodes = nodes.map(node => node.id === replacement.id ? replacement : node) }
      if (args.action === 'start') {
        if (!node || !['pending', 'blocked', 'interrupted'].includes(node.status)) throw new Error('task graph: node cannot start')
        if (nodes.some(node => ['running', 'verifying'].includes(node.status))) throw new Error('task graph: another node is active')
        if (!node.dependencies.every(ref => nodes.find(item => item.id === ref)?.status === 'completed')) throw new Error('task graph: prerequisites are incomplete')
        replace({ ...node, status: 'running', attempt: node.attempt + 1, startSeq: agent.session.snapshotEvents().length, evidence: [] })
      } else if (args.action === 'record') {
        if (!node || node.status !== 'running' || view.recoveryRequired) throw new Error('task graph: node attempt is not running')
        const note = feedback({ outcome: args.outcome, text: args.feedback })
        const refs = array(args.evidence, GRAPH_LIMITS.evidence).map(callId => this.resolveEvidence(agent, current, node, text(callId, 256)))
        if (note.outcome === 'passed' && !refs.length) throw new Error('task graph: successful execution needs real evidence')
        replace({ ...node, status: note.outcome === 'passed' ? 'verifying' : 'blocked', evidence: refs, feedback: [...node.feedback, note].slice(-GRAPH_LIMITS.feedback) })
        notes = [...notes, note].slice(-GRAPH_LIMITS.feedback)
      } else if (args.action === 'verify') {
        if (!node || node.status !== 'verifying' || view.recoveryRequired) throw new Error('task graph: node attempt is not verifying')
        const assessments = array(args.assessments, GRAPH_LIMITS.acceptance).map(value => {
          const row = object(value); keys(row, ['acceptanceId', 'callId', 'assertion', 'sourceExcerpt'])
          const acceptanceId = id(row.acceptanceId), assertion = text(row.assertion), sourceExcerpt = text(row.sourceExcerpt, 1000)
          if (!node.acceptance.some(item => item.id === acceptanceId)) throw new Error('task graph: unknown acceptance id')
          const ref = this.resolveEvidence(agent, current, node, text(row.callId, 256))
          if (!node.evidence.some(item => item.callId === ref.callId && item.resultSeq === ref.resultSeq)) throw new Error('task graph: unrecorded evidence')
          const result = agent.session.snapshotEvents().find(event => event.seq === ref.resultSeq)
          if (!JSON.stringify(result?.data).includes(sourceExcerpt) && !resultText(result?.data).includes(sourceExcerpt)) throw new Error('task graph: source excerpt not present in actual tool result')
          return { ...ref, kind: 'reviewer-assessment' as const, acceptanceId, assertion, sourceExcerpt }
        })
        if (assessments.length !== node.acceptance.length || new Set(assessments.map(item => item.acceptanceId)).size !== assessments.length) throw new Error('task graph: every acceptance needs one reviewer assessment')
        replace({ ...node, status: 'completed', evidence: assessments })
      } else if (args.action === 'replan') {
        const definitions = parseNodes(args.nodes), note = feedback({ outcome: 'needs-work', text: args.feedback })
        const preserved = new Set<string>()
        let changed = true
        while (changed) { changed = false; for (const proposed of definitions) {
          const prior = nodes.find(node => node.id === proposed.id)
          if (!preserved.has(proposed.id) && prior?.status === 'completed' && sameDefinition(prior, proposed) && proposed.dependencies.every(ref => preserved.has(ref))) { preserved.add(proposed.id); changed = true }
        } }
        nodes = definitions.map(proposed => preserved.has(proposed.id) ? nodes.find(node => node.id === proposed.id)!
          : { ...proposed, attempt: nodes.find(node => node.id === proposed.id)?.attempt ?? 0 })
        notes = [...notes, note].slice(-GRAPH_LIMITS.feedback)
      } else throw new Error('task graph: unknown action')
      const next = parseGraph({ ...current, revision: current.revision + 1, nodes, feedback: notes, runtimeInstance: this.instanceId, durability: 'pending' })
      await this.persist(agent, next, true)
      return this.read(agent)
    } finally { this.locks.delete(agent.session) }
  }

  /** Admission is captured at the actual dispatcher boundary, including parallel calls in one node. */
  observeCall(execution: GraphExecution): void {
    if (!execution.agent || execution.name === 'xiaoshe_task_graph') return
    try {
      const read = this.read(execution.agent), graph = read.graph
      const node = graph?.nodes.find(node => node.status === 'running')
      if (!graph || !node || read.error || read.stale || read.recoveryRequired || graph.durability !== 'durable') return
      execution.agent.session.append(GRAPH_CALL_EVENT, { version: 1, graphId: graph.id, nodeId: node.id, attempt: node.attempt,
        taskGeneration: graph.taskGeneration, runtimeInstance: this.instanceId, callId: execution.callId, toolName: execution.name }, { ignorable: true })
    } catch (error) { this.observerFailure(execution.agent, error) }
  }
  observeResult(execution: GraphExecution, result: { readonly isError: boolean; readonly value?: unknown }): void {
    if (!execution.agent || execution.name === 'xiaoshe_task_graph') return
    try {
      const events = execution.agent.session.snapshotEvents().slice(-GRAPH_LIMITS.history)
      const admitted = events.reverse().find(event => event.type === GRAPH_CALL_EVENT && object(event.data).callId === execution.callId)
      if (!admitted) return
      const data = object(admitted.data), graph = this.read(execution.agent)
      const node = graph.graph?.nodes.find(node => node.id === data.nodeId)
      if (graph.error || graph.stale || graph.recoveryRequired || graph.graph?.id !== data.graphId || !node || node.attempt !== data.attempt || node.status !== 'running') return
      execution.agent.session.append(GRAPH_RESULT_EVENT, { ...data, succeeded: !result.isError && successfulValue(execution.name, result.value) }, { ignorable: true })
    } catch (error) { this.observerFailure(execution.agent, error) }
  }
  private resolveEvidence(agent: GraphAgent, graph: GraphSnapshot, node: GraphNode, callId: string): Evidence {
    const events = agent.session.snapshotEvents().slice(-GRAPH_LIMITS.history)
    const admission = events.find(event => event.type === GRAPH_CALL_EVENT && object(event.data).callId === callId)
    const observation = events.find(event => event.type === GRAPH_RESULT_EVENT && object(event.data).callId === callId)
    const canonical = events.filter(event => event.type === 'tool/result' && object(object(object(event.data).message).source).callId === callId)
    const data = admission ? object(admission.data) : null
    if (!data || !observation || canonical.length !== 1 || data.graphId !== graph.id || data.nodeId !== node.id || data.attempt !== node.attempt
      || data.taskGeneration !== graph.taskGeneration || data.runtimeInstance !== this.instanceId || admission!.seq <= (node.startSeq ?? Infinity)
      || observation.seq <= admission!.seq || canonical[0]!.seq <= observation.seq || object(observation.data).succeeded !== true || data.toolName === 'xiaoshe_task_graph') throw new Error('task graph: evidence is not a successful current node attempt result')
    const result = canonical[0]!, message = object(object(result.data).message)
    const blocks = array(message.content, 100)
    if (blocks.some(block => object(block).isError === true) || !blocks.some(block => object(block).type === 'tool-result')) throw new Error('task graph: failed tool result cannot prove acceptance')
    return { callId, resultSeq: result.seq, toolName: text(data.toolName, 256), attempt: node.attempt, kind: 'execution' }
  }
}

function sameDefinition(left: GraphNode, right: GraphNode): boolean {
  return left.title === right.title && JSON.stringify(left.dependencies) === JSON.stringify(right.dependencies) && JSON.stringify(left.acceptance) === JSON.stringify(right.acceptance)
}
function successfulValue(toolName: string, value: unknown): boolean {
  // These four bridge actions use ACTION_SCHEMA's execution discriminator,
  // unlike an arbitrary read tool's business status. changed:false can still
  // be a completed action (for example an already-focused window).
  if (ACTION_TOOL_NAMES.has(toolName)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    if ((value as Record<string, unknown>).status !== 'completed') return false
  }
  // The first-party probe transports all terminal outcomes as normal values.
  // Decode its exact contract; arbitrary business status fields are just data.
  if (toolName === 'pure_js_probe') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const probe = value as Record<string, unknown>
    return probe.status === 'passed' && probe.runtime === 'quickjs-snapshot' && probe.error === undefined
      && Array.isArray(probe.cases) && probe.cases.length > 0 && probe.cases.length <= 32
      && probe.cases.every(item => item !== null && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).pass === true)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true
  const row = value as Record<string, unknown>
  return row.isError !== true && row.success !== false && row.ok !== false
    && (row.exitCode === undefined || row.exitCode === 0) && row.timedOut !== true && row.aborted !== true
}
function resultText(value: unknown): string {
  const texts: string[] = []
  function walk(value: unknown, depth: number): void {
    if (depth > 6 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) walk(item, depth + 1); return }
    const row = value as Record<string, unknown>
    if (row.type === 'text' && typeof row.text === 'string') texts.push(row.text)
    if (row.message) walk(row.message, depth + 1)
    if (row.content) walk(row.content, depth + 1)
  }
  walk(value, 0); return texts.join('\n')
}
