#!/bin/bash
# 小蛇开发者发行版安装器：安装锁定依赖、构建产品并配置 DSH web Profile。
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "$0")" && pwd -P)"
XS_ROOT="$(cd "$TOOL_DIR/.." && pwd -P)"
DSH_ROOT="$XS_ROOT/runtime/DSH"
CHECK_ONLY=0
RUN_DEVELOPER_VALIDATION=0
for argument in "$@"; do
  case "$argument" in
    --check-only) CHECK_ONLY=1 ;;
    --run-developer-validation) RUN_DEVELOPER_VALIDATION=1 ;;
    *) printf '[错误] 用法：%s [--check-only] [--run-developer-validation]\n' "$0" >&2; exit 2 ;;
  esac
done
INSTALL_MODE="${XIAOSHE_INSTALL_MODE:-developer-source}"
case "$INSTALL_MODE" in
  developer-source|embedded-runtime) ;;
  *) printf '[错误] 未知安装模式：%s\n' "$INSTALL_MODE" >&2; exit 2 ;;
esac

say() { printf '\n[%s] %s\n' "$1" "$2"; }
fail() { printf '[错误] %s\n' "$1" >&2; exit 1; }
require_file() { [ -f "$1" ] || fail "发行源码不完整，缺少：$1"; }

find_compatible_node() {
  local candidate
  for candidate in "${XIAOSHE_NODE:-}" "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    "$candidate" -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 23) || (major === 24 && minor >= 17) ? 0 : 1)' \
      >/dev/null 2>&1 && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

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

NODE="$(find_compatible_node || true)"
if [ -z "$NODE" ] && [ "$CHECK_ONLY" = 0 ] && command -v brew >/dev/null 2>&1; then
  say '安装' '未找到 Node 24，通过 Homebrew 安装 node@24…'
  brew install node@24
  NODE="$(find_compatible_node || true)"
fi
[ -n "$NODE" ] || fail '需要 Node.js 22.23+ 或 24.17+。请先安装 Node 24 LTS（推荐 brew install node@24）后重试。'
export PATH="$(dirname "$NODE"):$PATH"
PYTHON="$(find_compatible_python || true)"
[ -n "$PYTHON" ] || fail '需要真实的 Python 3.10+ 解释器。'
export XIAOSHE_PYTHON="$PYTHON"

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

say '校验' '检查开发者发行源码和本机工具链…'
command -v git >/dev/null 2>&1 || fail '未找到 Git。'
require_file "$XS_ROOT/package.json"
require_file "$DSH_ROOT/package.json"
require_file "$XS_ROOT/runtime/xiaoshe-legacy/run.py"
require_file "$XS_ROOT/packages/product-bundle/package.json"
require_file "$XS_ROOT/packages/provider-readiness/package.json"
require_file "$XS_ROOT/packages/migration-recovery/package.json"
require_file "$XS_ROOT/packages/agent-experience/package.json"
require_file "$XS_ROOT/packages/coding-workbench/package.json"
require_file "$TOOL_DIR/profile/cordis.patch.yml"
if [ "$INSTALL_MODE" = 'developer-source' ]; then
  require_file "$XS_ROOT/启动小蛇.command"
  require_file "$XS_ROOT/启动小蛇终端.command"
  require_file "$XS_ROOT/停止小蛇.command"
fi
if [ "$RUN_DEVELOPER_VALIDATION" = 1 ]; then
  # --check-only must validate every input selected by its flags before the
  # early success exit; otherwise a partial handoff reports a false green.
  require_file "$XS_ROOT/apps/desktop-shell/package.json"
fi
printf '  Node %s\n' "$("$NODE" --version)"
if [ -n "$PNPM" ]; then printf '  pnpm %s\n' "$($PNPM --version)"; else printf '  pnpm 将由安装器配置为 11.7.0\n'; fi
printf '  XS %s\n' "$XS_ROOT"

if [ "$CHECK_ONLY" = 1 ]; then
  say '通过' '源码结构和前置工具已验证；未修改本机。'
  exit 0
fi

# 正式安装始终使用用户目录下的固定 pnpm 实例。Corepack shim 会根据当前
# 工作目录自动选版，不能作为 DSH 子进程的版本边界。
PNPM_PREFIX="${HOME}/.local/share/xiaoshe/pnpm-11.7.0"
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
PNPM_SHIM_DIR="${HOME}/.local/share/xiaoshe/bin"
mkdir -p "$PNPM_SHIM_DIR"
ln -sfn "$PNPM" "$PNPM_SHIM_DIR/pnpm"
export PATH="$PNPM_SHIM_DIR:$(dirname "$NODE"):$PATH"

PROFILE_ROOT="${DSH_HOME:-${HOME}/.dsh}/profiles/web"
if [ -d "$PROFILE_ROOT" ]; then
  BACKUP_PARENT="${DSH_HOME:-${HOME}/.dsh}/backups"
  mkdir -p "$BACKUP_PARENT"
  BACKUP_ROOT="$(mktemp -d "$BACKUP_PARENT/web-before-xiaoshe-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
  # macOS ditto has no --exclude option. The system rsync supports a bounded
  # archive copy and preserves symlinks/metadata without duplicating the
  # disposable dependency tree.
  [ -x /usr/bin/rsync ] || fail '缺少系统 rsync，无法安全备份现有 web Profile。'
  /usr/bin/rsync -a --exclude 'node_modules/' --exclude '.dsh-module-fallback/' "$PROFILE_ROOT/" "$BACKUP_ROOT/"
  say '备份' "已备份原 web Profile：$BACKUP_ROOT"
fi

say '安装' '安装 DSH 锁定依赖并构建…'
"$PNPM" --dir "$DSH_ROOT" install --frozen-lockfile
"$PNPM" --dir "$DSH_ROOT" run build

say '构建' '安装 XS 锁定依赖并构建产品插件…'
(
  # pnpm 的路径型 --filter 相对进程 cwd 解析，不能只依赖 --dir；否则从
  # Finder 或其他目录启动时会静默匹配 0 个 workspace 包。
  cd "$XS_ROOT"
  "$PNPM" install --frozen-lockfile
  # pnpm 的依赖图可能已完整，但 Electron 的平台二进制仍可能因
  # 主机空间、缓存或 install script 中断而缺失。ss 是原生入口，
  # 因此安装不能只信任 pnpm 的退出码，必须验证真实可执行文件。
  if [ "$INSTALL_MODE" = 'developer-source' ]; then
    ELECTRON_ROOT="$XS_ROOT/apps/desktop-shell/node_modules/electron"
    ELECTRON_INSTALL="$ELECTRON_ROOT/install.js"
    ELECTRON_BIN="$ELECTRON_ROOT/dist/Electron.app/Contents/MacOS/Electron"
    if [ ! -x "$ELECTRON_BIN" ]; then
      [ -f "$ELECTRON_INSTALL" ] || fail 'Electron 依赖不完整，缺少官方安装脚本。'
      say '安装' '补齐 Electron 原生桌面运行时…'
      "$NODE" "$ELECTRON_INSTALL"
    fi
    [ -x "$ELECTRON_BIN" ] || fail 'Electron 安装脚本已返回，但原生可执行文件仍缺失。'
  fi
  # 冷设备没有任何 lib：按拓扑构建上游导出，再检查产品源码类型。
  "$PNPM" -r --filter './packages/**' run build
  "$PNPM" -r --filter './packages/**' run typecheck
  "$PNPM" run typecheck
  "$PNPM" run build
  # Packaged acceptance already runs this suite before launch. Keep the suite
  # out of the installation Profile/port/temp environment unless a developer
  # explicitly asks for source validation.
  if [ "$RUN_DEVELOPER_VALIDATION" = 1 ]; then
    "$PNPM" --filter '@xiaoshe/desktop-shell' test
  fi
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
    "$XS_ROOT/packages/project-knowledge" \
    "$XS_ROOT/packages/plugin-governance" \
    "$XS_ROOT/packages/provider-readiness" \
    "$XS_ROOT/packages/migration-recovery" \
    "$XS_ROOT/packages/agent-experience" \
    "$XS_ROOT/packages/coding-workbench" \
    "$XS_ROOT/packages/task-timeline" \
    "$DSH_ROOT/packages/session-query/tool-session-query" \
    "$DSH_ROOT/packages/web/web-fetch-http" \
    "$XS_ROOT/packages/product-bundle"
)
mkdir -p "$PROFILE_ROOT"
PROFILE_PATCH="$PROFILE_ROOT/cordis.patch.yml"
"$NODE" "$XS_ROOT/scripts/ensure-profile-patch.mjs" \
  --target "$PROFILE_PATCH" \
  --template "$TOOL_DIR/profile/cordis.patch.yml"
"$NODE" "$XS_ROOT/scripts/patch-modlens-runtime.mjs" \
  --profile-root "$PROFILE_ROOT"

chmod +x "$XS_ROOT/scripts/"*.sh "$TOOL_DIR/install-macos.sh"
if [ "$INSTALL_MODE" = 'developer-source' ]; then
  chmod +x "$XS_ROOT/启动小蛇.command" "$XS_ROOT/启动小蛇终端.command" "$XS_ROOT/停止小蛇.command"
  ZSHRC="${HOME}/.zshrc"
  [ ! -e "$ZSHRC" ] || cp -p "$ZSHRC" "${ZSHRC}.before-xiaoshe-$(date +%Y%m%d-%H%M%S).bak"
  TMP_ZSHRC="$(mktemp)"
  if [ -f "$ZSHRC" ]; then
    # 兼容早期交接包写入的旧标记，避免重复安装后留下两组 s / ss。
    awk '/^# >>> XS 小蛇(交接)? >>>$/{skip=1;next}/^# <<< XS 小蛇(交接)? <<<$/{skip=0;next}!skip{print}' "$ZSHRC" > "$TMP_ZSHRC"
  fi
  ESCAPED_ROOT="${XS_ROOT//\'/\'\\\'\'}"
  {
    printf '%s\n' '# >>> XS 小蛇 >>>'
    printf '%s\n' 'unalias s ss 2>/dev/null || true'
    printf '%s\n' 'unfunction s ss 2>/dev/null || true'
    printf "s() { bash '%s/scripts/start-xiaoshe-terminal.sh' \"\$@\"; }\n" "$ESCAPED_ROOT"
    printf "ss() { bash '%s/启动小蛇.command' \"\$@\"; }\n" "$ESCAPED_ROOT"
    printf '%s\n' '# <<< XS 小蛇 <<<'
  } >> "$TMP_ZSHRC"
  mv "$TMP_ZSHRC" "$ZSHRC"
else
  say '配置' '桌面应用运行时不修改终端配置；启动与退出由已安装的“小蛇.app”管理。'
fi

say '终验' '解析最终 DSH web Profile…'
"$PNPM" --dir "$DSH_ROOT" dsh web --dump-config >/dev/null
say '冒烟' '在隔离端口启动已安装 Profile 并验证产品健康…'
"$NODE" "$XS_ROOT/scripts/smoke-installed-profile.mjs" \
  --dsh-root "$DSH_ROOT" --profile-root "$PROFILE_ROOT"

if [ "$INSTALL_MODE" = 'developer-source' ]; then
  say '完成' '开发者发行版、依赖、Profile、独立桌面壳与 s / ss 双入口已安装。'
  printf '%s\n' \
    '  1. 本包故意不包含 API Key；首次打开后在设置里配置 DEEPSEEK_API_KEY。' \
    '  2. macOS 需为真实宿主授予“屏幕与系统录音”及“辅助功能”权限。' \
    '  3. 重开终端输入 s 启动终端版；输入 ss 或双击 XS/启动小蛇.command 启动界面版。'
else
  say '完成' '桌面应用运行时、锁定依赖与 DSH web Profile 已安装。'
  printf '%s\n' \
    '  1. 应用不包含 API Key；首次打开后在设置里配置 DEEPSEEK_API_KEY。' \
    '  2. macOS 需为“小蛇”授予“屏幕与系统录音”及“辅助功能”权限。' \
    '  3. 后续由“小蛇.app”启动；未修改终端快捷入口。'
fi
