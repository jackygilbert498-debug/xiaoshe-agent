import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureSameSessionFileBaseline, proveSameSessionFileRun } from './same-session-file-proof.mjs'

const inputText = '{"project":"Alpha","amount":12.5,"quantity":3,"owner":"Li"}\n{"project":"Beta","amount":2,"quantity":0}\n'
const expected = { items: [{ project: 'Alpha', amount: 12.5, quantity: 3, owner: 'Li' },
  { project: 'Beta', amount: 2, quantity: 0, owner: null }] }
const userMessageIds = ['question-message', 'file-task-message']

function readText(path, text) {
  const lines = text.replace(/\n$/u, '').split('\n')
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${lines.map((line, i) => `${i + 1}: ${line}`).join('\n')}\n\n(End of file - total ${lines.length} lines)\n</content>`
}

function historyFixture(outputText, { planner = true, auto = true, todos = false } = {}) {
  const events = []
  const append = (type, data) => events.push({ event: { seq: events.length, time: events.length + 1, type, data } })
  const header = names => append('request/header', { header: { config: { provider: 'offline-fixture', model: 'fixture', maxTokens: 2048 },
    tools: names.map(name => ({ name, description: 'Offline fixture', parameters: { type: 'object' } })) }, reason: 'change' })
  const result = (id, turn, text) => append('tool/result', { turn, step: 1, message: { id: `result-${id}`, role: 'user',
    source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, isError: false, content: [{ type: 'text', text }] }] } })
  const call = (id, turn, name, args, text) => {
    append('tool/call', { turn, step: 1, callId: id, name, arguments: JSON.stringify(args) })
    // Match tool-todo's real session append and rendered result, not a file tool.
    if (name === 'todo_write') append('todo/write', { todos: structuredClone(args.todos) })
    result(id, turn, text)
  }
  append('turn/start', { turn: 1 })
  append('user/message', { id: userMessageIds[0], role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '检查本会话能力' }] })
  const firstTools = ['xiaoshe_runtime_info', 'xiaoshe_capability_plan', ...(todos ? ['todo_write'] : [])]
  header(firstTools)
  if (todos) call('todo-observation', 1, 'todo_write', { todos: [{ content: '检查会话能力', status: 'in_progress' }] },
    'Updated todo list: 0 pending, 1 in progress, 0 completed.')
  call('info', 1, 'xiaoshe_runtime_info', {}, JSON.stringify({ tools: firstTools,
    tool_availability: { registered_tools: ['read', 'write', ...firstTools], registered_count: firstTools.length + 2, visible_count: firstTools.length },
    execution: { tool_surface: { presentation: 'native' } } }))
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  append('turn/start', { turn: 2 })
  append('user/message', { id: userMessageIds[1], role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '读取 input.jsonl 并写入 output/result.json 后回读' }] })
  header(auto ? ['read', 'write', ...firstTools] : firstTools)
  if (todos) call('todo-files', 2, 'todo_write', { todos: [{ content: '读取 input.jsonl', status: 'in_progress' },
    { content: '写入 output/result.json 后回读', status: 'pending' }] },
  'Updated todo list: 1 pending, 1 in progress, 0 completed.')
  if (planner) call('plan', 2, 'xiaoshe_capability_plan', { goal: '读取 input.jsonl，写入 output/result.json 并回读' },
    JSON.stringify({ registration_only: true, candidates: [{ name: 'read' }, { name: 'write' }] }))
  if (planner && !auto) header(['read', 'write', ...firstTools])
  call('source', 2, 'read', { file_path: 'input.jsonl' }, readText('input.jsonl', inputText))
  call('write', 2, 'write', { file_path: 'output/result.json', content: outputText }, '<path>output/result.json</path>\n<type>file</type>\n<content>\nCreated file\n</content>')
  call('readback', 2, 'read', { file_path: 'output/result.json' }, readText('output/result.json', outputText))
  append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return { events, hasMore: false }
}

async function fixture(t, options) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'xs-file-proof-'))
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }))
  await writeFile(join(workspaceRoot, 'input.jsonl'), inputText)
  await mkdir(join(workspaceRoot, 'output'))
  const baseline = await captureSameSessionFileBaseline({ workspaceRoot })
  const outputText = `${JSON.stringify(expected, null, 2)}\n`
  await writeFile(join(workspaceRoot, 'output/result.json'), outputText)
  return { workspaceRoot, baseline, sessionId: 'isolated-file-session', userMessageIds,
    history: historyFixture(outputText, options), outputText }
}

const fact = (history, callId) => history.events.find(row => row.event.type === 'tool/call' && row.event.data.callId === callId).event
const result = (history, callId) => history.events.find(row => row.event.type === 'tool/result' && row.event.data.message.source.callId === callId).event
const textOf = event => event.data.message.content[0].content[0]
const reseq = history => history.events.forEach((row, seq) => { row.event.seq = seq })

async function continuousFixture(t) {
  const data = await fixture(t, { planner: false })
  data.toolPolicy = 'continuous-availability'
  const block = textOf(result(data.history, 'info')), info = JSON.parse(block.text)
  info.tools = [...info.tool_availability.registered_tools]
  info.tool_availability.visible_count = info.tools.length
  block.text = JSON.stringify(info)
  data.history.events.find(row => row.event.type === 'request/header').event.data.header.tools
    = info.tools.map(name => ({ name, description: 'Offline fixture', parameters: { type: 'object' } }))
  return data
}

test('current policy proves continuously available file tools without a planner', async t => {
  const proof = await proveSameSessionFileRun(await continuousFixture(t))
  assert.ok(proof.tasks.every(task => task.state === 'pass'))
  assert.equal(proof.regression.id, 'same-session-tool-availability')
  assert.equal(proof.regression.state, 'pass')
})

test('current policy rejects hidden tools at either turn and inconsistent runtime-info', async t => {
  const legacy = await fixture(t)
  assert.equal((await proveSameSessionFileRun({ ...legacy, toolPolicy: 'continuous-availability' })).regression.state, 'fail')
  for (const turnIndex of [0, 1]) {
    const data = await continuousFixture(t)
    const header = data.history.events.filter(row => row.event.type === 'request/header')[turnIndex].event.data.header
    header.tools = header.tools.filter(tool => tool.name !== 'write')
    assert.equal((await proveSameSessionFileRun(data)).regression.state, 'fail')
  }
  const data = await continuousFixture(t)
  const block = textOf(result(data.history, 'info')), info = JSON.parse(block.text)
  info.tool_availability.visible_count++
  block.text = JSON.stringify(info)
  assert.equal((await proveSameSessionFileRun(data)).regression.state, 'fail')
})

test('current proof is not legacy rediscovery and unknown policy fails closed', async t => {
  const data = await continuousFixture(t)
  assert.equal((await proveSameSessionFileRun({ ...data, toolPolicy: 'legacy-rediscovery' })).regression.state, 'fail')
  await assert.rejects(proveSameSessionFileRun({ ...data, toolPolicy: 'unknown' }), /invalid_tool_policy/)
})

const planDenial = 'Error: 复杂任务尚未完成行动前准备：先用任务清单记录少量可更新步骤。取得一次真实结果后再实施，不要通过重复同一写入调用绕过。'
const isolatedDenial = 'Error: acceptance-file-policy: tool_not_allowed'

function addRejectedCall(data, { id, name, args, text, before = 'write', step = 3 }) {
  const template = result(data.history, 'write')
  const call = { event: { type: 'tool/call', data: { turn: 2, step, callId: id, name, arguments: JSON.stringify(args) } } }
  const denied = { event: structuredClone(template) }
  denied.event.data.turn = 2; denied.event.data.step = step
  denied.event.data.message.id = `result-${id}`
  denied.event.data.message.source.callId = id
  denied.event.data.message.content[0].toolCallId = id
  denied.event.data.message.content[0].isError = true
  textOf(denied.event).text = text
  const index = before ? data.history.events.findIndex(row => row.event === fact(data.history, before)) : data.history.events.length - 1
  data.history.events.splice(index, 0, call, denied); reseq(data.history)
}

async function recoveryFixture(t) {
  const data = await fixture(t, { todos: true })
  // Match the third real run: input read -> product write preflight -> plan ->
  // successful write/readback -> isolated glob denial -> completed turn.
  const todoRows = data.history.events.filter(row => row.event === fact(data.history, 'todo-files')
    || row.event === result(data.history, 'todo-files'))
  const todoEvent = data.history.events.findLast(row => row.event.type === 'todo/write')
  data.history.events = data.history.events.filter(row => !todoRows.includes(row) && row !== todoEvent)
  const writeIndex = data.history.events.findIndex(row => row.event === fact(data.history, 'write'))
  data.history.events.splice(writeIndex, 0, todoRows[0], todoEvent, todoRows[1]); reseq(data.history)
  addRejectedCall(data, { id: 'preflight-write', name: 'write', args: JSON.parse(fact(data.history, 'write').data.arguments),
    text: planDenial, before: 'todo-files' })
  addRejectedCall(data, { id: 'guard-glob', name: 'glob', args: { pattern: 'output/*' }, text: isolatedDenial, before: null, step: 6 })
  for (const [id, step] of [['source', 2], ['todo-files', 4], ['write', 5], ['readback', 6]]) {
    fact(data.history, id).data.step = step; result(data.history, id).data.step = step
  }
  return data
}

test('exact ordered source, write and readback proofs map to both fixed catalog tasks', async t => {
  const data = await fixture(t)
  const proof = await proveSameSessionFileRun(data)
  assert.deepEqual(proof.tasks.map(task => [task.taskId, task.state]), [
    ['files-extract-structured', 'pass'], ['files-structured-write-readback', 'pass']])
  assert.equal(proof.regression.state, 'pass')
  assert.equal(proof.regression.checks[2].evidence.mode, 'automatic_task_surface')
  assert.equal(proof.regression.checks[2].evidence.hasPlannerConfirmation, true)
  assert.deepEqual(proof.tasks[0].checks.map(check => check.id), ['source-read', 'fields-match-source', 'missing-values-not-invented'])
  assert.equal(proof.independent.noExtraFiles, true)
})

test('actual automatic surface restoration is accepted but never called planner-driven recovery', async t => {
  const data = await fixture(t, { planner: false })
  const proof = await proveSameSessionFileRun(data)
  assert.equal(proof.tasks[1].state, 'pass')
  assert.equal(proof.regression.state, 'pass')
  assert.equal(proof.regression.checks[2].evidence.mode, 'automatic_task_surface')
  assert.equal(proof.regression.checks[2].evidence.hasPlannerConfirmation, false)
})

test('planner recovery requires a hidden current-turn header followed by a real visible header after planner success', async t => {
  const data = await fixture(t, { auto: false })
  let proof = await proveSameSessionFileRun(data)
  assert.equal(proof.regression.state, 'pass')
  assert.equal(proof.regression.checks[2].evidence.mode, 'capability_plan')
  assert.equal(proof.regression.checks[2].evidence.hasPlannerConfirmation, true)
  const changed = structuredClone(data)
  const after = changed.history.events.find(row => row.event.type === 'request/header'
    && row.event.seq > result(changed.history, 'plan').seq)
  after.event.data.header.tools = after.event.data.header.tools.filter(tool => tool.name !== 'read')
  proof = await proveSameSessionFileRun(changed)
  assert.equal(proof.regression.state, 'fail', 'a candidate registration without visibility restoration is not proof')
  const noCurrentHeader = structuredClone(data)
  noCurrentHeader.history.events = noCurrentHeader.history.events.filter(row => !(row.event.type === 'request/header'
    && row.event.seq > noCurrentHeader.history.events.find(row => row.event.type === 'turn/start' && row.event.data.turn === 2).event.seq
    && row.event.seq < fact(noCurrentHeader.history, 'plan').seq))
  reseq(noCurrentHeader.history)
  assert.equal((await proveSameSessionFileRun(noCurrentHeader)).regression.state, 'fail')
})

test('third-run shape proves bounded pre-dispatch recovery without treating rejected attempts as side effects', async t => {
  const data = await recoveryFixture(t)
  const proof = await proveSameSessionFileRun(data)
  assert.ok(proof.tasks.every(task => task.state === 'pass'))
  assert.equal(proof.regression.state, 'pass')
  assert.equal(proof.regression.checks[2].evidence.mode, 'automatic_task_surface')
  assert.equal(proof.recovery.retriedWriteCalls, 1)
  assert.equal(proof.recovery.successfulWriteCalls, 1)
  assert.equal(proof.recovery.preflightRejectedWriteCalls, 1)
  assert.equal(proof.recovery.isolatedDeniedCalls, 1)
  assert.equal(proof.recovery.totalFailedCalls, 2)
  assert.equal(proof.recovery.unclassifiedFailedCalls, 0)
  assert.equal(proof.recovery.withinLimits, true)
  assert.deepEqual(proof.recovery.preflightWriteEvidence.map(row => row.callId), ['preflight-write'])
  assert.deepEqual(proof.recovery.isolatedDenialEvidence.map(row => row.callId), ['guard-glob'])
  assert.equal(proof.tasks[1].checks[1].evidence.callId, 'write')
})

test('only exact pre-execute write denial before the successful same-target write is recoverable', async t => {
  for (const mutate of [
    data => { textOf(result(data.history, 'preflight-write')).text = 'Error: EIO: write failed' },
    data => { textOf(result(data.history, 'preflight-write')).text = planDenial + ' ' },
    data => { result(data.history, 'preflight-write').data.message.content[0].isError = false },
    data => { result(data.history, 'preflight-write').data.message.isError = false },
    data => { fact(data.history, 'preflight-write').data.arguments = JSON.stringify({ file_path: 'input.jsonl', content: inputText }) },
    data => { result(data.history, 'preflight-write').data.turn = 1 },
    data => { result(data.history, 'preflight-write').data.step = 99 },
    data => {
      const rows = data.history.events.filter(row => row.event === fact(data.history, 'preflight-write') || row.event === result(data.history, 'preflight-write'))
      data.history.events = data.history.events.filter(row => !rows.includes(row)); data.history.events.splice(-1, 0, ...rows); reseq(data.history)
    },
  ]) {
    const data = await recoveryFixture(t); mutate(data)
    assert.ok((await proveSameSessionFileRun(data)).tasks.every(task => task.state === 'fail'))
  }
})

test('isolation denial needs an exact native error; unknown or fake errors never certify non-execution', async t => {
  for (const mutate of [
    data => { textOf(result(data.history, 'guard-glob')).text = isolatedDenial + '\n' },
    data => { textOf(result(data.history, 'guard-glob')).text = isolatedDenial.replace('tool_not_allowed', 'tool_not_allow') },
    data => { textOf(result(data.history, 'guard-glob')).text = 'Error: ENOENT: path missing' },
    data => { result(data.history, 'guard-glob').data.message.content[0].isError = false },
    data => { delete result(data.history, 'guard-glob').data.message.content[0].isError; result(data.history, 'guard-glob').data.isError = true },
    data => { result(data.history, 'guard-glob').data.turn = 1 },
    data => { result(data.history, 'guard-glob').data.message.content[0].content.push({ type: 'text', text: 'side effects occurred' }) },
    data => { fact(data.history, 'guard-glob').data.name = 'todo_write' },
  ]) {
    const data = await recoveryFixture(t); mutate(data)
    assert.ok((await proveSameSessionFileRun(data)).tasks.every(task => task.state === 'fail'))
  }
})

test('recovery remains bounded to one preflight retry and one isolated denial; duplicate success still fails', async t => {
  for (const kind of ['preflight', 'isolation', 'successful-write']) {
    const data = await recoveryFixture(t)
    if (kind === 'preflight') addRejectedCall(data, { id: 'extra-preflight', name: 'write',
      args: JSON.parse(fact(data.history, 'write').data.arguments), text: planDenial })
    if (kind === 'isolation') addRejectedCall(data, { id: 'extra-isolation', name: 'bash', args: { command: 'not executed' }, text: isolatedDenial, before: null })
    if (kind === 'successful-write') {
      const extra = structuredClone(data.history.events.filter(row => row.event === fact(data.history, 'write') || row.event === result(data.history, 'write')))
      extra[0].event.data.callId = 'extra-write'; extra[1].event.data.message.source.callId = 'extra-write'
      extra[1].event.data.message.content[0].toolCallId = 'extra-write'; data.history.events.splice(-1, 0, ...extra); reseq(data.history)
    }
    const proof = await proveSameSessionFileRun(data)
    assert.ok(proof.tasks.every(task => task.state === 'fail'), kind)
    if (kind !== 'successful-write') assert.equal(proof.recovery.withinLimits, false, kind)
    else assert.equal(proof.recovery.successfulWriteCalls, 2)
  }
})

test('real-shape todo_write planning in either user turn is allowed but never counted as file evidence', async t => {
  const data = await fixture(t, { todos: true })
  const proof = await proveSameSessionFileRun(data)
  assert.ok(proof.tasks.every(task => task.state === 'pass'))
  assert.equal(proof.regression.state, 'pass')
  assert.equal(data.history.events.filter(row => row.event.type === 'todo/write').length, 2)
  assert.equal(proof.tasks[0].checks[0].evidence.callId, 'source')
  assert.equal(proof.tasks[1].checks[1].evidence.callId, 'write')
  assert.equal(proof.tasks[1].checks[2].evidence.callId, 'readback')
  fact(data.history, 'source').data.name = 'todo_write'
  fact(data.history, 'source').data.arguments = JSON.stringify({ todos: [{ content: 'Read input.jsonl', status: 'completed' }] })
  textOf(result(data.history, 'source')).text = 'Updated todo list: 0 pending, 0 in progress, 1 completed.'
  assert.ok((await proveSameSessionFileRun(data)).tasks.every(task => task.state === 'fail'))
})

test('allowed todo_write still requires settled result and correct native turn/step binding', async t => {
  for (const mutation of [
    data => { fact(data.history, 'todo-files').data.turn = 1 },
    data => { result(data.history, 'todo-files').data.turn = 1 },
    data => { result(data.history, 'todo-files').data.step = 2 },
    data => { data.history.events = data.history.events.filter(row => row.event !== result(data.history, 'todo-files')); reseq(data.history) },
    data => { fact(data.history, 'todo-files').data.name = 'bash' },
    data => { fact(data.history, 'todo-files').data.name = 'web_fetch' },
  ]) {
    const data = await fixture(t, { todos: true }); mutation(data)
    const proof = await proveSameSessionFileRun(data)
    assert.ok(proof.tasks.every(task => task.state === 'fail'))
    assert.equal(proof.regression.state, 'fail')
  }
})

test('planning allowance never permits additional file writes or overescaped non-JSON output', async t => {
  const duplicated = await fixture(t, { todos: true })
  const extra = structuredClone(duplicated.history.events.filter(row => row.event === fact(duplicated.history, 'write')
    || row.event === result(duplicated.history, 'write')))
  extra[0].event.data.callId = 'extra-write'
  extra[1].event.data.message.source.callId = 'extra-write'
  extra[1].event.data.message.content[0].toolCallId = 'extra-write'
  duplicated.history.events.splice(-1, 0, ...extra); reseq(duplicated.history)
  assert.equal((await proveSameSessionFileRun(duplicated)).tasks[1].state, 'fail')

  const escaped = await fixture(t, { todos: true })
  const invalidJSON = escaped.outputText.replaceAll('"', '\\"')
  await writeFile(join(escaped.workspaceRoot, 'output/result.json'), invalidJSON)
  fact(escaped.history, 'write').data.arguments = JSON.stringify({ file_path: 'output/result.json', content: invalidJSON })
  textOf(result(escaped.history, 'readback')).text = readText('output/result.json', invalidJSON)
  const proof = await proveSameSessionFileRun(escaped)
  assert.equal(proof.independent.outputCorrect, false)
  assert.ok(proof.tasks.every(task => task.state === 'fail'))
})

test('planner may follow another observation, but its successful read candidate must precede the source read', async t => {
  const data = await fixture(t, { auto: false })
  const extra = structuredClone(data.history.events.filter(row => row.event.type === 'tool/call' && row.event.data.callId === 'info'
    || row.event.type === 'tool/result' && row.event.data.message?.source?.callId === 'info'))
  extra[0].event.data.callId = 'second-info'; extra[0].event.data.turn = 2
  extra[1].event.data.turn = 2; extra[1].event.data.message.source.callId = 'second-info'
  extra[1].event.data.message.content[0].toolCallId = 'second-info'
  data.history.events.splice(data.history.events.findIndex(row => row.event === fact(data.history, 'plan')), 0, ...extra); reseq(data.history)
  assert.equal((await proveSameSessionFileRun(data)).regression.state, 'pass')
  const restored = data.history.events.find(row => row.event.type === 'request/header' && row.event.seq > result(data.history, 'plan').seq)
  const planRows = data.history.events.filter(row => row.event.type === 'tool/call' && row.event.data.callId === 'plan'
    || row.event.type === 'tool/result' && row.event.data.message?.source?.callId === 'plan' || row === restored)
  data.history.events = data.history.events.filter(row => !planRows.includes(row))
  data.history.events.splice(-1, 0, ...planRows); reseq(data.history)
  assert.equal((await proveSameSessionFileRun(data)).regression.state, 'fail')
})

test('missing registration, already-visible read, Code Mode and absent discovery are not rediscovery proof', async t => {
  for (const mutation of [
    info => { delete info.tool_availability.registered_tools },
    info => { info.tool_availability.registered_tools = ['write', 'xiaoshe_runtime_info', 'xiaoshe_capability_plan']; info.tool_availability.registered_count = 3 },
    info => { info.tools.push('read'); info.tool_availability.visible_count++ },
    info => { info.execution.tool_surface.presentation = 'code' },
  ]) {
    const data = await fixture(t)
    const block = textOf(result(data.history, 'info')), info = JSON.parse(block.text); mutation(info); block.text = JSON.stringify(info)
    assert.equal((await proveSameSessionFileRun(data)).regression.state, 'fail')
  }
  const data = await fixture(t, { planner: false, auto: false })
  assert.equal((await proveSameSessionFileRun(data)).regression.state, 'fail')
  assert.equal((await proveSameSessionFileRun(data)).tasks[1].state, 'pass', 'file task and discovery regression remain separate claims')
})

test('complete-history and exact two-human-turn bindings reject partial, merged, repeated and misbound events', async t => {
  const data = await fixture(t)
  for (const mutate of [
    input => { input.history.hasMore = true }, input => { input.history.events[3].event.seq = 2 },
    input => { input.userMessageIds = ['wrong', userMessageIds[1]] },
    input => { input.history.events.find(row => row.event.type === 'user/message').event.data.source.kind = 'plugin' },
    input => { input.history.events.findLast(row => row.event.type === 'turn/end').event.data.turn = 9 },
  ]) {
    const changed = structuredClone(data); mutate(changed)
    await assert.rejects(proveSameSessionFileRun(changed), /same-session-file-proof/u)
  }
  data.history.events.at(-1).event.data.reason.kind = 'max-tokens'
  assert.ok((await proveSameSessionFileRun(data)).tasks.every(task => task.state === 'fail'))
})

test('tool names, output existence and success flags without exact result content cannot pass', async t => {
  for (const id of ['source', 'write', 'readback']) {
    const data = await fixture(t)
    textOf(result(data.history, id)).text = 'ok'
    assert.equal((await proveSameSessionFileRun(data)).tasks[1].state, 'fail', id)
  }
  const data = await fixture(t)
  textOf(result(data.history, 'source')).text = readText('elsewhere/input.jsonl', inputText)
  assert.equal((await proveSameSessionFileRun(data)).tasks[0].state, 'fail')
})

test('failed, duplicate, foreign-turn and conflicting result identities fail closed', async t => {
  for (const mutation of [
    data => { result(data.history, 'source').data.message.content[0].isError = true },
    data => { result(data.history, 'source').data.message.source.callId = 'foreign' },
    data => { result(data.history, 'source').data.turn = 1 },
    data => { data.history.events.splice(-1, 0, structuredClone(data.history.events.find(row => row.event === result(data.history, 'source')))); reseq(data.history) },
    data => { fact(data.history, 'source').data.arguments = '{' },
  ]) {
    const data = await fixture(t); mutation(data)
    assert.equal((await proveSameSessionFileRun(data)).tasks[1].state, 'fail')
  }
})

test('readback must follow the successful write and the write must follow the complete source result', async t => {
  const data = await fixture(t)
  const writeRows = data.history.events.filter(row => ['tool/call', 'tool/result'].includes(row.event.type)
    && (row.event.data.callId === 'write' || row.event.data.message?.source?.callId === 'write'))
  data.history.events = data.history.events.filter(row => !writeRows.includes(row))
  data.history.events.splice(-1, 0, ...writeRows); reseq(data.history)
  assert.equal((await proveSameSessionFileRun(data)).tasks[1].state, 'fail')
})

test('exact nested SDK calls require a successful enclosing real run_code call, not orphan dispatch facts', async t => {
  const data = await fixture(t)
  const rootId = 'code-root'
  const first = data.history.events.findIndex(row => row.event === fact(data.history, 'source'))
  const nested = []
  for (const id of ['source', 'write', 'readback']) {
    const originalCall = fact(data.history, id), originalResult = result(data.history, id)
    const fields = { rootCallId: rootId, parentCallId: rootId, subCallId: id, name: originalCall.data.name, arguments: JSON.parse(originalCall.data.arguments) }
    nested.push({ event: { type: 'tool/code-dispatch-start', data: { ...fields } } },
      { event: { type: 'tool/code-dispatch', data: { ...fields, isError: false, content: originalResult.data.message.content[0].content } } })
  }
  const rootCall = { event: { type: 'tool/call', data: { turn: 2, step: 1, callId: rootId, name: 'run_code', arguments: '{"code":"fixture SDK program"}' } } }
  const rootResult = structuredClone(data.history.events.find(row => row.event === result(data.history, 'write')))
  rootResult.event.data.message.source.callId = rootId; rootResult.event.data.message.content[0].toolCallId = rootId
  data.history.events.splice(first, 6, rootCall, ...nested, rootResult); reseq(data.history)
  assert.equal((await proveSameSessionFileRun(data)).tasks[1].state, 'pass')
  data.history.events = data.history.events.filter(row => row !== rootCall && row !== rootResult); reseq(data.history)
  assert.equal((await proveSameSessionFileRun(data)).tasks[1].state, 'fail')
})

test('unapproved tools or attempted input writes fail even when expected final files exist', async t => {
  for (const mutate of [
    data => { fact(data.history, 'plan').data.name = 'bash' },
    data => { fact(data.history, 'write').data.arguments = JSON.stringify({ file_path: 'input.jsonl', content: inputText }) },
    data => { fact(data.history, 'source').data.arguments = JSON.stringify({ file_path: '../input.jsonl' }) },
  ]) {
    const data = await fixture(t); mutate(data)
    assert.equal((await proveSameSessionFileRun(data)).tasks[1].state, 'fail')
  }
})

test('independent file inspection rejects tampered source, wrong values, invented missing fields and extra files', async t => {
  for (const mutate of [
    async data => writeFile(join(data.workspaceRoot, 'input.jsonl'), inputText.replace('12.5', '99')),
    async data => writeFile(join(data.workspaceRoot, 'output/result.json'), JSON.stringify({ items: [] })),
    async data => { const changed = structuredClone(expected); changed.items[1].owner = 'invented'; await writeFile(join(data.workspaceRoot, 'output/result.json'), JSON.stringify(changed)) },
    async data => writeFile(join(data.workspaceRoot, 'extra.txt'), 'not permitted'),
    async data => mkdir(join(data.workspaceRoot, 'output/extra-directory')),
  ]) {
    const data = await fixture(t); await mutate(data)
    assert.equal((await proveSameSessionFileRun(data)).tasks[1].state, 'fail')
  }
})

test('baseline rejects dirty or symlinked input and requires a real missing-value fixture', async t => {
  const data = await fixture(t)
  await assert.rejects(captureSameSessionFileBaseline({ workspaceRoot: data.workspaceRoot }), /dirty_fixture_workspace/u)
  await rm(join(data.workspaceRoot, 'output/result.json'))
  await writeFile(join(data.workspaceRoot, 'input.jsonl'), '{"project":"All present","amount":1,"quantity":1,"owner":"Li"}\n')
  await assert.rejects(captureSameSessionFileBaseline({ workspaceRoot: data.workspaceRoot }), /missing_value_case_not_exercised/u)
  await rm(join(data.workspaceRoot, 'input.jsonl'))
  await writeFile(join(data.workspaceRoot, 'actual.jsonl'), inputText)
  await symlink(join(data.workspaceRoot, 'actual.jsonl'), join(data.workspaceRoot, 'input.jsonl'))
  await assert.rejects(captureSameSessionFileBaseline({ workspaceRoot: data.workspaceRoot }), /unexpected_workspace_entry/u)
})
