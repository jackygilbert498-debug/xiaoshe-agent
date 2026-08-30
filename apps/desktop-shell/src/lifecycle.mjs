import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { access, cp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCT_RUNTIME_MARKER = '.xiaoshe-product-runtime.json'
const REQUIRED_PRODUCT_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'runtime/DSH/package.json',
  'setup/install-windows.ps1',
  'scripts/start-xiaoshe-web.sh',
])

export function defaultProductRoot({ packaged, resourcesPath, moduleUrl = import.meta.url }) {
  return packaged ? resolve(resourcesPath, 'product') : resolve(dirname(fileURLToPath(moduleUrl)), '../../..')
}

/** Return a deliberate product-root override, never an empty environment entry. */
export function productRootOverride(environment) {
  return environment.XIAOSHE_PRODUCT_ROOT?.trim() || undefined
}

/**
 * Keep packaged resources immutable. A signed macOS application bundle and a
 * managed Windows installation are distribution inputs, not writable runtime
 * homes. The first launch atomically materializes one versioned, per-user copy;
 * subsequent launches preserve its installed dependencies and profile links.
 */
export async function prepareProductRoot({ packaged, resourcesPath, userDataPath, version, moduleUrl = import.meta.url }) {
  if (!packaged) return defaultProductRoot({ packaged, resourcesPath, moduleUrl })
  if (!isAbsolute(userDataPath ?? '')) throw new TypeError('packaged userDataPath must be absolute')
  if (typeof version !== 'string' || !/^[0-9A-Za-z._-]{1,64}$/u.test(version)) throw new TypeError('packaged version is invalid')
  const source = defaultProductRoot({ packaged: true, resourcesPath })
  await requireProductFiles(source)

  const runtimeParent = resolve(userDataPath, 'runtime')
  await mkdir(runtimeParent, { recursive: true })
  const canonicalParent = await realpath(runtimeParent)
  const target = resolve(runtimeParent, version)
  if (await reusableProductRoot(target, canonicalParent, version)) return target

  // Preserve an incomplete or older same-version materialization for manual
  // recovery instead of deleting user data during startup.
  if (await pathExists(target)) await rename(target, `${target}.recovery-${Date.now()}-${randomUUID()}`)
  const staging = `${target}.partial-${process.pid}-${randomUUID()}`
  try {
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
    await writeFile(join(staging, PRODUCT_RUNTIME_MARKER), `${JSON.stringify({ schemaVersion: 1, version })}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  if (!(await reusableProductRoot(target, canonicalParent, version))) throw new Error('packaged product materialization failed validation')
  return target
}

async function reusableProductRoot(target, canonicalParent, version) {
  if (!(await pathExists(target))) return false
  try {
    const canonicalTarget = await realpath(target)
    if (!isInside(canonicalParent, canonicalTarget)) return false
    await requireProductFiles(canonicalTarget)
    const marker = JSON.parse(await readFile(join(canonicalTarget, PRODUCT_RUNTIME_MARKER), 'utf8'))
    return marker?.schemaVersion === 1 && marker.version === version
  } catch {
    return false
  }
}

async function requireProductFiles(root) {
  for (const relativePath of REQUIRED_PRODUCT_FILES) await access(join(root, relativePath))
}

async function pathExists(path) {
  try { await access(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

function isInside(parent, candidate) {
  const remainder = relative(parent, candidate)
  return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`))
}

export function acceptanceQuitDelay(argv, environment) {
  if (environment.XIAOSHE_DESKTOP_ACCEPTANCE !== '1') return undefined
  const prefix = '--acceptance-quit-after='
  const raw = argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 60_000 ? value : undefined
}

export async function waitForReady(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000; const intervalMs = options.intervalMs ?? 250; const fetcher = options.fetcher ?? globalThis.fetch
  const started = Date.now(); let last = 'no response'
  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) throw new Error('desktop readiness wait was cancelled')
    try {
      const response = await fetcher(new URL('xiaoshe/desktop/status', url), { signal: AbortSignal.timeout(2_000) })
      const value = await response.json()
      if (response.ok && value?.product === '小蛇' && value?.bridge?.state === 'ready') return Object.freeze(value)
      last = `HTTP ${response.status}`
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs))
  }
  throw new Error(`小蛇本地服务未在 ${timeoutMs}ms 内就绪：${last}`)
}

export class ProductServiceController {
  #started = false; #launch
  constructor(privateOptions) { this.options = privateOptions }
  async start() {
    try { await waitForReady(this.options.url, { timeoutMs: 1_000 }); return { reused: true } } catch { /* launch below */ }
    this.#launch = await launchCommand(this.options.productRoot, this.options.platform)
    const result = await runProcess(this.#launch, this.options.startTimeoutMs ?? 15 * 60_000)
    if (result.exitCode !== 0) throw new Error(`小蛇服务启动器失败：${result.stderr.slice(-2000)}`)
    await waitForReady(this.options.url, { timeoutMs: this.options.readyTimeoutMs ?? 30_000 })
    this.#started = true; return { reused: false }
  }
  async stopOwned() {
    if (!this.#started) return { stopped: false, reason: 'reused-existing-service' }
    const command = await stopCommand(this.options.productRoot, this.options.platform); const result = await runProcess(command, 60_000); this.#started = false
    return { stopped: result.exitCode === 0, exitCode: result.exitCode, stderr: result.stderr }
  }
}

export async function launchCommand(root, platform) {
  if (platform === 'win32') return powershellCommand(join(root, 'scripts', 'windows-start-entry.ps1'), ['-NoOpen', '-ServerOnly'])
  if (platform === 'darwin') { const script = join(root, 'scripts', 'start-xiaoshe-web.sh'); await access(script); return { command: '/bin/bash', args: [script], cwd: root, environment: { XIAOSHE_DSH_NO_OPEN: '1' } } }
  throw new Error(`unsupported desktop platform ${platform}`)
}
export async function stopCommand(root, platform) {
  if (platform === 'win32') return powershellCommand(join(root, 'scripts', 'windows-stop-entry.ps1'), [])
  if (platform === 'darwin') { const script = join(root, 'scripts', 'stop-xiaoshe-web.sh'); await access(script); return { command: '/bin/bash', args: [script], cwd: root } }
  throw new Error(`unsupported desktop platform ${platform}`)
}
export function resolvePowerShell(environment = process.env, pathExists = existsSync) {
  const installed = [
    environment.ProgramFiles === undefined ? undefined : join(environment.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
    environment.SystemRoot === undefined ? undefined : join(environment.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ].find(candidate => candidate !== undefined && pathExists(candidate))
  // Windows PowerShell is present on supported Windows versions and is the
  // safest PATH fallback when neither absolute location can be inspected.
  return installed ?? 'powershell.exe'
}
function powershellCommand(script, extra) { return { command: resolvePowerShell(), args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra], cwd: dirname(dirname(script)) } }
export function runProcess(spec, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...safeEnvironment(), ...spec.environment }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; const append = (current, chunk) => `${current}${String(chunk)}`.slice(-128 * 1024)
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk) }); child.stderr?.on('data', chunk => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill() }, timeoutMs); timer.unref()
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolveRun({ exitCode: code ?? -1, stdout, stderr }) })
  })
}
function safeEnvironment() { return Object.fromEntries(['APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'DSH_HOME', 'XIAOSHE_DSH_PORT'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])) }
