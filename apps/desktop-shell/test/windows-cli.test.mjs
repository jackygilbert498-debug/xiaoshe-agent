import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productRoot = resolve(appRoot, '..', '..')
const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : ''

async function installCommands() {
  const root = await mkdtemp(join(tmpdir(), 'xiaoshe-windows-cli-'))
  const fakeRoot = join(root, 'product')
  const scripts = join(fakeRoot, 'scripts')
  const bin = join(root, 'bin')
  await mkdir(scripts, { recursive: true })
  for (const [name, marker] of [
    ['windows-terminal-entry.ps1', 'terminal'],
    ['windows-start-entry.ps1', 'desktop'],
    ['windows-doctor-entry.ps1', 'doctor'],
  ]) {
    await writeFile(resolve(scripts, name), [
      'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Forwarded)',
      `$Forwarded -join '|' | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) '${marker}.invocation') -Encoding ASCII -NoNewline`,
      'exit 0',
      '',
    ].join('\r\n'), 'ascii')
  }
  const installer = resolve(productRoot, 'scripts', 'install-windows-cli.ps1')
  const installed = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
    '-XsRoot', fakeRoot, '-BinPath', bin, '-NoPathUpdate',
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(installed.status, 0, installed.stderr || installed.stdout)
  return { root, fakeRoot, bin }
}

test('Windows s command launches the terminal entry and forwards arguments', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await installCommands()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const launched = spawnSync('cmd.exe', ['/d', '/c', 's.cmd', 'alpha', 'beta'], {
    cwd: fixture.bin,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(launched.status, 0, launched.stderr || launched.stdout)

  const markers = await readdir(fixture.fakeRoot)
  assert.equal(markers.includes('terminal.invocation'), true, 's must invoke the terminal entry')
  assert.equal(markers.includes('desktop.invocation'), false, 's must not invoke the desktop entry')
  assert.equal(await readFile(join(fixture.fakeRoot, 'terminal.invocation'), 'ascii'), 'alpha|beta')
})

test('Windows ss command launches the desktop entry', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const fixture = await installCommands()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const launched = spawnSync('cmd.exe', ['/d', '/c', 'ss.cmd'], {
    cwd: fixture.bin,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(launched.status, 0, launched.stderr || launched.stdout)

  const markers = await readdir(fixture.fakeRoot)
  assert.equal(markers.includes('desktop.invocation'), true, 'ss must invoke the desktop entry')
  assert.equal(markers.includes('terminal.invocation'), false, 'ss must not invoke the terminal entry')
  assert.equal(await readFile(join(fixture.fakeRoot, 'desktop.invocation'), 'ascii'), '')
})

test('Windows terminal entry check reports its runtime inputs without starting the host', {
  skip: process.platform !== 'win32',
}, () => {
  const script = resolve(productRoot, 'scripts', 'windows-terminal-entry.ps1')
  const checked = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-CheckOnly',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, XIAOSHE_DSH_PORT: '39791' },
  })
  assert.equal(checked.status, 0, checked.stderr || checked.stdout)

  const report = JSON.parse(checked.stdout)
  assert.equal(report.schema, 'xiaoshe-windows-terminal/v1')
  assert.equal(report.xsRoot, productRoot)
  assert.equal(report.port, 39791)
  assert.equal(report.hostStarted, false)
  assert.match(report.terminalEntry, /packages[\\/]terminal-client[\\/]lib[\\/]bin\.js$/u)
  assert.equal(report.nodeMajor >= 24, true)
})

test('published product includes the Windows terminal entry', async () => {
  const manifest = JSON.parse(await readFile(resolve(productRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.files.includes('scripts/windows-terminal-entry.ps1'), true)
})

test('Windows terminal entry rejects ports outside the TCP range', {
  skip: process.platform !== 'win32',
}, () => {
  const script = resolve(productRoot, 'scripts', 'windows-terminal-entry.ps1')
  const checked = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-CheckOnly',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, XIAOSHE_DSH_PORT: '70000' },
  })
  assert.notEqual(checked.status, 0, 'ports above 65535 must be rejected')
  assert.match(checked.stderr, /between 1 and 65535/u)
})

test('Windows desktop entry resolves the localized installed application', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), 'xiaoshe-local-app-data-'))
  t.after(() => rm(localAppData, { recursive: true, force: true }))
  const installed = join(localAppData, 'Programs', '小蛇', '小蛇.exe')
  await mkdir(dirname(installed), { recursive: true })
  await writeFile(installed, '')

  const script = resolve(productRoot, 'scripts', 'windows-start-entry.ps1')
  const checked = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-CheckOnly',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData },
  })
  assert.equal(checked.status, 0, checked.stderr || checked.stdout)

  const report = JSON.parse(checked.stdout)
  assert.equal(report.schema, 'xiaoshe-windows-desktop/v1')
  assert.equal(report.kind, 'installed')
  assert.equal(report.selectedDesktop, installed)
  assert.equal(report.launched, false)
})
