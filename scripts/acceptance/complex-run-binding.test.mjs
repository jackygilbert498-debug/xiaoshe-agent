import nodeTest from 'node:test'
const test = (name, body) => nodeTest(name, { skip: process.platform === 'win32' ? 'POSIX private ownership/mode binding requires macOS/Linux' : false }, body)
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, link, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { COMPLEX_SCENARIOS, assertComplexProtectedInputs, collectCompleteComplexHistory, loadComplexRunBinding } from './complex-run-binding.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const NODE = await realpath(process.execPath)
const NPM = process.platform === 'win32' ? NODE : await realpath(join(dirname(NODE), '../lib/node_modules/npm/bin/npm-cli.js'))
const OUTPUT = new URL('../../output/stabilization/', import.meta.url)
async function fixture(t) {
  const runId = randomUUID(), root = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  await mkdir(root, { mode: 0o700 })
  const evidenceDirectory = await realpath(await mkdtemp(new URL('complex-binding-test-', OUTPUT).pathname))
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(evidenceDirectory, { recursive: true, force: true }) })
  const fixtureRoot = join(root, 'workspace'), temporaryRoot = join(root, 'execution-temp')
  for (const path of [fixtureRoot, temporaryRoot, ...['code-repair', 'research', 'recovery', 'steer'].map(name => join(fixtureRoot, name))]) await mkdir(path, { mode: 0o700 })
  const config = { runId, fixtureRoot, expectedHostCwd: fixtureRoot, endpoint: 'http://127.0.0.1:49077', runtimeIdentity: 'a'.repeat(64),
    reportPath: join(evidenceDirectory, 'report.json'), evidenceDirectory, nodePath: NODE, npmPath: NPM, temporaryRoot }
  const path = join(root, 'complex-run-config.json')
  const save = async value => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await save(config)
  const processPath = join(root, 'host-process.json')
  const processEvidence = { schema: 'xiaoshe-owned-host-process/v1', pid: process.pid, cwd: config.expectedHostCwd, creationIdentity: 'synthetic-validator-fixture', platform: 'linux', endpoint: config.endpoint, runtimeIdentity: config.runtimeIdentity, runId }
  await writeFile(processPath, JSON.stringify(processEvidence), { flag: 'wx', mode: 0o600 })
  return { root, config, path, save, processPath, processEvidence, load: () => loadComplexRunBinding(path) }
}

test('absent configuration alone retains legacy mode; malformed supplied config never falls back', async t => {
  assert.equal(await loadComplexRunBinding(undefined), null)
  await assert.rejects(loadComplexRunBinding(''), /noncanonical/u)
  const f = await fixture(t)
  for (const value of [{}, { ...f.config, extra: true }, { ...f.config, runId: 'old-run' }, { ...f.config, runtimeIdentity: '' }]) {
    await f.save(value); await assert.rejects(f.load())
  }
  await writeFile(f.path, '{'); await assert.rejects(f.load(), /invalid_json/u)
})

test('exact canonical private workspace, separate temp, fixed five IDs and runtime cwd are bound', async t => {
  const f = await fixture(t), binding = await f.load()
  assert(Object.isFrozen(binding.config))
  assert.deepEqual(COMPLEX_SCENARIOS.map(id => binding.sessionId(id)), COMPLEX_SCENARIOS.map(id => `xiaoshe-harness-${id}-${f.config.runId}`))
  assert.throws(() => binding.sessionId('other'), /unknown_scenario/u)
  await mkdir(join(f.config.fixtureRoot, 'code-repair', 'src'), { mode: 0o700 })
  await binding.assertCurrent() // adding legitimate child directories changes nlink, not ownership.
  for (const [key, value] of [['expectedHostCwd', dirname(NODE)], ['temporaryRoot', f.root], ['fixtureRoot', f.root], ['reportPath', join(f.config.evidenceDirectory, 'other.json')]]) {
    await f.save({ ...f.config, [key]: value }); await assert.rejects(f.load(), /binding_mismatch/u)
  }
})

test('process evidence missing, mismatched, or altered after pinning is rejected', async t => {
  const f = await fixture(t)
  await rm(f.processPath)
  await assert.rejects(f.load(), { code: 'ENOENT' })
  await writeFile(f.processPath, JSON.stringify({ ...f.processEvidence, cwd: '/forged' }), { mode: 0o600 })
  await assert.rejects(f.load(), /host_process_evidence_mismatch/)
  await writeFile(f.processPath, JSON.stringify(f.processEvidence), { mode: 0o600 })
  const binding = await f.load()
  await writeFile(f.processPath, JSON.stringify({ ...f.processEvidence, pid: process.pid + 1 }), { mode: 0o600 })
  await assert.rejects(binding.assertCurrent(), /bound_input_changed/)
})

test('owned transport rejects daily endpoint, external hosts, URL components and missing explicit port', async t => {
  const f = await fixture(t)
  for (const endpoint of ['http://127.0.0.1:3080', 'http://127.0.0.1:0', 'http://localhost:49077', 'https://127.0.0.1:49077', 'http://127.0.0.1', 'http://127.0.0.1:49077/', 'http://u:p@127.0.0.1:49077', 'http://127.0.0.1:49077/path', 'http://127.0.0.1:49077?x=1']) {
    await f.save({ ...f.config, endpoint }); await assert.rejects(f.load(), /isolated_endpoint/u)
  }
})

test('manifest modes/links and nonempty or replaced fixture directories reject without writes', async t => {
  const f = await fixture(t)
  await chmod(f.path, 0o644); await assert.rejects(f.load(), /private_mode/u); await chmod(f.path, 0o600)
  const hard = join(f.root, 'manifest-hardlink'); await link(f.path, hard)
  await assert.rejects(f.load(), /hardlinked/u); await rm(hard)
  const directory = join(f.config.fixtureRoot, 'research'), old = join(f.root, 'original-research')
  await rename(directory, old); await symlink(old, directory)
  await assert.rejects(f.load(), /unsafe_path/u); await rm(directory); await rename(old, directory)
  await writeFile(join(directory, 'preexisting'), 'not ours')
  await assert.rejects(f.load(), /fixture_not_empty/u)
  assert.equal(await readFile(join(directory, 'preexisting'), 'utf8'), 'not ours')
  assert.deepEqual(await readdir(f.config.evidenceDirectory), [])
})

test('captured directory or manifest replacement fails closed before evidence is written', async t => {
  const f = await fixture(t), binding = await f.load()
  await f.save({ ...f.config, endpoint: 'http://127.0.0.1:49078' })
  await assert.rejects(binding.assertCurrent(), /bound_input_changed/u)
  const f2 = await fixture(t), second = await f2.load()
  const old = join(f2.root, 'old-workspace'); await rename(f2.config.fixtureRoot, old)
  await mkdir(f2.config.fixtureRoot, { mode: 0o700 })
  await assert.rejects(second.retainResponse({ method: 'session/follow', bytes: Buffer.from('{}') }), /bound_input_changed/u)
  assert.deepEqual(await readdir(f2.config.evidenceDirectory), [])
})

test('raw history envelopes retain exact bytes in exclusive order, including failed HTTP responses', async t => {
  const f = await fixture(t), binding = await f.load()
  const bytes = Buffer.from(' {"type":"server-response", "result":{"ok":false},"unknown":"原始\\n字段"} \n')
  const first = await binding.retainResponse({ method: 'session/follow', rpcId: 'first', payload: { sessionId: binding.sessionId('code-repair') }, status: 409, bytes })
  const second = await binding.retainResponse({ method: 'session/follow', rpcId: 'second', payload: { beforeSeq: 7 }, status: 200, bytes: Buffer.from('{"events":[]}') })
  assert.equal(first.ordinal, 1); assert.equal(second.ordinal, 2)
  assert.deepEqual(await readFile(first.path), bytes); assert.equal(first.sha256, sha(bytes))
  assert.equal((await lstat(first.path)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(first.path.replace('.json', '.receipt.json'), 'utf8')).status, 409)
  await writeFile(join(f.config.evidenceDirectory, 'session-follow-000003.json'), 'sentinel')
  await assert.rejects(binding.retainResponse({ method: 'session/follow', bytes: Buffer.from('{}') }), error => error.code === 'COMPLEX_RUN_BINDING' && error.cause?.code === 'EEXIST')
  assert.equal(await readFile(join(f.config.evidenceDirectory, 'session-follow-000003.json'), 'utf8'), 'sentinel')
  await assert.rejects(binding.assertCurrent(), /prior_retention_failure/u)
  await binding.writeReport({ status: 'fail' })
  assert.equal(JSON.parse(await readFile(f.config.reportPath, 'utf8')).status, 'fail')
})

test('report updates only its original owned inode and never an existing/replaced destination', async t => {
  const f = await fixture(t), binding = await f.load()
  await binding.writeReport({ state: 'pending' }); const first = await lstat(f.config.reportPath)
  await binding.writeReport({ state: 'done' }); assert.equal((await lstat(f.config.reportPath)).ino, first.ino)
  const saved = join(f.config.evidenceDirectory, 'saved.json'); await rename(f.config.reportPath, saved)
  await writeFile(f.config.reportPath, 'foreign', { mode: 0o600 })
  await assert.rejects(binding.writeReport({ state: 'pass' }), /report_replaced/u)
  assert.equal(await readFile(f.config.reportPath, 'utf8'), 'foreign')
})

test('real product status route shape is consumed, not guessed camelCase readiness', async t => {
  const f = await fixture(t), binding = await f.load()
  // Compile the actual pure route module in memory; no host, bridge process or app starts.
  let source = await readFile(new URL('../../src/runtime-control.ts', import.meta.url), 'utf8')
  for (const name of ['bridge-client', 'memory-service']) source = source.replace(`from './${name}.js'`, `from '${new URL(`../../dist/${name}.js`, import.meta.url).href}'`)
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const { registerRuntimeRoutes } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
  let route
  registerRuntimeRoutes({ register(value) { if (value.path === '/xiaoshe/desktop/status') route = value; return () => {} } }, {
    bridge: { async request(method) { assert.equal(method, 'health'); return { protocol_version: '1', platform: 'synthetic' } } },
    actions: { deploymentAllowed: false, enabled: false }, settings: { get: () => ({}) }, modlensAvailable: () => false,
    runtimeIdentity: f.config.runtimeIdentity, version: 'synthetic',
  })
  let raw, status
  await route.handler(Object.assign(new EventEmitter(), { method: 'GET', headers: { host: '127.0.0.1:49077' } }), {
    writeHead(value) { status = value; return this }, end(value) { raw = Buffer.from(value) },
  })
  const observed = await binding.verifyRuntime(async (url, options) => {
    assert.equal(url, `${f.config.endpoint}/xiaoshe/desktop/status`); assert.equal(options.redirect, 'error')
    return new Response(raw, { status })
  })
  assert.equal(observed.runtimeIdentity, f.config.runtimeIdentity)
  assert.deepEqual(await readFile(binding.retainedResponses()[0].path), raw)
  for (const change of [{ runtime_identity: 'b'.repeat(64) }, { bridge: { state: 'error' } }, { runtime_identity: undefined, runtimeIdentity: f.config.runtimeIdentity, bridge: { ready: true } }]) {
    await assert.rejects(binding.verifyRuntime(async () => Response.json({ ...JSON.parse(raw), ...change })), /runtime_identity_mismatch/u)
  }
})


nodeTest('full history rejects overlap, gaps, empty continuation and malformed completion', async () => {
  const row = seq => ({ event: { seq } })
  for (const pages of [
    [{ events: [row(0), row(2)], hasMore: false }],
    [{ events: [row(1)], hasMore: true }, { events: [row(0), row(1)], hasMore: false }],
    [{ events: [], hasMore: true }], [{ events: [row(0)] }],
    [{ events: [row(1), row(0)], hasMore: false }],
  ]) {
    const cutoff = Math.max(-1, ...pages.flatMap(page => page.events?.map(row => row.event.seq) ?? []))
    for (const page of pages) page.throughSeq = cutoff
    await assert.rejects(collectCompleteComplexHistory('synthetic', async () => pages.shift()), /history/u)
  }
})

test('protected fixtures are checked before any independent execution; contamination or symlink is rejected', async t => {
  const f = await fixture(t), code = join(f.config.fixtureRoot, 'code-repair'), expected = {}
  await mkdir(join(code, 'test'), { mode: 0o700 })
  for (const path of ['requirements.md', 'test/normalize.test.mjs', 'package.json']) {
    await writeFile(join(code, path), `protected:${path}`); expected[path] = sha(await readFile(join(code, path)))
  }
  await assertComplexProtectedInputs(code, expected)
  let executions = 0
  const guarded = async () => { await assertComplexProtectedInputs(code, expected); executions++ }
  await writeFile(join(code, 'package.json'), 'poison'); await assert.rejects(guarded(), /protected_input_changed/u)
  assert.equal(executions, 0)
  await rm(join(code, 'package.json')); await symlink(join(code, 'requirements.md'), join(code, 'package.json'))
  await assert.rejects(guarded(), /unsafe_path/u); assert.equal(executions, 0)
  const smoke = await readFile(new URL('./harness-performance-complex-smoke.mjs', import.meta.url), 'utf8')
  assert(smoke.indexOf('await assertComplexProtectedInputs(code, protectedBefore)') < smoke.indexOf('const invocation = createComplexSandboxInvocation'))
  assert.match(smoke, /cwd: code, env: invocation\.env, timeout: 30_000/u)
})

test('fixture retention copies all bytes independently with source modes and leaves original data for the outer owner', async t => {
  const f = await fixture(t), binding = await f.load(), code = join(f.config.fixtureRoot, 'code-repair')
  await mkdir(join(code, 'src'), { mode: 0o700 })
  const target = join(code, 'src/normalize.mjs'), bytes = Buffer.from([0, 255, 10, 20])
  await writeFile(target, bytes, { mode: 0o640 })
  const result = await binding.retainFixtures(), copied = join(result.destination, 'code-repair/src/normalize.mjs')
  assert.equal(result.retainedForOuterCleanup, true); assert.equal(result.totalBytes, 4)
  assert.deepEqual(await readFile(copied), bytes); assert.deepEqual(await readFile(target), bytes)
  assert.notEqual((await lstat(copied)).ino, (await lstat(target)).ino)
  assert.equal(result.entries.find(entry => entry.path.endsWith('normalize.mjs')).mode, 0o640)
  assert.equal(result.receipt.sha256, sha(await readFile(result.receipt.path)))
  await assert.rejects(binding.retainFixtures(), { code: 'EEXIST' })
})

test('fixture symlink or hardlink never copies external bytes and retains the original failed root', async t => {
  for (const kind of ['symlink', 'hardlink']) {
    const f = await fixture(t), binding = await f.load(), outside = join(f.root, 'synthetic-outside')
    await writeFile(outside, 'SYNTHETIC-DO-NOT-COPY')
    const linked = join(f.config.fixtureRoot, 'research/linked')
    await (kind === 'symlink' ? symlink(outside, linked) : link(outside, linked))
    await assert.rejects(binding.retainFixtures(), /unsafe_path|hardlinked_file/u)
    assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC-DO-NOT-COPY')
    await assert.rejects(readFile(join(f.config.evidenceDirectory, 'fixtures/research/linked')), { code: 'ENOENT' })
    assert((await lstat(f.root)).isDirectory())
  }
})
