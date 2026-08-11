# Changelog

Todas as mudanças notáveis neste projeto serão documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/)
e este projeto adere ao [Semantic Versioning](https://semver.org/lang/pt-BR/).

Este arquivo é atualizado automaticamente pelo workflow de release
(`.github/workflows/release.yml`) a partir dos commits (*Conventional
Commits*).

## [Não publicado]

### Adicionado
- Pipeline de CI/CD com GitHub Actions (`ci.yml` e `release.yml`).
- Versionamento com `package.json` como fonte única de verdade, validado
  contra a tag `vX.Y.Z` no workflow de release.
- Script `scripts/make-release-notes.ps1` para gerar release notes e
  atualizar o CHANGELOG automaticamente.
- Streaming de respostas do modelo em tempo real, com eventos estruturados
  (`text_delta`, `tool_call_start`, `tool_call_args`, `tool_call_end`,
  `tool_result`, `usage`, `retry`, `compaction`, entre outros).
- Camada de eventos reutilizável (`EventBus`) que conecta o agente à
  interface (renderer, trace e testes) sem acoplamento.
- Fallback automático para resposta completa quando o provider não suporta
  streaming, e retries visíveis em erros transitórios (429/5xx/network).
- Modos de exibição do terminal: `--debug` (eventos estruturados com
  timestamp), `--quiet` (apenas a resposta final) e `--debug-json`
  (gravação dos eventos em JSONL).
- Comandos `/trace` (rastreio de ferramentas da sessão) e `/tools`
  (ferramentas disponíveis e uso).
- Detecção de chamadas de ferramentas duplicadas na sessão (registro + aviso,
  sem bloquear a execução).
- Justificativa operacional de cada chamada de ferramenta derivada da etapa
  do plano (sem expor chain-of-thought nem custo extra de tokens).
- Testes de streaming e renderização (`tests/streaming.test.ts` e
  `tests/render.test.ts`).

## [0.1.0] - 2026-08-10

### Adicionado
- Agente de código interativo em linha de comando usando NVIDIA NIM como
  backend de IA.
- Comandos de configuração do provider (base URL, API key e modelo).
- Executável standalone via Node SEA (`dist/master-code.exe`).
- Instalador Windows via Inno Setup (`installer/master-code-setup.exe`).
- Sistema de contexto inteligente (etapas 2 e 3): intenção, scoring por
  camadas, recuperação híbrida, grafo de relações entre arquivos, memória
  de decisões/erros/alterações e detecção de arquivos obsoletos.

## [0.2.0] - 2026-08-11

### Adicionado

- update: sistema de atualizacao via GitHub Releases com release notes

### Outros

- release: atualiza CHANGELOG para 0.1.0

