import { spawn } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = join(root, 'runtime', 'DSH')
const cli = join(dshRoot, 'apps', 'cli', 'src', 'bin.ts')
const baselineVerifier = join(root, 'scripts', 'verify-native-shell-profile.mjs')
const profile = 'xiaoshe-native-shell-proof'
const args = process.argv.slice(2)
const serve = args.includes('--serve')
const homeIndex = args.indexOf('--dsh-home')
if (homeIndex < 0 || args[homeIndex + 1] === undefined) throw new Error('--dsh-home <absolute-path> is required')
const dshHome = resolve(args[homeIndex + 1])
const artifacts = join(dshHome, 'artifacts')
const productTar = join(artifacts, 'xiaoshe-product-bundle-0.1.0.tgz')
const adaptedClientPath = '/plugins/@xiaoshe%2Fnative-shell-legacy-adapted/client.js'
const baseEnv = sanitizedEnvironment({ DSH_HOME: dshHome })

await mkdir(artifacts, { recursive: true })
progress('verify the formal Product Profile add/remove baseline')
const baselineOutput = await run(process.execPath, [baselineVerifier, '--dsh-home', dshHome], root, sanitizedEnvironment())
const baseline = lastJsonLine(baselineOutput)
if (baseline.status !== 'PASS') throw new Error(`formal Product Profile verification did not pass: ${JSON.stringify(baseline)}`)
await access(productTar)

// The formal Product Bundle now points directly at the isolated adapted copy.
// Re-add it after the baseline removal so --serve can hold the exact release
// composition without the historical comparison overlay.
progress('reinstall the formal legacy-adapted Product Bundle')
await runDsh(['plugin', '--profile', profile, 'add', '--offline', productTar])
const dump = await runDsh(['--profile', profile, '--dump-config'])
const adaptedPresent = dump.includes('xiaoshe-native-shell-legacy-adapted')
const originalAbsent = !/^\s*-?\s*id:\s+xiaoshe-native-shell\s*$/mu.test(dump)
const servicesPreserved = ['xiaoshe-runtime-dsh-provider', 'xiaoshe-completion-receipt', 'xiaoshe-heartbeat', 'xiaoshe-memory', 'xiaoshe-plugin-governance', 'xiaoshe-task-timeline', 'xiaoshe-verification-policy']
  .every(id => dump.includes(id))

progress('start the installed legacy-adapted Product Profile')
const held = await startServer()
const probe = await probeServer(held.url)
const ready = adaptedPresent && originalAbsent && servicesPreserved
  && probe.rootStatus === 200 && probe.adaptedClientStatus === 200
  && probe.adaptedBrandStatus === 200 && probe.adaptedRasterStatus === 200 && probe.heartbeatStatus === 200
if (!ready) {
  const exit = await stop(held.child)
  throw new Error(`legacy-adapted Profile probe failed: ${JSON.stringify({ adaptedPresent, originalAbsent, servicesPreserved, probe, exit })}\n${held.output().slice(-4_000)}`)
}

if (serve) {
  process.stdout.write(`${JSON.stringify({
    status: 'READY', profile, url: held.url, dsh_home: dshHome,
    adapted_client_status: probe.adaptedClientStatus,
    adapted_brand_status: probe.adaptedBrandStatus,
    adapted_raster_status: probe.adaptedRasterStatus,
    original_shell_absent: originalAbsent,
    product_services_preserved: servicesPreserved,
  })}\n`)
  await waitForShutdownSignal()
  await stop(held.child)
  process.exit(0)
}

const exit = await stop(held.child)
const stoppedCleanly = exit.code === 0 || exit.signal === 'SIGTERM'
process.stdout.write(`${JSON.stringify({
  status: ready && stoppedCleanly ? 'PASS' : 'FAIL',
  profile,
  dsh_home: dshHome,
  root_status: probe.rootStatus,
  adapted_client_status: probe.adaptedClientStatus,
  adapted_brand_status: probe.adaptedBrandStatus,
  adapted_raster_status: probe.adaptedRasterStatus,
  heartbeat_status: probe.heartbeatStatus,
  adapted_present: adaptedPresent,
  original_shell_absent: originalAbsent,
  product_services_preserved: servicesPreserved,
  process_exit_code: exit.code,
  process_exit_signal: exit.signal,
  baseline_status: baseline.status,
  sentinel_unchanged: baseline.sentinel_unchanged,
})}\n`)

async function probeServer(url) {
  const [rootResponse, adaptedClientResponse, adaptedBrandResponse, adaptedRasterResponse, heartbeatResponse] = await Promise.all([
    fetch(url),
    fetch(`${url}${adaptedClientPath}`),
    fetch(`${url}/api/xiaoshe/legacy-adapted-brand-icon`),
    fetch(`${url}/api/xiaoshe/legacy-adapted-brand-raster`),
    fetch(`${url}/api/xiaoshe/heartbeat`),
  ])
  return {
    rootStatus: rootResponse.status,
    adaptedClientStatus: adaptedClientResponse.status,
    adaptedBrandStatus: adaptedBrandResponse.status,
    adaptedRasterStatus: adaptedRasterResponse.status,
    heartbeatStatus: heartbeatResponse.status,
  }
}

async function startServer() {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', cli, '--profile', profile, '--no-open', '--port', '0'], {
    cwd: dshRoot,
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  const append = chunk => { output += String(chunk) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  try {
    const url = await waitForUrl(child, () => output)
    return { child, url, output: () => output }
  } catch (error) {
    await stop(child)
    throw new Error(`legacy-adapted server failed: ${error instanceof Error ? error.message : String(error)}\n${output.slice(-4_000)}`)
  }
}

async function waitForUrl(child, output) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(output())
    if (match?.[1] !== undefined) return match[1]
    if (child.exitCode !== null) throw new Error(`server exited before announcing URL (${String(child.exitCode)})`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error('server did not announce a loopback URL within 60 seconds')
}

async function stop(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: null }
  child.kill()
  return await new Promise(resolveExit => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolveExit({ code: child.exitCode, signal: 'SIGKILL_TIMEOUT' })
    }, 5_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    })
  })
}

async function waitForShutdownSignal() {
  return await new Promise(resolveSignal => {
    process.once('SIGINT', resolveSignal)
    process.once('SIGTERM', resolveSignal)
  })
}

async function runDsh(commandArgs) {
  return await run(process.execPath, ['--import', 'tsx/esm', cli, ...commandArgs], dshRoot, baseEnv)
}

async function run(command, commandArgs, cwd, env) {
  const child = spawn(command, commandArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
  if (code !== 0) throw new Error(`${command} exited ${String(code)}\n${stderr.slice(-6_000)}\n${stdout.slice(-6_000)}`)
  return stdout
}

function sanitizedEnvironment(extra = {}) {
  const allowed = ['APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']
  return Object.fromEntries([
    ...allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
    ['CI', '1'],
    ...Object.entries(extra),
  ])
}

function lastJsonLine(output) {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]) } catch { /* Keep looking for the verifier record. */ }
  }
  throw new Error(`formal verifier did not emit JSON: ${output.slice(-2_000)}`)
}

function progress(message) {
  process.stderr.write(`[native-shell-legacy-adapted-profile] ${message}\n`)
}
