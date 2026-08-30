#!/bin/bash
# 小蛇终端入口：复用统一 DSH web Runtime，但绝不打开浏览器。
set -euo pipefail

XS_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PORT="${XIAOSHE_DSH_PORT:-3080}"
WEB_STARTER="$XS_ROOT/scripts/start-xiaoshe-web.sh"
TERMINAL_ENTRY="$XS_ROOT/packages/terminal-client/lib/bin.js"

fail() {
  printf '[错误] %s\n' "$1" >&2
  exit 1
}

find_node() {
  local candidate
  for candidate in "${XIAOSHE_NODE:-}" \
    /opt/homebrew/opt/node@24/bin/node \
    /usr/local/opt/node@24/bin/node \
    "$(command -v node 2>/dev/null || true)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    "$candidate" -e 'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 24 ? 0 : 1)' \
      >/dev/null 2>&1 && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

find_pnpm_cli() {
  local candidate
  for candidate in \
    "${XIAOSHE_PNPM_CLI:-}" \
    "${HOME}/.local/share/xiaoshe/pnpm-11.7.0/node_modules/pnpm/bin/pnpm.cjs" \
    "${HOME}/.cache/node/corepack/v1/pnpm/11.7.0/bin/pnpm.cjs"; do
    [ -n "$candidate" ] && [ -r "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

[ -f "$WEB_STARTER" ] || fail "缺少 $WEB_STARTER"

# 统一启动器会校验/补齐冷设备依赖和 Product Profile。NO_OPEN 是这条
# 入口的硬边界：终端版只复用后台 Host，不争抢前台浏览器窗口。
XIAOSHE_DSH_NO_OPEN=1 XIAOSHE_DSH_NO_PAUSE=1 bash "$WEB_STARTER"

NODE="$(find_node || true)"
[ -n "$NODE" ] || fail '需要 Node.js 24。请先运行 setup/install-macos.sh。'

# 运行中的 Host 可能来自上一次构建，而终端客户端是新加入的独立前端。
# 只在缺失或源码更新时增量构建，避免每次唤醒都等待全仓构建。
NEEDS_BUILD=0
[ -f "$TERMINAL_ENTRY" ] || NEEDS_BUILD=1
if [ "$NEEDS_BUILD" = 0 ] && find "$XS_ROOT/packages/terminal-client/src" -type f -newer "$TERMINAL_ENTRY" -print -quit | grep -q .; then
  NEEDS_BUILD=1
fi
if [ "$NEEDS_BUILD" = 1 ]; then
  PNPM_CLI="$(find_pnpm_cli || true)"
  [ -n "$PNPM_CLI" ] || fail '缺少项目锁定的 pnpm 11.7.0；请运行 setup/install-macos.sh。'
  printf '[准备] 正在构建小蛇终端客户端…\n'
  PATH="$(dirname "$NODE"):$PATH" "$NODE" "$PNPM_CLI" --dir "$XS_ROOT" \
    --filter '@xiaoshe/terminal-client' run build
fi

[ -f "$TERMINAL_ENTRY" ] || fail "终端客户端构建失败：缺少 $TERMINAL_ENTRY"
exec "$NODE" "$TERMINAL_ENTRY" --url "http://127.0.0.1:${PORT}" "$@"
