import test from 'node:test'
import assert from 'node:assert/strict'
import { createVerificationPolicy } from '../lib/index.js'

test('official reminder mutations require independent functional proof, not project compilation', () => {
  const policy = createVerificationPolicy()
  for (const toolName of ['schedule_delete', 'schedule_create']) {
    const classified = policy.classifyTool({ toolName })
    assert.deepEqual(classified, { mutation: true, change: { kind: 'data', risk: 'low' } })
    const plan = policy.planTool({ toolName, ...classified.change })
    assert.deepEqual(plan.gates, ['functional-probe'])
    assert.equal(policy.evaluate(plan, []), 'partial')
  }
  assert.deepEqual(policy.classifyTool({ toolName: 'schedule_list' }), { mutation: false })
  assert.deepEqual(policy.classifyTool({ toolName: 'mcp__external__schedule_delete' }), { mutation: true, change: { kind: 'code', risk: 'medium' } })
  assert.deepEqual(policy.classifyTool({ toolName: 'edit', arguments: { file_path: 'src/schedule.ts' } }), { mutation: true, change: { kind: 'code', risk: 'medium' } })
})
