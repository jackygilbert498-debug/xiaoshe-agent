import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { foreignDependencyMetadata, inspectMacDependencies } from './check-macos-dependencies.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xs-mac-dependencies-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dsh = join(root, 'runtime/DSH')
  const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  for (const dir of [root, dsh]) {
    await put(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', devDependencies: { typescript: '1.0.0' } }))
    await put(join(dir, 'node_modules/.modules.yaml'), 'virtualStoreDir: .pnpm\n')
    await put(join(dir, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"1.0.0"}')
    await put(join(dir, 'node_modules/typescript/bin/tsc'), '// fixture compiler')
    await put(join(dir, 'node_modules/.bin/tsc'), '#!/bin/sh\nexit 0\n')
    await chmod(join(dir, 'node_modules/.bin/tsc'), 0o755)
  }
  return { root, dsh, put, inspect: () => inspectMacDependencies(root, dsh) }
}

test('recognizes Windows and WSL pnpm metadata without flagging local paths', () => {
  for (const value of ['storeDir: C:\\Users\\someone', '"virtualStoreDir": "C:\\\\Users\\\\someone",', 'virtualStoreDir: /mnt/c/Users/someone']) assert.equal(foreignDependencyMetadata(value), true)
  for (const value of ['virtualStoreDir: .pnpm', 'storeDir: /Users/local/Library/pnpm', 'storeDir: /private/var/tmp/pnpm']) assert.equal(foreignDependencyMetadata(value), false)
})

test('local readable compiler and executable shim pass', async t => {
  const f = await fixture(t)
  await f.put(join(f.root, 'node_modules/.bin/tsc'), '#!/bin/sh\nexport NODE_PATH="/Users/local/node_modules:/Users/local/other"\n')
  assert.deepEqual(await f.inspect(), { ok: true, issues: [] })
})

test('copied metadata fails before any compiler execution', async t => {
  const f = await fixture(t)
  await f.put(join(f.root, 'node_modules/.modules.yaml'), 'virtualStoreDir: C:\\Users\\old\\XS\\node_modules\\.pnpm')
  assert.match((await f.inspect()).issues.join('\n'), /Windows\/WSL/)
})

test('non-executable compiler shim is rejected', async t => {
  const f = await fixture(t)
  await chmod(join(f.root, 'node_modules/.bin/tsc'), 0o644)
  assert.equal((await f.inspect()).ok, false)
})

test('missing or dangling TypeScript dependency is rejected', async t => {
  const f = await fixture(t)
  await rm(join(f.dsh, 'node_modules/typescript'), { recursive: true })
  assert.equal((await f.inspect()).ok, false)
  await symlink(join(f.root, 'absent'), join(f.dsh, 'node_modules/typescript'))
  assert.equal((await f.inspect()).ok, false)
})

test('a product package with its own broken tsc cannot borrow root readiness', async t => {
  const f = await fixture(t)
  await f.put(join(f.root, 'packages/example/package.json'), '{"name":"example","devDependencies":{"typescript":"1"}}')
  assert.match((await f.inspect()).issues.join('\n'), /example/)
})

test('foreign executable shim and missing pnpm metadata fail', async t => {
  const f = await fixture(t)
  await f.put(join(f.root, 'node_modules/.bin/tsc'), '#!/bin/sh\nexport NODE_PATH=/mnt/c/Users/old/XS\n')
  assert.equal((await f.inspect()).ok, false)
  await rm(join(f.dsh, 'node_modules/.modules.yaml'))
  assert.match((await f.inspect()).issues.join('\n'), /pnpm/)
})

test('CLI fails closed and startup checks before building', async t => {
  const f = await fixture(t)
  await chmod(join(f.root, 'node_modules/.bin/tsc'), 0o644)
  const result = spawnSync(process.execPath, ['scripts/check-macos-dependencies.mjs', f.root, f.dsh], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /TypeScript/)
  const source = await readFile(new URL('./start-xiaoshe-web.sh', import.meta.url), 'utf8')
  assert.ok(source.indexOf('"$NODE" "$PLUGIN_ROOT/scripts/check-macos-dependencies.mjs"') < source.indexOf("--filter './packages/**' run build"))
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.files.includes('scripts/check-macos-dependencies.mjs'))
})
