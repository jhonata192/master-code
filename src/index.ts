#!/usr/bin/env node
process.noDeprecation = true;
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import chalk from 'chalk';
import { askAutocomplete, inputClosed } from './autocomplete.js';
import type { Suggestion } from './autocomplete.js';
import { runTask, CancelledError } from './agent.js';
import type { AgentEvent } from './agent.js';
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

const isTTY = stdout.isTTY === true;

function clearLine(): void {
  if (isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
}

function renderEvent(e: AgentEvent): void {
  if (e.type === 'tool') {
    console.log(chalk.gray('  ' + e.content));
  } else {
    console.log(chalk.white(e.content));
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
  try {
    const result = await runTask(
      prompt,
      (e) => {
        clearLine();
        renderEvent(e);
      },
      controller.signal,
      confirm
    );
    clearLine();
    console.log(chalk.gray('  modelo: ' + result.modelUsed));
    console.log(chalk.bold('\n[Done]'));
    if (!result.text) console.log(chalk.gray('(sem texto de resposta)'));
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
  console.log(chalk.green('Contexto limpo (sessao reiniciada).'));
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
  console.log('  /help      Mostrar estes comandos');
  console.log('  sair | exit | :q');
  console.log('  Qualquer outro texto vira um pedido para o agente.');
  console.log('');
  console.log(chalk.bold('Autocomplete'));
  console.log('  Digite e veja a sugestao em cinza. Enter aceita a 1a sugestao, Tab completa,');
  console.log('  Ctrl+U limpa, Ctrl+C sai.');
}

async function handleSlash(raw: string): Promise<void> {
  const [cmd] = raw.trim().split(/\s+/);
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
    case '/help':
      printHelp();
      break;
    default:
      console.log(chalk.gray('Comando desconhecido. Use /help.'));
  }
}

const COMMANDS: string[] = ['/provider', '/model', '/status', '/contexto', '/memoria', '/limpar', '/help', 'sair', 'exit'];

function suggestCommands(buf: string): Suggestion[] {
  const b = buf.trim().toLowerCase();
  if (!b) return [];
  return COMMANDS.filter((c) => c.toLowerCase().startsWith(b)).map((c) => ({
    display: c,
    value: c,
  }));
}

async function main(): Promise<void> {
  const oneShot = process.argv.slice(2).join(' ');
  if (oneShot) {
    await handleTask(oneShot);
    return;
  }

  const c = await loadConfig();
  console.log(chalk.bold.cyan('master-code') + ' — agente de codigo via NVIDIA NIM');
  console.log(
    chalk.gray('Modelo: ' + describeModel(c) + '  |  API key: ' + maskKey(c.provider.apiKey))
  );
  console.log(chalk.gray('Comandos: /provider /model /status /help | sair para sair'));
  console.log('');

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
