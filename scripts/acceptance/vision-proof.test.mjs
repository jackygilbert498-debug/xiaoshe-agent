import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createVisionFixture, assertVisionFixture, visionQuestion } from './vision-fixture.mjs'
import { proveVisionTask, VISION_TASK_IDS, normalizeModLens322VisionResult } from './vision-proof.mjs'

// Offline fixtures only: these deliberately fake the child receipt in tests.
// A live runner must capture it around the actual paid engine child instead.
const at = delta => new Date(Date.parse('2026-09-07T12:00:00.000Z') + delta).toISOString()
const millis = delta => Date.parse(at(delta))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function scenario(kind = 'path') {
  const fixture = createVisionFixture({ nonce: '51e8d895492940f89855d633f15e4ab0' })
  const input = { kind, bytes: Buffer.from(fixture.png), ...(kind === 'path' ? { path: '/isolated/image.png' }
    : { attachmentId: `sha256:${fixture.manifest.imageSha256}` }) }
  const answer = JSON.stringify(fixture.manifest.expected)
  const data = { taskId: VISION_TASK_IDS[kind === 'path' ? 0 : 1], runId: 'offline-run', sessionId: 'offline-session',
    fixture, input, expectedEngine: { provider: 'codex-cli', model: 'offline-model', executableSha256: 'a'.repeat(64),
      nodeExecutableSha256: 'd'.repeat(64), cliSha256: 'e'.repeat(64),
      outputSchemaPath: '/isolated/modlens/dist/xiaoshe-vision-output-schema.json', outputSchemaSha256: '9'.repeat(64) } }
  const events = [], append = (type, body, delta) => events.push({ event: { seq: events.length, time: millis(delta), type, data: body } })
  append('session/header', { id: data.sessionId }, 0)
  append('turn/start', { turn: 1 }, 100)
  const content = [{ type: 'text', text: visionQuestion(input) }]
  if (kind === 'attachment') content.push({ type: 'image', attachment: { attachmentId: input.attachmentId,
    mediaType: 'image/png', bytes: fixture.png.length, width: fixture.manifest.width, height: fixture.manifest.height, name: 'image.png' } })
  append('user/message', { id: 'user-1', role: 'user', source: { kind: 'user' }, content }, 200)
  append('request/header', { header: { config: { provider: 'deepseek-modlens', model: 'deepseek-v4-flash', maxTokens: 2048 },
    tools: kind === 'path' ? [{ name: 'modlens_read_image' }] : [] } }, 250)
  if (kind === 'path') {
    append('tool/call', { turn: 1, step: 1, callId: 'vision-call', name: 'modlens_read_image', arguments: JSON.stringify({ path: input.path }) }, 300)
    append('tool/result', { turn: 1, step: 1, message: { id: 'vision-result', role: 'user', source: { kind: 'tool', callId: 'vision-call' },
      content: [{ type: 'tool-result', toolCallId: 'vision-call', isError: false, content: [{ type: 'text', text: answer }] }] } }, 600)
  }
  append('assistant/message', { message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-modlens', model: 'deepseek-v4-flash' },
    content: [{ type: 'text', text: answer }] } }, 700)
  append('turn/end', { turn: 1, reason: { kind: 'completed' } }, 800)
  data.history = { events, hasMore: false }
  data.engineReceipts = [{ schema: 'xiaoshe-vision-envelope/v1', runId: data.runId, sessionId: data.sessionId,
    ordinal: 1, pid: 12345, startedAt: at(400), finishedAt: at(500), exitCode: 0, errorCode: null,
    inputPath: kind === 'path' ? input.path : '/isolated/temp/paste.png', inputSha256: fixture.manifest.imageSha256,
    executable: { path: '/public/node', sha256: data.expectedEngine.nodeExecutableSha256 },
    cli: { path: '/isolated/modlens/dist/main.js', sha256: data.expectedEngine.cliSha256 },
    cleanup: { status: 'confirmed', confirmedBy: 'ESRCH', groupId: 12345 },
    output: { image: kind === 'path' ? input.path : '/isolated/temp/paste.png', provider: 'codex-cli',
      result: { summary: answer, ocr: { full_text: '', lines: [] }, layout: { regions: [] },
        semantics: { scene: 'Colored geometric shapes', entities: [] }, visual: {}, uncertainty: [] },
      meta: { generatedAt: at(480), model: 'offline-model', conversationId: 'independent-vision-conversation',
        usage: { input_tokens: 111, cached_input_tokens: 20, output_tokens: 45 },
        attempts: [{ provider: 'codex-cli', ok: true, durationSeconds: 0.08 }] } } }]
  const outer = data.engineReceipts[0]
  data.processReceipt = { schema: 'xiaoshe-vision-engine-process/v1', runId: data.runId, sessionId: data.sessionId, ordinal: 1,
    provider: 'codex-cli', model: 'offline-model', pid: 12346, startedAt: at(410), finishedAt: at(470), exitCode: 0, errorCode: null,
    executable: { path: '/public/codex', sha256: data.expectedEngine.executableSha256 },
    outputSchema: { path: data.expectedEngine.outputSchemaPath, sha256: data.expectedEngine.outputSchemaSha256 },
    inputPath: '/isolated/vision-work/copied.png', inputSha256: fixture.manifest.imageSha256,
    cleanup: { status: 'confirmed', confirmedBy: 'ESRCH', groupId: 12346 },
    conversationId: outer.output.meta.conversationId, result: structuredClone(outer.output.result), usage: structuredClone(outer.output.meta.usage) }
  setRawEngine(data)
  if (kind === 'attachment') input.delivery = { schema: 'xiaoshe-vision-native-attachment/v1', runId: data.runId, sessionId: data.sessionId,
    source: 'native_clipboard', trustedPaste: true, previewCount: 1, pasteAt: at(110), submitStartedAt: at(180), submitCompletedAt: at(210),
    userMessageId: 'user-1', attachmentId: input.attachmentId, imageSha256: fixture.manifest.imageSha256 }
  return data
}

function setRawEngine(data) {
  const receipt = data.processReceipt
  data.rawEngineStdout = [{ type: 'thread.started', thread_id: receipt.conversationId }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(receipt.result) } },
    { type: 'turn.completed', ...(receipt.usage ? { usage: receipt.usage } : {}) }].map(JSON.stringify).join('\n') + '\n'
  receipt.rawStdoutSha256 = digest(data.rawEngineStdout)
}

const find = (data, type) => data.history.events.find(row => row.event.type === type).event
const answerBlock = data => find(data, 'assistant/message').data.message.content[0]
const resequence = data => data.history.events.forEach((row, index) => { row.event.seq = index })

test('fixture is deterministic raster geometry with no text/metadata and private nonce binding', () => {
  const first = createVisionFixture({ nonce: 'a'.repeat(32) }), same = createVisionFixture({ nonce: 'a'.repeat(32) })
  assert.deepEqual(first, same)
  assert.notDeepEqual(first.manifest.expected, createVisionFixture({ nonce: 'b'.repeat(32) }).manifest.expected)
  assert.equal(first.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  const types = [], data = []
  for (let offset = 8; offset < first.png.length;) {
    const length = first.png.readUInt32BE(offset), type = first.png.subarray(offset + 4, offset + 8).toString()
    types.push(type)
    if (type === 'IDAT') data.push(first.png.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND'])
  const raster = inflateSync(Buffer.concat(data)), pixels = Buffer.alloc(600 * 400 * 3)
  assert.equal(raster.length, 400 * (600 * 3 + 1))
  for (let y = 0; y < 400; y++) {
    assert.equal(raster[y * 1801], 0)
    raster.copy(pixels, y * 1800, y * 1801 + 1, (y + 1) * 1801)
  }
  assert.equal(digest(pixels), first.manifest.pixelsSha256)
  assert.equal(digest(first.png), first.manifest.imageSha256)
  assert(first.manifest.expected.rows.every(row => row.length === 3))
  assert.equal(first.manifest.expected.rows.length, 2)
  assert(!first.png.includes(Buffer.from(first.manifest.nonce)))
  assert(!visionQuestion({ kind: 'attachment' }).includes(JSON.stringify(first.manifest.expected)))
})

test('tampered expected answer, nonce, bytes or input hash fail fixture binding', () => {
  assert.throws(() => createVisionFixture({ nonce: 'bad' }), /invalid_nonce/u)
  for (const change of [
    data => { data.fixture.manifest.expected.rows[0][0].color = 'black' },
    data => { data.fixture.manifest.nonce = 'a'.repeat(32) },
    data => { data.fixture.png[100] ^= 1 },
    data => { data.input.bytes[100] ^= 1 },
  ]) { const data = scenario(); change(data); assert.throws(() => proveVisionTask(data), /vision-/u) }
  assert.equal(assertVisionFixture(scenario().fixture).width, 600)
})

test('path task needs exact real-engine receipt, native tool result and matching geometric answer', () => {
  const proof = proveVisionTask(scenario())
  assert.equal(proof.state, 'pass')
  assert.deepEqual(proof.checks.map(c => c.id), ['fresh-session', 'real-vision-provider-used', 'target-content-matched'])
  assert.deepEqual(proof.engineUsage, { status: 'reported', inputTokens: 111, outputTokens: 45, cachedInputTokens: 20 })
  assert.equal(proof.monetaryHardCap, false)
})

test('public ModLens 3.22.0 seven optional-null paths normalize without changing raw evidence', () => {
  const data = scenario(), raw = data.processReceipt.result
  raw.semantics.intent = null
  raw.semantics.relations = null
  raw.semantics.entities = [{ name: 'shape', type: 'geometry', evidence: null }]
  raw.visual = { dominant_colors: null, style: null, notes: null }
  data.engineReceipts[0].output.result.semantics.entities = [{ name: 'shape', type: 'geometry' }]
  setRawEngine(data)
  assert.equal(proveVisionTask(data).state, 'pass')
  const before = structuredClone(raw)
  const withText = structuredClone(raw)
  withText.ocr.lines = [{ text: 'schema-only fixture', language: null }]
  const normalized = normalizeModLens322VisionResult(withText)
  assert.deepEqual(normalized.ocr.lines, [{ text: 'schema-only fixture' }])
  assert.deepEqual(normalized.semantics, { scene: raw.semantics.scene, entities: [{ name: 'shape', type: 'geometry' }] })
  assert.deepEqual(normalized.visual, {})
  assert.deepEqual(raw, before)
  // Even a normalizable discrepancy is forbidden between original JSONL and
  // the independently captured inner receipt; only inner -> outer normalizes.
  delete raw.semantics.intent
  assert.equal(proveVisionTask(data).state, 'fail')
})

test('required nulls never normalize into valid vision results, even when both receipts agree', () => {
  for (const mutate of [
    r => { r.layout = null }, r => { r.visual = null }, r => { r.semantics.scene = null },
    r => { r.semantics.entities = null }, r => { r.layout.regions = null },
    r => { r.layout.regions = [{ type: 'shape', reading_order: null, text: '' }] },
    r => { r.semantics.entities = [{ name: null, type: 'shape' }] },
    r => { r.semantics.relations = [{ subject: 'a', predicate: null, object: 'b' }] },
  ]) {
    const data = scenario(); mutate(data.processReceipt.result)
    data.engineReceipts[0].output.result = structuredClone(data.processReceipt.result)
    setRawEngine(data)
    assert.equal(proveVisionTask(data).state, 'fail')
  }
})

test('pinned normalization cannot delete unknown nulls, non-null optionals or change values', () => {
  for (const [rawValue, outerValue] of [['actual', undefined], ['actual', 'changed'], ['', undefined], [null, 'invented']]) {
    const data = scenario(); data.processReceipt.result.semantics.intent = rawValue
    if (outerValue !== undefined) data.engineReceipts[0].output.result.semantics.intent = outerValue
    setRawEngine(data)
    assert.equal(proveVisionTask(data).state, 'fail')
  }
  const data = scenario(); data.processReceipt.result.visual.unknown = null; setRawEngine(data)
  assert.equal(proveVisionTask(data).state, 'fail')
  data.engineReceipts[0].output.result.visual.unknown = null
  assert.equal(proveVisionTask(data).state, 'pass')
})

test('real attachment contract includes durable image bytes and separately observed native paste/submit', () => {
  const proof = proveVisionTask(scenario('attachment'))
  assert.equal(proof.state, 'pass')
  assert.deepEqual(proof.checks.map(c => c.id), ['fresh-session', 'attachment-delivered', 'real-vision-provider-used', 'target-content-matched'])
})

test('all actually reported CLI usage counters survive the inner and outer receipt comparison', () => {
  const data = scenario()
  const usage = { input_tokens: 9071, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 123, reasoning_output_tokens: 0 }
  data.processReceipt.usage = structuredClone(usage)
  data.engineReceipts[0].output.meta.usage = structuredClone(usage)
  setRawEngine(data)
  assert.equal(proveVisionTask(data).state, 'pass')
  data.engineReceipts[0].output.meta.usage.reasoning_output_tokens = 1
  assert.equal(proveVisionTask(data).state, 'fail')
})

test('registered tool, correct tool text, attachment payload or model guess alone are not engine evidence', () => {
  for (const kind of ['path', 'attachment']) {
    const data = scenario(kind); data.engineReceipts = []
    assert.equal(proveVisionTask(data).state, 'fail')
    assert.equal(proveVisionTask(data).checks.find(c => c.id === 'real-vision-provider-used').state, 'fail')
  }
})

test('no OCR or copied prose substitutes for an independent geometric answer', () => {
  for (const mutate of [
    data => { const r = data.engineReceipts[0].output.result; r.ocr.full_text = r.summary; r.summary = '' },
    data => { data.engineReceipts[0].output.result.ocr.lines = [{ text: 'guessed' }] },
    data => { data.engineReceipts[0].output.result.uncertainty = ['not sure'] },
    data => { data.engineReceipts[0].output.result.summary = 'Read succeeded.' },
    data => { answerBlock(data).text = 'I could not see the image. ' + answerBlock(data).text },
    data => { answerBlock(data).text = '```json\n' + answerBlock(data).text + '\n```' },
  ]) { const data = scenario(); mutate(data); assert.equal(proveVisionTask(data).state, 'fail') }
})

test('wrong order, wrong visual class, invented property or wrong value type fails', () => {
  for (const change of [
    result => { result.rows.reverse() },
    result => { result.rows[0][0].shape = 'pentagon' },
    result => { result.rows[0][0].confidence = 1 },
    result => { result.rows[0][0].color = 1 },
  ]) {
    const data = scenario(), result = JSON.parse(answerBlock(data).text); change(result); answerBlock(data).text = JSON.stringify(result)
    assert.equal(proveVisionTask(data).state, 'fail')
  }
})

test('receipt must bind run/session/image/executable/model/single successful backend attempt', () => {
  for (const change of [
    r => { r.runId = 'another' }, r => { r.sessionId = 'another' }, r => { r.inputSha256 = 'c'.repeat(64) },
    r => { r.executable.sha256 = 'b'.repeat(64) }, r => { r.output.meta.model = 'wrong' },
    r => { r.output.provider = 'ocr' }, r => { r.output.meta.attempts[0].provider = 'other' },
    r => { r.output.meta.attempts.push({ provider: 'codex-cli', ok: false, durationSeconds: 1 }) },
    r => { r.output.meta.attempts[0].ok = false }, r => { r.output.meta.conversationId = null },
    r => { r.exitCode = 1 }, r => { r.errorCode = 'outer_input_changed' }, r => { delete r.errorCode },
    r => { r.errorCode = '' }, r => { r.errorCode = false }, r => { r.pid = 0 }, r => { r.ordinal = 2 },
    r => { r.output.image = '/another.png' },
  ]) { const data = scenario(); change(data.engineReceipts[0]); assert.equal(proveVisionTask(data).state, 'fail') }
  const duplicate = scenario(); duplicate.engineReceipts.push(duplicate.engineReceipts[0]); assert.equal(proveVisionTask(duplicate).state, 'fail')
})

test('receipt chronology cannot reuse an earlier engine answer or finish after model answer', () => {
  for (const change of [
    r => { r.startedAt = at(50) }, r => { r.finishedAt = at(701) }, r => { r.output.meta.generatedAt = at(399) },
    r => { r.output.meta.generatedAt = at(501) }, r => { r.startedAt = at(550) },
  ]) { const data = scenario(); change(data.engineReceipts[0]); assert.equal(proveVisionTask(data).state, 'fail') }
})

test('unknown engine usage stays null and never becomes a zero cost or token claim', () => {
  const data = scenario(); data.engineReceipts[0].output.meta.usage = null
  data.processReceipt.usage = null; setRawEngine(data)
  const proof = proveVisionTask(data)
  assert.equal(proof.state, 'pass')
  assert.deepEqual(proof.engineUsage, { status: 'unknown', inputTokens: null, outputTokens: null, cachedInputTokens: null })
})

test('outer Node envelope never substitutes for the actual independently recorded Codex process', () => {
  for (const mutate of [
    d => { delete d.processReceipt },
    d => { d.processReceipt.pid = d.engineReceipts[0].pid },
    d => { d.processReceipt.executable.sha256 = d.expectedEngine.nodeExecutableSha256 },
    d => { d.processReceipt.cleanup.confirmedBy = 'signal-sent' },
    d => { d.engineReceipts[0].cleanup.status = 'unconfirmed' },
    d => { d.processReceipt.rawStdoutSha256 = 'f'.repeat(64) },
    d => { d.rawEngineStdout += '{}\n' },
    d => { d.processReceipt.result.summary = 'guessed'; setRawEngine(d) },
    d => { d.processReceipt.startedAt = at(390) },
    d => { d.processReceipt.finishedAt = at(501) },
    d => { d.processReceipt.errorCode = 'VISION_CLEANUP_FAILED' },
    d => { d.processReceipt.inputSha256 = 'f'.repeat(64) },
    d => { d.engineReceipts[0].cli.sha256 = 'f'.repeat(64) },
    d => { delete d.processReceipt.outputSchema },
    d => { d.processReceipt.outputSchema.path = '/another/schema.json' },
    d => { d.processReceipt.outputSchema.sha256 = 'f'.repeat(64) },
    d => { delete d.expectedEngine.outputSchemaPath },
    d => { delete d.expectedEngine.outputSchemaSha256 },
  ]) { const data = scenario(); mutate(data); assert.equal(proveVisionTask(data).state, 'fail') }
})

test('native path tool is unique, successful, correctly correlated and exact-target; shell/other tools fail', () => {
  for (const mutate of [
    data => { find(data, 'tool/call').data.name = 'bash' },
    data => { find(data, 'tool/call').data.name = 'read' },
    data => { find(data, 'tool/call').data.arguments = JSON.stringify({ path: '/another.png' }) },
    data => { find(data, 'tool/result').data.message.content[0].isError = true },
    data => { find(data, 'tool/result').data.turn = 2 },
    data => { find(data, 'tool/result').data.step = 2 },
    data => { find(data, 'tool/result').data.message.source.callId = 'another' },
    data => { find(data, 'tool/result').data.message.content[0].content[0].text = 'not the engine answer' },
    data => { data.history.events.splice(-1, 0, structuredClone(data.history.events.find(r => r.event.type === 'tool/call'))); resequence(data) },
  ]) { const data = scenario(); mutate(data); assert.equal(proveVisionTask(data).state, 'fail') }
})

test('native paste proof rejects synthetic/API delivery, stale preview, foreign bytes or wrong submitted message', () => {
  for (const mutate of [
    data => { delete data.input.delivery },
    data => { data.input.delivery.source = 'rpc' },
    data => { data.input.delivery.trustedPaste = false },
    data => { data.input.delivery.previewCount = 0 },
    data => { data.input.delivery.userMessageId = 'other' },
    data => { data.input.delivery.imageSha256 = 'b'.repeat(64) },
    data => { data.input.delivery.submitStartedAt = at(250) },
    data => { data.input.delivery.submitCompletedAt = at(190) },
    data => { find(data, 'user/message').data.content[1].attachment.width = 1 },
    data => { find(data, 'user/message').data.content[1].attachment.attachmentId = 'other' },
    data => { find(data, 'user/message').data.content[1].attachment.bytes++ },
  ]) { const data = scenario('attachment'); mutate(data); assert.equal(proveVisionTask(data).state, 'fail') }
})

test('fresh complete user turn is mandatory; fixed prompt cannot contain leaked ground truth', () => {
  for (const mutate of [
    data => { find(data, 'turn/end').data.reason.kind = 'error' },
    data => { find(data, 'user/message').data.source.kind = 'plugin' },
    data => { find(data, 'user/message').data.content[0].text += '\n' + JSON.stringify(data.fixture.manifest.expected) },
    data => { data.history.events.splice(-1, 0, structuredClone(data.history.events.find(r => r.event.type === 'user/message'))); resequence(data) },
  ]) { const data = scenario(); mutate(data); assert.equal(proveVisionTask(data).state, 'fail') }
  for (const mutate of [data => { data.history.hasMore = true }, data => { data.history.events[1].event.seq = 99 }]) {
    const data = scenario(); mutate(data); assert.throws(() => proveVisionTask(data), /vision-proof/u)
  }
})
