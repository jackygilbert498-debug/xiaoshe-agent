import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { MigrationExporter } from './exporter.js'
import { registerMigrationRecoveryHttpRoutes, type MigrationWebServer } from './http.js'
import { MigrationImporter } from './importer.js'
import { MigrationRecoveryService } from './service.js'

interface SessionPersistencePort {
  list(signal?: AbortSignal): Promise<readonly Record<string, unknown>[]>
  inspect(id: string, signal?: AbortSignal): Promise<{ readonly meta: Record<string, unknown>; readonly events: readonly unknown[] }>
  create(meta: Record<string, unknown>): Promise<void>
  append(id: string, events: readonly unknown[]): Promise<void>
}
interface AttachmentPort {
  readImage(ref: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<{ readonly ref: Readonly<Record<string, unknown>>; readonly data: Uint8Array }>
  saveImage(input: { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }): Promise<Readonly<Record<string, unknown>>>
}
interface SettingsPort {
  describe(options?: { readonly redactSecrets: boolean }): readonly Readonly<Record<string, unknown>>[]
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
}
interface WorkspacePort {
  list(): readonly (Readonly<Record<string, unknown>> & { readonly path?: string; attachSession?(id: string): Promise<void> })[]
  create(path: string, title?: string): Promise<Readonly<Record<string, unknown>> & { attachSession?(id: string): Promise<void> }>
  archiveSession(id: string): Promise<void>
  readonly archivedSessionIds: readonly unknown[]
}
interface PluginGovernancePort {
  listTransactions(): readonly unknown[]
  snapshot?(): Readonly<Record<string, unknown>>
}
interface MigrationHostContext {
  readonly webServer: MigrationWebServer
  readonly sessionPersistence: SessionPersistencePort
  readonly attachments: AttachmentPort
  readonly settings: SettingsPort
  readonly workspaceRegistry: WorkspacePort
  get(name: string): unknown
  provide(name: string, value: unknown): unknown
  effect(execute: () => (() => void | Promise<void>), label?: string): unknown
}

export interface MigrationRecoveryConfig { readonly dshHome?: string; readonly activeProfile?: string }
export const name = 'xiaoshe-migration-recovery'
export const inject = ['webServer', 'sessionPersistence', 'attachments', 'settings', 'workspaceRegistry']

/** Compose migration from existing public Host services; this package owns no duplicate data store. */
export function apply(ctx: MigrationHostContext, config: MigrationRecoveryConfig = {}): void {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? resolve(homedir(), '.dsh'))
  const profile = config.activeProfile ?? currentProfile(process.argv) ?? 'default'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(profile)) throw new TypeError('active profile is invalid')
  const governance = ctx.get('xiaoshePluginGovernance')
  const plugins = isPluginGovernance(governance)
    ? { snapshot: () => governance.snapshot?.() ?? { transactions: governance.listTransactions() } }
    : { snapshot: () => ({ transactions: [], status: 'plugin-governance-unavailable' }) }
  const exporter = new MigrationExporter({
    sessions: ctx.sessionPersistence,
    attachments: ctx.attachments,
    settings: ctx.settings,
    workspaces: ctx.workspaceRegistry,
    plugins,
  })
  const importer = new MigrationImporter({
    sessions: ctx.sessionPersistence,
    attachments: ctx.attachments,
    settings: ctx.settings,
    workspaces: ctx.workspaceRegistry,
    journalPath: resolve(dshHome, 'profiles', profile, '.xiaoshe', 'migration-import-journal.json'),
  })
  const service = new MigrationRecoveryService({ exporter, importer })
  ctx.provide('xiaosheMigrationRecovery', service)
  ctx.effect(() => {
    const release = registerMigrationRecoveryHttpRoutes(ctx.webServer, service)
    return () => { release(); service.dispose() }
  }, 'xiaoshe-migration-recovery: export, preview and confirmation-gated import')
}

function currentProfile(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--profile')
  return index < 0 ? undefined : argv[index + 1]
}
function isPluginGovernance(value: unknown): value is PluginGovernancePort {
  return typeof value === 'object' && value !== null && typeof (value as { listTransactions?: unknown }).listTransactions === 'function'
}

export * from './exporter.js'
export * from './http.js'
export * from './importer.js'
export * from './journal.js'
export * from './path-map.js'
export * from './schema.js'
export * from './service.js'
