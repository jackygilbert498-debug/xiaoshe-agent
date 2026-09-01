[CmdletBinding()]
param(
  [string]$XsRoot,
  [string]$BinPath = (Join-Path $env:LOCALAPPDATA 'Xiaoshe\bin'),
  [switch]$CheckOnly,
  [switch]$NoPathUpdate
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 does not populate $MyInvocation reliably while
# evaluating parameter defaults, so derive the repository root in the body.
if ([string]::IsNullOrWhiteSpace($XsRoot)) {
  $XsRoot = Split-Path -Parent $PSScriptRoot
}
$ResolvedXsRoot = (Resolve-Path -LiteralPath $XsRoot).Path
$TerminalScript = Join-Path $ResolvedXsRoot 'scripts\windows-terminal-entry.ps1'
$DesktopScript = Join-Path $ResolvedXsRoot 'scripts\windows-start-entry.ps1'
$DoctorScript = Join-Path $ResolvedXsRoot 'scripts\windows-doctor-entry.ps1'
if (-not (Test-Path -LiteralPath $TerminalScript)) { throw "Missing terminal launcher: $TerminalScript" }
if (-not (Test-Path -LiteralPath $DesktopScript)) { throw "Missing desktop launcher: $DesktopScript" }
if (-not (Test-Path -LiteralPath $DoctorScript)) { throw "Missing doctor: $DoctorScript" }

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$PathParts = @($UserPath -split ';' | Where-Object { $_ })
$PathInstalled = @($PathParts | Where-Object { $_.TrimEnd('\') -ieq $BinPath.TrimEnd('\') }).Count -gt 0
$SCommand = Join-Path $BinPath 's.cmd'
$SsCommand = Join-Path $BinPath 'ss.cmd'
$DoctorCommand = Join-Path $BinPath 'xiaoshe-doctor.cmd'

if ($CheckOnly) {
  [pscustomobject]@{
    schema = 'xiaoshe-windows-cli/v1'
    binPath = $BinPath
    sInstalled = (Test-Path -LiteralPath $SCommand)
    ssInstalled = (Test-Path -LiteralPath $SsCommand)
    doctorInstalled = (Test-Path -LiteralPath $DoctorCommand)
    pathInstalled = $PathInstalled
  } | ConvertTo-Json -Depth 3
  exit 0
}

New-Item -ItemType Directory -Force $BinPath | Out-Null
$WindowsPowerShell = '%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe'
$TerminalWrapper = "@echo off`r`n`"$WindowsPowerShell`" -NoProfile -ExecutionPolicy Bypass -File `"$TerminalScript`" %*`r`nexit /b %errorlevel%`r`n"
$DesktopWrapper = "@echo off`r`n`"$WindowsPowerShell`" -NoProfile -ExecutionPolicy Bypass -File `"$DesktopScript`" %*`r`nexit /b %errorlevel%`r`n"
$DoctorWrapper = "@echo off`r`n`"$WindowsPowerShell`" -NoProfile -ExecutionPolicy Bypass -File `"$DoctorScript`" %*`r`nexit /b %errorlevel%`r`n"
Set-Content -LiteralPath $SCommand -Value $TerminalWrapper -Encoding ASCII
Set-Content -LiteralPath $SsCommand -Value $DesktopWrapper -Encoding ASCII
Set-Content -LiteralPath $DoctorCommand -Value $DoctorWrapper -Encoding ASCII

if (-not $NoPathUpdate -and -not $PathInstalled) {
  $UpdatedUserPath = if ([string]::IsNullOrWhiteSpace($UserPath)) { $BinPath } else { "$BinPath;$UserPath" }
  [Environment]::SetEnvironmentVariable('Path', $UpdatedUserPath, 'User')
  $env:Path = "$BinPath;$env:Path"
  $PathInstalled = $true
}

[pscustomobject]@{
  schema = 'xiaoshe-windows-cli/v1'
  binPath = $BinPath
  sInstalled = $true
  ssInstalled = $true
  doctorInstalled = $true
  pathInstalled = $PathInstalled
  note = 'Open a new terminal before using s, ss, or xiaoshe-doctor.'
} | ConvertTo-Json -Depth 3
