[CmdletBinding()]
param(
  [switch]$NoOpen,
  [switch]$ServerOnly,
  [switch]$BrowserFallback,
  [switch]$CheckOnly,
  [switch]$OwnershipReport,
  [string]$OwnershipToken
)

$ErrorActionPreference = 'Stop'
$XsRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$PendingUpdateMarker = Join-Path $XsRoot 'apps\desktop-shell\dist-desktop\pending-package-update.json'
$PendingUpdateScript = Join-Path $XsRoot 'scripts\windows-promote-desktop-update.ps1'
$PendingDesktopUpdate = [pscustomobject]@{
  schema = 'xiaoshe-pending-desktop-update-result/v1'
  status = 'none'
  candidate = $null
  backup = $null
}
if (Test-Path -LiteralPath $PendingUpdateMarker -PathType Leaf) {
  if (-not (Test-Path -LiteralPath $PendingUpdateScript -PathType Leaf)) {
    throw '检测到待替换桌面包，但安全替换脚本缺失。'
  }
  $PendingDesktopUpdate = & $PendingUpdateScript -XsRoot $XsRoot -CheckOnly:$CheckOnly
  if (-not $CheckOnly -and $PendingDesktopUpdate.status -eq 'running') {
    Write-Warning '新桌面包已就绪，但旧版小蛇仍在运行。请在托盘菜单退出小蛇后，再执行一次 ss；下次会先完成替换再启动。'
    exit 0
  }
}
function Test-ElectronDistribution([string]$Executable, [switch]$RequireAppAsar) {
  if ([string]::IsNullOrWhiteSpace($Executable) -or -not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
    return $false
  }
  $DistributionRoot = Split-Path -Parent $Executable
  foreach ($RequiredName in @('icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin')) {
    if (-not (Test-Path -LiteralPath (Join-Path $DistributionRoot $RequiredName) -PathType Leaf)) {
      return $false
    }
  }
  $LocalesRoot = Join-Path $DistributionRoot 'locales'
  if (-not (Test-Path -LiteralPath $LocalesRoot -PathType Container)) { return $false }
  $Locale = Get-ChildItem -LiteralPath $LocalesRoot -Filter '*.pak' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $Locale) { return $false }
  if ($RequireAppAsar -and -not (Test-Path -LiteralPath (Join-Path $DistributionRoot 'resources\app.asar') -PathType Leaf)) {
    return $false
  }
  return $true
}

$InstalledDesktopCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\小蛇\小蛇.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Xiaoshe\小蛇.exe')
)
$InstalledDesktop = $InstalledDesktopCandidates | Where-Object { Test-ElectronDistribution -Executable $_ -RequireAppAsar } | Select-Object -First 1
$DeveloperDesktop = Join-Path $XsRoot 'apps\desktop-shell\dist-desktop\win-unpacked\小蛇.exe'
$DeveloperElectron = Join-Path $XsRoot 'apps\desktop-shell\node_modules\electron\dist\electron.exe'
$DeveloperDesktopReady = Test-ElectronDistribution -Executable $DeveloperDesktop -RequireAppAsar
$DeveloperElectronReady = (Test-ElectronDistribution -Executable $DeveloperElectron) `
  -and (Test-Path -LiteralPath (Join-Path $XsRoot 'apps\desktop-shell\package.json') -PathType Leaf)
$DesktopExecutable = if ($InstalledDesktop) {
  $InstalledDesktop
} elseif ($DeveloperDesktopReady) {
  $DeveloperDesktop
} elseif ($DeveloperElectronReady) {
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
  $CheckReport = [pscustomobject]@{
    schema = 'xiaoshe-windows-desktop/v1'
    kind = $DesktopKind
    selectedDesktop = $DesktopExecutable
    installedCandidates = $InstalledDesktopCandidates
    pendingDesktopUpdate = $PendingDesktopUpdate
    launched = $false
  }
  # Windows PowerShell 5.1 uses the active OEM code page for redirected output.
  # Escape non-ASCII JSON characters instead of mutating process-wide Console
  # encoding, so every machine consumer receives an unambiguous ASCII transport.
  $Json = $CheckReport | ConvertTo-Json -Depth 3
  $AsciiJson = @(
    foreach ($Character in $Json.ToCharArray()) {
      $CodeUnit = [int]$Character
      if ($CodeUnit -le 0x7F) {
        [string]$Character
      } else {
        '\u{0:x4}' -f $CodeUnit
      }
    }
  ) -join ''
  Write-Output $AsciiJson
  exit 0
}

# 正常入口优先独立桌面壳。BrowserFallback 只用于诊断；ServerOnly 仅由
# 桌面壳的服务控制器调用，防止启动器递归。
if (-not $ServerOnly -and -not $BrowserFallback) {
  if ($DesktopExecutable) {
    # A locally built shell must share the checkout used by s. Otherwise the
    # same 0.2.0 build reuses an older per-user runtime and silently misses new
    # plugins. Installed apps retain versioned runtimes; explicit overrides win.
    $SavedProductRoot = $env:XIAOSHE_PRODUCT_ROOT
    $UseCheckoutRoot = -not $InstalledDesktop -and [string]::IsNullOrWhiteSpace($SavedProductRoot)
    try {
      if ($UseCheckoutRoot) { $env:XIAOSHE_PRODUCT_ROOT = $XsRoot }
      # This is the interactive GUI requested by ss, not a background helper.
      # Hidden reaches Windows STARTUPINFO and can suppress its first ShowWindow.
      # Only the separate Node service below should start with a hidden window.
      if ($DesktopExecutable -eq $DeveloperElectron) {
        # Start-Process flattens ArgumentList into a Windows command line. Keep
        # the application directory quoted so repositories with spaces stay one argv.
        $ElectronAppArgument = '"{0}"' -f (Join-Path $XsRoot 'apps\desktop-shell')
        Start-Process -FilePath $DesktopExecutable -ArgumentList $ElectronAppArgument -WorkingDirectory $XsRoot -WindowStyle Normal
      } else {
        Start-Process -FilePath $DesktopExecutable -WorkingDirectory $XsRoot -WindowStyle Normal
      }
    } finally {
      if ($UseCheckoutRoot) {
        if ($null -eq $SavedProductRoot) { Remove-Item Env:\XIAOSHE_PRODUCT_ROOT -ErrorAction SilentlyContinue }
        else { $env:XIAOSHE_PRODUCT_ROOT = $SavedProductRoot }
      }
    }
    exit 0
  }
  Write-Warning '独立桌面壳尚未安装；本次回退到浏览器。完成安装后默认入口会自动切换为桌面窗口。'
}
$DshRoot = Join-Path $XsRoot 'runtime\DSH'
$LegacyRoot = Join-Path $XsRoot 'runtime\xiaoshe-legacy'
$Node = (Get-Command node -ErrorAction Stop).Source
$PinnedPnpm = Join-Path $HOME '.xiaoshe\pnpm-11.7.0\node_modules\.bin\pnpm.cmd'
$Installer = Join-Path $XsRoot 'setup\install-windows.ps1'
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$ProfileRoot = Join-Path $DshHome 'profiles\web'
$OwnerHelper = Join-Path $XsRoot 'scripts\windows-process-owner.mjs'
$IdentityHelper = Join-Path $XsRoot 'scripts\product-runtime-identity.mjs'
$LeaseHelper = Join-Path $XsRoot 'scripts\lifecycle-lease.mjs'
$ProxyHelper = Join-Path $XsRoot 'scripts\windows-proxy-environment.ps1'
$ProductBuildHelper = Join-Path $XsRoot 'scripts\windows-build-product.ps1'
$StateRoot = Join-Path $env:LOCALAPPDATA 'Xiaoshe'
$LogRoot = Join-Path $StateRoot 'Logs'
$Port = if ($env:XIAOSHE_DSH_PORT) { [int]$env:XIAOSHE_DSH_PORT } else { 3080 }
$StateFileName = if ($Port -eq 3080) { 'dsh-web-state.json' } else { "dsh-web-state-$Port.json" }
$StatePath = Join-Path $StateRoot $StateFileName
$LeasePath = Join-Path $StateRoot "lifecycle-$Port.lock"
$HostAddress = '127.0.0.1'
$Url = "http://${HostAddress}:$Port/"
$StatusUrl = "${Url}xiaoshe/desktop/status"

# Bind diagnostics to the roots this launcher actually uses. In particular,
# standalone s has no desktop parent to supply PRODUCT_ROOT / PROFILE_ROOT.
$env:XIAOSHE_PRODUCT_ROOT = $XsRoot
$env:XIAOSHE_PROFILE_ROOT = $ProfileRoot
$env:XIAOSHE_DSH_ROOT = $DshRoot
$env:XIAOSHE_LEGACY_ROOT = $LegacyRoot
$env:XIAOSHE_DSH_HOST = $HostAddress
$env:XIAOSHE_DSH_PORT = [string]$Port
$LaunchToken = if ([string]::IsNullOrWhiteSpace($OwnershipToken)) { [guid]::NewGuid().ToString() } else { $OwnershipToken.Trim() }
if ($LaunchToken -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') { throw '启动所有权令牌无效。' }
$env:XIAOSHE_LAUNCH_TOKEN = $LaunchToken

function Read-Health {
  try {
    return Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 2 -ErrorAction Stop
  } catch {
    return $null
  }
}

function Resolve-CompatiblePython {
  $Candidates = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($env:XIAOSHE_PYTHON)) { $Candidates.Add($env:XIAOSHE_PYTHON.Trim()) }
  $PyLauncher = Get-Command 'py.exe' -ErrorAction SilentlyContinue
  if ($PyLauncher) {
    $FromLauncher = (& $PyLauncher.Source -3 -c 'import os,sys; print(os.path.realpath(sys.executable))' 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($FromLauncher)) { $Candidates.Add($FromLauncher.Trim()) }
  }
  foreach ($Name in @('python.exe', 'python3.exe', 'python')) {
    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($Command -and -not [string]::IsNullOrWhiteSpace($Command.Source)) { $Candidates.Add($Command.Source) }
  }
  foreach ($Candidate in $Candidates | Select-Object -Unique) {
    if ($Candidate.IndexOf('\WindowsApps\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { continue }
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { continue }
    & $Candidate -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>$null
    if ($LASTEXITCODE -eq 0) { return (Resolve-Path -LiteralPath $Candidate).Path }
  }
  throw '未找到真实的 Python 3.10+ 解释器；Windows Store 的占位别名不受支持。'
}

function Write-OwnershipReport([ValidateSet('started', 'reused')][string]$Status, [string]$Token = '', [string]$Identity = '') {
  if (-not $OwnershipReport) { return }
  if ($Identity -notmatch '^[a-f0-9]{64}$') { throw '小蛇启动所有权报告缺少有效运行身份。' }
  $Fields = [ordered]@{ schema = 'xiaoshe-launch-ownership/v1'; status = $Status }
  if ($Status -eq 'started') { $Fields.token = $Token }
  $Fields.identity = $Identity
  $Fields.loginUrl = $AuthenticatedUrl
  $Report = $Fields | ConvertTo-Json -Compress
  Write-Output "XIAOSHE_LAUNCH_OWNERSHIP=$Report"
}

function Resolve-LaunchLogin([string]$Identity) {
  # Only called after the existing PID/root/identity ownership checks.
  $LoginHelper = Join-Path $XsRoot 'scripts\dsh-launch-auth.mjs'
  $LoginLog = Join-Path $LogRoot ("dsh-web-{0}.stdout.log" -f $Port)
  $LoginUrl = & $Node $LoginHelper --log $LoginLog --base $Url --identity $Identity
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($LoginUrl)) { throw '无法取得当前小蛇服务的登录链接；未关闭认证。' }
  return ([string]$LoginUrl).Trim()
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
    '@xiaoshe\project-knowledge' = (Join-Path $XsRoot 'packages\project-knowledge')
    '@xiaoshe\plugin-governance' = (Join-Path $XsRoot 'packages\plugin-governance')
    '@xiaoshe\provider-readiness' = (Join-Path $XsRoot 'packages\provider-readiness')
    '@xiaoshe\migration-recovery' = (Join-Path $XsRoot 'packages\migration-recovery')
    '@xiaoshe\agent-experience' = (Join-Path $XsRoot 'packages\agent-experience')
    '@xiaoshe\coding-workbench' = (Join-Path $XsRoot 'packages\coding-workbench')
    '@xiaoshe\task-timeline' = (Join-Path $XsRoot 'packages\task-timeline')
    '@deepseek-ai\dsh-tool-session-query' = (Join-Path $DshRoot 'packages\session-query\tool-session-query')
    '@deepseek-ai\dsh-web-fetch-http' = (Join-Path $DshRoot 'packages\web\web-fetch-http')
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

if (-not (Test-Path -LiteralPath $LeaseHelper -PathType Leaf)) { throw '生命周期互斥模块缺失，拒绝并发启动。' }
New-Item -ItemType Directory -Force $StateRoot | Out-Null
$LeaseJson = & $Node $LeaseHelper acquire --path $LeasePath --pid $PID --wait-ms 15000
if ($LASTEXITCODE -ne 0) { throw '另一个小蛇启动或停止流程仍在进行，请稍后重试。' }
$LifecycleLeaseToken = ($LeaseJson | ConvertFrom-Json).token
if ([string]::IsNullOrWhiteSpace($LifecycleLeaseToken)) { throw '生命周期互斥所有权无效。' }

try {
# Fast-path reuse is deliberately before install, Profile repair and build. A
# healthy service whose persisted content identity still matches this checkout
# must open without mutating its live runtime or requiring free build space.
$EarlyConnections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($EarlyConnections.Count -gt 0 -and (Test-Path -LiteralPath $StatePath -PathType Leaf) `
  -and (Test-Path -LiteralPath (Join-Path $ProfileRoot 'package.json') -PathType Leaf) `
  -and (Test-Path -LiteralPath $IdentityHelper -PathType Leaf)) {
  $EarlyState = Read-OwnerState
  $EarlyHealth = Read-Health
  $EarlyProcess = if ($EarlyState) { Get-CimInstance Win32_Process -Filter "ProcessId=$($EarlyState.pid)" -ErrorAction SilentlyContinue } else { $null }
  $EarlyCreationDate = if ($EarlyProcess) { $EarlyProcess.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() } else { '' }
  $EarlyCommand = if ($EarlyProcess) { [string]$EarlyProcess.CommandLine } else { '' }
  $EarlyOwnsListener = $EarlyState -and -not $EarlyState.legacy -and $EarlyProcess `
    -and $EarlyState.port -eq $Port -and $EarlyState.xsRoot -eq $XsRoot -and $EarlyState.dshRoot -eq $DshRoot `
    -and $EarlyCreationDate -eq $EarlyState.creationDate `
    -and $EarlyCommand.ToLowerInvariant().Contains(([string]$EarlyState.dshRoot).ToLowerInvariant()) `
    -and @($EarlyConnections | Where-Object { $_.OwningProcess -eq $EarlyState.pid }).Count -gt 0
  if ($EarlyOwnsListener -and $EarlyHealth -and $EarlyHealth.product -eq '小蛇' -and $EarlyHealth.bridge.state -eq 'ready' `
    -and $EarlyHealth.runtime_identity -eq $EarlyState.runtimeIdentity) {
    $EarlyIdentityJson = & $Node $IdentityHelper --root $XsRoot --dsh-root $DshRoot --profile-root $ProfileRoot 2>$null
    $EarlyRuntimeIdentity = if ($LASTEXITCODE -eq 0) { ($EarlyIdentityJson | ConvertFrom-Json).identity } else { '' }
    if ($EarlyRuntimeIdentity -eq $EarlyState.runtimeIdentity) {
      $AuthenticatedUrl = Resolve-LaunchLogin $EarlyRuntimeIdentity
      Write-Host "[已运行] 小蛇 DSH 已就绪：$Url" -ForegroundColor Green
      if (-not $NoOpen) { Start-Process $AuthenticatedUrl }
      Write-OwnershipReport 'reused' '' $EarlyRuntimeIdentity
      exit 0
    }
  }
}

$Python = Resolve-CompatiblePython
$env:XIAOSHE_PYTHON = $Python

if (-not (Test-Path -LiteralPath $PinnedPnpm) `
  -or -not (Test-Path -LiteralPath (Join-Path $DshRoot 'apps\cli\lib\bin.js')) `
  -or -not (Test-Path -LiteralPath (Join-Path $XsRoot 'node_modules')) `
  -or -not (Test-Path -LiteralPath (Join-Path $DshRoot 'node_modules')) `
  -or -not (Test-CurrentProductPackages)) {
  Write-Host '[首次启动] 正在安装、构建并验证 Windows 依赖…' -ForegroundColor Cyan
  $HadSetupSkipCliInstall = Test-Path Env:\XIAOSHE_SETUP_SKIP_CLI_INSTALL
  $SavedSetupSkipCliInstall = $env:XIAOSHE_SETUP_SKIP_CLI_INSTALL
  $InstallerExitCode = 0
  try {
    # ServerOnly is an internal desktop-shell repair path. Its product root can
    # be an acceptance or staged runtime, so it must not repoint the persistent
    # user-level s/ss wrappers while repairing runtime dependencies.
    if ($ServerOnly) { $env:XIAOSHE_SETUP_SKIP_CLI_INSTALL = '1' }
    & $Installer
    $InstallerExitCode = $LASTEXITCODE
  } finally {
    if ($HadSetupSkipCliInstall) { $env:XIAOSHE_SETUP_SKIP_CLI_INSTALL = $SavedSetupSkipCliInstall }
    else { Remove-Item Env:\XIAOSHE_SETUP_SKIP_CLI_INSTALL -ErrorAction SilentlyContinue }
  }
  if ($InstallerExitCode -ne 0) { throw 'Windows 安装失败。' }
}
if (-not (Test-Path -LiteralPath $PinnedPnpm)) { throw '项目专用 pnpm 11.7.0 不存在，请重新运行 setup/install-windows.ps1。' }
if (-not (Test-CurrentProductPackages)) { throw '正式 web Profile 未能同步到当前小蛇产品包。' }
if (-not (Test-Path -LiteralPath $ProductBuildHelper -PathType Leaf)) { throw 'Windows 非交互构建模块缺失，请重新安装小蛇。' }
& $ProductBuildHelper -XsRoot $XsRoot -Pnpm $PinnedPnpm
if (-not (Test-Path -LiteralPath $IdentityHelper -PathType Leaf)) { throw '运行身份计算模块缺失，拒绝复用服务。' }
$IdentityJson = & $Node $IdentityHelper --root $XsRoot --dsh-root $DshRoot --profile-root $ProfileRoot
if ($LASTEXITCODE -ne 0) { throw '无法计算当前小蛇内容与 Profile 运行身份。' }
$RuntimeIdentity = ($IdentityJson | ConvertFrom-Json).identity
if ([string]::IsNullOrWhiteSpace($RuntimeIdentity) -or $RuntimeIdentity -notmatch '^[a-f0-9]{64}$') { throw '当前小蛇运行身份无效，拒绝复用服务。' }
$env:XIAOSHE_RUNTIME_IDENTITY = $RuntimeIdentity
if (-not (Test-Path -LiteralPath $ProxyHelper -PathType Leaf)) { throw 'Windows 网络代理配置模块缺失，请重新安装小蛇。' }
. $ProxyHelper
$NodeVersion = (& $Node --version).Trim()
if (-not (Test-XiaosheNodeProxyVersion $NodeVersion)) {
  throw "当前 Node.js $NodeVersion 不支持安全代理启动；需要 22.23+ 或 24.17+（推荐 Node 24 LTS）。"
}

$Connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($Connections.Count -gt 0) {
  $State = Read-OwnerState
  $Health = Read-Health
  $Owned = $false
  $StateProcess = if ($State) { Get-CimInstance Win32_Process -Filter "ProcessId=$($State.pid)" -ErrorAction SilentlyContinue } else { $null }
  $StateCreationDate = if ($StateProcess) { $StateProcess.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() } else { '' }
  $StateCommand = if ($StateProcess) { [string]$StateProcess.CommandLine } else { '' }
  $StateOwnsListener = $State -and @($Connections | Where-Object { $_.OwningProcess -eq $State.pid }).Count -gt 0
  $AuthenticatedProcess = $State -and $StateProcess -and $StateOwnsListener `
    -and $State.port -eq $Port -and $State.xsRoot -eq $XsRoot -and $State.dshRoot -eq $DshRoot `
    -and $StateCreationDate -eq $State.creationDate `
    -and $StateCommand.ToLowerInvariant().Contains($DshRoot.ToLowerInvariant()) `
    -and $StateCommand -match '(?i)apps[\\/]cli[\\/]lib[\\/]bin\.js'
  $HealthyIdentity = $Health -and $Health.product -eq '小蛇' -and $Health.bridge.state -eq 'ready' `
    -and $Health.runtime_identity -eq $RuntimeIdentity
  if ($AuthenticatedProcess -and $HealthyIdentity -and $State.legacy) {
    & $Node $OwnerHelper migrate --path $StatePath `
      --expected-pid $State.pid --expected-port $State.port `
      --expected-xs-root $State.xsRoot --expected-dsh-root $State.dshRoot `
      --expected-creation-date $State.creationDate `
      --runtime-identity $RuntimeIdentity --ownership-token $LaunchToken | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '旧版进程所有权在认证迁移期间发生变化，拒绝复用。' }
    $State = Read-OwnerState
  }
  if ($AuthenticatedProcess -and $HealthyIdentity -and -not $State.legacy `
    -and $State.runtimeIdentity -eq $RuntimeIdentity) {
    $Owned = $true
  }
  if (-not $Owned) {
    if (-not $AuthenticatedProcess) { throw "端口 $Port 由非当前 XS 实例占用，未结束也未覆盖。" }
    Write-Host '[更新] 已运行服务内容或 Profile 身份不匹配，正在安全切换到当前运行时…' -ForegroundColor Cyan
    & (Join-Path $XsRoot 'scripts\windows-stop-entry.ps1') `
      -LifecycleLeaseToken $LifecycleLeaseToken -LifecycleLeasePid $PID
    if ($LASTEXITCODE -ne 0) { throw '旧小蛇服务身份不匹配且无法安全停止，拒绝覆盖。' }
    $Connections = @()
  }
  if ($Owned) {
  $AuthenticatedUrl = Resolve-LaunchLogin $RuntimeIdentity
  Write-Host "[已运行] 小蛇 DSH 已就绪：$Url" -ForegroundColor Green
  if (-not $NoOpen) { Start-Process $AuthenticatedUrl }
  Write-OwnershipReport 'reused' '' $RuntimeIdentity
  exit 0
  }
}

New-Item -ItemType Directory -Force $StateRoot, $LogRoot | Out-Null
$Stdout = Join-Path $LogRoot ("dsh-web-{0}.stdout.log" -f $Port)
$Stderr = Join-Path $LogRoot ("dsh-web-{0}.stderr.log" -f $Port)
$DshEntry = Join-Path $DshRoot 'apps\cli\lib\bin.js'
$Arguments = @(
  '--use-env-proxy', ('"{0}"' -f $DshEntry), 'web', '--no-open', '--host', $HostAddress, '--port', [string]$Port
)
Write-Host '[启动] DSH web profile + 小蛇 + ModLens…' -ForegroundColor Cyan
$InternetSettings = $null
try {
  $InternetSettings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
} catch {
  # A machine with no explicit user proxy remains on Node's normal direct path.
}
$ProxyEnvironment = Resolve-XiaosheWindowsProxyEnvironment `
  -HttpProxy $env:HTTP_PROXY `
  -HttpsProxy $env:HTTPS_PROXY `
  -NoProxy $env:NO_PROXY `
  -SystemProxyEnabled ($null -ne $InternetSettings -and $InternetSettings.ProxyEnable -eq 1) `
  -SystemProxyServer $(if ($null -ne $InternetSettings) { [string]$InternetSettings.ProxyServer } else { '' }) `
  -SystemProxyOverride $(if ($null -ne $InternetSettings) { [string]$InternetSettings.ProxyOverride } else { '' })

$ProcessHolder = [pscustomobject]@{ value = $null }
$Process = $null
$StateRecorded = $false
try {
$null = Invoke-XiaosheWithProxyEnvironment -ProxyEnvironment $ProxyEnvironment -Action {
  $ProcessHolder.value = Start-Process -FilePath $Node -ArgumentList $Arguments -WorkingDirectory $DshRoot `
    -WindowStyle Hidden -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru
}
$Process = $ProcessHolder.value
if (-not $Process) { throw 'DSH 进程未能启动。' }
$CimProcess = $null
for ($Attempt = 0; $Attempt -lt 20 -and -not $CimProcess; $Attempt++) {
  $CimProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.Id)" -ErrorAction SilentlyContinue
  if (-not $CimProcess) { Start-Sleep -Milliseconds 100 }
}
if (-not $CimProcess) { throw 'DSH 进程启动后无法读取进程身份。' }
$CreationDate = $CimProcess.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
& $Node $OwnerHelper write --path $StatePath --pid $Process.Id --port $Port `
  --xs-root $XsRoot --dsh-root $DshRoot --runtime-identity $RuntimeIdentity --ownership-token $LaunchToken --creation-date $CreationDate | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法记录小蛇进程所有权。' }
$StateRecorded = $true

for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
  $Health = Read-Health
  if ($Health -and $Health.product -eq '小蛇' -and $Health.bridge.state -eq 'ready' -and $Health.runtime_identity -eq $RuntimeIdentity) {
    $AuthenticatedUrl = Resolve-LaunchLogin $RuntimeIdentity
    Write-Host "[就绪] 小蛇 DSH 已通过健康检查：$Url" -ForegroundColor Green
    if (-not $NoOpen) { Start-Process $AuthenticatedUrl }
    Write-OwnershipReport 'started' $LaunchToken $RuntimeIdentity
    exit 0
  }
  if ($Process.HasExited) { break }
  Start-Sleep -Milliseconds 500
}

$Tail = if (Test-Path -LiteralPath $Stderr) { (Get-Content -LiteralPath $Stderr -Tail 30) -join "`n" } else { '' }
throw "小蛇 DSH 未能在 30 秒内通过健康检查。`n$Tail"
} catch {
  $Primary = $_.Exception
  if (-not $Process) { $Process = $ProcessHolder.value }
  $CleanupFailure = $null
  if ($Process -and -not $Process.HasExited) {
    & taskkill.exe /PID $Process.Id /T /F | Out-Null
    $TaskkillExitCode = $LASTEXITCODE
    if ($TaskkillExitCode -ne 0) {
      $CleanupFailure = [Exception]::new("无法补偿结束新启动的进程树 PID $($Process.Id)。")
    } else {
      for ($CleanupAttempt = 0; $CleanupAttempt -lt 60; $CleanupAttempt++) {
        $Alive = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.Id)" -ErrorAction SilentlyContinue
        $Listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $Alive -and -not $Listening) { break }
        Start-Sleep -Milliseconds 250
      }
      $Alive = Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.Id)" -ErrorAction SilentlyContinue
      $Listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
      if ($Alive -or $Listening) {
        $CleanupFailure = [Exception]::new("新启动的进程树 PID $($Process.Id) 未经验证完全停止；所有权状态必须保留。")
      }
    }
  }
  if (-not $CleanupFailure -and $StateRecorded) {
    & $Node $OwnerHelper remove --path $StatePath --expected-pid $Process.Id --expected-token $LaunchToken
    if ($LASTEXITCODE -ne 0) {
      $CleanupFailure = [Exception]::new('新进程已经停止，但所有权状态已被另一个流程替换；拒绝删除。')
    }
  }
  if ($CleanupFailure) {
    throw [AggregateException]::new('小蛇启动失败，且新进程补偿停止失败；所有权状态已保留。', @($Primary, $CleanupFailure))
  }
  throw $Primary
}
} finally {
  & $Node $LeaseHelper release --path $LeasePath --token $LifecycleLeaseToken
  if ($LASTEXITCODE -ne 0) { throw '生命周期互斥所有权已变化；拒绝无声结束启动流程。' }
}
