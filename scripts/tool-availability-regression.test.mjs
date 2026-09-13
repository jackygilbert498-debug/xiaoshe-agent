import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '../runtime/DSH/vendor/cordis/lib/index.js'
import { ToolRuntime } from '../runtime/DSH/packages/core/tools/lib/index.js'
import { SystemPrompt } from '../runtime/DSH/packages/core/system-prompt/lib/index.js'
import { createScope, scopeTarget } from '../runtime/DSH/packages/core/scope/lib/index.js'
import { createUserMessage } from '../runtime/DSH/packages/llm/llm/lib/index.js'
import { LocalFileSystem } from '../runtime/DSH/packages/fs/fs-local/lib/index.js'
import { apply as applyFileTools, Config as FileConfig } from '../runtime/DSH/packages/fs/tool-fs/lib/index.js'
import { apply, RecoveryController } from '../dist/plugins/agent-reliability.js'

function recoveryFixture() {
  let now = 100_000
  const agent = { id: randomUUID() }, recovery = new RecoveryController(undefined, () => now)
  const execution = (name, args = {}) => ({ agent, name, arguments: args, signal: new AbortController().signal })
  const failed = message => ({ isError: true, error: { code: 'EXECUTION_FAILED', message }, content: [] })
  const observed = { isError: false, content: [{ type: 'text', text: 'pending' }] }
  return { agent, recovery, execution, failed, observed, advance: ms => { now += ms } }
}

test('one resource permission failure never disables another resource and read-only recovery has a finite cooldown', () => {
  const { recovery: c, execution: e, failed, advance } = recoveryFixture()
  const protectedRead = e('read', { file_path: '/protected/a.txt' })
  c.result(protectedRead, failed('EACCES permission denied'))
  assert.match(c.denial(protectedRead), /同一调用已失败/)
  assert.equal(c.denial(e('read', { file_path: '/allowed/b.txt' })), undefined)
  advance(29_999)
  assert.match(c.denial(protectedRead), /30 秒/)
  advance(1)
  assert.equal(c.denial(protectedRead), undefined, 'permission must still be checked by the real tool on every probe')
})

test('unchanged status and planning can be queried again after throttling without a dummy tool call', () => {
  const { recovery: c, execution: e, observed, advance } = recoveryFixture()
  const poll = e('read', { file_path: '/status/progress.json' })
  c.result(poll, observed); c.result(poll, observed)
  assert.match(c.denial(poll), /间隔至少 1 秒/)
  advance(1_000)
  assert.equal(c.denial(poll), undefined)
  c.result(poll, observed)
  advance(1_000)
  assert.equal(c.denial(poll), undefined, 'external unchanged state is allowed indefinitely at a bounded frequency')
  c.result(e('xiaoshe_capability_plan', { goal: 'read file' }), observed)
  assert.match(c.denial(e('xiaoshe_capability_plan', { goal: 'read another file' })), /间隔 1 秒/)
  advance(1_000)
  assert.equal(c.denial(e('xiaoshe_capability_plan', { goal: 'read another file' })), undefined)
})

test('timeout pressure remains observable but never bans independent routes or necessary user input', () => {
  const { agent, recovery: c, execution: e, failed } = recoveryFixture()
  c.result(e('web_search', { query: 'one' }), failed('request timeout'))
  c.result(e('search_web', { query: 'two' }), failed('request timeout'))
  assert.ok(c.failedFamilies(agent).has('web_search'))
  assert.equal(c.denial(e('web_search', { query: 'corrected request' })), undefined)
  c.result(e('read_image', { path: '/large.png' }), failed('image side exceeds 2000 pixel limit; please downscale'))
  assert.equal(c.denial(e('bash', { command: 'tesseract /small.png stdout' })), undefined)
  c.result(e('modlens_read_image', { path: '/image.png' }), failed('No vision provider is set up'))
  c.result(e('read_image', { path: '/image.png' }), failed('model does not support image input'))
  assert.equal(c.denial(e('ask_user_question', { question: '请提供图片中的文字，以便继续核对。' })), undefined)
})

test('elapsed time never blindly retries a failed side effect and hot policy denials do not poison backend health', () => {
  const { agent, recovery: c, execution: e, failed, observed, advance } = recoveryFixture()
  const send = e('mcp__mail__send_message', { recipient: 'fixture', body: 'fixture' })
  c.result(send, failed('request timeout')); c.result(send, failed('request timeout'))
  advance(60_000)
  assert.match(c.denial(send), /副作用调用不得盲目重试/)
  const read = e('read', { file_path: '/status' })
  c.result(read, observed); c.result(read, observed)
  const denial = c.denial(read)
  c.result(read, failed(denial))
  assert.ok(!c.summary(agent).failed_routes.some(row => row.route.startsWith('filesystem_read:')))
})

const output = { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xs-advisory-file-test-'))
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx)
  new LocalFileSystem(ctx, { cwd: directory, diffBasisMaxBytes: 1024 * 1024 })
  applyFileTools(ctx, FileConfig({}))
  apply(ctx)
  const agent = { id: randomUUID(), session: { header: { cwd: directory } } }
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx
  t.after(async () => { scope.dispose(); ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  // More than the former 24-tool cutoff, using real dispatcher registrations.
  for (let i = 0; i < 32; i++) ctx.tools.register({ name: `fixture_service_${i}`, description: 'Specialist fixture tool.',
    parameters: { type: 'object', properties: {} }, output, async execute() { return {} } })
  ctx.tools.register({ name: 'todo_write', description: 'Record task steps.',
    parameters: { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] }, output,
    async execute(args) { return { todos: args.todos } } })
  ctx.tools.register({ name: 'grep', description: 'Search local fixture JSONL.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, pattern: { type: 'string' } }, required: ['path', 'pattern'] }, output,
    async execute(args) {
      assert.equal(args.path, join(directory, 'input.jsonl'))
      return { matches: (await readFile(args.path, 'utf8')).split('\n').filter(line => line.includes(args.pattern)) }
    } })
  const send = text => ctx.emit(scopeTarget(agent, agent), 'agent/inbox/claimed', { agent,
    message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) })
  const calls = []
  const call = async (name, args = {}) => {
    const result = await ctx.tools.execute({ name, arguments: args, callId: randomUUID(), agent, signal: new AbortController().signal })
    calls.push({ name, isError: result.isError })
    return result
  }
  const names = async () => (await ctx.systemPrompt.assemble({ agent, scope: agent })).tools.map(tool => tool.name)
  return { ctx, scope, directory, agent, send, call, calls, names }
}

test('JSONL real read/edit survive vague follow-up and todo-only recommendation without unlock calls', async t => {
  const { directory, send, call, calls, names } = await fixture(t)
  const file = join(directory, 'input.jsonl')
  const original = Array.from({ length: 120 }, (_, i) => ({ video: `Z:/video/copper_man_${i}.mp4`, source: [`source/${i}.mp4`], ref: [`ref/${i}.jpg`], fps: 24, seconds: 4, width: 720, height: 960,
    prompt: ['人物注视镜头时，皮肤逐渐变成铜质。', 'While looking at the camera, the skin gradually turns to copper.'] }))
  const before = original.map(row => JSON.stringify(row)).join('\n') + '\n'
  await writeFile(file, before)
  const start = performance.now()
  send(`读取并编辑文件 ${file} 的 prompt，删除指定的中英文朝向表述；保留变化过程，其他字段和行序不变。`)
  assert.equal((await call('todo_write', { todos: [{ content: '读取、批量修改与核验', status: 'in_progress' }] })).isError, false)
  assert.equal((await call('read', { file_path: file })).isError, false)
  send('你在干什么？这么慢/')
  const plan = await call('xiaoshe_capability_plan', { goal: '继续编辑 dec_fps_24.jsonl 的 prompt 文本，删除剩余的中文和英文朝向镜头/观众表述，需要文件编辑能力。' })
  assert.equal(plan.isError, false)
  assert.deepEqual(plan.value.candidates.map(c => c.name), ['todo_write'], 'reproduce the original low-confidence recommendation')
  assert.match(plan.value.guidance, /只作路线推荐/)
  for (const tool of ['read', 'write', 'edit', 'grep']) assert.ok((await names()).includes(tool), tool)
  // Replanning remains bounded, but it no longer locks the caller out of real work.
  assert.equal((await call('xiaoshe_capability_plan', { goal: '需要文件编辑工具。' })).isError, true)
  assert.equal((await call('edit', { file_path: file, old_string: '人物注视镜头时，', new_string: '', replace_all: true })).isError, false)
  assert.equal((await call('grep', { path: file, pattern: 'While looking at the camera, ' })).isError, false)
  assert.equal((await call('edit', { file_path: file, old_string: 'While looking at the camera, ', new_string: '', replace_all: true })).isError, false)
  assert.equal((await call('read', { file_path: file })).isError, false)
  const after = (await readFile(file, 'utf8')).trimEnd().split('\n').map(JSON.parse)
  assert.equal(after.length, original.length)
  for (let i = 0; i < after.length; i++) {
    const { prompt, ...metadata } = after[i], { prompt: _beforePrompt, ...beforeMetadata } = original[i]
    assert.deepEqual(metadata, beforeMetadata)
    assert.deepEqual(prompt, ['皮肤逐渐变成铜质。', 'the skin gradually turns to copper.'])
  }
  assert.equal(calls.filter(c => c.name === 'edit').length, 2)
  assert.deepEqual(calls.filter(c => c.isError).map(c => c.name), ['xiaoshe_capability_plan'])
  t.diagnostic(JSON.stringify({ rows: 120, editCalls: 2, metadataAndOrderPreserved: true, elapsedMs: Math.round(performance.now() - start), modelRequests: 0 }))
})

test('full catalog does not bypass readonly or allowed-path restrictions on actual file writes', async t => {
  const { directory, send, call, names } = await fixture(t)
  const allowed = join(directory, 'allowed.txt'), forbidden = join(directory, 'forbidden.txt')
  await writeFile(allowed, 'original'); await writeFile(forbidden, 'original')
  send('只读检查文件，不允许任何修改。')
  assert.ok(!(await names()).includes('edit'))
  assert.equal((await call('edit', { file_path: allowed, old_string: 'original', new_string: 'changed' })).isError, true)
  assert.equal(await readFile(allowed, 'utf8'), 'original')
  send(`现在修改文件，只允许修改 ${allowed}，禁止修改 ${forbidden}。`)
  assert.equal((await call('read', { file_path: allowed })).isError, false)
  assert.equal((await call('edit', { file_path: forbidden, old_string: 'original', new_string: 'changed' })).isError, true)
  assert.equal(await readFile(forbidden, 'utf8'), 'original')
})

test('external permission masks and revoked registrations remain authoritative after advisory planning', async t => {
  const { scope, ctx, agent, send, call, names } = await fixture(t)
  scope.ctx.tools.restrict({ deny: ['write'] })
  const revoke = scope.ctx.tools.register({ name: 'temporary_probe', description: 'Observe temporary fixture.', parameters: { type: 'object', properties: {} }, output, async execute() { return {} } })
  send('继续处理。')
  assert.ok(!(await names()).includes('write'))
  assert.ok((await names()).includes('temporary_probe'))
  const plan = await call('xiaoshe_capability_plan', { goal: '写入文件' })
  assert.ok(!plan.value.candidates.some(c => c.name === 'write'))
  revoke()
  assert.ok(!(await names()).includes('temporary_probe'))
  assert.equal(ctx.tools.get('temporary_probe', agent), undefined)
})
