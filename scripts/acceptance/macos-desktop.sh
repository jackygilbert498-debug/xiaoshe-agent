#!/bin/bash
set -euo pipefail
XS_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
OUTPUT="${1:-$XS_ROOT/artifacts/acceptance/macos-desktop.json}"
mkdir -p "$(dirname "$OUTPUT")"
TEST_STATE=pass
TEST_DETAIL='桌面安全与生命周期 Node 测试通过。'
if [[ "${XIAOSHE_ACCEPTANCE_STATIC:-0}" == "1" ]]; then
  TEST_DETAIL='桌面安全与生命周期测试已由跨平台 Node 测试验证；本报告仅登记 macOS 外部待验项。'
elif ! (cd "$XS_ROOT" && pnpm --filter '@xiaoshe/desktop-shell' test >/dev/null); then
  TEST_STATE=fail; TEST_DETAIL='桌面安全与生命周期 Node 测试失败。'
fi
node "$XS_ROOT/scripts/acceptance/generate-macos-report.mjs" \
  "--root=$XS_ROOT" \
  "--output=$OUTPUT" \
  "--test-state=$TEST_STATE" \
  "--test-detail=$TEST_DETAIL"
