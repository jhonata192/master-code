# Instalador do master-code.
# Copia o executavel para %ProgramFiles%\master-code e adiciona na PATH do sistema.
# Executa com elevacao (UAC) automaticamente.
param(
  [string]$ExePath = '',
  [string]$InstallDir = ''
)

$ErrorActionPreference = 'Stop'

# --- auto-elevacao (UAC) ---
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  $scriptArgs = @('-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($ExePath) { $scriptArgs += '-ExePath'; $scriptArgs += $ExePath }
  if ($InstallDir) { $scriptArgs += '-InstallDir'; $scriptArgs += $InstallDir }
  Write-Host 'Solicitando permissao de administrador (UAC)...'
  Start-Process powershell -Verb RunAs -ArgumentList $scriptArgs -Wait
  exit $LASTEXITCODE
}

$root = Split-Path -Parent $PSScriptRoot

if (-not $InstallDir) {
  $InstallDir = Join-Path $env:ProgramFiles 'master-code'
}
if (-not $ExePath) {
  $ExePath = Join-Path $root 'dist\master-code.exe'
}

# --- compila se o executavel nao existir ---
if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Host 'Executavel nao encontrado. Compilando antes de instalar...'
  & (Join-Path $PSScriptRoot 'build-exe.ps1')
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

# --- copia o executavel ---
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -LiteralPath $ExePath -Destination (Join-Path $InstallDir 'master-code.exe') -Force

# --- PATH do sistema ---
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$normalized = $InstallDir.TrimEnd('\')
$inPath = @($machinePath -split ';' | Where-Object {
  $_ -and $_.TrimEnd('\') -ieq $normalized
})
if ($inPath.Count -eq 0) {
  $newPath = ($machinePath.TrimEnd(';') + ';' + $InstallDir)
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'Machine')
  Write-Host "PATH do sistema atualizada: $InstallDir" -ForegroundColor Green
} else {
  Write-Host 'PATH do sistema ja contem o diretorio.' -ForegroundColor Yellow
}

# --- uninstaller na pasta de instalacao ---
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination (Join-Path $InstallDir 'uninstall.ps1') -Force
$uninstallCmd = "@echo off`r`npowershell -ExecutionPolicy Bypass -File `"%~dp0uninstall.ps1`"`r`n"
Set-Content -Path (Join-Path $InstallDir 'uninstall.cmd') -Value $uninstallCmd -Encoding ascii

Write-Host ''
Write-Host "Instalado: $InstallDir\master-code.exe" -ForegroundColor Green
Write-Host 'Agora abra um terminal novo e chame "master-code" em qualquer pasta.'
Write-Host 'Para remover: execute uninstall.cmd na pasta de instalacao.'
