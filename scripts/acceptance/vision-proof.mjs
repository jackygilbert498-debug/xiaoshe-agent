/** Offline visual evidence verifier. Never dispatches an engine or writes files. */
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertVisionFixture, visionQuestion } from './vision-fixture.mjs'
import { buildHarnessToolRecords } from './harness-performance-event-proof.mjs'
import { parseCodexVisionEvents } from './vision-engine-runtime.mjs'

export const VISION_TASK_IDS = Object.freeze(['files-image-evidence', 'files-attachment-evidence'])
const sha = value => createHash('sha256').update(value).digest('hex')
const hash = value => typeof value === 'string' && /^[a-f\d]{64}$/u.test(value)
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/u.test(value)
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const fail = code => new Error(`vision-proof: ${code}`)
const passed = checks => checks.every(check => check.state === 'pass')
const check = (id, success, evidence = {}) => ({ id, state: success ? 'pass' : 'fail', evidence })
const parse = value => { try { return JSON.parse(value) } catch { return undefined } }
const textBlocks = blocks => Array.isArray(blocks) ? blocks.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
const toolText = call => textBlocks(call?.result?.data?.message?.content?.[0]?.content)

// Pinned to public ModLens 3.22.0 VISION_RESULT_SCHEMA/withoutEmptyOptionals.
// Only its seven declared optional fields may lose null. Unknown fields remain
// exact; required nulls and malformed values cannot become successful proof.
export function normalizeModLens322VisionResult(value) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  const strings = v => Array.isArray(v) && v.every(entry => typeof entry === 'string')
  if (!object(value)) return undefined
  const result = structuredClone(value)
  const { ocr, layout, semantics, visual } = result
  if (typeof result.summary !== 'string' || !object(ocr) || !object(layout) || !object(semantics) || !object(visual)
    || !strings(result.uncertainty) || typeof ocr.full_text !== 'string' || !Array.isArray(ocr.lines)
    || !Array.isArray(layout.regions) || typeof semantics.scene !== 'string' || !Array.isArray(semantics.entities)) return undefined
  const optional = (record, key, valid) => {
    if (record[key] === null) delete record[key]
    return !Object.hasOwn(record, key) || valid(record[key])
  }
  const string = v => typeof v === 'string'
  if (!ocr.lines.every(line => object(line) && string(line.text) && optional(line, 'language', string))
    || !layout.regions.every(region => object(region) && string(region.type) && Number.isFinite(region.reading_order) && string(region.text))
    || !semantics.entities.every(entity => object(entity) && string(entity.name) && string(entity.type) && optional(entity, 'evidence', string))
    || !optional(semantics, 'intent', string)
    || !optional(semantics, 'relations', relations => Array.isArray(relations) && relations.every(relation => object(relation)
      && string(relation.subject) && string(relation.predicate) && string(relation.object)))
    || !optional(visual, 'dominant_colors', strings) || !optional(visual, 'style', string) || !optional(visual, 'notes', strings)) return undefined
  return result
}

function observedUsage(value) {
  const valid = key => Number.isSafeInteger(value?.[key]) && value[key] >= 0
  return { status: valid('input_tokens') && valid('output_tokens') ? 'reported' : 'unknown',
    inputTokens: valid('input_tokens') ? value.input_tokens : null,
    outputTokens: valid('output_tokens') ? value.output_tokens : null,
    cachedInputTokens: valid('cached_input_tokens') ? value.cached_input_tokens : null }
}

/**
 * engineReceipts are independently captured around the REAL ModLens CLI child,
 * never synthesized from tool text. Each receipt has schema/runId/sessionId,
 * ordinal=1, pid, startedAt/finishedAt ISO, inputPath/inputSha256, exitCode,
 * executable:{path,sha256} for Node, cli:{path,sha256}, confirmed cleanup, and
 * raw CLI output:{image,provider,result,meta}. processReceipt separately records
 * the actual Codex executable/PID and its original rawEngineStdout JSONL.
 * expectedEngine pins provider/model plus executableSha256 (Codex),
 * nodeExecutableSha256, cliSha256 and the exact outputSchemaPath/Sha256 from
 * the isolated run contract.
 * Mount/ownership/budget and tamper protection belong to
 * the live runner; receipt-shaped data by itself cannot authenticate a process.
 *
 * Native attachment delivery additionally requires a trusted UI observation:
 * schema/runId/sessionId/source='native_clipboard', trustedPaste=true,
 * pasteAt/submitStartedAt/submitCompletedAt, previewCount=1, userMessageId,
 * attachmentId/imageSha256. The owning desktop runner must produce this from
 * the actual paste+submit surface, not from a session.prompt API call.
 */
export function proveVisionTask({ taskId, runId, sessionId, history, fixture, input, engineReceipts, expectedEngine, processReceipt, rawEngineStdout }) {
  const manifest = assertVisionFixture(fixture)
  if (!VISION_TASK_IDS.includes(taskId) || !id(runId) || !id(sessionId)
    || (taskId === VISION_TASK_IDS[0] ? input?.kind !== 'path' : input?.kind !== 'attachment')
    || !Buffer.isBuffer(input.bytes) || sha(input.bytes) !== manifest.imageSha256
    || (input.kind === 'path' && !isAbsolute(input.path ?? ''))
    || expectedEngine?.provider !== 'codex-cli' || !id(expectedEngine.model) || !hash(expectedEngine.executableSha256)
    || !hash(expectedEngine.nodeExecutableSha256) || !hash(expectedEngine.cliSha256)) throw fail('invalid_binding')
  if (history?.hasMore !== false || !Array.isArray(history.events) || history.events.length < 1 || history.events.length > 100000) throw fail('incomplete_history')
  const events = history.events.map(row => row.event)
  if (events.some((event, i) => event?.seq !== i || !event.data || typeof event.type !== 'string' || !Number.isFinite(event.time))) throw fail('invalid_history')
  const users = events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user')
  const starts = events.filter(e => e.type === 'turn/start'), ends = events.filter(e => e.type === 'turn/end')
  const user = users[0], start = starts[0], end = ends[0]
  const fresh = users.length === 1 && starts.length === 1 && ends.length === 1
    && Number.isSafeInteger(start?.data.turn) && start.data.turn > 0 && end.data.turn === start.data.turn
    && start.seq < user.seq && user.seq < end.seq && end.data.reason?.kind === 'completed'
    && textBlocks(user.data.content) === visionQuestion(input)
    && !events.some(e => e.type === 'assistant/message' && e.seq < user.seq)
  const answers = events.filter(e => e.type === 'assistant/message' && e.seq > user?.seq && e.seq < end?.seq)
  const answer = answers.at(-1), answerText = textBlocks(answer?.data.message?.content ?? answer?.data.content)
  const calls = buildHarnessToolRecords(events)
  const within = call => fresh && call.seq > user.seq && call.resultSeq < end.seq && call.seq < call.resultSeq
    && call.eventType === 'tool/call' && events[call.eventIndex].data.turn === start.data.turn
    && call.result?.data.turn === start.data.turn && events[call.eventIndex].data.step === call.result?.data.step
  const allowed = new Set(['xiaoshe_runtime_info', 'xiaoshe_capability_plan', ...(input.kind === 'path' ? ['modlens_read_image'] : [])])
  const scoped = calls.length === events.filter(event => event.type === 'tool/call').length
    && !events.some(event => event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch')
    && calls.every(call => allowed.has(call.name) && call.succeeded && within(call))
  const reads = calls.filter(call => call.name === 'modlens_read_image')
  const imageRead = input.kind === 'path' && reads.length === 1 && reads[0].arguments.path === input.path ? reads[0] : undefined
  const receipt = Array.isArray(engineReceipts) && engineReceipts.length === 1 ? engineReceipts[0] : undefined
  const output = receipt?.output, meta = output?.meta
  const envelope = receipt?.schema === 'xiaoshe-vision-envelope/v1' && receipt.runId === runId && receipt.sessionId === sessionId
    && receipt.ordinal === 1 && Number.isSafeInteger(receipt.pid) && receipt.pid > 0 && receipt.exitCode === 0 && receipt.errorCode === null
    && iso(receipt.startedAt) && iso(receipt.finishedAt) && Date.parse(receipt.startedAt) <= Date.parse(receipt.finishedAt)
    && receipt.inputSha256 === manifest.imageSha256 && isAbsolute(receipt.inputPath ?? '') && output?.image === receipt.inputPath
    && isAbsolute(receipt.executable?.path ?? '') && receipt.executable.sha256 === expectedEngine.nodeExecutableSha256
    && isAbsolute(receipt.cli?.path ?? '') && receipt.cli.sha256 === expectedEngine.cliSha256
    && receipt.cleanup?.status === 'confirmed' && receipt.cleanup.confirmedBy === 'ESRCH' && receipt.cleanup.groupId === receipt.pid
    && output.provider === expectedEngine.provider && meta?.model === expectedEngine.model && id(meta.conversationId)
    && iso(meta.generatedAt) && Date.parse(meta.generatedAt) >= Date.parse(receipt.startedAt) && Date.parse(meta.generatedAt) <= Date.parse(receipt.finishedAt)
    && Array.isArray(meta.attempts) && meta.attempts.length === 1 && meta.attempts[0].provider === output.provider
    && meta.attempts[0].ok === true && Number.isFinite(meta.attempts[0].durationSeconds) && meta.attempts[0].durationSeconds >= 0
  let rawEngine
  try { if (typeof rawEngineStdout === 'string' && Buffer.byteLength(rawEngineStdout) <= 2 * 1024 * 1024) rawEngine = parseCodexVisionEvents(rawEngineStdout) } catch { /* Raw failures never become engine proof. */ }
  const engine = processReceipt
  const engineBound = envelope && engine?.schema === 'xiaoshe-vision-engine-process/v1' && engine.runId === runId && engine.sessionId === sessionId
    && engine.ordinal === 1 && engine.provider === expectedEngine.provider && engine.model === expectedEngine.model
    && Number.isSafeInteger(engine.pid) && engine.pid > 0 && engine.pid !== receipt.pid && engine.exitCode === 0 && engine.errorCode === null
    && engine.cleanup?.status === 'confirmed' && engine.cleanup.confirmedBy === 'ESRCH' && engine.cleanup.groupId === engine.pid
    && isAbsolute(engine.executable?.path ?? '') && engine.executable.sha256 === expectedEngine.executableSha256
    && isAbsolute(expectedEngine.outputSchemaPath ?? '') && hash(expectedEngine.outputSchemaSha256)
    && engine.outputSchema?.path === expectedEngine.outputSchemaPath && engine.outputSchema.sha256 === expectedEngine.outputSchemaSha256
    && isAbsolute(engine.inputPath ?? '') && engine.inputSha256 === manifest.imageSha256
    && iso(engine.startedAt) && iso(engine.finishedAt) && Date.parse(receipt.startedAt) <= Date.parse(engine.startedAt)
    && Date.parse(engine.startedAt) <= Date.parse(engine.finishedAt) && Date.parse(engine.finishedAt) <= Date.parse(receipt.finishedAt)
    && rawEngine && sha(rawEngineStdout) === engine.rawStdoutSha256 && rawEngine.conversationId === engine.conversationId
    && engine.conversationId === meta.conversationId && isDeepStrictEqual(rawEngine.result, engine.result)
    && normalizeModLens322VisionResult(engine.result) !== undefined
    && isDeepStrictEqual(normalizeModLens322VisionResult(engine.result), output.result) && isDeepStrictEqual(rawEngine.usage, engine.usage)
    && isDeepStrictEqual(engine.usage, meta.usage ?? null)
  const causal = fresh && engineBound && answer && user.time <= Date.parse(receipt.startedAt)
    && Date.parse(receipt.finishedAt) <= answer.time
    && (input.kind === 'attachment' || (imageRead && receipt.inputPath === input.path
      && events[imageRead.eventIndex].time <= Date.parse(receipt.startedAt) && Date.parse(receipt.finishedAt) <= imageRead.result?.time))
  const visualValue = output?.result
  // The challenge contains no text. An OCR answer or a model-only guess is not
  // visual proof; require the independent engine's geometric answer as well.
  const engineAnswer = visualValue?.ocr?.full_text === '' && Array.isArray(visualValue?.ocr?.lines) && visualValue.ocr.lines.length === 0
    && Array.isArray(visualValue?.uncertainty) && visualValue.uncertainty.length === 0
    && isDeepStrictEqual(parse(visualValue?.summary), manifest.expected)
  const targetMatched = isDeepStrictEqual(parse(answerText), manifest.expected) && engineAnswer
  const rawImages = user?.data?.content?.filter(block => block.type === 'image') ?? []
  let attachmentDelivered = false
  if (input.kind === 'attachment') {
    const image = rawImages[0]?.attachment, d = input.delivery
    attachmentDelivered = rawImages.length === 1 && image?.attachmentId === `sha256:${manifest.imageSha256}` && input.attachmentId === image.attachmentId
      && image.mediaType === 'image/png' && image.bytes === fixture.png.length && image.width === manifest.width && image.height === manifest.height
      && d?.schema === 'xiaoshe-vision-native-attachment/v1' && d.runId === runId && d.sessionId === sessionId
      && d.source === 'native_clipboard' && d.trustedPaste === true && d.previewCount === 1
      && d.userMessageId === user?.data.id && d.attachmentId === image.attachmentId && d.imageSha256 === manifest.imageSha256
      && iso(d.pasteAt) && iso(d.submitStartedAt) && iso(d.submitCompletedAt)
      && Date.parse(d.pasteAt) <= Date.parse(d.submitStartedAt) && Date.parse(d.submitStartedAt) <= user.time
      && user.time <= Date.parse(d.submitCompletedAt)
  }
  const delivered = input.kind === 'attachment' ? attachmentDelivered
    : rawImages.length === 0 && imageRead && imageRead.succeeded && toolText(imageRead) === visualValue?.summary
  const checks = [check('fresh-session', fresh), ...(input.kind === 'attachment' ? [check('attachment-delivered', fresh && attachmentDelivered)] : []),
    check('real-vision-provider-used', Boolean(fresh && scoped && delivered && causal), { provider: output?.provider ?? null,
      model: meta?.model ?? null, engineCalls: Array.isArray(engineReceipts) ? engineReceipts.length : null }),
    check('target-content-matched', Boolean(fresh && scoped && delivered && causal && targetMatched))]
  return { schema: 'xiaoshe-vision-task-proof/v2', taskId, runId, sessionId, state: passed(checks) ? 'pass' : 'fail', checks,
    fixture: { imageSha256: manifest.imageSha256, pixelsSha256: manifest.pixelsSha256 },
    engineUsage: observedUsage(meta?.usage), monetaryHardCap: false,
    boundary: 'Offline content/correlation proof. The live runner must attest real owned CLI dispatch, input bytes, native paste, source/runtime binding, independent engine budget and cleanup. This is not native DeepSeek vision or an OCR test.' }
}
