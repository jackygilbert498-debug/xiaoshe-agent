import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CODEX_VISION_PREFIX, createVisionEngineRuntime, parseCodexVisionEvents, readVisionEngineLedger,
  runOwnedVisionEngine, validateVisionEngineConfig } from './vision-engine-runtime.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const events = (usage = { input_tokens: 9, output_tokens: 4 }) => [
  { type: 'thread.started', thread_id: 'offline-thread' }, { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ summary: 'offline synthetic pixels' }) } },
  { type: 'turn.completed', usage },
].map(row => JSON.stringify(row)).join('\n') + '\n'

async function fixture(t, mode = 'success') {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'xs-vision-engine-test-')))
  t.after(async () => {
    // Preserve identity evidence if a failed business assertion left a child.
    let launch
    try { launch = JSON.parse(await fs.readFile(join(root, 'engine/launch-1.json'))) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (launch) { try { process.kill(-launch.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }; await gone(-launch.pid) }
    await fs.rm(root, { recursive: true, force: true })
  })
  const executable = join(root, 'offline-engine.mjs')
  const program = `#!${process.execPath}\nimport fs from 'node:fs';
if (process.env.XIAOSHE_TEST_SECRET || process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS) process.exit(21);
if (!process.env.CODEX_HOME.endsWith('nonexistent-auth-reference')) process.exit(22);
process.stderr.write('private diagnostic sentinel');
${mode === 'schema-change' ? "fs.writeFileSync(process.argv[process.argv.indexOf('--output-schema')+1], '{}');" : ''}
${mode === 'exit' ? 'process.exit(7)' : mode === 'invalid' ? "process.stdout.write('not JSON')" : `process.stdout.write(${JSON.stringify(events())})`};\n`
  await fs.writeFile(executable, program, { mode: 0o700 })
  const config = { runId: 'run-offline', sessionId: 'session-offline', acceptanceRoot: root,
    ledgerDirectory: join(root, 'engine'), workDirectory: join(root, 'work'), isolatedHome: join(root, 'home'),
    authHome: join(dirname(root), 'nonexistent-auth-reference'), executable, executableSha256: sha(program), model: 'test-vision-model', imageSha256: sha('synthetic PNG pixels'),
    outputSchemaPath: join(root, 'installed-output-schema.json'), outputSchemaSha256: sha('{"type":"object"}\n') }
  await fs.writeFile(config.outputSchemaPath, '{"type":"object"}\n', { mode: 0o600 })
  const runtime = createVisionEngineRuntime(config); await runtime.ready
  const cwd = await fs.mkdtemp(join(config.workDirectory, 'modlens-work-')), image = join(cwd, 'input.png')
  await fs.writeFile(image, 'synthetic PNG pixels')
  const invocation = { command: executable, cwd, args: [...CODEX_VISION_PREFIX, image, '-m', config.model, '--output-schema', config.outputSchemaPath, '--', 'Read the synthetic image only.'] }
  return { config, runtime, invocation, root, image }
}
async function gone(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    await delay(20)
  }
  assert.fail('test-owned process did not disappear')
}

test('strict flags disable user configuration/rules and known tool surfaces, without a false HTTP cap', () => {
  assert.ok(CODEX_VISION_PREFIX.includes('--ignore-user-config')); assert.ok(CODEX_VISION_PREFIX.includes('--ignore-rules'))
  for (const flag of ['features.apps=false', 'agents.enabled=false', 'features.shell_tool=false', 'features.unified_exec=false', 'web_search="disabled"']) assert.ok(CODEX_VISION_PREFIX.includes(flag))
  assert.throws(() => validateVisionEngineConfig({}), /invalid_config/)
})
test('engine rejects schema argument/hash changes before launch and detects actual child mutation after cleanup without refund', async t => {
  const before = await fixture(t)
  const badArgs = [...before.invocation.args]; badArgs[badArgs.indexOf('--output-schema') + 1] = before.image
  await assert.rejects(before.runtime.runCommand('codex-cli', { ...before.invocation, args: badArgs }, 3000), /invocation_not_allowed/u)
  await fs.writeFile(before.config.outputSchemaPath, '{}')
  await assert.rejects(before.runtime.runCommand('codex-cli', before.invocation, 3000), /artifact_changed/u)
  assert.equal((await before.runtime.snapshot()).reservedLaunches, 0)
  const after = await fixture(t, 'schema-change')
  await assert.rejects(after.runtime.runCommand('codex-cli', after.invocation, 3000), /artifact_changed/u)
  const ledger = await after.runtime.snapshot()
  assert.equal(ledger.reservedLaunches, 1); assert.equal(ledger.receipt.errorCode, 'artifact_changed')
  assert.equal(ledger.receipt.cleanup.confirmedBy, 'ESRCH')
  await gone(-ledger.receipt.pid)
  await fs.writeFile(after.config.outputSchemaPath, '{"type":"object"}\n')
  await assert.rejects(after.runtime.runCommand('codex-cli', after.invocation, 3000), /engine_budget_exhausted/u)
})
test('only one complete real JSONL turn is accepted; missing usage remains unknown', () => {
  assert.deepEqual(parseCodexVisionEvents(events()).usage, { input_tokens: 9, output_tokens: 4 })
  assert.equal(parseCodexVisionEvents(events(null)).usage, null)
  assert.equal(parseCodexVisionEvents(events({ input_tokens: -1, output_tokens: 0 })).usage, null)
  const completeUsage = { input_tokens: 9071, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 123, reasoning_output_tokens: 0 }
  assert.deepEqual(parseCodexVisionEvents(events(completeUsage)).usage, completeUsage)
  assert.equal(Object.hasOwn(parseCodexVisionEvents(events()).usage, 'cache_write_input_tokens'), false)
  for (const bad of ['', '{', events().replace('agent_message', 'command_execution'), events().replace('turn.completed', 'turn.failed'),
    events() + JSON.stringify({ type: 'turn.completed' }), events().split('\n').slice(0, 3).join('\n')]) {
    assert.throws(() => parseCodexVisionEvents(bad), /vision-engine:/)
  }
})
test('real local fake engine binds actual PID/binary/image/raw events, without reading auth or leaking stderr/env', { skip: process.platform === 'win32' }, async t => {
  const { runtime, config, invocation } = await fixture(t)
  assert.equal((await runtime.snapshot()).usage.status, 'no_model')
  const result = await runtime.runCommand('codex-cli', invocation, 3000)
  assert.equal(result.receipt.cleanup.confirmedBy, 'ESRCH'); assert.equal(result.receipt.inputPath, invocation.args[CODEX_VISION_PREFIX.length])
  assert.equal(result.receipt.executable.sha256, config.executableSha256)
  assert.deepEqual(result.receipt.outputSchema, { path: config.outputSchemaPath, sha256: config.outputSchemaSha256 })
  assert.ok(result.receipt.pid > 1); assert.equal(result.stderr, '')
  assert.ok(!JSON.stringify(result.receipt).includes('private diagnostic sentinel'))
  const ledger = await readVisionEngineLedger(config.ledgerDirectory)
  assert.equal(ledger.reservedLaunches, 1); assert.equal(ledger.usage.status, 'reported')
  assert.equal(ledger.internalRequestCap, null); assert.equal(ledger.monetaryHardCap, false)
  assert.equal(ledger.receipt.rawStdoutSha256, sha(result.stdout))
  await assert.rejects(fs.stat(config.authHome), { code: 'ENOENT' })
})
test('one immutable launch slot survives concurrency and restart; no fallback on failure', { skip: process.platform === 'win32' }, async t => {
  const { runtime, config, invocation } = await fixture(t)
  const second = createVisionEngineRuntime(config); await second.ready
  const results = await Promise.allSettled([runtime.runCommand('codex-cli', invocation, 3000), second.runCommand('codex-cli', invocation, 3000)])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'engine_budget_exhausted')
  const restarted = createVisionEngineRuntime(config); await restarted.ready
  await assert.rejects(restarted.runCommand('codex-cli', invocation, 3000), { code: 'engine_budget_exhausted' })
  assert.equal((await restarted.snapshot()).reservedLaunches, 1)
})
test('ordinary nonzero and invalid JSONL consume budget; unknown usage is not zero', { skip: process.platform === 'win32' }, async t => {
  for (const mode of ['exit', 'invalid']) {
    const { runtime, invocation, config } = await fixture(t, mode)
    await assert.rejects(runtime.runCommand('codex-cli', invocation, 3000))
    const ledger = await runtime.snapshot()
    assert.equal(ledger.remainingLaunches, 0); assert.deepEqual(ledger.usage, { status: 'unknown', value: null })
    assert.equal(ledger.receipt.cleanup.confirmedBy, 'ESRCH')
    const restart = createVisionEngineRuntime(config); await restart.ready
    await assert.rejects(restart.runCommand('codex-cli', invocation, 3000), { code: 'engine_budget_exhausted' })
  }
})
test('route, model, argv, image symlink/hash and executable tampering fail before launch', { skip: process.platform === 'win32' }, async t => {
  const { runtime, invocation, config, image } = await fixture(t)
  for (const changed of [{ ...invocation, command: process.execPath }, { ...invocation, env: {} },
    { ...invocation, args: [...invocation.args, '--extra'] }, { ...invocation, cwd: config.workDirectory }]) await assert.rejects(runtime.runCommand('codex-cli', changed, 3000))
  await assert.rejects(runtime.runCommand('other-provider', invocation, 3000), /route_not_allowed/)
  await fs.rename(image, image + '.original'); await fs.symlink(image + '.original', image)
  await assert.rejects(runtime.runCommand('codex-cli', invocation, 3000), /unsafe_file/)
  await fs.unlink(image); await fs.writeFile(image, 'different')
  await assert.rejects(runtime.runCommand('codex-cli', invocation, 3000), /invocation_not_allowed/)
  await fs.writeFile(image, 'synthetic PNG pixels'); await fs.appendFile(config.executable, '\n// changed')
  await assert.rejects(runtime.runCommand('codex-cli', invocation, 3000), /executable_changed/)
  assert.equal((await runtime.snapshot()).reservedLaunches, 0)
})
test('partial reservation stays consumed and readers fail closed; corrupt raw evidence cannot pass', { skip: process.platform === 'win32' }, async t => {
  const a = await fixture(t)
  await fs.writeFile(join(a.config.ledgerDirectory, 'reserved-1.json'), '{')
  await assert.rejects(a.runtime.runCommand('codex-cli', a.invocation, 3000), /engine_budget_exhausted/)
  await assert.rejects(a.runtime.snapshot())
  const b = await fixture(t)
  await b.runtime.runCommand('codex-cli', b.invocation, 3000)
  await fs.appendFile(join(b.config.ledgerDirectory, 'stdout-1.jsonl'), '\n')
  await assert.rejects(b.runtime.snapshot(), /raw_output_changed/)
})
test('restarts cannot change the auth reference or trust a forged receipt value', { skip: process.platform === 'win32' }, async t => {
  const { runtime, config, invocation } = await fixture(t)
  const changed = createVisionEngineRuntime({ ...config, authHome: config.authHome + '-other' })
  await assert.rejects(changed.ready, /identity_changed/)
  await runtime.runCommand('codex-cli', invocation, 3000)
  const path = join(config.ledgerDirectory, 'receipt-1.json'), receipt = JSON.parse(await fs.readFile(path))
  receipt.result.summary = 'forged visual answer'
  await fs.writeFile(path, JSON.stringify(receipt))
  await assert.rejects(runtime.snapshot(), /receipt_observation_mismatch/)
})
test('normal, failure, timeout and cancellation clean real local child trees with inherited or ignored stdio', { skip: process.platform === 'win32' }, async t => {
  await Promise.all(['normal', 'failure', 'timeout', 'cancel'].flatMap(mode => ['ignore', 'inherit'].map(async pipes => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'xs-vision-owned-test-'))), pidFile = join(root, 'pid.json')
    let ownedPid
    t.after(async () => {
      if (ownedPid) { try { process.kill(-ownedPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }; await gone(-ownedPid) }
      let row
      try { row = JSON.parse(await fs.readFile(pidFile)) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (row) { try { process.kill(row.child, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }; await gone(row.child) }
      await fs.rm(root, { recursive: true, force: true })
    })
    const child = "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"
    const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore',${JSON.stringify(pipes)},${JSON.stringify(pipes)},'ipc']});c.once('message',()=>{fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:c.pid}));${['normal', 'failure'].includes(mode) ? `process.exit(${mode === 'failure' ? 7 : 0})` : "setInterval(()=>{},1000)"}})`
    const controller = new AbortController()
    const pending = runOwnedVisionEngine(process.execPath, ['-e', code], { cwd: root, env: { PATH: '/usr/bin:/bin' }, signal: controller.signal,
      timeoutMs: mode === 'timeout' ? 600 : 3000, onSpawn: ({ pid }) => { ownedPid = pid } })
    pending.catch(() => {})
    let row
    for (let i = 0; i < 200; i++) { try { row = JSON.parse(await fs.readFile(pidFile)); break } catch (error) { if (error.code !== 'ENOENT') throw error }; await delay(10) }
    assert.ok(row, 'both owned processes reached readiness')
    if (mode === 'cancel') controller.abort()
    let result
    if (mode === 'normal') result = await pending
    else await assert.rejects(pending, error => { result = error.result; return error.code === ({ failure: 'engine_exit_failed', timeout: 'VISION_TIMEOUT', cancel: 'VISION_CANCELLED' })[mode] })
    assert.equal(result.cleanup.confirmedBy, 'ESRCH'); await gone(-row.parent); await gone(row.child)
  })))
})
test('failed launch persistence, missing executable and output overflow do not bypass cleanup', { skip: process.platform === 'win32' }, async () => {
  const options = { cwd: tmpdir(), env: { PATH: '/usr/bin:/bin' }, timeoutMs: 3000 }
  await assert.rejects(runOwnedVisionEngine('/not/a/real/engine', [], options), error => error.code === 'ENOENT' && error.result.cleanup.status === 'not-started')
  await assert.rejects(runOwnedVisionEngine(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, onSpawn: async () => { throw new Error('injected ledger failure') } }),
    error => error.code === 'launch_record_failed' && error.result.cleanup.confirmedBy === 'ESRCH')
  await assert.rejects(runOwnedVisionEngine(process.execPath, ['-e', "process.stdout.write('x'.repeat(3*1024*1024));setInterval(()=>{},1000)"], options),
    error => error.code === 'VISION_OUTPUT_LIMIT' && error.result.cleanup.confirmedBy === 'ESRCH')
})
test('EPERM cleanup observation fails success and preserves the cancellation cause', { skip: process.platform === 'win32' }, async t => {
  const realKill = process.kill.bind(process), groups = new Set()
  const mocked = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid < -1 && signal !== 0) groups.add(pid)
    if (signal === 0 && groups.has(pid)) throw Object.assign(new Error('injected probe failure'), { code: 'EPERM' })
    return realKill(pid, signal)
  })
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 80)
  try {
    const options = { cwd: tmpdir(), env: {}, timeoutMs: 3000 }
    const rows = await Promise.allSettled([
      runOwnedVisionEngine(process.execPath, ['-e', 'console.log("done")'], options),
      runOwnedVisionEngine(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, signal: controller.signal }),
    ])
    for (const [index, row] of rows.entries()) {
      assert.equal(row.status, 'rejected'); assert.equal(row.reason.code, 'VISION_CLEANUP_FAILED')
      assert.equal(row.reason.originalCode, index ? 'VISION_CANCELLED' : null)
      assert.equal(row.reason.result.cleanup.status, 'unconfirmed'); assert.equal(row.reason.result.cleanup.probeErrorCode, 'EPERM')
    }
  } finally {
    clearTimeout(timer); mocked.mock.restore()
    for (const pid of groups) { try { realKill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }; await gone(pid) }
  }
})
