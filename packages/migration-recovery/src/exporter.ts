import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { canonicalJson, sha256Bytes, type MigrationFileEntry, type MigrationManifest } from './schema.js'

interface SessionPort { list(signal?: AbortSignal): Promise<readonly Record<string, unknown>[]>; inspect(id: string, signal?: AbortSignal): Promise<{ readonly meta: Record<string, unknown>; readonly events: readonly unknown[] }> }
interface AttachmentPort { readImage(ref: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<{ readonly ref: Readonly<Record<string, unknown>>; readonly data: Uint8Array }> }
interface SettingsPort { describe(options?: { readonly redactSecrets: boolean }): readonly Readonly<Record<string, unknown>>[] }
interface WorkspacePort { list(): readonly Readonly<Record<string, unknown>>[]; readonly archivedSessionIds?: readonly unknown[] }
interface PluginPort { snapshot(): unknown }

/** Create one immutable, inspectable migration directory and publish it atomically. */
export class MigrationExporter {
  constructor(private readonly ports: { readonly sessions: SessionPort; readonly attachments?: AttachmentPort; readonly settings: SettingsPort; readonly workspaces: WorkspacePort; readonly plugins?: PluginPort }) {}

  async exportTo(target: string, signal?: AbortSignal): Promise<MigrationManifest> {
    if (!isAbsolute(target)) throw new TypeError('migration export target must be absolute')
    const parent = dirname(target)
    const temp = resolve(parent, `.${basename(target)}.partial-${randomUUID()}`)
    await mkdir(parent, { recursive: true })
    await mkdir(temp, { recursive: false })
    const files: MigrationFileEntry[] = []
    const write = async (path: string, bytes: Uint8Array): Promise<void> => {
      signal?.throwIfAborted()
      const destination = resolve(temp, ...path.split('/'))
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes, { flag: 'wx' })
      files.push(Object.freeze({ path, bytes: bytes.byteLength, sha256: sha256Bytes(bytes) }))
    }
    try {
      const headers = await this.ports.sessions.list(signal)
      if (headers.length > 10_000) throw new RangeError('too many sessions to export')
      const attachmentRefs = new Map<string, Readonly<Record<string, unknown>>>()
      for (const header of headers) {
        signal?.throwIfAborted()
        const id = sessionId(header)
        const inspection = await this.ports.sessions.inspect(id, signal)
        collectAttachmentRefs(inspection.events, attachmentRefs)
        await write(`sessions/${safeFileId(id)}.json`, jsonBytes({ meta: inspection.meta, events: inspection.events }))
      }
      const attachmentIndex: unknown[] = []
      if (this.ports.attachments !== undefined) {
        for (const [id, ref] of attachmentRefs) {
          const stored = await this.ports.attachments.readImage(ref, signal)
          const file = `attachments/${sha256Bytes(Buffer.from(id))}.bin`
          await write(file, stored.data)
          attachmentIndex.push({ ref: stored.ref, file })
        }
      }
      if (attachmentIndex.length > 0) await write('attachments/index.json', jsonBytes(attachmentIndex))
      const settings = this.ports.settings.describe({ redactSecrets: true }).map(row => ({ ns: row.ns, user: redactSensitive(row.user, row.secrets) }))
      await write('settings.json', jsonBytes(settings))
      await write('workspaces.json', jsonBytes({ workspaces: this.ports.workspaces.list().map(workspaceReference), archivedSessionIds: this.ports.workspaces.archivedSessionIds ?? [] }))
      await write('plugins.json', jsonBytes(redactSensitive(this.ports.plugins?.snapshot() ?? { installed: [] })))
      const manifest: MigrationManifest = Object.freeze({ schemaVersion: 1, product: 'xiaoshe', exportedAt: Date.now(), source: Object.freeze({ platform: process.platform }), files: Object.freeze(files.sort((a, b) => a.path.localeCompare(b.path))) })
      await writeFile(resolve(temp, 'manifest.json'), `${canonicalJson(manifest)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temp, target)
      return manifest
    } catch (error) {
      await rm(temp, { recursive: true, force: true })
      throw error
    }
  }
}

function jsonBytes(value: unknown): Uint8Array { return Buffer.from(`${canonicalJson(value)}\n`, 'utf8') }
function sessionId(value: Record<string, unknown>): string { const id = String(value.id ?? '').trim(); if (id === '' || id.length > 512) throw new TypeError('session id is invalid'); return id }
function safeFileId(id: string): string { return sha256Bytes(Buffer.from(id)).slice(0, 40) }
function workspaceReference(value: Readonly<Record<string, unknown>>): unknown { return { id: value.id, path: value.path, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt, sessionIds: value.sessionIds } }
function collectAttachmentRefs(value: unknown, target: Map<string, Readonly<Record<string, unknown>>>): void {
  if (Array.isArray(value)) { for (const item of value) collectAttachmentRefs(item, target); return }
  if (!isRecord(value)) return
  if (typeof value.attachmentId === 'string' && typeof value.mediaType === 'string' && Number.isSafeInteger(value.bytes)) target.set(value.attachmentId, value)
  for (const nested of Object.values(value)) collectAttachmentRefs(nested, target)
}
function redactSensitive(value: unknown, secretPaths: unknown = []): unknown {
  const paths = new Set(Array.isArray(secretPaths) ? secretPaths.flatMap(path => Array.isArray(path) ? [path.join('.')] : []) : [])
  const visit = (input: unknown, path: string[]): unknown => {
    if (Array.isArray(input)) return input.map((item, index) => visit(item, [...path, String(index)]))
    if (!isRecord(input)) return input
    return Object.fromEntries(Object.entries(input).flatMap(([key, nested]) => {
      const next = [...path, key]
      if (paths.has(next.join('.')) || /(?:api.?key|secret|token|password|credential)/iu.test(key)) return []
      return [[key, visit(nested, next)]]
    }))
  }
  return visit(value, [])
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
