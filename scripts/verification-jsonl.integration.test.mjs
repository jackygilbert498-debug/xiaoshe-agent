import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { SessionStore } from '../runtime/DSH/packages/core/session/lib/index.js'
import { ToolRuntime } from '../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt } from '../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { createToolResultMessage, createAssistantMessage } from '../runtime/DSH/packages/llm/llm/lib/index.js'
import { scopeTarget } from '../runtime/DSH/packages/core/scope/lib/index.js'
import { foldCompletionReceipt } from '../packages/completion-receipt/lib/index.js'
import LocalFileSystem from '../runtime/DSH/packages/fs/fs-local/lib/index.js'
import * as fsTools from '../runtime/DSH/packages/fs/tool-fs/lib/index.js'
import { createVerificationPolicy, isJsonlDataPath } from '../packages/verification-policy/lib/index.js'
import { apply } from '../dist/plugins/verification-results.js'
import { prepareJsonlMutation, captureJsonlMutation, captureJsonlRead } from '../dist/plugins/verification-jsonl.js'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xs-jsonl-verification-')))
  const workspace = join(root, 'workspace'), data = join(root, 'data')
  await mkdir(workspace); await mkdir(data)
  const path = join(data, 'records.jsonl') // authorized absolute path outside session cwd
  const original = Array.from({ length: 4044 }, (_, id) => ({ id, prompt: id < 48 ? 'old 中文' : '保持',
    english: 'Preserve this English text.', video: `${id}.mp4`, fps: 24, nested: { active: true } }))
  const content = original.map(row => JSON.stringify(row)).join('\n') + '\n'
  await writeFile(path, content)
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  ctx.logger.exporter({ levels: { default: 0 }, export() {} })
  new SessionStore(ctx); new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx, { mode: 'native' })
  new LocalFileSystem(ctx, { cwd: workspace, diffBasisMaxBytes: 8 * 1024 * 1024 })
  fsTools.apply(ctx, { readLimit: 2000, readMaxLineLength: 10000, readMaxBytes: 8 * 1024 * 1024, readStreamMinSize: 1024 * 1024 })
  ctx.provide('xiaosheVerificationPolicy', createVerificationPolicy())
  ctx.provide('xiaosheAgentReliability', { snapshot: () => ({ taskGeneration: 1, evidenceRevision: 0, callGeneration: () => undefined }) })
  apply(ctx)
  const session = ctx.sessions.create('jsonl-real-tools', { meta: { cwd: workspace } })
  const steers = []
  const agent = { id: 'jsonl-agent', ctx, session, steer(message) { steers.push(message) } }
  session.append('xiaoshe/task-generation', { version: 1, generation: 1, relation: 'new', triggerMessageId: 'goal-1' })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  let count = 0
  async function call(name, args) {
    const callId = `call-${++count}`
    const event = session.append('tool/call', { turn: 1, step: count, callId, name, arguments: JSON.stringify(args) })
    const result = await ctx.tools.execute({ callId, name, arguments: args, agent, signal: new AbortController().signal })
    session.append('tool/result', { turn: 1, step: count,
      message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
      ...(result.meta ? { meta: result.meta } : {}),
    }, { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
    assert.equal(result.isError, false, JSON.stringify(result))
    return callId
  }
  return { root, workspace, path, original, content, ctx, session, agent, call, steers,
    progress: () => ctx.xiaosheVerificationProgress.reconcile(agent) }
}

test('4044-row JSONL literal edit: independent full host read proves changed scope without build gates', async t => {
  const f = await fixture(t)
  await f.call('read', { file_path: f.path, limit: 1 })
  await f.call('edit', { file_path: f.path, old_string: 'old 中文', new_string: 'new 中文', replace_all: true })
  assert.deepEqual(f.progress().requiredGates, ['functional-probe'])
  assert.equal(f.progress().status, 'pending', 'write-owned before/after does not close debt')
  await f.call('read', { file_path: f.path, offset: 925, limit: 48 })
  assert.equal(f.progress().status, 'verified', 'host compares all bytes, not only the returned window')
  f.session.append('assistant/message', { stream: [], turn: 1, step: 4, message: createAssistantMessage({
    content: [{ type: 'text', text: '已完成并独立验证数据修改。' }], source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
  await f.ctx.serial(scopeTarget(f.agent, f.agent), 'agent/turn-stopping', {
    agent: f.agent, turn: 1, signal: new AbortController().signal,
  })
  assert.equal(f.steers.length, 0, 'the completion gate must not force another pointless verification round')
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const receipt = foldCompletionReceipt(f.session.snapshotEvents())
  assert.equal(receipt.outcome, 'verified', JSON.stringify(receipt))
  const rows = (await readFile(f.path, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.length, 4044)
  for (const [i, row] of rows.entries()) assert.deepEqual(row, { ...f.original[i], prompt: i < 48 ? 'new 中文' : '保持' })
})

test('sequential JSONL edits form a causal before/after chain and one independent read closes both', async t => {
  const f = await fixture(t)
  await f.call('edit', { file_path: f.path, old_string: 'old 中文', new_string: 'new 中文', replace_all: true })
  await f.call('edit', { file_path: f.path, old_string: 'new 中文', new_string: '最终 中文', replace_all: true })
  await f.call('read', { file_path: f.path, limit: 1 })
  assert.equal(f.progress().status, 'verified')
  assert.equal(f.progress().mutationCount, 2)
})

test('unrelated tail-field modification is caught even if the model reads only the correct prefix', async t => {
  const f = await fixture(t)
  await f.call('edit', { file_path: f.path, old_string: 'old 中文', new_string: 'new 中文', replace_all: true })
  await writeFile(f.path, (await readFile(f.path, 'utf8')).replace('"id":4043', '"id":9999'))
  await f.call('read', { file_path: f.path, limit: 1 })
  assert.equal(f.progress().status, 'pending')
  assert.deepEqual(f.progress().missingGates, ['functional-probe'])
})

test('JSONL evidence rejects malformed output, engineering paths, forged before metadata and symlinks', async t => {
  const f = await fixture(t)
  const args = { file_path: f.path, old_string: 'old 中文', new_string: 'new 中文', replace_all: true }
  const expected = prepareJsonlMutation('edit', args, f.workspace, isJsonlDataPath)
  assert.ok(expected)
  assert.equal(captureJsonlMutation(expected, { path: f.path, before: 'forged', after: expected.content }), undefined)
  assert.equal(prepareJsonlMutation('edit', { ...args, new_string: 'broken"value' }, f.workspace, isJsonlDataPath), undefined)
  assert.equal(prepareJsonlMutation('write', { file_path: join(f.root, 'src/a.jsonl'), content: '{}\n' }, f.workspace, isJsonlDataPath), undefined)
  await t.test('symlink target is never admitted as a literal JSONL mutation', async sub => {
    const alias = join(f.root, 'alias.jsonl')
    try { await symlink(f.path, alias) } catch (error) {
      if (process.platform === 'win32' && error?.code === 'EPERM') { sub.skip('Windows symlink privilege unavailable'); return }
      throw error
    }
    assert.equal(prepareJsonlMutation('edit', { ...args, file_path: alias }, f.workspace, isJsonlDataPath), undefined)
  })
  assert.equal(captureJsonlRead({ file_path: f.path }, { path: f.path, lines: [{ number: 1, text: 'fake' }], offset: 1, totalLines: 4044 }, f.workspace), undefined)
})

test('JSONL whole-file write still requires its own independent read and cannot borrow an earlier read', async t => {
  const f = await fixture(t)
  await f.call('read', { file_path: f.path, limit: 1 })
  await f.call('write', { file_path: f.path, content: f.content.replaceAll('old 中文', 'new 中文') })
  assert.equal(f.progress().status, 'pending')
  await f.call('read', { file_path: f.path, limit: 1 })
  assert.equal(f.progress().status, 'verified')
})
