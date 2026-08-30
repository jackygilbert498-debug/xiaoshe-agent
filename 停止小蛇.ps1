[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$XsRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$Node = (Get-Command node -ErrorAction Stop).Source
$OwnerHelper = Join-Path $XsRoot 'scripts\windows-process-owner.mjs'
$DefaultPort = if ($env:XIAOSHE_DSH_PORT) { [int]$env:XIAOSHE_DSH_PORT } else { 3080 }
$StateFileName = if ($DefaultPort -eq 3080) { 'dsh-web-state.json' } else { "dsh-web-state-$DefaultPort.json" }
$StatePath = Join-Path $env:LOCALAPPDATA "Xiaoshe\$StateFileName"

if (-not (Test-Path -LiteralPath $StatePath)) {
  $Connections = @(Get-NetTCPConnection -LocalPort $DefaultPort -State Listen -ErrorAction SilentlyContinue)
  if ($Connections.Count -eq 0) { Write-Host "[无需停止] 端口 $DefaultPort 未监听，且没有所有权状态。"; exit 0 }
  throw "端口 $DefaultPort 正在监听，但没有当前 XS 的所有权状态；拒绝结束任何进程。"
}

$StateJson = & $Node $OwnerHelper read --path $StatePath
if ($LASTEXITCODE -ne 0) { throw '小蛇进程所有权状态损坏，拒绝结束任何进程。' }
$State = $StateJson | ConvertFrom-Json
if ($State.xsRoot -ne $XsRoot) { throw '进程所有权状态属于另一个 XS 目录，拒绝结束。' }

$Process = Get-CimInstance Win32_Process -Filter "ProcessId=$($State.pid)" -ErrorAction SilentlyContinue
if (-not $Process) {
  & $Node $OwnerHelper remove --path $StatePath
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

& taskkill.exe /PID $State.pid /T /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "无法结束小蛇 DSH 进程树 PID $($State.pid)。" }
for ($Attempt = 0; $Attempt -lt 60; $Attempt++) {
  $Alive = Get-CimInstance Win32_Process -Filter "ProcessId=$($State.pid)" -ErrorAction SilentlyContinue
  $Listening = Get-NetTCPConnection -LocalPort ([int]$State.port) -State Listen -ErrorAction SilentlyContinue
  if (-not $Alive -and -not $Listening) { break }
  Start-Sleep -Milliseconds 250
}
if (Get-NetTCPConnection -LocalPort ([int]$State.port) -State Listen -ErrorAction SilentlyContinue) {
  throw "小蛇进程树已请求退出，但端口 $($State.port) 仍在监听。"
}
& $Node $OwnerHelper remove --path $StatePath
Write-Host "[已停止] 小蛇 DSH PID $($State.pid)，端口 $($State.port) 已释放。" -ForegroundColor Green
