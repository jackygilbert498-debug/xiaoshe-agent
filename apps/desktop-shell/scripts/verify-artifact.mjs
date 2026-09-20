import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sha = value => createHash('sha256').update(value).digest('hex')
const rootFiles = Object.freeze([
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.build.json',
  'README.md', 'cordis.patch.yml', '启动小蛇.ps1', '停止小蛇.ps1', '诊断小蛇-Windows.ps1',
])
const productDirectories = Object.freeze(['runtime', 'packages', 'scripts', 'setup', 'python', 'src'])
const ignoredSegments = new Set(['.git', 'node_modules', '.venv'])
const sensitiveExtensions = new Set(['.pem', '.key', '.p12', '.pfx', '.kdbx'])
const sensitiveConfigurationNames = new Set(['.npmrc', '.pnpmrc', '.netrc', '.pypirc'])
const privateKeyNames = new Set(['id_rsa', 'id_ed25519'])
const sharedDesktopProductFile = 'apps/desktop-shell/src/acceptance-isolation.mjs'

function portable(path) { return path.split(sep).join('/') }
function incidentalSourceCache(path) {
  const parts = path.replaceAll('\\', '/').split('/')
  return parts.at(-1) === '.DS_Store' || parts.includes('__pycache__')
}
export function sourceIsRequired(path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '')
  if (incidentalSourceCache(normalized)) return false
  if (rootFiles.includes(normalized)) return true
  if (normalized === 'apps/desktop-shell/package.json' || normalized === 'apps/desktop-shell/electron-builder.yml' || normalized === 'apps/desktop-shell/scripts/verify-artifact.mjs' || normalized === 'apps/desktop-shell/scripts/before-pack.mjs') return true
  if (normalized.startsWith('apps/desktop-shell/src/')) return true
  if (!productDirectories.some(directory => normalized === directory || normalized.startsWith(`${directory}/`))) return false
  const parts = normalized.split('/')
  if (parts.some(part => ignoredSegments.has(part))) return false
  const name = parts.at(-1) ?? ''
  const testOnly = parts.some(part => part === 'test' || part === 'tests' || part === '__tests__')
    || /\.(?:test|spec)\.[^/]+$/u.test(name)
    || /^(?:test_.+|.+_test)\.py$/u.test(name)
  return !testOnly
}

function assertSafeReleaseInput(path, { directory = false } = {}) {
  const normalized = portable(path).toLocaleLowerCase('en-US')
  const parts = normalized.split('/')
  const name = parts.at(-1) ?? ''
  const extension = name.includes('.') ? `.${name.split('.').at(-1)}` : ''
  const localSecret = /(?:credential|secret|token)/u.test(name)
    && /\.(?:json|ya?ml|txt|ini|cfg|conf)$/u.test(name)
  const sensitiveConfiguration = sensitiveConfigurationNames.has(name) || name.startsWith('.yarnrc')
  const serviceAccount = /service[-_.]?account/u.test(name) && name.endsWith('.json')
  const unsafeFile = !directory && ((name === '.env' || (name.startsWith('.env.') && name !== '.env.example'))
    || sensitiveExtensions.has(extension)
    || sensitiveConfiguration
    || privateKeyNames.has(name)
    || name === 'credentials'
    || name === 'token'
    || name === 'secret'
    || serviceAccount
    || localSecret)
  const unsafe = parts.includes('.credentials') || unsafeFile
  if (unsafe) throw new Error(`sensitive release input is forbidden: ${normalized}`)
}

function recordSourceInput(inputs, path, projectedPath, projection = 'identity') {
  // Raw paths are unique even when a module is shipped into both app.asar and
  // the product tree. Each shipped projection is still an independent digest.
  for (const value of [path, projectedPath]) {
    if (typeof value !== 'string' || /[\\\0-\x1f\x7f]/u.test(value)
        || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw new Error('unsafe release projection path')
    }
  }
  if (!/^(?:product|desktop|release)\//u.test(projectedPath)
      || !['identity', 'desktop-package'].includes(projection)) throw new Error('unsafe release projection mapping')
  if (!inputs) return
  if (inputs.projectedPaths.has(projectedPath)) throw new Error(`duplicate release projection: ${projectedPath}`)
  inputs.projectedPaths.add(projectedPath)
  const previous = inputs.files.get(path)
  if (previous) {
    inputs.files.set(path, Object.freeze({ ...previous, additionalProjections: Object.freeze([
      ...(previous.additionalProjections ?? []), Object.freeze({ projectedPath, projection }),
    ]) }))
  } else inputs.files.set(path, Object.freeze({ path, projectedPath, projection }))
}

async function fileEntry(root, path, virtualPath, inputs) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe release input: ${portable(relative(root, path))}`)
  recordSourceInput(inputs, portable(relative(root, path)), virtualPath)
  if (inputs?.pathsOnly) return Object.freeze({ path: virtualPath })
  const bytes = await readFile(path)
  return Object.freeze({ path: virtualPath, bytes: bytes.byteLength, sha256: sha(bytes) })
}

function desktopPackageEntry(bytes) {
  const value = JSON.parse(bytes.toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('desktop package metadata is invalid')
  const projected = {}
  for (const key of ['name', 'version', 'description', 'author', 'private', 'type', 'main', 'engines']) {
    if (value[key] !== undefined) projected[key] = value[key]
  }
  const canonical = Buffer.from(JSON.stringify(projected))
  return Object.freeze({ path: 'desktop/package.json', bytes: canonical.byteLength, sha256: sha(canonical) })
}

async function walkFiles(root, path, virtualRoot, filter = () => true, inputs) {
  const result = []
  inputs?.directories.add(portable(relative(root, path)))
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    const sourcePath = portable(relative(root, child))
    assertSafeReleaseInput(sourcePath, { directory: entry.isDirectory() })
    if (!filter(sourcePath, entry)) continue
    if (entry.isSymbolicLink()) throw new Error(`unsafe release input link: ${sourcePath}`)
    const virtualPath = `${virtualRoot}/${portable(relative(path, child))}`
    if (entry.isDirectory()) result.push(...await walkFiles(root, child, virtualPath, filter, inputs))
    else if (entry.isFile()) result.push(await fileEntry(root, child, virtualPath, inputs))
    else throw new Error(`unsafe release input type: ${sourcePath}`)
  }
  return result
}

function digestEntries(entries, prefix = '') {
  const selected = entries
    .filter(entry => prefix === '' || entry.path === prefix || entry.path.startsWith(`${prefix}/`))
    .map(entry => [entry.path, entry.bytes, entry.sha256])
    .sort(([left], [right]) => left.localeCompare(right))
  return Object.freeze({ files: selected.length, sha256: sha(JSON.stringify(selected)) })
}

async function sourceEntries(repositoryRoot, inputs) {
  const entries = []
  for (const directory of productDirectories) {
    const sourceRoot = join(repositoryRoot, directory)
    await assertSafeSourceDirectory(repositoryRoot, sourceRoot)
    entries.push(...await walkFiles(repositoryRoot, sourceRoot, `product/${directory}`, sourceIsRequired, inputs))
  }
  for (const name of rootFiles) entries.push(await fileEntry(repositoryRoot, join(repositoryRoot, name), `product/${name}`, inputs))
  const desktopSource = join(repositoryRoot, 'apps', 'desktop-shell', 'src')
  await assertSafeSourceDirectory(repositoryRoot, desktopSource)
  entries.push(...await walkFiles(repositoryRoot, desktopSource, 'desktop/src', path => !incidentalSourceCache(path), inputs))
  const shared = entries.find(entry => entry.path === 'desktop/src/acceptance-isolation.mjs')
  if (!shared) throw new Error(`required release input is missing: ${sharedDesktopProductFile}`)
  // Reuse the single raw read, not a second independently changing read. The
  // package verifier must nevertheless observe both physical shipped copies.
  const sharedProjection = `product/${sharedDesktopProductFile}`
  recordSourceInput(inputs, sharedDesktopProductFile, sharedProjection)
  entries.push(Object.freeze({ ...shared, path: sharedProjection }))
  const desktopPackage = join(repositoryRoot, 'apps', 'desktop-shell', 'package.json')
  // A projected manifest still originates from a regular file, not a link to
  // private configuration. Its raw bytes remain distinct from its projection.
  const desktopInfo = await lstat(desktopPackage)
  if (!desktopInfo.isFile() || desktopInfo.isSymbolicLink()) throw new Error('unsafe release input: apps/desktop-shell/package.json')
  entries.push(inputs?.pathsOnly ? Object.freeze({ path: 'desktop/package.json' }) : desktopPackageEntry(await readFile(desktopPackage)))
  recordSourceInput(inputs, 'apps/desktop-shell/package.json', 'desktop/package.json', 'desktop-package')
  entries.push(await fileEntry(repositoryRoot, join(repositoryRoot, 'apps', 'desktop-shell', 'electron-builder.yml'), 'release/electron-builder.yml', inputs))
  entries.push(await fileEntry(repositoryRoot, join(repositoryRoot, 'apps', 'desktop-shell', 'scripts', 'verify-artifact.mjs'), 'release/verify-artifact.mjs', inputs))
  entries.push(await fileEntry(repositoryRoot, join(repositoryRoot, 'apps', 'desktop-shell', 'scripts', 'before-pack.mjs'), 'release/before-pack.mjs', inputs))
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('duplicate release projection')
  return Object.freeze(entries.sort((left, right) => left.path.localeCompare(right.path)))
}

/** The release traversal is the single authority for raw-to-shipped paths.
 * Metadata is separate so release digests retain their exact entry shape.
 * inputs counts raw files; optional additionalProjections counts extra shipped
 * copies and must not cause an exporter to copy or stage a raw path twice. */
export async function collectReleaseSourceInputs(repositoryRoot, { includeDigests = false } = {}) {
  const canonical = await realpath(resolve(repositoryRoot))
  // Listing does not open file contents: exporters can reject ignored private
  // paths before requesting hashes. Existing release callers still hash all.
  const inputs = { files: new Map(), projectedPaths: new Set(), directories: new Set(), pathsOnly: !includeDigests }
  const projectedEntries = await sourceEntries(canonical, inputs)
  return Object.freeze({
    schema: 'xiaoshe-release-source-inputs/v1',
    ...(includeDigests ? { projectedEntries } : {}),
    inputs: Object.freeze([...inputs.files.values()].sort((a, b) => a.path.localeCompare(b.path))),
    directories: Object.freeze([...inputs.directories].sort()),
  })
}

async function assertSafeSourceDirectory(repositoryRoot, sourceRoot) {
  const info = await lstat(sourceRoot)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe release input link: ${portable(relative(repositoryRoot, sourceRoot))}`)
  const canonical = await realpath(sourceRoot)
  assertContained(repositoryRoot, canonical, 'release source directory')
}

/** Fail before packaging if any shipped source path resembles private configuration. */
export async function assertReleaseInputsSafe(repositoryRoot) {
  await sourceEntries(await realpath(resolve(repositoryRoot)))
}

async function gitFacts(repositoryRoot) {
  const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
    run('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
    run('git', ['-C', repositoryRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8' }),
  ])
  const commit = commitOutput.trim()
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('git commit identity is unavailable')
  const records = statusOutput.split('\0').filter(Boolean)
  const dirty = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (sourceIsRequired(path)) dirty.push(`${status} ${path}`)
    if (/[RC]/u.test(status) && records[index + 1] !== undefined) {
      const original = records[index + 1]
      if (sourceIsRequired(original)) dirty.push(`${status} ${original}`)
      index += 1
    }
  }
  return Object.freeze({ commit, dirty: Object.freeze(dirty.sort()) })
}

/** Build the clean source identity that every release artifact must match. */
export async function collectRequiredSourceSnapshot(repositoryRoot) {
  const canonical = await realpath(resolve(repositoryRoot))
  const before = await gitFacts(canonical)
  const entries = await sourceEntries(canonical)
  const after = await gitFacts(canonical)
  if (before.commit !== after.commit) throw new Error('required release sources changed commit while hashing')
  const dirty = Object.freeze([...new Set([...before.dirty, ...after.dirty])].sort())
  const all = digestEntries(entries)
  return Object.freeze({
    repositoryRoot: canonical,
    commit: before.commit,
    dirty,
    files: all.files,
    sha256: all.sha256,
    product: digestEntries(entries, 'product'),
    desktop: digestEntries(entries, 'desktop'),
    lock: digestEntries(entries, 'product/pnpm-lock.yaml'),
    profile: digestEntries(entries, 'product/cordis.patch.yml'),
    bundle: digestEntries(entries, 'product/packages/product-bundle'),
    dsh: digestEntries(entries, 'product/runtime/DSH'),
  })
}

async function packagedProductEntries(productRoot) {
  return Object.freeze((await walkFiles(productRoot, productRoot, 'product')).sort((left, right) => left.path.localeCompare(right.path)))
}

function loadAsar() {
  const desktopPackage = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const requireDesktop = createRequire(desktopPackage)
  const requireBuilder = createRequire(requireDesktop.resolve('electron-builder'))
  return requireBuilder('@electron/asar')
}

async function packagedDesktopEntries(archive) {
  const asar = loadAsar()
  const result = []
  for (const entry of asar.listPackage(archive)) {
    const normalized = entry.replace(/^[/\\]+/u, '').replaceAll('\\', '/')
    const info = asar.statFile(archive, normalized)
    const directory = info?.files !== undefined
    assertSafeReleaseInput(normalized, { directory })
    if (directory) continue
    const bytes = asar.extractFile(archive, normalized)
    result.push(normalized === 'package.json'
      ? desktopPackageEntry(bytes)
      : Object.freeze({ path: `desktop/${normalized}`, bytes: bytes.byteLength, sha256: sha(bytes) }))
  }
  return Object.freeze(result.sort((left, right) => left.path.localeCompare(right.path)))
}

async function artifactFact(path, minimumBytes = 1_024) {
  const canonical = await realpath(resolve(path))
  const info = await lstat(canonical)
  if (!info.isFile() || info.isSymbolicLink() || info.size < minimumBytes) throw new Error(`release artifact is missing or unexpectedly small: ${canonical}`)
  return Object.freeze({ path: canonical, bytes: info.size, sha256: sha(await readFile(canonical)) })
}

/** Hash every file, directory mode, and symlink target in a final application bundle. */
export async function applicationBundleManifest(root) {
  const requested = resolve(root)
  const requestedInfo = await lstat(requested)
  if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) throw new Error('application bundle must be a real directory')
  const canonicalRoot = await realpath(requested)
  const entries = []
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const before = await lstat(path)
      const key = portable(relative(canonicalRoot, path)).normalize('NFC')
      if (before.isDirectory()) {
        entries.push({ key, type: 'directory', mode: before.mode & 0o777 })
        await walk(path)
      } else if (before.isSymbolicLink()) {
        entries.push({ key, type: 'symlink', target: await readlink(path) })
      } else if (before.isFile()) {
        const bytes = await readFile(path)
        const after = await lstat(path)
        if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new Error(`application bundle file changed during verification: ${key}`)
        }
        entries.push({ key, type: 'file', mode: after.mode & 0o777, bytes: bytes.byteLength, sha256: sha(bytes) })
      } else {
        throw new Error(`unsupported application bundle entry: ${key}`)
      }
    }
  }
  await walk(canonicalRoot)
  return Object.freeze({
    digest: sha(JSON.stringify(entries)),
    entries: entries.length,
    files: entries.filter(entry => entry.type === 'file').length,
    bytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
  })
}

function assertContained(root, candidate, label, allowRoot = false) {
  const fromRoot = relative(root, candidate)
  const outside = fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || resolve(root, fromRoot) !== candidate
  if (outside || (!allowRoot && fromRoot === '')) throw new Error(`${label} is outside the release directory`)
  return candidate
}

async function containedExisting(root, path, label, allowRoot = false) {
  return assertContained(root, await realpath(resolve(path)), label, allowRoot)
}

function portableArtifactFact(fact, releaseRoot) {
  const fromRoot = relative(releaseRoot, fact.path)
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || resolve(releaseRoot, fromRoot) !== fact.path) {
    throw new Error(`release artifact is outside the release directory: ${fact.path}`)
  }
  return Object.freeze({ ...fact, path: portable(fromRoot) })
}

/** Inspect the artifact itself; environment variables are never signing proof. */
export async function inspectAuthenticode(path) {
  if (process.platform !== 'win32') return Object.freeze({ kind: 'authenticode', state: 'not-verified-on-this-platform', nativeStatus: 'Unavailable' })
  const command = "$value = Get-AuthenticodeSignature -LiteralPath $env:XIAOSHE_SIGNATURE_TARGET; $certificateSha256 = $null; if ($null -ne $value.SignerCertificate) { $hasher = [Security.Cryptography.SHA256]::Create(); try { $certificateSha256 = ([BitConverter]::ToString($hasher.ComputeHash($value.SignerCertificate.RawData))).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose() } }; [ordered]@{ status = [string]$value.Status; message = [string]$value.StatusMessage; subject = [string]$value.SignerCertificate.Subject; thumbprint = [string]$value.SignerCertificate.Thumbprint; signerCertificateSha256 = $certificateSha256 } | ConvertTo-Json -Compress"
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', env: { ...process.env, XIAOSHE_SIGNATURE_TARGET: resolve(path) }, windowsHide: true,
  })
  const value = JSON.parse(stdout.trim())
  const nativeStatus = String(value.status || 'Unknown')
  const state = nativeStatus === 'Valid' ? 'valid' : nativeStatus === 'NotSigned' ? 'unsigned' : 'invalid'
  return Object.freeze({
    kind: 'authenticode', state, nativeStatus,
    ...(value.message ? { message: String(value.message).slice(0, 1_000) } : {}),
    ...(value.subject ? { subject: String(value.subject).slice(0, 1_000) } : {}),
    ...(value.thumbprint ? { thumbprint: String(value.thumbprint).slice(0, 200) } : {}),
    ...(/^[a-f0-9]{64}$/u.test(value.signerCertificateSha256 ?? '') ? { signerCertificateSha256: value.signerCertificateSha256 } : {}),
  })
}

/** An EXE signature never substitutes for the independently inspected NSIS
 * installer. Keep certificate identities content-addressed in acceptance. */
export function assertWindowsSigningEvidence(evidence, expected) {
  const digest = value => /^[a-f0-9]{64}$/u.test(value ?? '')
  const bad = () => { throw new Error('Windows signing requires original and rechecked EXE and installer native Valid signatures bound to source, bytes, and signer') }
  if (evidence?.schema !== 'xiaoshe-windows-signing/v1' || evidence.platform !== 'win32'
    || evidence.collector !== 'Get-AuthenticodeSignature' || !/^[a-f0-9]{40,64}$/u.test(evidence.sourceCommit ?? '')
    || evidence.sourceCommit !== expected?.sourceCommit || !digest(evidence.sourceSha256) || evidence.sourceSha256 !== expected?.sourceSha256) bad()
  for (const role of ['executable', 'installer']) {
    const before = evidence.original?.[role], after = evidence.rechecked?.[role]
    if (!digest(expected?.[`${role}Sha256`]) || before?.sha256 !== expected[`${role}Sha256`] || after?.sha256 !== before.sha256
      || before?.kind !== 'authenticode' || after?.kind !== 'authenticode' || before.state !== 'valid' || after.state !== 'valid'
      || before.nativeStatus !== 'Valid' || after.nativeStatus !== 'Valid' || !digest(before.signerCertificateSha256)
      || after.signerCertificateSha256 !== before.signerCertificateSha256) bad()
  }
  // The release contract uses one pinned signing identity for both shipped
  // binaries, not an arbitrary differently signed installer with a valid chain.
  if (evidence.original.executable.signerCertificateSha256 !== evidence.original.installer.signerCertificateSha256) bad()
  return true
}

export function createWindowsSigningEvidence(original, rechecked) {
  const fact = artifact => ({ sha256: artifact?.sha256, kind: artifact?.signing?.kind, state: artifact?.signing?.state,
    nativeStatus: artifact?.signing?.nativeStatus, signerCertificateSha256: artifact?.signing?.signerCertificateSha256 })
  if ([original, rechecked].some(value => value?.schema !== 'xiaoshe-desktop-release/v1' || value.platform !== 'win32'
    || value.git?.requiredSources?.state !== 'clean' || value.git.requiredSources.dirty?.length !== 0)
    || original.git.commit !== rechecked.git.commit || original.git.requiredSources.sha256 !== rechecked.git.requiredSources.sha256) throw new Error('Windows signing manifest source or native platform mismatch')
  const evidence = { schema: 'xiaoshe-windows-signing/v1', platform: 'win32', collector: 'Get-AuthenticodeSignature',
    sourceCommit: original.git.commit, sourceSha256: original.git.requiredSources.sha256,
    original: { executable: fact(original.artifacts?.executable), installer: fact(original.artifacts?.installer) },
    rechecked: { executable: fact(rechecked.artifacts?.executable), installer: fact(rechecked.artifacts?.installer) } }
  assertWindowsSigningEvidence(evidence, { sourceCommit: original.git.commit, sourceSha256: original.git.requiredSources.sha256,
    executableSha256: original.artifacts?.executable?.sha256, installerSha256: original.artifacts?.installer?.sha256 })
  return Object.freeze(evidence)
}

function assertMatch(label, source, packaged) {
  if (source.sha256 !== packaged.sha256 || source.files !== packaged.files) throw new Error(`${label} identity mismatch: source ${source.sha256}, packaged ${packaged.sha256}`)
  return Object.freeze({ files: source.files, sha256: source.sha256, packagedSha256: packaged.sha256, matchesPackaged: true })
}

export function assertUpdateDisabled(configuration) {
  if (!/(?:^|\n)publish:\s*null\s*(?:\r?\n|$)/u.test(configuration)) throw new Error('desktop update policy is not disabled')
  return Object.freeze({ enabled: false, publish: null })
}

function assertExpectedArtifactHashes(expected, artifacts) {
  if (expected === undefined) return
  for (const name of ['appAsar', 'executable', 'installer']) {
    const value = expected[name]
    if (!/^[a-f0-9]{64}$/u.test(value ?? '') || value !== artifacts[name].sha256) {
      throw new Error(`expected ${name === 'appAsar' ? 'app.asar' : name} SHA-256 mismatch: expected ${value ?? 'missing'}, actual ${artifacts[name].sha256}`)
    }
  }
}

function assertArtifactUnchanged(label, before, after) {
  if (before.path !== after.path || before.bytes !== after.bytes || before.sha256 !== after.sha256) {
    throw new Error(`release ${label} artifact changed during verification`)
  }
}

/** Bind an inventory to the exact artifact bytes that were inspected. */
export async function collectStableArtifactInventory(path, collectEntries) {
  const before = await artifactFact(path)
  const entries = await collectEntries()
  const after = await artifactFact(path)
  if (before.path !== after.path || before.bytes !== after.bytes || before.sha256 !== after.sha256) {
    throw new Error('release app.asar artifact changed during inventory')
  }
  return Object.freeze({ artifact: after, entries })
}

function assertCapturedSourceIdentity(expected, actual) {
  if (expected === undefined) return
  const valid = /^[a-f0-9]{64}$/u.test(expected?.sha256 ?? '')
    && /^[a-f0-9]{40,64}$/u.test(expected?.commit ?? '')
    && Number.isSafeInteger(expected?.files) && expected.files > 0
  if (!valid
      || expected.commit !== actual.commit
      || expected.files !== actual.files
      || expected.sha256 !== actual.sha256) {
    throw new Error('captured source identity mismatch')
  }
}

function assertInventoryUnchanged(label, before, after) {
  const first = digestEntries(before)
  const second = digestEntries(after)
  if (first.files !== second.files || first.sha256 !== second.sha256) {
    throw new Error(`packaged ${label} changed during verification`)
  }
}

/**
 * Bind a platform-native packaged application to the exact clean source tree.
 * This is shared by unsigned acceptance builds and signed/notarized releases;
 * platform signing bytes are recorded but source-owned product/app.asar bytes
 * must be identical to the captured source identity.
 */
export async function verifyPackagedApplicationSourceIdentity(options) {
  const repositoryRoot = resolve(options.repositoryRoot)
  const applicationRoot = await realpath(resolve(options.applicationRoot ?? dirname(options.resourcesDir)))
  const applicationBundleRoot = await realpath(resolve(options.applicationBundleRoot ?? applicationRoot))
  assertContained(applicationBundleRoot, applicationRoot, 'packaged application contents', true)
  const resourcesDir = await containedExisting(applicationRoot, options.resourcesDir, 'packaged resources directory')
  const productRoot = await containedExisting(resourcesDir, join(resourcesDir, 'product'), 'packaged product directory')
  const archivePath = await containedExisting(resourcesDir, join(resourcesDir, 'app.asar'), 'packaged app.asar')
  const executablePath = await containedExisting(applicationRoot, options.executablePath, 'packaged executable')

  const source = await collectRequiredSourceSnapshot(repositoryRoot)
  if (source.dirty.length > 0) throw new Error(`required release sources are dirty: ${source.dirty.join(', ')}`)
  assertCapturedSourceIdentity(options.expectedSource, source)

  const executableBefore = await artifactFact(executablePath)
  const applicationBundleBefore = await applicationBundleManifest(applicationBundleRoot)
  const productEntries = await packagedProductEntries(productRoot)
  const { artifact: appAsar, entries: desktopEntries } = await collectStableArtifactInventory(
    archivePath,
    () => packagedDesktopEntries(archivePath),
  )
  const identity = prefix => digestEntries(productEntries, prefix)
  const identities = Object.freeze({
    lock: assertMatch('lock', source.lock, identity('product/pnpm-lock.yaml')),
    profile: assertMatch('profile', source.profile, identity('product/cordis.patch.yml')),
    bundle: assertMatch('bundle', source.bundle, identity('product/packages/product-bundle')),
    dsh: assertMatch('DSH', source.dsh, identity('product/runtime/DSH')),
    runtime: assertMatch('runtime', source.product, digestEntries(productEntries, 'product')),
    desktop: assertMatch('desktop', source.desktop, digestEntries(desktopEntries, 'desktop')),
  })

  const [productEntriesAfter, executableAfter, applicationBundleAfter, finalSource] = await Promise.all([
    packagedProductEntries(productRoot),
    artifactFact(executablePath),
    applicationBundleManifest(applicationBundleRoot),
    collectRequiredSourceSnapshot(repositoryRoot),
  ])
  assertInventoryUnchanged('product runtime', productEntries, productEntriesAfter)
  assertArtifactUnchanged('executable', executableBefore, executableAfter)
  if (JSON.stringify(applicationBundleBefore) !== JSON.stringify(applicationBundleAfter)) {
    throw new Error('release application bundle changed during verification')
  }
  if (finalSource.dirty.length > 0
      || finalSource.commit !== source.commit
      || finalSource.files !== source.files
      || finalSource.sha256 !== source.sha256) {
    const detail = finalSource.dirty.length > 0 ? `: ${finalSource.dirty.join(', ')}` : ''
    throw new Error(`release source changed during packaged application verification${detail}`)
  }

  return Object.freeze({
    schema: 'xiaoshe-packaged-application-source/v1',
    verifiedAt: new Date().toISOString(),
    source: Object.freeze({
      state: 'clean', commit: source.commit, files: source.files, sha256: source.sha256,
    }),
    identities,
    artifacts: Object.freeze({
      appAsar: portableArtifactFact(appAsar, applicationRoot),
      executable: portableArtifactFact(executableAfter, applicationRoot),
      applicationBundle: Object.freeze({
        path: '.', entries: applicationBundleAfter.entries, files: applicationBundleAfter.files,
        bytes: applicationBundleAfter.bytes, sha256: applicationBundleAfter.digest,
      }),
    }),
  })
}

/** Produce a fail-closed manifest for one unpacked application and installer. */
export async function createReleaseManifest(options) {
  const repositoryRoot = resolve(options.repositoryRoot)
  const requestedPackageDir = resolve(options.packageDir)
  const releaseRoot = await realpath(dirname(requestedPackageDir))
  const packageDir = await containedExisting(releaseRoot, requestedPackageDir, 'release package directory')
  const source = await collectRequiredSourceSnapshot(repositoryRoot)
  if (source.dirty.length > 0) throw new Error(`required release sources are dirty: ${source.dirty.join(', ')}`)
  if (options.expectedSourceSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(options.expectedSourceSha256) || options.expectedSourceSha256 !== source.sha256) throw new Error(`expected source SHA-256 mismatch: expected ${options.expectedSourceSha256}, actual ${source.sha256}`)
  }
  const productRoot = await containedExisting(packageDir, join(packageDir, 'resources', 'product'), 'packaged product directory')
  const archivePath = await containedExisting(packageDir, join(packageDir, 'resources', 'app.asar'), 'app.asar')
  const executablePath = await containedExisting(packageDir, options.executablePath === undefined ? await findExecutable(packageDir) : options.executablePath, 'packaged executable')
  const installerPath = await containedExisting(releaseRoot, options.installerPath, 'installer')
  const [productEntries, executable, installer, configuration] = await Promise.all([
    packagedProductEntries(productRoot), artifactFact(executablePath), artifactFact(installerPath),
    readFile(join(repositoryRoot, 'apps', 'desktop-shell', 'electron-builder.yml'), 'utf8'),
  ])
  const { artifact: appAsar, entries: desktopEntries } = await collectStableArtifactInventory(
    archivePath,
    () => packagedDesktopEntries(archivePath),
  )
  const inspect = options.signatureInspector ?? inspectAuthenticode
  assertExpectedArtifactHashes(options.expectedArtifactSha256, { appAsar, executable, installer })
  const [executableSigning, installerSigning] = await Promise.all([inspect(executable.path), inspect(installer.path)])
  const [finalAppAsar, finalExecutable, finalInstaller] = await Promise.all([
    artifactFact(appAsar.path), artifactFact(executable.path), artifactFact(installer.path),
  ])
  assertArtifactUnchanged('app.asar', appAsar, finalAppAsar)
  assertArtifactUnchanged('executable', executable, finalExecutable)
  assertArtifactUnchanged('installer', installer, finalInstaller)
  const finalSource = await collectRequiredSourceSnapshot(repositoryRoot)
  if (finalSource.dirty.length > 0 || finalSource.commit !== source.commit || finalSource.files !== source.files || finalSource.sha256 !== source.sha256) {
    const detail = finalSource.dirty.length > 0 ? `: ${finalSource.dirty.join(', ')}` : ''
    throw new Error(`release source changed during verification${detail}`)
  }
  const identity = prefix => digestEntries(productEntries, prefix)
  return Object.freeze({
    schema: 'xiaoshe-desktop-release/v1', generatedAt: new Date().toISOString(), platform: process.platform,
    git: Object.freeze({ commit: source.commit, requiredSources: Object.freeze({ state: 'clean', dirty: source.dirty, files: source.files, sha256: source.sha256 }) }),
    identities: Object.freeze({
      lock: assertMatch('lock', source.lock, identity('product/pnpm-lock.yaml')),
      profile: assertMatch('profile', source.profile, identity('product/cordis.patch.yml')),
      bundle: assertMatch('bundle', source.bundle, identity('product/packages/product-bundle')),
      dsh: assertMatch('DSH', source.dsh, identity('product/runtime/DSH')),
      runtime: assertMatch('runtime', source.product, digestEntries(productEntries, 'product')),
      desktop: assertMatch('desktop', source.desktop, digestEntries(desktopEntries, 'desktop')),
    }),
    artifacts: Object.freeze({
      root: '.',
      appAsar: portableArtifactFact(appAsar, releaseRoot),
      executable: Object.freeze({ ...portableArtifactFact(executable, releaseRoot), signing: executableSigning }),
      installer: Object.freeze({ ...portableArtifactFact(installer, releaseRoot), signing: installerSigning }),
    }),
    update: assertUpdateDisabled(configuration),
  })
}

async function findExecutable(packageDir) {
  const candidates = []
  for (const entry of await readdir(packageDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.exe') && !/^uninstall/iu.test(entry.name)) candidates.push(join(packageDir, entry.name))
  }
  if (candidates.length !== 1) throw new Error(`expected one packaged executable, found ${candidates.length}`)
  return candidates[0]
}

async function writeReleaseManifest(options) {
  const requestedPackageDir = resolve(options.packageDir)
  const releaseRoot = await realpath(dirname(requestedPackageDir))
  const destination = resolve(options.output)
  const outputParent = await realpath(dirname(destination))
  assertContained(releaseRoot, outputParent, 'release manifest output directory', true)
  try {
    const existing = await lstat(destination)
    if (existing.isSymbolicLink()) throw new Error('release manifest output cannot be a symbolic link')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const manifest = await createReleaseManifest(options)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`)
  return Object.freeze({ destination, manifest })
}

/** Create the release manifest from the exact artifacts emitted by Electron Builder. */
export async function createWindowsReleaseManifestAfterBuild(options) {
  const outDir = await realpath(resolve(options.outDir))
  const installers = (options.artifactPaths ?? [])
    .map(path => resolve(path))
    .filter(path => /^Xiaoshe-.+-x64-setup\.exe$/iu.test(path.slice(path.lastIndexOf(sep) + 1)))
  if (installers.length !== 1) throw new Error(`expected one Windows x64 NSIS installer, found ${installers.length}`)
  const output = join(outDir, 'release-manifest.json')
  const { destination } = await writeReleaseManifest({
    repositoryRoot: options.repositoryRoot,
    packageDir: join(outDir, 'win-unpacked'),
    installerPath: installers[0],
    output,
    ...(options.signatureInspector === undefined ? {} : { signatureInspector: options.signatureInspector }),
  })
  return Object.freeze([destination])
}

/** Electron Builder hook; non-Windows builds do not emit a Windows manifest. */
export default async function afterAllArtifactBuild(result) {
  if (process.platform !== 'win32') return []
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  return createWindowsReleaseManifestAfterBuild({
    repositoryRoot,
    outDir: result.outDir,
    artifactPaths: result.artifactPaths,
  })
}

function argumentsMap(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || values.has(key)) throw new Error('usage: verify-artifact.mjs --package-dir <win-unpacked> --installer <setup.exe> --output <release-manifest.json> [--expected-source-sha256 <sha256>] [--expected-app-asar-sha256 <sha256>] [--expected-executable-sha256 <sha256>] [--expected-installer-sha256 <sha256>] [--repository-root <root>]')
    values.set(key, value)
  }
  return values
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = argumentsMap(process.argv.slice(2))
  const repositoryRoot = resolve(values.get('--repository-root') ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))
  const output = values.get('--output')
  const packageDir = values.get('--package-dir')
  const installerPath = values.get('--installer')
  if (!output || !packageDir || !installerPath) throw new Error('package directory, installer and release manifest output are required')
  const { manifest } = await writeReleaseManifest({
    repositoryRoot,
    packageDir: resolve(packageDir),
    installerPath: resolve(installerPath),
    output: resolve(output),
    expectedSourceSha256: values.get('--expected-source-sha256'),
    expectedArtifactSha256: values.has('--expected-app-asar-sha256') || values.has('--expected-executable-sha256') || values.has('--expected-installer-sha256') ? {
      appAsar: values.get('--expected-app-asar-sha256'),
      executable: values.get('--expected-executable-sha256'),
      installer: values.get('--expected-installer-sha256'),
    } : undefined,
  })
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}
