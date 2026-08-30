[CmdletBinding()]
param()

$EntryRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EntryName = (-join @([char]0x505C, [char]0x6B62, [char]0x5C0F, [char]0x86C7)) + '.ps1'
$ModernPowerShell = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
if (-not $ModernPowerShell) {
  throw 'PowerShell 7 is required. Install Microsoft.PowerShell, then open a new terminal.'
}
& $ModernPowerShell.Source -NoProfile -ExecutionPolicy Bypass -File (Join-Path $EntryRoot $EntryName)
exit $LASTEXITCODE
