#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RepoDir,
    [string]$BinDir
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoDir)) {
    $RepoDir = $PSScriptRoot
}
$installer = Join-Path $PSScriptRoot 'scripts\install_s_command.ps1'
& $installer -RepoDir $RepoDir -BinDir $BinDir
