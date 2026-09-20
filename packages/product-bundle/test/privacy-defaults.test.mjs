import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const upstream = createRequire(new URL('../../../runtime/DSH/packages/boot/app-boot/package.json', import.meta.url))
const { applyEntryPatches } = await import(pathToFileURL(upstream.resolve('@deepseek-ai/cordis-plugin-include')).href)
const { parse } = upstream('yaml')
const readPatch = async url => parse(await readFile(url, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })

test('effective product defaults omit extra metadata/log fields while a later personal opt-in remains authoritative', async () => {
  const base = await readPatch(new URL('../../../runtime/DSH/packages/bundle/base/cordis.patch.yml', import.meta.url))
  const product = await readPatch(new URL('../cordis.patch.yml', import.meta.url))
  const entries = applyEntryPatches([], structuredClone([...base, ...product]), () => {})
  for (const id of ['plugin-package-inventory-deepseek', 'session-log-deepseek']) {
    assert.equal(entries.find(entry => entry.id === id)?.config?.enabled, false, `${id} public product default`)
    const opted = applyEntryPatches(structuredClone(entries), [{ id, config: { enabled: true } }], () => {})
    assert.equal(opted.find(entry => entry.id === id)?.config?.enabled, true, 'later explicit configuration is not overwritten')
  }
})
