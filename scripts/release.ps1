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

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Replace-VersionMatch {
  param(
    [string]$Raw,
    [string]$Pattern,
    [string]$Version,
    [string]$Path
  )
  $evaluator = [System.Text.RegularExpressions.MatchEvaluator]{
    param($match)
    $match.Groups[1].Value + $Version + $match.Groups[2].Value
  }
  $regex = [regex]::new($Pattern)
  if (!$regex.IsMatch($Raw)) {
    Write-Error "Failed to update version in $Path"
    exit 1
  }
  $updated = $regex.Replace($Raw, $evaluator, 1)
  return $updated
}

function Update-JsonVersion {
  param([string]$Path, [string]$Version)
  if (!(Test-Path $Path)) { return }
  $raw = Get-Content -Path $Path -Raw
  $updated = Replace-VersionMatch -Raw $raw -Pattern '("version"\s*:\s*")[^"]+(")' -Version $Version -Path $Path
  Write-Utf8NoBom -Path $Path -Content $updated
}

function Update-CargoVersion {
  param([string]$Path, [string]$Version)
  if (!(Test-Path $Path)) { return }
  $raw = Get-Content -Path $Path -Raw
  $pattern = '(?ms)(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")'
  $updated = Replace-VersionMatch -Raw $raw -Pattern $pattern -Version $Version -Path $Path
  Write-Utf8NoBom -Path $Path -Content $updated
}

Update-JsonVersion -Path $packageJson -Version $Version
Update-JsonVersion -Path $tauriConf -Version $Version
Update-CargoVersion -Path $cargoToml -Version $Version

git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "Release v$Version"

$tagExists = git tag -l "v$Version"
if ($tagExists) {
  Write-Warning "Tag v$Version already exists; skipping tag creation."
} else {
  git tag -a "v$Version" -m "Release v$Version"
}
git push
if (!$tagExists) {
  git push --tags
}

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

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (!$gh) {
  Write-Warning "GitHub CLI not found; skipping release upload."
} else {
  $releaseExists = $false
  & gh release view "v$Version" *> $null
  if ($LASTEXITCODE -eq 0) { $releaseExists = $true }

  if ($releaseExists) {
    gh release upload "v$Version" $assets --clobber
  } else {
    gh release create "v$Version" $assets --title "v$Version" --notes "Release v$Version"
  }
}

Write-Host "Assets:"
$assets | ForEach-Object { Write-Host " - $_" }
