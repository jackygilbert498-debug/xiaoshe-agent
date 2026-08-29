#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RepoDir,
    [string]$BinDir,
    [ValidateSet('Install', 'Upgrade', 'Rollback', 'Uninstall')]
    [string]$Action = 'Install',
    [string]$PathStore
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoDir)) {
    $RepoDir = $PSScriptRoot
}
$installer = Join-Path $PSScriptRoot 'scripts\install_s_command.ps1'
& $installer -RepoDir $RepoDir -BinDir $BinDir -Action $Action -PathStore $PathStore
