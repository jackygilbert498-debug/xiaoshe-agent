#!/bin/zsh

set -u
setopt pipefail

readonly SCRIPT_DIR="${0:A:h}"
readonly PROJECT_ROOT="${SCRIPT_DIR:h}"
readonly LOG_PATH="$PROJECT_ROOT/docs/evidence/macos-terminal-screen-smoke.log"
readonly STATUS_PATH="$PROJECT_ROOT/docs/evidence/macos-terminal-screen-smoke.status"
readonly NODE_PATH='/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin'

mkdir -p "$PROJECT_ROOT/docs/evidence"
print -r -- 'running' > "$STATUS_PATH"
cd "$PROJECT_ROOT" || exit 1

print -r -- '小蛇 × DSH：macOS 真实屏幕观察验收'
print -r -- '正在由 Terminal 进程执行，以核对系统“屏幕与系统录音”权限链路。'
print -r -- "日志：$LOG_PATH"
print -r -- ''

/usr/bin/env PATH="$NODE_PATH" \
  /opt/homebrew/opt/node@24/bin/pnpm \
  run smoke:bridge 2>&1 | /usr/bin/tee "$LOG_PATH"
readonly smoke_status=$pipestatus[1]

print -r -- "$smoke_status" > "$STATUS_PATH"
print -r -- ''
if (( smoke_status == 0 )); then
  print -r -- '验收通过：真实截图、元素采集、私有文件权限与退出清理均通过。'
else
  print -r -- "验收未通过（退出码 $smoke_status），请查看上面的明确错误。"
fi

exit "$smoke_status"
