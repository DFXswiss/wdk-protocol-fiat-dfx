#!/usr/bin/env bash
# Build the patched WDK starter and install it on one booted iOS simulator.
# STARTER_COMMIT defaults to the full hash of 031e210.
# An override must be that same 40-character hash. The hash is not in the patch.
# STARTER_WORKSPACE and STARTER_SCHEME override discovery. Leave them empty to use
# the single non-Pods workspace and the single shared scheme under ios/.
set -euo pipefail

PINNED_STARTER_COMMIT="031e210e8d7ef322a9c3100f5aed3f4b7c6e34e6"
STARTER_COMMIT="${STARTER_COMMIT:-$PINNED_STARTER_COMMIT}"
STARTER_WORKSPACE="${STARTER_WORKSPACE:-}"
STARTER_SCHEME="${STARTER_SCHEME:-}"
BUNDLE_ID="io.tether.wdk.starter.reactnative"

if [[ $# -ne 1 || -z "${1}" ]]; then
  echo "usage: build.sh <simulator-udid>" >&2
  exit 2
fi
UDID="$1"
if [[ "$STARTER_COMMIT" != "$PINNED_STARTER_COMMIT" ]]; then
  echo "STARTER_COMMIT must equal the pinned commit" >&2
  exit 2
fi
DFX_TARGET="${DFX_TARGET:-sandbox-sepolia}"
if [[ "$DFX_TARGET" != "sandbox-sepolia" && "$DFX_TARGET" != "production-polygon" ]]; then
  echo "DFX_TARGET must be sandbox-sepolia or production-polygon" >&2
  exit 2
fi
pimlico_key_source="placeholder"
if [[ "$DFX_TARGET" == "production-polygon" && -z "${PIMLICO_API_KEY_FILE:-}" ]]; then
  echo "PIMLICO_API_KEY_FILE is required for DFX_TARGET=production-polygon" >&2
  exit 1
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
module_head="$(git -C "$MODULE" rev-parse HEAD)"

git clone --quiet https://github.com/tetherto/wdk-starter-react-native.git "$STARTER"
git -C "$STARTER" checkout --detach "$STARTER_COMMIT"
git -C "$STARTER" apply --index "$ROOT/starter.patch"
cp "$STARTER/.env.example" "$STARTER/.env"
printf '\nEXPO_PUBLIC_DFX_TARGET=%s\n' "$DFX_TARGET" >> "$STARTER/.env"
if [[ -n "${PIMLICO_API_KEY_FILE:-}" ]]; then
  # The key is read into a shell variable and passed in the environment, never on argv, and is never printed.
  key_status=0
  pimlico_key="$(node -e '
const fs = require("fs")
const path = process.argv[process.argv.length - 1]
let fd
try {
  fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  const st = fs.fstatSync(fd)
  if (!st.isFile() || st.uid !== process.getuid()) process.exit(1)
  const mode = st.mode & 0o777
  if (mode !== 0o600 && mode !== 0o400) process.exit(1)
  if (st.size > 4096) process.exit(2)
  const text = fs.readFileSync(fd, "utf8").trim()
  if (!/^[A-Za-z0-9_]{8,128}$/.test(text)) process.exit(2)
  process.stdout.write(text)
} catch {
  process.exit(1)
} finally {
  if (fd !== undefined) fs.closeSync(fd)
}
' -- "$PIMLICO_API_KEY_FILE")" || key_status=$?
  if [[ "$key_status" -ne 0 ]]; then
    unset pimlico_key
    if [[ "$key_status" -eq 2 ]]; then
      echo "PIMLICO_API_KEY_FILE content is not a Pimlico key" >&2
    else
      echo "PIMLICO_API_KEY_FILE must be a regular non-symlink file owned by the current user with mode 0600 or 0400" >&2
    fi
    exit 1
  fi
  pimlico_key_re='^[A-Za-z0-9_]{8,128}$'
  if [[ ! "$pimlico_key" =~ $pimlico_key_re ]]; then
    unset pimlico_key
    echo "PIMLICO_API_KEY_FILE content is not a Pimlico key" >&2
    exit 1
  fi
  if ! PIMLICO_API_KEY="$pimlico_key" node -e '
const fs = require("fs")
const key = process.env.PIMLICO_API_KEY
const path = process.argv[process.argv.length - 1]
if (typeof key !== "string" || !/^[A-Za-z0-9_]{8,128}$/.test(key)) process.exit(1)
const text = fs.readFileSync(path, "utf8")
fs.writeFileSync(path, text.split("YOUR_PIMLICO_KEY").join(key))
' -- "$STARTER/.env"; then
    unset pimlico_key
    echo "could not write the Pimlico key into the starter .env" >&2
    exit 1
  fi
  unset pimlico_key
  chmod 600 "$STARTER/.env"
  pimlico_key_source="file"
fi
if [[ "$DFX_TARGET" == "production-polygon" ]]; then
  bundler_seen=0
  paymaster_seen=0
  placeholder_left=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == EXPO_PUBLIC_EVM_POLYGON_BUNDLER_URL=* ]]; then
      bundler_seen=$((bundler_seen + 1))
      if [[ "$line" == *YOUR_PIMLICO_KEY* ]]; then
        placeholder_left=1
      fi
    elif [[ "$line" == EXPO_PUBLIC_EVM_POLYGON_PAYMASTER_URL=* ]]; then
      paymaster_seen=$((paymaster_seen + 1))
      if [[ "$line" == *YOUR_PIMLICO_KEY* ]]; then
        placeholder_left=1
      fi
    fi
  done < "$STARTER/.env"
  unset line
  if [[ "$placeholder_left" -ne 0 || "$bundler_seen" -eq 0 || "$paymaster_seen" -eq 0 ]]; then
    echo "Polygon bundler or paymaster line is missing or still contains YOUR_PIMLICO_KEY" >&2
    exit 1
  fi
fi
provider=""
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == EXPO_PUBLIC_EVM_ETHEREUM_PROVIDER=* ]]; then
    if [[ -n "$provider" ]]; then
      echo "multiple Ethereum providers in .env" >&2
      exit 1
    fi
    provider="${line#*=}"
  fi
done < "$STARTER/.env"
if [[ -z "$provider" ]]; then
  echo "Ethereum provider missing in .env" >&2
  exit 1
fi
if ! response="$(curl --silent --show-error --fail --max-time 20 -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$provider" 2>/dev/null)"; then
  echo "Ethereum provider chain check failed" >&2
  exit 1
fi
chain="$(printf '%s' "$response" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const v=JSON.parse(s).result;process.stdout.write(typeof v==="string" && /^0x[0-9a-f]+$/.test(v)?v:"invalid")}catch{process.stdout.write("invalid")}})')"
if [[ "$chain" != "0xaa36a7" ]]; then
  echo "Ethereum provider chain is $chain; expected 0xaa36a7" >&2
  exit 1
fi
echo "Ethereum provider chain: $chain"
if [[ "$DFX_TARGET" == "production-polygon" ]]; then
  polygon_provider=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == EXPO_PUBLIC_EVM_POLYGON_PROVIDER=* ]]; then
      if [[ -n "$polygon_provider" ]]; then
        echo "multiple Polygon providers in .env" >&2
        exit 1
      fi
      polygon_provider="${line#*=}"
    fi
  done < "$STARTER/.env"
  if [[ -z "$polygon_provider" ]]; then
    echo "Polygon provider missing in .env" >&2
    exit 1
  fi
  if ! response="$(curl --silent --show-error --fail --max-time 20 -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$polygon_provider" 2>/dev/null)"; then
    echo "Polygon provider chain check failed" >&2
    exit 1
  fi
  chain="$(printf '%s' "$response" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const v=JSON.parse(s).result;process.stdout.write(typeof v==="string" && /^0x[0-9a-f]+$/.test(v)?v:"invalid")}catch{process.stdout.write("invalid")}})')"
  if [[ "$chain" != "0x89" ]]; then
    echo "Polygon provider chain is $chain; expected 0x89" >&2
    exit 1
  fi
  echo "Polygon provider chain: $chain"
fi
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

# expo prebuild does not change HEAD. This still checks the checkout commit.
starter_head="$(git -C "$STARTER" rev-parse HEAD)"
if [[ "$starter_head" != "$STARTER_COMMIT" ]]; then
  echo "checked out $starter_head, expected $STARTER_COMMIT" >&2
  exit 1
fi
patch_sha="$(shasum -a 256 "$ROOT/starter.patch" | awk '{print $1}')"
bundle_sha="$(shasum -a 256 "$bundle" | awk '{print $1}')"
mkdir -p "$ROOT/out"
rm -f "$ROOT/out/build.json"
module_status="$(git -C "$MODULE" status --porcelain)"
if [[ -n "$module_status" ]]; then
  echo "the module tree changed during the build" >&2
  exit 1
fi
if [[ "$(git -C "$MODULE" rev-parse HEAD)" != "$module_head" ]]; then
  echo "the module HEAD changed during the build" >&2
  exit 1
fi
cat > "$ROOT/out/build.json" <<EOF
{
  "moduleHead": "${module_head}",
  "moduleDirty": false,
  "starterCommit": "${starter_head}",
  "target": "${DFX_TARGET}",
  "pimlicoKey": "${pimlico_key_source}",
  "patchSha256": "${patch_sha}",
  "mainJsbundleSha256": "${bundle_sha}"
}
EOF
