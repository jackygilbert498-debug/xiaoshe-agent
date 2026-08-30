import { randomUUID } from 'node:crypto'
import type { WorkspacePathPolicy } from './path-policy.js'
import { readTextFile, scanWorkspaceTree } from './read-model.js'
import type { WorkspaceGit } from './git.js'
import type { ControlledFileWriter } from './patch.js'
import type { PackageScriptRunner } from './scripts.js'

export interface WorkbenchWorkspace { readonly id: string; readonly title: string; readonly path: string }
export interface WorkbenchSnapshot { readonly workspaces: readonly WorkbenchWorkspace[]; readonly running: readonly { readonly id: string; readonly workspaceId: string; readonly script: string }[]; readonly transactions: readonly unknown[] }

/** Public Host facade. Every operation resolves workspace id through PathPolicy. */
export class CodingWorkbenchService {
  readonly #runs = new Map<string, { readonly workspaceId: string; readonly script: string }>()
  constructor(private readonly ports: {
    readonly paths: WorkspacePathPolicy
    readonly workspaces: { list(): readonly WorkbenchWorkspace[] }
    readonly git: WorkspaceGit
    readonly writer: ControlledFileWriter
    readonly scripts: PackageScriptRunner
  }) {}
  snapshot(): WorkbenchSnapshot { return Object.freeze({ workspaces: Object.freeze(this.ports.workspaces.list().map(row => ({ id: row.id, title: row.title, path: row.path }))), running: Object.freeze([...this.#runs].map(([id, row]) => ({ id, ...row }))), transactions: this.ports.writer.list() }) }
  async tree(workspaceId: string): Promise<unknown> { const root = await this.ports.paths.root(workspaceId); return scanWorkspaceTree(root.absolutePath) }
  async read(workspaceId: string, path: string): Promise<unknown> { const file = await this.ports.paths.existing(workspaceId, path, 'file'); return { path: file.relativePath, ...await readTextFile(file.absolutePath) } }
  async gitStatus(workspaceId: string, signal?: AbortSignal): Promise<unknown> { const root = await this.ports.paths.root(workspaceId); return this.ports.git.status(root.absolutePath, signal) }
  async gitDiff(workspaceId: string, path?: string, staged = false, signal?: AbortSignal): Promise<unknown> { const root = await this.ports.paths.root(workspaceId); if (path !== undefined) await this.ports.paths.existing(workspaceId, path); return this.ports.git.diff(root.absolutePath, { ...(path === undefined ? {} : { path }), staged }, signal) }
  async prepareWrite(input: { readonly workspaceId: string; readonly path: string; readonly newText: string }): Promise<unknown> { const file = await this.ports.paths.existing(input.workspaceId, input.path, 'file'); return this.ports.writer.prepare({ workspaceId: input.workspaceId, relativePath: file.relativePath, absolutePath: file.absolutePath, newText: input.newText }) }
  async confirmWrite(id: string, token: string): Promise<unknown> { return this.ports.writer.confirm(id, token) }
  async revert(id: string): Promise<unknown> { return this.ports.writer.revert(id) }
  async scripts(workspaceId: string): Promise<unknown> { const root = await this.ports.paths.root(workspaceId); return this.ports.scripts.available(root.absolutePath) }
  async runScript(workspaceId: string, script: string): Promise<unknown> {
    const root = await this.ports.paths.root(workspaceId); const id = `workbench-run-${randomUUID()}`; this.#runs.set(id, { workspaceId, script })
    try { return { id, receipt: await this.ports.scripts.run(root.absolutePath, script, id) } } finally { this.#runs.delete(id) }
  }
  cancel(id: string): boolean { return this.ports.scripts.cancel(id) }
}
