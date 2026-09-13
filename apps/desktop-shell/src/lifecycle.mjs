import { validateDesktopLoginUrl, redactDesktopLogin, cleanDesktopLoginUrl } from './desktop-login.mjs'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptanceServiceEnvironment } from './acceptance-isolation.mjs'

const PRODUCT_RUNTIME_MARKER = '.xiaoshe-product-runtime.json'
const REQUIRED_PRODUCT_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'runtime/DSH/package.json',
  'packages/agent-experience/package.json',
  'runtime/xiaoshe-legacy/ui/assets/app-icon-256.png',
  'runtime/xiaoshe-legacy/ui/assets/icon-16.png',
  'runtime/xiaoshe-legacy/ui/assets/icon-32.png',
  'setup/install-windows.ps1',
  'scripts/start-xiaoshe-web.sh',
  'scripts/isolated-browser-protocol.mjs',
  'scripts/product-runtime-identity.mjs',
  'apps/desktop-shell/src/acceptance-isolation.mjs',
])
const UNSHIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.venv'])
const RECOVERY_RUNTIME_LIMIT = 2

// Chromium reports `clean-exit` both when the current renderer disappears and
// when an obsolete renderer is retired after a process swap. The event can
// arrive while WebContents still points at the just-disposed frame, so a single
// immediate probe is not evidence of failure. Retry a bounded, content-free
// probe after the process swap has had time to settle.
export const CURRENT_RENDERER_PROBE_SETTLE_MS = 500
export const CURRENT_RENDERER_PROBE_TIMEOUT_MS = 750
export const CURRENT_RENDERER_PROBE_ATTEMPTS = 4

export function rendererExitAction({ reason, visible }) {
  if (visible !== true) return 'defer'
  return reason === 'clean-exit' ? 'probe-current' : 'recover'
}

export async function rendererProbePassed({
  probe,
  wait,
  attempts = CURRENT_RENDERER_PROBE_ATTEMPTS,
  settleMs = CURRENT_RENDERER_PROBE_SETTLE_MS,
  timeoutMs = CURRENT_RENDERER_PROBE_TIMEOUT_MS,
}) {
  if (typeof probe !== 'function' || typeof wait !== 'function') throw new TypeError('renderer probe and timer are required')
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 8) throw new RangeError('renderer probe attempts are invalid')
  if (!Number.isSafeInteger(settleMs) || settleMs < 100 || settleMs > 2_000) throw new RangeError('renderer probe settle delay is invalid')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 2_000) throw new RangeError('renderer probe timeout is invalid')
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(settleMs)
    const probeOutcome = Promise.resolve().then(probe).then(value => value === true, () => false)
    const timeoutOutcome = Promise.resolve().then(() => wait(timeoutMs)).then(() => false)
    if (await Promise.race([probeOutcome, timeoutOutcome])) return true
  }
  return false
}

export function defaultProductRoot({ packaged, resourcesPath, moduleUrl = import.meta.url }) {
  return packaged ? resolve(resourcesPath, 'product') : resolve(dirname(fileURLToPath(moduleUrl)), '../../..')
}

/** Return a deliberate product-root override, never an empty environment entry. */
export function productRootOverride(environment) {
  return environment.XIAOSHE_PRODUCT_ROOT?.trim() || undefined
}

/**
 * Retire independent resources without allowing the first failure to skip the
 * service stop. The caller must treat an AggregateError as a failed shutdown.
 */
export async function shutdownOwnedProduct({ closeBrowser, stopService }) {
  if (typeof closeBrowser !== 'function' || typeof stopService !== 'function') throw new TypeError('shutdown cleanup functions are required')
  const results = await Promise.allSettled([
    Promise.resolve().then(closeBrowser),
    Promise.resolve().then(stopService),
  ])
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'owned product shutdown failed')
  return { browser: results[0].value, service: results[1].value }
}

/**
 * Keep packaged resources immutable. A signed macOS application bundle and a
 * managed Windows installation are distribution inputs, not writable runtime
 * homes. Same-version builds can contain different code, so reuse requires the
 * shipped file inventory and content digest, not just the application version.
 * Unchanged launches preserve installed dependencies and local runtime state.
 */
export async function prepareProductRoot({ packaged, resourcesPath, userDataPath, version, moduleUrl = import.meta.url }) {
  if (!packaged) return defaultProductRoot({ packaged, resourcesPath, moduleUrl })
  if (!isAbsolute(userDataPath ?? '')) throw new TypeError('packaged userDataPath must be absolute')
  if (typeof version !== 'string' || !/^[0-9A-Za-z._-]{1,64}$/u.test(version) || version === '.' || version === '..') throw new TypeError('packaged version is invalid')
  const source = defaultProductRoot({ packaged: true, resourcesPath })
  await requireProductFiles(source)
  const files = await shippedProductFiles(source)
  const fingerprint = await productFingerprint(source, files)

  const runtimeParent = resolve(userDataPath, 'runtime')
  await mkdir(runtimeParent, { recursive: true })
  const canonicalParent = await realpath(runtimeParent)
  const target = resolve(runtimeParent, version)
  if (await reusableProductRoot(target, canonicalParent, version, files, fingerprint)) return target

  // Validate the entire staged copy BEFORE moving the current runtime. A bad
  // package, incomplete copy or full disk must not take the old runtime away.
  const staging = `${target}.partial-${process.pid}-${randomUUID()}`
  let recovery
  try {
    await cp(source, staging, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true,
      filter: path => !relative(source, path).split(sep).some(part => UNSHIPPED_DIRECTORIES.has(part)),
    })
    await writeFile(join(staging, PRODUCT_RUNTIME_MARKER), `${JSON.stringify({ schemaVersion: 3, version, fingerprint, files })}\n`, { encoding: 'utf8', flag: 'wx' })
    if (!(await reusableProductRoot(staging, canonicalParent, version, files, fingerprint))) throw new Error('packaged product staging failed integrity validation')
    if (await pathExists(target)) {
      const info = await lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink() || !isInside(canonicalParent, await realpath(target))) throw new Error('unsafe packaged runtime target')
      recovery = `${target}.recovery-${Date.now()}-${randomUUID()}`
      await rename(target, recovery)
    }
    await rename(staging, target)
  } catch (error) {
    if (recovery !== undefined && !(await pathExists(target))) {
      try { await rename(recovery, target) } catch (rollbackError) {
        error = new AggregateError([error, rollbackError], `Runtime activation failed; previous runtime remains at ${recovery}`)
      }
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  // Retain recent rollback evidence without allowing repeated same-version
  // refreshes to consume unbounded user storage. Cleanup is deliberately
  // best-effort: activation has already succeeded and must stay available.
  await retainRecentRecoveries(runtimeParent, canonicalParent).catch(() => {})
  return target
}

async function retainRecentRecoveries(runtimeParent, canonicalParent) {
  const recoveries = []
  for (const entry of await readdir(runtimeParent, { withFileTypes: true })) {
    const match = /^([0-9A-Za-z._-]{1,64})\.recovery-([0-9]+)-[0-9a-f-]+$/u.exec(entry.name)
    if (match === null || match[1] === '.' || match[1] === '..' || entry.isSymbolicLink() || !entry.isDirectory()) continue
    const path = resolve(runtimeParent, entry.name)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    const canonical = await realpath(path)
    if (!isInside(canonicalParent, canonical)) continue
    let marker
    try { marker = JSON.parse(await readFile(join(canonical, PRODUCT_RUNTIME_MARKER), 'utf8')) } catch { continue }
    const verified = validRuntimeMarker(marker, match[1])
    if (verified === undefined) continue
    try {
      await requireProductFiles(canonical)
      if (await productFingerprint(canonical, verified.files) !== verified.fingerprint) continue
    } catch { continue }
    const createdAt = Number(match[2])
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) continue
    recoveries.push({ path, createdAt })
  }
  recoveries.sort((left, right) => right.createdAt - left.createdAt || right.path.localeCompare(left.path))
  for (const recovery of recoveries.slice(RECOVERY_RUNTIME_LIMIT)) await rm(recovery.path, { recursive: true, force: true })
}

async function reusableProductRoot(target, canonicalParent, version, files, fingerprint) {
  if (!(await pathExists(target))) return false
  try {
    const info = await lstat(target)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    const canonicalTarget = await realpath(target)
    if (!isInside(canonicalParent, canonicalTarget)) return false
    await requireProductFiles(canonicalTarget)
    const marker = validRuntimeMarker(JSON.parse(await readFile(join(canonicalTarget, PRODUCT_RUNTIME_MARKER), 'utf8')), version)
    return marker !== undefined && marker.fingerprint === fingerprint
      && JSON.stringify(marker.files) === JSON.stringify(files)
      && await productFingerprint(canonicalTarget, marker.files) === fingerprint
  } catch {
    return false
  }
}

function validRuntimeMarker(value, version) {
  if (value?.schemaVersion !== 3 || value.version !== version || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.fingerprint)) return undefined
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 50_000) return undefined
  const files = []
  for (const path of value.files) {
    if (typeof path !== 'string' || path === '' || path.includes('\\') || isAbsolute(path)) return undefined
    const parts = path.split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..')) return undefined
    files.push(path)
  }
  const normalized = [...new Set(files)].sort()
  if (normalized.length !== files.length || JSON.stringify(normalized) !== JSON.stringify(files)) return undefined
  if (!REQUIRED_PRODUCT_FILES.every(required => normalized.includes(required))) return undefined
  return { fingerprint: value.fingerprint, files: normalized }
}

/** Inventory only distribution-owned files; never hash user-added dependencies. */
async function shippedProductFiles(root) {
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (UNSHIPPED_DIRECTORIES.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`unsafe symbolic link in packaged product: ${relative(root, path)}`)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        if (entry.name === PRODUCT_RUNTIME_MARKER) throw new Error('packaged source contains a runtime marker')
        files.push(relative(root, path).split(sep).join('/'))
        if (files.length > 50_000) throw new Error('packaged product file limit exceeded')
      } else throw new Error(`unsafe packaged product entry: ${relative(root, path)}`)
    }
  }
  await visit(root)
  return files.sort()
}

/** Bounded I/O verifies both path inventory and bytes, including same-size edits. */
async function productFingerprint(root, files) {
  const canonicalRoot = await realpath(root)
  const hashes = new Array(files.length)
  let next = 0
  // Settle all opened reads before the caller can remove a failed staging
  // directory; Promise.all's early rejection would leave I/O racing cleanup.
  const results = await Promise.allSettled(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      const index = next++
      const path = join(root, files[index])
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || !isInside(canonicalRoot, await realpath(path))) throw new Error(`unsafe runtime file: ${files[index]}`)
      hashes[index] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }))
  const failure = results.find(result => result.status === 'rejected')
  if (failure !== undefined) throw failure.reason
  return createHash('sha256').update(JSON.stringify(files.map((path, index) => [path, hashes[index]]))).digest('hex')
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
  const expectedRuntimeIdentity = options.expectedRuntimeIdentity
  if (typeof expectedRuntimeIdentity !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedRuntimeIdentity)) {
    throw new Error('desktop readiness requires a valid expected runtime identity')
  }
  const started = Date.now(); let last = 'no response'
  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) throw new Error('desktop readiness wait was cancelled')
    try {
      const response = await fetcher(new URL('xiaoshe/desktop/status', url), { signal: AbortSignal.timeout(2_000) })
      const value = await response.json()
      if (response.ok && value?.product === '小蛇' && value?.bridge?.state === 'ready' && value?.runtime_identity === expectedRuntimeIdentity) return Object.freeze(value)
      last = response.ok && value?.product === '小蛇' && value?.bridge?.state === 'ready'
        ? `runtime identity mismatch (expected ${expectedRuntimeIdentity}, received ${String(value?.runtime_identity ?? 'missing')})`
        : `HTTP ${response.status}`
    } catch (error) { last = redactDesktopLogin(error instanceof Error ? error.message : String(error)) }
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs))
  }
  throw new Error(`小蛇本地服务未在 ${timeoutMs}ms 内就绪：${last}`)
}

/**
 * BrowserWindow.loadURL does not retry a transient connection refusal.  The
 * product health endpoint can become ready just before launchd replaces or
 * rebinds the supervised listener, so one failed navigation must not leave a
 * permanently blank desktop window.
 */
export async function loadProductPage(target, url, options = {}) {
  if (target === null || typeof target?.loadURL !== 'function') throw new TypeError('desktop window must provide loadURL')
  const productUrl = new URL(url).href
  const maxAttempts = options.maxAttempts ?? 40
  const intervalMs = options.intervalMs ?? 250
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 120) throw new RangeError('desktop page load attempts are invalid')
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 5_000) throw new RangeError('desktop page load interval is invalid')
  const wait = options.wait ?? (delay => new Promise(resolveWait => setTimeout(resolveWait, delay)))
  let last = 'no response'
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (target.isDestroyed?.()) throw new Error('小蛇窗口已关闭，停止加载界面')
    try {
      await target.loadURL(productUrl)
      return Object.freeze({ attempts: attempt, url: cleanDesktopLoginUrl(productUrl) })
    } catch (error) {
      last = redactDesktopLogin(error instanceof Error ? error.message : String(error))
      if (attempt === maxAttempts) break
      if (typeof options.onRetry === 'function') {
        try { await options.onRetry(Object.freeze({ attempt, message: last })) } catch { /* telemetry cannot break recovery */ }
      }
      await wait(intervalMs)
    }
  }
  throw new Error(`小蛇界面连续 ${maxAttempts} 次加载失败：${last}`)
}

export class ProductServiceController {
  #started = false; #launch; #run; #ownershipToken
  constructor(privateOptions) {
    this.options = privateOptions
    this.#run = privateOptions.run ?? runProcess
  }
  async start() {
    // A ready loopback listener alone has no product-root or Profile identity.
    // Always delegate reuse decisions to the platform launcher, which owns the
    // runtime/profile checks and refuses a listener from another product root.
    const launch = this.options.launch ?? launchCommand
    const ready = this.options.ready ?? waitForReady
    this.#ownershipToken = this.options.ownershipToken ?? randomUUID()
    this.#launch = await launch(this.options.productRoot, this.options.platform, this.#ownershipToken)
    let result
    try {
      result = await this.#run(this.#launch, this.options.startTimeoutMs ?? 15 * 60_000)
    } catch (launchError) {
      await this.#compensateUnknownLaunch(launchError)
    }
    if (result.exitCode !== 0) {
      await this.#compensateUnknownLaunch(new Error(`小蛇服务启动器失败（exit ${result.exitCode}）：stdout=${redactDesktopLogin(result.stdout).slice(-4000)} stderr=${redactDesktopLogin(result.stderr).slice(-4000)}`))
    }
    let ownership
    try { ownership = parseLaunchOwnership(result.stdout, this.#ownershipToken, this.options.url) } catch (ownershipError) {
      await this.#compensateUnknownLaunch(ownershipError)
    }
    this.#started = ownership.status === 'started'
    try {
      await ready(this.options.url, {
        timeoutMs: this.options.readyTimeoutMs ?? 30_000,
        expectedRuntimeIdentity: ownership.identity,
      })
    } catch (readinessError) {
      if (this.#started) {
        try {
          const cleanup = await this.stopOwned()
          if (!cleanup.stopped) throw new Error(`newly started service cleanup failed (exit ${cleanup.exitCode ?? 'unknown'})`)
        } catch (cleanupError) {
          throw new AggregateError([readinessError, cleanupError], '小蛇服务已启动但未就绪，且补偿停止失败')
        }
      }
      throw readinessError
    }
    return { reused: ownership.status === 'reused', loginUrl: ownership.loginUrl }
  }
  async stopOwned() {
    if (!this.#started) return { stopped: false, reason: 'reused-existing-service' }
    const command = await stopCommand(this.options.productRoot, this.options.platform, this.#ownershipToken); const result = await this.#run(command, 60_000)
    if (result.exitCode !== 0) {
      // Preserve ownership after a failed stop so callers can retry with the
      // same token instead of silently orphaning a product service.
      throw new Error(`owned service stop failed (exit ${result.exitCode}): ${result.stderr.slice(-4000)}`)
    }
    this.#started = false
    return { stopped: true, exitCode: result.exitCode, stderr: result.stderr }
  }
  async #compensateUnknownLaunch(primaryError) {
    try {
      const command = await stopCommand(this.options.productRoot, this.options.platform, this.#ownershipToken)
      const cleanup = await this.#run(command, 60_000)
      if (cleanup.exitCode !== 0) throw new Error(`token-scoped launch compensation failed (exit ${cleanup.exitCode}): ${cleanup.stderr}`)
    } catch (cleanupError) {
      throw new AggregateError([primaryError, cleanupError], '小蛇启动结果不可信，且基于所有权令牌的补偿失败')
    }
    throw primaryError
  }
}

export async function launchCommand(root, platform, ownershipToken = randomUUID()) {
  if (platform === 'win32') return powershellCommand(join(root, 'scripts', 'windows-start-entry.ps1'), ['-NoOpen', '-ServerOnly', '-OwnershipReport', '-OwnershipToken', ownershipToken])
  if (platform === 'darwin') { const script = join(root, 'scripts', 'start-xiaoshe-web.sh'); await access(script); return { command: '/bin/bash', args: [script, '--ownership-report'], cwd: root, environment: { XIAOSHE_DSH_NO_OPEN: '1', XIAOSHE_LAUNCH_TOKEN: ownershipToken } } }
  throw new Error(`unsupported desktop platform ${platform}`)
}
function parseLaunchOwnership(stdout, expectedToken, baseUrl) {
  const prefix = 'XIAOSHE_LAUNCH_OWNERSHIP='
  const lines = String(stdout).split(/\r?\n/u).filter(line => line.startsWith(prefix))
  if (lines.length !== 1) throw new Error('小蛇服务启动器未提供唯一的所有权结果')
  let value
  try { value = JSON.parse(lines[0].slice(prefix.length)) } catch { throw new Error('小蛇服务启动器所有权结果无效') }
  if (value?.schema !== 'xiaoshe-launch-ownership/v1' || (value.status !== 'started' && value.status !== 'reused')) {
    throw new Error('小蛇服务启动器所有权结果无效')
  }
  if (typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/u.test(value.identity)) {
    throw new Error('小蛇服务启动器所有权运行身份无效')
  }
  if (value.status === 'started' && value.token !== expectedToken) throw new Error('小蛇服务启动器所有权令牌不匹配')
  return Object.freeze({ status: value.status, identity: value.identity, loginUrl: validateDesktopLoginUrl(value.loginUrl, baseUrl) })
}
export async function stopCommand(root, platform, ownershipToken) {
  const tokenArgs = ownershipToken === undefined ? [] : ['-OwnershipToken', ownershipToken]
  if (platform === 'win32') return powershellCommand(join(root, 'scripts', 'windows-stop-entry.ps1'), tokenArgs)
  if (platform === 'darwin') { const script = join(root, 'scripts', 'stop-xiaoshe-web.sh'); await access(script); return { command: '/bin/bash', args: ownershipToken === undefined ? [script] : [script, '--ownership-token', ownershipToken], cwd: root } }
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
export function safeEnvironment(environment = process.env, isolationOptions) {
  const isolation = acceptanceServiceEnvironment(environment, isolationOptions)
  const safe = Object.fromEntries(
    ['APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'DSH_HOME', 'XIAOSHE_DSH_PORT', 'XIAOSHE_PYTHON']
      .flatMap(key => environment[key] === undefined ? [] : [[key, environment[key]]]),
  )
  // The isolated fixture must not inherit proxy credentials or route local-only
  // acceptance traffic through the user's network configuration.
  if (isolation !== undefined) return { ...safe, ...isolation }
  // The Windows launcher consumes uppercase names. Accept their conventional
  // lowercase forms at this boundary, but keep the child environment minimal
  // and do not forward unsupported ALL_PROXY or unrelated process secrets.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    const lowerKey = key.toLowerCase()
    const upperValue = environment[key]
    const lowerValue = environment[lowerKey]
    const value = typeof upperValue === 'string' && upperValue.trim() !== ''
      ? upperValue
      : typeof lowerValue === 'string' && lowerValue.trim() !== '' ? lowerValue : undefined
    if (value !== undefined) safe[key] = value
  }
  return safe
}
