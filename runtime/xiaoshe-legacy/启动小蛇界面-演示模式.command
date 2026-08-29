#!/bin/bash
# 小蛇界面 · Mac 双击启动（演示模式：假模型，不烧 API，不需要 .env 和代理）
cd "$(dirname "$0")"

PY="/opt/miniconda3/bin/python3"
[ -x "$PY" ] || PY="$(command -v python3)"
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
  echo "[错误] 需要 Python 3.10+（先试 /opt/miniconda3/bin/python3，再试 PATH 里的 python3）"
  read -r -p "按回车关闭…"; exit 1
fi

mkdir -p logs
PIDS=$(lsof -tiTCP:7788 -sTCP:LISTEN 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "[提示] 端口 7788 被旧实例占用（PID $PIDS），先停掉…"
  kill $PIDS 2>/dev/null; sleep 1
fi

echo "[1/1] 启动小蛇界面（演示模式 · 假模型不烧 API）…"
echo "      可试：发「写文件」体验审批卡、发「待办」看工具卡、⌘K 命令面板、右上角屏幕观测"
"$PY" scripts/serve_demo.py --port 7788 > logs/ui-demo-start.log 2>&1 &
SRV=$!

URL=""
for _ in $(seq 1 40); do
  sleep 0.5
  URL=$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[a-f0-9]*' logs/ui-demo-start.log 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  kill -0 $SRV 2>/dev/null || break
done

if [ -n "$URL" ]; then
  echo "小蛇界面已就绪: $URL"
  open "$URL"
  echo "（浏览器已打开；本窗口可最小化，关闭本窗口即停服）"
else
  echo "[错误] 启动失败，完整日志："
  cat logs/ui-demo-start.log
  read -r -p "按回车关闭…"; exit 1
fi

wait $SRV
