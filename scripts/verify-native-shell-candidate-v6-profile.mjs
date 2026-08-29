import { spawn } from 'node:child_process'
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = join(root, 'runtime', 'DSH')
const cli = join(dshRoot, 'apps', 'cli', 'src', 'bin.ts')
const baselineVerifier = join(root, 'scripts', 'verify-native-shell-profile.mjs')
// Reuse the exact Profile prepared and verified by the baseline verifier.
// Isolation comes from the caller-owned DSH_HOME, not from switching to an
// empty Profile that would silently drop the generic Web substrate.
const profile = 'xiaoshe-native-shell-proof'
const args = process.argv.slice(2)
const serve = args.includes('--serve')
const homeIndex = args.indexOf('--dsh-home')
if (homeIndex < 0 || args[homeIndex + 1] === undefined) throw new Error('--dsh-home <absolute-path> is required')
const dshHome = resolve(args[homeIndex + 1])
const artifacts = join(dshHome, 'artifacts')
const candidateTar = join(artifacts, 'xiaoshe-native-shell-candidate-v6-0.1.0.tgz')
const overlayTar = join(artifacts, 'xiaoshe-native-shell-candidate-v6-bundle-0.1.0.tgz')
const productTar = join(artifacts, 'xiaoshe-product-bundle-0.1.0.tgz')
const candidateClientPath = '/plugins/@xiaoshe%2Fnative-shell-candidate-v6/client.js'
const baseEnv = sanitizedEnvironment({ DSH_HOME: dshHome })

await mkdir(artifacts, { recursive: true })
progress('verify and prepare the unmodified Product Profile baseline')
const baselineOutput = await run(process.execPath, [baselineVerifier, '--dsh-home', dshHome], root, sanitizedEnvironment())
const baseline = lastJsonLine(baselineOutput)
if (baseline.status !== 'PASS') throw new Error(`baseline Product Profile verification did not pass: ${JSON.stringify(baseline)}`)

progress('build the separate candidate packages')
await runNodeBuild('native-shell-candidate-v6', 'scripts/build-client.mjs')
await runTypeScript('native-shell-candidate-v6', 'tsconfig.build.json')
await runTypeScript('native-shell-candidate-v6-bundle', 'tsconfig.json')
progress('pack exact candidate artifacts')
await packPackage('native-shell-candidate-v6')
await packPackage('native-shell-candidate-v6-bundle')
await Promise.all([access(productTar), access(candidateTar), access(overlayTar)])

// The baseline verifier intentionally leaves Product child packages installed
// but removes Product Bundle. Re-add Product first, then the candidate overlay.
progress('install candidate package, Product Bundle, then candidate overlay')
await runDsh(['plugin', '--profile', profile, 'add', '--offline', candidateTar])
await runDsh(['plugin', '--profile', profile, 'add', '--offline', productTar])
await runDsh(['plugin', '--profile', profile, 'add', '--offline', overlayTar])
const dump = await runDsh(['--profile', profile, '--dump-config'])
const candidatePresent = dump.includes('xiaoshe-native-shell-candidate-v6')
const originalDisabled = /id:\s+xiaoshe-native-shell-legacy-adapted\b[\s\S]{0,180}disabled:\s+true/.test(dump)
const servicesPreserved = ['xiaoshe-runtime-dsh-provider', 'xiaoshe-completion-receipt', 'xiaoshe-heartbeat', 'xiaoshe-memory', 'xiaoshe-plugin-governance', 'xiaoshe-task-timeline', 'xiaoshe-verification-policy']
  .every(id => dump.includes(id))

progress('start installed candidate Profile')
const held = await startServer()
const probe = await probeServer(held.url)
const ready = candidatePresent && originalDisabled && servicesPreserved
  && probe.rootStatus === 200 && probe.candidateClientStatus === 200
  && probe.candidateBrandStatus === 200 && probe.heartbeatStatus === 200
if (!ready) {
  const exit = await stop(held.child)
  throw new Error(`candidate Profile probe failed: ${JSON.stringify({ candidatePresent, originalDisabled, servicesPreserved, probe, exit })}\n${held.output().slice(-4_000)}`)
}

if (serve) {
  process.stdout.write(`${JSON.stringify({
    status: 'READY', profile, url: held.url, dsh_home: dshHome,
    candidate_client_status: probe.candidateClientStatus,
    candidate_brand_status: probe.candidateBrandStatus,
    original_shell_disabled: originalDisabled,
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
  candidate_client_status: probe.candidateClientStatus,
  candidate_brand_status: probe.candidateBrandStatus,
  heartbeat_status: probe.heartbeatStatus,
  candidate_present: candidatePresent,
  original_shell_disabled: originalDisabled,
  product_services_preserved: servicesPreserved,
  process_exit_code: exit.code,
  process_exit_signal: exit.signal,
  baseline_status: baseline.status,
  sentinel_unchanged: baseline.sentinel_unchanged,
})}\n`)

async function probeServer(url) {
  const [rootResponse, candidateClientResponse, candidateBrandResponse, heartbeatResponse] = await Promise.all([
    fetch(url),
    fetch(`${url}${candidateClientPath}`),
    fetch(`${url}/api/xiaoshe/candidate-v6-brand-icon`),
    fetch(`${url}/api/xiaoshe/heartbeat`),
  ])
  return {
    rootStatus: rootResponse.status,
    candidateClientStatus: candidateClientResponse.status,
    candidateBrandStatus: candidateBrandResponse.status,
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
    throw new Error(`candidate server failed: ${error instanceof Error ? error.message : String(error)}\n${output.slice(-4_000)}`)
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

async function runNodeBuild(packageName, relativeScript) {
  const packageRoot = join(root, 'packages', packageName)
  return await run(process.execPath, [join(packageRoot, relativeScript)], packageRoot, sanitizedEnvironment())
}

async function runTypeScript(packageName, configName) {
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  return await run(process.execPath, [tsc, '-p', join(root, 'packages', packageName, configName)], root, sanitizedEnvironment())
}

async function packPackage(packageName) {
  const pnpmEntry = await resolvePnpmEntry()
  const packageRoot = join(root, 'packages', packageName)
  const stagingRoot = join(artifacts, '.candidate-pack-staging', packageName)
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })
  await cp(packageRoot, stagingRoot, { recursive: true, filter: source => !source.split(/[\\/]/).includes('node_modules') })
  try {
    const manifestPath = join(stagingRoot, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    delete manifest.devDependencies
    if (packageName === 'native-shell-candidate-v6-bundle') {
      manifest.dependencies['@xiaoshe/native-shell-candidate-v6'] = fileSpec(candidateTar)
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await run(process.execPath, [pnpmEntry, '--config.ignore-scripts=true', 'pack', '--pack-destination', artifacts], stagingRoot, sanitizedEnvironment())
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

async function resolvePnpmEntry() {
  const candidates = [
    process.env.XIAOSHE_PNPM_CLI,
    process.env.npm_execpath?.includes('pnpm') === true ? process.env.npm_execpath : undefined,
    join(homedir(), '.local', 'share', 'xiaoshe-handoff', 'pnpm-11.7.0', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0)
  for (const candidate of candidates) {
    try { await access(candidate); return candidate } catch { /* Try the next explicit path. */ }
  }
  throw new Error('pnpm JavaScript entry could not be resolved without a command shell')
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
  throw new Error(`baseline verifier did not emit JSON: ${output.slice(-2_000)}`)
}

function fileSpec(path) {
  return `file:${path.replaceAll('\\', '/')}`
}

function progress(message) {
  process.stderr.write(`[native-shell-candidate-v6-profile] ${message}\n`)
}
