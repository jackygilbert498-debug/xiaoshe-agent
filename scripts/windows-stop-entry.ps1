[CmdletBinding()]
param()

$EntryRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EntryName = (-join @([char]0x505C, [char]0x6B62, [char]0x5C0F, [char]0x86C7)) + '.ps1'
& (Join-Path $EntryRoot $EntryName)
exit $LASTEXITCODE
