#Requires -Version 5.1
# Xiao She (小蛇) - Windows one-key installer.
# Writes an 's' function into your PowerShell profile so you can wake the agent
# from ANY directory by typing:   s   (interactive)   or   s -p "task"   (headless).
#
# Usage (from the repo root):
#     powershell -ExecutionPolicy Bypass -File .\install.ps1
# Then open a NEW PowerShell window and type  s .
#
# ASCII-only on purpose: Windows PowerShell 5.1 mis-decodes a BOM-less UTF-8
# script's non-ASCII literals, so keep this file plain ASCII to stay robust.
$ErrorActionPreference = 'Stop'

$repo  = $PSScriptRoot
$runpy = Join-Path $repo 'run.py'
if (-not (Test-Path $runpy)) {
    Write-Error "run.py not found at $runpy -- run this from the Xiao She repo root."
    exit 1
}

# 1) Execution policy: the profile is a script; a Restricted policy stops it from
#    loading at all, so 's' would never appear. RemoteSigned = local scripts run,
#    downloaded ones need a signature (Microsoft's recommended dev default).
$eff = Get-ExecutionPolicy
if ($eff -in @('Restricted', 'AllSigned', 'Undefined')) {
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
    Write-Host "[OK] Execution policy -> RemoteSigned (CurrentUser)"
} else {
    Write-Host "[i] Execution policy is already '$eff' (left unchanged)"
}

# 2) Make sure the profile file exists.
$dir = Split-Path $PROFILE
if (-not (Test-Path $dir))     { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }

# 3) Idempotently (re)write the 's' block between markers.
$begin = '# >>> xiaoshe s launcher >>>'
$end   = '# <<< xiaoshe s launcher <<<'
$raw = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
if ($null -eq $raw) { $raw = '' }
$pattern = [regex]::Escape($begin) + '.*?' + [regex]::Escape($end)
$raw = [regex]::Replace($raw, $pattern, '', 'Singleline').TrimEnd()
$block = @(
    $begin,
    "function s { python `"$runpy`" @args }   # s = interactive; s -p `"task`" = headless",
    $end
) -join "`r`n"
$new = if ($raw) { $raw + "`r`n`r`n" + $block } else { $block }
Set-Content -Path $PROFILE -Value $new -Encoding UTF8

Write-Host "[OK] Wrote 's' into $PROFILE"
Write-Host "     s  ->  python `"$runpy`""
Write-Host ""
Write-Host "Done. Open a NEW PowerShell window and type  s  to wake Xiao She (s -p ""task"" for headless)."
