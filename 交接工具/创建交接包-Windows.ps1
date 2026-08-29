[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ToolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$XsRoot = [IO.Path]::GetFullPath((Join-Path $ToolDir '..'))
$ParentDir = Split-Path -Parent $XsRoot
$BaseName = Split-Path -Leaf $XsRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$Tar = (Get-Command tar.exe -ErrorAction Stop).Source
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Output = Join-Path $ToolDir "XS-完整交接包-$Stamp.tar.gz"
$TempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$TempRoot = Join-Path $TempBase ("xiaoshe-handoff-" + [guid]::NewGuid().ToString('N'))
$TempArchive = Join-Path $TempRoot 'package.tar.gz'
$ExclusionList = Join-Path $TempRoot 'tar-exclusions.txt'
$UnpackedDir = Join-Path $TempRoot 'unpacked'

function Convert-ToPosixRelativePath {
  param([Parameter(Mandatory)][string]$Path)
  return [IO.Path]::GetRelativePath($XsRoot, $Path).Replace([IO.Path]::DirectorySeparatorChar, '/')
}

function Test-ExcludedDirectory {
  param([Parameter(Mandatory)][string]$RelativePath)
  $Parts = $RelativePath -split '/'
  $IgnoredNames = @(
    '.artifacts', '.cache', '.dsh-build', '.pnpm-store', '.pytest_cache', '.sessions',
    '.state', '.storages', '.session', '.vitest', '.worktrees', '__pycache__', 'coverage',
    'dist', 'dist-exe', 'logs', 'node_modules', 'tmp'
  )
  if ($Parts | Where-Object { $_ -in $IgnoredNames }) { return $true }
  if ($Parts.Count -ge 3 -and $Parts[0] -eq 'packages' -and $Parts[2] -eq 'lib') { return $true }
  if ($Parts.Count -ge 3 -and $Parts[0] -eq 'runtime' -and $Parts[1] -eq 'DSH' -and $Parts -contains 'lib') { return $true }
  return $RelativePath -eq 'runtime/xiaoshe-legacy/Harness交接'
}

function Test-ExcludedFile {
  param([Parameter(Mandatory)][string]$RelativePath)
  $Name = Split-Path -Leaf $RelativePath
  if ($Name -eq '.DS_Store') { return $true }
  if ($Name -eq '.env' -or ($Name.StartsWith('.env.') -and $Name -ne '.env.example')) { return $true }
  if ($Name -in @('.credentials.yaml', 'mcp.json', 'ui_token')) { return $true }
  if ($Name.StartsWith('model_secrets.bin')) { return $true }
  if ($RelativePath -eq '交接工具/完整性清单.json') { return $false }
  if ($RelativePath -match '^交接工具/XS-完整交接包-.*\.(tar\.gz|zip)(\.sha256)?$') { return $true }
  if ($RelativePath -match '\.(pyc|tsbuildinfo)$') { return $true }
  return $RelativePath.EndsWith('.log') -and $RelativePath -ne 'docs/evidence/macos-terminal-screen-smoke.log'
}

function Get-TarExclusions {
  $Excluded = [Collections.Generic.List[string]]::new()
  $Pending = [Collections.Generic.Stack[string]]::new()
  $Pending.Push($XsRoot)
  while ($Pending.Count -gt 0) {
    $Directory = $Pending.Pop()
    foreach ($Entry in [IO.Directory]::EnumerateFileSystemEntries($Directory)) {
      $Relative = Convert-ToPosixRelativePath -Path $Entry
      $Attributes = [IO.File]::GetAttributes($Entry)
      $IsDirectory = ($Attributes -band [IO.FileAttributes]::Directory) -ne 0
      $IsReparsePoint = ($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
      if ($IsDirectory -and -not $IsReparsePoint) {
        if (Test-ExcludedDirectory -RelativePath $Relative) {
          $Excluded.Add("$BaseName/$Relative")
        } else {
          $Pending.Push($Entry)
        }
      } elseif (Test-ExcludedFile -RelativePath $Relative) {
        $Excluded.Add("$BaseName/$Relative")
      }
    }
  }
  return $Excluded
}

New-Item -ItemType Directory -Path $TempRoot, $UnpackedDir -Force | Out-Null
try {
  & $Node (Join-Path $XsRoot 'scripts/handoff-manifest.mjs') generate
  if ($LASTEXITCODE -ne 0) { throw '完整性清单生成失败。' }
  & $Node (Join-Path $XsRoot 'scripts/handoff-manifest.mjs') verify
  if ($LASTEXITCODE -ne 0) { throw '打包前完整性校验失败。' }

  # One argv entry per excluded path eventually exceeds Windows' process
  # command-line limit. A UTF-8 exclusion file keeps the invocation bounded
  # while preserving the exact path list used by the previous implementation.
  $Utf8NoBom = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllLines($ExclusionList, [string[]](Get-TarExclusions), $Utf8NoBom)
  # Keep one bounded wildcard in argv as a second line of defence. The 2026-08-27
  # Windows handoff proved that tar.exe may fail to apply individual UTF-8
  # exclusion-file entries for Chinese paths and recursively embed old archives.
  $ArchiveRecursionGuard = "--exclude=$BaseName/交接工具/XS-完整交接包-*"
  $TarArgs = @('-czf', $TempArchive, '--exclude-from', $ExclusionList, $ArchiveRecursionGuard, '-C', $ParentDir, $BaseName)
  Write-Host '[打包] 正在创建不含凭据、会话、平台依赖和构建产物的可迁移副本…'
  & $Tar @TarArgs
  if ($LASTEXITCODE -ne 0) { throw 'tar.gz 创建失败。' }

  & $Tar -xzf $TempArchive -C $UnpackedDir
  if ($LASTEXITCODE -ne 0) { throw 'tar.gz 解包失败。' }
  $UnpackedRoot = Join-Path $UnpackedDir $BaseName
  & $Node (Join-Path $UnpackedRoot 'scripts/handoff-manifest.mjs') verify
  if ($LASTEXITCODE -ne 0) { throw '解包后 Git/哈希复验失败。' }

  Move-Item -LiteralPath $TempArchive -Destination $Output
  $Hash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash.ToLowerInvariant()
  $Size = (Get-Item -LiteralPath $Output).Length
  $Checksum = "$Output.sha256"
  [IO.File]::WriteAllText($Checksum, "$Hash  $(Split-Path -Leaf $Output)`n", $Utf8NoBom)
  Write-Host "[完成] 交接包已经‘生成清单 → 打包 → 解包 → Git/哈希复验’："
  Write-Host $Output
  Write-Host "SHA-256: $Hash"
  Write-Host "字节数: $Size"
  Write-Host "校验文件: $Checksum"
} finally {
  $ResolvedTemp = [IO.Path]::GetFullPath($TempRoot)
  if ($ResolvedTemp.StartsWith($TempBase, [StringComparison]::OrdinalIgnoreCase) -and $ResolvedTemp -ne $TempBase) {
    Remove-Item -LiteralPath $ResolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
