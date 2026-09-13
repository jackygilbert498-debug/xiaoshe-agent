#!/usr/bin/env node
/** Explicitly authorized real-main vision acceptance. Never a daily Profile. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { mkdir, lstat, realpath, readFile, writeFile, open, readdir, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createPublicProfile, runOwnedProcess, serviceAbsent, inspectGracefulExit } from '../quality/product-lifecycle.mjs'
import { assertMaterialBackendPortReleased, removeOwnedMaterialRoot } from './material-live.mjs'
import { captureCandidate } from '../quality/internal-beta.mjs'
import { productRuntimeIdentity } from '../product-runtime-identity.mjs'
import { readBudgetLedger } from './live-request-budget.mjs'
import { readLiveVisionPolicyLedger, META_TOOLS, PATH_TOOLS } from './live-vision-policy.mjs'
import { readVisionEngineLedger } from './vision-engine-runtime.mjs'
import { readVisionWireLedger, readVisionWireSourceHashes, validateVisionWireMount } from './vision-wire-install.mjs'
import { installIsolatedVision, snapshotVisionPublicFiles } from './vision-install.mjs'
import { createVisionFixture } from './vision-fixture.mjs'
import { proveVisionTask } from './vision-proof.mjs'
import { selectedCredential, unusedPort } from './same-session-files-live.mjs'
import { acceptanceServiceEnvironment } from '../../apps/desktop-shell/src/acceptance-isolation.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const positivePid = value => Number.isSafeInteger(value) && value > 1 && value !== process.pid
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const save = async (path, value) => {
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() } finally { await file.close() }
}

export function parseVisionLiveArgs(args) {
  if (isDeepStrictEqual(args, ['--live-authorized', '--input', 'path'])) return { liveAuthorized: true, inputKind: 'path', clipboardAuthorized: false }
  if (isDeepStrictEqual(args, ['--live-authorized', '--input', 'attachment', '--clipboard-authorized'])) return { liveAuthorized: true, inputKind: 'attachment', clipboardAuthorized: true }
  throw new Error('requires --live-authorized --input path OR --live-authorized --input attachment --clipboard-authorized')
}

export function visionProfilePatch({ productRoot, acceptanceRoot, runId, sessionId, inputKind, imageSha256, installation }) {
  return [
    ...['credentials', 'llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'session-title-llm', 'session-telemetry-otel'].map(id => ({ id, disabled: true })),
    { id: 'agent-default-model', config: { provider: 'deepseek-modlens', model: 'deepseek-v4-flash' } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'agent-presets', config: { default: 'standard', includeUserRoot: false } },
    { insert: [
      { id: 'acceptance-vision-wire', name: pathToFileURL(join(productRoot, 'scripts/acceptance/vision-wire-install.mjs')).href, config: { acceptanceRoot, runId, sessionId } },
      { id: 'acceptance-vision-budget', name: pathToFileURL(join(productRoot, 'scripts/acceptance/live-vision-budget.mjs')).href, config: { acceptanceRoot, runId, sessionId } },
      { id: 'acceptance-vision-policy', name: pathToFileURL(join(productRoot, 'scripts/acceptance/live-vision-policy.mjs')).href,
        config: { workspaceRealPath: join(acceptanceRoot, 'workspace'), ledgerDirectory: join(acceptanceRoot, 'tool-policy'), runId, sessionId, inputKind, imageSha256 } },
      { id: 'acceptance-vision-modlens', name: installation.pluginEntry, config: { upstream: 'deepseek-official', autoRead: false, timeoutMs: 120000 } },
    ] },
  ]
}

/** fileURL plugins need their own content binding: they are intentionally not
 * added to the product's existing direct-Profile-dependency hash algorithm. */
export async function verifyVisionInstallation(profileRoot, installation) {
  if (installation?.isolatedManifest?.schema !== 'xiaoshe-vision-isolated-files/v1'
    || !Array.isArray(installation.isolatedManifest.files) || installation.isolatedManifest.files.length === 0
    || !digest(installation.isolatedSha256) || hash(JSON.stringify(installation.isolatedManifest)) !== installation.isolatedSha256) throw new Error('invalid isolated installation binding')
  const rows = await snapshotVisionPublicFiles(profileRoot, installation.isolatedManifest.files.map(row => row.path))
  const observed = { schema: 'xiaoshe-vision-isolated-files/v1', files: rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) }
  const observedSha256 = hash(JSON.stringify(observed))
  if (observedSha256 !== installation.isolatedSha256) throw new Error('copied vision plugin or dependency changed')
  return { sha256: observedSha256, files: rows.length, observedAt: new Date().toISOString() }
}

/** Native booleans are corroborated by exact hashes, scope and observed PID. */
export function validateVisionNative(raw, { runId, sessionId, inputKind, runtimeIdentity, imageSha256, acceptanceRoot, pid, servicePid, startedAt, finishedAt, wireSourceHashes }) {
  const f = raw?.frontend, b = raw?.budgetBefore, p = raw?.policyBefore
  const within = at => iso(at) && Date.parse(at) >= Date.parse(startedAt) && Date.parse(at) <= Date.parse(finishedAt)
  if (!raw || raw.schema !== 'xiaoshe-vision-native/v1' || raw.accepted !== true || raw.runId !== runId || raw.sessionId !== sessionId
    || raw.inputKind !== inputKind || !positivePid(pid) || raw.pid !== pid || !positivePid(servicePid) || servicePid === pid || raw.backendPid !== servicePid
    || !within(raw.startedAt) || !within(raw.finishedAt) || raw.finishedAt < raw.startedAt || raw.failure || raw.retentionFailure
    || raw.turn?.reason !== 'completed') throw new Error('native vision identity or completion unproven')
  if (!digest(runtimeIdentity) || f?.backendIdentity !== runtimeIdentity || f.expectedRootProfileIdentity !== runtimeIdentity
    || f.candidateIdentity !== runtimeIdentity || f.identityMatches !== true || f.frontendMatches !== true
    || !digest(f.loadedFrontendIdentity) || f.loadedFrontendIdentity !== f.frontendBuildIdentity || !digest(f.frontendArtifactIdentity)
    || f.aboutRendered !== true || f.shellPresent !== true || f.loadedOriginMatches !== true || f.aboutHttpStatus !== 200
    || f.aboutStatus !== 'current' || f.diagnosticStatus !== 'current' || f.product !== '小蛇' || f.bridgeState !== 'ready') throw new Error('loaded product version is not current')
  if (raw.model?.routable !== true || raw.model.current?.provider !== 'deepseek-modlens' || raw.model.current.model !== 'deepseek-v4-flash') throw new Error('vision model route mismatch')
  const page = raw.finalPage
  if (page?.ready !== true || page.running !== false || page.blocked !== false || !Number.isSafeInteger(page.assistantCount)
    || page.assistantCount < 1 || typeof page.answerText !== 'string' || !page.answerText.trim()) throw new Error('final answer not visibly delivered')
  if (inputKind === 'attachment') {
    const views = raw.attachmentViews, reload = raw.historyReload, attachmentId = `sha256:${imageSha256}`
    if (!views || !reload || !within(raw.submitCompletedAt) || !within(reload.startedAt) || !within(reload.completedAt)
      || reload.startedAt > reload.completedAt || raw.delivery?.attachmentId !== attachmentId) throw new Error('attachment history reload unproven')
    for (const view of [views.submitted, views.reloaded]) {
      if (view?.ready !== true || view.source !== 'session-attachment-blob' || view.attachmentId !== attachmentId || view.sessionId !== sessionId
        || view.sha256 !== imageSha256 || !Number.isSafeInteger(view.bytes) || view.bytes <= 0 || view.bytes > 1024 * 1024
        || view.width !== 600 || view.height !== 400 || !within(view.observedAt)) throw new Error('rendered historical attachment bytes unproven')
    }
    if (raw.submitCompletedAt > views.submitted.observedAt || views.submitted.observedAt > reload.startedAt
      || reload.completedAt > views.reloaded.observedAt || views.submitted.bytes !== views.reloaded.bytes) throw new Error('attachment history observations out of order')
  }
  if (b?.runId !== runId || b.mounted !== true || b.mountCount !== 1 || b.mode !== 'bounded_model' || b.maxRequests !== 8 || b.maxOutputTokens !== 2048
    || b.reservedRequests !== 0 || b.attemptedRequests !== 0 || b.deniedRequests !== 0 || b.requests?.length !== 0
    || b.mounts?.length !== 1 || b.mounts[0].pid !== servicePid || b.mounts[0].runId !== runId || !within(b.mounts[0].at)) throw new Error('pre-dispatch API guard not bound to owned backend')
  if (p?.schema !== 'xiaoshe-live-vision-policy/v1' || p.runId !== runId || p.mounted !== true || p.inputKind !== inputKind
    || p.imageSha256 !== imageSha256 || !digest(p.policyDigest) || !isDeepStrictEqual(p.sessionIds, [sessionId])
    || p.workspaceRealPath !== join(acceptanceRoot, 'workspace') || p.imagePath !== join(acceptanceRoot, 'workspace/input.png')
    || !isDeepStrictEqual(p.allowedTools, inputKind === 'path' ? PATH_TOOLS : META_TOOLS)
    || !Array.isArray(p.mounts) || p.mounts.length !== 2
    || p.mounts.some(row => row.pid !== servicePid || row.runId !== runId || row.policyDigest !== p.policyDigest || !within(row.at))
    || p.mounts.filter(row => row.kind === 'host' && row.sessionId === null).length !== 1
    || p.mounts.filter(row => row.kind === 'agent' && row.sessionId === sessionId).length !== 1) throw new Error('pre-dispatch tool policy not bound to owned backend')
  validateVisionWireMount(raw.wireBefore, { runId, sessionId, servicePid, startedAt, finishedAt, sourceHashes: wireSourceHashes, empty: true })
  return true
}

/** Independent post-shutdown transport observation. Counts are associated
 * with budget slots, not added to token usage or claimed as causal permits. */
export function validateVisionFinalWire({ wire, native, budget, policy, history, envelopes, inputKind, imageSha256, ...binding }) {
  validateVisionWireMount(wire, binding)
  if (!isDeepStrictEqual(wire.manifest, native?.wireBefore?.manifest) || !isDeepStrictEqual(wire.mount, native?.wireBefore?.mount)
    || !budget?.mounted || budget.runId !== binding.runId || budget.mountCount !== 1 || budget.mounts?.[0]?.pid !== binding.servicePid
    || budget.maxRequests !== 8 || budget.maxOutputTokens !== 2048 || budget.deniedRequests !== 0
    || budget.reservedRequests < 1 || budget.reservedRequests > 8 || wire.observedAttempts !== budget.reservedRequests
    || budget.requests?.length !== wire.observedAttempts || budget.requests.some((row, i) => row.ordinal !== i + 1 || row.outcome !== 'finished')) throw new Error('official wire and budget attempts do not match')
  if (!policy?.mounted || policy.runId !== binding.runId || !isDeepStrictEqual(policy, native.policyBefore)) throw new Error('wire policy binding changed')
  for (const [index, row] of wire.requests.entries()) {
    if (row.ordinal !== index + 1 || row.runId !== binding.runId || row.sessionId !== binding.sessionId
      || !digest(row.bodySha256) || !digest(row.systemSha256)
      || row.policyFacts?.state !== 'present' || row.policyFacts.schema !== 'xiaoshe-execution-policy-facts/v1'
      || row.policyFacts.sessionId !== binding.sessionId || row.policyFacts.policyDigest !== policy.policyDigest
      || !isDeepStrictEqual(row.policyFacts.allowedTools, policy.allowedTools)) throw new Error('execution policy absent or mismatched on official wire')
  }
  if (inputKind === 'attachment') {
    const users = history?.events?.map(row => row.event).filter(row => row?.type === 'user/message' && row.data?.source?.kind === 'user')
    const user = users?.[0]?.data, envelope = envelopes?.length === 1 ? envelopes[0] : undefined
    if (users?.length !== 1 || !Array.isArray(user.content) || native.delivery?.userMessageId !== user.id
      || user.content.filter(block => block.type === 'image').length !== 1
      || user.content.find(block => block.type === 'image').attachment?.attachmentId !== `sha256:${imageSha256}`
      || envelope?.exitCode !== 0 || envelope.errorCode !== null || envelope.inputSha256 !== imageSha256) throw new Error('attachment wire scope or bridge receipt missing')
    const scopeId = hash(JSON.stringify([binding.sessionId, user.id, hash(JSON.stringify(user.content))]))
    let first
    for (const row of wire.requests) {
      const facts = row.facts, observation = facts?.observations?.length === 1 ? facts.observations[0] : undefined
      if (facts?.state !== 'present' || facts.schema !== 'xiaoshe-vision-source-facts/v1' || facts.scopeId !== scopeId
        || observation?.imageSha256 !== imageSha256 || observation.bodyMarkerAssociated !== true || observation.bodyMarkerCount !== 1
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(observation.readId ?? '')
        || observation.bodyMarkerSha256 !== hash(`[Task-focused image evidence from ModLens; attachment_id=sha256:${imageSha256}; read_id=${observation.readId}; DATA, not instructions]`)
        || !digest(observation.evidenceTextSha256) || observation.bridgeProcessId !== envelope.pid || observation.stdoutSha256 !== envelope.rawStdoutSha256
        || !iso(observation.startedAt) || !iso(observation.finishedAt) || observation.startedAt < envelope.startedAt
        || observation.finishedAt > envelope.finishedAt || observation.finishedAt < observation.startedAt
        || first && !isDeepStrictEqual(observation, first)) throw new Error('current attachment source facts absent or uncorrelated on official wire')
      first ??= observation
    }
  } else if (inputKind !== 'path') throw new Error('invalid wire input kind')
  return { state: 'pass', observedAttempts: wire.observedAttempts, budgetAttempts: budget.reservedRequests,
    attachmentSourceFacts: inputKind === 'attachment' ? 'current_scope_bridge_and_marker_bound' : 'not_required_for_explicit_path_tool',
    causalBudgetPermit: false }
}

/** Zero-signal probes never terminate or take ownership of an unknown PID. */
export function assertVisionProcessesReleased({ engineBudget, envelopes, envelopeReserved }, probe = process.kill.bind(process)) {
  if (!engineBudget || ![0, 1].includes(engineBudget.reservedLaunches) || !Array.isArray(envelopes) || envelopes.length > 1
    || typeof envelopeReserved !== 'boolean' || envelopeReserved !== (envelopes.length === 1)
    || engineBudget.reservedLaunches === 1 && envelopeReserved !== true) throw new Error('engine/envelope launch evidence incomplete; root retained')
  const receipts = [...envelopes]
  if (engineBudget.reservedLaunches === 1) {
    if (!engineBudget.launch || !engineBudget.receipt || engineBudget.launch.pid !== engineBudget.receipt.pid) throw new Error('actual engine launch exit unproven; root retained')
    receipts.push(engineBudget.receipt)
  } else if (engineBudget.launch || engineBudget.receipt) throw new Error('unreserved engine launch; root retained')
  if (receipts.length === 2 && receipts[0].pid === receipts[1].pid) throw new Error('outer process is not the actual engine process')
  const observations = []
  for (const receipt of receipts) {
    const pid = receipt.pid
    if (!positivePid(pid) || receipt.cleanup?.status !== 'confirmed' || receipt.cleanup.confirmedBy !== 'ESRCH' || receipt.cleanup.groupId !== pid) throw new Error('engine cleanup receipt is not independently probeable')
    for (const target of [-pid, pid]) {
      try { probe(target, 0); throw new Error('vision process or process group still present; root retained') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    observations.push({ pid, groupId: pid, confirmedBy: 'ESRCH', observedAt: new Date().toISOString() })
  }
  return { state: 'pass', noLaunch: receipts.length === 0, observations }
}

export async function readVisionEnvelope(directory, { runId, sessionId }) {
  const names = await readdir(directory)
  if (names.some(name => !['reserved-1.json', 'receipt-1.json', 'stdout-1.json'].includes(name))) throw new Error('unexpected envelope ledger entry')
  const reserved = names.includes('reserved-1.json'), envelopes = []
  if (reserved) {
    const slot = await json(join(directory, 'reserved-1.json'))
    if (Object.keys(slot).sort().join(',') !== 'ordinal,runId,sessionId,startedAt' || slot.runId !== runId || slot.sessionId !== sessionId
      || slot.ordinal !== 1 || !iso(slot.startedAt)) throw new Error('outer reservation identity mismatch')
  }
  if (names.includes('receipt-1.json')) {
    const receipt = await json(join(directory, 'receipt-1.json'))
    const raw = await readFile(join(directory, 'stdout-1.json'), 'utf8')
    if (!reserved || receipt.schema !== 'xiaoshe-vision-envelope/v1' || receipt.runId !== runId || receipt.sessionId !== sessionId || receipt.ordinal !== 1
      || receipt.rawStdoutSha256 !== hash(raw)) throw new Error('outer raw receipt mismatch')
    const failed = typeof receipt.errorCode === 'string' && receipt.errorCode.length > 0
    if (!failed && (receipt.errorCode !== null || receipt.exitCode !== 0)) throw new Error('outer receipt outcome mismatch')
    // The actual capture intentionally leaves output=null on nonzero exit or
    // invalid JSON. Preserve this failed PID/error record; never parse empty
    // failure bytes as success, nor discard the PID needed for cleanup.
    if (!failed || receipt.output !== null) {
      let parsed
      try { parsed = JSON.parse(raw) } catch { throw new Error('outer raw receipt mismatch') }
      if (!isDeepStrictEqual(receipt.output, parsed)) throw new Error('outer raw receipt mismatch')
    }
    envelopes.push(receipt)
  } else if (names.includes('stdout-1.json')) throw new Error('outer receipt incomplete')
  return { envelopes, envelopeReserved: reserved }
}

export function redactVisionText(value, secret) {
  return String(value).replaceAll(secret || '\0', '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/giu, '$1[REDACTED]')
}

/** A native failure may precede any user turn, so its missing history is not
 * the root cause. Diagnose the retained native report before reading history. */
export async function readVisionHistoryAfterNative(native, historyPath, secret) {
  if (native?.accepted !== true || Object.hasOwn(native, 'failure') || Object.hasOwn(native, 'retentionFailure')) {
    const failure = native?.failure, retention = native?.retentionFailure
    const stage = typeof failure?.stage === 'string' ? failure.stage : retention ? 'native-evidence-retention' : 'native-phase'
    const message = typeof failure?.message === 'string' ? failure.message
      : typeof retention?.message === 'string' ? retention.message : 'native phase was not accepted'
    throw new Error(redactVisionText(`native vision failed (${stage}): ${message}`, secret).slice(0, 1200))
  }
  return json(historyPath)
}

/** Retain only this run's ordinary files, with a digest of retained bytes. */
async function retainTree(source, destination, secret, rows, relative = '') {
  const stat = await lstat(source)
  if (stat.isSymbolicLink() || await realpath(source) !== source) throw new Error('unsafe evidence source')
  if (stat.isDirectory()) {
    await mkdir(destination, { mode: 0o700 })
    for (const name of await readdir(source)) await retainTree(join(source, name), join(destination, name), secret, rows, `${relative}/${name}`)
  } else {
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error('unsafe evidence file')
    const bytes = await readFile(source), retained = source.endsWith('.png') ? bytes : Buffer.from(redactVisionText(bytes.toString('utf8'), secret))
    await writeFile(destination, retained, { flag: 'wx', mode: 0o600 })
    rows.push({ path: relative, bytes: retained.length, sha256: hash(retained), redacted: !retained.equals(bytes) })
    return { sourceBytes: bytes, retainedBytes: retained }
  }
}

/** A raw JSON object already used by this run is required evidence. Compare
 * parsed content, not serialization formatting; hash the actual copied bytes. */
export async function retainVisionObservedJson({ acceptanceRoot, outputDirectory, name, observed, secret, retention }) {
  if (!['vision-native.json', 'vision-history.json'].includes(name)) throw new Error('unexpected observed vision evidence name')
  const source = join(acceptanceRoot, name), target = join(outputDirectory, `raw-${name}`)
  if (observed === undefined) {
    try { await lstat(source) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  const copied = await retainTree(source, target, secret, retention, name)
  if (observed !== undefined) {
    const expected = JSON.parse(redactVisionText(JSON.stringify(observed), secret))
    if (!copied || !isDeepStrictEqual(JSON.parse(copied.sourceBytes.toString('utf8')), observed)
      || !isDeepStrictEqual(JSON.parse(copied.retainedBytes.toString('utf8')), expected)
      || !(await readFile(target)).equals(copied.retainedBytes)) throw new Error('observed vision raw evidence changed before retention')
    const row = retention.findLast(row => row.path === name)
    row.sourceSha256 = hash(copied.sourceBytes)
  }
  return true
}

/** Required wire evidence remains byte-identical; a failed copy/read/check
 * keeps the owned root for diagnosis rather than trusting a stale snapshot. */
export async function retainVisionWireEvidence({ acceptanceRoot, outputDirectory, wire, secret, retention }) {
  const config = { acceptanceRoot, runId: wire?.runId, sessionId: wire?.sessionId }
  const source = join(acceptanceRoot, 'wire-observations'), target = join(outputDirectory, 'wire-observations')
  await retainTree(source, target, secret, retention, 'wire-observations')
  if (!isDeepStrictEqual(await readVisionWireLedger(config), wire)) throw new Error('wire ledger changed before retention')
  for (const name of ['manifest.json', 'host-mounted.json', ...wire.requests.map(row => `request-${row.ordinal}.json`)]) {
    const path = join(target, name), before = await lstat(path), original = await readFile(join(source, name)), copied = await readFile(path), after = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.mode & 0o077
      || process.getuid && before.uid !== process.getuid() || await realpath(path) !== path
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || !copied.equals(original) || !retention.some(row => row.path === `wire-observations/${name}` && row.sha256 === hash(copied) && row.redacted === false))
      throw new Error('wire retained bytes or identity mismatch')
  }
  if (!isDeepStrictEqual(await readVisionWireLedger(config), wire)) throw new Error('wire ledger changed during retention')
}

export async function finishVisionEvidence(report, { outputDirectory, onProgress, capture = () => captureCandidate(root), redact = redactVisionText }) {
  const note = (stage, error) => report.failures.push({ stage, message: redact(error?.message ?? error).slice(0, 800) })
  try { report.sourceAfter = await capture() } catch (error) { report.sourceAfter = null; note('source-snapshot-after', error) }
  if (!digest(report.sourceBefore?.sha256) || report.sourceBefore.sha256 !== report.sourceAfter?.sha256) note('source-binding', 'source changed or absent')
  try { await onProgress({ stage: 'evidence-finalizing', inputKind: report.inputKind, outputDirectory }) } catch (error) { note('progress-observer', error) }
  report.finishedAt = new Date().toISOString()
  const success = () => report.failures.length === 0 && report.proof?.state === 'pass' && report.proof.checks?.length > 0
    && report.proof.checks.every(row => row.state === 'pass') && report.cleanup.length > 0 && report.cleanup.every(row => row.state === 'pass')
  if (report.proof) try { await save(join(outputDirectory, 'proof.json'), report.proof) } catch (error) { note('proof-retention', error) }
  report.status = success() ? 'pass' : 'fail'
  if (report.status === 'pass') {
    try { await save(join(outputDirectory, 'task-run.json'), {
      schema: 'xiaoshe-task-run/v1', runId: report.runId, createdAt: report.createdAt, finishedAt: report.finishedAt,
      binding: { sourceSha256: report.sourceBefore.sha256, runtimeIdentity: report.runtimeIdentity }, executionKind: 'live_model', cleanup: report.cleanup,
      tasks: [{ taskId: report.proof.taskId, state: report.proof.state, checks: report.proof.checks }],
      sharedJourneyMetrics: { durationMs: Date.parse(report.finishedAt) - Date.parse(report.createdAt),
        inputTokens: report.budget?.usage?.totalUsage?.inputTokens ?? null, outputTokens: report.budget?.usage?.totalUsage?.outputTokens ?? null,
        cacheReadTokens: report.budget?.usage?.totalUsage?.cacheReadTokens ?? null, cost: null },
      engineUsage: report.proof.engineUsage, monetaryHardCap: false,
    }) } catch (error) { note('task-retention', error); report.status = 'fail' }
  }
  // No terminal success is emitted until every required evidence write above
  // succeeds and this authoritative report is durable.
  await save(join(outputDirectory, 'report.json'), report)
  return report
}

export async function runVisionLive(options = {}) {
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Reflect.ownKeys(options).some(key => !['liveAuthorized', 'inputKind', 'clipboardAuthorized', 'onProgress'].includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'))
    || options.liveAuthorized !== true || !['path', 'attachment'].includes(options.inputKind)
    || (options.inputKind === 'attachment' ? options.clipboardAuthorized !== true : options.clipboardAuthorized === true)
    || options.onProgress !== undefined && typeof options.onProgress !== 'function' || process.platform !== 'darwin') throw new Error('explicit macOS vision/clipboard authorization required')
  const { inputKind, clipboardAuthorized = false, onProgress = value => process.stdout.write(`${JSON.stringify(value)}\n`) } = options
  const runId = randomUUID(), sessionId = `xiaoshe-vision-${runId}`, createdAt = new Date().toISOString()
  const outputDirectory = join(root, 'output/stabilization', `vision-live-${runId}`)
  const acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  const label = `com.xiaoshe.acceptance.${runId}`, token = randomUUID(), failures = [], cleanup = [], pending = [], retention = []
  let env, ownedStat, port, profileRoot, installation, sourceBefore, runtimeIdentity, native, history, budget, policy, engineBudget, proof, engineCleanup,
    exit, servicePid, childPid, secret, fixture, installationBefore, installationAfter, wire = null, wireSourceHashes, wireBinding = null,
    envelopes = [], envelopeReserved = null, rawEngineStdout, childFinished = true, interrupted = false
  const note = (stage, error) => failures.push({ stage, message: redactVisionText(error?.message ?? error, secret).slice(0, 1200) })
  const progress = value => { try { pending.push(Promise.resolve(onProgress(value)).catch(error => note('progress-observer', error))) } catch (error) { note('progress-observer', error) } }
  const settle = async (id, action) => { try { await action(); cleanup.push({ id, state: 'pass' }) } catch (error) { cleanup.push({ id, state: 'fail' }); note(id, error) } }
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 })
  if (await realpath(dirname(outputDirectory)) !== dirname(outputDirectory)) throw new Error('unsafe evidence parent')
  await exec('git', ['check-ignore', '--quiet', outputDirectory], { cwd: root })
  await mkdir(outputDirectory, { mode: 0o700 })
  const interrupt = () => {
    interrupted = true
    if (childPid && !childFinished) try { process.kill(-childPid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') note('signal-owned-main', error) }
  }
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  try {
    progress({ stage: 'setup', inputKind, outputDirectory })
    await mkdir(acceptanceRoot, { mode: 0o700 }); ownedStat = await lstat(acceptanceRoot)
    for (const name of ['home', 'workspace', 'dsh-home/profiles/web', 'state', 'logs', 'budget', 'tool-policy', 'xiaoshe-windows-acceptance-user-data']) await mkdir(join(acceptanceRoot, name), { recursive: true, mode: 0o700 })
    fixture = createVisionFixture({ nonce: randomBytes(16).toString('hex') })
    await save(join(outputDirectory, 'private-ground-truth.json'), fixture.manifest)
    await writeFile(join(acceptanceRoot, 'workspace/input.png'), fixture.png, { flag: 'wx', mode: 0o600 })
    port = await unusedPort()
    env = {
      PATH: process.env.PATH, HOME: join(acceptanceRoot, 'home'), TMPDIR: await realpath(tmpdir()),
      DSH_HOME: join(acceptanceRoot, 'dsh-home'), DSH_TELEMETRY_DISABLED: '1',
      XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: acceptanceRoot,
      XIAOSHE_DESKTOP_ACCEPTANCE_RUN_ID: runId, XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(acceptanceRoot, 'xiaoshe-windows-acceptance-user-data'),
      XIAOSHE_ACCEPTANCE_WORKSPACE: join(acceptanceRoot, 'workspace'), XIAOSHE_STATE_ROOT: join(acceptanceRoot, 'state'),
      XIAOSHE_DSH_LOG_DIR: join(acceptanceRoot, 'logs'), XIAOSHE_DSH_SERVICE_LABEL: label, XIAOSHE_DSH_PORT: String(port),
      XIAOSHE_DESKTOP_URL: `http://127.0.0.1:${port}/`, XIAOSHE_NODE: await realpath(process.execPath),
      XIAOSHE_PYTHON: process.env.XIAOSHE_PYTHON ?? '/opt/miniconda3/bin/python3',
      XIAOSHE_PNPM_CLI: join(process.env.HOME, '.local/share/xiaoshe/pnpm-11.7.0/node_modules/pnpm/bin/pnpm.cjs'),
      XIAOSHE_DESKTOP_ACTIONS: 'off', XIAOSHE_DSH_NO_OPEN: '1', XIAOSHE_DSH_NO_PAUSE: '1', XIAOSHE_DESKTOP_START_HIDDEN: '1',
      XIAOSHE_VISION_INPUT_KIND: inputKind, ...(clipboardAuthorized ? { XIAOSHE_VISION_CLIPBOARD_AUTHORIZED: '1' } : {}), XIAOSHE_LAUNCH_TOKEN: token,
    }
    acceptanceServiceEnvironment(env)
    if (!(await serviceAbsent(label))) throw new Error('owned launch label already exists')
    profileRoot = await createPublicProfile({ productRoot: root, acceptanceRoot, runId, environment: env })
    installation = await installIsolatedVision({ productRoot: root, acceptanceRoot, profileRoot, runId, sessionId,
      imageSha256: fixture.manifest.imageSha256, model: 'gpt-6-astra', executable: await realpath('/Applications/ChatGPT.app/Contents/Resources/codex'), authHome: '/Users/zfy/.codex' })
    await writeFile(join(profileRoot, 'cordis.patch.yml'), JSON.stringify(visionProfilePatch({ productRoot: root, acceptanceRoot, runId, sessionId, inputKind, imageSha256: fixture.manifest.imageSha256, installation }), null, 2))
    await exec(process.execPath, [join(root, 'runtime/DSH/apps/cli/lib/bin.js'), '--profile', 'web', '--dump-config'], { cwd: join(acceptanceRoot, 'workspace'), env, timeout: 30000, maxBuffer: 1024 * 1024 })
    const initialEngine = await readVisionEngineLedger(join(acceptanceRoot, 'engine-budget'))
    if (initialEngine.reservedLaunches !== 0 || initialEngine.runId !== runId || initialEngine.sessionId !== sessionId) throw new Error('engine budget not fresh')
    await save(join(outputDirectory, 'engine-before.json'), initialEngine)
    installationBefore = await verifyVisionInstallation(profileRoot, installation)
    wireSourceHashes = await readVisionWireSourceHashes()
    sourceBefore = await captureCandidate(root)
    runtimeIdentity = await productRuntimeIdentity({ root, dshRoot: join(root, 'runtime/DSH'), profileRoot })
    secret = await selectedCredential('/Users/zfy/.dsh/.credentials.yaml') // exact official ref, only for in-memory log redaction; no Codex auth read
    if (interrupted) throw new Error('interrupted before native launch')
    childFinished = false
    const observer = (async () => {
      let next = Date.now() + 15000
      while (!childFinished) {
        if (!servicePid) {
          const service = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { timeout: 5000, maxBuffer: 262144 }).catch(() => null)
          if (service && new RegExp(`XIAOSHE_LAUNCH_TOKEN(?:\\s*(?:=>|=)\\s*)${token}`, 'u').test(service.stdout)) {
            const pid = Number(service.stdout.match(/^\s*pid = (\d+)\s*$/mu)?.[1]); if (positivePid(pid)) servicePid = pid
          }
        }
        if (Date.now() >= next) { progress({ stage: 'native-vision-running', inputKind, outputDirectory, serviceObserved: Boolean(servicePid) }); next = Date.now() + 20000 }
        await delay(300)
      }
    })().catch(error => note('native-observer', error))
    try { exit = await runOwnedProcess('/bin/bash', [join(root, '启动小蛇.command'), '--acceptance-vision'], {
      cwd: root, env, timeoutMs: 450000, onSpawn: pid => { childPid = pid; progress({ stage: 'native-main', pid, port, inputKind }); if (interrupted) interrupt() },
    }) } finally { childFinished = true; await observer }
    native = await json(join(acceptanceRoot, 'vision-native.json'))
    history = await readVisionHistoryAfterNative(native, join(acceptanceRoot, 'vision-history.json'), secret)
    if (exit.code !== 0 || exit.timedOut) throw new Error(`native launcher failed (exit=${exit.code}, timeout=${exit.timedOut}, logBytes=${exit.bytes})`)
    const records = (await readFile(join(acceptanceRoot, 'xiaoshe-windows-acceptance-user-data/logs/desktop-shell.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    if (!inspectGracefulExit(records)) throw new Error('native graceful shutdown unproven')
    validateVisionNative(native, { runId, sessionId, inputKind, runtimeIdentity, imageSha256: fixture.manifest.imageSha256, acceptanceRoot, pid: exit.pid, servicePid, startedAt: createdAt, finishedAt: new Date().toISOString(), wireSourceHashes })
    if (runtimeIdentity !== await productRuntimeIdentity({ root, dshRoot: join(root, 'runtime/DSH'), profileRoot })) throw new Error('runtime changed during native vision task')
  } catch (error) { note('execution', error) }
  finally {
    await settle('owned-main-group-released', async () => {
      if (!childPid) return
      for (const pid of [-childPid, childPid]) try { process.kill(pid, 0); throw new Error('owned main process still present') } catch (error) { if (error.code !== 'ESRCH') throw error }
    })
    if (env) await settle('owned-service-released', async () => {
      if (!(await serviceAbsent(label))) {
        await exec('/bin/bash', [join(root, 'scripts/stop-xiaoshe-web.sh'), '--ownership-token', token], { cwd: root, env, timeout: 30000, maxBuffer: 262144 })
        if (!(await serviceAbsent(label))) throw new Error('owned service remains')
        note('compensated-shutdown', 'main did not release service normally')
      }
      if (servicePid) try { process.kill(servicePid, 0); throw new Error('owned backend still alive') } catch (error) { if (error.code !== 'ESRCH') throw error }
      if (childPid && !servicePid) throw new Error('actual backend PID ownership was never observed')
    })
    if (port !== undefined) await settle('owned-backend-port-released', () => assertMaterialBackendPortReleased(port))
    if (installation) {
      await settle('copied-vision-source-unchanged', async () => { installationAfter = await verifyVisionInstallation(profileRoot, installation) })
      await settle('vision-ledgers-readable', async () => {
        engineBudget = await readVisionEngineLedger(join(acceptanceRoot, 'engine-budget'))
        if (engineBudget.receipt) rawEngineStdout = await readFile(join(acceptanceRoot, 'engine-budget/stdout-1.jsonl'), 'utf8')
        ;({ envelopes, envelopeReserved } = await readVisionEnvelope(join(acceptanceRoot, 'vision-envelope'), { runId, sessionId }))
        for (const receipt of envelopes) if (receipt.errorCode !== null) note('vision-envelope-failed', receipt.errorCode)
      })
      await settle('actual-engine-and-outer-released', () => { engineCleanup = assertVisionProcessesReleased({ engineBudget, envelopes, envelopeReserved }) })
    } else if (childPid) await settle('actual-engine-and-outer-released', () => { throw new Error('engine installation identity absent') })
    if (ownedStat) {
      try { budget = await readBudgetLedger(join(acceptanceRoot, 'budget')); policy = readLiveVisionPolicyLedger(join(acceptanceRoot, 'tool-policy')) } catch (error) { note('guard-ledger-unknown', error) }
      await settle('official-wire-readable', async () => { wire = await readVisionWireLedger({ acceptanceRoot, runId, sessionId }) })
      await settle('official-wire-binding', async () => {
        if (!isDeepStrictEqual(await readVisionWireSourceHashes(), wireSourceHashes)) throw new Error('wire observer source changed')
        wireBinding = validateVisionFinalWire({ wire, native, budget, policy, history, envelopes, inputKind, imageSha256: fixture?.manifest.imageSha256,
          runId, sessionId, servicePid, startedAt: createdAt, finishedAt: new Date().toISOString(), sourceHashes: wireSourceHashes })
      })
      if (native && history && installation && fixture && engineBudget) try {
        proof = proveVisionTask({ taskId: inputKind === 'path' ? 'files-image-evidence' : 'files-attachment-evidence', runId, sessionId, history, fixture,
          input: { kind: inputKind, path: join(acceptanceRoot, 'workspace/input.png'), bytes: fixture.png,
            ...(inputKind === 'attachment' ? { attachmentId: native.delivery?.attachmentId, delivery: native.delivery } : {}) },
          engineReceipts: envelopes, processReceipt: engineBudget.receipt, rawEngineStdout,
          expectedEngine: { provider: 'codex-cli', model: 'gpt-6-astra', executableSha256: installation.engineConfig.executableSha256,
            nodeExecutableSha256: installation.outerBinding.executable.sha256, cliSha256: installation.outerBinding.cli.sha256,
            outputSchemaPath: installation.engineConfig.outputSchemaPath, outputSchemaSha256: installation.engineConfig.outputSchemaSha256 } })
      } catch (error) { note('vision-proof', error) }
      for (const name of ['workspace', 'tool-policy', 'budget', 'engine-budget', 'vision-envelope']) await settle(`retained-${name}`, async () => {
        await retainTree(join(acceptanceRoot, name), join(outputDirectory, name), secret, retention, name)
      })
      await settle('retained-wire-observations', () => retainVisionWireEvidence({ acceptanceRoot, outputDirectory, wire, secret, retention }))
      for (const [name, observed] of [['vision-native.json', native], ['vision-history.json', history]]) await settle(`retained-${name}`, () =>
        retainVisionObservedJson({ acceptanceRoot, outputDirectory, name, observed, secret, retention }))
      for (const name of ['vision-install.json', 'logs/web.log', 'logs/web.error.log', 'xiaoshe-windows-acceptance-user-data/logs/desktop-shell.jsonl']) await settle(`retained-${name.replaceAll('/', '-')}`, async () => {
        try { await lstat(join(acceptanceRoot, name)) } catch (error) { if (error.code === 'ENOENT') return; throw error }
        await retainTree(join(acceptanceRoot, name), join(outputDirectory, `raw-${name.replaceAll('/', '-')}`), secret, retention, name)
      })
      try { await copyFile(join(acceptanceRoot, 'vision-product.png'), join(outputDirectory, 'vision-product.png'), 1) } catch (error) { if (error.code !== 'ENOENT') note('screenshot-retention', error) }
      await settle('retention-manifest', () => save(join(outputDirectory, 'retention.json'), retention))
      if (cleanup.every(row => row.state === 'pass') && childFinished) await settle('isolated-profile-removed', () => removeOwnedMaterialRoot({ acceptanceRoot, ownedStat, cleanup, childFinished }))
    }
  }
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  await Promise.all(pending)
  if (interrupted) note('interrupted', 'vision acceptance interrupted; owned cleanup attempted')
  if (!budget?.mounted || budget.runId !== runId || budget.mountCount !== 1 || budget.mounts[0]?.pid !== servicePid
    || budget.maxRequests !== 8 || budget.maxOutputTokens !== 2048 || budget.reservedRequests < 1 || budget.reservedRequests > 8
    || budget.deniedRequests !== 0 || budget.requests.some(row => row.outcome !== 'finished')) note('official-ledger', 'official paid dispatch/finish or ownership incomplete')
  if (!policy?.mounted || policy.policyDigest !== native?.policyBefore?.policyDigest || !isDeepStrictEqual(policy.mounts, native?.policyBefore?.mounts)) note('policy-binding', 'tool policy changed or absent')
  if (engineBudget?.reservedLaunches !== 1 || engineBudget.runId !== runId || engineBudget.sessionId !== sessionId) note('engine-ledger', 'one owned engine launch not proven')
  const report = { schema: 'xiaoshe-vision-live/v1', runId, sessionId, inputKind, createdAt, sourceBefore: sourceBefore ?? null,
    runtimeIdentity: runtimeIdentity ?? null, executionKind: 'live_model', model: native?.model?.current ?? null, engineModel: 'gpt-6-astra',
    servicePid: servicePid ?? null, exit: exit ?? null, native: native ?? null, installation: installation ?? null, budget: budget ?? null,
    installationBinding: { before: installationBefore ?? null, after: installationAfter ?? null },
    wire, wireSourceHashes: wireSourceHashes ?? null, wireBinding,
    policy: policy ?? null, engineBudget: engineBudget ?? null, engineCleanup: engineCleanup ?? null,
    envelopeLedger: { reserved: envelopeReserved, receipts: envelopes }, proof: proof ?? null, cleanup, failures,
    monetaryHardCap: false, scope: 'real-macos-main-official-text-model-codex-cli-vision-not-native-deepseek-vision',
    retainedRoot: cleanup.some(row => row.id === 'isolated-profile-removed' && row.state === 'pass') ? null : acceptanceRoot }
  // Native failures are retained as redacted diagnostics, not a channel for
  // credential-bearing SDK exception text in the outer report.
  if (report.native?.failure?.message) report.native.failure.message = redactVisionText(report.native.failure.message, secret)
  await finishVisionEvidence(report, { outputDirectory, onProgress, redact: value => redactVisionText(value, secret) })
  return { report, outputDirectory }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { report, outputDirectory } = await runVisionLive(parseVisionLiveArgs(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify({ status: report.status, inputKind: report.inputKind, outputDirectory,
      modelRequests: report.budget?.reservedRequests ?? null, engineLaunches: report.engineBudget?.reservedLaunches ?? null, failures: report.failures })}\n`)
    if (report.status !== 'pass') process.exitCode = 1
  } catch (error) { process.stderr.write(`${redactVisionText(error.message)}\n`); process.exitCode = 1 }
}
