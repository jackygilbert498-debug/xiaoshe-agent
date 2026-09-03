import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { WorkspaceGit } from './git.js'
import { registerCodingWorkbenchHttpRoutes, type WorkbenchWebServer } from './http.js'
import { ControlledFileWriter } from './patch.js'
import { WorkspacePathPolicy } from './path-policy.js'
import { PackageScriptRunner } from './scripts.js'
import { CodingWorkbenchService } from './service.js'
import { WorkbenchTransactionStore } from './transactions.js'

interface WorkspaceRow { readonly id: string; readonly title?: string; readonly path?: string }
interface Context { readonly webServer: WorkbenchWebServer; readonly workspaceRegistry: { list(): readonly WorkspaceRow[] }; provide(name: string, value: unknown): unknown; effect(setup: () => () => void, label?: string): unknown }
export interface CodingWorkbenchConfig { readonly dshHome?: string; readonly profile?: string; readonly allowedScripts?: readonly string[]; readonly npmCliPath?: string }
export const name = 'xiaoshe-coding-workbench'; export const inject = ['webServer', 'workspaceRegistry']

/** Compose the workbench entirely from workspace ids and existing public Host services. */
export function apply(ctx: Context, config: CodingWorkbenchConfig = {}): void {
  const workspaces = { list: () => ctx.workspaceRegistry.list().flatMap(row => typeof row.path === 'string' ? [{ id: row.id, title: row.title ?? row.id, path: row.path }] : []) }
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? resolve(homedir(), '.dsh')); const profile = config.profile ?? currentProfile(process.argv) ?? 'default'
  const service = new CodingWorkbenchService({
    paths: new WorkspacePathPolicy(workspaces), workspaces, git: new WorkspaceGit(),
    writer: new ControlledFileWriter({ store: new WorkbenchTransactionStore(resolve(dshHome, 'profiles', profile, '.xiaoshe', 'workbench-transactions.json')) }),
    scripts: new PackageScriptRunner({ allowlist: config.allowedScripts ?? ['build', 'test', 'typecheck', 'lint', 'check'], ...(config.npmCliPath === undefined ? {} : { npmCliPath: resolve(config.npmCliPath) }) }),
  })
  ctx.provide('xiaosheCodingWorkbench', service)
  ctx.effect(() => registerCodingWorkbenchHttpRoutes(ctx.webServer, service), 'xiaoshe-coding-workbench: workspace-bound workbench routes')
}
function currentProfile(argv: readonly string[]): string | undefined { const index = argv.indexOf('--profile'); return index < 0 ? undefined : argv[index + 1] }
export * from './git.js'; export * from './http.js'; export * from './patch.js'; export * from './path-policy.js'; export * from './read-model.js'; export * from './scripts.js'; export * from './service.js'; export * from './transactions.js'
