import { resolve } from 'node:path'

/** Parse a tool's durable JSON argument payload without inventing missing data. */
export function parseToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function nestedToolError(value) {
  if (!Array.isArray(value)) return false
  return value.some(block => block?.isError === true || nestedToolError(block?.content))
}

/** Read a result's call identity only when its available durable identities agree. */
export function toolResultCallId(event) {
  if (event?.type !== 'tool/result') return undefined
  if (event.data?.message?.source !== undefined && event.data.message.source?.kind !== 'tool') return undefined
  const candidates = [
    event.data?.callId,
    event.data?.toolCallId,
    event.data?.message?.source?.callId,
    ...(Array.isArray(event.data?.message?.content)
      ? event.data.message.content.flatMap(block => typeof block?.toolCallId === 'string' ? [block.toolCallId] : [])
      : []),
  ].filter(value => typeof value === 'string' && value.trim() !== '')
  if (candidates.length === 0 || candidates.some(value => value !== candidates[0])) return undefined
  return candidates[0]
}

/** A successful tool result must not carry an error at any supported projection. */
export function toolResultFailed(event) {
  if (event?.type !== 'tool/result') return true
  const data = event.data ?? {}
  return data.error != null
    || data.isError === true
    || data.result?.isError === true
    || data.output?.isError === true
    || data.message?.isError === true
    || nestedToolError(data.message?.content)
}

function toolResultExplicitlySucceeded(event) {
  const data = event?.data ?? {}
  const projected = [data.isError, data.result?.isError, data.output?.isError, data.message?.isError]
  const blocks = Array.isArray(data.message?.content)
    ? data.message.content.filter(block => block?.type === 'tool-result')
    : []
  return projected.includes(false) || blocks.some(block => block.isError === false)
}

/**
 * Pair every durable tool/call with exactly one later successful tool/result.
 * Missing, duplicated, mismatched, preceding, or failed results never count as
 * acceptance evidence.
 */
export function buildToolCallRecords(events) {
  const results = new Map()
  const callCounts = new Map()
  for (const [eventIndex, event] of events.entries()) {
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string' && event.data.callId.trim() !== '') {
      callCounts.set(event.data.callId, (callCounts.get(event.data.callId) ?? 0) + 1)
    }
    const callId = toolResultCallId(event)
    if (callId === undefined) continue
    const bucket = results.get(callId) ?? []
    bucket.push({ event, eventIndex })
    results.set(callId, bucket)
  }

  return events.flatMap((event, eventIndex) => event?.type === 'tool/call' ? [{ event, eventIndex }] : []).map(({ event, eventIndex }) => {
    const callId = typeof event.data?.callId === 'string' && event.data.callId.trim() !== ''
      ? event.data.callId
      : undefined
    const matching = callId === undefined ? [] : results.get(callId) ?? []
    const paired = callId !== undefined && callCounts.get(callId) === 1 && matching.length === 1
      ? matching[0]
      : undefined
    const result = paired?.event
    const seq = Number.isFinite(event.seq) ? event.seq : -1
    const resultSeq = Number.isFinite(result?.seq) ? result.seq : undefined
    const settled = result !== undefined && resultSeq > seq && paired.eventIndex > eventIndex
    return {
      seq,
      callId,
      name: typeof event.data?.name === 'string' ? event.data.name : '',
      arguments: parseToolArguments(event.data?.arguments),
      resultSeq,
      settled,
      failed: settled && toolResultFailed(result),
      succeeded: settled
        && toolResultExplicitlySucceeded(result) && !toolResultFailed(result),
    }
  })
}

const PATH_KEYS = ['file_path', 'filePath', 'path']

function normalizedExactPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return resolve(value.trim()).replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US')
}

export function callTargetsExactPath(call, targetPath) {
  const target = normalizedExactPath(targetPath)
  return target !== undefined && PATH_KEYS.some(key => normalizedExactPath(call?.arguments?.[key]) === target)
}

function isReadCall(call) {
  return /(?:^|[_.:-])(?:read|open)(?:[_.:-]|$)/iu.test(call?.name ?? '')
}

function isWriteCall(call) {
  return /(?:^|[_.:-])(?:write|edit|patch|apply_patch|str_replace_editor)(?:[_.:-]|$)/iu.test(call?.name ?? '')
}

/** Require one exact read whose paired durable result explicitly failed. */
export function hasExactFailedRead(calls, targetPath) {
  const matching = calls.filter(call => isReadCall(call) && callTargetsExactPath(call, targetPath))
  return matching.length === 1 && matching[0].settled === true && matching[0].failed === true
}

/** Bind recovery to the result of one exact failed read and a later exact successful fallback read. */
export function hasFailedReadThenRecovery(calls, failedPath, fallbackPath) {
  const failed = calls.filter(call => isReadCall(call) && callTargetsExactPath(call, failedPath))
  if (failed.length !== 1 || failed[0].settled !== true || failed[0].failed !== true) return false
  return calls.some(call => call.succeeded === true && isReadCall(call)
    && callTargetsExactPath(call, fallbackPath) && call.seq > failed[0].resultSeq)
}

/** Require an exact target mutation and a successful exact target read after its result. */
export function hasExactWriteReadback(calls, targetPath) {
  return calls.some(write => write.succeeded && isWriteCall(write) && callTargetsExactPath(write, targetPath)
    && calls.some(read => read.succeeded && isReadCall(read) && callTargetsExactPath(read, targetPath)
      && read.seq > write.resultSeq))
}

/** Keep idle polling separate from the authoritative durable turn result. */
export function decideScenarioState({ settled, turnEnd, verdict, externalBoundary = false }) {
  if (externalBoundary || verdict === 'pending_external') return 'pending_external'
  return settled === true && turnEnd === 'completed' && verdict === true ? 'pass' : 'fail'
}

/** Pending external work is a blocking gate unless the caller explicitly opts out. */
export function reportExitCode(checks, { allowPendingExternal = false } = {}) {
  const blocking = checks.some(check => check?.state === 'fail'
    || check?.state === 'not_run'
    || (check?.state === 'pending_external' && !allowPendingExternal))
  return blocking ? 1 : 0
}

/** Preserve the historical optional image argument while recognizing one explicit waiver. */
export function parseSmokeCliArgs(argv) {
  const allowPendingExternal = argv.includes('--allow-pending-external')
  const positional = argv.filter(value => value !== '--allow-pending-external')
  return { allowPendingExternal, imagePath: positional[0] }
}
