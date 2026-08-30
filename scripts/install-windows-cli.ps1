[CmdletBinding()]
param(
  [string]$XsRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$BinPath = (Join-Path $env:LOCALAPPDATA 'Xiaoshe\bin'),
  [switch]$CheckOnly,
  [switch]$NoPathUpdate
)

$ErrorActionPreference = 'Stop'
$ResolvedXsRoot = (Resolve-Path -LiteralPath $XsRoot).Path
$StartScript = Join-Path $ResolvedXsRoot 'scripts\windows-start-entry.ps1'
$DoctorScript = Join-Path $ResolvedXsRoot 'scripts\windows-doctor-entry.ps1'
if (-not (Test-Path -LiteralPath $StartScript)) { throw "Missing launcher: $StartScript" }
if (-not (Test-Path -LiteralPath $DoctorScript)) { throw "Missing doctor: $DoctorScript" }

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$PathParts = @($UserPath -split ';' | Where-Object { $_ })
$PathInstalled = @($PathParts | Where-Object { $_.TrimEnd('\') -ieq $BinPath.TrimEnd('\') }).Count -gt 0
$SCommand = Join-Path $BinPath 's.cmd'
$DoctorCommand = Join-Path $BinPath 'xiaoshe-doctor.cmd'

if ($CheckOnly) {
  [pscustomobject]@{
    schema = 'xiaoshe-windows-cli/v1'
    binPath = $BinPath
    sInstalled = (Test-Path -LiteralPath $SCommand)
    doctorInstalled = (Test-Path -LiteralPath $DoctorCommand)
    pathInstalled = $PathInstalled
  } | ConvertTo-Json -Depth 3
  exit 0
}

New-Item -ItemType Directory -Force $BinPath | Out-Null
$WindowsPowerShell = '%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe'
$StartWrapper = "@echo off`r`n`"$WindowsPowerShell`" -NoProfile -ExecutionPolicy Bypass -File `"$StartScript`" %*`r`nexit /b %errorlevel%`r`n"
$DoctorWrapper = "@echo off`r`n`"$WindowsPowerShell`" -NoProfile -ExecutionPolicy Bypass -File `"$DoctorScript`" %*`r`nexit /b %errorlevel%`r`n"
Set-Content -LiteralPath $SCommand -Value $StartWrapper -Encoding ASCII
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
  doctorInstalled = $true
  pathInstalled = $PathInstalled
  note = 'Open a new terminal before using s or xiaoshe-doctor.'
} | ConvertTo-Json -Depth 3
