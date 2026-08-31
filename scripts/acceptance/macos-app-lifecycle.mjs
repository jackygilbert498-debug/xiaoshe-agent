#!/usr/bin/env node
/** Real packaged Xiaoshe lifecycle acceptance for macOS. */
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer, createConnection } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const SERVICE_LABEL = 'com.xiaoshe.dsh.web'
const MAX_CAPTURE = 128 * 1024
const RUNTIME_MARKER = '.xiaoshe-product-runtime.json'
const REQUIRED_MATERIALIZED_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'runtime/DSH/apps/cli/lib/bin.js',
  'scripts/start-xiaoshe-web.sh',
]

function parseArgs(argv) {
  return new Map(argv.map(value => {
    const separator = value.indexOf('=')
    if (!value.startsWith('--') || separator < 3) throw new Error(`invalid argument: ${value}`)
    return [value.slice(2, separator), value.slice(separator + 1)]
  }))
}

async function findFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close()
        reject(new Error('could not allocate an isolated loopback port'))
        return
      }
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

function serviceIsRegistered() {
  const domain = `gui/${process.getuid()}/${SERVICE_LABEL}`
  return spawnSync('/bin/launchctl', ['print', domain], { stdio: 'ignore' }).status === 0
}

async function portIsOpen(port) {
  return await new Promise(resolveOpen => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = value => { socket.destroy(); resolveOpen(value) }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitUntil(predicate, timeoutMs, description, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await new Promise(resolveWait => setTimeout(resolveWait, intervalMs))
  }
  throw new Error(`timed out waiting for ${description}; last=${String(last)}`)
}

async function readProductStatus(url) {
  try {
    const response = await fetch(new URL('xiaoshe/desktop/status', url), { signal: AbortSignal.timeout(2_000) })
    const body = await response.json()
    return response.ok && body?.product === '小蛇' && body?.bridge?.state === 'ready' ? body : undefined
  } catch {
    return undefined
  }
}

function appendTail(current, chunk) {
  return `${current}${String(chunk)}`.slice(-MAX_CAPTURE)
}

function launch(binary, argv, environment) {
  const child = spawn(binary, argv, {
    cwd: dirname(binary),
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = { stdout: '', stderr: '' }
  child.stdout?.on('data', chunk => { capture.stdout = appendTail(capture.stdout, chunk) })
  child.stderr?.on('data', chunk => { capture.stderr = appendTail(capture.stderr, chunk) })
  return { child, capture }
}

async function waitForExit(child, timeoutMs, description) {
  if (child.exitCode !== null) return child.exitCode
  return await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`${description} did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
    const onExit = code => { cleanup(); resolveExit(code ?? -1) }
    const onError = error => { cleanup(); reject(error) }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function terminate(child, description) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForExit(child, 5_000, `${description} graceful termination`)
  } catch {
    if (child.exitCode === null) child.kill('SIGKILL')
    await waitForExit(child, 5_000, `${description} forced termination`)
  }
}

function windowFact(pid) {
  const script = `tell application "System Events"
set matches to every application process whose unix id is ${Number(pid)}
if (count matches) is 0 then return ""
tell item 1 of matches
  set windowCount to count of windows
  set windowTitle to ""
  if windowCount > 0 then set windowTitle to name of front window as text
  return (name as text) & "|" & (windowCount as text) & "|" & windowTitle
end tell
end tell`
  const result = spawnSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout: 5_000 })
  if (result.status !== 0) return undefined
  const [processName, rawCount, title] = String(result.stdout).trim().split('|')
  const count = Number(rawCount)
  return processName && Number.isInteger(count) && count > 0 ? { processName, count, title } : undefined
}

function brandedWindowFact(pid) {
  const fact = windowFact(pid)
  if (!fact) return undefined
  return fact.title.includes('小蛇') && !/(?:DSH Local Build|DeepSeek Harness)/iu.test(fact.title) ? fact : undefined
}

async function stopOwnedService(root, port, environment) {
  const script = join(root, 'scripts', 'stop-xiaoshe-web.sh')
  const result = spawnSync('/bin/bash', [script], {
    cwd: root,
    env: { ...process.env, HOME: environment.HOME, DSH_HOME: environment.DSH_HOME, XIAOSHE_DSH_PORT: String(port), XIAOSHE_DSH_NO_PAUSE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: result.status, stderr: String(result.stderr ?? '').slice(-2_000) }
}

async function startupEvents(userData) {
  const path = join(userData, 'logs', 'desktop-shell.jsonl')
  const text = await readFile(path, 'utf8')
  const rows = text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
  return { path, events: rows.map(row => row.event), rows }
}

async function failureDiagnostics(userData, primary, second) {
  let desktopLog = ''
  try { desktopLog = (await readFile(join(userData, 'logs', 'desktop-shell.jsonl'), 'utf8')).slice(-12_000) } catch { /* startup may fail before logging */ }
  const primaryStdout = primary?.capture.stdout ?? ''
  const primaryStderr = primary?.capture.stderr ?? ''
  const secondStderr = second?.capture.stderr ?? ''
  return [
    desktopLog === '' ? '' : `desktop-log=${desktopLog}`,
    primaryStdout === '' ? '' : `primary-stdout=${primaryStdout.slice(-4_000)}`,
    primaryStderr === '' ? '' : `primary-stderr=${primaryStderr.slice(-4_000)}`,
    secondStderr === '' ? '' : `second-stderr=${secondStderr.slice(-2_000)}`,
  ].filter(Boolean).join('; ')
}

async function inspectMaterializedRuntime(userData, version) {
  const expected = join(userData, 'runtime', version)
  const canonicalUserData = await realpath(userData)
  const canonicalRuntime = await realpath(expected)
  const remainder = relative(canonicalUserData, canonicalRuntime)
  if (remainder === '' || isAbsolute(remainder) || remainder === '..' || remainder.startsWith(`..${sep}`)) {
    throw new Error('packaged runtime was not materialized below isolated userData')
  }
  for (const path of REQUIRED_MATERIALIZED_FILES) await access(join(canonicalRuntime, path))
  const marker = JSON.parse(await readFile(join(canonicalRuntime, RUNTIME_MARKER), 'utf8'))
  if (marker?.schemaVersion !== 1 || marker.version !== version) throw new Error('packaged runtime marker is invalid')
  return {
    source: 'per-user-copy',
    materializedUnderUserData: true,
    version: marker.version,
    requiredFiles: REQUIRED_MATERIALIZED_FILES,
  }
}

export async function runMacosAppLifecycle({ root, appPath, keepUserData = false, usePackagedRuntime = false }) {
  if (process.platform !== 'darwin') throw new Error('macOS application lifecycle acceptance requires Darwin')
  root = resolve(root)
  appPath = resolve(appPath)
  const binary = join(appPath, 'Contents', 'MacOS', '小蛇')
  await access(binary, constants.X_OK)
  if (serviceIsRegistered()) throw new Error(`${SERVICE_LABEL} already exists; refusing to disturb an unrelated service`)

  const port = await findFreePort()
  if (await portIsOpen(port)) throw new Error(`isolated port ${port} unexpectedly has a listener`)
  const userData = await mkdtemp(join(tmpdir(), 'xiaoshe-desktop-lifecycle-'))
  const isolatedHome = join(userData, 'home')
  await mkdir(isolatedHome, { recursive: true })
  const url = `http://127.0.0.1:${port}/`
  const commonArgs = [`--user-data-dir=${userData}`]
  const environment = {
    ...process.env,
    XIAOSHE_DSH_PORT: String(port),
    XIAOSHE_DESKTOP_URL: url,
    XIAOSHE_DESKTOP_ACCEPTANCE: '1',
  }
  if (usePackagedRuntime) {
    environment.HOME = isolatedHome
    environment.DSH_HOME = join(isolatedHome, '.dsh')
    for (const key of ['XIAOSHE_PRODUCT_ROOT', 'XIAOSHE_DSH_ROOT', 'XIAOSHE_LEGACY_ROOT', 'XIAOSHE_PNPM_CLI']) delete environment[key]
  } else {
    environment.XIAOSHE_PRODUCT_ROOT = root
  }
  let primary
  let second
  let serviceStarted = false
  let succeeded = false
  try {
    primary = launch(binary, [...commonArgs, '--acceptance-hide-show', '--acceptance-quit-after=15000'], environment)
    const health = await waitUntil(
      () => {
        if (primary.child.exitCode !== null) throw new Error(`primary desktop exited early (${primary.child.exitCode}): ${primary.capture.stderr.slice(-2000)}`)
        return readProductStatus(url)
      },
      usePackagedRuntime ? 15 * 60_000 : 120_000,
      'packaged Xiaoshe product readiness',
      250,
    )
    serviceStarted = true
    const visibleWindow = await waitUntil(() => brandedWindowFact(primary.child.pid), 12_000, 'branded packaged Xiaoshe window')
    const runtime = usePackagedRuntime
      ? await inspectMaterializedRuntime(userData, String(health.version))
      : { source: 'explicit-override', materializedUnderUserData: false }

    second = launch(binary, commonArgs, environment)
    const secondExitCode = await waitForExit(second.child, 10_000, 'second packaged instance')
    if (secondExitCode !== 0) throw new Error(`second packaged instance exited ${secondExitCode}: ${second.capture.stderr.slice(-2000)}`)
    if (primary.child.exitCode !== null) throw new Error('primary packaged instance exited during single-instance arbitration')

    const primaryExitCode = await waitForExit(primary.child, 45_000, 'primary packaged instance')
    if (primaryExitCode !== 0) throw new Error(`primary packaged instance exited ${primaryExitCode}: ${primary.capture.stderr.slice(-2000)}`)
    const portReleased = await waitUntil(async () => !(await portIsOpen(port)), 15_000, 'owned product port release')
    const serviceReleased = await waitUntil(() => !serviceIsRegistered(), 15_000, 'owned launchd service release')
    const log = await startupEvents(userData)
    // A healthy listener is not sufficient: Electron can still be showing a
    // blank page after a one-shot ERR_CONNECTION_REFUSED.  Keep the renderer
    // navigation completion in the release gate so that failure cannot drift
    // back into a false-positive desktop acceptance.
    const requiredEvents = ['boot-started', 'runtime-ready', 'service-ready', 'ui-renderer-ready', 'ui-ready', 'ui-recovery-deferred', 'ui-recovered', 'ui-visual-proof']
    for (const event of requiredEvents) {
      if (!log.events.includes(event)) throw new Error(`desktop lifecycle log is missing ${event}`)
    }
    const visualProof = log.rows.find(row => row.event === 'ui-visual-proof')
    if (visualProof?.nonBlank !== true) throw new Error('desktop lifecycle visual proof is blank')
    const runtimeReady = log.rows.find(row => row.event === 'runtime-ready')
    if (runtimeReady?.source !== runtime.source) throw new Error(`desktop reported unexpected runtime source: ${String(runtimeReady?.source)}`)

    const evidence = {
      appPath,
      primaryPid: primary.child.pid,
      secondPid: second.child.pid,
      primaryExitCode,
      secondExitCode,
      port,
      status: { product: health.product, version: health.version, bridge: health.bridge?.state, platform: health.bridge?.platform },
      window: visibleWindow,
      startupEvents: requiredEvents,
      runtime,
      portReleased: Boolean(portReleased),
      serviceReleased: Boolean(serviceReleased),
      userData,
    }
    succeeded = true
    return evidence
  } catch (error) {
    const diagnostics = await failureDiagnostics(userData, primary, second)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(diagnostics === '' ? message : `${message}; ${diagnostics}`, { cause: error })
  } finally {
    await terminate(second?.child, 'second packaged instance')
    await terminate(primary?.child, 'primary packaged instance')
    if (serviceStarted || serviceIsRegistered()) await stopOwnedService(root, port, environment)
    if (!keepUserData || !succeeded) await rm(userData, { recursive: true, force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = resolve(args.get('root') || process.cwd())
  const appPath = resolve(args.get('app') || join(root, 'apps', 'desktop-shell', 'dist-desktop', 'mac-arm64', '小蛇.app'))
  const output = resolve(args.get('output') || join(root, 'artifacts', 'acceptance', 'macos-app-lifecycle.json'))
  const usePackagedRuntime = args.get('runtime') === 'packaged'
  let check
  try {
    const evidence = await runMacosAppLifecycle({ root, appPath, usePackagedRuntime })
    check = {
      id: 'macos-app-lifecycle',
      state: 'pass',
      detail: '真实打包应用完成窗口启动、产品就绪、单实例仲裁、正常退出和自有服务回收。',
      evidence: { ...evidence, userData: undefined },
    }
  } catch (error) {
    check = { id: 'macos-app-lifecycle', state: 'fail', detail: error instanceof Error ? error.message : String(error), evidence: { appPath } }
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify({ schemaVersion: 1, platform: 'macos', generatedAt: new Date().toISOString(), checks: [check] }, null, 2)}\n`)
  process.stdout.write(`macOS app lifecycle: ${output}\n`)
  if (check.state === 'fail') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
