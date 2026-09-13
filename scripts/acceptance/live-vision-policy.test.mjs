import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { ToolRuntime } from '../../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt } from '../../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { createScope, scopeTarget } from '../../runtime/DSH/packages/core/scope/lib/index.js'
import { installLiveVisionPolicy, readLiveVisionPolicyLedger, META_TOOLS, PATH_TOOLS } from './live-vision-policy.mjs'

async function fixture(t, inputKind = 'path', changes = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xs-vision-policy-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaceRealPath = join(root, 'workspace'), ledgerDirectory = join(root, 'ledger'), runId = randomUUID()
  await mkdir(workspaceRealPath); await mkdir(ledgerDirectory)
  // Deliberately not visual evidence: this test proves byte/path identity and
  // ToolRuntime authorization only. No decoder, ModLens CLI or model is run.
  const bytes = Buffer.from('synthetic image bytes for offline policy')
  const imagePath = join(workspaceRealPath, 'input.png')
  await writeFile(imagePath, bytes)
  const config = { workspaceRealPath, ledgerDirectory, runId, sessionId: `xiaoshe-vision-${runId}`,
    inputKind, imageSha256: createHash('sha256').update(bytes).digest('hex'), ...changes }
  const ctx = new Context(); new SystemPrompt(ctx, {}); new ToolRuntime(ctx, { mode: 'native' }); t.after(() => ctx.fiber.dispose())
  const calls = []
  const register = name => ctx.tools.register({ name, description: name,
    parameters: { type: 'object', additionalProperties: true },
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'offline dispatch observed' }] },
    async execute(args) { calls.push({ name, args }); return { observed: name } } })
  for (const name of [...PATH_TOOLS, 'read', 'read_image', 'write', 'bash', 'browser_open', 'browser_snapshot',
    'web_fetch', 'web_search', 'todo_write', 'subagent', 'cordis_plugin']) register(name)
  const before = ctx.tools.schemas().map(row => row.name)
  const policy = installLiveVisionPolicy(ctx, config)
  const agent = { id: 'offline-vision-agent', session: { id: config.sessionId,
    header: { id: config.sessionId, cwd: workspaceRealPath, agentPreset: 'standard' } } }
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx; t.after(() => scope.dispose())
  const publish = () => ctx.emit(scopeTarget(agent), 'agent/created', { agent })
  const call = (name, args = {}, caller = agent) => ctx.tools.execute({ name, arguments: args,
    agent: caller, callId: randomUUID(), signal: new AbortController().signal })
  return { root, config, ctx, policy, agent, scope, publish, call, calls, before, bytes, imagePath, register }
}

test('path policy mounts real host/agent guards and permits only exact native image read plus two meta tools', async t => {
  const f = await fixture(t); f.policy.assertReady()
  assert.equal(readLiveVisionPolicyLedger(f.config.ledgerDirectory).mounted, false)
  assert.equal((await f.call('modlens_read_image', { path: f.imagePath })).isError, true)
  f.publish()
  assert.equal((await f.call('modlens_read_image', { path: f.imagePath, prompt: 'only the synthetic question' })).isError, false)
  for (const name of META_TOOLS) assert.equal((await f.call(name)).isError, false)
  for (const name of f.before.filter(name => !PATH_TOOLS.includes(name))) assert.equal((await f.call(name, { path: f.imagePath })).isError, true, name)
  assert.deepEqual(f.ctx.tools.schemas(f.agent).map(row => row.name), f.before)
  f.register('later_network_tool')
  assert(f.ctx.tools.schemas(f.agent).some(row => row.name === 'later_network_tool'))
  assert.equal((await f.call('later_network_tool')).isError, true)
  const ledger = readLiveVisionPolicyLedger(f.config.ledgerDirectory)
  assert.equal(ledger.mounted, true); assert.equal(ledger.imagePath, f.imagePath)
  assert.deepEqual(ledger.allowedTools, PATH_TOOLS)
  assert.deepEqual(ledger.mounts.map(row => row.kind).sort(), ['agent', 'host'])
  assert(ledger.mounts.every(row => row.pid === process.pid && row.runId === f.config.runId))
  assert.equal(f.calls.length, 3)
})

test('attachment mode has no native read or other execution tool; original catalog stays visible', async t => {
  const f = await fixture(t, 'attachment'); f.publish()
  for (const name of f.before) assert.equal((await f.call(name, { path: f.imagePath })).isError, !META_TOOLS.includes(name), name)
  assert.deepEqual(f.ctx.tools.schemas(f.agent).map(row => row.name), f.before)
  assert.deepEqual(readLiveVisionPolicyLedger(f.config.ledgerDirectory).allowedTools, META_TOOLS)
  assert.equal(f.calls.length, 2)
})

test('relative aliases, URLs, other paths, alternate argument names and escalation cannot invoke native reader', async t => {
  const f = await fixture(t); f.publish()
  for (const args of [{ path: 'input.png' }, { path: `${f.config.workspaceRealPath}/./input.png` },
    { path: '../input.png' }, { path: '/etc/passwd' }, { path: `${f.imagePath}#part` },
    { path: 'https://example.invalid/image.png' }, { path: `file://${f.imagePath}` },
    { file_path: f.imagePath }, { path: f.imagePath, filePath: '/other' },
    { path: f.imagePath, sandbox_permissions: 'danger-full-access' }, { path: f.imagePath, justification: 'override' }]) {
    assert.equal((await f.call('modlens_read_image', args)).isError, true)
  }
  assert.deepEqual(f.calls, [])
})

test('changed, missing, symbolic-linked and hard-linked input bytes all fail closed before dispatch', async t => {
  for (const type of ['changed', 'missing', 'symlink', 'hardlink']) {
    const f = await fixture(t); f.publish()
    if (type === 'changed') await writeFile(f.imagePath, 'different input bytes')
    else if (type === 'missing') await rm(f.imagePath)
    else if (type === 'symlink') {
      const saved = join(f.root, 'owned-image.png'); await rename(f.imagePath, saved); await symlink(saved, f.imagePath)
    } else await link(f.imagePath, join(f.root, 'owned-image-link.png'))
    assert.equal((await f.call('modlens_read_image', { path: f.imagePath })).isError, true, type)
    assert.deepEqual(f.calls, [])
    assert.throws(f.policy.assertReady)
  }
})

test('inherited restrict and guards win even over later permissive pre-execute middleware', async t => {
  const f = await fixture(t)
  f.scope.ctx.tools.restrict({ deny: ['modlens_read_image'] })
  f.scope.ctx.tools.guard(exec => exec.name === 'xiaoshe_runtime_info' ? 'independent-product-guard' : undefined)
  f.publish(); f.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { global: true })
  assert.equal((await f.call('modlens_read_image', { path: f.imagePath })).isError, true)
  assert.equal((await f.call('xiaoshe_runtime_info')).isError, true)
  assert.equal((await f.call('bash')).isError, true)
  assert.deepEqual(f.calls, [])
})

test('agentless, cloned, disposed and changed-cwd scopes cannot borrow a valid mount', async t => {
  const f = await fixture(t); f.publish()
  assert.equal((await f.ctx.tools.execute({ name: 'xiaoshe_runtime_info', arguments: {}, callId: randomUUID(), signal: AbortSignal.timeout(1000) })).isError, true)
  assert.equal((await f.call('xiaoshe_runtime_info', {}, { ...f.agent })).isError, true)
  f.agent.session.header.cwd = f.root
  assert.equal((await f.call('xiaoshe_runtime_info')).isError, true)
  f.agent.session.header.cwd = f.config.workspaceRealPath
  f.agent.ctx = f.ctx
  assert.equal((await f.call('xiaoshe_runtime_info')).isError, true)
  f.agent.ctx = f.scope.ctx
  f.ctx.emit(scopeTarget(f.agent), 'agent/disposed', { agent: f.agent })
  assert.equal((await f.call('xiaoshe_runtime_info')).isError, true)
  assert.deepEqual(f.calls, [])
})

test('foreign identity, preset, lineage and unscoped agent creation latch closed', async t => {
  for (const change of [{ id: 'foreign' }, { agentPreset: 'code' }, { parentSession: 'parent' }, { origin: 'subagent' }]) {
    const f = await fixture(t); Object.assign(f.agent.session.header, change)
    assert.throws(f.publish, /agent_identity_not_allowed/)
    assert.equal(readLiveVisionPolicyLedger(f.config.ledgerDirectory).mounted, false)
    assert.equal((await f.call('xiaoshe_runtime_info')).isError, true)
  }
  const f = await fixture(t); f.agent.ctx = f.ctx
  assert.throws(f.publish, /agent_identity_not_allowed/)
})

test('manifest/mount tampering is fully read, cannot widen permissions and stays closed after restoration', async t => {
  const f = await fixture(t); f.publish()
  const path = join(f.config.ledgerDirectory, 'manifest.json'), original = await readFile(path, 'utf8')
  const value = JSON.parse(original); value.allowedTools.push('bash')
  await writeFile(path, JSON.stringify(value))
  assert.throws(() => readLiveVisionPolicyLedger(f.config.ledgerDirectory), /invalid_policy_manifest/)
  assert.equal((await f.call('xiaoshe_runtime_info')).isError, true)
  await writeFile(path, original)
  assert.throws(f.policy.assertReady, /invalid_policy_manifest/)
  assert.deepEqual(f.calls, [])
  for (const kind of ['host', 'agent']) {
    const mounted = await fixture(t); mounted.publish()
    const rows = readLiveVisionPolicyLedger(mounted.config.ledgerDirectory).mounts
    await rm(join(mounted.config.ledgerDirectory, rows.find(row => row.kind === kind).file))
    assert.equal(readLiveVisionPolicyLedger(mounted.config.ledgerDirectory).mounted, false)
    assert.equal((await mounted.call('xiaoshe_runtime_info')).isError, true)
  }
})

test('unexpected files, forged mount sessions and linked ledger records cannot become valid evidence', async t => {
  for (const type of ['extra', 'mount', 'linked']) {
    const f = await fixture(t); f.publish()
    if (type === 'extra') await writeFile(join(f.config.ledgerDirectory, 'unexpected.json'), '{}')
    else if (type === 'mount') {
      const row = readLiveVisionPolicyLedger(f.config.ledgerDirectory).mounts.find(row => row.kind === 'agent')
      const path = join(f.config.ledgerDirectory, row.file), value = JSON.parse(await readFile(path, 'utf8'))
      value.sessionId = 'foreign'; await writeFile(path, JSON.stringify(value))
    } else await link(join(f.config.ledgerDirectory, 'manifest.json'), join(f.root, 'owned-manifest-link.json'))
    assert.throws(() => readLiveVisionPolicyLedger(f.config.ledgerDirectory))
    assert.equal((await f.call('xiaoshe_runtime_info')).isError, true)
    assert.deepEqual(f.calls, [])
  }
})

test('private config snapshot and directory inode checks prevent widening after installation', async t => {
  const f = await fixture(t); f.publish()
  Object.assign(f.config, { sessionId: 'foreign', inputKind: 'attachment', imageSha256: '0'.repeat(64) })
  assert.equal((await f.call('modlens_read_image', { path: f.imagePath })).isError, false)
  await rename(f.config.workspaceRealPath, join(f.root, 'owned-old-workspace'))
  await mkdir(f.config.workspaceRealPath); await writeFile(f.imagePath, f.bytes)
  assert.equal((await f.call('xiaoshe_runtime_info')).isError, true)
  assert.throws(f.policy.assertReady, /directory_identity_changed/)
})

test('invalid config and failed mounting leave a host-wide rejecting guard, not an unguarded tool runtime', async t => {
  for (const change of [{ inputKind: 'url' }, { imageSha256: '0'.repeat(64) }, { sessionId: 'daily' },
    { allowedTools: ['bash'] }, { imagePath: '/elsewhere.png' }]) {
    const f = await fixture(t, 'path', change)
    assert.throws(f.policy.assertReady)
    assert.equal((await f.call('xiaoshe_runtime_info')).isError, true)
    assert.deepEqual(f.calls, [])
  }
})
