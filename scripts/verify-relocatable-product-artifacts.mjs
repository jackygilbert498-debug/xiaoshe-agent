#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = join(root, 'runtime', 'DSH')
const legacyRoot = join(root, 'runtime', 'xiaoshe-legacy')
const output = parseOutput(process.argv.slice(2))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'xiaoshe-relocation-proof-'))
const generated = join(temporaryRoot, 'generated-device-a')
const relocated = join(temporaryRoot, 'relocated artifacts with spaces')
const unavailable = join(temporaryRoot, 'generated-device-a.unavailable')
const dshHome = join(temporaryRoot, 'target-dsh-home')
const profile = 'xiaoshe-relocated-proof'
const sentinel = join(dshHome, 'session-sentinel.json')
let server

try {
  await mkdir(dshHome, { recursive: true })
  await writeFile(sentinel, '{"value":"must-survive"}\n', { flag: 'wx' })
  const sentinelBefore = await sha256(sentinel)
  progress('generate Product artifacts in device A directory')
  await run(process.execPath, [join(root, 'scripts', 'build-relocatable-product-artifacts.mjs'), '--output', generated], root)
  await cp(generated, relocated, { recursive: true })
  await rename(generated, unavailable)
  const artifactLeaks = await scanArtifactLeaks(relocated, generated)
  if (artifactLeaks.length > 0) throw new Error(`relocated artifacts retained source paths: ${artifactLeaks.join(', ')}`)

  progress('install only from relocated device B directory')
  const installOutput = await run(process.execPath, [join(relocated, 'install.mjs'), '--dsh-root', dshRoot, '--dsh-home', dshHome, '--profile', profile], root)
  const install = lastJsonLine(installOutput)
  if (install.status !== 'PASS') throw new Error(`relocated installer did not pass: ${installOutput.slice(-2_000)}`)
  const profileDir = join(dshHome, 'profiles', profile)
  const profileLeaks = []
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    const value = await readFile(join(profileDir, name), 'utf8')
    if (referencesPath(value, generated)) profileLeaks.push(name)
  }
  if (profileLeaks.length > 0) throw new Error(`target Profile retained source paths: ${profileLeaks.join(', ')}`)

  progress('start and probe relocated Product Profile')
  server = startServer(dshHome, profile)
  const url = await server.ready
  const endpoints = [
    '/',
    '/plugins/@xiaoshe%2Fnative-shell-legacy-adapted/client.js',
    '/api/xiaoshe/heartbeat',
    '/api/xiaoshe/memory',
    '/api/xiaoshe/plugins/transactions',
    '/api/xiaoshe/legacy-adapted-brand-icon',
    '/api/xiaoshe/legacy-adapted-brand-raster',
    '/xiaoshe/desktop/status',
  ]
  const probes = {}
  for (const endpoint of endpoints) {
    const response = await fetch(`${url}${endpoint}`, { cache: 'no-store' })
    probes[endpoint] = response.status
    if (response.status !== 200) throw new Error(`relocated Profile endpoint ${endpoint} returned ${response.status}`)
    if (endpoint === '/xiaoshe/desktop/status') {
      const status = await response.json()
      if (status.product !== '小蛇' || status.bridge?.state !== 'ready') throw new Error('relocated desktop bridge is not ready')
    }
  }
  await stop(server.child)
  server = undefined
  const manifest = JSON.parse(await readFile(join(relocated, 'artifact-manifest.json'), 'utf8'))
  const result = {
    schema_version: 1,
    status: 'PASS',
    packages: manifest.packages.length,
    artifact_bytes: manifest.packages.reduce((total, row) => total + row.size, 0),
    source_directory_made_unavailable: true,
    artifact_source_path_leaks: artifactLeaks.length,
    profile_source_path_leaks: profileLeaks.length,
    target_local_override_count: (await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')).split('\n').filter(line => line.includes(portableFileSpec(String(install.artifact_root)))).length,
    endpoints: probes,
    sentinel_unchanged: sentinelBefore === await sha256(sentinel),
  }
  if (result.target_local_override_count !== manifest.packages.length || !result.sentinel_unchanged) throw new Error(`relocation acceptance did not close: ${JSON.stringify(result)}`)
  if (output !== undefined) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  if (server !== undefined) await stop(server.child)
  await rm(temporaryRoot, { recursive: true, force: true })
}

function startServer(dshHomeValue, profileValue) {
  const cli = join(dshRoot, 'apps', 'cli', 'lib', 'bin.js')
  const child = spawn(process.execPath, [cli, '--profile', profileValue, '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: dshRoot,
    env: { ...process.env, DSH_HOME: dshHomeValue, XIAOSHE_LEGACY_ROOT: legacyRoot, XIAOSHE_DESKTOP_ACTIONS: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += String(chunk) }); child.stderr.on('data', chunk => { logs += String(chunk) })
  const ready = new Promise((resolveReady, rejectReady) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(logs)
      if (match?.[1] !== undefined) { clearInterval(timer); resolveReady(match[1]); return }
      if (child.exitCode !== null) { clearInterval(timer); rejectReady(new Error(`relocated Profile exited before ready\n${logs.slice(-4_000)}`)); return }
      if (Date.now() - started > 60_000) { clearInterval(timer); rejectReady(new Error(`relocated Profile timed out\n${logs.slice(-4_000)}`)) }
    }, 50)
  })
  return { child, ready }
}

async function scanArtifactLeaks(directory, forbidden) {
  const leaks = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    if (name.endsWith('.tgz')) {
      const manifest = tarEntry(gunzipSync(await readFile(path)), 'package/package.json')
      if (referencesPath(manifest, forbidden) || manifest.includes('workspace:')) leaks.push(name)
      continue
    }
    const value = await readFile(path, 'utf8')
    if (referencesPath(value, forbidden)) leaks.push(name)
  }
  return leaks
}

function tarEntry(buffer, wanted) {
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = cString(header.subarray(0, 100))
    const prefix = cString(header.subarray(345, 500))
    const path = prefix === '' ? name : `${prefix}/${name}`
    const size = Number.parseInt(cString(header.subarray(124, 136)).trim() || '0', 8)
    const body = offset + 512
    if (path === wanted) return buffer.subarray(body, body + size).toString('utf8')
    offset = body + Math.ceil(size / 512) * 512
  }
  throw new Error(`tar entry not found: ${wanted}`)
}

function cString(buffer) { const end = buffer.indexOf(0); return buffer.subarray(0, end < 0 ? buffer.length : end).toString('utf8') }
function referencesPath(value, path) {
  return [path, path.replaceAll('\\', '/'), pathToFileURL(path).href, portableFileSpec(path)].some(candidate => value.includes(candidate))
}
function portableFileSpec(path) { return `file:${resolve(path).replaceAll('\\', '/')}` }
async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex') }
async function stop(child) { if (child.exitCode !== null) return; child.kill('SIGTERM'); await new Promise(resolveExit => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit() }, 5_000); child.once('exit', () => { clearTimeout(timer); resolveExit() }) }) }
async function run(command, args, cwd) { const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) }); const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) }); if (code !== 0) throw new Error(`${command} exited ${String(code)}\n${stderr.slice(-4_000)}\n${stdout.slice(-4_000)}`); return stdout }
function lastJsonLine(output) { for (const line of output.trim().split(/\r?\n/u).reverse()) { try { return JSON.parse(line) } catch { /* Continue. */ } } throw new Error('command emitted no JSON result') }
function parseOutput(values) { if (values.length === 0) return undefined; if (values.length !== 2 || values[0] !== '--output') throw new Error('usage: verify-relocatable-product-artifacts.mjs [--output <report.json>]'); return resolve(values[1]) }
function progress(message) { process.stderr.write(`[relocation-proof] ${message}\n`) }
