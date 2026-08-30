import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { inspectCandidateTarball } from './tar-manifest.js'
import { runBoundedProcess, type ProcessResult } from './process-runner.js'

export type CandidateSource =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'tarball'; readonly path: string }
  | { readonly kind: 'registry'; readonly spec: string }

export interface CandidateIdentity {
  readonly displayName: string
  readonly description?: string
  readonly developer?: string
  readonly homepage?: string
  readonly license?: string
  readonly keywords: readonly string[]
}

export interface CandidateProvenance {
  readonly kind: 'local-directory' | 'local-tarball' | 'registry'
  readonly selection: 'local-bytes' | 'exact-version' | 'floating-reference' | 'external-reference'
  readonly label: string
  /** No signed catalog or publisher proof is available yet. */
  readonly assurance: 'unverified'
}

export interface CandidateAudit {
  readonly valid: boolean
  readonly packageName?: string
  readonly version?: string
  readonly source?: string
  readonly scope: 'profile-bundle' | 'session-dynamic' | 'unknown'
  readonly installScripts: readonly string[]
  readonly scriptCommands: readonly string[]
  readonly dependencies: readonly string[]
  readonly runtimeSignals: readonly string[]
  readonly requestedServices: readonly string[]
  readonly risk: 'low' | 'medium' | 'high'
  readonly osSandboxEnforced: false
  readonly findings: readonly string[]
}

export interface ResolvedCandidate {
  readonly id: string
  readonly packageName: string
  readonly version: string
  readonly tarballPath: string
  readonly sha256: string
  readonly manifestSha256: string
  readonly identity: CandidateIdentity
  readonly provenance: CandidateProvenance
  readonly audit: CandidateAudit
  readonly healthPath?: string
}

export interface CandidateResolverOptions {
  readonly cacheDirectory: string
  readonly npmEntry?: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly run?: typeof runBoundedProcess
}

/** Resolve a local/registry candidate to one immutable, audited npm tarball. */
export class CandidateResolver {
  readonly #cacheDirectory: string
  readonly #npmEntry: string | undefined
  readonly #cwd: string
  readonly #timeoutMs: number
  readonly #run: typeof runBoundedProcess

  constructor(options: CandidateResolverOptions) {
    if (!isAbsolute(options.cacheDirectory)) throw new TypeError('candidate cache directory must be absolute')
    this.#cacheDirectory = resolve(options.cacheDirectory)
    this.#npmEntry = options.npmEntry
    this.#cwd = resolve(options.cwd ?? process.cwd())
    this.#timeoutMs = options.timeoutMs ?? 120_000
    this.#run = options.run ?? runBoundedProcess
  }

  async resolve(source: CandidateSource): Promise<ResolvedCandidate> {
    await mkdir(this.#cacheDirectory, { recursive: true })
    const provenance = describeCandidateSource(source)
    const sourcePath = source.kind === 'tarball'
      ? await exactFile(source.path, 'candidate tarball')
      : await this.#pack(source)
    const bytes = await readFile(sourcePath)
    const inspected = inspectCandidateTarball(bytes)
    const sha256 = digest(bytes)
    const stablePath = join(this.#cacheDirectory, `${safeArtifactName(inspected.packageName)}-${inspected.version}-${sha256.slice(0, 16)}.tgz`)
    if (resolve(sourcePath) !== resolve(stablePath)) {
      const { copyFile } = await import('node:fs/promises')
      await copyFile(sourcePath, stablePath)
    }
    return Object.freeze({
      id: `candidate-${sha256.slice(0, 24)}-${randomUUID().slice(0, 8)}`,
      packageName: inspected.packageName,
      version: inspected.version,
      tarballPath: stablePath,
      sha256,
      manifestSha256: inspected.manifestSha256,
      identity: inspected.identity,
      provenance,
      audit: inspected.audit,
      ...(inspected.healthPath === undefined ? {} : { healthPath: inspected.healthPath }),
    })
  }

  async #pack(source: Exclude<CandidateSource, { readonly kind: 'tarball' }>): Promise<string> {
    const npmEntry = this.#npmEntry ?? await resolveNpmEntry()
    let cwd = this.#cwd
    const targetArgs: string[] = []
    if (source.kind === 'directory') {
      const directory = await realpath(resolve(source.path))
      const stat = await lstat(directory)
      if (!stat.isDirectory()) throw new TypeError('candidate directory must resolve to a directory')
      cwd = directory
    } else {
      const spec = source.spec.trim()
      if (spec.length === 0 || spec.length > 500 || /[\r\n\0]/u.test(spec)) throw new TypeError('registry candidate spec is invalid')
      targetArgs.push(spec)
    }
    const result = await this.#run({
      command: process.execPath,
      args: [npmEntry, 'pack', '--ignore-scripts', '--json', '--pack-destination', this.#cacheDirectory, ...targetArgs],
      cwd,
      timeoutMs: this.#timeoutMs,
      environment: sanitizedEnvironment(),
    })
    assertSuccess(result, 'npm pack')
    let rows: unknown
    try { rows = JSON.parse(result.stdout) } catch { throw new Error('npm pack returned invalid JSON') }
    if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0]) || typeof rows[0].filename !== 'string') {
      throw new Error('npm pack must return exactly one artifact')
    }
    return exactFile(join(this.#cacheDirectory, basename(rows[0].filename)), 'packed candidate')
  }
}

export function auditCandidateManifest(value: unknown): CandidateAudit {
  if (!isRecord(value)) return invalidAudit('manifest is not an object')
  const scriptMap = isRecord(value.scripts) ? value.scripts : {}
  const installScripts = Object.keys(scriptMap).filter(name => /^(?:preinstall|install|postinstall|prepare)$/u.test(name)).sort()
  const scriptCommands = installScripts.flatMap(name => typeof scriptMap[name] === 'string' ? [`${name}: ${scriptMap[name]}`] : [])
  const dependencies = [...new Set([
    ...dependencyNames(value.dependencies), ...dependencyNames(value.optionalDependencies), ...dependencyNames(value.peerDependencies),
  ])].sort()
  const runtimeSignals = [
    ...dependencies.filter(name => /(?:node-gyp|prebuild|ffi|native|sharp|sqlite|playwright|puppeteer)/iu.test(name)).map(name => `可能包含原生或下载行为：${name}`),
    ...scriptCommands.filter(command => /(?:curl|wget|invoke-webrequest|https?:|node-gyp|prebuild|download|powershell|bash|sh\s)/iu.test(command)).map(command => `安装命令需要人工审阅：${command}`),
  ]
  const dsh = isRecord(value.dsh) ? value.dsh : {}
  const scope = isRecord(dsh.bundle) ? 'profile-bundle' : isRecord(dsh.dynamic) ? 'session-dynamic' : 'unknown'
  const requestedServices = [
    ...(Array.isArray(dsh.inject) ? dsh.inject : []),
    ...(isRecord(dsh.bundle) && Array.isArray(dsh.bundle.inject) ? dsh.bundle.inject : []),
  ].filter((item): item is string => typeof item === 'string').sort()
  const repository = repositorySource(value.repository)
  const findings = [
    ...(installScripts.length > 0 ? [`包含安装脚本：${installScripts.join(', ')}`] : []),
    ...runtimeSignals,
    ...(scope === 'profile-bundle' ? ['Bundle 请求进入 DSH Host 进程内运行（未启用系统沙箱）'] : []),
    ...(scope === 'session-dynamic' ? ['动态 Host VM 不是安全边界'] : []),
    ...(repository === undefined ? ['未声明可核验的 repository 来源'] : []),
  ]
  const valid = validPackageName(value.name) && validVersion(value.version)
  return Object.freeze({
    valid,
    ...(typeof value.name === 'string' ? { packageName: value.name } : {}),
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    ...(repository === undefined ? {} : { source: repository }),
    scope,
    installScripts: Object.freeze(installScripts),
    scriptCommands: Object.freeze(scriptCommands),
    dependencies: Object.freeze(dependencies),
    runtimeSignals: Object.freeze(runtimeSignals),
    requestedServices: Object.freeze(requestedServices),
    risk: installScripts.length > 0 || runtimeSignals.length > 0 || scope === 'profile-bundle' || scope === 'unknown' ? 'high' : 'medium',
    osSandboxEnforced: false,
    findings: Object.freeze(findings),
  })
}

/** Extract display-only manifest metadata without treating it as publisher proof. */
export function candidateIdentityFromManifest(value: unknown): CandidateIdentity {
  const manifest = isRecord(value) ? value : {}
  const displayName = boundedText(manifest.displayName, 120)
    ?? boundedText(manifest.name, 214)
    ?? '未命名插件'
  const description = boundedText(manifest.description, 500)
  const developer = typeof manifest.author === 'string'
    ? boundedText(manifest.author, 160)
    : isRecord(manifest.author) ? boundedText(manifest.author.name, 160) : undefined
  const homepage = publicHttpUrl(manifest.homepage)
  const license = boundedText(manifest.license, 120)
  const keywords = uniqueBoundedStrings(manifest.keywords, 20, 60)
  return Object.freeze({
    displayName,
    ...(description === undefined ? {} : { description }),
    ...(developer === undefined ? {} : { developer }),
    ...(homepage === undefined ? {} : { homepage }),
    ...(license === undefined ? {} : { license }),
    keywords: Object.freeze(keywords),
  })
}

/** Describe where bytes were selected without implying that the publisher is trusted. */
export function describeCandidateSource(source: CandidateSource): CandidateProvenance {
  if (source.kind === 'directory') {
    return Object.freeze({ kind: 'local-directory', selection: 'local-bytes', label: `本地文件夹 ${safePathLeaf(source.path)}`, assurance: 'unverified' })
  }
  if (source.kind === 'tarball') {
    return Object.freeze({ kind: 'local-tarball', selection: 'local-bytes', label: `本地安装包 ${safePathLeaf(source.path)}`, assurance: 'unverified' })
  }
  const spec = boundedText(source.spec, 500) ?? '未命名引用'
  const external = externalRegistryReference(spec)
  return Object.freeze({
    kind: 'registry',
    selection: external ? 'external-reference' : exactRegistryVersion(spec) ? 'exact-version' : 'floating-reference',
    label: `${external ? '外部引用' : '软件源'} ${external ? safeExternalLocator(spec) : spec}`,
    assurance: 'unverified',
  })
}

export function candidateDisclosures(candidate: ResolvedCandidate): readonly string[] {
  return Object.freeze([
    `将变更 ${candidate.packageName}@${candidate.version}（sha256 ${candidate.sha256}）`,
    `来源：${candidate.provenance.label}；选择方式：${sourceSelectionLabel(candidate.provenance.selection)}`,
    '来源核验：未签名；SHA-256 只绑定审计后的安装包字节，不证明发布者身份。',
    '显示名称、说明与开发者信息来自插件清单，不证明作者身份。',
    ...candidate.audit.findings,
    '插件将在 Host 进程内运行；系统沙箱未启用。',
  ])
}

function invalidAudit(message: string): CandidateAudit {
  return Object.freeze({ valid: false, scope: 'unknown', installScripts: [], scriptCommands: [], dependencies: [], runtimeSignals: [], requestedServices: [], risk: 'high', osSandboxEnforced: false, findings: [message] })
}

function validPackageName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 214 && !/[\s\0]/u.test(value)
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u.test(value)
}

function dependencyNames(value: unknown): string[] { return isRecord(value) ? Object.keys(value) : [] }
function repositorySource(value: unknown): string | undefined {
  const source = typeof value === 'string' ? value : isRecord(value) ? value.url : undefined
  const normalized = boundedText(source, 1_000)
  return normalized === undefined ? undefined : safeExternalLocator(normalized)
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function digest(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }
function safeArtifactName(value: string): string { return value.replace(/^@/u, '').replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 120) }

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (normalized === '') return undefined
  return normalized.slice(0, maxLength).trimEnd()
}

function uniqueBoundedStrings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const normalized = boundedText(item, maxLength)
    if (normalized === undefined || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= maxItems) break
  }
  return result
}

function publicHttpUrl(value: unknown): string | undefined {
  const normalized = boundedText(value, 1_000)
  if (normalized === undefined) return undefined
  try {
    const url = new URL(normalized)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    redactUrl(url)
    return url.toString()
  } catch { return undefined }
}

function safeExternalLocator(value: string): string {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|\.{1,2}[\\/])/u.test(value)) return safePathLeaf(value.split(/[?#]/u, 1)[0]!)
  try {
    const url = new URL(value)
    if (url.protocol === 'file:') return `file:${safePathLeaf(decodeURIComponent(url.pathname))}`
    redactUrl(url)
    return url.toString().slice(0, 1_000)
  } catch {
    // SCP-style Git locators are not URL instances. Remove query/fragment
    // material and any URL-like userinfo before exposing them publicly.
    return value.split(/[?#]/u, 1)[0]!
      .replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/u, '$1')
      .slice(0, 1_000)
  }
}

function redactUrl(url: URL): void {
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
}

function safePathLeaf(value: string): string {
  const leaf = boundedText(value.trim().split(/[\\/]/u).filter(Boolean).at(-1), 160)
  return leaf ?? '未命名来源'
}

function externalRegistryReference(value: string): boolean {
  return /^(?:https?:|git(?:\+[A-Za-z0-9.-]+)?:|ssh:|file:|github:|gitlab:|bitbucket:|\.{0,2}[\\/]|[A-Za-z]:[\\/])/iu.test(value)
}

function exactRegistryVersion(value: string): boolean {
  return /^(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
}

function sourceSelectionLabel(value: CandidateProvenance['selection']): string {
  return ({ 'local-bytes': '本地字节', 'exact-version': '固定版本', 'floating-reference': '浮动引用', 'external-reference': '外部引用' } as const)[value]
}

async function exactFile(input: string, label: string): Promise<string> {
  const resolved = await realpath(resolve(input))
  const stat = await lstat(resolved)
  if (!stat.isFile()) throw new TypeError(`${label} must resolve to a regular file`)
  return resolved
}

async function resolveNpmEntry(): Promise<string> {
  for (const candidate of npmEntryCandidates(process.execPath, process.env.npm_execpath)) {
    try { return await exactFile(candidate, 'npm CLI') } catch { /* Try the next explicit npm installation. */ }
  }
  throw new Error('npm-cli.js could not be resolved without a command shell')
}

/** Explicit npm CLI locations, including Homebrew's libexec-only Node layout. */
export function npmEntryCandidates(execPath: string, npmExecPath?: string): readonly string[] {
  const prefix = dirname(dirname(execPath))
  return [
    npmExecPath?.includes('npm') === true && npmExecPath.includes('pnpm') === false ? npmExecPath : undefined,
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(prefix, 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((value): value is string => value !== undefined)
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']
  return Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
}

function assertSuccess(result: ProcessResult, label: string): void {
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    throw new Error(`${label} failed with exit ${result.exitCode}: ${(result.stderr || result.stdout).slice(-1_000)}`)
  }
}
