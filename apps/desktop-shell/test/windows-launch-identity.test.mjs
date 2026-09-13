import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// Exercise the real ServerOnly launcher up to its first child process. The
// isolated lease probe records that child's environment and deliberately
// refuses the lease, so no service, installer or personal Profile is touched.
for (const inherited of [false, true]) {
  test(`Windows Host receives authoritative roots with ${inherited ? 'stale' : 'absent'} caller metadata`, {
    skip: process.platform !== 'win32',
  }, async t => {
    const fixture = await mkdtemp(join(tmpdir(), 'xiaoshe-launch-identity-'))
    t.after(() => rm(fixture, { recursive: true, force: true }))
    const root = join(fixture, 'product')
    const dshHome = join(fixture, 'dsh-home')
    const observed = join(fixture, 'child-environment.json')
    await mkdir(join(root, 'scripts'), { recursive: true })
    await copyFile(join(productRoot, '启动小蛇.ps1'), join(root, '启动小蛇.ps1'))
    await writeFile(join(root, 'scripts/lifecycle-lease.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
        product: process.env.XIAOSHE_PRODUCT_ROOT,
        dsh: process.env.XIAOSHE_DSH_ROOT,
        profile: process.env.XIAOSHE_PROFILE_ROOT,
      }));
      process.exit(1);
    `)
    const environment = { ...process.env, LOCALAPPDATA: join(fixture, 'local'), DSH_HOME: dshHome }
    for (const key of ['XIAOSHE_PRODUCT_ROOT', 'XIAOSHE_DSH_ROOT', 'XIAOSHE_PROFILE_ROOT']) {
      if (inherited) environment[key] = join(fixture, 'old-source')
      else delete environment[key]
    }
    assert.throws(() => execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, '启动小蛇.ps1'), '-ServerOnly', '-NoOpen',
    ], { env: environment, windowsHide: true, timeout: 15_000, stdio: 'pipe' }), error => error.status === 1)
    assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), {
      product: root,
      dsh: join(root, 'runtime/DSH'),
      profile: join(dshHome, 'profiles/web'),
    })
  })
}
