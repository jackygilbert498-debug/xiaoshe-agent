import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, realpath, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { captureCandidate } from '../../../scripts/quality/internal-beta.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const electron = createRequire(import.meta.url)('electron')
const exec = promisify(execFile)
const requiredChecks = ['source-read', 'structured-output-readback', 'browser-submitted', 'server-value-matched', 'page-readback-matched', 'original-input-unchanged']
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let python

async function commandForOwnedTree(command, args, env) {
  if (process.platform !== 'win32') return { command, args }
  python ??= exec(env.XIAOSHE_QUALITY_PYTHON ?? 'python.exe', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8', windowsHide: true, timeout: 8_000, maxBuffer: 4096,
  }).then(async value => {
    const executable = value.stdout.trim()
    if (!isAbsolute(executable) || !(await lstat(executable)).isFile()) throw new Error('real Windows Job supervisor requires a Python executable')
    return executable
  })
  return { command: await python, args: [join(root, 'scripts/quality/windows-job.py'), '--node', process.execPath, '--', command, ...args] }
}

/** Own the entire child tree, including descendants left after normal exit.
 * POSIX uses only this child's new process group; Windows reuses kill-on-close
 * Job supervision. No process-name/port matching or user-service cleanup. */
async function runOwned(command, args, { env = process.env, timeoutMs = 65_000, cwd = root,
  signalProcess = (pid, signal) => process.kill(pid, signal), onSpawn = () => {} } = {}) {
  const invocation = await commandForOwnedTree(command, args, env)
  return new Promise((resolveRun, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd, env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false, settled = false, cleanupFailure
    const signalErrors = []
    const append = bytes => { log = (log + bytes).slice(-20_000) }
    child.stdout.on('data', append); child.stderr.on('data', append)
    const stopOwned = () => {
      if (!Number.isInteger(child.pid)) return
      try {
        if (process.platform === 'win32') { if (child.exitCode === null) child.kill('SIGKILL') }
        else signalProcess(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') {
          // Keep the real error as the cause of any failed cleanup proof. A
          // repeated signal can race with exit, so it is not itself the proof.
          cleanupFailure ??= error
          signalErrors.push({ code: typeof error.code === 'string' ? error.code : 'UNKNOWN' })
        }
      }
    }
    const proveGone = async () => {
      if (process.platform === 'win32' || !Number.isInteger(child.pid)) {
        if (cleanupFailure) throw cleanupFailure
        return { processGroupGone: process.platform === 'win32' ? null : true, signalErrors }
      }
      const deadline = Date.now() + 5_000
      while (true) {
        try { signalProcess(-child.pid, 0) } catch (error) {
          if (error.code === 'ESRCH') return { processGroupGone: true, signalErrors }
          cleanupFailure ??= error
        }
        if (Date.now() >= deadline) {
          const error = new Error('owned workflow process-tree cleanup could not be proven', { cause: cleanupFailure })
          error.code = cleanupFailure?.code ?? 'OWNED_TREE_SURVIVED'
          throw error
        }
        await sleep(25)
      }
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true; clearTimeout(timer); clearTimeout(hardStop)
      child.stdout.destroy(); child.stderr.destroy()
      if (error) reject(error); else resolveRun(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stopOwned()
    }, timeoutMs)
    const hardStop = setTimeout(() => {
      stopOwned()
      void proveGone().then(() => finish(cleanupFailure ?? new Error('owned workflow tree did not settle after timeout cleanup')), error => finish(error))
    }, timeoutMs + 5_000)
    child.once('error', error => {
      stopOwned()
      void proveGone().then(() => finish(error), cleanupError => finish(cleanupError))
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(hardStop)
      if (process.platform !== 'win32') stopOwned()
      void proveGone().then(cleanup => finish(null, { code, signal, timedOut, log, cleanup }), error => finish(error))
    })
    try { onSpawn(child.pid) } catch (error) {
      stopOwned()
      void proveGone().then(() => finish(error), cleanupError => finish(cleanupError))
    }
  })
}

function markParentFailure(report) {
  for (const row of report?.tasks ?? []) row.state = 'fail'
  report.parentValidation = 'failed'
}

async function finishProfileCleanup(report, output, remove = rm) {
  let cleanupPassed = false
  try {
    await remove(output, { recursive: true, force: true })
    await assert.rejects(lstat(output), error => error.code === 'ENOENT')
    cleanupPassed = true
  } catch { markParentFailure(report) }
  report.cleanup = [...(report.cleanup ?? []).filter(row => row.id !== 'parent-owned-profile-cleanup'),
    { id: 'parent-owned-profile-cleanup', state: cleanupPassed ? 'pass' : 'fail' }]
  report.profileCleanup = cleanupPassed ? 'completed_after_electron_exit' : 'failed_after_electron_exit'
  report.finishedAt = new Date().toISOString()
  if (cleanupPassed && report.parentValidation === 'passed' && report.cleanup.every(row => row.state === 'pass')) {
    for (const row of report.tasks) row.state = 'pass'
  }
  return cleanupPassed
}

async function publishReport(report, evidenceOutput) {
  if (!evidenceOutput) return
  assert.ok(isAbsolute(evidenceOutput), 'evidence directory must be explicit and absolute')
  await mkdir(evidenceOutput, { recursive: true, mode: 0o700 })
  await writeFile(join(evidenceOutput, `material-workflow-${report.runId}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

test('审核资料到网页交付：真实读写/浏览器/服务器回读，无模型调用', { timeout: 90_000 }, async t => {
  const output = await realpath(await mkdtemp(join(tmpdir(), 'xs-material-report-')))
  t.after(async () => { await rm(output, { recursive: true, force: true }) })
  const source = await captureCandidate(root)
  const env = { ...process.env, XIAOSHE_MATERIAL_WORKFLOW_OUTPUT: output,
    XIAOSHE_MATERIAL_WORKFLOW_SOURCE_SHA: source.sha256, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  delete env.ELECTRON_RUN_AS_NODE
  let report, failure
  try {
    const child = await runOwned(electron, [join(root, 'apps/desktop-shell/test/run-material-workflow.mjs')], { env })
    report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))
    assert.equal(child.timedOut, false, child.log)
    assert.equal(child.code, 0, child.log)
    assert.equal(report.schema, 'xiaoshe-task-run/v1')
    assert.equal(report.executionKind, 'component_fixture')
    assert.equal(report.paidModelRequests, 0)
    assert.equal(report.authenticatedExternalSiteTested, false)
    assert.equal(report.binding.sourceSha256, source.sha256)
    assert.equal((await captureCandidate(root)).sha256, source.sha256, 'source must remain stable throughout the workflow run')
    assert.equal(report.tasks.length, 1)
    assert.equal(report.tasks[0].taskId, 'material-browser-delivery')
    assert.equal(report.tasks[0].state, 'partial', 'child cannot certify cleanup of its own live profile')
    assert.deepEqual(report.tasks[0].checks.map(row => row.id), requiredChecks)
    assert.ok(report.tasks[0].checks.every(row => row.state === 'pass'))
    assert.deepEqual(report.cleanup.map(row => [row.id, row.state]), [
      ['private-channel-closed', 'pass'], ['browser-closed', 'pass'], ['server-closed', 'pass'],
      ['owned-fixture-cleanup', 'pass'], ['parent-owned-profile-cleanup', 'pending_external'],
    ])
    assert.deepEqual(report.extraChecks, [{ id: 'ledger-reload-and-revert', state: 'pass' }])
    report.parentValidation = 'passed'
  } catch (error) { failure = error; if (report) markParentFailure(report) }
  if (report) {
    const cleaned = await finishProfileCleanup(report, output)
    try { assert.equal((await captureCandidate(root)).sha256, source.sha256, 'source must remain stable through parent cleanup') }
    catch (error) { failure ??= error; markParentFailure(report) }
    report.finishedAt = new Date().toISOString()
    report.tasks[0].metrics.durationMs = Date.parse(report.finishedAt) - Date.parse(report.createdAt)
    await publishReport(report, process.env.XIAOSHE_MATERIAL_WORKFLOW_EVIDENCE_DIR)
    if (!cleaned && !failure) failure = new Error('owned profile cleanup failed; no green evidence was published')
  }
  if (failure) throw failure
  assert.equal(report.tasks[0].state, 'pass')
})

test('父进程清理失败保留失败报告，不能发布提前通过证据', async t => {
  const output = await mkdtemp(join(tmpdir(), 'xs-material-cleanup-'))
  const evidenceOutput = await mkdtemp(join(tmpdir(), 'xs-material-retained-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  t.after(() => rm(evidenceOutput, { recursive: true, force: true }))
  const report = { runId: 'synthetic-cleanup-failure', parentValidation: 'passed',
    tasks: [{ taskId: 'material-browser-delivery', state: 'partial' }],
    cleanup: [{ id: 'parent-owned-profile-cleanup', state: 'pending_external' }] }
  assert.equal(await finishProfileCleanup(report, output, async () => { throw new Error('synthetic storage failure') }), false)
  await publishReport(report, evidenceOutput)
  const retained = JSON.parse(await readFile(join(evidenceOutput, 'material-workflow-synthetic-cleanup-failure.json'), 'utf8'))
  assert.equal(retained.tasks[0].state, 'fail')
  assert.deepEqual(retained.cleanup, [{ id: 'parent-owned-profile-cleanup', state: 'fail' }])
})

test('父进程成功完成目录清理后才发布最终通过证据', async t => {
  const output = await mkdtemp(join(tmpdir(), 'xs-material-cleanup-pass-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const report = { parentValidation: 'passed', tasks: [{ state: 'partial' }], cleanup: [
    { id: 'parent-owned-profile-cleanup', state: 'pending_external' }] }
  assert.equal(await finishProfileCleanup(report, output), true)
  assert.equal(report.tasks[0].state, 'pass')
  assert.equal(report.cleanup[0].state, 'pass')
  await assert.rejects(lstat(output), error => error.code === 'ENOENT')
})

const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const pendingTreeCleanup = new Map()
async function removeTreeEvidence(output) {
  if (pendingTreeCleanup.get(output)?.size) throw new Error('owned tree cleanup failed; PID evidence directory retained')
  await rm(output, { recursive: true, force: true })
  pendingTreeCleanup.delete(output)
}
async function ownedTreeScenario(output, { timeout, timeoutMs = 2_000, signalProcess, expectedFailureCode } = {}) {
  const pidPath = join(output, `descendant-${randomUUID()}.json`)
  const pending = pendingTreeCleanup.get(output) ?? new Set()
  pendingTreeCleanup.set(output, pending); pending.add(pidPath)
  let ownedPid
  const grandchild = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`
  // No inherited pipes: normal parent exit must still reclaim the detached
  // group's live descendant rather than depending on stdio keeping it open.
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});const timer=setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(pidPath)})&&${!timeout}){clearInterval(timer);process.exit(0)}},20)`
  try {
    const running = runOwned(process.execPath, ['-e', parent], {
      timeoutMs, signalProcess, onSpawn(pid) { ownedPid = pid },
    })
    if (expectedFailureCode) {
      await assert.rejects(running, error => error.code === expectedFailureCode && error.cause?.code === expectedFailureCode)
      return
    }
    const result = await running
    const { pid } = JSON.parse(await readFile(pidPath, 'utf8'))
    assert.equal(result.timedOut, timeout)
    if (!timeout) assert.equal(result.code, 0)
    if (process.platform !== 'win32') {
      assert.equal(result.cleanup.processGroupGone, true)
      assert.equal(alive(-ownedPid), false, 'helper returned before owned process group disappeared')
    }
    assert.equal(alive(pid), false, 'owned descendant survived test tree cleanup')
    return result
  } finally {
    // This runs even when runOwned rejects. Read this scenario's PID evidence
    // and recover only its known group before the outer hook deletes the files.
    let descendant
    try { descendant = JSON.parse(await readFile(pidPath, 'utf8')).pid } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (descendant !== undefined) assert.ok(Number.isSafeInteger(descendant) && descendant > 1)
    const target = process.platform === 'win32' ? descendant : Number.isSafeInteger(ownedPid) && ownedPid > 1 ? -ownedPid : undefined
    if (target !== undefined && alive(target)) {
      try { process.kill(target, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const deadline = Date.now() + 5_000
    while (((target !== undefined && alive(target)) || (descendant !== undefined && alive(descendant))) && Date.now() < deadline) await sleep(25)
    if (target !== undefined) assert.equal(alive(target), false, 'test compensation did not reclaim its owned tree')
    if (descendant !== undefined) assert.equal(alive(descendant), false, 'test compensation did not reclaim its owned descendant')
    pending.delete(pidPath)
  }
}

test('超时和正常退出均回收本测试自有子进程树', { timeout: 20_000 }, async t => {
  const output = await mkdtemp(join(tmpdir(), 'xs-material-tree-'))
  t.after(() => removeTreeEvidence(output))
  for (const timeout of [true, false]) await ownedTreeScenario(output, { timeout })
})

test('超时和正常退出：短超时并发重复仍须证明整个进程组消失', { timeout: 10_000 }, async t => {
  const output = await mkdtemp(join(tmpdir(), 'xs-material-tree-repeat-'))
  t.after(() => removeTreeEvidence(output))
  for (let repeat = 0; repeat < 3; repeat++) {
    const results = await Promise.allSettled([true, false].map(timeout => ownedTreeScenario(output, { timeout, timeoutMs: 500 })))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
})

test('超时和正常退出：信号报错须保留code，仅在独立证明组已消失时可成功',
  { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
    const output = await mkdtemp(join(tmpdir(), 'xs-material-signal-error-'))
    t.after(() => removeTreeEvidence(output))
    const signalProcess = (pid, signal) => {
      process.kill(pid, signal)
      if (signal === 'SIGKILL') throw Object.assign(new Error('injected post-signal diagnostic'), { code: 'EIO' })
    }
    const result = await ownedTreeScenario(output, { timeout: true, timeoutMs: 500, signalProcess })
    assert.ok(result.cleanup.signalErrors.some(error => error.code === 'EIO'))
  })

test('超时和正常退出：信号失败且子树仍活着必须失败，并在finally实际回收',
  { skip: process.platform === 'win32', timeout: 12_000 }, async t => {
    const output = await mkdtemp(join(tmpdir(), 'xs-material-live-tree-error-'))
    t.after(() => removeTreeEvidence(output))
    const signalProcess = (pid, signal) => {
      if (signal === 'SIGKILL') throw Object.assign(new Error('injected signal denial'), { code: 'EPERM' })
      return process.kill(pid, signal)
    }
    await ownedTreeScenario(output, { timeout: false, signalProcess, expectedFailureCode: 'EPERM' })
  })
