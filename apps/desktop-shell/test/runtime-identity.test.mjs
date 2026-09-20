import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { productRuntimeIdentity } from '../../../scripts/product-runtime-identity.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-identity-stability-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dshRoot = join(root, 'runtime', 'DSH')
  const profileRoot = join(root, 'user-profile')
  async function put(path, value = 'fixture') { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  await put(join(root, 'package.json'), JSON.stringify({ name: '@xiaoshe/dsh-desktop-control', files: ['dist', 'scripts', 'launch.ps1'] }))
  await put(join(root, 'src', 'index.ts'))
  await put(join(root, 'dist', 'index.js'))
  await put(join(root, 'pnpm-lock.yaml'))
  await put(join(root, 'launch.ps1'))
  await put(join(root, 'packages', 'product-bundle', 'package.json'), JSON.stringify({ name: '@xiaoshe/product-bundle', files: ['lib', 'cordis.patch.yml'] }))
  await put(join(root, 'packages', 'product-bundle', 'cordis.patch.yml'))
  await put(join(root, 'packages', 'product-bundle', 'lib', 'index.js'))
  await put(join(dshRoot, 'apps', 'cli', 'lib', 'bin.js'))
  await put(join(dshRoot, 'packages', 'host', 'apiproxy', 'lib', 'index.js'))
  await put(join(profileRoot, 'package.json'), JSON.stringify({ dependencies: { '@xiaoshe/dsh-desktop-control': `link:${root}` } }))
  await put(join(profileRoot, 'cordis.patch.yml'))
  return { root, dshRoot, profileRoot, put, identity: () => productRuntimeIdentity({ root, dshRoot, profileRoot }) }
}

test('startup identity ignores probe ledgers, acceptance reports, docs and interpreter caches', async t => {
  const f = await fixture(t)
  const initial = await f.identity()
  for (const path of [
    join(f.profileRoot, '.xiaoshe', 'provider-probes.json'),
    join(f.root, 'output', 'acceptance', 'report.json'),
    join(f.root, 'README.md'),
    join(f.root, 'packages', 'product-bundle', 'test', 'new.test.mjs'),
    join(f.root, 'python', '__pycache__', 'bridge.pyc'),
  ]) {
    await f.put(path, 'new runtime observation')
    assert.equal(await f.identity(), initial, `non-runtime data changed identity: ${path}`)
  }
})

test('startup identity detects actual source, executable, dependency and startup configuration changes', async t => {
  const f = await fixture(t)
  let previous = await f.identity()
  for (const path of [
    join(f.root, 'src', 'index.ts'), join(f.root, 'dist', 'index.js'),
    join(f.root, 'launch.ps1'),
    join(f.root, 'pnpm-lock.yaml'), join(f.root, 'packages', 'product-bundle', 'lib', 'index.js'),
    join(f.dshRoot, 'apps', 'cli', 'lib', 'bin.js'), join(f.dshRoot, 'packages', 'host', 'apiproxy', 'lib', 'index.js'),
    join(f.profileRoot, 'cordis.patch.yml'),
  ]) {
    await f.put(path, 'changed executable or configuration')
    const next = await f.identity()
    assert.notEqual(next, previous, `runtime input was ignored: ${path}`)
    previous = next
  }
})

test('startup identity binds byte-identical products to their distinct checkout roots', async t => {
  const a = await fixture(t); const b = await fixture(t)
  // No dependency path distinguishes these manifests: the root binding must.
  await a.put(join(a.profileRoot, 'package.json'), '{"dependencies":{}}')
  await b.put(join(b.profileRoot, 'package.json'), '{"dependencies":{}}')
  assert.notEqual(await a.identity(), await b.identity())
})

test('runtime input links are rejected', async t => {
  const f = await fixture(t)
  await f.put(join(f.root, 'outside', 'private.js'))
  await symlink(join(f.root, 'outside'), join(f.root, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.identity, /unsafe|symbolic|link/iu)
})

test('runtime prompt Markdown remains an input while documentation Markdown is ignored', async t => {
  const f = await fixture(t)
  const prompt = join(f.dshRoot, 'packages/core/system-prompt/src/default.md')
  await f.put(prompt, 'first executable prompt')
  const before = await f.identity()
  await f.put(join(f.root, 'packages/product-bundle/docs/design.md'), 'documentation only')
  assert.equal(await f.identity(), before)
  await f.put(prompt, 'changed executable prompt')
  assert.notEqual(await f.identity(), before)
})

test('a dependency cannot declare payload files outside its installed package', async t => {
  const f = await fixture(t)
  await f.put(join(f.profileRoot, 'package.json'), '{"dependencies":{"external":"1"}}')
  await f.put(join(f.profileRoot, 'node_modules/external/package.json'), '{"name":"external","files":["../private"]}')
  await f.put(join(f.profileRoot, 'node_modules/private/index.js'), 'private')
  await assert.rejects(f.identity, /unsafe runtime payload path/u)
})

test('a dependency declared wildcard includes matching executable payload outside conventional lib directories', async t => {
  const f = await fixture(t)
  await f.put(join(f.profileRoot, 'package.json'), '{"dependencies":{"external":"1"}}')
  await f.put(join(f.profileRoot, 'node_modules/external/package.json'), '{"name":"external","files":["workers/worker-*.js"]}')
  const worker = join(f.profileRoot, 'node_modules/external/workers/worker-one.js')
  await f.put(worker, 'first worker')
  const before = await f.identity()
  await f.put(worker, 'updated worker')
  assert.notEqual(await f.identity(), before)
})
