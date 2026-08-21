#!/usr/bin/env bash
# Deploy Hermes Web — BUILD ONLY; no process management.
#
# Serving is done by the existing, nix-managed hermes dashboard, which has
# HERMES_WEB_DIST set ONCE (in the nix service config) to the directory this
# script deploys into (default ~/.hermes/desktop-web). Static files are picked
# up from disk on the next request — no restart, no process handling here.
#
# This script:
#   1. reads apps/web-desktop/.env (HERMES_WEB_URL, ...)
#   2. nix build — web-only build, upstream pinned by flake.lock
#      (update upstream separately with: nix flake update hermes)
#   3. copies result/ -> $HERMES_WEB_DIST_DIR (default ~/.hermes/desktop-web)
#   4. health-checks the URL from .env and prints it
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_DIR/apps/web-desktop/.env"
WEB_DIST_DIR="${HERMES_WEB_DIST_DIR:-$HOME/.hermes/desktop-web}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "⚠ No $ENV_FILE — copy .env.example to .env first."
  exit 1
fi

: "${HERMES_WEB_URL:?set HERMES_WEB_URL in $ENV_FILE}"

echo "==> [1/3] nix build (web-only; upstream pinned by flake.lock)"
nix --extra-experimental-features 'nix-command flakes' build "$REPO_DIR" -o "$REPO_DIR/result"

echo "==> [2/3] copy dist -> $WEB_DIST_DIR"
mkdir -p "$WEB_DIST_DIR"
cp -r "$REPO_DIR/result/." "$WEB_DIST_DIR/"

echo "==> [3/3] health-check: $HERMES_WEB_URL"
if curl -fsS --max-time 10 -o /dev/null "$HERMES_WEB_URL/"; then
  echo "✅ OK — Hermes Web: $HERMES_WEB_URL"
else
  echo "⚠ Build done, but $HERMES_WEB_URL is not answering."
  echo "  Check that the nix-managed dashboard has HERMES_WEB_DIST=$WEB_DIST_DIR"
  exit 1
fi
