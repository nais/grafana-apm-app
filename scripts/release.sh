#!/usr/bin/env bash
set -euo pipefail

# release.sh — bump version, update changelog, commit, and tag.
#
# Usage:
#   mise run release              # patch bump (0.4.2 → 0.4.3)
#   mise run release -- minor     # minor bump (0.4.2 → 0.5.0)
#   mise run release -- major     # major bump (0.4.2 → 1.0.0)
#   mise run release -- 1.2.3     # explicit version

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

die()  { echo -e "${RED}ERROR: $*${RESET}" >&2; exit 1; }
info() { echo -e "${GREEN}▸${RESET} $*"; }
warn() { echo -e "${YELLOW}▸${RESET} $*"; }

# --- Resolve repo root ---
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# --- Guard: clean working tree ---
if ! git diff --quiet || ! git diff --cached --quiet; then
  die "Working tree is dirty. Commit or stash changes first."
fi

# --- Read current version ---
CURRENT=$(node -p "require('./package.json').version")
info "Current version: ${BOLD}${CURRENT}${RESET}"

# --- Compute next version ---
bump="${1:-patch}"
IFS='.' read -r major minor patch <<< "$CURRENT"

case "$bump" in
  patch) next="${major}.${minor}.$((patch + 1))" ;;
  minor) next="${major}.$((minor + 1)).0" ;;
  major) next="$((major + 1)).0.0" ;;
  [0-9]*.[0-9]*.[0-9]*) next="$bump" ;;
  *) die "Invalid argument: '$bump'. Use patch, minor, major, or X.Y.Z" ;;
esac

info "Next version:    ${BOLD}${next}${RESET}"

# --- Check CHANGELOG has content for new version ---
TODAY=$(date +%Y-%m-%d)

if grep -q "^## ${next}" CHANGELOG.md; then
  info "CHANGELOG.md already has a ${next} section — will stamp today's date."
  # Ensure the date is current
  sed -i '' "s/^## ${next}.*/## ${next} (${TODAY})/" CHANGELOG.md
elif grep -q "^## Unreleased" CHANGELOG.md; then
  info "Stamping Unreleased section as ${next} (${TODAY})."
  sed -i '' "s/^## Unreleased.*/## ${next} (${TODAY})/" CHANGELOG.md
else
  die "CHANGELOG.md has no '## Unreleased' or '## ${next}' section.\n  Add release notes before running this script."
fi

# --- Bump package.json ---
contents=$(cat package.json)
echo "$contents" | sed "s/\"version\": \"${CURRENT}\"/\"version\": \"${next}\"/" > package.json

# Verify it took effect
NEW_VER=$(node -p "require('./package.json').version")
[ "$NEW_VER" = "$next" ] || die "package.json version bump failed (got ${NEW_VER})"
info "Bumped package.json → ${next}"

# --- Run full check + test + build ---
info "Running ${BOLD}mise run all${RESET} …"
"${ROOT}/scripts/mise-run.sh" all
info "All checks passed ✓"

# --- Commit and tag ---
git add CHANGELOG.md package.json pnpm-lock.yaml 2>/dev/null || true
git add CHANGELOG.md package.json

# Skip pre-commit hooks (we just ran the full pipeline)
git commit --no-verify -m "release: v${next}"
git tag -a "v${next}" -m "v${next}"

info "Created commit and tag ${BOLD}v${next}${RESET}"
echo ""
warn "Push when ready:"
echo -e "  ${BOLD}git push origin main --tags${RESET}"
