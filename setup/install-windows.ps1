[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$ToolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$XsRoot = Split-Path -Parent $ToolDir
$DshRoot = Join-Path $XsRoot 'runtime\DSH'

function Step([string]$Name, [string]$Message) { Write-Host "`n[$Name] $Message" -ForegroundColor Cyan }
function Require-Command([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "未找到 $Name。请先安装 Node.js 24、Git 和 Python 3。" }
  $command.Source
}

function Require-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "发行源码不完整，缺少：$Path" }
}

$Node = Require-Command 'node'
$NodeMajor = [int]((& $Node --version).Trim().TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 24) { throw "Node.js 需要 24 或更高版本，当前为 $(& $Node --version)。" }
$PnpmCommand = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
if ($CheckOnly -and (-not $PnpmCommand -or ((& $PnpmCommand.Source --version).Trim() -ne '11.7.0'))) {
  throw '--CheckOnly 需要已安装的 pnpm 11.7.0；正式安装模式会创建项目专用实例。'
}
$Pnpm = if ($PnpmCommand) { $PnpmCommand.Source } else { '' }
Require-Command 'git' | Out-Null
$env:XIAOSHE_PYTHON = Require-Command 'python'

Step '校验' '检查开发者发行源码和本机工具链…'
Require-File (Join-Path $XsRoot 'package.json')
Require-File (Join-Path $DshRoot 'package.json')
Require-File (Join-Path $XsRoot 'runtime\xiaoshe-legacy\run.py')
Require-File (Join-Path $XsRoot 'packages\product-bundle\package.json')
Require-File (Join-Path $XsRoot 'packages\provider-readiness\package.json')
Require-File (Join-Path $XsRoot 'packages\migration-recovery\package.json')
Require-File (Join-Path $XsRoot 'packages\coding-workbench\package.json')
Require-File (Join-Path $ToolDir 'profile\cordis.patch.yml')
if ($CheckOnly) { Step '通过' '源码结构和前置工具已验证；未修改本机。'; exit 0 }
$PnpmPrefix = Join-Path $HOME '.xiaoshe\pnpm-11.7.0'
$Pnpm = Join-Path $PnpmPrefix 'node_modules\.bin\pnpm.cmd'
if (-not (Test-Path $Pnpm) -or ((& $Pnpm --version).Trim() -ne '11.7.0')) {
  $Npm = Require-Command 'npm.cmd'
  Step '安装' '安装项目专用 pnpm 11.7.0…'
  & $Npm install --prefix $PnpmPrefix --no-save --no-audit --no-fund pnpm@11.7.0
  if ($LASTEXITCODE -ne 0) { throw 'pnpm 11.7.0 安装失败。' }
}
$PnpmShimDir = Join-Path $HOME '.xiaoshe\bin'
New-Item -ItemType Directory -Force $PnpmShimDir | Out-Null
$PnpmShim = Join-Path $PnpmShimDir 'pnpm.cmd'
Set-Content -Encoding ASCII $PnpmShim ("@echo off`r`ncall `"{0}`" %*`r`nexit /b %errorlevel%`r`n" -f $Pnpm)
$env:Path = "$PnpmShimDir;$([IO.Path]::GetDirectoryName($Node));$($env:Path)"

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$ProfileRoot = Join-Path $DshHome 'profiles\web'
if (Test-Path $ProfileRoot) {
  $Backup = Join-Path $DshHome ("backups\web-before-xiaoshe-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  & (Join-Path $XsRoot 'scripts\backup-dsh-profile.ps1') `
    -SourceRoot $ProfileRoot `
    -BackupRoot $Backup
  if ($LASTEXITCODE -ne 0) { throw '原 web Profile 备份失败。' }
  Step '备份' "已备份原 web Profile：$Backup"
}

Step '安装' '安装锁定依赖并构建 DSH…'
$env:CI = 'true'
Write-Host '[安装] 检测到的跨平台依赖将按锁文件重建；范围仅限 XS 与 runtime\DSH 的 node_modules。'
& $Pnpm --dir $DshRoot install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'DSH 依赖安装失败。' }
& $Pnpm --dir $DshRoot run build
if ($LASTEXITCODE -ne 0) { throw 'DSH 构建失败。' }

Step '构建' '安装 XS 锁定依赖并构建产品插件…'
Push-Location $XsRoot
try {
  # pnpm 的路径型 --filter 相对进程 cwd 解析，不能只依赖 --dir；否则从
  # 其他目录启动安装器时会静默匹配 0 个 workspace 包。
  & $Pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'XS 依赖安装失败。' }
  # 冷设备没有任何 lib：按拓扑构建上游导出，再检查产品源码类型。
  & $Pnpm -r --filter './packages/**' run build
  if ($LASTEXITCODE -ne 0) { throw 'XS 工作区包预构建失败。' }
  & $Pnpm -r --filter './packages/**' run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'XS 工作区包类型检查失败。' }
  & $Pnpm run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'XS 根包类型检查失败。' }
  & $Pnpm run build
  if ($LASTEXITCODE -ne 0) { throw 'XS 根包构建失败。' }
  if (Test-Path -LiteralPath (Join-Path $XsRoot 'apps\desktop-shell\package.json')) {
    & $Pnpm --filter '@xiaoshe/desktop-shell' test
    if ($LASTEXITCODE -ne 0) { throw '桌面壳安全与生命周期测试失败。' }
  }
} finally {
  Pop-Location
}

Step '配置' '将 ModLens、XS 桌面能力和完整 Product Bundle 接入 DSH web Profile…'
$ProductPackages = @(
  '@liustack/modlens@3.22.0',
  $XsRoot,
  (Join-Path $XsRoot 'packages\verification-policy'),
  (Join-Path $XsRoot 'packages\native-shell-legacy-adapted'),
  (Join-Path $XsRoot 'packages\runtime-dsh-provider'),
  (Join-Path $XsRoot 'packages\completion-receipt'),
  (Join-Path $XsRoot 'packages\runtime-contract'),
  (Join-Path $XsRoot 'packages\heartbeat'),
  (Join-Path $XsRoot 'packages\memory'),
  (Join-Path $XsRoot 'packages\plugin-governance'),
  (Join-Path $XsRoot 'packages\provider-readiness'),
  (Join-Path $XsRoot 'packages\migration-recovery'),
  (Join-Path $XsRoot 'packages\coding-workbench'),
  (Join-Path $XsRoot 'packages\task-timeline'),
  (Join-Path $DshRoot 'packages\session-query\tool-session-query'),
  (Join-Path $XsRoot 'packages\product-bundle')
)
Push-Location $XsRoot
try { & $Pnpm --dir $DshRoot dsh plugin --profile web add @ProductPackages }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'DSH web Profile 插件安装失败。' }

New-Item -ItemType Directory -Force $ProfileRoot | Out-Null
$ProfilePatch = Join-Path $ProfileRoot 'cordis.patch.yml'
& $Node (Join-Path $XsRoot 'scripts\ensure-profile-patch.mjs') `
  --target $ProfilePatch `
  --template (Join-Path $ToolDir 'profile\cordis.patch.yml')
if ($LASTEXITCODE -ne 0) { throw 'ModLens Profile 配置合并失败。' }

Step '终验' '解析最终 DSH web Profile…'
& $Pnpm --dir $DshRoot dsh web --dump-config | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'DSH Profile 解析失败。' }
Step '命令' '安装 Windows 双入口 s（终端版）、ss（桌面版）与 xiaoshe-doctor…'
& (Join-Path $XsRoot 'scripts\install-windows-cli.ps1') -XsRoot $XsRoot | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Windows 命令入口安装失败。' }
Step '完成' '已安装开发者发行版与独立桌面壳。重开终端输入 s 启动终端版，输入 ss 启动桌面版；xiaoshe-doctor 用于只读诊断。'
Write-Host '桌面操作仍受系统权限和当前设备显示配置约束，请先在小蛇中检查权限状态。' -ForegroundColor Yellow
