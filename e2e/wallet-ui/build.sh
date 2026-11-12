#!/usr/bin/env bash
# Build the patched WDK starter and install it on one booted iOS simulator.
# STARTER_COMMIT defaults to the full hash of 031e210.
# An override must be that same 40-character hash. The hash is not in the patch.
# STARTER_WORKSPACE and STARTER_SCHEME override discovery. Leave them empty to use
# the single non-Pods workspace and the single shared scheme under ios/.
set -euo pipefail

STARTER_COMMIT="${STARTER_COMMIT:-031e210e8d7ef322a9c3100f5aed3f4b7c6e34e6}"
STARTER_WORKSPACE="${STARTER_WORKSPACE:-}"
STARTER_SCHEME="${STARTER_SCHEME:-}"
BUNDLE_ID="io.tether.wdk.starter.reactnative"

if [[ $# -ne 1 || -z "${1}" ]]; then
  echo "usage: build.sh <simulator-udid>" >&2
  exit 2
fi
UDID="$1"
if [[ ! "$STARTER_COMMIT" =~ ^031e210[0-9a-f]{33}$ ]]; then
  echo "STARTER_COMMIT must be the full 40-character hash of 031e210" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODULE="$(cd "$ROOT/../.." && pwd)"
STARTER="$ROOT/.starter"

if [[ -e "$STARTER" ]]; then
  echo "refusing to overwrite $STARTER" >&2
  exit 1
fi
if [[ -n "$(git -C "$MODULE" status --porcelain)" ]]; then
  echo "the module working tree is not clean" >&2
  exit 1
fi

git clone --quiet https://github.com/tetherto/wdk-starter-react-native.git "$STARTER"
git -C "$STARTER" checkout --detach "$STARTER_COMMIT"
git -C "$STARTER" apply --index "$ROOT/starter.patch"
cp "$STARTER/.env.example" "$STARTER/.env"
printf 'install-links=true\n' > "$STARTER/.npmrc"
(cd "$STARTER" && npm install)

# ios/ is not in the starter checkout. Expo prebuild creates it and does not move HEAD.
export LANG=en_US.UTF-8
(cd "$STARTER" && npx expo prebuild --clean --platform ios)

if [[ -z "$STARTER_WORKSPACE" ]]; then
  found=""
  count=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    found="$line"
    count=$((count + 1))
  done < <(find "$STARTER/ios" -maxdepth 3 -type d -name '*.xcworkspace' ! -name 'project.xcworkspace' ! -path '*/Pods/*')
  if [[ "$count" -ne 1 ]]; then
    echo "STARTER_WORKSPACE is unset and ios/ does not contain exactly one workspace" >&2
    exit 1
  fi
  STARTER_WORKSPACE="$found"
fi
if [[ -z "$STARTER_SCHEME" ]]; then
  found=""
  count=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    found="$line"
    count=$((count + 1))
  done < <(find "$STARTER/ios" -path '*/xcshareddata/xcschemes/*.xcscheme' ! -path '*/Pods/*')
  if [[ "$count" -ne 1 ]]; then
    echo "STARTER_SCHEME is unset and ios/ does not contain exactly one shared scheme" >&2
    exit 1
  fi
  STARTER_SCHEME="$(basename "$found" .xcscheme)"
fi

derived="$STARTER/.derived"
xcodebuild \
  -workspace "$STARTER_WORKSPACE" \
  -scheme "$STARTER_SCHEME" \
  -configuration Release \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$derived" \
  IPHONEOS_DEPLOYMENT_TARGET=17.0 \
  build

app=""
count=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  app="$line"
  count=$((count + 1))
done < <(find "$derived/Build/Products" -type d -name '*.app' -path '*iphonesimulator*')
if [[ "$count" -ne 1 ]]; then
  echo "expected one simulator app product, found $count" >&2
  exit 1
fi
xcrun simctl terminate "$UDID" "$BUNDLE_ID" || true
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" || true
xcrun simctl install "$UDID" "$app"
container="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" app)"
bundle="$container/main.jsbundle"
if [[ ! -f "$bundle" ]]; then
  echo "installed app has no main.jsbundle" >&2
  exit 1
fi

module_head="$(git -C "$MODULE" rev-parse HEAD)"
# expo prebuild does not change HEAD. This still checks the checkout commit.
starter_head="$(git -C "$STARTER" rev-parse HEAD)"
if [[ "$starter_head" != "$STARTER_COMMIT" ]]; then
  echo "checked out $starter_head, expected $STARTER_COMMIT" >&2
  exit 1
fi
patch_sha="$(shasum -a 256 "$ROOT/starter.patch" | awk '{print $1}')"
bundle_sha="$(shasum -a 256 "$bundle" | awk '{print $1}')"
mkdir -p "$ROOT/out"
cat > "$ROOT/out/build.json" <<EOF
{
  "moduleHead": "${module_head}",
  "moduleDirty": false,
  "starterCommit": "${starter_head}",
  "patchSha256": "${patch_sha}",
  "mainJsbundleSha256": "${bundle_sha}"
}
EOF
