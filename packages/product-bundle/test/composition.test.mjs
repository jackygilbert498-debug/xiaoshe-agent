import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const patchUrl = new URL('../cordis.patch.yml', import.meta.url)
const packageUrl = new URL('../package.json', import.meta.url)

test('experience read model is mounted independently before reliability consumers', async () => {
  const [patch, manifest] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(packageUrl, 'utf8').then(JSON.parse),
  ])
  const experience = patch.indexOf("name: '@xiaoshe/agent-experience'")
  const receipt = patch.indexOf("name: '@xiaoshe/completion-receipt'")
  const memory = patch.indexOf("name: '@xiaoshe/memory'")
  assert.ok(experience >= 0)
  assert.ok(receipt > experience)
  assert.ok(memory > experience)
  assert.equal(manifest.dependencies['@xiaoshe/agent-experience'], 'workspace:*')
})
