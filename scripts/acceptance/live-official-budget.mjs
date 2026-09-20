/** Isolated paid fixture only; never mount alongside the normal DeepSeek row. */
import { isAbsolute } from 'node:path'
import { apply as applyOfficial } from '../../runtime/DSH/packages/llm/llm-deepseek/lib/index.js'
import { installBudgetGate, MAX_REQUESTS, MAX_OUTPUT_TOKENS } from './live-request-budget.mjs'

export const name = 'xiaoshe-acceptance-live-official-budget'
export const inject = ['llm']

// These connection facts are not Profile inputs. Credentials are resolved by
// the real adapter at dispatch through its ordinary DEEPSEEK_API_KEY seam.
export const OFFICIAL_ADAPTER_CONFIG = Object.freeze({
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com',
  thinking: 'disabled',
  reasoningEffort: 'off',
  maxTokens: MAX_OUTPUT_TOKENS,
  streamIdleTimeoutMs: 60_000,
  retryPolicy: Object.freeze({ mode: 'normal', maxRetries: 0 }),
  models: Object.freeze([Object.freeze({ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash',
    contextWindow: 1_000_000, maxTokens: MAX_OUTPUT_TOKENS, inputModalities: Object.freeze(['text']) })]),
})

function budgetConfig(config) {
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/u.test(value)
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).sort().join(',') !== 'ledgerDirectory,maxRequests,model,provider,runId,sessionIds'
    || !isAbsolute(config.ledgerDirectory ?? '') || !id(config.runId) || ![8, MAX_REQUESTS].includes(config.maxRequests)
    || config.provider !== 'deepseek-official' || config.model !== 'deepseek-v4-flash'
    || !Array.isArray(config.sessionIds) || config.sessionIds.length === 0 || !config.sessionIds.every(id)
    || new Set(config.sessionIds).size !== config.sessionIds.length) {
    throw new Error('official-live-budget: invalid fixed-route budget configuration')
  }
  return Object.freeze({ ...config, sessionIds: Object.freeze([...config.sessionIds]) })
}

/**
 * Both effects belong to this same Cordis fiber. Official apply registers the
 * adapter synchronously, before the guard's asynchronous ledger initialization
 * can inspect its retry policy. Patch ordering alone does not establish that.
 */
export function installOfficialBudget(ctx, config) {
  const budget = budgetConfig(config)
  applyOfficial(ctx, OFFICIAL_ADAPTER_CONFIG)
  return installBudgetGate(ctx, budget)
}

export function apply(ctx, config) { installOfficialBudget(ctx, config) }
