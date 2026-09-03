#!/bin/bash
set -e
XS_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
if [ "${1:-}" = '--browser-fallback' ]; then
  shift
else
  DEV_ELECTRON="$XS_ROOT/apps/desktop-shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  LOCAL_APP="$XS_ROOT/apps/desktop-shell/dist-desktop/mac-arm64/小蛇.app/Contents/MacOS/小蛇"
  INSTALLED_APP="/Applications/小蛇.app/Contents/MacOS/小蛇"
  if [ -x "$DEV_ELECTRON" ]; then
    exec "$DEV_ELECTRON" "$XS_ROOT/apps/desktop-shell" "$@"
  elif [ -x "$LOCAL_APP" ]; then
    exec "$LOCAL_APP" "$@"
  elif [ -x "$INSTALLED_APP" ]; then
    exec "$INSTALLED_APP" "$@"
  fi
  printf '[提示] 独立桌面壳不可用；本次回退到浏览器。\n' >&2
fi
exec bash "$XS_ROOT/scripts/start-xiaoshe-web.sh" "$@"
