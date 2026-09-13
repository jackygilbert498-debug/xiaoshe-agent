import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  collectRequiredSourceSnapshot,
  verifyPackagedApplicationSourceIdentity,
} from '../../apps/desktop-shell/scripts/verify-artifact.mjs'
import { runLifecycleCleanup } from '../acceptance/macos-app-lifecycle.mjs'
import { acceptanceRunMetadataFromEnvironment } from '../acceptance/macos-acceptance-run.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const run = promisify(execFile)
const digestPattern = /^[a-f0-9]{64}$/u
const commitPattern = /^[a-f0-9]{40,64}$/u

function assertSnapshotShape(snapshot) {
  if (!snapshot || !commitPattern.test(snapshot.commit ?? '')
      || !digestPattern.test(snapshot.sha256 ?? '')
      || !Number.isSafeInteger(snapshot.files) || snapshot.files <= 0
      || !Array.isArray(snapshot.dirty)) {
    throw new Error('invalid release source identity')
  }
}

function sourceProjection(snapshot) {
  return Object.freeze({
    commit: snapshot.commit,
    dirty: Object.freeze([...snapshot.dirty]),
    files: snapshot.files,
    sha256: snapshot.sha256,
    product: snapshot.product,
    desktop: snapshot.desktop,
  })
}

/** Capture only clean, content-backed source inputs that are actually shipped. */
export function createCleanSourceCapture(snapshot, now = new Date()) {
  assertSnapshotShape(snapshot)
  if (snapshot.dirty.length > 0) {
    throw new Error(`required release sources are dirty: ${snapshot.dirty.join(', ')}`)
  }
  return Object.freeze({
    schema: 'xiaoshe-macos-source-capture/v1',
    capturedAt: now.toISOString(),
    source: sourceProjection(snapshot),
  })
}

/** Refuse a missing, malformed, dirty, or changed pre-build source capture. */
export function assertCapturedSourceMatches(capture, current) {
  if (capture?.schema !== 'xiaoshe-macos-source-capture/v1') {
    throw new Error('macOS release source capture is missing or invalid')
  }
  assertSnapshotShape(capture.source)
  assertSnapshotShape(current)
  if (capture.source.dirty.length > 0 || current.dirty.length > 0) {
    throw new Error('required release sources are dirty')
  }
  if (capture.source.commit !== current.commit
      || capture.source.files !== current.files
      || capture.source.sha256 !== current.sha256) {
    throw new Error('captured source identity mismatch')
  }
}

async function stableFileFact(path, label) {
  const requested = resolve(path)
  const requestedInfo = await lstat(requested)
  if (!requestedInfo.isFile() || requestedInfo.isSymbolicLink()) throw new Error(`${label} is not a regular file`)
  const canonical = await realpath(requested)
  const before = await lstat(canonical)
  const bytes = await readFile(canonical)
  const after = await lstat(canonical)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1_024
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`${label} changed during verification or is unexpectedly small`)
  }
  return Object.freeze({ path: canonical, bytes: bytes.byteLength, sha256: sha256(bytes) })
}

/** Persist release identity without exposing the builder's local filesystem. */
export function contentFreeDmgEvidence(fact) {
  if (!Number.isSafeInteger(fact?.bytes) || fact.bytes < 1_024 || !digestPattern.test(fact?.sha256 ?? '')) {
    throw new Error('final DMG evidence is invalid')
  }
  return Object.freeze({ role: 'final-release-dmg', bytes: fact.bytes, sha256: fact.sha256 })
}

/** Resolve a real directory without allowing a symlink or parent escape. */
export async function containedReleaseDirectory(root, candidate, label) {
  const canonicalRoot = await realpath(resolve(root))
  const requested = resolve(candidate)
  const requestedInfo = await lstat(requested)
  if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a link`)
  }
  const canonicalCandidate = await realpath(requested)
  const remainder = relative(canonicalRoot, canonicalCandidate)
  if (remainder === '' || isAbsolute(remainder) || remainder === '..' || remainder.startsWith(`..${sep}`)) {
    throw new Error(`${label} is outside its declared root`)
  }
  return canonicalCandidate
}

async function command(path, argv, timeout = 180_000) {
  try {
    return await run(path, argv, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).slice(-3_000)
    throw new Error(`${path} ${argv[0] ?? ''} failed: ${detail}`)
  }
}

function assertSamePackagedMaterials(sidecar, mounted) {
  for (const name of ['runtime', 'desktop', 'lock', 'profile', 'bundle', 'dsh']) {
    if (sidecar.identities[name].files !== mounted.identities[name].files
        || sidecar.identities[name].sha256 !== mounted.identities[name].sha256) {
      throw new Error(`mounted DMG ${name} identity differs from the built application`)
    }
  }
  for (const name of ['appAsar', 'executable', 'applicationBundle']) {
    if (sidecar.artifacts[name].bytes !== mounted.artifacts[name].bytes
        || sidecar.artifacts[name].sha256 !== mounted.artifacts[name].sha256
        || sidecar.artifacts[name].entries !== mounted.artifacts[name].entries
        || sidecar.artifacts[name].files !== mounted.artifacts[name].files) {
      throw new Error(`mounted DMG ${name} differs from the built application`)
    }
  }
}

async function verifyMountedDmgApplication({ root, dmgPath, capture, sidecar, productName }) {
  const mountPoint = await mkdtemp(join(tmpdir(), 'xiaoshe-source-dmg-'))
  let attached = false
  let mountedPackaged
  let operationError
  try {
    await command('/usr/bin/hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-mountpoint', mountPoint])
    attached = true
    const candidates = (await readdir(mountPoint)).filter(name => name.endsWith('.app'))
    if (candidates.length !== 1) throw new Error(`DMG must contain exactly one application; found ${candidates.length}`)
    const mountedApp = await containedReleaseDirectory(mountPoint, join(mountPoint, candidates[0]), 'mounted DMG application')
    const contents = join(mountedApp, 'Contents')
    mountedPackaged = await verifyPackagedApplicationSourceIdentity({
      repositoryRoot: root,
      applicationRoot: contents,
      applicationBundleRoot: mountedApp,
      resourcesDir: join(contents, 'Resources'),
      executablePath: join(contents, 'MacOS', productName),
      expectedSource: capture.source,
    })
    assertSamePackagedMaterials(sidecar, mountedPackaged)
  } catch (error) {
    operationError = error
  }

  let cleanupError
  try {
    await runLifecycleCleanup([
      ['DMG detach', async () => {
        if (!attached) return
        await command('/usr/bin/hdiutil', ['detach', mountPoint], 60_000)
        attached = false
      }],
      ['DMG mount directory removal', () => rm(mountPoint, { recursive: true, force: true })],
    ])
  } catch (error) {
    cleanupError = error
  }
  if (operationError && cleanupError) {
    const cleanupFailures = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]
    throw new AggregateError([operationError, ...cleanupFailures], 'DMG source verification and cleanup failed')
  }
  if (operationError) throw operationError
  if (cleanupError) throw cleanupError
  return mountedPackaged
}

function argumentsMap(argv) {
  const values = new Map()
  for (const value of argv) {
    const separator = value.indexOf('=')
    if (!value.startsWith('--') || separator < 3) throw new Error(`invalid argument: ${value}`)
    const key = value.slice(2, separator)
    if (values.has(key)) throw new Error(`duplicate argument: --${key}`)
    values.set(key, value.slice(separator + 1))
  }
  return values
}

async function writeJson(path, value) {
  const destination = resolve(path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`)
}

async function captureCommand(values) {
  const root = resolve(values.get('root') ?? process.cwd())
  const output = values.get('output')
  if (!output) throw new Error('capture output is required')
  const capture = { ...createCleanSourceCapture(await collectRequiredSourceSnapshot(root)), ...acceptanceRunMetadataFromEnvironment() }
  await writeJson(output, capture)
  process.stdout.write(`macOS release source captured: ${resolve(output)}\n`)
}

async function verifyCommand(values) {
  const root = resolve(values.get('root') ?? process.cwd())
  const output = values.get('output')
  const expectedPath = values.get('expected')
  const appPath = values.get('app')
  const dmgPath = values.get('dmg')
  if (!output || !expectedPath || !appPath || !dmgPath) {
    throw new Error('verify requires output, expected capture, app, and dmg')
  }
  if (process.platform !== 'darwin') throw new Error('macOS release source verification requires Darwin')

  const capture = JSON.parse(await readFile(resolve(expectedPath), 'utf8'))
  const runMetadata = acceptanceRunMetadataFromEnvironment()
  if (runMetadata.runId !== undefined
      && (capture.runId !== runMetadata.runId || capture.runStartedAt !== runMetadata.runStartedAt)) {
    throw new Error('macOS release source capture belongs to another acceptance run')
  }
  const before = await collectRequiredSourceSnapshot(root)
  assertCapturedSourceMatches(capture, before)
  const app = await containedReleaseDirectory(
    join(root, 'apps', 'desktop-shell', 'dist-desktop'),
    appPath,
    'built macOS application',
  )
  const contents = join(app, 'Contents')
  const productName = String.fromCharCode(0x5c0f, 0x86c7)
  const sidecarPackaged = await verifyPackagedApplicationSourceIdentity({
    repositoryRoot: root,
    applicationRoot: contents,
    applicationBundleRoot: app,
    resourcesDir: join(contents, 'Resources'),
    executablePath: join(contents, 'MacOS', productName),
    expectedSource: capture.source,
  })
  const dmgBefore = await stableFileFact(dmgPath, 'DMG')
  const mountedPackaged = await verifyMountedDmgApplication({
    root, dmgPath: dmgBefore.path, capture, sidecar: sidecarPackaged, productName,
  })
  const after = await collectRequiredSourceSnapshot(root)
  assertCapturedSourceMatches(capture, after)
  const dmgAfter = await stableFileFact(dmgPath, 'DMG')
  if (dmgBefore.path !== dmgAfter.path || dmgBefore.bytes !== dmgAfter.bytes || dmgBefore.sha256 !== dmgAfter.sha256) {
    throw new Error('DMG changed during release source verification')
  }

  const dmgEvidence = contentFreeDmgEvidence(dmgAfter)
  const material = {
    source: mountedPackaged.source,
    identities: mountedPackaged.identities,
    applicationArtifacts: mountedPackaged.artifacts,
    dmg: dmgEvidence,
  }
  const sourceIdentity = Object.freeze({
    schema: 'xiaoshe-macos-release-source/v1',
    state: 'clean',
    verified: true,
    commit: mountedPackaged.source.commit,
    files: mountedPackaged.source.files,
    sha256: mountedPackaged.source.sha256,
    materialsSha256: sha256(Buffer.from(JSON.stringify(material))),
    packagedApplication: mountedPackaged,
    builtApplication: sidecarPackaged.artifacts,
    dmg: dmgEvidence,
  })
  const report = {
    schemaVersion: 1,
    platform: 'macos',
    generatedAt: new Date().toISOString(),
    ...runMetadata,
    sourceIdentity,
    checks: [{
      id: 'release-source-identity',
      state: 'pass',
      detail: 'Clean captured source matches the packaged product, app.asar, executable, and final DMG materials.',
      evidence: {
        commit: sourceIdentity.commit,
        files: sourceIdentity.files,
        sourceSha256: sourceIdentity.sha256,
        materialsSha256: sourceIdentity.materialsSha256,
        dmgSha256: sourceIdentity.dmg.sha256,
      },
    }],
  }
  await writeJson(output, report)
  process.stdout.write(`macOS release source verified: ${resolve(output)}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2)
  const values = argumentsMap(argv)
  if (command === 'capture') await captureCommand(values)
  else if (command === 'verify') await verifyCommand(values)
  else throw new Error('usage: macos-source-identity.mjs capture|verify --root=<root> --output=<path> [--expected=<capture> --app=<app> --dmg=<dmg>]')
}
