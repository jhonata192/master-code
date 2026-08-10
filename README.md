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
