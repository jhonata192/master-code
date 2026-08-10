# Valida a versao da release (tag vX.Y.Z) contra o package.json.
# Fonte unica de verdade: package.json. O workflow de release passa a tag
# em RELEASE_TAG (ex.: v0.1.0).
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tag = $env:RELEASE_TAG
if (-not $tag) {
  Write-Host 'RELEASE_TAG nao definida.' -ForegroundColor Red
  exit 1
}

# valida formato semver vX.Y.Z (com suporte a prerelease/build)
if ($tag -notmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$') {
  Write-Host "Tag invalida: '$tag'. Use o formato vX.Y.Z (ex.: v0.1.0)." -ForegroundColor Red
  exit 1
}

$version = ($tag -replace '^v', '')
$pkg = (Get-Content (Join-Path $root 'package.json') | ConvertFrom-Json)

if ($pkg.version -ne $version) {
  Write-Host "Versao inconsistente: package.json='$($pkg.version)' vs tag='$version'." -ForegroundColor Red
  Write-Host 'Atualize o package.json para casar com a tag antes de criar a release.' -ForegroundColor Yellow
  exit 1
}

Write-Host "VERSION=$version" -ForegroundColor Green
Write-Host "RELEASE_TAG=$tag" -ForegroundColor Green
Write-Host "IS_PRERELEASE=$([bool]($version -match '-'))" -ForegroundColor Green
