import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runBounded, type GitResult } from './git.js'

const LIFECYCLE = /^(?:pre|post)?(?:install|uninstall|publish|pack|prepare|version)$/u
export interface AllowedScript { readonly name: string; readonly command: string }
export interface ScriptRunReceipt extends GitResult { readonly script: string }

export function allowedPackageScripts(manifest: unknown, allowlist: readonly string[]): readonly AllowedScript[] {
  const value = record(manifest); const scripts = record(value?.scripts); if (scripts === undefined) return []
  const allowed = new Set(allowlist.filter(name => /^[a-z0-9:_-]{1,80}$/iu.test(name) && !LIFECYCLE.test(name)))
  return Object.freeze(Object.entries(scripts).flatMap(([name, command]) => allowed.has(name) && typeof command === 'string' ? [{ name, command }] : []).sort((a, b) => a.name.localeCompare(b.name)))
}

/** Runs only an existing package.json script name through npm CLI argv; never accepts a shell command from the browser. */
export class PackageScriptRunner {
  readonly #controllers = new Map<string, AbortController>()
  constructor(private readonly options: { readonly allowlist: readonly string[]; readonly nodePath?: string; readonly npmCliPath?: string; readonly timeoutMs?: number } ) {}
  async available(root: string): Promise<readonly AllowedScript[]> { return allowedPackageScripts(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')), this.options.allowlist) }
  async run(root: string, script: string, runId: string): Promise<ScriptRunReceipt> {
    if (this.#controllers.has(runId)) throw new Error('script run id is already active')
    const allowed = await this.available(root); if (!allowed.some(row => row.name === script)) throw new TypeError('script is not in the configured allowlist')
    const npmCli = this.options.npmCliPath ?? findNpmCli(process.execPath); if (npmCli === undefined) throw new Error('npm CLI is unavailable; script execution remains disabled')
    const controller = new AbortController(); this.#controllers.set(runId, controller)
    try { return { script, ...await runBounded(this.options.nodePath ?? process.execPath, [npmCli, 'run', script, '--silent'], root, this.options.timeoutMs ?? 10 * 60_000, 512 * 1024, controller.signal) } }
    finally { this.#controllers.delete(runId) }
  }
  cancel(runId: string): boolean { const controller = this.#controllers.get(runId); if (controller === undefined) return false; controller.abort(); return true }
}
function findNpmCli(execPath: string): string | undefined { const prefix = dirname(dirname(execPath)); return [join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(prefix, 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(existsSync) }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
