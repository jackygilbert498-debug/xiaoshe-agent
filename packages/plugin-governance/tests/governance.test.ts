import { describe, expect, it, vi } from 'vitest'
import { PluginGovernanceProvider } from '../src/client/index.js'

const inventory = { list: async () => ({ ok: true as const, value: { entries: [{ entryId: 'p1', moduleName: '@x/p', enabled: true, fiberPhase: 'active' as const }] } }) }

describe('plugin governance Client', () => {
  it('uses authoritative Host inventory and labels trust as a separate fact', async () => {
    const provider = new PluginGovernanceProvider(inventory, vi.fn())
    await expect(provider.listHostPlugins()).resolves.toEqual({
      ok: true,
      value: { entries: [{ entryId: 'p1', moduleName: '@x/p', enabled: true, fiberPhase: 'active', trust: 'trusted-host-code', osSandboxEnforced: false }] },
    })
    expect('planProfileChange' in provider).toBe(false)
    expect('command' in provider).toBe(false)
  })

  it('delegates audit/prepare/confirm to same-origin Host endpoints without exposing an executor', async () => {
    const calls: { input: string; init?: RequestInit }[] = []
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) })
      if (input.endsWith('/audit')) return json({ candidate: { id: 'candidate-1', packageName: '@x/demo', version: '1.0.0', sha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), audit: {}, osSandboxEnforced: false } })
      if (input.endsWith('/prepare')) return json({ challenge: { id: 'challenge-1', token: 'one-shot' } })
      return json({ transaction: { id: 'tx-1', action: 'add', profile: 'xiaoshe-managed-proof', packageName: '@x/demo', version: '1.0.0', state: 'healthy', consent: { confirmed: true, expiresAt: 1 }, osSandboxEnforced: false } })
    })
    const provider = new PluginGovernanceProvider(inventory, fetcher)
    await expect(provider.auditCandidate({ kind: 'registry', spec: '@x/demo@1.0.0' })).resolves.toMatchObject({ ok: true, value: { candidate: { id: 'candidate-1' } } })
    await expect(provider.prepareChange({ action: 'add', profile: 'xiaoshe-managed-proof', candidateId: 'candidate-1' })).resolves.toMatchObject({ ok: true, value: { challenge: { token: 'one-shot' } } })
    await expect(provider.confirmChange({ challengeId: 'challenge-1', token: 'one-shot' })).resolves.toMatchObject({ ok: true, value: { transaction: { state: 'healthy' } } })
    expect(calls.map(call => call.input)).toEqual(['/api/xiaoshe/plugins/audit', '/api/xiaoshe/plugins/prepare', '/api/xiaoshe/plugins/confirm'])
    expect(calls.every(call => call.init?.method === 'POST' && call.init.headers !== undefined)).toBe(true)
    expect(provider.getSnapshot()).toMatchObject({ status: 'ready', transactions: [{ state: 'healthy' }] })
    expect(Object.isFrozen(provider.getSnapshot())).toBe(true)
  })

  it('aborts in-flight work on disposal and does not notify disposed listeners', async () => {
    let observedSignal: AbortSignal | undefined
    const fetcher = vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal as AbortSignal
      observedSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const provider = new PluginGovernanceProvider(inventory, fetcher)
    const listener = vi.fn(); provider.subscribe(listener)
    const pending = provider.refreshTransactions()
    provider.dispose()
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'ABORTED' } })
    expect(observedSignal?.aborted).toBe(true)
    expect(provider.getSnapshot().status).toBe('disposed')
    const callsAfterSettlement = listener.mock.calls.length
    await expect(provider.refreshTransactions()).resolves.toMatchObject({ ok: false, error: { code: 'DISPOSED' } })
    expect(listener).toHaveBeenCalledTimes(callsAfterSettlement)
  })
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
