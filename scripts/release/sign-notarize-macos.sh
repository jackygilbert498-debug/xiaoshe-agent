#!/bin/bash
# Build, sign, notarize, staple, and Gatekeeper-check the Apple Silicon release.
set -euo pipefail

XS_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
IDENTITY="${XIAOSHE_MAC_IDENTITY:-}"
NOTARY_PROFILE="${XIAOSHE_NOTARY_PROFILE:-xiaoshe-notary}"
APP="$XS_ROOT/apps/desktop-shell/dist-desktop/mac-arm64/小蛇.app"
DMG="${XIAOSHE_DMG_PATH:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --identity=*) IDENTITY="${1#*=}" ;;
    --notary-profile=*) NOTARY_PROFILE="${1#*=}" ;;
    --app=*) APP="${1#*=}" ;;
    --dmg=*) DMG="${1#*=}" ;;
    *) printf '[错误] 未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$(uname -s)" != "Darwin" ]; then
  printf '[错误] macOS 签名与公证只能在 macOS 执行。\n' >&2
  exit 2
fi

if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/^.*"\(Developer ID Application:.*\)".*$/\1/p' | sed -n '1p')"
fi
if [ -z "$IDENTITY" ]; then
  printf '[外部阻塞] 钥匙串中没有有效的 Developer ID Application 证书。\n' >&2
  exit 3
fi
security find-identity -v -p codesigning | grep -Fq -- "\"$IDENTITY\"" \
  || { printf '[错误] 指定的 Developer ID Application 身份无效。\n' >&2; exit 3; }
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" --output-format json >/dev/null \
  || { printf '[外部阻塞] 公证钥匙串 Profile 不可用：%s\n' "$NOTARY_PROFILE" >&2; exit 4; }

NODE_DIR=""
for candidate in /opt/homebrew/opt/node@24/bin /usr/local/opt/node@24/bin; do
  if [ -x "$candidate/node" ]; then NODE_DIR="$candidate"; break; fi
done
if [ -z "$NODE_DIR" ]; then
  candidate_node="$(command -v node 2>/dev/null || true)"
  if [ -n "$candidate_node" ] && "$candidate_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
    NODE_DIR="$(dirname "$candidate_node")"
  fi
fi
[ -n "$NODE_DIR" ] || { printf '[错误] 需要 Node 24。\n' >&2; exit 5; }
export PATH="$NODE_DIR:$PATH"
if [ -z "$DMG" ]; then
  DESKTOP_VERSION="$(node -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$XS_ROOT/apps/desktop-shell/package.json")"
  DMG="$XS_ROOT/apps/desktop-shell/dist-desktop/Xiaoshe-${DESKTOP_VERSION}-arm64.dmg"
fi

WORK_DIR="$(mktemp -d /tmp/xiaoshe-notary.XXXXXX)"
MOUNT_POINT="$WORK_DIR/mount"
APP_ZIP="$WORK_DIR/Xiaoshe-app.zip"
APP_RESULT="$WORK_DIR/app-notary.json"
DMG_RESULT="$WORK_DIR/dmg-notary.json"
MOUNTED=0
cleanup() {
  if [ "$MOUNTED" -eq 1 ]; then hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true; fi
  /bin/rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT
mkdir -p "$MOUNT_POINT"

printf '[1/6] 构建并以 Developer ID 签名应用…\n'
(cd "$XS_ROOT" && CSC_NAME="$IDENTITY" pnpm --filter '@xiaoshe/desktop-shell' exec electron-builder --dir --mac --arm64 --config electron-builder.yml --publish never)
codesign --verify --deep --strict --verbose=4 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -Fq 'Authority=Developer ID Application:'

printf '[2/6] 公证并装订应用本体…\n'
ditto -c -k --keepParent "$APP" "$APP_ZIP"
xcrun notarytool submit "$APP_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json >"$APP_RESULT"
/usr/bin/python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); sys.exit(0 if value.get("status")=="Accepted" else 1)' "$APP_RESULT"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP"

printf '[3/6] 从已装订应用构建 DMG…\n'
(cd "$XS_ROOT" && pnpm --filter '@xiaoshe/desktop-shell' exec electron-builder --prepackaged "$APP" --mac dmg --arm64 --config electron-builder.yml --publish never)
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
codesign --verify --verbose=4 "$DMG"
hdiutil verify "$DMG"

printf '[4/6] 公证并装订 DMG…\n'
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json >"$DMG_RESULT"
/usr/bin/python3 -c 'import json,sys; value=json.load(open(sys.argv[1])); sys.exit(0 if value.get("status")=="Accepted" else 1)' "$DMG_RESULT"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"

printf '[5/6] 挂载最终 DMG 并复核内置应用…\n'
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT_POINT" >/dev/null
MOUNTED=1
shopt -s nullglob
embedded_apps=("$MOUNT_POINT"/*.app)
[ "${#embedded_apps[@]}" -eq 1 ] || { printf '[错误] 最终 DMG 内 .app 数量不是 1。\n' >&2; exit 6; }
codesign --verify --deep --strict --verbose=4 "${embedded_apps[0]}"
xcrun stapler validate "${embedded_apps[0]}"
spctl --assess --type execute --verbose=4 "${embedded_apps[0]}"
hdiutil detach "$MOUNT_POINT" >/dev/null
MOUNTED=0

printf '[6/6] 完成：应用与 DMG 均已签名、公证、装订并通过 Gatekeeper。\n'
