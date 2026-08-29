#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
test -f tauri/tauri.conf.json
cd tauri
cargo tauri build
