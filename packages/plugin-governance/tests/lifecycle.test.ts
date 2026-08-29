import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResolvedCandidate } from '../src/audit.js'
import { PluginLifecycleService } from '../src/lifecycle.js'
import { PluginTransactionStore } from '../src/store.js'
import type { HealthCheckInput, HealthResult, ProfileHealthCheckerLike } from '../src/health.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('confirmation-gated plugin lifecycle', () => {
  it('binds every consent fact, expires in ten minutes and consumes the token once', async () => {
    const harness = await setup()
    const challenge = await harness.service.prepare({ action: 'add', profile: 'xiaoshe-managed-proof', candidate: harness.candidate })
    expect(challenge).toMatchObject({
      action: 'add', profile: 'xiaoshe-managed-proof', packageName: '@xiaoshe/fixture', version: '1.0.0',
      candidateSha256: harness.candidate.sha256, manifestSha256: harness.candidate.manifestSha256,
      identity: harness.candidate.identity, provenance: harness.candidate.provenance,
      expiresAt: new Date(harness.clock.value + 600_000).toISOString(), osSandboxEnforced: false,
    })
    const completed = await harness.service.confirm({ challengeId: challenge.id, token: challenge.token })
    expect(completed.state).toBe('healthy')
    await expect(harness.service.confirm({ challengeId: challenge.id, token: challenge.token })).rejects.toThrow(/already consumed|unknown challenge/iu)
    expect(JSON.stringify(harness.service.listTransactions())).not.toContain(challenge.token)

    const expiring = await harness.service.prepare({ action: 'remove', profile: 'xiaoshe-managed-proof', packageName: '@xiaoshe/fixture', version: '1.0.0' })
    expect(expiring.disclosures.join('\n')).toContain('Host 进程内运行')
    expect(expiring.disclosures.join('\n')).toContain('系统沙箱未启用')
    expect(expiring.disclosures.join('\n')).not.toContain('受信任')
    harness.clock.value += 600_001
    await expect(harness.service.confirm({ challengeId: expiring.id, token: expiring.token })).rejects.toThrow(/expired/iu)
  })

  it('rejects unmanaged and active Profiles before issuing consent', async () => {
    const harness = await setup()
    await expect(harness.service.prepare({ action: 'add', profile: 'ordinary', candidate: harness.candidate })).rejects.toThrow(/managed profile/iu)
    await expect(harness.service.prepare({ action: 'add', profile: 'xiaoshe-managed-active', candidate: harness.candidate })).rejects.toThrow(/active profile/iu)
  })

  it('re-hashes the candidate at confirmation and rejects changed bytes', async () => {
    const harness = await setup()
    const challenge = await harness.service.prepare({ action: 'add', profile: 'xiaoshe-managed-proof', candidate: harness.candidate })
    await writeFile(harness.candidate.tarballPath, 'changed')
    await expect(harness.service.confirm({ challengeId: challenge.id, token: challenge.token })).rejects.toThrow(/candidate.*changed/iu)
    expect(harness.calls).toEqual([])
  })

  it('invalidates prepared challenges after a process restart while retaining receipts', async () => {
    const harness = await setup()
    const challenge = await harness.service.prepare({ action: 'add', profile: 'xiaoshe-managed-proof', candidate: harness.candidate })
    const restarted = new PluginLifecycleService({
      store: harness.store, activeProfile: 'xiaoshe-managed-active', now: () => harness.clock.value,
      candidateResolver: { resolve: async () => harness.candidate }, profileManager: harness.profileManager,
      healthChecker: harness.healthChecker,
    })
    await expect(restarted.confirm({ challengeId: challenge.id, token: challenge.token })).rejects.toThrow(/unknown challenge|restart/iu)
    expect(restarted.listTransactions()).toHaveLength(1)
  })

  it('excludes concurrent mutation of one Profile', async () => {
    const harness = await setup()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    harness.profileManager.add = async () => { await gate; return harness.receipt }
    const first = await harness.service.prepare({ action: 'add', profile: 'xiaoshe-managed-proof', candidate: harness.candidate })
    const second = await harness.service.prepare({ action: 'add', profile: 'xiaoshe-managed-proof', candidate: harness.candidate })
    const running = harness.service.confirm({ challengeId: first.id, token: first.token })
    await Promise.resolve()
    await expect(harness.service.confirm({ challengeId: second.id, token: second.token })).rejects.toThrow(/transaction.*running/iu)
    release()
    await running
  })

  it('runs the exact inverse and reports rolled-back only after baseline health recovers', async () => {
    const harness = await setup()
    harness.healthChecker.verify = async (input: HealthCheckInput): Promise<HealthResult> => input.candidateHealthPath === '/api/xiaoshe/fixture-health'
      ? { state: 'failed', gates: [{ gate: 'functional-probe', ok: false, detail: 'HTTP 500' }] }
      : { state: 'healthy', gates: [{ gate: 'profile-start', ok: true, detail: 'ready' }] }
    const challenge = await harness.service.prepare({ action: 'add', profile: 'xiaoshe-managed-proof', candidate: harness.candidate })
    const result = await harness.service.confirm({ challengeId: challenge.id, token: challenge.token })
    expect(result.state).toBe('rolled-back')
    expect(harness.calls).toEqual(['add:@xiaoshe/fixture', 'remove:@xiaoshe/fixture'])
    expect(result.rollback).toMatchObject({ attempted: true, succeeded: true, residuals: [] })
  })

  it('records rollback-failed and residual details when the inverse operation fails', async () => {
    const harness = await setup()
    harness.healthChecker.verify = async (): Promise<HealthResult> => ({ state: 'failed', gates: [{ gate: 'profile-start', ok: false, detail: 'controlled boot crash' }] })
    harness.profileManager.remove = async () => { throw new Error('controlled inverse failure') }
    const challenge = await harness.service.prepare({ action: 'add', profile: 'xiaoshe-managed-proof', candidate: harness.candidate })
    const result = await harness.service.confirm({ challengeId: challenge.id, token: challenge.token })
    expect(result.state).toBe('rollback-failed')
    expect(result.rollback).toMatchObject({ attempted: true, succeeded: false, residuals: [expect.stringContaining('controlled inverse failure')] })
  })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-plugin-lifecycle-'))
  roots.push(root)
  const tarballPath = join(root, 'fixture.tgz')
  const bytes = Buffer.from('fixture-tarball')
  await writeFile(tarballPath, bytes)
  const candidate: ResolvedCandidate = {
    id: 'candidate-fixture', packageName: '@xiaoshe/fixture', version: '1.0.0', tarballPath,
    sha256: createHash('sha256').update(bytes).digest('hex'), manifestSha256: 'b'.repeat(64),
    identity: { displayName: '验证插件', description: '验证一次性确认', developer: 'Xiaoshe', license: 'MIT', keywords: [] },
    provenance: { kind: 'local-tarball', selection: 'local-bytes', label: '本地安装包 fixture.tgz', assurance: 'unverified' },
    audit: {
      valid: true, packageName: '@xiaoshe/fixture', version: '1.0.0', scope: 'profile-bundle', installScripts: [],
      scriptCommands: [], dependencies: [], runtimeSignals: [], requestedServices: [], risk: 'high',
      osSandboxEnforced: false, findings: ['Host Bundle 进程内运行'],
    },
    healthPath: '/api/xiaoshe/fixture-health',
  }
  const calls: string[] = []
  const dependencies: Record<string, string> = {}
  const receipt = { operation: 'add' as const, profile: 'xiaoshe-managed-proof', argv: [], result: { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, stdoutBytes: 0, stderrBytes: 0 } }
  const profileManager = {
    inspect: async () => ({ profile: 'xiaoshe-managed-proof', exists: true, dependencies: { ...dependencies }, bundles: [], manifestSha256: 'd'.repeat(64) }),
    bootstrap: async () => receipt,
    add: async (_profile: string, _path: string) => { calls.push('add:@xiaoshe/fixture'); dependencies['@xiaoshe/fixture'] = 'file:fixture.tgz'; return receipt },
    update: async () => receipt,
    remove: async (_profile: string, packageName: string) => { calls.push(`remove:${packageName}`); delete dependencies[packageName]; return { ...receipt, operation: 'remove' as const } },
    dump: async () => '@xiaoshe/fixture',
  }
  const healthChecker: ProfileHealthCheckerLike = { verify: async () => ({ state: 'healthy', gates: [{ gate: 'functional-probe', ok: true, detail: 'HTTP 200' }] }) }
  const store = new PluginTransactionStore(join(root, 'transactions.json'))
  const clock = { value: Date.UTC(2026, 7, 25, 0, 0, 0) }
  const service = new PluginLifecycleService({
    store, activeProfile: 'xiaoshe-managed-active', now: () => clock.value,
    tokenFactory: () => 'raw-secret-token-1234567890',
    candidateResolver: { resolve: async () => candidate }, profileManager, healthChecker,
    defaultHealthPath: '/api/xiaoshe/brand',
  })
  return { root, service, store, candidate, calls, profileManager, healthChecker, clock, receipt }
}
