import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePhaseReport, runOwnedProcess } from './product-lifecycle.mjs'

const runId = '0310fd7e-1234-4234-8234-a01234567890'
const identity = 'a'.repeat(64)
const frontendIdentity = 'b'.repeat(64)
const phaseStart = Date.parse('2026-09-07T05:00:00.000Z')
const iso = offset => new Date(phaseStart + offset).toISOString()
const observed = (report, name) => report.checks.find(row => row.name === name).observed

test('native supervisor bounds a TERM-ignoring process and independently proves its exit', { timeout: 10_000 }, async () => {
  let pid
  const result = await runOwnedProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
    { timeoutMs: 200, env: process.env, onSpawn: value => { pid = value } })
  assert.equal(result.timedOut, true)
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
})

// The fixture mirrors runLifecycleAcceptance's fact shape, not an Electron run.
function phaseFixture(phase = 'seed') {
  const servicePid = phase === 'seed' ? 30101 : 30102
  const mounts = phase === 'seed'
    ? [{ file: 'mounted-seed.json', runId, pid: servicePid, at: iso(100) }]
    : [{ file: 'mounted-seed.json', runId, pid: 30101, at: iso(-5000) },
      { file: 'mounted-restore.json', runId, pid: servicePid, at: iso(100) }]
  const guard = () => ({ runId, runMatches: true, mode: 'no_model', attemptedRequests: 0, reservedRequests: 0,
    mountCount: mounts.length, mounts: structuredClone(mounts), phaseMountCountMatches: true,
    latestMountInPhase: true, latestMountPid: servicePid })
  const facts = {
    'loaded-product-version': { product: '小蛇', apiVersion: 1, bridgeState: 'ready', backendIdentity: identity,
      candidateIdentity: identity, expectedRootProfileIdentity: identity, loadedFrontendIdentity: frontendIdentity,
      frontendBuildIdentity: frontendIdentity, aboutStatus: 'current', diagnosticStatus: 'current', identityMatches: true,
      frontendMatches: true, aboutRendered: true, shellPresent: true, loadedOriginMatches: true, aboutHttpStatus: 200 },
    'session-persistence': { matchingTitleEvents: 1, modelOrTurnEvents: 0 },
    'memory-persistence': { matchingEntries: 1, revision: 1, revisionMatches: true, persistenceStatus: 'ready', markerDigest: 'c'.repeat(64) },
    'browser-storage-persistence': { origin: 'http://127.0.0.1:41001', localStorageMatches: true, cookieMatches: true,
      nativeCookieMatches: true, rendererPid: 30301, restoredWithoutWriting: phase === 'restore' },
    'browser-storage-flush': { cookieFlushCompleted: true, storageFlushCompleted: true },
    'no-active-model-work': { runningSessions: 0 },
    'no-model-guard-before': guard(), 'no-model-guard-after': guard(),
    ...(phase === 'seed' ? {
      'session-create-rename': { createdIdMatches: true, renamedTitleMatches: true, renameSequence: 1 },
      'memory-created': { matchingEntries: 1, revisionIncreased: true, entryIdPresent: true },
      'browser-storage-initially-empty': { origin: 'http://127.0.0.1:41001', ready: 'complete', localStoragePresent: false, cookiePresent: false },
    } : {}),
  }
  return { report: { schema: 'xiaoshe-lifecycle-acceptance/v1', runId, phase, pid: 30001, accepted: true,
    scope: 'real-main-isolated-no-model', shutdown: 'pending-parent-observation', startedAt: iso(50), finishedAt: iso(900),
    checks: Object.entries(facts).map(([name, observed]) => ({ name, passed: true, observed })) },
  expected: { runId, phase, pid: 30001, runtimeIdentity: identity, startedAt: phaseStart, finishedAt: phaseStart + 1000, servicePid } }
}

test('complete independently bound seed and restore fact sets are accepted', () => {
  for (const phase of ['seed', 'restore']) {
    const { report, expected } = phaseFixture(phase)
    const facts = validatePhaseReport(report, expected)
    assert.equal(facts['loaded-product-version'].backendIdentity, identity)
    assert.equal(facts['browser-storage-persistence'].restoredWithoutWriting, phase === 'restore')
  }
})

test('empty, failed, partial, duplicate, unknown and missing check reports are rejected', () => {
  for (const input of [null, {}, [], '', { accepted: true }]) {
    assert.throws(() => validatePhaseReport(input, phaseFixture().expected), /native phase evidence/u)
  }
  const mutations = [
    report => { report.accepted = false; report.failure = { stage: 'memory-persistence', code: 'LIFECYCLE_ACCEPTANCE_FAILED' } },
    report => { report.failure = { stage: 'memory-persistence', code: 'LIFECYCLE_ACCEPTANCE_FAILED' } },
    report => { report.failure = null },
    report => { report.checks[0].passed = false },
    report => { report.checks[0].passed = 'true' },
    report => { report.checks[0].observed = null },
    report => { report.checks = [] },
    report => { report.checks.pop() },
    report => { report.checks.push(structuredClone(report.checks[0])) },
    report => { report.checks[1] = structuredClone(report.checks[0]) },
    report => { report.checks[0].name = 'some-other-check' },
  ]
  for (const mutate of mutations) {
    const { report, expected } = phaseFixture(); mutate(report)
    assert.throws(() => validatePhaseReport(report, expected), /native phase evidence/u)
  }
})

test('run, phase, PID, runtime/frontend identity and time window must match independent parent observations', () => {
  const cases = [
    ['run', report => { report.runId = 'another-run' }],
    ['phase', report => { report.phase = 'restore' }],
    ['PID', report => { report.pid++ }],
    ['scope', report => { report.scope = 'mock-main' }],
    ['shutdown', report => { report.shutdown = 'complete' }],
    ['backend', report => { observed(report, 'loaded-product-version').backendIdentity = 'd'.repeat(64) }],
    ['candidate', report => { observed(report, 'loaded-product-version').candidateIdentity = 'd'.repeat(64) }],
    ['root/Profile', report => { observed(report, 'loaded-product-version').expectedRootProfileIdentity = 'd'.repeat(64) }],
    ['loaded frontend', report => { observed(report, 'loaded-product-version').loadedFrontendIdentity = 'd'.repeat(64) }],
    ['malformed frontend hash', report => { const fact = observed(report, 'loaded-product-version'); fact.loadedFrontendIdentity = fact.frontendBuildIdentity = 'not-a-digest' }],
    ['time before parent', report => { report.startedAt = iso(-1) }],
    ['time after parent', report => { report.finishedAt = iso(1001) }],
    ['backwards time', report => { report.finishedAt = iso(20) }],
    ['invalid time', report => { report.startedAt = 'invalid' }],
  ]
  for (const [label, mutate] of cases) {
    const { report, expected } = phaseFixture(); mutate(report)
    assert.throws(() => validatePhaseReport(report, expected), /native phase evidence/u, label)
  }
})

test('failed persistence, rendering, flushing or model-work facts cannot borrow passed:true', () => {
  const cases = [
    ['session-persistence', 'matchingTitleEvents', 2], ['session-persistence', 'modelOrTurnEvents', 1],
    ['memory-persistence', 'matchingEntries', 0], ['memory-persistence', 'revisionMatches', false],
    ['memory-persistence', 'persistenceStatus', 'failed'], ['memory-persistence', 'markerDigest', 'invalid'],
    ['browser-storage-persistence', 'localStorageMatches', false], ['browser-storage-persistence', 'cookieMatches', false],
    ['browser-storage-persistence', 'nativeCookieMatches', false], ['browser-storage-persistence', 'rendererPid', 0],
    ['browser-storage-persistence', 'restoredWithoutWriting', true],
    ['browser-storage-flush', 'cookieFlushCompleted', false], ['browser-storage-flush', 'storageFlushCompleted', false],
    ['no-active-model-work', 'runningSessions', 1], ['loaded-product-version', 'aboutRendered', false],
    ['loaded-product-version', 'aboutHttpStatus', 503], ['loaded-product-version', 'loadedOriginMatches', false],
  ]
  for (const [name, key, value] of cases) {
    const { report, expected } = phaseFixture(); observed(report, name)[key] = value
    assert.throws(() => validatePhaseReport(report, expected), /native phase evidence/u, `${name}.${key}`)
  }
})

test('seed creation and initially-empty storage facts are checked independently of their passed flags', () => {
  const cases = [
    ['session-create-rename', 'createdIdMatches', false], ['session-create-rename', 'renamedTitleMatches', false],
    ['session-create-rename', 'renameSequence', undefined], ['session-create-rename', 'renameSequence', 1.5],
    ['memory-created', 'matchingEntries', 0], ['memory-created', 'matchingEntries', 2],
    ['memory-created', 'revisionIncreased', false], ['memory-created', 'entryIdPresent', false],
    ['browser-storage-initially-empty', 'localStoragePresent', true], ['browser-storage-initially-empty', 'cookiePresent', true],
    ['browser-storage-initially-empty', 'localStoragePresent', undefined], ['browser-storage-initially-empty', 'cookiePresent', undefined],
  ]
  for (const [name, key, value] of cases) {
    const { report, expected } = phaseFixture(); observed(report, name)[key] = value
    assert.throws(() => validatePhaseReport(report, expected), /native phase evidence/u, `${name}.${key}`)
  }
  for (const name of ['session-create-rename', 'memory-created', 'browser-storage-initially-empty']) {
    const { report, expected } = phaseFixture()
    report.checks.find(row => row.name === name).observed = {}
    assert.throws(() => validatePhaseReport(report, expected), /native phase evidence/u, `${name}: empty facts`)
  }
})

test('neither guard observation can reuse a seed mount as proof of a newly started restore service', () => {
  for (const name of ['no-model-guard-before', 'no-model-guard-after']) {
    const mutations = [
      guard => { guard.runId = 'another-run' }, guard => { guard.mode = 'bounded_model' },
      guard => { guard.attemptedRequests = 1 }, guard => { guard.reservedRequests = 1 },
      guard => { guard.mountCount = 1 }, guard => { guard.mounts = [] },
      guard => { guard.mounts = [guard.mounts[0]] }, // stale seed record, even with claimed mountCount:2
      guard => { guard.mounts = [guard.mounts[1]] }, // real current mount alone cannot substantiate claimed count:2
      guard => { guard.mounts.push(structuredClone(guard.mounts[0])) }, // exactly one current mount, inconsistent total
      guard => { guard.mounts[1].pid = guard.mounts[0].pid },
      guard => { guard.mounts[1].runId = 'another-run' },
      guard => { guard.mounts[1].at = iso(-1) }, guard => { guard.mounts[1].at = iso(1001) },
      guard => { guard.mounts[1].at = 'invalid' }, guard => { guard.mounts.push(structuredClone(guard.mounts[1])) },
    ]
    for (const mutate of mutations) {
      const { report, expected } = phaseFixture('restore'); mutate(observed(report, name))
      assert.throws(() => validatePhaseReport(report, expected), /native phase evidence/u, name)
    }
  }
})

test('owned group is cleaned after its parent exits while a TERM-ignoring child keeps running with closed stdio',
  { skip: process.platform === 'win32', timeout: 12000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'xs-owned-process-test-'))
    let ownedPid
    t.after(async () => {
      // Compensation targets only the exact group spawned by this test.
      if (Number.isSafeInteger(ownedPid) && ownedPid > 1) {
        try { process.kill(-ownedPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      await rm(root, { recursive: true, force: true })
    })
    const marker = join(root, 'child-ready.json')
    const grandchildCode = `process.on('SIGTERM',()=>{}); process.send({pid:process.pid,termHandlerInstalled:process.listenerCount('SIGTERM')===1}); process.disconnect(); setInterval(()=>{},1000)`
    const parentCode = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs');
      const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',message=>{writeFileSync(${JSON.stringify(marker)},JSON.stringify({...message,parentPid:process.pid,stdioClosed:true}));child.unref();process.exit(0)});`
    const result = await runOwnedProcess(process.execPath, ['-e', parentCode], {
      cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 3000, onSpawn(pid) { ownedPid = pid },
    })
    const child = JSON.parse(await readFile(marker, 'utf8'))
    assert.equal(result.code, 0)
    assert.equal(result.timedOut, false)
    assert.equal(result.pid, child.parentPid)
    assert.equal(child.termHandlerInstalled, true)
    assert.equal(child.stdioClosed, true)
    assert.notEqual(child.pid, result.pid)
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
    assert.throws(() => process.kill(-result.pid, 0), { code: 'ESRCH' })
  })

test('spawn ENOENT rejects promptly instead of waiting for close or the deadline', { timeout: 3000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xs-owned-enoent-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let spawnedPid = 'not-called'
  await assert.rejects(runOwnedProcess(join(root, 'definitely-not-an-executable'), [], {
    cwd: root, env: { PATH: process.env.PATH }, timeoutMs: 10000, onSpawn(pid) { spawnedPid = pid },
  }), { code: 'ENOENT' })
  assert.equal(spawnedPid, undefined)
})
