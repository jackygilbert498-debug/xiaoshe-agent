[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TerminalArguments
)

$ErrorActionPreference = 'Stop'
$XsRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$HostStarter = Join-Path $XsRoot 'scripts\windows-start-entry.ps1'
$TerminalEntry = Join-Path $XsRoot 'packages\terminal-client\lib\bin.js'
$TerminalSource = Join-Path $XsRoot 'packages\terminal-client\src'
$PinnedPnpm = Join-Path $HOME '.xiaoshe\pnpm-11.7.0\node_modules\.bin\pnpm.cmd'
$WindowsPowerShell = Join-Path $PSHOME 'powershell.exe'

$Port = 3080
if (-not [string]::IsNullOrWhiteSpace($env:XIAOSHE_DSH_PORT)) {
  $ParsedPort = 0
  if (-not [int]::TryParse($env:XIAOSHE_DSH_PORT, [ref]$ParsedPort) -or $ParsedPort -lt 1 -or $ParsedPort -gt 65535) {
    throw 'XIAOSHE_DSH_PORT must be an integer between 1 and 65535.'
  }
  $Port = $ParsedPort
}

$NodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$NodePath = if ($null -eq $NodeCommand) { $null } else { $NodeCommand.Source }
$NodeMajor = 0
if ($NodePath) {
  $VersionOutput = ([string](& $NodePath --version)).Trim()
  if ($LASTEXITCODE -eq 0 -and $VersionOutput -match '^v([0-9]+)\.') {
    [void][int]::TryParse($Matches[1], [ref]$NodeMajor)
  }
}

if ($CheckOnly) {
  [pscustomobject]@{
    schema = 'xiaoshe-windows-terminal/v1'
    xsRoot = $XsRoot
    port = $Port
    hostStarted = $false
    hostStarter = $HostStarter
    terminalEntry = $TerminalEntry
    terminalBuilt = (Test-Path -LiteralPath $TerminalEntry -PathType Leaf)
    nodePath = $NodePath
    nodeMajor = $NodeMajor
    pinnedPnpm = $PinnedPnpm
    pinnedPnpmAvailable = (Test-Path -LiteralPath $PinnedPnpm -PathType Leaf)
  } | ConvertTo-Json -Depth 3
  exit 0
}

if (-not (Test-Path -LiteralPath $HostStarter -PathType Leaf)) { throw "Missing host launcher: $HostStarter" }
if (-not (Test-Path -LiteralPath $WindowsPowerShell -PathType Leaf)) { throw "Missing Windows PowerShell: $WindowsPowerShell" }
if (-not $NodePath -or $NodeMajor -lt 24) { throw 'Xiaoshe terminal requires Node.js 24 or newer.' }

# Start or reuse the authoritative DSH Host in a child PowerShell process. The
# child boundary is required because the shared launcher intentionally exits.
& $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $HostStarter -NoOpen -ServerOnly
if ($LASTEXITCODE -ne 0) { throw "Xiaoshe Host launcher exited $LASTEXITCODE." }

$NeedsBuild = -not (Test-Path -LiteralPath $TerminalEntry -PathType Leaf)
if (-not $NeedsBuild) {
  $BuiltAt = (Get-Item -LiteralPath $TerminalEntry).LastWriteTimeUtc
  $NewerSource = Get-ChildItem -LiteralPath $TerminalSource -Recurse -File -ErrorAction Stop |
    Where-Object { $_.LastWriteTimeUtc -gt $BuiltAt } |
    Select-Object -First 1
  $NeedsBuild = $null -ne $NewerSource
}
if ($NeedsBuild) {
  if (-not (Test-Path -LiteralPath $PinnedPnpm -PathType Leaf)) {
    throw "Missing pinned pnpm 11.7.0: $PinnedPnpm"
  }
  Write-Host '[prepare] Building Xiaoshe terminal client...'
  & $PinnedPnpm --dir $XsRoot --filter '@xiaoshe/terminal-client' run build
  if ($LASTEXITCODE -ne 0) { throw "Terminal client build exited $LASTEXITCODE." }
}
if (-not (Test-Path -LiteralPath $TerminalEntry -PathType Leaf)) { throw "Missing terminal client: $TerminalEntry" }

& $NodePath $TerminalEntry --url "http://127.0.0.1:$Port" @TerminalArguments
exit $LASTEXITCODE
