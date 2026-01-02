#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:-}"
if [[ -z "$APP_PATH" ]]; then
  echo "Usage: scripts/macos/adhoc-sign.sh /path/to/App.app"
  exit 1
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "Error: app bundle not found at $APP_PATH"
  exit 1
fi

echo "Ad-hoc signing: $APP_PATH"
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
