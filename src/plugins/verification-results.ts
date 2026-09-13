import { createHash, randomUUID } from 'node:crypto'
import { readSessionEvents } from '../session-events.js'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { isPlainDocumentWrite } from '../../packages/verification-policy/lib/index.js'
import type { PreToolDecision } from '../types.js'
import type { ResumeCheckpoint, ResumeCheckpointEvidence } from './agent-reliability.js'
import {
  prepareJsonlMutation, captureJsonlMutation, captureJsonlRead, sameJsonlProof, jsonlRows,
  type JsonlExpectation, type JsonlProof,
} from './verification-jsonl.js'
import {
  observeOutputFile, outputTargetKey, sameOutputIdentity, VerificationFileProofStore,
  type OutputIdentity, type WriteProofBinding,
} from './verification-file-proofs.js'

export const name = 'xiaoshe-verification-results'
export const inject = ['xiaosheVerificationPolicy']

type VerificationGate =
  | 'typecheck'
  | 'test'
  | 'build'
  | 'browser'
  | 'windows-evidence'
  | 'migration-rollback'
  | 'profile-dump'
  | 'profile-start'
  | 'functional-probe'
  | 'release-confirmation'
type VerificationStatus = 'passed' | 'failed'
type ChangeKind = 'code' | 'data' | 'ui' | 'windows' | 'persistence' | 'plugin' | 'release'
type Risk = 'low' | 'medium' | 'high'

interface VerificationPolicy {
  plan(input: { readonly kind: ChangeKind; readonly risk?: Risk }): {
    readonly gates: readonly VerificationGate[]
  }
  planTool(input: { readonly toolName: string; readonly kind: ChangeKind; readonly risk?: Risk }): {
    readonly gates: readonly VerificationGate[]
  }
  classifyTool(input: { readonly toolName: string; readonly arguments?: unknown }): {
    readonly mutation: boolean
    readonly change?: { readonly kind: ChangeKind; readonly risk: Risk }
  }
}

interface SessionEvent {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

interface SessionLike {
  readonly header: { readonly cwd?: string; readonly id?: string; readonly createdAt?: number }
  snapshotEvents?(): readonly SessionEvent[]
  readonly events?: readonly SessionEvent[]
  append(type: 'verification/result', data: VerificationResultEvent): { readonly seq: number }
}

interface AgentLike {
  readonly id: string
  readonly session: SessionLike
  readonly ctx?: {
    readonly tools?: { schemas(scope?: AgentLike): ReadonlyArray<{ readonly name: string }> }
  }
  steer?(message: GuardMessage): void
}

interface GuardMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  readonly source: {
    readonly kind: 'plugin'
    readonly plugin: 'xiaoshe-verification-results'
    readonly form: 'notice'
    readonly summary: string
  }
}

interface AgentReliabilitySnapshotService {
  snapshot(agent: object): {
    readonly taskGeneration: number
    readonly evidenceRevision: number
    readonly wholeJsonDelivery?: { readonly target: string }
    readonly resumeCheckpoint?: ResumeCheckpoint
    callGeneration(callId: string): number | undefined
  } | undefined
}

interface Execution {
  readonly callId: string
  readonly name: string
  readonly arguments?: unknown
  readonly agent?: AgentLike
  readonly parent?: symbol
  readonly signal?: AbortSignal
}

interface ToolResult {
  readonly isError: boolean
  readonly value?: unknown
}

interface Host {
  readonly xiaosheVerificationPolicy: VerificationPolicy
  provide(name: 'xiaosheVerificationProgress', service: {
    reconcile(agent: AgentLike): VerificationProgress
    jsonDeliverySource(agent: AgentLike): { readonly status: 'verified'; readonly readCallId: string; readonly contentSha256: string } | undefined
    resumeCheckpoint(agent: AgentLike): ResumeCheckpointEvidence | undefined
  }): unknown
  get(name: 'xiaosheAgentReliability', strict: false): AgentReliabilitySnapshotService | undefined
  get(name: 'xiaosheBrowserAdmissionFacts', strict: false): {
    verificationArgumentRejected(agent: object, callId: string, args: unknown): boolean
  } | undefined
  get(name: 'sessionPersistence', strict: false): {
    locate(header: SessionLike['header']): { readonly kind: string; readonly path?: string }
  } | undefined
  readonly logger?: { warn(message: string): unknown }
  on(event: 'tools/pre-execute', listener: (execution: Execution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>): unknown
  on(event: 'tools/result', listener: (execution: Execution, result: ToolResult) => void): unknown
  on(event: 'agent/turn-stopping', listener: (payload: {
    readonly agent: AgentLike
    readonly turn: number
    readonly signal: AbortSignal
  }) => Promise<void> | void): unknown
  on(event: 'session/event', listener: (session: SessionLike, event: SessionEvent) => void): unknown
  effect(callback: () => (() => void)): unknown
}

interface VerificationResultEvent {
  readonly turn: number
  readonly mutationCallId: string
  readonly verifierCallId: string
  readonly gate: VerificationGate
  readonly status: VerificationStatus
  readonly evidence: string
}

interface CapturedResult {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly isError: boolean
  readonly value?: unknown
  /** Reads are always live; a write alone may be restored from a host-sealed sidecar. */
  readonly fileProof?: CapturedFileProof
  readonly jsonlProof?: JsonlProof
  /** Package-script evidence frozen before execution and rechecked at settlement. */
  readonly boundShellClassification?: CommandClassification
}

interface CapturedFileProof {
  readonly kind: 'write' | 'read'
  readonly targetKey: string
  readonly content: string
  readonly identity: OutputIdentity
}

interface PendingShellClassification {
  readonly packageInvocation: boolean
  readonly classification?: CommandClassification
}

interface DurableCall {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly turn: number
  readonly callSeq: number
  readonly resultSeq: number
  readonly failed: boolean
  readonly capture: CapturedResult
  readonly taskGeneration?: number
  readonly generationProtocol: 'absent' | 'valid' | 'invalid'
}

interface TaskGenerationHistory {
  readonly protocol: 'absent' | 'valid' | 'invalid'
  readonly facts: readonly { readonly seq: number; readonly generation: number }[]
}

interface Candidate {
  readonly gate: VerificationGate
  readonly status: VerificationStatus
  readonly evidence: string
  matches(mutation: DurableCall, session: SessionLike): boolean
}

interface PendingMutation {
  readonly call: DurableCall
  readonly gates: ReadonlySet<VerificationGate>
  readonly unknownEffect?: boolean
}

interface GuardAttemptState {
  generation: number
  total: number
  readonly revisionsByDebt: Map<string, Set<number>>
  readonly unavailableBrowserByDebt: Map<string, Exclude<BrowserControl, 'agent'>>
}

type BrowserControl = 'agent' | 'user' | 'paused' | 'unknown'

/** A bounded, non-sensitive projection of canonical proof, never a second ledger. */
interface VerificationProgress {
  readonly status: 'unavailable' | 'not-applicable' | 'pending' | 'verified' | 'observed'
  readonly taskGeneration?: number
  readonly mutationCount: number
  readonly requiredGates: readonly VerificationGate[]
  readonly passedGates: readonly VerificationGate[]
  readonly missingGates: readonly VerificationGate[]
  readonly unknownEffectCount: number
}

function unavailableProgress(): VerificationProgress {
  return { status: 'unavailable', mutationCount: 0, requiredGates: [], passedGates: [], missingGates: [], unknownEffectCount: 0 }
}

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const FILE_READ_TOOLS = new Set(['read'])
const SAFE_SCRIPT = /^[a-z0-9][a-z0-9:_-]*$/iu
const MAX_EVIDENCE = 2_048
const MAX_MUTATION_TARGETS = 64
const MAX_PATCH_CHARS = 1_000_000

/**
 * Reconcile only settled durable tool results, both before the next model
 * context is rendered and at the awaited stopping boundary. DSH emits the
 * tools/result hook BEFORE appending its durable result, so that hook captures
 * evidence but must not certify it. Both later seams use the same idempotent
 * producer; mutation-owned presentation metadata is never trusted.
 */
export function apply(ctx: Host): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const captured = new WeakMap<SessionLike, Map<string, CapturedResult>>()
  const pendingShell = new WeakMap<SessionLike, Map<string, PendingShellClassification>>()
  const pendingJsonl = new WeakMap<SessionLike, Map<string, JsonlExpectation>>()
  const guardAttempts = new WeakMap<AgentLike, GuardAttemptState>()
  const proofStoreWarnings = new WeakSet<SessionLike>()

  const sessionCaptures = (session: SessionLike, turn: number): ReadonlyMap<string, CapturedResult> => {
    const live = captured.get(session) ?? new Map<string, CapturedResult>()
    const result = new Map(live)
    const cwd = session.header.cwd
    if (cwd === undefined) return result
    let location: { readonly kind: string; readonly path?: string } | undefined
    try { location = ctx.get('sessionPersistence', false)?.locate(session.header) } catch { return result }
    if (location?.kind !== 'jsonl' || location.path === undefined) return result
    // The locator, never a model argument or a JSONL claim, owns the private
    // storage address. Persist only real live captures after canonical tool
    // settlement; never stat a historical write to manufacture its identity.
    for (const call of durableCalls(readSessionEvents(session), turn, live)) {
      const binding = writeProofBinding(session, call)
      if (binding === undefined) continue
      const proof = live.get(call.callId)?.fileProof
      const store = VerificationFileProofStore.open(location.path, cwd, proof?.kind === 'write')
      if (proof?.kind === 'write') {
        if (!(store?.save(binding, proof.identity) ?? false) && process.platform !== 'win32'
          && !proofStoreWarnings.has(session)) {
          proofStoreWarnings.add(session)
          // One content-free warning per Session, never a key/path/payload in
          // logs. Current live proof remains valid; cold durability did fail.
          ctx.logger?.warn('[XIAOSHE_WRITE_PROOF_UNAVAILABLE] Durable file proof could not be stored; live verification will not survive restart.')
        }
        continue
      }
      if (store === undefined) continue
      const identity = store.load(binding)
      const expected = record(call.arguments)?.content
      if (identity === undefined || typeof expected !== 'string') continue
      result.set(call.callId, { ...call.capture, fileProof: {
        kind: 'write', identity, content: expected, targetKey: outputTargetKey(identity),
      } })
    }
    return result
  }

  // Do not export document bytes as system instructions. This private relation
  // reuses the same sealed write and fresh full-read proof as canonical file
  // verification, then rechecks current FD identity at the input boundary.
  const jsonDeliverySource = (agent: AgentLike) => {
    const snapshot = ctx.get('xiaosheAgentReliability', false)?.snapshot(agent)
    const target = snapshot?.wholeJsonDelivery?.target
    const session = agent.session
    const turn = reconciliationTurnAt(readSessionEvents(session), Number.POSITIVE_INFINITY)
    const generations = taskGenerationHistory(readSessionEvents(session))
    if (!target || !snapshot || turn === undefined || generations.protocol !== 'valid'
      || generations.facts.at(-1)?.generation !== snapshot.taskGeneration) return undefined
    const targetPath = resolvePath(target, session.header.cwd)
    if (!targetPath) return undefined
    const captures = sessionCaptures(session, turn)
    const calls = durableCalls(readSessionEvents(session), turn, captures)
    const belongs = (call: DurableCall) => call.generationProtocol === 'valid'
      && call.taskGeneration === snapshot.taskGeneration
      && (snapshot.callGeneration(call.callId) === undefined
        || snapshot.callGeneration(call.callId) === snapshot.taskGeneration)
    const writes = calls.filter(call => belongs(call) && call.name === 'write'
      && !call.failed && !call.capture.isError
      && samePath(mutationTargetPath(call.name, call.arguments, session.header.cwd) ?? '', targetPath))
    const write = writes.at(-1)
    if (!write || write.capture.fileProof?.kind !== 'write') return undefined
    const binding = writeProofBinding(session, write)
    const location = ctx.get('sessionPersistence', false)?.locate(session.header)
    const sealed = binding && location?.kind === 'jsonl' && location.path && session.header.cwd
      ? VerificationFileProofStore.open(location.path, session.header.cwd, false)?.load(binding) : undefined
    if (!sealed || !sameOutputIdentity(sealed, write.capture.fileProof.identity)) return undefined
    const parsed = parseJsonDocument(write.capture.fileProof.content)
    if (!parsed.ok) return undefined
    for (const read of [...calls].reverse()) {
      if (!belongs(read) || captured.get(session)?.get(read.callId) !== read.capture
        || read.capture.fileProof?.kind !== 'read') continue
      if (!fileReadbackCandidates(read, session, calls).some(candidate => candidate.matches(write, session))) continue
      return { value: parsed.value, readCallId: read.callId,
        contentSha256: sealed.contentSha256, content: write.capture.fileProof.content }
    }
    return undefined
  }

  ctx.provide('xiaosheVerificationProgress', {
    resumeCheckpoint(agent) {
      try {
        const snapshot = ctx.get('xiaosheAgentReliability', false)?.snapshot(agent)
        const checkpoint = snapshot?.resumeCheckpoint
        const session = agent.session
        const turn = reconciliationTurnAt(readSessionEvents(session), Number.POSITIVE_INFINITY)
        const generations = taskGenerationHistory(readSessionEvents(session))
        if (!snapshot || !checkpoint?.target || !checkpoint.url || turn === undefined
          || checkpoint.generation !== snapshot.taskGeneration || generations.protocol !== 'valid'
          || generations.facts.at(-1)?.generation !== checkpoint.generation) return undefined
        const triggers = readSessionEvents(session).filter(event => event.type === 'user/message'
          && record(event.data)?.id === checkpoint.triggerMessageId
          && record(record(event.data)?.source)?.kind === 'user')
        if (triggers.length !== 1) return undefined
        const trigger = triggers[0]!
        // This query is read-only: do not invoke sessionCaptures, save a
        // sidecar, or turn historical text into current process captures.
        const live = captured.get(session) ?? new Map<string, CapturedResult>()
        const calls = durableCalls(readSessionEvents(session), turn, live)
        const starts = new Map<string, number>(), results = new Map<string, number>()
        for (const event of readSessionEvents(session)) {
          const data = record(event.data)
          const startId = event.type === 'tool/call' ? nonEmptyString(data?.callId)
            : ['tool/code-dispatch-start', 'tool/ptc-dispatch-start'].includes(event.type) ? nonEmptyString(data?.subCallId) : undefined
          const resultId = event.type === 'tool/result' ? nonEmptyString(record(record(data?.message)?.source)?.callId)
            : ['tool/code-dispatch', 'tool/ptc-dispatch'].includes(event.type) ? nonEmptyString(data?.subCallId) : undefined
          if (startId) starts.set(startId, (starts.get(startId) ?? 0) + 1)
          if (resultId) results.set(resultId, (results.get(resultId) ?? 0) + 1)
        }
        const fresh = calls.filter(call => call.callSeq > trigger.seq && !call.failed && !call.capture.isError
          // A repeated envelope must not move an old live capture past the
          // trigger. This seam rejects duplicate identity rather than relying
          // on the historical reducer's last-call correlation behavior.
          && starts.get(call.callId) === 1 && results.get(call.callId) === 1
          && call.generationProtocol === 'valid' && call.taskGeneration === checkpoint.generation
          && live.get(call.callId) === call.capture
          && (snapshot.callGeneration(call.callId) === undefined
            || snapshot.callGeneration(call.callId) === checkpoint.generation))
        const noObservationDenial = (call: DurableCall): boolean => call.name === 'browser_verify'
          && call.failed && call.capture.isError && live.get(call.callId) === call.capture
          && starts.get(call.callId) === 1 && results.get(call.callId) === 1
          && call.callSeq > trigger.seq && call.generationProtocol === 'valid'
          && call.taskGeneration === checkpoint.generation
          && ctx.get('xiaosheBrowserAdmissionFacts', false)?.verificationArgumentRejected(agent, call.callId, call.arguments) === true
        const target = resolvePath(checkpoint.target, session.header.cwd)
        if (!target) return undefined
        const oldWrite = calls.filter(call => call.name === 'write' && !call.failed && !call.capture.isError
          && call.resultSeq < trigger.seq && call.generationProtocol === 'valid'
          && call.taskGeneration === checkpoint.generation
          && samePath(mutationTargetPath(call.name, call.arguments, session.header.cwd) ?? '', target)).at(-1)
        const binding = oldWrite && writeProofBinding(session, oldWrite)
        const location = ctx.get('sessionPersistence', false)?.locate(session.header)
        const sealed = binding && location?.kind === 'jsonl' && location.path && session.header.cwd
          ? VerificationFileProofStore.open(location.path, session.header.cwd, false)?.load(binding) : undefined
        const expected = record(oldWrite?.arguments)?.content
        let fileReadCallId: string | undefined
        for (const call of [...fresh].reverse()) {
          if (call.name !== 'read' || call.capture.fileProof?.kind !== 'read'
            || !samePath(mutationTargetPath(call.name, call.arguments, session.header.cwd) ?? '', target)) continue
          const now = captureFileProof(call.name, call.arguments, call.capture.value, session.header.cwd)
          if (sealed && typeof expected === 'string' && now?.kind === 'read'
            && sameOutputIdentity(now.identity, sealed) && now.content === expected
            && sameOutputIdentity(now.identity, call.capture.fileProof.identity)
            && now.content === call.capture.fileProof.content && parseJsonDocument(now.content).ok) {
            fileReadCallId = call.callId; break
          }
        }
        const latestByTab = new Map<string, DurableCall>()
        // Include failed/foreign navigation too: unknown newer state cannot
        // leave a previously verified tab looking current.
        for (const call of calls.filter(call => call.callSeq > trigger.seq && call.name.startsWith('browser_'))) {
          if (noObservationDenial(call)) continue
          const value = record(call.capture.value)
          const tab = nonEmptyString(record(call.arguments)?.tab_id) ?? nonEmptyString(value?.tab_id)
          if (tab) latestByTab.set(tab, call)
        }
        const tabs: { tabId: string; snapshotId: string }[] = []
        let browserVerifierCallId: string | undefined
        for (const [tabId, latest] of latestByTab) {
          if (!fresh.includes(latest)) continue
          const value = record(latest.capture.value), current = record(value?.current) ?? value
          if (!canonicalBrowserSnapshot(current, tabId, agent.id) || current?.url !== checkpoint.url) continue
          tabs.push({ tabId, snapshotId: current.snapshot_id as string })
          if (latest.name !== 'browser_verify') continue
          const args = record(latest.arguments)
          if (args?.expect_url !== checkpoint.url || nonEmptyString(args.expect_text) === undefined) continue
          const candidates = browserCandidates(latest, calls)
          const opened = fresh.find(call => call.name === 'browser_open'
            && record(call.arguments)?.url === checkpoint.url
            && record(call.capture.value)?.url === checkpoint.url
            && verificationFollowsMutation(call, latest) && sameTaskGeneration(call, latest)
            && candidates.some(candidate => candidate.status === 'passed' && candidate.matches(call, session))
            && !calls.some(intervening => intervening.callId !== call.callId && intervening.callId !== latest.callId
              && intervening.name.startsWith('browser_') && intervening.callSeq > call.resultSeq
              && intervening.callSeq < latest.callSeq
              && !noObservationDenial(intervening)
              && (record(intervening.arguments)?.tab_id === tabId || record(intervening.capture.value)?.tab_id === tabId)))
          // durableCalls omits unsettled starts. A navigation already in flight
          // while the checkpoint was being observed cannot be ignored. Starts
          // after both observations are new work, not retroactive invalidation.
          const read = fresh.find(call => call.callId === fileReadCallId)
          const cutoff = Math.max(latest.resultSeq, read?.resultSeq ?? latest.resultSeq)
          const unsettled = readSessionEvents(session).some(event => {
            if (event.seq <= trigger.seq || event.seq > cutoff
              || !['tool/call', 'tool/code-dispatch-start', 'tool/ptc-dispatch-start'].includes(event.type)) return false
            const data = record(event.data), name = nonEmptyString(data?.name)
            const callId = nonEmptyString(event.type === 'tool/call' ? data?.callId : data?.subCallId)
            return name?.startsWith('browser_') === true && name !== 'browser_status'
              && callId !== undefined && !calls.some(call => call.callId === callId)
          })
          if (opened && !unsettled) browserVerifierCallId = latest.callId
        }
        return { triggerMessageId: checkpoint.triggerMessageId, generation: checkpoint.generation,
          ...(fileReadCallId === undefined ? {} : { fileReadCallId }),
          ...(browserVerifierCallId === undefined ? {} : { browserVerifierCallId }), tabs }
      } catch { return undefined }
    },
    jsonDeliverySource(agent) {
      try {
        const source = jsonDeliverySource(agent)
        return source === undefined ? undefined : {
          status: 'verified' as const, readCallId: source.readCallId, contentSha256: source.contentSha256,
        }
      } catch { return undefined }
    },
    reconcile(agent) {
      try {
        const turn = reconciliationTurnAt(readSessionEvents(agent.session), Number.POSITIVE_INFINITY)
        const snapshot = ctx.get('xiaosheAgentReliability', false)?.snapshot(agent)
        const generations = taskGenerationHistory(readSessionEvents(agent.session))
        if (turn === undefined || snapshot === undefined
          || nonNegativeInteger(snapshot.taskGeneration) === undefined
          || generations.protocol === 'invalid'
          || (generations.protocol === 'valid'
            && generations.facts.at(-1)?.generation !== snapshot.taskGeneration)) return unavailableProgress()
        const captures = sessionCaptures(agent.session, turn)
        const calls = durableCalls(readSessionEvents(agent.session), turn, captures ?? new Map())
        // A conflicting live identity must invalidate the whole projection, not
        // silently hide a fresh mutation while retaining an older all-pass.
        if (calls.some(call => call.generationProtocol === 'valid'
          && call.taskGeneration === snapshot.taskGeneration
          && snapshot.callGeneration(call.callId) !== undefined
          && snapshot.callGeneration(call.callId) !== snapshot.taskGeneration)) return unavailableProgress()
        const pending = produceTurnResults(agent.session, turn, captures, ctx.xiaosheVerificationPolicy)
        const belongs = (call: DurableCall): boolean => call.generationProtocol === 'valid'
          ? call.taskGeneration === snapshot.taskGeneration
            && (snapshot.callGeneration(call.callId) === undefined
              || snapshot.callGeneration(call.callId) === snapshot.taskGeneration)
          : call.generationProtocol === 'absent' && call.turn === turn
            && snapshot.callGeneration(call.callId) === snapshot.taskGeneration
        const required = new Set<VerificationGate>()
        let knownMutations = 0
        for (const call of calls) {
          if (!belongs(call) || call.failed || call.capture.isError) continue
          const classification = ctx.xiaosheVerificationPolicy.classifyTool({ toolName: call.name, arguments: call.arguments })
          if (!classification.mutation || classification.change === undefined) continue
          const gates = ctx.xiaosheVerificationPolicy.planTool({ toolName: call.name, ...classification.change }).gates
          if (gates.length === 0) continue
          knownMutations += 1
          for (const gate of gates) required.add(gate)
        }
        const current = pending.filter(item => belongs(item.call))
        const missing = new Set(current.flatMap(item => [...item.gates]))
        const unknownEffectCount = current.filter(item => item.unknownEffect).length
        const mutationCount = knownMutations + unknownEffectCount
        return {
          status: mutationCount === 0 ? 'not-applicable'
            : missing.size > 0 ? 'pending' : unknownEffectCount > 0 ? 'observed' : 'verified',
          taskGeneration: snapshot.taskGeneration,
          mutationCount,
          requiredGates: [...required].sort(),
          // A gate passes globally only when it covers EVERY current mutation
          // that requires it. Later changes immediately revoke that aggregate.
          passedGates: [...required].filter(gate => !missing.has(gate)).sort(),
          missingGates: [...missing].sort(),
          unknownEffectCount,
        }
      } catch {
        ctx.logger?.warn('xiaoshe verification progress unavailable; no completion proof was inferred')
        return unavailableProgress()
      }
    },
  })

  ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    if (decision.kind === 'allow' && execution.agent && !execution.signal?.aborted) {
      const session = execution.agent.session
      const expected = prepareJsonlMutation(execution.name, execution.arguments, session.header.cwd,
        path => ctx.xiaosheVerificationPolicy.classifyTool({ toolName: execution.name,
          arguments: { ...record(execution.arguments), file_path: path } }).change?.kind === 'data')
      if (expected) {
        let calls = pendingJsonl.get(session)
        if (!calls) { calls = new Map(); pendingJsonl.set(session, calls) }
        calls.set(execution.callId, expected)
        while (calls.size > 128) calls.delete(calls.keys().next().value as string)
      }
    }
    if (decision.kind !== 'allow' || !['write', 'browser_type'].includes(execution.name) || !execution.agent) return decision
    const agent = execution.agent
    const snapshot = ctx.get('xiaosheAgentReliability', false)?.snapshot(agent)
    if (!snapshot?.wholeJsonDelivery) return decision
    if (execution.name === 'write') {
      const args = record(execution.arguments)
      // The human's current exact-document relationship owns this narrow
      // syntax check. A .json suffix, page text or arbitrary write is not a
      // contract. Keep the requested bytes unchanged and let all other guards
      // retain their own path/source/planning/existence decisions.
      if (!args || typeof args.file_path !== 'string' || typeof args.content !== 'string') return decision
      const target = resolvePath(snapshot.wholeJsonDelivery.target, agent.session.header.cwd)
      const requested = resolvePath(args.file_path, agent.session.header.cwd)
      if (!target || !requested || !samePath(target, requested)) return decision
      if (lifetime.signal.aborted || execution.signal?.aborted) return { kind: 'deny', reason:
        'XIAOSHE_JSON_DOCUMENT: 当前调用已取消；此次未执行文件写入，未授予新的执行权限。' }
      if (!parseJsonDocument(args.content).ok) return { kind: 'deny', reason:
        'XIAOSHE_JSON_DOCUMENT: 当前用户约定的输出必须是可一次解析的完整 JSON 文档，不能使用多条 JSONL、Markdown 代码围栏或未闭合 JSON。此次未执行文件写入；这不是人工审批要求。请按原任务合同纠正 content 参数后再调用 write；路径、计划、来源读取及其他守卫仍须满足。' }
      // Valid JSON syntax certifies neither the requested data shape nor its
      // values, durable write, full readback or eventual browser delivery.
      return decision
    }
    const deny = (detail: string): PreToolDecision => ({ kind: 'deny', reason:
      `XIAOSHE_JSON_DELIVERY: ${detail} 此次未执行网页输入；这不是人工审批要求，也不能据此宣称网页已保存。` })
    if (lifetime.signal.aborted || execution.signal?.aborted) return deny('当前调用已取消。')
    const rejectJson = async (detail: string): Promise<PreToolDecision> => {
      const session = agent.session, ownerId = agent.id, tail = readSessionEvents(session).at(-1)
      const lastCapture = [...(captured.get(session)?.values() ?? [])].at(-1)
      const argsDigest = digest(JSON.stringify(execution.arguments))
      const signal = execution.signal
        ? AbortSignal.any([execution.signal, lifetime.signal]) : lifetime.signal
      // This is only a read-only control observation before a prospective
      // semantic denial, not a native type attempt or a BROWSER_PAUSED receipt.
      const control = await currentBrowserControl(ownerId, signal)
      const latest = ctx.get('xiaosheAgentReliability', false)?.snapshot(agent)
      if (signal.aborted || execution.agent !== agent || agent.session !== session || agent.id !== ownerId
        || readSessionEvents(session).at(-1) !== tail || [...(captured.get(session)?.values() ?? [])].at(-1) !== lastCapture
        || latest?.taskGeneration !== snapshot.taskGeneration || latest.evidenceRevision !== snapshot.evidenceRevision
        || latest.wholeJsonDelivery !== snapshot.wholeJsonDelivery
        || digest(JSON.stringify(execution.arguments)) !== argsDigest) {
        return { kind: 'deny', reason: 'XIAOSHE_BROWSER_CONTROL_STALE: 控制状态查询期间任务、调用、观察或取消状态已改变；本次未执行输入，未推断当前权限。' }
      }
      if (control !== 'agent') return { kind: 'deny', reason: control === 'unknown'
        ? 'XIAOSHE_BROWSER_CONTROL_UNAVAILABLE: 私有状态查询未能确认当前会话浏览器控制权；本次未执行输入。不要推断 agent 模式或自行恢复控制。'
        : `XIAOSHE_BROWSER_CONTROL_UNAVAILABLE: 私有状态查询确认当前会话控制模式为 ${control}；本次在执行前停止输入，等待用户明确交回。这不是已调用原生 type 的拒绝回执。` }
      return deny(detail)
    }
    try {
      const args = record(execution.arguments)
      // Let the existing schema/host limits reject malformed or oversized
      // arguments. Never coerce them or change the requested browser action.
      if (!args || typeof args.text !== 'string' || args.text.length > 2_000
        || typeof args.tab_id !== 'string' || typeof args.snapshot_id !== 'string'
        || typeof args.element_id !== 'string') return decision
      const turn = reconciliationTurnAt(readSessionEvents(agent.session), Number.POSITIVE_INFINITY)
      if (turn === undefined) return rejectJson('无法绑定当前任务和浏览器观察。')
      const live = captured.get(agent.session) ?? new Map<string, CapturedResult>()
      const calls = durableCalls(readSessionEvents(agent.session), turn, live)
      // A reconstructed historical tool message is not a current browser
      // observation. Use only actual results received in this process and task.
      const observations = calls.filter(call => call.name.startsWith('browser_')
        && !call.failed && !call.capture.isError && live.get(call.callId) === call.capture
        && call.generationProtocol === 'valid' && call.taskGeneration === snapshot.taskGeneration)
        .map(call => record(record(call.capture.value)?.current) ?? record(call.capture.value))
        .filter(value => value?.tab_id === args.tab_id && canonicalBrowserSnapshot(value, args.tab_id as string, agent.id))
      const current = observations.at(-1)
      if (!current || current.snapshot_id !== args.snapshot_id) return rejectJson('没有与本次 tab_id、snapshot_id 和当前会话所有者相符的真实观察；不能从历史工具文本推断输入载体。')
      const fields = (current.elements as unknown[]).map(record).filter(element => element
        && element.disabled === false && element.requires_user === false
        && (element.tag === 'textarea' || element.tag === 'input'
          && typeof element.type === 'string'
          && !['button', 'submit', 'hidden', 'checkbox', 'radio'].includes(element.type)))
      // A unique textarea can carry the explicitly requested whole document.
      // Ordinary forms, multiple fields and non-textarea widgets stay under
      // their original guards; do not infer which field should receive JSON.
      if (fields.length !== 1 || fields[0]?.tag !== 'textarea'
        || fields[0]?.element_id !== args.element_id) return decision
      const source = jsonDeliverySource(agent)
      if (!source) return rejectJson('唯一输出尚无仍有效的封存写入和本进程完整回读证明；先核对指定输出，不使用其他文件或历史回读替代。')
      const oldValue = fields[0]?.value
      if (args.replace !== true && (typeof oldValue !== 'string' || oldValue !== '')) {
        return rejectJson('完整文档输入不能追加到未知或非空旧值；请使用 replace 并保留完整 JSON。')
      }
      const payload = parseJsonDocument(args.text)
      if (!payload.ok || !sameJsonValue(payload.value, source.value)
        || !sameJsonValue(jsonTypeShape(payload.value), jsonTypeShape(source.value))
        || !sameDeliveredJson(source.content, args.text)) {
        return rejectJson('输入载荷与已核对文件的完整 JSON 值不一致；保留顶层容器、全部字段、值、类型和数组次序，不得只取内部数组、子项或摘要。排版和对象键序可以不同。')
      }
      // Matching input is not a verification/result. Independent browser
      // verification and actual server persistence are still required.
      return decision
    } catch {
      return rejectJson('当前文件或观察身份无法复核，未推断文档一致。')
    }
  })

  ctx.on('tools/result', (execution, result) => {
    const session = execution.agent?.session
    // Both native calls and Code Mode sub-dispatches have a canonical result
    // here. The durable reconciler below accepts the latter only after their
    // matching start/settle pair and enclosing run_code result exist.
    if (session === undefined) return
    let calls = captured.get(session)
    if (calls === undefined) {
      calls = new Map()
      captured.set(session, calls)
    }
    const pending = pendingShell.get(session)?.get(execution.callId)
    const expectedJsonl = pendingJsonl.get(session)?.get(execution.callId)
    pendingJsonl.get(session)?.delete(execution.callId)
    const jsonlProof = result.isError ? undefined : execution.name === 'read'
      ? captureJsonlRead(execution.arguments, result.value, session.header.cwd)
      : captureJsonlMutation(expectedJsonl, result.value)
    pendingShell.get(session)?.delete(execution.callId)
    const boundShellClassification = pending?.packageInvocation === true
      && pending.classification !== undefined
      && packageGraphsStillMatch(pending.classification.packageGraphs)
      ? pending.classification
      : undefined
    const fileProof = result.isError
      ? undefined
      : captureFileProof(execution.name, execution.arguments, result.value, session.header.cwd)
    const record: CapturedResult = {
      callId: execution.callId,
      name: execution.name,
      arguments: execution.arguments,
      isError: result.isError,
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(fileProof === undefined ? {} : { fileProof }),
      ...(jsonlProof === undefined ? {} : { jsonlProof }),
      ...(boundShellClassification === undefined ? {} : { boundShellClassification }),
    }
    calls.set(execution.callId, record)
    // Bound abnormal sessions that never reach turn/end (for example a hard
    // process interruption). Ordinary turns are cleared by the listener below.
    while (calls.size > 512) calls.delete(calls.keys().next().value as string)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const stopSignal = AbortSignal.any([signal, lifetime.signal])
    if (stopSignal.aborted) return
    try {
      const pending = produceTurnResults(
        agent.session,
        turn,
        sessionCaptures(agent.session, turn),
        ctx.xiaosheVerificationPolicy,
      )
      await redirectUnverifiedCompletion(agent, turn, pending, guardAttempts,
        ctx.get('xiaosheAgentReliability', false), stopSignal)
    } catch (error: unknown) {
      // Verification is fail-closed: producer faults leave the receipt partial
      // instead of turning a successfully completed user task into a loop error.
      ctx.logger?.warn(`xiaoshe verification producer skipped turn ${turn}: ${errorMessage(error)}`)
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/result' || ['tool/code-dispatch', 'tool/ptc-dispatch'].includes(event.type)) {
      const turn = reconciliationTurnAt(readSessionEvents(session), Number.POSITIVE_INFINITY)
      if (turn !== undefined) sessionCaptures(session, turn)
    }
    const shellCall = shellCallFromEvent(event)
    if (shellCall !== undefined) {
      const args = record(shellCall.arguments)
      const command = nonEmptyString(args?.command)
      if (command !== undefined && commandInvokesPackageScript(command)) {
        const workdir = resolvePath(nonEmptyString(args?.workdir), session.header.cwd)
        let calls = pendingShell.get(session)
        if (calls === undefined) {
          calls = new Map()
          pendingShell.set(session, calls)
        }
        const classification = workdir === undefined
          ? undefined
          : classifyVerificationCommandDetailed(command, workdir)
        calls.set(shellCall.callId, {
          packageInvocation: true,
          ...(classification === undefined ? {} : { classification }),
        })
        while (calls.size > 512) calls.delete(calls.keys().next().value as string)
      }
    }
    if (event.type !== 'turn/end') return
    pendingShell.delete(session)
    const turn = nonNegativeInteger(record(event.data)?.turn)
    const calls = captured.get(session)
    if (turn === undefined || calls === undefined) return
    try {
      pruneCapturedResults(session, turn, calls, ctx.xiaosheVerificationPolicy)
    } catch (error: unknown) {
      // Retaining bounded captures is safer than deleting a mutation that a
      // later turn still needs to verify.
      ctx.logger?.warn(`xiaoshe verification producer could not prune turn ${turn}: ${errorMessage(error)}`)
    }
    if (calls.size === 0) captured.delete(session)
  })
}

function produceTurnResults(
  session: SessionLike,
  turn: number,
  captures: ReadonlyMap<string, CapturedResult> | undefined,
  policy: VerificationPolicy,
): PendingMutation[] {
  // The Session log is authoritative after a restart. Live captures retain
  // richer typed values, but durable tool/result content is sufficient to
  // reconstruct the supported verifier and mutation contracts fail-closed.
  const calls = durableCalls(readSessionEvents(session), turn, captures ?? new Map())
  const mutations = calls.flatMap<PendingMutation>(call => {
    const classification = policy.classifyTool({ toolName: call.name, arguments: call.arguments })
    const change = classification.change
    if (!classification.mutation || call.failed || call.capture.isError) return []
    // Opaque shell programs cannot be certified by rerunning unrelated tests.
    // Keep this boundary visible to the model just as it is in the receipt,
    // without inventing a verification gate or silently treating it as read-only.
    if (change === undefined) return SHELL_TOOLS.has(call.name)
      ? [{ call, gates: new Set<VerificationGate>(), unknownEffect: true }]
      : []
    const gates = new Set(policy.planTool({ toolName: call.name, ...change }).gates)
    // Prompt-time reconciliation can already have closed a mutation. Retain it
    // here so a later verifier (including a failed rerun) refreshes the same
    // causal ledger; only the final pending projection drops satisfied gates.
    return gates.size === 0 ? [] : [{ call, gates }]
  })
  if (mutations.length === 0) return []

  const emitted = existingResultKeys(readSessionEvents(session))
  // A verifier may close debt from an earlier turn, including after a crash
  // between its durable result and this producer boundary. Strict result
  // ordering below prevents an older verifier from proving a later mutation,
  // while existingResultKeys makes reconciliation idempotent.
  for (const verifier of calls) {
    const candidates = verificationCandidates(verifier, session, calls, policy)
    if (candidates.length === 0) continue
    for (const mutation of mutations) {
      if (!verificationFollowsMutation(mutation.call, verifier)
        || !sameTaskGeneration(mutation.call, verifier)) continue
      for (const candidate of candidates) {
        if (!mutation.gates.has(candidate.gate) || !candidate.matches(mutation.call, session)) continue
        const key = resultKey(mutation.call.callId, verifier.callId, candidate)
        if (emitted.has(key)) continue
        session.append('verification/result', {
          // The fact belongs to this reconciliation turn; its linked verifier
          // may have settled in an earlier turn of the same task generation.
          turn,
          mutationCallId: mutation.call.callId,
          verifierCallId: verifier.callId,
          gate: candidate.gate,
          status: candidate.status,
          evidence: candidate.evidence,
        })
        emitted.add(key)
      }
    }
  }
  // A build command can be opaque to the shallow shell classifier and still
  // have a complete, independently checked verifier contract. Mirror receipt
  // folding: only a causally trusted result may retire that verifier's debt.
  // Include already-satisfied mutations so repeated stopping/replay is stable.
  const trustedVerifierIds = new Set<string>()
  if (mutations.some(mutation => mutation.unknownEffect)) {
    for (const call of calls) {
      const classification = policy.classifyTool({ toolName: call.name, arguments: call.arguments })
      if (!classification.mutation || classification.change === undefined
        || call.failed || call.capture.isError) continue
      const gates = new Set(policy.planTool({ toolName: call.name, ...classification.change }).gates)
      trustedProducedResults(readSessionEvents(session), call, calls, session, policy, { gates, callIds: trustedVerifierIds })
    }
  }
  return mutations.flatMap(mutation => {
    if (mutation.unknownEffect) return trustedVerifierIds.has(mutation.call.callId) ? [] : [mutation]
    // Partial progress is real progress. Do not repeatedly request gates whose
    // causal proof is already present; the completion receipt uses these same facts.
    const results = trustedProducedResults(readSessionEvents(session), mutation.call, calls, session, policy)
    const missing = new Set([...mutation.gates].filter(gate => results.get(gate)?.status !== 'passed'))
    return missing.size === 0 ? [] : [{ ...mutation, gates: missing }]
  })
}

/**
 * DSH currently streams assistant chunks before the awaited turn-stopping
 * seam, so this guard cannot retract a sentence already shown. It does ensure
 * the same turn cannot settle on that sentence without a correction: unless
 * the current answer already acknowledges every pending boundary, one
 * plugin-sourced next step asks for proof or an explicit partial outcome.
 * A second redirect is allowed only after a genuinely newer evidence revision;
 * the per-generation cap prevents a model from looping around verification.
 */
async function redirectUnverifiedCompletion(
  agent: AgentLike,
  turn: number,
  pending: readonly PendingMutation[],
  attempts: WeakMap<AgentLike, GuardAttemptState>,
  reliability: AgentReliabilitySnapshotService | undefined,
  signal: AbortSignal,
): Promise<void> {
  const snapshot = reliability?.snapshot(agent)
  if (snapshot === undefined || agent.steer === undefined) return

  let state = attempts.get(agent)
  if (state === undefined || state.generation !== snapshot.taskGeneration) {
    state = {
      generation: snapshot.taskGeneration,
      total: 0,
      revisionsByDebt: new Map(),
      unavailableBrowserByDebt: new Map(),
    }
    attempts.set(agent, state)
  }
  // Classifier uncertainty is not a failed user task. Retain diagnostics but
  // enforce stopping only for concrete, applicable verification obligations.
  const current = pending.filter(item => !item.unknownEffect
    && snapshot.callGeneration(item.call.callId) === snapshot.taskGeneration,
  )
  if (current.length === 0) return
  // This is only an admission to stop prompting, never verification evidence.
  // In particular a user takeover leaves the original action debt intact.
  if (honestlyAcknowledgesPending(agent.session, turn, current)) return

  const debtSignature = digest(JSON.stringify(current
    .map(item => ({ callId: item.call.callId, gates: [...item.gates].sort(), unknownEffect: item.unknownEffect === true }))
    .sort((left, right) => left.callId.localeCompare(right.callId))))
  const revisions = state.revisionsByDebt.get(debtSignature) ?? new Set<number>()
  if (state.total >= 2) return
  let browserControl: BrowserControl | undefined
  let browserRouteRestored = false
  if (current.some(item => item.gates.has('browser'))) {
    // Tool registration is not current control authority. Query only private
    // host status, never page data, and never carry this observation forward.
    const session = agent.session
    const ownerId = agent.id
    const tail = readSessionEvents(session).at(-1)
    browserControl = await currentBrowserControl(ownerId, signal)
    const latest = reliability?.snapshot(agent)
    if (signal.aborted || agent.session !== session || agent.id !== ownerId
      || readSessionEvents(session).at(-1) !== tail || latest?.taskGeneration !== snapshot.taskGeneration
      || latest.evidenceRevision !== snapshot.evidenceRevision) return
    const previous = state.unavailableBrowserByDebt.get(debtSignature)
    if (browserControl === 'agent') {
      browserRouteRestored = previous !== undefined
      state.unavailableBrowserByDebt.delete(debtSignature)
    } else {
      // Repeated user/paused/unknown observations are not new verification
      // opportunities even when a model's status call increases its revision.
      if (previous === browserControl) return
      state.unavailableBrowserByDebt.set(debtSignature, browserControl)
    }
  }
  const browserUnavailable = browserControl !== undefined && browserControl !== 'agent'
  if (signal.aborted || (!browserUnavailable && !browserRouteRestored && revisions.has(snapshot.evidenceRevision))) return
  revisions.add(snapshot.evidenceRevision)
  state.revisionsByDebt.set(debtSignature, revisions)
  state.total += 1

  const gates = [...new Set(current.flatMap(item => [...item.gates]))].sort()
  const mutationIds = current.map(item => item.call.callId).sort()
  // Bare call_00/call_01 prefixes were misread as a file/browser pair in a
  // real run. Name the actual operation and opaque baseline, never its body.
  const actions = current.map(item => {
    const value = record(item.call.capture.value)
    const baseline = item.call.name.startsWith('browser_') ? nonEmptyString(value?.snapshot_id) : undefined
    return `- ${item.call.callId}：工具 ${item.call.name}；待验门禁 ${[...item.gates].join('、')}${baseline ? `；动作快照 ${JSON.stringify(baseline)}` : ''}。`
  })
  const routeAvailable = !browserUnavailable && gates.some(gate => verificationRouteAvailable(agent, gate))
  const instruction = browserUnavailable
    ? [
        browserControl === 'unknown'
          ? '当前未取得本会话浏览器控制状态的可靠观测，不能将工具已注册推断为可操作，也不能断言用户已交回。'
          : `私有浏览器当前控制状态为 ${browserControl}：用户已接管或暂停本会话浏览器。`,
        `待验证调用：${mutationIds.join('、')}；缺少门禁：${gates.join('、')}。`,
        ...actions,
        '根据上述尚未闭合的 browser 门禁，在最终回复中单独清楚说明“浏览器部分：部分完成，尚待验证”，不能只列已确认结果和待验门禁。该状态仅说明浏览器动作的验证仍有缺口，不能据此推断网页未保存或已保存。',
        '停止工具操作。后续只有用户明确交回，且本会话可靠的私有控制状态观测明确为 agent 时，才具备按原任务和现有权限决定下一步的控制条件；user、paused、unknown 均不可操作。',
        '不要为确认是否可操作而反复查询或尝试验证，不要换终端、HTTP、截图等路线绕过控制边界，也不能自行恢复。',
        '已有成功修改及其待验记录全部保留；用户接管不代表验证通过。不能重复保存或用新的查看点击冒充原动作验证；旧快照不能承诺恢复，交回后的新观察也不能冒充旧动作已通过。',
        '后续具体操作应依据交回后的新观察、原任务和现有权限，不要预先承诺一定提交、重提交或永不提交。',
      ].join('\n')
    : routeAvailable
    ? [
        '验证闭环：刚才的完成表述不能作为最终结论；当前成功修改仍尚未验证。',
        `待验证调用：${mutationIds.join('、')}；缺少门禁：${gates.join('、')}。`,
        ...actions,
        '请按完整调用 ID 和实际工具名对应原动作，不要按 call_00/call_01 前缀猜测。浏览器基线若已被后续动作替换，保留待验边界；不能重复保存或用新的查看点击冒充原动作验证。',
        '请立即使用当前已注册的独立回读、测试或观察工具验证这些修改。不要信任写入动作自身的返回或元数据。',
        ...(current.some(item => item.call.name === 'schedule_create' || item.call.name === 'schedule_delete')
          ? ['提醒记录的 functional-probe 使用 schedule_list 回读当前会话：创建后核对同一 ID、内容、到期时间和单次/重复规则，取消后核对该 ID 已不在列表。只证明记录已创建或已取消，不代表未来提醒已经执行或送达；不需要代码构建。'] : []),
        ...(current.some(item => item.call.capture.jsonlProof?.kind === 'mutation')
          ? ['JSONL 数据修改的 functional-probe 可用原生 read 回读同一文件完成：宿主独立比较整份文件与本次精确编辑产生的预期内容，不只依据 grep 或抽样。缺少修改前基线、文件过大或文件身份发生不明变化时保留实际证据缺口；不要求代码构建。'] : []),
        '若验证失败则继续修正；若没有可用路线、没有新证据或无法完成验证，停止尝试并在下一条回复中明确写“部分完成，尚待验证”，列出缺失门禁，绝不能再无条件声称已完成。',
      ].join('\n')
    : [
        '验证闭环：刚才的完成表述不能作为最终结论；当前成功修改仍尚未验证，且本步没有匹配的独立验证工具。',
        `待验证调用：${mutationIds.join('、')}；缺少门禁：${gates.join('、')}。`,
        ...actions,
        '不要继续试探或重复工具。请在下一条回复中明确写“部分完成，尚待验证”，列出缺失门禁，绝不能无条件声称已完成。',
      ].join('\n')
  agent.steer(guardMessage(instruction, routeAvailable))
}

async function currentBrowserControl(ownerId: string, signal: AbortSignal): Promise<BrowserControl> {
  try {
    const protocol = await import(new URL('../../scripts/isolated-browser-protocol.mjs', import.meta.url).href) as {
      requestBrowser(input: { ownerId: string; command: 'status'; signal: AbortSignal; timeoutMs: number }): Promise<unknown>
    }
    const value = record(await protocol.requestBrowser({ ownerId, command: 'status', signal, timeoutMs: 1500 }))
    if (value?.connected === true && value.owner_id === ownerId
      && (value.mode === 'agent' || value.mode === 'user' || value.mode === 'paused')) return value.mode
  } catch { /* Unknown transport/control state is not permission to operate. */ }
  return 'unknown'
}

const PENDING_GATE_WORDS: Readonly<Record<VerificationGate, RegExp>> = {
  typecheck: /\btypecheck\b|类型检查/iu,
  test: /\btests?\b|测试/iu,
  build: /\bbuild\b|构建/iu,
  browser: /\bbrowser\b|浏览器|网页/iu,
  'windows-evidence': /\bwindows-evidence\b|Windows.*(?:证据|验证)|桌面.*(?:证据|验证)/iu,
  'migration-rollback': /\bmigration-rollback\b|迁移.*回滚/iu,
  'profile-dump': /\bprofile-dump\b|配置导出/iu,
  'profile-start': /\bprofile-start\b|配置启动/iu,
  'functional-probe': /\bfunctional-probe\b|功能(?:探测|验证)|独立回读|文件.*回读/iu,
  'release-confirmation': /\brelease-confirmation\b|发行确认|发布确认/iu,
}
const PENDING_LANGUAGE = /尚(?:待|未)|还未|未(?:完成|通过|验证|确认|执行)|没有.*(?:验证|确认)|缺(?:失|少).*门禁|无法.*(?:验证|确认)|(?:验证|确认).*?(?:打断|暂停|阻止|未做)|\b(?:pending|unverified|not (?:yet )?(?:verified|validated|confirmed|complete|completed)|unable to verify)\b/iu
const POSITIVE_VERIFICATION = /已(?:经)?(?:全部)?(?:完成)?(?:独立)?(?:验证|确认|通过)|(?:验证|测试|构建|类型检查)(?:已)?通过|\b(?:verified|validated|confirmed|passed)\b/iu

/** Conservative prose recognition: unknown wording retains the existing guard. */
function honestlyAcknowledgesPending(session: SessionLike, turn: number, pending: readonly PendingMutation[]): boolean {
  let message: Record<string, unknown> | undefined
  let messageSeq = -1
  for (const event of readSessionEvents(session)) {
    const data = record(event.data)
    if (event.type === 'turn/start' || event.type === 'turn/end'
      || event.type === 'user/message' || event.type.startsWith('tool/')) {
      message = undefined
    }
    if (event.type !== 'assistant/message') continue
    // Only the latest complete model message in this turn can acknowledge it.
    message = data?.turn === turn ? record(data.message) : undefined
    messageSeq = event.seq
  }
  if (message?.role !== 'assistant' || record(message.source)?.kind !== 'model'
    || !Array.isArray(message.content) || message.content.some(block => record(block)?.type !== 'text')
    || pending.some(item => item.call.resultSeq >= messageSeq)) return false
  const raw = message.content.map(block => record(block)?.text).filter((text): text is string => typeof text === 'string').join('\n')
  if (raw.length > 32_000) return false
  const text = directCompletionProse(raw)
  if (!/部分完成|尚未完成|未全部完成|尚待.*验证|\b(?:partially complete|partial(?:ly)? completion|partial result|not fully complete)\b/iu.test(text)) return false
  const clauses = text.split(/[。！？!?;；，,\n]+/u).map(line => line.trim()).filter(line => line !== '')
  // A partial preface cannot excuse a contradictory overall success claim.
  if (clauses.some(clause => /(?:全部|整体|所有|一切).{0,18}(?:完成|通过|验证|确认|成功)|\b(?:everything|all (?:work|tasks|changes|checks)).{0,24}\b(?:complete|completed|verified|passed|done)\b/iu.test(clause
    .replace(/(?:未|没有|并非)全部|\bnot (?:all|everything)\b/giu, '')))) return false
  if (clauses.some(clause => /^(?:(?:但|然而|所以|因此|现在|我|本次|本轮|当前)[：: ]*)*(?:(?:整个)?(?:任务|工作|流程|交付))?(?:已经|现已|已)?(?:完成|全部完成|验证通过)(?:了)?$|^(?:(?:the )?task is )?(?:complete|completed|all done)$/iu.test(clause))) return false
  for (const item of pending) {
    // An explicit call ID narrows a statement even when several calls share
    // the same tool name; mentioning A cannot acknowledge B's debt.
    const targetsItem = (clause: string) => {
      const explicit = pending.filter(candidate => clause.includes(candidate.call.callId))
      return explicit.length === 0 || explicit.some(candidate => candidate === item)
    }
    if (item.unknownEffect) {
      const effectClauses = clauses.filter(clause => targetsItem(clause)
        && /unknown.effect|未知.*(?:影响|副作用)|(?:命令|副作用).*(?:影响|范围)/iu.test(clause))
      if (!effectClauses.some(clause => /未知|无法.*确认|尚待.*确认|未确认|unknown|unconfirmed/iu.test(clause))
        || effectClauses.some(hasAffirmativeVerification)
        || clauses.some(clause => clause.includes(item.call.callId) && hasAffirmativeVerification(clause))) return false
    }
    for (const gate of item.gates) {
      const words = PENDING_GATE_WORDS[gate]
      const sameOperation = (clause: string) => clause.includes(item.call.callId)
        || clause.includes(item.call.name)
        || (item.call.name.startsWith('browser_') && new RegExp(`\\b${item.call.name.slice(8)}\\b`, 'iu').test(clause))
      const anotherBrowserOperation = (clause: string) => /\b(?:browser_)?(?:open|type|click|press|scroll|close)\b/iu.test(clause) && !sameOperation(clause)
      if (!clauses.some(clause => targetsItem(clause) && (words.test(clause) || (gate === 'browser' && sameOperation(clause)))
        && PENDING_LANGUAGE.test(clause) && !anotherBrowserOperation(clause)
        && (gate !== 'browser' || /验证|确认|门禁|verif|validat|confirm/iu.test(clause)))) return false
      if (clauses.some(clause => targetsItem(clause) && (sameOperation(clause) || (words.test(clause) && !anotherBrowserOperation(clause)))
        && hasAffirmativeVerification(clause))) return false
      if (gate === 'browser' && clauses.some(clause => /已(?:经)?(?:成功)?保存|\b(?:saved successfully|successfully saved)\b/iu.test(clause)
        && !/未保存|尚未保存|未点击|尚未执行/iu.test(clause)
        && (words.test(clause) || !/文件|\.json\b/iu.test(clause)))) return false
    }
  }
  return true
}

function hasAffirmativeVerification(clause: string): boolean {
  // Remove only local negative assertions, not an entire sentence: a later
  // “but everything is verified” must still be detected as contradictory.
  return POSITIVE_VERIFICATION.test(clause.replace(/(?:尚待|尚未|未|不能|无法|没有|不应|不可)(?:完成|独立|全部)?(?:验证|确认|通过)|\b(?:not (?:yet )?|un)(?:verified|validated|confirmed)|\bnot passed\b/giu, ''))
}

function directCompletionProse(raw: string): string {
  // Quoted instructions, examples and tool/page data cannot acknowledge debt.
  let fence: string | undefined
  return raw.split(/\r?\n/u).filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) { fence = fence === undefined ? marker[0] : fence === marker[0] ? undefined : fence; return false }
    return fence === undefined && !/^\s*>/u.test(line) && !/[?？]/u.test(line)
      && !/^\s*(?:引用|示例|例如|假设|如果|假如|若|请写|应写|用户(?:说|要求)|页面(?:显示|写着)|工具(?:返回|输出)|example\b|if\b|quote\b)/iu.test(line)
  }).join('\n')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, '')
    .replace(/`([^`\n]+)`/gu, (_match, value: string) => /^[\w-]+$/u.test(value) ? value : '')
    .replace(/\*\*|__/gu, '')
}

function verificationRouteAvailable(agent: AgentLike, gate: VerificationGate): boolean {
  const names = new Set(agent.ctx?.tools?.schemas(agent).map(tool => tool.name) ?? [])
  if (['typecheck', 'test', 'build', 'migration-rollback', 'profile-dump', 'profile-start',
    'release-confirmation'].includes(gate)) return names.has('pwsh') || names.has('bash')
  if (gate === 'browser') return names.has('browser_verify')
  if (gate === 'windows-evidence') return names.has('screen_verify')
  if (gate === 'functional-probe') {
    return [...FILE_READ_TOOLS].some(name => names.has(name))
      || names.has('xiaoshe_memory_list') || names.has('schedule_list') || names.has('pwsh') || names.has('bash')
  }
  return false
}

function guardMessage(text: string, routeAvailable: boolean): GuardMessage {
  // A correction is a next action or a bounded handoff, not an invitation to
  // replay the transcript. A real off-reasoning run spent its entire response
  // budget debating an expired baseline and never delivered its partial result.
  const closure = '收尾方式：不要复盘整段历史、推演快照关系或反复自我论证。' +
    (routeAvailable ? '有可用验证路线时直接调用工具；否则直接交付简短的部分结果。' : '现在直接交付简短的部分结果，不再调用工具。') +
    '回复只需说明已确认结果、尚待验证的门禁和继续所需条件，遵守用户要求的回复格式；无法闭合的原动作继续保持未验证，不以解释或其他新动作代替证据。'
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `${text}\n${closure}` }],
    source: {
      kind: 'plugin',
      plugin: 'xiaoshe-verification-results',
      form: 'notice',
      summary: routeAvailable ? '继续独立验证' : '降级为尚待验证',
    },
  }
}

function durableCalls(
  events: readonly SessionEvent[],
  turn: number,
  captures: ReadonlyMap<string, CapturedResult>,
): DurableCall[] {
  const generations = taskGenerationHistory(events)
  const roots = new Map<string, {
    name: string
    arguments: unknown
    turn: number
    callSeq: number
    resultSeq?: number
    failed?: boolean
    capture?: CapturedResult
  }>()
  const starts = new Map<string, {
    rootCallId: string
    parentCallId: string
    name: string
    arguments: unknown
    callSeq: number
  }>()
  const nested: Array<{
    rootCallId: string
    parentCallId: string
    subCallId: string
    name: string
    arguments: unknown
    callSeq: number
    resultSeq: number
    failed: boolean
    content: unknown
    meta: unknown
  }> = []
  for (const event of events) {
    const data = record(event.data)
    const eventTurn = nonNegativeInteger(data?.turn)
    if (event.type === 'tool/call' && eventTurn !== undefined && eventTurn <= turn) {
      const callId = nonEmptyString(data?.callId)
      const name = nonEmptyString(data?.name)
      const parsed = parseArguments(data?.arguments)
      if (callId !== undefined && name !== undefined && parsed.ok) {
        roots.set(callId, { name, arguments: parsed.value, turn: eventTurn, callSeq: event.seq })
      }
      continue
    }
    if (event.type === 'tool/result' && eventTurn !== undefined && eventTurn <= turn) {
      const message = record(data?.message)
      const source = record(message?.source)
      const callId = nonEmptyString(source?.callId)
      const call = callId === undefined ? undefined : roots.get(callId)
      const liveCapture = callId === undefined ? undefined : captures.get(callId)
      if (call === undefined || call.turn !== eventTurn
        || (liveCapture !== undefined && (liveCapture.name !== call.name
          || !sameJson(liveCapture.arguments, call.arguments)))) continue
      const capture = liveCapture ?? reconstructedCapture(
        callId as string,
        call.name,
        call.arguments,
        data?.error !== undefined || message?.isError === true || hasErrorContent(message?.content),
        message?.content,
        // Current DSH persists presentation meta beside the message. Older or
        // bridged logs may carry the same private payload on the message.
        // Prefer that observed shape while retaining the canonical fallback.
        record(message?.meta) ?? record(data?.meta),
      )
      call.resultSeq = event.seq
      call.failed = data?.error !== undefined || message?.isError === true || hasErrorContent(message?.content)
      call.capture = capture
      continue
    }
    if (['tool/code-dispatch-start', 'tool/ptc-dispatch-start'].includes(event.type)) {
      const rootCallId = nonEmptyString(data?.rootCallId)
      const parentCallId = nonEmptyString(data?.parentCallId)
      const subCallId = nonEmptyString(data?.subCallId)
      const name = nonEmptyString(data?.name)
      if (rootCallId !== undefined && parentCallId !== undefined && subCallId !== undefined
        && name !== undefined && data !== undefined && Object.hasOwn(data, 'arguments')) {
        starts.set(subCallId, {
          rootCallId, parentCallId, name, arguments: data.arguments, callSeq: event.seq,
        })
      }
      continue
    }
    if (!['tool/code-dispatch', 'tool/ptc-dispatch'].includes(event.type)) continue
    const rootCallId = nonEmptyString(data?.rootCallId)
    const parentCallId = nonEmptyString(data?.parentCallId)
    const subCallId = nonEmptyString(data?.subCallId)
    const name = nonEmptyString(data?.name)
    const start = subCallId === undefined ? undefined : starts.get(subCallId)
    starts.delete(subCallId ?? '')
    if (rootCallId === undefined || parentCallId === undefined || subCallId === undefined
      || name === undefined || start === undefined || typeof data?.isError !== 'boolean'
      || !Array.isArray(data.content) || start.rootCallId !== rootCallId
      || start.parentCallId !== parentCallId || start.name !== name
      || !sameJson(start.arguments, data.arguments)) continue
    nested.push({
      rootCallId, parentCallId, subCallId, name, arguments: data.arguments,
      callSeq: start.callSeq,
      resultSeq: event.seq,
      failed: data.isError || hasErrorContent(data.content),
      content: data.content,
      meta: data.meta,
    })
  }

  const calls: DurableCall[] = []
  for (const [callId, call] of roots) {
    if (call.resultSeq === undefined || call.capture === undefined || call.failed === undefined) continue
    calls.push({
      callId,
      name: call.name,
      arguments: call.arguments,
      turn: call.turn,
      callSeq: call.callSeq,
      resultSeq: call.resultSeq,
      failed: call.failed,
      capture: call.capture,
      ...durableGeneration(generations, call.callSeq),
    })
  }
  for (const dispatch of nested) {
    const parent = roots.get(dispatch.parentCallId)
    const capture = captures.get(dispatch.subCallId) ?? reconstructedCapture(
      dispatch.subCallId,
      dispatch.name,
      dispatch.arguments,
      dispatch.failed,
      dispatch.content,
      record(dispatch.meta),
    )
    // Code Mode currently has one run_code transport level. Requiring both
    // ids to name that exact durable root prevents an event from another turn
    // or a forged composite envelope from entering this receipt.
    if (dispatch.rootCallId !== dispatch.parentCallId || parent?.name !== 'run_code'
      || parent.resultSeq === undefined || dispatch.resultSeq >= parent.resultSeq
      || capture === undefined || capture.name !== dispatch.name
      || !sameJson(capture.arguments, dispatch.arguments)) continue
    calls.push({
      callId: dispatch.subCallId,
      name: dispatch.name,
      arguments: dispatch.arguments,
      turn: parent.turn,
      callSeq: dispatch.callSeq,
      resultSeq: dispatch.resultSeq,
      failed: dispatch.failed,
      capture,
      ...durableGeneration(generations, dispatch.callSeq),
    })
  }
  return calls.sort((left, right) => left.resultSeq - right.resultSeq)
}

function taskGenerationHistory(events: readonly SessionEvent[]): TaskGenerationHistory {
  const generationEvents = events.filter(event => event.type === 'xiaoshe/task-generation')
  if (generationEvents.length === 0) return { protocol: 'absent', facts: [] }
  const facts: Array<{ seq: number; generation: number }> = []
  let current: number | undefined
  let previousSeq = -1
  let previousTriggerSeq = -1
  let lastUnsafeSeq = -1
  const anchors: Array<{ inputSeq: number; markerSeq: number }> = []
  const acceptedInputSeqs = new Set<number>()
  const markerCounts = new Map<string, number>()
  for (const event of generationEvents) {
    const id = nonEmptyString(record(event.data)?.triggerMessageId)
    if (id !== undefined) markerCounts.set(id, (markerCounts.get(id) ?? 0) + 1)
  }
  for (const event of generationEvents) {
    const data = record(event.data)
    const generation = nonNegativeInteger(data?.generation)
    const relation = nonEmptyString(data?.relation)
    const triggerMessageId = nonEmptyString(data?.triggerMessageId)
    const committed = data?.version === 2 && committedGenerationMessage(events, event)
    const legacy = data?.version === 1 && legacyGenerationMessage(events, event)
    if (event.seq <= previousSeq || (!legacy && !committed) || generation === undefined
      || (relation !== 'new' && relation !== 'continuation') || triggerMessageId === undefined
      || markerCounts.get(triggerMessageId) !== 1
      || (data?.version === 2 && (data.triggerMessageSeq as number) <= previousTriggerSeq)
      || (data?.version === 2 && current === undefined && relation === 'continuation')
      || (current !== undefined && relation === 'continuation' && generation !== current)
      || (current !== undefined && relation === 'new' && generation <= current)) {
      lastUnsafeSeq = Math.max(lastUnsafeSeq, event.seq)
      previousSeq = event.seq
      continue
    }
    facts.push({ seq: event.seq, generation })
    current = generation
    previousSeq = event.seq
    previousTriggerSeq = events.find(candidate => candidate.type === 'user/message' && record(candidate.data)?.id === triggerMessageId)!.seq
    acceptedInputSeqs.add(previousTriggerSeq)
    if (data?.version === 2 && relation === 'new') anchors.push({ inputSeq: data.triggerMessageSeq as number, markerSeq: event.seq })
  }
  // A direct input without its own valid admission cannot borrow the previous
  // task's identity, including an old orphan's trigger arriving after a new task.
  const firstInputSeq = Math.min(generationEvents[0]!.seq, ...acceptedInputSeqs)
  for (const event of events) {
    const message = record(event.data)
    if (event.seq >= firstInputSeq && event.type === 'user/message' && message?.role === 'user'
      && record(message.source)?.kind === 'user' && Array.isArray(message.content)
      && !acceptedInputSeqs.has(event.seq)) lastUnsafeSeq = Math.max(lastUnsafeSeq, event.seq)
  }
  if (lastUnsafeSeq < 0) return { protocol: 'valid', facts }
  const anchor = anchors.find(candidate => candidate.inputSeq > lastUnsafeSeq)
  // New work may recover from an old orphan, but its verifiers cannot prove
  // mutations whose task identity belonged to the quarantined prefix.
  return anchor === undefined ? { protocol: 'invalid', facts: [] }
    : { protocol: 'valid', facts: facts.filter(fact => fact.seq >= anchor.markerSeq) }
}

/** V1 stays pre-admission and may carry only its initial pending debt before the input. */
function legacyGenerationMessage(events: readonly SessionEvent[], marker: SessionEvent): boolean {
  const data = record(marker.data)
  if (data?.version !== 1 || Object.keys(data).some(key => !['version', 'generation', 'relation', 'triggerMessageId'].includes(key))) return false
  const matches = events.filter(event => event.type === 'user/message' && record(event.data)?.id === data.triggerMessageId)
  const input = matches[0], message = record(input?.data)
  if (matches.length !== 1 || input === undefined || input.seq <= marker.seq
    || message?.role !== 'user' || record(message.source)?.kind !== 'user' || !Array.isArray(message.content)) return false
  return !events.some(event => event.seq > marker.seq && event.seq < input.seq
    && (/^(?:tool\/|assistant\/|approval\/)/u.test(event.type)
      || event.type === 'verification/result' || event.type === 'turn/end' || event.type === 'xiaoshe/task-generation'
      || (event.type === 'user/message' && record(record(event.data)?.source)?.kind === 'user')))
}

/** A post-commit identity may refer only to one real direct input before any effects. */
function committedGenerationMessage(events: readonly SessionEvent[], marker: SessionEvent): boolean {
  const data = record(marker.data)
  const seq = nonNegativeInteger(data?.triggerMessageSeq)
  if (data?.version !== 2 || seq === undefined || !Number.isSafeInteger(marker.seq) || marker.seq <= seq
    || typeof data.triggerMessageId !== 'string' || data.triggerMessageId.trim() !== data.triggerMessageId
    || data.triggerMessageId.length === 0 || data.triggerMessageId.length > 512
    || Object.keys(data).some(key => !['version', 'generation', 'relation', 'triggerMessageId', 'triggerMessageSeq'].includes(key))) return false
  const messages = events.filter(event => event.type === 'user/message' && record(event.data)?.id === data.triggerMessageId)
  if (messages.length !== 1 || messages[0]?.seq !== seq || events.filter(event => event.seq === seq).length !== 1
    || events.filter(event => event.seq === marker.seq).length !== 1) return false
  const message = record(messages[0].data)
  if (message?.role !== 'user' || record(message.source)?.kind !== 'user' || !Array.isArray(message.content)) return false
  return !events.some(event => event.seq > seq && event.seq < marker.seq
    && (/^(?:tool\/|assistant\/|turn\/|approval\/)/u.test(event.type)
      || event.type === 'verification/result' || event.type === 'xiaoshe/obligation-state'))
}

function durableGeneration(
  history: TaskGenerationHistory,
  callSeq: number,
): Pick<DurableCall, 'generationProtocol' | 'taskGeneration'> {
  let generation: number | undefined
  if (history.protocol === 'valid') {
    for (const fact of history.facts) {
      if (fact.seq >= callSeq) break
      generation = fact.generation
    }
  }
  return {
    generationProtocol: history.protocol,
    ...(generation === undefined ? {} : { taskGeneration: generation }),
  }
}

function sameTaskGeneration(left: DurableCall, right: DurableCall): boolean {
  // Legacy logs have no durable goal boundary. Preserve same-turn behavior,
  // but never guess that a verifier in a later turn still belongs to the old
  // task; the new protocol is required for that continuation.
  if (left.generationProtocol === 'absent' && right.generationProtocol === 'absent') {
    return left.turn === right.turn
  }
  return left.generationProtocol === 'valid' && right.generationProtocol === 'valid'
    && left.taskGeneration !== undefined && left.taskGeneration === right.taskGeneration
}

/** A late result cannot prove new state if its verifier started before the effect settled. */
function verificationFollowsMutation(mutation: DurableCall, verifier: DurableCall, factSeq = Number.POSITIVE_INFINITY): boolean {
  return mutation.callSeq < mutation.resultSeq
    && mutation.resultSeq < verifier.callSeq
    && verifier.callSeq < verifier.resultSeq
    && verifier.resultSeq < factSeq
}

/** Bind a reconciled fact to the actual open turn instead of trusting its claimed turn number. */
function reconciliationTurnAt(events: readonly SessionEvent[], factSeq: number): number | undefined {
  let active: number | undefined
  for (const event of events) {
    if (event.seq >= factSeq) break
    const turn = nonNegativeInteger(record(event.data)?.turn)
    if (event.type === 'turn/start') active = turn
    else if (event.type === 'turn/end' && turn === active) active = undefined
  }
  return active
}

function reconstructedCapture(
  callId: string,
  name: string,
  args: unknown,
  isError: boolean,
  content: unknown,
  meta?: Record<string, unknown>,
): CapturedResult {
  const shell = SHELL_TOOLS.has(name) ? reconstructedShellValue(meta, content) : undefined
  const read = FILE_READ_TOOLS.has(name)
    ? validatedReadWindow(meta)
    : undefined
  const rendered = shell === undefined
    ? read ?? renderedJsonValue(content)
    : undefined
  return {
    callId,
    name,
    arguments: args,
    isError,
    ...(shell !== undefined ? { value: shell } : rendered === undefined ? {} : { value: rendered }),
  }
}

function shellCallFromEvent(event: SessionEvent): {
  readonly callId: string
  readonly arguments: unknown
} | undefined {
  const data = record(event.data)
  const name = nonEmptyString(data?.name)
  if (name === undefined || !SHELL_TOOLS.has(name)) return undefined
  const callId = event.type === 'tool/call'
    ? nonEmptyString(data?.callId)
    : ['tool/code-dispatch-start', 'tool/ptc-dispatch-start'].includes(event.type) ? nonEmptyString(data?.subCallId) : undefined
  if (callId === undefined) return undefined
  if (event.type === 'tool/call') {
    const parsed = parseArguments(data?.arguments)
    return parsed.ok ? { callId, arguments: parsed.value } : undefined
  }
  return Object.hasOwn(data ?? {}, 'arguments') ? { callId, arguments: data?.arguments } : undefined
}

function reconstructedShellValue(meta: Record<string, unknown> | undefined, content: unknown): unknown {
  const process = record(meta?.shellProcess)
  if (process?.kind !== 'foreground'
    || (typeof process.exitCode !== 'number' && process.exitCode !== null)
    || (typeof process.signal !== 'string' && process.signal !== null)
    || typeof process.timedOut !== 'boolean' || typeof process.aborted !== 'boolean') return undefined
  return {
    kind: 'foreground',
    exitCode: process.exitCode,
    signal: process.signal,
    timedOut: process.timedOut,
    aborted: process.aborted,
    stdout: { text: renderedText(content), truncated: false },
    stderr: { text: '', truncated: false },
  }
}

function renderedJsonValue(content: unknown): unknown {
  const text = renderedText(content).trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function renderedText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  const pending = [...content].reverse()
  while (pending.length > 0) {
    const block = record(pending.pop())
    if (block?.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
      continue
    }
    if (block?.type === 'tool-result' && Array.isArray(block.content)) {
      for (let index = block.content.length - 1; index >= 0; index -= 1) pending.push(block.content[index])
    }
  }
  return texts.join('\n')
}

function pruneCapturedResults(
  session: SessionLike,
  turn: number,
  captures: Map<string, CapturedResult>,
  policy: VerificationPolicy,
): void {
  const calls = durableCalls(readSessionEvents(session), turn, captures)
  const retain = new Set<string>()
  for (const call of calls) {
    const classification = policy.classifyTool({ toolName: call.name, arguments: call.arguments })
    const change = classification.change
    if (!classification.mutation || change === undefined || call.failed || call.capture.isError) continue
    const gates = new Set(policy.planTool({ toolName: call.name, ...change }).gates)
    if (gates.size === 0) continue
    const results = trustedProducedResults(readSessionEvents(session), call, calls, session, policy)
    if ([...gates].every(gate => results.get(gate)?.status === 'passed')) continue

    // Keep the mutation plus already-linked successful verifiers. Retaining
    // the latter lets a later turn re-check the complete evidence chain rather
    // than trusting an orphan verification/result when the remaining gates
    // eventually arrive.
    retain.add(call.callId)
    for (const result of results.values()) {
      if (result.status === 'passed') retain.add(result.verifierCallId)
    }
  }
  for (const callId of captures.keys()) {
    if (!retain.has(callId)) captures.delete(callId)
  }
}

function trustedProducedResults(
  events: readonly SessionEvent[],
  mutation: DurableCall,
  calls: readonly DurableCall[],
  session: SessionLike,
  policy: VerificationPolicy,
  acceptedVerifiers?: { readonly gates: ReadonlySet<VerificationGate>; readonly callIds: Set<string> },
): Map<VerificationGate, { readonly status: VerificationStatus; readonly verifierCallId: string }> {
  const byId = new Map(calls.map(call => [call.callId, call]))
  const latest = new Map<VerificationGate, { readonly status: VerificationStatus; readonly verifierCallId: string }>()
  for (const event of events) {
    if (event.type !== 'verification/result') continue
    const data = record(event.data)
    if (nonEmptyString(data?.mutationCallId) !== mutation.callId) continue
    const verifierCallId = nonEmptyString(data?.verifierCallId)
    const verifier = verifierCallId === undefined ? undefined : byId.get(verifierCallId)
    const eventTurn = nonNegativeInteger(data?.turn)
    const gate = nonEmptyString(data?.gate)
    const status = nonEmptyString(data?.status)
    const evidence = nonEmptyString(data?.evidence)
    if (verifier === undefined || verifier.callId === mutation.callId
      || eventTurn === undefined || eventTurn < verifier.turn
      || eventTurn !== reconciliationTurnAt(events, event.seq)
      || verifier.failed || verifier.capture.isError
      || !verificationFollowsMutation(mutation, verifier, event.seq)
      || !sameTaskGeneration(mutation, verifier)
      || (status !== 'passed' && status !== 'failed') || evidence === undefined) continue
    const candidate = verificationCandidates(verifier, session, calls, policy).find(item => item.gate === gate
      && item.status === status && item.evidence === evidence && item.matches(mutation, session))
    if (candidate === undefined) continue
    // Each accepted verifier retires its own opaque-shell debt. A later run
    // replaces the latest gate result, but must not resurrect an earlier run.
    if (candidate.status === 'passed' && acceptedVerifiers?.gates.has(candidate.gate)) {
      acceptedVerifiers.callIds.add(verifier.callId)
    }
    latest.set(candidate.gate, { status: candidate.status, verifierCallId: verifier.callId })
  }
  return latest
}

function verificationCandidates(
  verifier: DurableCall,
  session: SessionLike,
  calls: readonly DurableCall[],
  policy: VerificationPolicy,
): Candidate[] {
  if (SHELL_TOOLS.has(verifier.name)) return shellCandidates(verifier, session, calls, policy)
  if (verifier.name === 'screen_verify') return windowsCandidates(verifier)
  if (verifier.name === 'browser_verify') return browserCandidates(verifier, calls)
  if (verifier.name === 'xiaoshe_memory_list') return memoryCandidates(verifier)
  if (verifier.name === 'schedule_list') return scheduleCandidates(verifier)
  if (FILE_READ_TOOLS.has(verifier.name)) return fileReadbackCandidates(verifier, session, calls)
  return []
}

function fileReadbackCandidates(
  verifier: DurableCall,
  session: SessionLike,
  calls: readonly DurableCall[],
): Candidate[] {
  if (verifier.name === 'read' && !verifier.failed && !verifier.capture.isError
    && verifier.capture.jsonlProof?.kind === 'read') {
    const current = captureJsonlRead(verifier.arguments, verifier.capture.value, session.header.cwd)
    if (!current || !sameJsonlProof(current, verifier.capture.jsonlProof)) return []
    return [{ gate: 'functional-probe', status: 'passed',
      evidence: evidence([`verifier=${verifier.callId}`, 'format=jsonl', 'host_full_read=true',
        `rows=${jsonlRows(current.content)}`, `content_sha256=${current.identity.contentSha256}`]),
      matches: mutation => {
        let proof = mutation.capture.jsonlProof
        if (proof?.kind !== 'mutation' || !['edit', 'write'].includes(mutation.name)
          || verifier.callSeq <= mutation.resultSeq) return false
        // A later authorized edit supersedes the earlier bytes, not their
        // verification debt. Follow only contiguous host-observed baselines.
        for (const later of calls.filter(call => call.callSeq > mutation.resultSeq
          && call.resultSeq < verifier.callSeq && sameTaskGeneration(mutation, call))
          .sort((a, b) => a.callSeq - b.callSeq)) {
          const next = later.capture.jsonlProof
          if (!later.failed && !later.capture.isError && next?.kind === 'mutation'
            && next.before && sameOutputIdentity(proof.identity, next.before.identity)
            && proof.content === next.before.content) proof = next
        }
        return sameJsonlProof(proof, current)
      },
    }]
  }
  if (verifier.failed || verifier.capture.isError || verifier.capture.fileProof?.kind !== 'read') return []
  const args = record(verifier.arguments)
  // A ranged read can equal the expected prefix while hiding trailing bytes;
  // only a whole-file invocation is strong enough to close exact-read debt.
  if (args === undefined || ['offset', 'limit', 'start', 'end', 'range', 'line', 'lines',
    'start_line', 'end_line', 'line_start', 'line_end'].some(key => Object.hasOwn(args, key))) return []
  const target = mutationTargetPath(verifier.name, verifier.arguments, session.header.cwd)
  const currentProof = captureFileProof(
    verifier.name,
    verifier.arguments,
    verifier.capture.value,
    session.header.cwd,
  )
  if (target === undefined || currentProof?.kind !== 'read'
    || currentProof.targetKey !== verifier.capture.fileProof.targetKey
    || currentProof.content !== verifier.capture.fileProof.content) return []
  const actual = currentProof.content
  const parsed = parseJsonDocument(actual)
  const document = isPlainDocumentWrite('write', { file_path: target, content: actual })
  if (!parsed.ok && !document) return []
  return [{
    gate: 'functional-probe',
    status: 'passed',
    evidence: evidence([
      `verifier=${verifier.callId}`,
      `tool=${verifier.name}`,
      `target=${target}`,
      'offset=1',
      'truncated=false',
      `target_key_sha256=${digest(currentProof.targetKey)}`,
      `content_sha256=${digest(actual)}`,
      ...(parsed.ok ? [`json_shape_sha256=${digest(JSON.stringify(jsonTypeShape(parsed.value)))}`] : ['format=plain-document']),
    ]),
    matches: mutation => exactStaticJsonReadbackMatches(
      mutation,
      verifier,
      currentProof,
      target,
      parsed.ok ? parsed.value : undefined,
      calls,
      session.header.cwd,
    ),
  }]
}

function exactStaticJsonReadbackMatches(
  mutation: DurableCall,
  verifier: DurableCall,
  readProof: CapturedFileProof,
  readTarget: string,
  actualJson: unknown,
  calls: readonly DurableCall[],
  sessionCwd: string | undefined,
): boolean {
  const args = record(mutation.arguments)
  const expected = typeof args?.content === 'string' ? args.content : undefined
  const mutationTarget = mutationTargetPath(mutation.name, mutation.arguments, sessionCwd)
  const writeProof = mutation.capture.fileProof
  if (mutation.name !== 'write' || writeProof?.kind !== 'write'
    || expected === undefined || mutationTarget === undefined || !samePath(mutationTarget, readTarget)
    || !sameOutputIdentity(writeProof.identity, readProof.identity) || verifier.resultSeq <= mutation.resultSeq
    || !latestStaticJsonWrite(mutation, mutationTarget, calls, sessionCwd)) return false
  const parsed = parseJsonDocument(expected)
  if (isPlainDocumentWrite(mutation.name, mutation.arguments)) return expected === readProof.content
  return parsed.ok && sameJsonValue(parsed.value, actualJson)
    && sameJsonValue(jsonTypeShape(parsed.value), jsonTypeShape(actualJson))
}

function latestStaticJsonWrite(
  mutation: DurableCall,
  target: string,
  calls: readonly DurableCall[],
  cwd: string | undefined,
): boolean {
  return !calls.some(candidate => candidate.callId !== mutation.callId
    && candidate.name === 'write' && !candidate.failed && !candidate.capture.isError
    && candidate.resultSeq > mutation.resultSeq
    && samePath(mutationTargetPath(candidate.name, candidate.arguments, cwd) ?? '', target))
}

function writeProofBinding(session: SessionLike, call: DurableCall): WriteProofBinding | undefined {
  const args = record(call.arguments)
  const content = typeof args?.content === 'string' ? args.content : undefined
  const parsed = content === undefined ? { ok: false as const } : parseJsonDocument(content)
  const id = session.header.id
  const createdAt = session.header.createdAt
  const document = isPlainDocumentWrite(call.name, call.arguments)
  if (call.name !== 'write' || call.failed || call.capture.isError || (!parsed.ok && !document)
    || content === undefined || call.generationProtocol !== 'valid' || call.taskGeneration === undefined
    || id === undefined || createdAt === undefined || !Number.isFinite(createdAt)) return undefined
  return {
    sessionId: id, sessionCreatedAt: createdAt, generation: call.taskGeneration,
    callId: call.callId, callSeq: call.callSeq, resultSeq: call.resultSeq,
    argumentsSha256: digest(JSON.stringify(call.arguments)), contentSha256: digest(content),
    shapeSha256: digest(parsed.ok ? JSON.stringify(jsonTypeShape(parsed.value)) : 'plain-document'),
  }
}

/**
 * Bind a first-party whole-file result to the file that exists on disk now.
 * Presentation text is insufficient. Live FD identity is captured here; only
 * the host-side sealed write fact may cross a process boundary. Read evidence
 * must always come from a fresh real whole-file invocation after that boundary.
 */
function captureFileProof(
  toolName: string,
  rawArgs: unknown,
  rawValue: unknown,
  sessionCwd: string | undefined,
): CapturedFileProof | undefined {
  const args = record(rawArgs)
  const value = record(rawValue)
  const requested = nonEmptyString(args?.file_path)
  const resultPath = nonEmptyString(value?.path)
  if (args === undefined || value === undefined || requested === undefined || resultPath === undefined) return undefined
  const requestedPath = resolvePath(requested, sessionCwd)
  const returnedPath = resolvePath(resultPath, sessionCwd)
  if (requestedPath === undefined || returnedPath === undefined || !samePath(requestedPath, returnedPath)) return undefined

  const current = observeOutputFile(requestedPath, sessionCwd)
  if (current === undefined) return undefined
  if (toolName === 'write') {
    const content = typeof args.content === 'string' ? args.content : undefined
    const before = value.before
    if (content === undefined || (value.operation !== 'create' && value.operation !== 'update')
      || (typeof before !== 'string' && before !== null) || value.after !== content
      || current.content !== content) return undefined
    return { kind: 'write', targetKey: current.targetKey, content, identity: current.identity }
  }
  if (toolName !== 'read' || Object.keys(args).some(key => key !== 'file_path')) return undefined
  const window = validatedReadWindow(rawValue)
  if (window === undefined || !structuredReadMatchesFile(window, current.content)) return undefined
  return { kind: 'read', targetKey: current.targetKey, content: current.content, identity: current.identity }
}

function structuredReadMatchesFile(window: ValidatedReadWindow, content: string): boolean {
  const expected = fileLines(content)
  return window.totalLines === expected.length && window.lines.length === expected.length
    && window.lines.every((line, index) => line.number === index + 1 && line.text === expected[index])
}

/** Mirror DSH's line semantics: a terminal newline closes, but does not add, an extra line. */
function fileLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
  if (content.endsWith('\n')) lines.pop()
  return lines
}

interface ValidatedReadWindow {
  readonly path: string
  readonly offset: 1
  readonly lines: readonly { readonly number: number; readonly text: string }[]
  readonly totalLines: number
}

function validatedReadWindow(value: unknown): ValidatedReadWindow | undefined {
  const input = record(value)
  if (input === undefined) return undefined
  const path = nonEmptyString(input?.path)
  const offset = nonNegativeInteger(input?.offset)
  const totalLines = nonNegativeInteger(input?.totalLines)
  const rawLines = Array.isArray(input?.lines) ? input.lines : undefined
  if (path === undefined || offset !== 1 || totalLines === undefined || rawLines === undefined
    || ['truncatedByBytes', 'truncated', 'spilled'].some(key => Object.hasOwn(input, key) && input[key] !== false)
    || (Object.hasOwn(input, 'spill') && input.spill !== null && input.spill !== false)
    || rawLines.length !== totalLines) return undefined
  const lines: Array<{ readonly number: number; readonly text: string }> = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = record(rawLines[index])
    if (nonNegativeInteger(line?.number) !== index + 1 || typeof line?.text !== 'string') return undefined
    lines.push({ number: index + 1, text: line.text })
  }
  return { path, offset: 1, lines, totalLines }
}

function parseJsonDocument(value: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown }
  } catch {
    return { ok: false }
  }
}

function jsonTypeShape(value: unknown): unknown {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.map(item => jsonTypeShape(item))
  const object = record(value)
  if (object !== undefined) return Object.fromEntries(
    Object.keys(object).sort().map(key => [key, jsonTypeShape(object[key])]),
  )
  return typeof value
}

/** JSON.parse alone rounds distinct numeric tokens to the same JS number.
 * Compare a typed canonical tree too, using the runtime's actual primitive
 * source tokens. No floating-point arithmetic, document keys or fixture schema
 * are involved; missing source-token support fails closed for numbers.
 */
function sameDeliveredJson(source: string, payload: string): boolean {
  const tree = (text: string): unknown => JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number') {
      const token = context?.source
      if (!token || token.length > 2_048) throw new Error('numeric source unavailable')
      const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu.exec(token)
      if (!match) throw new Error('invalid numeric source')
      let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/u, '')
      let exponent = BigInt(match[4] ?? '0') - BigInt((match[3] ?? '').length)
      if (!digits) return ['number', match[1] === '-' ? '-0' : '0']
      const trailing = /0+$/u.exec(digits)?.[0].length ?? 0
      if (trailing) { digits = digits.slice(0, -trailing); exponent += BigInt(trailing) }
      return ['number', `${match[1]}${digits}e${exponent}`]
    }
    if (value === null) return ['null']
    if (typeof value !== 'object') return [typeof value, value]
    return Array.isArray(value) ? ['array', value]
      : ['object', Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]
  })
  try { return sameJsonValue(tree(source), tree(payload)) } catch { return false }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return Object.is(left, right)
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]))
  }
  const leftObject = record(left)
  const rightObject = record(right)
  if (leftObject === undefined || rightObject === undefined) return false
  const leftKeys = Object.keys(leftObject).sort()
  const rightKeys = Object.keys(rightObject).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameJsonValue(leftObject[key], rightObject[key]))
}

function shellCandidates(
  verifier: DurableCall,
  session: SessionLike,
  calls: readonly DurableCall[],
  policy: VerificationPolicy,
): Candidate[] {
  const args = record(verifier.arguments)
  const command = nonEmptyString(args?.command)
  if (command === undefined) return []
  const workdir = resolvePath(nonEmptyString(args?.workdir), session.header.cwd)
  const packageInvocation = commandInvokesPackageScript(command)
  const classification = packageInvocation
    ? verifier.capture.boundShellClassification
    : classifyVerificationCommandDetailed(command, workdir)
  if (classification === undefined || classification.gates.length === 0) return []
  const gates = classification.gates

  const result = shellOutcome(verifier.capture)
  // For a failed conjunction it is impossible to prove which later segment
  // executed. Leave every gate unresolved instead of assigning false failures.
  if (result.status === 'failed' && gates.length > 1) return []
  if (result.status === undefined) return []
  const outputHash = result.output === undefined ? 'none' : digest(result.output)
  return gates.flatMap(gate => {
    if (gate === 'test' && result.status === 'passed'
      && classification.needsPositiveTestSummary === true
      && !hasPositiveTestSummary(result.output)) return []
    return [{
    gate,
    status: result.status as VerificationStatus,
    evidence: evidence([
      `verifier=${verifier.callId}`,
      `tool=${verifier.name}`,
      `gate=${gate}`,
      `command=${command}`,
      `workdir=${nonEmptyString(args?.workdir) ?? '<session-cwd>'}`,
      `outcome=${result.label}`,
      `output_sha256=${outputHash}`,
      ...(classification.packageGraphs.length === 0 ? [] : [
        `package_graph_sha256=${digest(JSON.stringify(classification.packageGraphs))}`,
      ]),
    ]),
    matches: (mutation, session) => workspaceMatches(mutation, args, session.header.cwd)
      && packageGraphsUntainted(classification.packageGraphs, mutation, verifier, calls, policy, session.header.cwd)
      && (gate !== 'test' || classification.testTargets === undefined
        || targetedTestMatches(mutation, classification.testTargets, args, session.header.cwd)),
    }]
  })
}

function windowsCandidates(verifier: DurableCall): Candidate[] {
  if (verifier.failed || verifier.capture.isError) return []
  const args = record(verifier.arguments)
  const value = record(verifier.capture.value)
  const current = record(value?.current)
  const baseline = nonEmptyString(args?.viewport_id)
  const currentViewport = nonEmptyString(current?.viewport_id)
  const sha256 = nonEmptyString(current?.sha256)
  const added = Array.isArray(value?.added) ? value.added : undefined
  const removed = Array.isArray(value?.removed) ? value.removed : undefined
  if (baseline === undefined || value?.status !== 'verified'
    || nonEmptyString(value?.baseline_viewport_id) !== baseline
    || currentViewport === undefined || sha256 === undefined || !/^[a-f0-9]{64}$/iu.test(sha256)
    || added === undefined || removed === undefined) return []
  const changed = value?.changed === true
  const changedElements = [...added, ...removed].flatMap(item => {
    const element = record(item)
    const id = nonEmptyString(element?.id)
    const ref = nonEmptyString(element?.ref)
    const name = nonEmptyString(element?.name)
    return id === undefined && ref === undefined && name === undefined ? [] : [{ id, ref, name }]
  })
  // A changed screenshot alone is not an asserted UI postcondition: clocks,
  // cursors, animations and notifications all move pixels. A successful gate
  // therefore needs a structural accessibility diff that includes the exact
  // element targeted by the mutation. No change remains useful failed proof.
  if (changed && (currentViewport === baseline || changedElements.length === 0)) return []
  return [{
    gate: 'windows-evidence',
    status: changed ? 'passed' : 'failed',
    evidence: evidence([
      `verifier=${verifier.callId}`,
      'tool=screen_verify',
      `baseline=${baseline}`,
      `current=${currentViewport}`,
      `changed=${String(changed)}`,
      `added=${String(added.length)}`,
      `removed=${String(removed.length)}`,
      `screenshot_sha256=${sha256}`,
    ]),
    matches: mutation => {
      const mutationArgs = record(mutation.arguments)
      const mutationValue = record(mutation.capture.value)
      const after = record(mutationValue?.after)
      const expectedAction = actionForTool(mutation.name)
      const mutationBaseline = nonEmptyString(mutationValue?.before_viewport_id)
      const requestedBaseline = nonEmptyString(mutationArgs?.viewport_id)
      const actionTarget = nonEmptyString(mutationValue?.target)
      if (expectedAction === undefined || mutationValue?.status !== 'completed'
        || mutationValue.action !== expectedAction || mutationBaseline !== baseline
        || (requestedBaseline !== undefined && requestedBaseline !== baseline)
        || nonEmptyString(after?.viewport_id) === undefined
        || nonEmptyString(after?.sha256) === undefined
        || mutationValue?.changed !== true
        || !windowsActionMatchesArguments(mutation.name, mutationArgs, actionTarget)) return false
      if (!changed) return true
      const mutationChanged = structuralElements(mutationValue?.added, mutationValue?.removed)
      // The independent read must reproduce at least one exact AX/UIA state
      // transition already observed immediately after this action. This works
      // for input, key, coordinate-click and focus actions without pretending
      // that their argument string is itself an accessibility element id.
      return mutationChanged.length > 0 && changedElements.some(currentElement =>
        mutationChanged.some(actionElement => structuralElementEquals(currentElement, actionElement)),
      )
    },
  }]
}

function windowsActionMatchesArguments(
  toolName: string,
  args: Record<string, unknown> | undefined,
  target: string | undefined,
): boolean {
  if (args === undefined || target === undefined) return false
  if (toolName === 'screen_type') {
    const input = stringValue(args.text)
    return input !== undefined && target === `text:${[...input].length} chars`
  }
  if (toolName === 'screen_press') {
    const keys = nonEmptyString(args.keys)
    return keys !== undefined && target === `keys:${keys}`
  }
  if (toolName === 'screen_focus_window') {
    const title = nonEmptyString(args.title)
    const windowId = nonEmptyString(args.window_id)
    return title !== undefined && windowId !== undefined && target === title
  }
  if (toolName === 'screen_click') {
    const elementId = nonEmptyString(args.element_id)
    if (elementId !== undefined) return target === `element:${elementId}` || target.startsWith(`element:${elementId}:`)
    return Number.isInteger(args.image_x) && Number.isInteger(args.image_y)
      && /^screen:-?\d+,-?\d+$/u.test(target)
  }
  return false
}

interface StructuralElement {
  readonly id: string | undefined
  readonly ref: string | undefined
  readonly name: string | undefined
}

function structuralElements(...values: unknown[]): StructuralElement[] {
  return values.flatMap(value => Array.isArray(value) ? value : []).flatMap(item => {
    const element = record(item)
    const id = nonEmptyString(element?.id)
    const ref = nonEmptyString(element?.ref)
    const name = nonEmptyString(element?.name)
    return id === undefined && ref === undefined && name === undefined ? [] : [{ id, ref, name }]
  })
}

function structuralElementEquals(
  left: StructuralElement,
  right: StructuralElement,
): boolean {
  return (left.id !== undefined && left.id === right.id)
    || (left.ref !== undefined && left.ref === right.ref)
    || (left.name !== undefined && left.name === right.name)
}

interface BrowserExpectations {
  readonly expectClosed?: true
  readonly expectUrl?: string
  readonly expectText?: string
  readonly expectElementId?: string
  readonly expectValue?: string
  readonly expectScrollY?: number
}

/**
 * A browser action's own returned snapshot is useful context, never independent
 * proof. `browser_verify` must name that exact snapshot as its baseline and then
 * perform a fresh, structured observation in the same private tab and owner.
 */
function browserCandidates(verifier: DurableCall, calls: readonly DurableCall[]): Candidate[] {
  if (verifier.failed || verifier.capture.isError) return []
  const args = record(verifier.arguments)
  const value = record(verifier.capture.value)
  let expectations = browserExpectations(args)
  const returned = browserExpectations(record(value?.assertions))
  const tabId = nonEmptyString(args?.tab_id)
  const ownerId = nonEmptyString(value?.owner_id)
  let inputAction: DurableCall | undefined
  if (args !== undefined && Object.hasOwn(args, 'use_action_input')) {
    if (args.use_action_input !== true || ['expect_element_id', 'expect_value', 'expect_closed',
      'expectElementId', 'expectValue', 'expectClosed'].some(key => Object.hasOwn(args, key))
      || tabId === undefined || ownerId === undefined) return []
    const baseline = nonEmptyString(args.after_snapshot_id)
    if (baseline === undefined) return []
    const inputs = calls.filter(call => call.name === 'browser_type' && !call.failed && !call.capture.isError
      && verificationFollowsMutation(call, verifier) && sameTaskGeneration(call, verifier)
      && record(call.arguments)?.tab_id === tabId
      && canonicalBrowserSnapshot(record(call.capture.value), tabId, ownerId)
      && record(call.capture.value)?.snapshot_id === baseline)
    if (inputs.length !== 1) return []
    const action = inputs[0]
    if (action === undefined) return []
    inputAction = action
    const inputArgs = record(action.arguments)
    const element = boundedString(inputArgs?.element_id, 64, false)
    const input = boundedString(inputArgs?.text, 2_000, true)
    if (element === undefined || input === undefined) return []
    // Reconstruct from the actual earlier successful call, never from returned
    // assertions, page text or a provenance label. A later observation/action
    // on this tab invalidates the reference even if its final DOM looks equal.
    const stateCommands = new Set(['browser_open', 'browser_snapshot', 'browser_type', 'browser_click',
      'browser_press', 'browser_scroll', 'browser_verify', 'browser_close'])
    if (calls.some(call => call !== action && stateCommands.has(call.name) && !call.failed && !call.capture.isError
      && call.resultSeq > action.resultSeq && call.callSeq < verifier.callSeq
      && (record(call.arguments)?.tab_id === tabId || record(call.capture.value)?.tab_id === tabId))) return []
    const source = record(value?.assertion_source)
    const expectedSource = { kind: 'browser_type_input', owner_id: ownerId, tab_id: tabId,
      baseline_snapshot_id: baseline, expect_element_id: element, input_sha256: digest(input) }
    if (source === undefined || Object.keys(source).length !== Object.keys(expectedSource).length
      || Object.entries(expectedSource).some(([key, expected]) => source[key] !== expected)) return []
    for (const snapshot of [record(action.capture.value), record(value?.current)]) {
      const elements = Array.isArray(snapshot?.elements)
        ? snapshot.elements.map(record).filter(item => item?.element_id === element) : []
      if (elements.length !== 1 || elements[0]?.value !== input) return []
    }
    expectations = browserExpectations({ ...args, expect_element_id: element, expect_value: input })
  } else if (value !== undefined && Object.hasOwn(value, 'assertion_source')) return []
  if (expectations === undefined || returned === undefined || tabId === undefined
    || ownerId === undefined || nonEmptyString(value?.tab_id) !== tabId
    || JSON.stringify(expectations) !== JSON.stringify(returned)) return []

  if (expectations.expectClosed === true) {
    const observed = record(value?.observed)
    if (value?.status !== 'verified' || observed?.closed !== true) return []
    return [{
      gate: 'browser',
      status: 'passed',
      evidence: evidence([
        `verifier=${verifier.callId}`,
        'tool=browser_verify',
        `tab=${tabId}`,
        `owner=${ownerId}`,
        'postcondition=closed',
      ]),
      matches: mutation => {
        const mutationValue = record(mutation.capture.value)
        return mutation.name === 'browser_close'
          && mutationValue?.closed === true
          && nonEmptyString(mutationValue.tab_id) === tabId
          && nonEmptyString(mutationValue.owner_id) === ownerId
      },
    }]
  }

  const baseline = nonEmptyString(args?.after_snapshot_id)
  const returnedBaseline = nonEmptyString(value?.baseline_snapshot_id)
  const current = record(value?.current)
  if (baseline === undefined || returnedBaseline !== baseline || value?.status !== 'verified'
    || !canonicalBrowserSnapshot(current, tabId, ownerId)
    || nonEmptyString(current?.snapshot_id) === baseline
    || inputAction !== undefined && nonEmptyString(value?.snapshot_id) !== nonEmptyString(current?.snapshot_id)
    || !browserSnapshotMatches(current, expectations)) return []

  return [{
    gate: 'browser',
    status: 'passed',
    evidence: evidence([
      `verifier=${verifier.callId}`,
      'tool=browser_verify',
      `tab=${tabId}`,
      `owner=${ownerId}`,
      `baseline=${baseline}`,
      `current=${nonEmptyString(current?.snapshot_id)}`,
      `assertions_sha256=${digest(JSON.stringify(expectations))}`,
      `snapshot_sha256=${digest(JSON.stringify(current))}`,
    ]),
    matches: mutation => {
      if (inputAction !== undefined && mutation.callId !== inputAction.callId) return false
      if (!['browser_open', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll'].includes(mutation.name)) return false
      const mutationArgs = record(mutation.arguments)
      const mutationValue = record(mutation.capture.value)
      if (!canonicalBrowserSnapshot(mutationValue, tabId, ownerId)
        || nonEmptyString(mutationValue?.snapshot_id) !== baseline
        || !browserSnapshotMatches(mutationValue, expectations)) return false

      if (mutation.name === 'browser_open') {
        return expectations.expectUrl !== undefined
          && expectations.expectUrl === nonEmptyString(mutationValue?.url)
      }
      if (mutation.name === 'browser_type') {
        return expectations.expectElementId !== undefined
          && expectations.expectValue !== undefined
          && expectations.expectValue === stringValue(mutationArgs?.text)
      }
      if (mutation.name === 'browser_scroll') {
        return expectations.expectScrollY !== undefined
          && expectations.expectScrollY === record(mutationValue?.viewport)?.scroll_y
      }
      return true
    },
  }]
}

function browserExpectations(value: Record<string, unknown> | undefined): BrowserExpectations | undefined {
  if (value === undefined) return undefined
  const expectClosed = value.expect_closed === true || value.expectClosed === true
  const expectUrl = boundedString(value.expect_url ?? value.expectUrl, 2_048, false)
  const expectText = boundedString(value.expect_text ?? value.expectText, 1_000, false)
  const expectElementId = boundedString(value.expect_element_id ?? value.expectElementId, 64, false)
  const expectValue = boundedString(value.expect_value ?? value.expectValue, 2_000, true)
  const rawScrollY = value.expect_scroll_y ?? value.expectScrollY
  const expectScrollY = typeof rawScrollY === 'number' && Number.isSafeInteger(rawScrollY) ? rawScrollY : undefined
  if (expectValue !== undefined && expectElementId === undefined) return undefined
  if (expectClosed) {
    if (expectUrl !== undefined || expectText !== undefined || expectElementId !== undefined
      || expectValue !== undefined || expectScrollY !== undefined) return undefined
    return { expectClosed: true }
  }
  const result: BrowserExpectations = {
    ...(expectUrl === undefined ? {} : { expectUrl }),
    ...(expectText === undefined ? {} : { expectText }),
    ...(expectElementId === undefined ? {} : { expectElementId }),
    ...(expectValue === undefined ? {} : { expectValue }),
    ...(expectScrollY === undefined ? {} : { expectScrollY }),
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function canonicalBrowserSnapshot(
  snapshot: Record<string, unknown> | undefined,
  tabId: string,
  ownerId: string,
): boolean {
  return snapshot !== undefined
    && nonEmptyString(snapshot.snapshot_id) !== undefined
    && nonEmptyString(snapshot.tab_id) === tabId
    && nonEmptyString(snapshot.owner_id) === ownerId
    && snapshot.source === 'isolated-browser-dom'
    && snapshot.content_is_untrusted === true
    && typeof snapshot.text === 'string'
    && Array.isArray(snapshot.elements)
}

function browserSnapshotMatches(
  snapshot: Record<string, unknown> | undefined,
  expectations: BrowserExpectations,
): boolean {
  if (snapshot === undefined || expectations.expectClosed === true) return false
  if (expectations.expectUrl !== undefined && snapshot.url !== expectations.expectUrl) return false
  if (expectations.expectText !== undefined
    && (typeof snapshot.text !== 'string' || !snapshot.text.includes(expectations.expectText))) return false
  if (expectations.expectScrollY !== undefined
    && record(snapshot.viewport)?.scroll_y !== expectations.expectScrollY) return false
  if (expectations.expectElementId !== undefined) {
    const elements = Array.isArray(snapshot.elements) ? snapshot.elements : []
    const element = elements.map(record).find(item => item?.element_id === expectations.expectElementId)
    if (element === undefined || (expectations.expectValue !== undefined && element.value !== expectations.expectValue)) return false
  }
  return true
}

function boundedString(value: unknown, max: number, allowEmpty: boolean): string | undefined {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Admit only complete official session-local views, never success prose or error unions. */
function scheduleView(value: unknown): Record<string, unknown> | undefined {
  const view = record(value)
  if (view === undefined || !/^schedule-[1-9]\d*$/u.test(nonEmptyString(view.id) ?? '')
    || typeof view.prompt !== 'string' || view.prompt.trim() === '' || view.prompt !== view.prompt.trim()
    || view.deliveryMode !== 'session-local' || !['scheduled', 'overdue'].includes(String(view.state))
    || typeof view.scheduledAt !== 'string' || !Number.isFinite(Date.parse(view.scheduledAt))
    || new Date(view.scheduledAt).toISOString() !== view.scheduledAt) return undefined
  const positive = (value: unknown, min: number): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
  if (view.kind === 'after' ? !positive(view.afterSeconds, 1)
    : view.kind === 'every' ? !positive(view.everySeconds, 300) : view.kind !== 'at') return undefined
  const fields = new Set(['id', 'kind', 'prompt', 'scheduledAt', 'state', 'deliveryMode',
    ...(view.kind === 'after' ? ['afterSeconds'] : view.kind === 'every' ? ['everySeconds'] : [])])
  return Object.keys(view).every(key => fields.has(key)) ? view : undefined
}

/** Creation proof certifies registration; it makes no claim about future dispatch or receipt. */
function scheduleCandidates(verifier: DurableCall): Candidate[] {
  if (verifier.failed || verifier.capture.isError || !Array.isArray(verifier.capture.value)
    || Object.keys(record(verifier.arguments) ?? { invalid: true }).length !== 0) return []
  const views = verifier.capture.value.map(scheduleView)
  if (views.some(view => view === undefined)) return []
  const entries = views as Record<string, unknown>[]
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) return []
  return [{
    gate: 'functional-probe', status: 'passed',
    evidence: evidence([`verifier=${verifier.callId}`, 'tool=schedule_list', 'scope=session-local',
      'proof=reminder-record-state', `snapshot_sha256=${digest(JSON.stringify(entries))}`]),
    matches: (mutation, session) => scheduleReadbackMatches(mutation, entries, session),
  }]
}

/** Bind the list to an actual in-call schedule event, independently of the mutation's own result. */
function scheduleReadbackMatches(mutation: DurableCall, entries: readonly Record<string, unknown>[], session: SessionLike): boolean {
  const args = record(mutation.arguments), result = record(mutation.capture.value)
  if (args === undefined || result === undefined) return false
  const changes = readSessionEvents(session).filter(event => event.type === 'schedule/change'
    && event.seq > mutation.callSeq && event.seq < mutation.resultSeq).map(event => record(event.data))
  if (mutation.name === 'schedule_delete') {
    const id = nonEmptyString(args.id)
    if (id === undefined || result.id !== id || entries.some(entry => entry.id === id)) return false
    if (result.deleted === false) return result.code === 'schedule_not_found'
    return result.deleted === true && result.code === undefined
      && changes.some(change => change?.version === 1 && change.operation === 'delete' && change.id === id)
  }
  if (mutation.name !== 'schedule_create') return false
  const created = scheduleView(result)
  if (created === undefined || typeof args.prompt !== 'string' || created.prompt !== args.prompt.trim()
    || [args.after_seconds, args.at, args.every_seconds].filter(value => value !== undefined).length !== 1) return false
  if (created.kind === 'after' ? args.after_seconds !== created.afterSeconds
    : created.kind === 'every' ? args.every_seconds !== created.everySeconds : args.at === undefined) return false
  // The canonical create event is produced by DSH only after validating delay,
  // RFC3339/IANA targets, and selectors. Do not reimplement its timezone rules.
  const sameRecord = (view: Record<string, unknown> | undefined): boolean => view !== undefined
    && ['id', 'kind', 'prompt', 'scheduledAt', 'afterSeconds', 'everySeconds'].every(key => view[key] === created[key])
  return changes.some(change => change?.version === 1 && change.operation === 'create' && sameRecord(record(change.schedule)))
    && entries.some(sameRecord)
}

function memoryCandidates(verifier: DurableCall): Candidate[] {
  if (verifier.failed || verifier.capture.isError) return []
  const args = record(verifier.arguments)
  const snapshot = record(verifier.capture.value)
  const revision = nonNegativeInteger(snapshot?.revision)
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : undefined
  if (snapshot?.api_version !== 1 || revision === undefined || entries === undefined) return []
  return [{
    gate: 'functional-probe',
    status: 'passed',
    evidence: evidence([
      `verifier=${verifier.callId}`,
      'tool=xiaoshe_memory_list',
      `scope=${nonEmptyString(args?.scope) ?? '<default>'}`,
      `project=${nonEmptyString(args?.project) ?? '<none>'}`,
      `revision=${String(revision)}`,
      `snapshot_sha256=${digest(JSON.stringify(snapshot))}`,
    ]),
    matches: mutation => memoryReadbackMatches(mutation, args, entries, revision),
  }]
}

function memoryReadbackMatches(
  mutation: DurableCall,
  query: Record<string, unknown> | undefined,
  rawEntries: readonly unknown[],
  readRevision: number,
): boolean {
  const mutationArgs = record(mutation.arguments)
  const mutationSnapshot = record(mutation.capture.value)
  const mutationRevision = nonNegativeInteger(mutationSnapshot?.revision)
  if (mutationSnapshot?.api_version !== 1 || mutationRevision === undefined
    || readRevision < mutationRevision) return false
  const entries = rawEntries.flatMap(value => {
    const entry = record(value)
    return entry === undefined ? [] : [entry]
  })

  if (mutation.name === 'xiaoshe_memory_remember') {
    const scope = nonEmptyString(mutationArgs?.scope)
    const text = nonEmptyString(mutationArgs?.text)?.trim()
    if ((scope !== 'global' && scope !== 'project') || text === undefined
      || !memoryQueryIncludesScope(query, scope)) return false
    const mutationEntries = Array.isArray(mutationSnapshot.entries) ? mutationSnapshot.entries : []
    const audit = Array.isArray(mutationSnapshot.audit) ? mutationSnapshot.audit : []
    const auditEntryId = audit.flatMap(value => {
      const row = record(value)
      return row?.revision === mutationRevision
        && (row.action === 'create' || row.action === 'edit')
        && (mutationArgs?.replaces_id === undefined || row.previous_entry_id === mutationArgs.replaces_id)
        ? [nonEmptyString(row.entry_id)] : []
    }).find((id): id is string => id !== undefined)
    const expected = mutationEntries.flatMap(value => {
      const entry = record(value)
      return entry === undefined ? [] : [entry]
    }).find(entry => entry.id === auditEntryId)
    if (expected === undefined || expected.scope !== scope || expected.text !== text
      || expected.state !== 'active'
      || (scope === 'project' && nonEmptyString(expected.project) === undefined)
      || (scope === 'global' && expected.project !== undefined)) return false
    return memoryEntriesContainProjection(entries, expected)
  }

  if (mutation.name === 'xiaoshe_memory_set_state') {
    const id = nonEmptyString(mutationArgs?.id)
    const state = nonEmptyString(mutationArgs?.state)
    if (id === undefined || (state !== 'active' && state !== 'forgotten')
      || (state === 'forgotten' && query?.include_inactive !== true)) return false
    const mutationEntries = Array.isArray(mutationSnapshot.entries) ? mutationSnapshot.entries : []
    const expected = mutationEntries.flatMap(value => {
      const entry = record(value)
      return entry === undefined ? [] : [entry]
    }).find(entry => entry.id === id && entry.state === state
      && (entry.scope === 'global' || entry.scope === 'project'))
    if (expected === undefined || !memoryQueryIncludesScope(query, expected.scope as 'global' | 'project')
      || (expected.scope === 'project' && nonEmptyString(expected.project) === undefined)
      || (expected.scope === 'global' && expected.project !== undefined)) return false
    return memoryEntriesContainProjection(entries, expected)
  }
  return false
}

function memoryQueryIncludesScope(
  query: Record<string, unknown> | undefined,
  scope: 'global' | 'project',
): boolean {
  const queryScope = nonEmptyString(query?.scope)
  return queryScope === undefined || queryScope === 'all' || queryScope === scope
}

function memoryEntriesContainProjection(
  entries: readonly Record<string, unknown>[],
  expected: Record<string, unknown>,
): boolean {
  const id = nonEmptyString(expected.id)
  const scope = expected.scope
  const text = stringValue(expected.text)
  const state = nonEmptyString(expected.state)
  if (id === undefined || (scope !== 'global' && scope !== 'project')
    || text === undefined || state === undefined) return false
  return entries.some(entry => entry.id === id && entry.scope === scope
    && entry.text === text && entry.state === state
    && (scope === 'global'
      ? entry.project === undefined
      : memoryProjectEquals(nonEmptyString(entry.project), nonEmptyString(expected.project))))
}

function memoryProjectEquals(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false
  return left.replace(/\\/gu, '/').toLowerCase() === right.replace(/\\/gu, '/').toLowerCase()
}

function actionForTool(toolName: string): 'click' | 'type' | 'press' | 'focus' | undefined {
  if (toolName === 'screen_click') return 'click'
  if (toolName === 'screen_type') return 'type'
  if (toolName === 'screen_press') return 'press'
  if (toolName === 'screen_focus_window') return 'focus'
  return undefined
}

/** Classify only commands whose own zero exit is a trustworthy gate result. */
export function classifyVerificationCommand(command: string, workdir?: string): VerificationGate[] {
  return classifyVerificationCommandDetailed(command, workdir)?.gates ?? []
}

interface CommandClassification {
  readonly gates: VerificationGate[]
  readonly proofs: readonly CommandProof[]
  readonly packageGraphs: readonly PackageGraphEvidence[]
  /** Undefined means a project-wide test invocation; a list means exact test files only. */
  readonly testTargets?: readonly string[]
  readonly needsPositiveTestSummary: boolean
}

interface SegmentClassification {
  readonly gates: VerificationGate[]
  readonly proofs: readonly CommandProof[]
  readonly packageGraphs: readonly PackageGraphEvidence[]
  readonly testTargets?: readonly string[]
  readonly needsPositiveTestSummary: boolean
}

interface PackageGraphEvidence {
  readonly path: string
  readonly sha256: string
}

type CommandProof = 'node-syntax'

function classifyVerificationCommandDetailed(
  command: string,
  workdir?: string,
  scriptStack: ReadonlySet<string> = new Set(),
): CommandClassification | undefined {
  const trimmed = command.trim()
  if (trimmed.length === 0 || /[\r\n;|`<>]|\$\(|(?<!&)&(?!&)/u.test(trimmed)) return undefined
  const segments = trimmed.split(/\s*&&\s*/u)
  if (segments.some(segment => segment.trim().length === 0)) return undefined
  const classified = segments.map(segment => classifyCommandSegment(segment, workdir, scriptStack))
  if (classified.some(item => item === undefined
    || (item.gates.length === 0 && item.proofs.length === 0))) return undefined
  const accepted = classified as SegmentClassification[]
  const testSegments = accepted.filter(item => item.gates.includes('test'))
  const scopedTests = testSegments.length > 0 && testSegments.every(item => item.testTargets !== undefined)
    ? [...new Set(testSegments.flatMap(item => item.testTargets ?? []))]
    : undefined
  return {
    gates: uniqueGates(accepted.flatMap(item => item.gates)),
    proofs: [...new Set(accepted.flatMap(item => item.proofs))],
    packageGraphs: uniquePackageGraphs(accepted.flatMap(item => item.packageGraphs)),
    ...(scopedTests === undefined ? {} : { testTargets: scopedTests }),
    needsPositiveTestSummary: testSegments.some(item => item.needsPositiveTestSummary),
  }
}

function classifyCommandSegment(
  segment: string,
  workdir: string | undefined,
  scriptStack: ReadonlySet<string>,
): SegmentClassification | undefined {
  const tokens = tokenize(segment)
  if (tokens === undefined || tokens.length === 0) return undefined
  const normalized = tokens.map(token => token.toLowerCase())
  const flagNames = normalized.map(flagName)
  // These switches can return zero without running the asserted workload.
  // Reject them before inspecting the runner so aliases and `npm run -- ...`
  // cannot turn help, discovery, dry-runs, or an empty suite into proof.
  if (flagNames.some(token => [
    '-h', '--help', '--version', '--dry-run', '--if-present', '--ignore-scripts',
    '-list', '--list', '--listtests', '--list-tests', '--collect-only', '--no-run',
    '--passwithnotests', '--allow-no-tests',
  ].includes(token))) return undefined
  const executable = basename(normalized[0] as string)
  const gates: VerificationGate[] = []
  const proofs: CommandProof[] = []
  let testTargets: readonly string[] | undefined
  let needsPositiveTestSummary = false

  const runner = /^(?:npm|npm\.cmd|pnpm|pnpm\.cmd|yarn|yarn\.cmd|bun|bun\.exe)$/u.test(executable)
  if (runner) {
    const invocation = packageScriptInvocation(executable, normalized)
    if (invocation !== undefined) {
      // Arguments after the script name can narrow or alter a declared suite.
      // The producer cannot prove their semantics, so only the exact package
      // script invocation is eligible for a project-wide gate.
      if (!SAFE_SCRIPT.test(invocation.script) || invocation.tail.length > 0
        || hasTestFilter(flagNames)) return undefined
      return packageScriptClassification(workdir, invocation.script, scriptStack)
    }
  }

  const invocation = unwrapInvocation(normalized)
  const direct = invocation.executable
  const directArgs = invocation.arguments
  const joined = normalized.join(' ')
  if (direct === 'tsc' || (['npx', 'pnpm', 'yarn', 'bunx'].includes(executable.replace(/\.cmd$/u, '')) && joined.includes(' tsc '))) {
    if (normalized.includes('--noemit')) gates.push('typecheck')
    else gates.push('build')
  }
  const directNodeTestFiles = direct === 'node' ? directArgs
    .filter(token => /(?:^|[\\/])[^\\/]+\.(?:test|spec)\.[cm]?[jt]s$/iu.test(token)) : []
  const directNodeTestFile = directNodeTestFiles.length > 0
  if (direct === 'node' && (directArgs.includes('--test') || directNodeTestFile)) {
    if (hasAnyFlag(flagNames, ['--test-name-pattern', '--test-skip-pattern', '--test-only', '--test-shard'])) return undefined
    if (directNodeTestFile) testTargets = directNodeTestFiles
    needsPositiveTestSummary = true
    gates.push('test')
  }
  // `node --check file.js` is a real, effect-free syntax proof, but it is not
  // intrinsically a project typecheck or build. A package script may assign
  // that semantic role below; direct invocations deliberately remain ungated.
  if (direct === 'node' && directArgs.length === 2
    && (directArgs[0] === '--check' || directArgs[0] === '-c')
    && /\.[cm]?js$/iu.test(directArgs[1] ?? '')) proofs.push('node-syntax')
  if (direct === 'pytest' || (['python', 'python3', 'py'].includes(direct) && joined.includes(' -m pytest'))) {
    if (hasAnyFlag(flagNames, ['-k', '-m']) || positionalTestSelectors(direct, directArgs).length > 0) return undefined
    gates.push('test')
  }
  if (['vitest', 'jest', 'mocha'].includes(direct)) {
    const runnerArgs = direct === 'vitest' && directArgs[0] === 'run' ? directArgs.slice(1) : directArgs
    if (hasTestFilter(flagNames) || runnerArgs.some(token => !token.startsWith('-'))) return undefined
    gates.push('test')
  }
  if (direct === 'cargo' && normalized[1] === 'test') {
    if (normalized.slice(2).some(token => !token.startsWith('-'))) return undefined
    gates.push('test')
  }
  if (direct === 'go' && normalized[1] === 'test') {
    const packages = normalized.slice(2).filter(token => !token.startsWith('-'))
    if (hasAnyFlag(flagNames, ['-run']) || packages.some(token => token !== './...')) return undefined
    gates.push('test')
  }
  if (direct === 'dotnet' && normalized[1] === 'test') {
    if (hasAnyFlag(flagNames, ['--filter']) || normalized.slice(2).some(token => !token.startsWith('-'))) return undefined
    gates.push('test')
  }
  if ((direct === 'cargo' || direct === 'go' || direct === 'dotnet') && normalized[1] === 'build') gates.push('build')
  if ((direct === 'mvn' || direct === 'mvnw' || direct === 'gradle' || direct === 'gradlew')
    && normalized.some(token => token === 'test')) {
    if (hasAnyFlag(flagNames, ['-dtest', '-dit.test', '--tests'])) return undefined
    gates.push('test')
  }
  if ((direct === 'mvn' || direct === 'mvnw') && normalized.some(token => token === 'package' || token === 'verify')) gates.push('build')
  if ((direct === 'gradle' || direct === 'gradlew') && normalized.some(token => token === 'build' || token === 'assemble')) gates.push('build')
  if (/\bdsh(?:\.cmd)?\b/iu.test(segment) && normalized.includes('--dump-config')) gates.push('profile-dump')
  return {
    gates: uniqueGates(gates),
    proofs,
    packageGraphs: [],
    ...(testTargets === undefined ? {} : { testTargets }),
    // Exit zero only proves a test gate when the runner also reports that at
    // least one test actually ran. This covers empty suites and wrappers whose
    // configuration permits zero tests without failing the process.
    needsPositiveTestSummary: needsPositiveTestSummary || gates.includes('test'),
  }
}

function packageScriptClassification(
  workdir: string | undefined,
  script: string,
  scriptStack: ReadonlySet<string>,
): SegmentClassification | undefined {
  if (workdir === undefined) return undefined
  const packagePath = resolve(workdir, 'package.json')
  const packageGraph = readPackageScripts(packagePath)
  if (packageGraph === undefined) return undefined
  const scripts = packageGraph?.scripts
  const command = scripts?.[script]
  if (command === undefined) return undefined
  const key = `${packagePath}\u0000${script}`
  if (scriptStack.has(key)) return undefined
  const nextStack = new Set(scriptStack)
  nextStack.add(key)

  const lifecycle = [`pre${script}`, script, `post${script}`]
    .flatMap(name => scripts?.[name] === undefined ? [] : [scripts[name] as string])
  const classifications = lifecycle.map(value => classifyVerificationCommandDetailed(value, workdir, nextStack))
  if (classifications.length === 0 || classifications.some(value => value === undefined)) return undefined
  const accepted = classifications as CommandClassification[]
  const proofs = [...new Set(accepted.flatMap(value => value.proofs))]
  const scriptRoleGate = proofs.includes('node-syntax') ? nodeSyntaxScriptGate(script) : undefined
  const testCommands = accepted.filter(value => value.gates.includes('test'))
  // The canonical package `test` script is the repository's declared suite,
  // even when a small project implements it with one node:test module that
  // imports production code. Ad-hoc scripts keep exact-file scoping.
  const projectWideTest = script === 'test' || script === 'verify:test'
  const testTargets = !projectWideTest && testCommands.length > 0
    && testCommands.every(value => value.testTargets !== undefined)
    ? [...new Set(testCommands.flatMap(value => value.testTargets ?? []))]
    : undefined
  return {
    gates: uniqueGates([
      ...accepted.flatMap(value => value.gates),
      ...(scriptRoleGate === undefined ? [] : [scriptRoleGate]),
    ]),
    proofs,
    packageGraphs: uniquePackageGraphs([
      packageGraph.evidence,
      ...accepted.flatMap(value => value.packageGraphs),
    ]),
    ...(testTargets === undefined ? {} : { testTargets }),
    needsPositiveTestSummary: testCommands.some(value => value.needsPositiveTestSummary),
  }
}

function nodeSyntaxScriptGate(script: string): 'typecheck' | 'build' | undefined {
  const roles = script.toLowerCase().split(':')
  if (roles.some(role => role === 'typecheck' || role === 'types')) return 'typecheck'
  if (roles.some(role => role === 'build' || role === 'compile')) return 'build'
  return undefined
}

function readPackageScripts(packagePath: string): {
  readonly scripts: Readonly<Record<string, string>>
  readonly evidence: PackageGraphEvidence
} | undefined {
  try {
    if (statSync(packagePath).size > 1_000_000) return undefined
    const source = readFileSync(packagePath, 'utf8')
    const parsed = record(JSON.parse(source) as unknown)
    const scripts = record(parsed?.scripts)
    if (scripts === undefined) return undefined
    const result: Record<string, string> = {}
    for (const [name, value] of Object.entries(scripts)) {
      if (SAFE_SCRIPT.test(name) && typeof value === 'string' && value.trim() !== '') result[name] = value
    }
    return {
      scripts: result,
      evidence: { path: packagePath, sha256: digest(source) },
    }
  } catch {
    return undefined
  }
}

function uniquePackageGraphs(graphs: readonly PackageGraphEvidence[]): PackageGraphEvidence[] {
  const unique = new Map<string, PackageGraphEvidence>()
  for (const graph of graphs) {
    const key = normalPathKey(graph.path)
    const previous = unique.get(key)
    // Encountering different contents for one manifest in a single resolved
    // command graph means the graph was not stable enough to attest.
    if (previous !== undefined && previous.sha256 !== graph.sha256) return []
    unique.set(key, graph)
  }
  return [...unique.values()].sort((left, right) => normalPathKey(left.path).localeCompare(normalPathKey(right.path)))
}

function packageGraphsStillMatch(graphs: readonly PackageGraphEvidence[]): boolean {
  if (graphs.length === 0) return false
  try {
    return graphs.every(graph => statSync(graph.path).size <= 1_000_000
      && digest(readFileSync(graph.path, 'utf8')) === graph.sha256)
  } catch {
    return false
  }
}

function packageGraphsUntainted(
  graphs: readonly PackageGraphEvidence[],
  mutation: DurableCall,
  verifier: DurableCall,
  calls: readonly DurableCall[],
  policy: VerificationPolicy,
  sessionCwd: string | undefined,
): boolean {
  if (graphs.length === 0) return true
  const graphPaths = new Set(graphs.map(graph => normalPathKey(graph.path)))
  for (const call of calls) {
    if (call.resultSeq < mutation.resultSeq || call.resultSeq >= verifier.resultSeq
      || call.failed || call.capture.isError) continue
    const classification = policy.classifyTool({ toolName: call.name, arguments: call.arguments })
    if (!classification.mutation || classification.change === undefined
      || !['code', 'plugin', 'release'].includes(classification.change.kind)) continue
    const targets = mutationTargetPaths(call.name, call.arguments, sessionCwd)
    // A code mutation with an ambiguous/missing path could have changed the
    // wrapper that is now trying to certify it. Keep that debt open.
    if (targets === undefined || targets.some(target => graphPaths.has(normalPathKey(target)))) return false
  }
  return true
}

interface PackageScriptInvocation {
  readonly script: string
  readonly tail: readonly string[]
}

function packageScriptInvocation(
  executable: string,
  normalizedTokens: readonly string[],
): PackageScriptInvocation | undefined {
  const manager = executable.replace(/\.(?:cmd|exe)$/u, '')
  if (manager === 'npm') {
    // npm's standard test alias runs the same declared lifecycle as `run test`.
    // Keep its tail so filters/flags cannot bypass the shared script checks.
    if (normalizedTokens[1] === 'test') return { script: 'test', tail: normalizedTokens.slice(2) }
    return normalizedTokens[1] === 'run' && normalizedTokens[2] !== undefined
      ? { script: normalizedTokens[2], tail: normalizedTokens.slice(3) }
      : undefined
  }
  if (!['pnpm', 'yarn', 'bun'].includes(manager)) return undefined
  const offset = normalizedTokens[1] === 'run' ? 2 : 1
  const script = normalizedTokens[offset]
  if (script === undefined || ['exec', 'x', 'dlx'].includes(script)) return undefined
  return { script, tail: normalizedTokens.slice(offset + 1) }
}

function commandInvokesPackageScript(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed.length === 0 || /[\r\n;|`<>]|\$\(|(?<!&)&(?!&)/u.test(trimmed)) return false
  return trimmed.split(/\s*&&\s*/u).some(segment => {
    const tokens = tokenize(segment)?.map(token => token.toLowerCase())
    if (tokens === undefined || tokens.length === 0) return false
    const executable = basename(tokens[0] as string)
    return packageScriptInvocation(executable, tokens) !== undefined
  })
}

function positionalTestSelectors(direct: string, directArgs: readonly string[]): string[] {
  const args = direct === 'pytest'
    ? directArgs
    : directArgs[0] === '-m' && directArgs[1] === 'pytest' ? directArgs.slice(2) : directArgs
  return args.filter(token => !token.startsWith('-'))
}

function unwrapInvocation(tokens: readonly string[]): {
  readonly executable: string
  readonly arguments: readonly string[]
} {
  const outer = basename(tokens[0] ?? '').replace(/\.(?:cmd|exe)$/u, '')
  let commandIndex = 0
  if (outer === 'npx' || outer === 'bunx') commandIndex = wrappedCommandIndex(tokens, 1)
  else if (['npm', 'pnpm', 'yarn', 'bun'].includes(outer)
    && ['exec', 'x', 'dlx'].includes(tokens[1] ?? '')) commandIndex = wrappedCommandIndex(tokens, 2)
  if (commandIndex <= 0 || commandIndex >= tokens.length) {
    return { executable: outer, arguments: tokens.slice(1) }
  }
  return {
    executable: basename(tokens[commandIndex] ?? '').replace(/\.(?:cmd|exe)$/u, ''),
    arguments: tokens.slice(commandIndex + 1),
  }
}

function wrappedCommandIndex(tokens: readonly string[], start: number): number {
  let index = start
  while (['--', '--yes', '-y'].includes(tokens[index] ?? '')) index += 1
  return (tokens[index] ?? '').startsWith('-') ? 0 : index
}

function flagName(token: string): string {
  return token.split('=', 1)[0] as string
}

function hasAnyFlag(flags: readonly string[], denied: readonly string[]): boolean {
  const blocked = new Set(denied)
  return flags.some(flag => blocked.has(flag))
}

function hasTestFilter(flags: readonly string[]): boolean {
  return hasAnyFlag(flags, [
    '-t', '-g', '-f', '-k', '-m', '-run', '--filter', '--grep', '--fgrep', '--invert', '--grep-invert',
    '--testnamepattern', '--test-name-pattern', '--test-skip-pattern', '--testpathpatterns', '--tests',
  ])
}

function shellOutcome(capture: CapturedResult): {
  readonly status?: VerificationStatus
  readonly label: string
  readonly output?: string
} {
  if (capture.isError) return { status: 'failed', label: 'tool-error' }
  const value = record(capture.value)
  const stdout = record(value?.stdout)
  const stderr = record(value?.stderr)
  if (value?.kind !== 'foreground' || typeof value.exitCode !== 'number'
    || typeof value.timedOut !== 'boolean' || typeof value.aborted !== 'boolean'
    || (value.signal !== null && typeof value.signal !== 'string')
    || typeof stdout?.text !== 'string' || typeof stderr?.text !== 'string') {
    return { label: 'unsupported-result' }
  }
  const passed = value.exitCode === 0 && value.signal === null
    && value.timedOut === false && value.aborted === false
  return {
    status: passed ? 'passed' : 'failed',
    label: `exit-${String(value.exitCode)}${value.timedOut === true ? '-timeout' : ''}${value.aborted === true ? '-aborted' : ''}`,
    output: `${stdout.text}\n${stderr.text}`,
  }
}

function hasPositiveTestSummary(output: string | undefined): boolean {
  if (output === undefined) return false
  const summary = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
  // A trailing/broad positive counter must never overwrite an explicit runner
  // failure printed earlier in the same canonical stdout/stderr transcript.
  if (hasExplicitTestFailure(summary)) return false
  // Node 24's default spec reporter prefixes its canonical totals with `ℹ`,
  // while TAP uses `#`. Require the complete tests/pass/fail triple so an
  // incidental prose line can never promote an empty or failed suite.
  const tests = /(?:^|\n)\s*(?:#|ℹ)\s*tests\s+(\d+)\s*(?:\n|$)/iu.exec(summary)
  const passed = /(?:^|\n)\s*(?:#|ℹ)\s*pass\s+(\d+)\s*(?:\n|$)/iu.exec(summary)
  const failed = /(?:^|\n)\s*(?:#|ℹ)\s*fail\s+(\d+)\s*(?:\n|$)/iu.exec(summary)
  if (tests !== null || passed !== null || failed !== null) {
    return Number(tests?.[1] ?? 0) > 0 && Number(passed?.[1] ?? 0) > 0 && Number(failed?.[1] ?? 0) === 0
  }
  return /(?:^|\b)[1-9]\d*\s+tests?\s+passed(?:\b|$)/iu.test(summary)
    || /(?:^|\b)tests?\s+[1-9]\d*\s+passed(?:\b|$)/iu.test(summary)
    || /(?:^|\s)[1-9]\d*\s+passed(?:\b|$)/iu.test(summary)
    || /(?:^|\b)[1-9]\d*\s+passing(?:\b|$)/iu.test(summary)
    || /(?:^|\b)tests?:\s*[1-9]\d*\s+passed(?:\b|$)/iu.test(summary)
    || /(?:^|\b)passed!\s*-\s*failed:\s*0\s*,\s*passed:\s*[1-9]\d*/iu.test(summary)
    || /(?:^|\n)\s*---\s+pass:/iu.test(summary)
    || /(?:^|\b)tests?\s+run:\s*[1-9]\d*\s*,\s*failures:\s*0/iu.test(summary)
}

function hasExplicitTestFailure(output: string): boolean {
  return /(?:^|\n)\s*not ok\b/iu.test(output)
    || /(?:^|\n)\s*---\s*fail:/iu.test(output)
    || /(?:^|\n)\s*(?:\[[^\]\r\n]+\]\s*)?(?:(?:build|test)\s+)?(?:fail(?:ed|ure|ures)?|errors?|failing)(?:\b|:|!)/iu.test(output)
    || /(?:^|\b)[1-9]\d*\s+(?:tests?\s+)?(?:failed|failures?|errors?|failing)(?:\b|$)/iu.test(output)
    || /(?:^|\b)(?:failed|failures?|errors?|failing)\s*:?\s*[1-9]\d*(?:\b|$)/iu.test(output)
}

function workspaceMatches(
  mutation: DurableCall,
  verifierArgs: Record<string, unknown> | undefined,
  sessionCwd: string | undefined,
): boolean {
  const workspace = resolvePath(undefined, sessionCwd)
  const workdir = resolvePath(nonEmptyString(verifierArgs?.workdir), sessionCwd)
  const targets = mutationTargetPaths(mutation.name, mutation.arguments, sessionCwd)
  return workspace !== undefined && workdir !== undefined && targets !== undefined
    && inside(workspace, workdir) && targets.every(target => inside(workspace, target) && inside(workdir, target))
}

function targetedTestMatches(
  mutation: DurableCall,
  targets: readonly string[],
  verifierArgs: Record<string, unknown> | undefined,
  sessionCwd: string | undefined,
): boolean {
  const workspace = resolvePath(undefined, sessionCwd)
  const workdir = resolvePath(nonEmptyString(verifierArgs?.workdir), sessionCwd)
  const mutationPaths = mutationTargetPaths(mutation.name, mutation.arguments, sessionCwd)
  if (workspace === undefined || workdir === undefined || mutationPaths === undefined
    || !inside(workspace, workdir) || !mutationPaths.every(target => inside(workdir, target))) return false
  return mutationPaths.every(mutationPath => targets.some(target => {
    const testPath = resolvePath(target, workdir)
    return testPath !== undefined && inside(workspace, testPath) && samePath(testPath, mutationPath)
  }))
}

function mutationTargetPath(
  toolName: string,
  rawArgs: unknown,
  sessionCwd: string | undefined,
): string | undefined {
  const targets = mutationTargetPaths(toolName, rawArgs, sessionCwd)
  // Exact data readback still has a single-file contract. Supporting code
  // target sets must never silently aggregate partial JSON readback evidence.
  return targets?.length === 1 ? targets[0] : undefined
}

/** Resolve the complete bounded effect set; an unknown member invalidates the whole set. */
function mutationTargetPaths(
  toolName: string,
  rawArgs: unknown,
  sessionCwd: string | undefined,
): string[] | undefined {
  const workspace = resolvePath(undefined, sessionCwd)
  const args = record(rawArgs)
  if (workspace === undefined || args === undefined) return undefined
  let requested = ['file_path', 'path', 'target', 'file', 'filename']
    .flatMap(key => nonEmptyString(args[key]) ?? [])
  if (toolName === 'apply_patch') {
    const patch = nonEmptyString(args.patch) ?? nonEmptyString(args.input)
    if (patch === undefined || (args.patch !== undefined && args.input !== undefined && args.patch !== args.input)) return undefined
    const targets = patchTargetPaths(patch)
    if (targets === undefined) return undefined
    const declared = new Set(targets.map(target => normalPathKey(resolve(workspace, target))))
    if (requested.some(target => !declared.has(normalPathKey(resolve(workspace, target))))) return undefined
    requested = targets
  }
  const resolved = [...new Set(requested.flatMap(target => {
    const path = resolvePath(target, workspace)
    return path === undefined ? [] : [normalPathKey(path)]
  }))]
  if (resolved.length === 0 || resolved.length > MAX_MUTATION_TARGETS
    || (toolName !== 'apply_patch' && resolved.length !== 1)) return undefined
  const targets = resolved.map(target => resolve(target))
  return targets.every(target => inside(workspace, target)) ? targets : undefined
}

function patchTargetPaths(patch: string): string[] | undefined {
  if (patch.length > MAX_PATCH_CHARS) return undefined
  const lines = patch.trim().split(/\r?\n/u)
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return undefined
  const targets = new Set<string>()
  for (const line of lines) {
    const match = /^\*\*\* (?:Add|Delete|Update) File:\s*(.+?)\s*$/u.exec(line)
      ?? /^\*\*\* Move to:\s*(.+?)\s*$/u.exec(line)
    const target = nonEmptyString(match?.[1])
    if (target !== undefined) targets.add(target)
    else if (line.startsWith('***') && !/^\*\*\* (?:Begin Patch|End Patch|End of File)$/u.test(line)) return undefined
    if (targets.size > MAX_MUTATION_TARGETS) return undefined
  }
  return targets.size === 0 ? undefined : [...targets]
}

function existingResultKeys(events: readonly SessionEvent[]): Set<string> {
  const keys = new Set<string>()
  for (const event of events) {
    if (event.type !== 'verification/result') continue
    const data = record(event.data)
    const mutation = nonEmptyString(data?.mutationCallId)
    const verifier = nonEmptyString(data?.verifierCallId)
    const gate = nonEmptyString(data?.gate)
    const status = nonEmptyString(data?.status)
    if (mutation !== undefined && gate !== undefined && status !== undefined && verifier !== undefined) {
      keys.add(`${mutation}\u0000${verifier}\u0000${gate}\u0000${status}`)
    }
  }
  return keys
}

function resultKey(mutationCallId: string, verifierCallId: string, candidate: Candidate): string {
  return `${mutationCallId}\u0000${verifierCallId}\u0000${candidate.gate}\u0000${candidate.status}`
}

function tokenize(command: string): string[] | undefined {
  const tokens = command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/gu)
  if (tokens === null) return undefined
  return tokens.map(token => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1)
    }
    return token
  })
}

function basename(path: string): string {
  return path.replace(/\\/gu, '/').split('/').at(-1) ?? path
}

function resolvePath(path: string | undefined, base: string | undefined): string | undefined {
  if (path === undefined) return base === undefined ? undefined : resolve(base)
  if (isAbsolute(path)) return resolve(path)
  return base === undefined ? undefined : resolve(base, path)
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function samePath(left: string, right: string): boolean {
  return normalPathKey(left) === normalPathKey(right)
}

function normalPathKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function parseArguments(value: unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (typeof value !== 'string') return { ok: false }
  try {
    return { ok: true, value: value === '' ? {} : JSON.parse(value) }
  } catch {
    return { ok: false }
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function hasErrorContent(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => record(item)?.isError === true)
}

function uniqueGates(gates: readonly VerificationGate[]): VerificationGate[] {
  return [...new Set(gates)]
}

function evidence(parts: readonly string[]): string {
  return parts.map(part => part.replace(/[\u0000-\u001f;]+/gu, ' ').trim()).join(';').slice(0, MAX_EVIDENCE)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
