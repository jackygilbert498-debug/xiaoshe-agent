import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPluginGovernanceHttpRoutes, type PluginWebServer } from '../src/http.js'
import type { ResolvedCandidate } from '../src/audit.js'
import type { PluginTransaction } from '../src/store.js'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

describe('plugin governance Host API', () => {
  it('guards origin/content type/unknown fields and exposes no persisted token hash', async () => {
    const service = fixtureService()
    const url = await listen(service)
    const cross = await fetch(`${url}/api/xiaoshe/plugins/transactions`, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })
    expect(cross.status).toBe(403)
    const media = await fetch(`${url}/api/xiaoshe/plugins/audit`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    expect(media.status).toBe(415)
    const unknown = await post(url, '/api/xiaoshe/plugins/audit', { source: { kind: 'registry', spec: '@x/demo' }, surprise: true })
    expect(unknown.status).toBe(400)
    const transactions = await fetch(`${url}/api/xiaoshe/plugins/transactions`).then(response => response.json()) as Record<string, unknown>
    expect(JSON.stringify(transactions)).not.toContain('tokenSha256')
    expect(JSON.stringify(transactions)).not.toContain('raw-secret')
  })

  it('audits before prepare, returns one-shot consent, then returns a redacted transaction', async () => {
    const service = fixtureService()
    const url = await listen(service)
    const auditResponse = await post(url, '/api/xiaoshe/plugins/audit', { source: { kind: 'registry', spec: '@x/demo@1.0.0' } })
    const audit = await auditResponse.json() as { candidate: Record<string, unknown> }
    expect(auditResponse.status).toBe(200)
    expect(audit.candidate).toMatchObject({
      id: 'candidate-1', packageName: '@x/demo', osSandboxEnforced: false,
      identity: { displayName: '演示插件', developer: 'Example Studio' },
      provenance: { selection: 'exact-version', assurance: 'unverified' },
    })
    expect(audit.candidate.tarballPath).toBeUndefined()
    expect(JSON.stringify(audit.candidate)).not.toMatch(/C:\/private|password|token=secret/iu)
    const prepare = await post(url, '/api/xiaoshe/plugins/prepare', { action: 'add', profile: 'xiaoshe-managed-proof', candidateId: 'candidate-1' })
    expect(await prepare.json()).toMatchObject({ challenge: { id: 'challenge-1', token: 'raw-secret', osSandboxEnforced: false } })
    const confirm = await post(url, '/api/xiaoshe/plugins/confirm', { challengeId: 'challenge-1', token: 'raw-secret' })
    const receipt = await confirm.json()
    expect(receipt).toMatchObject({ transaction: { id: 'tx-1', state: 'healthy', consent: { confirmed: true }, osSandboxEnforced: false } })
    expect(JSON.stringify(receipt)).not.toContain('tokenSha256')
    expect(service.confirm).toHaveBeenCalledWith({ challengeId: 'challenge-1', token: 'raw-secret' })
  })
})

function fixtureService() {
  const candidate: ResolvedCandidate = {
    id: 'candidate-1', packageName: '@x/demo', version: '1.0.0', tarballPath: 'C:/private/demo.tgz', sha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
    identity: { displayName: '演示插件', description: '用于验证公共候选', developer: 'Example Studio', keywords: [] },
    provenance: { kind: 'registry', selection: 'exact-version', label: '软件源 @x/demo@1.0.0', assurance: 'unverified' },
    audit: { valid: true, packageName: '@x/demo', version: '1.0.0', scope: 'profile-bundle', installScripts: [], scriptCommands: [], dependencies: [], runtimeSignals: [], requestedServices: [], risk: 'high', osSandboxEnforced: false, findings: [] },
  }
  const transaction: PluginTransaction = {
    id: 'tx-1', action: 'add', profile: 'xiaoshe-managed-proof', packageName: '@x/demo', version: '1.0.0', candidateSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), state: 'healthy', createdAt: 1, updatedAt: 2,
    consent: { challengeId: 'challenge-1', tokenSha256: 'c'.repeat(64), expiresAt: 3, confirmedAt: 2 }, disclosures: [], events: [],
  }
  return {
    audit: vi.fn(async () => candidate), candidate: vi.fn(() => candidate),
    prepare: vi.fn(async () => ({ id: 'challenge-1', token: 'raw-secret', expiresAt: new Date(3).toISOString(), action: 'add' as const, profile: 'xiaoshe-managed-proof', packageName: '@x/demo', version: '1.0.0', candidateSha256: candidate.sha256, manifestSha256: candidate.manifestSha256, disclosures: [], osSandboxEnforced: false as const })),
    confirm: vi.fn(async () => transaction), listTransactions: vi.fn(() => [transaction]),
  }
}

async function listen(service: ReturnType<typeof fixtureService>): Promise<string> {
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
  const webServer: PluginWebServer = { register(route) { routes.set(route.path, route.handler as never); return () => { routes.delete(route.path) } } }
  registerPluginGovernanceHttpRoutes(webServer, service)
  const server = createServer((request, response) => {
    const handler = routes.get(new URL(request.url ?? '/', 'http://localhost').pathname)
    if (handler === undefined) { response.writeHead(404).end(); return }
    void handler(request, response)
  })
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing server address')
  return `http://127.0.0.1:${address.port}`
}
function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
