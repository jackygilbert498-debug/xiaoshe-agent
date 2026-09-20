import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parse } from 'yaml'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

test('pure probe is an installed first-party capability, not a temporary test dependency', async () => {
  assert.equal(manifest.dependencies['quickjs-emscripten'], '0.32.0')
  assert.equal(manifest.exports['./pure-js-probe'], './dist/plugins/pure-js-probe.js')
  const lock = parse(await readFile(new URL('pnpm-lock.yaml', root), 'utf8'))
  assert.deepEqual(lock.importers['.'].dependencies['quickjs-emscripten'], {
    specifier: '0.32.0', version: '0.32.0',
  })
  assert.match(lock.packages['quickjs-emscripten@0.32.0'].resolution.integrity, /^sha512-/u)
  const patch = parse(await readFile(new URL('cordis.patch.yml', root), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  const rows = patch.flatMap(row => row.insert ?? []).filter(row => row.id === 'xiaoshe-pure-js-probe')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, '@xiaoshe/dsh-desktop-control/pure-js-probe')
  assert.ok(manifest.files.includes('dist'), 'compiled runner and Worker must travel with the package')
})

test('standard agent test entry includes real probe runner and DSH registration coverage', () => {
  assert.ok(manifest.scripts['test:agent'].includes('scripts/pure-js-probe.test.mjs'))
  assert.match(manifest.scripts['test:agent:integration'], /scripts\/pure-js-probe\.integration\.test\.mjs/u)
})
