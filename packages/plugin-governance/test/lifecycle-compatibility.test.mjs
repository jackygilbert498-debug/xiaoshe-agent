import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  PluginCompatibilityError,
  PluginLifecycleService,
  PluginTransactionStore,
} from '../lib/index.js'

const EMPTY_POLICY = Object.freeze({
  capabilities: Object.freeze([]), permissions: Object.freeze([]), unknownPermissions: Object.freeze([]),
  isolation: 'shared-host', conflicts: Object.freeze([]), engines: Object.freeze({}),
})

test('lifecycle blocks an invalid signature before any profile mutation', async t => {
  const fixture = await createFixture(t, { signatureStatus: 'invalid' })
  const service = fixture.service()

  await assert.rejects(
    service.prepare({ action: 'add', profile: 'xiaoshe-managed-test', candidate: fixture.candidate }),
    error => error instanceof PluginCompatibilityError
      && error.report.status === 'blocked'
      && error.report.blockers.some(row => row.includes('签名无效')),
  )
  assert.equal(fixture.calls.add, 0)
  assert.equal(service.listTransactions().length, 0)
})

test('lifecycle exposes unsigned warnings and completes a graph-verified install', async t => {
  const fixture = await createFixture(t, { signatureStatus: 'unsigned', installVisibleAfterMutation: true })
  const service = fixture.service()
  const challenge = await service.prepare({ action: 'add', profile: 'xiaoshe-managed-test', candidate: fixture.candidate })

  assert.equal(challenge.compatibility?.status, 'warning')
  assert.ok(challenge.compatibility?.warnings.some(row => row.includes('未签名')))
  const receipt = await service.confirm({ challengeId: challenge.id, token: challenge.token })

  assert.equal(receipt.state, 'healthy')
  assert.equal(fixture.calls.add, 1)
  assert.equal(fixture.calls.remove, 0)
})

test('lifecycle rolls back when the post-mutation profile graph omits the package', async t => {
  const fixture = await createFixture(t, { signatureStatus: 'trusted', installVisibleAfterMutation: false })
  const service = fixture.service()
  const challenge = await service.prepare({ action: 'add', profile: 'xiaoshe-managed-test', candidate: fixture.candidate })
  const receipt = await service.confirm({ challengeId: challenge.id, token: challenge.token })

  assert.equal(receipt.state, 'rolled-back')
  assert.equal(receipt.rollback?.attempted, true)
  assert.equal(receipt.rollback?.succeeded, true)
  assert.equal(fixture.calls.add, 1)
  assert.equal(fixture.calls.remove, 1)
  assert.ok(receipt.events.some(row => row.kind === 'rollback'))
})

async function createFixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-plugin-lifecycle-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const tarballPath = join(root, 'candidate.tgz')
  const bytes = Buffer.from('immutable test plugin bytes')
  await writeFile(tarballPath, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const calls = { add: 0, remove: 0 }
  let installed = false
  const inspect = () => Object.freeze({
    profile: 'xiaoshe-managed-test', exists: true,
    dependencies: installed ? Object.freeze({ '@xiaoshe/example': '1.2.3' }) : Object.freeze({}),
    bundles: Object.freeze([]), manifestSha256: 'a'.repeat(64),
  })
  const processReceipt = operation => Object.freeze({
    operation, profile: 'xiaoshe-managed-test', argv: Object.freeze([]),
    result: Object.freeze({ exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, stdoutBytes: 0, stderrBytes: 0 }),
  })
  const manager = {
    async inspect() { return inspect() },
    async bootstrap() { return processReceipt('bootstrap') },
    async add() {
      calls.add += 1
      installed = options.installVisibleAfterMutation === true
      return processReceipt('add')
    },
    async update() { return processReceipt('update') },
    async remove() { calls.remove += 1; installed = false; return processReceipt('remove') },
    async dump() { return '{}' },
  }
  const health = {
    async verify(input) {
      return Object.freeze({
        state: 'healthy',
        gates: Object.freeze([{ gate: 'profile-dump', ok: true, detail: `expected ${input.expected}` }]),
      })
    },
  }
  const signature = Object.freeze({
    status: options.signatureStatus,
    reason: options.signatureStatus === 'invalid' ? 'signature did not verify' : options.signatureStatus,
    ...(options.signatureStatus === 'trusted' ? { fingerprint: 'b'.repeat(64), keyId: 'test' } : {}),
  })
  const candidate = Object.freeze({
    id: 'candidate-1', packageName: '@xiaoshe/example', version: '1.2.3', tarballPath, sha256,
    manifestSha256: 'c'.repeat(64),
    identity: Object.freeze({ displayName: 'Example', keywords: Object.freeze([]) }),
    provenance: Object.freeze({
      kind: 'local-tarball', selection: 'local-bytes', label: '本地安装包 candidate.tgz',
      assurance: options.signatureStatus === 'trusted' ? 'verified-publisher' : options.signatureStatus === 'invalid' ? 'invalid-signature' : 'unverified',
    }),
    signature,
    audit: Object.freeze({
      valid: true, packageName: '@xiaoshe/example', version: '1.2.3', scope: 'profile-bundle',
      installScripts: Object.freeze([]), scriptCommands: Object.freeze([]), dependencies: Object.freeze([]),
      dependencyRequirements: Object.freeze({}), peerRequirements: Object.freeze({}), policy: EMPTY_POLICY,
      runtimeSignals: Object.freeze([]), requestedServices: Object.freeze([]), risk: 'medium',
      osSandboxEnforced: false, findings: Object.freeze([]),
    }),
  })
  return {
    candidate, calls,
    service: () => new PluginLifecycleService({
      store: new PluginTransactionStore(join(root, 'transactions.json')),
      candidateResolver: { async resolve() { return candidate } }, profileManager: manager, healthChecker: health,
      activeProfile: 'product', tokenFactory: () => 'test-confirmation-token-00000001', now: () => 1_800_000_000_000,
    }),
  }
}
