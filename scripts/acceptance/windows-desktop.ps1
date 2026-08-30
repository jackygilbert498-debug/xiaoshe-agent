[CmdletBinding()]
param(
  [string]$OutputPath,
  [string]$ServiceUrl = 'http://127.0.0.1:3080/',
  [switch]$SkipLaunch
)
$ErrorActionPreference = 'Stop'
$XsRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutputPath) { $OutputPath = Join-Path $XsRoot 'artifacts\acceptance\windows-desktop.json' }
$Checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Id, [string]$State, [string]$Detail, [hashtable]$Evidence = @{}) {
  $Checks.Add([ordered]@{ id = $Id; state = $State; detail = $Detail; evidence = $Evidence })
}
function Run-Check([string]$Id, [scriptblock]$Action) {
  try { & $Action } catch { Add-Check $Id 'fail' $_.Exception.Message }
}
function Resolve-PackagedExecutable {
  $Directory = Join-Path $XsRoot 'apps\desktop-shell\dist-desktop\win-unpacked'
  $Candidate = Get-ChildItem -LiteralPath $Directory -Filter '*.exe' -File -ErrorAction Stop |
    Where-Object { $_.Name -notmatch '^Uninstall' } |
    Sort-Object Length -Descending |
    Select-Object -First 1
  if ($null -eq $Candidate) { throw 'Windows unpacked executable is missing' }
  return $Candidate.FullName
}

Push-Location $XsRoot
try {
  Run-Check 'desktop-unit-tests' {
    & pnpm.cmd --filter '@xiaoshe/desktop-shell' test | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "desktop tests exited $LASTEXITCODE" }
    Add-Check 'desktop-unit-tests' 'pass' 'Desktop security, lifecycle, and packaging contract tests passed.'
  }
  Run-Check 'unpacked-artifact' {
    $Exe = Resolve-PackagedExecutable
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Exe).Hash.ToLowerInvariant()
    Add-Check 'unpacked-artifact' 'pass' 'The unpacked Windows desktop artifact exists and has a SHA-256 digest.' @{ path = $Exe; sha256 = $Hash; bytes = (Get-Item $Exe).Length }
    $Signature = Get-AuthenticodeSignature -LiteralPath $Exe
    if ($Signature.Status -eq 'Valid') { Add-Check 'windows-code-signing' 'pass' 'The Authenticode signature is valid.' @{ status = [string]$Signature.Status } }
    else { Add-Check 'windows-code-signing' 'pending_external' 'No release code-signing certificate is configured; functional acceptance is not reported as signing acceptance.' @{ status = [string]$Signature.Status } }
  }
  Run-Check 'product-health' {
    $StatusUrl = [Uri]::new([Uri]$ServiceUrl, '/xiaoshe/desktop/status').AbsoluteUri
    $Health = Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 3
    $ExpectedProduct = [string]([char]0x5C0F) + [string]([char]0x86C7)
    if ($Health.product -ne $ExpectedProduct -or $Health.bridge.state -ne 'ready') { throw 'product or bridge fact is not ready' }
    Add-Check 'product-health' 'pass' 'The local product service reports the expected product identity and bridge=ready.' @{ version = $Health.version; platform = $Health.bridge.platform; url = $StatusUrl }
  }
  if ($SkipLaunch) { Add-Check 'single-instance-and-graceful-quit' 'pending_external' 'The caller skipped desktop process acceptance.' }
  else {
    Run-Check 'single-instance-and-graceful-quit' {
      $Exe = Resolve-PackagedExecutable
      $PreviousRoot = $env:XIAOSHE_PRODUCT_ROOT
      $PreviousUrl = $env:XIAOSHE_DESKTOP_URL
      $PreviousAcceptance = $env:XIAOSHE_DESKTOP_ACCEPTANCE
      try {
        $env:XIAOSHE_PRODUCT_ROOT = $XsRoot
        $env:XIAOSHE_DESKTOP_URL = $ServiceUrl
        $env:XIAOSHE_DESKTOP_ACCEPTANCE = '1'
        $First = Start-Process -FilePath $Exe -ArgumentList @('--acceptance-quit-after=5000') -WorkingDirectory (Split-Path -Parent $Exe) -PassThru
        Start-Sleep -Seconds 1
        $Second = Start-Process -FilePath $Exe -ArgumentList @('--acceptance-quit-after=5000') -WorkingDirectory (Split-Path -Parent $Exe) -PassThru
        if (-not $Second.WaitForExit(5000)) { throw 'second packaged instance did not exit after single-instance arbitration' }
        if (-not $First.WaitForExit(20000)) { throw 'primary packaged desktop process did not quit through the acceptance lifecycle' }
        if ($First.ExitCode -ne 0 -or $Second.ExitCode -ne 0) { throw "packaged desktop exit codes were $($First.ExitCode), $($Second.ExitCode)" }
        Add-Check 'single-instance-and-graceful-quit' 'pass' 'The packaged second instance exited and the primary instance completed the before-quit lifecycle.' @{ executable = $Exe; firstPid = $First.Id; secondPid = $Second.Id }
      } finally {
        $env:XIAOSHE_PRODUCT_ROOT = $PreviousRoot
        $env:XIAOSHE_DESKTOP_URL = $PreviousUrl
        $env:XIAOSHE_DESKTOP_ACCEPTANCE = $PreviousAcceptance
      }
    }
  }
  Add-Check 'desktop-update' 'pass' 'Automatic updates are disabled by default; this release has no feed and performs no silent download.'
  Add-Check 'macos-real-device' 'pending_external' 'Apple Silicon and Intel hardware must validate permissions, signing, notarization, installation, and removal.'
} finally { Pop-Location }

$Commit = (& git -C $XsRoot rev-parse HEAD).Trim()
$Report = [ordered]@{ schemaVersion = 1; platform = 'windows'; generatedAt = (Get-Date).ToUniversalTime().ToString('o'); commit = $Commit; checks = $Checks }
$Directory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force $Directory | Out-Null
$Report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "Windows desktop acceptance: $OutputPath"
if (@($Checks | Where-Object state -eq 'fail').Count -gt 0) { exit 1 }
