$script:XiaosheAcceptanceEnvironmentKeys = @(
  'XIAOSHE_PRODUCT_ROOT',
  'XIAOSHE_DESKTOP_URL',
  'XIAOSHE_DESKTOP_ACCEPTANCE',
  'XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA',
  'XIAOSHE_LAUNCH_TOKEN',
  'XIAOSHE_DSH_PORT',
  'XIAOSHE_HOME',
  'DSH_HOME',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP'
)

function Enter-XiaosheAcceptanceEnvironment {
  param(
    [Parameter(Mandatory = $true)][string]$CleanupRoot,
    [Parameter(Mandatory = $true)][string]$UserDataRoot,
    [Parameter(Mandatory = $true)][string]$ServiceUrl,
    [Parameter(Mandatory = $true)][int]$Port
  )
  $TemporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $CanonicalCleanupRoot = [System.IO.Path]::GetFullPath($CleanupRoot).TrimEnd('\')
  $CanonicalUserDataRoot = [System.IO.Path]::GetFullPath($UserDataRoot).TrimEnd('\')
  if (-not ($CanonicalCleanupRoot + '\').StartsWith($TemporaryBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'acceptance cleanup root must be inside the OS temporary directory'
  }
  $CanonicalTemporaryRoot = [System.IO.Path]::GetFullPath((Join-Path $CanonicalCleanupRoot 'temp')).TrimEnd('\')
  $RequiredUserDataPrefix = $CanonicalTemporaryRoot + '\'
  if (-not $CanonicalUserDataRoot.StartsWith($RequiredUserDataPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'acceptance userData root must be a child of the isolated TEMP directory'
  }
  if (-not ([System.IO.Path]::GetFileName($CanonicalUserDataRoot)).StartsWith('xiaoshe-windows-acceptance-', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'acceptance userData root must use the xiaoshe acceptance directory prefix'
  }
  foreach ($RequiredDirectory in @($CanonicalCleanupRoot, $CanonicalTemporaryRoot, $CanonicalUserDataRoot)) {
    if (-not (Test-Path -LiteralPath $RequiredDirectory -PathType Container)) {
      throw "acceptance isolation directory must exist before environment isolation: $RequiredDirectory"
    }
  }
  $Cursor = $TemporaryBase.TrimEnd('\')
  foreach ($Segment in $CanonicalUserDataRoot.Substring($TemporaryBase.Length).Split('\', [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $Cursor = Join-Path $Cursor $Segment
    $Item = Get-Item -LiteralPath $Cursor -Force -ErrorAction Stop
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'acceptance isolation directories must not traverse a filesystem link or reparse point'
    }
  }

  $Current = [Environment]::GetEnvironmentVariables('Process')
  $Previous = @{}
  foreach ($Name in $script:XiaosheAcceptanceEnvironmentKeys) {
    $Previous[$Name] = @{
      present = $Current.Contains($Name)
      value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    }
  }

  $HomeRoot = Join-Path $CanonicalCleanupRoot 'home'
  $Paths = @{
    XIAOSHE_HOME = (Join-Path $CanonicalCleanupRoot 'xiaoshe-home')
    DSH_HOME = (Join-Path $CanonicalCleanupRoot 'dsh-home')
    HOME = $HomeRoot
    USERPROFILE = $HomeRoot
    LOCALAPPDATA = (Join-Path $CanonicalCleanupRoot 'local-app-data')
    APPDATA = (Join-Path $CanonicalCleanupRoot 'roaming-app-data')
    TEMP = $CanonicalTemporaryRoot
    TMP = $CanonicalTemporaryRoot
  }
  New-Item -ItemType Directory -Force @($Paths.Values | Select-Object -Unique) | Out-Null
  Remove-Item Env:\XIAOSHE_PRODUCT_ROOT -ErrorAction SilentlyContinue
  $env:XIAOSHE_DESKTOP_URL = $ServiceUrl
  $env:XIAOSHE_DESKTOP_ACCEPTANCE = '1'
  $env:XIAOSHE_DESKTOP_ACCEPTANCE_USER_DATA = $CanonicalUserDataRoot
  $env:XIAOSHE_DSH_PORT = [string]$Port
  foreach ($Entry in $Paths.GetEnumerator()) {
    Set-Item -LiteralPath "Env:$($Entry.Key)" -Value ([string]$Entry.Value)
  }
  return $Previous
}

function Exit-XiaosheAcceptanceEnvironment {
  param([Parameter(Mandatory = $true)][hashtable]$Previous)
  foreach ($Name in $script:XiaosheAcceptanceEnvironmentKeys) {
    $Entry = $Previous[$Name]
    if ($Entry.present) {
      Set-Item -LiteralPath "Env:$Name" -Value ([string]$Entry.value)
    } else {
      Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    }
  }
}
