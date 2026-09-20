// Optional owned-run transport/evidence binding; this does not judge task answers.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { validateProcessObservation, verifyProcessObservation } from './owned-process-identity.mjs'

export const COMPLEX_SCENARIOS = Object.freeze(['code-repair', 'conflict-research', 'offline-to-online-topic-switch', 'failure-recovery', 'user-steer'])
const KEYS = ['runId', 'fixtureRoot', 'expectedHostCwd', 'endpoint', 'runtimeIdentity', 'reportPath', 'evidenceDirectory', 'nodePath', 'npmPath', 'temporaryRoot'].sort()
const FIXTURE_DIRECTORIES = ['code-repair', 'recovery', 'research', 'steer']
const OUTPUT = fileURLToPath(new URL('../../output/stabilization/', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const failure = reason => Object.assign(new Error(`complex-run-binding: ${reason}`), { code: 'COMPLEX_RUN_BINDING' })
const inside = (root, path) => path !== root && !relative(root, path).startsWith('..') && !isAbsolute(relative(root, path))
const identity = stat => [stat.dev, stat.ino, stat.uid, stat.mode, stat.isDirectory() ? '-' : stat.nlink].join(':')
const contentIdentity = stat => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`

async function canonical(path, kind, privateMode) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/u.test(path)) throw failure('noncanonical_path')
  const stat = await lstat(path, { bigint: true })
  if (await realpath(path) !== path || stat.isSymbolicLink() || !(kind === 'directory' ? stat.isDirectory() : stat.isFile())) throw failure('unsafe_path')
  if (privateMode !== undefined && (stat.uid !== BigInt(process.getuid()) || Number(stat.mode & 0o7777n) !== privateMode)) throw failure('private_mode_required')
  if (kind === 'file' && stat.nlink !== 1n) throw failure('hardlinked_file')
  return stat
}

async function readStable(path, maxBytes = 32 * 1024 * 1024) {
  const before = await canonical(path, 'file')
  if (before.size > BigInt(maxBytes)) throw failure('file_size_limit')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (contentIdentity(before) !== contentIdentity(await handle.stat({ bigint: true }))) throw failure('file_changed')
    const bytes = await handle.readFile()
    for (const after of [await handle.stat({ bigint: true }), await lstat(path, { bigint: true })]) {
      if (contentIdentity(before) !== contentIdentity(after)) throw failure('file_changed')
    }
    return { bytes, stat: before }
  } finally { await handle.close() }
}

async function absent(path) {
  try { await lstat(path); throw failure('output_already_exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
}

/** Undefined alone selects legacy mode. An invalid supplied manifest never falls back. */
export async function loadComplexRunBinding(path) {
  if (path === undefined) return null
  const manifest = await readStable(path, 16_384)
  await canonical(path, 'file', 0o600)
  let config
  try { config = JSON.parse(manifest.bytes.toString('utf8')) } catch { throw failure('invalid_json') }
  if (!config || Object.getPrototypeOf(config) !== Object.prototype || Object.keys(config).sort().join(',') !== KEYS.join(',')) throw failure('invalid_config_fields')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(config.runId)
    || !/^[0-9a-f]{64}$/u.test(config.runtimeIdentity)) throw failure('invalid_identity')
  const acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${config.runId}`)
  if (config.fixtureRoot !== join(acceptanceRoot, 'workspace') || config.expectedHostCwd !== config.fixtureRoot
    || config.temporaryRoot !== join(acceptanceRoot, 'execution-temp')) throw failure('root_binding_mismatch')
  if (typeof config.evidenceDirectory !== 'string' || !inside(resolve(OUTPUT), config.evidenceDirectory)
    || config.reportPath !== join(config.evidenceDirectory, 'report.json')) throw failure('evidence_binding_mismatch')
  if (![acceptanceRoot, config.evidenceDirectory].includes(dirname(path))) throw failure('manifest_outside_owned_root')
  let endpoint
  try { endpoint = new URL(config.endpoint) } catch { throw failure('invalid_endpoint') }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.origin !== config.endpoint
    || !endpoint.port || Number(endpoint.port) < 1 || Number(endpoint.port) === 3080 || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw failure('isolated_endpoint_required')
  const directories = [acceptanceRoot, config.fixtureRoot, config.temporaryRoot, config.evidenceDirectory]
  const pins = []
  for (const directory of directories) pins.push({ path: directory, stat: await canonical(directory, 'directory', 0o700), kind: 'directory' })
  const fixtureNames = (await readdir(config.fixtureRoot)).sort()
  if (JSON.stringify(fixtureNames) !== JSON.stringify(FIXTURE_DIRECTORIES)) throw failure('fresh_fixture_directories_required')
  for (const name of FIXTURE_DIRECTORIES) {
    const directory = join(config.fixtureRoot, name)
    pins.push({ path: directory, stat: await canonical(directory, 'directory', 0o700), kind: 'directory' })
    if ((await readdir(directory)).length) throw failure('fixture_not_empty')
  }
  for (const tool of [config.nodePath, config.npmPath]) {
    if (inside(acceptanceRoot, tool) || inside(config.evidenceDirectory, tool)) throw failure('tool_inside_mutable_root')
    const value = await readStable(tool, 128 * 1024 * 1024)
    pins.push({ path: tool, stat: value.stat, kind: 'file', sha256: sha(value.bytes) })
  }
  if ((pins.find(pin => pin.path === config.nodePath).stat.mode & 0o111n) === 0n || !config.npmPath.endsWith('/npm/bin/npm-cli.js')) throw failure('invalid_tool_entry')
  pins.push({ path, stat: manifest.stat, kind: 'file', sha256: sha(manifest.bytes) })
  const processPath = join(acceptanceRoot, 'host-process.json')
  const processRaw = await readStable(processPath, 16384)
  await canonical(processPath, 'file', 0o600)
  let processEvidence
  try { processEvidence = validateProcessObservation(JSON.parse(processRaw.bytes.toString('utf8')), config) }
  catch { throw failure('host_process_evidence_mismatch') }
  pins.push({ path: processPath, stat: processRaw.stat, kind: 'file', sha256: sha(processRaw.bytes) })
  await absent(config.reportPath)
  config = Object.freeze(config)
  let sequence = 0, reportStat, retentionFailed = false
  const retained = []
  async function assertCurrent() {
    if (retentionFailed) throw failure('prior_retention_failure')
    for (const pin of pins) {
      const now = await canonical(pin.path, pin.kind)
      if (identity(now) !== identity(pin.stat) || (pin.kind === 'file' && contentIdentity(now) !== contentIdentity(pin.stat))) throw failure('bound_input_changed')
    }
  }
  async function writeExclusive(target, bytes) {
    await assertCurrent()
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await assertCurrent()
    return { path: target, bytes: bytes.length, sha256: sha(bytes) }
  }
  async function retainResponse({ method, rpcId, payload, status, bytes }) {
    try {
      if (!['session/follow', 'session/page', 'desktop.status', 'independent.node-test'].includes(method)) throw failure('unrecognized_evidence_method')
      if (!Buffer.isBuffer(bytes)) throw failure('raw_response_required')
      const ordinal = ++sequence
      const name = `${method.replace(/[./]/gu, '-')}-${String(ordinal).padStart(6, '0')}`
      const raw = await writeExclusive(join(config.evidenceDirectory, `${name}.json`), bytes)
      const entry = { ordinal, method, rpcId, payload, status, receivedAt: new Date().toISOString(), ...raw }
      await writeExclusive(join(config.evidenceDirectory, `${name}.receipt.json`), Buffer.from(`${JSON.stringify(entry, null, 2)}\n`))
      retained.push(entry)
      return entry
    } catch (error) {
      retentionFailed = true
      if (error.code === 'COMPLEX_RUN_BINDING') throw error
      throw Object.assign(failure('raw_retention_failed'), { cause: error })
    }
  }
  return Object.freeze({
    config, acceptanceRoot, manifest: { path, sha256: sha(manifest.bytes), rawBase64: manifest.bytes.toString('base64') }, assertCurrent,
    sessionId(id) { if (!COMPLEX_SCENARIOS.includes(id)) throw failure('unknown_scenario'); return `xiaoshe-harness-${id}-${config.runId}` },
    retainedResponses: () => [...retained], retainResponse,
    processEvidence: Object.freeze(processEvidence),
    async verifyProcess() { await assertCurrent(); return verifyProcessObservation(processEvidence) },
    async writeReport(report) {
      // Only this run's originally-created report inode may be updated.
      // Retention failure must still be publishable as FAIL, never silently retried.
      for (const pin of pins.filter(pin => pin.kind === 'directory')) {
        if (identity(await canonical(pin.path, 'directory')) !== identity(pin.stat)) throw failure('report_parent_changed')
      }
      if (reportStat && identity(await canonical(config.reportPath, 'file', 0o600)) !== identity(reportStat)) throw failure('report_replaced')
      const handle = await open(config.reportPath, constants.O_WRONLY | constants.O_NOFOLLOW | (reportStat ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600)
      try {
        const opened = await handle.stat({ bigint: true })
        if (reportStat && identity(opened) !== identity(reportStat)) throw failure('report_replaced')
        reportStat ??= opened
        await handle.truncate(0); await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); await handle.sync()
        if (identity(await lstat(config.reportPath, { bigint: true })) !== identity(reportStat)) throw failure('report_replaced')
      } finally { await handle.close() }
    },
    async verifyRuntime(fetchImpl = fetch) {
      await assertCurrent()
      const response = await fetchImpl(`${config.endpoint}/xiaoshe/desktop/status`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
      const bytes = Buffer.from(await response.arrayBuffer())
      await retainResponse({ method: 'desktop.status', rpcId: null, payload: null, status: response.status, bytes })
      let body
      try { body = JSON.parse(bytes.toString('utf8')) } catch { throw failure('invalid_runtime_status') }
      if (!response.ok || body?.runtime_identity !== config.runtimeIdentity || body?.product !== '小蛇' || body?.bridge?.state !== 'ready') throw failure('runtime_identity_mismatch')
      return { runtimeIdentity: body.runtime_identity, product: body.product, bridgeReady: true }
    },
    async retainFixtures() {
      await assertCurrent()
      const destination = join(config.evidenceDirectory, 'fixtures')
      await mkdir(destination, { mode: 0o700 })
      const entries = []
      let totalBytes = 0
      async function visit(source, target) {
        const before = await canonical(source, 'directory')
        const names = (await readdir(source)).sort()
        for (const name of names) {
          const from = join(source, name), to = join(target, name)
          const stat = await lstat(from, { bigint: true })
          if (entries.length >= 2_000) throw failure('fixture_entry_limit')
          if (stat.isDirectory()) {
            await canonical(from, 'directory')
            await mkdir(to, { mode: 0o700 })
            entries.push({ path: relative(config.fixtureRoot, from), kind: 'directory', mode: Number(stat.mode & 0o7777n) })
            await visit(from, to)
          } else {
            const raw = await readStable(from, 16 * 1024 * 1024)
            totalBytes += raw.bytes.length
            if (totalBytes > 16 * 1024 * 1024) throw failure('fixture_byte_limit')
            const retainedFile = await writeExclusive(to, raw.bytes)
            if (identity(await lstat(to, { bigint: true })) === identity(raw.stat)) throw failure('fixture_copy_not_independent')
            entries.push({ path: relative(config.fixtureRoot, from), kind: 'file', mode: Number(raw.stat.mode & 0o7777n), bytes: raw.bytes.length, sha256: retainedFile.sha256 })
          }
        }
        if (identity(await canonical(source, 'directory')) !== identity(before) || JSON.stringify(await readdir(source).then(names => names.sort())) !== JSON.stringify(names)) throw failure('fixture_tree_changed')
      }
      await visit(config.fixtureRoot, destination)
      // A final second read closes changes to earlier files while later files were copied.
      for (const entry of entries.filter(entry => entry.kind === 'file')) {
        const raw = await readStable(join(config.fixtureRoot, entry.path))
        if (sha(raw.bytes) !== entry.sha256 || Number(raw.stat.mode & 0o7777n) !== entry.mode) throw failure('fixture_tree_changed')
      }
      const result = { schema: 'xiaoshe-complex-fixture-retention/v1', source: config.fixtureRoot, destination, retainedForOuterCleanup: true, totalBytes, entries }
      const receipt = await writeExclusive(join(config.evidenceDirectory, 'fixtures.json'), Buffer.from(`${JSON.stringify(result, null, 2)}\n`))
      return { ...result, receipt }
    },
  })
}

/** Evidence collection is additional: original per-scenario evaluation windows stay unchanged. */
export async function collectCompleteComplexHistory(sessionId, rpc) {
  const pages = [], seen = new Set()
  let beforeSeq, cutoff
  for (let index = 0; index < 1_000; index++) {
    const page = await rpc('session.history', { sessionId, maxMessages: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) })
    if (!Array.isArray(page?.events) || typeof page.hasMore !== 'boolean') throw failure('invalid_history_page')
    if (index === 0) cutoff = page.throughSeq
    if (!Number.isSafeInteger(cutoff) || cutoff < -1 || page.throughSeq !== cutoff) throw failure('history_cutoff_invalid')
    let previous = -1
    for (const row of page.events) {
      const seq = row?.event?.seq
      if (!Number.isSafeInteger(seq) || seq < 0 || seq > cutoff || seq <= previous || seen.has(seq) || (beforeSeq !== undefined && seq >= beforeSeq)) throw failure('history_sequence_invalid')
      previous = seq; seen.add(seq)
    }
    pages.push(page)
    if (!page.hasMore) {
      const sequences = [...seen].sort((a, b) => a - b)
      if (sequences.some((seq, i) => seq !== i)) throw failure('history_sequence_gap')
      if (seen.size !== cutoff + 1) throw failure('history_cutoff_gap')
      return { sessionId, pages: pages.length, events: seen.size, firstSeq: sequences[0] ?? null, lastSeq: sequences.at(-1) ?? null, throughSeq: cutoff, hasMore: false }
    }
    if (!page.events.length) throw failure('empty_history_continuation')
    beforeSeq = page.events[0].event.seq
  }
  throw failure('history_page_limit')
}

/** Do not import/execute a model-contaminated test or npm manifest, even inside confinement. */
export async function assertComplexProtectedInputs(codeRoot, expected) {
  if (Object.keys(expected).sort().join(',') !== 'package.json,requirements.md,test/normalize.test.mjs') throw failure('protected_input_set_mismatch')
  for (const [path, digest] of Object.entries(expected)) {
    const raw = await readStable(join(codeRoot, path))
    if (sha(raw.bytes) !== digest) throw failure('protected_input_changed')
  }
}
