import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const SCHEMA = 'xiaoshe-installed-profile-smoke/v1'
const HOST = '127.0.0.1'
const DEFAULT_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 2_000
const PACKAGE_METADATA = /^(?:changelog|history|license|notice|readme)(?:\..*)?$/iu

function parseArguments(arguments_) {
  const values = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (!key?.startsWith('--') || value === undefined || values.has(key.slice(2))) {
      throw new Error('invalid installed Profile smoke arguments')
    }
    values.set(key.slice(2), value)
  }
  return values
}

function required(values, name) {
  const value = values.get(name)?.trim()
  if (!value) throw new Error(`missing --${name}`)
  return value
}

function timeout(values) {
  const raw = values.get('timeout-ms') ?? String(DEFAULT_TIMEOUT_MS)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 100 || value > 120_000) throw new Error('invalid --timeout-ms')
  return value
}

async function freeLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, HOST, resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : undefined
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error('failed to reserve an installed Profile smoke port')
  return port
}

function boundedLog(previous, chunk) {
  return `${previous}${String(chunk)}`.slice(-4_000)
}

function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolveExit => {
    const timer = setTimeout(() => {
      child.off('exit', exited)
      resolveExit(false)
    }, milliseconds)
    const exited = () => {
      clearTimeout(timer)
      resolveExit(true)
    }
    child.once('exit', exited)
  })
}

async function stopOwnedProcess(child) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return
  if (await waitForExit(child, 0)) return
  child.kill('SIGTERM')
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return
  child.kill('SIGKILL')
  if (!await waitForExit(child, STOP_TIMEOUT_MS)) {
    throw new Error(`installed Profile smoke process ${child.pid} did not exit after forced termination`)
  }
}

async function waitForHealth(child, url, timeoutMs, diagnostics, childFailure) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const spawnError = childFailure()
    if (spawnError !== undefined) throw spawnError
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`installed Profile smoke process exited before health was ready: ${diagnostics()}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(500, Math.max(1, deadline - Date.now()))) })
      const health = response.ok ? await response.json() : null
      if (health?.product === '小蛇' && health?.bridge?.state === 'ready') return health
    } catch {
      // A connection refusal is expected until the local Host binds the port.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(50, Math.max(1, deadline - Date.now()))))
  }
  const spawnError = childFailure()
  if (spawnError !== undefined) throw spawnError
  throw new Error(`installed Profile was not ready before timeout at ${url}: ${diagnostics()}`)
}

function isInside(root, candidate) {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep)
}

function staticPayloadRoot(value) {
  if (typeof value !== 'string' || value.startsWith('!')) return null
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (!normalized || normalized === '.' || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)) return ''
  if (normalized.split('/').includes('..')) throw new Error('unsafe package files entry: ' + value)
  const wildcardIndexes = ['*', '?', '[', ']', '{', '}', '(', ')']
    .map(character => normalized.indexOf(character))
    .filter(index => index >= 0)
  const wildcardIndex = wildcardIndexes.length > 0 ? Math.min(...wildcardIndexes) : -1
  if (wildcardIndex < 0) return normalized
  return normalized.slice(0, wildcardIndex).replace(/\/+$/u, '')
}

function collapsePayloadRoots(roots) {
  const ordered = [...new Set(roots)]
    .filter(Boolean)
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
  const result = []
  for (const root of ordered) {
    if (!result.some(parent => root === parent || root.startsWith(parent + '/'))) result.push(root)
  }
  return result
}

async function independentCopy(source, destination, boundary, followedLinks = new Set()) {
  const metadata = await lstat(source)
  if (metadata.isSymbolicLink()) {
    const target = await realpath(source)
    const canonicalTarget = resolve(target)
    if (!isInside(boundary, canonicalTarget)) {
      throw new Error('Profile dependency link escaped outside package boundary: ' + source)
    }
    if (followedLinks.has(canonicalTarget)) throw new Error('cyclic Profile dependency link: ' + source)
    const nextLinks = new Set(followedLinks)
    nextLinks.add(canonicalTarget)
    await independentCopy(target, destination, boundary, nextLinks)
    return
  }
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true })
    const entries = await readdir(source)
    entries.sort((left, right) => left.localeCompare(right))
    for (const entry of entries) {
      await independentCopy(join(source, entry), join(destination, entry), boundary, followedLinks)
    }
    return
  }
  if (!metadata.isFile()) throw new Error('unsupported Profile dependency entry: ' + source)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination, fsConstants.COPYFILE_FICLONE)
  await chmod(destination, metadata.mode & 0o777)
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function portablePackageRoots(packageRoot) {
  const packagePath = join(packageRoot, 'package.json')
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return (await readdir(packageRoot)).filter(name => name !== 'node_modules' && name !== '.git')
  }
  const referenced = [
    manifest.main,
    manifest.module,
    manifest.types,
    manifest.typings,
    manifest.style,
    ...(typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {})),
    ...manifestLocalReferences(manifest.browser),
    ...manifestLocalReferences(manifest.exports),
    manifest.dsh?.bundle?.patch,
  ]
  const declared = [...manifest.files, ...referenced].map(staticPayloadRoot)
  if (declared.includes('')) {
    return (await readdir(packageRoot)).filter(name => name !== 'node_modules' && name !== '.git')
  }
  const metadata = (await readdir(packageRoot)).filter(name => PACKAGE_METADATA.test(name))
  return collapsePayloadRoots(['package.json', ...metadata, ...declared])
}

function manifestLocalReferences(value) {
  if (typeof value === 'string') return value.startsWith('.') ? [value] : []
  if (Array.isArray(value)) return value.flatMap(manifestLocalReferences)
  if (value && typeof value === 'object') return Object.values(value).flatMap(manifestLocalReferences)
  return []
}

async function copyPortablePackage(packageRoot, destination) {
  const roots = await portablePackageRoots(packageRoot)
  for (const root of roots) {
    const source = resolve(packageRoot, root)
    if (!isInside(packageRoot, source)) throw new Error('package payload escaped its root: ' + root)
    if (!await pathExists(source)) continue
    await independentCopy(source, join(destination, ...root.split('/')), packageRoot)
  }
}

async function hasPackageManifest(path) {
  try {
    return (await stat(join(path, 'package.json'))).isFile()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function copyInstalledPackage(source, destination) {
  const metadata = await lstat(source)
  if (!metadata.isSymbolicLink()) {
    await independentCopy(source, destination, source)
    return
  }
  const target = await realpath(source)
  if (await hasPackageManifest(target)) {
    await copyPortablePackage(target, destination)
    return
  }
  await independentCopy(target, destination, target)
}

async function materializeInstalledModules(sourceModules, destinationModules) {
  await mkdir(destinationModules, { recursive: true })
  const entries = await readdir(sourceModules)
  entries.sort((left, right) => left.localeCompare(right))
  for (const entry of entries) {
    const source = join(sourceModules, entry)
    const destination = join(destinationModules, entry)
    const metadata = await lstat(source)
    if (entry.startsWith('@') && metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await mkdir(destination, { recursive: true })
      const packages = await readdir(source)
      packages.sort((left, right) => left.localeCompare(right))
      for (const packageName of packages) {
        await copyInstalledPackage(join(source, packageName), join(destination, packageName))
      }
      continue
    }
    if (entry.startsWith('.')) await independentCopy(source, destination, sourceModules)
    else await copyInstalledPackage(source, destination)
  }
}

/**
 * Materialize the installed Profile into a disposable DSH_HOME. Workspace and
 * package-manager links are copied as independent package payloads so plugin
 * startup cannot write through into the user's installed dependency tree.
 */
async function createIsolatedProfile(sourceProfileRoot) {
  const sourceModules = join(sourceProfileRoot, 'node_modules')
  // app-boot regenerates this module-link cache; copying it would preserve
  // links back into the source installation instead of independent payloads.
  const sourceFallback = join(sourceProfileRoot, '.dsh-module-fallback')
  if (!(await stat(sourceProfileRoot)).isDirectory()) {
    throw new Error(`installed Profile root is not a directory: ${sourceProfileRoot}`)
  }
  if (!(await stat(sourceModules)).isDirectory()) {
    throw new Error(`installed Profile dependencies are missing: ${sourceModules}`)
  }

  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-installed-profile-runtime-'))
  const dshHome = join(root, 'dsh-home')
  const profileRoot = join(dshHome, 'profiles', 'web')
  try {
    await mkdir(join(dshHome, 'profiles'), { recursive: true })
    await cp(sourceProfileRoot, profileRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: source => resolve(source) !== resolve(sourceModules) && resolve(source) !== resolve(sourceFallback),
    })
    await materializeInstalledModules(sourceModules, join(profileRoot, 'node_modules'))
    return { root, dshHome }
  } catch (error) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'installed Profile materialization and temporary cleanup failed',
      )
    }
    throw error
  }
}

const values = parseArguments(process.argv.slice(2))
const dshRoot = resolve(required(values, 'dsh-root'))
const sourceProfileRoot = resolve(required(values, 'profile-root'))
const timeoutMs = timeout(values)
const entry = join(dshRoot, 'apps', 'cli', 'lib', 'bin.js')
if (!(await stat(entry)).isFile()) throw new Error(`installed DSH entry is missing: ${entry}`)
let isolated
let port
let child
let health
let failure
let spawnFailure
try {
  isolated = await createIsolatedProfile(sourceProfileRoot)
  port = await freeLoopbackPort()
  const statusUrl = `http://${HOST}:${port}/xiaoshe/desktop/status`
  child = spawn(process.execPath, [entry, 'web', '--no-open', '--host', HOST, '--port', String(port)], {
    cwd: dshRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_HOME: isolated.dshHome,
      XIAOSHE_DSH_HOST: HOST,
      XIAOSHE_DSH_PORT: String(port),
      XIAOSHE_DSH_NO_OPEN: '1',
    },
  })
  child.once('error', error => { spawnFailure = error })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout = boundedLog(stdout, chunk) })
  child.stderr?.on('data', chunk => { stderr = boundedLog(stderr, chunk) })
  const diagnostics = () => JSON.stringify({ pid: child.pid, exitCode: child.exitCode, stdout, stderr })
  health = await waitForHealth(child, statusUrl, timeoutMs, diagnostics, () => spawnFailure)
} catch (error) {
  failure = error
}
if (child !== undefined) {
  try {
    await stopOwnedProcess(child)
  } catch (error) {
    failure = failure === undefined
      ? error
      : new AggregateError([failure, error], 'installed Profile smoke and process cleanup failed')
  }
}
if (isolated !== undefined) {
  try {
    await rm(isolated.root, { recursive: true, force: true })
  } catch (error) {
    failure = failure === undefined
      ? error
      : new AggregateError([failure, error], 'installed Profile smoke and temporary Profile cleanup failed')
  }
}
if (failure !== undefined) throw failure
process.stdout.write(`${JSON.stringify({
  schema: SCHEMA,
  status: 'ready',
  port,
  version: typeof health?.version === 'string' ? health.version : null,
})}\n`)
