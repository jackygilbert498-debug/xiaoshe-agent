/** Isolated vision acceptance only. Counts official API streams, not the
 * ModLens wrapper or its separately guarded CLI engine. This is not a sandbox
 * for untrusted adapters calling fetch directly; the runner must disable all
 * alternate providers, network tools and plugin/settings reconfiguration. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CredentialProvider } from '../../runtime/DSH/packages/credentials/credentials/lib/index.js'
import { assertUsableApiKey, resolveRetryPolicy } from '../../runtime/DSH/packages/llm/llm/lib/index.js'
import { DeepSeekAdapter } from '../../runtime/DSH/packages/llm/llm-deepseek/lib/index.js'
import { createBudgetGate, MAX_OUTPUT_TOKENS } from './live-request-budget.mjs'
import { OFFICIAL_ADAPTER_CONFIG } from './live-official-budget.mjs'
import { selectedCredential } from './same-session-files-live.mjs'

export const name = 'xiaoshe-acceptance-live-vision-budget'
export const inject = ['llm']
const WRAPPER = 'deepseek-modlens', OFFICIAL = 'deepseek-official', MODEL = 'deepseek-v4-flash'
const REF = 'DEEPSEEK_API_KEY', KEY_FILE = '/Users/zfy/.dsh/.credentials.yaml'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const fail = code => Object.assign(new Error(`vision-budget: ${code}`), { code })
const plainData = value => value && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))

export const VISION_CONNECTION = Object.freeze({
  baseURL: OFFICIAL_ADAPTER_CONFIG.baseURL, apiKeyEnv: REF,
  defaults: Object.freeze({ thinking: 'disabled', reasoningEffort: 'off' }),
  maxTokens: MAX_OUTPUT_TOKENS, defaultContextWindow: 1_000_000,
  models: OFFICIAL_ADAPTER_CONFIG.models, streamIdleTimeoutMs: 60_000,
  maxRequestImageBytes: 20 * 1024 * 1024,
  retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'vision-budget'),
})

function ownedRoot(root) {
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root
    || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw fail('unsafe_acceptance_root')
  return stat
}

export function visionBudgetConfig(config) {
  if (!plainData(config) || Object.keys(config).sort().join(',') !== 'acceptanceRoot,runId,sessionId'
    || !UUID.test(config.runId ?? '') || config.sessionId !== `xiaoshe-vision-${config.runId}`
    || typeof config.acceptanceRoot !== 'string'
    || basename(config.acceptanceRoot) !== `xiaoshe-product-acceptance-${config.runId}`
    || dirname(config.acceptanceRoot) !== realpathSync(tmpdir())) throw fail('invalid_isolated_identity')
  ownedRoot(config.acceptanceRoot)
  return Object.freeze({ ledgerDirectory: join(config.acceptanceRoot, 'budget'), runId: config.runId,
    maxRequests: 8, provider: OFFICIAL, model: MODEL, sessionIds: Object.freeze([config.sessionId]) })
}

/** The optional credential reader is solely an offline test seam. apply never
 * reads it from Profile config; no credential value is a config/report field. */
export function installVisionBudget(ctx, config, { readCredential = () => selectedCredential(KEY_FILE) } = {}) {
  const budgetConfig = visionBudgetConfig(config)
  const root = config.acceptanceRoot, rootIdentity = ownedRoot(root), sessionId = config.sessionId
  if (ctx.get('credentials') !== undefined) throw fail('credential_provider_already_mounted')
  if (ctx.llm.listProviders().some(row => row.id === OFFICIAL)) throw fail('official_provider_already_mounted')
  class SelectedReadOnlyCredential extends CredentialProvider {
    async resolve(ref) {
      if (ref !== REF) return undefined
      try { return { value: assertUsableApiKey(await readCredential(), name, REF), source: 'acceptance-selected-read-only' } }
      catch { throw fail('selected_credential_unavailable') }
    }
    async describe(ref) {
      if (ref !== REF) return { configured: false, writable: false }
      return { configured: await this.resolve(ref).then(() => true, () => false), writable: false }
    }
    async set() { throw fail('credential_mutation_forbidden') }
    async unset() { throw fail('credential_mutation_forbidden') }
  }
  const credentials = new SelectedReadOnlyCredential(ctx)
  // Use the real official wire adapter, but not its mutable settings overlay:
  // an isolated settings update cannot pair this key with another endpoint.
  ctx.llm.registerAdapter([OFFICIAL], new DeepSeekAdapter({
    options: () => VISION_CONNECTION,
    resolveApiKey: async () => (await credentials.resolve(REF)).value,
    resolveUserId: () => budgetConfig.runId,
  }))
  const budget = createBudgetGate(budgetConfig, { retryPolicy: provider => ctx.llm.providerRetryPolicy(provider) })
  const contexts = new AsyncLocalStorage()
  const assertReady = async () => {
    const current = ownedRoot(root)
    if (current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) throw fail('acceptance_root_replaced')
    return budget.snapshot()
  }
  // Reuse the existing immutable denied records too. The deliberately denied
  // purpose never reaches an adapter; no request/messages/secret are persisted.
  const deny = async (code, permit = contexts.getStore()) => {
    if (permit) permit.violation ??= code
    try {
      for await (const _chunk of budget.stream({ provider: OFFICIAL, model: MODEL, sessionId,
        purpose: 'vision-policy-denied', maxTokens: MAX_OUTPUT_TOKENS }, () => { throw fail('unreachable_dispatch') })) { /* Closed. */ }
    } catch (error) {
      if (error?.code !== 'route_not_allowed') throw error
      throw fail(code)
    }
    throw fail('unreachable_dispatch')
  }
  const retryZero = () => [WRAPPER, OFFICIAL].every(provider => {
    try { const p = ctx.llm.providerRetryPolicy(provider); return p?.mode === 'normal' && p.maxRetries === 0 } catch { return false }
  })
  const validRoute = options => options.model === MODEL && options.sessionId === sessionId
    && options.purpose === undefined && (options.reasoningEffort === undefined || options.reasoningEffort === 'off')
  const validate = async options => {
    if (!plainData(options)) return deny('invalid_request_object')
    try { Object.freeze(options) } catch { return deny('invalid_request_object') }
    if (!validRoute(options)) return deny('route_not_allowed')
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > MAX_OUTPUT_TOKENS) return deny('invalid_output_cap')
    if (!retryZero()) return deny('retry_policy_not_zero')
    if (options.signal?.aborted) return deny('already_aborted')
  }

  async function* stream(options, next) {
    const state = await assertReady()
    await validate(options)
    const inherited = contexts.getStore()
    if (options.provider === OFFICIAL) {
      const permit = inherited
      if (!permit?.active || permit.consumed || permit.violation
        || permit.sessionId !== options.sessionId || permit.maxTokens !== options.maxTokens
        || permit.signal !== options.signal) return await deny('missing_or_consumed_causal_permit', permit)
      // Consume synchronously before any disk await: two concurrent nested
      // streams cannot both reserve, even when their session ids are equal.
      permit.consumed = true
      try {
        for await (const chunk of budget.stream(options, next)) {
          if (!permit.active || permit.violation) return await deny('causal_permit_revoked', permit)
          permit.chunk = chunk
          yield chunk
        }
        permit.upstreamClosed = true
      } catch (error) { permit.violation ??= 'upstream_failed'; throw error }
      return
    }
    if (options.provider !== WRAPPER || inherited) return await deny('route_not_allowed', inherited)
    if (state.remainingRequests === 0) return await deny('budget_exhausted')
    const permit = { active: true, consumed: false, sessionId, maxTokens: options.maxTokens,
      signal: options.signal, upstreamClosed: false, chunk: undefined, violation: undefined }
    let iterator, completed = false
    try {
      iterator = contexts.run(permit, () => next()[Symbol.asyncIterator]())
      while (true) {
        // Creating an async generator inside run() is insufficient. The real
        // adapter work and awaited image conversion happen in iterator.next().
        const item = await contexts.run(permit, () => iterator.next())
        if (permit.violation) throw fail(permit.violation)
        if (item.done) {
          completed = true
          if (!permit.consumed || !permit.upstreamClosed || permit.chunk !== undefined) return await deny('wrapper_without_completed_upstream', permit)
          return
        }
        // The pinned wrapper is a transparent yield*. It may not replace an
        // upstream failure, invent success, duplicate chunks or use a fallback.
        if (permit.chunk === undefined || item.value !== permit.chunk) return await deny('wrapper_changed_upstream_output', permit)
        permit.chunk = undefined
        try { yield item.value } catch (error) {
          permit.active = false
          if (iterator.throw) await contexts.run(permit, () => iterator.throw(error))
          throw error
        }
      }
    } finally {
      permit.active = false
      if (!completed && iterator?.return) await contexts.run(permit, () => iterator.return())
    }
  }
  async function requestConfig(agent, next) {
    await assertReady()
    const proposal = await next()
    if (!plainData(proposal)) return deny('invalid_request_object')
    if (proposal.provider !== WRAPPER || !validRoute({ ...proposal, sessionId: agent?.session?.id })) return deny('route_not_allowed')
    if (!retryZero()) return deny('retry_policy_not_zero')
    if (proposal.maxTokens !== undefined && (!Number.isSafeInteger(proposal.maxTokens) || proposal.maxTokens < 1)) return deny('invalid_output_cap')
    return { ...proposal, maxTokens: Math.min(proposal.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS), reasoningEffort: 'off' }
  }
  // These rejecting hooks remain installed if asynchronous ledger mounting
  // fails. Wrapper registration may follow mounting; it is checked at dispatch.
  ctx.on('llm/stream', (options, next) => stream(options, next), { global: true, prepend: true })
  ctx.on('agent/request', ({ agent }, next) => requestConfig(agent, next), { global: true, prepend: true })
  return Object.freeze({ ready: budget.ready, snapshot: assertReady })
}

export function apply(ctx, config) { installVisionBudget(ctx, config) }
