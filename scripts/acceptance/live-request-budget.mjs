// Acceptance-only gate. It bounds dispatched DSH requests, not money: input/cache
// charges, provider billing, unknown usage and transport cancellation still apply.
// Load into the isolated host before starting sessions; never load in a daily Profile.
// The host must disable arbitrary network/shell/plugin-reconfiguration tools and
// trust its adapters/middleware. This is not a sandbox for direct adapter/fetch
// calls outside LlmRuntime, ledger deletion/tampering, or power-loss durability.
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'xiaoshe-acceptance-request-budget'
export const inject = ['llm']
export const MAX_REQUESTS = 16
// Cross-file/browser journeys include a separate verification after each UI
// action. This opt-in ceiling does not change existing 0/8/16-slot ledgers.
export const MAX_MATERIAL_REQUESTS = 64
export const MAX_OUTPUT_TOKENS = 2048
const FORMAT = 1
const tokenKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
const fail = code => Object.assign(new Error(`acceptance-budget: ${code}`), { code })
const textId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/u.test(value)

function identity(config) {
  if (!config || !isAbsolute(config.ledgerDirectory ?? '') || !textId(config.runId)
    || ![0, 8, MAX_REQUESTS, MAX_MATERIAL_REQUESTS].includes(config.maxRequests) || !textId(config.provider) || !textId(config.model)
    || !Array.isArray(config.sessionIds) || !config.sessionIds.every(textId)
    || new Set(config.sessionIds).size !== config.sessionIds.length
    || (config.maxRequests !== 0 && config.sessionIds.length === 0)
    || Object.keys(config).some(key => !['ledgerDirectory', 'runId', 'maxRequests', 'provider', 'model', 'sessionIds'].includes(key))) {
    throw fail('invalid_config')
  }
  return Object.freeze({ format: FORMAT, runId: config.runId, mode: config.maxRequests === 0 ? 'no_model' : 'bounded_model',
    maxRequests: config.maxRequests, maxOutputTokens: MAX_OUTPUT_TOKENS, provider: config.provider,
    model: config.model, sessionIds: [...config.sessionIds].sort() })
}

async function readJson(io, path) {
  const stat = await io.lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw fail('invalid_ledger')
  // O_NOFOLLOW also closes the lstat/open symlink swap for the final component.
  const file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return JSON.parse(await file.readFile('utf8')) } finally { await file.close() }
}

async function exclusiveJson(io, path, value) {
  const file = await io.open(path, 'wx', 0o600)
  // Never unlink a failed/partial reservation: its slot remains consumed.
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() } finally { await file.close() }
}

function usageValue(value) {
  if (!value || !['inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null
  const result = {}
  for (const key of tokenKeys) {
    if (value[key] === undefined) continue
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null
    result[key] = value[key]
  }
  return result
}

/** Independent post-run reader. Missing/invalid usage is unknown, never zero. */
export async function readBudgetLedger(ledgerDirectory, io = fs) {
  const manifest = await readJson(io, join(ledgerDirectory, 'manifest.json'))
  const expected = identity({ ledgerDirectory, runId: manifest.runId, maxRequests: manifest.maxRequests,
    provider: manifest.provider, model: manifest.model, sessionIds: manifest.sessionIds })
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw fail('invalid_ledger')
  const names = await io.readdir(ledgerDirectory)
  if (names.some(value => {
    const slot = /^request-(\d+)\.json$/u.exec(value)
    return slot && (Number(slot[1]) < 1 || Number(slot[1]) > manifest.maxRequests)
  })) throw fail('invalid_ledger')
  const requests = []
  for (let ordinal = 1; ordinal <= manifest.maxRequests; ordinal++) {
    if (!names.includes(`request-${ordinal}.json`)) continue
    let receipt = null
    try { receipt = await readJson(io, join(ledgerDirectory, `receipt-${ordinal}.json`)) } catch { /* Unknown, including partial receipts. */ }
    const usage = receipt?.ordinal === ordinal ? usageValue(receipt.usage) : null
    requests.push({ ordinal, outcome: ['finished', 'output_limit', 'failed', 'interrupted'].includes(receipt?.outcome) ? receipt.outcome : 'unknown', usage })
  }
  const deniedRequests = names.filter(value => /^denied-[\da-f-]+\.json$/u.test(value)).length
  const mounts = []
  for (const file of names.filter(value => value.startsWith('mounted-')).sort()) {
    const match = /^mounted-(\d+)-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.json$/u.exec(file)
    let row
    try { row = await readJson(io, join(ledgerDirectory, file)) } catch { throw fail('invalid_mount_record') }
    if (!match || row?.format !== FORMAT || row.runId !== manifest.runId || !Number.isSafeInteger(row.pid)
      || row.pid < 1 || String(row.pid) !== match[1] || typeof row.at !== 'string'
      || !Number.isFinite(Date.parse(row.at)) || new Date(row.at).toISOString() !== row.at
      || Object.keys(row).sort().join(',') !== 'at,format,pid,runId') throw fail('invalid_mount_record')
    mounts.push({ file, runId: row.runId, pid: row.pid, at: row.at })
  }
  const knownUsage = Object.fromEntries(tokenKeys.map(key => [key,
    requests.some(request => request.usage?.[key] !== undefined)
      ? requests.reduce((sum, request) => sum + (request.usage?.[key] ?? 0), 0) : null]))
  const unknownUsageRequests = requests.filter(request => request.usage === null).length
  return { mounted: mounts.length > 0, mountCount: mounts.length, mounts, mode: manifest.mode, runId: manifest.runId,
    maxRequests: manifest.maxRequests, maxOutputTokens: MAX_OUTPUT_TOKENS,
    attemptedRequests: requests.length + deniedRequests, reservedRequests: requests.length, deniedRequests,
    remainingRequests: Math.max(0, manifest.maxRequests - requests.length), requests,
    usage: { status: requests.length === 0 ? 'no_model' : unknownUsageRequests ? 'unknown' : 'reported',
      unknownUsageRequests, knownUsage: requests.length ? knownUsage : null,
      totalUsage: requests.length > 0 && unknownUsageRequests === 0
        ? Object.fromEntries(tokenKeys.map(key => [key, requests.every(request => request.usage?.[key] !== undefined) ? knownUsage[key] : null])) : null },
    monetaryHardCap: false }
}

/** The optional io seam is for offline failure injection, never Profile config. */
export function createBudgetGate(config, { io = fs, retryPolicy } = {}) {
  let expected
  let fatal
  const now = () => new Date().toISOString()
  const path = file => join(config.ledgerDirectory, file)
  const fault = error => { fatal = fail(error?.code === 'identity_mismatch' ? 'identity_mismatch' : 'ledger_unavailable'); return fatal }
  const checkManifest = async () => {
    if (JSON.stringify(await readJson(io, path('manifest.json'))) !== JSON.stringify(expected)) throw fail('identity_mismatch')
  }
  const checkRetry = () => {
    if (expected.maxRequests === 0) return
    let policy
    try { policy = retryPolicy?.(expected.provider) } catch { throw fail('retry_policy_not_zero') }
    if (policy?.mode !== 'normal' || policy.maxRetries !== 0) throw fail('retry_policy_not_zero')
  }
  const ready = (async () => {
    expected = identity(config)
    await io.mkdir(config.ledgerDirectory, { recursive: true, mode: 0o700 })
    const stat = await io.lstat(config.ledgerDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('invalid_ledger')
    try { await exclusiveJson(io, path('manifest.json'), expected) } catch (error) { if (error.code !== 'EEXIST') throw error }
    await checkManifest()
    checkRetry()
    const mountId = `${process.pid}-${randomUUID()}`
    const pendingMount = path(`pending-mount-${mountId}.json`)
    await exclusiveJson(io, pendingMount, { format: FORMAT, runId: expected.runId, pid: process.pid, at: now() })
    // A parent polling mount observations must never see a half-written record.
    // A failed publish leaves no mounted marker and the installed hooks closed.
    await io.rename(pendingMount, path(`mounted-${mountId}.json`))
  })().catch(error => { fatal = error?.message?.startsWith('acceptance-budget:') ? error : fault(error); throw fatal })
  // Cordis apply is synchronous, so initialization rejection must not go unhandled.
  ready.catch(() => {})

  const deny = async code => {
    try { await exclusiveJson(io, path(`denied-${randomUUID()}.json`), { format: FORMAT, reason: code, at: now() }) } catch (error) { throw fault(error) }
    throw fail(code)
  }
  const assertReady = async () => { await ready; if (fatal) throw fatal; try { await checkManifest() } catch (error) { throw fault(error) } }
  const routeAllowed = options => options.provider === expected.provider && options.model === expected.model
    && expected.sessionIds.includes(options.sessionId) && options.purpose === undefined

  return {
    ready,
    async snapshot() { await assertReady(); return readBudgetLedger(config.ledgerDirectory, io) },
    async requestConfig(agent, next) {
      await assertReady()
      // 0-mode also records attempts which fail before LlmRuntime can resolve a route.
      if (expected.maxRequests === 0) return deny('no_model')
      const proposal = await next()
      if (!routeAllowed({ ...proposal, sessionId: agent?.session?.id })) return deny('route_not_allowed')
      if (proposal.maxTokens !== undefined && (!Number.isSafeInteger(proposal.maxTokens) || proposal.maxTokens < 1)) return deny('invalid_output_cap')
      return { ...proposal, maxTokens: Math.min(proposal.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS) }
    },
    async *stream(options, next) {
      await assertReady()
      if (expected.maxRequests === 0) return await deny('no_model')
      // The agent loop already deep-freezes GenerateOptions. Freeze direct-call
      // scalars too: an async ledger write must not allow route/cap mutation
      // between validation and adapter dispatch. Reject accessor-based scalars.
      if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
        || ['provider', 'model', 'sessionId', 'maxTokens', 'purpose'].some(key => {
          const descriptor = Object.getOwnPropertyDescriptor(options, key)
          return descriptor && !Object.hasOwn(descriptor, 'value')
        })) return await deny('invalid_request_object')
      try { Object.freeze(options) } catch { return await deny('invalid_request_object') }
      if (!routeAllowed(options)) return await deny('route_not_allowed')
      if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > MAX_OUTPUT_TOKENS) return await deny('invalid_output_cap')
      try { checkRetry() } catch { return await deny('retry_policy_not_zero') }
      if (options.signal?.aborted) return await deny('already_aborted')
      let ordinal
      // Exclusive immutable slots make the configured cap global to this ledger,
      // including concurrent processes. No lease, refund, stale-lock reset or retry.
      for (let candidate = 1; candidate <= expected.maxRequests; candidate++) {
        try {
          await exclusiveJson(io, path(`request-${candidate}.json`), { format: FORMAT, runId: expected.runId,
            ordinal: candidate, at: now(), maxTokens: options.maxTokens })
          ordinal = candidate
          break
        } catch (error) { if (error.code !== 'EEXIST') throw fault(error) }
      }
      if (ordinal === undefined) return await deny('budget_exhausted')
      let usage = null
      let outcome = 'interrupted'
      try {
        if (fatal) throw fatal
        if (options.signal?.aborted) throw fail('already_aborted')
        // Validation/capping happens before this immutable LLM request. Neither
        // preparedCall.stream nor auxiliary/direct llm.stream gets an exemption.
        for await (const chunk of next()) {
          if (chunk.type === 'usage') usage = usageValue(chunk.usage) // latest cumulative observation, not a sum
          if (chunk.type === 'finish') outcome = chunk.reason?.kind === 'max-tokens' ? 'output_limit'
            : ['stop', 'tool-calls'].includes(chunk.reason?.kind) ? 'finished' : 'failed'
          yield chunk
        }
      } catch (error) { outcome = 'failed'; throw error } finally {
        try { await exclusiveJson(io, path(`receipt-${ordinal}.json`), { format: FORMAT, ordinal, outcome, usage, at: now() }) }
        catch (error) { throw fault(error) }
      }
    },
  }
}

/** Real Cordis entry point; no build, credentials, provider imports or network. */
export function installBudgetGate(ctx, config) {
  const gate = createBudgetGate(config, { retryPolicy: provider => ctx.llm.providerRetryPolicy(provider) })
  // Hooks are installed before asynchronous initialization completes. A failed
  // initialization leaves these rejecting hooks installed, rather than failing
  // plugin apply and accidentally disposing the only guard.
  ctx.on('llm/stream', (options, next) => gate.stream(options, next), { global: true, prepend: true })
  ctx.on('agent/request', ({ agent }, next) => gate.requestConfig(agent, next), { global: true, prepend: true })
  return gate
}

export function apply(ctx, config) { installBudgetGate(ctx, config) }
