$ErrorActionPreference='Stop'
Set-Location (Join-Path $PSScriptRoot '..\tauri')
cargo tauri build
