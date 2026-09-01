[CmdletBinding()]
param(
  [switch]$NoOpen,
  [switch]$ServerOnly,
  [switch]$BrowserFallback,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$XsRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$InstalledDesktopCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\小蛇\小蛇.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Xiaoshe\小蛇.exe')
)
$InstalledDesktop = $InstalledDesktopCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
$DeveloperDesktop = Join-Path $XsRoot 'apps\desktop-shell\dist-desktop\win-unpacked\小蛇.exe'
$DeveloperElectron = Join-Path $XsRoot 'apps\desktop-shell\node_modules\electron\dist\electron.exe'
$DesktopExecutable = if ($InstalledDesktop) {
  $InstalledDesktop
} elseif (Test-Path -LiteralPath $DeveloperDesktop -PathType Leaf) {
  $DeveloperDesktop
} elseif (Test-Path -LiteralPath $DeveloperElectron -PathType Leaf) {
  $DeveloperElectron
} else {
  $null
}
$DesktopKind = if ($InstalledDesktop) {
  'installed'
} elseif ($DesktopExecutable -eq $DeveloperDesktop) {
  'packaged-development'
} elseif ($DesktopExecutable -eq $DeveloperElectron) {
  'electron-development'
} else {
  'unavailable'
}

if ($CheckOnly) {
  # Windows PowerShell 5.1 writes redirected native output with the active OEM
  # code page. Force UTF-8 so JSON paths containing the localized product name
  # remain machine-readable when consumed by Node or another automation host.
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [pscustomobject]@{
    schema = 'xiaoshe-windows-desktop/v1'
    kind = $DesktopKind
    selectedDesktop = $DesktopExecutable
    installedCandidates = $InstalledDesktopCandidates
    launched = $false
  } | ConvertTo-Json -Depth 3
  exit 0
}

# 正常入口优先独立桌面壳。BrowserFallback 只用于诊断；ServerOnly 仅由
# 桌面壳的服务控制器调用，防止启动器递归。
if (-not $ServerOnly -and -not $BrowserFallback) {
  if ($DesktopExecutable) {
    $DesktopArguments = if ($DesktopExecutable -eq $DeveloperElectron) { @((Join-Path $XsRoot 'apps\desktop-shell')) } else { @() }
    Start-Process -FilePath $DesktopExecutable -ArgumentList $DesktopArguments -WorkingDirectory $XsRoot -WindowStyle Hidden
    exit 0
  }
  Write-Warning '独立桌面壳尚未安装；本次回退到浏览器。完成安装后默认入口会自动切换为桌面窗口。'
}
$DshRoot = Join-Path $XsRoot 'runtime\DSH'
$LegacyRoot = Join-Path $XsRoot 'runtime\xiaoshe-legacy'
$Node = (Get-Command node -ErrorAction Stop).Source
$Python = (Get-Command python -ErrorAction Stop).Source
$PinnedPnpm = Join-Path $HOME '.xiaoshe\pnpm-11.7.0\node_modules\.bin\pnpm.cmd'
$Installer = Join-Path $XsRoot 'setup\install-windows.ps1'
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$ProfileRoot = Join-Path $DshHome 'profiles\web'
$OwnerHelper = Join-Path $XsRoot 'scripts\windows-process-owner.mjs'
$StateRoot = Join-Path $env:LOCALAPPDATA 'Xiaoshe'
$LogRoot = Join-Path $StateRoot 'Logs'
$Port = if ($env:XIAOSHE_DSH_PORT) { [int]$env:XIAOSHE_DSH_PORT } else { 3080 }
$StateFileName = if ($Port -eq 3080) { 'dsh-web-state.json' } else { "dsh-web-state-$Port.json" }
$StatePath = Join-Path $StateRoot $StateFileName
$HostAddress = '127.0.0.1'
$Url = "http://${HostAddress}:$Port/"
$StatusUrl = "${Url}xiaoshe/desktop/status"

$env:XIAOSHE_DSH_ROOT = $DshRoot
$env:XIAOSHE_LEGACY_ROOT = $LegacyRoot
$env:XIAOSHE_PYTHON = $Python
$env:XIAOSHE_DSH_HOST = $HostAddress
$env:XIAOSHE_DSH_PORT = [string]$Port

function Read-Health {
  try {
    return Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 2 -ErrorAction Stop
  } catch {
    return $null
  }
}

function Read-OwnerState {
  if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
  $Json = & $Node $OwnerHelper read --path $StatePath
  if ($LASTEXITCODE -ne 0) { throw '小蛇进程所有权状态损坏，拒绝复用或覆盖。' }
  return $Json | ConvertFrom-Json
}

function Resolve-InstalledPackageTarget([string]$Installed) {
  # Resolve-Path normalizes the junction's own path but does not dereference
  # pnpm's Windows junction. Inspect the reparse-point target explicitly so a
  # stale profile cannot be mistaken for the current packaged product.
  $Item = Get-Item -LiteralPath $Installed -Force -ErrorAction Stop
  $Targets = @($Item.Target | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
  if ($Targets.Count -ne 1) { return $null }
  $Target = [string]$Targets[0]
  if (-not [IO.Path]::IsPathRooted($Target)) {
    $Target = Join-Path (Split-Path -Parent $Installed) $Target
  }
  return (Resolve-Path -LiteralPath $Target -ErrorAction Stop).Path.TrimEnd('\')
}

function Test-CurrentProductPackages {
  if (-not (Test-Path -LiteralPath (Join-Path $ProfileRoot 'package.json') -PathType Leaf)) { return $false }
  $ExpectedPackages = [ordered]@{
    '@xiaoshe\dsh-desktop-control' = $XsRoot
    '@xiaoshe\verification-policy' = (Join-Path $XsRoot 'packages\verification-policy')
    '@xiaoshe\native-shell-legacy-adapted' = (Join-Path $XsRoot 'packages\native-shell-legacy-adapted')
    '@xiaoshe\runtime-dsh-provider' = (Join-Path $XsRoot 'packages\runtime-dsh-provider')
    '@xiaoshe\completion-receipt' = (Join-Path $XsRoot 'packages\completion-receipt')
    '@xiaoshe\runtime-contract' = (Join-Path $XsRoot 'packages\runtime-contract')
    '@xiaoshe\heartbeat' = (Join-Path $XsRoot 'packages\heartbeat')
    '@xiaoshe\memory' = (Join-Path $XsRoot 'packages\memory')
    '@xiaoshe\plugin-governance' = (Join-Path $XsRoot 'packages\plugin-governance')
    '@xiaoshe\provider-readiness' = (Join-Path $XsRoot 'packages\provider-readiness')
    '@xiaoshe\migration-recovery' = (Join-Path $XsRoot 'packages\migration-recovery')
    '@xiaoshe\coding-workbench' = (Join-Path $XsRoot 'packages\coding-workbench')
    '@xiaoshe\task-timeline' = (Join-Path $XsRoot 'packages\task-timeline')
    '@deepseek-ai\dsh-tool-session-query' = (Join-Path $DshRoot 'packages\session-query\tool-session-query')
    '@xiaoshe\product-bundle' = (Join-Path $XsRoot 'packages\product-bundle')
  }
  foreach ($Entry in $ExpectedPackages.GetEnumerator()) {
    $Installed = Join-Path (Join-Path $ProfileRoot 'node_modules') $Entry.Key
    if (-not (Test-Path -LiteralPath $Installed)) { return $false }
    try {
      $InstalledPath = Resolve-InstalledPackageTarget $Installed
      $ExpectedPath = (Resolve-Path -LiteralPath $Entry.Value).Path.TrimEnd('\')
    } catch { return $false }
    if (-not $InstalledPath) { return $false }
    if (-not [string]::Equals($InstalledPath, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  }
  return $true
}

if (-not (Test-Path -LiteralPath $PinnedPnpm) `
  -or -not (Test-Path -LiteralPath (Join-Path $DshRoot 'apps\cli\lib\bin.js')) `
  -or -not (Test-Path -LiteralPath (Join-Path $XsRoot 'node_modules')) `
  -or -not (Test-Path -LiteralPath (Join-Path $DshRoot 'node_modules')) `
  -or -not (Test-CurrentProductPackages)) {
  Write-Host '[首次启动] 正在安装、构建并验证 Windows 依赖…' -ForegroundColor Cyan
  & $Installer
  if ($LASTEXITCODE -ne 0) { throw 'Windows 安装失败。' }
}
if (-not (Test-Path -LiteralPath $PinnedPnpm)) { throw '项目专用 pnpm 11.7.0 不存在，请重新运行 setup/install-windows.ps1。' }
if (-not (Test-CurrentProductPackages)) { throw '正式 web Profile 未能同步到当前小蛇产品包。' }

$Connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($Connections.Count -gt 0) {
  $State = Read-OwnerState
  $Health = Read-Health
  $Owned = $false
  if ($State -and $Health -and $State.port -eq $Port -and $State.xsRoot -eq $XsRoot) {
    $Owned = @($Connections | Where-Object { $_.OwningProcess -eq $State.pid }).Count -gt 0
  }
  if (-not $Owned) { throw "端口 $Port 由非当前 XS 实例占用，未结束也未覆盖。" }
  Write-Host "[已运行] 小蛇 DSH 已就绪：$Url" -ForegroundColor Green
  if (-not $NoOpen) { Start-Process $Url }
  exit 0
}

New-Item -ItemType Directory -Force $StateRoot, $LogRoot | Out-Null
$Stdout = Join-Path $LogRoot 'dsh-web.stdout.log'
$Stderr = Join-Path $LogRoot 'dsh-web.stderr.log'
$DshEntry = Join-Path $DshRoot 'apps\cli\lib\bin.js'
$Arguments = @(
  ('"{0}"' -f $DshEntry), 'web', '--no-open', '--host', $HostAddress, '--port', [string]$Port
)
Write-Host '[启动] DSH web profile + 小蛇 + ModLens…' -ForegroundColor Cyan
$Process = Start-Process -FilePath $Node -ArgumentList $Arguments -WorkingDirectory $DshRoot `
  -WindowStyle Hidden -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru
$CimProcess = $null
for ($Attempt = 0; $Attempt -lt 20 -and -not $CimProcess; $Attempt++) {
  $CimProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.Id)" -ErrorAction SilentlyContinue
  if (-not $CimProcess) { Start-Sleep -Milliseconds 100 }
}
if (-not $CimProcess) { throw 'DSH 进程启动后无法读取进程身份。' }
$CreationDate = $CimProcess.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
& $Node $OwnerHelper write --path $StatePath --pid $Process.Id --port $Port `
  --xs-root $XsRoot --dsh-root $DshRoot --creation-date $CreationDate | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法记录小蛇进程所有权。' }

for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
  $Health = Read-Health
  if ($Health) {
    Write-Host "[就绪] 小蛇 DSH 已通过健康检查：$Url" -ForegroundColor Green
    if (-not $NoOpen) { Start-Process $Url }
    exit 0
  }
  if ($Process.HasExited) { break }
  Start-Sleep -Milliseconds 500
}

if (-not $Process.HasExited) { & taskkill.exe /PID $Process.Id /T /F | Out-Null }
& $Node $OwnerHelper remove --path $StatePath
$Tail = if (Test-Path -LiteralPath $Stderr) { (Get-Content -LiteralPath $Stderr -Tail 30) -join "`n" } else { '' }
throw "小蛇 DSH 未能在 30 秒内通过健康检查。`n$Tail"
