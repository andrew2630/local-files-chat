#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="$(ls -d "$SCRIPT_DIR"/*.app 2>/dev/null | head -n 1 || true)"

if [[ -z "$APP_PATH" ]]; then
  echo "No .app found next to this script."
  exit 1
fi

xattr -dr com.apple.quarantine "$APP_PATH"
echo "Removed quarantine: $APP_PATH"
