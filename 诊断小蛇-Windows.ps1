[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = 'Stop'
$XsDoctorRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$DshDoctorRoot = Join-Path $XsDoctorRoot 'runtime\DSH'
$LegacyDoctorRoot = Join-Path $XsDoctorRoot 'runtime\xiaoshe-legacy'
$ProfileDoctorRoot = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$DoctorPort = if ($env:XIAOSHE_DSH_PORT) { [int]$env:XIAOSHE_DSH_PORT } else { 3080 }
$StateDoctorFileName = if ($DoctorPort -eq 3080) { 'dsh-web-state.json' } else { "dsh-web-state-$DoctorPort.json" }
$StateDoctorPath = Join-Path $env:LOCALAPPDATA "Xiaoshe\$StateDoctorFileName"
$DoctorChecks = [System.Collections.Generic.List[object]]::new()

function Add-DoctorCheck([string]$Id, [string]$Status, [string]$Detail) {
  $DoctorChecks.Add([pscustomobject]@{ id = $Id; status = $Status; detail = $Detail })
}

function Find-DoctorCommand([string]$Name) {
  return Get-Command $Name -ErrorAction SilentlyContinue
}

Add-DoctorCheck 'xs.root' $(if (Test-Path -LiteralPath (Join-Path $XsDoctorRoot 'package.json')) { 'pass' } else { 'fail' }) $XsDoctorRoot
Add-DoctorCheck 'dsh.root' $(if (Test-Path -LiteralPath (Join-Path $DshDoctorRoot 'apps\cli\lib\bin.js')) { 'pass' } else { 'fail' }) $DshDoctorRoot
Add-DoctorCheck 'legacy.root' $(if (Test-Path -LiteralPath (Join-Path $LegacyDoctorRoot 'harness\observe.py')) { 'pass' } else { 'fail' }) $LegacyDoctorRoot

$NodeDoctor = Find-DoctorCommand 'node'
if ($NodeDoctor) {
  $NodeDoctorVersion = (& $NodeDoctor.Source -p 'process.versions.node').Trim()
  $NodeDoctorMajor = [int]$NodeDoctorVersion.Split('.')[0]
  Add-DoctorCheck 'runtime.node' $(if ($NodeDoctorMajor -ge 24) { 'pass' } else { 'fail' }) $NodeDoctorVersion
} else { Add-DoctorCheck 'runtime.node' 'fail' 'node not found' }

$PythonDoctor = Find-DoctorCommand 'python'
if ($PythonDoctor) {
  $PythonDoctorVersion = (& $PythonDoctor.Source --version 2>&1 | Out-String).Trim()
  Add-DoctorCheck 'runtime.python' 'pass' $PythonDoctorVersion
} else { Add-DoctorCheck 'runtime.python' 'fail' 'python not found' }

$PwshDoctor = Find-DoctorCommand 'pwsh.exe'
Add-DoctorCheck 'runtime.pwsh-uia' $(if ($PwshDoctor) { 'pass' } else { 'warn' }) $(if ($PwshDoctor) { $PwshDoctor.Source } else { 'pwsh.exe not found; Windows PowerShell 5.1 remains available, but PowerShell 7 is recommended for richer UIA results' })

$PinnedDoctorPnpm = Join-Path $env:USERPROFILE '.xiaoshe\pnpm-11.7.0\node_modules\.bin\pnpm.cmd'
if (Test-Path -LiteralPath $PinnedDoctorPnpm) {
  $PnpmDoctorVersion = (& $PinnedDoctorPnpm --version 2>$null | Out-String).Trim()
  Add-DoctorCheck 'runtime.pnpm' $(if ($PnpmDoctorVersion -eq '11.7.0') { 'pass' } else { 'fail' }) $PnpmDoctorVersion
} else { Add-DoctorCheck 'runtime.pnpm' 'fail' $PinnedDoctorPnpm }

$ProfileDoctorPackage = Join-Path $ProfileDoctorRoot 'package.json'
if (Test-Path -LiteralPath $ProfileDoctorPackage) {
  $ProfileDoctorText = Get-Content -LiteralPath $ProfileDoctorPackage -Raw
  $HasDoctorXs = $ProfileDoctorText.Contains('@xiaoshe/dsh-desktop-control')
  $HasDoctorModLens = $ProfileDoctorText.Contains('@liustack/modlens')
  Add-DoctorCheck 'profile.web' $(if ($HasDoctorXs -and $HasDoctorModLens) { 'pass' } else { 'fail' }) "xs=$HasDoctorXs modlens=$HasDoctorModLens"
} else { Add-DoctorCheck 'profile.web' 'fail' $ProfileDoctorPackage }

$DoctorListeners = @(Get-NetTCPConnection -LocalPort $DoctorPort -State Listen -ErrorAction SilentlyContinue)
if ($DoctorListeners.Count -eq 0) {
  Add-DoctorCheck 'service.listener' 'warn' "port $DoctorPort is static"
} elseif (-not (Test-Path -LiteralPath $StateDoctorPath)) {
  Add-DoctorCheck 'service.listener' 'fail' "port $DoctorPort is occupied without Xiaoshe ownership state"
} else {
  try {
    $DoctorState = Get-Content -LiteralPath $StateDoctorPath -Raw | ConvertFrom-Json
    $DoctorOwned = @($DoctorListeners | Where-Object { $_.OwningProcess -eq $DoctorState.pid }).Count -gt 0 -and $DoctorState.xsRoot -eq $XsDoctorRoot
    Add-DoctorCheck 'service.listener' $(if ($DoctorOwned) { 'pass' } else { 'fail' }) "pid=$($DoctorState.pid) port=$DoctorPort owned=$DoctorOwned"
    if ($DoctorOwned) {
      try {
        $DoctorHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$DoctorPort/xiaoshe/desktop/status" -TimeoutSec 3
        $DoctorHealthReady = $DoctorHealth.bridge.state -eq 'ready' -and $DoctorHealth.modlens_available -eq $true
        Add-DoctorCheck 'service.health' $(if ($DoctorHealthReady) { 'pass' } else { 'fail' }) "bridge=$($DoctorHealth.bridge.state) platform=$($DoctorHealth.bridge.platform) modlens=$($DoctorHealth.modlens_available)"
      } catch { Add-DoctorCheck 'service.health' 'fail' $_.Exception.Message }
    }
  } catch { Add-DoctorCheck 'service.listener' 'fail' $_.Exception.Message }
}

$DeveloperModeDoctor = try {
  (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -ErrorAction Stop).AllowDevelopmentWithoutDevLicense
} catch { $null }
Add-DoctorCheck 'system.developer-mode' $(if ($DeveloperModeDoctor -eq 1) { 'pass' } else { 'warn' }) $(if ($DeveloperModeDoctor -eq 1) { 'enabled' } else { 'disabled; DSH symlink-heavy gates may return EPERM' })

$DoctorFailed = @($DoctorChecks | Where-Object { $_.status -eq 'fail' }).Count
$DoctorWarnings = @($DoctorChecks | Where-Object { $_.status -eq 'warn' }).Count
$DoctorReport = [ordered]@{
  schema = 'xiaoshe-windows-doctor/v1'
  platform = 'win32'
  xsRoot = $XsDoctorRoot
  ready = ($DoctorFailed -eq 0)
  failed = $DoctorFailed
  warnings = $DoctorWarnings
  checks = $DoctorChecks
  checkedAt = [DateTimeOffset]::Now.ToString('o')
}

if ($Json) {
  $DoctorReport | ConvertTo-Json -Depth 6
} else {
  Write-Host "Xiaoshe Windows doctor: ready=$($DoctorReport.ready) failed=$DoctorFailed warnings=$DoctorWarnings"
  $DoctorChecks | Format-Table id, status, detail -AutoSize -Wrap
}
if ($DoctorFailed -gt 0) { exit 1 }
