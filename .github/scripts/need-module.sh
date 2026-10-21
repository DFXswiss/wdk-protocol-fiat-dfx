#!/usr/bin/env bash
# Print GitHub Actions outputs: module=true when this head has the package.
# Exit 1 when the head drops a package.json that the base still has.
# Exit 0 with module=false when neither side has a package yet.
set -euo pipefail

base_ref="${GITHUB_BASE_REF:-}"
base_has=0
if [ -n "$base_ref" ]; then
  git fetch --no-tags origin "$base_ref"
  if git cat-file -e "origin/${base_ref}:package.json" 2>/dev/null; then
    base_has=1
  fi
fi

head_has=0
if [ -f package.json ]; then
  head_has=1
fi

if [ "$base_has" -eq 0 ] && [ "$head_has" -eq 0 ]; then
  echo "No package.json on the base or the head. The module suite starts when the package lands." >&2
  echo "module=false"
  exit 0
fi

if [ "$head_has" -eq 0 ]; then
  echo "::error::package.json was removed." >&2
  exit 1
fi

if [ ! -f package-lock.json ]; then
  echo "::error::package-lock.json is required next to package.json." >&2
  exit 1
fi

echo "module=true"
