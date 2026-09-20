import {
  TaskGraphController, applyGraphEvent, graphView, initialGraphState, object, parseGraph, parseGraphState,
  type GraphAgent, type GraphEvent, type GraphExecution, type GraphSession, type GraphState,
} from './task-graph-domain.js'

export const name = 'xiaoshe-task-graph'
export const inject = ['tools', 'systemPrompt', 'sessions', 'sessionProjections', 'xiaosheAgentReliability']
interface Host {
  tools: { register(tool: { name: string; description: string; parameters: unknown; output: unknown; execute(args: unknown, execution: GraphExecution): Promise<unknown> }): () => void }
  sessions: { flush(session: GraphSession): Promise<boolean> }
  sessionProjections: { register(definition: unknown): () => void }
  systemPrompt: { context(provider: { name: string; order: number; text(context: { agent?: GraphAgent }): string }): () => void }
  xiaosheAgentReliability: { snapshot(agent: GraphAgent): { taskGeneration: number } | undefined }
  get(name: string, strict: false): { get(agent: GraphAgent): { id: string; phase: string } | undefined } | undefined
  on(event: 'tools/pre-execute' | 'tools/execute', callback: (execution: GraphExecution, next: () => Promise<unknown>) => Promise<unknown>): unknown
  on(event: 'tools/result', callback: (execution: GraphExecution, result: { isError: boolean; value?: unknown }) => void): unknown
  effect(callback: () => (() => void), label?: string): unknown
  provide(name: string, value: unknown): unknown
  logger?: { warn(message: string): unknown }
}

/** The registry only needs parse(), retaining the root bundle's dependency-free structural API. */
export function taskGraphProjectionDefinition(instanceId: string): unknown {
  return {
    key: 'taskGraph', stateVersion: 1,
    stateSchema: { parse: parseGraphState },
    init: (header: { id: string }) => initialGraphState(header.id), apply: applyGraphEvent,
    wire: { view: (state: GraphState) => graphView(state, instanceId), viewSchema: { parse(value: unknown) {
      if (value === null) return null
      const { status, stale, recoveryRequired, ...snapshot } = object(value)
      if (!['ready', 'active', 'waiting', 'completed'].includes(String(status)) || typeof stale !== 'boolean' || typeof recoveryRequired !== 'boolean') throw new Error('invalid taskGraph view')
      parseGraph(snapshot)
      return value
    } } },
  }
}

const guidance = '复杂多步骤任务可用 xiaoshe_task_graph create 建立依赖与明确验收项，简单任务直接执行。Graph 是当前任务的执行记录；不自行创建或重启 Goal。每次 read 获取 revision；一次只 start 一个节点，该节点内可正常并行工具。工具失败时 record failed/needs-work 写实际反馈，修正参数或已授权环境后可 start 新尝试、继续用同一工具；次数不是永久禁令。外部状态未变时等待或按现有任务机制继续，不编造进展。record passed 仅说明执行成功；verify 必须给每个 acceptanceId 提供本次尝试真实工具结果的 callId、原文 sourceExcerpt 和 assertion，明确这是模型 reviewer-assessment，不是自动语义证明。自己的 Graph 工具输出不能验收自己。验收失败或计划变化用 replan，保持有效已完成依赖。pending durability 先 reconcile；冷恢复 interrupted 先核对现实状态并显式重新 start，不自动重放副作用。用户权限、禁止事项与真实工具审批始终优先。feedback 仅指当前执行/检查反馈。'

/** Adds bookkeeping and per-step context to the existing loop; it owns no continuation or timers. */
export function apply(ctx: Host): void {
  const controller = new TaskGraphController({
    generation: agent => {
      const generation = ctx.xiaosheAgentReliability.snapshot(agent)?.taskGeneration
      if (!Number.isSafeInteger(generation) || Number(generation) < 0) throw new Error('task graph: current task generation is unavailable')
      return Number(generation)
    },
    goal: agent => ctx.get('goals', false)?.get(agent) ?? null,
    flush: session => ctx.sessions.flush(session),
    warn: message => { ctx.logger?.warn(message) },
  })
  ctx.effect(() => ctx.sessionProjections.register(taskGraphProjectionDefinition(controller.instanceId)), `${name}: projection`)
  ctx.effect(() => ctx.tools.register({
    name: 'xiaoshe_task_graph', description: 'Read or update the optional current task DAG. CAS every mutation. One active node; real tool evidence and explicit reviewer assessment; no automatic effects or Goal creation. Read/reconcile remain recovery routes.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['read', 'create', 'start', 'record', 'verify', 'replan', 'reconcile'] },
      graphId: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, objective: { type: 'string', maxLength: 2000 },
      nodes: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'dependencies', 'acceptance'], properties: {
        id: { type: 'string' }, title: { type: 'string', maxLength: 300 }, dependencies: { type: 'array', items: { type: 'string' }, maxItems: 64 },
        acceptance: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string', maxLength: 2000 } } } },
      } } },
      nodeId: { type: 'string' }, outcome: { type: 'string', enum: ['failed', 'needs-work', 'passed'] }, feedback: { type: 'string', maxLength: 2000 },
      evidence: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Actual successful tool call IDs in this node attempt.' },
      assessments: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['acceptanceId', 'callId', 'assertion', 'sourceExcerpt'], properties: {
        acceptanceId: { type: 'string' }, callId: { type: 'string' }, assertion: { type: 'string', maxLength: 2000 }, sourceExcerpt: { type: 'string', maxLength: 1000 },
      } } },
    } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      if (!execution.agent?.session) throw new Error('task graph: a live current session is required')
      return controller.execute(execution.agent, args)
    },
  }), `${name}: tool`)
  ctx.effect(() => ctx.systemPrompt.context({ name: 'xiaoshe:task-graph', order: 460, text: context => {
    if (!context.agent) return ''
    const value = controller.read(context.agent)
    return `${guidance}\n当前 taskGraph（长图用 read 取得完整验收项）：${JSON.stringify(value).slice(0, 12000)}`
  } }), `${name}: per-step context`)
  ctx.on('tools/pre-execute', async (execution, next) => {
    // This sole decision is about a matching Graph completion claim. Ordinary
    // tools retain the same permission and dispatcher ownership as before.
    if (execution.agent && execution.name === 'update_goal' && object(execution.arguments).action === 'complete') {
      const value = controller.read(execution.agent), graph = value.graph, args = object(execution.arguments)
      if (graph && graph.goalId === args.goal_id && !value.stale && (value.error || graph.status !== 'completed' || graph.durability !== 'durable')) {
        return { kind: 'deny', reason: '当前 Goal 关联的 taskGraph 尚未持久化验收完成；请 read 并处理节点或恢复持久化。' }
      }
    }
    return next()
  })
  ctx.on('tools/execute', async (execution, next) => {
    // The actual dispatch seam runs after ask approval and scoped guards. It
    // cannot grant permission and optional observer failure cannot cancel next.
    controller.observeCall(execution)
    return next()
  })
  ctx.on('tools/result', (execution, result) => controller.observeResult(execution, result))
  ctx.provide('xiaosheTaskGraph', controller)
}

export { TaskGraphController, applyGraphEvent, graphView, initialGraphState, parseGraph }
export type { TaskGraphView, GraphSnapshot, GraphNode, Evidence, Feedback, Acceptance, GraphState, GraphEvent } from './task-graph-domain.js'
