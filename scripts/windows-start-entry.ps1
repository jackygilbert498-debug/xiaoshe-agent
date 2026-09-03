[CmdletBinding()]
param(
  [switch]$NoOpen,
  [switch]$ServerOnly,
  [switch]$BrowserFallback
)

$EntryRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EntryName = (-join @([char]0x542F, [char]0x52A8, [char]0x5C0F, [char]0x86C7)) + '.ps1'
& (Join-Path $EntryRoot $EntryName) `
  -NoOpen:$NoOpen -ServerOnly:$ServerOnly -BrowserFallback:$BrowserFallback
exit $LASTEXITCODE
