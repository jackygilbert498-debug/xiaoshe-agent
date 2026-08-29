#!/bin/bash
# 在新 Mac 上运行：校验交接载荷、安装锁定依赖、构建两层工程并配置 DSH web Profile。
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "$0")" && pwd -P)"
XS_ROOT="$(cd "$TOOL_DIR/.." && pwd -P)"
DSH_ROOT="$XS_ROOT/runtime/DSH"
CHECK_ONLY=0
[ "${1:-}" = "--check-only" ] && CHECK_ONLY=1
[ "$#" -le 1 ] || { printf '[错误] 用法：%s [--check-only]\n' "$0" >&2; exit 2; }

say() { printf '\n[%s] %s\n' "$1" "$2"; }
fail() { printf '[错误] %s\n' "$1" >&2; exit 1; }

find_compatible_node() {
  local candidate
  for candidate in "${XIAOSHE_NODE:-}" "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    "$candidate" -e 'const [major]=process.versions.node.split(".").map(Number); process.exit(major >= 24 ? 0 : 1)' \
      >/dev/null 2>&1 && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

NODE="$(find_compatible_node || true)"
if [ -z "$NODE" ] && [ "$CHECK_ONLY" = 0 ] && command -v brew >/dev/null 2>&1; then
  say '安装' '未找到 Node 24，通过 Homebrew 安装 node@24…'
  brew install node@24
  NODE="$(find_compatible_node || true)"
fi
[ -n "$NODE" ] || fail '需要 Node.js 24。请先安装 Node 24（推荐 brew install node@24）后重试。'
export PATH="$(dirname "$NODE"):$PATH"

find_pnpm() {
  local candidate version
  for candidate in "${XIAOSHE_PNPM:-}" "$(command -v pnpm 2>/dev/null || true)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    version="$($candidate --version 2>/dev/null || true)"
    [ "$version" = '11.7.0' ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

PNPM="$(find_pnpm || true)"
if [ "$CHECK_ONLY" = 1 ] && [ -z "$PNPM" ]; then
  fail '未找到 pnpm 11.7.0。正式安装模式会自动安装；当前是 --check-only。'
fi
if [ -n "$PNPM" ]; then
  PNPM="$(cd "$(dirname "$PNPM")" && pwd -P)/$(basename "$PNPM")"
fi

say '校验' '检查交接文件哈希和 Git 对象…'
"$NODE" "$XS_ROOT/scripts/handoff-manifest.mjs" verify
printf '  Node %s\n' "$("$NODE" --version)"
if [ -n "$PNPM" ]; then printf '  pnpm %s\n' "$($PNPM --version)"; else printf '  pnpm 将由安装器配置为 11.7.0\n'; fi
printf '  XS %s\n' "$XS_ROOT"

if [ "$CHECK_ONLY" = 1 ]; then
  say '通过' '接收前置条件和载荷完整性均已验证；未修改本机。'
  exit 0
fi

# 正式安装始终使用用户目录下的固定 pnpm 实例。Corepack shim 会根据当前
# 工作目录自动选版，不能作为 DSH 子进程的版本边界。
PNPM_PREFIX="${HOME}/.local/share/xiaoshe-handoff/pnpm-11.7.0"
DEDICATED_PNPM="$PNPM_PREFIX/node_modules/.bin/pnpm"
if [ ! -x "$DEDICATED_PNPM" ] || [ "$($DEDICATED_PNPM --version 2>/dev/null || true)" != '11.7.0' ]; then
  NPM="$(command -v npm 2>/dev/null || true)"
  [ -n "$NPM" ] || fail '未找到 npm，无法安装项目专用 pnpm 11.7.0。'
  say '安装' '安装项目专用 pnpm 11.7.0…'
  "$NPM" install --prefix "$PNPM_PREFIX" --no-save --no-audit --no-fund pnpm@11.7.0
fi
PNPM="$DEDICATED_PNPM"

# dsh plugin 会再启动一个名为 pnpm 的子进程。专用 shim 保证子进程
# 也使用经验收的 11.7.0，而不是被 Corepack 自动切到其他版本。
PNPM_SHIM_DIR="${HOME}/.local/share/xiaoshe-handoff/bin"
mkdir -p "$PNPM_SHIM_DIR"
ln -sfn "$PNPM" "$PNPM_SHIM_DIR/pnpm"
export PATH="$PNPM_SHIM_DIR:$(dirname "$NODE"):$PATH"

PROFILE_ROOT="${DSH_HOME:-${HOME}/.dsh}/profiles/web"
if [ -d "$PROFILE_ROOT" ]; then
  BACKUP_ROOT="${DSH_HOME:-${HOME}/.dsh}/backups/web-before-xs-handoff-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$(dirname "$BACKUP_ROOT")"
  cp -pR "$PROFILE_ROOT" "$BACKUP_ROOT"
  say '备份' "已备份原 web Profile：$BACKUP_ROOT"
fi

say '安装' '安装 DSH 锁定依赖并构建…'
"$PNPM" --dir "$DSH_ROOT" install --frozen-lockfile
"$PNPM" --dir "$DSH_ROOT" run build

say '验证' '安装 XS 锁定依赖并运行全部本地门禁…'
(
  # pnpm 的路径型 --filter 相对进程 cwd 解析，不能只依赖 --dir；否则从
  # Finder、其他目录或交接工具目录启动时会静默匹配 0 个 workspace 包。
  cd "$XS_ROOT"
  "$PNPM" install --frozen-lockfile
  # 冷设备没有任何 lib：先按拓扑构建上游导出，供下游包测试解析。
  "$PNPM" -r --filter './packages/**' run build
  # 部分 artifact 测试会主动清理临时 lib；测试后必须再次构建，生成供
  # 根项目读取的最终工作区产物，不能依赖上一台设备遗留的构建目录。
  "$PNPM" -r --filter './packages/**' run test
  "$PNPM" -r --filter './packages/**' run build
  "$PNPM" -r --filter './packages/**' run typecheck
  "$PNPM" run check
)

say '配置' '将 ModLens、XS 桌面能力和完整 Product Bundle 接入 DSH web Profile…'
(
  cd "$XS_ROOT"
  "$PNPM" --dir "$DSH_ROOT" dsh plugin --profile web add \
    '@liustack/modlens@3.22.0' \
    "$XS_ROOT" \
    "$XS_ROOT/packages/verification-policy" \
    "$XS_ROOT/packages/native-shell-legacy-adapted" \
    "$XS_ROOT/packages/runtime-dsh-provider" \
    "$XS_ROOT/packages/completion-receipt" \
    "$XS_ROOT/packages/runtime-contract" \
    "$XS_ROOT/packages/heartbeat" \
    "$XS_ROOT/packages/memory" \
    "$XS_ROOT/packages/plugin-governance" \
    "$XS_ROOT/packages/task-timeline" \
    "$XS_ROOT/packages/product-bundle"
)
mkdir -p "$PROFILE_ROOT"
PROFILE_PATCH="$PROFILE_ROOT/cordis.patch.yml"
"$NODE" "$XS_ROOT/scripts/ensure-handoff-profile-patch.mjs" \
  --target "$PROFILE_PATCH" \
  --template "$TOOL_DIR/profile/cordis.patch.yml"

chmod +x "$XS_ROOT/启动小蛇.command" "$XS_ROOT/启动小蛇终端.command" "$XS_ROOT/停止小蛇.command" "$XS_ROOT/scripts/"*.sh "$XS_ROOT/scripts/"*.command "$TOOL_DIR/"*.command
ZSHRC="${HOME}/.zshrc"
[ ! -e "$ZSHRC" ] || cp -p "$ZSHRC" "${ZSHRC}.before-xs-handoff-$(date +%Y%m%d-%H%M%S).bak"
TMP_ZSHRC="$(mktemp)"
if [ -f "$ZSHRC" ]; then
  awk '/^# >>> XS 小蛇交接 >>>$/{skip=1;next}/^# <<< XS 小蛇交接 <<<$/{skip=0;next}!skip{print}' "$ZSHRC" > "$TMP_ZSHRC"
fi
ESCAPED_ROOT="${XS_ROOT//\'/\'\\\'\'}"
{
  printf '%s\n' '# >>> XS 小蛇交接 >>>'
  printf '%s\n' 'unalias s ss 2>/dev/null || true'
  printf '%s\n' 'unfunction s ss 2>/dev/null || true'
  printf "s() { bash '%s/scripts/start-xiaoshe-terminal.sh' \"\$@\"; }\n" "$ESCAPED_ROOT"
  printf "ss() { bash '%s/启动小蛇.command' \"\$@\"; }\n" "$ESCAPED_ROOT"
  printf '%s\n' '# <<< XS 小蛇交接 <<<'
} >> "$TMP_ZSHRC"
mv "$TMP_ZSHRC" "$ZSHRC"

say '终验' '解析最终 DSH web Profile…'
"$PNPM" --dir "$DSH_ROOT" dsh web --dump-config >/dev/null

say '完成' '工程、依赖、Profile 与 s / ss 双入口已安装。'
printf '%s\n' \
  '  1. 本包故意不包含 API Key；首次打开后在设置里配置 DEEPSEEK_API_KEY。' \
  '  2. macOS 需为真实宿主授予“屏幕与系统录音”及“辅助功能”权限。' \
  '  3. 重开终端输入 s 启动终端版；输入 ss 或双击 XS/启动小蛇.command 启动界面版。'
