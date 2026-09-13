import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type {
  JsonValue,
  SettingsSchemaLike,
  SettingsScopeLike,
  ToolDefinitionLike,
} from './types.js'

const MAX_ENTRIES = 500
const MAX_AUDIT_EVENTS = 200
const MAX_TEXT_LENGTH = 4_000
const MAX_PROJECT_LENGTH = 240
const MAX_ID_LENGTH = 128
const MAX_INJECTION_ITEMS = 100
const MAX_SETTINGS_CONFLICT_RETRIES = 8

export type MemoryScope = 'global' | 'project'
export type MemoryState = 'active' | 'forgotten' | 'superseded'

export interface MemoryEntry {
  readonly id: string
  readonly scope: MemoryScope
  readonly project?: string
  readonly text: string
  readonly state: MemoryState
  readonly version: number
  readonly created_at: string
  readonly updated_at: string
  readonly supersedes?: string
  readonly superseded_by?: string
}

export type MemoryAuditAction = 'create' | 'edit' | 'forget' | 'restore'

export interface MemoryAuditEvent {
  readonly revision: number
  readonly action: MemoryAuditAction
  readonly entry_id: string
  readonly previous_entry_id?: string
  readonly at: string
}

export interface MemoryUsageRecord {
  readonly entry_id: string
  readonly count: number
  readonly last_used_at: string
  readonly last_session_id: string
  readonly last_project?: string
}

export interface MemoryDiagnostics {
  /** Whether the settings namespace itself is currently schema-valid. */
  readonly persistence_status: 'ready' | 'degraded'
  /** Usage bookkeeping is best-effort and must never gate prompt assembly. */
  readonly usage_audit_status: 'ready' | 'degraded'
  readonly usage_persistence_failures: number
  readonly last_usage_persistence_error?: 'MEMORY_USAGE_PERSISTENCE_FAILED'
  readonly last_usage_persistence_error_at?: string
}

export interface MemorySnapshot {
  readonly api_version: 1
  readonly revision: number
  /** Canonical key of the project boundary applied to this projection. */
  readonly project?: string
  readonly counts: {
    readonly active: number
    readonly global: number
    readonly project: number
    readonly forgotten: number
    readonly superseded: number
  }
  readonly entries: readonly MemoryEntry[]
  readonly audit: readonly MemoryAuditEvent[]
  readonly usage: readonly MemoryUsageRecord[]
  readonly diagnostics: MemoryDiagnostics
}

export interface RememberMemoryInput {
  readonly scope: MemoryScope
  readonly project?: string
  readonly text: string
  readonly replaces_id?: string
}

export interface MemoryQuery {
  readonly scope?: MemoryScope | 'all'
  readonly project?: string
  readonly include_inactive?: boolean
}

export interface MemoryService {
  snapshot(query?: MemoryQuery): MemorySnapshot
  remember(input: RememberMemoryInput, expectedRevision: number): Promise<MemorySnapshot>
  setState(id: string, state: 'active' | 'forgotten', expectedRevision: number): Promise<MemorySnapshot>
  injection(project?: string): MemoryInjection
  recordInjection(input: RecordMemoryInjectionInput): Promise<void>
}

export interface RecordMemoryInjectionInput {
  readonly sessionId: string
  readonly project?: string
  readonly itemIds: readonly string[]
  readonly at?: string
}

interface MemoryServiceOptions {
  readonly createId?: () => string
  readonly now?: () => Date
  /** Test seam and embedded-host override for filesystem identity lookup. */
  readonly realpath?: (value: string) => string
  /** Fixed-message Host observer; storage errors are deliberately not exposed. */
  readonly onUsageAuditFailure?: () => void
}

interface StoredState {
  readonly revision: number
  readonly entries: readonly MemoryEntry[]
  readonly audit: readonly MemoryAuditEvent[]
  readonly usage: readonly MemoryUsageRecord[]
}

interface ObservedState {
  readonly state: StoredState
  readonly settingsRevision?: number
  readonly persistenceStatus: 'ready' | 'degraded'
}

/** Strict persisted shape for the profile-owned Xiaoshe memory namespace. */
export const memorySettingsSchema: SettingsSchemaLike = Object.assign(
  (value: unknown): Record<string, JsonValue> => {
    if (value === undefined || value === null) return {}
    if (!isRecord(value)) throw new TypeError('xiaoshe-memory settings must be an object')
    const allowed = new Set(['revision', 'entries', 'audit', 'usage'])
    const extra = Object.keys(value).filter(key => !allowed.has(key))
    if (extra.length > 0) throw new TypeError(`Unknown xiaoshe-memory setting: ${extra.join(', ')}`)
    const result: Record<string, JsonValue> = {}
    if (value.revision !== undefined) {
      if (!isNonNegativeInteger(value.revision)) throw new TypeError('memory revision must be a non-negative integer')
      result.revision = value.revision
    }
    if (value.entries !== undefined) {
      if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) {
        throw new TypeError(`memory entries must be an array with at most ${MAX_ENTRIES} items`)
      }
      const ids = new Set<string>()
      for (const entry of value.entries) {
        validateEntry(entry)
        if (ids.has(entry.id as string)) throw new TypeError(`duplicate memory id: ${String(entry.id)}`)
        ids.add(entry.id as string)
      }
      result.entries = value.entries as JsonValue
    }
    if (value.audit !== undefined) {
      if (!Array.isArray(value.audit) || value.audit.length > MAX_AUDIT_EVENTS) {
        throw new TypeError(`memory audit must be an array with at most ${MAX_AUDIT_EVENTS} items`)
      }
      for (const event of value.audit) validateAudit(event)
      result.audit = value.audit as JsonValue
    }
    if (value.usage !== undefined) {
      if (!Array.isArray(value.usage) || value.usage.length > MAX_ENTRIES) {
        throw new TypeError(`memory usage must be an array with at most ${MAX_ENTRIES} items`)
      }
      for (const usage of value.usage) validateUsage(usage)
      result.usage = value.usage as JsonValue
    }
    return result
  },
  {
    toJSON: () => ({
      uid: 0,
      refs: {
        0: {
          type: 'object',
          meta: { default: { revision: 0, entries: [], audit: [], usage: [] } },
          dict: {
            revision: { type: 'number', meta: { default: 0 } },
            entries: { type: 'array', inner: { type: 'any' }, meta: { default: [] } },
            audit: { type: 'array', inner: { type: 'any' }, meta: { default: [] } },
            usage: { type: 'array', inner: { type: 'any' }, meta: { default: [] } },
          },
        },
      },
    }),
  },
)

export class MemoryRevisionConflictError extends Error {
  readonly name = 'MemoryRevisionConflictError'

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(`memory revision changed from ${expectedRevision} to ${currentRevision}`)
  }
}

/** DSH tools backed by the same service used by the browser workbench. */
export function createMemoryToolDefinitions(service: MemoryService): ToolDefinitionLike[] {
  const output = {
    schema: { type: 'object' },
    render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }
  return [
    {
      name: 'xiaoshe_memory_list',
      description: '列出全局记忆或当前会话项目的记忆。兼容旧调用的 all 也只表示全局加当前项目；这是只读操作。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['global', 'project', 'all'] },
          project: { type: 'string', minLength: 1, maxLength: MAX_PROJECT_LENGTH },
          include_inactive: { type: 'boolean', default: false },
        },
      },
      output,
      async execute(args, exec) {
        const input = toolArgs(args, ['scope', 'project', 'include_inactive'])
        const explicitScope = input.scope
        if (explicitScope !== undefined
          && explicitScope !== 'global'
          && explicitScope !== 'project'
          && explicitScope !== 'all') {
          throw new TypeError('scope must be global, project or all')
        }
        if (input.project !== undefined && typeof input.project !== 'string') {
          throw new TypeError('project must be a string')
        }
        if (input.include_inactive !== undefined && typeof input.include_inactive !== 'boolean') {
          throw new TypeError('include_inactive must be a boolean')
        }
        if (explicitScope === 'project' && input.project === undefined) {
          throw new TypeError('project must be provided when scope is project')
        }
        const callerProject = canonicalProjectKey(exec.agent?.session?.header?.cwd)
        const requestedProject = input.project === undefined
          ? undefined
          : canonicalProjectKey(input.project)
        if (input.project !== undefined && requestedProject === undefined) {
          throw new TypeError('project key is invalid')
        }
        if (explicitScope === 'global' && input.project !== undefined) {
          throw new TypeError('global scope must not include a project')
        }
        if (requestedProject !== undefined
          && (callerProject === undefined || requestedProject !== callerProject)) {
          throw new TypeError('memory tool can only access its current project')
        }
        // Tool arguments are model-controlled. Keep the legacy `all` spelling,
        // but bind it to the caller's session project. The service snapshot API
        // remains the explicit trusted Product/management aggregation port.
        const scope = explicitScope === 'global'
          ? 'global'
          : explicitScope === 'project'
            ? 'project'
            : callerProject === undefined ? 'global' : 'all'
        return service.snapshot({
          scope,
          ...(scope === 'global' || callerProject === undefined ? {} : { project: callerProject }),
          include_inactive: input.include_inactive === true,
        }) as unknown as JsonValue
      },
    },
    {
      name: 'xiaoshe_memory_remember',
      description: '只有用户明确要求记住或修改长期事实时才调用。新增记忆，或用 replaces_id 创建新版本替代旧版本；不得把模型推断自动写入。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['expected_revision', 'scope', 'text'],
        properties: {
          expected_revision: { type: 'integer', minimum: 0 },
          scope: { type: 'string', enum: ['global', 'project'] },
          project: { type: 'string', minLength: 1, maxLength: MAX_PROJECT_LENGTH },
          text: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LENGTH },
          replaces_id: { type: 'string', minLength: 1, maxLength: MAX_ID_LENGTH },
        },
      },
      output,
      async execute(args, exec) {
        const input = toolArgs(args, ['expected_revision', 'scope', 'project', 'text', 'replaces_id'])
        const expectedRevision = toolRevision(input)
        let project = input.project
        if (input.scope === 'project' && typeof input.project === 'string') {
          const requestedProject = canonicalProjectKey(input.project)
          if (requestedProject !== undefined) {
            const callerProject = canonicalProjectKey(exec.agent?.session?.header?.cwd)
            if (callerProject === undefined || requestedProject !== callerProject) {
              throw new TypeError('memory tool can only access its current project')
            }
            // Persist the execution context's canonical identity, never the
            // model-controlled spelling that merely proved equivalent to it.
            project = callerProject
          }
        }
        return await service.remember({
          scope: input.scope as never,
          ...(project === undefined ? {} : { project: project as never }),
          text: input.text as never,
          ...(input.replaces_id === undefined ? {} : { replaces_id: input.replaces_id as never }),
        }, expectedRevision) as unknown as JsonValue
      },
    },
    {
      name: 'xiaoshe_memory_set_state',
      description: '只有用户明确要求忘记或恢复某条记忆时才调用。遗忘可恢复，不会删除历史；superseded 旧版本不能恢复。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['expected_revision', 'id', 'state'],
        properties: {
          expected_revision: { type: 'integer', minimum: 0 },
          id: { type: 'string', minLength: 1, maxLength: MAX_ID_LENGTH },
          state: { type: 'string', enum: ['active', 'forgotten'] },
        },
      },
      output,
      async execute(args, exec) {
        const input = toolArgs(args, ['expected_revision', 'id', 'state'])
        if (typeof input.id !== 'string' || (input.state !== 'active' && input.state !== 'forgotten')) {
          throw new TypeError('id and active or forgotten state are required')
        }
        const expectedRevision = toolRevision(input)
        const callerProject = canonicalProjectKey(exec.agent?.session?.header?.cwd)
        // Scope the model-facing ID lookup before entering the trusted mutation
        // service. Direct service and Product HTTP callers retain their existing
        // profile-wide management capability.
        const visible = service.snapshot({
          scope: callerProject === undefined ? 'global' : 'all',
          ...(callerProject === undefined ? {} : { project: callerProject }),
          include_inactive: true,
        })
        if (visible.revision !== expectedRevision) {
          throw new MemoryRevisionConflictError(expectedRevision, visible.revision)
        }
        if (!visible.entries.some(entry => entry.id === input.id)) {
          throw new TypeError('memory tool can only access its current project')
        }
        return await service.setState(input.id, input.state, expectedRevision) as unknown as JsonValue
      },
    },
  ]
}

/** Create one profile-owned memory service over DSH's durable settings scope. */
export function createMemoryService(
  settings: SettingsScopeLike,
  options: MemoryServiceOptions = {},
): MemoryService {
  const createId = options.createId ?? randomUUID
  const now = options.now ?? (() => new Date())
  const normalizeProject = (value: string | undefined): string | undefined => canonicalProjectKey(value, {
    ...(options.realpath === undefined ? {} : { realpath: options.realpath }),
  })
  let mutation: Promise<void> = Promise.resolve()
  let usageAuditStatus: MemoryDiagnostics['usage_audit_status'] = 'ready'
  let usagePersistenceFailures = 0
  let lastUsagePersistenceErrorAt: string | undefined
  let lastPersistenceWriteFailed = false

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutation.then(operation, operation)
    mutation = next.then(() => undefined, () => undefined)
    return next
  }

  function diagnostics(persistenceStatus: MemoryDiagnostics['persistence_status']): MemoryDiagnostics {
    return {
      persistence_status: persistenceStatus,
      usage_audit_status: usageAuditStatus,
      usage_persistence_failures: usagePersistenceFailures,
      ...(lastUsagePersistenceErrorAt === undefined
        ? {}
        : {
            last_usage_persistence_error: 'MEMORY_USAGE_PERSISTENCE_FAILED' as const,
            last_usage_persistence_error_at: lastUsagePersistenceErrorAt,
          }),
    }
  }

  function currentPersistenceStatus(
    observedStatus: MemoryDiagnostics['persistence_status'] = scopePersistenceStatus(settings),
  ): MemoryDiagnostics['persistence_status'] {
    return lastPersistenceWriteFailed || observedStatus === 'degraded' ? 'degraded' : 'ready'
  }

  function markUsageAuditFailure(): void {
    usageAuditStatus = 'degraded'
    usagePersistenceFailures = Math.min(usagePersistenceFailures + 1, Number.MAX_SAFE_INTEGER)
    try {
      lastUsagePersistenceErrorAt = now().toISOString()
    } catch {
      // A broken injected clock must not hide the original audit failure or
      // prevent the Host from observing degradation.
      lastUsagePersistenceErrorAt = new Date().toISOString()
    }
    try { options.onUsageAuditFailure?.() } catch {
      // Diagnostics must remain available even when a Host logger is faulty.
    }
  }

  async function persistTracked(state: StoredState, expectedSettingsRevision?: number): Promise<void> {
    try {
      await persist(settings, state, expectedSettingsRevision)
      lastPersistenceWriteFailed = false
    } catch (error) {
      if (isSettingsConflict(error)) throw error
      throw new MemoryPersistenceError()
    }
  }

  function rethrowPersistenceFailure(error: unknown): never {
    if (error instanceof MemoryPersistenceError) {
      lastPersistenceWriteFailed = true
      throw error
    }
    if (isSettingsConflict(error)) lastPersistenceWriteFailed = true
    throw error
  }

  return {
    snapshot(query = {}) {
      const observed = observeState(settings)
      return project(observed.state, query, normalizeProject, diagnostics(currentPersistenceStatus(observed.persistenceStatus)))
    },

    remember(input, expectedRevision) {
      return serialize(async () => {
        try {
          const initial = observeState(settings)
          assertMemoryRevision(expectedRevision, initial.state.revision)
          const normalized = normalizeRememberInput(input, normalizeProject)
          const timestamp = now().toISOString()
          const id = createId()
          validateIdentifier(id, 'generated memory id')
          return await retrySettingsConflicts(settings, initial, async (observed) => {
            const current = observed.state
            assertMemoryRevision(expectedRevision, current.revision)
            if (current.entries.length >= MAX_ENTRIES) {
              throw new RangeError(`memory store is limited to ${MAX_ENTRIES} entries`)
            }
            if (current.entries.some(entry => entry.id === id)) {
              throw new Error('generated memory id already exists')
            }
            const replaced = normalized.replaces_id === undefined
              ? undefined
              : current.entries.find(entry => entry.id === normalized.replaces_id && entry.state === 'active')
            if (normalized.replaces_id !== undefined && replaced === undefined) {
              throw new TypeError('memory to replace is missing or inactive')
            }
            if (replaced !== undefined
              && (replaced.scope !== normalized.scope
                || normalizeProject(replaced.project) !== normalized.project)) {
              throw new TypeError('replacement must keep the original memory scope')
            }
            const entry: MemoryEntry = {
              id,
              scope: normalized.scope,
              ...(normalized.project === undefined ? {} : { project: normalized.project }),
              text: normalized.text,
              state: 'active',
              version: replaced === undefined ? 1 : replaced.version + 1,
              created_at: timestamp,
              updated_at: timestamp,
              ...(replaced === undefined ? {} : { supersedes: replaced.id }),
            }
            const next: StoredState = {
              revision: current.revision + 1,
              entries: [
                ...current.entries.map(item => item.id === replaced?.id
                  ? { ...item, state: 'superseded' as const, updated_at: timestamp, superseded_by: id }
                  : item),
                entry,
              ],
              audit: appendAudit(current.audit, {
                revision: current.revision + 1,
                action: replaced === undefined ? 'create' : 'edit',
                entry_id: id,
                ...(replaced === undefined ? {} : { previous_entry_id: replaced.id }),
                at: timestamp,
              }),
              usage: current.usage,
            }
            await persistTracked(next, observed.settingsRevision)
            return project(
              next,
              mutationProjection(normalized.scope, normalized.project),
              normalizeProject,
              diagnostics(currentPersistenceStatus()),
            )
          })
        } catch (error) {
          return rethrowPersistenceFailure(error)
        }
      })
    },

    setState(id, state, expectedRevision) {
      return serialize(async () => {
        try {
          const initial = observeState(settings)
          assertMemoryRevision(expectedRevision, initial.state.revision)
          validateIdentifier(id, 'memory id')
          const timestamp = now().toISOString()
          return await retrySettingsConflicts(settings, initial, async (observed) => {
            const current = observed.state
            assertMemoryRevision(expectedRevision, current.revision)
            const existing = current.entries.find(entry => entry.id === id)
            if (existing === undefined || existing.state === 'superseded') {
              throw new TypeError('memory is missing or cannot change state')
            }
            if (existing.state === state) {
              return project(
                current,
                { ...mutationProjection(existing.scope, normalizeProject(existing.project)), include_inactive: true },
                normalizeProject,
                diagnostics(currentPersistenceStatus(observed.persistenceStatus)),
              )
            }
            const next: StoredState = {
              revision: current.revision + 1,
              entries: current.entries.map(entry => entry.id === id
                ? { ...entry, state, updated_at: timestamp }
                : entry),
              audit: appendAudit(current.audit, {
                revision: current.revision + 1,
                action: state === 'forgotten' ? 'forget' : 'restore',
                entry_id: id,
                at: timestamp,
              }),
              usage: current.usage,
            }
            await persistTracked(next, observed.settingsRevision)
            return project(
              next,
              { ...mutationProjection(existing.scope, normalizeProject(existing.project)), include_inactive: true },
              normalizeProject,
              diagnostics(currentPersistenceStatus()),
            )
          })
        } catch (error) {
          return rethrowPersistenceFailure(error)
        }
      })
    },

    injection(projectKey) {
      const observed = observeState(settings)
      return selectMemoryInjectionWith(
        project(
          observed.state,
          { include_inactive: true },
          normalizeProject,
          diagnostics(currentPersistenceStatus(observed.persistenceStatus)),
        ),
        projectKey,
        normalizeProject,
      )
    },

    recordInjection(input) {
      return serialize(async () => {
        try {
          const normalized = normalizeInjectionInput(input, now, normalizeProject)
          if (normalized.itemIds.length === 0) return
          await retrySettingsConflicts(settings, observeState(settings), async (observed) => {
            const current = observed.state
            const entries = new Map(current.entries.map(entry => [entry.id, entry]))
            for (const id of normalized.itemIds) {
              const entry = entries.get(id)
              if (entry === undefined || entry.state !== 'active') {
                throw new TypeError(`injected memory is missing or inactive: ${id}`)
              }
              if (entry.scope === 'project' && normalizeProject(entry.project) !== normalized.project) {
                throw new TypeError(`project memory does not belong to the injected project: ${id}`)
              }
            }
            const touched = new Set(normalized.itemIds)
            const existing = new Map(current.usage.map(row => [row.entry_id, row]))
            const usage = current.usage.map((row): MemoryUsageRecord => {
              if (!touched.has(row.entry_id)) return row
              if (row.count >= Number.MAX_SAFE_INTEGER) throw new RangeError('memory usage count is exhausted')
              return {
                entry_id: row.entry_id,
                count: row.count + 1,
                last_used_at: normalized.at,
                last_session_id: normalized.sessionId,
                ...(normalized.project === undefined ? {} : { last_project: normalized.project }),
              }
            })
            for (const id of normalized.itemIds) {
              if (existing.has(id)) continue
              usage.push({
                entry_id: id,
                count: 1,
                last_used_at: normalized.at,
                last_session_id: normalized.sessionId,
                ...(normalized.project === undefined ? {} : { last_project: normalized.project }),
              })
            }
            await persistTracked({ ...current, usage }, observed.settingsRevision)
          })
          usageAuditStatus = 'ready'
        } catch (error) {
          markUsageAuditFailure()
          if (error instanceof MemoryPersistenceError || isSettingsConflict(error)) {
            return rethrowPersistenceFailure(error)
          }
          throw error
        }
      })
    },
  }
}

function observeState(settings: SettingsScopeLike): ObservedState {
  const snapshot = settings.getSnapshot?.()
  if (snapshot === undefined) {
    // A legacy or third-party scope can supply values without proving that
    // durable storage is healthy. Keep the data usable but fail health closed.
    return { state: parseStoredState(settings.get()), persistenceStatus: 'degraded' }
  }
  if (!isNonNegativeInteger(snapshot.revision)) {
    throw new TypeError('settings snapshot revision must be a non-negative integer')
  }
  if (snapshot.status !== 'ready' && snapshot.status !== 'degraded') {
    throw new TypeError('settings snapshot status must be ready or degraded')
  }
  return {
    state: parseStoredState(snapshot.value),
    settingsRevision: snapshot.revision,
    persistenceStatus: snapshot.status,
  }
}

function parseStoredState(value: unknown): StoredState {
  const raw = memorySettingsSchema(value)
  return {
    revision: typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0
      ? raw.revision
      : 0,
    entries: Array.isArray(raw.entries) ? raw.entries as unknown as MemoryEntry[] : [],
    audit: Array.isArray(raw.audit) ? raw.audit as unknown as MemoryAuditEvent[] : [],
    usage: Array.isArray(raw.usage) ? raw.usage as unknown as MemoryUsageRecord[] : [],
  }
}

function project(
  state: StoredState,
  query: MemoryQuery,
  normalizeProject: (value: string | undefined) => string | undefined = canonicalProjectKey,
  diagnostics: MemoryDiagnostics = {
    persistence_status: 'ready',
    usage_audit_status: 'ready',
    usage_persistence_failures: 0,
  },
): MemorySnapshot {
  const queryProject = normalizeProject(query.project)
  // Build one scope boundary first, then derive every public collection from
  // it. Filtering entries alone would still disclose another project's ids
  // through audit rows and its aggregate state through counts.
  const scopedEntries = state.entries.filter((entry) => {
    if (query.scope !== undefined && query.scope !== 'all' && entry.scope !== query.scope) return false
    if (entry.scope === 'project' && query.project !== undefined
      && normalizeProject(entry.project) !== queryProject) return false
    return true
  })
  const scopedIds = new Set(scopedEntries.map(entry => entry.id))
  const visible = scopedEntries.filter(entry => query.include_inactive === true || entry.state === 'active')
  const visibleIds = new Set(visible.map(entry => entry.id))
  const crossProjectMetadataAllowed = query.project === undefined
    && (query.scope === undefined || query.scope === 'all')
  return {
    api_version: 1,
    revision: state.revision,
    ...(queryProject === undefined ? {} : { project: queryProject }),
    counts: {
      active: scopedEntries.filter(entry => entry.state === 'active').length,
      global: scopedEntries.filter(entry => entry.state === 'active' && entry.scope === 'global').length,
      project: scopedEntries.filter(entry => entry.state === 'active' && entry.scope === 'project').length,
      forgotten: scopedEntries.filter(entry => entry.state === 'forgotten').length,
      superseded: scopedEntries.filter(entry => entry.state === 'superseded').length,
    },
    entries: visible,
    audit: state.audit.filter(row => scopedIds.has(row.entry_id)
      && (row.previous_entry_id === undefined || scopedIds.has(row.previous_entry_id))),
    usage: state.usage.flatMap((row): MemoryUsageRecord[] => {
      if (!visibleIds.has(row.entry_id)) return []
      if (row.last_project !== undefined && !crossProjectMetadataAllowed
        && (queryProject === undefined || normalizeProject(row.last_project) !== queryProject)) {
        const { last_project: _hiddenProject, ...safe } = row
        return [safe]
      }
      return [row]
    }),
    diagnostics,
  }
}

/** Keep mutation responses useful to their caller without returning another project. */
function mutationProjection(scope: MemoryScope, project: string | undefined): MemoryQuery {
  return scope === 'global'
    ? { scope: 'global' }
    : { scope: 'all', ...(project === undefined ? {} : { project }) }
}

async function persist(
  settings: SettingsScopeLike,
  state: StoredState,
  expectedSettingsRevision?: number,
): Promise<void> {
  const section = {
    revision: state.revision,
    entries: state.entries as unknown as JsonValue,
    audit: state.audit as unknown as JsonValue,
    usage: state.usage as unknown as JsonValue,
  }
  if (settings.replace !== undefined) {
    await settings.replace(section, expectedSettingsRevision)
    return
  }
  await settings.update(section, expectedSettingsRevision)
}

function assertMemoryRevision(expectedRevision: number, currentRevision: number): void {
  if (expectedRevision !== currentRevision) {
    throw new MemoryRevisionConflictError(expectedRevision, currentRevision)
  }
}

/**
 * Rebuild a whole-section mutation from the newest durable snapshot whenever
 * another provider wins the namespace CAS. The retry is bounded so sustained
 * contention becomes an explicit failure rather than an infinite busy loop.
 */
async function retrySettingsConflicts<T>(
  settings: SettingsScopeLike,
  initial: ObservedState,
  operation: (observed: ObservedState) => Promise<T>,
): Promise<T> {
  let observed = initial
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(observed)
    } catch (error) {
      if (!isSettingsConflict(error) || attempt >= MAX_SETTINGS_CONFLICT_RETRIES - 1) throw error
      observed = observeState(settings)
    }
  }
}

function scopePersistenceStatus(settings: SettingsScopeLike): MemoryDiagnostics['persistence_status'] {
  return settings.getSnapshot?.().status === 'ready' ? 'ready' : 'degraded'
}

function isSettingsConflict(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'SETTINGS_CONFLICT'
}

export class MemoryPersistenceError extends Error {
  readonly name = 'MemoryPersistenceError'

  constructor() { super('memory persistence failed') }
}

function normalizeInjectionInput(
  input: RecordMemoryInjectionInput,
  now: () => Date,
  normalizeProject: (value: string | undefined) => string | undefined,
): { readonly sessionId: string; readonly project?: string; readonly itemIds: readonly string[]; readonly at: string } {
  if (!isRecord(input)) throw new TypeError('memory injection audit must be an object')
  assertOnlyKeys(input, ['sessionId', 'project', 'itemIds', 'at'], 'memory injection audit')
  validateIdentifier(input.sessionId, 'sessionId')
  if (!Array.isArray(input.itemIds) || input.itemIds.length > MAX_INJECTION_ITEMS) {
    throw new TypeError(`itemIds must contain at most ${MAX_INJECTION_ITEMS} memory ids`)
  }
  const itemIds = input.itemIds.map((id) => {
    validateIdentifier(id, 'injected memory id')
    return id
  })
  if (new Set(itemIds).size !== itemIds.length) throw new TypeError('itemIds must be unique')
  const project = normalizeProject(typeof input.project === 'string' ? input.project : undefined)
  if (input.project !== undefined && project === undefined) throw new TypeError('project key is invalid')
  const at = input.at === undefined ? now().toISOString() : input.at
  validateTimestamp(at, 'injection timestamp')
  return {
    sessionId: input.sessionId,
    ...(project === undefined ? {} : { project }),
    itemIds,
    at,
  }
}

function appendAudit(
  current: readonly MemoryAuditEvent[],
  event: MemoryAuditEvent,
): readonly MemoryAuditEvent[] {
  return [...current, event].slice(-MAX_AUDIT_EVENTS)
}

function normalizeRememberInput(
  input: RememberMemoryInput,
  normalizeProject: (value: string | undefined) => string | undefined,
): RememberMemoryInput {
  if (!isRecord(input) || (input.scope !== 'global' && input.scope !== 'project')) {
    throw new TypeError('memory scope must be global or project')
  }
  if (typeof input.text !== 'string') throw new TypeError('memory text must be a string')
  const text = input.text.trim()
  if (text === '' || text.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`memory text must contain 1 to ${MAX_TEXT_LENGTH} characters`)
  }
  let project: string | undefined
  if (input.scope === 'project') {
    if (typeof input.project !== 'string') throw new TypeError('project memory requires a project key')
    project = normalizeProject(input.project)
    if (project === undefined) {
      throw new TypeError(`project key must contain 1 to ${MAX_PROJECT_LENGTH} characters`)
    }
  } else if (input.project !== undefined) {
    throw new TypeError('global memory must not include a project key')
  }
  if (input.replaces_id !== undefined) validateIdentifier(input.replaces_id, 'replaces_id')
  return {
    scope: input.scope,
    ...(project === undefined ? {} : { project }),
    text,
    ...(input.replaces_id === undefined ? {} : { replaces_id: input.replaces_id }),
  }
}

function validateEntry(value: unknown): asserts value is Record<string, JsonValue> {
  if (!isRecord(value)) throw new TypeError('memory entry must be an object')
  assertOnlyKeys(value, [
    'id', 'scope', 'project', 'text', 'state', 'version', 'created_at', 'updated_at',
    'supersedes', 'superseded_by',
  ], 'memory entry')
  validateIdentifier(value.id, 'memory id')
  if (value.scope !== 'global' && value.scope !== 'project') throw new TypeError('memory entry scope is invalid')
  if (typeof value.text !== 'string' || value.text.trim() === '' || value.text.length > MAX_TEXT_LENGTH) {
    throw new TypeError(`memory entry text must contain 1 to ${MAX_TEXT_LENGTH} characters`)
  }
  if (value.state !== 'active' && value.state !== 'forgotten' && value.state !== 'superseded') {
    throw new TypeError('memory entry state is invalid')
  }
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) {
    throw new TypeError('memory entry version must be a positive integer')
  }
  validateTimestamp(value.created_at, 'created_at')
  validateTimestamp(value.updated_at, 'updated_at')
  if (value.scope === 'project') {
    if (typeof value.project !== 'string' || value.project.trim() === '' || value.project.length > MAX_PROJECT_LENGTH) {
      throw new TypeError('project memory entry requires a valid project key')
    }
  } else if (value.project !== undefined) {
    throw new TypeError('global memory entry must not include a project key')
  }
  if (value.supersedes !== undefined) validateIdentifier(value.supersedes, 'supersedes')
  if (value.superseded_by !== undefined) validateIdentifier(value.superseded_by, 'superseded_by')
}

function validateAudit(value: unknown): asserts value is Record<string, JsonValue> {
  if (!isRecord(value)) throw new TypeError('memory audit event must be an object')
  assertOnlyKeys(value, ['revision', 'action', 'entry_id', 'previous_entry_id', 'at'], 'memory audit event')
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) {
    throw new TypeError('memory audit revision must be a positive integer')
  }
  if (value.action !== 'create' && value.action !== 'edit'
    && value.action !== 'forget' && value.action !== 'restore') {
    throw new TypeError('memory audit action is invalid')
  }
  validateIdentifier(value.entry_id, 'audit entry_id')
  if (value.previous_entry_id !== undefined) validateIdentifier(value.previous_entry_id, 'audit previous_entry_id')
  validateTimestamp(value.at, 'audit timestamp')
}

function validateUsage(value: unknown): asserts value is Record<string, JsonValue> {
  if (!isRecord(value)) throw new TypeError('memory usage record must be an object')
  assertOnlyKeys(value, ['entry_id', 'count', 'last_used_at', 'last_session_id', 'last_project'], 'memory usage record')
  validateIdentifier(value.entry_id, 'usage entry_id')
  if (!Number.isSafeInteger(value.count) || Number(value.count) < 1) {
    throw new TypeError('memory usage count must be a positive integer')
  }
  validateTimestamp(value.last_used_at, 'usage last_used_at')
  validateIdentifier(value.last_session_id, 'usage last_session_id')
  if (value.last_project !== undefined) {
    if (typeof value.last_project !== 'string' || canonicalProjectKey(value.last_project) === undefined) {
      throw new TypeError('usage last_project is invalid')
    }
  }
}

function validateIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ID_LENGTH) {
    throw new TypeError(`${name} must contain 1 to ${MAX_ID_LENGTH} characters`)
  }
}

function validateTimestamp(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp`)
  }
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const allowed = new Set(keys)
  const extra = Object.keys(value).filter(key => !allowed.has(key))
  if (extra.length > 0) throw new TypeError(`Unknown ${name} field: ${extra.join(', ')}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function toolArgs(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('memory tool arguments must be an object')
  assertOnlyKeys(value, fields, 'memory tool argument')
  return value
}

function toolRevision(value: Record<string, unknown>): number {
  if (!isNonNegativeInteger(value.expected_revision)) {
    throw new TypeError('expected_revision must be a non-negative integer')
  }
  return value.expected_revision
}

export type MemoryInjectionReason = 'global-preference' | 'project-context'

export interface MemoryInjectionItem {
  readonly id: string
  readonly version: number
  readonly scope: MemoryScope
  readonly reason: MemoryInjectionReason
}

export interface MemoryInjection {
  readonly project?: string
  readonly items: readonly MemoryInjectionItem[]
  readonly text: string
}

/**
 * Select active global memories plus memories owned by the exact Agent cwd.
 * The trace frame makes every prompt contribution attributable without
 * exposing forgotten, superseded, or another project's content.
 */
export function selectMemoryInjection(snapshot: MemorySnapshot, projectKey?: string): MemoryInjection {
  return selectMemoryInjectionWith(snapshot, projectKey, canonicalProjectKey)
}

function selectMemoryInjectionWith(
  snapshot: MemorySnapshot,
  projectKey: string | undefined,
  normalizeProject: (value: string | undefined) => string | undefined,
): MemoryInjection {
  const project = normalizeProject(projectKey)
  const selected = snapshot.entries.flatMap((entry): Array<{
    readonly entry: MemoryEntry
    readonly item: MemoryInjectionItem
  }> => {
    if (entry.state !== 'active') return []
    const reason: MemoryInjectionReason | undefined = entry.scope === 'global'
      ? 'global-preference'
      : project !== undefined && normalizeProject(entry.project) === project
        ? 'project-context'
        : undefined
    if (reason === undefined) return []
    return [{
      entry,
      item: {
        id: entry.id,
        version: entry.version,
        scope: entry.scope,
        reason,
      },
    }]
  })

  return {
    ...(project === undefined ? {} : { project }),
    items: selected.map(({ item }) => item),
    text: selected.map(({ entry, item }) => [
      `<xiaoshe-memory id="${escapeMemoryAttribute(item.id)}" version="${item.version}" scope="${item.scope}" reason="${item.reason}">`,
      escapeMemoryText(entry.text),
      '</xiaoshe-memory>',
    ].join('\n')).join('\n'),
  }
}

export interface CanonicalProjectKeyOptions {
  readonly realpath?: (value: string) => string
}

/**
 * Build the durable identity used for project-scoped memory.
 *
 * Windows drive and UNC paths are normalized case-insensitively even when
 * this package is tested on another OS. Existing local paths additionally
 * use filesystem identity so junction/symlink aliases converge. Missing and
 * remote paths fall back to deterministic lexical normalization.
 */
export function canonicalProjectKey(
  value: string | undefined,
  options: CanonicalProjectKeyOptions = {},
): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_PROJECT_LENGTH) return undefined

  const windowsPath = /^[A-Za-z]:[\\/]/u.test(trimmed) || /^[\\/]{2}[^\\/]/u.test(trimmed)
  const uncPath = /^[\\/]{2}[^\\/]/u.test(trimmed)
  const pathApi = windowsPath ? win32 : posix
  let normalized = pathApi.normalize(trimmed)

  const absolute = pathApi.isAbsolute(normalized)
  if (absolute && !uncPath) {
    try {
      normalized = (options.realpath ?? realpathSync.native)(normalized)
      normalized = pathApi.normalize(normalized)
    } catch {
      // Missing/inaccessible projects still need a stable lexical identity.
    }
  }

  const root = pathApi.parse(normalized).root
  if (normalized.length > root.length) normalized = normalized.replace(/[\\/]+$/u, '')

  if (windowsPath) {
    normalized = normalized
      .replace(/^\\\\\?\\UNC\\/iu, '\\\\')
      .replace(/^\\\\\?\\/u, '')
      .toLocaleLowerCase('en-US')
  }
  if (normalized === '' || normalized.length > MAX_PROJECT_LENGTH) return undefined
  return normalized
}

function escapeMemoryAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeMemoryText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
