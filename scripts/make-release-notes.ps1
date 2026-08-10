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
$previous = git describe --tags --abbrev=0 "$tag^" 2>$null
if ($LASTEXITCODE -ne 0) {
  $previous = $null
  Write-Host 'Nenhuma tag anterior encontrada; usando todos os commits.' -ForegroundColor Yellow
}

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
  feat = @()
  fix  = @()
  docs = @()
  perf = @()
  refactor = @()
  test = @()
  build = @()
  ci = @()
  chore = @()
}
$order = @('feat', 'fix', 'docs', 'perf', 'refactor', 'test', 'build', 'ci', 'chore')
$labels = @{
  feat = 'Adicionado'
  fix  = 'Corrigido'
  docs = 'Documentação'
  perf = 'Performance'
  refactor = 'Refatoração'
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
      if ($scope) { $entry = "**$scope:** $subject" }
      $groups[$type] += $entry
    }
  }
}

# monta release notes
$notes = @()
$notes += "## $version"
$notes += ""
$notes += "Lançado via GitHub Actions. Consulte o [CHANGELOG]($repo/blob/main/CHANGELOG.md) para detalhes."
$notes += ""
$notes += "### Artefatos"
$notes += ""
$notes += "- `master-code.exe` — executável standalone (Node SEA)"
$notes += "- `master-code-setup.exe` — instalador Windows (Inno Setup)"
$notes += "- `SHA256SUMS.txt` — checksums SHA-256 de ambos os artefatos"
$notes += ""

$hasContent = $false
foreach ($type in $order) {
  if ($groups[$type].Count -gt 0) {
    $hasContent = $true
    $notes += "### $($labels[$type])"
    $notes += ""
    foreach ($entry in $groups[$type]) {
      $notes += "- $entry"
    }
    $notes += ""
  }
}

if (-not $hasContent) {
  $notes += "_Nenhuma mudança individual listada nos commits._"
  $notes += ""
}

$notesFile = Join-Path $root 'release-notes.md'
Set-Content -Path $notesFile -Value $notes -Encoding utf8
Write-Host "Release notes geradas: $notesFile" -ForegroundColor Green

# atualiza CHANGELOG.md
$changelog = Join-Path $root 'CHANGELOG.md'
$existing = Get-Content -Path $changelog -Raw -Encoding utf8
$date = Get-Date -Format 'yyyy-MM-dd'
$newSection = "## [$version] - $date`r`n"
$newSection += "`r`n"
foreach ($type in $order) {
  if ($groups[$type].Count -gt 0) {
    $newSection += "### $($labels[$type])`r`n`r`n"
    foreach ($entry in $groups[$type]) {
      $newSection += "- $entry`r`n"
    }
    $newSection += "`r`n"
  }
}

$marker = '## [Não publicado]'
if ($existing -match [regex]::Escape($marker)) {
  $idx = $existing.IndexOf($marker)
  $head = $existing.Substring(0, $idx)
  $tail = $existing.Substring($idx)
  $updated = $head + $newSection + $tail
} else {
  $updated = $existing + $newSection
}

Set-Content -Path $changelog -Value $updated -Encoding utf8
Write-Host 'CHANGELOG.md atualizado.' -ForegroundColor Green
