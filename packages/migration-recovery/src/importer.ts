import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { MigrationJournal } from './journal.js'
import { mapWorkspacePath, type WorkspacePathMapping } from './path-map.js'
import { canonicalJson, sha256Bytes, verifyMigrationDirectory } from './schema.js'

interface SessionPort { list(signal?: AbortSignal): Promise<readonly Record<string, unknown>[]>; inspect(id: string, signal?: AbortSignal): Promise<{ readonly meta: Record<string, unknown>; readonly events: readonly unknown[] }>; create(meta: Record<string, unknown>): Promise<void>; append(id: string, events: readonly unknown[]): Promise<void> }
interface WorkspacePort { list(): readonly Readonly<Record<string, unknown>>[]; create(path: string, title?: string): Promise<Readonly<Record<string, unknown>> & { attachSession?(id: string): Promise<void> }>; archiveSession?(id: string): Promise<void> }
interface AttachmentPort { saveImage(input: { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }): Promise<Readonly<Record<string, unknown>>> }
interface SettingsPort { describe(options?: { readonly redactSecrets: boolean }): readonly Readonly<Record<string, unknown>>[]; replace(ns: string, section: object, expectedRevision?: number): Promise<void> }

export interface MigrationConflict { readonly kind: 'path-unmapped' | 'session-different' | 'settings-different'; readonly id: string; readonly detail: string }
export interface MigrationPreview {
  readonly bundlePath: string; readonly bundleHash: string; readonly mappings: readonly WorkspacePathMapping[]
  readonly sessions: readonly { readonly id: string; readonly action: 'create' | 'skip-identical'; readonly mappedCwd?: string }[]
  readonly conflicts: readonly MigrationConflict[]
}

/** Inspect first, then apply only a still-identical bundle with no conflicts. */
export class MigrationImporter {
  readonly #journal: MigrationJournal
  constructor(private readonly ports: { readonly sessions: SessionPort; readonly workspaces?: WorkspacePort; readonly attachments?: AttachmentPort; readonly settings?: SettingsPort; readonly journalPath: string }) { this.#journal = new MigrationJournal(ports.journalPath) }

  async preview(bundlePath: string, mappings: readonly WorkspacePathMapping[], signal?: AbortSignal): Promise<MigrationPreview> {
    const manifest = await verifyMigrationDirectory(bundlePath)
    const bundleHash = sha256Bytes(Buffer.from(canonicalJson(manifest)))
    const existing = new Map((await this.ports.sessions.list(signal)).map(row => [String(row.id), row]))
    const conflicts: MigrationConflict[] = []
    const sessions = []
    for (const file of manifest.files.filter(row => row.path.startsWith('sessions/') && row.path.endsWith('.json'))) {
      const document = await readJson(resolve(bundlePath, ...file.path.split('/')))
      const meta = requiredRecord(document, 'meta')
      const events = requiredArray(document, 'events')
      const id = String(meta.id ?? '')
      const sourceCwd = typeof meta.cwd === 'string' ? meta.cwd : undefined
      const mappedCwd = sourceCwd === undefined ? undefined : mapWorkspacePath(sourceCwd, mappings)
      if (sourceCwd !== undefined && mappedCwd === undefined) conflicts.push({ kind: 'path-unmapped', id, detail: sourceCwd })
      const mapped = { ...meta, ...(mappedCwd === undefined ? {} : { cwd: mappedCwd }) }
      const current = existing.get(id)
      let action: 'create' | 'skip-identical' = 'create'
      if (current !== undefined) {
        const inspection = await this.ports.sessions.inspect(id, signal)
        if (canonicalJson({ meta: inspection.meta, events: inspection.events }) === canonicalJson({ meta: mapped, events })) action = 'skip-identical'
        else conflicts.push({ kind: 'session-different', id, detail: '目标设备已有同 ID 的不同会话' })
      }
      sessions.push(Object.freeze({ id, action, ...(mappedCwd === undefined ? {} : { mappedCwd }) }))
    }
    if (this.ports.settings !== undefined) {
      const imported = await readOptionalJson(bundlePath, manifest.files, 'settings.json')
      const current = new Map(this.ports.settings.describe({ redactSecrets: true }).map(row => [String(row.ns), row]))
      if (Array.isArray(imported)) for (const row of imported) {
        if (!isRecord(row) || typeof row.ns !== 'string' || !isRecord(row.user)) continue
        const before = current.get(row.ns)?.user
        if (isRecord(before) && Object.keys(before).length > 0 && canonicalJson(before) !== canonicalJson(row.user)) conflicts.push({ kind: 'settings-different', id: row.ns, detail: '目标设置已有不同用户层' })
      }
    }
    return Object.freeze({ bundlePath, bundleHash, mappings: Object.freeze(mappings.map(row => Object.freeze({ ...row }))), sessions: Object.freeze(sessions), conflicts: Object.freeze(conflicts) })
  }

  async apply(preview: MigrationPreview, signal?: AbortSignal): Promise<void> {
    if (preview.conflicts.length > 0) throw new Error('migration preview contains conflicts')
    const manifest = await verifyMigrationDirectory(preview.bundlePath)
    const bundleHash = sha256Bytes(Buffer.from(canonicalJson(manifest)))
    if (bundleHash !== preview.bundleHash) throw new Error('migration bundle changed after preview')
    const completed = this.#journal.open(bundleHash)
    const attachments = await readOptionalJson(preview.bundlePath, manifest.files, 'attachments/index.json')
    if (this.ports.attachments !== undefined && Array.isArray(attachments)) for (const item of attachments) {
      signal?.throwIfAborted()
      if (!isRecord(item) || !isRecord(item.ref) || typeof item.file !== 'string') throw new TypeError('attachment index is invalid')
      const key = `attachment:${String(item.ref.attachmentId)}`
      if (completed.has(key)) continue
      const data = await readFile(resolve(preview.bundlePath, ...item.file.split('/')))
      const saved = await this.ports.attachments.saveImage({ data, mediaType: String(item.ref.mediaType), ...(typeof item.ref.name === 'string' ? { name: item.ref.name } : {}) })
      if (String(saved.attachmentId) !== String(item.ref.attachmentId)) throw new Error('restored attachment identity does not match the session log')
      await this.#journal.mark(bundleHash, key)
    }
    for (const row of preview.sessions) {
      signal?.throwIfAborted()
      const key = `session:${row.id}`
      if (completed.has(key) || row.action === 'skip-identical') { await this.#journal.mark(bundleHash, key); continue }
      const document = await sessionDocument(preview.bundlePath, manifest.files, row.id)
      const meta = { ...requiredRecord(document, 'meta'), ...(row.mappedCwd === undefined ? {} : { cwd: row.mappedCwd }) }
      const events = requiredArray(document, 'events')
      await this.ports.sessions.create(meta)
      if (events.length > 0) await this.ports.sessions.append(row.id, events)
      await this.#journal.mark(bundleHash, key)
    }
    if (this.ports.settings !== undefined) {
      const settings = await readOptionalJson(preview.bundlePath, manifest.files, 'settings.json')
      const current = new Map(this.ports.settings.describe({ redactSecrets: true }).map(row => [String(row.ns), row]))
      if (Array.isArray(settings)) for (const row of settings) {
        if (!isRecord(row) || typeof row.ns !== 'string' || !isRecord(row.user)) continue
        const key = `settings:${row.ns}`
        if (completed.has(key)) continue
        const descriptor = current.get(row.ns)
        await this.ports.settings.replace(row.ns, row.user, typeof descriptor?.revision === 'number' ? descriptor.revision : undefined)
        await this.#journal.mark(bundleHash, key)
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
        const existing = this.ports.workspaces.list().find(row => row.path === mapped)
        const workspace = existing ?? await this.ports.workspaces.create(mapped, typeof source.title === 'string' ? source.title : undefined)
        if (typeof workspace.attachSession === 'function' && Array.isArray(source.sessionIds)) for (const id of source.sessionIds) await workspace.attachSession(String(id))
        await this.#journal.mark(bundleHash, key)
      }
      if (isRecord(workspacesDoc) && Array.isArray(workspacesDoc.archivedSessionIds) && this.ports.workspaces.archiveSession !== undefined) for (const id of workspacesDoc.archivedSessionIds) await this.ports.workspaces.archiveSession(String(id))
    }
  }
}

async function sessionDocument(root: string, files: readonly { readonly path: string }[], id: string): Promise<Record<string, unknown>> {
  for (const file of files.filter(row => row.path.startsWith('sessions/'))) { const value = await readJson(resolve(root, ...file.path.split('/'))); if (isRecord(value) && isRecord(value.meta) && String(value.meta.id) === id) return value }
  throw new Error(`session document not found: ${id}`)
}
async function readOptionalJson(root: string, files: readonly { readonly path: string }[], path: string): Promise<unknown> { return files.some(row => row.path === path) ? await readJson(resolve(root, ...path.split('/'))) : undefined }
async function readJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) }
function requiredRecord(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value) || !isRecord(value[field])) throw new TypeError(`migration ${field} is invalid`); return structuredClone(value[field]) }
function requiredArray(value: unknown, field: string): unknown[] { if (!isRecord(value) || !Array.isArray(value[field])) throw new TypeError(`migration ${field} is invalid`); return structuredClone(value[field]) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
