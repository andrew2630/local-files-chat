#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"
APP_PATH="${1:-}"

if [[ -z "$APP_PATH" ]]; then
  if [[ ! -d "$BUNDLE_DIR" ]]; then
    echo "Error: bundle directory not found at $BUNDLE_DIR"
    exit 1
  fi
  APP_PATH="$(find "$BUNDLE_DIR" -maxdepth 3 -name "*.app" -print0 | xargs -0 ls -td 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "Error: .app bundle not found. Pass the path as an argument."
  exit 1
fi

if [[ "${SKIP_ADHOC_SIGN:-}" != "1" ]]; then
  "$SCRIPT_DIR/adhoc-sign.sh" "$APP_PATH"
fi

APP_NAME="$(basename "$APP_PATH")"
APP_BASE="${APP_NAME%.app}"
APP_SLUG="$(printf '%s' "$APP_BASE" | tr -cd '[:alnum:]')"
if [[ -z "$APP_SLUG" ]]; then
  APP_SLUG="app"
fi

OUT_DIR="$BUNDLE_DIR/portable"
ZIP_NAME="${APP_SLUG}-macos-portable.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lcf-portable.XXXXXX")"
cleanup() { rm -rf "$STAGING_DIR"; }
trap cleanup EXIT

ditto "$APP_PATH" "$STAGING_DIR/$APP_NAME"
cp "$SCRIPT_DIR/README-macOS-portable.txt" "$STAGING_DIR/README-macOS-portable.txt"
cp "$SCRIPT_DIR/RemoveQuarantine.command" "$STAGING_DIR/RemoveQuarantine.command"
chmod +x "$STAGING_DIR/RemoveQuarantine.command"

mkdir -p "$OUT_DIR"
rm -f "$ZIP_PATH"
ditto -c -k --sequesterRsrc "$STAGING_DIR" "$ZIP_PATH"

echo "Portable zip: $ZIP_PATH"
