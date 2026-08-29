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
$Owner = 'xiaoshe.s-command'
$ManifestName = '.xiaoshe-s-manifest.json'
$RollbackShimName = '.xiaoshe-s-rollback.cmd'
$RollbackManifestName = '.xiaoshe-s-rollback.json'
$JournalName = '.xiaoshe-s-transaction.json'
$OwnedNames = @('S.cmd', $ManifestName, $RollbackShimName, $RollbackManifestName)
$TransactionNames = @($OwnedNames + $JournalName)
$MaxJournalFileBytes = 1048576
$MaxPathBytes = 131072
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-AbsolutePath([string]$Path) { [IO.Path]::GetFullPath($Path) }

function Assert-NoReparseComponents([string]$Path) {
    $current = Get-AbsolutePath $Path
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Install path contains a reparse point; refusing the operation.'
            }
        }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-SafeRoot([string]$Root) {
    $full = Get-AbsolutePath $Root
    Assert-NoReparseComponents $full
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw 'Install root is unavailable.' }
    return $full
}

function Get-SafeChild([string]$Root, [string]$Name) {
    if ($Name -notin $TransactionNames) { throw 'Unexpected installer-owned filename.' }
    $rootFull = Assert-SafeRoot $Root
    $candidate = Get-AbsolutePath (Join-Path $rootFull $Name)
    if (-not $candidate.StartsWith($rootFull.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installer target escapes the install root.'
    }
    if (Test-Path -LiteralPath $candidate) { Assert-NoReparseComponents $candidate }
    return $candidate
}

function Assert-LeafOrAbsent([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        Assert-NoReparseComponents $Path
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            throw 'Installer target has an unexpected structure.'
        }
    }
}

function Assert-TransactionTargets([string]$Root) {
    foreach ($name in $TransactionNames) {
        Assert-LeafOrAbsent (Get-SafeChild $Root $name)
    }
}

function Get-HashBytes([byte[]]$Bytes) {
    'sha256:' + ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
}
function Get-HashText([string]$Text) { Get-HashBytes $Utf8NoBom.GetBytes($Text) }
function Get-OwnedHash([string]$Path) { 'sha256:' + (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Write-DurableBytes([string]$Root, [string]$Name, [byte[]]$Bytes) {
    $path = Get-SafeChild $Root $Name
    Assert-LeafOrAbsent $path
    $temporary = Get-SafeChild $Root $JournalName
    $temporary = $temporary + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        if (Test-Path -LiteralPath $temporary) { throw 'Installer staging target already exists.' }
        $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Assert-LeafOrAbsent $temporary
        if ((Get-HashBytes ([IO.File]::ReadAllBytes($temporary))) -ne (Get-HashBytes $Bytes)) { throw 'Staged file hash verification failed.' }
        Assert-SafeRoot $Root | Out-Null
        Assert-LeafOrAbsent $path
        Move-Item -LiteralPath $temporary -Destination $path -Force
        Assert-LeafOrAbsent $path
        if ((Get-OwnedHash $path) -ne (Get-HashBytes $Bytes)) { throw 'Committed file hash verification failed.' }
    }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Write-DurableJson([string]$Root, [string]$Name, [object]$Value) {
    Write-DurableBytes $Root $Name $Utf8NoBom.GetBytes((($Value | ConvertTo-Json -Depth 8) + "`r`n"))
}

function Read-Json([string]$Root, [string]$Name) {
    $path = Get-SafeChild $Root $Name
    try { Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'Installer metadata is missing or corrupt.' }
}

function Read-OwnedManifest([string]$Root, [string]$Name, [string]$ExpectedFile) {
    $record = Read-Json $Root $Name
    if ($record.schema_version -ne 1 -or $record.owner -ne $Owner -or
        @($record.files).Count -ne 1 -or $record.files[0].relative_path -ne $ExpectedFile -or
        -not ($record.files[0].sha256 -match '^sha256:[0-9a-f]{64}$')) { throw 'Owned installation manifest is invalid.' }
    if ($null -ne $record.path_management) {
        $pm = $record.path_management
        if ($pm.added -isnot [bool] -or $pm.before_b64 -isnot [string] -or
            $pm.installed_hash -isnot [string] -or -not ($pm.installed_hash -match '^sha256:[0-9a-f]{64}$')) {
            throw 'Owned installation manifest is invalid.'
        }
        try { $beforeBytes = [Convert]::FromBase64String([string]$pm.before_b64) }
        catch { throw 'Owned installation manifest is invalid.' }
        if ($beforeBytes.Length -gt $MaxPathBytes) { throw 'Owned installation manifest is invalid.' }
    }
    return $record
}

function Assert-OwnedFile([string]$Root, [object]$Manifest) {
    $path = Get-SafeChild $Root ([string]$Manifest.files[0].relative_path)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-OwnedHash $path) -ne [string]$Manifest.files[0].sha256) {
        throw 'An owned installer file is missing or modified.'
    }
    return $path
}

function Get-ManagedPath {
    if (-not [string]::IsNullOrWhiteSpace($PathStore)) {
        if (Test-Path -LiteralPath $PathStore -PathType Leaf) { return [IO.File]::ReadAllText((Get-AbsolutePath $PathStore), [Text.Encoding]::UTF8) }
        return ''
    }
    return [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Assert-ManagedPathTarget {
    if (-not [string]::IsNullOrWhiteSpace($PathStore)) {
        $target = Get-AbsolutePath $PathStore
        $parent = Split-Path -Parent $target
        Assert-NoReparseComponents $parent
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'PATH store parent is unavailable.' }
        Assert-LeafOrAbsent $target
    }
}
function Set-ManagedPath([string]$Value) {
    if (-not [string]::IsNullOrWhiteSpace($PathStore)) {
        $target = Get-AbsolutePath $PathStore
        Assert-ManagedPathTarget
        [IO.File]::WriteAllText($target, $Value, $Utf8NoBom)
    } else { [Environment]::SetEnvironmentVariable('Path', $Value, 'User') }
}

function Test-ManagedPathContains([string]$Value, [string]$Expected) {
    foreach ($segment in @($Value -split ';')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        try {
            $expanded = [Environment]::ExpandEnvironmentVariables($segment.Trim().Trim('"'))
            if ((Get-AbsolutePath $expanded) -eq (Get-AbsolutePath $Expected)) { return $true }
        } catch { continue }
    }
    return $false
}

function Get-ManagedPathMatchCount([string]$Value, [string]$Expected) {
    $count = 0
    foreach ($segment in @($Value -split ';')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        try {
            $expanded = [Environment]::ExpandEnvironmentVariables($segment.Trim().Trim('"'))
            if ((Get-AbsolutePath $expanded) -eq (Get-AbsolutePath $Expected)) { $count++ }
        } catch { continue }
    }
    return $count
}

function Remove-ManagedPathEntry([string]$Value, [string]$OwnedPath) {
    $kept = @()
    foreach ($segment in @($Value -split ';')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        $matches = $false
        try {
            $expanded = [Environment]::ExpandEnvironmentVariables($segment.Trim().Trim('"'))
            $matches = (Get-AbsolutePath $expanded) -eq (Get-AbsolutePath $OwnedPath)
        } catch { $matches = $false }
        if (-not $matches) { $kept += $segment }
    }
    return ($kept -join ';')
}

function Remove-OneManagedPathEntry([string]$Value, [string]$OwnedPath) {
    $kept = @()
    $removed = $false
    foreach ($segment in @($Value -split ';')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        $matches = $false
        try {
            $expanded = [Environment]::ExpandEnvironmentVariables($segment.Trim().Trim('"'))
            $matches = (Get-AbsolutePath $expanded) -eq (Get-AbsolutePath $OwnedPath)
        } catch { $matches = $false }
        if ($matches -and -not $removed) { $removed = $true; continue }
        $kept += $segment
    }
    return ($kept -join ';')
}

function New-Manifest([string]$Version, [string]$File, [string]$Hash, [object]$PathManagement) {
    [ordered]@{ schema_version=1; owner=$Owner; version=$Version; files=@([ordered]@{relative_path=$File;sha256=$Hash}); path_management=$PathManagement }
}

function Snapshot-File([string]$Root, [string]$Name) {
    $path = Get-SafeChild $Root $Name
    Assert-LeafOrAbsent $path
    [byte[]]$bytes = @()
    if (Test-Path -LiteralPath $path -PathType Leaf) { $bytes = [IO.File]::ReadAllBytes($path) }
    [ordered]@{
        name=$Name
        exists=(Test-Path -LiteralPath $path -PathType Leaf)
        data=[Convert]::ToBase64String($bytes)
        byte_length=$bytes.Length
        sha256=(Get-HashBytes $bytes)
    }
}

function Begin-Transaction([string]$Root, [string]$PathOperation, [string]$InstallerWrittenPath) {
    Assert-TransactionTargets $Root
    Assert-ManagedPathTarget
    if ($PathOperation -notin @('none','add','remove')) { throw 'Invalid transaction PATH operation.' }
    $journalPath = Get-SafeChild $Root $JournalName
    if (Test-Path -LiteralPath $journalPath) { throw 'An unresolved transaction journal already exists.' }
    $pathValue = Get-ManagedPath
    if ($pathValue -isnot [string]) { $pathValue = '' }
    $pathBytes = $Utf8NoBom.GetBytes($pathValue)
    if ($InstallerWrittenPath -isnot [string]) { $InstallerWrittenPath = $pathValue }
    $writtenPathBytes = $Utf8NoBom.GetBytes($InstallerWrittenPath)
    if ($pathBytes.Length -gt $MaxPathBytes -or $writtenPathBytes.Length -gt $MaxPathBytes) { throw 'Managed PATH is too large to journal safely.' }
    $journal = [ordered]@{
        schema_version=1
        owner=$Owner
        files=@($OwnedNames | ForEach-Object { Snapshot-File $Root $_ })
        path_value=$pathValue
        path_byte_length=$pathBytes.Length
        pre_path_hash=(Get-HashBytes $pathBytes)
        path_operation=$PathOperation
        owned_bin_dir=$Root
        installer_written_path=$InstallerWrittenPath
        installer_written_path_byte_length=$writtenPathBytes.Length
        installer_written_path_hash=(Get-HashBytes $writtenPathBytes)
    }
    Write-DurableJson $Root $JournalName $journal
}

function Recover-Transaction([string]$Root) {
    $journalPath = Get-SafeChild $Root $JournalName
    if (-not (Test-Path -LiteralPath $journalPath -PathType Leaf)) {
        return [pscustomobject]@{
            respect_owned_path_removal=$false
            continue_path_ownership=$false
            ownership_before=''
            ownership_installed_hash=''
        }
    }
    Assert-TransactionTargets $Root
    Assert-ManagedPathTarget
    if ((Get-Item -LiteralPath $journalPath -Force).Length -gt $MaxJournalFileBytes) { throw 'Transaction journal is invalid.' }
    $journal = Read-Json $Root $JournalName
    if ($journal.path_value -isnot [string] -or $journal.path_byte_length -isnot [ValueType] -or
        $journal.pre_path_hash -isnot [string] -or -not ($journal.pre_path_hash -match '^sha256:[0-9a-f]{64}$') -or
        $journal.path_operation -isnot [string] -or $journal.path_operation -notin @('none','add','remove') -or
        $journal.owned_bin_dir -isnot [string] -or $journal.installer_written_path -isnot [string] -or
        $journal.installer_written_path_byte_length -isnot [ValueType] -or
        $journal.installer_written_path_hash -isnot [string] -or
        -not ($journal.installer_written_path_hash -match '^sha256:[0-9a-f]{64}$')) {
        throw 'Transaction journal is invalid.'
    }
    $pathBytes = $Utf8NoBom.GetBytes([string]$journal.path_value)
    if ($pathBytes.Length -gt $MaxPathBytes -or [long]$journal.path_byte_length -ne $pathBytes.Length -or
        (Get-HashBytes $pathBytes) -ne [string]$journal.pre_path_hash) { throw 'Transaction journal is invalid.' }
    $writtenPathBytes = $Utf8NoBom.GetBytes([string]$journal.installer_written_path)
    if ($writtenPathBytes.Length -gt $MaxPathBytes -or
        [long]$journal.installer_written_path_byte_length -ne $writtenPathBytes.Length -or
        (Get-HashBytes $writtenPathBytes) -ne [string]$journal.installer_written_path_hash -or
        (Get-AbsolutePath ([string]$journal.owned_bin_dir)) -ne (Get-AbsolutePath $Root)) {
        throw 'Transaction journal is invalid.'
    }
    if ($journal.path_operation -eq 'none' -and $journal.installer_written_path_hash -ne $journal.pre_path_hash) {
        throw 'Transaction journal is invalid.'
    }
    $journalNames = @($journal.files | ForEach-Object { [string]$_.name } | Sort-Object)
    $expectedNames = @($OwnedNames | Sort-Object)
    if ($journal.schema_version -ne 1 -or $journal.owner -ne $Owner -or
        @($journal.files).Count -ne $OwnedNames.Count -or ($journalNames -join "`n") -ne ($expectedNames -join "`n")) { throw 'Transaction journal is invalid.' }
    $decoded = @()
    foreach ($snapshot in @($journal.files)) {
        if ($snapshot.name -isnot [string] -or $snapshot.name -notin $OwnedNames -or
            $snapshot.exists -isnot [bool] -or $snapshot.data -isnot [string] -or
            $snapshot.byte_length -isnot [ValueType] -or $snapshot.sha256 -isnot [string] -or
            -not ($snapshot.sha256 -match '^sha256:[0-9a-f]{64}$')) { throw 'Transaction journal is invalid.' }
        [void](Get-SafeChild $Root ([string]$snapshot.name))
        try { $bytes = [Convert]::FromBase64String([string]$snapshot.data) }
        catch { throw 'Transaction journal is invalid.' }
        if ($bytes.Length -gt $MaxJournalFileBytes -or [long]$snapshot.byte_length -ne $bytes.Length -or
            (Get-HashBytes $bytes) -ne [string]$snapshot.sha256 -or
            (-not [bool]$snapshot.exists -and $bytes.Length -ne 0)) { throw 'Transaction journal is invalid.' }
        $decoded += [pscustomobject]@{name=[string]$snapshot.name;exists=[bool]$snapshot.exists;bytes=$bytes}
    }
    $currentPath = Get-ManagedPath
    if ($currentPath -isnot [string]) { $currentPath = '' }
    $currentPathHash = Get-HashText $currentPath
    $respectOwnedPathRemoval = $false
    $continuePathOwnership = $false
    $ownershipBefore = ''
    $ownershipInstalledHash = ''
    $recoveryPath = $currentPath
    $shouldWriteRecoveryPath = $false
    if ($journal.path_operation -eq 'none') {
        $recoveryPath = $currentPath
    } elseif ($currentPathHash -eq [string]$journal.installer_written_path_hash) {
        $recoveryPath = [string]$journal.path_value
        $shouldWriteRecoveryPath = $true
    } elseif ($currentPathHash -eq [string]$journal.pre_path_hash) {
        $respectOwnedPathRemoval = $journal.path_operation -eq 'add'
    } elseif ($journal.path_operation -eq 'add') {
        $ownedCount = Get-ManagedPathMatchCount $currentPath $Root
        if ($ownedCount -gt 1) { throw 'PATH contains multiple owned entries after an interrupted install; manual resolution is required.' }
        if ($ownedCount -eq 1) {
            $continuePathOwnership = $true
            $ownershipBefore = Remove-OneManagedPathEntry $currentPath $Root
            $ownershipInstalledHash = $currentPathHash
        } else {
            $respectOwnedPathRemoval = $true
        }
    } else {
        throw 'PATH changed after an interrupted uninstall; refusing to overwrite user changes.'
    }
    foreach ($snapshot in $decoded) {
        $path = Get-SafeChild $Root $snapshot.name
        if ($snapshot.exists) { Write-DurableBytes $Root $snapshot.name $snapshot.bytes }
        elseif (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    if ($shouldWriteRecoveryPath) { Set-ManagedPath $recoveryPath }
    Remove-Item -LiteralPath (Get-SafeChild $Root $JournalName) -Force
    return [pscustomobject]@{
        respect_owned_path_removal=$respectOwnedPathRemoval
        continue_path_ownership=$continuePathOwnership
        ownership_before=$ownershipBefore
        ownership_installed_hash=$ownershipInstalledHash
    }
}

function Invoke-Failure([string]$Step) {
    if ($env:XIAOSHE_INSTALL_FAIL_STEP -eq $Step) { throw "Injected installer failure: $Step" }
}

if ([string]::IsNullOrWhiteSpace($BinDir)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA is unavailable; pass -BinDir explicitly.' }
    $BinDir = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'
}
$binPath = Get-AbsolutePath $BinDir
Assert-NoReparseComponents $binPath
[IO.Directory]::CreateDirectory($binPath) | Out-Null
$binPath = Assert-SafeRoot $binPath
Assert-TransactionTargets $binPath
Assert-ManagedPathTarget
$recovery = Recover-Transaction $binPath

$manifestPath = Get-SafeChild $binPath $ManifestName
$shimPath = Get-SafeChild $binPath 'S.cmd'
$rollbackShimPath = Get-SafeChild $binPath $RollbackShimName
$rollbackManifestPath = Get-SafeChild $binPath $RollbackManifestName

if ($Action -in @('Install','Upgrade')) {
    if ([string]::IsNullOrWhiteSpace($RepoDir)) { $RepoDir = Split-Path -Parent $PSScriptRoot }
    $repoPath = Get-AbsolutePath $RepoDir
    Assert-NoReparseComponents $repoPath
    $runPath = Join-Path $repoPath 'run.py'
    if (-not (Test-Path -LiteralPath $runPath -PathType Leaf)) { throw "run.py not found at: $runPath" }
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($null -eq $py) { throw 'Python launcher py.exe is missing.' }
    & $py.Source -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3,10) else 2)"
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required.' }

    $batchRunPath = $runPath.Replace('%','%%')
    $content = @(
      '@echo off','setlocal DisableDelayedExpansion',
      '"%SystemRoot%\System32\where.exe" py.exe >nul 2>nul','if errorlevel 1 goto :python_missing',
      'py -3 -c "import sys;raise SystemExit(0 if sys.version_info >= (3,10) else 2)" >nul 2>nul','if errorlevel 1 goto :python_unsupported',
      'for /f "tokens=*" %%L in (''chcp'') do for %%C in (%%L) do set "_XS_ORIGINAL_CODE_PAGE=%%C"',
      'for /f "delims=0123456789" %%C in ("%_XS_ORIGINAL_CODE_PAGE%") do set "_XS_ORIGINAL_CODE_PAGE="',
      'if not defined _XS_ORIGINAL_CODE_PAGE exit /b 1','if not "%_XS_ORIGINAL_CODE_PAGE%"=="65001" chcp 65001 >nul',
      'set "PYTHONUTF8=1"','set "PYTHONDONTWRITEBYTECODE=1"',('py -3 "{0}" %*' -f $batchRunPath),
      'set "_XS_EXIT_CODE=%ERRORLEVEL%"','if not "%_XS_ORIGINAL_CODE_PAGE%"=="65001" chcp %_XS_ORIGINAL_CODE_PAGE% >nul','exit /b %_XS_EXIT_CODE%',
      ':python_missing','if /I "%~1"=="doctor" echo {"version":1,"overall":"error","checks":[{"id":"python","status":"error","code":"python_missing","detail":"Python is unavailable","action":"Install Python 3.10 or newer"}]}','exit /b 2',
      ':python_unsupported','if /I "%~1"=="doctor" echo {"version":1,"overall":"error","checks":[{"id":"python","status":"error","code":"python_too_old","detail":"Python is unsupported","action":"Install Python 3.10 or newer"}]}','exit /b 2'
    ) -join "`r`n"; $content += "`r`n"
    $bytes = $Utf8NoBom.GetBytes($content); $hash=Get-HashBytes $bytes; $version=$hash.Substring(7,12)
}

$currentManifest = $null
if (Test-Path -LiteralPath $manifestPath) { $currentManifest=Read-OwnedManifest $binPath $ManifestName 'S.cmd'; [void](Assert-OwnedFile $binPath $currentManifest) }
elseif (Test-Path -LiteralPath $shimPath) { throw 'An unmanaged S.cmd already exists; refusing to overwrite it.' }

if ($Action -eq 'Upgrade' -and $null -eq $currentManifest) { throw 'No owned S installation exists to upgrade.' }

if ($Action -eq 'Uninstall') {
    if ($null -eq $currentManifest) { throw 'No owned S installation exists to uninstall.' }
    if ((Test-Path -LiteralPath $rollbackShimPath) -or (Test-Path -LiteralPath $rollbackManifestPath)) {
        $previous=Read-OwnedManifest $binPath $RollbackManifestName $RollbackShimName; [void](Assert-OwnedFile $binPath $previous)
    }
    $pm=$currentManifest.path_management; $now=Get-ManagedPath
    $uninstallPath=$now; $uninstallPathOperation='none'
    if ($pm.added -eq $true -and (Get-HashText $now) -eq [string]$pm.installed_hash) {
        $uninstallPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$pm.before_b64))
        $uninstallPathOperation='remove'
    }
    Begin-Transaction $binPath $uninstallPathOperation $uninstallPath; Invoke-Failure 'after_journal'
    foreach ($name in @('S.cmd',$RollbackShimName,$RollbackManifestName,$ManifestName)) { $p=Get-SafeChild $binPath $name; if(Test-Path -LiteralPath $p){Remove-Item -LiteralPath $p -Force} }
    Invoke-Failure 'after_shim'
    if ($uninstallPathOperation -eq 'remove') { Set-ManagedPath $uninstallPath }
    Invoke-Failure 'after_path'; Remove-Item -LiteralPath (Get-SafeChild $binPath $JournalName) -Force
    Write-Host '[OK] Uninstalled the owned S launcher; user data was preserved.'; return
}

if ($Action -eq 'Rollback') {
    if ($null -eq $currentManifest) { throw 'No owned S installation exists to roll back.' }
    $previous=Read-OwnedManifest $binPath $RollbackManifestName $RollbackShimName; [void](Assert-OwnedFile $binPath $previous)
    $currentBytes=[IO.File]::ReadAllBytes($shimPath); $previousBytes=[IO.File]::ReadAllBytes($rollbackShimPath)
    $rollbackPath=Get-ManagedPath
    Begin-Transaction $binPath 'none' $rollbackPath; Invoke-Failure 'after_journal'
    Write-DurableBytes $binPath 'S.cmd' $previousBytes; Invoke-Failure 'after_shim'
    Write-DurableJson $binPath $ManifestName (New-Manifest ([string]$previous.version) 'S.cmd' (Get-HashBytes $previousBytes) $currentManifest.path_management); Invoke-Failure 'after_manifest'
    Write-DurableBytes $binPath $RollbackShimName $currentBytes
    Write-DurableJson $binPath $RollbackManifestName (New-Manifest ([string]$currentManifest.version) $RollbackShimName (Get-HashBytes $currentBytes) $null)
    Remove-Item -LiteralPath (Get-SafeChild $binPath $JournalName) -Force; Write-Host '[OK] Rolled S launcher back.'; return
}

if ($null -ne $currentManifest -and [string]$currentManifest.files[0].sha256 -eq $hash -and $Action -ne 'Upgrade') { Write-Host "[OK] S command already current: $shimPath"; return }
$currentPath=Get-ManagedPath
if ($null -ne $currentManifest) {
    $present = Test-ManagedPathContains $currentPath $binPath
    $previouslyAdded = $null -ne $currentManifest.path_management -and $currentManifest.path_management.added -eq $true
    if ($present -and $previouslyAdded) {
        $withoutOwned = Remove-ManagedPathEntry $currentPath $binPath
        $pathManagement=[ordered]@{
            added=$true
            before_b64=[Convert]::ToBase64String($Utf8NoBom.GetBytes($withoutOwned))
            installed_hash=(Get-HashText $currentPath)
        }
    } else {
        $pathManagement=[ordered]@{
            added=$false
            before_b64=[Convert]::ToBase64String($Utf8NoBom.GetBytes($currentPath))
            installed_hash=(Get-HashText $currentPath)
        }
        if (-not $present) { Write-Warning 'S install directory was removed from PATH; upgrade preserved the user change.' }
    }
} else {
    $present = Test-ManagedPathContains $currentPath $binPath
    $respectRemoval = $recovery.respect_owned_path_removal -eq $true
    $continueOwnership = $recovery.continue_path_ownership -eq $true
    if ($continueOwnership) {
        if (-not $present -or [string]$recovery.ownership_installed_hash -ne (Get-HashText $currentPath)) {
            throw 'Recovered PATH ownership metadata no longer matches the current PATH.'
        }
        $shouldAdd = $false
        $installedPath = $currentPath
        $pathManagement=[ordered]@{
            added=$true
            before_b64=[Convert]::ToBase64String($Utf8NoBom.GetBytes([string]$recovery.ownership_before))
            installed_hash=(Get-HashText $currentPath)
        }
    } else {
        $shouldAdd = -not $present -and -not $respectRemoval
        $installedPath = if (-not $shouldAdd) { $currentPath } elseif ([string]::IsNullOrWhiteSpace($currentPath)) { $binPath } else { $currentPath.TrimEnd(';')+';'+$binPath }
        $pathManagement=[ordered]@{added=$shouldAdd;before_b64=[Convert]::ToBase64String($Utf8NoBom.GetBytes($currentPath));installed_hash=(Get-HashText $installedPath)}
    }
}
$candidate=New-Manifest $version 'S.cmd' $hash $pathManagement
$installPathOperation = if ($null -eq $currentManifest -and $pathManagement.added -eq $true) { 'add' } else { 'none' }
$installerWrittenPath = if ($installPathOperation -eq 'add') { $installedPath } else { $currentPath }
Begin-Transaction $binPath $installPathOperation $installerWrittenPath; Invoke-Failure 'after_journal'
if ($null -ne $currentManifest) {
    $old=[IO.File]::ReadAllBytes($shimPath)
    Write-DurableBytes $binPath $RollbackShimName $old
    Write-DurableJson $binPath $RollbackManifestName (New-Manifest ([string]$currentManifest.version) $RollbackShimName (Get-HashBytes $old) $null)
}
Write-DurableBytes $binPath 'S.cmd' $bytes; Invoke-Failure 'after_shim'
Write-DurableJson $binPath $ManifestName $candidate; Invoke-Failure 'after_manifest'
if ($null -eq $currentManifest -and $pathManagement.added -eq $true -and (Get-HashText (Get-ManagedPath)) -ne [string]$pathManagement.installed_hash) {
    $before=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$pathManagement.before_b64))
    Set-ManagedPath $(if([string]::IsNullOrWhiteSpace($before)){$binPath}else{$before.TrimEnd(';')+';'+$binPath})
}
Invoke-Failure 'after_path'; Remove-Item -LiteralPath (Get-SafeChild $binPath $JournalName) -Force
Write-Host "[OK] Installed S command: $shimPath"
