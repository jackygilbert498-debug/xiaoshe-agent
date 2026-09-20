import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MATERIAL_SUITE_PLAN, readRetainedMaterialEvidence, runMaterialSuite, runMaterialSuiteTest } from './material-suite.mjs'
import { createBudgetGate } from './live-request-budget.mjs'

const exec = promisify(execFile)
const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = { commit: 'synthetic', files: 2, sha256: 'a'.repeat(64) }
const changed = { ...source, sha256: 'b'.repeat(64) }
const capture = async () => source
const pass = id => ({ id, state: 'pass', checks: [{ id: 'synthetic-fact', state: 'pass' }] })
const releaseIds = ['owned-main-group-released', 'owned-service-released', 'owned-backend-port-released', 'owned-fixture-closed',
  'retained-workspace', 'retained-tool-policy', 'retained-budget', 'retained-server', 'isolated-profile-removed']

function fakeResult(scenario, index = 0) {
  const runId = randomUUID(), at = new Date().toISOString(), sessionId = `xiaoshe-material-${runId}`
  const isBusiness = scenario === 'normal' || scenario === 'response_lost'
  const tasks = isBusiness ? ['material-browser-delivery', 'browser-form-delivery'].map(taskId => ({ taskId, state: 'pass', checks: [{ id: 'synthetic-fact', state: 'pass' }] })) : []
  const regressions = scenario === 'normal' ? [] : [pass(scenario === 'response_lost' ? 'material-response-lost-recovery'
    : scenario === 'missing_input' ? 'material-missing-input-safe-stop' : 'material-user-takeover-safe-stop')]
  return { outputDirectory: join(productRoot, 'output/stabilization', `material-live-${runId}`),
    report: { schema: 'xiaoshe-material-live/v1', executionKind: 'live_model', runId, sessionId, scenario,
      createdAt: at, finishedAt: at, sourceBefore: source, sourceAfter: source,
      runtimeIdentity: createHash('sha256').update(runId).digest('hex'),
      model: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' },
      status: 'pass', failures: [], exit: { code: 0, timedOut: false, signal: null, pid: 1000 + index },
      servicePid: 2000 + index, retainedRoot: null, cleanup: releaseIds.map(id => ({ id, state: 'pass' })),
      budget: { mounted: true, runId, mode: 'bounded_model', maxRequests: 64, reservedRequests: 1, attemptedRequests: 1, deniedRequests: 0,
        requests: [{ ordinal: 1, outcome: 'finished' }], mounts: [{ runId, pid: 2000 + index, at }],
        usage: { status: 'reported', totalUsage: { inputTokens: 100, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: null } } },
      proof: { schema: 'xiaoshe-material-task-proof/v1', runId, sessionId, scenario, status: 'pass', tasks, regressions } } }
}

// Synthetic execution only: real owned files and the production ledger writer /
// reader, but the stream below never imports an adapter or calls a provider.
async function persistedResult(t, scenario, { requests = 1, outputLimit = false, noLedger = false } = {}) {
  const value = fakeResult(scenario)
  await mkdir(dirname(value.outputDirectory), { recursive: true, mode: 0o700 })
  await mkdir(value.outputDirectory, { mode: 0o700 })
  t.after(() => rm(value.outputDirectory, { recursive: true, force: true }))
  if (noLedger) {
    value.report.budget = undefined
    value.report.servicePid = undefined
  } else {
    const gate = createBudgetGate({ ledgerDirectory: join(value.outputDirectory, 'budget'), runId: value.report.runId,
      maxRequests: 64, provider: 'offline', model: 'synthetic', sessionIds: [value.report.sessionId] },
    { retryPolicy: () => ({ mode: 'normal', maxRetries: 0 }) })
    await gate.ready
    for (let ordinal = 1; ordinal <= requests; ordinal++) {
      for await (const _ of gate.stream({ provider: 'offline', model: 'synthetic', sessionId: value.report.sessionId, maxTokens: 2048 }, async function* () {
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 2, cacheReadTokens: 0 } }
        yield { type: 'finish', reason: { kind: outputLimit && ordinal === requests ? 'max-tokens' : 'stop' } }
      })) { /* Consume offline chunks so the real writer finalizes each receipt. */ }
    }
    value.report.budget = await gate.snapshot()
    value.report.servicePid = process.pid
  }
  if (outputLimit || noLedger) {
    value.report.status = 'fail'
    value.report.proof = undefined
    value.report.model = null
    value.report.exit.code = 1
    value.report.failures = [{ stage: 'execution', message: 'synthetic native exit failure' }]
  }
  value.report.finishedAt = new Date().toISOString()
  await writeFile(join(value.outputDirectory, 'report.json'), `${JSON.stringify(value.report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return value
}

test('fixed twenty-run plan is immutable and interleaves each scenario five times', () => {
  assert.equal(MATERIAL_SUITE_PLAN.length, 20)
  assert(Object.isFrozen(MATERIAL_SUITE_PLAN))
  assert(MATERIAL_SUITE_PLAN.every(Object.isFrozen))
  assert.deepEqual(MATERIAL_SUITE_PLAN.map(row => row.scenario), Array.from({ length: 5 }, () => ['normal', 'missing_input', 'response_lost', 'takeover']).flat())
  assert.equal(MATERIAL_SUITE_PLAN.filter(row => row.kind === 'business_journey').length, 10)
  assert.equal(MATERIAL_SUITE_PLAN.filter(row => row.kind === 'safe_stop_regression').length, 10)
})

test('offline executor is serial, retains independent identities and counts journeys separately from safe stops', async t => {
  let active = 0, calls = 0, network = 0
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('offline only') })
  const checkpoints = [], progress = []
  const report = await runMaterialSuiteTest({ capture, onCheckpoint: async (value, stage) => checkpoints.push({ value, stage }), onProgress: value => progress.push(value),
    run: async ({ scenario, onProgress }) => {
      assert.equal(active++, 0, 'native runs must never overlap')
      const value = fakeResult(scenario, calls++)
      await onProgress({ stage: 'synthetic-owned-run', outputDirectory: value.outputDirectory })
      await Promise.resolve(); active--
      return value
    } })
  assert.equal(report.status, 'pass'); assert.equal(report.executionKind, 'test')
  assert.equal(calls, 20); assert.equal(network, 0)
  assert.equal(new Set(report.runs.map(row => row.runId)).size, 20)
  assert.equal(new Set(report.runs.map(row => row.sessionId)).size, 20)
  assert.equal(new Set(report.runs.map(row => row.runtimeIdentity)).size, 20)
  assert(report.runs.every(row => row.evidence.kind === 'synthetic_test' && row.evidence.ledgerDirectory.endsWith('/budget')))
  assert.equal(report.runtimeIdentity, undefined, 'a suite must not pretend to have one joined runtime identity')
  assert.deepEqual(report.counts.businessJourneys, { planned: 10, attempted: 10, passed: 10 })
  assert.deepEqual(report.counts.safeStopRegressions, { planned: 10, attempted: 10, passed: 10 })
  for (const row of Object.values(report.counts.scenarios)) assert.deepEqual(row, { planned: 5, attempted: 5, passed: 5 })
  assert.equal(report.usage.reservedRequests, 20)
  assert.equal(report.usage.totalUsage.inputTokens, 2000)
  assert.equal(report.usage.totalUsage.outputTokens, 40)
  assert.equal(report.usage.totalUsage.cacheReadTokens, 0)
  assert.equal(report.usage.totalUsage.cacheWriteTokens, null)
  assert.equal(report.usage.cost, null)
  assert.equal(report.policy.historicalRunsIncluded, 0)
  assert.equal(checkpoints.filter(row => row.stage === 'run-starting').length, 20)
  assert.equal(checkpoints.filter(row => row.stage === 'run-finished').length, 20)
  assert.equal(checkpoints.at(-1).stage, 'suite-finished')
  assert.deepEqual(checkpoints.at(-1).value, report)
  assert.equal(progress.at(-1).stage, 'suite-finalizing')
})

test('the first failed proof stops immediately, preserving its requests and never retrying or backfilling', async () => {
  let calls = 0
  const report = await runMaterialSuiteTest({ capture, run: async ({ scenario }) => {
    const value = fakeResult(scenario, calls++)
    if (calls === 3) { value.report.proof.status = 'fail'; value.report.proof.tasks[0].state = 'fail'; value.report.proof.tasks[0].checks[0].state = 'fail' }
    return value
  } })
  assert.equal(calls, 3); assert.equal(report.status, 'fail')
  assert.deepEqual(report.runs.map(row => row.scenario), ['normal', 'missing_input', 'response_lost'])
  assert(report.runs.at(-1).issues.includes('proof_identity_or_status_invalid'))
  assert.equal(report.runs.at(-1).budget.reservedRequests, 1)
  assert.equal(report.usage.reservedRequests, 3)
  assert.equal(report.counts.businessJourneys.passed, 1)
  assert.equal(report.counts.safeStopRegressions.passed, 1)
  assert.equal(report.counts.scenarios.takeover.attempted, 0)
})

test('production disk reader retains JSON-omitted proof and all 63 offline requests when the fifth run hits output_limit', async t => {
  let calls = 0, network = 0, failedValue
  t.mock.method(globalThis, 'fetch', async () => { network++; throw new Error('offline only') })
  const counts = [16, 3, 15, 10, 19]
  const report = await runMaterialSuiteTest({ capture, run: async ({ scenario }) => {
    const index = calls++
    const value = await persistedResult(t, scenario, { requests: counts[index], outputLimit: index === 4 })
    if (index === 4) failedValue = value
    return readRetainedMaterialEvidence(value)
  } })
  assert.equal(calls, 5); assert.equal(network, 0)
  assert.equal(report.executionKind, 'test'); assert.equal(report.status, 'fail')
  assert.deepEqual(report.runs.map(row => row.status), ['pass', 'pass', 'pass', 'pass', 'fail'])
  const failed = report.runs.at(-1)
  assert.equal(Object.hasOwn(failedValue.report, 'proof'), true)
  const bytes = await readFile(join(failedValue.outputDirectory, 'report.json'))
  assert.equal(Object.hasOwn(JSON.parse(bytes), 'proof'), false)
  assert.equal(failed.runId, failedValue.report.runId)
  assert.equal(failed.sessionId, failedValue.report.sessionId)
  assert.deepEqual(failed.sourceBefore, source); assert.deepEqual(failed.sourceAfter, source)
  assert.equal(failed.runtimeIdentity, failedValue.report.runtimeIdentity)
  assert.deepEqual(failed.cleanup, failedValue.report.cleanup)
  assert.equal(failed.exit.code, 1); assert.equal(failed.reportStatus, 'fail')
  assert.equal(failed.evidence.reportSha256, createHash('sha256').update(bytes).digest('hex'))
  assert(failed.issues.includes('run_failed'))
  assert(failed.issues.includes('model_ledger_unproven'))
  assert(failed.issues.includes('proof_identity_or_status_invalid'))
  assert(!failed.issues.includes('run_threw_or_evidence_unreadable'))
  assert.equal(failed.budget.reservedRequests, 19)
  assert.equal(failed.budget.requests.filter(row => row.outcome === 'finished').length, 18)
  assert.equal(failed.budget.requests.at(-1).outcome, 'output_limit')
  assert.equal(report.usage.attemptedRequests, 63); assert.equal(report.usage.reservedRequests, 63)
  assert.equal(report.usage.deniedRequests, 0); assert.equal(report.usage.unknownUsageRuns, 0)
  assert.deepEqual(report.usage.totalUsage, { inputTokens: 6300, outputTokens: 126,
    cacheReadTokens: 0, cacheWriteTokens: null, reasoningTokens: null })
  assert.equal(report.usage.cost, null)
  assert(report.failures.some(row => row.code === 'fixed_suite_incomplete'))
})

test('early failed startup retains its identity but a never-mounted ledger remains unknown rather than zero', async t => {
  let calls = 0, value
  const report = await runMaterialSuiteTest({ capture, run: async ({ scenario }) => {
    calls++; value = await persistedResult(t, scenario, { noLedger: true })
    return readRetainedMaterialEvidence(value)
  } })
  assert.equal(calls, 1); assert.equal(report.status, 'fail')
  assert.equal(report.runs[0].runId, value.report.runId)
  assert.deepEqual(report.runs[0].sourceBefore, source)
  assert.equal(report.runs[0].budget, null); assert.equal(report.runs[0].servicePid, null)
  assert.equal(report.usage.attemptedRequests, null); assert.equal(report.usage.unknownUsageRuns, 1)
  assert(Object.values(report.usage.totalUsage).every(value => value === null))
})

test('JSON boundary comparison still rejects changed values, extra disk facts and null substituted for an omitted proof', async t => {
  const value = await persistedResult(t, 'normal', { outputLimit: true })
  const path = join(value.outputDirectory, 'report.json'), bytes = await readFile(path)
  for (const mutate of [report => { report.sourceBefore.sha256 = changed.sha256 },
    report => { report.proof = null }, report => { report.unobservedSuccess = true }]) {
    const disk = JSON.parse(bytes); mutate(disk)
    await writeFile(path, `${JSON.stringify(disk)}\n`)
    await assert.rejects(readRetainedMaterialEvidence(value), /disk_report_mismatch/u)
  }
  await writeFile(path, bytes)
  assert.equal((await readRetainedMaterialEvidence(value)).report.runId, value.report.runId)
})

test('non-JSON values cannot silently serialize into valid evidence', async t => {
  const value = await persistedResult(t, 'normal', { outputLimit: true })
  const path = join(value.outputDirectory, 'report.json')
  for (const field of [NaN, Infinity, () => true, Symbol('synthetic'), [undefined]]) {
    const report = { ...value.report, unsupported: field }
    await writeFile(path, `${JSON.stringify(report)}\n`)
    await assert.rejects(readRetainedMaterialEvidence({ ...value, report }), /invalid_report_json_value/u)
  }
})

test('retained ledger mismatch stays fail-closed and reports the specific safe evidence error', async t => {
  let calls = 0
  const report = await runMaterialSuiteTest({ capture, run: async ({ scenario, onProgress }) => {
    calls++
    const value = await persistedResult(t, scenario, { outputLimit: true })
    await onProgress({ stage: 'synthetic-retained', outputDirectory: value.outputDirectory })
    value.report.budget.requests[0].outcome = 'finished'
    await writeFile(join(value.outputDirectory, 'report.json'), `${JSON.stringify(value.report)}\n`)
    return readRetainedMaterialEvidence(value)
  } })
  assert.equal(calls, 1); assert.equal(report.status, 'fail')
  assert.deepEqual(report.runs[0].issues, ['run_threw_or_evidence_unreadable', 'disk_budget_mismatch'])
  assert.equal(report.runs[0].runId, null, 'unverified values must not be promoted')
  assert.equal(report.runs[0].budget, null); assert.equal(report.usage.reservedRequests, null)
})

test('fixed-root reader rejects foreign references, a symlinked report and a missing retained ledger', async t => {
  const value = await persistedResult(t, 'normal', { outputLimit: true })
  await assert.rejects(readRetainedMaterialEvidence({ ...value, outputDirectory: `${value.outputDirectory}-foreign` }), /unsafe_run_reference/u)
  const path = join(value.outputDirectory, 'report.json'), bytes = await readFile(path)
  await writeFile(join(value.outputDirectory, 'target.json'), bytes)
  await rm(path); await symlink('target.json', path)
  await assert.rejects(readRetainedMaterialEvidence(value))
  await rm(path); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  await rm(join(value.outputDirectory, 'budget'), { recursive: true })
  await assert.rejects(readRetainedMaterialEvidence(value))
})

test('run failure, partial checks, wrong routes, missing cleanup, source mismatch and historical evidence fail closed', async () => {
  const changes = [
    value => { value.report.status = 'fail' },
    value => { value.report.failures.push({ stage: 'synthetic' }) },
    value => { value.report.proof.tasks = [] },
    value => { value.report.proof.tasks[0].checks = [] },
    value => { value.report.proof.tasks[0].checks[0].state = 'fail' },
    value => { value.report.cleanup = value.report.cleanup.filter(row => row.id !== 'owned-backend-port-released') },
    value => { value.report.cleanup[0].state = 'fail' },
    value => { value.report.retainedRoot = '/synthetic/retained' },
    value => { value.report.model.provider = 'other' },
    value => { value.report.runtimeIdentity = null },
    value => { value.report.sessionId = 'wrong-session' },
    value => { value.report.scenario = 'takeover' },
    value => { value.report.createdAt = '2000-01-01T00:00:00.000Z' },
    value => { value.report.sourceAfter = changed },
    value => { value.report.budget.requests[0].outcome = 'unknown' },
    value => { value.report.budget.runId = randomUUID() },
    value => { value.outputDirectory = '/synthetic/foreign-output' },
    value => { delete value.report },
  ]
  for (const change of changes) {
    let calls = 0
    const report = await runMaterialSuiteTest({ capture, run: async ({ scenario }) => { calls++; const value = fakeResult(scenario); change(value); return value } })
    assert.equal(calls, 1); assert.equal(report.status, 'fail')
    assert.equal(report.runs[0].status, 'fail')
  }
})

test('safe-stop evidence must contain its actual regression and may not borrow delivered-task counts', async () => {
  let calls = 0
  const report = await runMaterialSuiteTest({ capture, run: async ({ scenario }) => {
    const value = fakeResult(scenario, calls++)
    if (scenario === 'missing_input') value.report.proof.regressions = []
    return value
  } })
  assert.equal(calls, 2); assert.equal(report.status, 'fail')
  assert(report.runs[1].issues.includes('scenario_regressions_incomplete'))
  assert.equal(report.counts.businessJourneys.passed, 1)
  assert.equal(report.counts.safeStopRegressions.passed, 0)
})

test('a reused session/run identity cannot count as another fresh repetition', async () => {
  let first, calls = 0
  const report = await runMaterialSuiteTest({ capture, run: async ({ scenario }) => {
    const value = fakeResult(scenario, calls++)
    if (!first) first = value.report.runId
    else {
      value.report.runId = first; value.report.sessionId = `xiaoshe-material-${first}`
      value.outputDirectory = join(productRoot, 'output/stabilization', `material-live-${first}`)
    }
    return value
  } })
  assert.equal(calls, 2)
  assert(report.runs[1].issues.includes('run_identity_reused_or_invalid'))
})

test('source drift prevents the next paid run and a changed final snapshot prevents suite PASS', async () => {
  let captures = 0, calls = 0
  const early = await runMaterialSuiteTest({ capture: async () => ++captures >= 3 ? changed : source,
    run: async ({ scenario }) => fakeResult(scenario, calls++) })
  assert.equal(calls, 1); assert.equal(early.status, 'fail')
  assert(early.failures.some(row => row.code === 'source_changed_before_run'))
  captures = 0; calls = 0
  const late = await runMaterialSuiteTest({ capture: async () => ++captures >= 22 ? changed : source,
    run: async ({ scenario }) => fakeResult(scenario, calls++) })
  assert.equal(calls, 20); assert.equal(late.status, 'fail')
  assert(late.failures.some(row => row.code === 'suite_source_changed'))
})

test('unknown usage propagates null instead of silently counting missing costs or tokens as zero', async () => {
  let calls = 0
  const report = await runMaterialSuiteTest({ capture, run: async ({ scenario }) => {
    const value = fakeResult(scenario, calls++)
    if (calls === 2) value.report.budget.usage = { status: 'unknown', totalUsage: null }
    return value
  } })
  assert.equal(report.status, 'pass', 'unknown provider usage is not fabricated task failure')
  assert.equal(report.usage.reservedRequests, 20)
  assert.equal(report.usage.unknownUsageRuns, 1)
  assert(Object.values(report.usage.totalUsage).every(value => value === null))
  assert.equal(report.usage.cost, null)
})

test('exceptions and interruption stop the sequence and leave observable incomplete checkpoints', async () => {
  const checkpoints = []
  let calls = 0
  const thrown = await runMaterialSuiteTest({ capture, onCheckpoint: (value, stage) => checkpoints.push({ value, stage }),
    run: async ({ onProgress }) => { calls++; await onProgress({ stage: 'synthetic-start' }); throw new Error('synthetic child failure') } })
  assert.equal(calls, 1); assert.equal(thrown.status, 'fail')
  assert.equal(thrown.usage.reservedRequests, null)
  assert(checkpoints.some(row => row.stage === 'run-starting' && row.value.status === 'running'))
  assert.equal(checkpoints.at(-1).value.status, 'fail')
  let interrupted = false; calls = 0
  const stopped = await runMaterialSuiteTest({ capture, isInterrupted: () => interrupted,
    run: async ({ scenario }) => { calls++; const value = fakeResult(scenario); interrupted = true; return value } })
  assert.equal(calls, 1); assert.equal(stopped.status, 'fail')
  assert(stopped.failures.some(row => row.code === 'interrupted'))
})

test('a missing final source or rejecting final observer is recorded before the final checkpoint', async () => {
  let snapshots = 0
  for (const mode of ['source', 'observer']) {
    snapshots = 0
    let final
    const report = await runMaterialSuiteTest({ capture: async () => {
      if (++snapshots === 22 && mode === 'source') throw new Error('synthetic snapshot failure')
      return source
    }, onProgress: async value => { if (mode === 'observer' && value.stage === 'suite-finalizing') throw new Error('synthetic observer failure') },
    onCheckpoint: (value, stage) => { if (stage === 'suite-finished') final = value }, run: async ({ scenario }) => fakeResult(scenario) })
    assert.equal(report.status, 'fail'); assert.deepEqual(final, report)
  }
})

test('production API and CLI reject arbitrary plan, runner, resume and output injection before any live action', async () => {
  for (const options of [{}, { liveAuthorized: false }, { liveAuthorized: true, run() {} }, { liveAuthorized: true, count: 1 },
    { liveAuthorized: true, plan: [] }, { liveAuthorized: true, outputDirectory: '/tmp' }, { liveAuthorized: true, resume: true }, { liveAuthorized: true, onProgress: 1 }]) {
    await assert.rejects(runMaterialSuite(options), /explicit_fixed_live_authorization_required/u)
  }
  for (const args of [[], ['--count', '20'], ['--live-authorized', '--count', '1'], ['--live-authorized', '--resume'], ['--live-authorized', '--output', '/tmp']]) {
    await assert.rejects(exec(process.execPath, ['scripts/acceptance/material-suite.mjs', ...args], { cwd: productRoot, timeout: 10_000 }), error => {
      assert.match(error.stderr, /requires_only_--live-authorized/u)
      assert(!error.stdout.includes('suite-started')); return true
    })
  }
})
