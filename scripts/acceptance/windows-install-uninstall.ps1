[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$ExpectedInstallerSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedExecutableSha256,
  [Parameter(Mandatory = $true)][string]$ExpectedProductVersion,
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$ProductName = [string]([char]0x5C0F) + [string]([char]0x86C7)
$CheckId = 'windows-install-uninstall'
$UninstallRegistryKey = 'ba0f3e97-dae3-539b-9849-e666817b715c'
$EnvironmentHelper = Join-Path $PSScriptRoot 'windows-acceptance-environment.ps1'
if (-not (Test-Path -LiteralPath $EnvironmentHelper -PathType Leaf)) { throw 'Windows acceptance environment helper is missing.' }
. $EnvironmentHelper
if (-not $OutputPath) {
  $RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
  $OutputPath = Join-Path $RepositoryRoot 'artifacts\acceptance\windows-install-uninstall.json'
}

function Get-CanonicalPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
}

function Test-PathInside([string]$Root, [string]$Candidate) {
  $CanonicalRoot = Get-CanonicalPath $Root
  $CanonicalCandidate = Get-CanonicalPath $Candidate
  return $CanonicalCandidate.StartsWith(
    $CanonicalRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Get-ShortcutCandidates {
  $Desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
  $Programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
  return @(
    (Join-Path $Desktop "$ProductName.lnk"),
    (Join-Path $Programs "$ProductName.lnk")
  )
}

function Get-XiaosheUninstallRecords {
  $Paths = @(
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\$UninstallRegistryKey",
    "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\$UninstallRegistryKey",
    "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$UninstallRegistryKey"
  )
  $Records = [System.Collections.Generic.List[object]]::new()
  foreach ($Path in $Paths) {
    if (-not (Test-Path -LiteralPath $Path)) { continue }
    $Value = Get-ItemProperty -LiteralPath $Path -ErrorAction Stop
    $Records.Add([ordered]@{
      key = $Path
      displayName = [string]$Value.DisplayName
      displayVersion = [string]$Value.DisplayVersion
      uninstallString = [string]$Value.UninstallString
      quietUninstallString = [string]$Value.QuietUninstallString
    })
  }
  return @($Records)
}

function Assert-NoExistingInstallation {
  $DefaultExecutables = @(
    (Join-Path $env:LOCALAPPDATA "Programs\$ProductName\$ProductName.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Xiaoshe\$ProductName.exe")
  )
  $ExistingExecutables = @($DefaultExecutables | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  $ExistingShortcuts = @(Get-ShortcutCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  $ExistingRecords = @(Get-XiaosheUninstallRecords)
  if ($ExistingExecutables.Count -gt 0 -or $ExistingShortcuts.Count -gt 0 -or $ExistingRecords.Count -gt 0) {
    throw 'refusing to disturb an existing Xiaoshe installation'
  }
}

function Wait-PathAbsent([string]$Path, [int]$TimeoutSeconds = 20) {
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "path remains after uninstall: $Path"
}

function Get-VerifiedCreatedShortcuts([string]$InstallRoot, [string]$InstalledExecutable) {
  $Shell = New-Object -ComObject WScript.Shell
  $Verified = [System.Collections.Generic.List[string]]::new()
  foreach ($ShortcutPath in @(Get-ShortcutCandidates)) {
    if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
      throw "expected installer shortcut is missing: $ShortcutPath"
    }
    $Shortcut = $Shell.CreateShortcut($ShortcutPath)
    $Target = [string]$Shortcut.TargetPath
    if ([string]::IsNullOrWhiteSpace($Target) -or
        -not (Test-Path -LiteralPath $Target -PathType Leaf) -or
        (Get-CanonicalPath $Target) -ne (Get-CanonicalPath $InstalledExecutable)) {
      throw "installer shortcut does not target the exact installed executable: $ShortcutPath"
    }
    $Verified.Add($ShortcutPath)
  }
  return @($Verified)
}

function Get-VerifiedUninstallRecord($Records, [string]$Version, [string]$ExpectedUninstaller) {
  if (@($Records).Count -ne 1) { throw "expected one uninstall registry record, found $(@($Records).Count)." }
  $Record = @($Records)[0]
  $ExpectedDisplayName = "$ProductName $Version"
  if ($Record.displayName -ne $ExpectedDisplayName -or $Record.displayVersion -ne $Version) {
    throw 'the uninstall registry identity does not match the packaged product version.'
  }
  $EscapedUninstaller = [regex]::Escape((Get-CanonicalPath $ExpectedUninstaller))
  $Normal = [regex]::Match([string]$Record.uninstallString, ('^"' + $EscapedUninstaller + '" /(?<mode>currentuser|allusers)$'), [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  $Quiet = [regex]::Match([string]$Record.quietUninstallString, ('^"' + $EscapedUninstaller + '" /(?<mode>currentuser|allusers) /S$'), [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $Normal.Success -or -not $Quiet.Success -or $Normal.Groups['mode'].Value -ne $Quiet.Groups['mode'].Value) {
    throw 'the registered uninstall command does not point to the unique isolated uninstaller.'
  }
  return @{ record = $Record; mode = "/$($Quiet.Groups['mode'].Value)" }
}

function Remove-OwnedShortcut([string]$Path, [string]$InstallRoot) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  $Shell = New-Object -ComObject WScript.Shell
  $Shortcut = $Shell.CreateShortcut($Path)
  if (-not [string]::IsNullOrWhiteSpace([string]$Shortcut.TargetPath) -and
      (Test-PathInside -Root $InstallRoot -Candidate ([string]$Shortcut.TargetPath))) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
  }
}

function Invoke-CleanupStep([string]$Name, [scriptblock]$Action, $Failures) {
  try {
    & $Action
    return $true
  } catch {
    [void]$Failures.Add("$Name`: $($_.Exception.Message)")
    return $false
  }
}

function Get-FreeLoopbackPort {
  $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try { $Listener.Start(); return ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port }
  finally { $Listener.Stop() }
}

function Test-PortListening([int]$Port) {
  return @((Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)).Count -gt 0
}

function Wait-PortReleased([int]$Port, [int]$TimeoutSeconds = 15) {
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (-not (Test-PortListening $Port)) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "installed application did not release isolated port $Port"
}

function Invoke-InstalledApplicationLifecycle([string]$InstalledExecutable, [string]$ParentRoot) {
  $LifecycleRoot = Join-Path $ParentRoot 'lifecycle'
  $LifecycleTemp = Join-Path $LifecycleRoot 'temp'
  $UserDataRoot = Join-Path $LifecycleTemp "xiaoshe-windows-acceptance-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $LifecycleRoot,$LifecycleTemp,$UserDataRoot -ErrorAction Stop | Out-Null
  $Port = Get-FreeLoopbackPort
  $ServiceUrl = "http://127.0.0.1:$Port/"
  $OwnershipToken = [Guid]::NewGuid().ToString()
  $PreviousEnvironment = $null
  $Process = $null
  $RuntimeRoot = $null
  $OperationFailure = $null
  $CleanupFailures = [System.Collections.Generic.List[string]]::new()
  $ExitCode = $null
  try {
    $PreviousEnvironment = Enter-XiaosheAcceptanceEnvironment -CleanupRoot $LifecycleRoot -UserDataRoot $UserDataRoot -ServiceUrl $ServiceUrl -Port $Port
    $env:XIAOSHE_LAUNCH_TOKEN = $OwnershipToken
    $Arguments = @('--acceptance-hide-show', '--acceptance-quit-after=15000', "--user-data-dir=`"$UserDataRoot`"")
    $Process = Start-Process -FilePath $InstalledExecutable -ArgumentList $Arguments -WorkingDirectory (Split-Path -Parent $InstalledExecutable) -PassThru -WindowStyle Hidden
    if (-not $Process.WaitForExit(900000)) { throw 'installed application did not complete its acceptance lifecycle within 15 minutes.' }
    $ExitCode = $Process.ExitCode
    if ($ExitCode -ne 0) { throw "installed application exited $ExitCode." }
    $RuntimeParent = Join-Path $UserDataRoot 'runtime'
    $Candidates = @(Get-ChildItem -LiteralPath $RuntimeParent -Directory -Force -ErrorAction Stop | Where-Object {
      ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and
      (Test-Path -LiteralPath (Join-Path $_.FullName '.xiaoshe-product-runtime.json') -PathType Leaf)
    })
    if ($Candidates.Count -ne 1) { throw "installed application materialized $($Candidates.Count) runtime roots instead of one." }
    $RuntimeRoot = Get-CanonicalPath $Candidates[0].FullName
    if (-not (Test-PathInside -Root $UserDataRoot -Candidate $RuntimeRoot)) { throw 'installed runtime escaped isolated userData.' }
    $LogPath = Join-Path $UserDataRoot 'logs\desktop-shell.jsonl'
    $Rows = @(Get-Content -LiteralPath $LogPath -ErrorAction Stop | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_ | ConvertFrom-Json })
    $RequiredEvents = @('runtime-ready','service-ready','ui-renderer-ready','ui-ready','ui-visual-proof','shutdown-complete')
    foreach ($RequiredEvent in $RequiredEvents) {
      if (@($Rows | Where-Object event -eq $RequiredEvent).Count -eq 0) { throw "installed lifecycle log is missing $RequiredEvent." }
    }
    $VisualProof = $Rows | Where-Object event -eq 'ui-visual-proof' | Select-Object -First 1
    if ($VisualProof.nonBlank -ne $true) { throw 'installed application visual proof is blank.' }
    Wait-PortReleased $Port
  } catch {
    $OperationFailure = $_.Exception.Message
  } finally {
    [void](Invoke-CleanupStep 'installed application process cleanup' {
      if ($null -ne $Process) {
        $Process.Refresh()
        if (-not $Process.HasExited) { $Process.Kill(); if (-not $Process.WaitForExit(5000)) { throw 'installed application process could not be terminated.' } }
      }
    } $CleanupFailures)
    $ServiceReleased = Invoke-CleanupStep 'installed application service cleanup' {
      $StateName = if ($Port -eq 3080) { 'dsh-web-state.json' } else { "dsh-web-state-$Port.json" }
      $StatePath = Join-Path $env:LOCALAPPDATA "Xiaoshe\$StateName"
      if ((Test-Path -LiteralPath $StatePath -PathType Leaf) -or (Test-PortListening $Port)) {
        if ($null -eq $RuntimeRoot) {
          $RuntimeCandidates = @(Get-ChildItem -LiteralPath (Join-Path $UserDataRoot 'runtime') -Directory -Force -ErrorAction Stop | Where-Object {
            ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and
            (Test-Path -LiteralPath (Join-Path $_.FullName '.xiaoshe-product-runtime.json') -PathType Leaf)
          })
          if ($RuntimeCandidates.Count -ne 1) { throw 'cannot identify the single installed runtime for owned cleanup.' }
          $RuntimeRoot = Get-CanonicalPath $RuntimeCandidates[0].FullName
        }
        $StopEntry = Join-Path $RuntimeRoot 'scripts\windows-stop-entry.ps1'
        if (-not (Test-Path -LiteralPath $StopEntry -PathType Leaf)) { throw 'installed runtime stop entry is missing.' }
        $PowerShell = (Get-Process -Id $PID -ErrorAction Stop).Path
        & $PowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $StopEntry -OwnershipToken $OwnershipToken | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "installed runtime owned stop exited $LASTEXITCODE." }
      }
      Wait-PortReleased $Port
      if (Test-Path -LiteralPath $StatePath) { throw 'installed runtime state remains after cleanup.' }
    } $CleanupFailures
    $EnvironmentRestored = Invoke-CleanupStep 'installed application environment restore' {
      if ($null -ne $PreviousEnvironment) { Exit-XiaosheAcceptanceEnvironment -Previous $PreviousEnvironment }
    } $CleanupFailures
    [void](Invoke-CleanupStep 'installed application data cleanup' {
      if (-not $ServiceReleased -or -not $EnvironmentRestored) { throw "installed lifecycle data retained: $LifecycleRoot" }
      Remove-Item -LiteralPath $LifecycleRoot -Recurse -Force -ErrorAction Stop
      if (Test-Path -LiteralPath $LifecycleRoot) { throw "installed lifecycle data remains: $LifecycleRoot" }
    } $CleanupFailures)
  }
  if ($null -ne $OperationFailure) { $CleanupFailures.Insert(0, $OperationFailure) }
  if ($CleanupFailures.Count -gt 0) { throw ($CleanupFailures -join ' | ') }
  return @{ exitCode = $ExitCode; runtimeMaterialized = $true; visualProof = $true; port = $Port; portReleased = $true }
}

$Failure = $null
$CleanupFailures = [System.Collections.Generic.List[string]]::new()
$Installer = $null
$AcceptanceRoot = $null
$InstallRoot = $null
$Uninstaller = $null
$UninstallMode = '/currentuser'
$Evidence = [ordered]@{}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Windows NSIS acceptance can run only on Windows.'
  }
  if ($ExpectedInstallerSha256 -notmatch '^[a-fA-F0-9]{64}$' -or
      $ExpectedExecutableSha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw 'Expected SHA-256 values must contain exactly 64 hexadecimal characters.'
  }
  if ($ExpectedProductVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw 'Expected product version is invalid.'
  }
  $Installer = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
  if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw 'NSIS installer is missing.' }
  $ActualInstallerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant()
  if ($ActualInstallerHash -ne $ExpectedInstallerSha256.ToLowerInvariant()) {
    throw 'NSIS installer SHA-256 does not match the release manifest.'
  }

  Assert-NoExistingInstallation

  $TemporaryBase = Get-CanonicalPath ([System.IO.Path]::GetTempPath())
  $AcceptanceRoot = Get-CanonicalPath (Join-Path $TemporaryBase "xiaoshe-nsis-acceptance-$([Guid]::NewGuid().ToString('N'))")
  if (-not (Test-PathInside -Root $TemporaryBase -Candidate $AcceptanceRoot)) {
    throw "unsafe NSIS acceptance root: $AcceptanceRoot"
  }
  $InstallRoot = Join-Path $AcceptanceRoot 'installed'
  New-Item -ItemType Directory -Path $AcceptanceRoot -ErrorAction Stop | Out-Null

  # NSIS requires /D= to be the final argument; as the final option it also
  # accepts a path containing spaces without mutating a user's normal install.
  $InstallProcess = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$InstallRoot") -Wait -PassThru -WindowStyle Hidden
  if ($InstallProcess.ExitCode -ne 0) { throw "NSIS installer exited $($InstallProcess.ExitCode)." }

  $InstalledExecutable = Join-Path $InstallRoot "$ProductName.exe"
  if (-not (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf)) {
    throw "installed executable is missing: $InstalledExecutable"
  }
  $ActualExecutableHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InstalledExecutable).Hash.ToLowerInvariant()
  if ($ActualExecutableHash -ne $ExpectedExecutableSha256.ToLowerInvariant()) {
    throw 'installed executable SHA-256 does not match the release manifest.'
  }

  $UninstallCandidates = @(Get-ChildItem -LiteralPath $InstallRoot -Filter 'Uninstall*.exe' -File -ErrorAction Stop)
  if ($UninstallCandidates.Count -ne 1) {
    throw "expected exactly one NSIS uninstaller, found $($UninstallCandidates.Count)."
  }
  $Uninstaller = [string]$UninstallCandidates[0].FullName
  $CreatedShortcuts = @(Get-VerifiedCreatedShortcuts -InstallRoot $InstallRoot -InstalledExecutable $InstalledExecutable)
  $InstalledRecords = @(Get-XiaosheUninstallRecords)
  $RegisteredUninstaller = Get-VerifiedUninstallRecord -Records $InstalledRecords -Version $ExpectedProductVersion -ExpectedUninstaller $Uninstaller
  $UninstallMode = [string]$RegisteredUninstaller.mode

  $InstalledLifecycle = Invoke-InstalledApplicationLifecycle -InstalledExecutable $InstalledExecutable -ParentRoot $AcceptanceRoot

  $UninstallProcess = Start-Process -FilePath $Uninstaller -ArgumentList @($UninstallMode, '/S') -Wait -PassThru -WindowStyle Hidden
  if ($UninstallProcess.ExitCode -ne 0) { throw "NSIS uninstaller exited $($UninstallProcess.ExitCode)." }
  Wait-PathAbsent -Path $InstallRoot
  foreach ($ShortcutPath in $CreatedShortcuts) { Wait-PathAbsent -Path $ShortcutPath }
  if (@(Get-XiaosheUninstallRecords).Count -ne 0) { throw 'uninstall registry record remains after uninstall.' }

  $Evidence = [ordered]@{
    installer = $Installer
    installerSha256 = $ActualInstallerHash
    executableSha256 = $ActualExecutableHash
    isolatedInstallRoot = $InstallRoot
    installedLifecycleExitCode = [int]$InstalledLifecycle.exitCode
    installedRuntimeMaterialized = [bool]$InstalledLifecycle.runtimeMaterialized
    installedVisualProof = [bool]$InstalledLifecycle.visualProof
    installedPortReleased = [bool]$InstalledLifecycle.portReleased
    shortcutsCreatedAndRemoved = @($CreatedShortcuts)
    uninstallRegistryRemoved = $true
    installRootRemoved = $true
  }
} catch {
  $Failure = $_.Exception.Message
} finally {
  $UninstallReleased = Invoke-CleanupStep 'owned uninstaller and registry cleanup' {
    if ($null -ne $InstallRoot -and (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
      if ($null -eq $Uninstaller) {
        $Candidate = Get-ChildItem -LiteralPath $InstallRoot -Filter 'Uninstall*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $Candidate) { $Uninstaller = [string]$Candidate.FullName }
      }
      if ($null -eq $Uninstaller -or -not (Test-Path -LiteralPath $Uninstaller -PathType Leaf)) {
        throw "isolated installation retained because its owned uninstaller is unavailable: $InstallRoot"
      }
      $CleanupProcess = Start-Process -FilePath $Uninstaller -ArgumentList @($UninstallMode, '/S') -Wait -PassThru -WindowStyle Hidden
      if ($CleanupProcess.ExitCode -ne 0) { throw "cleanup uninstaller exited $($CleanupProcess.ExitCode)." }
      Wait-PathAbsent -Path $InstallRoot
    }
    if (@(Get-XiaosheUninstallRecords).Count -ne 0) { throw 'owned uninstall registry record remains after cleanup.' }
  } $CleanupFailures

  [void](Invoke-CleanupStep 'owned shortcut cleanup' {
    if ($null -ne $InstallRoot) {
      foreach ($ShortcutPath in @(Get-ShortcutCandidates)) { Remove-OwnedShortcut -Path $ShortcutPath -InstallRoot $InstallRoot }
    }
  } $CleanupFailures)

  [void](Invoke-CleanupStep 'isolated installation directory cleanup' {
    if ($null -ne $AcceptanceRoot -and (Test-Path -LiteralPath $AcceptanceRoot)) {
      if (-not $UninstallReleased) {
        throw "isolated installation retained because uninstall release was not verified: $AcceptanceRoot"
      }
      $TemporaryBase = Get-CanonicalPath ([System.IO.Path]::GetTempPath())
      if (-not (Test-PathInside -Root $TemporaryBase -Candidate $AcceptanceRoot)) {
        throw "refusing to remove unsafe NSIS acceptance root: $AcceptanceRoot"
      }
      Remove-Item -LiteralPath $AcceptanceRoot -Recurse -Force -ErrorAction Stop
    }
    if ($null -ne $AcceptanceRoot -and (Test-Path -LiteralPath $AcceptanceRoot)) {
      throw "NSIS acceptance root remains after cleanup: $AcceptanceRoot"
    }
  } $CleanupFailures)
}

$CleanupFailure = if ($CleanupFailures.Count -eq 0) { $null } else { $CleanupFailures -join ' | ' }
if ($null -eq $Failure -and $null -ne $CleanupFailure) { $Failure = $CleanupFailure }
elseif ($null -ne $Failure -and $null -ne $CleanupFailure) { $Failure = "$Failure Cleanup also failed: $CleanupFailure" }

if ($null -eq $Failure) {
  $Check = [ordered]@{
    id = 'windows-install-uninstall'
    state = 'pass'
    detail = 'The manifest-bound NSIS installer and uninstaller completed against an isolated custom installation.'
    evidence = $Evidence
  }
} else {
  $Check = [ordered]@{
    id = $CheckId
    state = 'fail'
    detail = $Failure
    evidence = $Evidence
  }
}
$Report = [ordered]@{
  schemaVersion = 1
  platform = 'windows'
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  checks = @($Check)
}
$OutputDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($OutputPath))
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$Report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "Windows NSIS acceptance: $OutputPath"
if ($Check.state -ne 'pass') { exit 1 }
