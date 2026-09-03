#!/bin/bash
# 小蛇统一界面入口：只启动带小蛇 Bundle 的 DSH web profile。
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ -n "${XIAOSHE_DSH_ROOT:-}" ]; then
  DSH_ROOT="$XIAOSHE_DSH_ROOT"
elif [ -f "$PLUGIN_ROOT/runtime/DSH/package.json" ]; then
  DSH_ROOT="$PLUGIN_ROOT/runtime/DSH"
else
  DSH_ROOT="${HOME}/Desktop/DSH"
fi
if [ -n "${XIAOSHE_LEGACY_ROOT:-}" ]; then
  LEGACY_ROOT="$XIAOSHE_LEGACY_ROOT"
elif [ -f "$PLUGIN_ROOT/runtime/xiaoshe-legacy/run.py" ]; then
  LEGACY_ROOT="$PLUGIN_ROOT/runtime/xiaoshe-legacy"
else
  LEGACY_ROOT="${HOME}/Desktop/小蛇"
fi
PORT="${XIAOSHE_DSH_PORT:-3080}"
HOST="127.0.0.1"
URL="http://${HOST}:${PORT}/"
PROFILE="${XIAOSHE_DSH_PROFILE:-web}"
PROFILE_ROOT="${DSH_HOME:-${HOME}/.dsh}/profiles/${PROFILE}"
NODE="${XIAOSHE_NODE:-}"
PNPM_CLI="${XIAOSHE_PNPM_CLI:-}"
CODEX_APP_BIN="${XIAOSHE_CODEX_BIN:-/Applications/ChatGPT.app/Contents/Resources/codex}"
INSTALLER="$PLUGIN_ROOT/setup/install-macos.sh"
INSTALL_MODE='developer-source'
if [ -f "$PLUGIN_ROOT/.xiaoshe-product-runtime.json" ]; then
  INSTALL_MODE='embedded-runtime'
fi
LOG_DIR="${XIAOSHE_DSH_LOG_DIR:-${HOME}/Library/Logs/小蛇}"
LOG_FILE="${LOG_DIR}/web.log"
ERROR_LOG_FILE="${LOG_DIR}/web.error.log"
SERVICE_LABEL="${XIAOSHE_DSH_SERVICE_LABEL:-com.xiaoshe.dsh.web}"
SERVICE_DOMAIN="gui/$(id -u)"
# launchd 不能稳定读取桌面目录中的脚本文件；把固定命令作为参数交给
# /bin/bash -c，并由 exec 让 launchd 最终直接监督 DSH Node 进程。
SERVICE_COMMAND='cd "$XIAOSHE_DSH_ROOT" && exec "$XIAOSHE_NODE" "$XIAOSHE_DSH_ROOT/apps/cli/lib/bin.js" web --no-open --host "$XIAOSHE_DSH_HOST" --port "$XIAOSHE_DSH_PORT"'

pause_on_error() {
  local code="$?"
  if [ "$code" -ne 0 ] && [ -t 0 ] && [ "${XIAOSHE_DSH_NO_PAUSE:-0}" != "1" ]; then
    printf '\n按回车关闭…'
    read -r _ || true
  fi
  exit "$code"
}
trap pause_on_error EXIT

fail() {
  printf '[错误] %s\n' "$1" >&2
  return 1
}

require_file() {
  [ -e "$1" ] || fail "缺少 $1"
}

is_xiaoshe_ready() {
  curl -fsS --max-time 2 "${URL}xiaoshe/desktop/status" 2>/dev/null \
    | "$NODE" -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { input += chunk });
      process.stdin.on("end", () => {
        try {
          const value = JSON.parse(input);
          process.exit(value.product === "小蛇" && value.bridge?.state === "ready" ? 0 : 1);
        } catch { process.exit(1) }
      });
    ' >/dev/null 2>&1
}

open_ui() {
  [ "${XIAOSHE_DSH_NO_OPEN:-0}" = "1" ] && return 0
  # LaunchServices may only focus an existing Edge tab when the exact URL was
  # opened before.  If that tab contains a connection-error page, `ss` appears
  # broken even though the freshly checked service is healthy.  A per-launch
  # query forces a real navigation while keeping the DSH service URL unchanged.
  local launch_url="${URL}?xiaoshe_launch=$(date +%s)-$$"
  if [ -d '/Applications/Microsoft Edge.app' ]; then
    open -a 'Microsoft Edge' "$launch_url" || open "$launch_url"
  else
    open "$launch_url"
  fi
}

remove_service() {
  launchctl remove "$SERVICE_LABEL" >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do
    launchctl print "${SERVICE_DOMAIN}/${SERVICE_LABEL}" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
}

service_is_registered() {
  launchctl print "${SERVICE_DOMAIN}/${SERVICE_LABEL}" >/dev/null 2>&1
}

service_matches_current_runtime() {
  local service
  service="$(launchctl print "${SERVICE_DOMAIN}/${SERVICE_LABEL}" 2>/dev/null)" || return 1
  grep -Fq "XIAOSHE_DSH_ROOT=$DSH_ROOT" <<<"$service" \
    && grep -Fq "XIAOSHE_LEGACY_ROOT=$LEGACY_ROOT" <<<"$service"
}

profile_has_current_product_packages() {
  local package_name package_root installed_root
  while IFS='|' read -r package_name package_root; do
    installed_root="$PROFILE_ROOT/node_modules/$package_name"
    "$NODE" -e '
      const { realpathSync } = require("node:fs")
      try {
        process.exit(realpathSync(process.argv[1]) === realpathSync(process.argv[2]) ? 0 : 1)
      } catch {
        process.exit(1)
      }
    ' "$installed_root" "$package_root" || return 1
  done <<EOF
@xiaoshe/dsh-desktop-control|$PLUGIN_ROOT
@xiaoshe/verification-policy|$PLUGIN_ROOT/packages/verification-policy
@xiaoshe/native-shell-legacy-adapted|$PLUGIN_ROOT/packages/native-shell-legacy-adapted
@xiaoshe/runtime-dsh-provider|$PLUGIN_ROOT/packages/runtime-dsh-provider
@xiaoshe/completion-receipt|$PLUGIN_ROOT/packages/completion-receipt
@xiaoshe/runtime-contract|$PLUGIN_ROOT/packages/runtime-contract
@xiaoshe/heartbeat|$PLUGIN_ROOT/packages/heartbeat
@xiaoshe/memory|$PLUGIN_ROOT/packages/memory
@xiaoshe/plugin-governance|$PLUGIN_ROOT/packages/plugin-governance
@xiaoshe/provider-readiness|$PLUGIN_ROOT/packages/provider-readiness
@xiaoshe/migration-recovery|$PLUGIN_ROOT/packages/migration-recovery
@xiaoshe/coding-workbench|$PLUGIN_ROOT/packages/coding-workbench
@xiaoshe/task-timeline|$PLUGIN_ROOT/packages/task-timeline
@deepseek-ai/dsh-tool-session-query|$DSH_ROOT/packages/session-query/tool-session-query
@xiaoshe/product-bundle|$PLUGIN_ROOT/packages/product-bundle
EOF
}

sync_current_product_packages() {
  printf '[同步] 正式 %s Profile 尚未装配当前小蛇产品包，正在补齐…\n' "$PROFILE"
  (
    cd "$PLUGIN_ROOT"
    "$NODE" "$PNPM_CLI" --dir "$DSH_ROOT" dsh plugin --profile "$PROFILE" add \
      "$PLUGIN_ROOT" \
      "$PLUGIN_ROOT/packages/verification-policy" \
      "$PLUGIN_ROOT/packages/native-shell-legacy-adapted" \
      "$PLUGIN_ROOT/packages/runtime-dsh-provider" \
      "$PLUGIN_ROOT/packages/completion-receipt" \
      "$PLUGIN_ROOT/packages/runtime-contract" \
      "$PLUGIN_ROOT/packages/heartbeat" \
      "$PLUGIN_ROOT/packages/memory" \
      "$PLUGIN_ROOT/packages/plugin-governance" \
      "$PLUGIN_ROOT/packages/provider-readiness" \
      "$PLUGIN_ROOT/packages/migration-recovery" \
      "$PLUGIN_ROOT/packages/coding-workbench" \
      "$PLUGIN_ROOT/packages/task-timeline" \
      "$DSH_ROOT/packages/session-query/tool-session-query" \
      "$PLUGIN_ROOT/packages/product-bundle"
  )
  profile_has_current_product_packages \
    || fail "正式 $PROFILE Profile 未能同步到当前 XS 产品包"
}

require_file "$DSH_ROOT/package.json"
require_file "$PLUGIN_ROOT/package.json"

# 开发者源码按设计不携带 node_modules 和构建产物。用户直接双击启动器时，
# 首次启动必须走与正式接收相同的锁定安装流程，不能先因缺少 lib/bin.js 退出。
if [ ! -f "$DSH_ROOT/apps/cli/lib/bin.js" ] \
  || [ ! -d "$DSH_ROOT/node_modules" ] \
  || [ ! -d "$PLUGIN_ROOT/node_modules" ] \
  || [ ! -f "$PROFILE_ROOT/package.json" ]; then
  require_file "$INSTALLER"
  printf '[首次启动] 正在安装锁定依赖、构建 DSH 并配置小蛇 Profile…\n'
  XIAOSHE_DSH_NO_PAUSE=1 XIAOSHE_INSTALL_MODE="$INSTALL_MODE" bash "$INSTALLER"
fi

# 安装器可能刚在 Apple Silicon 或 Intel Homebrew 路径中补齐 Node，亦可能
# 创建项目专用 pnpm；因此必须在安装后重新解析，不能固化原电脑路径。
if [ -z "$NODE" ]; then
  for CANDIDATE in \
    /opt/homebrew/opt/node@24/bin/node \
    /usr/local/opt/node@24/bin/node \
    "$(command -v node 2>/dev/null || true)"; do
    if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ] \
      && "$CANDIDATE" -e 'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 24 ? 0 : 1)' >/dev/null 2>&1; then
      NODE="$CANDIDATE"
      break
    fi
  done
fi
if [ -z "$PNPM_CLI" ]; then
  for CANDIDATE in \
    "${HOME}/.local/share/xiaoshe/pnpm-11.7.0/node_modules/pnpm/bin/pnpm.cjs" \
    "${HOME}/.cache/node/corepack/v1/pnpm/11.7.0/bin/pnpm.cjs"; do
    if [ -r "$CANDIDATE" ]; then
      PNPM_CLI="$CANDIDATE"
      break
    fi
  done
fi

require_file "$DSH_ROOT/apps/cli/lib/bin.js"
[ -x "$NODE" ] || fail "需要 Node 24：$NODE"
[ -r "$PNPM_CLI" ] || fail "需要已缓存的 pnpm 11.7.0：$PNPM_CLI"
"$NODE" -e 'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 24 ? 0 : 1)' \
  || fail "小蛇 DSH 需要 Node 24 或更高版本"
export PATH="$(dirname "$NODE"):$PATH"
# ModLens 复用 Codex 登录时优先使用与当前桌面应用同版的 CLI。Homebrew
# 旧版会误读新版 models_cache.json，表现为缺少 base_instructions。
if [ -x "$CODEX_APP_BIN" ]; then
  export PATH="$(dirname "$NODE"):$(dirname "$CODEX_APP_BIN"):$PATH"
fi
PNPM_SHIM_DIR="${HOME}/.local/share/xiaoshe/bin"
if [ -x "$PNPM_SHIM_DIR/pnpm" ]; then
  export PATH="$PNPM_SHIM_DIR:$PATH"
fi

if ! profile_has_current_product_packages; then
  sync_current_product_packages
fi

if is_xiaoshe_ready; then
  if service_is_registered; then
    if service_matches_current_runtime; then
      printf '[已运行] 小蛇 DSH 已就绪：%s\n' "$URL"
      open_ui
      trap - EXIT
      exit 0
    fi
    printf '[更新] 已运行服务仍指向旧工程，正在切换到当前 XS runtime…\n'
    remove_service
  else
    LISTENERS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    fail "端口 $PORT 上存在未由统一入口管理的小蛇实例（PID ${LISTENERS//$'\n'/,}）；未结束或接管该进程。"
  fi
fi

LISTENERS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$LISTENERS" ]; then
  fail "端口 $PORT 已被非健康的小蛇实例或其他程序占用（PID ${LISTENERS//$'\n'/,}）；未结束任何进程。"
fi

mkdir -p "$LOG_DIR"
umask 077
printf '[准备] 构建小蛇桌面 Bundle…\n'
(
  cd "$PLUGIN_ROOT"
  "$NODE" "$PNPM_CLI" -r --filter './packages/**' run build
  "$NODE" "$PNPM_CLI" run build
)

printf '[启动] DSH web profile + 小蛇 + ModLens…\n'
: > "$LOG_FILE"
: > "$ERROR_LOG_FILE"
remove_service
SERVICE_ENV=(
  "PATH=$PATH"
  "HOME=$HOME"
  "XIAOSHE_DSH_ROOT=$DSH_ROOT"
  "XIAOSHE_LEGACY_ROOT=$LEGACY_ROOT"
  "XIAOSHE_DSH_HOST=$HOST"
  "XIAOSHE_DSH_PORT=$PORT"
  "XIAOSHE_NODE=$NODE"
)
for KEY in DSH_HOME XIAOSHE_PYTHON XIAOSHE_DESKTOP_ACTIONS XIAOSHE_DESKTOP_TIMEOUT_MS; do
  if [ "${!KEY+x}" = x ]; then
    SERVICE_ENV+=("$KEY=${!KEY}")
  fi
done
launchctl submit \
  -l "$SERVICE_LABEL" \
  -o "$LOG_FILE" \
  -e "$ERROR_LOG_FILE" \
  -- /usr/bin/env \
  "${SERVICE_ENV[@]}" \
  /bin/bash -c "$SERVICE_COMMAND"

for _ in $(seq 1 120); do
  if is_xiaoshe_ready; then
    printf '[就绪] 小蛇统一界面：%s\n' "$URL"
    printf '       日志：%s（错误日志：%s）\n' "$LOG_FILE" "$ERROR_LOG_FILE"
    open_ui
    trap - EXIT
    exit 0
  fi
  if ! launchctl print "${SERVICE_DOMAIN}/${SERVICE_LABEL}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

remove_service
printf '[错误] 小蛇 DSH 未能在 30 秒内就绪。最近日志：\n' >&2
tail -n 40 "$LOG_FILE" >&2 || true
tail -n 40 "$ERROR_LOG_FILE" >&2 || true
exit 1
