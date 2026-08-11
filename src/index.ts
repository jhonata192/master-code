#!/usr/bin/env node
process.noDeprecation = true;
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import chalk from 'chalk';
import { askAutocomplete, inputClosed } from './autocomplete.js';
import type { Suggestion } from './autocomplete.js';
import { runTask, CancelledError } from './agent.js';
import { EventBus } from './events/bus.js';
import { AgentRenderer, parseCliFlags } from './render.js';
import type { RenderMode } from './render.js';
import { TraceStore } from './events/trace.js';
import { tools as allTools } from './tools.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  loadConfig,
  setProvider,
  setModel,
  setAutoModel,
  maskKey,
  CONFIG_PATH,
} from './config.js';
import { listModels, listCodingModels } from './llm.js';
import { getContextManager, resetContextManager } from './session.js';
import {
  UpdateService,
  getCurrentVersion,
  isUpdaterInvocation,
  parseUpdaterArgs,
  runUpdater,
  renderMarkdown,
  summarizeNotes,
  truncateNotesLines,
  openUrlInBrowser,
} from './update/index.js';
import type { NotesEntry, UpdateStatus } from './update/index.js';
import { appendLog } from './update/index.js';

const isTTY = stdout.isTTY === true;

const updateService = new UpdateService();
const MAX_NOTES_LINES = 40;

const traceStore = new TraceStore();
let renderMode: RenderMode = 'normal';
let debugJsonPath: string | undefined;

function renderBox(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const border = '┌' + '─'.repeat(width) + '┐';
  const body = lines.map((l) => '│ ' + l.padEnd(width - 1) + '│');
  const bottom = '└' + '─'.repeat(width) + '┘';
  return [border, ...body, bottom].join('\n');
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(2) + ' MB';
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(2) + ' KB';
  return n + ' B';
}

function fmtProgress(p: { received: number; total: number }): string {
  if (p.total > 0) {
    const pct = Math.floor((p.received / p.total) * 100);
    return `${pct}% (${fmtBytes(p.received)} / ${fmtBytes(p.total)})`;
  }
  return fmtBytes(p.received);
}

function clearLine(): void {
  if (isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
}

function startEscListener(onEsc: () => void): () => void {
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  const onKey = (_str: string | null, key: readline.Key) => {
    if (key.name === 'escape') onEsc();
  };
  stdin.on('keypress', onKey);
  return () => {
    stdin.removeListener('keypress', onKey);
    stdin.setRawMode(false);
    stdin.pause();
  };
}

async function handleTask(prompt: string): Promise<void> {
  const controller = new AbortController();
  let stopEsc: (() => void) | undefined;
  let escActive = false;

  const ensureEsc = (): void => {
    if (escActive || !stdin.isTTY) return;
    stopEsc = startEscListener(() => {
      if (!controller.signal.aborted) {
        controller.abort();
        clearLine();
      }
    });
    escActive = true;
  };

  const pauseEsc = (): void => {
    if (escActive && stopEsc) {
      stopEsc();
      escActive = false;
    }
  };

  ensureEsc();

  const confirm = async (command: string): Promise<boolean> => {
    if (!stdin.isTTY) return false;
    pauseEsc();
    try {
      clearLine();
      console.log(chalk.yellow('\n[aviso] Comando potencialmente destrutivo:'));
      console.log(chalk.gray('  ' + command));
      const rl = readline.createInterface({ input: stdin, output: stdout });
      const ans = await new Promise<string>((resolve) => {
        rl.question(chalk.yellow('Executar mesmo? [s/N]: '), (a) => resolve(a));
      });
      rl.close();
      return /^\s*(s|sim|y|yes)\s*$/i.test(ans);
    } finally {
      ensureEsc();
    }
  };

  process.stdout.write(chalk.cyan('...'));
  const bus = new EventBus();
  traceStore.attach(bus);
  const renderer = new AgentRenderer(bus, { mode: renderMode, debugJsonPath });
  void renderer;
  try {
    const result = await runTask(prompt, {
      bus,
      signal: controller.signal,
      confirm,
    });
    clearLine();
    if (renderMode !== 'quiet') {
      console.log(chalk.gray('  modelo: ' + result.modelUsed));
      console.log(chalk.bold('\n[Done]'));
      if (!result.text) console.log(chalk.gray('(sem texto de resposta)'));
    }
  } catch (err) {
    clearLine();
    if (err instanceof CancelledError) {
      console.log(chalk.yellow('[Cancelado]'));
    } else {
      console.log(chalk.red('\n[Erro] ' + String(err)));
    }
  } finally {
    pauseEsc();
  }
}

function describeModel(c: {
  model: string;
  autoModel: boolean;
  modelPool: string[];
}): string {
  if (!c.autoModel) return c.model;
  const n = c.modelPool.length;
  return (
    'AUTO' +
    (n > 0 ? ` (${n} modelos de codigo em rotacao)` : ' (busca modelos de codigo na API)')
  );
}

async function cmdStatus(): Promise<void> {
  const c = await loadConfig();
  console.log(chalk.bold('Status'));
  console.log('  Config:       ' + chalk.gray(CONFIG_PATH));
  console.log('  Base URL:     ' + chalk.gray(c.provider.baseUrl));
  console.log('  API key:      ' + chalk.gray(maskKey(c.provider.apiKey)));
  console.log('  Modelo:       ' + chalk.gray(describeModel(c)));
  console.log('  Iteracoes:    ' + chalk.gray(String(c.maxIterations)));
  console.log('  Janela ctx:   ' + chalk.gray(c.contextWindow + ' tokens'));
}

async function cmdContexto(): Promise<void> {
  const ctx = await getContextManager();
  console.log(chalk.bold('Contexto da sessao'));
  console.log('  Projeto:     ' + chalk.gray(ctx.projectRoot));
  console.log('  Objetivo:    ' + chalk.gray(ctx.objective ?? '(nenhum)'));
  console.log('  Entradas:    ' + chalk.gray(String(ctx.entryCount) + ' ativas'));
  console.log('  Tokens:      ' + chalk.gray(String(ctx.totalTokens) + ' / ' + ctx.windowTokens));
  console.log('  Compactados: ' + chalk.gray(String(ctx.archiveCount) + ' blocos'));
  if (ctx.taskState) {
    console.log('  Tarefa:      ' + chalk.gray(ctx.taskState.kind));
    console.log('  Pendentes:   ' + chalk.gray(String(ctx.taskState.pending.length) + ' | Concluidos: ' + ctx.taskState.completed.length));
    console.log('  Arquivos:    ' + chalk.gray(String(ctx.taskState.files.length) + ' | Decisoes: ' + ctx.taskState.decisions.length));
  }
  console.log('  Memoria:     ' + chalk.gray(String(ctx.memory.size) + ' fatos'));
  console.log('  Decisoes:    ' + chalk.gray(String(ctx.decisionCount) + ' | Erros: ' + ctx.errorCount + ' | Alteracoes: ' + ctx.changeCount));
  console.log('  Grafo:       ' + chalk.gray(String(ctx.graph.nodeCount) + ' nos | ' + ctx.graph.edgeCount + ' arestas'));
  const report = ctx.contextReport();
  console.log('  Orcamento:   ' + chalk.gray(`${report.budget.percent}% usado (${report.budget.used}/${report.budget.total})`));
  for (const p of report.budget.parts) {
    if (p.tokens === 0) continue;
    console.log('    - ' + chalk.gray(p.label + ': ' + p.tokens + ' tokens'));
  }
  const files = ctx.entries
    .filter((e) => e.tags.some((t) => t.startsWith('file:')))
    .slice(-10)
    .map((e) => '  - ' + e.tags.find((t) => t.startsWith('file:'))!.slice(5));
  if (files.length) {
    console.log('  Ultimos arquivos tocados:');
    console.log(files.join('\n'));
  }
}

async function cmdMemoria(): Promise<void> {
  const ctx = await getContextManager();
  console.log(chalk.bold('Memoria do projeto (' + ctx.memory.size + ' fatos)'));
  const facts = ctx.memory.all();
  if (facts.length === 0) {
    console.log(chalk.gray('  (nenhuma memoria ainda)'));
    return;
  }
  for (const f of facts) {
    console.log(
      '  [' + chalk.cyan(f.priority.padEnd(8)) + '] ' +
      chalk.gray(f.category) + ' ' + chalk.gray(new Date(f.ts).toLocaleTimeString()) +
      '\n      ' + f.content.slice(0, 160)
    );
  }
}

async function cmdLimpar(): Promise<void> {
  const ctx = await getContextManager();
  await ctx.reset();
  resetContextManager();
  traceStore.reset();
  console.log(chalk.green('Contexto limpo (sessao reiniciada).'));
}

function cmdTrace(): void {
  console.log(traceStore.render());
}

function cmdTools(): void {
  const counts = traceStore.countByTool();
  console.log(chalk.bold('Ferramentas (' + allTools.length + ')'));
  for (const t of allTools) {
    const fn = t.function;
    const used = counts.get(fn.name) ?? 0;
    const desc = (fn.description ?? '').split('\n')[0];
    console.log(
      '  ' + chalk.cyan(fn.name.padEnd(16)) +
      (used > 0 ? chalk.gray(String(used) + 'x  ') : chalk.gray('    ')) +
      chalk.gray(desc.slice(0, 80))
    );
  }
}

async function cmdProvider(): Promise<void> {
  const c = await loadConfig();
  console.log('Provedor atual: ' + c.provider.baseUrl);
  console.log('API key atual:  ' + maskKey(c.provider.apiKey));
  const key = await askAutocomplete(
    chalk.yellow('Nova NVIDIA API key (Enter para manter): '),
    () => []
  );
  const keyTrim = key.trim();
  const base = await askAutocomplete(
    chalk.yellow(`Base URL (Enter para manter [${c.provider.baseUrl}]): `),
    () => []
  );
  const baseTrim = base.trim();
  await setProvider(keyTrim || c.provider.apiKey, baseTrim || c.provider.baseUrl);
  console.log(chalk.green('Provedor salvo.'));
}

function suggestModelsIn(list: string[], buf: string): Suggestion[] {
  const b = buf.trim().toLowerCase();
  if (!b) return [];
  if (/^\d+$/.test(b)) return [];
  const out: Suggestion[] = [];
  if ('/search'.startsWith(b)) out.push({ display: '/search', value: '/search' });
  for (const m of list.filter((x) => x.toLowerCase().includes(b)).slice(0, 5)) {
    out.push({ display: m, value: m });
  }
  return out;
}

function suggestModelsSearch(models: string[], buf: string): Suggestion[] {
  const b = buf.trim().toLowerCase();
  if (!b) return [];
  return models
    .filter((x) => x.toLowerCase().includes(b))
    .slice(0, 5)
    .map((m) => ({ display: m, value: m }));
}

async function cmdModel(): Promise<void> {
  const c = await loadConfig();
  console.log('Modelo atual: ' + describeModel(c));
  console.log(chalk.gray('Buscando modelos do NVIDIA NIM...'));
  const models = await listModels();
  if (models.length === 0) {
    console.log(chalk.red('Nenhum modelo listado. Configure /provider primeiro.'));
    return;
  }

  let filter = '';
  for (;;) {
    const list = filter
      ? models.filter((m) => m.toLowerCase().includes(filter.toLowerCase()))
      : models;
    console.log('');
    console.log('  ' + chalk.cyan('  0)') + ' AUTO - rotaciona entre modelos de codigo');
    list.forEach((m, i) => console.log(`  ${chalk.cyan(String(i + 1).padStart(3))}) ${m}`));

    const input = await askAutocomplete(
      chalk.yellow('\nNumero, /search, nome (autocomplete), Enter p/ cancelar: '),
      (buf) => suggestModelsIn(list, buf)
    );
    const t = input.trim();
    if (!t) {
      console.log(chalk.gray('Cancelado.'));
      return;
    }

    if (t === '/search' || t.startsWith('/search ')) {
      let rest = t.replace(/^\/search\s*/, '').trim();
      if (!rest) {
        rest = await askAutocomplete(
          chalk.yellow('Buscar modelo: '),
          (buf) => suggestModelsSearch(models, buf),
          { enterCompletes: false }
        );
        rest = rest.trim();
      }
      if (!rest) {
        console.log(chalk.gray('Cancelado.'));
        return;
      }
      filter = rest;
      continue;
    }

    if (t.toLowerCase() === 'auto') {
      const coding = await listCodingModels();
      await setAutoModel(coding);
      console.log(chalk.green(`Auto-rotacao ativada com ${coding.length} modelos de codigo.`));
      return;
    }

    const n = Number(t);
    if (!Number.isNaN(n) && Number.isInteger(n) && n >= 1 && n <= list.length) {
      await setModel(list[n - 1]);
      console.log(chalk.green('Modelo salvo: ' + list[n - 1]));
      return;
    }

    const exact = models.find((m) => m === t);
    if (exact) {
      await setModel(exact);
      console.log(chalk.green('Modelo salvo: ' + exact));
      return;
    }

    filter = t;
  }
}

function printHelp(): void {
  console.log(chalk.bold('Comandos'));
  console.log('  /provider  Configurar NVIDIA (API key e base URL)');
  console.log('  /model     Escolher modelo fixo ou AUTO. Dentro: /search p/ buscar com autocomplete');
  console.log('  /status    Mostrar configuracao atual');
  console.log('  /contexto  Mostrar o estado do contexto da sessao');
  console.log('  /memoria   Listar a memoria persistente do projeto');
  console.log('  /limpar    Limpar o contexto e comecar sessao nova');
  console.log('  /trace     Mostrar o rastreio das ferramentas da sessao');
  console.log('  /tools     Listar ferramentas disponiveis e uso na sessao');
  console.log('  /version   Mostrar versao, canal e status de atualizacao');
  console.log('  /update    Verificar e instalar a ultima versao do GitHub');
  console.log('  /update check   Verificar se ha atualizacao disponivel');
  console.log('  /update download  Baixar a atualizacao (sem instalar)');
  console.log('  /update install   Instalar a atualizacao baixada');
  console.log('  /update notes     Mostrar as Release Notes (--full p/ tudo, ou /update notes 0.2.0)');
  console.log('  /update open      Abrir a Release no navegador');
  console.log('  /update status    Mostrar estado detalhado do updater');
  console.log('  /help      Mostrar estes comandos');
  console.log('  sair | exit | :q');
  console.log('  Qualquer outro texto vira um pedido para o agente.');
  console.log('');
  console.log(chalk.bold('Autocomplete'));
  console.log('  Digite e veja a sugestao em cinza. Enter aceita a 1a sugestao, Tab completa,');
  console.log('  Ctrl+U limpa, Ctrl+C sai.');
}

async function cmdVersion(): Promise<void> {
  const c = await loadConfig();
  console.log(chalk.bold('Master-Code'));
  console.log('  Version: ' + chalk.gray(getCurrentVersion()));
  console.log('  Channel: ' + chalk.gray(c.update.channel));
  const st = await updateService.status();
  console.log(
    st.updateAvailable && st.lastKnownVersion
      ? '  Update:  ' + chalk.green('available (' + st.lastKnownVersion + ')')
      : '  Update:  ' + chalk.gray('up to date')
  );
}

async function cmdUpdateCheck(): Promise<void> {
  console.log(chalk.cyan('Verificando atualizacoes no GitHub...'));
  const res = await updateService.check(true);
  if (!res.ok) {
    console.log(chalk.red('Erro: ' + (res.error ?? 'falha desconhecida')));
    return;
  }
  console.log('  Versao atual:  ' + chalk.gray(res.currentVersion));
  if (!res.latestVersion) {
    console.log(chalk.gray('  Nenhuma versao publicada no GitHub.'));
    return;
  }
  console.log('  Ultima versao: ' + chalk.gray(res.latestVersion));
  if (res.updateAvailable) {
    console.log(chalk.green('\n  Nova versao disponivel.'));
    const notes = await updateService.getReleaseNotes();
    if (notes.ok && notes.entry?.body) {
      const items = summarizeNotes(notes.entry.body, 8);
      if (items.length) {
        console.log(chalk.bold('\n  Principais alteracoes:'));
        for (const it of items) console.log('    * ' + it);
      }
    }
    console.log(chalk.gray('\n  Use /update para atualizar.'));
    console.log(chalk.gray('  Use /update notes para ver as notas completas.'));
  } else {
    console.log(chalk.green('\n  Voce esta atualizado.'));
  }
}

function showReleaseInfo(entry: NotesEntry, full = false): void {
  console.log(chalk.bold('\n  Nova versao disponivel: ' + entry.version));
  console.log('  Release: ' + chalk.gray(entry.tagName));
  if (entry.publishedAt) {
    const d = new Date(entry.publishedAt);
    if (!Number.isNaN(d.getTime())) console.log('  Data:    ' + chalk.gray(d.toLocaleDateString('pt-BR')));
  }
  if (entry.htmlUrl) console.log('  Ver no GitHub: ' + chalk.gray(entry.htmlUrl));

  if (!entry.body || !entry.body.trim()) {
    console.log(chalk.gray('\n  (Release sem notas publicadas.)'));
    return;
  }
  console.log(chalk.bold('\n  Notas da atualizacao:'));
  const rendered = renderMarkdown(entry.body);
  if (full) {
    console.log(rendered);
    return;
  }
  const { lines, truncated, remaining } = truncateNotesLines(rendered, MAX_NOTES_LINES);
  console.log(lines.join('\n'));
  if (truncated) {
    console.log(chalk.gray(`\n  ... mais ${remaining} linhas. Use /update notes --full para ver tudo.`));
  }
}

async function cmdUpdateNotes(opts: { version?: string; full: boolean }): Promise<void> {
  const res = await updateService.getReleaseNotes({ version: opts.version });
  if (!res.ok) {
    console.log(chalk.red(res.error ?? 'Erro ao obter as notas.'));
    return;
  }
  const entry = res.entry!;
  if (res.fromCache) console.log(chalk.gray('  (notas em cache)'));
  showReleaseInfo(entry, opts.full);
}

async function cmdUpdateOpen(): Promise<void> {
  const notes = await updateService.getReleaseNotes();
  if (!notes.ok || !notes.entry?.htmlUrl) {
    console.log(chalk.red(notes.error ?? 'Nao ha release para abrir.'));
    return;
  }
  console.log(chalk.gray('Abrindo no navegador: ' + notes.entry.htmlUrl));
  const ok = openUrlInBrowser(notes.entry.htmlUrl);
  if (!ok) console.log(chalk.yellow('  Nao foi possivel abrir o navegador automaticamente.'));
}

async function cmdUpdate(): Promise<void> {
  console.log(chalk.cyan('Verificando atualizacoes no GitHub...'));
  const res = await updateService.check(true);
  if (!res.ok) {
    console.log(chalk.red('Erro: ' + (res.error ?? 'falha desconhecida')));
    return;
  }
  console.log('  Versao atual:  ' + chalk.gray(res.currentVersion));
  if (!res.latestVersion) {
    console.log(chalk.gray('  Nenhuma versao publicada no GitHub.'));
    return;
  }
  console.log('  Nova versao:   ' + chalk.gray(res.latestVersion));
  if (!res.updateAvailable) {
    console.log(chalk.green('  Voce esta atualizado.'));
    return;
  }

  const notes = await updateService.getReleaseNotes();
  if (notes.ok && notes.entry) {
    showReleaseInfo(notes.entry, false);
  }

  const yes = await askAutocomplete(chalk.yellow('\n  Deseja atualizar? [S] Sim / [N] Nao: '), () => []);
  if (!/^\s*(s|sim|y|yes)\s*$/i.test(yes)) {
    console.log(chalk.gray('  Atualizacao cancelada.'));
    return;
  }
  await cmdUpdateDownload();
  const inst = await updateService.status();
  if (inst.downloaded) {
    await cmdUpdateInstall();
  }
}

async function cmdUpdateDownload(): Promise<void> {
  console.log(chalk.cyan('Baixando atualizacao...'));
  let last: { received: number; total: number } = { received: 0, total: 0 };
  const res = await updateService.download({
    onProgress: (p) => {
      last = p;
      clearLine();
      process.stdout.write(chalk.gray('  Progresso: ' + fmtProgress(p)));
    },
  });
  clearLine();
  if (!res.ok) {
    console.log(chalk.red('Falha ao baixar: ' + (res.error ?? 'erro desconhecido')));
    return;
  }
  console.log(chalk.green('Download concluido.'));
  console.log('  Versao:  ' + chalk.gray(res.version ?? '-'));
  console.log('  Arquivo: ' + chalk.gray(res.fileName ?? '-'));
  console.log('  Tamanho: ' + chalk.gray(fmtBytes(res.size)));
  console.log('  Destino: ' + chalk.gray(res.filePath ?? '-'));
  console.log(
    res.checksum
      ? '  SHA-256: ' + chalk.gray(res.checksum.slice(0, 16) + '...')
      : chalk.yellow('  SHA-256: nao verificado (checksum ausente na release)')
  );
  console.log(chalk.gray('  Use /update install para instalar.'));
}

async function cmdUpdateInstall(): Promise<void> {
  const res = await updateService.install();
  if (!res.ok) {
    console.log(chalk.red('Nao foi possivel instalar: ' + (res.error ?? 'erro desconhecido')));
    return;
  }
  console.log(chalk.green('Atualizacao em andamento.'));
  console.log(chalk.gray('O updater vai fechar esta instancia, instalar a nova versao e reabrir.'));
  await appendLog('install', { state: 'closing-app' });
  setTimeout(() => process.exit(0), 500);
}

async function cmdUpdateStatus(): Promise<void> {
  const st: UpdateStatus = await updateService.status();
  console.log(chalk.bold('Update status'));
  console.log('  Versao atual:        ' + chalk.gray(st.currentVersion));
  console.log('  Canal:               ' + chalk.gray(st.channel));
  console.log('  Habilitado:          ' + chalk.gray(String(st.enabled)));
  console.log('  Auto-check:          ' + chalk.gray(String(st.autoCheck)));
  console.log('  Auto-update:         ' + chalk.gray(String(st.autoUpdate)));
  console.log(
    '  Ultima verificacao:  ' + chalk.gray(st.lastUpdateCheck ? new Date(st.lastUpdateCheck).toLocaleString() : 'nunca')
  );
  console.log('  Ultima versao:       ' + chalk.gray(st.lastKnownVersion ?? 'nenhuma'));
  console.log(
    '  Atualizacao:         ' +
      (st.updateAvailable ? chalk.green('disponivel (' + st.lastKnownVersion + ')') : chalk.gray('atualizado'))
  );
  if (st.downloaded) {
    console.log('  Download:            ' + chalk.gray(st.downloaded.fileName));
    console.log('  Download path:       ' + chalk.gray(st.downloaded.path));
  } else {
    console.log('  Download:            ' + chalk.gray('nenhum'));
  }
}

async function handleSlash(raw: string): Promise<void> {
  const [cmd, ...rest] = raw.trim().split(/\s+/);
  const sub = rest.join(' ').trim();
  switch (cmd) {
    case '/provider':
      await cmdProvider();
      break;
    case '/model':
      await cmdModel();
      break;
    case '/status':
      await cmdStatus();
      break;
    case '/contexto':
      await cmdContexto();
      break;
    case '/memoria':
      await cmdMemoria();
      break;
    case '/limpar':
      await cmdLimpar();
      break;
    case '/trace':
      cmdTrace();
      break;
    case '/tools':
      cmdTools();
      break;
    case '/version':
      await cmdVersion();
      break;
    case '/update': {
      if (sub === 'check') await cmdUpdateCheck();
      else if (sub === 'download') await cmdUpdateDownload();
      else if (sub === 'install') await cmdUpdateInstall();
      else if (sub === 'status') await cmdUpdateStatus();
      else if (sub === 'open') await cmdUpdateOpen();
      else if (sub === 'notes') await cmdUpdateNotes({ full: false });
      else if (sub.startsWith('notes ')) {
        const restArgs = sub.slice(6).trim().split(/\s+/);
        const full = restArgs.includes('--full');
        const version = restArgs.filter((a) => a !== '--full').join(' ').trim() || undefined;
        await cmdUpdateNotes({ version, full });
      } else if (sub === '') await cmdUpdate();
      else console.log(chalk.gray('Uso: /update [check|download|install|status|notes [versao] [--full]|open]'));
      break;
    }
    case '/help':
      printHelp();
      break;
    default:
      console.log(chalk.gray('Comando desconhecido. Use /help.'));
  }
}

const COMMANDS: string[] = [
  '/provider',
  '/model',
  '/status',
  '/contexto',
  '/memoria',
  '/limpar',
  '/trace',
  '/tools',
  '/version',
  '/update',
  '/update check',
  '/update download',
  '/update install',
  '/update notes',
  '/update open',
  '/update status',
  '/help',
  'sair',
  'exit',
];

function suggestCommands(buf: string): Suggestion[] {
  const b = buf.trim().toLowerCase();
  if (!b) return [];
  return COMMANDS.filter((c) => c.toLowerCase().startsWith(b)).map((c) => ({
    display: c,
    value: c,
  }));
}

async function runAutoUpdateCheck(): Promise<void> {
  const c = await loadConfig();
  if (!c.update.autoCheck || !c.update.enabled) return;
  try {
    const res = await updateService.check(false);
    if (res.updateAvailable && res.latestVersion) {
      console.log('');
      console.log(
        renderBox([
          chalk.bold('Nova versao disponivel'),
          '',
          '  Atual: ' + res.currentVersion,
          '  Nova:  ' + res.latestVersion,
          '',
          chalk.gray('Use /update para ver as novidades.'),
        ])
      );
      console.log('');
    }
  } catch {
    /* offline/lento: ignorar silenciosamente */
  }
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  if (isUpdaterInvocation(process.argv)) {
    const args = parseUpdaterArgs(process.argv);
    if (args) {
      const code = await runUpdater(args);
      process.exit(code);
    }
    process.exit(1);
  }

  const flags = parseCliFlags(rawArgv);
  renderMode = flags.mode;
  debugJsonPath = flags.debugJsonPath;
  if (debugJsonPath) {
    await mkdir(path.dirname(debugJsonPath), { recursive: true });
    console.log(chalk.gray('  eventos JSONL: ' + debugJsonPath));
  }

  const oneShot = flags.args.join(' ');
  if (oneShot) {
    await handleTask(oneShot);
    return;
  }

  const c = await loadConfig();
  console.log(chalk.bold.cyan('master-code') + ' — agente de codigo via NVIDIA NIM');
  console.log(
    chalk.gray('Modelo: ' + describeModel(c) + '  |  API key: ' + maskKey(c.provider.apiKey))
  );
  console.log(
    chalk.gray('Versao ' + getCurrentVersion() + '  |  Comandos: /provider /model /status /version /update /trace /tools /help | sair para sair' + (renderMode !== 'normal' ? '  |  modo: ' + renderMode : ''))
  );
  console.log('');

  void runAutoUpdateCheck();

  try {
    for (;;) {
      const answer = await askAutocomplete(chalk.green('\n> '), suggestCommands);
      if (inputClosed()) break;
      const t = answer.trim();
      if (!t) continue;
      if (t === 'exit' || t === 'sair' || t === ':q') break;
      if (t.startsWith('/')) {
        await handleSlash(t);
        continue;
      }
      await handleTask(t);
    }
  } catch (err) {
    console.error(chalk.red(String(err)));
  }
}

void main()
  .then(() => {
    if (stdin.isTTY) stdin.setRawMode(false);
    process.exit(0);
  })
  .catch((err) => {
    console.error(chalk.red(String(err)));
    process.exit(1);
  });
