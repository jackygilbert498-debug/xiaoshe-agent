import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'

async function read(relativeUrl: string): Promise<string> {
  return await readFile(new URL(relativeUrl, import.meta.url), 'utf8')
}

function pluginRow(source: string, id: string): string {
  const marker = `- id: ${id}`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing ${id} row`)
  const lineStart = source.lastIndexOf('\n', start) + 1
  const indentation = source.slice(lineStart, start)
  const next = source.indexOf(`\n${indentation}- id: `, start + marker.length)
  return source.slice(start, next === -1 ? source.length : next)
}

test('shipping compositions mount the hardened provider before exposing web_fetch', async () => {
  const basePatch = await read('../../../bundle/base/cordis.patch.yml')
  const provider = pluginRow(basePatch, 'web-fetch-http')
  const baseTool = pluginRow(basePatch, 'tool-web')
  assert.match(provider, /name: '@deepseek-ai\/dsh-web-fetch-http'/)
  assert.ok(basePatch.indexOf('- id: web-fetch-http') < basePatch.indexOf('- id: tool-web'))
  assert.match(baseTool, /fetch: true/)

  const basePackage = JSON.parse(await read('../../../bundle/base/package.json')) as {
    dependencies?: Record<string, string>
  }
  assert.equal(basePackage.dependencies?.['@deepseek-ai/dsh-web-fetch-http'], 'workspace:^')

  for (const preset of ['standard', 'ptc', 'cordis']) {
    const source = await read(`../../../preset/agent-presets/presets/${preset}/agent.cordis.yml`)
    assert.match(pluginRow(source, 'tool-web'), /fetch: true/, `${preset} must expose web_fetch`)
  }
})
