import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import test from 'node:test'
import { promisify } from 'node:util'
import { captureCandidate, runGate, validateLiveEvidence, verifyLiveRuntime } from './internal-beta.mjs'
import { productRuntimeIdentity } from '../product-runtime-identity.mjs'

const exec = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-quality-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await exec('git', ['init', '--quiet', root], { windowsHide: true })
  await writeFile(join(root, '.gitignore'), 'output/\n')
  await writeFile(join(root, 'source.txt'), 'initial')
  return root
}
function stage(id, code, timeoutMs = 5_000) {
  return { id, command: process.execPath, args: ['-e', code], timeoutMs }
}
async function gate(root, stages, required = stages.map(item => item.id)) {
  return runGate({ root, stages, required, reportPath: join(root, 'output/report.json') })
}

test('content identity includes dirty, untracked, removed inputs, but ignores report output', async t => {
  const root = await fixture(t)
  const initial = await captureCandidate(root)
  await mkdir(join(root, 'output'))
  await writeFile(join(root, 'output/report.json'), 'not source')
  assert.equal((await captureCandidate(root)).sha256, initial.sha256)
  await writeFile(join(root, 'source.txt'), 'changed')
  assert.notEqual((await captureCandidate(root)).sha256, initial.sha256)
  await exec('git', ['add', 'source.txt'], { cwd: root, windowsHide: true })
  const added = await captureCandidate(root)
  await rm(join(root, 'source.txt'))
  assert.notEqual((await captureCandidate(root)).sha256, added.sha256)
})

test('successful real child execution persists an explicitly limited deterministic pass', async t => {
  const root = await fixture(t)
  const report = await gate(root, [stage('unit', 'process.stdout.write("fixture secret text")')])
  assert.equal(report.deterministic, 'passed')
  assert.equal(report.live, 'not_run')
  assert.equal(report.status, 'partial')
  assert.equal(report.releaseApproval, false)
  assert.equal(report.stages[0].status, 'passed')
  assert.ok(report.stages[0].durationMs >= 0)
  assert.equal(report.stages[0].stdoutBytes, 19)
  assert.equal(report.stages[0].invocation.command, process.execPath)
  assert.equal(report.stages[0].invocation.cwd, '.')
  assert.match(report.stages[0].invocation.args[1], /^\[inline sha256:/)
  assert.doesNotMatch(await readFile(join(root, 'output/report.json'), 'utf8'), /fixture secret text/)
})

test('nonzero, missing and duplicate stages cannot produce a pass', async t => {
  const root = await fixture(t)
  const failed = await gate(root, [stage('unit', 'process.exit(7)')])
  assert.equal(failed.status, 'failed')
  assert.equal(failed.stages[0].exitCode, 7)
  const missing = await gate(root, [stage('unit', '')], ['unit', 'integration'])
  assert.equal(missing.status, 'failed')
  assert.deepEqual(missing.missingStages, ['integration'])
  await assert.rejects(gate(root, [stage('same', ''), stage('same', '')]), /duplicate/i)
  await assert.rejects(gate(root, [], []), /empty/i)
})

test('a noncooperative child is timed out, and following stages are not falsely marked passed', async t => {
  const root = await fixture(t)
  const report = await gate(root, [stage('hang', 'setInterval(() => {}, 1000)', 250), stage('later', '')])
  assert.equal(report.status, 'failed')
  assert.equal(report.stages[0].status, 'timed_out')
  assert.equal(report.stages[1].status, 'not_run')
  assert.ok(report.stages[0].durationMs < 10_000)
})

test('exiting parent cannot leave a grandchild holding the stage pipes alive', async t => {
  const root = await fixture(t)
  const pidPath = join(root, 'output/grandchild.pid')
  await mkdir(join(root, 'output'))
  let descendantPid
  t.after(() => { if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch {} } })
  const childCode = `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`
  const parentCode = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'inherit',windowsHide:true,detached:${process.platform === 'win32'}}); setTimeout(() => process.exit(0), 400)`
  await gate(root, [stage('orphan', parentCode, 2000)])
  descendantPid = Number(await readFile(pidPath, 'utf8'))
  let alive = true
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(descendantPid, 0) } catch { alive = false; break }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  try { assert.equal(alive, false, 'a stage descendant survived stage cleanup') }
  finally {
    // Clean the RED fixture before root removal: on Windows its working
    // directory is held open until this deliberately leaked process dies.
    if (alive) { try { process.kill(descendantPid, 'SIGKILL') } catch {} }
    descendantPid = null
  }
})

test('normal successful exit reaps an unreferenced background descendant with closed pipes', async t => {
  const root = await fixture(t)
  const pidPath = join(root, 'output/background.pid')
  await mkdir(join(root, 'output'))
  const childCode = `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`
  const parentCode = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'ignore',windowsHide:true}).unref(); setTimeout(() => process.exit(0), 500)`
  let descendantPid
  try {
    const report = await gate(root, [stage('background', parentCode)])
    descendantPid = Number(await readFile(pidPath, 'utf8'))
    assert.equal(report.stages[0].status, 'passed')
    let alive = true
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(descendantPid, 0) } catch { alive = false; break }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(alive, false, 'normal exit must clean the owned group, not only timeouts')
  } finally {
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch {} }
  }
})

test('source mutation during a passing test invalidates the candidate', async t => {
  const root = await fixture(t)
  const report = await gate(root, [stage('mutate', 'require("fs").writeFileSync("source.txt", "changed during tests")')])
  assert.equal(report.stages[0].status, 'passed')
  assert.equal(report.sourceStable, false)
  assert.equal(report.status, 'failed')
})

test('live evidence requires the entire fixed scenario set and all checks and cleanup', () => {
  const evidence = {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    scenarios: ['code-repair', 'conflict-research', 'offline-to-online-topic-switch', 'failure-recovery', 'user-steer']
      .map(id => ({ id, state: 'pass', checks: [{ id: 'real-check', state: 'pass' }] })),
    cleanup: [{ id: 'owned-cleanup', state: 'pass' }],
  }
  assert.equal(validateLiveEvidence(evidence), true)
  assert.equal(validateLiveEvidence({ ...evidence, scenarios: evidence.scenarios.slice(1) }), false)
  assert.equal(validateLiveEvidence({ ...evidence, scenarios: [...evidence.scenarios, evidence.scenarios[0]] }), false)
  assert.equal(validateLiveEvidence({ ...evidence, cleanup: [] }), false)
  assert.equal(validateLiveEvidence({ ...evidence, scenarios: evidence.scenarios.map(item => ({ ...item, checks: [] })) }), false)
  assert.equal(validateLiveEvidence({ ...evidence, cleanup: [{ state: 'fail' }] }), false)
  const expected = { nonce: 'new-stage', runtimeIdentity: 'new-runtime', sourceSha256: 'new-source', startedAt: Date.now() - 1000, finishedAt: Date.now() + 1000 }
  assert.equal(validateLiveEvidence({ ...evidence, acceptanceBinding: expected }, expected), true)
  assert.equal(validateLiveEvidence({ ...evidence, acceptanceBinding: { ...expected, nonce: 'old-stage' } }, expected), false)
  assert.equal(validateLiveEvidence({ ...evidence, createdAt: '2000-01-01', acceptanceBinding: expected }, expected), false)
  assert.equal(validateLiveEvidence({ ...evidence, schemaVersion: 0 }, expected), false)
  assert.equal(validateLiveEvidence({ ...evidence, scenarios: [null, null, null, null, null] }), false)
  assert.equal(validateLiveEvidence({ ...evidence, scenarios: evidence.scenarios.map(item => ({ ...item, checks: [null] })) }), false)
  assert.equal(validateLiveEvidence({ ...evidence, cleanup: [null] }), false)
})

async function liveFixture(t) {
  const root = await fixture(t)
  const dshRoot = join(root, 'runtime/DSH')
  const profileRoot = join(root, 'output/profile')
  await mkdir(dshRoot, { recursive: true })
  await mkdir(profileRoot, { recursive: true })
  await writeFile(join(root, 'package.json'), '{}')
  await writeFile(join(profileRoot, 'package.json'), '{"dependencies":{}}')
  const identity = await productRuntimeIdentity({ root, dshRoot, profileRoot })
  let status = { product: '小蛇', bridge: { state: 'ready' }, runtime_identity: identity }
  const server = createServer((request, response) => {
    assert.equal(request.url, '/xiaoshe/desktop/status')
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(status))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return { root, profileRoot, identity, base: `http://127.0.0.1:${server.address().port}`, setStatus: value => { status = value } }
}

test('live runtime preflight binds current payload and Profile to startup identity, not just service availability', async t => {
  const fixture = await liveFixture(t)
  assert.equal(await verifyLiveRuntime(fixture.root, fixture.profileRoot, fixture.base), fixture.identity)
  fixture.setStatus({ product: '小蛇', bridge: { state: 'ready' }, runtime_identity: '0'.repeat(64) })
  await assert.rejects(verifyLiveRuntime(fixture.root, fixture.profileRoot, fixture.base), /does not match/)
})

test('zero-exit live child with incomplete evidence is still failed; reused evidence is never accepted', async t => {
  const fixture = await liveFixture(t)
  const evidencePath = join(fixture.root, 'output/live.json')
  const live = { ...stage('live-one', `require('fs').writeFileSync(${JSON.stringify(evidencePath)}, '{"scenarios":[],"cleanup":[]}')`),
    kind: 'live', evidencePath, profileRoot: fixture.profileRoot, base: fixture.base }
  const first = await gate(fixture.root, [stage('unit', ''), live])
  assert.equal(first.stages[1].exitCode, 0)
  assert.equal(first.stages[1].evidenceComplete, false)
  assert.equal(first.status, 'failed')
  const second = await gate(fixture.root, [stage('unit', ''), live])
  assert.equal(second.livePreflightError, true)
  assert.equal(second.stages[1].status, 'not_run')
  assert.equal(second.status, 'failed')
})
