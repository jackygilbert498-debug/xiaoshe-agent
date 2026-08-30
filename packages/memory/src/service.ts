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

export interface MemorySnapshot {
  readonly api_version: 1
  readonly revision: number
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
}

interface StoredState {
  readonly revision: number
  readonly entries: readonly MemoryEntry[]
  readonly audit: readonly MemoryAuditEvent[]
  readonly usage: readonly MemoryUsageRecord[]
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
      description: '列出当前小蛇 Profile 中的长期或项目记忆。项目记忆必须提供准确的 project 键；这是只读操作。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: ['global', 'project', 'all'], default: 'all' },
          project: { type: 'string', minLength: 1, maxLength: MAX_PROJECT_LENGTH },
          include_inactive: { type: 'boolean', default: false },
        },
      },
      output,
      async execute(args) {
        const input = toolArgs(args, ['scope', 'project', 'include_inactive'])
        const scope = input.scope ?? 'all'
        if (scope !== 'global' && scope !== 'project' && scope !== 'all') {
          throw new TypeError('scope must be global, project or all')
        }
        if (input.project !== undefined && typeof input.project !== 'string') {
          throw new TypeError('project must be a string')
        }
        if (input.include_inactive !== undefined && typeof input.include_inactive !== 'boolean') {
          throw new TypeError('include_inactive must be a boolean')
        }
        return service.snapshot({
          scope,
          ...(input.project === undefined ? {} : { project: input.project }),
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
      async execute(args) {
        const input = toolArgs(args, ['expected_revision', 'scope', 'project', 'text', 'replaces_id'])
        return await service.remember({
          scope: input.scope as never,
          ...(input.project === undefined ? {} : { project: input.project as never }),
          text: input.text as never,
          ...(input.replaces_id === undefined ? {} : { replaces_id: input.replaces_id as never }),
        }, toolRevision(input)) as unknown as JsonValue
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
      async execute(args) {
        const input = toolArgs(args, ['expected_revision', 'id', 'state'])
        if (typeof input.id !== 'string' || (input.state !== 'active' && input.state !== 'forgotten')) {
          throw new TypeError('id and active or forgotten state are required')
        }
        return await service.setState(input.id, input.state, toolRevision(input)) as unknown as JsonValue
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

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutation.then(operation, operation)
    mutation = next.then(() => undefined, () => undefined)
    return next
  }

  return {
    snapshot(query = {}) {
      return project(readState(settings), query, normalizeProject)
    },

    remember(input, expectedRevision) {
      return serialize(async () => {
        const current = readState(settings)
        if (expectedRevision !== current.revision) {
          throw new MemoryRevisionConflictError(expectedRevision, current.revision)
        }
        if (current.entries.length >= MAX_ENTRIES) {
          throw new RangeError(`memory store is limited to ${MAX_ENTRIES} entries`)
        }
        const normalized = normalizeRememberInput(input, normalizeProject)
        const timestamp = now().toISOString()
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
        const id = createId()
        validateIdentifier(id, 'generated memory id')
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
        await persist(settings, next)
        return project(next, {}, normalizeProject)
      })
    },

    setState(id, state, expectedRevision) {
      return serialize(async () => {
        const current = readState(settings)
        if (expectedRevision !== current.revision) {
          throw new MemoryRevisionConflictError(expectedRevision, current.revision)
        }
        const existing = current.entries.find(entry => entry.id === id)
        if (existing === undefined || existing.state === 'superseded') {
          throw new TypeError('memory is missing or cannot change state')
        }
        if (existing.state === state) return project(current, {}, normalizeProject)
        const timestamp = now().toISOString()
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
        await persist(settings, next)
        return project(next, {}, normalizeProject)
      })
    },

    injection(projectKey) {
      return selectMemoryInjectionWith(
        project(readState(settings), { include_inactive: true }, normalizeProject),
        projectKey,
        normalizeProject,
      )
    },

    recordInjection(input) {
      const normalized = normalizeInjectionInput(input, now, normalizeProject)
      if (normalized.itemIds.length === 0) return Promise.resolve()
      return serialize(async () => {
        const current = readState(settings)
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
        await persist(settings, { ...current, usage })
      })
    },
  }
}

function readState(settings: SettingsScopeLike): StoredState {
  const raw = memorySettingsSchema(settings.get())
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
): MemorySnapshot {
  const queryProject = normalizeProject(query.project)
  const visible = state.entries.filter((entry) => {
    if (query.include_inactive !== true && entry.state !== 'active') return false
    if (query.scope !== undefined && query.scope !== 'all' && entry.scope !== query.scope) return false
    if (entry.scope === 'project' && query.project !== undefined
      && normalizeProject(entry.project) !== queryProject) return false
    return true
  })
  return {
    api_version: 1,
    revision: state.revision,
    counts: {
      active: state.entries.filter(entry => entry.state === 'active').length,
      global: state.entries.filter(entry => entry.state === 'active' && entry.scope === 'global').length,
      project: state.entries.filter(entry => entry.state === 'active' && entry.scope === 'project').length,
      forgotten: state.entries.filter(entry => entry.state === 'forgotten').length,
      superseded: state.entries.filter(entry => entry.state === 'superseded').length,
    },
    entries: visible,
    audit: state.audit,
    usage: state.usage.filter(row => visible.some(entry => entry.id === row.entry_id)),
  }
}

async function persist(settings: SettingsScopeLike, state: StoredState): Promise<void> {
  await settings.update({
    revision: state.revision,
    entries: state.entries as unknown as JsonValue,
    audit: state.audit as unknown as JsonValue,
    usage: state.usage as unknown as JsonValue,
  })
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
