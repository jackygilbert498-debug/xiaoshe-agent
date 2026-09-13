/** Fixed official adapter and ordinary read-only credential seam for this run. */
import { CredentialProvider } from '../../runtime/DSH/packages/credentials/credentials/lib/index.js'
import { apply as applyOfficial } from '../../runtime/DSH/packages/llm/llm-deepseek/lib/index.js'
import { installBudgetGate, MAX_MATERIAL_REQUESTS } from './live-request-budget.mjs'
import { OFFICIAL_ADAPTER_CONFIG } from './live-official-budget.mjs'
import { selectedCredential } from './same-session-files-live.mjs'
import { complexPolicy, complexSessionIds } from './complex-tool-policy.mjs'

export const name = 'xiaoshe-complex-official-budget'
export const inject = ['llm']
const REF = 'DEEPSEEK_API_KEY'

export function complexOfficialConfig(config) {
  if (!config || Object.keys(config).sort().join(',') !== 'acceptanceRoot,liveAuthorized,nodePath,npmPath,runId'
    || typeof config.liveAuthorized !== 'boolean') throw new Error('complex-official: invalid configuration')
  const { liveAuthorized, ...policyConfig } = config
  const policy = complexPolicy(policyConfig)
  return { ledgerDirectory: `${policy.acceptanceRoot}/budget`, runId: policy.runId,
    maxRequests: liveAuthorized ? MAX_MATERIAL_REQUESTS : 0,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', sessionIds: complexSessionIds(policy.runId) }
}

export function installComplexOfficial(ctx, config, { readCredential = () => selectedCredential('/Users/zfy/.dsh/.credentials.yaml') } = {}) {
  const budget = complexOfficialConfig(config)
  if (ctx.get('credentials') !== undefined) throw new Error('complex-official: unexpected credential provider')
  class SelectedReadOnlyCredential extends CredentialProvider {
    async resolve(ref) {
      // Preparation cannot even read the selected real key.
      if (!config.liveAuthorized || ref !== REF) return undefined
      try { return { value: await readCredential(), source: 'acceptance-selected-read-only' } }
      catch { throw new Error('complex-official: selected credential unavailable') }
    }
    async describe(ref) {
      const resolved = await this.resolve(ref).catch(() => undefined)
      return { configured: resolved !== undefined, writable: false,
        ...(resolved ? { source: resolved.source } : {}) }
    }
    async set() { throw new Error('complex-official: credential mutation forbidden') }
    async unset() { throw new Error('complex-official: credential mutation forbidden') }
  }
  new SelectedReadOnlyCredential(ctx)
  applyOfficial(ctx, OFFICIAL_ADAPTER_CONFIG)
  return installBudgetGate(ctx, budget)
}

export function apply(ctx, config) { installComplexOfficial(ctx, config) }
