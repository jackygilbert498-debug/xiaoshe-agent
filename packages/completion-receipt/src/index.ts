import {
  createVerificationPolicy,
  type VerificationChangeKind,
  type VerificationGate,
  type VerificationPlan,
  type VerificationPolicy,
  type VerificationResult,
  type VerificationRisk,
  type VerificationStatus,
} from '@xiaoshe/verification-policy'

export type ReceiptOutcome = 'running' | 'verified' | 'partial' | 'blocked' | 'failed' | 'not_run' | 'release_held'
export type ReceiptToolStatus = 'running' | 'succeeded' | 'failed' | 'needs_verification'

export interface ReceiptEvidence { readonly path: string }
export interface ReceiptTool {
  readonly callId: string
  readonly name: string
  readonly status: ReceiptToolStatus
  readonly evidence: readonly ReceiptEvidence[]
}
export interface ReceiptApproval {
  readonly id: string
  readonly toolName: string
  readonly callId?: string
  readonly outcome: string
}
export interface CompletionReceipt {
  readonly schemaVersion: 2
  readonly turn: number
  readonly outcome: ReceiptOutcome
  readonly startedAt: number
  readonly completedAt?: number
  readonly sourceSeq: number
  readonly tools: readonly ReceiptTool[]
  readonly approvals: readonly ReceiptApproval[]
  readonly requirements: readonly VerificationGate[]
  readonly verificationResults: readonly VerificationResult[]
  readonly unverified: readonly string[]
}

export interface SessionFact {
  readonly type: string
  readonly data: unknown
  readonly seq: number
  readonly time: number
}

interface ProjectionState { readonly receipt: CompletionReceipt | null }

interface ProjectionDefinition {
  readonly key: 'completionReceipt'
  readonly schema: { parse(value: unknown): CompletionReceipt | null }
  readonly stateVersion: 3
  init(): ProjectionState
  apply(state: ProjectionState, event: SessionFact): ProjectionState
  view(state: ProjectionState): CompletionReceipt | null
}

const GATE_ORDER: readonly VerificationGate[] = [
  'typecheck', 'test', 'build', 'browser', 'windows-evidence', 'migration-rollback',
  'profile-dump', 'profile-start', 'functional-probe', 'release-confirmation',
]
const GATES = new Set<VerificationGate>(GATE_ORDER)
const STATUSES = new Set<VerificationStatus>(['passed', 'failed', 'skipped', 'not-run', 'blocked'])
const CHANGE_KINDS = new Set<VerificationChangeKind>(['code', 'ui', 'windows', 'persistence', 'plugin', 'release'])
const RISKS = new Set<VerificationRisk>(['low', 'medium', 'high'])
const EVIDENCE_REQUIRED = new Set<VerificationGate>([
  'browser', 'windows-evidence', 'migration-rollback', 'profile-dump',
  'profile-start', 'functional-probe', 'release-confirmation',
])

/** Purely fold canonical DSH Session facts; no second journal or snapshot store is created. */
export function foldCompletionReceipt(
  events: readonly SessionFact[],
  policy: VerificationPolicy = createVerificationPolicy(),
): CompletionReceipt | null {
  const projection = createCompletionReceiptProjection(policy)
  let state = projection.init()
  for (const item of events) state = projection.apply(state, item)
  return projection.view(state)
}

export function createCompletionReceiptProjection(policy: VerificationPolicy): ProjectionDefinition {
  return {
    key: 'completionReceipt',
    schema: { parse: parseCompletionReceipt },
    stateVersion: 3,
    init: () => ({ receipt: null }),
    apply: (state, event) => applyEvent(policy, state, event),
    view: state => state.receipt,
  }
}

export const completionReceiptProjection = createCompletionReceiptProjection(createVerificationPolicy())

function applyEvent(policy: VerificationPolicy, state: ProjectionState, event: SessionFact): ProjectionState {
  const data = record(event.data)
  if (event.type === 'turn/start') {
    const turn = integer(data?.turn)
    if (turn === undefined) return state
    return {
      receipt: {
        schemaVersion: 2,
        turn,
        outcome: 'running',
        startedAt: event.time,
        sourceSeq: event.seq,
        tools: [],
        approvals: [],
        requirements: [],
        verificationResults: [],
        unverified: [],
      },
    }
  }

  const receipt = state.receipt
  if (receipt === null) return state

  if (event.type === 'tool/call') {
    const callId = text(data?.callId)
    const name = text(data?.name)
    if (callId === undefined || name === undefined) return state
    const inferred = inferChange(name)
    return update(receipt, event.seq, {
      tools: [...receipt.tools, { callId, name, status: 'running', evidence: [] }],
      requirements: inferred === undefined
        ? receipt.requirements
        : mergeRequirements(receipt.requirements, policy.plan(inferred).gates),
    })
  }

  if (event.type === 'tool/result') {
    const message = record(data?.message)
    const source = record(message?.source)
    const callId = text(source?.callId)
    if (callId === undefined) return state
    const tool = receipt.tools.find(candidate => candidate.callId === callId)
    if (tool === undefined) return state
    const failed = data?.error !== undefined || message?.isError === true || hasErrorContent(message?.content)
    const meta = record(data?.meta)
    const evidence = evidenceFrom(meta)
    const declaredChange = changeFrom(meta?.change)
    const verificationResults = verificationFrom(meta?.verification)
    return update(receipt, event.seq, {
      tools: receipt.tools.map(candidate => candidate.callId === callId
        ? { ...candidate, status: failed ? 'failed' : 'succeeded', evidence }
        : candidate),
      requirements: declaredChange === undefined
        ? receipt.requirements
        : mergeRequirements(receipt.requirements, policy.plan(declaredChange).gates),
      verificationResults: [...receipt.verificationResults, ...verificationResults],
      unverified: failed
        ? appendUnique(receipt.unverified, `工具 ${tool.name} 执行失败`)
        : evidence.length === 0 && requiresEvidence(tool.name)
          ? appendUnique(receipt.unverified, `高风险工具 ${tool.name} 未提供可复查证据`)
          : receipt.unverified,
    })
  }

  if (event.type === 'approval/asked') {
    const id = text(data?.id)
    const toolName = text(data?.toolName)
    if (id === undefined || toolName === undefined) return state
    const callId = text(data?.callId)
    return update(receipt, event.seq, {
      approvals: [...receipt.approvals, { id, toolName, ...(callId === undefined ? {} : { callId }), outcome: 'pending' }],
    })
  }

  if (event.type === 'approval/decided') {
    const id = text(data?.id)
    const outcome = text(data?.outcome)
    if (id === undefined || outcome === undefined) return state
    return update(receipt, event.seq, {
      approvals: receipt.approvals.map(item => item.id === id ? { ...item, outcome } : item),
      unverified: outcome === 'allowed-once'
        ? receipt.unverified
        : appendUnique(receipt.unverified, `审批结果：${outcome}`),
    })
  }

  if (event.type !== 'turn/end') return state
  const turn = integer(data?.turn)
  if (turn !== receipt.turn) return state
  const reason = record(data?.reason)
  const kind = text(reason?.kind) ?? 'unknown'
  const unresolved = receipt.tools.filter(tool => tool.status === 'running')
  let unverified = receipt.unverified
  for (const tool of unresolved) unverified = appendUnique(unverified, `工具 ${tool.name} 的结果未知`)
  if (kind === 'interrupted' || kind === 'aborted') unverified = appendUnique(unverified, '任务在完成前中断')
  if (kind === 'max-tokens') unverified = appendUnique(unverified, '模型达到输出上限')
  const tools = receipt.tools.map(tool => tool.status === 'running'
    ? { ...tool, status: 'needs_verification' as const }
    : tool)

  for (const gate of receipt.requirements) {
    if (!gateSatisfied(gate, receipt.verificationResults)) {
      unverified = appendUnique(unverified, `验证门禁 ${gate} 未通过`)
    }
  }
  const verificationOutcome = receipt.requirements.length === 0
    ? 'verified'
    : policy.evaluate(compositePlan(receipt.requirements), receipt.verificationResults)
  const hasFailedTool = tools.some(tool => tool.status === 'failed')
  const outcome: ReceiptOutcome = kind === 'blocked'
    ? 'blocked'
    : kind === 'error' || hasFailedTool || verificationOutcome === 'failed'
      ? 'failed'
      : kind === 'not-run'
        ? 'not_run'
        : verificationOutcome === 'blocked'
          ? 'blocked'
          : verificationOutcome === 'release-held'
            ? 'release_held'
            : kind === 'completed' && verificationOutcome === 'verified'
              && unverified.length === 0 && tools.every(tool => tool.status === 'succeeded')
              ? 'verified'
              : 'partial'
  return update(receipt, event.seq, { outcome, completedAt: event.time, tools, unverified })
}

interface ProjectionRegistryPort { register(definition: ProjectionDefinition): unknown }
export const inject = ['sessionProjections', 'xiaosheVerificationPolicy']
export function apply(ctx: {
  readonly sessionProjections: ProjectionRegistryPort
  readonly xiaosheVerificationPolicy: VerificationPolicy
}): void {
  ctx.sessionProjections.register(createCompletionReceiptProjection(ctx.xiaosheVerificationPolicy))
}

function update(receipt: CompletionReceipt, sourceSeq: number, fields: Partial<CompletionReceipt>): ProjectionState {
  return { receipt: { ...receipt, ...fields, sourceSeq } }
}

function inferChange(toolName: string): { readonly kind: VerificationChangeKind; readonly risk: VerificationRisk } | undefined {
  if (/(?:publish|deploy|release)/iu.test(toolName)) return { kind: 'release', risk: 'high' }
  if (/(?:plugin.*(?:install|add|remove|update)|(?:install|uninstall).*plugin)/iu.test(toolName)) return { kind: 'plugin', risk: 'high' }
  if (/(?:migrate|migration|restore|rollback|backup)/iu.test(toolName)) return { kind: 'persistence', risk: 'high' }
  if (/(?:registry|win32|windows[_-])|(?:powershell|pwsh)/iu.test(toolName)) return { kind: 'windows', risk: 'high' }
  if (/(?:write|edit|delete|remove|move|rename|apply_patch|create_file)/iu.test(toolName)) return { kind: 'code', risk: 'medium' }
  return undefined
}

function changeFrom(value: unknown): { readonly kind: VerificationChangeKind; readonly risk?: VerificationRisk } | undefined {
  const input = record(value)
  if (input === undefined || Object.keys(input).some(key => key !== 'kind' && key !== 'risk')) return undefined
  if (typeof input.kind !== 'string' || !CHANGE_KINDS.has(input.kind as VerificationChangeKind)) return undefined
  if (input.risk !== undefined && (typeof input.risk !== 'string' || !RISKS.has(input.risk as VerificationRisk))) return undefined
  return {
    kind: input.kind as VerificationChangeKind,
    ...(input.risk === undefined ? {} : { risk: input.risk as VerificationRisk }),
  }
}

function verificationFrom(value: unknown): readonly VerificationResult[] {
  if (!Array.isArray(value) || value.length > 50) return []
  return value.flatMap((item): VerificationResult[] => {
    const input = record(item)
    if (input === undefined || Object.keys(input).some(key => key !== 'gate' && key !== 'status' && key !== 'evidence')) return []
    if (typeof input.gate !== 'string' || !GATES.has(input.gate as VerificationGate)
      || typeof input.status !== 'string' || !STATUSES.has(input.status as VerificationStatus)) return []
    if (input.evidence !== undefined && (typeof input.evidence !== 'string'
      || input.evidence.trim() === '' || input.evidence.length > 2_048)) return []
    return [{
      gate: input.gate as VerificationGate,
      status: input.status as VerificationStatus,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence as string }),
    }]
  })
}

function mergeRequirements(current: readonly VerificationGate[], next: readonly VerificationGate[]): readonly VerificationGate[] {
  const selected = new Set([...current, ...next])
  return GATE_ORDER.filter(gate => selected.has(gate))
}

function compositePlan(gates: readonly VerificationGate[]): VerificationPlan {
  return {
    kind: gates.includes('release-confirmation') ? 'release' : 'code',
    risk: 'high',
    gates,
  }
}

function gateSatisfied(gate: VerificationGate, results: readonly VerificationResult[]): boolean {
  return results.some(result => result.gate === gate && result.status === 'passed'
    && (!EVIDENCE_REQUIRED.has(gate) || (result.evidence !== undefined && result.evidence.trim() !== '')))
}

function evidenceFrom(meta: Record<string, unknown> | undefined): readonly ReceiptEvidence[] {
  const evidence = meta?.evidence
  if (typeof evidence === 'string' && evidence.trim() !== '' && evidence.length <= 2_048) return [{ path: evidence }]
  if (!Array.isArray(evidence) || evidence.length > 50) return []
  return evidence.flatMap(item => typeof item === 'string' && item.trim() !== '' && item.length <= 2_048 ? [{ path: item }] : [])
}

function hasErrorContent(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => record(item)?.isError === true)
}

function parseCompletionReceipt(value: unknown): CompletionReceipt | null {
  if (value === null) return null
  const candidate = record(value)
  if (candidate === undefined) throw new TypeError('invalid completion receipt projection')
  validateCommonReceipt(candidate)
  if (candidate.schemaVersion === 1) {
    return {
      ...(candidate as unknown as Omit<CompletionReceipt, 'schemaVersion' | 'requirements' | 'verificationResults'>),
      schemaVersion: 2,
      requirements: [],
      verificationResults: [],
    }
  }
  if (candidate.schemaVersion !== 2 || !Array.isArray(candidate.requirements)
    || candidate.requirements.some(gate => typeof gate !== 'string' || !GATES.has(gate as VerificationGate))
    || !Array.isArray(candidate.verificationResults)
    || verificationFrom(candidate.verificationResults).length !== candidate.verificationResults.length) {
    throw new TypeError('invalid completion receipt verification fields')
  }
  return value as CompletionReceipt
}

function validateCommonReceipt(candidate: Record<string, unknown>): void {
  if (integer(candidate.turn) === undefined || !isOutcome(candidate.outcome)
    || typeof candidate.startedAt !== 'number' || !Number.isFinite(candidate.startedAt)
    || integer(candidate.sourceSeq) === undefined || !Array.isArray(candidate.tools)
    || !Array.isArray(candidate.approvals) || !Array.isArray(candidate.unverified)) {
    throw new TypeError('invalid completion receipt projection')
  }
}

function isOutcome(value: unknown): value is ReceiptOutcome {
  return typeof value === 'string' && ['running', 'verified', 'partial', 'blocked', 'failed', 'not_run', 'release_held'].includes(value)
}

function appendUnique(values: readonly string[], value: string): readonly string[] {
  return values.includes(value) ? values : [...values, value]
}

function requiresEvidence(toolName: string): boolean {
  return /(?:click|type|write|edit|delete|remove|move|rename|execute|run|shell|plugin|publish|deploy|install|uninstall)/iu.test(toolName)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}
