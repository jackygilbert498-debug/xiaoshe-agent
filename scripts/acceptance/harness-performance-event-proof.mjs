import { createHash } from 'node:crypto'
import { eventText } from '../../packages/terminal-client/lib/presentation.js'
import { posix, resolve, win32 } from 'node:path'

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function parseArguments(value) {
  if (object(value)) return value
  if (typeof value !== 'string') return {}
  try { return object(JSON.parse(value)) ?? {} } catch { return {} }
}

/** Reconstruct explicit type-input assertions from caller-bound action evidence.
 * The caller must still bind both native receipts, the current baseline, phase
 * and new DOM. A returned assertion_source alone cannot establish any of them.
 */
export function browserVerificationAssertions(action, baseline, args, value, ownerId) {
  if (!object(args) || !object(value)) return undefined
  const assertions = Object.fromEntries(Object.entries(args).filter(([key]) => key.startsWith('expect_')))
  if (!Object.hasOwn(args, 'use_action_input')) {
    return Object.hasOwn(value, 'assertion_source') ? undefined : assertions
  }
  if (args.use_action_input !== true
    || ['expect_element_id', 'expect_value', 'expect_closed', 'expectElementId', 'expectValue', 'expectClosed'].some(key => Object.hasOwn(args, key))
    || action?.name !== 'browser_type' || action.succeeded !== true || !object(action.arguments)
    || typeof action.arguments.text !== 'string' || action.arguments.text.length > 2000
    || typeof action.arguments.element_id !== 'string' || !action.arguments.element_id || action.arguments.element_id.length > 64
    || typeof ownerId !== 'string' || !ownerId || ownerId.length > 512 || baseline?.owner_id !== ownerId
    || typeof baseline.snapshot_id !== 'string' || !baseline.snapshot_id || baseline.snapshot_id.length > 128
    || typeof baseline.tab_id !== 'string' || !baseline.tab_id || baseline.tab_id.length > 128
    || action.arguments.tab_id !== baseline.tab_id || args.tab_id !== baseline.tab_id
    || args.after_snapshot_id !== baseline.snapshot_id
    || typeof value.snapshot_id !== 'string' || !value.snapshot_id || value.snapshot_id !== value.current?.snapshot_id
    || value.snapshot_id === baseline.snapshot_id) return undefined
  for (const snapshot of [baseline, value.current]) {
    if (!Array.isArray(snapshot?.elements)) return undefined
    const elements = snapshot.elements.filter(element => element?.element_id === action.arguments.element_id)
    if (elements.length !== 1 || elements[0].value !== action.arguments.text) return undefined
  }
  const source = { kind: 'browser_type_input', owner_id: ownerId, tab_id: baseline.tab_id,
    baseline_snapshot_id: baseline.snapshot_id, expect_element_id: action.arguments.element_id,
    input_sha256: createHash('sha256').update(action.arguments.text, 'utf8').digest('hex') }
  if (!object(value.assertion_source) || Object.keys(value.assertion_source).length !== Object.keys(source).length
    || Object.entries(source).some(([key, expected]) => value.assertion_source[key] !== expected)) return undefined
  return { ...assertions, expect_element_id: action.arguments.element_id, expect_value: action.arguments.text }
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
}

function nestedError(value) {
  if (!Array.isArray(value)) return false
  return value.some(block => block?.isError === true || nestedError(block?.content))
}

function resultText(event) {
  const visit = value => Array.isArray(value)
    ? value.flatMap(item => [typeof item?.text === 'string' ? item.text : '', ...visit(item?.content)]).filter(Boolean)
    : []
  return visit(event?.data?.message?.content ?? event?.data?.content).join('\n')
}

/**
 * Read the last durable visible answer in an ordered, caller-scoped event slice.
 * A later correction replaces earlier claims/citations; reasoning, tool calls,
 * streaming chunks and empty usage-only messages cannot supply answer evidence.
 */
export function latestVisibleAssistantAnswer(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    if (Array.isArray(event.data?.stream)) {
      const text = eventText(event)
      if (text.trim()) return text
      continue
    }
    const message = event.data?.message ?? event.data
    const text = Array.isArray(message?.content)
      ? message.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text).join('\n')
      : ''
    if (text.trim()) return text
  }
  return ''
}

function diagnosticText(value) {
  if (typeof value !== 'string') return undefined
  // Failure prose may echo transport credentials. Keep the reason readable,
  // never serialize arbitrary error/config objects, and bound retained text.
  return value
    .replace(/\bBearer\s+[^\s;,]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*["']?[^\s;,"']+/giu, '[credential redacted]')
    .replace(/\bsk-[\w-]+/gu, '[key redacted]')
    .replace(/https?:\/\/[^\s<>"']+/giu, raw => {
      try {
        const url = new URL(raw)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.href
      } catch { return '[url redacted]' }
    })
    .slice(0, 2_000)
}

function diagnosticFields(value, textKeys, numberKeys = []) {
  const output = {}
  for (const key of textKeys) {
    const text = diagnosticText(value?.[key])
    if (text !== undefined) output[key] = text
  }
  for (const key of numberKeys) {
    if (Number.isSafeInteger(value?.[key])) output[key] = value[key]
  }
  return output
}

/**
 * Retain only durable turn failure and obligation correlation facts for the
 * local acceptance report. Tool bodies, model/config/env objects, URL tokens,
 * headers and unknown event fields are deliberately outside this allow-list.
 */
export function harnessTurnDiagnostics(events) {
  const end = events.findLast(event => event?.type === 'turn/end')
  let turnEnd = null
  if (end !== undefined) {
    const rawReason = end.data?.reason
    const reason = diagnosticFields(rawReason, ['kind'])
    if (object(rawReason?.reason)) reason.reason = diagnosticFields(rawReason.reason, ['kind', 'reason'])
    else if (typeof rawReason?.reason === 'string') reason.reason = diagnosticText(rawReason.reason)
    if (object(rawReason?.error)) reason.error = diagnosticFields(rawReason.error, ['code', 'message'], ['status'])
    turnEnd = { ...diagnosticFields(end, [], ['seq']), ...diagnosticFields(end.data, [], ['turn']), reason }
  }
  const reliabilityEvents = events.flatMap(event => {
    if (!['xiaoshe/obligation-state', 'xiaoshe/research-evidence'].includes(event?.type)) return []
    const data = diagnosticFields(event.data,
      ['kind', 'status', 'reason', 'callId', 'failedFamily', 'alternativeFamily', 'alternativeTool'],
      ['version', 'generation', 'turn', 'proofResultSeq'])
    for (const key of ['sourceResultSeqs', 'bodyResultSeqs', 'citedBodyResultSeqs']) {
      if (Array.isArray(event.data?.[key])) data[key] = event.data[key].filter(Number.isSafeInteger)
    }
    return [{ ...diagnosticFields(event, [], ['seq']), type: event.type, data }]
  })
  return { turnEnd, reliabilityEvents }
}

function explicitRootOutcome(event) {
  const data = object(event?.data) ?? {}
  const message = object(data.message) ?? {}
  const blocks = Array.isArray(message.content)
    ? message.content.filter(block => block?.type === 'tool-result')
    : []
  const projected = [data.isError, object(data.result)?.isError, object(data.output)?.isError, message.isError]
  return projected.some(value => typeof value === 'boolean')
    || blocks.some(block => typeof block?.isError === 'boolean')
}

function rootResultCallId(event) {
  if (event?.type !== 'tool/result') return undefined
  const data = object(event.data) ?? {}
  const message = object(data.message) ?? {}
  const source = object(message.source)
  if (source?.kind !== 'tool') return undefined
  const candidates = [
    data.callId,
    data.toolCallId,
    source.callId,
    ...(Array.isArray(message.content)
      ? message.content.flatMap(block => typeof block?.toolCallId === 'string' ? [block.toolCallId] : [])
      : []),
  ].filter(value => typeof value === 'string' && value.trim() !== '')
  if (candidates.length === 0 || candidates.some(value => value !== candidates[0])) return undefined
  return candidates[0]
}

function rootResultFailed(event, toolName) {
  const data = object(event?.data) ?? {}
  const message = object(data.message) ?? {}
  const projected = [data.isError, object(data.result)?.isError, object(data.output)?.isError, message.isError]
  const explicitError = data.error != null || object(data.result)?.error != null || object(data.output)?.error != null
  const shellExit = /^(?:bash|pwsh|powershell|shell|exec_command|run_command|cmd|terminal_send)$/iu.test(toolName)
    && /\[exit code:\s*[1-9]\d*\]/iu.test(resultText(event))
  return explicitError || projected.includes(true) || nestedError(message.content) || shellExit
}

function nestedIdentity(event) {
  if (event?.type !== 'tool/code-dispatch') return undefined
  const data = object(event.data)
  if (data === undefined || !Number.isFinite(event.seq) || typeof data.isError !== 'boolean'
    || !Array.isArray(data.content)) return undefined
  const rootCallId = typeof data.rootCallId === 'string' && data.rootCallId.trim() !== '' ? data.rootCallId : undefined
  const parentCallId = typeof data.parentCallId === 'string' && data.parentCallId.trim() !== '' ? data.parentCallId : undefined
  const callId = typeof data.subCallId === 'string' && data.subCallId.trim() !== '' ? data.subCallId : undefined
  const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name : undefined
  if (!rootCallId || !parentCallId || !callId || !name || !Object.hasOwn(data, 'arguments')) return undefined
  return { rootCallId, parentCallId, callId, name, arguments: parseArguments(data.arguments) }
}

function add(map, key, value) {
  const bucket = map.get(key) ?? []
  bucket.push(value)
  map.set(key, bucket)
}

/**
 * Reconstruct trustworthy root and Code Mode tool evidence from durable facts.
 * Duplicate identities, preceding results, divergent nested arguments and
 * implicit outcomes remain visible but never qualify as successful evidence.
 */
export function buildHarnessToolRecords(events) {
  const calls = []
  const callCount = new Map()
  const rootResults = new Map()
  const nestedResults = new Map()

  for (const [eventIndex, event] of events.entries()) {
    if (event?.type === 'tool/call') {
      const data = object(event.data)
      const callId = typeof data?.callId === 'string' && data.callId.trim() !== '' ? data.callId : undefined
      const name = typeof data?.name === 'string' && data.name.trim() !== '' ? data.name : undefined
      if (!Number.isFinite(event.seq) || !callId || !name) continue
      const record = {
        seq: event.seq,
        callId,
        name,
        arguments: parseArguments(data.arguments),
        eventType: event.type,
        eventIndex,
      }
      calls.push(record)
      add(callCount, `root:${callId}`, record)
      continue
    }
    if (event?.type === 'tool/code-dispatch-start') {
      const data = object(event.data)
      const rootCallId = typeof data?.rootCallId === 'string' && data.rootCallId.trim() !== '' ? data.rootCallId : undefined
      const parentCallId = typeof data?.parentCallId === 'string' && data.parentCallId.trim() !== '' ? data.parentCallId : undefined
      const callId = typeof data?.subCallId === 'string' && data.subCallId.trim() !== '' ? data.subCallId : undefined
      const name = typeof data?.name === 'string' && data.name.trim() !== '' ? data.name : undefined
      if (!Number.isFinite(event.seq) || !rootCallId || !parentCallId || !callId || !name || !Object.hasOwn(data, 'arguments')) continue
      const record = {
        seq: event.seq,
        callId,
        name,
        arguments: parseArguments(data.arguments),
        eventType: event.type,
        rootCallId,
        parentCallId,
        eventIndex,
      }
      calls.push(record)
      add(callCount, `nested:${callId}`, record)
      continue
    }
    const rootId = rootResultCallId(event)
    if (rootId !== undefined && Number.isFinite(event.seq)) add(rootResults, rootId, { event, eventIndex })
    const nested = nestedIdentity(event)
    if (nested !== undefined) add(nestedResults, nested.callId, { event, identity: nested, eventIndex })
  }

  return calls.map(call => {
    const kind = call.eventType === 'tool/call' ? 'root' : 'nested'
    const uniqueCall = (callCount.get(`${kind}:${call.callId}`) ?? []).length === 1
    const candidates = kind === 'root' ? rootResults.get(call.callId) ?? [] : nestedResults.get(call.callId) ?? []
    const paired = uniqueCall && candidates.length === 1 ? candidates[0] : undefined
    const result = paired?.event
    const identity = kind === 'nested' ? paired?.identity : undefined
    const identityMatches = kind === 'root' || (identity !== undefined
      && identity.rootCallId === call.rootCallId && identity.parentCallId === call.parentCallId
      && identity.name === call.name && stable(identity.arguments) === stable(call.arguments))
    const ordered = Number.isFinite(result?.seq) && result.seq > call.seq && paired.eventIndex > call.eventIndex
    const explicitOutcome = kind === 'root' ? explicitRootOutcome(result) : typeof result?.data?.isError === 'boolean'
    const failed = result !== undefined && identityMatches && ordered && explicitOutcome
      && (kind === 'root'
        ? rootResultFailed(result, call.name)
        : result.data.isError === true || nestedError(result.data.content)
          || (/^(?:bash|pwsh|powershell|shell|exec_command|run_command|cmd|terminal_send)$/iu.test(call.name)
            && /\[exit code:\s*[1-9]\d*\]/iu.test(resultText(result))))
    const settled = result !== undefined && identityMatches && ordered && explicitOutcome
    return {
      ...call,
      fingerprint: createHash('sha256').update(call.name).update(stable(call.arguments)).digest('hex'),
      result,
      resultSeq: Number.isFinite(result?.seq) ? result.seq : undefined,
      settled,
      failed,
      succeeded: settled && !failed,
    }
  })
}

/**
 * Surface work that began before a user-intent boundary but completed after it.
 * Filtering only by call sequence hides this race and can make a steer test pass
 * even though a successful result from the abandoned route reached the model.
 */
export function successfulCallsSettledAfterBoundary(calls, boundary) {
  if (!Number.isFinite(boundary) || !Array.isArray(calls)) return []
  return calls.filter(call => Number.isFinite(call?.seq) && call.seq <= boundary
    && Number.isFinite(call?.resultSeq) && call.resultSeq > boundary
    && call.succeeded === true)
}

function normalizedDirectory(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const input = value.trim()
  const windowsAbsolute = /^[a-z]:[\\/]/iu.test(input) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(input)
  if (windowsAbsolute) return win32.normalize(input).replace(/[\\/]+$/u, '').toLowerCase()
  if (posix.isAbsolute(input)) return posix.normalize(input).replace(/[\\/]+$/u, '')
  const normalized = resolve(input).replace(/[\\/]+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** An omitted shell cwd inherits the scenario cwd; every explicit cwd must match it exactly. */
export function callUsesSessionDirectory(call, sessionDirectory) {
  const expected = normalizedDirectory(sessionDirectory)
  if (expected === undefined) return false
  const explicit = ['cwd', 'workdir', 'workingDirectory', 'working_directory']
    .filter(key => Object.hasOwn(call?.arguments ?? {}, key))
    .map(key => normalizedDirectory(call.arguments[key]))
  return explicit.length === 0 || explicit.every(value => value === expected)
}
