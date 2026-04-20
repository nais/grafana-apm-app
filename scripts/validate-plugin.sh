#!/usr/bin/env bash
# Validate plugin.json has all required fields for Grafana plugin submission.
# Run locally via: pnpm run validate
set -euo pipefail

PLUGIN_JSON="src/plugin.json"

if [ ! -f "$PLUGIN_JSON" ]; then
  echo "❌ $PLUGIN_JSON not found"
  exit 1
fi

errors=()

check_field() {
  local query="$1" label="$2"
  val=$(jq -r "$query // empty" "$PLUGIN_JSON")
  if [ -z "$val" ]; then
    errors+=("missing $label")
  fi
}

check_field '.id'                         'id'
check_field '.type'                       'type'
check_field '.name'                       'name'
check_field '.info.description'           'info.description'
check_field '.info.author.name'           'info.author.name'
check_field '.info.logos.small'           'info.logos.small'
check_field '.info.logos.large'           'info.logos.large'
check_field '.info.version'              'info.version'
check_field '.dependencies.grafanaDependency' 'dependencies.grafanaDependency'

# Verify logo files exist
for logo in $(jq -r '.info.logos.small, .info.logos.large' "$PLUGIN_JSON"); do
  if [ ! -f "src/$logo" ]; then
    errors+=("logo file not found: src/$logo")
  fi
done

# Verify screenshot files exist
for screenshot in $(jq -r '.info.screenshots[]?.path // empty' "$PLUGIN_JSON"); do
  if [ ! -f "src/$screenshot" ]; then
    errors+=("screenshot not found: src/$screenshot")
  fi
done

if [ ${#errors[@]} -gt 0 ]; then
  echo "❌ plugin.json validation failed:"
  for e in "${errors[@]}"; do
    echo "  • $e"
  done
  exit 1
fi

echo "✅ plugin.json valid"
