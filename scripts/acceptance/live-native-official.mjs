/** Paid native acceptance only. Resolve one read-only key through the real seam;
 * never put a secret in launchctl arguments, an isolated Profile or reports. */
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CredentialProvider } from '../../runtime/DSH/packages/credentials/credentials/lib/index.js'
import { apply as applyOfficial } from '../../runtime/DSH/packages/llm/llm-deepseek/lib/index.js'
import { installBudgetGate, MAX_MATERIAL_REQUESTS } from './live-request-budget.mjs'
import { OFFICIAL_ADAPTER_CONFIG } from './live-official-budget.mjs'
import { selectedCredential } from './same-session-files-live.mjs'

export const name = 'xiaoshe-acceptance-native-official'
export const inject = ['llm']
const REF = 'DEEPSEEK_API_KEY'
const KEY_FILE = '/Users/zfy/.dsh/.credentials.yaml'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

export function nativeOfficialConfig(config) {
  if (!config || Object.keys(config).sort().join(',') !== 'acceptanceRoot,runId,sessionId'
    || !UUID.test(config.runId ?? '') || !['material', 'batch'].some(kind => config.sessionId === `xiaoshe-${kind}-${config.runId}`)
    || typeof config.acceptanceRoot !== 'string'
    || basename(config.acceptanceRoot) !== `xiaoshe-product-acceptance-${config.runId}`
    || dirname(config.acceptanceRoot) !== realpathSync(tmpdir())) throw new Error('native-official: invalid isolated identity')
  const root = config.acceptanceRoot, stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('native-official: unsafe acceptance root')
  return { ledgerDirectory: join(root, 'budget'), runId: config.runId, maxRequests: MAX_MATERIAL_REQUESTS,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', sessionIds: [config.sessionId] }
}

export function installNativeOfficial(ctx, config, { readCredential = () => selectedCredential(KEY_FILE) } = {}) {
  const budget = nativeOfficialConfig(config)
  if (ctx.get('credentials') !== undefined) throw new Error('native-official: another credential provider is mounted')
  class SelectedReadOnlyCredential extends CredentialProvider {
    async resolve(ref) {
      if (ref !== REF) return undefined
      // Re-resolve through the existing strict O_NOFOLLOW/owner/mode parser.
      // This trusted seam alone can read the exact authorized key file; the
      // agent's file guard independently denies reads outside synthetic input.
      try { return { value: await readCredential(), source: 'acceptance-selected-read-only' } }
      catch { throw new Error('native-official: selected credential unavailable') }
    }
    async describe(ref) {
      if (ref !== REF) return { configured: false, writable: false }
      const resolved = await this.resolve(ref).catch(() => undefined)
      return { configured: resolved !== undefined, writable: false,
        ...(resolved ? { source: resolved.source } : {}) }
    }
    async set() { throw new Error('native-official: credential mutation forbidden') }
    async unset() { throw new Error('native-official: credential mutation forbidden') }
  }
  new SelectedReadOnlyCredential(ctx)
  applyOfficial(ctx, OFFICIAL_ADAPTER_CONFIG)
  return installBudgetGate(ctx, budget)
}

export function apply(ctx, config) { installNativeOfficial(ctx, config) }
