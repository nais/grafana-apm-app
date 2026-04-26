#!/usr/bin/env bash
# Wrapper for `mise run` that handles sandboxed environments where parent
# config files (e.g. ../.tool-versions) may be permission-denied.
#
# Usage: ./scripts/mise-run.sh <task> [args...]
#   e.g. ./scripts/mise-run.sh all
#        ./scripts/mise-run.sh frontend:check

set -euo pipefail

# Find parent .tool-versions files that might be inaccessible
ignored_paths=""
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
parent="$(dirname "$dir")"
while [ "$parent" != "/" ]; do
  tv="$parent/.tool-versions"
  if [ -e "$tv" ] && ! [ -r "$tv" ]; then
    ignored_paths="${ignored_paths:+$ignored_paths:}$tv"
  fi
  parent="$(dirname "$parent")"
done

if [ -n "$ignored_paths" ]; then
  export MISE_IGNORED_CONFIG_PATHS="${MISE_IGNORED_CONFIG_PATHS:+$MISE_IGNORED_CONFIG_PATHS:}$ignored_paths"
fi

# Run mise with interleaved output so errors are visible, but capture it
# to only display on failure (keeping success quiet with a short summary).
output=$(mise run "$@" 2>&1) && {
  echo "✓ mise run $* passed"
} || {
  rc=$?
  echo "$output"
  exit $rc
}
