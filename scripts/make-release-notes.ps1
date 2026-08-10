# Gera release notes a partir dos commits entre a ultima tag e HEAD
# (Conventional Commits) e atualiza o CHANGELOG.md.
# Variaveis: RELEASE_TAG (ex.: v0.1.0), GITHUB_REPOSITORY (owner/repo).
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tag = $env:RELEASE_TAG
if (-not $tag) {
  Write-Host 'RELEASE_TAG nao definida.' -ForegroundColor Red
  exit 1
}
$repo = $env:GITHUB_REPOSITORY
if (-not $repo) { $repo = 'jhonata192/master-code' }

$version = $tag -replace '^v', ''

# intervalo de commits desde a ultima tag (se houver)
$previous = $null
try {
  $prevOut = git describe --tags --abbrev=0 "$tag^" 2>$null
  if ($LASTEXITCODE -eq 0 -and $prevOut) { $previous = $prevOut.Trim() }
} catch {
  $previous = $null
}
if (-not $previous) {
  Write-Host 'Nenhuma tag anterior encontrada; usando todos os commits.' -ForegroundColor Yellow
}

$log = $null
if ($previous) {
  $log = git log "$previous..$tag" --pretty=format:"%s" --no-merges
} else {
  $log = git log "$tag" --pretty=format:"%s" --no-merges
}

$commits = @()
if ($log) {
  $commits = $log -split "`n" | Where-Object { $_.Trim() -ne '' }
}

# agrupa por tipo conventional commit
$groups = @{
  feat = [System.Collections.ArrayList]@()
  fix  = [System.Collections.ArrayList]@()
  docs = [System.Collections.ArrayList]@()
  perf = [System.Collections.ArrayList]@()
  refactor = [System.Collections.ArrayList]@()
  test = [System.Collections.ArrayList]@()
  build = [System.Collections.ArrayList]@()
  ci = [System.Collections.ArrayList]@()
  chore = [System.Collections.ArrayList]@()
}
$order = @('feat', 'fix', 'docs', 'perf', 'refactor', 'test', 'build', 'ci', 'chore')
$labels = @{
  feat = 'Adicionado'
  fix  = 'Corrigido'
  docs = 'Documentacao'
  perf = 'Performance'
  refactor = 'Refatoracao'
  test = 'Testes'
  build = 'Build'
  ci = 'CI/CD'
  chore = 'Outros'
}

foreach ($line in $commits) {
  $match = [regex]::Match($line, '^(\w+)(?:\(([^)]+)\))?!?:\s+(.+)$')
  if ($match.Success) {
    $type = $match.Groups[1].Value
    $scope = $match.Groups[2].Value
    $subject = $match.Groups[3].Value.Trim()
    if ($groups.ContainsKey($type)) {
      $entry = $subject
      if ($scope) { $entry = "${scope}: ${subject}" }
      [void]$groups[$type].Add($entry)
    }
  }
}

$nl = [Environment]::NewLine

# monta release notes
$notes = [System.Collections.ArrayList]@()
[void]$notes.Add("## $version")
[void]$notes.Add('')
[void]$notes.Add("Lancado via GitHub Actions. Consulte o CHANGELOG ($repo/blob/main/CHANGELOG.md) para detalhes.")
[void]$notes.Add('')
[void]$notes.Add('### Artefatos')
[void]$notes.Add('')
[void]$notes.Add('- master-code.exe - executavel standalone (Node SEA)')
[void]$notes.Add('- master-code-setup.exe - instalador Windows (Inno Setup)')
[void]$notes.Add('- SHA256SUMS.txt - checksums SHA-256 de ambos os artefatos')
[void]$notes.Add('')

$hasContent = $false
foreach ($type in $order) {
  if ($groups[$type].Count -gt 0) {
    $hasContent = $true
    [void]$notes.Add("### $($labels[$type])")
    [void]$notes.Add('')
    foreach ($entry in $groups[$type]) {
      [void]$notes.Add("- $entry")
    }
    [void]$notes.Add('')
  }
}

if (-not $hasContent) {
  [void]$notes.Add('_Nenhuma mudanca individual listada nos commits._')
  [void]$notes.Add('')
}

$notesFile = Join-Path $root 'release-notes.md'
Set-Content -Path $notesFile -Value ($notes -join $nl) -Encoding utf8
Write-Host "Release notes geradas: $notesFile" -ForegroundColor Green

# atualiza CHANGELOG.md
$changelog = Join-Path $root 'CHANGELOG.md'
$existing = Get-Content -Path $changelog -Raw -Encoding utf8
$date = Get-Date -Format 'yyyy-MM-dd'
$newSection = [System.Collections.ArrayList]@()
[void]$newSection.Add("## [$version] - $date")
[void]$newSection.Add('')
foreach ($type in $order) {
  if ($groups[$type].Count -gt 0) {
    [void]$newSection.Add("### $($labels[$type])")
    [void]$newSection.Add('')
    foreach ($entry in $groups[$type]) {
      [void]$newSection.Add("- $entry")
    }
    [void]$newSection.Add('')
  }
}
$newSectionText = $newSection -join $nl

# idempotente: nao duplica a secao se ela ja existir
if ($existing -match [regex]::Escape("## [$version] - ")) {
  Write-Host "Secao [$version] ja existe no CHANGELOG; pulando atualizacao." -ForegroundColor Yellow
} else {
  $marker = '## [Não publicado]'
  if ($existing -match [regex]::Escape($marker)) {
    $idx = $existing.IndexOf($marker)
    $head = $existing.Substring(0, $idx)
    $tail = $existing.Substring($idx)
    $updated = $head + $newSectionText + $nl + $tail
  } else {
    $updated = $existing.TrimEnd("`r", "`n") + $nl + $nl + $newSectionText
  }
  Set-Content -Path $changelog -Value $updated -Encoding utf8
  Write-Host 'CHANGELOG.md atualizado.' -ForegroundColor Green
}
