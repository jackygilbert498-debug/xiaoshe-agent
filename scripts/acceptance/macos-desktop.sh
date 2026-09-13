#!/bin/bash
set -euo pipefail
XS_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
OUTPUT="${1:-$XS_ROOT/artifacts/acceptance/macos-desktop.json}"
mkdir -p "$(dirname "$OUTPUT")"
/bin/rm -f -- "$OUTPUT"
NODE=""
for CANDIDATE in /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ] \
    && "$CANDIDATE" -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 23) || (major === 24 && minor >= 17) ? 0 : 1)' >/dev/null 2>&1; then
    NODE="$CANDIDATE"
    break
  fi
done
[ -n "$NODE" ] || { printf '[错误] macOS 验收需要 Node.js 22.23+ 或 24.17+。\n' >&2; exit 2; }
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
SOURCE_CAPTURE="$XS_ROOT/artifacts/acceptance/macos-source-capture.json"
SOURCE_REPORT="$XS_ROOT/artifacts/acceptance/macos-source-identity.json"
SOURCE_IDENTITY="$XS_ROOT/scripts/release/macos-source-identity.mjs"
DESKTOP_VERSION="$("$NODE" -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$XS_ROOT/apps/desktop-shell/package.json")"
DMG="$XS_ROOT/apps/desktop-shell/dist-desktop/Xiaoshe-${DESKTOP_VERSION}-arm64.dmg"
APP="$XS_ROOT/apps/desktop-shell/dist-desktop/mac-arm64/小蛇.app"
REPORT_ARGS=()
RUN_CONTEXT="$("$NODE" "$XS_ROOT/scripts/acceptance/macos-acceptance-run.mjs" begin \
  "$OUTPUT" "$ACTION_REPORT" "$LIFECYCLE_REPORT" "$SIGNING_REPORT" "$INSTALL_REPORT" "$SOURCE_CAPTURE" "$SOURCE_REPORT")"
IFS='|' read -r XIAOSHE_ACCEPTANCE_RUN_ID XIAOSHE_ACCEPTANCE_RUN_STARTED_AT <<<"$RUN_CONTEXT"
export XIAOSHE_ACCEPTANCE_RUN_ID XIAOSHE_ACCEPTANCE_RUN_STARTED_AT

# A component command deliberately returns non-zero for a failed check. Keep
# `set -e` from erasing the aggregate report, and synthesize only a content-free
# fail record when an interrupted component did not leave usable evidence.
LAST_COMPONENT_SUCCEEDED=0
run_acceptance_component() {
  local component="$1"
  local report="$2"
  shift 2
  LAST_COMPONENT_SUCCEEDED=0
  if "$@"; then LAST_COMPONENT_SUCCEEDED=1; return 0; fi
  "$NODE" "$XS_ROOT/scripts/acceptance/macos-acceptance-run.mjs" ensure-failure "$component" "$report"
  return 0
}

if [[ "${XIAOSHE_ACCEPTANCE_STATIC:-0}" != "1" && "$TEST_STATE" == "pass" ]]; then
  FORMAL_SETUP=pass
  if ! "$NODE" "$SOURCE_IDENTITY" capture "--root=$XS_ROOT" "--output=$SOURCE_CAPTURE"; then
    FORMAL_SETUP=fail
  elif [[ "${XIAOSHE_ACCEPTANCE_REUSE_DMG:-0}" != "1" || ! -f "$DMG" ]] \
    && ! (cd "$XS_ROOT" && pnpm --filter '@xiaoshe/desktop-shell' exec electron-builder --mac dmg --arm64 --config electron-builder.yml --publish never); then
    FORMAL_SETUP=fail
  fi
  if [[ "$FORMAL_SETUP" == "fail" ]]; then
    for COMPONENT_REPORT in "actions:$ACTION_REPORT" "signing:$SIGNING_REPORT" "source:$SOURCE_REPORT" "lifecycle:$LIFECYCLE_REPORT" "install:$INSTALL_REPORT"; do
      run_acceptance_component "${COMPONENT_REPORT%%:*}" "${COMPONENT_REPORT#*:}" false
    done
  else
    run_acceptance_component actions "$ACTION_REPORT" python3 "$XS_ROOT/scripts/acceptance/macos-desktop-actions.py" --root "$XS_ROOT" --output "$ACTION_REPORT"
    run_acceptance_component signing "$SIGNING_REPORT" env XIAOSHE_MAC_SOURCE_REPORT="$SOURCE_REPORT" "$NODE" "$XS_ROOT/scripts/acceptance/macos-signing-gate.mjs" --root="$XS_ROOT" --dmg="$DMG" --output="$SIGNING_REPORT"
    # The signing gate may rebuild, sign, staple, and replace both APP and DMG.
    # Freeze their final bytes only after that mutation, then launch that exact app.
    run_acceptance_component source "$SOURCE_REPORT" "$NODE" "$SOURCE_IDENTITY" verify "--root=$XS_ROOT" "--expected=$SOURCE_CAPTURE" "--app=$APP" "--dmg=$DMG" "--output=$SOURCE_REPORT"
    if [[ "$LAST_COMPONENT_SUCCEEDED" == "1" ]]; then
      run_acceptance_component lifecycle "$LIFECYCLE_REPORT" "$NODE" "$XS_ROOT/scripts/acceptance/macos-app-lifecycle.mjs" --root="$XS_ROOT" --app="$APP" --runtime=packaged --source="$SOURCE_REPORT" --output="$LIFECYCLE_REPORT"
      run_acceptance_component install "$INSTALL_REPORT" "$NODE" "$XS_ROOT/scripts/acceptance/macos-install-uninstall.mjs" --root="$XS_ROOT" --dmg="$DMG" --output="$INSTALL_REPORT"
    else
      # Never launch or install a DMG that was not bound to this run's clean source.
      run_acceptance_component lifecycle "$LIFECYCLE_REPORT" false
      run_acceptance_component install "$INSTALL_REPORT" false
    fi
  fi
  REPORT_ARGS+=("--source=$SOURCE_REPORT" "--actions=$ACTION_REPORT" "--lifecycle=$LIFECYCLE_REPORT" "--signing=$SIGNING_REPORT" "--install=$INSTALL_REPORT")
fi

if [[ "${XIAOSHE_ACCEPTANCE_STATIC:-0}" == "1" ]]; then
  "$NODE" "$XS_ROOT/scripts/acceptance/generate-macos-report.mjs" \
    "--root=$XS_ROOT" \
    "--output=$OUTPUT" \
    "--test-state=$TEST_STATE" \
    "--test-detail=$TEST_DETAIL" \
    "--run-id=$XIAOSHE_ACCEPTANCE_RUN_ID" \
    "--run-started-at=$XIAOSHE_ACCEPTANCE_RUN_STARTED_AT"
else
  "$NODE" "$XS_ROOT/scripts/acceptance/generate-macos-report.mjs" \
    "--root=$XS_ROOT" \
    "--output=$OUTPUT" \
    "--test-state=$TEST_STATE" \
    "--test-detail=$TEST_DETAIL" \
    "--run-id=$XIAOSHE_ACCEPTANCE_RUN_ID" \
    "--run-started-at=$XIAOSHE_ACCEPTANCE_RUN_STARTED_AT" \
    "${REPORT_ARGS[@]}"
fi
