#!/usr/bin/env bash
# Assembles dist/chrome and dist/firefox from the shared src/ tree.
# No build tooling required - this is a plain file copy plus swapping in
# each browser's manifest, because MV3 still differs slightly between
# Chrome (service_worker) and Firefox (background.scripts array).
# Only needs POSIX cp/mkdir/rm, so it runs on macOS, Linux, and Git Bash/WSL
# on Windows without installing anything extra.
set -euo pipefail
cd "$(dirname "$0")"

SRC="src"
OUT_CHROME="dist/chrome"
OUT_FIREFOX="dist/firefox"

rm -rf "$OUT_CHROME" "$OUT_FIREFOX"
mkdir -p "$OUT_CHROME" "$OUT_FIREFOX"

cp -R "$SRC"/. "$OUT_CHROME"/
cp -R "$SRC"/. "$OUT_FIREFOX"/

rm -f "$OUT_CHROME/manifest.chrome.json" "$OUT_CHROME/manifest.firefox.json"
rm -f "$OUT_FIREFOX/manifest.chrome.json" "$OUT_FIREFOX/manifest.firefox.json"

cp "$SRC/manifest.chrome.json" "$OUT_CHROME/manifest.json"
cp "$SRC/manifest.firefox.json" "$OUT_FIREFOX/manifest.json"

echo "Built:"
echo "  $OUT_CHROME  (chrome://extensions -> Load unpacked)"
echo "  $OUT_FIREFOX (about:debugging -> Load Temporary Add-on -> manifest.json)"
