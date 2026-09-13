import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { assertMaterialBackendPortReleased, finishMaterialEvidence, materialProfilePatch, readFinalMaterialServerEvidence, removeOwnedMaterialRoot, runMaterialLive } from './material-live.mjs'

const exec = promisify(execFile)
const productRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/u, '')
async function ownDirectory(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'xs-material-live-test-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
test('material Profile carries only references and mounts one fixed route with execution fencing', () => {
  const patch = materialProfilePatch({ productRoot: '/owned/product', acceptanceRoot: '/owned/fixture', runId: 'fixture-id', sessionId: 'owned-session', fixtureUrl: 'http://127.0.0.1:41234/fixture/', scenario: 'normal' })
  for (const id of ['credentials', 'llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'session-title-llm', 'session-telemetry-otel']) assert.deepEqual(patch.find(row => row.id === id), { id, disabled: true })
  const insertion = patch.find(row => row.insert).insert
  assert.equal(insertion.length, 2)
  assert(insertion[0].name.endsWith('/scripts/acceptance/live-material-policy.mjs'))
  assert.deepEqual(insertion[0].config.sessionIds, ['owned-session'])
  assert.equal(insertion[0].config.fixtureUrl, 'http://127.0.0.1:41234/fixture/')
  assert.equal(insertion[0].config.scenario, 'normal')
  assert.deepEqual(insertion[1].config, { acceptanceRoot: '/owned/fixture', runId: 'fixture-id', sessionId: 'owned-session' })
  assert.equal(patch.find(row => row.id === 'tools').config.mode, 'native')
  assert.equal(patch.find(row => row.id === 'agent-presets').config.includeUserRoot, false)
  assert(!JSON.stringify(patch).includes('apiKey'))
})

test('material Profile explicitly projects all four scenarios and never defaults missing or malformed values', () => {
  const base = { productRoot: '/product', acceptanceRoot: '/isolated', runId: 'fixture', sessionId: 'xiaoshe-material-fixture', fixtureUrl: 'http://127.0.0.1:41234/fixture/' }
  for (const scenario of ['normal', 'missing_input', 'response_lost', 'takeover']) {
    assert.equal(materialProfilePatch({ ...base, scenario }).find(row => row.insert).insert[0].config.scenario, scenario)
  }
  for (const options of [base, { ...base, scenario: undefined }, { ...base, scenario: null }, { ...base, scenario: 'other' },
    Object.assign(Object.create({ scenario: 'normal' }), base)]) assert.throws(() => materialProfilePatch(options), /explicit scenario/)
  let reads = 0
  assert.throws(() => materialProfilePatch({ ...base, get scenario() { reads++; return 'normal' } }), /explicit scenario/)
  assert.equal(reads, 0)
})

test('unsupported scenario fails before creating resources; CLI requires explicit live authorization', async () => {
  await assert.rejects(runMaterialLive({ scenario: 'unsupported' }), /explicit supported/u)
  for (const args of [[], ['--scenario', 'normal'], ['--live-authorized'], ['--live-authorized', '--scenario', 'unsupported']]) {
    await assert.rejects(exec(process.execPath, ['scripts/acceptance/material-live.mjs', ...args], { timeout: 10_000 }), error => {
      assert.equal(error.code, 1)
      assert(error.stderr.includes('requires --live-authorized --scenario'))
      assert(!error.stdout.includes('"stage":"setup"'))
      return true
    })
  }
})

test('isolated launchd service environment preserves the validated temporary root in a real clean child', { skip: process.platform !== 'darwin' }, async t => {
  const runId = randomUUID(), temporaryRoot = await realpath(tmpdir())
  const acceptanceRoot = join(temporaryRoot, `xiaoshe-product-acceptance-${runId}`)
  await mkdir(acceptanceRoot, { mode: 0o700 })
  t.after(() => rm(acceptanceRoot, { recursive: true, force: true }))
  for (const name of ['dsh-home/profiles/web', 'state', 'logs', 'workspace', 'xiaoshe-windows-acceptance-user-data']) await mkdir(join(acceptanceRoot, name), { recursive: true, mode: 0o700 })
  const script = await readFile(new URL('../start-xiaoshe-web.sh', import.meta.url), 'utf8')
  const validation = script.match(/if \[ -n "\$\{XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED:-\}" \]; then[\s\S]*?\nfi/u)?.[0]
  assert(validation)
  const start = script.indexOf('\nSERVICE_ENV=(') + 1, end = script.indexOf('\nOWNED_LAUNCH_ACTIVE=1', start)
  assert(start > 0 && end > start)
  // Execute the actual validation and SERVICE_ENV assembly, never the service
  // launcher. env -i models the missing caller environment at the launchd seam.
  const command = `${validation}\n${script.slice(start, end)}\nexec /usr/bin/env -i "\${SERVICE_ENV[@]}" "$NODE" --input-type=module -e "$1" "$2" "$3"`
  const probe = `import {tmpdir} from 'node:os'; import {realpathSync} from 'node:fs'; import {pathToFileURL} from 'node:url'; const {nativeOfficialConfig}=await import(pathToFileURL(process.argv[1]).href); const budget=nativeOfficialConfig(JSON.parse(process.argv[2])); process.stdout.write(JSON.stringify({temporaryRoot:realpathSync(tmpdir()),runId:budget.runId}));`
  const env = {
    PATH: process.env.PATH, HOME: acceptanceRoot, TMPDIR: temporaryRoot,
    NODE: process.execPath, PLUGIN_ROOT: productRoot, DSH_ROOT: join(productRoot, 'runtime/DSH'),
    PROFILE_ROOT: join(acceptanceRoot, 'dsh-home/profiles/web'), LEGACY_ROOT: join(productRoot, 'runtime/xiaoshe-legacy'),
    HOST: '127.0.0.1', PORT: '41234', LAUNCH_TOKEN: randomUUID(), XIAOSHE_RUNTIME_IDENTITY: 'a'.repeat(64),
    DSH_HOME: join(acceptanceRoot, 'dsh-home'),
    XIAOSHE_DESKTOP_ACCEPTANCE: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED: '1', XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: acceptanceRoot,
    XIAOSHE_STATE_ROOT: join(acceptanceRoot, 'state'), XIAOSHE_DSH_LOG_DIR: join(acceptanceRoot, 'logs'),
    XIAOSHE_ACCEPTANCE_WORKSPACE: join(acceptanceRoot, 'workspace'),
    XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(acceptanceRoot, 'xiaoshe-windows-acceptance-user-data'),
    XIAOSHE_DSH_SERVICE_LABEL: `com.xiaoshe.acceptance.${runId}`, XIAOSHE_DSH_PORT: '41234',
  }
  const result = await exec('/bin/bash', ['-c', command, 'isolated-service-environment', probe,
    join(productRoot, 'scripts/acceptance/live-native-official.mjs'), JSON.stringify({ acceptanceRoot, runId, sessionId: `xiaoshe-material-${runId}` })], { env, timeout: 10_000 })
  assert.deepEqual(JSON.parse(result.stdout), { temporaryRoot, runId })
  await assert.rejects(exec('/bin/bash', ['-c', command, 'invalid-isolation', probe, '', '{}'], {
    env: { ...env, XIAOSHE_DESKTOP_ACCEPTANCE_ROOT: productRoot }, timeout: 10_000,
  }))
})

test('a real occupied backend port retains the owned root and never signals its listener', async t => {
  const acceptanceRoot = await ownDirectory(t), ownedStat = await lstat(acceptanceRoot)
  await writeFile(join(acceptanceRoot, 'evidence.json'), '{}')
  const server = createServer()
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  t.after(() => new Promise(done => { if (!server.listening) done(); else server.close(done) }))
  const port = server.address().port
  await assert.rejects(assertMaterialBackendPortReleased(port), /still occupied/u)
  assert.equal(server.listening, true)
  const cleanup = [{ id: 'owned-service-released', state: 'pass' }, { id: 'owned-main-group-released', state: 'pass' }, { id: 'owned-backend-port-released', state: 'fail' }]
  await assert.rejects(removeOwnedMaterialRoot({ acceptanceRoot, ownedStat, cleanup, childFinished: true }), /root retained/u)
  assert.equal(await readFile(join(acceptanceRoot, 'evidence.json'), 'utf8'), '{}')
  await new Promise(done => server.close(done))
  await assertMaterialBackendPortReleased(port)
  cleanup.at(-1).state = 'pass'
  await assert.rejects(removeOwnedMaterialRoot({ acceptanceRoot, ownedStat, cleanup, childFinished: false }), /root retained/u)
  await removeOwnedMaterialRoot({ acceptanceRoot, ownedStat, cleanup, childFinished: true })
  await assert.rejects(lstat(acceptanceRoot), { code: 'ENOENT' })
  for (const invalid of [3080, 0, -1, 65536, '41234', undefined]) await assert.rejects(assertMaterialBackendPortReleased(invalid), /invalid isolated/u)
})

function reportFixture() {
  return { runId: randomUUID(), scenario: 'normal', createdAt: new Date().toISOString(),
    sourceBefore: { sha256: 'a'.repeat(64) }, runtimeIdentity: 'b'.repeat(64),
    proof: { status: 'pass', tasks: [{ taskId: 'synthetic-test', state: 'pass' }] },
    budget: { reservedRequests: 1, usage: { totalUsage: null } }, cleanup: [{ id: 'owned-backend-port-released', state: 'pass' }], failures: [] }
}

test('post-cleanup source snapshot failure still persists a failed total report and no task success', async t => {
  const outputDirectory = await ownDirectory(t), report = reportFixture(), progress = []
  const note = (stage, error) => report.failures.push({ stage, message: error.message })
  await finishMaterialEvidence(report, { outputDirectory, note, onProgress: value => progress.push(value), capture: async () => { throw new Error('synthetic snapshot read failure') } })
  const saved = JSON.parse(await readFile(join(outputDirectory, 'report.json'), 'utf8'))
  assert.equal(saved.status, 'fail'); assert.equal(saved.sourceAfter, null)
  assert(saved.failures.some(row => row.stage === 'source-snapshot-after'))
  assert(saved.failures.some(row => row.stage === 'source-binding'))
  assert.deepEqual(await readdir(outputDirectory), ['proof.json', 'report.json'])
  assert.equal(progress.at(-1).stage, 'evidence-finalizing')
  assert.equal(progress.at(-1).status, undefined, 'pre-publication progress must not announce success')
})

test('final asynchronous progress rejection is captured before status and task evidence are saved', async t => {
  const outputDirectory = await ownDirectory(t), report = reportFixture()
  const note = (stage, error) => report.failures.push({ stage, message: error.message })
  await finishMaterialEvidence(report, { outputDirectory, note, capture: async () => report.sourceBefore,
    onProgress: async () => { await Promise.resolve(); throw new Error('synthetic observer failure') } })
  assert.equal(report.status, 'fail')
  assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, 'report.json'), 'utf8')), report)
  assert.equal(report.failures.at(-1).stage, 'progress-observer')
  assert.deepEqual(await readdir(outputDirectory), ['proof.json', 'report.json'])
})

test('unchanged source and successful finalization persist a matching task report', async t => {
  const outputDirectory = await ownDirectory(t), report = reportFixture()
  await finishMaterialEvidence(report, { outputDirectory, note: () => assert.fail('unexpected failure'), capture: async () => report.sourceBefore, onProgress: () => {} })
  assert.equal(report.status, 'pass')
  const task = JSON.parse(await readFile(join(outputDirectory, 'task-run.json'), 'utf8'))
  assert.equal(task.binding.sourceSha256, report.sourceBefore.sha256)
  assert.equal(task.finishedAt, report.finishedAt)
  assert.deepEqual(task.tasks, report.proof.tasks)
})

test('final server evidence requires completed close and cannot substitute an open or failed closure', async () => {
  const events = []
  const result = await readFinalMaterialServerEvidence({
    async close() { events.push('closing'); await Promise.resolve(); events.push('closed') },
    async evidence() { assert.deepEqual(events, ['closing', 'closed']); events.push('evidence'); return { closed: true } },
  })
  assert.equal(result.closed, true)
  await assert.rejects(readFinalMaterialServerEvidence({ async close() {}, async evidence() { return { closed: false } } }), /closure is unproven/u)
  await assert.rejects(readFinalMaterialServerEvidence({
    async close() { throw new Error('synthetic close failure') },
    async evidence() { assert.fail('failed close must never be followed by a trusted snapshot') },
  }), /synthetic close failure/u)
})
