[CmdletBinding()]
param(
  [string]$OutputPath,
  [string]$ManifestPath,
  [switch]$SkipLaunch,
  [switch]$AllowPendingExternal
)
$ErrorActionPreference = 'Stop'
$XsRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$RunId = [guid]::NewGuid().ToString()
$RunStartedAt = (Get-Date).ToUniversalTime().ToString('o')
$EnvironmentHelper = Join-Path $PSScriptRoot 'windows-acceptance-environment.ps1'
if (-not (Test-Path -LiteralPath $EnvironmentHelper -PathType Leaf)) { throw 'Windows acceptance environment helper is missing.' }
$InstallUninstallScript = Join-Path $PSScriptRoot 'windows-install-uninstall.ps1'
if (-not (Test-Path -LiteralPath $InstallUninstallScript -PathType Leaf)) { throw 'Windows install/uninstall acceptance script is missing.' }
. $EnvironmentHelper
if (-not $OutputPath) { $OutputPath = Join-Path $XsRoot 'artifacts\acceptance\windows-desktop.json' }
if (-not $ManifestPath) { $ManifestPath = Join-Path $XsRoot 'apps\desktop-shell\dist-desktop\release-manifest.json' }
$Checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Id, [string]$State, [string]$Detail, [hashtable]$Evidence = @{}) {
  $Checks.Add([ordered]@{ id = $Id; state = $State; detail = $Detail; evidence = $Evidence })
}
function Run-Check([string]$Id, [scriptblock]$Action) {
  try { & $Action } catch { Add-Check $Id 'fail' $_.Exception.Message }
}
function Stop-AcceptanceProcessVerified([object]$Process, [string]$Name) {
  if ($null -eq $Process) { return }
  $Process.Refresh()
  if ($Process.HasExited) { return }
  try {
    $Process.Kill()
  } catch {
    $Process.Refresh()
    if (-not $Process.HasExited) { throw "$Name could not be terminated: $($_.Exception.Message)" }
  }
  if (-not $Process.WaitForExit(5000)) { throw "$Name did not exit after forced termination." }
  $Process.Refresh()
  if (-not $Process.HasExited) { throw "$Name did not exit after forced termination." }
}
function Remove-IsolatedUserDataVerified([string]$Path, [string]$TemporaryBase) {
  $FullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $FullBase = [System.IO.Path]::GetFullPath($TemporaryBase).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $RequiredPrefix = $FullBase + [System.IO.Path]::DirectorySeparatorChar
  if (-not $FullPath.StartsWith($RequiredPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing to remove userData outside the temporary base: $FullPath"
  }
  if (Test-Path -LiteralPath $FullPath) { Remove-Item -LiteralPath $FullPath -Recurse -Force -ErrorAction Stop }
  if (Test-Path -LiteralPath $FullPath) { throw "isolated acceptance userData still exists after removal: $FullPath" }
}
function Test-IsolatedPortListening([int]$Port) {
  return @((Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)).Count -gt 0
}
function Resolve-IsolatedRuntimeRoot([string]$UserDataRoot) {
  $CanonicalUserData = [System.IO.Path]::GetFullPath($UserDataRoot).TrimEnd('\')
  $RuntimeParent = Join-Path $CanonicalUserData 'runtime'
  if (-not (Test-Path -LiteralPath $RuntimeParent -PathType Container)) { throw "isolated runtime directory is missing: $RuntimeParent" }
  $Candidates = @(Get-ChildItem -LiteralPath $RuntimeParent -Directory -Force -ErrorAction Stop |
    Where-Object {
      ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and
      (Test-Path -LiteralPath (Join-Path $_.FullName '.xiaoshe-product-runtime.json') -PathType Leaf)
    })
  if ($Candidates.Count -ne 1) { throw "expected one isolated packaged runtime, found $($Candidates.Count)" }
  $CanonicalRuntime = [System.IO.Path]::GetFullPath($Candidates[0].FullName).TrimEnd('\')
  if (-not $CanonicalRuntime.StartsWith($CanonicalUserData + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "isolated runtime is outside userData: $CanonicalRuntime"
  }
  return $CanonicalRuntime
}
function Stop-IsolatedServiceVerified {
  param(
    [Parameter(Mandatory = $true)][string]$UserDataRoot,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$OwnershipToken,
    [string]$ProductRoot
  )
  $StateFileName = if ($Port -eq 3080) { 'dsh-web-state.json' } else { "dsh-web-state-$Port.json" }
  $StatePath = Join-Path $env:LOCALAPPDATA "Xiaoshe\$StateFileName"
  if ((Test-Path -LiteralPath $StatePath -PathType Leaf) -or (Test-IsolatedPortListening $Port)) {
    if ([string]::IsNullOrWhiteSpace($ProductRoot)) { $ProductRoot = Resolve-IsolatedRuntimeRoot $UserDataRoot }
    $StopEntry = Join-Path $ProductRoot 'scripts\windows-stop-entry.ps1'
    if (-not (Test-Path -LiteralPath $StopEntry -PathType Leaf)) { throw "isolated stop entry is missing: $StopEntry" }
    $PowerShell = (Get-Process -Id $PID -ErrorAction Stop).Path
    & $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StopEntry -OwnershipToken $OwnershipToken
    if ($LASTEXITCODE -ne 0) { throw "isolated owned service stop exited $LASTEXITCODE" }
  }
  $Deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    if (-not (Test-Path -LiteralPath $StatePath) -and -not (Test-IsolatedPortListening $Port)) {
      return @{ stateRemoved = $true; portReleased = $true; statePath = $StatePath }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "isolated service cleanup did not release state or port $Port"
}
function Resolve-PackagedExecutable {
  $Directory = Join-Path $XsRoot 'apps\desktop-shell\dist-desktop\win-unpacked'
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { $script:ArtifactPendingReason = 'The unpacked package directory is missing.'; return $null }
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { $script:ArtifactPendingReason = 'No release manifest binds the unpacked package to current source inputs.'; return $null }
  $Manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
  if ($Manifest.schema -ne 'xiaoshe-desktop-release/v1') { throw 'The release manifest schema is invalid.' }
  $Commit = (& git -C $XsRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $Manifest.git.commit -ne $Commit) { throw 'The release manifest does not match the current git commit.' }
  $Candidate = Get-ChildItem -LiteralPath $Directory -Filter '*.exe' -File -ErrorAction Stop |
    Where-Object { $_.Name -notmatch '^Uninstall' } |
    Sort-Object Length -Descending |
    Select-Object -First 1
  if ($null -eq $Candidate) { return $null }
  $ManifestRoot = Split-Path -Parent ([System.IO.Path]::GetFullPath($ManifestPath))
  $ExpectedExe = [System.IO.Path]::GetFullPath((Join-Path $ManifestRoot ([string]$Manifest.artifacts.executable.path)))
  if ($ExpectedExe -ne [System.IO.Path]::GetFullPath($Candidate.FullName)) { throw 'The release manifest executable path does not match the unpacked package.' }
  $ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Candidate.FullName).Hash.ToLowerInvariant()
  if ($ActualHash -ne [string]$Manifest.artifacts.executable.sha256) { throw 'The unpacked executable does not match the release manifest SHA-256.' }
  $script:ReleaseManifest = $Manifest
  return [string]$Candidate.FullName
}
function Get-IsolatedPort {
  $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $Listener.Start()
    return ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port
  } finally { $Listener.Stop() }
}
function Wait-ProductHealth([string]$ServiceUrl, [int]$TimeoutSeconds = 25) {
  $StatusUrl = [Uri]::new([Uri]$ServiceUrl, '/xiaoshe/desktop/status').AbsoluteUri
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      $Health = Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 2
      $ExpectedProduct = [string]([char]0x5C0F) + [string]([char]0x86C7)
      if ($Health.product -eq $ExpectedProduct -and $Health.bridge.state -eq 'ready') {
        return @{ health = $Health; url = $StatusUrl }
      }
    } catch { Start-Sleep -Milliseconds 250 }
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "isolated packaged service was not ready at $StatusUrl"
}
function Confirm-ReleaseManifest([string]$Exe) {
  $Verifier = Join-Path $XsRoot 'apps\desktop-shell\scripts\verify-artifact.mjs'
  $ManifestRoot = Split-Path -Parent ([System.IO.Path]::GetFullPath($ManifestPath))
  $Installer = [System.IO.Path]::GetFullPath((Join-Path $ManifestRoot ([string]$script:ReleaseManifest.artifacts.installer.path)))
  # The verifier only permits output under the artifact release directory.
  # Reserve a fresh child so rechecks never overwrite a release or prior report.
  $RecheckRoot = Join-Path $ManifestRoot ('.xiaoshe-release-recheck-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $RecheckRoot -ErrorAction Stop | Out-Null
  $Recheck = Join-Path $RecheckRoot 'release-manifest.json'
  $OriginalSnapshot = Join-Path $RecheckRoot 'original-manifest.json'
  try {
    # Bind reinspection to the manifest already resolved in memory, not a
    # second mutable read of the caller's manifest path.
    $script:ReleaseManifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $OriginalSnapshot -Encoding UTF8
    $VerifyArguments = @(
      $Verifier,
      '--repository-root', $XsRoot,
      '--package-dir', (Split-Path -Parent $Exe),
      '--installer', $Installer,
      '--expected-source-sha256', ([string]$script:ReleaseManifest.git.requiredSources.sha256),
      '--expected-app-asar-sha256', ([string]$script:ReleaseManifest.artifacts.appAsar.sha256),
      '--expected-executable-sha256', ([string]$script:ReleaseManifest.artifacts.executable.sha256),
      '--expected-installer-sha256', ([string]$script:ReleaseManifest.artifacts.installer.sha256),
      '--output', $Recheck
    )
    & node @VerifyArguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "release manifest recheck exited $LASTEXITCODE" }
    # The manifest collector independently invokes native Authenticode for
    # BOTH files. Do not discard that recheck or promote only the app signature.
    # Single quotes inside JavaScript survive Windows PowerShell 5.1 native
    # argument forwarding; embedded double quotes would be stripped by its C argv seam.
    $SigningProbe = 'import {readFileSync} from ''node:fs''; import {pathToFileURL} from ''node:url''; const [entry,before,after]=process.argv.slice(1); process.argv[1]=''windows-signing-recheck''; const {createWindowsSigningEvidence}=await import(pathToFileURL(entry).href); const read=p=>JSON.parse(readFileSync(p,''utf8'').replace(/^\uFEFF/u,'''')); process.stdout.write(JSON.stringify(createWindowsSigningEvidence(read(before),read(after))));'
    $SigningJson = & node --input-type=module -e $SigningProbe $Verifier $OriginalSnapshot $Recheck
    if ($LASTEXITCODE -ne 0) { throw "dual-artifact Authenticode recheck failed (exit $LASTEXITCODE)" }
    $script:SigningEvidence = $SigningJson | ConvertFrom-Json
  } finally {
    if (Test-Path -LiteralPath $OriginalSnapshot) { Remove-Item -LiteralPath $OriginalSnapshot -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $Recheck) { Remove-Item -LiteralPath $Recheck -Force -ErrorAction Stop }
    # Non-recursive cleanup refuses unexpected contents rather than deleting them.
    Remove-Item -LiteralPath $RecheckRoot -ErrorAction Stop
  }
}
function Invoke-InstallUninstallAcceptance {
  $ManifestRoot = Split-Path -Parent ([System.IO.Path]::GetFullPath($ManifestPath))
  $Installer = [System.IO.Path]::GetFullPath((Join-Path $ManifestRoot ([string]$script:ReleaseManifest.artifacts.installer.path)))
  $ChildReportPath = Join-Path $XsRoot 'artifacts\acceptance\windows-install-uninstall.json'
  $PowerShell = (Get-Process -Id $PID -ErrorAction Stop).Path
  $ProductVersion = [string](Get-Content -Raw -LiteralPath (Join-Path $XsRoot 'apps\desktop-shell\package.json') | ConvertFrom-Json).version
  Remove-Item -LiteralPath $ChildReportPath -Force -ErrorAction SilentlyContinue
  & $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $InstallUninstallScript `
    -InstallerPath $Installer `
    -ExpectedInstallerSha256 ([string]$script:ReleaseManifest.artifacts.installer.sha256) `
    -ExpectedExecutableSha256 ([string]$script:ReleaseManifest.artifacts.executable.sha256) `
    -ExpectedProductVersion $ProductVersion `
    -OutputPath $ChildReportPath
  $ChildExitCode = $LASTEXITCODE
  if (-not (Test-Path -LiteralPath $ChildReportPath -PathType Leaf)) {
    throw "Windows install/uninstall acceptance did not produce a report (exit $ChildExitCode)."
  }
  $ChildReport = Get-Content -Raw -LiteralPath $ChildReportPath | ConvertFrom-Json
  $ChildChecks = @($ChildReport.checks)
  if ($ChildReport.platform -ne 'windows' -or $ChildChecks.Count -ne 1 -or $ChildChecks[0].id -ne 'windows-install-uninstall') {
    throw 'Windows install/uninstall acceptance report is invalid.'
  }
  $ChildCheck = $ChildChecks[0]
  if (($ChildExitCode -eq 0 -and $ChildCheck.state -ne 'pass') -or
      ($ChildExitCode -ne 0 -and $ChildCheck.state -ne 'fail')) {
    throw "Windows install/uninstall acceptance exit $ChildExitCode disagrees with report state $($ChildCheck.state)."
  }
  $Checks.Add([ordered]@{
    id = 'windows-install-uninstall'
    state = [string]$ChildCheck.state
    detail = [string]$ChildCheck.detail
    evidence = $ChildCheck.evidence
  })
}

Push-Location $XsRoot
try {
  Run-Check 'desktop-unit-tests' {
    & pnpm.cmd --filter '@xiaoshe/desktop-shell' test | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "desktop tests exited $LASTEXITCODE" }
    Add-Check 'desktop-unit-tests' 'pass' 'Desktop security, lifecycle, and packaging contract tests passed.'
  }
  $Exe = $null
  $ArtifactResolutionFailed = $false
  try { $Exe = Resolve-PackagedExecutable } catch { $ArtifactResolutionFailed = $true; Add-Check 'release-manifest' 'fail' $_.Exception.Message }
  if ($null -eq $Exe) {
    if (-not $ArtifactResolutionFailed) { Add-Check 'release-manifest' 'pending_external' $script:ArtifactPendingReason }
    Add-Check 'unpacked-artifact' 'pending_external' 'No manifest-bound current Windows build is available; script contracts were tested without claiming packaged acceptance.'
    Add-Check 'windows-code-signing' 'pending_external' 'No current executable is available for Authenticode inspection.'
  } else {
    Run-Check 'unpacked-artifact' {
    $Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Exe).Hash.ToLowerInvariant()
    Add-Check 'unpacked-artifact' 'pass' 'The unpacked Windows desktop artifact exists and has a SHA-256 digest.' @{ path = $Exe; sha256 = $Hash; bytes = (Get-Item $Exe).Length }
    }
  }
  $script:ReleaseVerified = $false
  $script:SigningEvidence = $null
  if ($null -ne $Exe -and -not $SkipLaunch) {
    Run-Check 'release-manifest' {
      Confirm-ReleaseManifest $Exe
      $script:ReleaseVerified = $true
      Add-Check 'release-manifest' 'pass' 'The release manifest was regenerated from clean current sources and matched every packaged identity.' @{
        path = $ManifestPath
        sourceCommit = [string]$script:ReleaseManifest.git.commit
        sourceSha256 = [string]$script:ReleaseManifest.git.requiredSources.sha256
        executableSha256 = [string]$script:ReleaseManifest.artifacts.executable.sha256
        installerSha256 = [string]$script:ReleaseManifest.artifacts.installer.sha256
      }
    }
  } elseif ($null -ne $Exe) {
    Add-Check 'release-manifest' 'pending_external' 'The caller skipped the clean-source and packaged-identity recheck.' @{ path = $ManifestPath }
  }
  if ($null -ne $Exe) {
    if ($script:ReleaseVerified -and $null -ne $script:SigningEvidence) {
      Add-Check 'windows-code-signing' 'pass' 'Both EXE and NSIS installer have native Valid Authenticode signatures, with unchanged bytes and one pinned signer across reinspection.' @{
        schema = [string]$script:SigningEvidence.schema
        platform = [string]$script:SigningEvidence.platform
        collector = [string]$script:SigningEvidence.collector
        sourceCommit = [string]$script:SigningEvidence.sourceCommit
        sourceSha256 = [string]$script:SigningEvidence.sourceSha256
        original = $script:SigningEvidence.original
        rechecked = $script:SigningEvidence.rechecked
      }
    } else {
      Add-Check 'windows-code-signing' 'pending_external' 'No complete original-and-rechecked native signing proof exists for both EXE and NSIS installer.'
    }
  }
  if ($SkipLaunch -or $null -eq $Exe -or -not $script:ReleaseVerified) {
    Add-Check 'windows-install-uninstall' 'pending_external' 'The manifest-bound NSIS installer and uninstaller were not executed.'
  } else {
    Run-Check 'windows-install-uninstall' { Invoke-InstallUninstallAcceptance }
  }
  if ($SkipLaunch -or $null -eq $Exe -or -not $script:ReleaseVerified) {
    Add-Check 'product-health' 'pending_external' 'The isolated packaged service was not launched.'
    Add-Check 'embedded-runtime-startup' 'pending_external' 'The embedded runtime was not launched.'
    Add-Check 'single-instance-and-graceful-quit' 'pending_external' 'The packaged process lifecycle was not launched.'
  }
  else {
    Run-Check 'single-instance-and-graceful-quit' {
      $AcceptancePort = Get-IsolatedPort
      $ServiceUrl = "http://127.0.0.1:$AcceptancePort/"
      $TemporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
      $CleanupRoot = [System.IO.Path]::GetFullPath((Join-Path $TemporaryBase "xiaoshe-windows-acceptance-cleanup-$([Guid]::NewGuid().ToString('N'))"))
      $AcceptanceTemp = Join-Path $CleanupRoot 'temp'
      $UserDataRoot = [System.IO.Path]::GetFullPath((Join-Path $AcceptanceTemp "xiaoshe-windows-acceptance-$([Guid]::NewGuid().ToString('N'))"))
      if (-not $CleanupRoot.StartsWith($TemporaryBase, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe acceptance cleanup path' }
      New-Item -ItemType Directory -Path $CleanupRoot,$AcceptanceTemp,$UserDataRoot -ErrorAction Stop | Out-Null
      $First = $null
      $Second = $null
      $PreviousEnvironment = $null
      $LifecycleEvidence = $null
      $Materialized = $null
      $OwnershipToken = [Guid]::NewGuid().ToString()
      $AcceptanceFailure = $null
      $CleanupFailures = [System.Collections.Generic.List[Exception]]::new()
      try {
        $PreviousEnvironment = Enter-XiaosheAcceptanceEnvironment -CleanupRoot $CleanupRoot -UserDataRoot $UserDataRoot -ServiceUrl $ServiceUrl -Port $AcceptancePort
        $env:XIAOSHE_LAUNCH_TOKEN = $OwnershipToken
        $Arguments = @('--acceptance-quit-after=15000', "--user-data-dir=`"$UserDataRoot`"")
        $First = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory (Split-Path -Parent $Exe) -PassThru -WindowStyle Hidden
        $Ready = Wait-ProductHealth $ServiceUrl
        Add-Check 'product-health' 'pass' 'The isolated packaged service reports the expected product and ready bridge.' @{ version = $Ready.health.version; platform = $Ready.health.bridge.platform; url = $Ready.url; port = $AcceptancePort }
        $RuntimeParent = Join-Path $UserDataRoot 'runtime'
        $Materialized = Get-ChildItem -LiteralPath $RuntimeParent -Directory -ErrorAction Stop |
          Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '.xiaoshe-product-runtime.json') -PathType Leaf } |
          Sort-Object LastWriteTimeUtc -Descending |
          Select-Object -First 1
        if ($null -eq $Materialized) { throw "embedded runtime was not materialized under isolated userData: $RuntimeParent" }
        Add-Check 'embedded-runtime-startup' 'pass' 'The packaged application started from embedded resources and materialized runtime under isolated userData.' @{ userData = $UserDataRoot; runtime = $Materialized.FullName; productRootOverride = 'unset' }
        Start-Sleep -Seconds 1
        $Second = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory (Split-Path -Parent $Exe) -PassThru -WindowStyle Hidden
        if (-not $Second.WaitForExit(5000)) { throw 'second packaged instance did not exit after single-instance arbitration' }
        if (-not $First.WaitForExit(25000)) { throw 'primary packaged desktop process did not quit through the acceptance lifecycle' }
        if ($First.ExitCode -ne 0 -or $Second.ExitCode -ne 0) { throw "packaged desktop exit codes were $($First.ExitCode), $($Second.ExitCode)" }
        $LifecycleEvidence = @{ executable = $Exe; firstPid = $First.Id; secondPid = $Second.Id; port = $AcceptancePort; userData = $UserDataRoot }
      } catch {
        $AcceptanceFailure = $_.Exception
      } finally {
        try { Stop-AcceptanceProcessVerified -Process $Second -Name 'secondary packaged desktop process' }
        catch { $CleanupFailures.Add($_.Exception) }
        try { Stop-AcceptanceProcessVerified -Process $First -Name 'primary packaged desktop process' }
        catch { $CleanupFailures.Add($_.Exception) }
        $ServiceReleased = $false
        try {
          $ProductRoot = if ($null -eq $Materialized) { $null } else { [string]$Materialized.FullName }
          $ServiceCleanup = Stop-IsolatedServiceVerified -UserDataRoot $UserDataRoot -Port $AcceptancePort -OwnershipToken $OwnershipToken -ProductRoot $ProductRoot
          $ServiceReleased = $true
          if ($null -ne $LifecycleEvidence) {
            $LifecycleEvidence.serviceStateRemoved = [bool]$ServiceCleanup.stateRemoved
            $LifecycleEvidence.portReleased = [bool]$ServiceCleanup.portReleased
          }
        } catch { $CleanupFailures.Add($_.Exception) }
        if ($null -ne $PreviousEnvironment) {
          try { Exit-XiaosheAcceptanceEnvironment -Previous $PreviousEnvironment }
          catch { $CleanupFailures.Add($_.Exception) }
        }
        try {
          if (-not $ServiceReleased) { throw "isolated userData retained because owned service release was not verified: $CleanupRoot" }
          Remove-IsolatedUserDataVerified -Path $CleanupRoot -TemporaryBase $TemporaryBase
        }
        catch { $CleanupFailures.Add($_.Exception) }
      }
      if ($null -ne $AcceptanceFailure) { $CleanupFailures.Insert(0, $AcceptanceFailure) }
      if ($CleanupFailures.Count -gt 0) {
        throw [System.AggregateException]::new('Packaged desktop acceptance or its verified cleanup failed.', $CleanupFailures.ToArray())
      }
      Add-Check 'single-instance-and-graceful-quit' 'pass' 'The isolated packaged second instance exited, the primary completed the before-quit lifecycle, and cleanup was verified.' $LifecycleEvidence
    }
  }
  Add-Check 'desktop-update' 'pass' 'Automatic updates are disabled by default; this release has no feed and performs no silent download.'
} finally { Pop-Location }

$Commit = (& git -C $XsRoot rev-parse HEAD).Trim()
$WorkingTreeDirty = -not [string]::IsNullOrWhiteSpace((& git -C $XsRoot status --porcelain --untracked-files=all | Out-String).Trim())
$Report = [ordered]@{
  schemaVersion = 1
  platform = 'windows'
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  runId = $RunId
  runStartedAt = $RunStartedAt
  commit = $Commit
  workingTreeDirty = $WorkingTreeDirty
  checks = $Checks
}
$Directory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force $Directory | Out-Null
$Report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "Windows desktop acceptance: $OutputPath"
$Failed = @($Checks | Where-Object state -eq 'fail').Count
$Pending = @($Checks | Where-Object state -eq 'pending_external').Count
if ($Failed -gt 0 -or ($Pending -gt 0 -and -not $AllowPendingExternal)) { exit 1 }
