/** Synthetic offline ledgers test the proof's rejection boundaries, not a live agent. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BATCH_ITEMS, batchSourceBytes } from './batch-fixture.mjs'
import { proveBatchSeed, proveBatchTask } from './batch-task-proof.mjs'

const runId = '9f98c00e-e4fa-45a8-a6c9-5c6d83616cd5', sessionId = `xiaoshe-batch-${runId}`, candidateId = 'a'.repeat(64)
const hash = value => createHash('sha256').update(value).digest('hex')
const at = time => new Date(time).toISOString(), baseTime = Date.parse('2026-09-07T08:00:00.000Z')
const copy = value => ({ ...structuredClone(value), sourceBytes: Object.fromEntries(Object.entries(value.sourceBytes).map(([id, bytes]) => [id, Buffer.from(bytes)])) })
const readText = (path, text) => {
  const lines = text.replace(/\n$/u, '').split('\n')
  return `<path>${path}</path>\n<type>file</type>\n<content>\n${lines.map((line, index) => `${index + 1}: ${line}`).join('\n')}\n\n(End of file - total ${lines.length} lines)\n</content>`
}
const eventCall = (data, id) => data.history.events.find(row => row.event.type === 'tool/call' && row.event.data.callId === id).event
const eventResult = (data, id) => data.history.events.find(row => row.event.type === 'tool/result' && row.event.data.message.source.callId === id).event
const textBlock = event => event.data.message.content[0].content[0]

function refreshCheckpoint(data) {
  data.restartEvidence.checkpoint.historySha256 = hash(JSON.stringify(data.history.events.slice(0, data.restartEvidence.checkpoint.lastSeq + 1).map(row => row.event)))
}

function nativeCall(data, id) {
  return Object.values(data.nativeReports).flatMap(report => report.nativeActions).find(row => row.startedAt === at(eventCall(data, id).time + 10))
}

function mutateArguments(data, id, mutate) {
  const arguments_ = JSON.parse(eventCall(data, id).data.arguments); mutate(arguments_)
  eventCall(data, id).data.arguments = JSON.stringify(arguments_)
  nativeCall(data, id).args = structuredClone(arguments_)
  refreshCheckpoint(data)
}

function mutateValue(data, id, mutate) {
  const value = JSON.parse(textBlock(eventResult(data, id)).text); mutate(value)
  textBlock(eventResult(data, id)).text = JSON.stringify(value)
  nativeCall(data, id).value = structuredClone(value)
  refreshCheckpoint(data)
}

function referenceInput(data, phase, itemId) {
  const typeId = `${phase}-type-${itemId}`, verifyId = `${phase}-verify-type-${itemId}`
  const input = JSON.parse(eventCall(data, typeId).data.arguments), baseline = JSON.parse(textBlock(eventResult(data, typeId)).text)
  mutateArguments(data, verifyId, value => {
    delete value.expect_element_id; delete value.expect_value
    value.use_action_input = true; value.expect_url = baseline.url; value.expect_text = '尚未保存'
  })
  mutateValue(data, verifyId, value => {
    value.assertions = { expect_element_id: input.element_id, expect_value: input.text, expect_url: baseline.url, expect_text: '尚未保存' }
    value.assertion_source = { kind: 'browser_type_input', owner_id: sessionId, tab_id: baseline.tab_id,
      baseline_snapshot_id: baseline.snapshot_id, expect_element_id: input.element_id, input_sha256: hash(input.text) }
  })
}

function insertResumeObservation(data, command, sameSnapshotId = false) {
  const original = JSON.parse(textBlock(eventResult(data, 'resume-type-item-2')).text)
  const input = JSON.parse(eventCall(data, 'resume-type-item-2').data.arguments)
  const start = eventResult(data, 'resume-type-item-2').time + 10, id = `intervening-${command}`
  const current = { ...original, snapshot_id: sameSnapshotId ? original.snapshot_id : 'intervening-snapshot' }
  const arguments_ = { tab_id: original.tab_id, ...(command === 'verify'
    ? { after_snapshot_id: original.snapshot_id, expect_element_id: input.element_id, expect_value: input.text } : {}) }
  const value = command === 'verify' ? { status: 'verified', owner_id: sessionId, tab_id: original.tab_id,
    baseline_snapshot_id: original.snapshot_id, assertions: { expect_element_id: input.element_id, expect_value: input.text }, current } : current
  data.history.events.splice(eventCall(data, 'resume-verify-type-item-2').seq, 0,
    { event: { type: 'tool/call', time: start, data: { turn: 2, step: 1, callId: id, name: `browser_${command}`, arguments: JSON.stringify(arguments_) } } },
    { event: { type: 'tool/result', time: start + 30, data: { turn: 2, step: 1, message: { id: `result-${id}`, role: 'user', source: { kind: 'tool', callId: id },
      content: [{ type: 'tool-result', toolCallId: id, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] }] } } } })
  data.history.events.forEach((row, seq) => { row.event.seq = seq })
  data.nativeReports.resume.nativeActions.push({ ownerId: sessionId, command, args: arguments_, startedAt: at(start + 5), finishedAt: at(start + 20), status: 'success', value })
  refreshCheckpoint(data)
}

async function fixture(t) {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'xs-batch-proof-test-')))
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }))
  await mkdir(join(workspaceRoot, 'output'))
  const sourceBytes = batchSourceBytes(), expected = {}, outputs = {}
  for (const [index, item] of BATCH_ITEMS.entries()) {
    await writeFile(join(workspaceRoot, item.source), sourceBytes[item.itemId])
    if (index === 2) continue
    expected[item.itemId] = { items: sourceBytes[item.itemId].toString().trim().split('\n').map(line => { const row = JSON.parse(line); return { ...row, owner: row.owner ?? null } }) }
    outputs[item.itemId] = JSON.stringify(expected[item.itemId]) + '\n'
    await writeFile(join(workspaceRoot, item.target), outputs[item.itemId])
  }
  const events = [], origin = 'http://127.0.0.1:48123', basePath = `/${runId}/`, profileRoot = join(workspaceRoot, '..', 'test-only-profile')
  const serverEvidence = { schema: 'xiaoshe-batch-server/v1', runId, origin, basePath, requests: [], submissions: [], records: { 'item-1': null, 'item-2': null, 'item-3': null }, errorCode: null, closed: true }
  const nativeReports = {}
  let phase, turn, native, snapshotIndex = 0
  const append = (type, data) => { const event = { seq: events.length, time: baseTime + events.length * 100, type, data }; events.push({ event }); return event }
  const call = (id, name, args, value) => {
    const start = append('tool/call', { turn, step: 1, callId: id, name, arguments: JSON.stringify(args) })
    if (name.startsWith('browser_')) native.nativeActions.push({ ownerId: sessionId, command: name.slice(8), args: structuredClone(args), startedAt: at(start.time + 10), finishedAt: at(start.time + 70), status: 'success', value: structuredClone(value) })
    append('tool/result', { turn, step: 1, message: { id: `result-${id}`, role: 'user', source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, isError: false, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }] } })
    return start
  }
  const url = itemId => origin + basePath + itemId + '/'
  const get = (itemId, time, saved = true) => serverEvidence.requests.push({ ordinal: serverEvidence.requests.length + 1, itemId, method: 'GET', path: basePath + itemId + '/', at: at(time), finishedAt: at(time + 10), status: 200, recordSha256: saved ? hash(JSON.stringify(expected[itemId])) : null })
  const snapshot = (itemId, state = 'empty') => ({ snapshot_id: `snapshot-${++snapshotIndex}`, tab_id: `tab-${phase}`, owner_id: sessionId,
    url: url(itemId), source: 'isolated-browser-dom', physical_input_used: false, truncated: false,
    text: state === 'saved' ? `已保存（服务器记录）\n${JSON.stringify(expected[itemId])}` : '尚未保存',
    elements: [{ element_id: 'textarea', tag: 'textarea', name: '结构化结果 JSON', value: state === 'empty' ? '' : JSON.stringify(expected[itemId]) },
      { element_id: 'save', tag: 'button', name: '保存结果' }, { element_id: 'query', tag: 'button', name: '查看已保存记录' }] })
  const verify = (id, itemId, baseline, state, assertions) => {
    const current = snapshot(itemId, state)
    call(id, 'browser_verify', { tab_id: baseline.tab_id, after_snapshot_id: baseline.snapshot_id, ...assertions },
      { status: 'verified', snapshot_id: current.snapshot_id, tab_id: baseline.tab_id, owner_id: sessionId, baseline_snapshot_id: baseline.snapshot_id, assertions, current })
    return current
  }
  const deliver = itemId => {
    const item = BATCH_ITEMS.find(item => item.itemId === itemId)
    call(`${phase}-source-${itemId}`, 'read', { file_path: item.source }, readText(item.source, sourceBytes[itemId].toString()))
    call(`${phase}-write-${itemId}`, 'write', { file_path: item.target, content: outputs[itemId] }, `<path>${item.target}</path>\n<type>file</type>\n<content>\nCreated file\n</content>`)
    call(`${phase}-readback-${itemId}`, 'read', { file_path: item.target }, readText(item.target, outputs[itemId]))
    let current = snapshot(itemId)
    const opened = call(`${phase}-open-${itemId}`, 'browser_open', { url: url(itemId) }, current); get(itemId, opened.time + 20, false)
    current = verify(`${phase}-verify-open-${itemId}`, itemId, current, 'empty', { expect_url: url(itemId) })
    const typed = snapshot(itemId, 'typed')
    call(`${phase}-type-${itemId}`, 'browser_type', { tab_id: current.tab_id, snapshot_id: current.snapshot_id, element_id: 'textarea', text: JSON.stringify(expected[itemId]) }, typed)
    current = verify(`${phase}-verify-type-${itemId}`, itemId, typed, 'typed', { expect_element_id: 'textarea', expect_value: JSON.stringify(expected[itemId]) })
    const saved = snapshot(itemId, 'saved')
    const clicked = call(`${phase}-save-${itemId}`, 'browser_click', { tab_id: current.tab_id, snapshot_id: current.snapshot_id, element_id: 'save' }, saved)
    const post = { ordinal: serverEvidence.requests.length + 1, itemId, method: 'POST', path: basePath + itemId + '/save', at: at(clicked.time + 20), status: 200 }
    serverEvidence.requests.push(post)
    serverEvidence.submissions.push({ ordinal: serverEvidence.submissions.length + 1, itemId, requestOrdinal: post.ordinal, at: at(clicked.time + 30), persistedAt: at(clicked.time + 40), bodySha256: hash(JSON.stringify(expected[itemId])), status: 200, persisted: true, record: structuredClone(expected[itemId]) })
    serverEvidence.records[itemId] = structuredClone(expected[itemId])
    verify(`${phase}-verify-save-${itemId}`, itemId, saved, 'saved', { expect_text: '已保存（服务器记录）' })
  }
  const begin = name => {
    phase = name; turn = name === 'seed' ? 1 : 2
    const start = append('turn/start', { turn })
    native = { schema: 'xiaoshe-batch-native/v1', runId, sessionId, candidateId, phase, profileRoot, pid: turn === 1 ? 48124 : 48126,
      backendPid: turn === 1 ? 48125 : 48127, backendPort: 48128, startedAt: at(start.time - 40), accepted: true, nativeActions: [], finalPages: [], provenance: 'offline-test-fixture' }
    nativeReports[phase] = native
    append('user/message', { id: `${phase}-user`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: phase === 'seed' ? '处理三项资料，先交付第一项，然后等待受控重启。' : '继续同一批资料；先回读首项并查询服务器，再处理剩余两项。' }] })
  }
  const end = (answer, itemIds) => {
    append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
    const end = append('turn/end', { turn, reason: { kind: 'completed' } })
    native.finishedAt = at(end.time + 25)
    for (const itemId of itemIds) {
      get(itemId, end.time + 5)
      native.finalPages.push({ itemId, url: url(itemId), reloaded: true, rendererPid: native.pid + 100, capturedAt: at(end.time + 20), status: '已保存（服务器记录）', record: structuredClone(expected[itemId]) })
    }
    return end
  }
  begin('seed'); deliver('item-1')
  const seedEnd = end('第一项已交付并回读，其余未交付，等待重启继续。', ['item-1'])
  const checkpoint = { lastSeq: seedEnd.seq, savedAt: at(seedEnd.time + 26), historySha256: hash(JSON.stringify(events.map(row => row.event))) }
  begin('resume')
  call('resume-recovered-file', 'read', { file_path: 'output/item-1.json' }, readText('output/item-1.json', outputs['item-1']))
  const recovered = snapshot('item-1', 'saved'), query = call('resume-recovered-query', 'browser_open', { url: url('item-1') }, recovered)
  get('item-1', query.time + 20)
  verify('resume-verify-recovered', 'item-1', recovered, 'saved', { expect_url: url('item-1') })
  deliver('item-2')
  call('resume-broken', 'read', { file_path: 'input-3.jsonl' }, readText('input-3.jsonl', sourceBytes['item-3'].toString()))
  end('2/3 已交付。input-3.jsonl 第 2 行 JSON 语法错误，解析失败，未生成输出、未提交第三项。', ['item-1', 'item-2'])
  const restartEvidence = { runId, sessionId, candidateId, profileRoot, seed: { pid: 48124, backendPid: 48125 }, resume: { pid: 48126, backendPid: 48127 }, checkpoint,
    stopped: { desktopExited: true, backendExited: true, portReleased: true, backendPort: 48128, at: at(seedEnd.time + 30) } }
  return { runId, sessionId, candidateId, workspaceRoot, sourceBytes, history: { hasMore: false, events }, nativeReports, restartEvidence, serverEvidence }
}

test('offline fixed-batch artifact proof requires both item deliveries, fresh recovery checks and an honest invalid item', async t => {
  const data = await fixture(t), proof = await proveBatchTask(data)
  assert.equal(proof.status, 'pass', JSON.stringify(proof))
  assert.deepEqual(proof.items.map(item => item.state), ['delivered', 'delivered', 'invalid-reported'])
  assert.deepEqual(proof.tasks.map(task => task.taskId), ['files-batch-preserve-order', 'recovery-resume-after-restart'])
  assert.equal(proof.recovery.successfulWrites, 2); assert.equal(proof.recovery.submittedRequests, 2)
  assert.match(proof.boundary, /Offline test ledgers are test-only/)
})

test('both batch phases independently bind explicit action-input references without repeating input JSON', async t => {
  const data = await fixture(t)
  for (const [phase, itemId] of [['seed', 'item-1'], ['resume', 'item-2']]) {
    const typeId = `${phase}-type-${itemId}`, verifyId = `${phase}-verify-type-${itemId}`
    const input = `${JSON.parse(eventCall(data, typeId).data.arguments).text}\n`
    mutateArguments(data, typeId, value => { value.text = input })
    mutateValue(data, typeId, value => { value.elements[0].value = input })
    mutateValue(data, verifyId, value => { value.current.elements[0].value = input })
    referenceInput(data, phase, itemId)
  }
  const proof = await proveBatchTask(data)
  assert.equal(proof.status, 'pass', JSON.stringify(proof))
  assert.deepEqual(proof.items.map(item => item.state), ['delivered', 'delivered', 'invalid-reported'])
  assert.equal(proof.recovery.successfulWrites, 2)
  assert.equal(proof.recovery.submittedRequests, 2)
  assert.ok(proof.actionVerifications.every(row => row.state === 'pass'))
})

test('batch references reject cross-phase source, mixed/forged receipts and numeric or native mismatches', async t => {
  const data = await fixture(t)
  referenceInput(data, 'seed', 'item-1'); referenceInput(data, 'resume', 'item-2')
  const verifyId = 'resume-verify-type-item-2', typeId = 'resume-type-item-2'
  const mutations = [
    d => mutateValue(d, verifyId, value => { value.assertion_source = JSON.parse(textBlock(eventResult(d, 'seed-verify-type-item-1')).text).assertion_source }),
    d => mutateValue(d, verifyId, value => { value.assertion_source.owner_id = 'another-owner' }),
    d => mutateValue(d, verifyId, value => { value.assertion_source.input_sha256 = '0'.repeat(64) }),
    d => mutateValue(d, verifyId, value => { value.assertion_source.extra = true }),
    d => mutateValue(d, verifyId, value => { delete value.assertion_source }),
    d => mutateArguments(d, verifyId, value => { value.use_action_input = 1 }),
    d => mutateArguments(d, verifyId, value => { value.expect_element_id = 'textarea' }),
    d => mutateArguments(d, verifyId, value => { value.expect_value = JSON.parse(eventCall(d, typeId).data.arguments).text }),
    ...['expect_closed', 'expectElementId', 'expectValue', 'expectClosed'].map(key =>
      d => mutateArguments(d, verifyId, value => { value[key] = false })),
    d => mutateValue(d, verifyId, value => { delete value.snapshot_id }),
    d => mutateValue(d, verifyId, value => { value.snapshot_id = 'different-new-snapshot' }),
    d => mutateValue(d, typeId, value => { const parsed = JSON.parse(value.elements[0].value); parsed.items[0].amount += 0.1; value.elements[0].value = JSON.stringify(parsed) }),
    d => mutateValue(d, verifyId, value => { const parsed = JSON.parse(value.current.elements[0].value); parsed.items[0].amount += 0.1; value.current.elements[0].value = JSON.stringify(parsed) }),
    d => mutateValue(d, verifyId, value => { value.assertions.expect_element_id = 'different-input' }),
    d => { nativeCall(d, verifyId).args.use_action_input = false },
    d => { nativeCall(d, typeId).value.owner_id = 'another-owner' },
    d => { eventCall(d, verifyId).data.turn = 1 },
    d => { eventResult(d, typeId).data.message.content[0].isError = true },
  ]
  for (const [index, mutate] of mutations.entries()) {
    const changed = copy(data); mutate(changed)
    assert.equal((await proveBatchTask(changed)).status, 'fail', `mutation ${index}`)
  }
})

test('batch cannot reuse a type baseline after a newer snapshot or verifier, including identical copied IDs', async t => {
  const data = await fixture(t)
  referenceInput(data, 'seed', 'item-1'); referenceInput(data, 'resume', 'item-2')
  for (const [command, sameSnapshotId] of [['snapshot', false], ['snapshot', true], ['verify', false]]) {
    const changed = copy(data); insertResumeObservation(changed, command, sameSnapshotId)
    assert.equal((await proveBatchTask(changed)).status, 'fail', command)
  }
})

test('seed proof uses only actual seed-shaped artifacts and rejects later-item effects or missing action proof', async t => {
  const full = await fixture(t)
  referenceInput(full, 'seed', 'item-1')
  const { nativeReports, restartEvidence, ...data } = copy(full)
  data.nativeReport = nativeReports.seed
  data.history.events = data.history.events.slice(0, restartEvidence.checkpoint.lastSeq + 1)
  data.serverEvidence.requests = data.serverEvidence.requests.filter(row => row.at <= nativeReports.seed.finishedAt)
  data.serverEvidence.submissions = data.serverEvidence.submissions.slice(0, 1)
  data.serverEvidence.records['item-2'] = null
  data.serverEvidence.closed = false
  await rm(join(data.workspaceRoot, 'output/item-2.json'))
  const proof = await proveBatchSeed(data)
  assert.equal(proof.status, 'pass', JSON.stringify(proof))
  assert.deepEqual(proof.checkpoint, { lastSeq: restartEvidence.checkpoint.lastSeq, historySha256: restartEvidence.checkpoint.historySha256 })
  for (const mutate of [
    d => { d.serverEvidence.records['item-2'] = { items: [] } },
    d => { d.serverEvidence.closed = true },
    d => { eventCall(d, 'seed-verify-save-item-1').data.name = 'browser_snapshot' },
    d => { eventCall(d, 'seed-source-item-1').data.arguments = JSON.stringify({ file_path: 'input-2.jsonl' }) },
    d => { eventResult(d, 'seed-write-item-1').data.message.content[0].isError = true },
  ]) {
    const changed = copy(data); mutate(changed)
    assert.equal((await proveBatchSeed(changed)).status, 'fail')
  }
  await writeFile(join(data.workspaceRoot, 'output/item-2.json'), '{}')
  assert.equal((await proveBatchSeed(data)).status, 'fail')
})

test('restart proof rejects missing stop facts, reused processes, another candidate/profile/port and an unbound checkpoint', async t => {
  const data = await fixture(t)
  for (const mutate of [
    d => { delete d.restartEvidence }, d => { d.restartEvidence.stopped.desktopExited = false },
    d => { d.restartEvidence.stopped.backendExited = false }, d => { d.restartEvidence.stopped.portReleased = false },
    d => { d.nativeReports.resume.pid = d.nativeReports.seed.pid; d.restartEvidence.resume.pid = d.restartEvidence.seed.pid },
    d => { d.nativeReports.resume.candidateId = 'b'.repeat(64) }, d => { d.nativeReports.resume.profileRoot += '-other' },
    d => { d.restartEvidence.stopped.backendPort = 3080 }, d => { d.restartEvidence.checkpoint.historySha256 = '0'.repeat(64) },
    d => { d.restartEvidence.checkpoint.lastSeq = d.history.events.length - 1 },
  ]) {
    const changed = copy(data); mutate(changed)
    assert.equal((await proveBatchTask(changed)).status, 'fail')
  }
})

test('source/readback substitution and duplicate submits cannot be hidden behind a correct final page', async t => {
  const data = await fixture(t)
  for (const mutate of [
    d => { eventCall(d, 'resume-recovered-file').data.name = 'xiaoshe_runtime_info' },
    d => { textBlock(eventResult(d, 'resume-source-item-2')).text = textBlock(eventResult(d, 'seed-source-item-1')).text },
    d => { const request = d.serverEvidence.requests.find(row => row.itemId === 'item-1' && row.method === 'GET' && row.at > d.nativeReports.resume.startedAt); request.recordSha256 = '0'.repeat(64) },
    d => { const post = structuredClone(d.serverEvidence.requests.find(row => row.method === 'POST')); post.ordinal = d.serverEvidence.requests.length + 1; post.status = 409; d.serverEvidence.requests.push(post); d.serverEvidence.submissions.push({ ...d.serverEvidence.submissions[0], ordinal: 3, requestOrdinal: post.ordinal, persisted: false, status: 409 }) },
    d => { d.serverEvidence.records['item-2'].items.reverse() },
    d => { d.nativeReports.resume.finalPages = d.nativeReports.resume.finalPages.filter(row => row.itemId !== 'item-1') },
  ]) {
    const changed = copy(data); mutate(changed)
    assert.equal((await proveBatchTask(changed)).status, 'fail')
  }
})

test('a snapshot or foreign native result cannot replace independently bound action verification', async t => {
  const data = await fixture(t)
  for (const id of ['seed-verify-open-item-1', 'seed-verify-type-item-1', 'seed-verify-save-item-1', 'resume-verify-recovered', 'resume-verify-save-item-2']) {
    const changed = copy(data), event = eventCall(changed, id), result = eventResult(changed, id), old = JSON.parse(textBlock(result).text)
    const native = Object.values(changed.nativeReports).flatMap(report => report.nativeActions).find(row => row.startedAt === at(event.time + 10))
    event.data.name = 'browser_snapshot'; event.data.arguments = JSON.stringify({ tab_id: old.tab_id })
    textBlock(result).text = JSON.stringify(old.current)
    native.command = 'snapshot'; native.args = { tab_id: old.tab_id }; native.value = old.current
    assert.equal((await proveBatchTask(changed)).status, 'fail', id)
  }
  const foreign = copy(data); foreign.nativeReports.resume.nativeActions[0].ownerId = 'foreign-session'
  assert.equal((await proveBatchTask(foreign)).status, 'fail')
})

test('invalid source needs actual byte read plus truthful filename, line, cause and partial receipt', async t => {
  const data = await fixture(t)
  for (const answer of ['全部资料已成功交付，3/3。', '2/3 已交付，第三项跳过。', '2/3 已交付，input-3.jsonl 解析失败，未提交。', '2/3 已交付，input-3.jsonl 第2行有问题。']) {
    const changed = copy(data)
    changed.history.events.findLast(row => row.event.type === 'assistant/message').event.data.message.content[0].text = answer
    assert.equal((await proveBatchTask(changed)).status, 'fail', answer)
  }
  const unread = copy(data); eventCall(unread, 'resume-broken').data.name = 'xiaoshe_runtime_info'
  assert.equal((await proveBatchTask(unread)).status, 'fail')
})

test('current-file unparseable-line wording is accepted only as a direct diagnosis, with every other batch gate unchanged', async t => {
  const data = await fixture(t), diagnosis = 'input-3.jsonl 第 2 行不可解析'
  const rows = [
    ['direct', diagnosis, true],
    ['unable', 'input-3.jsonl 第2行无法解析。', true],
    ['causal', `未完成：第三项，因 ${diagnosis}，待提供可解析来源。`, true],
    ['Chinese numeral', 'input-3.jsonl 第二行无法解析。', true],
    ['JSON subject', 'input-3.jsonl 第2行的 JSON 无法解析。', true],
    ['Markdown list', '- ' + diagnosis, true],
    ['new paragraph', '示例：\nother.jsonl 第2行不可解析\n\n当前诊断\n' + diagnosis, true],
    ['new heading', '## 状态示例\nother.jsonl 第2行不可解析\n## 当前诊断\n' + diagnosis, true],
    ['other file', 'input-2.jsonl 第2行不可解析', false],
    ['other line', 'input-3.jsonl 第1行不可解析', false],
    ['filename prefix', 'other-' + diagnosis, false],
    ['not unable', 'input-3.jsonl 第2行不是无法解析', false],
    ['negation', '并非 ' + diagnosis, false],
    ['does not imply', '这不代表 ' + diagnosis, false],
    ['negated comma premise', '并非如此，' + diagnosis, false],
    ['ASCII quote', '"' + diagnosis + '"', false],
    ['CJK quote', '“' + diagnosis + '”', false],
    ['unclosed quote', '“' + diagnosis, false],
    ['unclosed multiline quote', '转述原话："\n' + diagnosis, false],
    ['multiline quote', '转述原话："\n' + diagnosis + '\n"', false],
    ['inline code', '`' + diagnosis + '`', false],
    ['fenced code', '```text\n' + diagnosis + '\n```', false],
    ['blockquote', '> ' + diagnosis, false],
    ['lazy blockquote', '> 引文\n' + diagnosis, false],
    ['inline example', '示例：' + diagnosis, false],
    ['example block', '状态示例：\n' + diagnosis, false],
    ['bold example label', '**示例：**\n' + diagnosis, false],
    ['example introduction', '以下仅为示例：\n' + diagnosis, false],
    ['conditional block', '条件：\n' + diagnosis, false],
    ['hypothetical', '如果 ' + diagnosis + '，请停止', false],
    ['generic incomplete', 'input-3.jsonl 第2行不完整', false],
    ['generic missing fields', 'input-3.jsonl 第2行字段缺失', false],
    ['not attempted', 'input-3.jsonl 第2行尚未解析', false],
  ]
  for (const [label, text, passed] of rows) await t.test(label, async () => {
    // Supply all pre-existing lexical gates independently so these cases test
    // only the new reason branch. The full synthetic native/server proof is
    // still evaluated; no live artifact, expected answer or run ID is imported.
    const changed = copy(data)
    const answer = `input-3.jsonl 第2行 JSON。\n${text}\n\n未生成 output/item-3.json；实际完成 2/3。`
    assert.equal(/无效|损坏|错误|截断|失败|invalid|malformed|unexpected|unterminated/iu.test(answer), false)
    changed.history.events.findLast(row => row.event.type === 'assistant/message').event.data.message.content[0].text = answer
    const proof = await proveBatchTask(changed)
    assert.equal(proof.status, passed ? 'pass' : 'fail', JSON.stringify(proof.checks.filter(row => row.state === 'fail')))
  })
  const changed = copy(data)
  changed.history.events.findLast(row => row.event.type === 'assistant/message').event.data.message.content[0].text = `${diagnosis}。未生成，实际完成2/3，但所有任务已完成，3/3。`
  assert.equal((await proveBatchTask(changed)).status, 'fail', 'new wording cannot override a contradictory completion claim')
  eventCall(changed, 'resume-broken').data.name = 'xiaoshe_runtime_info'
  assert.equal((await proveBatchTask(changed)).status, 'fail', 'a textual diagnosis does not manufacture an actual input read')
})

test('independent files and complete history fail closed on tampering, extra output, symlinks and truncation', async t => {
  const data = await fixture(t)
  await writeFile(join(data.workspaceRoot, 'output/item-3.json'), '{}')
  assert.equal((await proveBatchTask(data)).status, 'fail')
  await rm(join(data.workspaceRoot, 'output/item-3.json'))
  await writeFile(join(data.workspaceRoot, 'input-1.jsonl'), 'changed')
  assert.equal((await proveBatchTask(data)).status, 'fail')
  await writeFile(join(data.workspaceRoot, 'input-1.jsonl'), data.sourceBytes['item-1'])
  await rm(join(data.workspaceRoot, 'output/item-2.json'))
  await symlink(join(data.workspaceRoot, 'input-2.jsonl'), join(data.workspaceRoot, 'output/item-2.json'))
  assert.equal((await proveBatchTask(data)).status, 'fail')
  const truncated = copy(data); truncated.history.hasMore = true
  await assert.rejects(proveBatchTask(truncated), /incomplete_history/)
  const gap = copy(data); gap.history.events[3].event.seq = 99
  await assert.rejects(proveBatchTask(gap), /invalid_history/)
})


// Explicit opt-in fixtures below are synthetic rejection-boundary tests only.
// They never replay or reclassify a retained paid run.
const admissionDenial = "Error: 验证断言与该动作的原始观察不一致；本次尚未独立回读页面，当前基线和原有效期未刷新。这不表示页面动作失败；请依据任务和已有观察修正断言，用同一 after_snapshot_id 重试，不要重做动作。不会自动反转义或改写预期。"
function reindexRecoveryFixture(data) {
  data.history.events.forEach((row, seq) => { row.event.seq = seq })
  data.restartEvidence.checkpoint.lastSeq = data.history.events.find(row => row.event.type === 'turn/end' && row.event.data.turn === 1).event.seq
  refreshCheckpoint(data)
}
function insertAdmissionFailure(data, phase = 'seed', itemId = 'item-1', suffix = '') {
  const verifierId = `${phase}-verify-save-${itemId}`, verifier = eventCall(data, verifierId)
  const id = `admission-${phase}${suffix}`, time = verifier.time - (suffix ? 25 : 60)
  const args = { ...JSON.parse(verifier.data.arguments), expect_text: 'synthetic missing assertion' }
  const denied = { event: { type: 'tool/call', time, data: { turn: verifier.data.turn, step: 1, callId: id, name: 'browser_verify', arguments: JSON.stringify(args) } } }
  const result = { event: { type: 'tool/result', time: time + 20, data: { turn: verifier.data.turn, step: 1,
    message: { id: `result-${id}`, role: 'user', source: { kind: 'tool', callId: id },
      content: [{ type: 'tool-result', toolCallId: id, isError: true, content: [{ type: 'text', text: admissionDenial }] }] } } } }
  data.history.events.splice(verifier.seq, 0, denied, result)
  data.nativeReports[phase].nativeActions.push({ ownerId: sessionId, command: 'verify', args: structuredClone(args),
    startedAt: at(time + 10), finishedAt: at(time + 15), status: 'error', code: 'BROWSER_VERIFICATION_ARGUMENT', message: admissionDenial.slice(7) })
  reindexRecoveryFixture(data)
  return id
}
function insertPlanFailure(data, phase = 'resume', itemId = 'item-2', text = 'Error: 复杂任务尚未完成行动前准备：先用任务清单记录少量可更新步骤。取得一次真实结果后再实施，不要通过重复同一写入调用绕过。') {
  const write = eventCall(data, `${phase}-write-${itemId}`), id = `plan-${phase}`, time = write.time - 60
  const args = JSON.parse(write.data.arguments)
  data.history.events.splice(write.seq, 0,
    { event: { type: 'tool/call', time, data: { turn: write.data.turn, step: 1, callId: id, name: 'write', arguments: JSON.stringify(args) } } },
    { event: { type: 'tool/result', time: time + 20, data: { turn: write.data.turn, step: 1, message: { id: `result-${id}`, role: 'user', source: { kind: 'tool', callId: id },
      content: [{ type: 'tool-result', toolCallId: id, isError: true, content: [{ type: 'text', text }] }] } } } })
  reindexRecoveryFixture(data); return id
}
async function onlySeed(data) {
  const { nativeReports, restartEvidence, ...seed } = copy(data)
  seed.nativeReport = nativeReports.seed
  seed.history.events = seed.history.events.slice(0, restartEvidence.checkpoint.lastSeq + 1)
  seed.serverEvidence.requests = seed.serverEvidence.requests.filter(row => row.at <= nativeReports.seed.finishedAt)
  seed.serverEvidence.submissions = seed.serverEvidence.submissions.slice(0, 1)
  seed.serverEvidence.records['item-2'] = null; seed.serverEvidence.closed = false
  await rm(join(seed.workspaceRoot, 'output/item-2.json'), { force: true })
  return seed
}

test('existing default remains seed zero-error; bounded recovery is explicit and never labels an error zero', async t => {
  const full = await fixture(t); insertAdmissionFailure(full)
  const seed = await onlySeed(full)
  const existing = await proveBatchSeed(seed)
  assert.equal(existing.status, 'fail')
  assert.equal(existing.acceptanceMode, 'existing')
  assert.equal(existing.quality.strictZeroToolErrors, false)
  const recovered = await proveBatchSeed({ ...seed, acceptanceMode: 'bounded-admission-recovery' })
  assert.equal(recovered.status, 'pass', JSON.stringify(recovered))
  assert.deepEqual(recovered.quality, { acceptanceMode: 'bounded-admission-recovery', strictZeroToolErrors: false,
    failedToolCalls: 1, recoveredToolCalls: 1, unclassifiedFailedToolCalls: 0, recoveryBudgetLimit: 1,
    recoveryBudgetUsed: 1, browserAssertionRejectedCalls: 1, planRejectedCalls: 0 })
  assert.equal(recovered.independent.nativeIdentityBound, true)
  assert.equal(recovered.independent.browserCallsBound, true)
})

test('existing whole-journey PLAN exception stays unchanged while its quality reports the real error', async t => {
  const data = await fixture(t); insertPlanFailure(data)
  const proof = await proveBatchTask(data)
  assert.equal(proof.status, 'pass', JSON.stringify(proof))
  assert.equal(proof.quality.strictZeroToolErrors, false)
  assert.equal(proof.quality.failedToolCalls, 1)
  assert.equal(proof.acceptanceMode, 'existing')
  assert.equal((await proveBatchTask({ ...data, acceptanceMode: 'bounded-admission-recovery' })).status, 'pass')
})

test('both phases allow one correctly bound recovery only when explicitly selected', async t => {
  for (const [phase, itemId] of [['seed', 'item-1'], ['resume', 'item-2']]) {
    const data = await fixture(t); insertAdmissionFailure(data, phase, itemId)
    assert.equal((await proveBatchTask(data)).status, 'fail')
    const proof = await proveBatchTask({ ...data, acceptanceMode: 'bounded-admission-recovery' })
    assert.equal(proof.status, 'pass', JSON.stringify(proof))
    assert.equal(proof.recovery.successfulWrites, 2); assert.equal(proof.recovery.submittedRequests, 2)
    assert.equal(proof.quality.failedToolCalls, 1); assert.equal(proof.quality.recoveredToolCalls, 1)
    assert.ok(proof.actionVerifications.every(row => row.state === 'pass'))
  }
})

test('full history cannot refresh a consumed seed budget in resume or combine it with PLAN', async t => {
  for (const extra of ['browser', 'plan', 'same-phase-browser']) {
    const data = await fixture(t); insertAdmissionFailure(data)
    if (extra === 'browser') insertAdmissionFailure(data, 'resume', 'item-2')
    else if (extra === 'plan') insertPlanFailure(data)
    else insertAdmissionFailure(data, 'seed', 'item-1', '-second')
    const proof = await proveBatchTask({ ...data, acceptanceMode: 'bounded-admission-recovery' })
    assert.equal(proof.status, 'fail', extra)
    assert.equal(proof.quality.failedToolCalls, 2)
    assert.equal(proof.quality.recoveryBudgetUsed, 2)
  }
})

test('new mode allows one actual PLAN-then-create seed but does not add JSON or arbitrary write denials', async t => {
  const data = await fixture(t); insertPlanFailure(data, 'seed', 'item-1')
  const seed = await onlySeed(data)
  assert.equal((await proveBatchSeed(seed)).status, 'fail')
  const good = await proveBatchSeed({ ...seed, acceptanceMode: 'bounded-admission-recovery' })
  assert.equal(good.status, 'pass', JSON.stringify(good))
  for (const text of ['Error: XIAOSHE_JSON_DOCUMENT: invalid JSON', 'Error: rejected', admissionDenial]) {
    const changed = copy(seed); textBlock(eventResult(changed, 'plan-seed')).text = text
    assert.equal((await proveBatchSeed({ ...changed, acceptanceMode: 'bounded-admission-recovery' })).status, 'fail')
  }
})

test('recovery requires exact host rejection, argument failure, fresh DOM, owner, phase and unique matching', async t => {
  const data = await fixture(t), id = insertAdmissionFailure(data)
  const mutations = [
    d => { nativeCall(d, id).code = 'BROWSER_STALE' },
    d => { nativeCall(d, id).message += ' other' },
    d => { textBlock(eventResult(d, id)).text += ' other' },
    d => { nativeCall(d, id).value = {} },
    d => { nativeCall(d, id).screenshot = 'not-a-proof' },
    d => { nativeCall(d, id).snapshot_id = 'new-observation' },
    d => { nativeCall(d, id).status = 'success' },
    d => { nativeCall(d, id).ownerId = 'another-owner' },
    d => { eventResult(d, id).data.message.content[0].isError = false },
    d => { eventCall(d, id).data.turn = 2 },
    d => { eventResult(d, id).data.turn = 2 },
    d => { d.nativeReports.seed.nativeActions.push(structuredClone(nativeCall(d, id))) },
    d => mutateArguments(d, id, args => { args.tab_id = 'other-tab' }),
    d => mutateArguments(d, id, args => { args.after_snapshot_id = 'other-baseline' }),
    d => mutateArguments(d, id, args => { args.expect_text = '已保存（服务器记录）' }),
    d => mutateArguments(d, id, args => { args.expect_text = 123 }),
    d => mutateArguments(d, id, args => { args.expect_text = '' }),
    d => mutateArguments(d, id, args => { args.expect_closed = false }),
    d => mutateArguments(d, id, args => { args.use_action_input = true }),
    d => mutateValue(d, 'seed-verify-save-item-1', value => { value.status = 'mismatch' }),
    d => mutateValue(d, 'seed-verify-save-item-1', value => { value.snapshot_id = 'alias-mismatch' }),
    d => mutateValue(d, 'seed-verify-save-item-1', value => { value.current.snapshot_id = value.baseline_snapshot_id; value.snapshot_id = value.baseline_snapshot_id }),
    d => mutateValue(d, 'seed-verify-save-item-1', value => { value.current.source = 'synthetic-other-source' }),
    d => mutateValue(d, 'seed-verify-save-item-1', value => { value.current.physical_input_used = true }),
    d => mutateValue(d, 'seed-verify-save-item-1', value => { value.current.truncated = true }),
    d => mutateValue(d, 'seed-verify-save-item-1', value => { value.current.text = 'not saved' }),
    d => mutateValue(d, 'seed-save-item-1', value => { value.source = 'fake-source' }),
    d => { nativeCall(d, 'seed-verify-save-item-1').value.status = 'mismatch' },
  ]
  for (const [index, mutate] of mutations.entries()) {
    const changed = copy(data); mutate(changed); refreshCheckpoint(changed)
    assert.equal((await proveBatchTask({ ...changed, acceptanceMode: 'bounded-admission-recovery' })).status, 'fail', `recovery mutation ${index}`)
  }
})


function insertAfterDenialObservation(data, id, { command = 'snapshot', sameSnapshotId = false } = {}) {
  const phase = id.includes('resume') ? 'resume' : 'seed', itemId = phase === 'seed' ? 'item-1' : 'item-2'
  const verifier = eventCall(data, `${phase}-verify-save-${itemId}`), actionValue = JSON.parse(textBlock(eventResult(data, `${phase}-save-${itemId}`)).text)
  const eventId = `intervening-${command}-recovery`, time = verifier.time - 10
  const current = { ...actionValue, snapshot_id: sameSnapshotId ? actionValue.snapshot_id : 'intervening-recovery-snapshot' }
  const args = { tab_id: current.tab_id, ...(command === 'verify' ? { after_snapshot_id: actionValue.snapshot_id, expect_text: 'saved' } : {}) }
  const value = command === 'verify' ? { status: 'mismatch', snapshot_id: current.snapshot_id, baseline_snapshot_id: actionValue.snapshot_id, owner_id: sessionId, tab_id: current.tab_id, assertions: { expect_text: 'saved' }, current } : current
  data.history.events.splice(verifier.seq, 0,
    { event: { type: 'tool/call', time, data: { turn: verifier.data.turn, step: 1, callId: eventId, name: `browser_${command}`, arguments: JSON.stringify(args) } } },
    { event: { type: 'tool/result', time: time + 8, data: { turn: verifier.data.turn, step: 1, message: { id: `result-${eventId}`, role: 'user', source: { kind: 'tool', callId: eventId },
      content: [{ type: 'tool-result', toolCallId: eventId, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] }] } } } })
  data.nativeReports[phase].nativeActions.push({ ownerId: sessionId, command, args, startedAt: at(time + 1), finishedAt: at(time + 5), status: 'success', value })
  reindexRecoveryFixture(data)
}
test('a later new observation or actual DOM mismatch cannot refill an old action after a rejection', async t => {
  const data = await fixture(t), id = insertAdmissionFailure(data)
  for (const spec of [{}, { sameSnapshotId: true }, { command: 'verify' }]) {
    const changed = copy(data); insertAfterDenialObservation(changed, id, spec)
    assert.equal((await proveBatchTask({ ...changed, acceptanceMode: 'bounded-admission-recovery' })).status, 'fail', JSON.stringify(spec))
  }
})

function delayRecovery(data, from, delay) {
  for (const row of data.history.events) if (row.event.time >= from) row.event.time += delay
  const shift = object => {
    if (!object || typeof object !== 'object') return
    for (const [key, value] of Object.entries(object)) {
      if (typeof value === 'string' && /^2026-09-07T/u.test(value) && Date.parse(value) >= from) object[key] = at(Date.parse(value) + delay)
      else if (typeof value === 'object') shift(value)
    }
  }
  shift(data.nativeReports); shift(data.serverEvidence); shift(data.restartEvidence)
  reindexRecoveryFixture(data)
}
test('the original action expires at 45 seconds, not 45 seconds after its failed admission', async t => {
  const data = await fixture(t), id = insertAdmissionFailure(data)
  const elapsed = Date.parse(nativeCall(data, 'seed-verify-save-item-1').startedAt) - Date.parse(nativeCall(data, 'seed-save-item-1').finishedAt)
  for (const [limit, expected] of [[45_000, 'pass'], [45_001, 'fail']]) {
    const changed = copy(data); delayRecovery(changed, eventCall(changed, id).time, limit - elapsed)
    const proof = await proveBatchTask({ ...changed, acceptanceMode: 'bounded-admission-recovery' })
    assert.equal(proof.status, expected, JSON.stringify(proof))
  }
})

test('bounded recovery does not relax duplicate POST, prior item resubmit, fresh file or original input proof', async t => {
  const data = await fixture(t); insertAdmissionFailure(data)
  for (const mutate of [
    d => { d.serverEvidence.submissions.push(structuredClone(d.serverEvidence.submissions[0])) },
    d => { d.serverEvidence.requests.push({ ...d.serverEvidence.requests.find(row => row.method === 'POST'), ordinal: d.serverEvidence.requests.length + 1 }) },
    d => { textBlock(eventResult(d, 'seed-readback-item-1')).text = 'a successful read is claimed' },
    d => { textBlock(eventResult(d, 'resume-recovered-file')).text = 'no fresh bytes' },
    d => { d.restartEvidence.stopped.desktopExited = false },
    d => { d.nativeReports.resume.finalPages[0].record = {} },
  ]) {
    const changed = copy(data); mutate(changed); refreshCheckpoint(changed)
    assert.equal((await proveBatchTask({ ...changed, acceptanceMode: 'bounded-admission-recovery' })).status, 'fail')
  }
})

test('unknown mode is rejected before proof and zero-error legacy success reports facts honestly', async t => {
  const data = await fixture(t)
  for (const acceptanceMode of ['strict', '', true, {}, null]) await assert.rejects(proveBatchTask({ ...data, acceptanceMode }), /invalid_acceptance_mode/)
  const proof = await proveBatchTask(data)
  assert.equal(proof.quality.strictZeroToolErrors, true)
  assert.equal(proof.quality.failedToolCalls, 0)
  assert.equal(proof.quality.recoveredToolCalls, 0)
})

test('unmatched typed native errors outside user/turn windows cannot borrow the recovery exemption', async t => {
  for (const where of ['before-user', 'after-turn', 'extra-after-valid-recovery']) {
    const data = await fixture(t), native = data.nativeReports.seed
    if (where === 'extra-after-valid-recovery') insertAdmissionFailure(data)
    const time = where === 'before-user' ? Date.parse(native.startedAt) : Date.parse(native.finishedAt) - 5
    native.nativeActions.push({ ownerId: sessionId, command: 'verify',
      args: { tab_id: 'unbound-test-only', after_snapshot_id: 'unbound-test-only', expect_text: 'missing' },
      startedAt: at(time), finishedAt: at(time), status: 'error', code: 'BROWSER_VERIFICATION_ARGUMENT', message: admissionDenial.slice(7) })
    const proof = await proveBatchTask({ ...data, acceptanceMode: 'bounded-admission-recovery' })
    assert.equal(proof.status, 'fail', where)
    assert.equal(proof.independent.unboundRecoveryErrorRows, 1)
    assert.equal(proof.independent.browserCallsBound, false)
    assert.equal(proof.quality.failedToolCalls, where === 'extra-after-valid-recovery' ? 1 : 0)
  }
})
