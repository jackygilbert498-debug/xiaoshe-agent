import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { ToolRuntime } from '../../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt } from '../../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { createScope, scopeTarget } from '../../runtime/DSH/packages/core/scope/lib/index.js'
import { LocalFileSystem } from '../../runtime/DSH/packages/fs/fs-local/lib/index.js'
import { apply as applyFs } from '../../runtime/DSH/packages/fs/tool-fs/lib/index.js'
import { apply as applyTodo } from '../../runtime/DSH/packages/todo/tool-todo/lib/index.js'
import { ALLOWED_TOOLS, installLiveMaterialPolicy, readLiveMaterialPolicyLedger } from './live-material-policy.mjs'

async function fixture(t, change = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xs-material-policy-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runId = randomUUID()
  const config = { workspaceRealPath: join(root, 'workspace'), ledgerDirectory: join(root, 'ledger'), runId,
    sessionIds: [`xiaoshe-material-${runId}`], fixtureUrl: `http://127.0.0.1:49271/${runId}/`,
    ...(change.sessionIds?.[0]?.startsWith('xiaoshe-batch-') ? {} : { scenario: 'normal' }), ...change }
  await mkdir(join(config.workspaceRealPath, 'output'), { recursive: true })
  await mkdir(config.ledgerDirectory, { recursive: true })
  await writeFile(join(config.workspaceRealPath, 'input.jsonl'), '{"value":7}\n')
  const ctx = new Context(), calls = [], fsRequests = [], observations = [], sessionEvents = []
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx, { mode: 'native' })
  class ObservedLocalFileSystem extends LocalFileSystem {
    async resolve(path, options) { fsRequests.push(path); return super.resolve(path, options) }
  }
  new ObservedLocalFileSystem(ctx, { cwd: config.workspaceRealPath, diffBasisMaxBytes: 1_048_576 })
  applyFs(ctx, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 50000, readStreamMinSize: 10485760 })
  applyTodo(ctx, { allowParallelInProgress: false })
  ctx.on('fs/observed', (_target, observation) => observations.push(observation))
  t.after(() => ctx.fiber.dispose())
  // Browser definitions here are inert dispatch probes: no browser or HTTP
  // service is started. Files and todos use the actual product implementations.
  for (const name of [...ALLOWED_TOOLS.filter(name => !['read', 'write', 'todo_write'].includes(name)),
    'bash', 'web_fetch', 'web_search', 'subagent', 'cordis_plugin', 'browser_screenshot']) {
    ctx.tools.register({ name, description: name, parameters: { type: 'object', additionalProperties: true },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) { calls.push({ name, args }); return { observed: name } } })
  }
  const before = ctx.tools.schemas().map(tool => tool.name)
  const policy = installLiveMaterialPolicy(ctx, config)
  const agent = { id: 'material-agent', session: { id: config.sessionIds[0],
    header: { id: config.sessionIds[0], cwd: config.workspaceRealPath, agentPreset: 'standard' },
    append(type, data) { sessionEvents.push({ type, data }) } } }
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx; t.after(() => scope.dispose())
  const publish = () => ctx.emit(scopeTarget(agent), 'agent/created', { agent })
  const call = (name, args = {}, caller = agent) => ctx.tools.execute({ name, arguments: args, agent: caller, callId: randomUUID(), signal: new AbortController().signal })
  return { root, ctx, config, policy, agent, scope, publish, call, calls, before, fsRequests, observations, sessionEvents }
}

test('real ToolRuntime keeps the catalog intact while allowing only scoped material capabilities', async t => {
  const f = await fixture(t); f.policy.assertReady()
  assert.equal(readLiveMaterialPolicyLedger(f.config.ledgerDirectory).mounted, false)
  assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true)
  f.publish()
  assert.deepEqual(f.ctx.tools.schemas(f.agent).map(tool => tool.name), f.before)
  const read = await f.call('read', { file_path: 'input.jsonl' })
  assert.equal(read.isError, false)
  assert.equal(read.value.lines[0].text, '{"value":7}')
  assert.equal((await f.call('write', { file_path: 'output/result.json', content: '{"sum":7}' })).isError, false)
  assert.equal(await readFile(join(f.config.workspaceRealPath, 'output/result.json'), 'utf8'), '{"sum":7}')
  assert.equal((await f.call('read', { file_path: 'output/result.json' })).isError, false)
  assert.equal((await f.call('todo_write', { todos: [{ content: 'Verify the output', status: 'in_progress' }] })).isError, false)
  assert.equal(f.sessionEvents[0].type, 'todo/write')
  for (const name of ALLOWED_TOOLS.filter(name => !['read', 'write', 'todo_write', 'browser_open'].includes(name))) {
    assert.equal((await f.call(name, { tab_id: 'fixture-owned-tab' })).isError, false, name)
  }
  for (const name of ['bash', 'web_fetch', 'web_search', 'subagent', 'cordis_plugin', 'run_code', 'browser_screenshot', 'edit']) {
    assert.equal((await f.call(name, { file_path: 'input.jsonl' })).isError, true, name)
    assert.equal(f.calls.some(call => call.name === name), false)
  }
  const ledger = readLiveMaterialPolicyLedger(f.config.ledgerDirectory)
  assert.equal(ledger.mounted, true)
  assert.deepEqual(ledger.mounts.map(row => row.kind).sort(), ['agent', 'host'])
  assert(ledger.mounts.every(row => row.pid === process.pid && row.runId === f.config.runId))
})

test('missing.jsonl reaches the real file reader and returns its native not-found result', async t => {
  const f = await fixture(t, { scenario: 'missing_input' }); f.publish()
  const result = await f.call('read', { file_path: 'missing.jsonl' })
  assert.equal(result.isError, true)
  assert.deepEqual(f.fsRequests, ['missing.jsonl'])
  assert.deepEqual(f.observations, [{ kind: 'absent' }])
  assert.match(JSON.stringify(result), /not found|FS_NOT_FOUND/u)
  assert.doesNotMatch(JSON.stringify(result), /acceptance-material-policy/u)
  await assert.rejects(readFile(join(f.config.workspaceRealPath, 'missing.jsonl')), { code: 'ENOENT' })
  const count = f.fsRequests.length
  const fallback = await f.call('read', { file_path: 'input.jsonl' })
  assert.equal(fallback.isError, true)
  assert.match(JSON.stringify(fallback), /path_not_allowed/)
  assert.doesNotMatch(JSON.stringify(fallback), /FS_NOT_FOUND/)
  assert.equal(f.fsRequests.length, count, 'an existing alternative input is not dispatched')
})

test('each current material scenario exposes exactly its real input and output without changing the catalog', async t => {
  for (const scenario of ['normal', 'response_lost', 'takeover']) {
    const f = await fixture(t, { scenario }); f.publish()
    const ledger = readLiveMaterialPolicyLedger(f.config.ledgerDirectory)
    assert.equal(ledger.schema, 'xiaoshe-live-material-policy/v2')
    assert.equal(ledger.scenario, scenario)
    assert.deepEqual(ledger.readPaths, ['input.jsonl', 'output/result.json'].map(path => join(f.config.workspaceRealPath, path)))
    assert.deepEqual(ledger.writePaths, [join(f.config.workspaceRealPath, 'output/result.json')])
    assert.deepEqual(f.ctx.tools.schemas(f.agent).map(tool => tool.name), f.before)
    assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, false)
    assert.equal((await f.call('write', { file_path: 'output/result.json', content: '{"value":7}' })).isError, false)
    assert.equal((await f.call('read', { file_path: 'output/result.json' })).isError, false)
    for (const file_path of ['missing.jsonl', './missing.jsonl', join(f.config.workspaceRealPath, 'missing.jsonl')]) {
      const before = f.fsRequests.length, result = await f.call('read', { file_path })
      assert.equal(result.isError, true); assert.match(JSON.stringify(result), /path_not_allowed/)
      assert.doesNotMatch(JSON.stringify(result), /FS_NOT_FOUND/)
      assert.equal(f.fsRequests.length, before, 'wrong-path read never reaches the file tool')
    }
  }
  const f = await fixture(t, { scenario: 'missing_input' }); f.publish()
  assert.deepEqual(readLiveMaterialPolicyLedger(f.config.ledgerDirectory).readPaths,
    ['missing.jsonl', 'output/result.json'].map(path => join(f.config.workspaceRealPath, path)))
})

test('batch mode has exactly three predefined pairs and item URLs, never a caller-expanded directory', async t => {
  const runId = randomUUID(), f = await fixture(t, { runId, sessionIds: [`xiaoshe-batch-${runId}`], fixtureUrl: `http://127.0.0.1:49271/${runId}/` })
  f.policy.assertReady(); f.publish()
  for (let index = 1; index <= 3; index++) {
    await writeFile(join(f.config.workspaceRealPath, `input-${index}.jsonl`), '{"value":7}\n')
    assert.equal((await f.call('read', { file_path: `input-${index}.jsonl` })).isError, false)
    assert.equal((await f.call('write', { file_path: `output/item-${index}.json`, content: '{}' })).isError, false)
    assert.equal((await f.call('read', { file_path: `output/item-${index}.json` })).isError, false)
    assert.equal((await f.call('browser_open', { url: `${f.config.fixtureUrl}item-${index}/` })).isError, false)
    assert.equal((await f.call('browser_open', { url: `${f.config.fixtureUrl}item-${index}/record` })).isError, false)
  }
  for (const file_path of ['input.jsonl', 'input-4.jsonl', 'output/result.json', '../config.json']) assert.equal((await f.call('read', { file_path })).isError, true)
  assert.equal((await f.call('write', { file_path: 'output/item-4.json', content: '{}' })).isError, true)
  for (const suffix of ['', 'item-4/', 'item-1/save', 'item-1/../item-4/']) assert.equal((await f.call('browser_open', { url: f.config.fixtureUrl + suffix })).isError, true)
  const ledger = readLiveMaterialPolicyLedger(f.config.ledgerDirectory)
  assert.equal(ledger.readPaths.length, 6)
  assert.equal(ledger.writePaths.length, 3)
  assert.equal(ledger.browserPaths.length, 6)
  assert.equal(ledger.schema, 'xiaoshe-live-material-policy/v2')
  assert.equal(Object.hasOwn(ledger, 'scenario'), false)
})

test('missing, malformed or caller-expanded scenarios cannot install a material or batch policy', async t => {
  for (const scenario of [undefined, null, '', 'other', 'NORMAL', ['normal']]) {
    const f = await fixture(t, { scenario })
    assert.throws(f.policy.assertReady, /invalid_config/)
    assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true)
    assert.deepEqual(f.fsRequests, [])
    await assert.rejects(readFile(join(f.config.ledgerDirectory, 'manifest.json')), { code: 'ENOENT' })
  }
  const invalidBase = await fixture(t, { scenario: undefined })
  const { scenario: _scenario, ...withoutScenario } = invalidBase.config
  assert.throws(installLiveMaterialPolicy(invalidBase.ctx, withoutScenario).assertReady, /invalid_config/)
  let accessed = 0
  assert.throws(installLiveMaterialPolicy(invalidBase.ctx, { ...withoutScenario, get scenario() { accessed++; return 'normal' } }).assertReady, /invalid_config/)
  assert.equal(accessed, 0)
  for (const scenario of ['normal', 'missing_input', undefined]) {
    const runId = randomUUID(), f = await fixture(t, { runId, sessionIds: [`xiaoshe-batch-${runId}`],
      fixtureUrl: `http://127.0.0.1:49271/${runId}/`, scenario })
    assert.throws(f.policy.assertReady, /invalid_config/)
    assert.equal((await f.call('read', { file_path: 'input-1.jsonl' })).isError, true)
    assert.deepEqual(f.fsRequests, [])
  }
})

const digestPolicy = contents => ({ ...contents, policyDigest: createHash('sha256').update(JSON.stringify(contents)).digest('hex') })
async function replaceManifest(f, transform, replaceMounts = false) {
  const path = join(f.config.ledgerDirectory, 'manifest.json')
  const original = JSON.parse(await readFile(path, 'utf8'))
  const { policyDigest: _digest, ...contents } = original
  const changed = digestPolicy(transform(contents))
  if (replaceMounts) {
    const ledger = readLiveMaterialPolicyLedger(f.config.ledgerDirectory)
    for (const row of ledger.mounts) {
      const record = JSON.parse(await readFile(join(f.config.ledgerDirectory, row.file), 'utf8'))
      const { kind, sessionId, pid, at } = record
      await writeFile(join(f.config.ledgerDirectory, row.file), JSON.stringify({ ...changed, kind, sessionId, pid, at }))
    }
  }
  await writeFile(path, JSON.stringify(changed))
}

test('scenario and scope are immutable even when an edited manifest has a recomputed digest', async t => {
  for (const change of [contents => ({ ...contents, scenario: 'missing_input' }),
    contents => ({ ...contents, readPaths: [...contents.readPaths, join(contents.workspaceRealPath, 'missing.jsonl')] }),
    contents => { delete contents.scenario; return contents }]) {
    const f = await fixture(t); f.publish()
    await replaceManifest(f, change)
    assert.throws(() => readLiveMaterialPolicyLedger(f.config.ledgerDirectory))
    assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true)
    assert.deepEqual(f.fsRequests, [])
  }
  const f = await fixture(t); f.publish()
  await replaceManifest(f, contents => ({ ...contents, scenario: 'takeover' }), true)
  assert.equal(readLiveMaterialPolicyLedger(f.config.ledgerDirectory).scenario, 'takeover')
  assert.throws(f.policy.assertReady, /policy_identity_changed/)
  assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true)
  assert.deepEqual(f.fsRequests, [])
})

test('v1 can only be inspected under its original filesystem conditions and never mounted or downgraded into v2', async t => {
  for (const batch of [false, true]) {
    const runId = randomUUID(), f = await fixture(t, batch ? { runId, sessionIds: [`xiaoshe-batch-${runId}`], fixtureUrl: `http://127.0.0.1:49271/${runId}/` } : {})
    f.publish()
    await replaceManifest(f, contents => {
      delete contents.scenario
      return { ...contents, schema: 'xiaoshe-live-material-policy/v1', readPaths: batch ? contents.readPaths
        : ['input.jsonl', 'missing.jsonl', 'output/result.json'].map(path => join(f.config.workspaceRealPath, path)) }
    }, true)
    const historic = readLiveMaterialPolicyLedger(f.config.ledgerDirectory)
    assert.equal(historic.schema, 'xiaoshe-live-material-policy/v1')
    assert.equal(historic.mounted, true, 'only the retained v1 mount records are being read')
    assert.equal(historic.readPaths.length, batch ? 6 : 3)
    assert.throws(f.policy.assertReady, /historical_policy_not_mountable/)
    const before = historic.mounts.length
    assert.throws(installLiveMaterialPolicy(f.ctx, f.config).assertReady, /historical_policy_not_mountable/)
    assert.equal(readLiveMaterialPolicyLedger(f.config.ledgerDirectory).mounts.length, before)
    assert.equal((await f.call('read', { file_path: batch ? 'input-1.jsonl' : 'input.jsonl' })).isError, true)
    assert.deepEqual(f.fsRequests, [])
    await replaceManifest(f, contents => ({ ...contents, readPaths: [...contents.readPaths, join(f.config.workspaceRealPath, 'foreign.jsonl')] }))
    assert.throws(() => readLiveMaterialPolicyLedger(f.config.ledgerDirectory), /invalid_policy_manifest/)
  }
})

test('browser_open accepts only fixture base or record query on the exact loopback origin', async t => {
  const f = await fixture(t); f.publish()
  const base = f.config.fixtureUrl
  for (const url of [base, `${base}?view=summary`, `${base}record?id=synthetic-7`]) {
    assert.equal((await f.call('browser_open', { url })).isError, false, url)
  }
  const before = f.calls.length
  for (const url of [
    'https://example.com/', base.replace(':49271/', ':49272/'), base.replace('127.0.0.1', 'localhost'),
    base.replace('http:', 'https:'), base.replace('127.0.0.1', 'user:pass@127.0.0.1'),
    `${base}#fragment`, `${base}#`, 'file:///etc/passwd', 'data:text/html,owned', '/record?id=7',
    `${base}other`, `${base}../foreign/`, base.replace(/\/$/u, '-other/'), `${base}%2f..%2fsecret`,
    `${base}record/extra`, `${base}\\record`, `${base}\n`,
  ]) assert.equal((await f.call('browser_open', { url })).isError, true, url)
  assert.equal(f.calls.length, before)
})

test('read/write paths, symlinks, hardlinks, foreign ancestors and escalation cannot escape', async t => {
  const f = await fixture(t, { scenario: 'missing_input' }); f.publish()
  for (const [name, args] of [
    ['read', { file_path: '../ledger/manifest.json' }], ['read', { file_path: '/etc/passwd' }],
    ['write', { file_path: 'input.jsonl', content: 'overwrite' }], ['write', { file_path: 'missing.jsonl', content: 'forge' }],
    ['write', { file_path: 'output/other.json', content: 'escape' }], ['write', { filePath: 'output/result.json', content: 'escape' }],
    ['write', { file_path: 'output/result.json', content: '{}', sandbox_permissions: 'danger-full-access' }],
    ['browser_open', { url: f.config.fixtureUrl, justification: 'escalate' }],
  ]) assert.equal((await f.call(name, args)).isError, true)
  assert.deepEqual(f.fsRequests, [])
  const outside = join(f.root, 'private-synthetic.txt'); await writeFile(outside, 'private synthetic data')
  await symlink(outside, join(f.config.workspaceRealPath, 'missing.jsonl'))
  const symlinkRead = await f.call('read', { file_path: 'missing.jsonl' })
  assert.equal(symlinkRead.isError, true)
  assert.match(JSON.stringify(symlinkRead), /unsafe_file_target/)
  await rm(join(f.config.workspaceRealPath, 'missing.jsonl'))
  await link(outside, join(f.config.workspaceRealPath, 'missing.jsonl'))
  const hardlinkRead = await f.call('read', { file_path: 'missing.jsonl' })
  assert.equal(hardlinkRead.isError, true)
  assert.match(JSON.stringify(hardlinkRead), /unsafe_file_target/)
  await rename(join(f.config.workspaceRealPath, 'output'), join(f.root, 'owned-output'))
  await symlink(f.root, join(f.config.workspaceRealPath, 'output'), process.platform === 'win32' ? 'junction' : 'dir')
  const foreignAncestorWrite = await f.call('write', { file_path: 'output/result.json', content: '{}' })
  assert.equal(foreignAncestorWrite.isError, true)
  // Ledger readiness rechecks the fixed output directory before path dispatch.
  assert.match(JSON.stringify(foreignAncestorWrite), /unsafe_directory/)
  assert.equal(await readFile(outside, 'utf8'), 'private synthetic data')
  assert.deepEqual(f.fsRequests, [])
})

test('the permitted input remains symlink-protected in every current material scenario', async t => {
  for (const scenario of ['normal', 'missing_input', 'response_lost', 'takeover']) {
    const f = await fixture(t, { scenario }); f.publish()
    const file_path = scenario === 'missing_input' ? 'missing.jsonl' : 'input.jsonl'
    const input = join(f.config.workspaceRealPath, file_path)
    if (scenario !== 'missing_input') await rm(input)
    const outside = join(f.root, 'private-synthetic.txt')
    await writeFile(outside, 'private synthetic data')
    await symlink(outside, input)
    const result = await f.call('read', { file_path })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /unsafe_file_target/)
    assert.doesNotMatch(JSON.stringify(result), /path_not_allowed|FS_NOT_FOUND/)
    assert.equal(await readFile(outside, 'utf8'), 'private synthetic data')
    assert.deepEqual(f.fsRequests, [])
  }
})

test('independent scope masks and owner guards win over later permissive hooks', async t => {
  const f = await fixture(t)
  f.scope.ctx.tools.restrict({ deny: ['write'] })
  f.scope.ctx.tools.guard(exec => exec.name.startsWith('browser_') && exec.arguments?.tab_id === 'foreign-tab' ? 'product-owner-guard' : undefined)
  f.publish()
  f.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { global: true })
  assert.equal((await f.call('write', { file_path: 'output/result.json', content: '{}' })).isError, true)
  assert.equal((await f.call('browser_click', { tab_id: 'foreign-tab' })).isError, true)
  assert.equal((await f.call('browser_open', { tab_id: 'foreign-tab', url: f.config.fixtureUrl })).isError, true)
  assert.equal((await f.call('browser_open', { url: 'https://example.com/' })).isError, true)
  assert.equal((await f.call('bash')).isError, true)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.fsRequests, [])
})

test('agentless, cloned, foreign-session and replaced scope dispatch cannot borrow a mount', async t => {
  const f = await fixture(t); f.publish()
  assert.equal((await f.ctx.tools.execute({ name: 'read', arguments: { file_path: 'input.jsonl' }, callId: randomUUID(), signal: new AbortController().signal })).isError, true)
  assert.equal((await f.call('read', { file_path: 'input.jsonl' }, { ...f.agent })).isError, true)
  f.agent.session.header.cwd = f.root
  assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true)
  f.agent.session.header.cwd = f.config.workspaceRealPath
  f.agent.ctx = f.ctx
  assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true)
  f.agent.ctx = f.scope.ctx
  const foreign = { id: 'foreign', session: { ...f.agent.session, id: 'foreign-session' } }
  const scope = createScope(f.ctx, foreign); foreign.ctx = scope.ctx; t.after(() => scope.dispose())
  assert.throws(() => f.ctx.emit(scopeTarget(foreign), 'agent/created', { agent: foreign }), /agent_identity_not_allowed/u)
  assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true, 'bad creation latches closed')
  assert.deepEqual(f.fsRequests, [])
})

test('incorrect preset, delegation lineage and unscoped creation never mount', async t => {
  for (const change of [{ agentPreset: 'code' }, { parentSession: 'parent' }, { origin: 'subagent' }]) {
    const f = await fixture(t); Object.assign(f.agent.session.header, change)
    assert.throws(f.publish, /agent_identity_not_allowed/u)
    assert.equal(readLiveMaterialPolicyLedger(f.config.ledgerDirectory).mounted, false)
  }
  const f = await fixture(t); f.agent.ctx = f.ctx
  assert.throws(f.publish, /scoped_tools_unavailable/u)
})

test('changed manifest is rejected and remains latched closed even after restoration', async t => {
  const f = await fixture(t); f.publish()
  const path = join(f.config.ledgerDirectory, 'manifest.json'), original = await readFile(path, 'utf8')
  const tampered = JSON.parse(original); tampered.writePaths.push(join(f.config.workspaceRealPath, 'input.jsonl'))
  await writeFile(path, JSON.stringify(tampered))
  assert.throws(() => readLiveMaterialPolicyLedger(f.config.ledgerDirectory), /invalid_policy_manifest/u)
  assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true)
  await writeFile(path, original)
  assert.throws(f.policy.assertReady, /invalid_policy_manifest/u)
  assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true)
  assert.deepEqual(f.fsRequests, [])
})

test('missing or changed process mounts cannot keep an active dispatch proof', async t => {
  for (const kind of ['host', 'agent']) {
    const f = await fixture(t); f.publish()
    const ledger = readLiveMaterialPolicyLedger(f.config.ledgerDirectory)
    await rm(join(f.config.ledgerDirectory, ledger.mounts.find(row => row.kind === kind).file))
    assert.equal(readLiveMaterialPolicyLedger(f.config.ledgerDirectory).mounted, false)
    assert.equal((await f.call('xiaoshe_runtime_info')).isError, true)
    assert.deepEqual(f.calls, [])
  }
  const f = await fixture(t); f.publish()
  const ledger = readLiveMaterialPolicyLedger(f.config.ledgerDirectory), path = join(f.config.ledgerDirectory, ledger.mounts.find(row => row.kind === 'agent').file)
  const record = JSON.parse(await readFile(path, 'utf8')); record.sessionId = 'foreign'
  await writeFile(path, JSON.stringify(record))
  assert.throws(() => readLiveMaterialPolicyLedger(f.config.ledgerDirectory), /invalid_mount_record/u)
  assert.equal((await f.call('browser_status')).isError, true)
})

test('mutating caller config cannot widen the private policy snapshot', async t => {
  const f = await fixture(t); f.publish()
  f.config.scenario = 'missing_input'
  f.config.fixtureUrl = 'http://127.0.0.1:49272/foreign/'
  f.config.workspaceRealPath = f.root
  f.config.sessionIds[0] = 'foreign'
  assert.equal((await f.call('browser_open', { url: f.config.fixtureUrl })).isError, true)
  assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, false)
  assert.equal((await f.call('read', { file_path: 'missing.jsonl' })).isError, true)
})

test('unexpected ledger files and linked manifests are rejected before executing a tool', async t => {
  const unexpected = await fixture(t); unexpected.publish()
  await writeFile(join(unexpected.config.ledgerDirectory, 'not-a-mount.json'), '{}')
  assert.throws(() => readLiveMaterialPolicyLedger(unexpected.config.ledgerDirectory), /invalid_ledger_files/u)
  assert.equal((await unexpected.call('browser_status')).isError, true)
  assert.deepEqual(unexpected.calls, [])
  const linked = await fixture(t); linked.publish()
  const path = join(linked.config.ledgerDirectory, 'manifest.json'), saved = join(linked.root, 'saved-manifest.json')
  await rename(path, saved)
  await symlink(saved, path)
  assert.throws(() => readLiveMaterialPolicyLedger(linked.config.ledgerDirectory), /invalid_ledger/u)
  assert.equal((await linked.call('read', { file_path: 'input.jsonl' })).isError, true)
  assert.deepEqual(linked.fsRequests, [])
})

test('invalid configuration installs a fail-closed backstop instead of relaxing dispatch', async t => {
  for (const fixtureUrl of ['https://example.com/', 'http://127.0.0.1:3080/run/', 'http://127.0.0.1:49271/',
    'http://user:pass@127.0.0.1:49271/run/', 'http://127.0.0.1:49271/run/?query=1', 'http://127.0.0.1:49271/run/#fragment']) {
    const f = await fixture(t, { fixtureUrl })
    assert.throws(f.policy.assertReady, /invalid_fixture/u)
    assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true)
  }
  const f = await fixture(t); f.publish()
  const invalid = installLiveMaterialPolicy(f.ctx, { ...f.config, sessionIds: ['foreign-session'] })
  assert.throws(invalid.assertReady, /invalid_config/u)
  assert.equal((await f.call('read', { file_path: 'input.jsonl' })).isError, true)
})
