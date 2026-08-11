# Build script: gera master-code.exe a partir do codigo TypeScript
# usando Node SEA (Single Executable Application) + esbuild + postject.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '==> 1/4 Compilando TypeScript...'
npx tsc
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '==> 2/4 Empacotando com esbuild...'
New-Item -ItemType Directory -Force -Path 'dist-bundle' | Out-Null
node scripts/bundle.mjs
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '==> 3/4 Gerando blob SEA...'
node --experimental-sea-config sea-config.json
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host '==> 4/4 Montando executavel...'
$nodeExe = (Get-Command node).Source
New-Item -ItemType Directory -Force -Path 'dist' | Out-Null

# encerra instancias antigas do executavel para nao ficar bloqueado
Get-Process -Name 'master-code' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300
if (Test-Path -LiteralPath 'dist\master-code.exe') {
  Remove-Item -LiteralPath 'dist\master-code.exe' -Force
}

Copy-Item $nodeExe 'dist/master-code.exe' -Force

npx postject dist/master-code.exe NODE_SEA_BLOB dist-bundle/sea-prep.blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ''
Write-Host "OK: dist\master-code.exe" -ForegroundColor Green
Write-Host 'Rode npm run install:exe para instalar na PATH do sistema.' -ForegroundColor Yellow
