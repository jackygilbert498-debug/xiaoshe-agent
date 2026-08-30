import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { runBoundedProcess, type ProcessResult } from './process-runner.js'

export interface ProfileInspection {
  readonly profile: string
  readonly exists: boolean
  readonly dependencies: Readonly<Record<string, string>>
  readonly bundles: readonly string[]
  readonly manifestSha256: string
}

export interface ProfileReceipt {
  readonly operation: 'bootstrap' | 'add' | 'update' | 'remove'
  readonly profile: string
  readonly argv: readonly string[]
  readonly result: ProcessResult
  readonly steps?: readonly { readonly argv: readonly string[]; readonly result: ProcessResult }[]
}

export interface DshProfileManagerLike {
  inspect(profile: string): Promise<ProfileInspection>
  bootstrap(profile: string, sourceProfile: string, signal: AbortSignal): Promise<ProfileReceipt>
  add(profile: string, tarballPath: string, signal: AbortSignal): Promise<ProfileReceipt>
  update(profile: string, tarballPath: string, signal: AbortSignal): Promise<ProfileReceipt>
  remove(profile: string, packageName: string, signal: AbortSignal): Promise<ProfileReceipt>
  restore?(profile: string, packageName: string, spec: string, signal: AbortSignal): Promise<ProfileReceipt>
  dump(profile: string, signal: AbortSignal): Promise<string>
}

export interface DshProfileManagerOptions {
  readonly dshHome: string
  readonly cliPath: string
  readonly cwd: string
  readonly nodeArgs?: readonly string[]
  readonly timeoutMs?: number
  readonly run?: typeof runBoundedProcess
  readonly environment?: NodeJS.ProcessEnv
}

/** Owns all managed Profile mutations through the official DSH CLI. */
export class DshProfileManager implements DshProfileManagerLike {
  readonly dshHome: string
  readonly cliPath: string
  readonly cwd: string
  readonly nodeArgs: readonly string[]
  readonly timeoutMs: number
  readonly #run: typeof runBoundedProcess
  readonly #environment: NodeJS.ProcessEnv

  constructor(options: DshProfileManagerOptions) {
    for (const [label, value] of [['DSH_HOME', options.dshHome], ['CLI path', options.cliPath], ['cwd', options.cwd]] as const) {
      if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`)
    }
    // macOS exposes the temporary directory through both /var and /private/var.
    // Canonicalize existing boundaries once so exact tarball/profile paths cannot
    // be mistaken for an escape merely because the OS returned the other alias.
    this.dshHome = canonicalPath(options.dshHome)
    this.cliPath = canonicalPath(options.cliPath)
    this.cwd = canonicalPath(options.cwd)
    this.nodeArgs = Object.freeze([...(options.nodeArgs ?? ['--import', 'tsx/esm'])])
    this.timeoutMs = options.timeoutMs ?? 180_000
    this.#run = options.run ?? runBoundedProcess
    this.#environment = Object.freeze({ ...sanitizedEnvironment(options.environment), DSH_HOME: this.dshHome, CI: '1' })
  }

  async inspect(profile: string): Promise<ProfileInspection> {
    validateProfileName(profile, false)
    const path = join(this.dshHome, 'profiles', profile, 'package.json')
    if (!existsSync(path)) return { profile, exists: false, dependencies: {}, bundles: [], manifestSha256: digest('missing') }
    const exact = await realpath(path)
    assertWithin(exact, join(this.dshHome, 'profiles', profile))
    const bytes = await readFile(exact)
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new TypeError(`profile ${profile} manifest is invalid JSON`) }
    if (!isRecord(value)) throw new TypeError(`profile ${profile} manifest must be an object`)
    const dependencies = stringMap(value.dependencies)
    const dsh = isRecord(value.dsh) ? value.dsh : {}
    const profileManifest = isRecord(dsh.profile) ? dsh.profile : {}
    const bundles = Array.isArray(profileManifest.bundles) ? profileManifest.bundles.filter((row): row is string => typeof row === 'string') : []
    return Object.freeze({ profile, exists: true, dependencies: Object.freeze(dependencies), bundles: Object.freeze(bundles), manifestSha256: digest(bytes) })
  }

  async bootstrap(profile: string, sourceProfile: string, signal: AbortSignal): Promise<ProfileReceipt> {
    validateProfileName(profile, true)
    validateProfileName(sourceProfile, false)
    const current = await this.inspect(profile)
    if (current.exists && Object.keys(current.dependencies).length > 0) throw new Error(`managed profile ${profile} is already initialized`)
    const source = await this.inspect(sourceProfile)
    if (!source.exists) throw new Error(`source profile ${sourceProfile} does not exist`)
    const specs = Object.entries(source.dependencies)
    if (specs.length === 0) throw new Error(`source profile ${sourceProfile} has no locked dependencies to bootstrap`)
    const targets = specs.map(([packageName, spec]) => exactDependencyTarget(packageName, spec))
    const argv = ['plugin', '--profile', profile, 'add', '--offline', ...targets]
    const result = await this.#invoke(argv, signal)
    assertProcessSuccess(result, `bootstrap ${specs.length} locked dependencies`)
    return { operation: 'bootstrap', profile, argv, result, steps: Object.freeze([{ argv, result }]) }
  }

  async add(profile: string, tarballPath: string, signal: AbortSignal): Promise<ProfileReceipt> {
    return this.#mutate('add', profile, await exactAbsoluteFile(tarballPath), signal)
  }
  async update(profile: string, tarballPath: string, signal: AbortSignal): Promise<ProfileReceipt> {
    return this.#mutate('update', profile, await exactAbsoluteFile(tarballPath), signal)
  }
  async remove(profile: string, packageName: string, signal: AbortSignal): Promise<ProfileReceipt> {
    validatePackageName(packageName)
    return this.#mutate('remove', profile, packageName, signal)
  }
  async restore(profile: string, packageName: string, spec: string, signal: AbortSignal): Promise<ProfileReceipt> {
    validateProfileName(profile, true)
    const target = exactDependencyTarget(packageName, spec)
    const argv = ['plugin', '--profile', profile, 'add', '--offline', target]
    const result = await this.#invoke(argv, signal)
    assertProcessSuccess(result, 'dsh plugin restore')
    return Object.freeze({ operation: 'add', profile, argv: Object.freeze(argv), result })
  }
  async dump(profile: string, signal: AbortSignal): Promise<string> {
    validateProfileName(profile, true)
    const result = await this.#invoke(['--profile', profile, '--dump-config'], signal)
    assertProcessSuccess(result, 'profile dump')
    return result.stdout
  }

  async #mutate(operation: 'add' | 'update' | 'remove', profile: string, target: string, signal: AbortSignal): Promise<ProfileReceipt> {
    validateProfileName(profile, true)
    const argv = ['plugin', '--profile', profile, operation, ...(operation === 'remove' ? [] : ['--offline']), target]
    const result = await this.#invoke(argv, signal)
    assertProcessSuccess(result, `dsh plugin ${operation}`)
    return Object.freeze({ operation, profile, argv: Object.freeze(argv), result })
  }

  async #invoke(argv: readonly string[], signal: AbortSignal): Promise<ProcessResult> {
    return this.#run({
      command: process.execPath,
      args: [...this.nodeArgs, this.cliPath, ...argv],
      cwd: this.cwd,
      environment: this.#environment,
      timeoutMs: this.timeoutMs,
      signal,
    })
  }
}

export function validateProfileName(profile: string, managedOnly: boolean): void {
  const pattern = managedOnly ? /^xiaoshe-managed-[a-z0-9]+(?:-[a-z0-9]+)*$/u : /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
  if (!pattern.test(profile)) throw new TypeError(managedOnly ? 'profile must be a xiaoshe managed profile' : 'profile name is invalid')
}

function exactDependencyTarget(packageName: string, spec: string): string {
  validatePackageName(packageName)
  if (spec.length === 0 || spec.length > 2_000 || /[\r\n\0]/u.test(spec)) throw new TypeError(`dependency spec for ${packageName} is invalid`)
  if (/^(?:file|link):/u.test(spec) || /^[A-Za-z]:[/\\]|^\//u.test(spec)) return spec
  return `${packageName}@${spec}`
}
function validatePackageName(value: string): void {
  if (value.length === 0 || value.length > 214 || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(value)) throw new TypeError('package name is invalid')
}
async function exactAbsoluteFile(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new TypeError('candidate tarball path must be absolute')
  const exact = await realpath(resolve(path))
  if (!(await lstat(exact)).isFile()) throw new TypeError('candidate tarball must be a regular file')
  return exact
}
function assertProcessSuccess(result: ProcessResult, label: string): void {
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    const diagnostics = [result.stderr, result.stdout].filter(value => value.trim() !== '').join('\n').slice(-4_000)
    throw new Error(`${label} failed (exit ${result.exitCode}, timeout=${result.timedOut}, aborted=${result.aborted}): ${diagnostics}`)
  }
}
function assertWithin(path: string, root: string): void {
  const delta = relative(canonicalPath(root), canonicalPath(path))
  if (delta === '..' || delta.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(delta)) throw new Error('resolved profile path escaped DSH_HOME')
}
function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync.native(absolute) } catch { return absolute }
}
function sanitizedEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ['APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']
  return Object.fromEntries(allowed.flatMap(key => input[key] === undefined ? [] : [[key, input[key]]]))
}
function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const rows = Object.entries(value)
  if (rows.some(([, spec]) => typeof spec !== 'string')) throw new TypeError('profile dependencies must use string specs')
  return Object.fromEntries(rows) as Record<string, string>
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function digest(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }
