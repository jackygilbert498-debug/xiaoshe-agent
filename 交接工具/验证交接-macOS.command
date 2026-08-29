#!/bin/bash
set -euo pipefail
TOOL_DIR="$(cd "$(dirname "$0")" && pwd -P)"
XS_ROOT="$(cd "$TOOL_DIR/.." && pwd -P)"
FULL=0
[ "${1:-}" = '--full' ] && FULL=1
[ "$#" -le 1 ] || { printf '[错误] 用法：%s [--full]\n' "$0" >&2; exit 2; }

NODE="${XIAOSHE_NODE:-$(command -v node 2>/dev/null || true)}"
[ -n "$NODE" ] || { printf '[错误] 未找到 Node.js。\n' >&2; exit 1; }
"$NODE" "$XS_ROOT/scripts/handoff-manifest.mjs" verify

for required in "$XS_ROOT/package.json" "$XS_ROOT/runtime/DSH/package.json" "$XS_ROOT/runtime/xiaoshe-legacy/run.py"; do
  [ -f "$required" ] || { printf '[错误] 缺少 %s\n' "$required" >&2; exit 1; }
done
printf '[通过] 三层源码、Git 历史与工作树完整。\n'

if [ "$FULL" = 1 ]; then
  PNPM="${XIAOSHE_PNPM:-$(command -v pnpm 2>/dev/null || true)}"
  [ -n "$PNPM" ] || { printf '[错误] --full 需要 pnpm 11.7.0。\n' >&2; exit 1; }
  [ "$($PNPM --version)" = '11.7.0' ] || { printf '[错误] pnpm 版本必须为 11.7.0。\n' >&2; exit 1; }
  (
    # 路径型 filter 必须以 XS 为 cwd；--dir 不改变 pnpm 的 filter 基准。
    cd "$XS_ROOT"
    "$PNPM" -r --filter './packages/**' run build
    "$PNPM" -r --filter './packages/**' run test
    "$PNPM" -r --filter './packages/**' run build
    "$PNPM" -r --filter './packages/**' run typecheck
    "$PNPM" run check
  )
  "$PNPM" --dir "$XS_ROOT/runtime/DSH" dsh web --dump-config >/dev/null
  printf '[通过] XS 全部门禁与 DSH Profile 解析。\n'
fi
