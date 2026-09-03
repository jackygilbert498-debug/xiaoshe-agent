import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('coding workbench Client artifact registers through the DSH ModuleLoader', async () => {
  const artifact = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(artifact, /window\.__ModuleLoader__\.load\(\{/u)
  assert.match(artifact, /id:\s*['"]@xiaoshe\/coding-workbench['"]/u)
  assert.doesNotMatch(artifact, /^export\s/mu)
})
