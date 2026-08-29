#!/bin/bash
# 生成一个不携带本机依赖/缓存的 tar.gz，并在临时目录真实解包复验。
set -euo pipefail
TOOL_DIR="$(cd "$(dirname "$0")" && pwd -P)"
XS_ROOT="$(cd "$TOOL_DIR/.." && pwd -P)"
BASENAME="$(basename "$XS_ROOT")"
NODE="${XIAOSHE_NODE:-$(command -v node 2>/dev/null || true)}"
[ -n "$NODE" ] || { printf '[错误] 未找到 Node.js。\n' >&2; exit 1; }

"$NODE" "$XS_ROOT/scripts/handoff-manifest.mjs" generate
"$NODE" "$XS_ROOT/scripts/handoff-manifest.mjs" verify

STAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT="$TOOL_DIR/XS-完整交接包-${STAMP}.tar.gz"
TMP_ROOT="$(mktemp -d)"
TMP_ARCHIVE="$TMP_ROOT/package.tar.gz"
STAGED_ROOT="$TMP_ROOT/staged/$BASENAME"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

verify_macos_entry_modes() {
  local root="$1"
  local entry
  for entry in \
    '启动小蛇.command' \
    '启动小蛇终端.command' \
    '停止小蛇.command' \
    '交接工具/接收并安装-macOS.command' \
    '交接工具/验证交接-macOS.command' \
    '交接工具/创建交接包-macOS.command'; do
    [ -x "$root/$entry" ] || {
      printf '[错误] macOS 入口缺少执行权限：%s\n' "$entry" >&2
      return 1
    }
  done
}

printf '[分期] 正在创建不含凭据、会话、平台依赖和缓存的可迁移副本…\n'
mkdir -p "$STAGED_ROOT"
# 不复制 macOS com.apple.provenance/resource-fork xattr：它们不是项目内容，
# 且 openrsync -E 可能对只读 Git object 返回 Permission denied。
rsync -a \
  --include='.env.example' \
  --include='/docs/evidence/macos-terminal-screen-smoke.log' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='.credentials.yaml' \
  --exclude='.state/' \
  --exclude='.session/' \
  --exclude='.sessions/' \
  --exclude='.storages/' \
  --exclude='.worktrees/' \
  --exclude='.cache/' \
  --exclude='.pnpm-store/' \
  --exclude='.pytest_cache/' \
  --exclude='.vitest/' \
  --exclude='__pycache__/' \
  --exclude='node_modules/' \
  --exclude='coverage/' \
  --exclude='dist/' \
  --exclude='/packages/*/lib/' \
  --exclude='*.pyc' \
  --exclude='*.log' \
  --exclude='*.tsbuildinfo' \
  --exclude='ui_token' \
  --exclude='model_secrets.bin*' \
  --exclude='mcp.json' \
  --exclude='/runtime/DSH/**/lib/' \
  --exclude='/runtime/xiaoshe-legacy/Harness交接/' \
  --exclude='/交接工具/XS-完整交接包-*' \
  --exclude='.DS_Store' \
  "$XS_ROOT/" "$STAGED_ROOT/"
verify_macos_entry_modes "$STAGED_ROOT"
"$NODE" "$STAGED_ROOT/scripts/handoff-manifest.mjs" verify

printf '[打包] 正在创建 tar.gz…\n'
tar -czf "$TMP_ARCHIVE" -C "$TMP_ROOT/staged" "$BASENAME"

mkdir -p "$TMP_ROOT/unpacked"
tar -xzf "$TMP_ARCHIVE" -C "$TMP_ROOT/unpacked"
verify_macos_entry_modes "$TMP_ROOT/unpacked/$BASENAME"
"$NODE" "$TMP_ROOT/unpacked/$BASENAME/scripts/handoff-manifest.mjs" verify
mv "$TMP_ARCHIVE" "$OUTPUT"
read -r HASH SIZE < <("$NODE" -e '
  const { createHash } = require("node:crypto")
  const { readFileSync, statSync } = require("node:fs")
  const path = process.argv[1]
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex")
  process.stdout.write(`${hash} ${statSync(path).size}\n`)
' "$OUTPUT")
CHECKSUM="${OUTPUT}.sha256"
printf '%s  %s\n' "$HASH" "$(basename "$OUTPUT")" > "$CHECKSUM"
printf '[完成] 交接包已经“打包 → 解包 → 哈希/Git 复验”：\n%s\n' "$OUTPUT"
printf 'SHA-256: %s\n字节数: %s\n校验文件: %s\n' "$HASH" "$SIZE" "$CHECKSUM"
