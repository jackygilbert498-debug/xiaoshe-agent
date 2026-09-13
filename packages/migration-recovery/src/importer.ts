import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { MigrationJournal } from './journal.js'
import { mapWorkspacePath, normalizeBundlePath, type WorkspacePathMapping } from './path-map.js'
import { canonicalJson, sha256Bytes, verifyMigrationDirectory } from './schema.js'

interface SessionPort { list(signal?: AbortSignal): Promise<readonly Record<string, unknown>[]>; inspect(id: string, signal?: AbortSignal): Promise<{ readonly meta: Record<string, unknown>; readonly events: readonly unknown[] }>; create(meta: Record<string, unknown>): Promise<void>; append(id: string, events: readonly unknown[]): Promise<void> }
interface WorkspacePort { list(): readonly Readonly<Record<string, unknown>>[]; create(path: string, title?: string): Promise<Readonly<Record<string, unknown>> & { attachSession?(id: string): Promise<void> }>; archiveSession?(id: string): Promise<void>; readonly archivedSessionIds?: readonly unknown[] }
interface AttachmentPort { saveImage(input: { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }): Promise<Readonly<Record<string, unknown>>> }
interface SettingsPathSet { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
interface SettingsPort { describe(options?: { readonly redactSecrets: boolean }): readonly Readonly<Record<string, unknown>>[]; mutate(ns: string, ops: readonly SettingsPathSet[], expectedRevision?: number): Promise<void> }

export interface MigrationConflict { readonly kind: 'path-unmapped' | 'session-different' | 'settings-different'; readonly id: string; readonly detail: string }
export interface MigrationPreview {
  readonly bundlePath: string; readonly bundleHash: string; readonly mappings: readonly WorkspacePathMapping[]
  readonly sessions: readonly { readonly id: string; readonly action: 'create' | 'resume-events' | 'skip-identical'; readonly mappedCwd?: string }[]
  readonly conflicts: readonly MigrationConflict[]
}

/** Inspect first, then apply only a still-identical bundle with no conflicts. */
export class MigrationImporter {
  readonly #journal: MigrationJournal
  constructor(private readonly ports: { readonly sessions: SessionPort; readonly workspaces?: WorkspacePort; readonly attachments?: AttachmentPort; readonly settings?: SettingsPort; readonly journalPath: string }) { this.#journal = new MigrationJournal(ports.journalPath) }

  async preview(bundlePath: string, mappings: readonly WorkspacePathMapping[], signal?: AbortSignal): Promise<MigrationPreview> {
    const manifest = await verifyMigrationDirectory(bundlePath)
    const bundleHash = sha256Bytes(Buffer.from(canonicalJson(manifest)))
    const attachmentIndex = await readOptionalJson(bundlePath, manifest.files, 'attachments/index.json')
    if (attachmentIndex !== undefined) {
      if (!Array.isArray(attachmentIndex)) throw new TypeError('migration attachment index is invalid')
      const declared = new Set(manifest.files.map(row => row.path))
      const attachmentIds = new Set<string>()
      for (const item of attachmentIndex) {
        if (!isRecord(item) || !isRecord(item.ref) || typeof item.ref.attachmentId !== 'string'
          || typeof item.ref.mediaType !== 'string' || typeof item.file !== 'string') {
          throw new TypeError('migration attachment index is invalid')
        }
        assertUniqueIdentity(item.ref.attachmentId, attachmentIds, 'attachment')
        let file: string
        try { file = normalizeBundlePath(item.file) } catch { throw new TypeError('unsafe attachment path outside migration bundle') }
        if (!file.startsWith('attachments/') || file === 'attachments/index.json' || !declared.has(file)) {
          throw new TypeError('migration attachment file is not declared inside the verified bundle')
        }
      }
    }
    const completed = this.#journal.open(bundleHash)
    const pending = this.#journal.pending(bundleHash)
    const existing = new Map((await this.ports.sessions.list(signal)).map(row => [String(row.id), row]))
    const conflicts: MigrationConflict[] = []
    const sessions = []
    const importedSessionIds = new Set<string>()
    for (const file of manifest.files.filter(row => row.path.startsWith('sessions/') && row.path.endsWith('.json'))) {
      const document = await readVerifiedJson(bundlePath, manifest.files, file.path)
      const meta = requiredRecord(document, 'meta')
      const events = requiredArray(document, 'events')
      const id = String(meta.id ?? '')
      if (id.trim() === '' || importedSessionIds.has(id)) throw new TypeError('migration bundle contains an invalid or duplicate session identity')
      importedSessionIds.add(id)
      const sourceCwd = typeof meta.cwd === 'string' ? meta.cwd : undefined
      const mappedCwd = sourceCwd === undefined ? undefined : mapWorkspacePath(sourceCwd, mappings)
      if (sourceCwd !== undefined && mappedCwd === undefined) conflicts.push({ kind: 'path-unmapped', id, detail: sourceCwd })
      const mapped = { ...meta, ...(mappedCwd === undefined ? {} : { cwd: mappedCwd }) }
      const current = existing.get(id)
      let action: 'create' | 'resume-events' | 'skip-identical' = 'create'
      if (current !== undefined) {
        const inspection = await this.ports.sessions.inspect(id, signal)
        if (canonicalJson({ meta: inspection.meta, events: inspection.events }) === canonicalJson({ meta: mapped, events })) action = 'skip-identical'
        else if (
          (completed.has(`session:${id}:created`) || pending.has(`session:${id}:created`))
          && canonicalJson(inspection.meta) === canonicalJson(mapped)
          && inspection.events.length === 0
        ) action = 'resume-events'
        else conflicts.push({ kind: 'session-different', id, detail: '目标设备已有同 ID 的不同会话' })
      }
      sessions.push(Object.freeze({ id, action, ...(mappedCwd === undefined ? {} : { mappedCwd }) }))
    }
    const importedSettings = await readOptionalJson(bundlePath, manifest.files, 'settings.json')
    if (importedSettings !== undefined && !Array.isArray(importedSettings)) throw new TypeError('migration settings are invalid')
    if (Array.isArray(importedSettings)) {
      const settingNamespaces = new Set<string>()
      const rows = importedSettings.map((row) => {
        if (!isRecord(row) || typeof row.ns !== 'string' || row.ns.trim() === '' || !isRecord(row.user)) throw new TypeError('migration settings record is invalid')
        assertUniqueIdentity(row.ns, settingNamespaces, 'settings')
        return row
      })
      const statusAware = rows.map(row => Object.prototype.hasOwnProperty.call(row, 'status'))
      if (statusAware.some(Boolean) && !statusAware.every(Boolean)) {
        throw new TypeError('migration source settings status encoding is invalid')
      }
      // The original schema-v1 exporter did not emit `status`. An all-omitted
      // document is therefore migrated as the legacy ready default. Explicit
      // status values, and mixed old/new rows, are never defaulted silently.
      if (statusAware.every(Boolean)) for (const row of rows) assertSettingsReady(row, 'source')
    }
    if (this.ports.settings !== undefined) {
      const described = this.ports.settings.describe({ redactSecrets: true })
      for (const row of described) assertSettingsReady(row, 'target')
      const current = new Map(described.map(row => [String(row.ns), row]))
      if (Array.isArray(importedSettings)) for (const row of importedSettings) {
        if (!isRecord(row) || typeof row.ns !== 'string' || !isRecord(row.user)) continue
        const descriptor = current.get(row.ns)
        const before = descriptor?.user
        if (canonicalJson(before) !== canonicalJson(row.user)) {
          // A path write can preserve hidden object siblings, but the Settings
          // seam cannot address array indexes. Replacing such an array would
          // silently erase a target-only secret, so reject before any session
          // or settings mutation instead of producing a lossy migration.
          buildSafeSettingsOps(row.ns, row.user, descriptor?.secrets)
        }
        if (isRecord(before) && Object.keys(before).length > 0 && canonicalJson(before) !== canonicalJson(row.user)) conflicts.push({ kind: 'settings-different', id: row.ns, detail: '目标设置已有不同用户层' })
      }
    }
    const importedWorkspaces = await readOptionalJson(bundlePath, manifest.files, 'workspaces.json')
    if (importedWorkspaces !== undefined && (!isRecord(importedWorkspaces) || !Array.isArray(importedWorkspaces.workspaces) || !Array.isArray(importedWorkspaces.archivedSessionIds))) {
      throw new TypeError('migration workspaces are invalid')
    }
    if (isRecord(importedWorkspaces) && Array.isArray(importedWorkspaces.workspaces)) {
      const workspaceIds = new Set<string>()
      for (const row of importedWorkspaces.workspaces) {
        if (!isRecord(row) || typeof row.id !== 'string' || row.id.trim() === '' || typeof row.path !== 'string' || !Array.isArray(row.sessionIds)) {
          throw new TypeError('migration workspace record is invalid')
        }
        assertUniqueIdentity(row.id, workspaceIds, 'workspace')
        if (mapWorkspacePath(row.path, mappings) === undefined) {
          conflicts.push({ kind: 'path-unmapped', id: String(row.id ?? ''), detail: row.path })
        }
      }
    }
    return Object.freeze({ bundlePath, bundleHash, mappings: Object.freeze(mappings.map(row => Object.freeze({ ...row }))), sessions: Object.freeze(sessions), conflicts: Object.freeze(conflicts) })
  }

  async apply(preview: MigrationPreview, signal?: AbortSignal): Promise<void> {
    if (preview.conflicts.length > 0) throw new Error('migration preview contains conflicts')
    // Confirmation binds the source bundle, but the target can still change
    // while the user is deciding. Re-preview immediately before the first
    // write so a stale create/skip decision cannot overwrite or falsely adopt
    // concurrent target state.
    const current = await this.preview(preview.bundlePath, preview.mappings, signal)
    if (current.bundleHash !== preview.bundleHash) throw new Error('migration bundle changed after preview')
    if (current.conflicts.length > 0) throw new Error('migration target changed after preview; inspect conflicts again')
    preview = current
    const manifest = await verifyMigrationDirectory(preview.bundlePath)
    const bundleHash = sha256Bytes(Buffer.from(canonicalJson(manifest)))
    if (bundleHash !== preview.bundleHash) throw new Error('migration bundle changed after preview')
    const completed = new Set(this.#journal.open(bundleHash))
    const pending = new Set(this.#journal.pending(bundleHash))
    const attachments = await readOptionalJson(preview.bundlePath, manifest.files, 'attachments/index.json')
    if (this.ports.attachments !== undefined && Array.isArray(attachments)) for (const item of attachments) {
      signal?.throwIfAborted()
      if (!isRecord(item) || !isRecord(item.ref) || typeof item.file !== 'string') throw new TypeError('attachment index is invalid')
      const key = `attachment:${String(item.ref.attachmentId)}`
      if (completed.has(key)) continue
      await this.#journal.begin(bundleHash, key); pending.add(key)
      const data = await readVerifiedBytes(preview.bundlePath, manifest.files, item.file)
      const saved = await this.ports.attachments.saveImage({ data, mediaType: String(item.ref.mediaType), ...(typeof item.ref.name === 'string' ? { name: item.ref.name } : {}) })
      if (String(saved.attachmentId) !== String(item.ref.attachmentId)) throw new Error('restored attachment identity does not match the session log')
      await this.#journal.complete(bundleHash, key); pending.delete(key); completed.add(key)
    }
    for (const row of preview.sessions) {
      signal?.throwIfAborted()
      const createdKey = `session:${row.id}:created`
      const eventsKey = `session:${row.id}:events`
      if (row.action === 'skip-identical') {
        if (!completed.has(createdKey)) { await this.#journal.complete(bundleHash, createdKey); pending.delete(createdKey); completed.add(createdKey) }
        if (!completed.has(eventsKey)) { await this.#journal.complete(bundleHash, eventsKey); pending.delete(eventsKey); completed.add(eventsKey) }
        continue
      }
      const document = await sessionDocument(preview.bundlePath, manifest.files, row.id)
      const meta = { ...requiredRecord(document, 'meta'), ...(row.mappedCwd === undefined ? {} : { cwd: row.mappedCwd }) }
      const events = requiredArray(document, 'events')
      if (!completed.has(createdKey)) {
        if (row.action === 'create') {
          await this.#journal.begin(bundleHash, createdKey); pending.add(createdKey)
          await this.ports.sessions.create(meta)
        }
        await this.#journal.complete(bundleHash, createdKey); pending.delete(createdKey)
        completed.add(createdKey)
      }
      if (!completed.has(eventsKey)) {
        await this.#journal.begin(bundleHash, eventsKey); pending.add(eventsKey)
        if (events.length > 0) await this.ports.sessions.append(row.id, events)
        await this.#journal.complete(bundleHash, eventsKey); pending.delete(eventsKey)
        completed.add(eventsKey)
      }
    }
    if (this.ports.settings !== undefined) {
      const settings = await readOptionalJson(preview.bundlePath, manifest.files, 'settings.json')
      const current = new Map(this.ports.settings.describe({ redactSecrets: true }).map(row => [String(row.ns), row]))
      if (Array.isArray(settings)) for (const row of settings) {
        if (!isRecord(row) || typeof row.ns !== 'string' || !isRecord(row.user)) continue
        const key = `settings:${row.ns}`
        if (completed.has(key)) continue
        const descriptor = current.get(row.ns)
        if (isRecord(descriptor?.user) && canonicalJson(descriptor.user) === canonicalJson(row.user)) {
          await this.#journal.complete(bundleHash, key); pending.delete(key); completed.add(key)
          continue
        }
        await this.#journal.begin(bundleHash, key); pending.add(key)
        // The migration file contains a redacted view. Path writes preserve
        // secret fields that were deliberately omitted from that view; a
        // wholesale replace would silently delete the target device's key.
        const ops = buildSafeSettingsOps(row.ns, row.user, descriptor?.secrets)
        if (ops.length > 0) {
          await this.ports.settings.mutate(row.ns, ops, typeof descriptor?.revision === 'number' ? descriptor.revision : undefined)
        }
        await this.#journal.complete(bundleHash, key); pending.delete(key); completed.add(key)
      }
    }
    if (this.ports.workspaces !== undefined) {
      const workspacesDoc = await readOptionalJson(preview.bundlePath, manifest.files, 'workspaces.json')
      if (isRecord(workspacesDoc) && Array.isArray(workspacesDoc.workspaces)) for (const source of workspacesDoc.workspaces) {
        if (!isRecord(source) || typeof source.path !== 'string') continue
        const mapped = mapWorkspacePath(source.path, preview.mappings)
        if (mapped === undefined) throw new Error(`workspace path was not mapped: ${source.path}`)
        const key = `workspace:${String(source.id)}`
        if (completed.has(key)) continue
        await this.#journal.begin(bundleHash, key); pending.add(key)
        const existing = this.ports.workspaces.list().find(row => row.path === mapped)
        const workspace = existing ?? await this.ports.workspaces.create(mapped, typeof source.title === 'string' ? source.title : undefined)
        const attached = new Set(Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [])
        if (typeof workspace.attachSession === 'function' && Array.isArray(source.sessionIds)) for (const id of source.sessionIds.map(String)) {
          if (!attached.has(id)) { await workspace.attachSession(id); attached.add(id) }
        }
        await this.#journal.complete(bundleHash, key); pending.delete(key); completed.add(key)
      }
      if (isRecord(workspacesDoc) && Array.isArray(workspacesDoc.archivedSessionIds) && this.ports.workspaces.archiveSession !== undefined) {
        const archived = new Set((this.ports.workspaces.archivedSessionIds ?? []).map(String))
        for (const rawId of workspacesDoc.archivedSessionIds) {
          const id = String(rawId)
          const key = `archive:${id}`
          if (completed.has(key)) continue
          if (pending.has(key) && archived.has(id)) {
            await this.#journal.complete(bundleHash, key); pending.delete(key); completed.add(key)
            continue
          }
          await this.#journal.begin(bundleHash, key); pending.add(key)
          await this.ports.workspaces.archiveSession(id)
          await this.#journal.complete(bundleHash, key); pending.delete(key); completed.add(key)
          archived.add(id)
        }
      }
    }
  }
}

interface VerifiedFile { readonly path: string; readonly bytes: number; readonly sha256: string }
async function sessionDocument(root: string, files: readonly VerifiedFile[], id: string): Promise<Record<string, unknown>> {
  for (const file of files.filter(row => row.path.startsWith('sessions/'))) { const value = await readVerifiedJson(root, files, file.path); if (isRecord(value) && isRecord(value.meta) && String(value.meta.id) === id) return value }
  throw new Error(`session document not found: ${id}`)
}
async function readOptionalJson(root: string, files: readonly VerifiedFile[], path: string): Promise<unknown> { return files.some(row => row.path === path) ? await readVerifiedJson(root, files, path) : undefined }
async function readVerifiedJson(root: string, files: readonly VerifiedFile[], path: string): Promise<unknown> { return JSON.parse((await readVerifiedBytes(root, files, path)).toString('utf8')) }
async function readVerifiedBytes(root: string, files: readonly VerifiedFile[], path: string): Promise<Buffer> {
  const normalized = normalizeBundlePath(path)
  const entry = files.find(row => row.path === normalized)
  if (entry === undefined) throw new TypeError(`migration file is not declared: ${normalized}`)
  const data = await readFile(resolve(root, ...normalized.split('/')))
  if (data.byteLength !== entry.bytes || sha256Bytes(data) !== entry.sha256) throw new Error(`migration hash mismatch: ${normalized}`)
  return data
}
function requiredRecord(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value) || !isRecord(value[field])) throw new TypeError(`migration ${field} is invalid`); return structuredClone(value[field]) }
function requiredArray(value: unknown, field: string): unknown[] { if (!isRecord(value) || !Array.isArray(value[field])) throw new TypeError(`migration ${field} is invalid`); return structuredClone(value[field]) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function assertUniqueIdentity(value: string, seen: Set<string>, kind: 'attachment' | 'settings' | 'workspace'): void {
  if (value.trim() === '' || seen.has(value)) {
    // Bundle identities can contain user data, so a preflight failure names
    // only the record kind and never echoes the conflicting identifier.
    throw new TypeError(`migration bundle contains an invalid or duplicate ${kind} identity`)
  }
  seen.add(value)
}
function buildSafeSettingsOps(ns: string, user: Readonly<Record<string, unknown>>, rawSecrets: unknown): SettingsPathSet[] {
  const secretPaths = Array.isArray(rawSecrets)
    ? rawSecrets.flatMap((entry) => {
        if (!isRecord(entry) || entry.set !== true || !Array.isArray(entry.path)
          || entry.path.some(part => typeof part !== 'string')) return []
        return [entry.path as string[]]
      })
    : []
  const hasProtectedDescendant = (path: readonly string[]): boolean => secretPaths.some(secret => (
    secret.length > path.length && path.every((part, index) => secret[index] === part)
  ))
  const ops: SettingsPathSet[] = []
  const visit = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) {
      if (hasProtectedDescendant(path)) {
        throw new Error(`migration cannot safely import redacted settings array "${path.join('.')}" in namespace "${ns}"`)
      }
      ops.push({ op: 'set', path, value })
      return
    }
    if (!isRecord(value)) {
      ops.push({ op: 'set', path, value })
      return
    }
    const entries = Object.entries(value)
    if (entries.length === 0) {
      // An empty redacted container may still hold a target-only secret. In
      // that case omission means preservation, not replacement with `{}`.
      if (!hasProtectedDescendant(path)) ops.push({ op: 'set', path, value: {} })
      return
    }
    for (const [name, nested] of entries) visit(nested, [...path, name])
  }
  for (const [name, value] of Object.entries(user)) visit(value, [name])
  return ops
}
function assertSettingsReady(row: Readonly<Record<string, unknown>>, side: 'source' | 'target'): void {
  if (row.status === 'ready') return
  const namespace = typeof row.ns === 'string' && row.ns.trim() !== '' ? ` namespace "${row.ns}"` : ''
  const status = row.status === 'degraded' ? 'degraded' : 'not reporting a ready status'
  throw new Error(`migration ${side} settings${namespace} is ${status}`)
}
