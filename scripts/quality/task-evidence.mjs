#!/usr/bin/env node
/** Read only explicitly named reports; never discover sessions, credentials or artifacts. */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { TASK_CATALOG, TASK_CATALOG_VERSION } from './task-catalog.mjs'
import { captureCandidate } from './internal-beta.mjs'

const SHA = /^[a-f0-9]{64}$/u
const MAX_REPORT_BYTES = 8 * 1024 * 1024
const exec = promisify(execFile)
const EXECUTIONS = new Set(['live_model', 'product_no_model', 'component_fixture', 'manual', 'unknown'])
const STATES = new Set(['pass', 'fail', 'partial', 'not_run', 'pending_external'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const timestamp = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/u.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/u.test(value)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const taskById = new Map(TASK_CATALOG.map(task => [task.id, task]))
const complexTasks = {
  'code-repair': 'code-repair-regression', 'conflict-research': 'files-multi-source-conflict',
  'offline-to-online-topic-switch': 'recovery-network-scope', 'failure-recovery': 'recovery-missing-input', 'user-steer': 'recovery-user-steer',
}
const legacyTasks = {
  'real-document-result': 'files-extract-structured', 'verified-file-delivery': 'files-structured-write-readback',
  'native-image-read': 'files-image-evidence', 'pasted-image-read': 'files-attachment-evidence',
}

function checkList(checks) {
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 500) return false
  const names = new Set()
  return checks.every(check => {
    if (!object(check) || !validId(check.id) || !STATES.has(check.state) || names.has(check.id)) return false
    names.add(check.id); return true
  })
}

function gateStagesValid(raw) {
  const required = raw.requiredStages, stages = raw.stages
  if (!Array.isArray(required) || required.length === 0 || required.length > 256 || new Set(required).size !== required.length
    || required.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,159}$/u.test(id)) || !Array.isArray(stages) || stages.length !== required.length
    || new Set(stages.map(stage => stage?.id)).size !== stages.length || !Array.isArray(raw.missingStages) || raw.missingStages.length) return false
  if (!stages.every(stage => object(stage) && required.includes(stage.id)
    && ['passed', 'failed', 'timed_out', 'not_run'].includes(stage.status))) return false
  const deterministic = stages.filter(stage => stage.kind !== 'live')
  if (raw.deterministic === 'passed' && (deterministic.length === 0 || !deterministic.every(stage => stage.status === 'passed'))) return false
  const live = stages.filter(stage => stage.kind === 'live')
  if (raw.live === 'passed' && (live.length < 2 || !live.every(stage => stage.status === 'passed' && stage.evidenceComplete === true))) return false
  return true
}

function metrics(value) {
  const source = object(value) ? value : {}
  const count = key => Number.isSafeInteger(source[key]) && source[key] >= 0 ? source[key] : null
  return {
    durationMs: count('durationMs'), retryCount: count('retryCount'), humanInterventions: count('humanInterventions'),
    inputTokens: count('inputTokens'), outputTokens: count('outputTokens'),
    cost: object(source.cost) && typeof source.cost.currency === 'string' && /^[A-Z]{3}$/u.test(source.cost.currency)
      && Number.isFinite(source.cost.amount) && source.cost.amount >= 0
      ? { amount: source.cost.amount, currency: source.cost.currency } : null,
  }
}

function currency(report, expected, executionKind) {
  const reasons = []
  const start = timestamp(report.createdAt), finish = timestamp(report.finishedAt)
  if (start === null || finish === null) reasons.push('missing_time_binding')
  if (start !== null && finish !== null && (finish < start || finish > expected.until || start > expected.until)) return { kind: 'invalid', reasons: ['invalid_time_range'] }
  if (start !== null && start < expected.since) return { kind: 'historical', reasons: ['before_candidate_window'] }
  const source = report.binding?.sourceSha256
  if (!SHA.test(source ?? '')) reasons.push('missing_source_binding')
  else if (source !== expected.sourceSha256) return { kind: 'historical', reasons: ['different_source'] }
  const runtime = report.binding?.runtimeIdentity
  if (runtime !== null && runtime !== undefined && !SHA.test(runtime)) return { kind: 'invalid', reasons: ['invalid_runtime_identity'] }
  if (['live_model', 'product_no_model'].includes(executionKind)) {
    if (!expected.runtimeIdentity || !runtime) reasons.push('missing_runtime_binding')
    else if (runtime !== expected.runtimeIdentity) return { kind: 'historical', reasons: ['different_runtime'] }
  }
  return { kind: reasons.length ? 'unbound' : 'current', reasons }
}

/** Adapters retain evidence boundaries. Legacy accepted=true is never promoted to a task pass. */
function adapt(raw, reportId) {
  if (raw.schema === 'xiaoshe-task-run/v1') return { ...raw, adapter: 'task-run', strict: true }
  if (raw.schema === 'xiaoshe-internal-candidate/v1') return {
    adapter: 'internal-gate', runId: reportId, createdAt: raw.createdAt, finishedAt: raw.finishedAt,
    binding: { sourceSha256: raw.sourceBefore?.sha256, runtimeIdentity: null }, executionKind: 'component_fixture', tasks: [],
    gate: { deterministic: raw.deterministic ?? 'unknown', live: raw.live ?? 'unknown', status: raw.status ?? 'unknown', sourceStable: raw.sourceStable === true, releaseApproval: raw.releaseApproval === true },
  }
  if (raw.schemaVersion === 1 && Array.isArray(raw.scenarios)) return {
    adapter: 'complex-live', runId: raw.acceptanceBinding?.nonce ?? reportId,
    createdAt: raw.createdAt, finishedAt: raw.finishedAt, binding: raw.acceptanceBinding,
    executionKind: 'live_model', cleanup: raw.cleanup,
    tasks: raw.scenarios.filter(row => complexTasks[row?.id]).map(row => ({ taskId: complexTasks[row.id], state: row.state, checks: row.checks, metrics: row.metrics })),
    // The outer gate owns time, before/after runtime checks and nonce validation.
    // A raw scenario report without finishedAt remains an unbound reference.
    referenceOnly: !raw.finishedAt,
    adapterErrors: raw.scenarios.some(row => !complexTasks[row?.id] || !object(row)) ? ['unrecognized_or_setup_scenario'] : [],
  }
  if (raw.schemaVersion === 1 && Array.isArray(raw.checks) && raw.checks.some(row => legacyTasks[row?.id])) return {
    adapter: 'legacy-agent', runId: reportId, createdAt: raw.createdAt, finishedAt: null, binding: null,
    executionKind: 'live_model', referenceOnly: true,
    tasks: raw.checks.filter(row => legacyTasks[row?.id]).map(row => ({ taskId: legacyTasks[row.id], state: row.state, checks: [], metrics: { durationMs: row.elapsedMs } })),
  }
  if (typeof raw.accepted === 'boolean' && Array.isArray(raw.checks)) return {
    adapter: 'legacy-browser', runId: reportId, createdAt: raw.completedAt ?? null, finishedAt: raw.completedAt ?? null,
    binding: null, executionKind: 'unknown', referenceOnly: true, tasks: [],
    reference: { reportedAccepted: raw.accepted, authenticatedExternalSiteTested: raw.authenticatedExternalSiteTested === true, checkCount: raw.checks.length },
  }
  throw new Error('unsupported_report_schema')
}

function normalizeReport(raw, source, expected) {
  if (!object(raw)) throw new Error('report_must_be_object')
  const reportId = source.sha256
  const report = adapt(raw, reportId)
  const errors = [...(report.adapterErrors ?? [])]
  if (!validId(report.runId)) errors.push('invalid_run_id')
  if (!EXECUTIONS.has(report.executionKind)) errors.push('invalid_execution_kind')
  if (!Array.isArray(report.tasks) || report.tasks.length > 30 || (report.strict && report.tasks.length === 0)) errors.push('invalid_task_list')
  const bound = currency(report, expected, report.executionKind)
  if (bound.kind === 'invalid') errors.push(...bound.reasons)
  if (!report.referenceOnly && report.adapter !== 'internal-gate' && !checkList(report.cleanup)) errors.push('missing_or_invalid_cleanup')
  if (report.adapter === 'internal-gate' && (!report.gate.sourceStable || raw.sourceBefore?.sha256 !== raw.sourceAfter?.sha256)) errors.push('gate_source_changed')
  if (report.adapter === 'internal-gate' && !gateStagesValid(raw)) errors.push('gate_stage_contract_incomplete')
  const seen = new Set()
  const evidence = []
  for (const row of Array.isArray(report.tasks) ? report.tasks : []) {
    if (!object(row) || !taskById.has(row.taskId) || seen.has(row.taskId)) { errors.push('unknown_or_duplicate_task'); continue }
    seen.add(row.taskId)
    const contract = taskById.get(row.taskId)
    const rowErrors = []
    if (!STATES.has(row.state)) rowErrors.push('invalid_task_state')
    const validChecks = checkList(row.checks)
    if (!report.referenceOnly && !validChecks && !['not_run', 'pending_external'].includes(row.state)) rowErrors.push('missing_or_invalid_checks')
    const passedChecks = new Set(validChecks ? row.checks.filter(check => check.state === 'pass').map(check => check.id) : [])
    const missingChecks = contract.requiredChecks.filter(id => !passedChecks.has(id))
    const cleanupPass = checkList(report.cleanup) && report.cleanup.every(check => check.state === 'pass')
    const everyCheckPass = validChecks && row.checks.every(check => check.state === 'pass')
    let state = row.state
    if (state === 'pass' && (!everyCheckPass || !cleanupPass || missingChecks.length || report.referenceOnly)) state = 'partial'
    if ((validChecks && row.checks.some(check => check.state === 'fail')) || (checkList(report.cleanup) && report.cleanup.some(check => check.state === 'fail'))) state = 'fail'
    evidence.push({ taskId: row.taskId, reportId, runId: report.runId, executionKind: report.executionKind,
      state, claimedState: STATES.has(row.state) ? row.state : 'unknown', currency: bound.kind,
      reasons: [...bound.reasons, ...rowErrors, ...(report.referenceOnly ? ['reference_only_adapter'] : []),
        ...(row.state === 'pass' && !cleanupPass ? ['cleanup_not_passed'] : []),
        ...(row.state === 'pass' && missingChecks.length ? ['required_checks_not_passed'] : [])],
      missingChecks, metrics: metrics(row.metrics),
    })
    errors.push(...rowErrors)
  }
  if (errors.length) for (const item of evidence) { item.currency = 'invalid'; item.reasons.push('report_integrity_error') }
  return {
    report: { id: reportId, path: source.path, sha256: source.sha256, adapter: report.adapter,
      runId: report.runId ?? null, executionKind: EXECUTIONS.has(report.executionKind) ? report.executionKind : 'unknown',
      createdAt: timestamp(report.createdAt) === null ? null : report.createdAt,
      finishedAt: timestamp(report.finishedAt) === null ? null : report.finishedAt,
      sourceSha256: SHA.test(report.binding?.sourceSha256 ?? '') ? report.binding.sourceSha256 : null,
      runtimeIdentity: SHA.test(report.binding?.runtimeIdentity ?? '') ? report.binding.runtimeIdentity : null,
      currency: errors.length ? 'invalid' : bound.kind, reasons: bound.reasons,
      ...(report.gate ? { gate: report.gate } : {}), ...(report.reference ? { reference: report.reference } : {}),
      errors: [...new Set(errors)], taskEvidenceCount: evidence.length,
    }, evidence,
  }
}

async function loadReport(path) {
  const absolute = resolve(path)
  const stat = await lstat(absolute)
  // No directories, FIFOs or links, and no unbounded report reads.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES) throw new Error('unsafe_or_oversized_report')
  const canonical = await realpath(absolute)
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || stat.dev !== opened.dev || stat.ino !== opened.ino || stat.size !== opened.size) throw new Error('report_changed_during_read')
    // Bound the read even when a writer grows a report after the initial stat.
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await lstat(absolute), final = await handle.stat()
    if (length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || after.isSymbolicLink()
      || stat.dev !== after.dev || stat.ino !== after.ino || opened.mtimeMs !== final.mtimeMs || opened.size !== final.size) throw new Error('report_changed_during_read')
    const bytes = buffer.subarray(0, length)
    return { path: canonical, sha256: digest(bytes), raw: JSON.parse(bytes.toString('utf8')) }
  } finally { await handle.close() }
}

/** The caller supplies the actual candidate identity. No source/session scanning occurs here. */
export async function buildTaskEvidence({ sourceSha256, runtimeIdentity = null, since, until = new Date().toISOString(), reportPaths = [] }) {
  if (!SHA.test(sourceSha256 ?? '') || (runtimeIdentity !== null && !SHA.test(runtimeIdentity))) throw new Error('invalid_expected_identity')
  const start = timestamp(since), end = timestamp(until)
  if (start === null || end === null || end < start) throw new Error('invalid_candidate_time_window')
  if (!Array.isArray(reportPaths) || reportPaths.length > 128 || reportPaths.some(path => typeof path !== 'string' || !path)) throw new Error('invalid_report_paths')
  const expected = { sourceSha256, runtimeIdentity, since: start, until: end }
  const reports = [], evidence = [], errors = [], paths = new Set(), hashes = new Set(), runs = new Map()
  for (const path of reportPaths) {
    let source
    try {
      source = await loadReport(path)
      if (paths.has(source.path) || hashes.has(source.sha256)) throw new Error('duplicate_report')
      paths.add(source.path); hashes.add(source.sha256)
      const normalized = normalizeReport(source.raw, source, expected)
      if (runs.has(normalized.report.runId)) {
        const previous = runs.get(normalized.report.runId)
        previous.currency = 'invalid'; previous.errors.push('duplicate_run_id')
        for (const item of evidence.filter(item => item.runId === normalized.report.runId)) { item.currency = 'invalid'; item.reasons.push('duplicate_run_id') }
        normalized.report.currency = 'invalid'; normalized.report.errors.push('duplicate_run_id')
        for (const item of normalized.evidence) { item.currency = 'invalid'; item.reasons.push('duplicate_run_id') }
      }
      runs.set(normalized.report.runId, normalized.report)
      reports.push(normalized.report); evidence.push(...normalized.evidence)
    } catch (error) {
      // Do not retain raw parse errors: they may contain private report text.
      const code = error instanceof SyntaxError ? 'invalid_json' : /^[a-z_]+$/u.test(error?.message ?? '') ? error.message : 'report_unreadable'
      errors.push({ path: resolve(path), code })
    }
  }
  const tasks = TASK_CATALOG.map(contract => {
    const items = evidence.filter(item => item.taskId === contract.id)
    const current = items.filter(item => item.currency === 'current' && item.state !== 'not_run')
    let status = 'not_run'
    // A later green run never erases an earlier failure within the same candidate window.
    if (items.some(item => item.currency === 'invalid')) status = 'invalid'
    else if (current.some(item => item.state === 'fail')) status = 'failed'
    else if (current.some(item => item.state === 'partial')) status = 'partial'
    else if (current.some(item => item.state === 'pass' && item.executionKind === contract.executionKind)) status = 'passed'
    else if (current.some(item => item.state === 'pass' && item.executionKind === 'component_fixture')) status = 'fixture_only'
    else if (current.some(item => item.state === 'pending_external')) status = 'pending_external'
    else if (current.length) status = 'partial'
    else if (items.some(item => item.currency === 'historical')) status = 'historical'
    else if (items.some(item => item.currency === 'unbound')) status = 'unbound'
    return { ...contract, status, evidence: items }
  })
  const counts = Object.fromEntries(['passed', 'failed', 'partial', 'fixture_only', 'not_run', 'pending_external', 'historical', 'unbound', 'invalid'].map(state => [state, tasks.filter(task => task.status === state).length]))
  const integrityErrors = errors.length + reports.reduce((sum, report) => sum + report.errors.length, 0)
  return {
    schema: 'xiaoshe-task-evidence-index/v1', catalogVersion: TASK_CATALOG_VERSION,
    generatedAt: until, candidate: { sourceSha256, runtimeIdentity, since, until },
    scope: 'Only explicitly supplied reports are indexed. Task definitions are not executions; this is not release approval or a measured population success rate.',
    summary: { definedTasks: TASK_CATALOG.length, suppliedReports: reportPaths.length, loadedReports: reports.length,
      counts, liveModelPassed: tasks.filter(task => task.status === 'passed' && task.executionKind === 'live_model').length,
      productNoModelPassed: tasks.filter(task => task.status === 'passed' && task.executionKind === 'product_no_model').length,
      integrityErrors, complete: counts.passed === TASK_CATALOG.length && integrityErrors === 0, releaseApproval: false },
    reports, errors, tasks,
  }
}

const labels = { passed: '已通过', failed: '失败', partial: '证据不完整', fixture_only: '仅组件通过', not_run: '未执行', pending_external: '外部待验', historical: '历史参考', unbound: '未绑定参考', invalid: '证据无效' }
export function renderTaskEvidenceSummary(index) {
  const counts = index.summary.counts
  return `# 小蛇固定任务证据索引\n\n候选源码：\`${index.candidate.sourceSha256}\`\n\n验收窗口：${index.candidate.since} 至 ${index.candidate.until}\n\n` +
    `定义 ${index.summary.definedTasks} 项不等于执行 ${index.summary.definedTasks} 项。当前按完整任务契约通过 ${counts.passed} 项，其中真实模型 ${index.summary.liveModelPassed} 项、无模型真实产品旅程 ${index.summary.productNoModelPassed} 项；仅组件通过 ${counts.fixture_only} 项。\n\n` +
    `证据完整性错误 ${index.summary.integrityErrors} 项。${index.summary.complete ? '本目录任务契约均有当前证据。' : '任务基线尚未完整通过。'}本索引不是发行批准，也不是通用任务成功率。未提供的耗时、重试、人工介入或费用保持未知。\n\n` +
    '| 固定任务 | 所需执行 | 当前状态 |\n| --- | --- | --- |\n' +
    index.tasks.map(task => `| ${task.id} · ${task.title} | ${task.executionKind} | ${labels[task.status]} |`).join('\n') + '\n'
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}

async function canonicalDestination(path) {
  try { return await realpath(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return join(await canonicalDestination(dirname(path)), basename(path))
  }
}

export async function runTaskEvidenceCli(argv) {
  const options = { reportPaths: [] }, seen = new Set()
  const names = new Map([['--source-sha', 'sourceSha256'], ['--runtime-identity', 'runtimeIdentity'], ['--since', 'since'], ['--until', 'until'], ['--root', 'root'], ['--output', 'output'], ['--summary', 'summary']])
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--require-complete') { if (seen.has(key)) throw new Error('duplicate_argument'); seen.add(key); options.requireComplete = true; continue }
    if ((key !== '--report' && !names.has(key)) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid_cli_arguments')
    const value = argv[++i]
    if (key === '--report') options.reportPaths.push(value)
    else { if (seen.has(key)) throw new Error('duplicate_argument'); seen.add(key); options[names.get(key)] = value }
  }
  if (!options.sourceSha256 || !options.since || !options.output || !options.summary) throw new Error('require_source_sha_since_output_summary')
  const root = resolve(options.root ?? fileURLToPath(new URL('../..', import.meta.url)))
  const output = resolve(options.output), summary = resolve(options.summary)
  if (output === summary || options.reportPaths.some(path => [output, summary].includes(resolve(path)))) throw new Error('output_conflicts_with_input')
  const inputPaths = await Promise.all(options.reportPaths.map(path => canonicalDestination(resolve(path))))
  const destinations = await Promise.all([output, summary].map(canonicalDestination))
  if (destinations[0] === destinations[1] || destinations.some(path => inputPaths.includes(path))) throw new Error('output_conflicts_with_input')
  const canonicalRoot = await realpath(root)
  for (const path of destinations) {
    const suffix = relative(canonicalRoot, path)
    const outside = suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)
    if (!outside && !suffix.startsWith(`output${sep}`)) throw new Error('output_path_must_not_modify_source')
    if (!outside) {
      // A directory called output is not automatically generated-only. Check
      // even nonexistent destinations, without --no-index: tracked files must
      // remain protected despite an ignore pattern that would match new files.
      try {
        await exec('git', ['-C', canonicalRoot, 'check-ignore', '--quiet', '--', path], {
          windowsHide: true, timeout: 8_000, maxBuffer: 4096,
        })
      } catch (error) {
        if (error.code === 1) throw new Error('output_path_must_be_gitignored')
        throw new Error('output_ignore_check_failed')
      }
    }
  }
  if (options.until && timestamp(options.until) > Date.now()) throw new Error('candidate_window_is_in_the_future')
  const before = await captureCandidate(root)
  if (before.sha256 !== options.sourceSha256) throw new Error('expected_source_does_not_match_checkout')
  const index = await buildTaskEvidence(options)
  if ((await captureCandidate(root)).sha256 !== before.sha256) throw new Error('source_changed_during_index')
  await atomicWrite(output, `${JSON.stringify(index, null, 2)}\n`)
  await atomicWrite(summary, renderTaskEvidenceSummary(index))
  return { index, output, summary, exitCode: index.summary.integrityErrors || (options.requireComplete && !index.summary.complete) ? 1 : 0 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runTaskEvidenceCli(process.argv.slice(2))
    process.stdout.write(`JSON: ${result.output}\n摘要: ${result.summary}\n任务通过: ${result.index.summary.counts.passed}/30; 仅组件: ${result.index.summary.counts.fixture_only}; 完整性错误: ${result.index.summary.integrityErrors}\n`)
    process.exitCode = result.exitCode
  } catch (error) { process.stderr.write(`task-evidence: ${error.message}\n`); process.exitCode = 1 }
}
