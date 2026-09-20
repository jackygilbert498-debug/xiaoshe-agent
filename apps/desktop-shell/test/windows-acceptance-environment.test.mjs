import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const testRoot = dirname(fileURLToPath(import.meta.url))
const helper = resolve(testRoot, '..', '..', '..', 'scripts', 'acceptance', 'windows-acceptance-environment.ps1')
const acceptanceIsolation = resolve(testRoot, '..', 'src', 'acceptance-isolation.mjs')
const powershell = process.platform === 'win32'
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null
const isolatedKeys = [
  'XIAOSHE_HOME', 'DSH_HOME', 'HOME', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP',
]

function isInside(root, candidate) {
  const path = relative(resolve(root), resolve(candidate))
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !resolve(path).startsWith(sep)
}

test('Windows packaged acceptance redirects every profile path and leaves real user directories unchanged', {
  skip: process.platform !== 'win32',
}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'xiaoshe-acceptance-environment-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))

  const real = {
    XIAOSHE_HOME: join(temporary, 'real-xiaoshe-home'),
    DSH_HOME: join(temporary, 'real-dsh-home'),
    HOME: join(temporary, 'real-home'),
    USERPROFILE: join(temporary, 'real-user-profile'),
    LOCALAPPDATA: join(temporary, 'real-local-app-data'),
    APPDATA: join(temporary, 'real-roaming-app-data'),
    TEMP: join(temporary, 'real-temp'),
    TMP: join(temporary, 'real-temp'),
  }
  for (const path of new Set(Object.values(real))) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'sentinel.txt'), `unchanged:${path}\n`)
  }

  const cleanupRoot = join(real.TEMP, 'xiaoshe-acceptance-cleanup')
  const acceptanceTemp = join(cleanupRoot, 'temp')
  const userData = join(acceptanceTemp, 'xiaoshe-windows-acceptance-composed')
  const probe = join(temporary, 'acceptance-user-data-probe.mjs')
  await writeFile(probe, `
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
const { acceptanceUserDataPath } = await import(pathToFileURL(process.argv[2]).href)
process.stdout.write(JSON.stringify({ temporaryRoot: tmpdir(), userData: acceptanceUserDataPath(process.env, tmpdir()) }))
`)
  const harness = join(temporary, 'exercise-environment.ps1')
  await writeFile(harness, String.raw`param([string]$Helper, [string]$CleanupRoot, [string]$UserData, [string]$Probe, [string]$AcceptanceIsolation)
$ErrorActionPreference = 'Stop'
. $Helper
New-Item -ItemType Directory -Force -Path $CleanupRoot,$UserData | Out-Null
$PersistentNames = @('XIAOSHE_HOME','DSH_HOME','HOME','USERPROFILE','LOCALAPPDATA','APPDATA')
$Before = @{}
foreach ($Name in $PersistentNames) {
  $Before[$Name] = @((Get-ChildItem -LiteralPath ([Environment]::GetEnvironmentVariable($Name, 'Process')) -Recurse -Force | ForEach-Object FullName))
}
$Previous = Enter-XiaosheAcceptanceEnvironment -CleanupRoot $CleanupRoot -UserDataRoot $UserData -ServiceUrl 'http://127.0.0.1:41731/' -Port 41731
try {
  $During = @{}
  foreach ($Name in $script:XiaosheAcceptanceEnvironmentKeys) {
    $During[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
  }
  foreach ($Name in @('XIAOSHE_HOME','DSH_HOME','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP')) {
    $CurrentPath = [Environment]::GetEnvironmentVariable($Name, 'Process')
    Set-Content -LiteralPath (Join-Path $CurrentPath 'acceptance-write.txt') -Value $Name
  }
  $AcceptanceProbe = (& node $Probe $AcceptanceIsolation | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0) { throw "acceptance userData probe exited $LASTEXITCODE" }
} finally {
  Exit-XiaosheAcceptanceEnvironment -Previous $Previous
}
$Restored = @{}
foreach ($Name in $script:XiaosheAcceptanceEnvironmentKeys) {
  $Restored[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
}
Remove-Item -LiteralPath $CleanupRoot -Recurse -Force
$RealDirectoriesUnchanged = $true
foreach ($Name in $PersistentNames) {
  $After = @((Get-ChildItem -LiteralPath ([Environment]::GetEnvironmentVariable($Name, 'Process')) -Recurse -Force | ForEach-Object FullName))
  if ($null -ne (Compare-Object -ReferenceObject @($Before[$Name]) -DifferenceObject $After)) { $RealDirectoriesUnchanged = $false }
}
@{ during = $During; restored = $Restored; realDirectoriesUnchanged = $RealDirectoriesUnchanged; acceptanceProbe = $AcceptanceProbe } | ConvertTo-Json -Depth 4 -Compress
`)

  const original = {
    ...real,
    XIAOSHE_PRODUCT_ROOT: join(temporary, 'real-product-root'),
    XIAOSHE_DESKTOP_URL: 'http://127.0.0.1:39999/',
    XIAOSHE_DESKTOP_ACCEPTANCE: 'original-acceptance',
    XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA: join(temporary, 'original-user-data'),
    XIAOSHE_DSH_PORT: '39999',
  }
  const { stdout, stderr } = await run(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', harness, '-Helper', helper, '-CleanupRoot', cleanupRoot, '-UserData', userData,
    '-Probe', probe, '-AcceptanceIsolation', acceptanceIsolation,
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...original } })
  assert.equal(stderr, '')
  const result = JSON.parse(stdout.trim())

  assert.equal(result.during.XIAOSHE_PRODUCT_ROOT, null)
  assert.equal(result.during.XIAOSHE_DESKTOP_URL, 'http://127.0.0.1:41731/')
  assert.equal(result.during.XIAOSHE_DESKTOP_ACCEPTANCE, '1')
  assert.equal(result.during.XIAOSHE_DSH_PORT, '41731')
  assert.equal(resolve(result.during.XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA), resolve(userData))
  assert.equal(resolve(result.during.TEMP), resolve(acceptanceTemp))
  assert.equal(resolve(result.during.TMP), resolve(acceptanceTemp))
  assert.equal(resolve(result.acceptanceProbe.temporaryRoot), resolve(acceptanceTemp))
  assert.equal(resolve(result.acceptanceProbe.userData), resolve(userData))
  for (const key of isolatedKeys) {
    assert.ok(isInside(cleanupRoot, result.during[key]), `${key} must be inside the common cleanup root`)
  }
  for (const [key, value] of Object.entries(original)) {
    assert.equal(result.restored[key], value, `${key} must be restored exactly`)
  }
  assert.equal(result.realDirectoriesUnchanged, true)

  for (const path of new Set(Object.values(real))) {
    const entries = await readdir(path, { recursive: true })
    assert.equal(entries.some(entry => entry.endsWith('acceptance-write.txt')), false, `acceptance write escaped isolation: ${path}`)
    assert.equal(await readFile(join(path, 'sentinel.txt'), 'utf8'), `unchanged:${path}\n`)
  }
})

test('Windows packaged acceptance rejects a temporary junction targeting a real user directory', {
  skip: process.platform !== 'win32',
}, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'xiaoshe-acceptance-junction-'))
  const outside = await mkdtemp(join(dirname(tmpdir()), 'xiaoshe-real-user-directory-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const cleanupRoot = join(temporary, 'cleanup')
  const acceptanceTemp = join(cleanupRoot, 'temp')
  await mkdir(acceptanceTemp, { recursive: true })
  const linked = join(acceptanceTemp, 'xiaoshe-windows-acceptance-linked')
  await symlink(outside, linked, 'junction')
  const harness = join(temporary, 'reject-junction.ps1')
  await writeFile(harness, String.raw`param([string]$Helper, [string]$UserData)
$ErrorActionPreference = 'Stop'
. $Helper
Enter-XiaosheAcceptanceEnvironment -CleanupRoot (Split-Path -Parent (Split-Path -Parent $UserData)) -UserDataRoot $UserData -ServiceUrl 'http://127.0.0.1:41731/' -Port 41731 | Out-Null
`)
  await assert.rejects(run(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', harness, '-Helper', helper, '-UserData', linked,
  ], { encoding: 'utf8', windowsHide: true }), /temporary directory|filesystem link|reparse/iu)
})
