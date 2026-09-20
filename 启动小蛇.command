#!/bin/bash
set -e
XS_ROOT="$(cd "$(dirname "$0")" && pwd -P)"
if [ "${1:-}" = '--browser-fallback' ]; then
  shift
else
  DEV_ELECTRON="$XS_ROOT/apps/desktop-shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  if [ -x "$DEV_ELECTRON" ]; then
    exec "$DEV_ELECTRON" "$XS_ROOT/apps/desktop-shell" "$@"
  fi
  # A same-named packaged app can contain older code than this source checkout.
  # Keep this entry bound to XS; opening an installed app is a separate action.
  printf '[提示] 当前 XS 开发桌面壳不可用；不会转入旧打包应用。本次使用当前源码的浏览器启动流程，版本以启动校验为准。\n' >&2
fi
exec bash "$XS_ROOT/scripts/start-xiaoshe-web.sh" "$@"
