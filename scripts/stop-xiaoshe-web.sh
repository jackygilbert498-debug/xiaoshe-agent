#!/bin/bash
# 只停止由统一入口记录的小蛇 DSH 进程；不根据端口盲杀。
set -euo pipefail

SERVICE_LABEL="${XIAOSHE_DSH_SERVICE_LABEL:-com.xiaoshe.dsh.web}"
SERVICE_DOMAIN="gui/$(id -u)"
PORT="${XIAOSHE_DSH_PORT:-3080}"

if ! launchctl print "${SERVICE_DOMAIN}/${SERVICE_LABEL}" >/dev/null 2>&1; then
  printf '[无需停止] 没有统一入口记录的运行实例。\n'
  exit 0
fi

printf '[停止] 正在让小蛇 DSH 用户服务安全退出…\n'
launchctl remove "$SERVICE_LABEL"
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
