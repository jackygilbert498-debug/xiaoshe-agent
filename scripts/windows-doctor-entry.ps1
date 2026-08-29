[CmdletBinding()]
param([switch]$Json)

$EntryRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EntryName = (-join @([char]0x8BCA, [char]0x65AD, [char]0x5C0F, [char]0x86C7)) + '-Windows.ps1'
& (Join-Path $EntryRoot $EntryName) -Json:$Json
exit $LASTEXITCODE
