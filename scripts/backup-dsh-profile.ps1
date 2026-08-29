[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$SourceRoot,

  [Parameter(Mandatory)]
  [string]$BackupRoot
)

$ErrorActionPreference = 'Stop'

$ResolvedSource = [System.IO.Path]::GetFullPath($SourceRoot)
$ResolvedBackup = [System.IO.Path]::GetFullPath($BackupRoot)
$SourcePrefix = $ResolvedSource.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not (Test-Path -LiteralPath $ResolvedSource -PathType Container)) {
  throw "DSH Profile 不存在：$ResolvedSource"
}
if ($ResolvedBackup.Equals($ResolvedSource, [System.StringComparison]::OrdinalIgnoreCase) -or
    $ResolvedBackup.StartsWith($SourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'DSH Profile 备份目录不能位于源 Profile 内部。'
}
if (Test-Path -LiteralPath $ResolvedBackup) {
  throw "DSH Profile 备份目录已存在：$ResolvedBackup"
}

New-Item -ItemType Directory -Path $ResolvedBackup -Force | Out-Null
foreach ($Item in Get-ChildItem -LiteralPath $ResolvedSource -Force) {
  # pnpm 的 node_modules 包含指回 XS 工作区的 Junction。它是可由锁文件
  # 重建的安装产物，递归复制会越过 Profile 边界并可能形成循环。
  if ($Item.Name -eq 'node_modules') { continue }
  Copy-Item -LiteralPath $Item.FullName -Destination $ResolvedBackup -Recurse -Force
}

Write-Host "[完成] 已备份 DSH Profile 持久文件（不含可重建 node_modules）：$ResolvedBackup"
