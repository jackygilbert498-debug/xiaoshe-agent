#!/bin/bash
# 只停止 root、runtime 与 token 均匹配的本产品 launchd 服务。
set -euo pipefail

OWNERSHIP_TOKEN=''
LIFECYCLE_LEASE_TOKEN=''
LIFECYCLE_LEASE_PID=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ownership-token) [ "$#" -ge 2 ] || { printf '[错误] 缺少所有权令牌。\n' >&2; exit 64; }; OWNERSHIP_TOKEN="$2"; shift 2 ;;
    --lifecycle-lease-token) [ "$#" -ge 2 ] || { printf '[错误] 缺少生命周期令牌。\n' >&2; exit 64; }; LIFECYCLE_LEASE_TOKEN="$2"; shift 2 ;;
    --lifecycle-lease-pid) [ "$#" -ge 2 ] || { printf '[错误] 缺少生命周期 PID。\n' >&2; exit 64; }; LIFECYCLE_LEASE_PID="$2"; shift 2 ;;
    *) printf '[错误] 未知停止参数：%s\n' "$1" >&2; exit 64 ;;
  esac
done

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
DSH_ROOT="${XIAOSHE_DSH_ROOT:-$PLUGIN_ROOT/runtime/DSH}"
NODE="${XIAOSHE_NODE:-$(command -v node 2>/dev/null || true)}"
[ -x "$NODE" ] || { printf '[错误] 无法验证生命周期所有权：未找到 Node。\n' >&2; exit 1; }
if [ -n "${XIAOSHE_DESKTOP_ACCEPTANCE_ISOLATED:-}" ]; then
  "$NODE" --input-type=module -e 'import {pathToFileURL} from "node:url"; const {acceptanceServiceEnvironment}=await import(pathToFileURL(process.argv[1]).href); acceptanceServiceEnvironment(process.env)' \
    "$PLUGIN_ROOT/apps/desktop-shell/src/acceptance-isolation.mjs"
fi
LEASE_HELPER="$PLUGIN_ROOT/scripts/lifecycle-lease.mjs"
[ -f "$LEASE_HELPER" ] || { printf '[错误] 生命周期互斥模块缺失。\n' >&2; exit 1; }
SERVICE_LABEL="${XIAOSHE_DSH_SERVICE_LABEL:-com.xiaoshe.dsh.web}"
SERVICE_DOMAIN="gui/$(id -u)"
PORT="${XIAOSHE_DSH_PORT:-3080}"
STATE_ROOT="${XIAOSHE_STATE_ROOT:-${HOME}/Library/Application Support/小蛇}"
LEASE_PATH="$STATE_ROOT/lifecycle-$PORT.lock"
OWNS_LIFECYCLE_LEASE=0

release_lifecycle_lease() {
  local code="$?"
  if [ "$OWNS_LIFECYCLE_LEASE" = 1 ]; then
    if ! "$NODE" "$LEASE_HELPER" release --path "$LEASE_PATH" --token "$LIFECYCLE_LEASE_TOKEN"; then
      printf '[错误] 生命周期互斥所有权已变化；停止结果不可信。\n' >&2
      code=1
    fi
  fi
  trap - EXIT
  exit "$code"
}
trap release_lifecycle_lease EXIT

mkdir -p "$STATE_ROOT"
if [ -n "$LIFECYCLE_LEASE_TOKEN" ] || [ -n "$LIFECYCLE_LEASE_PID" ]; then
  [ -n "$LIFECYCLE_LEASE_TOKEN" ] && [ -n "$LIFECYCLE_LEASE_PID" ] \
    || { printf '[错误] 嵌套停止必须同时提供生命周期 PID 与 token。\n' >&2; exit 1; }
  "$NODE" "$LEASE_HELPER" check --path "$LEASE_PATH" --pid "$LIFECYCLE_LEASE_PID" --token "$LIFECYCLE_LEASE_TOKEN" \
    || { printf '[错误] 调用方不拥有生命周期互斥。\n' >&2; exit 1; }
else
  LEASE_JSON="$("$NODE" "$LEASE_HELPER" acquire --path "$LEASE_PATH" --pid "$$" --wait-ms 15000)" \
    || { printf '[错误] 另一个启动或停止流程仍在进行。\n' >&2; exit 1; }
  LIFECYCLE_LEASE_TOKEN="$(printf '%s' "$LEASE_JSON" | "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).token)}catch{process.exit(1)}})')"
  [ -n "$LIFECYCLE_LEASE_TOKEN" ] || { printf '[错误] 生命周期互斥 token 无效。\n' >&2; exit 1; }
  OWNS_LIFECYCLE_LEASE=1
fi

service_has_environment() {
  local service="$1" key="$2" value="$3"
  grep -Fq "$key=$value" <<<"$service" \
    || grep -Fq "$key => $value" <<<"$service" \
    || grep -Fq "$key = $value" <<<"$service"
}

if ! SERVICE="$(launchctl print "${SERVICE_DOMAIN}/${SERVICE_LABEL}" 2>/dev/null)"; then
  if [ -n "$OWNERSHIP_TOKEN" ]; then
    printf '[错误] launchctl print failed；无法证明补偿目标已不存在。\n' >&2
    exit 1
  fi
  printf '[无需停止] 没有统一入口记录的运行实例。\n'
  exit 0
fi

service_has_environment "$SERVICE" XIAOSHE_PRODUCT_ROOT "$PLUGIN_ROOT" \
  || { printf '[错误] 当前 launchd 服务不属于此小蛇 root，拒绝停止。\n' >&2; exit 1; }
service_has_environment "$SERVICE" XIAOSHE_DSH_ROOT "$DSH_ROOT" \
  || { printf '[错误] 当前 launchd 服务不属于此 DSH runtime，拒绝停止。\n' >&2; exit 1; }
if [ -n "$OWNERSHIP_TOKEN" ] && ! service_has_environment "$SERVICE" XIAOSHE_LAUNCH_TOKEN "$OWNERSHIP_TOKEN"; then
  printf '[错误] ownership token mismatch；当前服务不属于本次启动令牌。\n' >&2
  exit 1
fi

printf '[停止] 正在让小蛇 DSH 用户服务安全退出…\n'
launchctl remove "$SERVICE_LABEL" \
  || { printf '[错误] launchctl remove 失败；服务所有权状态保留。\n' >&2; exit 1; }
for _ in $(seq 1 100); do
  SERVICE_PRESENT=0
  PORT_PRESENT=0
  launchctl print "${SERVICE_DOMAIN}/${SERVICE_LABEL}" >/dev/null 2>&1 && SERVICE_PRESENT=1
  lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && PORT_PRESENT=1
  if [ "$SERVICE_PRESENT" -eq 0 ] && [ "$PORT_PRESENT" -eq 0 ]; then
    printf '[已停止] 小蛇 DSH 已退出。\n'
    exit 0
  fi
  sleep 0.1
done

LISTENERS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
printf '[提示] 服务未完全退出或端口 %s 仍被占用（PID %s）；未强制结束任何进程。\n' "$PORT" "${LISTENERS//$'\n'/,}" >&2
exit 1
