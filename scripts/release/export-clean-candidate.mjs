/** Save exact local candidate bytes. This does NOT create a clean Git release,
 * install dependencies, build, sign, or manufacture an A/B version pair. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectReleaseSourceInputs } from '../../apps/desktop-shell/scripts/verify-artifact.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const portable = path => path.split(sep).join('/')
const META = '.xiaoshe-candidate'
const SUPPORT = Object.freeze(['.gitignore'])
const MAX_BYTES = 128 * 1024 * 1024
const GIT_TIMEOUT_MS = 10_000
const FILTER_KEYS = '^filter\\..*\\.(clean|process)$'
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const uid = process.getuid?.()
function fail(code, message) { throw Object.assign(new Error(message), { code }) }
export function assertCandidatePlatform(platform = process.platform) {
  if (!['darwin', 'linux'].includes(platform) || typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number'
    || typeof process.getuid !== 'function') fail('UNSUPPORTED_PLATFORM', 'candidate export requires POSIX ownership/mode and no-follow support; Windows ACL privacy is not implemented')
}
function inside(parent, child) {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || /[\0-\x1f\x7f]/u.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(path)) fail('UNSAFE_PATH', 'unsafe candidate relative path')
  return path
}
function identity(info, file = false) {
  return { dev: String(info.dev), ino: String(info.ino), mode: Number(info.mode & 0o7777n), uid: Number(info.uid),
    ...(file ? { nlink: Number(info.nlink), size: Number(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) } : {}) }
}
async function directory(path) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || uid !== undefined && Number(info.uid) !== uid
    || (info.mode & 0o7000n) !== 0n) fail('UNSAFE_DIRECTORY', 'candidate directory must be an owned real directory')
  return identity(info)
}
async function canonicalDirectory(path) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) fail('UNSAFE_DIRECTORY', 'use an absolute canonical directory without links')
  await directory(path)
  return path
}
async function parents(root, path) {
  const result = new Map([['', await directory(root)]])
  let current = ''
  for (const part of safeRelative(path).split('/').slice(0, -1)) {
    current = current ? `${current}/${part}` : part
    result.set(current, await directory(join(root, current)))
  }
  return result
}
async function assertDirectories(root, facts) {
  for (const [path, expected] of facts) if (!equal(await directory(join(root, path)), expected)) fail('DIRECTORY_CHANGED', 'candidate directory identity changed')
}
async function readStable(root, path, expected, expectedDirectories) {
  const ancestors = await parents(root, path)
  if (expectedDirectories) for (const [name, fact] of ancestors) {
    if (!equal(fact, expectedDirectories.get(name))) fail('DIRECTORY_CHANGED', 'candidate ancestor identity changed')
  }
  const absolute = join(root, path)
  const before = await lstat(absolute, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o7000n) !== 0n
    || uid !== undefined && Number(before.uid) !== uid || before.size > BigInt(MAX_BYTES)) fail('UNSAFE_FILE', `unsafe candidate input: ${path}`)
  const fact = identity(before, true)
  if (expected && !equal(fact, expected)) fail('SOURCE_CHANGED', `candidate input changed: ${path}`)
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!equal(identity(await handle.stat({ bigint: true }), true), fact)) fail('SOURCE_CHANGED', `candidate input replaced: ${path}`)
    const bytes = await handle.readFile()
    if (bytes.length !== Number(before.size) || !equal(identity(await handle.stat({ bigint: true }), true), fact)
      || !equal(identity(await lstat(absolute, { bigint: true }), true), fact)) fail('SOURCE_CHANGED', `candidate input changed while reading: ${path}`)
    await assertDirectories(root, ancestors)
    return { bytes, fact, sha256: sha(bytes) }
  } finally { await handle.close() }
}

// This is an admission classification, never a second file-selection list.
// A file must already be in the sole release collector before using it.
export function ignoredBuildInputCategory(path) {
  if (['runtime/DSH/.dsh-build/client-build-environment.json', 'runtime/DSH/tsconfig.client.tsbuildinfo', 'runtime/DSH/tsconfig.host.tsbuildinfo'].includes(path)) return 'dsh-build-metadata'
  if (path === 'packages/native-shell-legacy-adapted/lib/client.version.json') return 'frontend-build-identity'
  const lib = /^(?:packages\/[^/]+|runtime\/DSH\/(?:apps\/[^/]+|packages\/[^/]+\/[^/]+|vendor\/[^/]+|native\/landlock-run\/packages\/entry))\/lib\//u.test(path)
  if (lib && /\.(?:[cm]?js|d\.ts|map|tsbuildinfo|css)$/u.test(path)) return path.endsWith('.tsbuildinfo') ? 'typescript-build-metadata' : 'compiled-product-code'
  if (/^runtime\/DSH\/apps\/web\/dist\/(?:index\.html|favicon\.svg|manifest\.webmanifest|assets\/.+\.(?:[cm]?js|css|map|woff2?|ttf|svg|png|ico))$/u.test(path)) return 'compiled-web-assets'
  return null
}
async function git(root, args, input) {
  // Read-only Git commands must not refresh the user's index or invoke their
  // fsmonitor hook. No inherited Git redirection, credential or network env.
  const child = spawn('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.quotePath=false', '-C', root, ...args], {
    env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  const chunks = []
  let length = 0, errorLength = 0, stopped = null, escalation
  const signalOwned = signal => {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return
    try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') child.kill(signal) }
  }
  const stop = code => {
    if (stopped) return
    stopped = code; signalOwned('SIGTERM')
    escalation = setTimeout(() => signalOwned('SIGKILL'), 250)
  }
  const timer = setTimeout(() => stop('GIT_TIMEOUT'), GIT_TIMEOUT_MS)
  child.stdout.on('data', bytes => { length += bytes.length; if (length > 32 * 1024 * 1024) stop('GIT_OUTPUT_LIMIT'); else chunks.push(bytes) })
  child.stderr.on('data', bytes => { errorLength += bytes.length; if (errorLength > 128 * 1024) stop('GIT_OUTPUT_LIMIT') })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  let code
  try { code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) }) }
  finally {
    if (stopped) signalOwned('SIGKILL')
    clearTimeout(timer); clearTimeout(escalation)
  }
  const groupExists = () => {
    try { process.kill(-child.pid, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  if (groupExists()) {
    stopped ??= 'GIT_DESCENDANT_REMAINED'
    signalOwned('SIGKILL')
    const deadline = Date.now() + 2_000
    while (groupExists() && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 20))
    if (groupExists()) fail('GIT_CLEANUP_UNCONFIRMED', 'owned Git process group cleanup could not be confirmed')
  }
  if (stopped) fail(stopped, 'read-only Git inspection exceeded its bounded time or output limit; owned process group was stopped and reaped')
  const noMatches = args[0] === 'check-ignore' || args[0] === 'config' && args.at(-1) === FILTER_KEYS && args.includes('--name-only')
  if (code !== 0 && !(noMatches && code === 1)) fail('GIT_READ_FAILED', 'read-only Git inspection failed')
  return Buffer.concat(chunks)
}
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
async function gitFacts(root) {
  const head = decode(await git(root, ['rev-parse', 'HEAD'])).trim()
  if (!/^[a-f0-9]{40}$/u.test(head)) fail('GIT_IDENTITY', 'a committed source repository is required')
  const indexPath = resolve(root, decode(await git(root, ['rev-parse', '--git-path', 'index'])).trim())
  // The index is provenance only. It is never copied or rewritten.
  const indexRoot = await canonicalDirectory(dirname(indexPath))
  const index = await readStable(indexRoot, indexPath.slice(indexRoot.length + 1))
  // Even `status` can execute clean/process filters from local configuration
  // or its active include/includeIf chain. Inspect only effective key names,
  // never command values, before EVERY status (including final rechecks).
  // An empty/duplicate filter definition is still rejected; guessing whether
  // its command would run would require interpreting private configuration.
  const filterKeys = await git(root, ['config', '--includes', '--name-only', '--null', '--get-regexp', FILTER_KEYS])
  if (filterKeys.length !== 0) fail('GIT_EXTERNAL_FILTER', 'external Git clean/process filter configuration is present; export refused before status')
  // Parent status may recursively execute a child repository's filters even
  // when the parent's effective configuration has none. Gitlink export is not
  // implemented: reject from index metadata, never ignore or enter the child.
  const staged = decode(await git(root, ['ls-files', '--stage', '-z']))
  if (staged.split('\0').some(record => record.startsWith('160000 '))) fail('GIT_SUBMODULE_UNSUPPORTED', 'tracked Git submodules are unsupported; export refused before recursive status')
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  decode(status)
  return { head, statusBase64: status.toString('base64'), statusSha256: sha(status), originalWorktreeClean: status.length === 0,
    index: { path: indexPath, sha256: index.sha256, identity: index.fact } }
}
async function ignoreAdmission(root, inputs) {
  const result = decode(await git(root, ['check-ignore', '--no-index', '-z', '--stdin'], inputs.map(input => `${input.path}\0`).join('')))
  const ignored = new Set(result.split('\0').filter(Boolean))
  const selected = new Set(inputs.map(input => input.path))
  return inputs.map(input => {
    safeRelative(input.path)
    const ignoredCategory = ignored.has(input.path) ? ignoredBuildInputCategory(input.path) : null
    if (ignored.has(input.path) && !ignoredCategory) fail('IGNORED_INPUT_FORBIDDEN', `unapproved ignored release input: ${input.path}`)
    if (ignored.has(input.path) && input.path.includes('/lib/') && !selected.has(`${input.path.split('/lib/')[0]}/package.json`)) fail('IGNORED_INPUT_FORBIDDEN', `compiled input has no selected package manifest: ${input.path}`)
    return { ...input, ignored: ignored.has(input.path), ignoredCategory }
  })
}
async function capture(root) {
  const gitBefore = await gitFacts(root)
  const listing = await collectReleaseSourceInputs(root)
  const support = []
  for (const path of SUPPORT) {
    try { await lstat(join(root, path)); support.push({ path, projectedPath: null, projection: 'build-support' }) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const inputs = await ignoreAdmission(root, [...listing.inputs, ...support].sort((a, b) => a.path.localeCompare(b.path)))
  if (new Set(inputs.map(input => input.path)).size !== inputs.length) fail('DUPLICATE_INPUT', 'release collector returned duplicate source paths')
  const directories = new Set(listing.directories)
  for (const input of inputs) {
    const parts = input.path.split('/').slice(0, -1)
    for (let index = 1; index <= parts.length; index++) directories.add(parts.slice(0, index).join('/'))
  }
  const directoryFacts = new Map([['', await directory(root)]])
  for (const path of [...directories].sort()) { safeRelative(path); directoryFacts.set(path, await directory(join(root, path))) }
  const files = []
  for (const input of inputs) {
    const read = await readStable(root, input.path)
    files.push({ ...input, bytes: read.bytes.length, sha256: read.sha256, mode: read.fact.mode, identity: read.fact })
  }
  // All path/ignore checks precede any projection read. Hashing is still done
  // by the actual release collector, including desktop package projection.
  const projected = await collectReleaseSourceInputs(root, { includeDigests: true })
  if (!equal(listing.inputs, projected.inputs) || !equal(listing.directories, projected.directories)) fail('SOURCE_CHANGED', 'release input list changed while capturing')
  const gitAfter = await gitFacts(root)
  if (!equal(gitBefore, gitAfter)) fail('SOURCE_CHANGED', 'Git provenance changed while capturing')
  await assertDirectories(root, directoryFacts)
  return { files, directoryFacts, git: gitBefore, projectedEntries: projected.projectedEntries,
    inputPaths: listing.inputs, directoryPaths: listing.directories }
}
function inventoryDigest(files) {
  return sha(JSON.stringify(files.map(file => [file.path, file.bytes, file.sha256, file.mode])))
}
async function writeOwned(path, bytes, mode = 0o600) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync() }
  finally { await handle.close() }
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function destinationInventory(root) {
  const files = [], directories = []
  async function walk(path) {
    for (const name of (await readdir(join(root, path))).sort()) {
      const rel = path ? `${path}/${name}` : name
      if (rel === META) continue
      safeRelative(rel)
      const info = await lstat(join(root, rel))
      if (info.isDirectory() && !info.isSymbolicLink()) { directories.push({ path: rel, mode: (await directory(join(root, rel))).mode }); await walk(rel) }
      else { const read = await readStable(root, rel); files.push({ path: rel, bytes: read.bytes.length, sha256: read.sha256, mode: read.fact.mode }) }
    }
  }
  await walk('')
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), directories: directories.sort((a, b) => a.path.localeCompare(b.path)) }
}
function optionsOf(options) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).some(key => !['repositoryRoot', 'outputDirectory'].includes(key))) fail('INVALID_OPTIONS', 'only repositoryRoot and outputDirectory are accepted')
  for (const key of ['repositoryRoot', 'outputDirectory']) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') fail('INVALID_OPTIONS', 'candidate paths must be plain string values')
  }
  return options
}
async function exportCandidate(options, checkpoint = async () => {}) {
  assertCandidatePlatform()
  const { repositoryRoot, outputDirectory } = optionsOf(options)
  const source = await canonicalDirectory(repositoryRoot)
  if (!isAbsolute(outputDirectory) || resolve(outputDirectory) !== outputDirectory) fail('INVALID_TARGET', 'target must be a new absolute directory')
  const parent = await canonicalDirectory(dirname(outputDirectory))
  if (inside(source, outputDirectory) || inside(outputDirectory, source)) fail('OVERLAPPING_TARGET', 'source and candidate directories must not overlap')
  try { await lstat(outputDirectory); fail('EEXIST', 'candidate target already exists') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const parentIdentity = await directory(parent)
  const captureBefore = await capture(source)
  await checkpoint('after-capture', { source, target: outputDirectory })
  if (!equal(await directory(parent), parentIdentity)) fail('DIRECTORY_CHANGED', 'target parent changed')
  await mkdir(outputDirectory, { mode: 0o700 }) // exclusive; never adopt an existing directory
  await chmod(outputDirectory, 0o700)
  const targetIdentity = await directory(outputDirectory)
  const metadata = join(outputDirectory, META)
  await mkdir(metadata, { mode: 0o700 })
  const metadataIdentity = await directory(metadata)
  const targetDirectories = new Map([['', targetIdentity]])
  const manifestPath = join(metadata, 'manifest.json')
  const runId = randomUUID(), startedAt = new Date().toISOString()
  const boundary = { cleanReleaseReady: false, gitInitialized: false, dependenciesInstalled: false, build: 'not-run', signing: 'not-run', installation: 'not-run', versionPair: 'not-established' }
  await writeOwned(manifestPath, JSON.stringify({ schema: 'xiaoshe-candidate-bytes/v1', status: 'incomplete', runId, startedAt, ...boundary }) + '\n')
  let currentManifestIdentity = (await readStable(metadata, 'manifest.json')).fact
  let published = false
  const assertOwned = async () => {
    if (!equal(await directory(parent), parentIdentity) || !equal(await directory(outputDirectory), targetIdentity)
      || !equal(await directory(metadata), metadataIdentity)) fail('DIRECTORY_CHANGED', 'candidate ownership changed')
    await readStable(metadata, 'manifest.json', currentManifestIdentity)
  }
  try {
    const directories = [...captureBefore.directoryFacts].filter(([path]) => path).sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    for (const [path] of directories) {
      await assertOwned()
      const ancestors = await parents(outputDirectory, path)
      for (const [name, fact] of ancestors) if (!equal(fact, targetDirectories.get(name))) fail('DIRECTORY_CHANGED', 'candidate ancestor changed before mkdir')
      await mkdir(join(outputDirectory, path), { mode: 0o700 })
      targetDirectories.set(path, await directory(join(outputDirectory, path)))
    }
    for (const file of captureBefore.files) {
      await checkpoint('before-copy-file', { source, target: outputDirectory, path: file.path })
      await assertOwned()
      const read = await readStable(source, file.path, file.identity, captureBefore.directoryFacts)
      if (read.sha256 !== file.sha256) fail('SOURCE_CHANGED', `candidate bytes changed: ${file.path}`)
      const ancestors = await parents(outputDirectory, file.path)
      for (const [name, fact] of ancestors) if (!equal(fact, targetDirectories.get(name))) fail('DIRECTORY_CHANGED', 'candidate ancestor changed before write')
      await writeOwned(join(outputDirectory, file.path), read.bytes, file.mode)
      await assertDirectories(outputDirectory, ancestors)
      await checkpoint('after-copy-file', { source, target: outputDirectory, path: file.path })
    }
    // Preserve source directory modes inside the private root, after writing.
    await assertDirectories(outputDirectory, targetDirectories)
    for (const [path, fact] of [...directories].reverse()) {
      await chmod(join(outputDirectory, path), fact.mode); await syncDirectory(join(outputDirectory, path))
      targetDirectories.set(path, await directory(join(outputDirectory, path)))
    }
    await checkpoint('before-final-check', { source, target: outputDirectory })
    await assertOwned()
    const finalSource = await capture(source)
    if (!equal(captureBefore.files, finalSource.files) || !equal(captureBefore.git, finalSource.git)
      || !equal(captureBefore.projectedEntries, finalSource.projectedEntries)
      || !equal([...captureBefore.directoryFacts], [...finalSource.directoryFacts])) fail('SOURCE_CHANGED', 'source changed during candidate export')
    const actual = await destinationInventory(outputDirectory)
    const expectedFiles = captureBefore.files.map(({ path, bytes, sha256, mode }) => ({ path, bytes, sha256, mode }))
    const expectedDirectories = directories.map(([path, fact]) => ({ path, mode: fact.mode })).sort((a, b) => a.path.localeCompare(b.path))
    if (!equal(actual.files, expectedFiles) || !equal(actual.directories, expectedDirectories)) fail('COPY_MISMATCH', 'candidate raw byte/mode inventory differs from source')
    const projectedCopy = await collectReleaseSourceInputs(outputDirectory, { includeDigests: true })
    if (!equal(projectedCopy.projectedEntries, captureBefore.projectedEntries)) fail('COPY_MISMATCH', 'candidate release projection differs from source')
    await checkpoint('before-publish', { source, target: outputDirectory })
    await assertOwned()
    // Recheck after the final barrier; neither a callback nor a late filesystem
    // mutation may turn the earlier measurement into an unchecked success.
    if (!equal(await destinationInventory(outputDirectory), actual)) fail('COPY_MISMATCH', 'candidate changed before publication')
    const last = await capture(source)
    if (!equal(last.files, captureBefore.files) || !equal(last.git, captureBefore.git)
      || !equal(last.projectedEntries, captureBefore.projectedEntries) || !equal([...last.directoryFacts], [...captureBefore.directoryFacts])) fail('SOURCE_CHANGED', 'source changed before publication')
    const manifest = { schema: 'xiaoshe-candidate-bytes/v1', status: 'candidate-bytes-saved-not-clean', runId, startedAt, finishedAt: new Date().toISOString(),
      ...boundary, repositoryRoot: source, outputDirectory, provenance: captureBefore.git,
      sourceRootMode: captureBefore.directoryFacts.get('').mode, candidateRootMode: 0o700,
      rawInventory: { files: expectedFiles.length, sha256: inventoryDigest(expectedFiles), entries: captureBefore.files },
      directories: expectedDirectories, releaseProjection: { files: captureBefore.projectedEntries.length,
        sha256: sha(JSON.stringify(captureBefore.projectedEntries.map(entry => [entry.path, entry.bytes, entry.sha256]))), entries: captureBefore.projectedEntries },
      supportAllowlist: SUPPORT, boundary: 'Local bytes only; original dirty worktree is preserved. No clean release, build, signature, installation or A/B compatibility is established.' }
    // The manifest attests measured bytes, not successful final directory
    // durability. A post-rename sync failure is separately marked incomplete.
    const manifestBytes = JSON.stringify(manifest, null, 2) + '\n'
    await writeOwned(join(metadata, 'manifest.pending'), manifestBytes)
    await assertOwned()
    await rename(join(metadata, 'manifest.pending'), manifestPath)
    const written = await readStable(metadata, 'manifest.json')
    if (written.sha256 !== sha(manifestBytes)) fail('MANIFEST_CHANGED', 'published candidate manifest changed')
    currentManifestIdentity = written.fact; published = true
    await checkpoint('after-manifest-publication', { source, target: outputDirectory })
    await syncDirectory(metadata); await syncDirectory(outputDirectory); await syncDirectory(parent)
    return manifest
  } catch (error) {
    // Do not delete or recursively repair a possibly replaced directory. The
    // initial incomplete manifest survives, and owned failures get a receipt.
    try {
      await assertOwned()
      const failure = { status: 'incomplete', runId, code: error.code ?? 'EXPORT_FAILED', cleanReleaseReady: false,
        manifestPublished: published, directoryDurability: published ? 'unknown' : 'not-published' }
      await writeOwned(join(metadata, 'failure.json'), JSON.stringify(failure) + '\n')
      if (published) {
        await writeOwned(join(metadata, 'manifest.incomplete'), JSON.stringify({ schema: 'xiaoshe-candidate-bytes/v1', ...failure, ...boundary, startedAt }) + '\n')
        await assertOwned(); await rename(join(metadata, 'manifest.incomplete'), manifestPath)
      }
      await syncDirectory(metadata)
    } catch { /* Ownership uncertain: preserve and report, never overwrite. */ }
    throw error
  }
}

export function exportCleanCandidate(options) { return exportCandidate(options) }
/** Deterministic filesystem race tests only; never accepted by the CLI/API. */
export function exportCleanCandidateForTest(options, checkpoint) {
  if (!process.env.NODE_TEST_CONTEXT || typeof checkpoint !== 'function') fail('TEST_ONLY', 'filesystem checkpoints are only available to the Node test runner')
  return exportCandidate(options, checkpoint)
}
export async function candidateCli(args) {
  if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--output') fail('CLI_USAGE', 'Usage: node scripts/release/export-clean-candidate.mjs --source <canonical-repository> --output <new-canonical-directory>')
  const manifest = await exportCleanCandidate({ repositoryRoot: args[1], outputDirectory: args[3] })
  return { status: manifest.status, cleanReleaseReady: false, files: manifest.rawInventory.files, sha256: manifest.rawInventory.sha256,
    manifest: join(manifest.outputDirectory, META, 'manifest.json'), summary: '候选原字节已保存；尚不是 clean release，未安装依赖、提交 Git、构建、签名或验证 A/B。' }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  candidateCli(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify({ status: 'failed', cleanReleaseReady: false, code: error.code ?? 'EXPORT_FAILED', message: error.message }))
    process.exitCode = 1
  })
}
