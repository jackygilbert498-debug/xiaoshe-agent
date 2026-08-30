#!/bin/bash
set -e
XS_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
if [ "${1:-}" != '--browser-fallback' ]; then
  ELECTRON="$XS_ROOT/apps/desktop-shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  if [ -x "$ELECTRON" ]; then
    exec "$ELECTRON" "$XS_ROOT/apps/desktop-shell"
  fi
  printf '[提示] 独立桌面壳尚未安装；本次回退到浏览器。\n' >&2
fi
exec bash "$XS_ROOT/scripts/start-xiaoshe-web.sh"
