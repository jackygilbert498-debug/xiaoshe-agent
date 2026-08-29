import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rewriteWorkspaceDependencies } from './lib/relocatable-product-artifacts.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = join(root, 'runtime', 'DSH')
const cli = join(dshRoot, 'apps', 'cli', 'src', 'bin.ts')
const profile = 'xiaoshe-native-shell-proof'
const args = process.argv.slice(2)
const serve = args.includes('--serve')
const homeIndex = args.indexOf('--dsh-home')
if (homeIndex < 0 || args[homeIndex + 1] === undefined) throw new Error('--dsh-home <absolute-path> is required')
const dshHome = resolve(args[homeIndex + 1])
const artifacts = join(dshHome, 'artifacts')
const nativeTar = join(artifacts, 'xiaoshe-native-shell-legacy-adapted-0.1.0.tgz')
const providerTar = join(artifacts, 'xiaoshe-runtime-dsh-provider-0.1.0.tgz')
const productTar = join(artifacts, 'xiaoshe-product-bundle-0.1.0.tgz')
const receiptTar = join(artifacts, 'xiaoshe-completion-receipt-0.1.0.tgz')
const contractTar = join(artifacts, 'xiaoshe-runtime-contract-0.1.0.tgz')
const heartbeatTar = join(artifacts, 'xiaoshe-heartbeat-0.1.0.tgz')
const verificationTar = join(artifacts, 'xiaoshe-verification-policy-0.1.0.tgz')
const governanceTar = join(artifacts, 'xiaoshe-plugin-governance-0.1.0.tgz')
const timelineTar = join(artifacts, 'xiaoshe-task-timeline-0.1.0.tgz')
const memoryTar = join(artifacts, 'xiaoshe-memory-0.1.0.tgz')
const sessionContinuityTar = join(artifacts, 'deepseek-ai-dsh-tool-session-query-0.1.0-rc.8.tgz')
const sessionContinuitySource = join(dshRoot, 'packages', 'session-query', 'tool-session-query')
const profileDir = join(dshHome, 'profiles', profile)
const sentinelPath = join(dshHome, 'session-sentinel.json')
const sessionIndexPath = join(dshHome, 'session-query.sqlite')
const sessionContinuityInspectionPatch = join(dshHome, 'inspect-session-continuity.patch.yml')
const sessionContinuityInspector = join(root, 'scripts', 'inspect-session-continuity-plugin.mjs')
const clientPath = '/plugins/@xiaoshe%2Fnative-shell-legacy-adapted/client.js'
const providerPath = '/plugins/@xiaoshe%2Fruntime-dsh-provider/client.js'
const governancePath = '/plugins/@xiaoshe%2Fplugin-governance/client.js'
const memoryClientPath = '/plugins/@xiaoshe%2Fmemory/client.js'
const baseEnv = sanitizedEnvironment({ DSH_HOME: dshHome })

await mkdir(artifacts, { recursive: true })
await writeFile(sentinelPath, '{"value":"must-survive"}\n', { flag: 'wx' })
await writeFile(sessionContinuityInspectionPatch, [
  '- insert:',
  '    - id: xiaoshe-session-continuity-inspector',
  `      name: '${yamlQuote(pathToFileURL(sessionContinuityInspector).href)}'`,
  '',
].join('\n'), { flag: 'wx' })
const sentinelBefore = await digest(sentinelPath)

progress('build legacy-adapted native shell')
await runNodeBuild('native-shell-legacy-adapted', 'scripts/build-client.mjs')
await runTypeScript('native-shell-legacy-adapted', 'tsconfig.build.json')
progress('build product bundle')
await runTypeScript('product-bundle', 'tsconfig.json')
progress('build verification policy')
await runTypeScript('verification-policy', 'tsconfig.json')
progress('build completion receipt')
await runTypeScript('completion-receipt', 'tsconfig.json')
progress('build runtime contract')
await runTypeScript('runtime-contract', 'tsconfig.json')
progress('build heartbeat')
await runTypeScript('heartbeat', 'tsconfig.json')
progress('build memory')
await runNodeBuild('memory', 'scripts/build-client.mjs')
await runTypeScript('memory', 'tsconfig.build.json')
progress('build plugin governance')
await runNodeBuild('plugin-governance', 'scripts/build-client.mjs')
await runTypeScript('plugin-governance', 'tsconfig.build.json')
progress('build task timeline')
await runTypeScript('task-timeline', 'tsconfig.json')
progress('build DSH runtime provider')
await runNodeBuild('runtime-dsh-provider', 'scripts/build-client.mjs')
await runTypeScript('runtime-dsh-provider', 'tsconfig.build.json')
progress('pack verification policy')
await packPackage('verification-policy')
progress('pack legacy-adapted native shell')
await packPackage('native-shell-legacy-adapted')
progress('pack memory')
await packPackage('memory')
progress('pack plugin governance')
await packPackage('plugin-governance')
progress('pack task timeline')
await packPackage('task-timeline')
progress('pack DSH runtime provider')
await packPackage('runtime-dsh-provider')
progress('pack completion receipt')
await packPackage('completion-receipt')
progress('pack runtime contract')
await packPackage('runtime-contract')
progress('pack heartbeat')
await packPackage('heartbeat')
progress('pack DSH session continuity tool')
await packSessionContinuityPlugin()
progress('pack product bundle')
await packPackage('product-bundle')
await Promise.all([access(nativeTar), access(providerTar), access(productTar), access(receiptTar), access(contractTar), access(heartbeatTar), access(verificationTar), access(governanceTar), access(timelineTar), access(memoryTar), access(sessionContinuityTar)])

const webBundle = `link:${join(dshRoot, 'packages', 'bundle', 'web-app')}`
progress('initialize profile with the generic DSH web substrate')
await runDsh(['plugin', '--profile', profile, 'add', '--offline', webBundle])
const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
const workspace = await readFile(workspacePath, 'utf8')
await writeFile(workspacePath, `${workspace.trimEnd()}\n\n# Local unpublished package resolution used only by this isolated proof.\noverrides:\n  '@xiaoshe/native-shell-legacy-adapted': '${fileSpec(nativeTar)}'\n  '@xiaoshe/runtime-dsh-provider': '${fileSpec(providerTar)}'\n  '@xiaoshe/completion-receipt': '${fileSpec(receiptTar)}'\n  '@xiaoshe/runtime-contract': '${fileSpec(contractTar)}'\n  '@xiaoshe/heartbeat': '${fileSpec(heartbeatTar)}'\n  '@xiaoshe/verification-policy': '${fileSpec(verificationTar)}'\n  '@xiaoshe/memory': '${fileSpec(memoryTar)}'\n  '@xiaoshe/plugin-governance': '${fileSpec(governanceTar)}'\n  '@xiaoshe/task-timeline': '${fileSpec(timelineTar)}'\n  '@deepseek-ai/dsh-tool-session-query': '${fileSpec(sessionContinuityTar)}'\n  '@deepseek-ai/schemastery': '${linkSpec(join(dshRoot, 'vendor', 'schemastery'))}'\n`)
// Keep every unpublished Product child as an exact direct dependency. The
// managed-Profile bootstrapper can replay these locked specs through the DSH
// CLI without copying this proof-only overrides file or any node_modules tree.
progress('add exact Product child dependencies')
await runDsh(['plugin', '--profile', profile, 'add', '--offline', verificationTar])
await runDsh(['plugin', '--profile', profile, 'add', '--offline', nativeTar, providerTar, receiptTar, contractTar, heartbeatTar, memoryTar, governanceTar, timelineTar])
progress('add exact session continuity dependency')
await runDsh(['plugin', '--profile', profile, 'add', '--offline', sessionContinuityTar])
progress('add product bundle')
await runDsh(['plugin', '--profile', profile, 'add', '--offline', productTar])

progress('dump and start installed profile')
const installedDump = await runDsh(['--profile', profile, '--dump-config'])
if (serve) {
  const held = await startServer()
  process.stdout.write(`${JSON.stringify({ status: 'READY', profile, url: held.url, dsh_home: dshHome })}\n`)
  await waitForShutdownSignal()
  await stop(held.child)
  process.exit(0)
}
const sessionIndexAbsentBeforeStart = !(await exists(sessionIndexPath))
const installedProbe = await probeServer({ exerciseHeartbeat: true, inspectSessionContinuity: true })
const sessionIndexAbsentAfterInstalledStart = !(await exists(sessionIndexPath))
progress('remove product bundle')
await runDsh(['plugin', '--profile', profile, 'remove', '@xiaoshe/product-bundle'])
progress('dump and restart removed profile')
const removedDump = await runDsh(['--profile', profile, '--dump-config'])
const removedProbe = await probeServer()
const sessionIndexAbsentAfterRemoval = !(await exists(sessionIndexPath))
const sentinelAfter = await digest(sentinelPath)

const productRoster = ['xiaoshe-native-shell-legacy-adapted', 'xiaoshe-runtime-dsh-provider', 'xiaoshe-completion-receipt', 'xiaoshe-heartbeat', 'xiaoshe-verification-policy', 'xiaoshe-memory', 'xiaoshe-plugin-governance', 'xiaoshe-task-timeline', 'xiaoshe-session-continuity']
const installedRosterOk = productRoster
  .every(name => installedDump.includes(name))
const productRowsDisabled = /id:\s+ui-conversation[\s\S]{0,160}disabled:\s+true/.test(installedDump)
const installedSessionQueryOk = /id:\s+session-query-sqlite[\s\S]{0,500}session-query\.sqlite[\s\S]{0,200}openAt:\s+first-search/u.test(installedDump)
  && /id:\s+xiaoshe-session-continuity[\s\S]{0,300}name:\s+['"]?@deepseek-ai\/dsh-tool-session-query['"]?[\s\S]{0,300}maxSearchResults:\s+20[\s\S]{0,200}searchTimeoutMs:\s+30000/u.test(installedDump)
const removedRosterOk = productRoster
  .every(name => !removedDump.includes(name))
const removedSessionQueryDefaultsRestored = /id:\s+session-query-sqlite[\s\S]{0,500}path:\s+['"]?:memory:['"]?[\s\S]{0,200}openAt:\s+never/u.test(removedDump)
const stoppedCleanly = probe => (probe.exit.code === 0 || probe.exit.signal === 'SIGTERM')
  && (probe.restartExit === undefined || probe.restartExit.code === 0 || probe.restartExit.signal === 'SIGTERM')

process.stdout.write(`${JSON.stringify({
  status: installedProbe.rootStatus === 200 && installedProbe.clientStatus === 200
    && installedProbe.providerStatus === 200
    && installedProbe.governanceStatus === 200 && installedProbe.heartbeatStatus === 200
    && installedProbe.brandStatus === 200 && installedProbe.rasterStatus === 200
    && installedProbe.memoryClientStatus === 200 && installedProbe.memoryApiStatus === 200
    && installedProbe.heartbeatTransitions?.join(',') === 'idle,running,healthy'
    && installedProbe.heartbeatRestart?.status === 'healthy' && installedProbe.heartbeatRestart?.running === false
    && installedProbe.sessionContinuityTools === true && installedProbe.restartSessionContinuityTools === true
    && removedProbe.rootStatus === 200 && removedProbe.clientStatus === 404 && removedProbe.providerStatus === 404
    && removedProbe.governanceStatus === 404 && removedProbe.heartbeatStatus === 404
    && removedProbe.brandStatus === 404 && removedProbe.rasterStatus === 404
    && removedProbe.memoryClientStatus === 404 && removedProbe.memoryApiStatus === 404
    && installedRosterOk && productRowsDisabled && installedSessionQueryOk && removedRosterOk
    && removedSessionQueryDefaultsRestored
    && sessionIndexAbsentBeforeStart && sessionIndexAbsentAfterInstalledStart && sessionIndexAbsentAfterRemoval
    && stoppedCleanly(installedProbe) && stoppedCleanly(removedProbe)
    && sentinelBefore === sentinelAfter ? 'PASS' : 'FAIL',
  profile,
  installed: {
    root_status: installedProbe.rootStatus,
    client_status: installedProbe.clientStatus,
    provider_status: installedProbe.providerStatus,
    governance_status: installedProbe.governanceStatus,
    heartbeat_status: installedProbe.heartbeatStatus,
    brand_status: installedProbe.brandStatus,
    raster_status: installedProbe.rasterStatus,
    memory_client_status: installedProbe.memoryClientStatus,
    memory_api_status: installedProbe.memoryApiStatus,
    roster_contains_adapted: installedDump.includes('xiaoshe-native-shell-legacy-adapted'),
    roster_contains_provider: installedDump.includes('xiaoshe-runtime-dsh-provider'),
    roster_contains_completion_receipt: installedDump.includes('xiaoshe-completion-receipt'),
    roster_contains_verification_policy: installedDump.includes('xiaoshe-verification-policy'),
    roster_contains_heartbeat: installedDump.includes('xiaoshe-heartbeat'),
    roster_contains_plugin_governance: installedDump.includes('xiaoshe-plugin-governance'),
    roster_contains_task_timeline: installedDump.includes('xiaoshe-task-timeline'),
    roster_contains_memory: installedDump.includes('xiaoshe-memory'),
    roster_contains_session_continuity: installedDump.includes('xiaoshe-session-continuity'),
    session_query_configured: installedSessionQueryOk,
    session_tools_registered: installedProbe.sessionContinuityTools,
    session_tools_registered_after_restart: installedProbe.restartSessionContinuityTools,
    session_index_absent_before_start: sessionIndexAbsentBeforeStart,
    session_index_absent_after_schema_probe: sessionIndexAbsentAfterInstalledStart,
    dsh_product_surfaces_disabled: productRowsDisabled,
    heartbeat_transitions: installedProbe.heartbeatTransitions,
    heartbeat_restart_status: installedProbe.heartbeatRestart?.status,
    heartbeat_recovered_without_active_lease: installedProbe.heartbeatRestart?.running === false,
    process_exit_code: installedProbe.exit.code,
    process_exit_signal: installedProbe.exit.signal,
  },
  removed: {
    root_status: removedProbe.rootStatus,
    client_status: removedProbe.clientStatus,
    provider_status: removedProbe.providerStatus,
    governance_status: removedProbe.governanceStatus,
    heartbeat_status: removedProbe.heartbeatStatus,
    brand_status: removedProbe.brandStatus,
    raster_status: removedProbe.rasterStatus,
    memory_client_status: removedProbe.memoryClientStatus,
    memory_api_status: removedProbe.memoryApiStatus,
    roster_contains_adapted: removedDump.includes('xiaoshe-native-shell-legacy-adapted'),
    roster_contains_provider: removedDump.includes('xiaoshe-runtime-dsh-provider'),
    roster_contains_completion_receipt: removedDump.includes('xiaoshe-completion-receipt'),
    roster_contains_verification_policy: removedDump.includes('xiaoshe-verification-policy'),
    roster_contains_heartbeat: removedDump.includes('xiaoshe-heartbeat'),
    roster_contains_plugin_governance: removedDump.includes('xiaoshe-plugin-governance'),
    roster_contains_task_timeline: removedDump.includes('xiaoshe-task-timeline'),
    roster_contains_memory: removedDump.includes('xiaoshe-memory'),
    roster_contains_session_continuity: removedDump.includes('xiaoshe-session-continuity'),
    session_query_defaults_restored: removedSessionQueryDefaultsRestored,
    session_index_absent: sessionIndexAbsentAfterRemoval,
    process_exit_code: removedProbe.exit.code,
    process_exit_signal: removedProbe.exit.signal,
  },
  sentinel_sha256: sentinelAfter,
  sentinel_unchanged: sentinelBefore === sentinelAfter,
})}\n`)

async function probeServer({ exerciseHeartbeat = false, inspectSessionContinuity = false } = {}) {
  const held = await startServer({ inspectSessionContinuity })
  const { child, url } = held
  let restarted
  try {
    const [rootResponse, clientResponse, providerResponse, governanceResponse, heartbeatResponse, brandResponse, rasterResponse, memoryClientResponse, memoryApiResponse] = await Promise.all([
      fetch(url), fetch(`${url}${clientPath}`), fetch(`${url}${providerPath}`), fetch(`${url}${governancePath}`), fetch(`${url}/api/xiaoshe/heartbeat`), fetch(`${url}/api/xiaoshe/legacy-adapted-brand-icon`), fetch(`${url}/api/xiaoshe/legacy-adapted-brand-raster`), fetch(`${url}${memoryClientPath}`), fetch(`${url}/api/xiaoshe/memory`),
    ])
    const result = {
      rootStatus: rootResponse.status,
      clientStatus: clientResponse.status,
      providerStatus: providerResponse.status,
      governanceStatus: governanceResponse.status,
      heartbeatStatus: heartbeatResponse.status,
      brandStatus: brandResponse.status,
      rasterStatus: rasterResponse.status,
      memoryClientStatus: memoryClientResponse.status,
      memoryApiStatus: memoryApiResponse.status,
    }
    if (!exerciseHeartbeat) {
      const exit = await stop(child)
      return {
        ...result,
        sessionContinuityTools: held.output().includes('[xiaoshe-session-continuity] tools='),
        exit,
      }
    }

    const idle = await waitForHeartbeat(url, value => value.status === 'idle'
      && value.checks?.some(check => check.id === 'xiaoshe-product-runtime'), 'registered idle check')
    const runResponse = await fetch(`${url}/api/xiaoshe/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'run_now', id: 'xiaoshe-product-runtime' }),
    })
    if (runResponse.status !== 202) throw new Error(`heartbeat run_now returned ${runResponse.status}: ${(await runResponse.text()).slice(0, 1_000)}`)
    const running = await waitForHeartbeat(url, value => value.status === 'running' && value.running === true, 'running check')
    const healthy = await waitForHeartbeat(url, value => value.status === 'healthy'
      && value.checks?.some(check => check.id === 'xiaoshe-product-runtime' && check.lastSuccessAt !== undefined), 'healthy check')
    const exit = await stop(child)
    const sessionContinuityTools = held.output().includes('[xiaoshe-session-continuity] tools=')

    restarted = await startServer({ inspectSessionContinuity })
    const heartbeatRestart = await waitForHeartbeat(restarted.url, value => value.status === 'healthy'
      && value.running === false && value.checks?.some(check => check.id === 'xiaoshe-product-runtime'), 'persisted healthy check after restart')
    const restartExit = await stop(restarted.child)
    const restartSessionContinuityTools = restarted.output().includes('[xiaoshe-session-continuity] tools=')
    return {
      ...result,
      heartbeatTransitions: [idle.status, running.status, healthy.status],
      heartbeatRestart,
      sessionContinuityTools,
      restartSessionContinuityTools,
      exit,
      restartExit,
    }
  } catch (error) {
    await stop(child)
    if (restarted !== undefined) await stop(restarted.child)
    const restartOutput = restarted === undefined ? '' : `\n${restarted.output().slice(-4_000)}`
    throw new Error(`DSH profile probe failed: ${error instanceof Error ? error.message : String(error)}\n${held.output().slice(-4_000)}${restartOutput}`)
  }
}

async function waitForHeartbeat(url, predicate, label) {
  const deadline = Date.now() + 10_000
  let latest
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/xiaoshe/heartbeat`, { cache: 'no-store' })
    if (response.status === 200) {
      latest = await response.json()
      if (predicate(latest)) return latest
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 5))
  }
  throw new Error(`heartbeat did not reach ${label} within 10 seconds; latest=${JSON.stringify(latest)}`)
}

async function startServer({ inspectSessionContinuity = false } = {}) {
  const launcherArgs = ['--import', 'tsx/esm', cli, '--profile', profile]
  if (inspectSessionContinuity) launcherArgs.push('--patch', sessionContinuityInspectionPatch)
  launcherArgs.push('--no-open', '--port', '0')
  const child = spawn(process.execPath, launcherArgs, {
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
    const [url] = await Promise.all([
      waitForUrl(child, () => output),
      inspectSessionContinuity
        ? waitForSessionContinuityTools(child, () => output)
        : Promise.resolve(),
    ])
    return { child, url, output: () => output }
  } catch (error) {
    await stop(child)
    throw new Error(`DSH profile probe failed: ${error instanceof Error ? error.message : String(error)}\n${output.slice(-4_000)}`)
  }
}

async function waitForSessionContinuityTools(child, output) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const current = output()
    if (current.includes('[xiaoshe-session-continuity] tools=')) return
    const failure = /\[xiaoshe-session-continuity\] error=([^\r\n]+)/u.exec(current)
    if (failure?.[1] !== undefined) throw new Error(`session continuity inspector failed: ${failure[1]}`)
    if (child.exitCode !== null) throw new Error(`server exited before registering session continuity tools (${String(child.exitCode)})`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error('session continuity tools were not registered within 60 seconds')
}

async function waitForShutdownSignal() {
  return await new Promise(resolveSignal => {
    process.once('SIGINT', resolveSignal)
    process.once('SIGTERM', resolveSignal)
  })
}

async function waitForUrl(child, output) {
  // 全套 Vitest 并行时，首次 DSH/tsx 冷启动在 Windows 上可能超过 30 秒。
  // 仍保留有界等待，且子进程一旦提前退出就立即失败。
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
  let exit
  if (child.exitCode !== null) {
    exit = { code: child.exitCode, signal: null }
  } else {
    child.kill()
    exit = await new Promise(resolveExit => {
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
  await removeOwnedSettingsLock(child.pid)
  return exit
}

/**
 * Windows may terminate the verifier-owned server while it holds DSH's
 * cross-process writer lock. Only reclaim a lock whose recorded owner is the
 * child we just observed exiting; a lock owned by any other process remains
 * authoritative and is never guessed stale.
 */
async function removeOwnedSettingsLock(childPid) {
  if (childPid === undefined) return
  const lockPath = join(dshHome, 'settings.yaml.lock')
  let owner
  try {
    owner = (await readFile(lockPath, 'utf8')).trim()
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (owner !== String(childPid)) return
  await rm(lockPath, { force: true })
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
  const stagingRoot = join(artifacts, '.pack-staging', packageName)
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })
  await cp(packageRoot, stagingRoot, {
    recursive: true,
    filter: source => !source.split(/[\\/]/).includes('node_modules'),
  })
  try {
    const manifestPath = join(stagingRoot, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    // Development-only workspace edges are neither installed from a tarball
    // nor part of the runtime closure; omitting them avoids asking the packer
    // to resolve source-workspace tooling in this isolated copy.
    delete manifest.devDependencies
    for (const field of ['dependencies', 'optionalDependencies']) {
      if (manifest[field] === undefined) continue
      for (const [dependency, spec] of Object.entries(manifest[field])) {
        if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
        const artifact = workspaceArtifact(dependency)
        manifest[field][dependency] = fileSpec(artifact)
      }
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return await run(process.execPath, [pnpmEntry, '--config.ignore-scripts=true', 'pack', '--pack-destination', artifacts], stagingRoot, sanitizedEnvironment())
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

async function packSessionContinuityPlugin() {
  const pnpmEntry = await resolvePnpmEntry()
  const stagingRoot = join(artifacts, '.pack-staging', 'deepseek-ai__dsh-tool-session-query')
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })
  await cp(sessionContinuitySource, stagingRoot, {
    recursive: true,
    filter: source => !source.split(/[\\/]/u).includes('node_modules'),
  })
  try {
    const manifestPath = join(stagingRoot, 'package.json')
    const manifest = rewriteWorkspaceDependencies(JSON.parse(await readFile(manifestPath, 'utf8')))
    delete manifest.devDependencies
    delete manifest.scripts
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    if (!(await exists(join(stagingRoot, 'LICENSE')))) {
      await cp(join(dshRoot, 'LICENSE'), join(stagingRoot, 'LICENSE'))
    }
    return await run(process.execPath, [pnpmEntry, '--config.ignore-scripts=true', 'pack', '--pack-destination', artifacts], stagingRoot, sanitizedEnvironment())
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

function workspaceArtifact(packageName) {
  const names = {
    '@xiaoshe/native-shell-legacy-adapted': nativeTar,
    '@xiaoshe/runtime-dsh-provider': providerTar,
    '@xiaoshe/completion-receipt': receiptTar,
    '@xiaoshe/runtime-contract': contractTar,
    '@xiaoshe/heartbeat': heartbeatTar,
    '@xiaoshe/verification-policy': verificationTar,
    '@xiaoshe/memory': memoryTar,
    '@xiaoshe/plugin-governance': governanceTar,
    '@xiaoshe/task-timeline': timelineTar,
  }
  const artifact = names[packageName]
  if (artifact === undefined) throw new Error(`no exact offline artifact is declared for workspace dependency ${packageName}`)
  return artifact
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
  if (code !== 0) throw new Error(`${command} exited ${String(code)}\n${stderr.slice(-4_000)}\n${stdout.slice(-4_000)}`)
  return stdout
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
    try {
      await access(candidate)
      return candidate
    } catch { /* Try the next explicit installation path. */ }
  }
  throw new Error('pnpm JavaScript entry could not be resolved without invoking a command shell')
}

function sanitizedEnvironment(extra = {}) {
  const allowed = ['APPDATA', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']
  return Object.fromEntries([
    ...allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
    ['CI', '1'],
    ...Object.entries(extra),
  ])
}

function fileSpec(path) {
  return `file:${path.replaceAll('\\', '/')}`
}

function linkSpec(path) {
  return `link:${resolve(path).replaceAll('\\', '/')}`
}

function yamlQuote(value) {
  return value.replaceAll("'", "''")
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function progress(message) {
  process.stderr.write(`[native-shell-profile] ${message}\n`)
}
