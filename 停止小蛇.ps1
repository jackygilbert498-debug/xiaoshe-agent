[CmdletBinding()]
param([string]$OwnershipToken, [string]$LifecycleLeaseToken, [int]$LifecycleLeasePid)

$ErrorActionPreference = 'Stop'
$XsRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$OwnerHelper = Join-Path $XsRoot 'scripts\windows-process-owner.mjs'
$LeaseHelper = Join-Path $XsRoot 'scripts\lifecycle-lease.mjs'
$DefaultPort = if ($env:XIAOSHE_DSH_PORT) { [int]$env:XIAOSHE_DSH_PORT } else { 3080 }
$StateFileName = if ($DefaultPort -eq 3080) { 'dsh-web-state.json' } else { "dsh-web-state-$DefaultPort.json" }
$StatePath = Join-Path $env:LOCALAPPDATA "Xiaoshe\$StateFileName"
$LeasePath = Join-Path $env:LOCALAPPDATA "Xiaoshe\lifecycle-$DefaultPort.lock"
$OwnsLifecycleLease = $false

if (-not (Test-Path -LiteralPath $LeaseHelper -PathType Leaf)) { throw '生命周期互斥模块缺失，拒绝停止。' }
if ([string]::IsNullOrWhiteSpace($LifecycleLeaseToken)) {
  $LeaseJson = & $Node $LeaseHelper acquire --path $LeasePath --pid $PID --wait-ms 15000
  if ($LASTEXITCODE -ne 0) { throw '另一个小蛇启动或停止流程仍在进行，请稍后重试。' }
  $LifecycleLeaseToken = ($LeaseJson | ConvertFrom-Json).token
  $OwnsLifecycleLease = $true
} else {
  if ($LifecycleLeasePid -le 0) { throw '调用方未提供生命周期互斥 owner PID。' }
  & $Node $LeaseHelper check --path $LeasePath --pid $LifecycleLeasePid --token $LifecycleLeaseToken
  if ($LASTEXITCODE -ne 0) { throw '调用方不拥有小蛇生命周期互斥，拒绝嵌套停止。' }
}

try {

if (-not (Test-Path -LiteralPath $StatePath)) {
  $Connections = @(Get-NetTCPConnection -LocalPort $DefaultPort -State Listen -ErrorAction SilentlyContinue)
  if ($Connections.Count -eq 0) { Write-Host "[无需停止] 端口 $DefaultPort 未监听，且没有所有权状态。"; exit 0 }
  throw "端口 $DefaultPort 正在监听，但没有当前 XS 的所有权状态；拒绝结束任何进程。"
}

$StateJson = & $Node $OwnerHelper read --path $StatePath
if ($LASTEXITCODE -ne 0) { throw '小蛇进程所有权状态损坏，拒绝结束任何进程。' }
$State = $StateJson | ConvertFrom-Json
if ($State.xsRoot -ne $XsRoot) { throw '进程所有权状态属于另一个 XS 目录，拒绝结束。' }
if (-not [string]::IsNullOrWhiteSpace($OwnershipToken) -and $State.ownershipToken -ne $OwnershipToken) {
  Write-Host '[未停止] 当前服务不属于本次启动令牌；按复用服务处理。'
  exit 0
}

function Remove-OwnerState([object]$ExpectedState) {
  $RemoveArguments = @('remove', '--path', $StatePath, '--expected-pid', [string]$ExpectedState.pid)
  if ($ExpectedState.legacy) {
    $RemoveArguments += @('--expected-creation-date', [string]$ExpectedState.creationDate)
  } else {
    $RemoveArguments += @('--expected-token', [string]$ExpectedState.ownershipToken)
  }
  & $Node $OwnerHelper @RemoveArguments
  if ($LASTEXITCODE -ne 0) { throw '进程所有权状态已被另一个启动流程替换，拒绝删除。' }
}

$Process = Get-CimInstance Win32_Process -Filter "ProcessId=$($State.pid)" -ErrorAction SilentlyContinue
if (-not $Process) {
  Remove-OwnerState $State
  Write-Host '[已静止] 已记录进程不存在，所有权状态已移除。' -ForegroundColor Green
  exit 0
}
$CreationDate = $Process.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
$CommandLine = [string]$Process.CommandLine
if ($CreationDate -ne $State.creationDate `
  -or -not $CommandLine.ToLowerInvariant().Contains(([string]$State.dshRoot).ToLowerInvariant()) `
  -or $CommandLine -notmatch '(?i)apps[\\/]cli[\\/]lib[\\/]bin\.js') {
  throw "PID $($State.pid) 已被其他进程复用或不属于当前 DSH，拒绝结束。"
}
$OwnedConnections = @(Get-NetTCPConnection -LocalPort ([int]$State.port) -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -eq $State.pid })
if ($OwnedConnections.Count -eq 0) {
  throw "所有权记录 PID $($State.pid) 当前并未监听端口 $($State.port)，拒绝结束进程。"
}

& taskkill.exe /PID $State.pid /T /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "无法结束小蛇 DSH 进程树 PID $($State.pid)。" }
for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
  $Alive = Get-CimInstance Win32_Process -Filter "ProcessId=$($State.pid)" -ErrorAction SilentlyContinue
  $Listening = Get-NetTCPConnection -LocalPort ([int]$State.port) -State Listen -ErrorAction SilentlyContinue
  if (-not $Alive -and -not $Listening) { break }
  Start-Sleep -Milliseconds 250
}
if (Get-CimInstance Win32_Process -Filter "ProcessId=$($State.pid)" -ErrorAction SilentlyContinue) {
  throw "小蛇进程树已请求退出，但 PID $($State.pid) 仍存在；所有权状态已保留。"
}
if (Get-NetTCPConnection -LocalPort ([int]$State.port) -State Listen -ErrorAction SilentlyContinue) {
  throw "小蛇进程树已请求退出，但端口 $($State.port) 仍在监听；所有权状态已保留。"
}
Remove-OwnerState $State
Write-Host "[已停止] 小蛇 DSH PID $($State.pid)，端口 $($State.port) 已释放。" -ForegroundColor Green
} finally {
  if ($OwnsLifecycleLease) {
    & $Node $LeaseHelper release --path $LeasePath --token $LifecycleLeaseToken
    if ($LASTEXITCODE -ne 0) { throw '生命周期互斥所有权已变化；拒绝无声结束停止流程。' }
  }
}
