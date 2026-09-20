import test from 'node:test'
import assert from 'node:assert/strict'
import { createVerificationPolicy } from '../lib/index.js'

test('only the first-party pure JS snapshot probe is read-only, without reducing code gates', () => {
  const policy = createVerificationPolicy()
  const args = { module: 'src/pure.mjs', exportName: 'sum', cases: [{ args: [1, 2], expect: 3 }] }
  assert.deepEqual(policy.classifyTool({ toolName: 'pure_js_probe', arguments: args }), { mutation: false })
  assert.deepEqual(policy.classifyTool({ toolName: 'mcp__remote__pure_js_probe', arguments: args }), { mutation: true })
  assert.deepEqual(policy.classifyTool({ toolName: 'pwsh', arguments: { command: 'node --input-type=module -e "console.log(3)"' } }), { mutation: true })
  assert.deepEqual(policy.plan({ kind: 'code', risk: 'medium' }).gates, ['typecheck', 'test', 'build'])
})
