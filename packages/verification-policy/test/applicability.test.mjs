import test from 'node:test'
import assert from 'node:assert/strict'
import { createVerificationPolicy, verificationResultSatisfied } from '../lib/index.js'

test('N/A is evidenced disposition, not skipped or passed; live gates cannot be waived', () => {
  const policy = createVerificationPolicy()
  const plan = policy.plan({ kind: 'code' })
  const results = ['typecheck', 'build'].map(gate => ({ gate, status: 'not-applicable', evidence: 'applicability/v1;host-observed-context' }))
  assert.equal(policy.evaluate(plan, results), 'partial')
  assert.equal(policy.evaluate(plan, [...results, { gate: 'test', status: 'passed' }]), 'verified')
  assert.equal(policy.evaluate(plan, [...results, { gate: 'test', status: 'failed' }]), 'failed')
  for (const gate of ['build', 'typecheck']) {
    for (const status of ['skipped', 'not-run', 'blocked']) assert.equal(verificationResultSatisfied(gate, { gate, status }), false)
    assert.equal(verificationResultSatisfied(gate, { gate, status: 'not-applicable', evidence: 'model says no need' }), false)
  }
  for (const gate of ['functional-probe', 'browser', 'release-confirmation']) {
    assert.equal(verificationResultSatisfied(gate, { gate, status: 'not-applicable', evidence: 'applicability/v1;fake' }), false)
  }
})

test('artifact plans add independent readback without deleting compilation requirements', () => {
  const policy = createVerificationPolicy()
  for (const file_path of ['job.sh', 'agent.plist', 'README.md']) {
    assert.deepEqual(policy.planTool({ toolName: 'edit', arguments: { file_path }, kind: 'code' }).gates,
      file_path.endsWith('.md') ? ['typecheck', 'test', 'build', 'functional-probe'] : ['typecheck', 'test', 'build'])
  }
  assert.deepEqual(policy.planTool({ toolName: 'edit', arguments: { file_path: 'src/a.ts' }, kind: 'code' }).gates,
    ['typecheck', 'test', 'build'])
})

test('stderr discard and descriptor copying do not invent compilation debt', () => {
  const policy = createVerificationPolicy()
  for (const command of ['bash -n job.sh 2>/dev/null', 'plutil -lint agent.plist 2>&1', 'grep -n value README.md 2>/dev/null | head -10']) {
    assert.equal(policy.classifyTool({ toolName: 'bash', arguments: { command } }).change, undefined)
  }
  assert.equal(policy.classifyTool({ toolName: 'bash', arguments: { command: 'echo changed > src/code.ts' } }).change.kind, 'code')
})
