/** Copy the current source bytes for another device, without Git history or local state.
 * The plan is reviewable JSON. A copy requires its SHA-256 and an existing empty
 * destination; failures leave partial files for inspection and never erase them.
 * This is an integrity check for a local handoff, not a signed release or sandbox.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const MANIFEST = 'handoff-manifest.json'
const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const MAX_FILES = 100_000
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sorted = entries => [...entries].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
const inside = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
function fail(code, message) { throw Object.assign(new Error(message), { code }) }

/** Reject paths that could escape, alias another file, or break on the receiving Windows device. */
function safePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || isAbsolute(path)
    || /[\x00-\x1f\x7f<>:"|?*]/u.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    fail('UNSAFE_PATH', `unsafe portable path: ${JSON.stringify(path)}`)
  }
  return path
}

const omittedDirectories = new Set([
  '.git', 'node_modules', '.superpowers', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.cache', '.pnpm-store', '.turbo', '.vitest', '.vite', '.venv', 'venv',
  'coverage', '.credentials', '.dsh', '.xiaoshe', '.state', '.session', '.sessions',
  '.storages', '.worktrees', '.playwright-mcp', '.dsh-build', '.desktop-build',
])
const omittedRoots = new Set(['artifacts', 'output', '_验收', '.superpowers', 'runtime-state', 'var'])
const currentDesignDocs = new Set([
  'docs/superpowers/specs/2026-09-20-loop-graph-design.md',
  'docs/superpowers/plans/2026-09-20-loop-graph.md',
])

/** Select source by its role, not Git status or broad words such as "legacy", "lib" or "credentials". */
function exclusion(path, directory) {
  const parts = path.split('/')
  const name = parts.at(-1)
  if (omittedRoots.has(parts[0])) return 'local-output-or-private-history'
  // This checked-in snapshot contains only synthetic Skill fixtures used by the
  // session replay suite. It is not a device Profile, despite its directory name.
  if (omittedDirectories.has(name) && path !== 'runtime/DSH/snapshots/session/skill-load/workspace/.dsh') return 'dependency-cache-or-private-state'
  if (path === '_接收记录.md') return 'superseded-handoff-record'
  if (path.startsWith('docs/superpowers/') && !directory && !currentDesignDocs.has(path)) return 'superseded-design-history'
  if (directory && (name === 'logs' || name === 'output' || name === '.artifacts')) return 'local-output'
  if (directory && (path === 'dist' || /^apps\/[^/]+\/dist-desktop$/u.test(path)
    || /^(?:packages\/[^/]+|runtime\/DSH\/(?:packages\/[^/]+\/[^/]+|vendor\/[^/]+|apps\/[^/]+|native\/(?:system|landlock-run)(?:\/packages\/[^/]+)?))\/(?:lib|dist)$/u.test(path)
    || /^(?:packages\/[^/]+\/test|runtime\/DSH\/native\/system)\/\.generated$/u.test(path)
    || path === 'runtime/DSH/dist' || path === 'runtime/DSH/dist-exe'
    || path === 'runtime/DSH/native/system/.release' || path === 'runtime/DSH/native/system/test/bin')) return 'generated-build-output'
  if (/^\.env(?:\.|$)/iu.test(name) && name !== '.env.example') return 'local-credentials'
  if (/^(?:\.credentials(?:\..+)?|credentials\.local\..+|secrets\.local\..+|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc)$/iu.test(name)
    || /\.(?:pem|key|p12|pfx|kdbx)$/iu.test(name)) return 'local-credentials'
  if (/\.(?:log|status|tmp|bak|pyc|pyo|tsbuildinfo)$/iu.test(name)
    || ['.DS_Store', 'Thumbs.db', '.last-token', '.last-port', 'server-info', 'server-instance-id', 'ui_token'].includes(name)) return 'transient-state'
  // Dependency locks (pnpm-lock.yaml, uv.lock) and test fixtures remain source.
  if (/\.(?:pid|tgz|tar\.gz|zip|7z|dmg|msi)$/iu.test(name)) return 'local-archive-or-runtime-state'
  return null
}

function fact(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':')
}

async function safeDirectory(path) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_LINK', `directory is a link or not a real directory: ${path}`)
  return info
}

async function canonicalRoot(input) {
  if (typeof input !== 'string' || !isAbsolute(input)) fail('UNSAFE_ROOT', 'source and destination must be absolute canonical directory paths')
  const root = resolve(input)
  if (root === parse(root).root) fail('UNSAFE_ROOT', 'a filesystem root is not a handoff directory')
  await safeDirectory(root)
  if (relative(root, await realpath(root)) !== '') fail('UNSAFE_LINK', 'root must be canonical, without symbolic links or junctions')
  return root
}

async function parentFacts(root, path) {
  const parents = [['', await safeDirectory(root)]]
  let current = ''
  for (const part of safePath(path).split('/').slice(0, -1)) {
    current = current ? `${current}/${part}` : part
    parents.push([current, await safeDirectory(join(root, current))])
  }
  return parents.map(([path, info]) => [path, `${info.dev}:${info.ino}`])
}

/** Check a file and its ancestors on both sides of an actual handle read. No excluded file is opened. */
async function readStable(root, path, maxFileBytes = MAX_FILE_BYTES) {
  const parents = await parentFacts(root, path)
  const absolute = join(root, path)
  const before = await lstat(absolute, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) fail('UNSAFE_LINK', `selected source is a link or special file: ${path}`)
  if (before.size > BigInt(maxFileBytes)) fail('SIZE_LIMIT', `file exceeds size limit: ${path}`)
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW ?? 0)
  const handle = await open(absolute, flags)
  try {
    if (fact(await handle.stat({ bigint: true })) !== fact(before)) fail('SOURCE_CHANGED', `file changed before read: ${path}`)
    const bytes = await handle.readFile()
    if (bytes.length !== Number(before.size) || fact(await handle.stat({ bigint: true })) !== fact(before)
      || fact(await lstat(absolute, { bigint: true })) !== fact(before)
      || !same(parents, await parentFacts(root, path))) fail('SOURCE_CHANGED', `file changed while reading: ${path}`)
    return { bytes, size: bytes.length, sha256: hash(bytes), executable: (before.mode & 0o111n) !== 0n }
  } finally { await handle.close() }
}

async function listSource(root) {
  const files = [], excluded = [], seen = new Set()
  async function walk(path = '', depth = 0) {
    if (depth > 64) fail('PATH_DEPTH_LIMIT', 'source directory nesting exceeds 64')
    const directory = join(root, path)
    await safeDirectory(directory)
    for (const name of sorted(await readdir(directory))) {
      const child = path ? `${path}/${name}` : name
      safePath(child)
      const info = await lstat(join(root, child))
      const reason = exclusion(child, info.isDirectory())
      if (reason) { excluded.push({ path: child, reason, directory: info.isDirectory() }); continue }
      if (info.isSymbolicLink()) fail('UNSAFE_LINK', `unexpected selected link or junction: ${child}`)
      const key = child.normalize('NFC').toLowerCase()
      if (seen.has(key)) fail('PATH_COLLISION', `portable path collision: ${child}`)
      seen.add(key)
      if (info.isDirectory()) await walk(child, depth + 1)
      else if (info.isFile()) {
        if (child === MANIFEST) fail('RESERVED_PATH', `source contains reserved ${MANIFEST}`)
        files.push(child)
        if (files.length > MAX_FILES) fail('FILE_COUNT_LIMIT', 'source file count exceeds limit')
      } else fail('UNSAFE_LINK', `selected source is a special file: ${child}`)
    }
  }
  await walk()
  return { files: sorted(files), excluded: excluded.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }
}

async function sourceHead(root) {
  // Only provenance: rev-parse neither invokes status filters nor reads credentials.
  try { await lstat(join(root, '.git')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', root, 'rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_OPTIONAL_LOCKS: '0' },
  })
  const head = result.status === 0 ? result.stdout.trim() : ''
  return /^[a-f0-9]{40}$/u.test(head) ? head : null
}

const sourceDigest = files => hash(Buffer.from(JSON.stringify(files)))

/** Return every selected path and hash plus pruned paths/reasons, without writing or reading excluded content. */
export async function planSource(input, { maxFileBytes = MAX_FILE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0 || maxFileBytes > MAX_FILE_BYTES) fail('SIZE_LIMIT', 'invalid file size limit')
  const root = await canonicalRoot(input)
  const listing = await listSource(root)
  const files = []
  let bytes = 0
  for (const path of listing.files) {
    const file = await readStable(root, path, maxFileBytes)
    files.push({ path, bytes: file.size, sha256: file.sha256 })
    bytes += file.size
    if (bytes > MAX_TOTAL_BYTES) fail('SIZE_LIMIT', 'source total bytes exceed 2 GiB limit')
  }
  if (!same(listing, await listSource(root))) fail('SOURCE_CHANGED', 'source file list changed during planning')
  return { kind: 'xiaoshe-source-handoff-plan', schemaVersion: 1, sourceHead: await sourceHead(root),
    fileCount: files.length, bytes, sourceSha256: sourceDigest(files), files, excluded: listing.excluded }
}

async function createParents(root, path) {
  let current = ''
  for (const part of safePath(path).split('/').slice(0, -1)) {
    current = current ? `${current}/${part}` : part
    const absolute = join(root, current)
    try { await mkdir(absolute) } catch (error) { if (error.code !== 'EEXIST') throw error }
    await safeDirectory(absolute)
    if (relative(absolute, await realpath(absolute)) !== '') fail('UNSAFE_LINK', 'destination ancestor is not canonical')
  }
}

async function writeExclusive(root, path, bytes, mode = 0o644) {
  await createParents(root, path)
  const parents = await parentFacts(root, path)
  const handle = await open(join(root, path), 'wx', mode)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    if (!same(parents, await parentFacts(root, path))) fail('DESTINATION_CHANGED', 'destination ancestor changed while writing')
  } finally { await handle.close() }
}

/** A reviewed byte snapshot is copied only to an empty, disjoint directory. Never overwrites or deletes. */
export async function copySource({ source, destination, expectedSha256 }) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '')) fail('REVIEW_REQUIRED', 'copy requires the reviewed plan --expected-sha256')
  const root = await canonicalRoot(source)
  const target = await canonicalRoot(destination)
  if (inside(root, target) || inside(target, root)) fail('OVERLAPPING_ROOTS', 'source and destination must be disjoint, without overlap')
  if ((await readdir(target)).length) fail('DESTINATION_NOT_EMPTY', 'destination must be empty; nothing was overwritten')
  const plan = await planSource(root)
  if (plan.sourceSha256 !== expectedSha256) fail('REVIEW_CHANGED', 'source differs from the reviewed plan SHA-256; review a fresh plan')
  for (const file of plan.files) {
    const actual = await readStable(root, file.path)
    if (actual.sha256 !== file.sha256 || actual.size !== file.bytes) fail('SOURCE_CHANGED', `source changed after review: ${file.path}`)
    await writeExclusive(target, file.path, actual.bytes, actual.executable ? 0o755 : 0o644)
  }
  const after = await planSource(root)
  if (after.sourceSha256 !== plan.sourceSha256 || !same(after.excluded, plan.excluded) || after.sourceHead !== plan.sourceHead) {
    fail('SOURCE_CHANGED', 'source changed during copy; no completed manifest was written')
  }
  await verifyFiles(target, plan.files)
  const manifest = { ...plan, kind: 'xiaoshe-source-handoff', createdAt: new Date().toISOString(),
    assurance: 'Current source snapshot only. No Git history, installed dependencies, credentials or release approval.' }
  await writeExclusive(target, MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
  await verifyHandoff(target)
  return manifest
}

/** Walk every received path, including normally excluded names: an injected .env must fail verification. */
async function verifyFiles(root, files, hasManifest = false) {
  const allowedFiles = new Set(files.map(file => file.path))
  if (hasManifest) allowedFiles.add(MANIFEST)
  const allowedDirectories = new Set()
  for (const file of files) {
    const parts = file.path.split('/')
    for (let count = 1; count < parts.length; count++) allowedDirectories.add(parts.slice(0, count).join('/'))
  }
  const found = new Set()
  async function walk(path = '') {
    await safeDirectory(join(root, path))
    for (const name of await readdir(join(root, path))) {
      const child = safePath(path ? `${path}/${name}` : name)
      const info = await lstat(join(root, child))
      if (info.isSymbolicLink()) fail('UNSAFE_LINK', `received link or junction: ${child}`)
      if (info.isDirectory()) {
        if (!allowedDirectories.has(child)) fail('UNEXPECTED_PATH', `unexpected received directory: ${child}`)
        await walk(child)
      } else if (info.isFile()) {
        if (!allowedFiles.has(child)) fail('UNEXPECTED_PATH', `unexpected received file: ${child}`)
        found.add(child)
      } else fail('UNSAFE_LINK', `received special file: ${child}`)
    }
  }
  await walk()
  for (const path of allowedFiles) if (!found.has(path)) fail('MISSING_FILE', `missing received file: ${path}`)
  for (const expected of files) {
    const actual = await readStable(root, expected.path)
    if (actual.size !== expected.bytes || actual.sha256 !== expected.sha256) fail('HASH_MISMATCH', `received file size/hash mismatch: ${expected.path}`)
  }
  // Re-enumerate to catch additions/replacements while the hashes were read.
  found.clear()
  await walk()
  for (const path of allowedFiles) if (!found.has(path)) fail('MISSING_FILE', `missing received file: ${path}`)
}

function validateManifest(manifest) {
  if (!manifest || manifest.kind !== 'xiaoshe-source-handoff' || manifest.schemaVersion !== 1
    || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES
    || manifest.fileCount !== manifest.files.length || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0
    || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
    || !(manifest.sourceHead === null || /^[a-f0-9]{40}$/u.test(manifest.sourceHead))
    || !Array.isArray(manifest.excluded) || !/^[a-f0-9]{64}$/u.test(manifest.sourceSha256)) fail('INVALID_MANIFEST', 'invalid handoff manifest')
  const seen = new Set()
  let bytes = 0
  for (const file of manifest.files) {
    safePath(file?.path)
    if (file.path === MANIFEST || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES
      || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? '')) fail('INVALID_MANIFEST', 'invalid manifest file record')
    const key = file.path.normalize('NFC').toLowerCase()
    if (seen.has(key)) fail('INVALID_MANIFEST', 'duplicate or case-colliding manifest path')
    seen.add(key)
    bytes += file.bytes
  }
  if (bytes > MAX_TOTAL_BYTES || bytes !== manifest.bytes || sourceDigest(manifest.files) !== manifest.sourceSha256) {
    fail('INVALID_MANIFEST', 'manifest size or source digest mismatch')
  }
}

/** Verify a copied tree using its manifest alone; the original machine and Git are unnecessary. */
export async function verifyHandoff(input) {
  if (typeof input !== 'string' || !input.trim()) fail('UNSAFE_ROOT', 'verification requires a destination directory')
  const root = await canonicalRoot(resolve(input))
  const receipt = await readStable(root, MANIFEST, MAX_MANIFEST_BYTES)
  let manifest
  try { manifest = JSON.parse(receipt.bytes.toString('utf8')) }
  catch { fail('INVALID_MANIFEST', 'handoff manifest is not valid JSON') }
  validateManifest(manifest)
  await verifyFiles(root, manifest.files, true)
  if ((await readStable(root, MANIFEST, MAX_MANIFEST_BYTES)).sha256 !== receipt.sha256) fail('SOURCE_CHANGED', 'manifest changed during verification')
  return { verified: true, fileCount: manifest.fileCount, bytes: manifest.bytes,
    sourceSha256: manifest.sourceSha256, sourceHead: manifest.sourceHead }
}

async function main() {
  const { values, positionals } = parseArgs({ options: {
    source: { type: 'string' }, destination: { type: 'string' }, 'expected-sha256': { type: 'string' },
  }, allowPositionals: true, strict: true })
  if (positionals.length !== 1 || !['plan', 'copy', 'verify'].includes(positionals[0])) {
    fail('USAGE', 'usage: handoff-source.mjs plan --source ABS | copy --source ABS --destination ABS --expected-sha256 SHA | verify --destination ABS')
  }
  const mode = positionals[0]
  const result = mode === 'plan' ? await planSource(values.source)
    : mode === 'copy' ? await copySource({ source: values.source, destination: values.destination, expectedSha256: values['expected-sha256'] })
      : await verifyHandoff(values.destination)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.code ?? 'HANDOFF_FAILED'}: ${error.message}\n`)
    process.exitCode = 1
  })
}
