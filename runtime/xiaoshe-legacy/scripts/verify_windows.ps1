[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Invoke-VerifyStep {
    param([Parameter(Mandatory)][string]$Name,
          [Parameter(Mandatory)][string[]]$Arguments)
    Write-Host "`n==> $Name"
    & py -3 @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

function Invoke-NodeVerifyStep {
    param([Parameter(Mandatory)][string]$Name,
          [Parameter(Mandatory)][string[]]$Arguments)
    Write-Host "`n==> $Name"
    $node = Get-Command node -ErrorAction Stop
    & $node.Source @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repo
try {
    Invoke-VerifyStep 'UI contract' @('tests/ui_contract/validate_contract.py')
    Invoke-NodeVerifyStep 'Tasking UI store' @('--test','tests/tasking_store.test.mjs')
    Invoke-VerifyStep 'Serve smoke' @('scripts/smoke_serve.py')
    Invoke-VerifyStep 'UI E2E' @('scripts/e2e/run_e2e.py')
    Invoke-VerifyStep 'Full unittest' @('-m','unittest','discover','-s','tests','-p','test_*.py','-v')
} finally {
    Pop-Location
}
Write-Host "`nWindows verification PASS"
