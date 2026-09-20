import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')

// Import real build output without the checkout's packages/ directory or links.
// A source-relative dependency can pass local tests but cannot survive shipping.
for (const entry of ['agent-reliability', 'verification-results', 'task-graph']) {
  test(`installed ${entry} loads with only declared workspace dependencies`, async t => {
    const staging = await mkdtemp(join(tmpdir(), 'xiaoshe-plugin-import-'))
    t.after(() => rm(staging, { recursive: true, force: true }))
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const installed = join(staging, 'node_modules', ...manifest.name.split('/'))
    await mkdir(installed, { recursive: true })
    await cp(join(root, 'package.json'), join(installed, 'package.json'))
    await cp(join(root, 'dist'), join(installed, 'dist'), { recursive: true })
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (!version.startsWith('workspace:')) continue
      const source = join(root, 'packages', name.split('/').at(-1))
      const destination = join(staging, 'node_modules', ...name.split('/'))
      await mkdir(destination, { recursive: true })
      await cp(join(source, 'package.json'), join(destination, 'package.json'))
      await cp(join(source, 'lib'), join(destination, 'lib'), { recursive: true })
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `const plugin = await import(${JSON.stringify(`${manifest.name}/${entry}`)}); console.log(JSON.stringify({name: plugin.name, apply: typeof plugin.apply}))`,
    ], { cwd: dirname(dirname(installed)), encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.deepEqual(JSON.parse(result.stdout), { name: `xiaoshe-${entry}`, apply: 'function' })
  })
}
