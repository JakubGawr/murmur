#!/usr/bin/env bash
# Capture the Murmur README screenshots (real Angular UI + mocked Tauri IPC).
#
#   1. start the Angular dev server:   npm start        (serves :1420)
#   2. run this:                       bash scripts/screenshots/run.sh [shot...]
#
# Playwright resolution, and why it is in this order. This script used to scan
# ONLY the npx cache, on the premise that playwright "is not a package.json
# dependency". That premise expired: `@playwright/test` is a devDependency now,
# so `node_modules/playwright` exists and is the version whose browser builds
# `npx playwright install` actually provisions. The npx cache, meanwhile, keeps
# whatever an unrelated `npx playwright@…` call left behind — here a
# `1.61.0-alpha-…` wanting a Chromium build nothing on the machine has, which the
# old `case "$v" in 1.61.*)` test happily accepted as "a stable 1.61.x" and then
# broke out of the loop on. The result was a hard launch failure and a misleading
# "run npx playwright install" banner for a browser that was already installed.
#
# So: the dependency wins, the npx cache is the fallback for a checkout with no
# node_modules, and the fallback now actually excludes prereleases.
set -euo pipefail
cd "$(dirname "$0")/../.."

NP=""
if [ -e "node_modules/playwright/package.json" ]; then
  NP="$(pwd)/node_modules"
else
  for d in "$HOME"/.npm/_npx/*/node_modules; do
    [ -e "$d/playwright/package.json" ] || continue
    v=$(node -e "console.log(require('$d/playwright/package.json').version)" 2>/dev/null || true)
    # A prerelease carries a '-'; `1.61.*` alone matches `1.61.0-alpha-…` too.
    case "$v" in *-*) ;; 1.61.*) NP="$d"; break;; esac
    [ -z "$NP" ] && NP="$d"
  done
fi
if [ -z "$NP" ]; then
  echo "No playwright found. Run once:  npm install  (or: npx playwright@1.61.1 --version)" >&2
  exit 1
fi

v=$(node -e "console.log(require('$NP/playwright/package.json').version)" 2>/dev/null || echo "?")
echo "[screenshots] using playwright $v at: $NP"
PLAYWRIGHT_PATH="$NP/playwright" node scripts/screenshots/capture.mjs "$@"
