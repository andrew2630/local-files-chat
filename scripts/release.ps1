param(
  [Parameter(Mandatory = $true)]
  [string]$Version
)

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Write-Error "Usage: scripts/release.ps1 X.Y.Z"
  exit 1
}

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$packageJson = Join-Path $root "package.json"
$tauriConf = Join-Path $root "src-tauri/tauri.conf.json"
$cargoToml = Join-Path $root "src-tauri/Cargo.toml"

function Update-JsonVersion {
  param([string]$Path, [string]$Version)
  if (!(Test-Path $Path)) { return }
  $raw = Get-Content -Path $Path -Raw
  $updated = [regex]::Replace($raw, '("version"\s*:\s*")[^"]+(")', "`$1$Version`$2", 1)
  Set-Content -Path $Path -Value $updated -Encoding utf8
}

function Update-CargoVersion {
  param([string]$Path, [string]$Version)
  if (!(Test-Path $Path)) { return }
  $raw = Get-Content -Path $Path -Raw
  $pattern = '(?ms)(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")'
  $updated = [regex]::Replace($raw, $pattern, "`$1$Version`$2", 1)
  Set-Content -Path $Path -Value $updated -Encoding utf8
}

Update-JsonVersion -Path $packageJson -Version $Version
Update-JsonVersion -Path $tauriConf -Version $Version
Update-CargoVersion -Path $cargoToml -Version $Version

git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "Release v$Version"
git tag -a "v$Version" -m "Release v$Version"
git push
git push --tags

npx tauri build

$bundleDir = Join-Path $root "src-tauri/target/release/bundle"
$assets = @()
$nsis = Get-ChildItem -Path (Join-Path $bundleDir "nsis") -Filter "*.exe" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($nsis) { $assets += $nsis.FullName }
$dmg = Get-ChildItem -Path (Join-Path $bundleDir "dmg") -Filter "*.dmg" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($dmg) { $assets += $dmg.FullName }

if ($assets.Count -eq 0) {
  Write-Warning "No installer assets found."
  exit 1
}

$releaseExists = $false
& gh release view "v$Version" *> $null
if ($LASTEXITCODE -eq 0) { $releaseExists = $true }

if ($releaseExists) {
  gh release upload "v$Version" $assets --clobber
} else {
  gh release create "v$Version" $assets --title "v$Version" --notes "Release v$Version"
}

Write-Host "Assets:"
$assets | ForEach-Object { Write-Host " - $_" }
