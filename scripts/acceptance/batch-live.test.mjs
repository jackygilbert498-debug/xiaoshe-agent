import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { assertBatchNativeExit, batchPhaseLog, batchProfilePatch, finishBatchEvidence, observeBatchStopped, ownedBatchServicePid,
  batchQualityFields, parseBatchLiveArguments, runBatchLive, validateBatchCheckpoint, validateBatchFinalBudget, validateBatchLiveOptions, validateBatchPhase } from './batch-live.mjs'

const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const at = number => new Date(Date.UTC(2026, 8, 7, 10, 0, number)).toISOString()
async function own(t) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'xs-batch-live-unit-'))); t.after(() => rm(dir, { recursive: true, force: true })); return dir }
function phaseFixture(phase = 'seed') {
  const runId = randomUUID(), sessionId = `xiaoshe-batch-${runId}`, candidateId = 'a'.repeat(64), runtimeIdentity = 'b'.repeat(64)
  const root = '/isolated/batch-root', profileRoot = root + '/dsh-home/profiles/web', servicePid = phase === 'seed' ? 102 : 104
  const beforeMount = { file: 'mounted-102-before.json', pid: 102, runId, at: at(1) }
  const currentMount = phase === 'seed' ? beforeMount : { file: 'mounted-104-after.json', pid: 104, runId, at: at(11) }
  const requests = phase === 'seed' ? [] : [{ ordinal: 1, outcome: 'finished', usage: null }]
  const previousBudget = phase === 'seed' ? null : { runId, mountCount: 1, mounts: [beforeMount], reservedRequests: 1, requests: structuredClone(requests) }
  const binding = { runId, sessionId, phase, candidateId, profileRoot, runtimeIdentity, port: 41414, pid: phase === 'seed' ? 101 : 103,
    servicePid, startedAt: phase === 'seed' ? at(0) : at(10), finishedAt: phase === 'seed' ? at(9) : at(19), previousBudget }
  const native = { schema: 'xiaoshe-batch-native/v1', runId, sessionId, phase, candidateId, profileRoot, runtimeIdentity,
    backendPort: binding.port, pid: binding.pid, backendPid: servicePid, accepted: true, startedAt: phase === 'seed' ? at(2) : at(12), finishedAt: phase === 'seed' ? at(8) : at(18),
    frontend: { backendIdentity: runtimeIdentity, candidateIdentity: runtimeIdentity, expectedRootProfileIdentity: runtimeIdentity,
      loadedFrontendIdentity: 'c'.repeat(64), frontendBuildIdentity: 'c'.repeat(64), identityMatches: true, frontendMatches: true,
      aboutRendered: true, shellPresent: true, loadedOriginMatches: true, aboutHttpStatus: 200, aboutStatus: 'current', diagnosticStatus: 'current' },
    model: { routable: true, current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' } },
    budgetBefore: { mounted: true, runId, maxRequests: 64, maxOutputTokens: 2048, deniedRequests: 0,
      mountCount: phase === 'seed' ? 1 : 2, mounts: phase === 'seed' ? [currentMount] : [beforeMount, currentMount],
      reservedRequests: requests.length, requests },
    policyBefore: { mounted: true, runId, workspaceRealPath: root + '/workspace', mounts: [{ kind: 'agent', pid: servicePid, runId, sessionId, at: currentMount.at }] } }
  return { native, binding }
}

test('native failure remains primary while nonzero exits never pass', () => {
  assert.throws(() => assertBatchNativeExit({ code: 1 }, { failure: { stage: 'browser-preparation', message: 'hidden' } }, 'seed'), /browser-preparation: hidden/u)
  assert.throws(() => assertBatchNativeExit({ code: 1 }, null, 'seed'), /exit_failed/u)
  assert.throws(() => assertBatchNativeExit({ code: 0, timedOut: true }, { accepted: true }, 'resume'), /exit_failed/u)
  assert.doesNotThrow(() => assertBatchNativeExit({ code: 0, timedOut: false }, { accepted: true }, 'seed'))
})
test('unknown CLI/API options and missing authorization fail before creating resources or dispatching', async () => {
  for (const options of [undefined, {}, { liveAuthorized: false }, { liveAuthorized: true, maxRequests: 1 },
    { liveAuthorized: true, model: 'other' }, { liveAuthorized: true, onProgress: 'invalid' }]) {
    assert.throws(() => validateBatchLiveOptions(options), /explicit_live_authorization_required/)
    await assert.rejects(runBatchLive(options), /explicit_live_authorization_required/)
  }
  assert.doesNotThrow(() => validateBatchLiveOptions({ liveAuthorized: true, onProgress() {} }))
  for (const args of [[], ['--phase', 'seed'], ['--live-authorized', '--max-requests', '1'], ['--live-authorized', '--live-authorized']]) {
    await assert.rejects(exec(process.execPath, ['scripts/acceptance/batch-live.mjs', ...args], { timeout: 10000 }), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, /requires_only_--live-authorized/); assert.ok(!error.stdout.includes('batch-setup')); return true
    })
  }
})
test('batch profile selects the actual fixed provider and scoped policy without introducing a reset ledger', () => {
  const runId = randomUUID(), sessionId = `xiaoshe-batch-${runId}`
  const patch = batchProfilePatch({ productRoot: '/product', acceptanceRoot: '/isolated', runId, sessionId, fixtureUrl: `http://127.0.0.1:41234/${runId}/` })
  const inserted = patch.find(row => row.insert).insert
  assert.equal(inserted.length, 2); assert.deepEqual(inserted[0].config.sessionIds, [sessionId])
  assert.equal(inserted[0].config.ledgerDirectory, '/isolated/tool-policy')
  assert.equal(Object.hasOwn(inserted[0].config, 'scenario'), false)
  assert.deepEqual(inserted[1].config, { acceptanceRoot: '/isolated', runId, sessionId })
  assert.ok(inserted[1].name.endsWith('/live-native-official.mjs')); assert.ok(!JSON.stringify(patch).includes('apiKey'))
  assert.throws(() => batchProfilePatch({ runId, sessionId: `xiaoshe-material-${runId}` }), /batch_session_required/)
  for (const scenario of ['normal', 'missing_input', undefined]) {
    assert.throws(() => batchProfilePatch({ productRoot: '/product', acceptanceRoot: '/isolated', runId, sessionId, fixtureUrl: `http://127.0.0.1:41234/${runId}/`, scenario }), /batch forbids scenario/)
  }
})
test('launchd PID requires this exact label and the current phase token', () => {
  const label = `com.xiaoshe.acceptance.${randomUUID()}`, token = randomUUID()
  const text = `gui/501/${label} = {\n  pid = 4321\n  environment = {\n    XIAOSHE_LAUNCH_TOKEN => ${token}\n  }\n}`
  assert.equal(ownedBatchServicePid(text, { label, token }), 4321)
  for (const changed of [{ label: label + '-other', token }, { label, token: randomUUID() }]) assert.equal(ownedBatchServicePid(text, changed), undefined)
  assert.equal(ownedBatchServicePid(text.replace('pid = 4321', 'pid = 0'), { label, token }), undefined)
})
test('old graceful shutdown records cannot stand in for current-phase shutdown', () => {
  const good = [{ event: 'ui-ready' }, { event: 'shutdown-complete', service: { stopped: true } }].map(JSON.stringify).join('\n') + '\n'
  assert.equal(batchPhaseLog('', good).length, 2)
  assert.throws(() => batchPhaseLog(good, good), /native_log_missing/)
  assert.throws(() => batchPhaseLog(good, good + JSON.stringify({ event: 'ui-ready' }) + '\n'), /normal_native_shutdown_unproven/)
  assert.throws(() => batchPhaseLog(good, 'replaced\n' + good), /native_log_replaced/)
  assert.equal(batchPhaseLog(good, good + good).length, 2)
})
test('phase guards require actual PID/time and resume retains prior request usage and mount observations', () => {
  for (const phase of ['seed', 'resume']) {
    const { native, binding } = phaseFixture(phase)
    assert.equal(validateBatchPhase(native, binding), true)
    for (const mutate of [row => { row.pid++ }, row => { row.backendPid++ }, row => { row.candidateId = 'd'.repeat(64) },
      row => { row.failure = {} }, row => { row.retentionFailure = {} }, row => { row.frontend.aboutRendered = false },
      row => { row.budgetBefore.maxRequests = 8 }, row => { row.budgetBefore.mounts.at(-1).at = at(30) },
      row => { row.policyBefore.mounts[0].sessionId = 'another-session' }, row => { row.model.current.provider = 'other-provider' }]) {
      const changed = structuredClone(native); mutate(changed); assert.throws(() => validateBatchPhase(changed, binding), /mismatch/)
    }
    if (phase === 'resume') {
      const reset = structuredClone(native); reset.budgetBefore.reservedRequests = 0; reset.budgetBefore.requests = []
      assert.throws(() => validateBatchPhase(reset, binding), /mismatch/)
      const usageChanged = structuredClone(native); usageChanged.budgetBefore.requests[0].usage = { inputTokens: 0, outputTokens: 0 }
      assert.throws(() => validateBatchPhase(usageChanged, binding), /mismatch/)
    }
  }
})
test('checkpoint binds the complete real seed history, native copy, candidate and actual save time', () => {
  const runId = randomUUID(), sessionId = `xiaoshe-batch-${runId}`, candidateId = 'a'.repeat(64)
  const events = [{ seq: 0, type: 'turn/start', time: Date.parse(at(1)), data: { turn: 1 } },
    { seq: 1, type: 'turn/end', time: Date.parse(at(3)), data: { reason: { kind: 'completed' } } }]
  const checkpoint = { runId, sessionId, candidateId, lastSeq: 1, savedAt: at(4), historySha256: sha(JSON.stringify(events)) }
  const args = { runId, sessionId, candidateId, history: { hasMore: false, events: events.map(event => ({ event })) }, nativeReport: { checkpoint, finishedAt: at(5) } }
  assert.equal(validateBatchCheckpoint(checkpoint, args).historySha256, checkpoint.historySha256)
  for (const change of [{ lastSeq: 0 }, { historySha256: '0'.repeat(64) }, { savedAt: at(2) }, { candidateId: 'other' }]) assert.throws(() => validateBatchCheckpoint({ ...checkpoint, ...change }, args), /checkpoint_mismatch/)
  assert.throws(() => validateBatchCheckpoint(checkpoint, { ...args, history: { ...args.history, hasMore: true } }), /checkpoint_mismatch/)
})
test('stop facts require ESRCH, real label absence and port rebind; EPERM or occupied port is not success', async t => {
  const identity = { pid: 22221, backendPid: 22222, backendPort: 41414, label: `com.xiaoshe.acceptance.${randomUUID()}` }
  const gone = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }
  const good = { probe: gone, absent: async () => true, portReleased: async () => {} }
  assert.equal((await observeBatchStopped(identity, good)).backendExited, true)
  await assert.rejects(observeBatchStopped(identity, { ...good, probe: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } }), { code: 'EPERM' })
  await assert.rejects(observeBatchStopped(identity, { ...good, probe: () => true }), /owned_process_still_present/)
  await assert.rejects(observeBatchStopped(identity, { ...good, absent: async () => false }), /backend_label_still_present/)
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  await assert.rejects(observeBatchStopped({ ...identity, backendPort: server.address().port }, { probe: gone, absent: async () => true }), /still occupied/)
  assert.equal(server.listening, true)
  await assert.rejects(observeBatchStopped({ ...identity, backendPort: 3080 }, good), /invalid_stop_identity/)
})
test('final budget cannot lose requests, receipt usage, mounts or either observed backend', () => {
  const { native, binding } = phaseFixture('resume'), budget = structuredClone(native.budgetBefore)
  budget.reservedRequests = 2; budget.requests.push({ ordinal: 2, outcome: 'finished', usage: null })
  const phases = { seed: { servicePid: 102 }, resume: { servicePid: 104, budgetAfter: structuredClone(budget) } }
  assert.equal(validateBatchFinalBudget(budget, phases, binding.runId), true)
  for (const mutate of [row => { row.reservedRequests = 1 }, row => { row.mountCount = 1 }, row => { row.deniedRequests = 1 },
    row => { row.requests[0].outcome = 'unknown' }, row => { row.mounts[1].pid = 105 }]) {
    const changed = structuredClone(budget); mutate(changed); assert.throws(() => validateBatchFinalBudget(changed, phases, binding.runId), /budget_incomplete/)
  }
})
function reportFixture() {
  return { runId: randomUUID(), createdAt: at(0), sourceBefore: { sha256: 'a'.repeat(64) }, runtimeIdentity: 'b'.repeat(64),
    proof: { status: 'pass', tasks: [{ taskId: 'offline-synthetic-contract', state: 'pass' }] },
    budget: { reservedRequests: 2, usage: { totalUsage: null } }, cleanup: [{ id: 'owned-backend-port-released', state: 'pass' }], failures: [] }
}
test('candidate/progress/publication failure is recorded before authoritative status; never announces early PASS', async t => {
  for (const mode of ['candidate', 'observer', 'proof-write']) {
    const outputDirectory = await own(t), report = reportFixture(), seen = []
    if (mode === 'proof-write') await mkdir(join(outputDirectory, 'proof.json'))
    await finishBatchEvidence(report, { outputDirectory, note: (stage, error) => report.failures.push({ stage, message: error.message }),
      capture: async () => mode === 'candidate' ? { sha256: 'c'.repeat(64) } : report.sourceBefore,
      onProgress: async value => { seen.push(value); if (mode === 'observer') throw new Error('observer failed') } })
    assert.equal(report.status, 'fail'); assert.equal(JSON.parse(await readFile(join(outputDirectory, 'report.json'))).status, 'fail')
    assert.ok(!seen.some(row => row.status)); assert.ok(!(await readdir(outputDirectory)).includes('task-run.json'))
  }
})
test('successful final publication preserves proof catalog checks and counts one shared two-phase journey', async t => {
  const outputDirectory = await own(t), report = reportFixture()
  await finishBatchEvidence(report, { outputDirectory, note: () => assert.fail('unexpected failure'), capture: async () => report.sourceBefore, onProgress() {} })
  const task = JSON.parse(await readFile(join(outputDirectory, 'task-run.json')))
  assert.equal(report.status, 'pass'); assert.equal(report.candidateStable, true); assert.deepEqual(task.tasks, report.proof.tasks)
  assert.equal(task.sharedJourneyMetrics.cost, null); assert.equal(task.sharedJourneyMetrics.inputTokens, null)
  assert.equal(task.finishedAt, report.finishedAt)
})


test('bounded recovery has one explicit opt-in flag and never changes the default mode', () => {
  assert.deepEqual(parseBatchLiveArguments(['--live-authorized']), { liveAuthorized: true, acceptanceMode: 'existing' })
  assert.deepEqual(parseBatchLiveArguments(['--live-authorized', '--bounded-admission-recovery']), { liveAuthorized: true, acceptanceMode: 'bounded-admission-recovery' })
  for (const args of [[], ['--bounded-admission-recovery'], ['--bounded-admission-recovery', '--live-authorized'],
    ['--live-authorized', '--bounded-admission-recovery', '--bounded-admission-recovery'], ['--live-authorized', '--allow-errors'], ['--live-authorized', '--bounded-admission-recovery', '--phase', 'resume']]) {
    assert.throws(() => parseBatchLiveArguments(args), /requires_only_/)
  }
  for (const acceptanceMode of ['existing', 'bounded-admission-recovery']) {
    assert.equal(validateBatchLiveOptions({ liveAuthorized: true, acceptanceMode }).acceptanceMode, acceptanceMode)
  }
  for (const acceptanceMode of [true, false, '', 'strict', {}, null]) assert.throws(() => validateBatchLiveOptions({ liveAuthorized: true, acceptanceMode }), /explicit_live_authorization_required/)
})

test('partial or failed resume cannot present seed-only quality as a whole-run zero-error result', () => {
  const seedProof = { status: 'pass', quality: { strictZeroToolErrors: true, failedToolCalls: 0, recoveredToolCalls: 0 } }
  const fields = batchQualityFields(undefined, seedProof)
  assert.equal(fields.quality, null)
  assert.deepEqual(fields.seedQuality, seedProof.quality)
  assert.deepEqual(batchQualityFields(undefined, undefined), { quality: null, seedQuality: null })
  const fullProof = { status: 'fail', quality: { strictZeroToolErrors: false, failedToolCalls: 2, recoveredToolCalls: 1 } }
  assert.deepEqual(batchQualityFields(fullProof, seedProof), { quality: fullProof.quality, seedQuality: seedProof.quality })
})
