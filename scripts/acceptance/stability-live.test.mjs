import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { assertStabilityJournals, finalizeStabilityReport, parseStabilityArgs, runStabilityLive, validateStabilityEvidence, verifyStabilityDisk } from './stability-live.mjs'
import { stabilityText, STABILITY_DURATION_MS } from '../../apps/desktop-shell/src/stability-acceptance.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const runtimeIdentity = 'a'.repeat(64), frontend = 'b'.repeat(64)
async function directory(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'xs-stability-proof-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Synthetic facts only exercise the independent validator, never runLive. */
function evidence() {
  const runId = randomUUID(), base = Date.parse('2026-09-07T01:00:00Z'), measured = base + 1000, samples = [], observations = []
  const processFact = pid => ({ pid, started: new Date(base - 1000).toISOString(), rssKiB: 1024, cpuSeconds: 1 })
  const processes = { main: processFact(111), backend: processFact(222) }
  const version = { product: '小蛇', bridgeState: 'ready', identityMatches: true, frontendMatches: true,
    backendIdentity: runtimeIdentity, expectedRootProfileIdentity: runtimeIdentity, candidateIdentity: runtimeIdentity,
    loadedFrontendIdentity: frontend, frontendBuildIdentity: frontend, aboutStatus: 'current', diagnosticStatus: 'current',
    aboutRendered: true, shellPresent: true, loadedOriginMatches: true, aboutHttpStatus: 200 }
  const budget = { mounted: true, runId, mode: 'no_model', mountCount: 1, attemptedRequests: 0, reservedRequests: 0,
    mounts: [{ runId, pid: 222, at: new Date(base).toISOString() }] }
  let currentMs, previousHash = hash(stabilityText(runId, -1))
  const add = (kind, slot, data) => {
    const row = { schema: 'xiaoshe-stability-sample/v1', runId, seq: samples.length + 1, kind, slot,
      elapsedMs: currentMs++, at: new Date(measured + currentMs).toISOString(), data }
    samples.push(row)
    if (kind === 'health') observations.push({ runId, nativeSeq: row.seq, at: new Date(measured + currentMs + 10).toISOString(),
      servicePid: 222, tokenMatches: true, product: '小蛇', bridgeState: 'ready', runtimeIdentity })
    if (kind === 'transaction') observations.push({ runId, nativeSeq: row.seq, at: new Date(measured + currentMs + 10).toISOString(),
      disk: { sha256: data.afterSha256, canonical: true, singleLink: true } })
  }
  const transaction = (index, slot, recovered = false) => {
    const afterSha256 = hash(stabilityText(runId, index)), transactionId = `tx-${index}`
    if (recovered) add('recovery', slot, { transactionId, state: 'prepared', beforeSha256: previousHash, afterSha256,
      beforeRendererPid: 333, afterRendererPid: 333, reloadCompleted: true, interactiveAfter: true, confirmationAbsent: true })
    add('transaction', slot, { index, transactionId, recovered, confirmationRequests: 1, beforeSha256: previousHash,
      afterSha256, apiReadSha256: afterSha256, appliedReceipts: 1, bytes: Buffer.byteLength(stabilityText(runId, index)) })
    previousHash = afterSha256
  }
  for (let slot = 0; slot <= 120; slot++) {
    currentMs = slot * 15000 + 10
    add('health', slot, { main: processes.main, backend: processes.backend, product: '小蛇', bridgeState: 'ready', runtimeIdentity,
      renderer: { pid: 333, origin: 'http://127.0.0.1:49103', shellPresent: true, readyState: 'complete', interactive: true, ownedSessionSelected: true } })
    if (slot % 4 === 0) add('resource', slot, structuredClone(processes))
    if (slot % 8 === 0) transaction(slot / 8, slot)
    if (slot === 60) transaction(1000, slot, true)
  }
  const native = { schema: 'xiaoshe-stability-native/v1', executionKind: 'product_no_model', accepted: true, runId,
    sessionId: `xiaoshe-stability-${runId}`, pid: 111, backendPid: 222, shutdown: 'pending-parent-observation',
    measuredStartedAt: new Date(measured).toISOString(), finishedAt: new Date(measured + STABILITY_DURATION_MS + 2000).toISOString(), elapsedMs: STABILITY_DURATION_MS + 20,
    frontendBefore: version, frontendAfter: structuredClone(version), budgetBefore: budget, budgetAfter: structuredClone(budget),
    onboarding: { acknowledged: true, ready: true }, noModelEvents: true, runningSessions: 0, processes,
    counts: { health: 121, resource: 31, transaction: 17, recovery: 1 } }
  const binding = { runId, pid: 111, servicePid: 222, runtimeIdentity, startedAt: base, finishedAt: measured + STABILITY_DURATION_MS + 3000, elapsedMs: STABILITY_DURATION_MS + 4000 }
  return { native, samples, observations, binding }
}
const validate = f => validateStabilityEvidence(f.native, f.samples, f.observations, f.binding)

test('fixed CLI cannot authorize implicitly, shorten duration or resume a previous run', async () => {
  assert.deepEqual(parseStabilityArgs(['--run-authorized']), { runAuthorized: true })
  for (const args of [[], ['--live-authorized'], ['--run-authorized', '--duration', '1'], ['--run-authorized', '--resume', '/tmp/x']]) assert.throws(() => parseStabilityArgs(args))
  await assert.rejects(runStabilityLive({ runAuthorized: true, durationMs: 1 }), /authorization/u)
  await assert.rejects(runStabilityLive({ runAuthorized: true, execute: () => {} }), /authorization/u)
  await assert.rejects(runStabilityLive({}), /authorization/u)
  let called = false
  await assert.rejects(runStabilityLive({ get runAuthorized() { called = true; return true } }), /authorization/u)
  await assert.rejects(runStabilityLive({ runAuthorized: true, get onProgress() { called = true; return () => {} } }), /authorization/u)
  await assert.rejects(runStabilityLive(Object.create({ runAuthorized: true })), /authorization/u)
  assert.equal(called, false, 'authorization accessors must not execute before rejection')
})

test('all 30-minute facts produce only Host soak proof, not memory-leak or model-task claims', () => {
  const proof = validate(evidence())
  assert.equal(proof.status, 'pass'); assert.equal(proof.healthSamples, 121); assert.equal(proof.resourceSamples, 31)
  assert.equal(proof.workbenchTransactions, 17); assert.equal(proof.modelRequests, 0)
  assert.match(proof.scope, /not-model-delivery/u); assert.match(proof.resourceAssessment, /observed-only/u)
  assert.equal(proof.tasks, undefined)
})

test('test execution, shortened or missing native/parent clocks never become live proof', () => {
  for (const mutate of [f => { f.native.executionKind = 'test' }, f => { f.native.elapsedMs = undefined },
    f => { f.native.elapsedMs = NaN }, f => { f.native.finishedAt = 'bad' }, f => { f.native.measuredStartedAt = 'bad' },
    f => { f.binding.elapsedMs = 1000 }, f => { f.binding.finishedAt = NaN },
    f => { f.native.budgetBefore.mounts[0].at = 'bad' }, f => { f.observations[0].at = 'bad' },
    f => { f.observations[2].at = f.observations[0].at }, f => { f.samples[0].at = 'bad' }]) {
    const f = evidence(); mutate(f); assert.throws(() => validate(f))
  }
})

test('missing samples, PID/start changes, inactive composer and incomplete onboarding fail closed', () => {
  for (const mutate of [f => { f.samples.pop() }, f => { f.observations.pop() }, f => { f.samples.find(row => row.kind === 'health').data.backend = { pid: 999, started: f.native.processes.backend.started } },
    f => { f.samples.find(row => row.kind === 'health').data.main = { pid: 111, started: '2026-09-07T02:00:00Z' } },
    f => { f.samples.find(row => row.kind === 'health').data.renderer.interactive = false },
    f => { f.samples.find(row => row.kind === 'health').data.renderer.ownedSessionSelected = false },
    f => { f.native.onboarding.acknowledged = false }, f => { f.samples[0].elapsedMs = 9000 },
    f => { f.observations[0].tokenMatches = false }, f => { f.native.budgetAfter.reservedRequests = 1 }]) {
    const f = evidence(); mutate(f); assert.throws(() => validate(f))
  }
})

test('API receipts cannot substitute for independent disk hash or pending transaction recovery', () => {
  for (const mutate of [f => { f.observations.find(row => row.disk).disk.sha256 = 'f'.repeat(64) },
    f => { f.samples.find(row => row.kind === 'transaction').data.confirmationRequests = 2 },
    f => { f.samples.find(row => row.kind === 'recovery').data.state = 'applied' },
    f => { f.samples.find(row => row.kind === 'recovery').data.confirmationAbsent = false },
    f => { f.samples.find(row => row.kind === 'recovery').data.interactiveAfter = false }]) {
    const f = evidence(); mutate(f); assert.throws(() => validate(f))
  }
})

test('real isolated disk reader rejects wrong bytes, symlinks and hardlinks', async t => {
  const dir = await directory(t), runId = randomUUID(), row = { kind: 'transaction', runId, data: { index: 1, afterSha256: hash(stabilityText(runId, 1)) } }
  await writeFile(join(dir, 'soak.txt'), stabilityText(runId, 1))
  assert.equal((await verifyStabilityDisk(dir, row)).sha256, row.data.afterSha256)
  await writeFile(join(dir, 'soak.txt'), 'wrong'); await assert.rejects(verifyStabilityDisk(dir, row), /differ/u)
  await writeFile(join(dir, 'soak.txt'), stabilityText(runId, 1)); await link(join(dir, 'soak.txt'), join(dir, 'linked'))
  await assert.rejects(verifyStabilityDisk(dir, row), /unsafe/u)
  await rm(join(dir, 'soak.txt')); await symlink(join(dir, 'linked'), join(dir, 'soak.txt'))
  await assert.rejects(verifyStabilityDisk(dir, row), /symlink/u)
})

test('raw journal byte binding detects already-consumed line replacement and missing evidence', async t => {
  const dir = await directory(t), nativePath = join(dir, 'native.jsonl'), observationsPath = join(dir, 'observations.jsonl')
  const samples = [{ seq: 1, fact: 'original' }], observations = [{ nativeSeq: 1, fact: 'disk' }]
  await writeFile(nativePath, JSON.stringify(samples[0]) + '\n'); await writeFile(observationsPath, JSON.stringify(observations[0]) + '\n')
  const input = { nativePath, observationsPath, samples, observations }
  assert.match((await assertStabilityJournals(input)).nativeSha256, /^[a-f\d]{64}$/u)
  await writeFile(nativePath, JSON.stringify({ seq: 1, fact: 'replaced' }) + '\n')
  await assert.rejects(assertStabilityJournals(input), /exact consumed/u)
  await rm(nativePath); await assert.rejects(assertStabilityJournals(input), { code: 'ENOENT' })
})

test('failed final source or async progress still leaves a durable failed report, never test PASS', async t => {
  const dir = await directory(t)
  for (const scenario of ['source', 'progress', 'test']) {
    const outputDirectory = join(dir, scenario); await mkdir(outputDirectory)
    const report = { executionKind: scenario === 'test' ? 'test' : 'product_no_model', sourceBefore: { sha256: runtimeIdentity },
      failures: [], cleanup: [{ id: 'owned', state: 'pass' }], proof: { status: 'pass' } }
    await finalizeStabilityReport(report, { outputDirectory,
      capture: async () => { if (scenario === 'source') throw new Error('unavailable'); return { sha256: runtimeIdentity } },
      onProgress: async () => { if (scenario === 'progress') throw new Error('async observer failed') } })
    assert.equal(JSON.parse(await readFile(join(outputDirectory, 'report.json'), 'utf8')).status, 'fail')
  }
})
