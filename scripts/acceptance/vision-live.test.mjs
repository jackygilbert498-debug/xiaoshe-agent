import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVisionLiveArgs, runVisionLive, visionProfilePatch, verifyVisionInstallation, validateVisionNative, assertVisionProcessesReleased,
  readVisionEnvelope, redactVisionText, readVisionHistoryAfterNative, finishVisionEvidence, validateVisionFinalWire, retainVisionWireEvidence, retainVisionObservedJson } from './vision-live.mjs'
import { installVisionWireObservation } from './vision-wire-install.mjs'
import { captureVisionEnvelope } from './vision-install.mjs'
import { removeOwnedMaterialRoot } from './material-live.mjs'
import { PATH_TOOLS, META_TOOLS } from './live-vision-policy.mjs'

const exec = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex')
const runner = fileURLToPath(new URL('./vision-live.mjs', import.meta.url))
const absent = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }
async function directory(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'xs-vision-live-test-')))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('only the two exact authorized CLI contracts parse; API calls require their own explicit authorization', async () => {
  assert.deepEqual(parseVisionLiveArgs(['--live-authorized', '--input', 'path']), { liveAuthorized: true, inputKind: 'path', clipboardAuthorized: false })
  assert.deepEqual(parseVisionLiveArgs(['--live-authorized', '--input', 'attachment', '--clipboard-authorized']), { liveAuthorized: true, inputKind: 'attachment', clipboardAuthorized: true })
  for (const args of [[], ['--input', 'path'], ['--live-authorized', '--input', 'attachment'],
    ['--live-authorized', '--input', 'path', '--clipboard-authorized'], ['--live-authorized', '--input', 'path', '--max-requests', '99'],
    ['--live-authorized', '--input', 'path', '--live-authorized'], ['--live-authorized', '--input', 'unknown']]) {
    assert.throws(() => parseVisionLiveArgs(args), /requires --live-authorized/u)
  }
  for (const options of [{}, { inputKind: 'path' }, { liveAuthorized: true, inputKind: 'attachment' },
    { liveAuthorized: true, inputKind: 'path', clipboardAuthorized: true }, { liveAuthorized: true, inputKind: 'path', run: () => {} },
    { liveAuthorized: true, inputKind: 'path', model: 'other' }, { liveAuthorized: true, inputKind: 'path', maxRequests: 999 },
    Object.defineProperty({}, 'liveAuthorized', { get() { assert.fail('getters must not run') } })]) {
    await assert.rejects(runVisionLive(options), /authorization required/u)
  }
  for (const args of [[], ['--input', 'path'], ['--live-authorized', '--input', 'attachment']]) {
    await assert.rejects(exec(process.execPath, [runner, ...args], { timeout: 10000 }), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, /requires --live-authorized/u)
      assert.equal(error.stdout, '', 'no setup/native/API action before authorization')
      return true
    })
  }
})

test('isolated Profile has one fixed official causal budget before policy and copied wrapper, no secret or fallback', () => {
  for (const inputKind of ['path', 'attachment']) {
    const patch = visionProfilePatch({ productRoot: '/public', acceptanceRoot: '/owned', runId: 'run', sessionId: 'session', inputKind,
      imageSha256: 'a'.repeat(64), installation: { pluginEntry: 'file:///owned/copied/dsh/index.js' } })
    for (const id of ['credentials', 'llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'session-title-llm', 'session-telemetry-otel']) assert.deepEqual(patch.find(row => row.id === id), { id, disabled: true })
    const inserted = patch.find(row => row.insert).insert
    assert.deepEqual(inserted.map(row => row.id), ['acceptance-vision-wire', 'acceptance-vision-budget', 'acceptance-vision-policy', 'acceptance-vision-modlens'])
    assert.deepEqual(inserted[0].config, { acceptanceRoot: '/owned', runId: 'run', sessionId: 'session' })
    assert.match(inserted[0].name, /vision-wire-install\.mjs$/u)
    assert.deepEqual(inserted[1].config, inserted[0].config)
    assert.equal(inserted[2].config.inputKind, inputKind); assert.equal(inserted[2].config.imageSha256, 'a'.repeat(64))
    assert.deepEqual(inserted[3], { id: 'acceptance-vision-modlens', name: 'file:///owned/copied/dsh/index.js', config: { upstream: 'deepseek-official', autoRead: false, timeoutMs: 120000 } })
    assert.equal(patch.find(row => row.id === 'tools').config.mode, 'native')
    assert.deepEqual(patch.find(row => row.id === 'agent-presets').config, { default: 'standard', includeUserRoot: false })
    assert(!/apiKey|DEEPSEEK_API_KEY|auth\.json|fallback/u.test(JSON.stringify(patch)))
  }
})

test('copied fileURL plugin/dependencies have independent before/after content binding beyond Profile metadata', async t => {
  const profile = await directory(t), content = 'export const synthetic = 1\n'
  await writeFile(join(profile, 'synthetic.mjs'), content)
  const manifest = { schema: 'xiaoshe-vision-isolated-files/v1', files: [{ path: 'synthetic.mjs', bytes: Buffer.byteLength(content), sha256: sha(content) }] }
  const installation = { isolatedManifest: manifest, isolatedSha256: sha(JSON.stringify(manifest)) }
  assert.equal((await verifyVisionInstallation(profile, installation)).sha256, installation.isolatedSha256)
  await writeFile(join(profile, 'synthetic.mjs'), 'export const synthetic = 2\n')
  await assert.rejects(verifyVisionInstallation(profile, installation), /copied vision plugin or dependency changed/u)
  await assert.rejects(verifyVisionInstallation(profile, { ...installation, isolatedSha256: '0'.repeat(64) }), /invalid isolated installation/u)
})

function nativeFixture(inputKind = 'path') {
  const runId = randomUUID(), sessionId = `xiaoshe-vision-${runId}`, at = '2026-09-07T10:00:01.000Z'
  const binding = { runId, sessionId, inputKind, runtimeIdentity: 'b'.repeat(64), imageSha256: 'c'.repeat(64), acceptanceRoot: '/owned',
    pid: 1234561, servicePid: 1234562, startedAt: '2026-09-07T10:00:00.000Z', finishedAt: '2026-09-07T10:00:09.000Z',
    wireSourceHashes: { observerSourceSha256: '1'.repeat(64), installerSourceSha256: '2'.repeat(64) } }
  const raw = { schema: 'xiaoshe-vision-native/v1', accepted: true, runId, sessionId, inputKind, pid: binding.pid, backendPid: binding.servicePid,
    startedAt: at, finishedAt: '2026-09-07T10:00:08.000Z', turn: { reason: 'completed' },
    finalPage: { ready: true, running: false, blocked: false, assistantCount: 1, answerText: '{"rows":[]}' },
    frontend: { backendIdentity: binding.runtimeIdentity, expectedRootProfileIdentity: binding.runtimeIdentity, candidateIdentity: binding.runtimeIdentity,
      identityMatches: true, frontendMatches: true, loadedFrontendIdentity: 'd'.repeat(64), frontendBuildIdentity: 'd'.repeat(64), frontendArtifactIdentity: 'e'.repeat(64),
      aboutRendered: true, shellPresent: true, loadedOriginMatches: true, aboutHttpStatus: 200, aboutStatus: 'current', diagnosticStatus: 'current', product: '小蛇', bridgeState: 'ready' },
    model: { routable: true, current: { provider: 'deepseek-modlens', model: 'deepseek-v4-flash' } },
    budgetBefore: { runId, mounted: true, mountCount: 1, mode: 'bounded_model', maxRequests: 8, maxOutputTokens: 2048,
      reservedRequests: 0, attemptedRequests: 0, deniedRequests: 0, requests: [], mounts: [{ runId, pid: binding.servicePid, at }] },
    policyBefore: { schema: 'xiaoshe-live-vision-policy/v1', runId, mounted: true, inputKind, imageSha256: binding.imageSha256,
      policyDigest: 'f'.repeat(64), sessionIds: [sessionId], workspaceRealPath: '/owned/workspace', imagePath: '/owned/workspace/input.png',
      allowedTools: [...inputKind === 'path' ? PATH_TOOLS : META_TOOLS],
      mounts: [{ kind: 'host', sessionId: null, runId, pid: binding.servicePid, at, policyDigest: 'f'.repeat(64) },
        { kind: 'agent', sessionId, runId, pid: binding.servicePid, at, policyDigest: 'f'.repeat(64) }] } }
  raw.wireBefore = { schema: 'xiaoshe-vision-wire-ledger/v1', runId, sessionId, mounted: true, observedAttempts: 0, requests: [],
    manifest: { schema: 'xiaoshe-vision-wire-manifest/v1', runId, sessionId, endpoint: 'https://api.deepseek.com/chat/completions',
      pid: binding.servicePid, createdAt: at, ...binding.wireSourceHashes },
    mount: { schema: 'xiaoshe-vision-wire-host-mount/v1', runId, sessionId, pid: binding.servicePid, at } }
  if (inputKind === 'attachment') {
    const attachmentId = `sha256:${binding.imageSha256}`
    const view = observedAt => ({ ready: true, source: 'session-attachment-blob', attachmentId, sessionId, sha256: binding.imageSha256,
      bytes: 5300, width: 600, height: 400, observedAt })
    raw.delivery = { attachmentId }
    raw.submitCompletedAt = '2026-09-07T10:00:02.000Z'
    raw.attachmentViews = { submitted: view('2026-09-07T10:00:03.000Z'), reloaded: view('2026-09-07T10:00:06.000Z') }
    raw.historyReload = { startedAt: '2026-09-07T10:00:04.000Z', completedAt: '2026-09-07T10:00:05.000Z' }
  }
  return { raw, binding }
}

test('native validator rejects self-reported success without actual hashes, PID, fresh guards and scope', () => {
  for (const kind of ['path', 'attachment']) { const { raw, binding } = nativeFixture(kind); assert.equal(validateVisionNative(raw, binding), true) }
  const mutations = [
    r => r.accepted = false, r => r.runId = randomUUID(), r => r.pid++, r => r.turn.reason = 'cancelled',
    r => r.startedAt = '2026-09-06T10:00:01.000Z', r => r.failure = { message: 'failed' },
    r => r.frontend.backendIdentity = '0'.repeat(64), r => r.frontend.frontendBuildIdentity = '0'.repeat(64),
    r => r.frontend.frontendArtifactIdentity = null, r => r.frontend.aboutStatus = 'stale', r => r.frontend.diagnosticStatus = 'unknown',
    r => r.frontend.bridgeState = 'connecting', r => r.frontend.loadedOriginMatches = false,
    r => r.model.current.provider = 'deepseek-official', r => r.budgetBefore.maxRequests = 16,
    r => delete r.finalPage, r => r.finalPage.running = true, r => r.finalPage.blocked = true, r => r.finalPage.answerText = '',
    r => r.budgetBefore.reservedRequests = 1, r => r.budgetBefore.deniedRequests = 1, r => r.budgetBefore.mounts[0].pid++,
    r => r.budgetBefore.mounts[0].at = '2026-09-06T10:00:01.000Z', r => r.policyBefore.mounts[1].sessionId = 'foreign',
    r => r.policyBefore.mounts[0].pid++, r => r.policyBefore.policyDigest = '0'.repeat(64),
    r => r.policyBefore.allowedTools.push('bash'), r => r.policyBefore.workspaceRealPath = '/daily',
    r => delete r.wireBefore, r => r.wireBefore.mount.pid++, r => r.wireBefore.manifest.observerSourceSha256 = '9'.repeat(64),
    r => r.wireBefore.observedAttempts = 1, r => r.wireBefore.mount.at = '2026-09-06T10:00:01.000Z',
    r => r.wireBefore.manifest.sessionId = 'foreign', r => r.wireBefore.mount.at = '2026-09-07 10:00:01.000Z',
  ]
  for (const mutate of mutations) { const { raw, binding } = nativeFixture(); mutate(raw); assert.throws(() => validateVisionNative(raw, binding)) }
})

test('pasted image must be decoded from identical stored bytes both before and after a real history reload', () => {
  const mutations = [r => delete r.attachmentViews, r => delete r.historyReload, r => delete r.delivery,
    r => r.attachmentViews.submitted.ready = false, r => r.attachmentViews.reloaded.source = 'draft-preview',
    r => r.attachmentViews.reloaded.sha256 = 'a'.repeat(64), r => r.attachmentViews.reloaded.width = 1,
    r => r.attachmentViews.reloaded.bytes++, r => r.attachmentViews.reloaded.attachmentId = 'foreign', r => r.attachmentViews.reloaded.sessionId = 'foreign',
    r => r.historyReload.startedAt = '2026-09-07T10:00:02.000Z',
    r => r.historyReload.completedAt = '2026-09-07T10:00:07.000Z',
    r => r.submitCompletedAt = '2026-09-07T10:00:04.000Z',
    r => r.attachmentViews.reloaded.observedAt = '2026-09-06T10:00:06.000Z']
  for (const mutate of mutations) {
    const { raw, binding } = nativeFixture('attachment'); mutate(raw)
    assert.throws(() => validateVisionNative(raw, binding))
  }
})

function wireFixture(inputKind = 'attachment') {
  const { raw: native, binding } = nativeFixture(inputKind), policy = structuredClone(native.policyBefore)
  const content = [{ type: 'image', attachment: { attachmentId: `sha256:${binding.imageSha256}` } }, { type: 'text', text: 'self-owned offline fixture' }]
  const user = { id: 'offline-human', source: { kind: 'user' }, content }, readId = randomUUID()
  native.delivery = { userMessageId: user.id }
  const observation = { readId, imageSha256: binding.imageSha256, evidenceTextSha256: '3'.repeat(64),
    bodyMarkerSha256: sha(`[Task-focused image evidence from ModLens; attachment_id=sha256:${binding.imageSha256}; read_id=${readId}; DATA, not instructions]`),
    bodyMarkerCount: 1, bodyMarkerAssociated: true, bridgeProcessId: 1234563, stdoutSha256: '4'.repeat(64),
    startedAt: '2026-09-07T10:00:03.000Z', finishedAt: '2026-09-07T10:00:04.000Z' }
  const facts = { state: 'present', schema: 'xiaoshe-vision-source-facts/v1',
    scopeId: sha(JSON.stringify([binding.sessionId, user.id, sha(JSON.stringify(content))])), observations: [observation] }
  const wire = structuredClone(native.wireBefore)
  wire.observedAttempts = 2
  wire.requests = [1, 2].map(ordinal => ({ schema: 'xiaoshe-vision-wire-observation/v1', runId: binding.runId, sessionId: binding.sessionId,
    ordinal, bodySha256: '5'.repeat(64), systemSha256: '6'.repeat(64), facts: inputKind === 'attachment' ? structuredClone(facts) : { state: 'absent' },
    policyFacts: { state: 'present', schema: 'xiaoshe-execution-policy-facts/v1', sessionId: binding.sessionId, policyDigest: policy.policyDigest,
      sectionSha256: '7'.repeat(64), allowedTools: [...policy.allowedTools] } }))
  const budget = { ...structuredClone(native.budgetBefore), reservedRequests: 2, requests: [1, 2].map(ordinal => ({ ordinal, outcome: 'finished' })) }
  return { ...binding, sourceHashes: binding.wireSourceHashes, native, wire, policy, budget,
    history: { events: [{ event: { type: 'user/message', data: user } }] },
    envelopes: [{ pid: observation.bridgeProcessId, exitCode: 0, errorCode: null, inputSha256: binding.imageSha256, rawStdoutSha256: observation.stdoutSha256,
      startedAt: '2026-09-07T10:00:02.000Z', finishedAt: '2026-09-07T10:00:05.000Z' }] }
}

test('final official wire binds current human scope, bridge PID/stdout/time, marker and one stable cached receipt; path facts may be absent', () => {
  for (const kind of ['attachment', 'path']) {
    const value = wireFixture(kind), result = validateVisionFinalWire(value)
    assert.equal(result.state, 'pass'); assert.equal(result.observedAttempts, 2); assert.equal(result.causalBudgetPermit, false)
  }
  for (const change of [x => x.wire = null, x => x.wire.mount.pid++, x => x.sourceHashes.observerSourceSha256 = '0'.repeat(64),
    x => x.budget.reservedRequests++, x => x.budget.requests[0].outcome = 'failed', x => x.budget.deniedRequests++,
    x => x.wire.requests[1].ordinal = 3, x => x.wire.requests[0].policyFacts = { state: 'absent' },
    x => x.wire.requests[0].policyFacts.allowedTools.push('bash'), x => x.wire.requests[1].policyFacts.policyDigest = '0'.repeat(64),
    x => x.wire.requests[0].facts = { state: 'absent' }, x => x.history.events[0].event.data.content[1].text += 'new task',
    x => x.native.delivery.userMessageId = 'foreign-human', x => x.wire.requests[0].facts.scopeId = '0'.repeat(64),
    x => x.wire.requests[0].facts.observations[0].bodyMarkerCount = 2,
    x => x.wire.requests[0].facts.observations[0].bodyMarkerSha256 = '0'.repeat(64),
    x => x.wire.requests[0].facts.observations[0].imageSha256 = '0'.repeat(64),
    x => x.wire.requests[0].facts.observations[0].bridgeProcessId++, x => x.envelopes[0].rawStdoutSha256 = '0'.repeat(64),
    x => x.envelopes[0].errorCode = 'outer_input_changed', x => delete x.envelopes[0].errorCode,
    x => x.wire.requests[0].facts.observations[0].startedAt = '2026-09-07T10:00:01.000Z',
    x => x.wire.requests[1].facts.observations[0].evidenceTextSha256 = '0'.repeat(64),
    x => x.wire.requests[1].facts.observations[0].readId = randomUUID()]) {
    const value = wireFixture(); change(value); assert.throws(() => validateVisionFinalWire(value))
  }
})

async function retainedWireFixture(t) {
  const parent = await directory(t), runId = randomUUID(), acceptanceRoot = join(parent, `xiaoshe-product-acceptance-${runId}`), outputDirectory = join(parent, 'retained')
  await mkdir(acceptanceRoot, { mode: 0o700 }); await mkdir(outputDirectory, { mode: 0o700 })
  const config = { acceptanceRoot, runId, sessionId: `xiaoshe-vision-${runId}` }
  const observer = installVisionWireObservation(config, { fetchTarget: { fetch: async () => new Response('offline') } })
  await observer.ready; const wire = await observer.snapshot(); await observer.dispose()
  return { ...config, outputDirectory, wire, retention: [], secret: undefined }
}

test('required wire evidence is retained and independently byte-checked before the owned root can be removed', async t => {
  const f = await retainedWireFixture(t)
  await retainVisionWireEvidence(f)
  assert.equal(f.retention.length, 2); assert(f.retention.every(row => row.redacted === false && /^[a-f0-9]{64}$/u.test(row.sha256)))
  for (const name of ['manifest.json', 'host-mounted.json']) assert.deepEqual(await readFile(join(f.outputDirectory, 'wire-observations', name)), await readFile(join(f.acceptanceRoot, 'wire-observations', name)))
  const cleanup = [{ id: 'retained-wire-observations', state: 'pass' }], ownedStat = await lstat(f.acceptanceRoot)
  await removeOwnedMaterialRoot({ acceptanceRoot: f.acceptanceRoot, ownedStat, cleanup, childFinished: true })
  await assert.rejects(lstat(f.acceptanceRoot), { code: 'ENOENT' })
})

test('wire reader/copy failures preserve evidence and prevent root deletion rather than reusing wireBefore', async t => {
  for (const mode of ['corrupt-current', 'missing-current', 'copy-collision', 'unknown-final']) {
    const f = await retainedWireFixture(t), path = join(f.acceptanceRoot, 'wire-observations/host-mounted.json'), ownedStat = await lstat(f.acceptanceRoot)
    if (mode === 'corrupt-current') await writeFile(path, '{"invalid":true}')
    if (mode === 'missing-current') await rm(path)
    if (mode === 'copy-collision') await mkdir(join(f.outputDirectory, 'wire-observations'))
    if (mode === 'unknown-final') f.wire = null
    await assert.rejects(retainVisionWireEvidence(f))
    const cleanup = [{ id: 'retained-wire-observations', state: 'fail' }]
    await assert.rejects(removeOwnedMaterialRoot({ acceptanceRoot: f.acceptanceRoot, ownedStat, cleanup, childFinished: true }), /root retained/u)
    assert((await lstat(f.acceptanceRoot)).isDirectory())
    if (mode === 'corrupt-current') assert.equal(await readFile(join(f.outputDirectory, 'wire-observations/host-mounted.json'), 'utf8'), '{"invalid":true}')
  }
})

test('native/history already read by the run cannot disappear or be replaced before required raw retention', async t => {
  for (const name of ['vision-native.json', 'vision-history.json']) for (const mutation of ['delete', 'replace']) {
    const acceptanceRoot = await directory(t), outputDirectory = await directory(t), source = join(acceptanceRoot, name)
    await writeFile(source, '{"fixture":"previously-validated","accepted":true}')
    const observed = JSON.parse(await readFile(source, 'utf8')), ownedStat = await lstat(acceptanceRoot)
    if (mutation === 'delete') await rm(source)
    else await writeFile(source, '{"fixture":"replacement","accepted":true}')
    await assert.rejects(retainVisionObservedJson({ acceptanceRoot, outputDirectory, name, observed, retention: [] }))
    const cleanup = [{ id: `retained-${name}`, state: 'fail' }]
    await assert.rejects(removeOwnedMaterialRoot({ acceptanceRoot, ownedStat, cleanup, childFinished: true }), /root retained/u)
    assert((await lstat(acceptanceRoot)).isDirectory())
    if (mutation === 'replace') assert.equal(JSON.parse(await readFile(join(outputDirectory, `raw-${name}`))).fixture, 'replacement', 'retain diagnostic replacement without declaring it validated')
  }
})

test('required JSON retention accepts original whitespace/key order and records actual raw hash plus redacted copy hash', async t => {
  const acceptanceRoot = await directory(t), outputDirectory = await directory(t), name = 'vision-native.json', retention = []
  const raw = '  { "accepted": true, "failure": { "message": "fixture-secret" } }\n\n'
  await writeFile(join(acceptanceRoot, name), raw)
  const observed = { failure: { message: 'fixture-secret' }, accepted: true }
  assert.equal(await retainVisionObservedJson({ acceptanceRoot, outputDirectory, name, observed, secret: 'fixture-secret', retention }), true)
  const copied = await readFile(join(outputDirectory, `raw-${name}`), 'utf8')
  assert.equal(copied, raw.replace('fixture-secret', '[REDACTED]'))
  assert.equal(retention[0].sourceSha256, sha(raw)); assert.equal(retention[0].sha256, sha(copied)); assert.equal(retention[0].redacted, true)
  assert(!JSON.stringify(retention).includes('fixture-secret'))
  assert.equal(await retainVisionObservedJson({ acceptanceRoot, outputDirectory, name: 'vision-history.json', observed: undefined, retention }), false,
    'setup before any submitted history does not invent a missing-evidence failure')
})

const receipt = pid => ({ pid, cleanup: { status: 'confirmed', confirmedBy: 'ESRCH', groupId: pid } })
function processes() {
  return { engineBudget: { reservedLaunches: 1, launch: { pid: 1234563 }, receipt: receipt(1234563) }, envelopes: [receipt(1234564)], envelopeReserved: true }
}
test('actual Codex PID and PGID are checked separately from outer Node; all probes are non-mutating', () => {
  const observed = [], result = assertVisionProcessesReleased(processes(), (pid, signal) => { observed.push([pid, signal]); absent() })
  assert.deepEqual(observed, [[-1234564, 0], [1234564, 0], [-1234563, 0], [1234563, 0]])
  assert.equal(result.state, 'pass'); assert.equal(result.observations.length, 2)
  assert.deepEqual(assertVisionProcessesReleased({ engineBudget: { reservedLaunches: 0 }, envelopes: [], envelopeReserved: false }, () => assert.fail('no process launched')).observations, [])
  for (const livePid of [-1234563, 1234563]) assert.throws(() => assertVisionProcessesReleased(processes(), pid => { if (pid !== livePid) absent() }), /still present/u)
  assert.throws(() => assertVisionProcessesReleased(processes(), () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }), /denied/u)
  for (const modify of [x => x.engineBudget = null, x => x.engineBudget.receipt = null, x => x.envelopes = [],
    x => { x.envelopeReserved = false; x.envelopes = [] }, x => { x.envelopeReserved = null }, x => { delete x.envelopeReserved },
    x => x.engineBudget.receipt.pid = 1234564, x => x.engineBudget.receipt.cleanup.confirmedBy = 'parent-exit',
    x => x.engineBudget.receipt.pid = process.pid]) {
    const value = processes(); modify(value); assert.throws(() => assertVisionProcessesReleased(value, absent))
  }
})

test('incomplete actual-engine evidence retains the exact owned test directory', async t => {
  const acceptanceRoot = await directory(t), ownedStat = await lstat(acceptanceRoot)
  await writeFile(join(acceptanceRoot, 'evidence'), 'keep')
  const value = processes(); value.engineBudget.receipt = null
  const cleanup = [{ id: 'owned-main-group-released', state: 'pass' }]
  try { assertVisionProcessesReleased(value, absent); assert.fail('must reject') } catch { cleanup.push({ id: 'actual-engine-and-outer-released', state: 'fail' }) }
  await assert.rejects(removeOwnedMaterialRoot({ acceptanceRoot, ownedStat, cleanup, childFinished: true }), /root retained/u)
  assert.equal(await readFile(join(acceptanceRoot, 'evidence'), 'utf8'), 'keep')
})

test('outer ledger reader verifies fresh slot identity and raw output hash rather than accepting parsed JSON alone', async t => {
  const path = await directory(t), runId = randomUUID(), sessionId = `xiaoshe-vision-${runId}`
  assert.deepEqual(await readVisionEnvelope(path, { runId, sessionId }), { envelopes: [], envelopeReserved: false })
  await writeFile(join(path, 'reserved-1.json'), JSON.stringify({ runId, sessionId, ordinal: 1, startedAt: '2026-09-07T10:00:01.000Z' }))
  assert.deepEqual(await readVisionEnvelope(path, { runId, sessionId }), { envelopes: [], envelopeReserved: true })
  const raw = '{"result":{"summary":"synthetic only"}}', row = { schema: 'xiaoshe-vision-envelope/v1', runId, sessionId, ordinal: 1,
    exitCode: 0, errorCode: null, rawStdoutSha256: sha(raw), output: JSON.parse(raw) }
  await writeFile(join(path, 'stdout-1.json'), raw); await writeFile(join(path, 'receipt-1.json'), JSON.stringify(row))
  assert.deepEqual(await readVisionEnvelope(path, { runId, sessionId }), { envelopes: [row], envelopeReserved: true })
  await assert.rejects(readVisionEnvelope(path, { runId: randomUUID(), sessionId }), /reservation identity/u)
  await writeFile(join(path, 'stdout-1.json'), '{}'); await assert.rejects(readVisionEnvelope(path, { runId, sessionId }), /raw receipt mismatch/u)
})

test('actual outer capture preserves empty or malformed failed stdout and keeps the outer PID independently probeable', async t => {
  for (const sample of [
    { code: 1, stdout: '', errorCode: 'MODLENS_EXIT_FAILED' },
    { code: 1, stdout: '{"partial":true}', errorCode: 'MODLENS_EXIT_FAILED' },
    { code: 0, stdout: 'not JSON', errorCode: 'outer_invalid_json' },
    { code: 0, stdout: '{"image":"wrong-image"}', errorCode: 'outer_output_identity_changed' },
  ]) {
    const acceptanceRoot = await directory(t), runId = randomUUID(), sessionId = `xiaoshe-vision-${runId}`
    const envelopeDirectory = join(acceptanceRoot, 'envelope'), cliPath = join(acceptanceRoot, 'cli.mjs'), input = join(acceptanceRoot, 'input.png')
    await mkdir(envelopeDirectory, { mode: 0o700 }); await writeFile(cliPath, '// offline capture fixture; never executed\n'); await writeFile(input, 'synthetic image bytes')
    const stat = await lstat(acceptanceRoot), executablePath = await realpath(process.execPath)
    const binding = { acceptanceRoot, rootDevice: stat.dev, rootInode: stat.ino, envelopeDirectory, runId, sessionId, model: 'offline-only',
      executable: { path: executablePath, sha256: sha(await readFile(executablePath)) },
      cli: { path: cliPath, sha256: sha(await readFile(cliPath)) }, imageSha256: sha(await readFile(input)) }
    // The real capture writes its actual failure shape. Only its subprocess
    // runner and zero-signal cleanup probes are explicit offline substitutes.
    await assert.rejects(captureVisionEnvelope(binding, async () => ({ ...sample, stderr: '', cleanup: receipt(1234564).cleanup }),
      executablePath, [cliPath, '-i', input, '--timeout', '3000'], undefined, 3000), { code: sample.errorCode })
    const read = await readVisionEnvelope(envelopeDirectory, { runId, sessionId })
    assert.equal(read.envelopeReserved, true); assert.equal(read.envelopes.length, 1)
    const envelope = read.envelopes[0]
    assert.equal(envelope.pid, 1234564); assert.equal(envelope.exitCode, sample.code); assert.equal(envelope.errorCode, sample.errorCode)
    assert.equal(envelope.rawStdoutSha256, sha(sample.stdout))
    if (sample.errorCode !== 'outer_output_identity_changed') assert.equal(envelope.output, null)
    const probes = []
    assert.equal(assertVisionProcessesReleased({ engineBudget: processes().engineBudget, ...read }, pid => { probes.push(pid); absent() }).state, 'pass')
    assert.deepEqual(probes, [-1234564, 1234564, -1234563, 1234563], 'successful cleanup of failed execution still checks both processes')
    envelope.rawStdoutSha256 = '0'.repeat(64)
    await writeFile(join(envelopeDirectory, 'receipt-1.json'), JSON.stringify(envelope))
    await assert.rejects(readVisionEnvelope(envelopeDirectory, { runId, sessionId }), /raw receipt mismatch/u)
  }
})

test('success cannot borrow empty failure bytes and unreadable reservation never means no launch', async t => {
  const path = await directory(t), runId = randomUUID(), sessionId = `xiaoshe-vision-${runId}`
  await writeFile(join(path, 'reserved-1.json'), JSON.stringify({ runId, sessionId, ordinal: 1, startedAt: '2026-09-07T10:00:01.000Z' }))
  const row = { schema: 'xiaoshe-vision-envelope/v1', runId, sessionId, ordinal: 1,
    ...receipt(1234564), exitCode: 1, errorCode: 'MODLENS_EXIT_FAILED', rawStdoutSha256: sha(''), output: null }
  await writeFile(join(path, 'stdout-1.json'), '')
  for (const change of [r => { r.errorCode = null; r.exitCode = 0 }, r => { delete r.errorCode },
    r => { r.errorCode = '' }, r => { r.errorCode = false }, r => { r.output = {} }]) {
    const invalid = structuredClone(row); change(invalid)
    await writeFile(join(path, 'receipt-1.json'), JSON.stringify(invalid))
    // Match the runner's unknown initial state: failed assignment must not
    // leave a false/no-launch value that skips the missing outer process.
    let envelopes = [], envelopeReserved = null
    await assert.rejects(async () => { ({ envelopes, envelopeReserved } = await readVisionEnvelope(path, { runId, sessionId })) })
    assert.equal(envelopeReserved, null)
    assert.throws(() => assertVisionProcessesReleased({ engineBudget: processes().engineBudget, envelopes, envelopeReserved },
      () => assert.fail('unknown outer launch cannot produce a successful cleanup observation')), /evidence incomplete/u)
  }
})

function reportFixture() {
  return { schema: 'xiaoshe-vision-live/v1', runId: randomUUID(), inputKind: 'path', createdAt: new Date().toISOString(), sourceBefore: { sha256: 'a'.repeat(64) },
    runtimeIdentity: 'b'.repeat(64), proof: { state: 'pass', taskId: 'files-image-evidence', checks: [{ id: 'synthetic-only', state: 'pass' }], engineUsage: { status: 'unknown', inputTokens: null, outputTokens: null } },
    budget: { reservedRequests: 1, usage: { totalUsage: null } }, cleanup: [{ id: 'all-synthetic-test-cleanup', state: 'pass' }], failures: [] }
}

test('finalization persists failure on source drift/snapshot errors and never creates a successful task', async t => {
  for (const capture of [async () => { throw new Error('snapshot unavailable') }, async () => ({ sha256: 'c'.repeat(64) })]) {
    const outputDirectory = await directory(t), report = reportFixture(), progress = []
    await finishVisionEvidence(report, { outputDirectory, capture, onProgress: x => progress.push(x) })
    assert.equal(report.status, 'fail'); assert(report.failures.some(row => row.stage === 'source-binding'))
    assert.deepEqual(await readdir(outputDirectory), ['proof.json', 'report.json'])
    assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, 'report.json'), 'utf8')), report)
    assert.equal(progress[0].status, undefined)
  }
})

test('async observer rejection and proof write failure happen before final status is saved', async t => {
  const outputDirectory = await directory(t), report = reportFixture()
  await finishVisionEvidence(report, { outputDirectory, capture: async () => report.sourceBefore, onProgress: async () => { throw new Error('Bearer test-secret') } })
  assert.equal(report.status, 'fail'); assert(!JSON.stringify(report).includes('test-secret'))
  assert(!((await readdir(outputDirectory)).includes('task-run.json')))
  const other = await directory(t), failure = reportFixture()
  await writeFile(join(other, 'proof.json'), 'existing evidence')
  await finishVisionEvidence(failure, { outputDirectory: other, capture: async () => failure.sourceBefore, onProgress: () => {} })
  assert.equal(failure.status, 'fail'); assert(failure.failures.some(row => row.stage === 'proof-retention'))
  assert.equal(await readFile(join(other, 'proof.json'), 'utf8'), 'existing evidence')
})

test('matching proof emits one bound task and keeps unknown official/engine usage null, never zero', async t => {
  const outputDirectory = await directory(t), report = reportFixture()
  await finishVisionEvidence(report, { outputDirectory, capture: async () => report.sourceBefore, onProgress: () => {} })
  assert.equal(report.status, 'pass')
  const task = JSON.parse(await readFile(join(outputDirectory, 'task-run.json'), 'utf8'))
  assert.equal(task.tasks.length, 1); assert.equal(task.tasks[0].taskId, 'files-image-evidence')
  assert.equal(task.binding.sourceSha256, report.sourceBefore.sha256); assert.equal(task.binding.runtimeIdentity, report.runtimeIdentity)
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cost']) assert.equal(task.sharedJourneyMetrics[key], null)
  assert.equal(task.engineUsage.inputTokens, null); assert.equal(task.monetaryHardCap, false)
})

test('redaction covers exact selected official secret and common authorization tokens without accessing credential files', () => {
  const text = redactVisionText('secret-example Bearer token-example apiKey="key-example" refresh_token: refresh-example safe', 'secret-example')
  for (const secret of ['secret-example', 'token-example', 'key-example', 'refresh-example']) assert(!text.includes(secret))
  assert(text.includes('safe'))
})

test('real native failure takes precedence over absent history and is redacted before propagation', async t => {
  const path = await directory(t), historyPath = join(path, 'vision-history.json')
  const failure = { accepted: false, failure: { stage: 'native-image-paste', message: 'clipboard.writeBuffer is not a function; fixture-secret' } }
  await assert.rejects(readVisionHistoryAfterNative(failure, historyPath, 'fixture-secret'), error => {
    assert.match(error.message, /native-image-paste.*clipboard\.writeBuffer is not a function/u)
    assert(!error.message.includes('fixture-secret')); assert(!error.message.includes('ENOENT'))
    return true
  })
  for (const native of [{ accepted: false }, { accepted: true, failure: { stage: 'paste', message: 'paste failed' } },
    { accepted: true, retentionFailure: { message: 'native history retention failed' } }]) {
    await assert.rejects(readVisionHistoryAfterNative(native, historyPath), error => {
      assert.match(error.message, /native vision failed/u); assert(!error.message.includes('ENOENT')); return true
    })
  }
  assert.deepEqual(await readdir(path), [], 'no history is fabricated for an unsubmitted native turn')
})

test('an accepted native phase still requires real readable history; no failure fallback relaxes acceptance', async t => {
  const path = await directory(t), historyPath = join(path, 'vision-history.json'), native = nativeFixture().raw
  await assert.rejects(readVisionHistoryAfterNative(native, historyPath), { code: 'ENOENT' })
  const history = { hasMore: false, events: [] }
  await writeFile(historyPath, JSON.stringify(history))
  assert.deepEqual(await readVisionHistoryAfterNative(native, historyPath), history)
  await writeFile(historyPath, 'invalid history')
  await assert.rejects(readVisionHistoryAfterNative(native, historyPath), SyntaxError)
})
