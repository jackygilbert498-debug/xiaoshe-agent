[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$XsRoot,

  [Parameter(Mandatory = $true)]
  [string]$Pnpm
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $XsRoot -PathType Container)) {
  throw "Xiaoshe product root does not exist: $XsRoot"
}
if (-not (Test-Path -LiteralPath $Pnpm -PathType Leaf)) {
  throw "Xiaoshe pinned pnpm does not exist: $Pnpm"
}

$HadCI = Test-Path Env:\CI
$SavedCI = $env:CI
try {
  # The desktop shell starts this path without a terminal. pnpm may need to
  # replace stale node_modules after a handoff; CI mode keeps that bounded
  # operation non-interactive instead of aborting when no TTY is available.
  $env:CI = 'true'
  Push-Location $XsRoot
  try {
    & $Pnpm -r --filter './packages/**' run build
    if ($LASTEXITCODE -ne 0) { throw 'Preflight product plugin build failed.' }
    & $Pnpm run build
    if ($LASTEXITCODE -ne 0) { throw 'Preflight product runtime build failed.' }
  } finally {
    Pop-Location
  }
} finally {
  if ($HadCI) { $env:CI = $SavedCI }
  else { Remove-Item Env:\CI -ErrorAction SilentlyContinue }
}
