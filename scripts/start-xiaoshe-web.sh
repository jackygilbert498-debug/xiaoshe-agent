#!/bin/bash
# 小蛇统一界面入口：只启动带小蛇 Bundle 的 DSH web profile。
set -euo pipefail

OWNERSHIP_REPORT=0
OWNED_LAUNCH_ACTIVE=0
for argument in "$@"; do
  case "$argument" in
    --ownership-report) OWNERSHIP_REPORT=1 ;;
    *) printf '[错误] 未知启动参数：%s\n' "$argument" >&2; exit 64 ;;
  esac
done

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
STATE_ROOT="${XIAOSHE_STATE_ROOT:-${HOME}/Library/Application Support/小蛇}"
LEASE_PATH="$STATE_ROOT/lifecycle-$PORT.lock"
LEASE_HELPER="$PLUGIN_ROOT/scripts/lifecycle-lease.mjs"
STOP_HELPER="$PLUGIN_ROOT/scripts/stop-xiaoshe-web.sh"
IDENTITY_HELPER="$PLUGIN_ROOT/scripts/product-runtime-identity.mjs"
LIFECYCLE_LEASE_TOKEN=''
OWNS_LIFECYCLE_LEASE=0
# launchd 不能稳定读取桌面目录中的脚本文件；把固定命令作为参数交给
# /bin/bash -c，并由 exec 让 launchd 最终直接监督 DSH Node 进程。
SERVICE_COMMAND='cd "$XIAOSHE_DSH_ROOT" && exec "$XIAOSHE_NODE" "$XIAOSHE_DSH_ROOT/apps/cli/lib/bin.js" web --no-open --host "$XIAOSHE_DSH_HOST" --port "$XIAOSHE_DSH_PORT"'
if [ "${XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED:-0}" = 1 ]; then
  # The CLI reads cwd/.env before boot. Use the validated empty acceptance
  # workspace, never the developer's DSH checkout or their credential fallback.
  [ "${XIAOSHE_DESKTOP_ACCEPTANCE:-0}" = 1 ] \
    && [ -n "${XIAOSHE_ACCEPTANCE_WORKSPACE:-}" ] \
    && [ "$XIAOSHE_ACCEPTANCE_WORKSPACE" = "${XIAOSHE_DESKTOP_ACCEPTANCE_ROOT:-}/workspace" ] \
    && [ -d "$XIAOSHE_ACCEPTANCE_WORKSPACE" ] \
    || { printf '[错误] 隔离验收 workspace 未经过有效配置。\n' >&2; exit 64; }
  SERVICE_COMMAND='cd "$XIAOSHE_ACCEPTANCE_WORKSPACE" && exec "$XIAOSHE_NODE" "$XIAOSHE_DSH_ROOT/apps/cli/lib/bin.js" web --no-open --host "$XIAOSHE_DSH_HOST" --port "$XIAOSHE_DSH_PORT"'
fi

find_compatible_node() {
  local candidate
  for candidate in "$NODE" "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    "$candidate" -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 23) || (major === 24 && minor >= 17) ? 0 : 1)' \
      >/dev/null 2>&1 && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

NODE="$(find_compatible_node || true)"
[ -n "$NODE" ] || { printf '[错误] 启动前需要 Node.js 22.23+ 或 24.17+；请先运行 macOS 安装器。\n' >&2; exit 1; }
if [ -n "${XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED:-}" ]; then
  # Direct shell invocations must satisfy the same gate as Electron, before
  # acquiring a lease or touching any service label or state directory.
  ISOLATED_TEMP_ROOT="$("$NODE" --input-type=module -e 'import {pathToFileURL} from "node:url"; const {acceptanceServiceEnvironment}=await import(pathToFileURL(process.argv[1]).href); process.stdout.write(acceptanceServiceEnvironment(process.env).TMPDIR)' \
    "$PLUGIN_ROOT/apps/desktop-shell/src/acceptance-isolation.mjs")"
fi

pause_on_error() {
  local code="$?"
  if [ "$code" -ne 0 ] && [ "$OWNED_LAUNCH_ACTIVE" = 1 ]; then
    # In ownership-report mode the desktop controller is the sole compensator;
    # removing here would make its token-scoped proof indistinguishable from a
    # launchctl inspection failure. Direct shell launches compensate locally.
    if [ "$OWNERSHIP_REPORT" = 0 ]; then
      if remove_service "${LAUNCH_TOKEN:-}"; then
        OWNED_LAUNCH_ACTIVE=0
      else
        printf '[错误] 启动失败，且基于所有权令牌的补偿停止也失败；服务仍保留供诊断。\n' >&2
      fi
    else
      printf '[提示] 启动器失败；保留 token 所属服务，由桌面控制器执行唯一一次补偿。\n' >&2
    fi
  fi
  if [ "$OWNS_LIFECYCLE_LEASE" = 1 ]; then
    if ! "$NODE" "$LEASE_HELPER" release --path "$LEASE_PATH" --token "$LIFECYCLE_LEASE_TOKEN"; then
      printf '[错误] 生命周期互斥所有权已变化；启动结果不可信。\n' >&2
      code=1
    fi
    OWNS_LIFECYCLE_LEASE=0
  fi
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

report_ownership() {
  [ "$OWNERSHIP_REPORT" = 1 ] || return 0
  [[ "${XIAOSHE_RUNTIME_IDENTITY:-}" =~ ^[a-f0-9]{64}$ ]] \
    || fail '小蛇启动所有权报告缺少有效运行身份'
  if [ "$1" = started ]; then
    printf 'XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"started","token":"%s","identity":"%s","loginUrl":"%s"}\n' "$LAUNCH_TOKEN" "$XIAOSHE_RUNTIME_IDENTITY" "$AUTHENTICATED_URL"
  else
    printf 'XIAOSHE_LAUNCH_OWNERSHIP={"schema":"xiaoshe-launch-ownership/v1","status":"reused","identity":"%s","loginUrl":"%s"}\n' "$XIAOSHE_RUNTIME_IDENTITY" "$AUTHENTICATED_URL"
  fi
}

release_lifecycle_lease() {
  [ "$OWNS_LIFECYCLE_LEASE" = 1 ] || return 0
  "$NODE" "$LEASE_HELPER" release --path "$LEASE_PATH" --token "$LIFECYCLE_LEASE_TOKEN" \
    || return 1
  OWNS_LIFECYCLE_LEASE=0
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
          process.exit(value.product === "小蛇" && value.bridge?.state === "ready" && value.runtime_identity === process.env.XIAOSHE_RUNTIME_IDENTITY ? 0 : 1);
        } catch { process.exit(1) }
      });
    ' >/dev/null 2>&1
}

open_ui() {
  # Resolve on both cold start and reuse. The launcher has already proved service ownership.
  AUTHENTICATED_URL="$("$NODE" "$PLUGIN_ROOT/scripts/dsh-launch-auth.mjs" --log "$LOG_FILE" --base "$URL" --identity "$XIAOSHE_RUNTIME_IDENTITY")" || return 1
  [ "${XIAOSHE_DSH_NO_OPEN:-0}" = "1" ] && return 0
  # LaunchServices may only focus an existing Edge tab when the exact URL was
  # opened before.  If that tab contains a connection-error page, `ss` appears
  # broken even though the freshly checked service is healthy.  A per-launch
  # query forces a real navigation while keeping the DSH service URL unchanged.
  local launch_url="$AUTHENTICATED_URL"
  if [ -d '/Applications/Microsoft Edge.app' ]; then
    open -a 'Microsoft Edge' "$launch_url" || open "$launch_url"
  else
    open "$launch_url"
  fi
}

service_has_environment() {
  local service="$1" key="$2" value="$3"
  grep -Fq "$key=$value" <<<"$service" \
    || grep -Fq "$key => $value" <<<"$service" \
    || grep -Fq "$key = $value" <<<"$service"
}

remove_service() {
  local expected_token="${1:-}"
  local arguments=("$STOP_HELPER" --lifecycle-lease-token "$LIFECYCLE_LEASE_TOKEN" --lifecycle-lease-pid "$$")
  if [ -n "$expected_token" ]; then
    arguments+=(--ownership-token "$expected_token")
  fi
  XIAOSHE_NODE="$NODE" XIAOSHE_DSH_ROOT="$DSH_ROOT" XIAOSHE_DSH_PORT="$PORT" \
    bash "${arguments[@]}"
}

service_is_registered() {
  launchctl print "${SERVICE_DOMAIN}/${SERVICE_LABEL}" >/dev/null 2>&1
}

service_matches_current_runtime() {
  local service
  service="$(launchctl print "${SERVICE_DOMAIN}/${SERVICE_LABEL}" 2>/dev/null)" || return 1
  service_has_environment "$service" XIAOSHE_PRODUCT_ROOT "$PLUGIN_ROOT" \
    && service_has_environment "$service" XIAOSHE_DSH_ROOT "$DSH_ROOT" \
    && service_has_environment "$service" XIAOSHE_LEGACY_ROOT "$LEGACY_ROOT" \
    && service_has_environment "$service" XIAOSHE_RUNTIME_IDENTITY "$XIAOSHE_RUNTIME_IDENTITY"
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
@xiaoshe/agent-experience|$PLUGIN_ROOT/packages/agent-experience
@xiaoshe/coding-workbench|$PLUGIN_ROOT/packages/coding-workbench
@xiaoshe/task-timeline|$PLUGIN_ROOT/packages/task-timeline
@deepseek-ai/dsh-tool-session-query|$DSH_ROOT/packages/session-query/tool-session-query
@deepseek-ai/dsh-web-fetch-http|$DSH_ROOT/packages/web/web-fetch-http
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
      "$PLUGIN_ROOT/packages/agent-experience" \
      "$PLUGIN_ROOT/packages/coding-workbench" \
      "$PLUGIN_ROOT/packages/task-timeline" \
      "$DSH_ROOT/packages/session-query/tool-session-query" \
      "$DSH_ROOT/packages/web/web-fetch-http" \
      "$PLUGIN_ROOT/packages/product-bundle"
  )
  profile_has_current_product_packages \
    || fail "正式 $PROFILE Profile 未能同步到当前 XS 产品包"
}

require_file "$LEASE_HELPER"
mkdir -p "$STATE_ROOT"
LEASE_JSON="$("$NODE" "$LEASE_HELPER" acquire --path "$LEASE_PATH" --pid "$$" --wait-ms 15000)" \
  || fail '另一个小蛇启动或停止流程仍在进行，请稍后重试。'
LIFECYCLE_LEASE_TOKEN="$(printf '%s' "$LEASE_JSON" | "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).token)}catch{process.exit(1)}})')"
[ -n "$LIFECYCLE_LEASE_TOKEN" ] || fail '生命周期互斥 token 无效'
OWNS_LIFECYCLE_LEASE=1

# FAST_REUSE is intentionally before installer, Profile sync, and product build.
# It performs only ownership, health, and content-identity reads.
FAST_REUSE=0
if service_is_registered \
  && [ -f "$PROFILE_ROOT/package.json" ] \
  && [ -f "$IDENTITY_HELPER" ]; then
  if EARLY_IDENTITY="$($NODE "$IDENTITY_HELPER" --root "$PLUGIN_ROOT" --dsh-root "$DSH_ROOT" --profile-root "$PROFILE_ROOT" 2>/dev/null \
    | "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const v=JSON.parse(s);if(!/^[a-f0-9]{64}$/.test(v.identity??""))throw 0;process.stdout.write(v.identity)}catch{process.exit(1)}})')"; then
    XIAOSHE_RUNTIME_IDENTITY="$EARLY_IDENTITY"
    export XIAOSHE_RUNTIME_IDENTITY
    if service_matches_current_runtime && is_xiaoshe_ready; then
      FAST_REUSE=1
      printf '[已运行] 小蛇 DSH 已就绪：%s\n' "$URL"
      open_ui
      report_ownership reused
      release_lifecycle_lease || fail '生命周期互斥所有权已变化；拒绝报告复用成功。'
      trap - EXIT
      exit 0
    fi
  fi
fi

find_compatible_python() {
  local candidate
  for candidate in "${XIAOSHE_PYTHON:-}" "$(command -v python3 2>/dev/null || true)" \
    /opt/homebrew/bin/python3 /usr/local/bin/python3 \
    /opt/miniconda3/bin/python3 /opt/anaconda3/bin/python3 \
    "${HOME}/miniconda3/bin/python3" "${HOME}/anaconda3/bin/python3" /usr/bin/python3; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
      >/dev/null 2>&1 && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
PYTHON="$(find_compatible_python || true)"
[ -n "$PYTHON" ] || fail '需要真实的 Python 3.10+ 解释器。'
export XIAOSHE_PYTHON="$PYTHON"

require_file "$DSH_ROOT/package.json"
require_file "$PLUGIN_ROOT/package.json"

# 开发者源码按设计不携带 node_modules 和构建产物。用户直接双击启动器时，
# 首次启动必须走与正式接收相同的锁定安装流程，不能先因缺少 lib/bin.js 退出。
if [ ! -f "$DSH_ROOT/apps/cli/lib/bin.js" ] \
  || [ ! -d "$DSH_ROOT/node_modules" ] \
  || [ ! -d "$PLUGIN_ROOT/node_modules" ] \
  || [ ! -f "$PROFILE_ROOT/package.json" ]; then
  # Acceptance owns a prebuilt, secret-free Profile. Falling through to the
  # installer would mutate shell configuration and expand this test's scope.
  [ "${XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED:-0}" != 1 ] \
    || fail '隔离验收缺少预构建依赖或 Profile；拒绝自动安装。'
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
      && "$CANDIDATE" -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 23) || (major === 24 && minor >= 17) ? 0 : 1)' >/dev/null 2>&1; then
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
[ -x "$NODE" ] || fail "需要 Node 22.23+ 或 24.17+：$NODE"
[ -r "$PNPM_CLI" ] || fail "需要已缓存的 pnpm 11.7.0：$PNPM_CLI"
"$NODE" -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 23) || (major === 24 && minor >= 17) ? 0 : 1)' \
  || fail "小蛇 DSH 需要 Node 22.23+ 或 24.17+"
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
  [ "${XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED:-0}" != 1 ] \
    || fail '隔离验收 Profile 未绑定当前产品包；拒绝自动修改依赖。'
  sync_current_product_packages
fi

printf '[准备] 构建小蛇桌面 Bundle…\n'
(
  cd "$PLUGIN_ROOT"
  # pnpm 11 caches absolute workspace paths and otherwise may install again
  # after a packaged runtime is relocated. Only rebuild installed dependencies;
  # dependency installation remains in the explicit first-start branch above.
  # pnpm applies its environment override after CLI config, so pin both only
  # for these commands; do not change installer/probe behavior via global env.
  pnpm_config_verify_deps_before_run=false "$NODE" "$PNPM_CLI" --config.verify-deps-before-run=false -r --filter './packages/**' run build
  pnpm_config_verify_deps_before_run=false "$NODE" "$PNPM_CLI" --config.verify-deps-before-run=false run build
)

require_file "$IDENTITY_HELPER"
XIAOSHE_RUNTIME_IDENTITY="$($NODE "$IDENTITY_HELPER" --root "$PLUGIN_ROOT" --dsh-root "$DSH_ROOT" --profile-root "$PROFILE_ROOT" | "$NODE" -e 'let input=""; process.stdin.on("data", chunk => { input += chunk }); process.stdin.on("end", () => { try { const value = JSON.parse(input); if (!/^[a-f0-9]{64}$/.test(value.identity ?? "")) throw new Error("invalid identity"); process.stdout.write(value.identity) } catch { process.exit(1) } })')"
export XIAOSHE_RUNTIME_IDENTITY
LAUNCH_TOKEN="${XIAOSHE_LAUNCH_TOKEN:-$(/usr/bin/uuidgen | tr '[:upper:]' '[:lower:]')}"
[[ "$LAUNCH_TOKEN" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail '启动所有权令牌无效'

if service_is_registered && ! service_matches_current_runtime; then
  printf '[更新] 已注册服务内容或 Profile 身份不匹配，正在切换到当前 XS runtime…\n'
  remove_service
fi

if is_xiaoshe_ready; then
  if service_is_registered; then
    if service_matches_current_runtime; then
      printf '[已运行] 小蛇 DSH 已就绪：%s\n' "$URL"
      open_ui
      report_ownership reused
      release_lifecycle_lease || fail '生命周期互斥所有权已变化；拒绝报告复用成功。'
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
printf '[启动] DSH web profile + 小蛇 + ModLens…\n'
: > "$LOG_FILE"
: > "$ERROR_LOG_FILE"
chmod 600 "$LOG_FILE" "$ERROR_LOG_FILE"
remove_service
SERVICE_ENV=(
  "PATH=$PATH"
  "HOME=$HOME"
  "XIAOSHE_PRODUCT_ROOT=$PLUGIN_ROOT"
  "XIAOSHE_DSH_ROOT=$DSH_ROOT"
  "XIAOSHE_PROFILE_ROOT=$PROFILE_ROOT"
  "XIAOSHE_LEGACY_ROOT=$LEGACY_ROOT"
  "XIAOSHE_DSH_HOST=$HOST"
  "XIAOSHE_DSH_PORT=$PORT"
  "XIAOSHE_NODE=$NODE"
  "XIAOSHE_RUNTIME_IDENTITY=$XIAOSHE_RUNTIME_IDENTITY"
  "XIAOSHE_LAUNCH_TOKEN=$LAUNCH_TOKEN"
)
for KEY in DSH_HOME XIAOSHE_PYTHON XIAOSHE_DESKTOP_ACTIONS XIAOSHE_DESKTOP_TIMEOUT_MS DSH_TELEMETRY_DISABLED; do
  if [ "${!KEY+x}" = x ]; then
    SERVICE_ENV+=("$KEY=${!KEY}")
  fi
done
if [ "${XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED:-0}" = 1 ]; then
  # launchd does not inherit the caller's TMPDIR. Keep the backend's temporary
  # root identical to the canonical root validated before any service action.
  SERVICE_ENV+=("TMPDIR=$ISOLATED_TEMP_ROOT" "XIAOSHE_ACCEPTANCE_WORKSPACE=$XIAOSHE_ACCEPTANCE_WORKSPACE")
fi
OWNED_LAUNCH_ACTIVE=1
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
    report_ownership started
    release_lifecycle_lease || fail '生命周期互斥所有权已变化；拒绝报告启动成功。'
    OWNED_LAUNCH_ACTIVE=0
    trap - EXIT
    exit 0
  fi
  if ! launchctl print "${SERVICE_DOMAIN}/${SERVICE_LABEL}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! remove_service "$LAUNCH_TOKEN"; then
  fail '小蛇 DSH 未就绪，且基于所有权令牌的补偿停止失败；服务仍保留供诊断。'
fi
OWNED_LAUNCH_ACTIVE=0
printf '[错误] 小蛇 DSH 未能在 30 秒内就绪。最近日志：\n' >&2
tail -n 40 "$LOG_FILE" >&2 || true
tail -n 40 "$ERROR_LOG_FILE" >&2 || true
exit 1
