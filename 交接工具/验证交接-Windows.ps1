[CmdletBinding()]
param([switch]$Full)
$ErrorActionPreference = 'Stop'
$ToolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$XsRoot = Split-Path -Parent $ToolDir
$Node = (Get-Command node -ErrorAction Stop).Source
& $Node (Join-Path $XsRoot 'scripts\handoff-manifest.mjs') verify
if ($LASTEXITCODE -ne 0) { throw '交接完整性校验失败。' }
Write-Host '[通过] 三层源码、Git 历史与工作树完整。' -ForegroundColor Green
if ($Full) {
  $Pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
  if ((& $Pnpm --version).Trim() -ne '11.7.0') { throw 'pnpm 版本必须为 11.7.0。' }
  Push-Location $XsRoot
  try {
    # 路径型 filter 必须以 XS 为 cwd；--dir 不改变 pnpm 的 filter 基准。
    & $Pnpm -r --filter './packages/**' run build
    if ($LASTEXITCODE -ne 0) { throw '工作区包预构建失败。' }
    & $Pnpm -r --filter './packages/**' run test
    if ($LASTEXITCODE -ne 0) { throw '工作区包测试失败。' }
    & $Pnpm -r --filter './packages/**' run build
    if ($LASTEXITCODE -ne 0) { throw '工作区包构建失败。' }
    & $Pnpm -r --filter './packages/**' run typecheck
    if ($LASTEXITCODE -ne 0) { throw '工作区包类型检查失败。' }
    & $Pnpm run check
    if ($LASTEXITCODE -ne 0) { throw 'XS 本地门禁失败。' }
  } finally {
    Pop-Location
  }
  & $Pnpm --dir (Join-Path $XsRoot 'runtime\DSH') dsh web --dump-config | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '全量本地门禁失败。' }
  Write-Host '[通过] XS 全部门禁与 DSH Profile 解析。' -ForegroundColor Green
}
