# Build do instalador .exe (Inno Setup).
# Garante o executavel atualizado e compila o master-code-setup.exe.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 1. garante que o master-code.exe esteja atualizado
& (Join-Path $PSScriptRoot 'build-exe.ps1')
if ($LASTEXITCODE -ne 0) { exit 1 }

# 2. localiza o ISCC.exe do Inno Setup
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'),
  'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
  'C:\Program Files\Inno Setup 6\ISCC.exe',
  'C:\Program Files\Inno Setup 7\ISCC.exe'
)
$iscc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $iscc) {
  Write-Host 'ISCC.exe do Inno Setup nao encontrado.' -ForegroundColor Red
  Write-Host 'Instale o Inno Setup: https://jrsoftware.org/isdl.php' -ForegroundColor Yellow
  exit 1
}

# 3. le a versao do package.json (fonte unica de verdade) e compila o instalador
$version = (Get-Content (Join-Path $root 'package.json') | ConvertFrom-Json).version
& $iscc (Join-Path $root 'installer\master-code.iss') "/DMyAppVersion=$version"
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ''
Write-Host "Instalador gerado: installer\master-code-setup.exe" -ForegroundColor Green
Write-Host 'Compartilhe esse arquivo com seus amigos - tudo ja vem embutido.' -ForegroundColor Yellow
