# master-code

Agente de código estilo Claude Code / opencode usando NVIDIA NIM.

![CI](https://github.com/jhonata192/master-code/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/jhonata192/master-code/actions/workflows/release.yml/badge.svg)

## Sobre

`master-code` é um agente de linha de comando que assiste você em tarefas de
engenharia de software, usando modelos da plataforma NVIDIA NIM como backend
de IA.

## Requisitos

- Node.js 20+ (apenas para rodar a partir do código-fonte)
- Windows (para o instalador `.exe`)

## Instalação

### Via instalador (Windows)

Baixe o instalador `master-code-setup.exe` da página de
[Releases](https://github.com/jhonata192/master-code/releases) e execute-o.
Ele instala o executável em `%ProgramFiles%\master-code` e adiciona à PATH do
sistema.

Depois, abra um novo terminal e configure sua chave de API:

```sh
master-code /config
```

### Via código-fonte

```sh
npm ci
npm run build
```

## Uso

```sh
master-code
```

Digite `/help` dentro do agente para ver os comandos disponíveis.

## Development

```sh
npm ci            # instala dependências
npm run dev       # roda em modo desenvolvimento (tsx)
npm run typecheck # verificação de tipos (tsc --noEmit)
npm test          # roda a suíte de testes
npm run build     # compila TypeScript para dist/
```

### Gerar executável standalone (SEA)

```sh
npm run build:exe
```

Gera `dist/master-code.exe` usando Node SEA + esbuild + postject.

### Gerar instalador (Inno Setup)

```sh
npm run build:setup
```

Chama `build:exe` e compila `installer/master-code-setup.exe` com o Inno
Setup (é preciso ter o Inno Setup 6/7 instalado).

### Instalar/desinstalar o executável na PATH do sistema

```sh
npm run install:exe
npm run uninstall:exe
```

## Atualização

O `master-code` verifica automaticamente por novas versões no GitHub Releases
do repositório `jhonata192/master-code` (canal `stable`, sem pré-releases).
O comportamento é offline-first: a verificação acontece em background na
inicialização, com timeout curto, e não bloqueia o uso do agente.

### Comandos

```
/version           Versão atual, canal e se há atualização
/update            Verifica e, se confirmar, baixa e instala a última versão
/update check      Verifica se há atualização disponível (com resumo das novidades)
/update download   Baixa a atualização (sem instalar)
/update install    Instala a atualização já baixada
/update notes      Mostra as Release Notes da última versão (respeita o canal)
/update notes 0.2.0   Mostra as Release Notes daquela versão
/update notes --full  Mostra as notas completas (sem truncar)
/update open       Abre a página da Release no navegador padrão
/update status     Estado detalhado do updater
/trace             Mostra o rastreio das ferramentas da sessao (chamadas, uso, duplicadas)
/tools             Lista as ferramentas disponiveis e quantas vezes foram usadas na sessao
```

### Streaming e observabilidade

A execucao do agente e transmitida em tempo real para o terminal por meio de
eventos estruturados (`text_delta`, `tool_call_start`, `tool_call_args`,
`tool_result`, `usage`, `compaction`, etc.). As respostas do modelo chegam em
fluxo (streaming) e, se o provider nao suportar streaming, o agente usa
automaticamente a resposta completa como fallback.

```
--debug        Mostra eventos estruturados com timestamp (args, ids, usage, contexto)
--quiet        Mostra somente a resposta final
--debug-json   Grava todos os eventos em um arquivo JSONL (~/.master-code/traces/ ou caminho informado)
```

### Como funciona

1. **Verificação**: compara a versão local (do `package.json`, embutida no
   executável) com a última release estável do GitHub usando semver. O
   resultado fica em cache por 24h em `~/.master-code/config.json`.
2. **Release Notes**: o `body` da GitHub Release é usado como as notas
   oficiais da atualização. Na verificação, as notas são armazenadas em cache
   em `~/.master-code/release-notes.json` (versão, release ID, corpo, data de
   publicação e timestamp da consulta). O cache expira em 24h e é invalidado
   quando a Release muda; nenhuma chamada ao GitHub é feita para notas que já
   estão em cache.
3. **Exibição**: as notas são renderizadas como Markdown no terminal
   (títulos, listas, negrito, código, links, citações). Notas muito grandes
   são truncadas por padrão (`/update notes --full` mostra tudo) e `/update`
   apresenta um resumo das principais alterações antes de pedir confirmação.
4. **Download**: baixa `master-code-setup-<versão>.exe` e valida o SHA-256
   contra o `SHA256SUMS.txt` da release. Sem checksum na release, o download
   é abortado com aviso de integridade.
5. **Instalação**: copia o executável atual para `master-code-updater.exe`
   (processo auxiliar em `%TEMP%`), fecha o `master-code`, roda o instalador
   em modo silencioso (`/VERYSILENT /NORESTART`) e reabre o aplicativo.

O processo de atualização usa apenas o repositório configurado; nada é
executado de URLs arbitrárias. Configurações, sessões e memória em
`~/.master-code/` são preservadas. Logs de atualização ficam em
`~/.master-code/update.log`.

> **Nota**: a instalação automática exige o `master-code.exe` instalado
> (via instalador ou `npm run install:exe`). Rodando apenas a partir do
> código-fonte (`node dist/index.js`), use `/update download` para baixar e
> instale manualmente.

## Release

O processo de release é gerenciado por GitHub Actions:

1. O workflow de CI (`ci.yml`) roda em todo push e pull request:
   `typecheck`, testes e build do executável.
2. O workflow de release (`release.yml`) dispara quando uma tag `v*` é
   criada (ou manualmente via *workflow_dispatch*):
   - valida a versão (package.json vs. tag);
   - roda `typecheck`, testes e build;
   - gera `dist/master-code.exe` e `installer/master-code-setup.exe`;
   - calcula o checksum SHA-256 de cada artefato e gera `SHA256SUMS.txt`;
   - gera/atualiza o `CHANGELOG.md` e as release notes a partir dos commits
     seguindo *Conventional Commits*;
   - cria uma GitHub Release com os artefatos e o checksum.

### Criar uma release

```sh
git tag v0.1.0
git push origin v0.1.0
```

A versão exibida nos artefatos vem do `package.json` (fonte única de
verdade), que deve casar com a tag `vX.Y.Z`.

## Estrutura

```
src/       código-fonte TypeScript
scripts/   scripts de build (PowerShell) e utilitários
tests/     suíte de testes (node:test)
installer/ script Inno Setup (.iss)
dist/      build TypeScript + executável SEA (gerado)
dist-bundle/ bundle esbuild + blob SEA (gerado)
.github/workflows/  pipelines de CI e release
```

## Licença

A definir.
