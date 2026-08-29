#!/bin/bash
# 小蛇界面 · Mac 一键启动。重复执行时复用健康实例，避免换 token 后旧页失联。
set -u
cd "$(dirname "$0")" || exit 1

PORT="${XS_UI_PORT:-7788}"
TOKEN_FILE=".state/ui_token"
LOG_FILE="logs/ui-start.log"
SRV=""

open_ui() {
  local url="$1"
  if [ "${XS_UI_NO_OPEN:-0}" = "1" ]; then
    return 0
  fi
  # 用户日常使用 Edge；显式指定可避免系统把 URL 交给另一个浏览器，
  # 留在旧的 file://ui/index.html 页面而误报“需要配对 token”。
  if [ -d "/Applications/Microsoft Edge.app" ]; then
    open -a "Microsoft Edge" "$url"
  else
    open "$url"
  fi
}

healthy_existing_url() {
  [ -r "$TOKEN_FILE" ] || return 1
  local token
  token="$(tr -cd 'a-f0-9' < "$TOKEN_FILE")"
  [ "${#token}" -eq 32 ] || return 1
  curl -fsS --max-time 1 -H "Authorization: Bearer $token" \
    "http://127.0.0.1:${PORT}/api/state" >/dev/null 2>&1 || return 1
  printf 'http://127.0.0.1:%s/?token=%s' "$PORT" "$token"
}

project_listener() {
  local pid="$1" cwd
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  [ "$cwd" = "$PWD" ]
}

PY="/opt/miniconda3/bin/python3"
[ -x "$PY" ] || PY="$(command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
  echo "[错误] 需要 Python 3.10+（先试 /opt/miniconda3/bin/python3，再试 PATH 里的 python3）"
  read -r -p "按回车关闭…"; exit 1
fi

mkdir -p logs
PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  EXISTING_URL="$(healthy_existing_url || true)"
  if [ -n "$EXISTING_URL" ]; then
    echo "[已运行] 检测到健康的小蛇界面，不重复启动。"
    echo "小蛇界面: $EXISTING_URL"
    open_ui "$EXISTING_URL"
    echo "✓ 已切到最新界面；这个终端可以直接关闭。"
    exit 0
  fi

  OWNED_PIDS=""
  for pid in $PIDS; do
    if project_listener "$pid"; then
      if [ -z "$OWNED_PIDS" ]; then OWNED_PIDS="$pid"; else OWNED_PIDS="$OWNED_PIDS $pid"; fi
    fi
  done
  if [ -n "$OWNED_PIDS" ]; then
    echo "[修复] 发现本项目未响应的旧实例（PID ${OWNED_PIDS// /,}），正在温和重启…"
    kill $OWNED_PIDS 2>/dev/null || true
    for _ in $(seq 1 20); do
      lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 0.1
    done
    if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "[提示] 旧实例仍在收尾；本次改用空闲端口，不强制杀进程。"
      PORT=0
    fi
  else
    echo "[提示] 端口 $PORT 正由其他程序使用；小蛇将自动选择空闲端口，不会结束其他程序。"
    PORT=0
  fi
fi

echo "[启动中] 小蛇界面（正式模式）…"
: > "$LOG_FILE"
XIAOSHE_TASKING_V2=on "$PY" run.py serve --port "$PORT" --no-browser > "$LOG_FILE" 2>&1 &
SRV=$!

cleanup() {
  if [ -n "$SRV" ] && kill -0 "$SRV" 2>/dev/null; then
    kill "$SRV" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM HUP

URL=""
for _ in $(seq 1 40); do
  sleep 0.25
  URL="$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[a-f0-9]*' "$LOG_FILE" 2>/dev/null | head -1)"
  [ -n "$URL" ] && break
  kill -0 "$SRV" 2>/dev/null || break
done

if [ -n "$URL" ]; then
  echo "小蛇界面已就绪: $URL"
  if open_ui "$URL"; then
    echo "✓ 浏览器已打开。小蛇正在运行，不是卡住。"
    echo "  这个窗口只负责保持服务；可最小化，关闭它会安全停止小蛇。"
  else
    echo "[提示] 浏览器未能自动打开，请复制上面的完整网址。"
  fi
else
  echo "[错误] 启动失败，完整日志："
  cat "$LOG_FILE"
  read -r -p "按回车关闭…"; exit 1
fi

wait "$SRV"
