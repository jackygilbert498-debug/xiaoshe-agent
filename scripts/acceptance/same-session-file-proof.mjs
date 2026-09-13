/** Offline proof only: never starts a session, calls an API, or writes files. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { buildHarnessToolRecords } from './harness-performance-event-proof.mjs'

export const SAME_SESSION_TASK_IDS = Object.freeze(['files-extract-structured', 'files-structured-write-readback'])
const SHA = /^[a-f\d]{64}$/u
const LIMIT = 65536
// Pin the actual product pre-execute and isolated guard denials. Generic tool
// errors may follow side effects; neither prefixes nor model prose prove denial.
const PLAN_PREFLIGHT_DENIAL = 'Error: 复杂任务尚未完成行动前准备：先用任务清单记录少量可更新步骤。取得一次真实结果后再实施，不要通过重复同一写入调用绕过。'
const ISOLATED_TOOL_DENIAL = 'Error: acceptance-file-policy: tool_not_allowed'
const RECOVERY_LIMITS = Object.freeze({ preflightWriteDenials: 1, isolatedToolDenials: 1 })
const digest = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = code => Object.assign(new Error(`same-session-file-proof: ${code}`), { code })
const check = (id, passed, evidence = {}) => ({ id, state: passed ? 'pass' : 'fail', evidence })
const passed = rows => rows.every(row => row.state === 'pass')

async function readSmallFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) throw fail('invalid_fixture_file')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return await file.readFile() } finally { await file.close() }
}

function linesOf(text) {
  const lines = text.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function deriveOutput(text) {
  const lines = linesOf(text)
  if (!lines.length || lines.length > 100 || lines.some(line => !line.trim())) throw fail('invalid_input_jsonl')
  const items = lines.map(line => {
    let row
    try { row = JSON.parse(line) } catch { throw fail('invalid_input_jsonl') }
    if (!object(row) || Object.keys(row).some(key => !['project', 'amount', 'quantity', 'owner'].includes(key))
      || typeof row.project !== 'string' || !row.project.trim() || !Number.isFinite(row.amount) || row.amount < 0
      || !Number.isSafeInteger(row.quantity) || row.quantity < 0
      || (row.owner !== undefined && (typeof row.owner !== 'string' || !row.owner.trim()))) throw fail('invalid_input_jsonl')
    return { project: row.project, amount: row.amount, quantity: row.quantity, owner: row.owner ?? null }
  })
  return { items }
}

async function inventory(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw fail('unexpected_workspace_entry')
    if (entry.isFile()) result.push(entry.name)
    else if (entry.isDirectory() && entry.name === 'output') {
      for (const child of await readdir(join(root, 'output'), { withFileTypes: true })) {
        if (!child.isFile() || child.isSymbolicLink()) throw fail('unexpected_workspace_entry')
        result.push(`output/${child.name}`)
      }
    } else throw fail('unexpected_workspace_entry')
  }
  return result.sort()
}

/** Call before the first prompt. Only input.jsonl and an optional empty output/ may exist. */
export async function captureSameSessionFileBaseline({ workspaceRoot }) {
  if (!isAbsolute(workspaceRoot ?? '')) throw fail('invalid_workspace')
  const canonicalRoot = await realpath(workspaceRoot)
  const initialInventory = await inventory(canonicalRoot)
  if (!isDeepStrictEqual(initialInventory, ['input.jsonl'])) throw fail('dirty_fixture_workspace')
  const input = await readSmallFile(join(canonicalRoot, 'input.jsonl'))
  const expectedOutput = deriveOutput(input.toString('utf8'))
  if (!expectedOutput.items.some(item => item.owner === null)) throw fail('missing_value_case_not_exercised')
  return { schema: 'xiaoshe-same-session-file-baseline/v1', workspaceRoot: canonicalRoot,
    inputSha256: digest(input), expectedOutput, initialInventory }
}

function resultText(call) {
  const event = call?.result
  const blocks = event?.type === 'tool/code-dispatch' ? event.data?.content
    : event?.data?.message?.content?.length === 1 && event.data.message.content[0]?.type === 'tool-result'
      ? event.data.message.content[0].content : undefined
  return Array.isArray(blocks) && blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string'
    ? blocks[0].text : undefined
}

function resultJson(call) {
  if (!call?.succeeded) return undefined
  try { const value = JSON.parse(resultText(call)); return object(value) ? value : undefined } catch { return undefined }
}

function exactNativeDenial(call, text) {
  if (call.eventType !== 'tool/call' || !call.settled || !call.failed || resultText(call) !== text) return false
  const data = call.result?.data, message = data?.message
  const blocks = message?.content
  // Require the real tool-result error flag, not an error-looking string or a
  // projected flag elsewhere. Conflicting explicit success flags fail closed.
  return blocks?.length === 1 && blocks[0].type === 'tool-result' && blocks[0].isError === true
    && [data.isError, data.result?.isError, data.output?.isError, message.isError].every(value => value === undefined || value === true)
}

function exactPath(value, root, target) {
  return typeof value === 'string' && value.trim() !== '' && resolve(root, value) === target
}

function readMatches(call, root, target, text) {
  if (!call?.succeeded || call.name !== 'read' || !exactPath(call.arguments.file_path, root, target)
    || ![undefined, 1].includes(call.arguments.offset)) return false
  const envelope = /^<path>([^\n]*)<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(resultText(call) ?? '')
  if (!envelope || !exactPath(envelope[1], root, target)) return false
  const lines = linesOf(text)
  const body = `${lines.map((line, index) => `${index + 1}: ${line}`).join('\n')}\n\n(End of file - total ${lines.length} lines)`
  return envelope[2] === body
}

function writeMatches(call, root, target, outputText, expectedOutput) {
  if (!call?.succeeded || call.name !== 'write' || !exactPath(call.arguments.file_path, root, target)
    || typeof call.arguments.content !== 'string' || call.arguments.content !== outputText) return false
  try { if (!isDeepStrictEqual(JSON.parse(call.arguments.content), expectedOutput)) return false } catch { return false }
  const envelope = /^<path>([^\n]*)<\/path>\n<type>file<\/type>\n<content>\nCreated file\n<\/content>$/u.exec(resultText(call) ?? '')
  return envelope !== null && exactPath(envelope[1], root, target)
}

function historyEvents(history) {
  if (history?.hasMore !== false || !Array.isArray(history.events) || history.events.length === 0 || history.events.length > 100000) throw fail('incomplete_history')
  const events = history.events.map(entry => entry?.event)
  if (events.some((event, index) => !object(event) || event.seq !== index || typeof event.type !== 'string' || !object(event.data))) throw fail('invalid_history_order')
  return events
}

function turnsFrom(events, userMessageIds) {
  if (!Array.isArray(userMessageIds) || userMessageIds.length !== 2 || new Set(userMessageIds).size !== 2
    || userMessageIds.some(id => typeof id !== 'string' || !id)) throw fail('invalid_user_message_binding')
  const starts = events.filter(event => event.type === 'turn/start')
  const ends = events.filter(event => event.type === 'turn/end')
  const users = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user')
  if (starts.length !== 2 || ends.length !== 2 || users.length !== 2) throw fail('not_exactly_two_user_turns')
  return starts.map((start, index) => {
    const end = ends[index], user = users[index]
    if (!Number.isSafeInteger(start.data.turn) || start.data.turn < 1 || end.data.turn !== start.data.turn
      || user.data.id !== userMessageIds[index] || !(start.seq < user.seq && user.seq < end.seq)
      || (index === 1 && (start.seq <= ends[0].seq || start.data.turn <= starts[0].data.turn))) throw fail('invalid_turn_binding')
    return { start, end, user, completed: end.data.reason?.kind === 'completed' }
  })
}

const callEvidence = call => call ? { callSeq: call.seq, resultSeq: call.resultSeq, callId: call.callId, name: call.name } : {}

/**
 * history must be the complete session.history reply fetched for sessionId by
 * the owning orchestrator; the RPC event payload has no independent session ID.
 * This returns file-task facts, not live-model/runtime/cleanup attestation. The
 * orchestrator must bind real provider activity, candidate identity and cleanup.
 */
export async function proveSameSessionFileRun({ sessionId, history, baseline, userMessageIds, toolPolicy = 'legacy-rediscovery' }) {
  // Preserve historical evidence semantics; current runs must explicitly prove
  // continuous availability, not reinterpret an old hidden-tool run as fixed.
  if (!['legacy-rediscovery', 'continuous-availability'].includes(toolPolicy)) throw fail('invalid_tool_policy')
  if (typeof sessionId !== 'string' || !sessionId || baseline?.schema !== 'xiaoshe-same-session-file-baseline/v1'
    || !SHA.test(baseline.inputSha256 ?? '') || !isAbsolute(baseline.workspaceRoot ?? '')) throw fail('invalid_proof_binding')
  const events = historyEvents(history)
  const turns = turnsFrom(events, userMessageIds)
  const root = await realpath(baseline.workspaceRoot)
  if (root !== baseline.workspaceRoot) throw fail('workspace_identity_changed')
  const inputPath = join(root, 'input.jsonl'), outputPath = join(root, 'output/result.json')
  let input, output, files, expectedOutput
  try { input = await readSmallFile(inputPath); expectedOutput = deriveOutput(input.toString('utf8')) } catch { /* Fails the independent checks below. */ }
  try { output = await readSmallFile(outputPath) } catch { /* Output absence is not success. */ }
  try { files = await inventory(root) } catch { /* Symlinks/directories fail the no-extra-files check. */ }
  const originalUnchanged = input !== undefined && digest(input) === baseline.inputSha256
    && isDeepStrictEqual(expectedOutput, baseline.expectedOutput)
  let outputValue
  try { outputValue = JSON.parse(output?.toString('utf8')) } catch { /* Invalid JSON cannot count as structured output. */ }
  const outputCorrect = output !== undefined && isDeepStrictEqual(outputValue, expectedOutput) && originalUnchanged
  const noExtraFiles = isDeepStrictEqual(files, ['input.jsonl', 'output/result.json'])
  const calls = buildHarnessToolRecords(events)
  const within = (call, turn) => call.seq > turn.user.seq && call.resultSeq < turn.end.seq
    && call.seq < call.resultSeq && (call.eventType !== 'tool/call'
      || (events[call.eventIndex].data.turn === turn.start.data.turn && call.result?.data?.turn === turn.start.data.turn
        && events[call.eventIndex].data.step === call.result?.data?.step))
  const firstCalls = calls.filter(call => within(call, turns[0]))
  const secondCalls = calls.filter(call => within(call, turns[1]))
  const headerBefore = seq => events.findLast(event => event.type === 'request/header' && event.seq < seq)
  const nativeToolNames = header => Array.isArray(header?.data?.header?.tools) ? header.data.header.tools.map(tool => tool.name) : []
  const hiddenInfo = firstCalls.find(call => {
    if (call.name !== 'xiaoshe_runtime_info') return false
    const info = resultJson(call), availability = info?.tool_availability
    const registered = availability?.registered_tools, visible = info?.tools
    const header = headerBefore(call.seq)
    return Array.isArray(registered) && registered.includes('read') && new Set(registered).size === registered.length
      && availability.registered_count === registered.length && Array.isArray(visible) && !visible.includes('read')
      && availability.visible_count === visible.length && info.execution?.tool_surface?.presentation === 'native'
      && header?.seq > turns[0].user.seq && !nativeToolNames(header).includes('read')
  })
  const availableInfo = firstCalls.find(call => {
    if (call.name !== 'xiaoshe_runtime_info' || !call.succeeded) return false
    const info = resultJson(call), availability = info?.tool_availability
    const registered = availability?.registered_tools, visible = info?.tools
    const header = headerBefore(call.seq)
    return Array.isArray(registered) && new Set(registered).size === registered.length
      && availability.registered_count === registered.length && Array.isArray(visible)
      && availability.visible_count === visible.length && info.execution?.tool_surface?.presentation === 'native'
      && header?.seq > turns[0].user.seq
      && ['read', 'write'].every(name => registered.includes(name) && visible.includes(name) && nativeToolNames(header).includes(name))
  })
  const continuousHeaders = turns.every(turn => {
    const headers = events.filter(event => event.type === 'request/header' && event.seq > turn.user.seq && event.seq < turn.end.seq)
    return headers.length > 0 && headers.every(header => ['read', 'write'].every(name => nativeToolNames(header).includes(name)))
  })
  const sourceRead = secondCalls.find(call => input && readMatches(call, root, inputPath, input.toString('utf8')))
  const writes = calls.filter(call => call.name === 'write')
  const successfulWrites = writes.filter(call => call.succeeded)
  const write = successfulWrites.length === 1 && within(successfulWrites[0], turns[1]) && output
    && writeMatches(successfulWrites[0], root, outputPath, output.toString('utf8'), expectedOutput) ? successfulWrites[0] : undefined
  const readback = write && secondCalls.find(call => call.seq > write.resultSeq
    && readMatches(call, root, outputPath, output.toString('utf8')))
  const planner = sourceRead && secondCalls.find(call => {
    const plan = resultJson(call)
    return call.name === 'xiaoshe_capability_plan' && call.resultSeq < sourceRead.seq
      && plan?.registration_only === true && Array.isArray(plan.candidates) && plan.candidates.some(candidate => candidate?.name === 'read')
  })
  const restoredHeader = sourceRead && headerBefore(sourceRead.seq)
  const readVisible = restoredHeader?.seq > turns[1].user.seq && nativeToolNames(restoredHeader).includes('read')
  const beforePlanner = planner && headerBefore(planner.seq)
  const visibleBeforePlanner = beforePlanner?.seq > turns[1].user.seq && nativeToolNames(beforePlanner).includes('read')
  const plannerRestored = planner && beforePlanner?.seq > turns[1].user.seq && !nativeToolNames(beforePlanner).includes('read')
    && restoredHeader?.seq > planner.resultSeq && readVisible
  // A normal new-goal pre-step may restore file tools before the model needs a
  // planner. A later planner confirmation is not evidence it caused recovery.
  const recoveryMode = readVisible && (!planner || visibleBeforePlanner) ? 'automatic_task_surface'
    : plannerRestored ? 'capability_plan' : null
  // Product-mandated todo_write updates only the owning session's plan. It is
  // permitted bookkeeping, never evidence of a workspace read or file write.
  const allowed = new Set(['read', 'write', 'todo_write', 'xiaoshe_runtime_info', 'xiaoshe_capability_plan', 'run_code'])
  const preflightRejectedWrites = writes.filter(call => write && call.resultSeq < write.seq && within(call, turns[1])
    && exactPath(call.arguments.file_path, root, outputPath) && typeof call.arguments.content === 'string'
    && exactNativeDenial(call, PLAN_PREFLIGHT_DENIAL))
  const isolatedDenied = calls.filter(call => !allowed.has(call.name) && turns.some(turn => within(call, turn))
    && exactNativeDenial(call, ISOLATED_TOOL_DENIAL))
  const safeDenials = new Set([...preflightRejectedWrites, ...isolatedDenied])
  const recoveryWithinLimits = preflightRejectedWrites.length <= RECOVERY_LIMITS.preflightWriteDenials
    && isolatedDenied.length <= RECOVERY_LIMITS.isolatedToolDenials
  const callScope = calls.every(call => ((allowed.has(call.name) && call.succeeded) || safeDenials.has(call)) && call.settled
    && turns.some(turn => within(call, turn))
    && (call.name !== 'read' || exactPath(call.arguments.file_path, root, inputPath) || exactPath(call.arguments.file_path, root, outputPath))
    && (call.eventType === 'tool/call' || calls.some(rootCall => rootCall.eventType === 'tool/call' && rootCall.name === 'run_code'
      && rootCall.callId === call.rootCallId && rootCall.succeeded && rootCall.seq < call.seq && rootCall.resultSeq > call.resultSeq
      && (call.parentCallId === rootCall.callId || calls.some(parent => parent.callId === call.parentCallId
        && parent.rootCallId === call.rootCallId && parent.succeeded && parent.seq < call.seq && parent.resultSeq > call.resultSeq)))))
  const firstReadFree = firstCalls.every(call => call.name !== 'read' && call.name !== 'write')
  const orderedWrite = Boolean(sourceRead && write && sourceRead.resultSeq < write.seq)
  const base = turns.every(turn => turn.completed) && callScope && recoveryWithinLimits && firstReadFree && noExtraFiles
  const extractChecks = [check('source-read', base && Boolean(sourceRead), callEvidence(sourceRead)),
    check('fields-match-source', base && outputCorrect && orderedWrite),
    check('missing-values-not-invented', base && outputCorrect && expectedOutput.items.some(item => item.owner === null))]
  const writeChecks = [check('source-read', base && Boolean(sourceRead), callEvidence(sourceRead)),
    check('allowed-output-written', base && orderedWrite && outputCorrect, callEvidence(write)),
    check('output-readback-matched', base && outputCorrect && Boolean(readback), callEvidence(readback)),
    check('original-input-unchanged', base && originalUnchanged)]
  const regressionChecks = toolPolicy === 'continuous-availability' ? [
    check('same-session-two-completed-user-turns', turns.every(turn => turn.completed)),
    check('file-tools-registered-and-visible-first-turn', Boolean(availableInfo), callEvidence(availableInfo)),
    check('file-tools-visible-in-every-request', continuousHeaders),
    check('available-read-really-succeeded', Boolean(sourceRead && readVisible), callEvidence(sourceRead)),
  ] : [check('same-session-two-completed-user-turns', turns.every(turn => turn.completed)),
    check('read-registered-but-hidden-first-turn', Boolean(hiddenInfo), callEvidence(hiddenInfo)),
    check('read-rediscovered-before-execution', Boolean(recoveryMode && sourceRead), { mode: recoveryMode,
      hasPlannerConfirmation: Boolean(planner), ...callEvidence(planner) }),
    check('rediscovered-read-really-succeeded', Boolean(sourceRead), callEvidence(sourceRead))]
  return { schema: 'xiaoshe-same-session-file-proof/v1', sessionId,
    tasks: [{ taskId: SAME_SESSION_TASK_IDS[0], state: passed(extractChecks) ? 'pass' : 'fail', checks: extractChecks },
      { taskId: SAME_SESSION_TASK_IDS[1], state: passed(writeChecks) ? 'pass' : 'fail', checks: writeChecks }],
    regression: { id: toolPolicy === 'continuous-availability' ? 'same-session-tool-availability' : 'same-session-tool-rediscovery',
      state: base && passed(regressionChecks) ? 'pass' : 'fail', checks: regressionChecks },
    independent: { originalUnchanged, outputCorrect, noExtraFiles, inputSha256: input ? digest(input) : null,
      outputSha256: output ? digest(output) : null },
    recovery: { retriedWriteCalls: Math.max(0, writes.length - 1), successfulWriteCalls: successfulWrites.length,
      preflightRejectedWriteCalls: preflightRejectedWrites.length, isolatedDeniedCalls: isolatedDenied.length,
      totalFailedCalls: calls.filter(call => call.failed).length,
      unclassifiedFailedCalls: calls.filter(call => call.failed && !safeDenials.has(call)).length,
      withinLimits: recoveryWithinLimits, limits: RECOVERY_LIMITS,
      preflightWriteEvidence: preflightRejectedWrites.map(callEvidence), isolatedDenialEvidence: isolatedDenied.map(callEvidence) },
    turnEvidence: turns.map(turn => ({ turn: turn.start.data.turn, userMessageId: turn.user.data.id,
      userMessageSeq: turn.user.seq, startSeq: turn.start.seq, endSeq: turn.end.seq, completed: turn.completed })),
    boundary: 'Offline event-and-file proof only; the orchestrator owns real-model, same-RPC-session, runtime, budget and cleanup binding.' }
}
