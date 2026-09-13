import assert from 'node:assert/strict'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

test('doctor shares launcher Node floors and reads only the selected DSH_HOME Profile', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-doctor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const product = join(root, 'product'), user = join(root, 'user'), dshHome = join(root, 'selected-dsh-home')
  const source = resolve(import.meta.dirname, '../../..')
  async function put(path, text) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text) }
  await put(join(product, 'package.json'), '{}')
  await put(join(product, 'runtime/DSH/apps/cli/lib/bin.js'), '')
  await put(join(product, 'runtime/xiaoshe-legacy/harness/observe.py'), '')
  await put(join(dshHome, 'profiles/web/package.json'), '{"dependencies":{"@xiaoshe/dsh-desktop-control":"1","@liustack/modlens":"3"}}')
  await put(join(user, '.xiaoshe/pnpm-11.7.0/node_modules/.bin/pnpm.cmd'), '@echo off\r\necho 11.7.0\r\n')
  const entry = join(product, 'doctor.ps1'), proxy = join(product, 'scripts/windows-proxy-environment.ps1')
  await mkdir(dirname(proxy), { recursive: true })
  await copyFile(join(source, '诊断小蛇-Windows.ps1'), entry)
  await copyFile(join(source, 'scripts/windows-proxy-environment.ps1'), proxy)
  const version = join(root, 'version.ps1')
  await put(version, 'Write-Output $env:XIAOSHE_TEST_NODE_VERSION\n')
  const harness = join(root, 'harness.ps1')
  await put(harness, [
    'function Get-Command { param($Name) if ($Name -in @("node", "python")) { [pscustomobject]@{ Source = $env:XIAOSHE_TEST_VERSION_COMMAND } } }',
    'function Get-NetTCPConnection { @() }',
    'function Get-ItemProperty { throw "fixture has no registry" }',
    '& $env:XIAOSHE_TEST_DOCTOR -Json',
  ].join('\n'))
  for (const [versionText, want] of [['22.22.9', 'fail'], ['22.23.0', 'pass'], ['24.16.9', 'fail'], ['24.17.0', 'pass'], ['25.0.0', 'fail'], ['26.0.0', 'fail']]) {
    const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, USERPROFILE: user, HOME: user, LOCALAPPDATA: join(root, 'local'), DSH_HOME: dshHome,
        XIAOSHE_TEST_NODE_VERSION: versionText, XIAOSHE_TEST_VERSION_COMMAND: version, XIAOSHE_TEST_DOCTOR: entry },
    })
    assert.ok(result.stdout.trim().startsWith('{'), result.stderr)
    const report = JSON.parse(result.stdout.trim())
    assert.equal(report.checks.find(row => row.id === 'runtime.node').status, want, `Node ${versionText}`)
    assert.equal(report.checks.find(row => row.id === 'profile.web').status, 'pass', 'selected DSH_HOME must override empty default Profile')
  }
})
