import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { SessionStore } from '../runtime/DSH/packages/core/session/lib/index.js'
import { SystemPrompt } from '../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { ToolRuntime } from '../runtime/DSH/packages/core/tools/lib/index.js'
import { WorkerThreadCodeRuntime } from '../runtime/DSH/packages/code-runtime/code-runtime-worker-thread/lib/index.js'
import { createToolResultMessage, createUserMessage } from '../runtime/DSH/packages/llm/llm/lib/index.js'
import { scopeTarget } from '../runtime/DSH/packages/core/scope/lib/index.js'
import { createVerificationPolicy } from '../packages/verification-policy/lib/index.js'
import { foldCompletionReceipt } from '../packages/completion-receipt/lib/index.js'

// Exercise the shipped spawn entry. The backend worker deliberately does not
// inherit TS loaders, so source-only imports cannot verify this deployment path.
const plugin = await import('../dist/plugins/pure-js-probe.js')
const { apply: applyVerification } = await import('../dist/plugins/verification-results.js')
const { apply: applyReliability } = await import('../dist/plugins/agent-reliability.js')
const workspace = fileURLToPath(new URL('./fixtures/pure-js-probe/', import.meta.url))
const input = { module: 'entry.mjs', files: ['numbers.mjs'], exportName: 'summarize', cases: [
  { name: 'sum', args: [[1, 2, 4]], expect: { count: 3, total: 7 }, immutable: true },
  { name: 'empty', args: [[]], expect: { count: 0, total: 0 }, immutable: true },
  { name: 'invalid', args: [['not-a-number']], throws: 'TypeError', immutable: true },
] }

async function fixture(t, mode = 'native') {
  const ctx = new Context()
  new SessionStore(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  if (mode === 'code') new WorkerThreadCodeRuntime(ctx, { computeMs: 10_000, maxWallMs: 20_000,
    maxOutputBytes: 1_000_000, maxOldGenerationSizeMb: 64 })
  new ToolRuntime(ctx, { mode })
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(plugin)
  const session = ctx.sessions.create(`pure-probe-${crypto.randomUUID()}`, { meta: { cwd: workspace } })
  const agent = { id: session.id, ctx, session }
  return { ctx, session, agent, execute: (args, options = {}) => ctx.tools.execute({
    name: 'pure_js_probe', arguments: args, agent, callId: crypto.randomUUID(),
    signal: new AbortController().signal, ...options,
  }) }
}

test('pure JS probe native registration executes actual cross-module cases without project writes', async t => {
  const { ctx, agent, execute } = await fixture(t)
  assert(ctx.tools.schemas(agent).some(tool => tool.name === 'pure_js_probe'))
  const before = await Promise.all(['entry.mjs', 'numbers.mjs'].map(file => readFile(new URL(`./fixtures/pure-js-probe/${file}`, import.meta.url), 'utf8')))
  const result = await execute(input)
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.status, 'passed', JSON.stringify(result.value))
  assert.equal(result.value.runtime, 'quickjs-snapshot')
  assert.deepEqual(result.value.cases.map(item => item.pass), [true, true, true])
  assert.deepEqual(result.value.modules.map(item => item.relativePath).sort(), ['entry.mjs', 'numbers.mjs'])
  assert.equal(result.value.modules.every(item => /^[a-f0-9]{64}$/u.test(item.sha256)), true)
  const after = await Promise.all(['entry.mjs', 'numbers.mjs'].map(file => readFile(new URL(`./fixtures/pure-js-probe/${file}`, import.meta.url), 'utf8')))
  assert.deepEqual(after, before)
  const failed = await execute({ ...input, cases: [{ args: [[1]], expect: { count: 1, total: 99 } }] })
  assert.equal(failed.isError, false)
  assert.equal(failed.value.status, 'failed')
  assert.equal(failed.value.cases[0].pass, false)
})

test('pure JS probe CodeMode registration calls the same trusted backend through a nested tool', async t => {
  const { ctx, agent } = await fixture(t, 'code')
  assert(ctx.tools.schemas(agent).some(tool => tool.name === 'pure_js_probe'))
  const result = await ctx.tools.execute({ name: 'run_code', arguments: {
    code: `return await tools.pure_js_probe(${JSON.stringify(input)})`, description: 'Check pure module snapshots',
  }, agent, callId: crypto.randomUUID(), signal: new AbortController().signal })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.result.runtime, 'quickjs-snapshot')
  assert.equal(result.value.result.status, 'passed', JSON.stringify(result.value.result))
  assert.deepEqual(result.value.result.cases.map(item => item.pass), [true, true, true])
})

test('pure JS probe rejects model-controlled workspace and missing trusted session identity', async t => {
  const { ctx, agent, execute } = await fixture(t)
  assert(ctx.tools.schemas(agent).some(tool => tool.name === 'pure_js_probe'))
  for (const args of [{ ...input, workspace }, { ...input, cases: [] },
    { ...input, cases: Array.from({ length: 33 }, () => ({ args: [], expect: null })) },
    { ...input, cases: [{ args: [], expect: null, throws: 'TypeError' }] },
    { ...input, cases: [{ args: [] }] }]) {
    const result = await execute(args)
    assert.equal(result.isError, true, JSON.stringify(args))
  }
  assert.equal((await execute(input, { agent: undefined })).isError, true)
  assert.equal((await execute(input, { agent: { id: 'no-cwd', session: { header: {} } } })).isError, true)
  assert.equal((await execute(input, { agent: { id: 'relative-cwd', session: { header: { cwd: '.' } } } })).isError, true)
})

test('pure JS probe uses each invoking session workspace instead of cached or process cwd', async t => {
  const { ctx, execute } = await fixture(t)
  const other = ctx.sessions.create(`other-probe-${crypto.randomUUID()}`, { meta: { cwd: join(workspace, 'other-session') } })
  const result = await execute({ module: 'entry.mjs', exportName: 'summarize',
    cases: [{ args: [], expect: 'other-session' }] }, { agent: { id: other.id, session: other, ctx } })
  assert.equal(result.isError, false)
  assert.equal(result.value.status, 'passed', JSON.stringify(result.value))
  assert.equal((await execute(input)).value.status, 'passed')
})

test('pure JS probe forwards cancellation to the runner instead of relying on outer tool masking', async t => {
  const { ctx, agent } = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  // Invoke the registered callback so ToolRuntime's own early-abort path cannot
  // hide a missing signal at the plugin → runner ownership boundary.
  const result = await ctx.tools.get('pure_js_probe', agent).execute(input, { agent, signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(result.cases, [])
})

test('pure JS probe success cannot mint project gates or retire an earlier opaque effect', async t => {
  const { ctx, session, agent } = await fixture(t)
  ctx.provide('xiaosheVerificationPolicy', createVerificationPolicy())
  applyReliability(ctx)
  applyVerification(ctx)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const message = createUserMessage({ content: [{ type: 'text', text: '修复 JavaScript 项目 src 模块并验证结果。' }], source: { kind: 'user' } })
  ctx.emit(scopeTarget(agent, agent), 'agent/inbox/claimed', { agent, message })
  session.append('user/message', message, { surfaceOp: 'append' })
  ctx.emit(scopeTarget(agent, agent), 'agent/assistant-stream', { agent, frame: { type: 'start' } })
  // Durable pre-existing effects are historical test inputs; no shell program
  // or project mutation is executed just to manufacture verification debt.
  for (const [callId, name, args] of [
    ['prior-write', 'write', { file_path: 'entry.mjs', content: 'changed source' }],
    ['prior-opaque', 'pwsh', { command: 'node -e "console.log(1)"' }],
  ]) {
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
    session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'completed' }], isError: false }) },
    { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  }
  const before = ctx.get('xiaosheVerificationProgress', false).reconcile(agent)
  assert.equal(before.status, 'pending')
  assert.equal(before.unknownEffectCount, 1)
  assert.deepEqual(before.missingGates, ['build', 'test', 'typecheck'])
  const callId = 'supplemental-probe'
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'pure_js_probe', arguments: JSON.stringify(input) })
  const result = await ctx.tools.execute({ name: 'pure_js_probe', arguments: input, agent, callId,
    signal: new AbortController().signal })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.status, 'passed', JSON.stringify(result.value))
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: result.content, isError: result.isError }) },
  { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const after = ctx.get('xiaosheVerificationProgress', false).reconcile(agent)
  assert.deepEqual(after, before)
  assert.equal(session.snapshotEvents().filter(event => event.type === 'verification/result').length, 0)
  const receipt = foldCompletionReceipt(session.snapshotEvents())
  assert.notEqual(receipt.outcome, 'verified')
  assert(receipt.unverified.length > 0)
})
