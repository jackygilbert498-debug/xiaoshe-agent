#!/usr/bin/env node
/** Fixed, fail-fast repetition. A safe-stop regression is not a delivered task. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify, isDeepStrictEqual } from 'node:util'
import { captureCandidate } from '../quality/internal-beta.mjs'
import { runMaterialLive } from './material-live.mjs'
import { MAX_MATERIAL_REQUESTS, readBudgetLedger } from './live-request-budget.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputParent = join(root, 'output/stabilization')
const exec = promisify(execFile)
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const DIGEST = /^[a-f0-9]{64}$/u
const SCENARIOS = Object.freeze(['normal', 'missing_input', 'response_lost', 'takeover'])
const TOKENS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
const RELEASE_CHECKS = ['owned-main-group-released', 'owned-service-released', 'owned-backend-port-released', 'owned-fixture-closed',
  'retained-workspace', 'retained-tool-policy', 'retained-budget', 'retained-server', 'isolated-profile-removed']
const business = scenario => scenario === 'normal' || scenario === 'response_lost'
const nonnegative = value => Number.isSafeInteger(value) && value >= 0
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const fail = code => Object.assign(new Error(`material-suite: ${code}`), { code })
const evidenceErrors = new Set(['unsafe_run_reference', 'unsafe_report_file', 'report_changed_while_reading',
  'invalid_report_json_value', 'disk_report_mismatch', 'disk_budget_mismatch'])
const clone = value => structuredClone(value)

export const MATERIAL_SUITE_PLAN = Object.freeze(Array.from({ length: 20 }, (_, index) => Object.freeze({
  ordinal: index + 1, scenario: SCENARIOS[index % 4], kind: business(SCENARIOS[index % 4]) ? 'business_journey' : 'safe_stop_regression',
})))

function summarize(report) {
  const count = selected => ({ planned: MATERIAL_SUITE_PLAN.filter(selected).length,
    attempted: report.runs.filter(selected).length, passed: report.runs.filter(row => selected(row) && row.status === 'pass').length })
  report.counts = { scenarios: Object.fromEntries(SCENARIOS.map(scenario => [scenario, count(row => row.scenario === scenario)])),
    businessJourneys: count(row => business(row.scenario)), safeStopRegressions: count(row => !business(row.scenario)) }
  const sum = pick => {
    const values = report.runs.map(pick)
    if (!values.length || values.some(value => !nonnegative(value))) return null
    const total = values.reduce((left, right) => left + right, 0)
    return nonnegative(total) ? total : null
  }
  report.usage = { scope: 'attempted_runs_in_this_fresh_suite_only',
    attemptedRequests: sum(row => row.budget?.attemptedRequests), reservedRequests: sum(row => row.budget?.reservedRequests),
    deniedRequests: sum(row => row.budget?.deniedRequests),
    totalUsage: Object.fromEntries(TOKENS.map(key => [key, sum(row => row.budget?.usage?.totalUsage?.[key])])),
    unknownUsageRuns: report.runs.filter(row => row.budget?.usage?.status !== 'reported').length,
    monetaryHardCap: false, cost: null }
}

function validChecks(row) {
  return row?.state === 'pass' && Array.isArray(row.checks) && row.checks.length > 0
    && row.checks.every(check => typeof check.id === 'string' && check.state === 'pass')
    && new Set(row.checks.map(check => check.id)).size === row.checks.length
}

function runIssues(value, expected, seen) {
  const issues = [], report = value?.report
  const check = (yes, code) => { if (!yes) issues.push(code) }
  if (!report || typeof report !== 'object') return ['missing_run_report']
  check(report.schema === 'xiaoshe-material-live/v1' && report.executionKind === 'live_model', 'wrong_run_kind')
  check(UUID.test(report.runId ?? '') && report.sessionId === `xiaoshe-material-${report.runId}`
    && !seen.has(report.runId), 'run_identity_reused_or_invalid')
  check(report.scenario === expected.scenario, 'wrong_scenario')
  check(value.outputDirectory === join(outputParent, `material-live-${report.runId}`), 'wrong_run_output')
  check(date(report.createdAt) && date(report.finishedAt) && Date.parse(report.createdAt) >= expected.startedAt
    && Date.parse(report.finishedAt) >= Date.parse(report.createdAt) && Date.parse(report.finishedAt) <= Date.now(), 'historical_or_invalid_run_time')
  check(DIGEST.test(report.runtimeIdentity ?? ''), 'runtime_identity_missing')
  check(report.sourceBefore?.sha256 === expected.sourceSha256 && report.sourceAfter?.sha256 === expected.sourceSha256, 'run_source_changed')
  check(report.status === 'pass' && Array.isArray(report.failures) && report.failures.length === 0, 'run_failed')
  check(report.model?.provider === 'deepseek-official' && report.model?.model === 'deepseek-v4-flash'
    && report.model?.reasoningEffort === 'off', 'wrong_model')
  check(report.exit?.code === 0 && report.exit?.timedOut === false && report.exit?.signal === null
    && Number.isSafeInteger(report.exit?.pid) && report.exit.pid > 0, 'main_exit_unproven')
  check(report.retainedRoot === null && Array.isArray(report.cleanup) && report.cleanup.every(row => row.state === 'pass')
    && RELEASE_CHECKS.every(id => report.cleanup.filter(row => row.id === id).length === 1), 'cleanup_unproven')
  const budget = report.budget
  check(budget?.mounted === true && budget.runId === report.runId && budget.mode === 'bounded_model'
    && budget.maxRequests === MAX_MATERIAL_REQUESTS && nonnegative(budget.reservedRequests) && budget.reservedRequests > 0
    && budget.reservedRequests <= MAX_MATERIAL_REQUESTS && budget.deniedRequests === 0
    && budget.attemptedRequests === budget.reservedRequests && Array.isArray(budget.requests)
    && budget.requests.length === budget.reservedRequests && budget.requests.every((row, index) => row.ordinal === index + 1 && row.outcome === 'finished')
    && Array.isArray(budget.mounts) && budget.mounts.some(row => row.pid === report.servicePid && row.runId === report.runId
      && Number.isSafeInteger(row.pid) && row.pid > 0 && date(row.at)
      && Date.parse(row.at) >= Date.parse(report.createdAt) && Date.parse(row.at) <= Date.parse(report.finishedAt)), 'model_ledger_unproven')
  const proof = report.proof
  check(proof?.schema === 'xiaoshe-material-task-proof/v1' && proof.runId === report.runId && proof.sessionId === report.sessionId
    && proof.scenario === expected.scenario && proof.status === 'pass', 'proof_identity_or_status_invalid')
  const taskIds = business(expected.scenario) ? ['browser-form-delivery', 'material-browser-delivery'] : []
  const regressionIds = expected.scenario === 'normal' ? [] : [expected.scenario === 'response_lost'
    ? 'material-response-lost-recovery' : expected.scenario === 'missing_input' ? 'material-missing-input-safe-stop' : 'material-user-takeover-safe-stop']
  check(Array.isArray(proof?.tasks) && isDeepStrictEqual(proof.tasks.map(row => row.taskId).sort(), taskIds)
    && proof.tasks.every(validChecks), 'business_contracts_incomplete')
  check(Array.isArray(proof?.regressions) && isDeepStrictEqual(proof.regressions.map(row => row.id).sort(), regressionIds)
    && proof.regressions.every(validChecks), 'scenario_regressions_incomplete')
  return issues
}

function runRecord(value, item, startedAt, issues, evidenceKind) {
  const report = value?.report
  return { ...item, startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
    status: issues.length ? 'fail' : 'pass', issues, reportStatus: report?.status ?? 'unknown',
    runId: report?.runId ?? null, sessionId: report?.sessionId ?? null,
    sourceBefore: report?.sourceBefore ?? null, sourceAfter: report?.sourceAfter ?? null,
    runtimeIdentity: report?.runtimeIdentity ?? null, model: report?.model ?? null,
    servicePid: report?.servicePid ?? null, exit: report?.exit ?? null, cleanup: report?.cleanup ?? null,
    budget: report?.budget ?? null, retainedRoot: report?.retainedRoot ?? null,
    evidence: { kind: evidenceKind, outputDirectory: value?.outputDirectory ?? null,
      reportPath: value?.outputDirectory ? join(value.outputDirectory, 'report.json') : null,
      reportSha256: value?.reportSha256 ?? null, ledgerDirectory: value?.outputDirectory ? join(value.outputDirectory, 'budget') : null } }
}

/** Private executor: only the public test seam can supply fake calls. */
async function executeSequence({ executionKind, run, capture, checkpoint, onProgress, isInterrupted, suiteId = randomUUID() }) {
  const report = { schema: 'xiaoshe-material-suite/v1', suiteId, executionKind,
    createdAt: new Date().toISOString(), finishedAt: null, sourceBefore: null, sourceAfter: null, status: 'running',
    plan: MATERIAL_SUITE_PLAN, runs: [], current: null, failures: [],
    policy: { fixedRuns: 20, retries: 0, resume: false, stopOnFirstFailure: true, historicalRunsIncluded: 0,
      maximumRequestsPerRun: MAX_MATERIAL_REQUESTS, maximumSuiteRequests: 20 * MAX_MATERIAL_REQUESTS,
      independentRuntimeIdentities: true, businessJourneys: 10, safeStopRegressions: 10 },
    boundary: 'Only these fresh runs count. Two delivery contracts share each business journey; safe stops are regressions, not deliveries. Prior failures and their paid usage remain separate and are never overwritten.' }
  const note = code => report.failures.push({ code, at: new Date().toISOString() })
  const publish = async stage => {
    summarize(report)
    await checkpoint(clone(report), stage)
    await onProgress({ stage, executionKind, completedRuns: report.runs.length, plannedRuns: 20,
      current: clone(report.current), status: report.status })
  }
  const seen = new Set()
  try {
    report.sourceBefore = await capture()
    if (!DIGEST.test(report.sourceBefore?.sha256 ?? '')) throw fail('source_before_unavailable')
    await publish('suite-started')
    for (const item of MATERIAL_SUITE_PLAN) {
      if (isInterrupted()) { note('interrupted'); break }
      const before = await capture()
      if (before?.sha256 !== report.sourceBefore.sha256) { note('source_changed_before_run'); break }
      const startedAt = Date.now()
      report.current = { ...item, startedAt: new Date(startedAt).toISOString(), stage: 'starting', outputDirectory: null }
      await publish('run-starting')
      if (isInterrupted()) { note('interrupted'); break }
      let value, issues = []
      try {
        value = await run({ scenario: item.scenario, onProgress: async event => {
          // Retain stage and exact owned report location, not arbitrary model
          // output or error strings from an observer.
          report.current.stage = typeof event.stage === 'string' ? event.stage.slice(0, 100) : 'running'
          if (typeof event.outputDirectory === 'string' && event.outputDirectory.startsWith(`${outputParent}/material-live-`)) report.current.outputDirectory = event.outputDirectory
          await publish('run-progress')
        } })
        issues = runIssues(value, { scenario: item.scenario, sourceSha256: report.sourceBefore.sha256, startedAt }, seen)
      } catch (error) {
        issues = ['run_threw_or_evidence_unreadable']
        if (evidenceErrors.has(error?.code)) issues.push(error.code)
      }
      if (!value && report.current.outputDirectory) value = { outputDirectory: report.current.outputDirectory }
      report.runs.push(runRecord(value, item, startedAt, issues, executionKind === 'test' ? 'synthetic_test' : 'retained_report_and_budget'))
      if (value?.report?.runId) seen.add(value.report.runId)
      report.current = null
      if (issues.length) note('first_failed_run')
      await publish('run-finished')
      if (issues.length) break
    }
  } catch { note('suite_execution_or_checkpoint_failed') }
  finally {
    try { report.sourceAfter = await capture() } catch { note('source_after_unavailable') }
    if (!report.sourceBefore || report.sourceBefore.sha256 !== report.sourceAfter?.sha256) note('suite_source_changed')
    if (isInterrupted() && !report.failures.some(row => row.code === 'interrupted')) note('interrupted')
    summarize(report)
    report.finishedAt = new Date().toISOString()
    const complete = report.runs.length === 20 && report.runs.every(row => row.status === 'pass')
      && SCENARIOS.every(scenario => report.counts.scenarios[scenario].passed === 5)
    if (!complete) note('fixed_suite_incomplete')
    report.status = !report.failures.length && complete ? 'pass' : 'fail'
    // Observer failures before final persistence are recorded, never reported
    // after saving a contradictory PASS. Final status is the returned report.
    try { await onProgress({ stage: 'suite-finalizing', executionKind, completedRuns: report.runs.length, plannedRuns: 20 }) }
    catch { note('progress_observer_failed'); report.status = 'fail' }
    await checkpoint(clone(report), 'suite-finished')
  }
  return report
}

/** Read-only, fixed-root evidence reader; it cannot execute or resume a run. */
export async function readRetainedMaterialEvidence(value) {
  const id = value?.report?.runId, path = value?.outputDirectory
  if (!UUID.test(id ?? '') || path !== join(outputParent, `material-live-${id}`) || await realpath(path) !== path) throw fail('unsafe_run_reference')
  const file = await open(join(path, 'report.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024 || process.getuid && stat.uid !== process.getuid()) throw fail('unsafe_report_file')
    bytes = await file.readFile()
    const after = await file.stat()
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw fail('report_changed_while_reading')
  } finally { await file.close() }
  const report = JSON.parse(bytes.toString('utf8'))
  // runMaterialLive returns its in-memory report after JSON persistence. Early
  // failures legitimately leave optional object fields (notably proof) undefined;
  // JSON omits those fields. Compare the exact persisted representation, never a
  // subset, so failure identity/paid usage survive without accepting changed data.
  const returned = JSON.parse(JSON.stringify(value.report, function (_key, entry) {
    if (typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint'
      || typeof entry === 'number' && !Number.isFinite(entry)
      || entry === undefined && Array.isArray(this)) throw fail('invalid_report_json_value')
    return entry
  }))
  if (!isDeepStrictEqual(report, returned)) throw fail('disk_report_mismatch')
  // A failed early startup may not have mounted a ledger. Keep the failed
  // report and its references; it must still stop the suite immediately.
  if (report.budget && !isDeepStrictEqual(await readBudgetLedger(join(path, 'budget')), report.budget)) throw fail('disk_budget_mismatch')
  return { report, outputDirectory: path, reportSha256: createHash('sha256').update(bytes).digest('hex') }
}

async function durableJson(path, value) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync() } finally { await file.close() }
}

/** No arbitrary runner, scenario, output directory, seed or resume overrides. */
export async function runMaterialSuite(options = {}) {
  if (Object.keys(options).some(key => !['liveAuthorized', 'onProgress'].includes(key)) || options.liveAuthorized !== true
    || (options.onProgress !== undefined && typeof options.onProgress !== 'function')) throw fail('explicit_fixed_live_authorization_required')
  if (process.platform !== 'darwin') throw fail('macOS_required')
  const suiteId = randomUUID(), outputDirectory = join(outputParent, `material-suite-${suiteId}`)
  await mkdir(outputParent, { recursive: true, mode: 0o700 })
  if (await realpath(outputParent) !== outputParent) throw fail('unsafe_output_parent')
  await exec('git', ['check-ignore', '--quiet', outputDirectory], { cwd: root, timeout: 10_000 })
  await mkdir(outputDirectory, { mode: 0o700 })
  const owned = await lstat(outputDirectory)
  let interrupted = false, sequence = 0, writes = Promise.resolve()
  const stop = () => { interrupted = true }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  const onProgress = options.onProgress ?? (value => process.stdout.write(`${JSON.stringify({ ...value, outputDirectory })}\n`))
  const checkpoint = (value, stage) => {
    const ordinal = ++sequence, name = `checkpoint-${String(ordinal).padStart(4, '0')}.json`
    writes = writes.then(async () => {
      const current = await lstat(outputDirectory)
      if (current.dev !== owned.dev || current.ino !== owned.ino || current.isSymbolicLink() || await realpath(outputDirectory) !== outputDirectory) throw fail('suite_output_replaced')
      await durableJson(join(outputDirectory, name), { ...value, checkpoint: { sequence: ordinal, stage, at: new Date().toISOString() } })
    })
    return writes
  }
  try {
    const report = await executeSequence({ suiteId, executionKind: 'live_model',
      run: async options => readRetainedMaterialEvidence(await runMaterialLive(options)), capture: () => captureCandidate(root),
      checkpoint, onProgress, isInterrupted: () => interrupted })
    await durableJson(join(outputDirectory, 'report.json'), report)
    return { report, outputDirectory }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
}

/** Offline-only seam: injected execution can never produce live-kind evidence. */
export async function runMaterialSuiteTest({ run, capture, onCheckpoint = () => {}, onProgress = () => {}, isInterrupted = () => false }) {
  if (typeof run !== 'function' || typeof capture !== 'function') throw fail('test_dependencies_required')
  return executeSequence({ executionKind: 'test', run, capture, checkpoint: onCheckpoint, onProgress, isInterrupted })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3 || process.argv[2] !== '--live-authorized') throw fail('requires_only_--live-authorized')
  runMaterialSuite({ liveAuthorized: true }).then(({ report, outputDirectory }) => {
    process.stdout.write(`${JSON.stringify({ status: report.status, outputDirectory, counts: report.counts, usage: report.usage })}\n`)
    if (report.status !== 'pass') process.exitCode = 1
  }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
