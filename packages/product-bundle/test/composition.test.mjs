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

test('source knowledge is an independent optional package included in portable artifacts and startup', async () => {
  const [patch, manifest, shell] = await Promise.all([
    readFile(patchUrl, 'utf8'), readFile(packageUrl, 'utf8').then(JSON.parse),
    readFile(new URL('../../../scripts/start-xiaoshe-web.sh', import.meta.url), 'utf8'),
  ])
  const { PRODUCT_PACKAGES } = await import('../../../scripts/lib/relocatable-product-artifacts.mjs')
  assert.equal(manifest.dependencies['@xiaoshe/project-knowledge'], 'workspace:*')
  assert.match(patch, /id: xiaoshe-project-knowledge\s+name: '@xiaoshe\/project-knowledge'/u)
  assert.ok(PRODUCT_PACKAGES.some(item => item.name === '@xiaoshe/project-knowledge'))
  assert.match(shell, /@xiaoshe\/project-knowledge\|\$PLUGIN_ROOT\/packages\/project-knowledge/u)
  assert.match(shell, /"\$PLUGIN_ROOT\/packages\/project-knowledge"/u)
  for (const path of ['../../../启动小蛇.ps1', '../../../setup/install-windows.ps1', '../../../setup/install-macos.sh']) {
    assert.match(await readFile(new URL(path, import.meta.url), 'utf8'), /packages[\\/]project-knowledge/u)
  }
})
