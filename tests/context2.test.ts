import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { ContextManager } from '../src/context/manager.js';
import { HeuristicTokenCounter } from '../src/context/tokenCounter.js';
import { InMemorySessionStorage } from '../src/context/storage.js';
import { FakeSummarizer } from '../src/context/summarizer.js';
import { KeywordRetriever } from '../src/context/retriever.js';
import { TokenBudget } from '../src/context/budget.js';
import { FileContextCache } from '../src/context/fileContext.js';
import { detectTaskKind } from '../src/context/taskState.js';

const COUNTER = new HeuristicTokenCounter(4);

function makeManager(opts: { window?: number; ratio?: number } = {}): ContextManager {
  return new ContextManager({
    sessionId: 'test2',
    tokenCounter: COUNTER,
    summarizer: new FakeSummarizer(),
    retriever: new KeywordRetriever(),
    storage: new InMemorySessionStorage(),
    projectRoot: os.tmpdir(),
    windowTokens: opts.window ?? 16000,
    compactRatio: opts.ratio ?? 0.75,
  });
}

test('8. memoria do projeto persiste e prioriza fatos', async () => {
  const m = makeManager();
  assert.equal(m.memory.size, 0, 'comeca vazio');
  m.remember('decisao', 'Usamos SQLite como banco', { tags: ['sqlite'], priority: 'high' });
  m.remember('decisao', 'Usamos PostgreSQL como banco', { tags: ['postgres'], priority: 'high' });
  m.remember('nota', 'Testes rodam com node --import tsx', { priority: 'low' });
  assert.equal(m.memory.size, 3);
  const all = m.memory.all();
  assert.equal(all[0].category, 'decisao', 'alta prioridade vem primeiro');
});

test('9. addReplacing remove fatos equivalentes antigos', async () => {
  const m = makeManager();
  m.remember('decisao', 'Porta padrao 3000', { tags: ['porta'] });
  m.remember('decisao', 'Porta padrao 8080', { tags: ['porta'] });
  const porta = m.memory.byCategory('decisao').filter((f) => f.tags.includes('porta'));
  assert.equal(porta.length, 1, 'so a decisao mais recente permanece');
  assert.ok(porta[0].content.includes('8080'));
});

test('10. estado da tarefa rastreia progresso', async () => {
  const m = makeManager();
  m.startTask('Corrigir bug do login');
  assert.equal(m.taskState!.kind, 'bugfix', 'tipo detectado do objetivo');
  assert.deepEqual(m.taskState!.pending, ['Corrigir bug do login']);
  m.completeSubtask('Corrigir bug do login');
  assert.ok(m.taskState!.completed.includes('Corrigir bug do login'));
  m.noteFile('src/auth.ts');
  m.noteError('lint falhou');
  assert.ok(m.taskState!.files.includes('src/auth.ts'));
  assert.equal(m.taskState!.errors.length, 1);
  const text = m.taskState ? `${m.taskState.objective} ${m.taskState.kind}` : '';
  assert.ok(text.includes('bug'), 'objetivo preservado');
});

test('11. recuperacao semantica sobre memoria e conhecimento', async () => {
  const m = makeManager();
  m.addKnowledge('Estrutura do projeto:\n src/app/controlador.ts', 0.5, ['estrutura']);
  m.remember('api', 'O endpoint /api/usuarios usa JWT para autenticacao', {
    tags: ['jwt', 'api'],
    priority: 'high',
  });
  const hits = await m.recall('autenticacao jwt', 3);
  assert.ok(hits.length > 0, 'recuperou algo');
  assert.ok(hits.some((h) => /jwt|autenticacao/i.test(h.text)), 'encontrou fato de jwt');
  assert.ok(hits.every((h) => typeof h.reason === 'string' && h.reason.length > 0), 'tem razao de match');
});

test('12. buildMessages inclui memoria, estado e recuperacao', async () => {
  const m = makeManager();
  m.startTask('Adicionar exportacao CSV');
  m.remember('decisao', 'Usamos csv-parse para o export', { tags: ['csv'], priority: 'high' });
  m.addUserMessage('preciso exportar os dados');
  m.addAssistantMessage('vou usar csv-parse');
  const msgs = await m.buildMessages('exportacao csv');
  const asText = msgs.map((x) => x.content ?? '').join('\n');
  assert.ok(asText.includes('[memoria:decisao]'), 'memoria incluida');
  assert.ok(asText.includes('estado da tarefa'), 'estado da tarefa incluido');
  assert.ok(asText.includes('[contexto recuperado'), 'recuperacao seletiva incluida');
});

test('13. continuidade apos compactacao com estado de tarefa', async () => {
  const m = makeManager({ window: 700, ratio: 0.7 });
  m.startTask('Refatorar modulo de pagamento');
  for (let i = 0; i < 40; i++) {
    m.addUserMessage(`passo ${i} ${'x'.repeat(50)}`);
    m.addAssistantMessage(`feito ${i} ${'x'.repeat(50)}`);
  }
  const compacted = await m.compactIfNeeded();
  assert.equal(compacted, true);
  assert.ok(m.continuity, 'continuidade criada');
  assert.ok(m.continuity!.summary.length > 0);
  const msgs = await m.buildMessages();
  const asText = msgs.map((x) => x.content ?? '').join('\n');
  assert.ok(asText.includes('[continuidade da tarefa]'), 'continuidade nas mensagens');
  assert.ok(asText.includes('Refatorar modulo de pagamento'), 'objetivo preservado');
});

test('14. persistencia salva memoria, tarefa e continuidade', async () => {
  const storage = new InMemorySessionStorage();
  const mk = () =>
    new ContextManager({
      sessionId: 'persist2',
      tokenCounter: COUNTER,
      summarizer: new FakeSummarizer(),
      retriever: new KeywordRetriever(),
      storage,
      projectRoot: os.tmpdir(),
      windowTokens: 16000,
      compactRatio: 0.75,
    });
  const m1 = mk();
  m1.startTask('Criar modulo de relatorios');
  m1.remember('decisao', 'Relatorios em PDF', { tags: ['pdf'] });
  await m1.persist();
  const m2 = mk();
  await m2.load();
  assert.equal(m2.taskState!.objective, 'Criar modulo de relatorios');
  assert.equal(m2.memory.size, 1);
  assert.ok(m2.memory.all()[0].content.includes('PDF'));
});

test('15. orcamento de tokens calcula reserva e relatorio', () => {
  const b = new TokenBudget(COUNTER, { windowTokens: 16000, reserveResponseRatio: 0.15 });
  assert.equal(b.availableForContext, 13600);
  b.add('objetivo', 'fazer algo'.repeat(20));
  assert.ok(b.used > 0);
  const r = b.report();
  assert.equal(r.total, 13600);
  assert.equal(r.parts[0].label, 'objetivo');
  const fmt = b.formatBudget();
  assert.ok(fmt.includes('objetivo'));
});

test('16. cache de arquivos invalida por mtime', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mccache-'));
  const file = path.join(dir, 'a.ts');
  try {
    await writeFile(file, 'const x = 1;', 'utf8');
    const cache = new FileContextCache();
    const e1 = await cache.getOrRead(file, COUNTER);
    assert.ok(e1, 'leu arquivo');
    assert.ok(e1!.content.includes('const x'));
    const e2 = await cache.getOrRead(file, COUNTER);
    assert.equal(e2, e1, 'segunda leitura usa cache');
    await new Promise((r) => setTimeout(r, 15));
    await writeFile(file, 'const x = 2; // alterado', 'utf8');
    const e3 = await cache.getOrRead(file, COUNTER);
    assert.notEqual(e3, e1, 'conteudo mudou -> invalida cache');
    assert.ok(e3!.content.includes('alterado'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('17. cache de arquivos respeita limites e LRU', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mccache2-'));
  try {
    const cache = new FileContextCache({ maxEntries: 2, totalTokenLimit: 100000 });
    const f1 = path.join(dir, '1.txt');
    const f2 = path.join(dir, '2.txt');
    const f3 = path.join(dir, '3.txt');
    await writeFile(f1, 'aaaa', 'utf8');
    await writeFile(f2, 'bbbb', 'utf8');
    await writeFile(f3, 'cccc', 'utf8');
    await cache.getOrRead(f1, COUNTER);
    await cache.getOrRead(f2, COUNTER);
    await cache.getOrRead(f3, COUNTER);
    assert.equal(cache.count, 2, 'estourou o limite de entradas');
    assert.ok(cache.list().some((e) => e.path === f2), 'mantem os mais recentes');
    assert.ok(cache.list().some((e) => e.path === f3));
    assert.ok(!cache.list().some((e) => e.path === f1), 'LRU removido');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('18. deteccao de tipo de tarefa', () => {
  assert.equal(detectTaskKind('corrigir o bug do carrinho'), 'bugfix');
  assert.equal(detectTaskKind('explique como funciona o auth'), 'explain');
  assert.equal(detectTaskKind('crie uma tela de login'), 'feature');
  assert.equal(detectTaskKind('rode os testes do modulo'), 'test');
  assert.equal(detectTaskKind('qualquer coisa'), 'general');
});

test('19. contexto vazio buildMessages funciona sem memoria', async () => {
  const m = makeManager();
  const msgs = await m.buildMessages('algo');
  assert.ok(msgs.length > 0);
  assert.equal(msgs[0].role, 'system');
});

test('20. reset limpa memoria, tarefa e cache', async () => {
  const m = makeManager();
  m.startTask('Tarefa x');
  m.remember('decisao', 'algo', {});
  await m.reset();
  assert.equal(m.memory.size, 0);
  assert.equal(m.taskState, null);
  assert.equal(m.objective, null);
});

test('21. hidratacao de conhecimento so le a estrutura do projeto, sem arquivos-chave', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mckey-'));
  try {
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "app-python"', 'utf8');
    await writeFile(path.join(dir, 'go.mod'), 'module github.com/example/app', 'utf8');
    await writeFile(path.join(dir, 'Cargo.toml'), '[package]\nname = "app-rust"', 'utf8');
    await writeFile(path.join(dir, 'Gemfile'), 'source "https://rubygems.org"', 'utf8');
    await writeFile(path.join(dir, 'pom.xml'), '<project></project>', 'utf8');
    await writeFile(path.join(dir, 'Dockerfile'), 'FROM node:20', 'utf8');
    await writeFile(path.join(dir, 'README.md'), '# Meu projeto', 'utf8');
    const m = new ContextManager({
      sessionId: 'keyfiles',
      tokenCounter: COUNTER,
      summarizer: new FakeSummarizer(),
      retriever: new KeywordRetriever(),
      storage: new InMemorySessionStorage(),
      projectRoot: dir,
      windowTokens: 16000,
      compactRatio: 0.75,
    });
    const added = await m.hydrateProjectKnowledge();
    assert.equal(added, 1, 'hidratou somente a arvore de estrutura');
    const allText = m.entries.map((e) => e.message.content ?? '').join('\n');
    assert.ok(allText.includes('Estrutura do projeto'), 'inclui a arvore');
    assert.ok(!allText.includes('app-python'), 'nao incluiu conteudo do pyproject.toml');
    assert.ok(!allText.includes('github.com/example/app'), 'nao incluiu conteudo do go.mod');
    assert.ok(!allText.includes('FROM node:20'), 'nao incluiu conteudo do Dockerfile');
    assert.ok(!allText.includes('Meu projeto'), 'nao incluiu conteudo do README');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
