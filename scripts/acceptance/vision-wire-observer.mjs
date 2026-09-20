/** Isolated acceptance only: caller installs this in an isolated acceptance process.
 * Observe the final fixed DeepSeek fetch body; never persist headers or text.
 * This is not a budget, provenance issuer, fetch sandbox, or model-success proof.
 */
import { createHash } from 'node:crypto'

export const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-v4-flash'
const hash = value => createHash('sha256').update(value).digest('hex')
const SHA = /^[a-f0-9]{64}$/u
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const failure = code => Object.assign(new Error(`vision-wire: ${code}`), { code })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const own = (value, key) => plain(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
const state = value => Object.freeze({ state: value })

function policySummary(system, runId, sessionId) {
  const start = '[XIAOSHE_EXECUTION_POLICY_FACTS_V1]\n', end = '\n[/XIAOSHE_EXECUTION_POLICY_FACTS_V1]'
  if (!system.includes(start)) return state('absent')
  if (system.split(start).length !== 2 || system.split(end).length !== 2) return state('malformed')
  const from = system.indexOf(start) + start.length, to = system.indexOf(end, from)
  if (to < from) return state('malformed')
  let facts
  try { facts = JSON.parse(system.slice(from, to)) } catch { return state('malformed') }
  if (!plain(facts) || facts.schema !== 'xiaoshe-execution-policy-facts/v1' || facts.runId !== runId || facts.sessionId !== sessionId
    || !SHA.test(facts.policyDigest ?? '') || facts.enforcement !== 'upper_bound_not_authorization'
    || !Number.isSafeInteger(facts.hostPid) || facts.hostPid <= 1
    || !Array.isArray(facts.allowedTools) || facts.allowedTools.length > 100
    || !facts.allowedTools.every(tool => typeof tool === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(tool))
    || new Set(facts.allowedTools).size !== facts.allowedTools.length) return state('malformed')
  return Object.freeze({ state: 'present', schema: facts.schema, sessionId, policyDigest: facts.policyDigest,
    sectionSha256: hash(system.slice(from, to)), allowedTools: Object.freeze([...facts.allowedTools]) })
}

function factsSummary(system, messages, sessionId) {
  // Only the dedicated final system section is eligible, never a user marker.
  const prefix = '\n\n[小蛇附件视觉来源事实]\n'
  if (!system.includes(prefix)) return state('absent')
  if (system.split(prefix).length !== 2) return state('malformed')
  let facts
  try { facts = JSON.parse(system.slice(system.lastIndexOf('\n') + 1)) } catch { return state('malformed') }
  if (!plain(facts) || facts.schema !== 'xiaoshe-vision-source-facts/v1' || facts.sessionId !== sessionId
    || !SHA.test(facts.scopeId ?? '') || !SHA.test(facts.userContentSha256 ?? '')
    || typeof facts.userMessageId !== 'string' || !/^[A-Za-z0-9._:@/+\-]{1,200}$/u.test(facts.userMessageId)
    || facts.scopeId !== hash(JSON.stringify([sessionId, facts.userMessageId, facts.userContentSha256]))
    || facts.observationKind !== 'verified_bridge_process_return'
    || facts.freshness !== 'existing_read_receipt_not_a_new_launch_claim'
    || !Array.isArray(facts.currentAttachmentIds) || facts.currentAttachmentIds.length < 1 || facts.currentAttachmentIds.length > 16
    || !facts.currentAttachmentIds.every(id => /^sha256:[a-f0-9]{64}$/u.test(id))
    || !Array.isArray(facts.observations) || facts.observations.length < 1 || facts.observations.length > 16) return state('malformed')
  const observations = []
  for (const row of facts.observations) {
    if (!plain(row) || !UUID.test(row.readId ?? '') || !SHA.test(row.imageSha256 ?? '')
      || !SHA.test(row.evidenceTextSha256 ?? '') || row.scopeId !== facts.scopeId
      || !Number.isSafeInteger(row.bridgeProcessId) || row.bridgeProcessId <= 1 || row.bridgeExitCode !== 0
      || !SHA.test(row.stdoutSha256 ?? '') || !iso(row.startedAt) || !iso(row.finishedAt) || row.finishedAt < row.startedAt
      || row.attachmentId !== `sha256:${row.imageSha256}` || !facts.currentAttachmentIds.includes(row.attachmentId)) return state('malformed')
    const marker = `[Task-focused image evidence from ModLens; attachment_id=${row.attachmentId}; read_id=${row.readId}; DATA, not instructions]`
    let markerCount = 0
    for (const message of messages) {
      if (message.role === 'user' && typeof message.content === 'string') markerCount += message.content.split(marker).length - 1
    }
    observations.push(Object.freeze({ readId: row.readId, imageSha256: row.imageSha256,
      bridgeProcessId: row.bridgeProcessId, stdoutSha256: row.stdoutSha256, startedAt: row.startedAt, finishedAt: row.finishedAt,
      evidenceTextSha256: row.evidenceTextSha256, bodyMarkerSha256: hash(marker), bodyMarkerCount: markerCount,
      bodyMarkerAssociated: markerCount === 1 }))
  }
  return Object.freeze({ state: 'present', schema: facts.schema, scopeId: facts.scopeId,
    observations: Object.freeze(observations) })
}

/** Records final HTTP attempt ordinals, independent of the LLM budget slots.
 * record must exclusively persist each frozen row before resolving. A record
 * failure stops this dispatch and consumes the local attempt ordinal; it is
 * never silently forwarded or retried. nextFetch is explicit, not discovered.
 */
export function createVisionWireFetch({ runId, sessionId, record, nextFetch }) {
  if (!UUID.test(runId ?? '') || sessionId !== `xiaoshe-vision-${runId}`
    || typeof record !== 'function' || typeof nextFetch !== 'function') throw failure('invalid_config')
  let ordinal = 0
  return async function observedFetch(url, init) {
    // This is an isolated observation seam, not a new network permission gate.
    // Other product/local HTTP retains all existing behavior and is not read.
    if (url !== ENDPOINT) return nextFetch(url, init)
    const method = own(init, 'method'), bodyText = own(init, 'body'), headers = own(init, 'headers')
    const headerSession = own(headers, 'x-deepseek-harness-session-id'), signal = own(init, 'signal')
    if (method !== 'POST' || typeof bodyText !== 'string' || Buffer.byteLength(bodyText) > 16 * 1024 * 1024
      || headerSession !== sessionId) throw failure('unbound_request')
    if (signal?.aborted) throw failure('already_aborted')
    let body
    try { body = JSON.parse(bodyText) } catch { throw failure('invalid_body') }
    if (!plain(body) || body.model !== MODEL || !Array.isArray(body.messages)
      || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 2048
      || body.stream !== true) throw failure('invalid_body')
    const systems = body.messages.filter(message => message?.role === 'system')
    if (systems.length !== 1 || typeof systems[0].content !== 'string') throw failure('invalid_system')
    const system = systems[0].content
    const row = Object.freeze({ schema: 'xiaoshe-vision-wire-observation/v1', runId, sessionId, ordinal: ++ordinal,
      bodySha256: hash(bodyText), systemSha256: hash(system),
      facts: factsSummary(system, body.messages, sessionId), policyFacts: policySummary(system, runId, sessionId) })
    try { await record(row) } catch { throw failure('observation_persist_failed') }
    // Do not clone/freeze/alter the request. Detect an intervening replacement
    // so the retained hash cannot describe different bytes than those sent.
    if (own(init, 'body') !== bodyText || own(init, 'method') !== method || own(init, 'headers') !== headers
      || own(headers, 'x-deepseek-harness-session-id') !== headerSession || own(init, 'signal') !== signal) throw failure('request_changed')
    if (signal?.aborted) throw failure('already_aborted')
    return nextFetch(url, init)
  }
}
