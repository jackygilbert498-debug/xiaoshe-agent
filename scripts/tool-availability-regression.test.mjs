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
const { apply, RecoveryController } = await import(process.env.XIAOSHE_TEST_SOURCE === '1'
  ? '../src/plugins/agent-reliability.ts' : '../dist/plugins/agent-reliability.js')

function recoveryFixture() {
  let now = 100_000
  const agent = { id: randomUUID() }, recovery = new RecoveryController(undefined, () => now)
  const execution = (name, args = {}) => ({ agent, name, arguments: args, signal: new AbortController().signal })
  const failed = message => ({ isError: true, error: { code: 'EXECUTION_FAILED', message }, content: [] })
  const observed = { isError: false, content: [{ type: 'text', text: 'pending' }] }
  return { agent, recovery, execution, failed, observed, advance: ms => { now += ms } }
}

test('definite read failures remain executable and never disable another resource', () => {
  const { recovery: c, execution: e, failed } = recoveryFixture()
  const protectedRead = e('read', { file_path: '/protected/a.txt' })
  c.result(protectedRead, failed('EACCES permission denied'))
  assert.equal(c.denial(protectedRead), undefined, 'the real filesystem policy must decide every corrected or repeated read')
  c.result(protectedRead, failed('EACCES permission denied'))
  assert.equal(c.denial(protectedRead), undefined)
  assert.equal(c.denial(e('read', { file_path: '/allowed/b.txt' })), undefined)
})

test('unchanged pending status and planning remain executable without synthetic polling errors', () => {
  const { recovery: c, execution: e, observed } = recoveryFixture()
  const poll = e('read', { file_path: '/status/progress.json' })
  for (let i = 0; i < 4; i++) {
    c.result(poll, observed)
    assert.equal(c.denial(poll), undefined)
  }
  const plan = e('xiaoshe_capability_plan', { goal: 'read file' })
  c.result(plan, observed); c.result(plan, observed)
  assert.equal(c.denial(plan), undefined)
  const control = e('job_status', { id: 'external-job' })
  c.result(control, observed); c.result(control, observed)
  assert.equal(c.denial(control), undefined)
})

test('timeout pressure stays advisory while corrected vision shell and user questions really execute', () => {
  const { agent, recovery: c, execution: e, failed } = recoveryFixture()
  c.result(e('web_search', { query: 'one' }), failed('request timeout'))
  c.result(e('search_web', { query: 'two' }), failed('request timeout'))
  assert.ok(c.failedFamilies(agent).has('web_search'))
  assert.equal(c.denial(e('web_search', { query: 'corrected request' })), undefined)
  c.result(e('read_image', { path: '/large.png' }), failed('image side exceeds 2000 pixel limit; please downscale'))
  assert.equal(c.denial(e('bash', { command: 'tesseract /small.png stdout' })), undefined)
  c.result(e('modlens_read_image', { path: '/image.png' }), failed('No vision provider is set up'))
  c.result(e('read_image', { path: '/image.png' }), failed('model does not support image input'))
  assert.equal(c.denial(e('bash', { command: 'modlens --input /corrected.png --prompt "read text"' })), undefined)
  const question = e('ask_user_question', { question: '请提供图片中的文字，以便继续核对。' })
  c.result(question, failed('service unavailable')); c.result(question, failed('service unavailable'))
  assert.equal(c.denial(question), undefined, 'a question transient must not disable the question itself')
})

test('content-only unknown outcomes and post-dispatch aborts protect the first exact external send', () => {
  const { recovery: c, execution: e, failed } = recoveryFixture()
  const send = e('mcp__mail__send_message', { recipient: 'fixture', body: 'fixture', client_request_id: 'send-1' })
  c.result(send, {
    isError: true,
    error: { code: 'EXECUTION_FAILED', message: 'transport closed' },
    content: [{ type: 'text', text: 'provider outcome unavailable' }],
  })
  assert.match(c.denial(send), /结果未知|未知结果|确认.*状态/u)

  const aborted = e('mcp__mail__send_message', { recipient: 'fixture', body: 'after-dispatch', client_request_id: 'send-2' })
  c.result({ ...aborted, signal: AbortSignal.abort() }, {
    isError: true,
    error: { code: 'EXECUTION_FAILED', message: 'cancelled', info: { code: 'ABORTED' } },
    content: [],
  })
  assert.match(c.denial(aborted), /结果未知|未知结果/u)
  const signalOnly = e('mcp__mail__send_message', { recipient: 'fixture', body: 'signal-only', client_request_id: 'send-3' })
  c.result({ ...signalOnly, signal: AbortSignal.abort() }, {
    isError: true,
    error: { code: 'EXECUTION_FAILED', message: 'transport closed unexpectedly' },
    content: [],
  })
  assert.match(c.denial(signalOnly), /结果未知|未知结果/u)
  assert.equal(c.denial(e('mcp__mail__get_message_status', { client_request_id: 'send-1' })), undefined)
  assert.equal(c.denial(e('mcp__mail__send_message', { recipient: 'fixture', body: 'corrected' })), undefined)
})

test('structured definitive refusal and pre-dispatch abort outrank timeout-looking text', () => {
  const { agent, recovery: c, execution: e } = recoveryFixture()
  const refused = e('mcp__mail__send_message', { recipient: 'fixture', body: 'refused' })
  c.result(refused, {
    isError: true,
    error: { code: 'EXECUTION_FAILED', message: 'approval timed out', info: { code: 'PERMISSION_DENIED' } },
    content: [],
  })
  assert.equal(c.denial(refused), undefined)
  assert.ok(c.summary(agent).failed_routes.some(row => row.route === 'integration:mail:permission_denied'))

  const beforeDispatch = e('mcp__mail__send_message', { recipient: 'fixture', body: 'not-dispatched' })
  c.result({ ...beforeDispatch, signal: AbortSignal.abort() }, {
    isError: true,
    error: { code: 'EXECUTION_FAILED', message: 'request timed out while cancelling', info: { code: 'ABORTED_BEFORE_DISPATCH' } },
    content: [],
  })
  assert.equal(c.denial(beforeDispatch), undefined)
})

test('only correlated definitive-negative reconciliation releases an exact unknown-effect lock', () => {
  const { recovery: c, execution: e, failed } = recoveryFixture()
  const args = { recipient: 'fixture', body: 'fixture', client_request_id: 'send-correlated' }
  const send = e('mcp__mail__send_message', args)
  c.result(send, failed('request timeout'))
  const status = { ...e('mcp__mail__get_message_status', { client_request_id: args.client_request_id }), callId: 'fresh-status' }
  c.recordAdmission(status)
  assert.equal(c.denial(status), undefined)
  assert.match(c.denial(send), /结果未知|未知结果/u, 'admitting a query is not resolution')
  c.result(status, { isError: false, value: { status: 'pending' }, content: [{ type: 'text', text: 'pending' }] })
  assert.match(c.denial(send), /结果未知|未知结果/u, 'a non-negative result cannot release the send')
  const negative = { ...status, callId: 'fresh-negative-status' }
  c.recordAdmission(negative)
  c.result(negative, { isError: false, value: { status: 'not_sent' }, content: [{ type: 'text', text: 'not sent' }] })
  assert.equal(c.denial(send), undefined)
})

test('a fresh replacement-task reconciliation releases an older exact unknown-effect lock', () => {
  const { agent, recovery: c, execution: e, failed } = recoveryFixture()
  c.goalChanged(agent, undefined, { reset: true, goal: 'first task' })
  const client_request_id = 'replacement-task-send'
  const send = e('mcp__mail__send_message', { recipient: 'fixture', body: 'fixture', client_request_id })
  c.result(send, failed('request timeout'))
  c.goalChanged(agent, undefined, { reset: true, goal: 'replacement task' })

  const fresh = { ...e('mcp__mail__get_message_status', { client_request_id }), callId: 'replacement-task-status' }
  c.recordAdmission(fresh)
  c.result(fresh, { isError: false, value: { status: 'not_sent' }, content: [{ type: 'text', text: 'not sent' }] })
  assert.equal(c.denial(send), undefined)
})

test('a correlated status query admitted before an unknown send result cannot clear the newer lock', () => {
  const { recovery: c, execution: e, failed } = recoveryFixture()
  const client_request_id = 'causal-send'
  const stale = { ...e('mcp__mail__get_message_status', { client_request_id }), callId: 'status-admitted-first' }
  c.recordAdmission(stale)
  const send = e('mcp__mail__send_message', { recipient: 'fixture', body: 'fixture', client_request_id })
  c.result(send, failed('request timeout'))
  c.result(stale, { isError: false, value: { status: 'not_sent' }, content: [{ type: 'text', text: 'not sent' }] })
  assert.match(c.denial(send), /结果未知|未知结果/u)

  const fresh = { ...e('mcp__mail__get_message_status', { client_request_id }), callId: 'status-admitted-after-unknown' }
  c.recordAdmission(fresh)
  c.result(fresh, { isError: false, value: { status: 'not_sent' }, content: [{ type: 'text', text: 'not sent' }] })
  assert.equal(c.denial(send), undefined, 'a fresh causal reconciliation remains usable')
})

test('an older task-generation observation cannot clear the current unknown-effect lock', () => {
  const { agent, recovery: c, execution: e, failed } = recoveryFixture()
  c.goalChanged(agent, undefined, { reset: true, goal: 'first task' })
  const client_request_id = 'generation-bound-send'
  const old = { ...e('mcp__mail__get_message_status', { client_request_id }), callId: 'old-generation-status' }
  c.recordAdmission(old)
  c.goalChanged(agent, undefined, { reset: true, goal: 'replacement task' })
  const send = e('mcp__mail__send_message', { recipient: 'fixture', body: 'fixture', client_request_id })
  c.result(send, failed('request timeout'))
  c.result(old, { isError: false, value: { status: 'not_sent' }, content: [{ type: 'text', text: 'not sent' }] })
  assert.match(c.denial(send), /结果未知|未知结果/u)
})

test('a fresh explicit human duplicate-risk authorization releases one exact unknown effect', () => {
  const { agent, recovery: c, execution: e, failed } = recoveryFixture()
  const send = e('mcp__mail__send_message', { recipient: 'fixture', body: 'fixture' })
  c.result(send, failed('request timeout'))
  c.goalChanged(agent, undefined, {
    reset: false, goal: '继续。', directGoal: '继续。', triggerMessageId: 'continue',
  })
  assert.match(c.denial(send), /结果未知|未知结果/u)
  const authorization = '我明确授权你重试刚才结果未知的相同发送，并接受可能重复发送的风险。'
  c.goalChanged(agent, undefined, {
    reset: false, goal: authorization, directGoal: authorization, triggerMessageId: 'authorize-retry',
  })
  assert.equal(c.denial(send), undefined)
})

test('definite local write failures and synthetic policy denials do not become unknown-effect locks', () => {
  const { agent, recovery: c, execution: e, failed } = recoveryFixture()
  const write = e('write', { file_path: '/missing/result.txt', content: 'fixture' })
  c.result(write, failed('validation failed: parent directory is required'))
  c.result(write, failed('ENOENT parent directory not found'))
  assert.equal(c.denial(write), undefined)
  const read = e('read', { file_path: '/status' })
  c.result(read, failed('blocked by PreToolUse hook'))
  assert.ok(!c.summary(agent).failed_routes.some(row => row.route.startsWith('filesystem_read:')))
})

for (const terminal of ['success', 'definite-failure']) for (const order of ['unknown-first', 'ordinary-first']) {
  test(`concurrent identical calls retain separate uncertainty: ${terminal}, ${order}`, () => {
    const { agent, recovery: c, execution: e, failed } = recoveryFixture()
    const args = { recipient: 'fixture', body: 'same', client_request_id: 'concurrent-send' }
    const first = { ...e('mcp__mail__send_message', args), callId: 'earlier' }
    const second = { ...first, callId: 'later' }
    assert.equal(c.denial(first), undefined); assert.equal(c.denial(second), undefined)
    const ordinary = () => c.result(first, terminal === 'success' ? { isError: false, value: { sent: true }, content: [] }
      : { isError: true, error: { code: 'PERMISSION_DENIED', message: 'definite refusal' }, content: [] })
    const unknown = () => c.result(second, failed('request timeout; outcome unavailable'))
    if (order === 'unknown-first') { unknown(); ordinary() } else { ordinary(); unknown() }
    assert.equal(c.state(agent).uncertainEffects.size, 1)
    assert.match(c.denial({ ...first, callId: 'retry' }), /结果未知|未知结果/u)
    const negative = { ...e('mcp__mail__get_message_status', { client_request_id: args.client_request_id }), callId: 'fresh-query' }
    c.recordAdmission(negative)
    c.result(negative, { isError: false, value: { status: 'not_sent' }, content: [] })
    assert.equal(c.state(agent).uncertainEffects.size, 0)
    assert.equal(c.denial({ ...first, callId: 'resolved-retry' }), undefined)
  })
}

for (const terminal of ['success', 'definite-failure']) {
  test(`older generation ${terminal} does not discharge a current identical unknown invocation`, () => {
    const { agent, recovery: c, execution: e, failed } = recoveryFixture()
    c.goalChanged(agent, undefined, { reset: true, goal: 'first task' })
    const first = { ...e('mcp__mail__send_message', { recipient: 'fixture', body: 'same' }), callId: 'old-send' }
    c.recordAdmission(first)
    c.goalChanged(agent, undefined, { reset: true, goal: 'second task' })
    const second = { ...first, callId: 'new-send' }
    c.recordAdmission(second)
    c.result(second, failed('request timeout; outcome unavailable'))
    c.result(first, terminal === 'success' ? { isError: false, value: { sent: true }, content: [] }
      : { isError: true, error: { code: 'PERMISSION_DENIED', message: 'definite refusal' }, content: [] })
    assert.equal(c.state(agent).uncertainEffects.size, 1)
    assert.match(c.denial({ ...first, callId: 'retry' }), /结果未知|未知结果/u)
  })
}

test('two identical unknown invocations survive individually and reconcile only after their own unknown results', () => {
  const { agent, recovery: c, execution: e, failed } = recoveryFixture()
  const client_request_id = 'two-unknown-sends'
  const first = { ...e('mcp__mail__send_message', { recipient: 'fixture', body: 'same', client_request_id }), callId: 'unknown-a' }
  const second = { ...first, callId: 'unknown-b' }
  c.recordAdmission(first); c.recordAdmission(second)
  c.result(first, failed('request timeout; outcome unavailable'))
  const query = { ...e('mcp__mail__get_message_status', { client_request_id }), callId: 'between-results-query' }
  c.recordAdmission(query)
  c.result(second, failed('request timeout; outcome unavailable'))
  assert.equal(c.state(agent).uncertainEffects.size, 2, 'same fingerprint is not the same invocation')
  const authorization = '我明确授权你重试刚才结果未知的相同发送，并接受可能重复发送的风险。'
  c.goalChanged(agent, undefined, { reset: false, goal: authorization, directGoal: authorization, triggerMessageId: 'ambiguous-two-effects' })
  assert.equal(c.state(agent).uncertainEffects.size, 2, 'one-effect authorization must not bulk-release two invocations')
  c.result(query, { isError: false, value: { status: 'not_sent' }, content: [] })
  assert.equal(c.state(agent).uncertainEffects.size, 1, 'query predating the second unknown result may settle only the first')
  assert.match(c.denial({ ...first, callId: 'still-blocked' }), /结果未知|未知结果/u)
  const fresh = { ...query, callId: 'after-both-query' }
  c.recordAdmission(fresh)
  c.result(fresh, { isError: false, value: { status: 'not_sent' }, content: [] })
  assert.equal(c.state(agent).uncertainEffects.size, 0)
  assert.equal(c.denial({ ...first, callId: 'resolved-send' }), undefined)
})

test('more than 64 unresolved invocations retain the oldest risk and release resolved entries', () => {
  const { agent, recovery: c, execution: e, failed } = recoveryFixture()
  const sends = Array.from({ length: 70 }, (_, i) => ({ ...e('mcp__mail__send_message', {
    recipient: 'fixture', body: 'same', client_request_id: `many-${i}`,
  }), callId: `unresolved-${i}` }))
  for (const send of sends) { c.recordAdmission(send); c.result(send, failed('request timeout; outcome unavailable')) }
  assert.equal(c.state(agent).uncertainEffects.size, 70)
  assert.match(c.denial({ ...sends[0], callId: 'oldest-retry' }), /结果未知|未知结果/u)
  for (let i = 0; i < sends.length; i++) {
    const query = { ...e('mcp__mail__get_message_status', { client_request_id: `many-${i}` }), callId: `resolve-${i}` }
    c.recordAdmission(query)
    c.result(query, { isError: false, value: { status: 'not_sent' }, content: [] })
    assert.equal(c.state(agent).uncertainEffects.size, sends.length - i - 1)
  }
  assert.equal(c.denial({ ...sends[0], callId: 'oldest-resolved' }), undefined)
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
  // Planning remains advisory; repeated status/planning calls are not synthetic tool errors.
  assert.equal((await call('xiaoshe_capability_plan', { goal: '需要文件编辑工具。' })).isError, false)
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
  assert.deepEqual(calls.filter(c => c.isError).map(c => c.name), [])
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
