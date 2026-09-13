#!/usr/bin/env node
/** Internal candidate validation, not a signed-release or competitor benchmark. */
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { productRuntimeIdentity } from '../product-runtime-identity.mjs'
import { resolveLocalAcceptanceBase } from '../acceptance/local-acceptance-base.mjs'

const exec = promisify(execFile)
const rootDefault = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scenarios = ['code-repair', 'conflict-research', 'offline-to-online-topic-switch', 'failure-recovery', 'user-steer']
const hash = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
let pythonExecutable
async function resolvePython() {
  pythonExecutable ??= exec(process.env.XIAOSHE_QUALITY_PYTHON ?? 'python.exe', ['-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8', windowsHide: true, timeout: 8_000, maxBuffer: 4096 }).then(async result => {
    const path = result.stdout.trim()
    if (!isAbsolute(path) || !(await lstat(path)).isFile()) throw new Error('invalid Python executable')
    return path
  })
  return pythonExecutable
}
const inside = (root, path) => {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

/** Hash actual tracked + untracked inputs, including deletions, not just HEAD.
 * Git-ignored build/report/profile state is deliberately not candidate source.
 * This gate requires a Git checkout; source archives use the release verifier.
 */
export async function captureCandidate(root) {
  root = await realpath(root)
  const git = args => exec('git', args, { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 })
  const top = (await git(['rev-parse', '--show-toplevel'])).stdout.trim()
  if (await realpath(top) !== root) throw new Error('quality gate requires the product Git root')
  const commit = await git(['rev-parse', '--verify', 'HEAD']).then(value => value.stdout.trim()).catch(() => 'unborn')
  const names = [...new Set((await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout.split('\0').filter(Boolean))].sort()
  if (names.length === 0) throw new Error('empty candidate')
  const digest = createHash('sha256')
  for (const name of names) {
    const path = resolve(root, name)
    if (!inside(root, path)) throw new Error('candidate path escapes product root')
    const before = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (before === null) { digest.update(`${name}\0deleted\0`); continue }
    if (!before.isFile() || before.isSymbolicLink() || !inside(root, await realpath(path))) throw new Error(`candidate input is not a contained regular file: ${name}`)
    const bytes = await readFile(path)
    const after = await lstat(path)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('candidate changed while hashing')
    digest.update(`${name}\0${hash(bytes)}\0`)
  }
  return { commit, files: names.length, sha256: digest.digest('hex') }
}

export function validateLiveEvidence(evidence, expected) {
  return object(evidence) && evidence.schemaVersion === 1 && typeof evidence.createdAt === 'string' && Number.isFinite(Date.parse(evidence.createdAt))
    && (!expected || (evidence.acceptanceBinding?.nonce === expected.nonce
      && evidence.acceptanceBinding?.runtimeIdentity === expected.runtimeIdentity
      && evidence.acceptanceBinding?.sourceSha256 === expected.sourceSha256
      && Date.parse(evidence.createdAt) >= expected.startedAt
      && Date.parse(evidence.createdAt) <= expected.finishedAt))
    && Array.isArray(evidence?.scenarios) && evidence.scenarios.length === scenarios.length
    && evidence.scenarios.every(object)
    && scenarios.every(id => evidence.scenarios.filter(item => item.id === id).length === 1)
    && evidence.scenarios.every(item => item.state === 'pass' && Array.isArray(item.checks)
      && item.checks.length > 0 && item.checks.every(check => object(check) && check.state === 'pass'))
    && Array.isArray(evidence.cleanup) && evidence.cleanup.length > 0
    && evidence.cleanup.every(check => object(check) && check.state === 'pass')
}

/** Check both startup identity and current payload, not merely a matching cwd. */
export async function verifyLiveRuntime(root, profileRoot, base) {
  if (!isAbsolute(profileRoot ?? '')) throw new Error('live gate requires an absolute isolated Profile root')
  const identity = await productRuntimeIdentity({ root, dshRoot: join(root, 'runtime/DSH'), profileRoot })
  const response = await fetch(`${resolveLocalAcceptanceBase(base)}/xiaoshe/desktop/status`, { signal: AbortSignal.timeout(15_000) })
  const status = response.ok ? await response.json() : null
  if (status?.runtime_identity !== identity || status?.product !== '小蛇' || status?.bridge?.state !== 'ready') {
    throw new Error('live runtime does not match current built payload and Profile; start a fresh owned instance')
  }
  return identity
}

/** Stop only the child tree created for this stage, never by process name/port. */
async function stopChild(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    await exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 5_000 })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

/** No child stdout/stderr content is retained: tests can accidentally print secrets.
 * Byte counts support diagnostics; rerun the named stage locally for full logs.
 */
async function runStage(stage, root) {
  const start = performance.now()
  let command = stage.command, args = stage.args
  if (process.platform === 'win32') {
    try {
      command = await resolvePython()
      args = [fileURLToPath(new URL('./windows-job.py', import.meta.url)), '--node', process.execPath, '--', stage.command, ...stage.args]
    } catch { return { id: stage.id, kind: stage.kind ?? 'deterministic', status: 'failed', errorCode: 'python_supervisor_unavailable', durationMs: Math.round(performance.now() - start) } }
  }
  return new Promise(resolveStage => {
    let timedOut = false, finished = false, stdoutBytes = 0, stderrBytes = 0, timer
    const child = spawn(command, args, {
      cwd: stage.cwd ?? root, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', ...stage.env },
    })
    const finish = (exitCode, errorCode) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      // Inline fixture/eval content is private source, not a diagnostic command.
      const args = stage.args.map((value, index) => ['-e', '--eval', '-c', '--command'].includes(stage.args[index - 1]?.toLowerCase())
        ? `[inline sha256:${hash(value)}]` : value)
      resolveStage({ id: stage.id, kind: stage.kind ?? 'deterministic',
        invocation: { command: stage.command, args, cwd: relative(root, stage.cwd ?? root) || '.' },
        status: timedOut ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed',
        exitCode, ...(errorCode ? { errorCode } : {}),
        durationMs: Math.round(performance.now() - start), stdoutBytes, stderrBytes })
    }
    child.stdout.on('data', chunk => { stdoutBytes += chunk.length })
    child.stderr.on('data', chunk => { stderrBytes += chunk.length })
    child.once('error', error => finish(null, error.code ?? 'spawn_error'))
    child.once('close', code => {
      clearTimeout(timer)
      // A successful POSIX parent can leave unref'ed descendants with closed
      // pipes. Reap its owned group on normal exit too; Windows' Job already
      // performs the equivalent operation before its supervisor exits.
      if (process.platform === 'win32') finish(code)
      else void stopChild(child).then(() => finish(code), () => finish(null, 'child_cleanup_failed'))
    })
    timer = setTimeout(() => {
      timedOut = true
      void stopChild(child).then(() => finish(null), () => finish(null, 'child_cleanup_failed'))
    }, stage.timeoutMs ?? 600_000)
  })
}

async function atomicReport(path, report) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

/** All requested stages must settle successfully on unchanged source. A
 * deterministic pass with no live run remains explicitly partial maturity.
 */
export async function runGate({ root, stages, required, reportPath, onProgress = () => {} }) {
  if (!Array.isArray(stages) || stages.length === 0 || !Array.isArray(required) || required.length === 0) throw new Error('empty stage plan')
  if (new Set(stages.map(stage => stage.id)).size !== stages.length || new Set(required).size !== required.length) throw new Error('duplicate stage ID')
  for (const stage of stages) {
    if (!stage.id || !stage.command || !Array.isArray(stage.args) || stage.args.some(arg => typeof arg !== 'string')
      || (stage.timeoutMs !== undefined && (!Number.isFinite(stage.timeoutMs) || stage.timeoutMs < 1))) throw new Error('invalid stage')
  }
  const report = { schema: 'xiaoshe-internal-candidate/v1', createdAt: new Date().toISOString(),
    platform: process.platform, node: process.version, releaseApproval: false,
    sourceBefore: await captureCandidate(root), sourceAfter: null, sourceStable: false,
    stages: [], requiredStages: required, missingStages: required.filter(id => !stages.some(stage => stage.id === id)),
    deterministic: 'not_run', live: 'not_run', status: 'running',
    external: { macOSPhysicalAcceptance: 'pending_external', signing: 'not_requested' } }
  await atomicReport(reportPath, report)
  let failed = report.missingStages.length > 0
  for (const stage of stages) {
    if (!failed) onProgress({ id: stage.id, status: 'running' })
    let identity
    const startedAt = Date.now()
    const nonce = randomUUID()
    if (!failed && stage.kind === 'live') {
      try {
        if (!stage.evidencePath || await lstat(stage.evidencePath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('live evidence must be fresh')
        identity = await verifyLiveRuntime(root, stage.profileRoot, stage.base)
      } catch { failed = true; report.livePreflightError = true }
    }
    const binding = { nonce, runtimeIdentity: identity, sourceSha256: report.sourceBefore.sha256 }
    const executable = stage.kind === 'live' ? { ...stage, env: { ...stage.env, XIAOSHE_ACCEPTANCE_BINDING: JSON.stringify(binding) } } : stage
    let outcome = failed ? { id: stage.id, kind: stage.kind ?? 'deterministic', status: 'not_run' } : await runStage(executable, root)
    if (outcome.status === 'passed' && stage.evidencePath) {
      const evidence = await readFile(stage.evidencePath, 'utf8').then(JSON.parse).catch(() => null)
      outcome = { ...outcome, evidenceComplete: validateLiveEvidence(evidence, { ...binding, startedAt, finishedAt: Date.now() }) }
      if (!outcome.evidenceComplete) outcome.status = 'failed'
    }
    if (outcome.status === 'passed' && stage.kind === 'live') {
      const after = await verifyLiveRuntime(root, stage.profileRoot, stage.base).catch(() => null)
      outcome.runtimeIdentity = identity
      if (after !== identity) outcome.status = 'failed'
    }
    failed ||= outcome.status !== 'passed'
    report.stages.push(outcome)
    onProgress(outcome)
    await atomicReport(reportPath, report)
  }
  try {
    report.sourceAfter = await captureCandidate(root)
    report.sourceStable = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter)
  } catch { report.sourceCaptureError = true }
  const regular = report.stages.filter(item => item.kind !== 'live')
  const live = report.stages.filter(item => item.kind === 'live')
  report.deterministic = regular.length > 0 && regular.every(item => item.status === 'passed') ? 'passed' : 'failed'
  report.live = live.length === 0 ? 'not_run' : live.length >= 2 && live.every(item => item.status === 'passed') ? 'passed' : 'partial'
  report.status = failed || !report.sourceStable || report.deterministic !== 'passed' || report.live === 'partial' ? 'failed' : report.live === 'passed' ? 'passed' : 'partial'
  report.finishedAt = new Date().toISOString()
  await atomicReport(reportPath, report)
  return report
}

/** Dependency-ordered product builds; no install step, cache purge or release pack. */
async function defaultStages(root, npmCli, output, live) {
  const npm = (id, directory, script, timeoutMs = 600_000) => ({ id, command: process.execPath,
    args: [npmCli, 'run', script], cwd: join(root, directory), timeoutMs })
  const packages = await Promise.all((await readdir(join(root, 'packages'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(async entry => ({ directory: `packages/${entry.name}`,
      manifest: JSON.parse(await readFile(join(root, 'packages', entry.name, 'package.json'), 'utf8')) })))
  const sorted = [], visiting = new Set(), visited = new Set()
  const visit = item => {
    if (visited.has(item)) return
    if (visiting.has(item)) throw new Error('cyclic product package dependencies')
    visiting.add(item)
    for (const name of Object.keys({ ...item.manifest.dependencies, ...item.manifest.devDependencies })) {
      const dependency = packages.find(candidate => candidate.manifest.name === name)
      if (dependency) visit(dependency)
    }
    visiting.delete(item); visited.add(item); sorted.push(item)
  }
  packages.forEach(visit)
  const stages = [npm('dsh-host-build', 'runtime/DSH', 'build:lib:host'), npm('dsh-client-build', 'runtime/DSH', 'build:lib:client'),
    npm('dsh-web-build', 'runtime/DSH/apps/web', 'build')]
  for (const script of ['build', 'typecheck', 'test']) {
    for (const item of sorted) if (item.manifest.scripts?.[script]) stages.push(npm(`${item.directory}:${script}`, item.directory, script))
  }
  for (const script of ['typecheck', 'test:agent', 'test:agent:integration', 'test:browser']) stages.push(npm(`root:${script}`, '.', script))
  stages.push(npm('dsh-tests', 'runtime/DSH', 'test'), npm('desktop-tests', 'apps/desktop-shell', 'test'))
  // Native focus/storage acceptance runs after other Electron fixtures so
  // another test process cannot become its foreground-window false positive.
  stages.push({ id: 'native-browser-tests', command: process.execPath, args: ['--test', 'scripts/quality/native-browser.test.mjs'], timeoutMs: 180_000 })
  const rootTests = (await readdir(join(root, 'scripts'))).filter(name => name.endsWith('.test.mjs') && !name.includes('.integration.'))
  stages.push({ id: 'root-script-tests', command: process.execPath, args: ['--test', ...rootTests.map(name => `scripts/${name}`), 'scripts/runtime-version-http.integration.test.mjs', 'scripts/quality/internal-beta.test.mjs', 'scripts/quality/windows-job.test.mjs', 'scripts/quality/task-evidence.test.mjs', 'scripts/quality/product-lifecycle.test.mjs', 'scripts/quality/product-lifecycle-policy.test.mjs', 'scripts/acceptance/live-request-budget.test.mjs', 'scripts/acceptance/live-file-tool-policy.test.mjs', 'scripts/acceptance/live-official-budget.test.mjs', 'scripts/acceptance/live-run-finalize.test.mjs', 'scripts/acceptance/same-session-file-proof.test.mjs', 'scripts/acceptance/same-session-files-live.test.mjs', 'scripts/acceptance/live-native-official.test.mjs', 'scripts/acceptance/live-material-policy.test.mjs', 'scripts/acceptance/material-fixture.test.mjs', 'scripts/acceptance/material-live.test.mjs', 'scripts/acceptance/material-task-proof.test.mjs', 'scripts/acceptance/vision-proof.test.mjs'], timeoutMs: 600_000 })
  // Exercise live-runner safety contracts without authorizing model requests,
  // native clipboard access or a paid journey from the offline candidate gate.
  stages.at(-1).args.push(...[
    'material-suite', 'live-vision-budget', 'live-vision-policy',
    'vision-engine-runtime', 'vision-runtime-patch', 'vision-install', 'vision-live',
    'batch-fixture', 'batch-task-proof', 'batch-live', 'stability-live',
    'vision-wire-observer', 'vision-wire-install',
  ].map(name => `scripts/acceptance/${name}.test.mjs`))
  stages.at(-1).args.push('scripts/acceptance/execution-policy-facts.integration.test.mjs',
    'scripts/acceptance/vision-wire-agent-loop.integration.test.mjs')
  if (live) {
    if (!process.env.XIAOSHE_ACCEPTANCE_BASE_URL || !isAbsolute(process.env.XIAOSHE_ACCEPTANCE_PROFILE_ROOT ?? '')) throw new Error('--live requires an explicit owned loopback runtime URL and absolute Profile root')
    for (let repetition = 1; repetition <= 2; repetition++) {
      const evidencePath = join(output, `live-${repetition}.json`)
      stages.push({ id: `complex-live-${repetition}`, kind: 'live', command: process.execPath,
        args: ['scripts/acceptance/harness-performance-complex-smoke.mjs'], timeoutMs: 1_800_000,
        evidencePath, profileRoot: process.env.XIAOSHE_ACCEPTANCE_PROFILE_ROOT,
        env: { XIAOSHE_HARNESS_REPORT_PATH: evidencePath } })
    }
  }
  return stages
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.some(arg => arg !== '--live')) throw new Error('usage: npm run verify:internal [-- --live]')
    const npmCli = process.env.npm_execpath
    if (!npmCli || !/npm-cli\.js$/u.test(npmCli)) throw new Error('invoke this gate with npm run verify:internal (dependencies must already be installed)')
    const output = join(rootDefault, 'output/maturity', `candidate-${Date.now()}-${randomUUID().slice(0, 8)}`)
    const reportPath = join(output, 'report.json')
    const stages = await defaultStages(rootDefault, npmCli, output, args.includes('--live'))
    const report = await runGate({ root: rootDefault, stages, required: stages.map(stage => stage.id), reportPath,
      onProgress: item => process.stdout.write(`${item.status}: ${item.id}\n`) })
    process.stdout.write(`Report: ${reportPath}\nDeterministic: ${report.deterministic}; live: ${report.live}; status: ${report.status}\n`)
    if (report.status === 'failed') process.exitCode = 1
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
