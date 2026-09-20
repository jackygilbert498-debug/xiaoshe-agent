[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$XsRoot,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

function Resolve-OrdinaryDirectory([string]$Path, [string]$Label) {
  $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $Item.PSIsContainer) { throw "$Label is not a directory: $Path" }
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label must not be a symbolic link or reparse point: $Path"
  }
  return [IO.Path]::GetFullPath($Item.FullName).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Resolve-DirectChild([string]$Parent, [string]$Name, [string]$Label) {
  $Child = [IO.Path]::GetFullPath((Join-Path $Parent $Name))
  $ChildParent = [IO.Directory]::GetParent($Child).FullName.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if (-not [string]::Equals($ChildParent, $Parent, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be a direct child of the desktop distribution directory."
  }
  return $Child
}

function Test-PathWithin([string]$Parent, [string]$Child) {
  $Prefix = $Parent + [IO.Path]::DirectorySeparatorChar
  return [string]::Equals($Parent, $Child, [StringComparison]::OrdinalIgnoreCase) -or
    $Child.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-Sha256([string]$Path) {
  $Stream = [IO.File]::OpenRead($Path)
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $Bytes = $Hasher.ComputeHash($Stream)
    return ([BitConverter]::ToString($Bytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $Hasher.Dispose()
    $Stream.Dispose()
  }
}

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
  $Actual = Get-Sha256 -Path $Path
  if (-not [string]::Equals($Actual, $Expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label checksum mismatch; refusing to replace the daily package."
  }
}

$ResolvedRoot = Resolve-OrdinaryDirectory -Path $XsRoot -Label 'product root'
$DistRoot = Resolve-OrdinaryDirectory -Path (Join-Path $ResolvedRoot 'apps\desktop-shell\dist-desktop') -Label 'desktop distribution directory'
$MarkerPath = Join-Path $DistRoot 'pending-package-update.json'

if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
  return [pscustomobject]@{
    schema = 'xiaoshe-pending-desktop-update-result/v1'
    status = 'none'
    candidate = $null
    backup = $null
  }
}

$MarkerItem = Get-Item -LiteralPath $MarkerPath -Force -ErrorAction Stop
if (($MarkerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'The pending update marker must not be a symbolic link or reparse point.'
}
$Marker = Get-Content -LiteralPath $MarkerPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
if ($Marker.schema -ne 'xiaoshe-pending-desktop-update/v1') { throw 'Unsupported pending update marker schema.' }
if ([string]$Marker.candidateName -notmatch '^candidate-[A-Za-z0-9._-]+$') { throw 'Invalid pending candidate directory name.' }
if ([string]$Marker.backupName -notmatch '^win-unpacked\.before-[A-Za-z0-9._-]+$') { throw 'Invalid pending backup directory name.' }
if ([string]$Marker.exeSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid pending executable digest.' }
if ([string]$Marker.asarSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid pending ASAR digest.' }

$CandidatePath = Resolve-DirectChild -Parent $DistRoot -Name ([string]$Marker.candidateName) -Label 'candidate package'
$DailyPath = Resolve-DirectChild -Parent $DistRoot -Name 'win-unpacked' -Label 'daily package'
$BackupPath = Resolve-DirectChild -Parent $DistRoot -Name ([string]$Marker.backupName) -Label 'backup package'
$ResolvedCandidate = Resolve-OrdinaryDirectory -Path $CandidatePath -Label 'candidate package'
if (-not [string]::Equals($ResolvedCandidate, $CandidatePath, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Resolved candidate package path is outside the expected location.'
}
if (Test-Path -LiteralPath $BackupPath) { throw "Backup target already exists; refusing to overwrite it: $BackupPath" }
if (Test-Path -LiteralPath $DailyPath) {
  $ResolvedDaily = Resolve-OrdinaryDirectory -Path $DailyPath -Label 'daily package'
  if (-not [string]::Equals($ResolvedDaily, $DailyPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Resolved daily package path is outside the expected location.'
  }
}

$ExecutableName = (-join @([char]0x5C0F, [char]0x86C7)) + '.exe'
$CandidateExecutable = Join-Path $CandidatePath $ExecutableName
$CandidateAsar = Join-Path $CandidatePath 'resources\app.asar'
Assert-Sha256 -Path $CandidateExecutable -Expected ([string]$Marker.exeSha256) -Label 'candidate executable'
Assert-Sha256 -Path $CandidateAsar -Expected ([string]$Marker.asarSha256) -Label 'candidate ASAR'

$RunningProductProcesses = @(
  Get-CimInstance -ClassName Win32_Process -Filter "Name='$ExecutableName'" -ErrorAction Stop |
    Where-Object {
      if ([string]::IsNullOrWhiteSpace([string]$_.ExecutablePath)) { return $false }
      $ExecutablePath = [IO.Path]::GetFullPath([string]$_.ExecutablePath)
      return Test-PathWithin -Parent $DistRoot -Child $ExecutablePath
    }
)

if ($RunningProductProcesses.Count -gt 0) {
  return [pscustomobject]@{
    schema = 'xiaoshe-pending-desktop-update-result/v1'
    status = 'running'
    candidate = $CandidatePath
    backup = $BackupPath
  }
}

if ($CheckOnly) {
  return [pscustomobject]@{
    schema = 'xiaoshe-pending-desktop-update-result/v1'
    status = 'ready'
    candidate = $CandidatePath
    backup = $BackupPath
  }
}

$MovedDaily = $false
$MovedCandidate = $false
try {
  if (Test-Path -LiteralPath $DailyPath) {
    [IO.Directory]::Move($DailyPath, $BackupPath)
    $MovedDaily = $true
  }
  [IO.Directory]::Move($CandidatePath, $DailyPath)
  $MovedCandidate = $true
  Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction Stop
} catch {
  $PromotionError = $_.Exception.Message
  $RollbackErrors = @()
  if ($MovedCandidate -and (Test-Path -LiteralPath $DailyPath) -and -not (Test-Path -LiteralPath $CandidatePath)) {
    try { [IO.Directory]::Move($DailyPath, $CandidatePath) } catch { $RollbackErrors += $_.Exception.Message }
  }
  if ($MovedDaily -and (Test-Path -LiteralPath $BackupPath) -and -not (Test-Path -LiteralPath $DailyPath)) {
    try { [IO.Directory]::Move($BackupPath, $DailyPath) } catch { $RollbackErrors += $_.Exception.Message }
  }
  if ($RollbackErrors.Count -gt 0) {
    throw "Desktop package promotion failed and rollback was incomplete. Promotion error: $PromotionError; rollback errors: $($RollbackErrors -join ' | ')"
  }
  throw "Desktop package promotion failed; the original daily package was restored. Promotion error: $PromotionError"
}

return [pscustomobject]@{
  schema = 'xiaoshe-pending-desktop-update-result/v1'
  status = 'promoted'
  candidate = $DailyPath
  backup = if ($MovedDaily) { $BackupPath } else { $null }
}
