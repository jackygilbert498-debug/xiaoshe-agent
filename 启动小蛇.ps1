[CmdletBinding()]
param([switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$XsRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
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
$StatePath = Join-Path $StateRoot 'dsh-web-state.json'
$LogRoot = Join-Path $StateRoot 'Logs'
$Port = if ($env:XIAOSHE_DSH_PORT) { [int]$env:XIAOSHE_DSH_PORT } else { 3080 }
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

if (-not (Test-Path -LiteralPath $PinnedPnpm) `
  -or -not (Test-Path -LiteralPath (Join-Path $DshRoot 'apps\cli\lib\bin.js')) `
  -or -not (Test-Path -LiteralPath (Join-Path $XsRoot 'node_modules')) `
  -or -not (Test-Path -LiteralPath (Join-Path $DshRoot 'node_modules')) `
  -or -not (Test-Path -LiteralPath (Join-Path $ProfileRoot 'package.json'))) {
  Write-Host '[首次启动] 正在安装、构建并验证 Windows 依赖…' -ForegroundColor Cyan
  & $Installer
  if ($LASTEXITCODE -ne 0) { throw 'Windows 安装失败。' }
}
if (-not (Test-Path -LiteralPath $PinnedPnpm)) { throw '项目专用 pnpm 11.7.0 不存在，请重新运行 setup/install-windows.ps1。' }

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
