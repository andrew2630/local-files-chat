#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: scripts/release.sh X.Y.Z"
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python - <<PY
import re
from pathlib import Path

version = "$VERSION"

def update_json_version(path: Path):
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    text = re.sub(r'("version"\\s*:\\s*")[^"]+(")', r'\\1' + version + r'\\2', text, count=1)
    path.write_text(text, encoding="utf-8")

def update_cargo_version(path: Path):
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    pattern = r'(?ms)(^\\[package\\][\\s\\S]*?^version\\s*=\\s*")[^"]+(")'
    text = re.sub(pattern, r'\\1' + version + r'\\2', text, count=1)
    path.write_text(text, encoding="utf-8")

root = Path(r"$ROOT")
update_json_version(root / "package.json")
update_json_version(root / "src-tauri" / "tauri.conf.json")
update_cargo_version(root / "src-tauri" / "Cargo.toml")
PY

git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "Release v$VERSION"
git tag -a "v$VERSION" -m "Release v$VERSION"
git push
git push --tags

npx tauri build

if [[ "$(uname -s)" == "Darwin" ]]; then
  APP_PATH="$(find "$ROOT/src-tauri/target/release/bundle" -maxdepth 3 -name "*.app" -print0 | xargs -0 ls -td 2>/dev/null | head -n 1 || true)"
  if [[ -z "$APP_PATH" ]]; then
    echo "No .app bundle found to sign."
    exit 1
  fi
  "$ROOT/scripts/macos/adhoc-sign.sh" "$APP_PATH"
  SKIP_ADHOC_SIGN=1 "$ROOT/scripts/macos/make-portable-zip.sh" "$APP_PATH"
fi

BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"
assets=()

if ls "$BUNDLE_DIR/nsis"/*.exe >/dev/null 2>&1; then
  assets+=("$(ls -t "$BUNDLE_DIR/nsis"/*.exe | head -n 1)")
fi
if ls "$BUNDLE_DIR/dmg"/*.dmg >/dev/null 2>&1; then
  assets+=("$(ls -t "$BUNDLE_DIR/dmg"/*.dmg | head -n 1)")
fi
if ls "$BUNDLE_DIR/portable"/*.zip >/dev/null 2>&1; then
  assets+=("$(ls -t "$BUNDLE_DIR/portable"/*.zip | head -n 1)")
fi

if [[ ${#assets[@]} -eq 0 ]]; then
  echo "No installer assets found."
  exit 1
fi

if gh release view "v$VERSION" >/dev/null 2>&1; then
  gh release upload "v$VERSION" "${assets[@]}" --clobber
else
  gh release create "v$VERSION" "${assets[@]}" --title "v$VERSION" --notes "Release v$VERSION"
fi

echo "Assets:"
for asset in "${assets[@]}"; do
  echo " - $asset"
done
