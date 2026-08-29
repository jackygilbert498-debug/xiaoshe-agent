[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$ToolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$XsRoot = Split-Path -Parent $ToolDir
$DshRoot = Join-Path $XsRoot 'runtime\DSH'

function Step([string]$Name, [string]$Message) { Write-Host "`n[$Name] $Message" -ForegroundColor Cyan }
function Require-Command([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "未找到 $Name。请先安装 Node.js 24、pnpm 11.7.0、Git、Python 3 和 PowerShell 7。" }
  $command.Source
}

$Node = Require-Command 'node'
$NodeMajor = [int]((& $Node -p 'process.versions.node.split(".")[0]').Trim())
if ($NodeMajor -lt 24) { throw "Node.js 需要 24 或更高版本，当前为 $(& $Node --version)。" }
$PnpmCommand = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue
if ($CheckOnly -and (-not $PnpmCommand -or ((& $PnpmCommand.Source --version).Trim() -ne '11.7.0'))) {
  throw '--CheckOnly 需要已安装的 pnpm 11.7.0；正式安装模式会创建项目专用实例。'
}
$Pnpm = if ($PnpmCommand) { $PnpmCommand.Source } else { '' }
Require-Command 'git' | Out-Null
Require-Command 'pwsh' | Out-Null
$env:XIAOSHE_PYTHON = Require-Command 'python'

Step '校验' '检查交接哈希和 Git 对象…'
& $Node (Join-Path $XsRoot 'scripts\handoff-manifest.mjs') verify
if ($LASTEXITCODE -ne 0) { throw '交接完整性校验失败。' }
if ($CheckOnly) { Step '通过' '前置条件和载荷完整性已验证；未修改本机。'; exit 0 }
$PnpmPrefix = Join-Path $HOME '.xiaoshe-handoff\pnpm-11.7.0'
$Pnpm = Join-Path $PnpmPrefix 'node_modules\.bin\pnpm.cmd'
if (-not (Test-Path $Pnpm) -or ((& $Pnpm --version).Trim() -ne '11.7.0')) {
  $Npm = Require-Command 'npm.cmd'
  Step '安装' '安装项目专用 pnpm 11.7.0…'
  & $Npm install --prefix $PnpmPrefix --no-save --no-audit --no-fund pnpm@11.7.0
  if ($LASTEXITCODE -ne 0) { throw 'pnpm 11.7.0 安装失败。' }
}
$PnpmShimDir = Join-Path $HOME '.xiaoshe-handoff\bin'
New-Item -ItemType Directory -Force $PnpmShimDir | Out-Null
$PnpmShim = Join-Path $PnpmShimDir 'pnpm.cmd'
Set-Content -Encoding ASCII $PnpmShim ("@echo off`r`ncall `"{0}`" %*`r`nexit /b %errorlevel%`r`n" -f $Pnpm)
$env:Path = "$PnpmShimDir;$([IO.Path]::GetDirectoryName($Node));$($env:Path)"

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$ProfileRoot = Join-Path $DshHome 'profiles\web'
if (Test-Path $ProfileRoot) {
  $Backup = Join-Path $DshHome ("backups\web-before-xs-handoff-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
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

Step '验证' '安装 XS 依赖并运行本地门禁…'
Push-Location $XsRoot
try {
  # pnpm 的路径型 --filter 相对进程 cwd 解析，不能只依赖 --dir；否则从
  # 其他目录启动接收器时会静默匹配 0 个 workspace 包。
  & $Pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'XS 依赖安装失败。' }
  # 冷设备没有任何 lib：先按拓扑构建上游导出，供下游包测试解析。
  & $Pnpm -r --filter './packages/**' run build
  if ($LASTEXITCODE -ne 0) { throw 'XS 工作区包预构建失败。' }
  # 部分 artifact 测试会主动清理临时 lib；测试后必须再次构建，生成供
  # 根项目读取的最终工作区产物，不能依赖上一台设备遗留的构建目录。
  & $Pnpm -r --filter './packages/**' run test
  if ($LASTEXITCODE -ne 0) { throw 'XS 工作区包测试失败。' }
  & $Pnpm -r --filter './packages/**' run build
  if ($LASTEXITCODE -ne 0) { throw 'XS 工作区包构建失败。' }
  & $Pnpm -r --filter './packages/**' run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'XS 工作区包类型检查失败。' }
  & $Pnpm run check
  if ($LASTEXITCODE -ne 0) { throw 'XS 本地门禁失败。' }
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
  (Join-Path $XsRoot 'packages\task-timeline'),
  (Join-Path $XsRoot 'packages\product-bundle')
)
Push-Location $XsRoot
try { & $Pnpm --dir $DshRoot dsh plugin --profile web add @ProductPackages }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'DSH web Profile 插件安装失败。' }

New-Item -ItemType Directory -Force $ProfileRoot | Out-Null
$ProfilePatch = Join-Path $ProfileRoot 'cordis.patch.yml'
& $Node (Join-Path $XsRoot 'scripts\ensure-handoff-profile-patch.mjs') `
  --target $ProfilePatch `
  --template (Join-Path $ToolDir 'profile\cordis.patch.yml')
if ($LASTEXITCODE -ne 0) { throw 'ModLens Profile 配置合并失败。' }

Step '终验' '解析最终 DSH web Profile…'
& $Pnpm --dir $DshRoot dsh web --dump-config | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'DSH Profile 解析失败。' }
Step '命令' '安装 Windows 短入口 s 与 xiaoshe-doctor…'
& (Join-Path $XsRoot 'scripts\install-windows-cli.ps1') -XsRoot $XsRoot | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Windows 命令入口安装失败。' }
Step '完成' '已安装。重开终端输入 s；输入 xiaoshe-doctor 可运行只读诊断。首次使用在设置中配置模型凭据。'
Write-Host '当前 200% DPI 与 Windows UIA/动作已真机通过；125%/150% 和多显示器仍需对应环境复验。' -ForegroundColor Yellow
