import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const acceptance = resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'acceptance', 'windows-desktop.ps1')

function runPowerShell(source) {
  return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, XIAOSHE_ACCEPTANCE_SCRIPT: acceptance },
  })
}

const loadCleanupFunctions = String.raw`
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:XIAOSHE_ACCEPTANCE_SCRIPT, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw ($errors | Out-String) }
$names = @('Stop-AcceptanceProcessVerified', 'Remove-IsolatedUserDataVerified')
$definitions = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name
}, $true))
if ($definitions.Count -ne 2) { throw "acceptance cleanup functions missing: $($definitions.Count)" }
foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }
`

test('Windows acceptance rejects a process that remains alive after forced termination', { skip: process.platform !== 'win32' }, () => {
  const result = runPowerShell(`${loadCleanupFunctions}
$process = [pscustomobject]@{ Id = 4242; HasExited = $false }
$process | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
$process | Add-Member -MemberType ScriptMethod -Name Kill -Value { }
$process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param([int]$milliseconds) return $false }
try {
  Stop-AcceptanceProcessVerified -Process $process -Name 'sticky fixture'
  throw 'cleanup incorrectly accepted a live process'
} catch {
  if ($_.Exception.Message -eq 'cleanup incorrectly accepted a live process') { throw }
  if ($_.Exception.Message -notmatch 'did not exit') { throw }
}
exit 0
`)
  assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }))
})

test('Windows acceptance rejects a locked userData tree and verifies successful removal', { skip: process.platform !== 'win32' }, () => {
  const result = runPowerShell(`${loadCleanupFunctions}
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$root = Join-Path $temporaryBase ('xiaoshe-cleanup-contract-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$file = Join-Path $root 'locked.txt'
[System.IO.File]::WriteAllText($file, 'locked')
$stream = [System.IO.File]::Open($file, 'Open', 'ReadWrite', 'None')
try {
  try {
    Remove-IsolatedUserDataVerified -Path $root -TemporaryBase $temporaryBase
    throw 'cleanup incorrectly accepted a retained directory'
  } catch {
    if ($_.Exception.Message -eq 'cleanup incorrectly accepted a retained directory') { throw }
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'locked fixture unexpectedly disappeared' }
  }
} finally {
  $stream.Dispose()
}
Remove-IsolatedUserDataVerified -Path $root -TemporaryBase $temporaryBase
if (Test-Path -LiteralPath $root) { throw 'verified cleanup retained the directory' }
`)
  assert.equal(result.status, 0, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }))
})
