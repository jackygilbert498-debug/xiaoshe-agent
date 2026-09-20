import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { TASK_CATALOG } from './task-catalog.mjs'
import { buildTaskEvidence, renderTaskEvidenceSummary, runTaskEvidenceCli } from './task-evidence.mjs'
import { captureCandidate } from './internal-beta.mjs'

const exec = promisify(execFile)
const SOURCE = 'a'.repeat(64), RUNTIME = 'b'.repeat(64)
const SINCE = '2026-09-07T01:00:00.000Z', CREATED = '2026-09-07T01:01:00.000Z'
const FINISHED = '2026-09-07T01:02:00.000Z', UNTIL = '2026-09-07T01:03:00.000Z'
const defaults = { sourceSha256: SOURCE, runtimeIdentity: RUNTIME, since: SINCE, until: UNTIL }
const TASK = 'material-browser-delivery'
const contract = id => TASK_CATALOG.find(task => task.id === id)
const result = (index, id = TASK) => index.tasks.find(task => task.id === id)
function taskRow(taskId = TASK, overrides = {}) {
  return { taskId, state: 'pass', checks: contract(taskId).requiredChecks.map(id => ({ id, state: 'pass' })), ...overrides }
}
function report(overrides = {}) {
  return { schema: 'xiaoshe-task-run/v1', runId: 'run-1', createdAt: CREATED, finishedAt: FINISHED,
    binding: { sourceSha256: SOURCE, runtimeIdentity: RUNTIME }, executionKind: 'live_model',
    tasks: [taskRow()], cleanup: [{ id: 'owned-fixture-cleanup', state: 'pass' }], ...overrides }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoshe-task-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let sequence = 0
  return { directory, async save(value) {
    const path = join(directory, `report-${sequence++}.json`)
    await writeFile(path, JSON.stringify(value)); return path
  } }
}
async function indexOne(fixture, raw, options = {}) {
  return buildTaskEvidence({ ...defaults, ...options, reportPaths: [await fixture.save(raw)] })
}

test('30 fixed task definitions alone produce 30 not_run, not 30 passes', async () => {
  assert.equal(TASK_CATALOG.length, 30)
  assert.equal(new Set(TASK_CATALOG.map(task => task.id)).size, 30)
  for (const task of TASK_CATALOG) {
    assert.ok(task.acceptance && task.boundary)
    assert.ok(task.requiredChecks.length >= 3)
    assert.equal(new Set(task.requiredChecks).size, task.requiredChecks.length)
  }
  const index = await buildTaskEvidence(defaults)
  assert.equal(index.summary.counts.not_run, 30)
  assert.equal(index.summary.counts.passed, 0)
  assert.equal(index.summary.complete, false)
  assert.equal(index.summary.releaseApproval, false)
  assert.match(renderTaskEvidenceSummary(index), /定义 30 项不等于执行 30 项/)
})

test('complete current model evidence passes only its one fixed task; unknown measurements remain null', async t => {
  const f = await fixture(t)
  const index = await indexOne(f, report())
  assert.equal(result(index).status, 'passed')
  assert.equal(index.summary.counts.passed, 1)
  assert.equal(index.summary.counts.not_run, 29)
  assert.equal(index.summary.liveModelPassed, 1)
  assert.equal(index.summary.complete, false)
  assert.deepEqual(result(index).evidence[0].metrics, {
    durationMs: null, retryCount: null, humanInterventions: null, inputTokens: null, outputTokens: null, cost: null,
  })
})

test('real component workflow is fixture_only, never a model task pass', async t => {
  const f = await fixture(t)
  const index = await indexOne(f, report({ executionKind: 'component_fixture', binding: { sourceSha256: SOURCE, runtimeIdentity: null } }), { runtimeIdentity: null })
  assert.equal(result(index).status, 'fixture_only')
  assert.equal(result(index).evidence[0].executionKind, 'component_fixture')
  assert.equal(index.summary.liveModelPassed, 0)
  assert.equal(index.summary.counts.passed, 0)
  assert.equal(index.summary.counts.fixture_only, 1)
})

test('current true product lifecycle is separate from model evidence; manual declaration cannot substitute', async t => {
  const f = await fixture(t), id = 'version-start-current'
  const actual = await indexOne(f, report({ tasks: [taskRow(id)], executionKind: 'product_no_model' }))
  assert.equal(result(actual, id).status, 'passed')
  assert.equal(actual.summary.productNoModelPassed, 1)
  assert.equal(actual.summary.liveModelPassed, 0)
  const manual = await indexOne(f, report({ tasks: [taskRow(id)], executionKind: 'manual' }))
  assert.equal(result(manual, id).status, 'partial')
})

test('different source, old timestamp and different runtime remain historical', async t => {
  const f = await fixture(t)
  for (const change of [
    { binding: { sourceSha256: 'c'.repeat(64), runtimeIdentity: RUNTIME } },
    { createdAt: '2026-09-06T01:01:00.000Z', finishedAt: '2026-09-06T01:02:00.000Z' },
    { binding: { sourceSha256: SOURCE, runtimeIdentity: 'c'.repeat(64) } },
  ]) {
    const index = await indexOne(f, report(change))
    assert.equal(result(index).status, 'historical')
    assert.equal(index.summary.counts.passed, 0)
  }
})

test('missing source, missing times and unavailable runtime cannot create current model proof', async t => {
  const f = await fixture(t)
  for (const change of [
    { binding: null }, { finishedAt: undefined }, { binding: { sourceSha256: SOURCE, runtimeIdentity: null } },
  ]) {
    const index = await indexOne(f, report(change))
    assert.equal(result(index).status, 'unbound')
    assert.equal(index.summary.counts.passed, 0)
  }
  const unverifiedRuntime = await indexOne(f, report(), { runtimeIdentity: null })
  assert.equal(result(unverifiedRuntime).status, 'unbound')
})

test('future evidence and reversed timestamps fail integrity validation', async t => {
  const f = await fixture(t)
  for (const change of [{ finishedAt: '2026-09-07T01:04:00.000Z' }, { finishedAt: SINCE }]) {
    const index = await indexOne(f, report(change))
    assert.equal(result(index).status, 'invalid')
    assert.ok(index.summary.integrityErrors > 0)
  }
})

test('pass flag without required or passing checks is insufficient', async t => {
  const f = await fixture(t)
  const missing = taskRow(); missing.checks.pop()
  const partial = await indexOne(f, report({ tasks: [missing] }))
  assert.equal(result(partial).status, 'partial')
  assert.ok(result(partial).evidence[0].missingChecks.includes('original-input-unchanged'))
  const contradicted = taskRow(); contradicted.checks[0].state = 'fail'
  const failed = await indexOne(f, report({ tasks: [contradicted] }))
  assert.equal(result(failed).status, 'failed')
  const empty = await indexOne(f, report({ tasks: [taskRow(TASK, { checks: [] })] }))
  assert.equal(result(empty).status, 'invalid')
})

test('failed, missing, duplicate and incomplete cleanup never produce a pass', async t => {
  const f = await fixture(t)
  const failed = await indexOne(f, report({ cleanup: [{ id: 'owned-fixture-cleanup', state: 'fail' }] }))
  assert.equal(result(failed).status, 'failed')
  for (const cleanup of [undefined, [], [{ id: 'x', state: 'pass' }, { id: 'x', state: 'pass' }]]) {
    const index = await indexOne(f, report({ cleanup }))
    assert.equal(result(index).status, 'invalid')
  }
  const pending = await indexOne(f, report({ cleanup: [{ id: 'cleanup', state: 'pending_external' }] }))
  assert.equal(result(pending).status, 'partial')
})

test('duplicate and unknown task/check identifiers invalidate their report', async t => {
  const f = await fixture(t)
  const duplicate = taskRow(); duplicate.checks.push(duplicate.checks[0])
  for (const tasks of [[taskRow(), taskRow()], [taskRow(), { taskId: 'invented-task', state: 'pass' }], [duplicate]]) {
    const index = await indexOne(f, report({ tasks }))
    assert.equal(result(index).status, 'invalid')
    assert.equal(index.summary.counts.passed, 0)
    assert.ok(index.summary.integrityErrors > 0)
  }
})

test('duplicate report bytes, paths and run IDs cannot inflate coverage', async t => {
  const f = await fixture(t), path = await f.save(report())
  const paths = await buildTaskEvidence({ ...defaults, reportPaths: [path, path] })
  assert.equal(paths.summary.counts.passed, 1)
  assert.equal(paths.summary.integrityErrors, 1)
  assert.equal(paths.summary.complete, false)
  const sameBytes = await buildTaskEvidence({ ...defaults, reportPaths: [path, await f.save(report())] })
  assert.equal(sameBytes.summary.loadedReports, 1)
  assert.equal(sameBytes.summary.integrityErrors, 1)
  const runDuplicate = await buildTaskEvidence({ ...defaults, reportPaths: [path, await f.save(report({ tasks: [taskRow('files-extract-structured')] }))] })
  assert.equal(result(runDuplicate).status, 'invalid')
  assert.equal(result(runDuplicate, 'files-extract-structured').status, 'invalid')
  assert.equal(runDuplicate.summary.counts.passed, 0)
})

test('a later green run does not erase failure from the same candidate window', async t => {
  const f = await fixture(t)
  const fail = taskRow(); fail.checks[0].state = 'fail'; fail.state = 'fail'
  const paths = [await f.save(report({ tasks: [fail] })), await f.save(report({ runId: 'retry-2' }))]
  const index = await buildTaskEvidence({ ...defaults, reportPaths: paths })
  assert.equal(result(index).status, 'failed')
  assert.equal(result(index).evidence.length, 2)
  const reversed = await buildTaskEvidence({ ...defaults, reportPaths: paths.toReversed() })
  assert.equal(result(reversed).status, 'failed')
})

test('not_run and pending_external are explicit, not positive execution evidence', async t => {
  const f = await fixture(t)
  const noRun = await indexOne(f, report({ tasks: [taskRow(TASK, { state: 'not_run', checks: [] })] }))
  assert.equal(result(noRun).status, 'not_run')
  const pending = await indexOne(f, report({ tasks: [taskRow(TASK, { state: 'pending_external', checks: [] })] }))
  assert.equal(result(pending).status, 'pending_external')
  assert.equal(pending.summary.counts.passed, 0)
})

test('internal all-green stage report cannot be turned into 30 real task passes', async t => {
  const f = await fixture(t)
  const gate = { schema: 'xiaoshe-internal-candidate/v1', createdAt: CREATED, finishedAt: FINISHED,
    sourceBefore: { sha256: SOURCE }, sourceAfter: { sha256: SOURCE }, sourceStable: true,
    stages: Array.from({ length: 52 }, (_, n) => ({ id: `stage-${n}`, status: 'passed' })),
    requiredStages: Array.from({ length: 52 }, (_, n) => `stage-${n}`), missingStages: [],
    deterministic: 'passed', live: 'not_run', status: 'partial', releaseApproval: false }
  const index = await indexOne(f, gate)
  assert.equal(index.reports[0].currency, 'current')
  assert.equal(index.reports[0].gate.deterministic, 'passed')
  assert.equal(index.summary.counts.passed, 0)
  assert.equal(index.summary.counts.not_run, 30)
  const stale = await indexOne(f, { ...gate, sourceAfter: { sha256: 'c'.repeat(64) } })
  assert.ok(stale.summary.integrityErrors > 0)
  const missing = await indexOne(f, { ...gate, stages: gate.stages.slice(1) })
  assert.equal(missing.reports[0].currency, 'invalid')
  const contradicted = await indexOne(f, { ...gate, stages: [{ ...gate.stages[0], status: 'failed' }, ...gate.stages.slice(1)] })
  assert.equal(contradicted.reports[0].currency, 'invalid')
})

test('existing complex-live reports need finished time, binding, full checks and cleanup', async t => {
  const f = await fixture(t), id = 'files-multi-source-conflict'
  const raw = { schemaVersion: 1, createdAt: CREATED, finishedAt: FINISHED,
    acceptanceBinding: { nonce: 'live-1', sourceSha256: SOURCE, runtimeIdentity: RUNTIME },
    scenarios: [{ id: 'conflict-research', state: 'pass', checks: taskRow(id).checks }],
    cleanup: [{ id: 'archive:session-1', state: 'pass' }] }
  const current = await indexOne(f, raw)
  assert.equal(result(current, id).status, 'passed')
  const oldFormat = await indexOne(f, { ...raw, finishedAt: undefined })
  assert.equal(result(oldFormat, id).status, 'unbound')
  const setupFailure = await indexOne(f, { ...raw, scenarios: [...raw.scenarios, { id: 'setup', state: 'fail', checks: [] }] })
  assert.equal(result(setupFailure, id).status, 'invalid')
})

test('legacy real model references remain visible without copying answer, tool arguments or account data', async t => {
  const f = await fixture(t)
  const secret = 'PRIVATE_ANSWER_SHOULD_NOT_APPEAR'
  const raw = { schemaVersion: 1, createdAt: '2026-09-04T12:18:37.990Z',
    checks: [{ id: 'real-document-result', state: 'pass', elapsedMs: 2110, answer: secret, calls: [{ arguments: secret }] }] }
  const index = await indexOne(f, raw)
  assert.equal(result(index, 'files-extract-structured').status, 'historical')
  assert.equal(result(index, 'files-extract-structured').evidence[0].executionKind, 'live_model')
  assert.equal(result(index, 'files-extract-structured').evidence[0].metrics.durationMs, 2110)
  assert.ok(!JSON.stringify(index).includes(secret))
  const browser = await indexOne(f, { accepted: true, checks: [{ name: secret, passed: true }], authenticatedExternalSiteTested: false })
  assert.equal(browser.summary.counts.passed, 0)
  assert.equal(browser.reports[0].currency, 'unbound')
  assert.ok(!JSON.stringify(browser).includes(secret))
})

test('only named regular bounded report files are read; malformed private content is not echoed', async t => {
  const f = await fixture(t)
  const privateText = 'PRIVATE_PARSE_FAILURE'
  const bad = join(f.directory, 'bad.json'), link = join(f.directory, 'link.json')
  await writeFile(bad, `{"private":"${privateText}`)
  const paths = [bad, f.directory, join(f.directory, 'missing.json')]
  // Windows accounts without Developer Mode may not create symbolic links.
  if (process.platform !== 'win32') { await symlink(bad, link); paths.push(link) }
  const index = await buildTaskEvidence({ ...defaults, reportPaths: paths })
  assert.equal(index.summary.integrityErrors, paths.length)
  assert.ok(!JSON.stringify(index).includes(privateText))
  assert.equal(index.summary.counts.not_run, 30)
  const tooLarge = join(f.directory, 'large.json')
  await writeFile(tooLarge, ' '.repeat(8 * 1024 * 1024 + 1))
  const largeIndex = await buildTaskEvidence({ ...defaults, reportPaths: [tooLarge] })
  assert.equal(largeIndex.errors[0].code, 'unsafe_or_oversized_report')
})

test('measurement fields are opt-in numeric observations, never inferred zero', async t => {
  const f = await fixture(t)
  const row = taskRow(TASK, { metrics: { durationMs: 123, retryCount: 0, humanInterventions: -1,
    inputTokens: 'unknown', outputTokens: 42, cost: { amount: 0.02, currency: 'USD' } } })
  const index = await indexOne(f, report({ tasks: [row] }))
  assert.deepEqual(result(index).evidence[0].metrics, { durationMs: 123, retryCount: 0, humanInterventions: null,
    inputTokens: null, outputTokens: 42, cost: { amount: 0.02, currency: 'USD' } })
})

test('CLI verifies actual checkout source, writes reproducible JSON and Chinese summary, and can require complete coverage', async t => {
  const f = await fixture(t)
  await exec('git', ['init', '--quiet', f.directory])
  await writeFile(join(f.directory, '.gitignore'), 'output/\n')
  await writeFile(join(f.directory, 'source.txt'), 'preserve me')
  const actual = await captureCandidate(f.directory)
  const output = join(f.directory, 'output/index.json'), summary = join(f.directory, 'output/index.md')
  const args = ['--root', f.directory, '--source-sha', actual.sha256, '--since', SINCE, '--until', UNTIL, '--output', output, '--summary', summary]
  const first = await runTaskEvidenceCli(args)
  assert.equal(first.exitCode, 0)
  assert.equal(first.index.summary.complete, false)
  const bytes = await readFile(output, 'utf8')
  await runTaskEvidenceCli(args)
  assert.equal(await readFile(output, 'utf8'), bytes)
  assert.match(await readFile(summary, 'utf8'), /小蛇固定任务证据索引/)
  assert.equal((await runTaskEvidenceCli([...args, '--require-complete'])).exitCode, 1)
  await assert.rejects(runTaskEvidenceCli([...args, '--source-sha', SOURCE]), /duplicate_argument/)
  await assert.rejects(runTaskEvidenceCli(args.map(arg => arg === actual.sha256 ? SOURCE : arg)), /expected_source_does_not_match_checkout/)
  await assert.rejects(runTaskEvidenceCli([...args, '--report', output]), /output_conflicts_with_input/)
  if (process.platform !== 'win32') {
    const alias = join(f.directory, 'output/alias.json')
    await symlink(output, alias)
    await assert.rejects(runTaskEvidenceCli([...args, '--report', alias]), /output_conflicts_with_input/)
  }
  await assert.rejects(runTaskEvidenceCli(args.map(arg => arg === output ? join(f.directory, 'source.txt') : arg)), /output_path_must_not_modify_source/)
  assert.equal(await readFile(join(f.directory, 'source.txt'), 'utf8'), 'preserve me')
  await assert.rejects(runTaskEvidenceCli(args.map(arg => arg === UNTIL ? '2999-01-01T00:00:00.000Z' : arg)), /candidate_window_is_in_the_future/)
})

test('invalid identity, windows and report inventories fail before reading evidence', async () => {
  await assert.rejects(buildTaskEvidence({ ...defaults, sourceSha256: 'HEAD' }), /invalid_expected_identity/)
  await assert.rejects(buildTaskEvidence({ ...defaults, since: 'yesterday' }), /invalid_candidate_time_window/)
  await assert.rejects(buildTaskEvidence({ ...defaults, since: UNTIL, until: SINCE }), /invalid_candidate_time_window/)
  await assert.rejects(buildTaskEvidence({ ...defaults, reportPaths: Array(129).fill('/irrelevant') }), /invalid_report_paths/)
})

test('CLI refuses nonignored and tracked project outputs before writing; ignored and external outputs preserve source identity', async t => {
  const f = await fixture(t), external = await fixture(t)
  await exec('git', ['init', '--quiet', f.directory])
  await writeFile(join(f.directory, '.gitignore'), '/output/acceptance/\n')
  await writeFile(join(f.directory, 'source.txt'), 'unchanged source')
  const candidate = await captureCandidate(f.directory)
  const args = (sourceSha, directory, output = join(directory, 'index.json')) => [
    '--root', f.directory, '--source-sha', sourceSha, '--since', SINCE, '--until', UNTIL,
    '--output', output, '--summary', join(directory, 'index.md'),
  ]
  const unignored = join(f.directory, 'output/stabilization')
  await assert.rejects(runTaskEvidenceCli(args(candidate.sha256, unignored)), /output_path_must_be_gitignored/)
  await assert.rejects(lstat(join(f.directory, 'output')), error => error.code === 'ENOENT')
  assert.equal((await captureCandidate(f.directory)).sha256, candidate.sha256)

  const ignored = join(f.directory, 'output/acceptance')
  assert.equal((await runTaskEvidenceCli(args(candidate.sha256, ignored))).exitCode, 0)
  assert.equal((await captureCandidate(f.directory)).sha256, candidate.sha256)
  // Verify both destinations, not only the JSON path.
  const mixed = args(candidate.sha256, ignored)
  mixed[mixed.length - 1] = join(unignored, 'index.md')
  await assert.rejects(runTaskEvidenceCli(mixed), /output_path_must_be_gitignored/)
  await assert.rejects(lstat(unignored), error => error.code === 'ENOENT')

  const tracked = join(ignored, 'tracked.json')
  await writeFile(tracked, 'protected tracked output')
  await exec('git', ['-C', f.directory, 'add', '-f', '--', tracked])
  const withTracked = await captureCandidate(f.directory)
  await assert.rejects(runTaskEvidenceCli(args(withTracked.sha256, ignored, tracked)), /output_path_must_be_gitignored/)
  assert.equal(await readFile(tracked, 'utf8'), 'protected tracked output')
  assert.equal((await runTaskEvidenceCli(args(withTracked.sha256, external.directory))).exitCode, 0)
  assert.equal((await captureCandidate(f.directory)).sha256, withTracked.sha256)
})
