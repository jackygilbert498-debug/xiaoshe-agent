import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { ToolRuntime } from '../../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt } from '../../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { createScope, scopeTarget } from '../../runtime/DSH/packages/core/scope/lib/index.js'
import { apply as applyTodo } from '../../runtime/DSH/packages/todo/tool-todo/lib/index.js'
import { ALLOWED_TOOLS, installLiveFileToolPolicy, readLiveFileToolPolicyLedger } from './live-file-tool-policy.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xs-file-tool-policy-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { workspaceRealPath: join(root, 'workspace'), ledgerDirectory: join(root, 'tool-policy'), runId: randomUUID(), sessionIds: ['isolated-session'] }
  await mkdir(join(config.workspaceRealPath, 'output'), { recursive: true })
  await mkdir(config.ledgerDirectory)
  await writeFile(join(config.workspaceRealPath, 'input.jsonl'), '{"value":7}\n')
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx, { mode: 'native' })
  t.after(() => ctx.fiber.dispose())
  const calls = [], sessionEvents = []
  for (const name of [...ALLOWED_TOOLS.filter(name => name !== 'todo_write'), 'bash', 'web_fetch', 'subagent', 'cordis_plugin', 'unrelated_tool']) {
    ctx.tools.register({ name, description: name, parameters: { type: 'object', additionalProperties: true },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) {
        calls.push(name)
        if (name === 'read') return { text: await readFile(resolve(config.workspaceRealPath, args.file_path), 'utf8') }
        if (name === 'write') { await writeFile(resolve(config.workspaceRealPath, args.file_path), args.content); return { written: true } }
        return {}
      },
    })
  }
  applyTodo(ctx, { allowParallelInProgress: false })
  const policy = installLiveFileToolPolicy(ctx, config)
  policy.assertReady()
  const agent = { id: 'agent', session: { id: config.sessionIds[0], header: { id: config.sessionIds[0], cwd: config.workspaceRealPath, agentPreset: 'standard' },
    append(type, data) { sessionEvents.push({ type, data }) } } }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  t.after(() => scope.dispose())
  const publish = () => ctx.emit(scopeTarget(agent), 'agent/created', { agent })
  const call = (name, args = {}, caller = agent) => ctx.tools.execute({ name, arguments: args, agent: caller, callId: randomUUID(), signal: new AbortController().signal })
  return { root, config, ctx, calls, sessionEvents, policy, agent, publish, call }
}

test('real todo tool can record the required plan without widening either file boundary', async t => {
  const { config, calls, sessionEvents, publish, call } = await fixture(t)
  const todos = [{ content: 'Read the isolated input', status: 'in_progress' },
    { content: 'Write and verify the isolated result', status: 'pending' }]
  assert.equal((await call('todo_write', { todos })).isError, true, 'planning also requires the mounted owning agent')
  publish()
  const before = readLiveFileToolPolicyLedger(config.ledgerDirectory)
  const plan = await call('todo_write', { todos })
  assert.equal(plan.isError, false)
  assert.deepEqual(plan.value.todos, todos)
  assert.deepEqual(plan.value.counts, { pending: 1, inProgress: 1, completed: 0 })
  assert.deepEqual(sessionEvents, [{ type: 'todo/write', data: { todos } }])
  // The real tool ignores extra top-level fields and rejects extra item fields.
  // Neither form can change the separate file dispatch fence or touch a file.
  for (const args of [
    { todos, filePath: '../not-allowed.json' },
    { todos, file_path: '../not-allowed.json' },
  ]) {
    assert.equal((await call('todo_write', args)).isError, false)
    assert.deepEqual(sessionEvents.at(-1), { type: 'todo/write', data: { todos } })
  }
  for (const args of [
    { todos: [{ ...todos[0], filePath: '../not-allowed.json' }] },
    { todos: [{ ...todos[0], file_path: '../not-allowed.json' }] },
  ]) assert.equal((await call('todo_write', args)).isError, true)
  assert.equal(sessionEvents.length, 3)
  assert.deepEqual(calls, [])
  for (const file_path of ['input.jsonl', 'output/other.json', '../not-allowed.json']) {
    assert.equal((await call('write', { file_path, filePath: 'output/result.json', content: '{}' })).isError, true)
  }
  assert.equal((await call('write', { filePath: 'output/result.json', content: '{}' })).isError, true)
  assert.equal((await call('write', { file_path: 'output/result.json', content: '{"ok":true}' })).isError, false)
  assert.deepEqual(calls, ['write'])
  const after = readLiveFileToolPolicyLedger(config.ledgerDirectory)
  assert.deepEqual(after.readPaths, before.readPaths)
  assert.deepEqual(after.writePaths, before.writePaths)
  assert.equal(after.policyDigest, before.policyDigest)
})

test('real ToolRuntime preserves the full catalog and fences actual scoped file dispatch', async t => {
  const { config, ctx, agent, calls, publish, call } = await fixture(t)
  assert.equal(readLiveFileToolPolicyLedger(config.ledgerDirectory).mounted, false)
  assert.equal((await call('read', { file_path: 'input.jsonl' })).isError, true)
  publish()
  const names = ctx.tools.schemas(agent).map(row => row.name)
  assert(names.includes('bash'))
  assert(names.includes('subagent'))
  assert.equal((await call('read', { file_path: join(config.workspaceRealPath, 'input.jsonl') })).value.text, '{"value":7}\n')
  assert.equal((await call('write', { file_path: 'output/result.json', content: '{"sum":7}' })).isError, false)
  assert.equal((await call('read', { file_path: 'output/result.json' })).value.text, '{"sum":7}')
  assert.equal((await call('xiaoshe_capability_plan', { goal: 'read input and write result' })).isError, false)
  assert.equal((await call('xiaoshe_runtime_info')).isError, false)
  for (const name of ['bash', 'web_fetch', 'subagent', 'cordis_plugin', 'unrelated_tool']) assert.equal((await call(name)).isError, true, name)
  assert.deepEqual(calls, ['read', 'write', 'read', 'xiaoshe_capability_plan', 'xiaoshe_runtime_info'])
  const ledger = readLiveFileToolPolicyLedger(config.ledgerDirectory)
  assert.equal(ledger.mounted, true)
  assert.equal(ledger.mounts.length, 2)
  assert(ledger.mounts.some(row => row.kind === 'agent' && row.sessionId === config.sessionIds[0] && row.pid === process.pid && row.runId === config.runId))
})

test('a later permissive pre-execute listener cannot undo the monotonic guard', async t => {
  const { ctx, calls, publish, call } = await fixture(t)
  publish()
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { global: true })
  assert.equal((await call('bash', { command: 'must never execute' })).isError, true)
  assert.deepEqual(calls, [])
})

test('exact input/output paths, read boundaries, escalation and symlink ancestors fail closed', async t => {
  const { root, config, calls, publish, call } = await fixture(t)
  publish()
  for (const [name, args] of [
    ['read', { file_path: '../tool-policy/manifest.json' }],
    ['read', { file_path: '/etc/passwd' }],
    ['write', { file_path: 'input.jsonl', content: 'overwrite' }],
    ['write', { file_path: 'output/other.json', content: 'unexpected' }],
    ['write', { file_path: 'output/result.json', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'test' }],
  ]) assert.equal((await call(name, args)).isError, true)
  await writeFile(join(root, 'secret.txt'), 'fixture secret, not a real credential')
  await rm(join(config.workspaceRealPath, 'input.jsonl'))
  await symlink(join(root, 'secret.txt'), join(config.workspaceRealPath, 'input.jsonl'))
  assert.equal((await call('read', { file_path: 'input.jsonl' })).isError, true)
  await rm(join(config.workspaceRealPath, 'output'), { recursive: true })
  await symlink(root, join(config.workspaceRealPath, 'output'), 'dir')
  assert.equal((await call('write', { file_path: 'output/result.json', content: 'x' })).isError, true)
  assert.deepEqual(calls, [])
})

test('foreign session, agentless dispatch and an unmounted scope cannot execute', async t => {
  const { ctx, agent, config, calls, publish, call } = await fixture(t)
  publish()
  assert.equal((await ctx.tools.execute({ name: 'read', arguments: { file_path: 'input.jsonl' }, callId: randomUUID(), signal: new AbortController().signal })).isError, true)
  const other = { ...agent, id: 'other' }
  assert.equal((await call('read', { file_path: 'input.jsonl' }, other)).isError, true)
  const foreign = { id: 'foreign', session: { id: 'foreign', header: { id: 'foreign', cwd: config.workspaceRealPath, agentPreset: 'standard' } } }
  const scope = createScope(ctx, foreign); foreign.ctx = scope.ctx; t.after(() => scope.dispose())
  assert.throws(() => ctx.emit(scopeTarget(foreign), 'agent/created', { agent: foreign }), /agent_identity_not_allowed/)
  assert.equal((await call('read', { file_path: 'input.jsonl' })).isError, true, 'creation fault latches every request closed')
  assert.deepEqual(calls, [])
})

test('wrong cwd, preset, delegation lineage or scope cannot publish a passing mount', async t => {
  for (const change of [
    { cwd: '/not-this-workspace' }, { agentPreset: 'code' }, { parentSession: 'foreign' }, { origin: 'subagent' },
  ]) {
    const { config, agent, publish, call, calls } = await fixture(t)
    Object.assign(agent.session.header, change)
    assert.throws(publish, /agent_identity_not_allowed/)
    assert.equal(readLiveFileToolPolicyLedger(config.ledgerDirectory).mounted, false)
    assert.equal((await call('read', { file_path: 'input.jsonl' })).isError, true)
    assert.deepEqual(calls, [])
  }
  const { config, ctx, agent, publish } = await fixture(t)
  agent.ctx = ctx
  assert.throws(publish, /scoped_tools_unavailable/)
  assert.equal(readLiveFileToolPolicyLedger(config.ledgerDirectory).mounted, false)
})

test('agent mount without its process host mount does not prove a guarded process', async t => {
  const { config, publish } = await fixture(t)
  publish()
  const ledger = readLiveFileToolPolicyLedger(config.ledgerDirectory)
  await rm(join(config.ledgerDirectory, ledger.mounts.find(row => row.kind === 'host').file))
  assert.equal(readLiveFileToolPolicyLedger(config.ledgerDirectory).mounted, false)
})

test('ledger corruption cannot masquerade as an active guard or allow an existing agent', async t => {
  const { config, calls, publish, call } = await fixture(t)
  publish()
  const ledger = readLiveFileToolPolicyLedger(config.ledgerDirectory)
  const mount = ledger.mounts.find(row => row.kind === 'agent')
  const mountPath = join(config.ledgerDirectory, mount.file)
  const original = JSON.parse(await readFile(mountPath, 'utf8'))
  await writeFile(mountPath, JSON.stringify({ ...original, sessionId: 'foreign' }))
  assert.throws(() => readLiveFileToolPolicyLedger(config.ledgerDirectory), /invalid_mount_record/)
  await writeFile(join(config.ledgerDirectory, 'manifest.json'), '{}')
  assert.equal((await call('read', { file_path: 'input.jsonl' })).isError, true)
  assert.deepEqual(calls, [])
})

test('invalid initialization leaves a denying guard installed instead of silently removing it', async t => {
  const { ctx, config, calls, publish, call } = await fixture(t)
  publish()
  const invalid = installLiveFileToolPolicy(ctx, { ...config, sessionIds: [] })
  assert.throws(() => invalid.assertReady(), /invalid_config/)
  assert.equal((await call('read', { file_path: 'input.jsonl' })).isError, true)
  assert.deepEqual(calls, [])
})
