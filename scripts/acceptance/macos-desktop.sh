#!/bin/bash
set -euo pipefail
XS_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
OUTPUT="${1:-$XS_ROOT/artifacts/acceptance/macos-desktop.json}"
mkdir -p "$(dirname "$OUTPUT")"
NODE=""
for CANDIDATE in /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ] \
    && "$CANDIDATE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; then
    NODE="$CANDIDATE"
    break
  fi
done
[ -n "$NODE" ] || { printf '[错误] macOS 验收需要 Node 24。\n' >&2; exit 2; }
export PATH="$(dirname "$NODE"):$PATH"

TEST_STATE=pass
TEST_DETAIL='桌面安全与生命周期 Node 测试通过。'
if [[ "${XIAOSHE_ACCEPTANCE_STATIC:-0}" == "1" ]]; then
  TEST_DETAIL='桌面安全与生命周期测试已由跨平台 Node 测试验证；本报告仅登记 macOS 外部待验项。'
elif ! (cd "$XS_ROOT" && pnpm --filter '@xiaoshe/desktop-shell' test >/dev/null); then
  TEST_STATE=fail; TEST_DETAIL='桌面安全与生命周期 Node 测试失败。'
fi

ACTION_REPORT="$XS_ROOT/artifacts/acceptance/macos-desktop-actions.json"
LIFECYCLE_REPORT="$XS_ROOT/artifacts/acceptance/macos-app-lifecycle.json"
SIGNING_REPORT="$XS_ROOT/artifacts/acceptance/macos-signing-notarization.json"
INSTALL_REPORT="$XS_ROOT/artifacts/acceptance/macos-install-uninstall.json"
DESKTOP_VERSION="$("$NODE" -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$XS_ROOT/apps/desktop-shell/package.json")"
DMG="$XS_ROOT/apps/desktop-shell/dist-desktop/Xiaoshe-${DESKTOP_VERSION}-arm64.dmg"
REPORT_ARGS=()

if [[ "${XIAOSHE_ACCEPTANCE_STATIC:-0}" != "1" && "$TEST_STATE" == "pass" ]]; then
  if [[ "${XIAOSHE_ACCEPTANCE_REUSE_DMG:-0}" != "1" || ! -f "$DMG" ]]; then
    (cd "$XS_ROOT" && pnpm --filter '@xiaoshe/desktop-shell' exec electron-builder --mac dmg --arm64 --config electron-builder.yml --publish never)
  fi
  python3 "$XS_ROOT/scripts/acceptance/macos-desktop-actions.py" --root "$XS_ROOT" --output "$ACTION_REPORT"
  "$NODE" "$XS_ROOT/scripts/acceptance/macos-app-lifecycle.mjs" --root="$XS_ROOT" --output="$LIFECYCLE_REPORT"
  "$NODE" "$XS_ROOT/scripts/acceptance/macos-signing-gate.mjs" --root="$XS_ROOT" --dmg="$DMG" --output="$SIGNING_REPORT"
  "$NODE" "$XS_ROOT/scripts/acceptance/macos-install-uninstall.mjs" --root="$XS_ROOT" --dmg="$DMG" --output="$INSTALL_REPORT"
  REPORT_ARGS+=("--actions=$ACTION_REPORT" "--lifecycle=$LIFECYCLE_REPORT" "--signing=$SIGNING_REPORT" "--install=$INSTALL_REPORT")
fi

if [[ "${XIAOSHE_ACCEPTANCE_STATIC:-0}" == "1" ]]; then
  "$NODE" "$XS_ROOT/scripts/acceptance/generate-macos-report.mjs" \
    "--root=$XS_ROOT" \
    "--output=$OUTPUT" \
    "--test-state=$TEST_STATE" \
    "--test-detail=$TEST_DETAIL"
else
  "$NODE" "$XS_ROOT/scripts/acceptance/generate-macos-report.mjs" \
    "--root=$XS_ROOT" \
    "--output=$OUTPUT" \
    "--test-state=$TEST_STATE" \
    "--test-detail=$TEST_DETAIL" \
    "${REPORT_ARGS[@]}"
fi
