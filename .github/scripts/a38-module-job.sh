#!/usr/bin/env bash
# One local module job.
# Neither the base commit nor the head has package.json: record that and
# exit 0. Dropping a package the base still has fails. Node 22 runs the
# install only after the package is present.
set -euo pipefail

job="${1:-}"
case "$job" in
  lint) set -- npm run lint ;;
  types) set -- npm run build:types ;;
  test) set -- npm run test:coverage ;;
  audit) set -- npm audit --audit-level=critical ;;
  *)
    echo "unknown module job: ${job}" >&2
    exit 1
    ;;
esac

base="${A38_BASE_SHA:-}"
if [ -z "$base" ]; then
  echo "A38_BASE_SHA is missing." >&2
  exit 1
fi

base_has=0
if git cat-file -e "${base}:package.json" 2>/dev/null; then
  base_has=1
fi
head_has=0
if [ -f package.json ]; then
  head_has=1
fi

if [ "$base_has" -eq 0 ] && [ "$head_has" -eq 0 ]; then
  echo "No package.json on the base or the head. The module suite starts when the package lands." >&2
  exit 0
fi

if [ "$head_has" -eq 0 ]; then
  echo "package.json was removed." >&2
  exit 1
fi

if [ ! -f package-lock.json ]; then
  echo "package-lock.json is required next to package.json." >&2
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" != "22" ]; then
  echo "Node major must be 22; got ${major}." >&2
  exit 1
fi

npm ci
"$@"
