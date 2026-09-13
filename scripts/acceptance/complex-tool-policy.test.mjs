import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, symlink, link, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '../../runtime/DSH/vendor/cordis/lib/index.js'
import { ToolRuntime } from '../../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt } from '../../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { createScope, scopeTarget } from '../../runtime/DSH/packages/core/scope/lib/index.js'
import { complexPolicy, installComplexToolPolicy, readComplexToolPolicy } from './complex-tool-policy.mjs'

async function fixture(t) {
  const runId = randomUUID(), acceptanceRoot = join(await realpath(tmpdir()), `xiaoshe-product-acceptance-${runId}`)
  await mkdir(acceptanceRoot, { mode: 0o700 })
  t.after(() => rm(acceptanceRoot, { recursive: true, force: true }))
  for (const p of ['workspace', 'tool-policy', 'execution-temp', 'workspace/code-repair/src', 'workspace/code-repair/test',
    'workspace/research/sources', 'workspace/recovery/sources', 'workspace/steer/sources']) await mkdir(join(acceptanceRoot, p), { recursive: true, mode: 0o700 })
  const config = { runId, acceptanceRoot, nodePath: process.execPath, npmPath: '/fixed/npm/bin/npm-cli.js' }
  const policy = complexPolicy(config)
  for (const path of new Set(policy.scenarios.flatMap(row => row.readPaths))) {
    if (!path.endsWith('/missing-note.md')) await writeFile(path, 'synthetic-input\n', { mode: 0o600 })
  }
  const ctx = new Context(), calls = [], sandboxChecks = []
  new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx, { mode: 'native' })
  t.after(() => ctx.fiber.dispose())
  ctx.provide('sandbox', { testOnly: true })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
  const names = new Set([...policy.scenarios.flatMap(row => row.allowedTools), 'subagent', 'cordis_plugin', 'terminal_send', 'sandbox_mode', 'memory_write'])
  for (const name of names) ctx.tools.register({ name, description: name, parameters: { type: 'object', additionalProperties: true },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      calls.push({ name, args })
      if (name === 'read') return { text: await readFile(resolve(exec.agent.session.header.cwd, args.file_path), 'utf8') }
      return { dispatched: true }
    } })
  const installed = installComplexToolPolicy(ctx, config, { assertSandbox: (_provider, identity) => { sandboxChecks.push(identity) } })
  installed.assertReady()
  const agents = policy.scenarios.map(row => {
    const agent = { id: row.id, session: { id: row.sessionId, header: { id: row.sessionId, cwd: row.cwd, agentPreset: 'standard' } } }
    const scope = createScope(ctx, agent); agent.ctx = scope.ctx; t.after(() => scope.dispose())
    return agent
  })
  const publish = agent => ctx.emit(scopeTarget(agent), 'agent/created', { agent })
  const call = (agent, name, args = {}) => ctx.tools.execute({ name, arguments: args, agent, callId: randomUUID(), signal: new AbortController().signal })
  return { acceptanceRoot, config, policy, ctx, agents, publish, call, calls, sandboxChecks }
}

test('each of five real scopes binds its exact cwd and preserves the visible tool catalog', async t => {
  const f = await fixture(t)
  assert.deepEqual(readComplexToolPolicy(join(f.acceptanceRoot, 'tool-policy')).mountedSessionIds, [])
  assert.equal((await f.call(f.agents[0], 'read', { file_path: 'requirements.md' })).isError, true)
  for (const agent of f.agents) f.publish(agent)
  assert.equal(readComplexToolPolicy(join(f.acceptanceRoot, 'tool-policy')).mountedSessionIds.length, 5)
  assert(f.ctx.tools.schemas(f.agents[1]).some(tool => tool.name === 'bash'))
  for (let i = 0; i < 5; i++) assert.equal((await f.call(f.agents[i], 'read', { file_path: f.policy.scenarios[i].readPaths.at(-1) })).isError, false)
  assert.equal((await f.call(f.agents[1], 'read', { file_path: f.policy.scenarios[0].readPaths[0] })).isError, true)
})

test('missing recovery input reaches real filesystem failure, never synthetic preflight rejection', async t => {
  const f = await fixture(t), agent = f.agents[3]; f.publish(agent)
  const failed = await f.call(agent, 'read', { file_path: 'sources/missing-note.md' })
  assert.equal(failed.isError, true)
  assert.match(JSON.stringify(failed), /ENOENT/u)
  assert.doesNotMatch(JSON.stringify(failed), /complex-tool-policy/u)
  assert.equal((await f.call(agent, 'read', { file_path: 'sources/recovery-note.md' })).isError, false)
  assert.deepEqual(f.calls.map(row => row.name), ['read', 'read'])
})

test('only implementation mutation and separate original npm verifiers may dispatch', async t => {
  const f = await fixture(t), agent = f.agents[0]; f.publish(agent)
  for (const name of ['write', 'edit']) {
    assert.equal((await f.call(agent, name, { file_path: 'src/normalize.mjs', content: 'synthetic' })).isError, false)
    for (const file_path of ['package.json', 'test/normalize.test.mjs', 'requirements.md', '../outside.mjs']) {
      assert.equal((await f.call(agent, name, { file_path, content: 'blocked' })).isError, true)
    }
  }
  for (const gate of ['typecheck', 'test', 'build']) assert.equal((await f.call(agent, 'bash', {
    command: `npm run ${gate}`, workdir: agent.session.header.cwd, timeoutMs: 60_000,
  })).isError, false)
  assert.equal(f.sandboxChecks.length, 4, 'one mount plus three actual verifier dispatch checks')
  for (const args of [
    { command: 'npm run test; printenv' }, { command: 'npm run test', env: {} },
    { command: 'npm run test', workdir: '/tmp' }, { command: 'npm run test', run_in_background: true },
    { command: 'npm run test', sandbox_permissions: 'danger-full-access' },
    { command: 'node test/normalize.test.mjs' }, { command: 'npm run test', shell: '/bin/zsh' },
  ]) assert.equal((await f.call(agent, 'bash', args)).isError, true)
  assert.equal(f.sandboxChecks.length, 4)
})

test('read-only scenarios cannot write, execute, delegate or configure; web confined to online scenario', async t => {
  const f = await fixture(t)
  for (const agent of f.agents) f.publish(agent)
  for (const agent of f.agents.slice(1)) for (const name of ['write', 'edit', 'bash', 'subagent', 'cordis_plugin', 'terminal_send', 'sandbox_mode', 'memory_write']) {
    assert.equal((await f.call(agent, name, { file_path: 'sources/recovery-note.md', command: 'npm run test' })).isError, true)
  }
  for (const agent of f.agents.filter((_, i) => i !== 2)) assert.equal((await f.call(agent, 'web_search', { queries: ['weather Shanghai'] })).isError, true)
  assert.equal((await f.call(f.agents[2], 'web_search', { queries: ['weather Shanghai'] })).isError, false)
  assert.equal((await f.call(f.agents[2], 'web_fetch', { url: 'https://example.com/weather' })).isError, false)
  for (const args of [{ url: 'file:///etc/passwd' }, { url: 'https://user:pass@example.com/' }, { url: 'https://example.com/', method: 'POST' }]) {
    assert.equal((await f.call(f.agents[2], 'web_fetch', args)).isError, true)
  }
})

test('symlink/hardlink file aliases and parent symlinks cannot cross the read or write fence', async t => {
  const f = await fixture(t), agent = f.agents[0]; f.publish(agent)
  const path = join(agent.session.header.cwd, 'src/normalize.mjs'), outside = join(f.acceptanceRoot, 'synthetic-secret')
  await writeFile(outside, 'never-read-me')
  for (const makeAlias of [symlink, link]) {
    await rm(path); await makeAlias(outside, path)
    assert.equal((await f.call(agent, 'read', { file_path: path })).isError, true)
    assert.equal((await f.call(agent, 'write', { file_path: path, content: 'blocked' })).isError, true)
  }
  await rm(join(agent.session.header.cwd, 'src'), { recursive: true })
  await symlink(f.acceptanceRoot, join(agent.session.header.cwd, 'src'))
  assert.equal((await f.call(agent, 'write', { file_path: path, content: 'blocked' })).isError, true)
  assert.deepEqual(f.calls, [])
  assert.equal(await readFile(outside, 'utf8'), 'never-read-me')
})

test('late permissive hooks cannot override denial; unsafe session mode prevents bash dispatch', async t => {
  const f = await fixture(t), agent = f.agents[0]; f.publish(agent)
  f.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { global: true })
  assert.equal((await f.call(agent, 'subagent')).isError, true)
  f.ctx.sandboxPolicy.resolve = () => ({ mode: 'danger-full-access' })
  assert.equal((await f.call(agent, 'bash', { command: 'npm run test' })).isError, true)
  assert.deepEqual(f.calls, [])
})

test('foreign agent identity or ledger corruption latches execution closed', async t => {
  const f = await fixture(t), agent = f.agents[0]
  agent.session.header.cwd = f.acceptanceRoot
  assert.throws(() => f.publish(agent), /agent_identity_not_allowed/u)
  assert.equal((await f.call(agent, 'todo_write', { todos: [] })).isError, true)
  const g = await fixture(t); g.publish(g.agents[0])
  await writeFile(join(g.acceptanceRoot, 'tool-policy/manifest.json'), '{}\n', { mode: 0o600 })
  assert.equal((await g.call(g.agents[0], 'read', { file_path: 'requirements.md' })).isError, true)
  assert.throws(() => readComplexToolPolicy(join(g.acceptanceRoot, 'tool-policy')), /invalid_config/u)
  assert.deepEqual(g.calls, [])
})
