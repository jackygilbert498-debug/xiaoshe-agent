/** Offline isolated installer. Only public package code is read/copied; never
 * auth contents, daily Profile configuration, npm, CLI or network execution. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { patchSource } from '../patch-modlens-runtime.mjs'
import { CODEX_SCHEMA_FILE, createCodexSchemaArtifact } from '../modlens-codex-schema.mjs'
import { patchVisionRuntime } from './vision-runtime-patch.mjs'
import { createVisionEngineRuntime } from './vision-engine-runtime.mjs'

export const PUBLIC_MODLENS_ROOT = '/Users/zfy/.dsh/profiles/web/node_modules/@liustack/modlens'
const PUBLIC_MODULES_ROOT = dirname(dirname(PUBLIC_MODLENS_ROOT))
const SHA = /^[a-f0-9]{64}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => Object.assign(new Error(`vision-install: ${code}`), { code })
const within = (root, path) => { const part = relative(root, path); return !!part && !part.startsWith('..') && !isAbsolute(part) }
const stamp = () => new Date().toISOString()
async function safeFile(path, limit = 16 * 1024 * 1024) {
  const before = await fs.lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit || await fs.realpath(path) !== path) throw fail('unsafe_file')
  const fd = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await fd.stat(), bytes = await fd.readFile(), after = await fd.stat()
    if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== bytes.length || before.mtimeMs !== after.mtimeMs) throw fail('source_changed')
    return bytes
  } finally { await fd.close() }
}
async function directory(path, { private: privateMode = false } = {}) {
  const stat = await fs.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(path) !== path
    || privateMode && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())) throw fail('unsafe_directory')
  return stat
}
async function ownedDirectory(root, target) {
  if (!within(root, target)) throw fail('unsafe_target')
  let current = root
  for (const part of relative(root, target).split('/')) {
    current = join(current, part)
    try { await fs.mkdir(current, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    await directory(current)
  }
}
async function exclusive(path, bytes) {
  const fd = await fs.open(path, 'wx', 0o600)
  try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
}
const exclusiveJson = (path, value) => exclusive(path, `${JSON.stringify(value)}\n`)

/** Read-only public snapshot seam, also used to test unsafe source rejection. */
export async function snapshotVisionPublicFiles(root, starts) {
  await directory(root)
  const rows = []; let bytes = 0
  const walk = async relativePath => {
    if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) || relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw fail('unsafe_public_path')
    const path = join(root, relativePath), stat = await fs.lstat(path)
    if (stat.isSymbolicLink()) throw fail('public_symlink')
    if (stat.isDirectory()) { await directory(path); for (const name of (await fs.readdir(path)).sort()) await walk(`${relativePath}/${name}`); return }
    if (/^(?:\.env(?:\..*)?|auth\.json|config\.toml|\.credentials.*)$/u.test(basename(path))) throw fail('nonpublic_file')
    const content = await safeFile(path); bytes += content.length
    if (rows.length >= 4000 || bytes > 64 * 1024 * 1024) throw fail('public_snapshot_too_large')
    rows.push({ path: relativePath, bytes: content.length, sha256: hash(content), content })
  }
  for (const start of starts) await walk(start)
  if (new Set(rows.map(row => row.path)).size !== rows.length) throw fail('overlapping_public_paths')
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}
const manifestRows = rows => rows.map(({ content, ...row }) => row)
async function unchanged(root, rows) {
  for (const row of rows) if (hash(await safeFile(join(root, row.path))) !== row.sha256) throw fail('public_source_changed')
}
async function absent(path) {
  try { await fs.lstat(path); throw fail('target_already_exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
}

/** Narrow wrapper seam. Installed code supplies the known product runner; this
 * is not configurable through a model, Profile row, request or environment. */
export async function captureVisionEnvelope(binding, runner, command, args, signal, timeoutMs) {
  const rootStat = await directory(binding.acceptanceRoot, { private: true })
  if (rootStat.dev !== binding.rootDevice || rootStat.ino !== binding.rootInode) throw fail('acceptance_root_changed')
  await directory(binding.envelopeDirectory, { private: true })
  const input = args?.[2]
  if (signal?.aborted) throw fail('VISION_CANCELLED')
  if (!Array.isArray(args) || ![5, 7].includes(args.length) || args[0] !== binding.cli.path || args[1] !== '-i'
    || args[3] !== '--timeout' || args[4] !== String(timeoutMs) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || args.length === 7 && (args[5] !== '--prompt' || typeof args[6] !== 'string' || args[6].length > 20000)
    || !isAbsolute(input ?? '') || !within(binding.acceptanceRoot, input) || command !== binding.executable.path) throw fail('outer_invocation_not_allowed')
  if (hash(await safeFile(command, 512 * 1024 * 1024)) !== binding.executable.sha256
    || hash(await safeFile(binding.cli.path)) !== binding.cli.sha256
    || hash(await safeFile(input)) !== binding.imageSha256) throw fail('outer_identity_changed')
  const startedAt = stamp()
  // A failed/partial reservation is deliberately not deleted. Every second
  // outer invocation fails before spawning, including after host restart.
  await exclusiveJson(join(binding.envelopeDirectory, 'reserved-1.json'), { runId: binding.runId, sessionId: binding.sessionId, ordinal: 1, startedAt })
  let value, error, output = null
  try {
    value = await runner(command, args, signal, timeoutMs)
    if (value.code !== 0) error = fail('MODLENS_EXIT_FAILED')
    else {
      try { output = JSON.parse(value.stdout) } catch { throw fail('outer_invalid_json') }
      if (output?.image !== input || output.provider !== 'codex-cli' || output.meta?.model !== binding.model) throw fail('outer_output_identity_changed')
      if (hash(await safeFile(input)) !== binding.imageSha256) throw fail('outer_input_changed')
    }
  } catch (cause) { error = cause }
  const raw = value?.stdout ?? '', cleanup = value?.cleanup ?? error?.cleanup ?? { status: 'unconfirmed' }
  if (cleanup.status !== 'confirmed' || cleanup.confirmedBy !== 'ESRCH' || !Number.isSafeInteger(cleanup.groupId) || cleanup.groupId <= 1) error ??= fail('outer_cleanup_unconfirmed')
  const receipt = { schema: 'xiaoshe-vision-envelope/v1', runId: binding.runId, sessionId: binding.sessionId, ordinal: 1,
    pid: cleanup.groupId ?? null, startedAt, finishedAt: stamp(), exitCode: value?.code ?? error?.exitCode ?? null,
    inputPath: input, inputSha256: binding.imageSha256, executable: binding.executable, cli: binding.cli, cleanup,
    rawStdoutSha256: hash(raw), output, errorCode: error ? error.code ?? 'outer_runner_failed' : null,
    stderrBytes: Buffer.byteLength(value?.stderr ?? ''), stderrSha256: hash(value?.stderr ?? '') }
  // Both files must be durable before the product sees a successful tool value.
  // No stderr content or exception message is persisted or sent to the model.
  await exclusive(join(binding.envelopeDirectory, 'stdout-1.json'), raw)
  await exclusiveJson(join(binding.envelopeDirectory, 'receipt-1.json'), receipt)
  if (error) throw error
  return value
}

export async function installIsolatedVision(input) {
  const keys = ['productRoot', 'acceptanceRoot', 'profileRoot', 'runId', 'sessionId', 'imageSha256', 'model', 'executable', 'authHome']
  if (!input || Object.keys(input).sort().join(',') !== keys.sort().join(',') || !UUID.test(input.runId ?? '')
    || input.sessionId !== `xiaoshe-vision-${input.runId}` || !SHA.test(input.imageSha256 ?? '')
    || typeof input.model !== 'string' || !/^[\w.-]{1,200}$/u.test(input.model)
    || ['productRoot', 'acceptanceRoot', 'profileRoot', 'executable', 'authHome'].some(key => !isAbsolute(input[key] ?? '') || resolve(input[key]) !== input[key])) throw fail('invalid_config')
  const { productRoot, acceptanceRoot, profileRoot, runId, sessionId } = input
  if (dirname(acceptanceRoot) !== await fs.realpath(tmpdir()) || basename(acceptanceRoot) !== `xiaoshe-product-acceptance-${runId}`
    || profileRoot !== join(acceptanceRoot, 'dsh-home/profiles/web') || input.executable === input.authHome
    || within(input.authHome, input.executable)) throw fail('invalid_isolated_identity')
  const rootStat = await directory(acceptanceRoot, { private: true })
  await directory(productRoot); await directory(profileRoot)
  const modules = join(profileRoot, 'node_modules'), packageRoot = join(modules, '@liustack/modlens')
  const targets = [packageRoot, join(modules, 'commander'), join(modules, 'undici')]
  for (const target of targets) await absent(target)
  await absent(join(acceptanceRoot, 'vision-install.json'))
  // Only public package files: no containing Profile tree, settings or auth.
  const modlens = await snapshotVisionPublicFiles(PUBLIC_MODLENS_ROOT, ['package.json', 'dist/main.js', 'dsh'])
  const metadata = JSON.parse(modlens.find(row => row.path === 'package.json').content)
  if (metadata.name !== '@liustack/modlens' || metadata.version !== '3.22.0'
    || JSON.stringify(metadata.dependencies) !== JSON.stringify({ commander: '^13.1.0', undici: '^8.10.0' })) throw fail('unsupported_public_package')
  const packages = [{ name: metadata.name, version: metadata.version, root: PUBLIC_MODLENS_ROOT, rows: modlens }]
  for (const [name, version] of [['commander', '13.1.0'], ['undici', '8.10.0']]) {
    const root = join(PUBLIC_MODULES_ROOT, name)
    const rows = await snapshotVisionPublicFiles(root, (await fs.readdir(root)).sort())
    const pkg = JSON.parse(rows.find(row => row.path === 'package.json').content)
    if (pkg.name !== name || pkg.version !== version || Object.keys(pkg.dependencies ?? {}).length) throw fail('unsupported_dependency')
    packages.push({ name, version, root, rows })
  }
  const helperPath = join(productRoot, 'scripts/modlens-vision-runtime.mjs'), helper = await safeFile(helperPath)
  const directoryHelper = await safeFile(join(productRoot, 'scripts/modlens-provider-directory.mjs'))
  const schemaHelperPath = join(productRoot, 'scripts/modlens-codex-schema.mjs'), schemaHelper = await safeFile(schemaHelperPath)
  const schemaArtifact = createCodexSchemaArtifact(JSON.parse(modlens.find(row => row.path === 'dsh/vision-schema.json').content))
  const nodePath = await fs.realpath(process.execPath), nodeSha = hash(await safeFile(nodePath, 512 * 1024 * 1024))
  const enginePath = await fs.realpath(input.executable)
  if (enginePath !== input.executable) throw fail('engine_executable_symlink')
  const engineConfig = { runId, sessionId, acceptanceRoot, ledgerDirectory: join(acceptanceRoot, 'engine-budget'),
    workDirectory: join(acceptanceRoot, 'vision-work'), isolatedHome: join(acceptanceRoot, 'home'), authHome: input.authHome,
    executable: enginePath, executableSha256: hash(await safeFile(enginePath, 512 * 1024 * 1024)), model: input.model, imageSha256: input.imageSha256,
    outputSchemaPath: join(packageRoot, 'dist', CODEX_SCHEMA_FILE), outputSchemaSha256: schemaArtifact.sha256 }
  const originalCli = modlens.find(row => row.path === 'dist/main.js')
  const cli = patchVisionRuntime({ source: originalCli.content.toString(), version: metadata.version, expectedSourceSha256: originalCli.sha256,
    engineModuleUrl: pathToFileURL(join(productRoot, 'scripts/acceptance/vision-engine-runtime.mjs')).href, config: engineConfig })
  let plugin = patchSource(modlens.find(row => row.path === 'dsh/index.js').content.toString())
  const pasteAnchor = "dir = await mkdtemp(join(tmpdir(), 'modlens-dsh-'))"
  if (plugin.split(pasteAnchor).length !== 2) throw fail('paste_temp_anchor_changed')
  plugin = plugin.replace(pasteAnchor, `dir = await mkdtemp(join(${JSON.stringify(join(acceptanceRoot, 'vision-paste-work'))}, 'modlens-dsh-'))`)
  const binding = { runId, sessionId, acceptanceRoot, rootDevice: rootStat.dev, rootInode: rootStat.ino,
    envelopeDirectory: join(acceptanceRoot, 'vision-envelope'), imageSha256: input.imageSha256, model: input.model,
    executable: { path: nodePath, sha256: nodeSha }, cli: { path: join(packageRoot, 'dist/main.js'), sha256: cli.sourceSha256 } }
  const wrapper = `// Acceptance-only outer Node/ModLens receipt; never a Codex engine receipt.\nexport * from './vision-product-runtime.mjs';\nimport { runVision as productRunVision, runVisionWithRecovery as productRecovery } from './vision-product-runtime.mjs';\nimport { captureVisionEnvelope } from ${JSON.stringify(pathToFileURL(join(productRoot, 'scripts/acceptance/vision-install.mjs')).href)};\nconst binding = Object.freeze(${JSON.stringify(binding)});\nexport function runVision(command, args, signal, timeoutMs) { return captureVisionEnvelope(binding, productRunVision, command, args, signal, timeoutMs); }\nexport function runVisionWithRecovery(command, args, signal, timeoutMs) { return captureVisionEnvelope(binding, productRecovery, command, args, signal, timeoutMs); }\n`
  for (const pkg of packages) await unchanged(pkg.root, pkg.rows)
  await ownedDirectory(acceptanceRoot, modules)
  for (const path of [binding.envelopeDirectory, join(acceptanceRoot, 'vision-paste-work')]) {
    await absent(path); await ownedDirectory(acceptanceRoot, path)
  }
  const installed = []
  for (const pkg of packages) {
    const target = join(modules, pkg.name)
    await ownedDirectory(acceptanceRoot, target)
    const rows = pkg.rows.map(row => ({ ...row }))
    if (pkg.name === '@liustack/modlens') {
      for (const [path, content] of [['dist/main.js', cli.source], ['dsh/index.js', plugin], ['dsh/xiaoshe-vision-runtime.mjs', wrapper],
        ['dsh/xiaoshe-provider-directory.mjs', directoryHelper], ['dsh/xiaoshe-codex-schema.mjs', schemaHelper], [`dist/${CODEX_SCHEMA_FILE}`, schemaArtifact.bytes]]) {
        const row = rows.find(row => row.path === path)
        if (row) row.content = Buffer.from(content)
        else rows.push({ path, content: Buffer.from(content) })
      }
      rows.push({ path: 'dsh/vision-product-runtime.mjs', content: helper })
    }
    for (const row of rows) {
      const path = join(target, row.path)
      await ownedDirectory(acceptanceRoot, dirname(path)); await exclusive(path, row.content)
      installed.push({ path: relative(profileRoot, path), bytes: row.content.length, sha256: hash(row.content) })
    }
  }
  // Prepare the independent engine manifest without starting any engine or
  // consulting auth. It is therefore observably no_model before launch.
  await createVisionEngineRuntime(engineConfig).ready
  const publicSourceManifest = { schema: 'xiaoshe-vision-public-source/v1', packages: packages.map(pkg => ({ name: pkg.name,
    version: pkg.version, sourceRoot: pkg.root, files: manifestRows(pkg.rows) })), productHelper: { path: helperPath, bytes: helper.length, sha256: hash(helper) },
    productSchemaHelper: { path: schemaHelperPath, bytes: schemaHelper.length, sha256: hash(schemaHelper) } }
  for (const row of installed) if (hash(await safeFile(join(profileRoot, row.path))) !== row.sha256) throw fail('installed_file_changed')
  const isolatedManifest = { schema: 'xiaoshe-vision-isolated-files/v1', files: installed.sort((a, b) => a.path.localeCompare(b.path)) }
  const result = { schema: 'xiaoshe-vision-install/v1', runId, sessionId, installedAt: stamp(),
    pluginEntry: pathToFileURL(join(packageRoot, 'dsh/index.js')).href,
    config: { upstream: 'deepseek-official', autoRead: false, timeoutMs: 120000 }, engineConfig, outerBinding: binding,
    publicSourceManifest, publicSourceSha256: hash(JSON.stringify(publicSourceManifest)), isolatedManifest,
    isolatedSha256: hash(JSON.stringify(isolatedManifest)), monetaryHardCap: false }
  await exclusiveJson(join(acceptanceRoot, 'vision-install.json'), result)
  return result
}
