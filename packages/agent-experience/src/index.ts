import { createHash } from 'node:crypto'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type ExperienceState = 'unknown' | 'candidate' | 'active' | 'stale'
export type ExperienceOutcome = 'failure' | 'verified-recovery'

export interface ExperienceObservation {
  readonly sessionId: string
  readonly taskGeneration: number
  readonly failedFamily: string
  readonly alternativeFamily: string
  readonly alternativeTool: string
  readonly toolContractDigest: string
  readonly presetId?: string
  readonly outcome: ExperienceOutcome
  readonly at?: string
}

export interface ExperienceCandidate {
  readonly tool: string
  readonly family: string
  readonly toolContractDigest: string
}

export interface ExperienceScore {
  readonly tool: string
  readonly family: string
  readonly score: number
  readonly state: ExperienceState
  readonly verifiedRecoveries: number
  readonly failures: number
}

export interface AgentExperienceService {
  observe(fact: ExperienceObservation): Promise<void>
  rank(query: {
    readonly candidates: readonly ExperienceCandidate[]
    readonly failedFamily?: string
    readonly presetId?: string
  }): ExperienceScore[]
}

export interface SessionFactLike {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

export interface CompletionReceiptLike {
  readonly outcome: string
  readonly turn: number
}

export interface SettingsScopeLike {
  get(): Record<string, JsonValue>
  getSnapshot(): {
    readonly value: Record<string, JsonValue>
    readonly revision: number
    readonly status?: 'ready' | 'degraded'
  }
  replace(section: Record<string, JsonValue>, expectedRevision: number): Promise<void>
}

export interface SettingsSchemaLike {
  (value: unknown): Record<string, JsonValue>
  toJSON(): unknown
}

interface StoredEntry {
  readonly key: string
  readonly failedFamily: string
  readonly alternativeFamily: string
  readonly alternativeTool: string
  readonly toolContractDigest: string
  readonly presetId?: string
  readonly verifiedEpisodes: readonly string[]
  readonly failureEpisodes: readonly string[]
  readonly lastSuccessAt?: string
  readonly lastFailureAt?: string
}

interface StoredState {
  readonly entries: readonly StoredEntry[]
}

interface ServiceOptions {
  readonly now?: () => Date
  readonly maxEntries?: number
  readonly ttlMs?: number
}

const SETTINGS_NAMESPACE = 'xiaoshe-agent-experience'
const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1_000
const MAX_EPISODES_PER_OUTCOME = 16
const MAX_SETTINGS_CAS_ATTEMPTS = 4
const LEGACY_UNKNOWN_SUCCESS_AT = new Date(0).toISOString()
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,128}$/u
const SAFE_DIGEST = /^[a-f0-9]{16,64}$/u
const runtimeWriterScopes = new WeakSet<object>()

/**
 * Strict profile-owned schema for the Agent experience projection. It accepts
 * only bounded, redacted aggregates; task text and tool payloads have no field
 * in the persisted vocabulary.
 */
export const agentExperienceSettingsSchema: SettingsSchemaLike = Object.assign(
  (value: unknown): Record<string, JsonValue> => {
    if (value === undefined) return {}
    const state = record(value)
    if (!state) throw new TypeError('xiaoshe-agent-experience settings must be an object')
    // `revision` is accepted only to migrate the pre-CAS projection. It was a
    // content counter, never the Settings namespace revision used for writes.
    rejectExtras(state, new Set(['schemaVersion', 'revision', 'entries']))
    const output: Record<string, JsonValue> = {}
    if (state.schemaVersion !== undefined && state.schemaVersion !== 1) {
      throw new TypeError('experience schemaVersion must be 1')
    }
    if (state.revision !== undefined) {
      if (!nonNegativeInteger(state.revision)) throw new TypeError('legacy experience revision must be a non-negative integer')
    }
    output.schemaVersion = 1
    if (state.entries !== undefined) {
      if (!Array.isArray(state.entries) || state.entries.length > DEFAULT_MAX_ENTRIES) {
        throw new TypeError(`experience entries must contain at most ${DEFAULT_MAX_ENTRIES} items`)
      }
      const keys = new Set<string>()
      const entries: JsonValue[] = []
      for (const entry of state.entries) {
        const normalized = validateStoredEntry(entry)
        const key = normalized.key
        if (keys.has(key)) throw new TypeError(`duplicate experience key: ${key}`)
        keys.add(key)
        entries.push(normalized as unknown as JsonValue)
      }
      output.entries = entries
    }
    return output
  },
  {
    toJSON: () => ({
      type: 'object', additionalProperties: false,
      properties: {
        schemaVersion: { type: 'integer', const: 1 },
        entries: { type: 'array', maxItems: DEFAULT_MAX_ENTRIES, items: { type: 'object' } },
      },
    }),
  },
)

/** Build the bounded, serialized read model used only as a weak route tie-break. */
export function createAgentExperienceService(
  settings: SettingsScopeLike,
  options: ServiceOptions = {},
): AgentExperienceService {
  // Keep one writer per scope in-process. Independent processes are coordinated
  // by the Settings namespace CAS below.
  if (runtimeWriterScopes.has(settings)) {
    throw new Error('agent experience settings scope already has a single runtime writer')
  }
  runtimeWriterScopes.add(settings)
  const now = options.now ?? (() => new Date())
  const maxEntries = boundedInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, DEFAULT_MAX_ENTRIES)
  const ttlMs = boundedInteger(options.ttlMs, DEFAULT_TTL_MS, 1_000, 365 * 24 * 60 * 60 * 1_000)
  let writeQueue: Promise<void> = Promise.resolve()

  return {
    observe(fact) {
      const observation = validateObservation(fact, now)
      writeQueue = writeQueue.catch(() => undefined).then(async () => {
        for (let attempt = 1; attempt <= MAX_SETTINGS_CAS_ATTEMPTS; attempt += 1) {
          const snapshot = settings.getSnapshot()
          if (!nonNegativeInteger(snapshot.revision)) throw new TypeError('experience Settings revision is invalid')
          const current = readState(snapshot.value)
          const key = routeKey(observation)
          const episode = episodeDigest(observation.sessionId, observation.taskGeneration, key, observation.outcome)
          const existing = current.entries.find(entry => entry.key === key)
          const base: StoredEntry = existing ?? {
            key,
            failedFamily: observation.failedFamily,
            alternativeFamily: observation.alternativeFamily,
            alternativeTool: observation.alternativeTool,
            toolContractDigest: observation.toolContractDigest,
            ...(observation.presetId === undefined ? {} : { presetId: observation.presetId }),
            verifiedEpisodes: [],
            failureEpisodes: [],
          }
          const updated: StoredEntry = observation.outcome === 'verified-recovery'
            ? {
                ...base,
                verifiedEpisodes: appendBoundedUnique(base.verifiedEpisodes, episode),
                lastSuccessAt: laterTimestamp(base.lastSuccessAt, observation.at),
              }
            : {
                ...base,
                failureEpisodes: appendBoundedUnique(base.failureEpisodes, episode),
                lastFailureAt: laterTimestamp(base.lastFailureAt, observation.at),
              }
          const entries = [
            ...current.entries.filter(entry => entry.key !== key),
            updated,
          ]
            .sort((left, right) => latestEntryTimestamp(right) - latestEntryTimestamp(left) || left.key.localeCompare(right.key))
            .slice(0, maxEntries)
          const next = agentExperienceSettingsSchema({
            schemaVersion: 1,
            entries: entries as unknown as JsonValue,
          })
          try {
            await settings.replace(next, snapshot.revision)
            return
          } catch (error) {
            if (!isSettingsConflict(error) || attempt === MAX_SETTINGS_CAS_ATTEMPTS) throw error
          }
        }
      })
      return writeQueue
    },

    rank(query) {
      const snapshot = settings.getSnapshot()
      // Settings deliberately keeps its last-good value while raw storage is
      // degraded. Experience is only an advisory tie-break, so fail closed
      // rather than applying stale advice until a strict replacement repairs it.
      const state = snapshot.status === 'degraded' ? { entries: [] } : readState(snapshot.value)
      const timestamp = now().getTime()
      const presetId = optionalSafeName(query.presetId, 'presetId')
      const failedFamily = optionalSafeName(query.failedFamily, 'failedFamily')
      return query.candidates.map(candidate => {
        const normalized = validateCandidate(candidate)
        const matching = state.entries.filter(entry => entry.alternativeFamily === normalized.family
          && entry.alternativeTool === normalized.tool
          && entry.toolContractDigest === normalized.toolContractDigest
          && (entry.presetId ?? '') === (presetId ?? ''))
          .filter(entry => failedFamily === undefined || entry.failedFamily === failedFamily)
        if (matching.length === 0) return neutral(normalized)
        const verified = new Set(matching.flatMap(entry => entry.verifiedEpisodes)).size
        const failures = new Set(matching.flatMap(entry => entry.failureEpisodes)).size
        // Failure observations are useful negative evidence, but must never
        // extend the TTL of an older successful recovery.
        const newest = verified > 0
          ? Math.max(...matching.flatMap(entry => entry.lastSuccessAt === undefined ? [] : [Date.parse(entry.lastSuccessAt)]))
          : Math.max(...matching.flatMap(entry => entry.lastFailureAt === undefined ? [] : [Date.parse(entry.lastFailureAt)]))
        if (!Number.isFinite(newest) || timestamp - newest > ttlMs) {
          return { ...neutral(normalized), state: 'stale' as const, verifiedRecoveries: verified, failures }
        }
        const stateLabel: ExperienceState = verified >= 2 ? 'active' : verified === 1 ? 'candidate' : 'unknown'
        const ageFactor = Math.min(1, Math.max(0, 1 - ((timestamp - newest) / ttlMs)))
        const score = stateLabel === 'active'
          ? Math.round(Math.max(0, verified * 2 - failures) * ageFactor * 1_000) / 1_000
          : 0
        return { tool: normalized.tool, family: normalized.family, score, state: stateLabel, verifiedRecoveries: verified, failures }
      })
    },
  }
}

/**
 * Project sanitized route-recovery facts into durable observations. A claimed
 * recovery is accepted only when the authoritative completion receipt verifies
 * the same turn and the referenced successful tool result exists in Session
 * Log. Malformed or stale projection input is ignored rather than weakening the
 * Agent runtime.
 */
export function recoveryObservationsFromSession(
  sessionId: string,
  events: readonly SessionFactLike[],
  receipt: CompletionReceiptLike | undefined,
): ExperienceObservation[] {
  try {
    const safeSessionId = boundedText(sessionId, 'sessionId', 256)
    if (!receipt || !nonNegativeInteger(receipt.turn)) return []
    const ordered = events
      .filter(event => nonNegativeInteger(event.seq))
      .sort((left, right) => left.seq - right.seq)
    const observations: ExperienceObservation[] = []
    const calls = toolCallsById(ordered)
    let activeGeneration: number | undefined

    for (const event of ordered) {
      if (validTaskGenerationFact(event)) {
        activeGeneration = record(event.data)!.generation as number
        continue
      }
      if (event.type !== 'xiaoshe/obligation-state') continue
      const route = parseRouteRecovery(event.data, receipt.turn)
      if (!route || route.generation !== activeGeneration
        || (route.status !== 'satisfied' && route.status !== 'blocked')) continue
      if (!Number.isFinite(event.time)) continue
      const at = new Date(event.time).toISOString()
      const common = {
        sessionId: safeSessionId,
        taskGeneration: route.generation,
        failedFamily: route.failedFamily,
        alternativeFamily: route.alternativeFamily,
        alternativeTool: route.alternativeTool,
        toolContractDigest: route.toolContractDigest,
        ...(route.presetId === undefined ? {} : { presetId: route.presetId }),
        at,
      }

      if (route.status === 'blocked') {
        observations.push({ ...common, outcome: 'failure' })
        continue
      }
      if (receipt.outcome !== 'verified' || route.proofResultSeq === undefined) continue
      const proof = ordered.find(candidate => candidate.seq === route.proofResultSeq
        && candidate.seq < event.seq
        && isSuccessfulToolResult(candidate, receipt.turn))
      const proofSource = record(record(record(proof?.data)?.message)?.source)
      const proofCall = typeof proofSource?.callId === 'string' ? calls.get(proofSource.callId) : undefined
      if (proof && proofCall && proofCall.seq < proof.seq
        && proofCall.turn === route.turn
        && proofCall.generation === route.generation
        && proofCall.name === route.alternativeTool
        && route.failedFamily !== route.alternativeFamily
        && proofCall.family === route.alternativeFamily
        && ordered.some(candidate => isPriorFailedFamilyResult(
          candidate,
          route,
          proof.seq,
          calls,
        ))) {
        observations.push({ ...common, outcome: 'verified-recovery' })
      }
    }
    return observations
  } catch {
    return []
  }
}

/** Independently composable Cordis plugin; the aggregate root also mounts it. */
export const name = 'xiaoshe-agent-experience'
export const inject = ['settings', 'sessionProjections']
export function apply(ctx: {
  readonly sessionProjections: {
    snapshot(session: unknown): { readonly values: Readonly<Record<string, unknown>> }
  }
  readonly settings: {
    register(
      namespace: string,
      schema: SettingsSchemaLike,
      options?: {
        readonly base?: Record<string, JsonValue>
        readonly applies?: 'live' | 'restart'
        readonly recoverInvalidStored?: boolean
      },
    ): SettingsScopeLike
  }
  on(
    event: 'session/event',
    listener: (
      session: { readonly id: string; snapshotEvents?(): readonly SessionFactLike[]; readonly events?: readonly SessionFactLike[] },
      event: SessionFactLike,
    ) => void,
  ): () => void
  effect(execute: () => () => void, label?: string): unknown
  provide(name: string, value: unknown): unknown
}): AgentExperienceService {
  const scope = ctx.settings.register(SETTINGS_NAMESPACE, agentExperienceSettingsSchema, {
    base: { schemaVersion: 1, entries: [] },
    applies: 'live',
    recoverInvalidStored: true,
  })
  const service = createAgentExperienceService(scope)
  const cursors = new WeakMap<object, { nextIndex: number; lastSeq: number | undefined; generation?: SessionFactLike }>()
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    try {
      const snapshot = ctx.sessionProjections.snapshot(session)
      const receipt = parseCompletionReceipt(snapshot.values.completionReceipt)
      const observations = incrementalRecoveryObservations(cursors, session, receipt)
      // Settings persistence is outside the Session Log commit path. Keep its
      // bounded write queue ordered, but never let an optional projection veto
      // or delay a committed session event.
      void Promise.all(observations.map(observation => service.observe(observation))).catch(() => undefined)
    } catch {
      // Missing/damaged optional projections degrade to no learned tie-break.
    }
  }), 'xiaoshe-agent-experience: verified recovery projection')
  ctx.provide('xiaosheAgentExperience', service)
  return service
}

function incrementalRecoveryObservations(
  cursors: WeakMap<object, { nextIndex: number; lastSeq: number | undefined; generation?: SessionFactLike }>,
  session: { readonly id: string; snapshotEvents?(): readonly SessionFactLike[]; readonly events?: readonly SessionFactLike[] },
  receipt: CompletionReceiptLike | undefined,
): ExperienceObservation[] {
  // Prefer the canonical v3 log; a snapshot failure must not learn stale history.
  const events = session.snapshotEvents ? session.snapshotEvents() : session.events ?? []
  const previous = cursors.get(session)
  const prefixIntact = previous !== undefined
    && previous.nextIndex <= events.length
    && (previous.nextIndex === 0 || events[previous.nextIndex - 1]?.seq === previous.lastSeq)
  const start = prefixIntact ? previous.nextIndex : 0
  const appended = events.slice(start)
  let generation = prefixIntact ? previous.generation : undefined
  for (const fact of appended) {
    if (fact.type === 'xiaoshe/task-generation' && validTaskGenerationFact(fact)) generation = fact
  }
  const last = events.at(-1)
  cursors.set(session, { nextIndex: events.length, lastSeq: last?.seq, ...(generation ? { generation } : {}) })
  if (!receipt) return []
  const generationValue = record(generation?.data)?.generation
  let activeGeneration: number | undefined
  let generationStart = -1
  for (let index = 0; index < events.length; index += 1) {
    const fact = events[index]!
    if (!validTaskGenerationFact(fact)) continue
    const nextGeneration = record(fact.data)!.generation as number
    if (nextGeneration !== activeGeneration) generationStart = index
    activeGeneration = nextGeneration
  }
  if (generationStart < 0 || activeGeneration !== generationValue) return []
  const generationEvents = events.slice(generationStart)
  // Cross-turn evidence is useful, but optional experience must remain bounded.
  // Keep the generation identity plus the latest facts and fail closed when an
  // older failure falls outside this window.
  const input = generationEvents.length <= 512
    ? generationEvents
    : [generationEvents[0]!, ...generationEvents.slice(-511)]
  return recoveryObservationsFromSession(session.id, input, receipt)
}

function readState(value: unknown): StoredState {
  try {
    const parsed = agentExperienceSettingsSchema(value)
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries as unknown as StoredEntry[] : [],
    }
  } catch {
    // A damaged optional projection must never block the Agent runtime.
    return { entries: [] }
  }
}

function isSettingsConflict(error: unknown): boolean {
  return record(error)?.code === 'SETTINGS_CONFLICT'
}

function routeKey(value: {
  readonly failedFamily: string
  readonly alternativeFamily: string
  readonly alternativeTool: string
  readonly toolContractDigest: string
  readonly presetId?: string
}): string {
  return createHash('sha256').update(JSON.stringify([
    value.failedFamily,
    value.alternativeFamily,
    value.alternativeTool,
    value.toolContractDigest,
    value.presetId ?? '',
  ])).digest('hex').slice(0, 32)
}

function episodeDigest(sessionId: string, generation: number, key: string, outcome: ExperienceOutcome): string {
  return createHash('sha256').update(JSON.stringify([sessionId, generation, key, outcome])).digest('hex').slice(0, 24)
}

function appendBoundedUnique(values: readonly string[], next: string): string[] {
  if (values.includes(next)) return [...values]
  return [...values, next].slice(-MAX_EPISODES_PER_OUTCOME)
}

function laterTimestamp(current: string | undefined, next: string): string {
  return current === undefined || Date.parse(next) > Date.parse(current) ? next : current
}

function latestEntryTimestamp(entry: StoredEntry): number {
  return Math.max(
    entry.lastSuccessAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(entry.lastSuccessAt),
    entry.lastFailureAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(entry.lastFailureAt),
  )
}

function validateObservation(value: ExperienceObservation, now: () => Date): Required<Omit<ExperienceObservation, 'presetId'>> & { readonly presetId?: string } {
  const sessionId = boundedText(value.sessionId, 'sessionId', 256)
  if (!nonNegativeInteger(value.taskGeneration)) throw new TypeError('taskGeneration must be a non-negative integer')
  if (value.outcome !== 'failure' && value.outcome !== 'verified-recovery') throw new TypeError('invalid experience outcome')
  const at = normalizeTimestamp(value.at ?? now().toISOString(), 'experience at')
  return {
    sessionId,
    taskGeneration: value.taskGeneration,
    failedFamily: safeName(value.failedFamily, 'failedFamily'),
    alternativeFamily: safeName(value.alternativeFamily, 'alternativeFamily'),
    alternativeTool: safeName(value.alternativeTool, 'alternativeTool'),
    toolContractDigest: safeDigest(value.toolContractDigest),
    ...(value.presetId === undefined ? {} : { presetId: safeName(value.presetId, 'presetId') }),
    outcome: value.outcome,
    at,
  }
}

function validateCandidate(value: ExperienceCandidate): ExperienceCandidate {
  return {
    tool: safeName(value.tool, 'candidate.tool'),
    family: safeName(value.family, 'candidate.family'),
    toolContractDigest: safeDigest(value.toolContractDigest),
  }
}

interface ParsedRouteRecovery {
  readonly generation: number
  readonly turn: number
  readonly status: 'satisfied' | 'blocked'
  readonly failedFamily: string
  readonly alternativeFamily: string
  readonly alternativeTool: string
  readonly toolContractDigest: string
  readonly presetId?: string
  readonly proofResultSeq?: number
}

function parseRouteRecovery(value: unknown, turn: number): ParsedRouteRecovery | undefined {
  const event = record(value)
  if (!event || event.version !== 1 || event.kind !== 'route-recovery' || event.turn !== turn
    || !nonNegativeInteger(event.generation)
    || (event.status !== 'satisfied' && event.status !== 'blocked')) return undefined
  try {
    const proofResultSeq = event.proofResultSeq
    if (proofResultSeq !== undefined && !nonNegativeInteger(proofResultSeq)) return undefined
    return {
      generation: event.generation,
      turn,
      status: event.status,
      failedFamily: safeName(event.failedFamily, 'failedFamily'),
      alternativeFamily: safeName(event.alternativeFamily, 'alternativeFamily'),
      alternativeTool: safeName(event.alternativeTool, 'alternativeTool'),
      toolContractDigest: safeDigest(event.toolContractDigest),
      ...(event.presetId === undefined ? {} : { presetId: safeName(event.presetId, 'presetId') }),
      ...(proofResultSeq === undefined ? {} : { proofResultSeq }),
    }
  } catch {
    return undefined
  }
}

function parseCompletionReceipt(value: unknown): CompletionReceiptLike | undefined {
  const receipt = record(value)
  return receipt && typeof receipt.outcome === 'string' && nonNegativeInteger(receipt.turn)
    ? { outcome: receipt.outcome, turn: receipt.turn }
    : undefined
}

function isSuccessfulToolResult(event: SessionFactLike, turn: number): boolean {
  if (event.type !== 'tool/result') return false
  const data = record(event.data)
  const message = record(data?.message)
  const source = record(message?.source)
  return data?.turn === turn
    && data.error === undefined
    && source?.kind === 'tool'
    && message?.isError !== true
    && !hasErrorContent(message?.content)
    && Array.isArray(message?.content)
}

function isPriorFailedFamilyResult(
  event: SessionFactLike,
  route: ParsedRouteRecovery,
  proofResultSeq: number,
  calls: ReadonlyMap<string, ProofToolCall>,
): boolean {
  if (event.type !== 'tool/result' || event.seq >= proofResultSeq) return false
  const data = record(event.data)
  const message = record(data?.message)
  const source = record(message?.source)
  const call = typeof source?.callId === 'string' ? calls.get(source.callId) : undefined
  const failed = data?.error !== undefined || message?.isError === true || hasErrorContent(message?.content)
  return failed
    && source?.kind === 'tool'
    && call !== undefined
    && call.seq < event.seq
    && call.generation === route.generation
    && call.family === route.failedFamily
    && recoverableCapabilityFailure(call.name, [message?.content, data?.error], call.family) === route.failedFamily
}

interface ProofToolCall {
  readonly seq: number
  readonly turn: number
  readonly generation: number
  readonly name: string
  readonly family: string
}

function toolCallsById(events: readonly SessionFactLike[]): ReadonlyMap<string, ProofToolCall> {
  const calls = new Map<string, ProofToolCall>()
  let generation: number | undefined
  for (const event of events) {
    const data = record(event.data)
    if (event.type === 'xiaoshe/task-generation' && validTaskGenerationFact(event)) {
      generation = data!.generation as number
      continue
    }
    if (event.type !== 'tool/call' || generation === undefined) continue
    if (typeof data?.callId === 'string' && typeof data.name === 'string'
      && nonNegativeInteger(data.turn) && nonNegativeInteger(event.seq)) {
      calls.set(data.callId, {
        seq: event.seq,
        turn: data.turn,
        generation,
        name: data.name,
        family: routeFamilyForTool(data.name, data.arguments),
      })
    }
  }
  return calls
}

function recoverableCapabilityFailure(toolName: string, canonicalError: unknown, knownFamily?: string): string | undefined {
  const rendered = searchableText(canonicalError)
  return rendered.includes('不在当前任务的精简能力面中')
    && (rendered.includes('当前可见能力') || rendered.includes('xiaoshe_capability_plan'))
    ? knownFamily ?? routeFamilyForTool(toolName)
    : undefined
}

/** Keep learned recovery correlation aligned with completion-receipt. */
function routeFamilyForTool(name: string, args?: unknown): string {
  const normalized = name.toLocaleLowerCase('en-US').replace(/[.:-]+/gu, '_')
  const parsedArgs = toolArgumentRecord(args)
  if (/(?:^|_)str_replace_editor$/u.test(normalized) && parsedArgs?.command === 'view') return 'filesystem_read'
  if (/xiaoshe_(?:runtime_info|capability_plan)|runtime_(?:info|status)|list_tools?/u.test(normalized)) return 'runtime'
  if (/modlens|read_image|image_read|vision|ocr/u.test(normalized)) return 'vision'
  if (/web_search|search_web|internet_search|search_query/u.test(normalized)) return 'web_search'
  if (/web_fetch|fetch_(?:url|page)|open_url|read_url/u.test(normalized)) return 'web_fetch'
  if (/browser|navigate|page_(?:open|click)|click_element|tab_/u.test(normalized)) return 'browser'
  if (/xiaoshe_desktop|capture_screen|(?:^|_)screen_|computer|mouse|keyboard|desktop_/u.test(normalized)) return 'desktop'
  if (/todo|task_list/u.test(normalized)) return 'todo'
  if (/(?:^|_)memory(?:_|$)|remember|^session_(?:event_)?(?:read|search|trace)$/u.test(normalized)) return 'memory'
  if (/(?:^|_)goal(?:_|$)/u.test(normalized)) return 'goal'
  if (/(?:^|_)skill(?:_|$)/u.test(normalized)) return 'skill'
  if (/apply_patch|str_replace|(?:^|_)(?:create|delete|edit|move|remove|rename|update|upload|write)_(?:file|text)(?:_|$)/u.test(normalized)) return 'filesystem_write'
  const localFilesystem = /^(?:mcp__|app__|connector__)?(?:filesystem|local|workspace)(?:__|[.:])/iu.test(name)
  if (localFilesystem) {
    if (/apply_patch|str_replace|(?:^|_)(?:edit|write|delete|remove|move|rename|create_file)(?:_|$)/u.test(normalized)) return 'filesystem_write'
    if (/(?:^|_)(?:glob|grep)(?:_|$)|find_(?:file|path)|search_(?:file|code)|list_(?:directory|files)/u.test(normalized)) return 'filesystem_search'
    if (/read_(?:file|text)|file_read|^read$/u.test(normalized)) return 'filesystem_read'
  }
  const namespace = name.toLocaleLowerCase('en-US').match(/^(?:mcp__|app__|connector__)?([a-z0-9-]{2,40})(?:__|[.:])/u)
  if (namespace?.[1]) return `integration:${namespace[1]}`
  if (/(?:^|_)(?:glob|grep)(?:_|$)|find_(?:file|path)|search_(?:file|code)|list_(?:directory|files)/u.test(normalized)) return 'filesystem_search'
  if (/read_(?:file|text)|file_read|^read$/u.test(normalized)) return 'filesystem_read'
  if (/apply_patch|str_replace|(?:^|_)(?:edit|write|delete|remove|move|rename|create_file)(?:_|$)/u.test(normalized)) return 'filesystem_write'
  if (/^(?:bash|powershell|pwsh|shell|exec_command|run_command)$/u.test(normalized)) return 'shell'
  if (/(?:^|_)(?:plugin|extension)(?:_|$)/u.test(normalized)) return 'plugin_management'
  if (/subagent|workflow|ralph/u.test(normalized) || /^(?:list_agents|send_message)$/u.test(normalized)) return 'delegation'
  if (/(?:^|_)job(?:_|$)/u.test(normalized)) return 'jobs'
  const generic = new Set(['api', 'app', 'connector', 'function', 'functions', 'mcp', 'tool', 'tools', 'create', 'delete', 'fetch', 'find', 'get', 'list', 'open', 'read', 'remove', 'run', 'search', 'send', 'update', 'write'])
  const provider = normalized.split('_').find(part => part && !generic.has(part)) ?? 'other'
  return `integration:${provider.slice(0, 40)}`
}

function toolArgumentRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return record(value)
  if (value.length > 262_144) return undefined
  try {
    return record(JSON.parse(value))
  } catch {
    return undefined
  }
}

function validTaskGenerationFact(event: SessionFactLike): boolean {
  const data = record(event.data)
  return event.type === 'xiaoshe/task-generation' && data?.version === 1
    && nonNegativeInteger(data.generation)
    && (data.relation === 'new' || data.relation === 'continuation')
    && typeof data.triggerMessageId === 'string' && data.triggerMessageId.length > 0
}

function validateStoredEntry(value: unknown): StoredEntry {
  const entry = record(value)
  if (!entry) throw new TypeError('experience entry must be an object')
  rejectExtras(entry, new Set([
    'key', 'failedFamily', 'alternativeFamily', 'alternativeTool', 'toolContractDigest', 'presetId',
    'verifiedEpisodes', 'failureEpisodes', 'lastSuccessAt', 'lastFailureAt', 'lastObservedAt',
  ]))
  if (typeof entry.key !== 'string' || !/^[a-f0-9]{32}$/u.test(entry.key)) throw new TypeError('invalid experience key')
  const verifiedEpisodes = validateEpisodeList(entry.verifiedEpisodes, 'verifiedEpisodes')
  const failureEpisodes = validateEpisodeList(entry.failureEpisodes, 'failureEpisodes')
  if (verifiedEpisodes.length === 0 && failureEpisodes.length === 0) {
    throw new TypeError('experience entry must contain at least one bounded episode')
  }

  const hasLegacyClock = entry.lastObservedAt !== undefined
  const hasSplitClock = entry.lastSuccessAt !== undefined || entry.lastFailureAt !== undefined
  if (hasLegacyClock && hasSplitClock) throw new TypeError('legacy and split experience clocks cannot be mixed')
  let lastSuccessAt: string | undefined
  let lastFailureAt: string | undefined
  if (hasLegacyClock) {
    const lastObservedAt = normalizeTimestamp(entry.lastObservedAt, 'lastObservedAt')
    // Old mixed entries cannot tell whether their shared clock came from the
    // success or a later failure. Preserve the evidence but expire its success
    // conservatively so migration cannot revive a route.
    if (verifiedEpisodes.length > 0) {
      lastSuccessAt = failureEpisodes.length > 0 ? LEGACY_UNKNOWN_SUCCESS_AT : lastObservedAt
    }
    if (failureEpisodes.length > 0) lastFailureAt = lastObservedAt
  } else {
    lastSuccessAt = optionalTimestamp(entry.lastSuccessAt, 'lastSuccessAt')
    lastFailureAt = optionalTimestamp(entry.lastFailureAt, 'lastFailureAt')
  }
  if ((verifiedEpisodes.length > 0) !== (lastSuccessAt !== undefined)) {
    throw new TypeError('lastSuccessAt must match verifiedEpisodes')
  }
  if ((failureEpisodes.length > 0) !== (lastFailureAt !== undefined)) {
    throw new TypeError('lastFailureAt must match failureEpisodes')
  }

  return {
    key: entry.key,
    failedFamily: safeName(entry.failedFamily, 'failedFamily'),
    alternativeFamily: safeName(entry.alternativeFamily, 'alternativeFamily'),
    alternativeTool: safeName(entry.alternativeTool, 'alternativeTool'),
    toolContractDigest: safeDigest(entry.toolContractDigest),
    ...(entry.presetId === undefined ? {} : { presetId: safeName(entry.presetId, 'presetId') }),
    verifiedEpisodes,
    failureEpisodes,
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
    ...(lastFailureAt === undefined ? {} : { lastFailureAt }),
  }
}

function validateEpisodeList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_EPISODES_PER_OUTCOME
    || value.some(item => typeof item !== 'string' || !/^[a-f0-9]{24}$/u.test(item))) {
    throw new TypeError(`invalid ${field}`)
  }
  return [...value] as string[]
}

function neutral(candidate: ExperienceCandidate): ExperienceScore {
  return { tool: candidate.tool, family: candidate.family, score: 0, state: 'unknown', verifiedRecoveries: 0, failures: 0 }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function searchableText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function hasErrorContent(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => record(item)?.isError === true)
}

function rejectExtras(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const extras = Object.keys(value).filter(key => !allowed.has(key))
  if (extras.length > 0) throw new TypeError(`Unknown xiaoshe-agent-experience setting: ${extras.join(', ')}`)
}

function safeName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_NAME.test(value)) throw new TypeError(`${field} must be a safe identifier`)
  return value
}

function optionalSafeName(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : safeName(value, field)
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`)
  }
  return new Date(value).toISOString()
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : normalizeTimestamp(value, field)
}

function safeDigest(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_DIGEST.test(value)) throw new TypeError('toolContractDigest must be a lowercase hex digest')
  return value
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) throw new TypeError(`${field} is invalid`)
  return value
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value === undefined || !Number.isSafeInteger(value) ? fallback : Math.min(maximum, Math.max(minimum, value))
}
