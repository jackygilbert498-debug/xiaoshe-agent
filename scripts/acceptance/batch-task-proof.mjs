/** Artifact proof for one fixed batch across two owned processes. Never invokes a model. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual as equal } from 'node:util'
import { BATCH_ITEMS } from './batch-fixture.mjs'
import { browserVerificationAssertions, buildHarnessToolRecords, latestVisibleAssistantAnswer } from './harness-performance-event-proof.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const parse = text => { try { return JSON.parse(text) } catch { return undefined } }
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const ms = value => Date.parse(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const check = (id, condition, evidence = {}) => ({ id, state: condition ? 'pass' : 'fail', evidence })
const state = checks => checks.every(row => row.state === 'pass') ? 'pass' : 'fail'
const failure = code => Error(`batch-task-proof: ${code}`)
const pathIs = (value, root, target) => typeof value === 'string' && value.trim() !== '' && resolve(root, value) === target
const linesOf = value => { const lines = value.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line); if (lines.at(-1) === '') lines.pop(); return lines }
const PLAN_DENIAL = 'Error: 复杂任务尚未完成行动前准备：先用任务清单记录少量可更新步骤。取得一次真实结果后再实施，不要通过重复同一写入调用绕过。'
const BROWSER_ASSERTION_DENIAL = 'Error: 验证断言与该动作的原始观察不一致；本次尚未独立回读页面，当前基线和原有效期未刷新。这不表示页面动作失败；请依据任务和已有观察修正断言，用同一 after_snapshot_id 重试，不要重做动作。不会自动反转义或改写预期。'
const realError = call => call.failed && call.result?.data?.message?.content?.length === 1
  && call.result.data.message.content[0].type === 'tool-result' && call.result.data.message.content[0].isError === true
const errorReceiptKeys = ['ownerId', 'command', 'args', 'startedAt', 'finishedAt', 'status', 'code', 'message'].sort()
const assertionErrorReceipt = row => object(row) && equal(Object.keys(row).sort(), errorReceiptKeys)
  && row.status === 'error' && row.code === 'BROWSER_VERIFICATION_ARGUMENT' && `Error: ${row.message}` === BROWSER_ASSERTION_DENIAL
function admissionAssertions(action, baseline, args) {
  if (!object(args) || Object.keys(args).some(key => !['tab_id', 'after_snapshot_id', 'expect_url', 'expect_text',
    'expect_element_id', 'expect_value', 'expect_scroll_y', 'use_action_input'].includes(key))) return undefined
  const assertions = Object.fromEntries(Object.entries(args).filter(([key]) => key.startsWith('expect_')))
  if (Object.hasOwn(args, 'use_action_input')) {
    if (args.use_action_input !== true || Object.hasOwn(args, 'expect_element_id') || Object.hasOwn(args, 'expect_value')
      || action.name !== 'browser_type') return undefined
    assertions.expect_element_id = action.arguments.element_id; assertions.expect_value = action.arguments.text
  }
  const boundedText = (key, max, empty = false) => !Object.hasOwn(assertions, key)
    || typeof assertions[key] === 'string' && assertions[key].length <= max && (empty || assertions[key].length > 0)
  if (!Object.keys(assertions).length || !boundedText('expect_url', 2048) || !boundedText('expect_text', 1000)
    || !boundedText('expect_element_id', 64) || !boundedText('expect_value', 2000, true)
    || Object.hasOwn(assertions, 'expect_value') && !Object.hasOwn(assertions, 'expect_element_id')
    || Object.hasOwn(assertions, 'expect_scroll_y') && !Number.isSafeInteger(assertions.expect_scroll_y)) return undefined
  if (action.name === 'browser_open' && assertions.expect_url === undefined
    || action.name === 'browser_type' && (assertions.expect_element_id !== action.arguments.element_id || assertions.expect_value !== action.arguments.text)
    || action.name === 'browser_scroll' && assertions.expect_scroll_y !== baseline.viewport?.scroll_y) return undefined
  return assertions
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const blank = value => value.replace(/[^\n]/gu, ' ')

/** A direct current diagnosis, not a generic incomplete-content keyword.
 * This is only an alternative to the legacy reason predicate. Source-read,
 * no-output/submission, partial-count and false-completion gates stay intact.
 */
function currentBrokenLineParseFailure(answer, source, invalidLine) {
  if (typeof answer !== 'string' || typeof source !== 'string' || !source || source.length > 256
    || !Number.isSafeInteger(invalidLine) || invalidLine < 1 || invalidLine > 1000000) return false
  // Keep line structure while discarding data quotations and code, including
  // unclosed quotations. Never promote their text to a current diagnosis.
  const direct = answer.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, blank)
    .replace(/"[^"]*(?:"|$)|'[^']*(?:'|$)|`[^`]*(?:`|$)|“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)/gu, blank)
  const lineNumber = invalidLine === 2 ? '(?:2|二)' : String(invalidLine)
  const diagnosis = new RegExp('^(?:(?:因|因为|由于)\\s*)?' + escape(source)
    + '\\s*(?:的\\s*)?第\\s*' + lineNumber + '\\s*行\\s*(?:(?:的\\s*)?JSON\\s*)?(?:无法|不可)解析[.．]?$', 'u')
  let nonCurrentBlock = false
  for (const raw of direct.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) { nonCurrentBlock = false; continue }
    if (/^>/u.test(trimmed)) { nonCurrentBlock = true; continue }
    const heading = /^#{1,6}\s+/u.test(trimmed)
    const line = trimmed.replace(/^#{1,6}\s+/u, '').replace(/^(?:[-+*]|\d+[.)])\s+/u, '')
      .replace(/^(\*\*|__)([^\n]+)\1$/u, '$2')
    // Explicit block labels apply only to their nonblank block. Merely
    // mentioning an example elsewhere cannot veto a genuine later diagnosis.
    const label = /^(?:以下(?:仅)?(?:为|是)\s*)?(?:(?:状态|输出|回答|诊断|解析|原因)\s*)?(?:示例|样例|模板|示范|引用|引文|条件|假设)(?:[：:]|$)/u.test(line)
    if (label) { nonCurrentBlock = true; continue }
    if (heading) nonCurrentBlock = false
    if (nonCurrentBlock || /^(?:例如|比如|如果|假如|假设|若|倘若|当\s|不是|并非|不代表|这不代表)/u.test(line)) continue
    for (const clause of line.split(/[，,。；;！!？?]/u)) {
      const text = clause.trim()
      if (text.length <= 320 && diagnosis.test(text)) return true
    }
  }
  return false
}

function resultText(call) {
  const blocks = call?.result?.data?.message?.content
  return blocks?.length === 1 && blocks[0].type === 'tool-result' && blocks[0].content?.length === 1
    && blocks[0].content[0].type === 'text' && typeof blocks[0].content[0].text === 'string' ? blocks[0].content[0].text : undefined
}
const valueOf = call => parse(resultText(call))
const ref = call => call ? { callId: call.callId, tool: call.name, callSeq: call.seq, resultSeq: call.resultSeq } : {}
async function smallFile(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw failure('unsafe_file')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return await file.readFile() } finally { await file.close() }
}
async function inventory(root) {
  const files = []
  for (const row of await readdir(root, { withFileTypes: true })) {
    if (row.isSymbolicLink()) throw failure('unexpected_file')
    if (row.isFile()) files.push(row.name)
    else if (row.isDirectory() && row.name === 'output') {
      for (const child of await readdir(join(root, 'output'), { withFileTypes: true })) {
        if (!child.isFile() || child.isSymbolicLink()) throw failure('unexpected_file')
        files.push(`output/${child.name}`)
      }
    } else throw failure('unexpected_file')
  }
  return files.sort()
}
function sourceRow(row) {
  if (!object(row) || Object.keys(row).some(key => !['project', 'amount', 'quantity', 'owner'].includes(key))
    || typeof row.project !== 'string' || !row.project || !Number.isFinite(row.amount) || row.amount < 0
    || !Number.isSafeInteger(row.quantity) || row.quantity < 0 || row.owner !== undefined && typeof row.owner !== 'string') throw failure('invalid_ground_truth')
  return { project: row.project, amount: row.amount, quantity: row.quantity, owner: row.owner ?? null }
}
function sourcesFrom(sourceBytes) {
  if (!object(sourceBytes) || !equal(Object.keys(sourceBytes).sort(), BATCH_ITEMS.map(item => item.itemId))) throw failure('invalid_sources')
  return BATCH_ITEMS.map((item, index) => {
    const bytes = sourceBytes[item.itemId]
    if (!Buffer.isBuffer(bytes) || bytes.length > 65536) throw failure('invalid_sources')
    const lines = linesOf(bytes.toString('utf8'))
    if (lines.length !== 2) throw failure('fixed_two_line_sources_required')
    const first = sourceRow(parse(lines[0]))
    if (index === 2) {
      if (parse(lines[1]) !== undefined) throw failure('third_source_line_2_must_be_invalid_json')
      return { ...item, bytes, expected: null, invalidLine: 2 }
    }
    const second = sourceRow(parse(lines[1]))
    if (second.owner !== null) throw failure('missing_owner_case_required')
    return { ...item, bytes, expected: { items: [first, second] }, invalidLine: null }
  })
}
function readMatches(call, path, bytes, root) {
  if (!call?.succeeded || call.name !== 'read' || !pathIs(call.arguments.file_path, root, path) || ![undefined, 1].includes(call.arguments.offset)) return false
  const match = /^<path>([^\n]+)<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(resultText(call) ?? '')
  const lines = linesOf(bytes.toString('utf8'))
  return match !== null && pathIs(match[1], root, path)
    && match[2] === `${lines.map((line, index) => `${index + 1}: ${line}`).join('\n')}\n\n(End of file - total ${lines.length} lines)`
}
function writeMatches(call, path, bytes, expected, root) {
  const match = /^<path>([^\n]+)<\/path>\n<type>file<\/type>\n<content>\nCreated file\n<\/content>$/u.exec(resultText(call) ?? '')
  return call?.succeeded && call.name === 'write' && bytes && pathIs(call.arguments.file_path, root, path)
    && call.arguments.content === bytes.toString('utf8') && equal(parse(call.arguments.content), expected) && match !== null && pathIs(match[1], root, path)
}
function pageRecord(snapshot, url, expected) {
  if (!snapshot || snapshot.source !== 'isolated-browser-dom' || snapshot.physical_input_used !== false || snapshot.truncated !== false
    || ![url, url + 'record'].includes(snapshot.url) || typeof snapshot.text !== 'string' || snapshot.url === url && !snapshot.text.includes('已保存（服务器记录）')) return false
  for (let i = 0; i < snapshot.text.length; i++) if (snapshot.text[i] === '{') {
    const parsed = parse(snapshot.text.slice(i).trim())
    if (equal(snapshot.url === url ? parsed : parsed?.record, expected)) return true
  }
  return false
}
function assertionsMatch(snapshot, assertions) {
  const keys = Object.keys(assertions)
  if (!snapshot || !keys.length || keys.some(key => !['expect_url', 'expect_text', 'expect_element_id', 'expect_value', 'expect_scroll_y'].includes(key))) return false
  const element = snapshot.elements?.find(row => row.element_id === assertions.expect_element_id)
  return (assertions.expect_url === undefined || snapshot.url === assertions.expect_url)
    && (assertions.expect_text === undefined || typeof assertions.expect_text === 'string' && assertions.expect_text.length > 0 && snapshot.text?.includes(assertions.expect_text))
    && (assertions.expect_element_id === undefined || !!element)
    && (assertions.expect_value === undefined || element?.value === assertions.expect_value)
    && (assertions.expect_scroll_y === undefined || snapshot.viewport?.scroll_y === assertions.expect_scroll_y)
}

/**
 * history is the final complete same-session history, with contiguous event seq.
 * nativeReports is exactly { seed, resume }; each finalPages is an itemId array.
 * Outer runner supplies observed process exit/port release and candidate binding.
 * This proof never turns a fixture-shaped ledger into a live-model attestation.
 */
export function proveBatchTask(args) { return proveBatchEvidence(args, false) }

/** Genuine seed artifacts only: never synthesize a second phase to reuse proof. */
export function proveBatchSeed({ nativeReport, ...args }) {
  return proveBatchEvidence({ ...args, nativeReports: { seed: nativeReport } }, true)
}

async function proveBatchEvidence({ runId, sessionId, candidateId, workspaceRoot, sourceBytes, history, nativeReports, restartEvidence: restart, serverEvidence: server, acceptanceMode = 'existing' }, seedOnly) {
  if (!['existing', 'bounded-admission-recovery'].includes(acceptanceMode)) throw failure('invalid_acceptance_mode')
  const boundedRecovery = acceptanceMode === 'bounded-admission-recovery'
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(runId ?? '') || sessionId !== `xiaoshe-batch-${runId}` || typeof candidateId !== 'string' || !candidateId || candidateId.length > 256
    || !isAbsolute(workspaceRoot ?? '')) throw failure('invalid_binding')
  const root = await realpath(workspaceRoot)
  if (root !== workspaceRoot) throw failure('workspace_identity_changed')
  const items = sourcesFrom(sourceBytes)
  if (history?.hasMore !== false || !Array.isArray(history.events) || !history.events.length || history.events.length > 100000) throw failure('incomplete_history')
  const events = history.events.map(row => row.event)
  if (events.some((event, index) => !object(event) || event.seq !== index || !object(event.data) || typeof event.type !== 'string'
    || !Number.isFinite(event.time) || index > 0 && event.time < events[index - 1].time)) throw failure('invalid_history')
  const starts = events.filter(event => event.type === 'turn/start'), ends = events.filter(event => event.type === 'turn/end')
  const users = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user')
  const names = seedOnly ? ['seed'] : ['seed', 'resume']
  const phases = names.map((phase, i) => ({ phase, start: starts[i], end: ends[i], user: users[i], native: nativeReports?.[phase] }))
  const completed = starts.length === names.length && ends.length === names.length && users.length === names.length
    && (seedOnly || starts[0].data.turn !== starts[1].data.turn && ends[0].seq < starts[1].seq)
    && phases.every(({ start, end, user }) => positive(start?.data.turn) && end?.data.turn === start.data.turn
      && end.data.reason?.kind === 'completed' && start.seq < user?.seq && user.seq < end.seq)
  const calls = buildHarnessToolRecords(events)
  const phaseOf = call => phases.find(phase => call.seq > phase.user?.seq && call.resultSeq < phase.end?.seq
    && events[call.eventIndex]?.data.turn === phase.start?.data.turn && call.result?.data.turn === phase.start?.data.turn)
  const structured = completed && calls.length === events.filter(event => event.type === 'tool/call').length
    && calls.length === events.filter(event => event.type === 'tool/result').length && new Set(calls.map(call => call.callId)).size === calls.length
    && !events.some(event => ['tool/code-dispatch-start', 'tool/code-dispatch'].includes(event.type))
    && calls.every(call => phaseOf(call) && call.seq < call.resultSeq && positive(events[call.eventIndex].data.step)
      && events[call.eventIndex].data.step === call.result.data.step && events[call.eventIndex].time <= call.result.time)
  const nativeBound = object(nativeReports) && equal(Object.keys(nativeReports).sort(), names.toSorted()) && completed && phases.every(({ phase, native, start, end }) =>
    native?.schema === 'xiaoshe-batch-native/v1' && native.runId === runId && native.sessionId === sessionId && native.phase === phase && native.candidateId === candidateId
    && native.accepted === true && native.failure === undefined && native.injectionFailure === undefined && native.retentionFailure === undefined
    && positive(native.pid) && positive(native.backendPid) && native.pid !== native.backendPid && positive(native.backendPort) && native.backendPort < 65536 && native.backendPort !== 3080
    && isAbsolute(native.profileRoot ?? '') && iso(native.startedAt) && iso(native.finishedAt) && ms(native.startedAt) <= start.time && end.time <= ms(native.finishedAt)
    && Array.isArray(native.nativeActions) && Array.isArray(native.finalPages))
  const seed = phases[0], resume = phases[1], checkpoint = restart?.checkpoint, stopped = restart?.stopped
  const restartBound = !seedOnly && nativeBound && restart?.runId === runId && restart.sessionId === sessionId && restart.candidateId === candidateId
    && restart.profileRoot === seed.native.profileRoot && seed.native.profileRoot === resume.native.profileRoot
    && equal(restart.seed, { pid: seed.native.pid, backendPid: seed.native.backendPid }) && equal(restart.resume, { pid: resume.native.pid, backendPid: resume.native.backendPid })
    && new Set([seed.native.pid, seed.native.backendPid, resume.native.pid, resume.native.backendPid]).size === 4
    && seed.native.backendPort === resume.native.backendPort && stopped?.backendPort === seed.native.backendPort
    && stopped.desktopExited === true && stopped.backendExited === true && stopped.portReleased === true && iso(stopped.at)
    && ms(seed.native.finishedAt) <= ms(stopped.at) && ms(stopped.at) < ms(resume.native.startedAt)
    && Number.isSafeInteger(checkpoint?.lastSeq) && seed.end.seq <= checkpoint.lastSeq && checkpoint.lastSeq < resume.start.seq
    && checkpoint.historySha256 === hash(JSON.stringify(events.slice(0, checkpoint.lastSeq + 1))) && iso(checkpoint.savedAt)
    && seed.end.time <= ms(checkpoint.savedAt) && ms(checkpoint.savedAt) <= ms(stopped.at)
  let origin, basePath
  try { const url = new URL(server?.origin); if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.port !== '3080' && url.origin === server.origin) { origin = url.origin; basePath = `/${runId}/` } } catch { /* Fail closed below. */ }
  const itemUrl = item => `${origin}${basePath}${item.itemId}/`
  const serverBound = server?.schema === 'xiaoshe-batch-server/v1' && server.runId === runId && !!origin && server.basePath === basePath && server.errorCode === null && server.closed === !seedOnly
    && object(server.records) && equal(Object.keys(server.records).sort(), BATCH_ITEMS.map(item => item.itemId)) && Array.isArray(server.requests) && Array.isArray(server.submissions)
    && server.submissions.length === (seedOnly ? 1 : 2)
    && server.requests.every((row, index) => row.ordinal === index + 1 && BATCH_ITEMS.some(item => item.itemId === row.itemId) && iso(row.at) && row.status === 200
      && (row.method === 'GET' && [basePath + row.itemId + '/', basePath + row.itemId + '/record'].includes(row.path) && iso(row.finishedAt) && ms(row.at) <= ms(row.finishedAt)
        || row.method === 'POST' && row.path === basePath + row.itemId + '/save'))
  const browser = calls.filter(call => call.name.startsWith('browser_')), matched = new Map(), used = new Set()
  let browserBound = nativeBound
  for (const phase of phases) {
    const rows = phase.native?.nativeActions ?? []
    if (!rows.every(row => object(row) && row.ownerId === sessionId && object(row.args) && iso(row.startedAt) && iso(row.finishedAt)
      && ms(phase.native.startedAt) <= ms(row.startedAt) && ms(row.startedAt) <= ms(row.finishedAt) && ms(row.finishedAt) <= ms(phase.native.finishedAt)
      && (row.status === 'success' || boundedRecovery && assertionErrorReceipt(row)) && row.injectionFailure === undefined)) browserBound = false
    for (const call of browser.filter(call => phaseOf(call) === phase)) {
      const matches = rows.filter(row => row.command === call.name.slice(8) && equal(row.args, call.arguments)
        && events[call.eventIndex].time <= ms(row.startedAt) && ms(row.finishedAt) <= call.result?.time)
      if (matches.length !== 1 || used.has(matches[0])) { browserBound = false; continue }
      const row = matches[0]
      if (call.succeeded ? row.status !== 'success' || !equal(valueOf(call), row.value)
        : !boundedRecovery || !realError(call) || !assertionErrorReceipt(row) || resultText(call) !== BROWSER_ASSERTION_DENIAL) { browserBound = false; continue }
      matched.set(call, row); used.add(row)
    }
    if (rows.some(row => !used.has(row) && row.command !== 'status' && ms(row.startedAt) >= phase.user?.time && ms(row.startedAt) <= phase.end?.time)) browserBound = false
  }
  const snapshots = browser.filter(call => call.succeeded).flatMap(call => { const value = valueOf(call), snapshot = value?.current ?? value; return snapshot?.snapshot_id ? [{ call, snapshot }] : [] })
  const latest = call => snapshots.findLast(row => phaseOf(row.call) === phaseOf(call) && row.call.resultSeq < call.seq && row.snapshot.tab_id === call.arguments.tab_id && row.snapshot.owner_id === sessionId)
  const targetOf = call => { const row = latest(call); return row?.snapshot.snapshot_id === call.arguments.snapshot_id ? row.snapshot.elements?.find(element => element.element_id === call.arguments.element_id) : undefined }
  const mutations = browser.filter(call => call.succeeded && ['browser_open', 'browser_type', 'browser_click', 'browser_scroll'].includes(call.name))
  const verifiers = new Map()
  for (const [index, action] of mutations.entries()) {
    const baseline = valueOf(action), next = mutations.slice(index + 1).find(call => phaseOf(call) === phaseOf(action))
    const verifier = browser.find(call => {
      if (call.name !== 'browser_verify' || !call.succeeded || phaseOf(call) !== phaseOf(action) || call.seq <= action.resultSeq || next && call.resultSeq >= next.seq) return false
      const value = valueOf(call), assertions = browserVerificationAssertions(action, baseline, call.arguments, value, sessionId)
      if (!assertions || !baseline?.snapshot_id || baseline.owner_id !== sessionId || call.arguments.tab_id !== baseline.tab_id || call.arguments.after_snapshot_id !== baseline.snapshot_id
        || latest(call)?.snapshot.snapshot_id !== baseline.snapshot_id || call.arguments.use_action_input === true && latest(call)?.call !== action
        || value?.status !== 'verified' || value.baseline_snapshot_id !== baseline.snapshot_id
        || value.owner_id !== sessionId || value.tab_id !== baseline.tab_id || value.current?.owner_id !== sessionId || value.current?.tab_id !== baseline.tab_id
        || !value.current.snapshot_id || value.current.snapshot_id === baseline.snapshot_id || !equal(value.assertions, assertions)
        || !assertionsMatch(baseline, assertions) || !assertionsMatch(value.current, assertions)) return false
      if (action.name === 'browser_open') return assertions.expect_url === baseline.url
      if (action.name === 'browser_type') return assertions.expect_element_id === action.arguments.element_id && assertions.expect_value === action.arguments.text
      if (action.name === 'browser_scroll') return Number.isSafeInteger(assertions.expect_scroll_y) && assertions.expect_scroll_y === baseline.viewport?.scroll_y
      return true
    })
    if (verifier) verifiers.set(action, verifier)
  }
  if (browser.some(call => call.succeeded && call.name === 'browser_verify'
    && (Object.hasOwn(call.arguments, 'use_action_input') || Object.hasOwn(valueOf(call) ?? {}, 'assertion_source'))
    && ![...verifiers.values()].includes(call))) browserBound = false
  // Recovery never substitutes for an action's independent verification. Bind
  // the failed host admission to its own original action and corrected read.
  const browserAssertionRejections = boundedRecovery ? browser.filter(call => {
    if (call.name !== 'browser_verify' || !realError(call) || resultText(call) !== BROWSER_ASSERTION_DENIAL) return false
    const receipt = matched.get(call), prior = latest(call), action = prior?.call, phase = phaseOf(call)
    if (!assertionErrorReceipt(receipt) || !mutations.includes(action) || phaseOf(action) !== phase
      || call.arguments.after_snapshot_id !== prior.snapshot.snapshot_id
      || prior.snapshot.owner_id !== sessionId || prior.snapshot.tab_id !== call.arguments.tab_id) return false
    const verifier = verifiers.get(action), actionReceipt = matched.get(action), verifierReceipt = matched.get(verifier), value = valueOf(verifier)
    if (!verifier || verifier.seq <= call.resultSeq || phaseOf(verifier) !== phase || verifier.arguments.after_snapshot_id !== prior.snapshot.snapshot_id
      || actionReceipt?.status !== 'success' || verifierReceipt?.status !== 'success'
      || latest(verifier)?.call !== action || value?.snapshot_id !== value?.current?.snapshot_id) return false
    if ([prior.snapshot, value.current].some(snapshot => snapshot.source !== 'isolated-browser-dom'
      || snapshot.physical_input_used !== false || snapshot.truncated !== false)) return false
    // A intervening DOM observation/action invalidates the original baseline.
    // Pure background status is neither model action nor verification evidence.
    if (browser.some(other => other !== call && other !== verifier && phaseOf(other) === phase
      && other.seq > action.resultSeq && other.seq < verifier.seq && other.succeeded && other.name !== 'browser_status')) return false
    const elapsed = ms(receipt.startedAt) - ms(actionReceipt.finishedAt), verifiedElapsed = ms(verifierReceipt.startedAt) - ms(actionReceipt.finishedAt)
    const assertions = admissionAssertions(action, prior.snapshot, call.arguments)
    return assertions !== undefined && !assertionsMatch(prior.snapshot, assertions)
      && elapsed >= 0 && elapsed <= 45_000 && verifiedElapsed >= elapsed && verifiedElapsed <= 45_000
  }) : []
  if (boundedRecovery && browser.some(call => call.failed && !browserAssertionRejections.includes(call))) browserBound = false
  // An error before the prompt or after turn/end is not a preparation/status
  // exemption. Every newly eligible error row must bind one classified call.
  const unboundRecoveryErrors = boundedRecovery ? phases.flatMap(phase => phase.native?.nativeActions ?? [])
    .filter(row => row.status === 'error' && !browserAssertionRejections.some(call => matched.get(call) === row)) : []
  if (unboundRecoveryErrors.length) browserBound = false
  // Preserve the existing whole-journey PLAN definition unchanged. The new
  // opt-in seed path additionally needs an actual later successful same-target
  // write; the complete two-phase history shares one recovery budget.
  const planFailures = calls.filter(call => call.name === 'write' && call.failed && call.result?.data?.message?.content?.[0]?.isError === true
    && resultText(call) === PLAN_DENIAL && items.slice(0, 2).some(item => pathIs(call.arguments.file_path, root, join(root, item.target))))
  const recoveredPlans = planFailures.filter(call => calls.some(write => write.name === 'write' && write.succeeded
    && phaseOf(write) === phaseOf(call) && write.seq > call.resultSeq && typeof write.arguments.file_path === 'string'
    && resolve(root, write.arguments.file_path) === resolve(root, call.arguments.file_path)))
  const safeRecoveries = new Set([...recoveredPlans, ...browserAssertionRejections])
  const recoveryBound = safeRecoveries.size <= 1
  const failedCalls = calls.filter(call => call.failed)
  const quality = { acceptanceMode, strictZeroToolErrors: failedCalls.length === 0, failedToolCalls: failedCalls.length,
    recoveredToolCalls: safeRecoveries.size, unclassifiedFailedToolCalls: failedCalls.filter(call => !safeRecoveries.has(call)).length,
    recoveryBudgetLimit: 1, recoveryBudgetUsed: safeRecoveries.size,
    browserAssertionRejectedCalls: browserAssertionRejections.length, planRejectedCalls: recoveredPlans.length }
  const independent = { nativeIdentityBound: nativeBound, browserCallsBound: browserBound,
    ...(boundedRecovery ? { unboundRecoveryErrorRows: unboundRecoveryErrors.length } : {}) }
  let files
  try { files = await inventory(root) } catch { /* Separate inventory check fails. */ }
  const itemProofs = []
  for (const [index, item] of (seedOnly ? items.slice(0, 1) : items).entries()) {
    const phase = index === 0 ? seed : resume, sourcePath = join(root, item.source), outputPath = join(root, item.target), url = itemUrl(item)
    let actual, output
    try { actual = await smallFile(sourcePath) } catch { /* Evidence remains absent. */ }
    try { output = await smallFile(outputPath) } catch { /* Invalid item must not have an output. */ }
    const sourceRead = calls.find(call => phaseOf(call) === phase && readMatches(call, sourcePath, item.bytes, root))
    const writes = calls.filter(call => call.name === 'write' && pathIs(call.arguments.file_path, root, outputPath))
    const successes = writes.filter(call => call.succeeded)
    const write = successes.length === 1 && phaseOf(successes[0]) === phase && writeMatches(successes[0], outputPath, output, item.expected, root) ? successes[0] : undefined
    const back = write && calls.find(call => phaseOf(call) === phase && call.seq > write.resultSeq && readMatches(call, outputPath, output, root))
    const types = browser.filter(call => call.name === 'browser_type' && latest(call)?.snapshot.url === url)
    const type = types.length === 1 && phaseOf(types[0]) === phase && equal(parse(types[0].arguments.text), item.expected)
      && targetOf(types[0])?.tag === 'textarea' && targetOf(types[0])?.name === '结构化结果 JSON' ? types[0] : undefined
    const saves = browser.filter(call => call.name === 'browser_click' && latest(call)?.snapshot.url === url && targetOf(call)?.name === '保存结果')
    const save = saves.length === 1 && phaseOf(saves[0]) === phase && saves[0].succeeded ? saves[0] : undefined
    const verifier = save && verifiers.get(save)
    const submissions = server?.submissions?.filter(row => row.itemId === item.itemId) ?? [], posts = server?.requests?.filter(row => row.itemId === item.itemId && row.method === 'POST') ?? []
    const submission = submissions.length === 1 ? submissions[0] : undefined, post = posts.length === 1 ? posts[0] : undefined
    const persisted = serverBound && submission?.ordinal === index + 1 && submission.persisted === true && submission.status === 200
      && iso(submission.at) && iso(submission.persistedAt) && ms(submission.at) <= ms(submission.persistedAt)
      && equal(submission.record, item.expected) && equal(server.records[item.itemId], item.expected) && submission.bodySha256 === hash(JSON.stringify(submission.record))
      && post && submission.requestOrdinal === post.ordinal && ms(post.at) <= ms(submission.at)
      && matched.has(save) && ms(matched.get(save).startedAt) <= ms(post.at) && ms(post.at) <= ms(matched.get(save).finishedAt)
      && ms(submission.persistedAt) <= verifier?.result.time
    const chain = sourceRead && write && back && type && save && verifier && sourceRead.resultSeq < write.seq && back.resultSeq < type.seq && type.resultSeq < save.seq
      && pageRecord(valueOf(verifier)?.current, url, item.expected)
    const finalPages = phase.native?.finalPages?.filter(row => row.itemId === item.itemId) ?? []
    const final = finalPages.length === 1 ? finalPages[0] : undefined
    const freshPage = nativeBound && final?.url === url && final.reloaded === true && positive(final.rendererPid) && iso(final.capturedAt)
      && phase.end.time <= ms(final.capturedAt) && ms(final.capturedAt) <= ms(phase.native.finishedAt) && final.status === '已保存（服务器记录）' && equal(final.record, item.expected)
      && server?.requests?.some(row => row.itemId === item.itemId && row.method === 'GET' && row.path === basePath + item.itemId + '/'
        && row.recordSha256 === hash(JSON.stringify(item.expected)) && phase.end.time <= ms(row.at) && ms(row.finishedAt) <= ms(final.capturedAt))
    itemProofs.push({ item, sourceRead, write, back, type, save, verifier, output, originalUnchanged: !!actual?.equals(item.bytes),
      outputCorrect: !!output && equal(parse(output.toString('utf8')), item.expected), chain: !!chain, persisted: !!persisted, freshPage: !!freshPage,
      noOutputOrSubmission: !output && writes.length === 0 && submissions.length === 0 && posts.length === 0 && server?.records?.[item.itemId] === null })
  }
  if (seedOnly) {
    const first = itemProofs[0], allowed = new Set(['read', 'write', 'todo_write', 'xiaoshe_runtime_info', 'xiaoshe_capability_plan', 'browser_status', 'browser_open', 'browser_snapshot', 'browser_type', 'browser_click', 'browser_verify', 'browser_scroll'])
    const originalChecks = await Promise.all(items.map(async item => {
      try { return (await smallFile(join(root, item.source))).equals(item.bytes) } catch { return false }
    }))
    const noLaterEffects = server?.records?.['item-2'] === null && server?.records?.['item-3'] === null
      && equal(files, [...items.map(item => item.source), first.item.target].sort())
      && (!boundedRecovery || recoveryBound)
      && calls.every(call => allowed.has(call.name) && (call.succeeded || boundedRecovery && safeRecoveries.has(call))
        && (call.name !== 'read' || [first.item.source, first.item.target].some(path => pathIs(call.arguments.file_path, root, join(root, path))))
        && (call.name !== 'write' || pathIs(call.arguments.file_path, root, join(root, first.item.target)))
        && (call.name !== 'browser_open' || [itemUrl(first.item), itemUrl(first.item) + 'record'].includes(call.arguments.url))
        && (call.name !== 'browser_click' || ['保存结果', '查看已保存记录'].includes(targetOf(call)?.name)))
    const checks = [check('one-complete-seed-turn', completed && structured), check('seed-native-bound', nativeBound && browserBound
      && equal(seed.native.finalPages.map(row => row.itemId), ['item-1'])), check('three-original-inputs-unchanged', originalChecks.every(Boolean)),
      check(boundedRecovery ? 'only-first-item-touched-and-bounded-tool-errors' : 'only-first-item-touched-and-zero-tool-errors', noLaterEffects), check('first-item-file-page-server-delivered', first.chain && first.persisted && first.outputCorrect && first.freshPage),
      check('every-seed-browser-action-verified', mutations.length > 0 && mutations.every(action => verifiers.has(action))), check('seed-server-still-owned-and-open', serverBound)]
    return { schema: 'xiaoshe-batch-seed-proof/v1', runId, sessionId, candidateId, status: state(checks), checks, acceptanceMode, quality, independent,
      checkpoint: { lastSeq: events.length - 1, historySha256: hash(JSON.stringify(events)) },
      boundary: 'Seed artifacts only: no restart or whole-batch success is claimed. Outer runner must retain the real history and observe owned process termination before resume.' }
  }
  const [first, second, broken] = itemProofs
  const recoveredFile = first.output && calls.find(call => phaseOf(call) === resume && readMatches(call, join(root, first.item.target), first.output, root))
  const recoveredQuery = browser.find(call => phaseOf(call) === resume && call.succeeded && matched.has(call) &&
    (call.name === 'browser_open' && [itemUrl(first.item), itemUrl(first.item) + 'record'].includes(call.arguments.url)
      || call.name === 'browser_click' && latest(call)?.snapshot.url === itemUrl(first.item) && targetOf(call)?.name === '查看已保存记录')
    && verifiers.has(call) && pageRecord(valueOf(verifiers.get(call))?.current, itemUrl(first.item), first.item.expected)
    && server?.requests?.some(row => row.itemId === first.item.itemId && row.method === 'GET' && row.recordSha256 === hash(JSON.stringify(first.item.expected))
      && row.path === (call.name === 'browser_open' ? new URL(call.arguments.url).pathname : basePath + first.item.itemId + '/record')
      && ms(matched.get(call).startedAt) <= ms(row.at) && ms(row.finishedAt) <= ms(matched.get(call).finishedAt)))
  const recoveredBeforeNewWork = !!recoveredFile && !!recoveredQuery && second.sourceRead && broken.sourceRead
    && recoveredFile.resultSeq < Math.min(second.sourceRead.seq, broken.sourceRead.seq)
    && verifiers.get(recoveredQuery).resultSeq < Math.min(second.sourceRead.seq, broken.sourceRead.seq)
  const resumeFirstPage = resume.native?.finalPages?.filter(row => row.itemId === first.item.itemId) ?? []
  const recoveryFinalPage = nativeBound && resumeFirstPage.length === 1 && resumeFirstPage[0].url === itemUrl(first.item) && resumeFirstPage[0].reloaded === true
    && positive(resumeFirstPage[0].rendererPid) && iso(resumeFirstPage[0].capturedAt) && resume.end.time <= ms(resumeFirstPage[0].capturedAt)
    && ms(resumeFirstPage[0].capturedAt) <= ms(resume.native.finishedAt) && resumeFirstPage[0].status === '已保存（服务器记录）' && equal(resumeFirstPage[0].record, first.item.expected)
    && server?.requests?.some(row => row.itemId === first.item.itemId && row.method === 'GET' && row.path === basePath + first.item.itemId + '/'
      && row.recordSha256 === hash(JSON.stringify(first.item.expected)) && resume.end.time <= ms(row.at) && ms(row.finishedAt) <= ms(resumeFirstPage[0].capturedAt))
  const allPagesBound = nativeBound && equal(seed.native.finalPages.map(row => row.itemId).sort(), ['item-1'])
    && equal(resume.native.finalPages.map(row => row.itemId).sort(), ['item-1', 'item-2'])
  const answer = latestVisibleAssistantAnswer(events.filter(event => event.seq > resume.user?.seq && event.seq < resume.end?.seq))
  const honestInvalid = !!broken.sourceRead && answer.includes(broken.item.source) && /第\s*(?:2|二)\s*行|行\s*2|line\s*2/iu.test(answer)
    && /JSON|语法|解析|parse|syntax/iu.test(answer) && (/无效|损坏|错误|截断|失败|invalid|malformed|unexpected|unterminated/iu.test(answer)
      || currentBrokenLineParseFailure(answer, broken.item.source, broken.item.invalidLine))
    && /未(?:生成|创建|写入|提交|交付)|跳过|not\s+(?:created|submitted|delivered)/iu.test(answer)
    && /2\s*[\/／]\s*3|(?:2|两|二)\s*(?:项|份|个).{0,12}(?:交付|完成|成功)|(?:交付|完成|成功).{0,12}(?:2|两|二)\s*(?:项|份|个)/iu.test(answer)
    && !/(?<!未|不|非)(?:全部|所有)(?:资料|文件|任务|项目|条目)?(?:已|均|都)?(?:成功|完成|交付)|3\s*[\/／]\s*3/iu.test(answer)
  const legal = new Set(['read', 'write', 'todo_write', 'xiaoshe_runtime_info', 'xiaoshe_capability_plan', 'browser_status', 'browser_open', 'browser_snapshot', 'browser_type', 'browser_click', 'browser_verify', 'browser_scroll'])
  const scoped = structured && (boundedRecovery ? recoveryBound : planFailures.length <= 1)
    && calls.every(call => legal.has(call.name) && (call.succeeded || (boundedRecovery ? safeRecoveries.has(call) : planFailures.includes(call)))
    && (call.name !== 'read' || items.some(item => [item.source, item.target].some(path => pathIs(call.arguments.file_path, root, join(root, path)))))
    && (call.name !== 'write' || items.slice(0, 2).some(item => pathIs(call.arguments.file_path, root, join(root, item.target))))
    && (call.name !== 'browser_open' || items.some(item => [itemUrl(item), itemUrl(item) + 'record'].includes(call.arguments.url)))
    && (call.name !== 'browser_click' || ['保存结果', '查看已保存记录'].includes(targetOf(call)?.name))
    && (phaseOf(call) !== seed || !['read', 'write'].includes(call.name) || [first.item.source, first.item.target].some(path => pathIs(call.arguments.file_path, root, join(root, path)))))
  const noExtraFiles = equal(files, [...BATCH_ITEMS.map(item => item.source), ...BATCH_ITEMS.slice(0, 2).map(item => item.target)].sort())
  const actionsVerified = mutations.length > 0 && mutations.every(action => verifiers.has(action))
  const baseChecks = [check('same-session-two-completed-phases', completed && structured), check('native-actions-bound', nativeBound && browserBound && allPagesBound),
    check('same-candidate-owned-process-restart', restartBound), check('scope-and-failures-bounded', scoped), check('each-browser-action-independently-verified', actionsVerified),
    check('server-closed-and-bound', serverBound), check('no-extra-files', noExtraFiles)]
  const checks = [...baseChecks, check('original-inputs-unchanged', itemProofs.every(item => item.originalUnchanged)),
    check('first-item-delivered-before-stop', first.chain && first.persisted && first.outputCorrect && first.freshPage),
    check('resume-rechecks-first-item-before-new-work', recoveredBeforeNewWork, { file: ref(recoveredFile), query: ref(recoveredQuery) }),
    check('second-item-delivered-after-restart', second.chain && second.persisted && second.outputCorrect && second.freshPage),
    check('first-item-not-resubmitted', first.persisted && server?.submissions?.filter(row => row.itemId === 'item-1').length === 1),
    check('bad-input-line-2-honest-no-output', honestInvalid && broken.noOutputOrSubmission), check('final-first-item-readback', recoveryFinalPage)]
  const status = state(checks)
  return { schema: 'xiaoshe-batch-task-proof/v1', runId, sessionId, candidateId, status, checks, acceptanceMode, quality, independent,
    tasks: ['files-batch-preserve-order', 'recovery-resume-after-restart'].map(taskId => ({ taskId, state: status, checks })),
    items: itemProofs.map(item => ({ itemId: item.item.itemId, state: item.item.invalidLine ? honestInvalid && item.noOutputOrSubmission ? 'invalid-reported' : 'fail'
      : item.chain && item.persisted && item.freshPage && item.outputCorrect ? 'delivered' : 'fail', sourceSha256: hash(item.item.bytes), outputSha256: item.output ? hash(item.output) : null,
      sourceRead: ref(item.sourceRead), write: ref(item.write), readback: ref(item.back), save: ref(item.save), verifier: ref(item.verifier) })),
    actionVerifications: mutations.map(action => ({ action: ref(action), verifier: ref(verifiers.get(action)), state: verifiers.has(action) ? 'pass' : 'fail' })),
    recovery: { successfulWrites: calls.filter(call => call.name === 'write' && call.succeeded).length, totalFailedCalls: calls.filter(call => call.failed).length,
      preflightRejectedWriteCalls: planFailures.length, submittedRequests: server?.requests?.filter(row => row.method === 'POST').length ?? null },
    boundary: 'Fixed 3-item artifact proof, with 2 delivered and 1 invalid at line 2. Outer runner must attest real model, current source/runtime, mounted guards and observed owned-process termination. Offline test ledgers are test-only, never live evidence. Invalid JSON is not an inaccessible-input catalog success.' }
}
