# Desinstalador do master-code.
# Remove a pasta da PATH do sistema e apaga os arquivos.
# Executa com elevacao (UAC) automaticamente.
$ErrorActionPreference = 'Stop'

# diretorio alvo: a propria pasta se copiado (uninstall.cmd) ou a pasta padrao de instalacao
$dir = $PSScriptRoot
if ((Split-Path $dir -Leaf) -ieq 'scripts') {
  $dir = Join-Path $env:ProgramFiles 'master-code'
}

# --- auto-elevacao (UAC) ---
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $scriptArgs = @('-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  Write-Host 'Solicitando permissao de administrador (UAC)...'
  Start-Process powershell -Verb RunAs -ArgumentList $scriptArgs -Wait
  exit $LASTEXITCODE
}

# --- remove da PATH do sistema ---
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$normalized = $dir.TrimEnd('\')
$parts = @($machinePath -split ';' | Where-Object {
  $_ -and $_.TrimEnd('\') -ine $normalized
})
$newPath = ($parts -join ';')
[Environment]::SetEnvironmentVariable('Path', $newPath, 'Machine')

# --- apaga os arquivos (com atraso, pois esta em uso) ---
if (Test-Path -LiteralPath $dir) {
  Start-Process cmd -ArgumentList '/c', "timeout /t 1 >nul & rd /s /q `"$dir`"" -WindowStyle Hidden
}

Write-Host 'master-code desinstalado. Feche e reabra o terminal.' -ForegroundColor Green
