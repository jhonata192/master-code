import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { ContextManager } from '../src/context/manager.js';
import { HeuristicTokenCounter } from '../src/context/tokenCounter.js';
import { InMemorySessionStorage } from '../src/context/storage.js';
import { FakeSummarizer } from '../src/context/summarizer.js';
import { KeywordRetriever } from '../src/context/retriever.js';
import type { ContextEntry } from '../src/context/types.js';

const COUNTER = new HeuristicTokenCounter(4);

function makeManager(opts: { window?: number; ratio?: number } = {}): ContextManager {
  return new ContextManager({
    sessionId: 'test-session',
    tokenCounter: COUNTER,
    summarizer: new FakeSummarizer(),
    retriever: new KeywordRetriever(),
    storage: new InMemorySessionStorage(),
    projectRoot: os.tmpdir(),
    windowTokens: opts.window ?? 16000,
    compactRatio: opts.ratio ?? 0.75,
  });
}

function pad(n: number, ch = 'x'): string {
  return ch.repeat(n);
}

test('1. crescimento do contexto', async () => {
  const m = makeManager();
  const initial = m.entryCount;
  for (let i = 0; i < 10; i++) {
    m.addUserMessage(`pergunta ${i} ${pad(100)}`);
    m.addAssistantMessage(`resposta ${i} ${pad(100)}`);
  }
  assert.ok(m.entryCount > initial, 'entradas crescem');
  assert.ok(m.totalTokens > 100, 'tokens crescem');
  assert.equal(m.entryCount, initial + 20);
});

test('2. compactacao automatica', async () => {
  const m = makeManager({ window: 800, ratio: 0.7 });
  for (let i = 0; i < 30; i++) {
    m.addUserMessage(`pergunta ${i} ${pad(80)}`);
    m.addAssistantMessage(`resposta ${i} ${pad(80)}`);
  }
  const before = m.totalTokens;
  assert.ok(before > 560, 'ultrapassa o limiar de compactacao');
  const compacted = await m.compactIfNeeded();
  assert.equal(compacted, true, 'compactou');
  assert.ok(m.totalTokens < before, 'tokens reduziram apos compactacao');
  assert.ok(m.archiveCount >= 1, 'criou bloco no arquivo');
  assert.ok(
    m.entries.some((e) => e.type === 'summary'),
    'entrada de resumo criada'
  );
});

test('3. preservacao de informacoes importantes', async () => {
  const m = makeManager({ window: 800, ratio: 0.7 });
  m.setObjective('Corrigir o bug do login no modulo auth');
  for (let i = 0; i < 30; i++) {
    m.addUserMessage(`pergunta ${i} ${pad(80)}`);
    m.addAssistantMessage(`resposta ${i} ${pad(80)}`);
  }
  await m.compactIfNeeded();
  assert.equal(
    m.objective,
    'Corrigir o bug do login no modulo auth',
    'objetivo preservado apos compactacao'
  );
  const summary = m.entries.find((e) => e.type === 'summary');
  assert.ok(summary, 'resumo existe');
  assert.ok(
    (summary!.message.content ?? '').includes('Objetivo preservado'),
    'resumo contem o objetivo'
  );
  assert.ok(
    (summary!.message.content ?? '').includes('Corrigir o bug do login no modulo auth'),
    'resumo mantem texto do objetivo'
  );
});

test('4. recuperacao de contexto antigo', async () => {
  const m = makeManager({ window: 600, ratio: 0.7 });
  m.setObjective('Adicionar suporte a SQLite');
  m.addUserMessage('criar modulo de banco de dados sqlite');
  m.addToolMessage('write_file', 'db.ts criado', ['file:src/db.ts']);
  for (let i = 0; i < 40; i++) {
    m.addUserMessage(`proxima pergunta ${i} ${pad(60)}`);
    m.addAssistantMessage(`seguindo ${i} ${pad(60)}`);
  }
  await m.compactIfNeeded();

  const results = await m.retrieve('sqlite db.ts', 3);
  assert.ok(results.length > 0, 'recuperou resultados');
  const found = results.some((r) => /db\.ts|sqlite/i.test(r.text));
  assert.ok(found, 'resultado contem informacao antiga (db.ts / sqlite)');
});

test('5. continuidade da tarefa apos compactacao', async () => {
  const m = makeManager({ window: 800, ratio: 0.7 });
  m.setObjective('Refatorar a funcao parseConfig');
  for (let i = 0; i < 30; i++) {
    m.addUserMessage(`passo ${i} ${pad(70)}`);
    m.addAssistantMessage(`feito ${i} ${pad(70)}`);
  }
  await m.compactIfNeeded();

  m.addAssistantMessage('Terminei a refatoracao de parseConfig.');
  const msgs = await m.buildMessages();
  const asText = msgs.map((mm) => (mm.content ?? '')).join('\n');

  assert.ok(asText.includes('Refatorar a funcao parseConfig'), 'objetivo presente nas mensagens');
  assert.ok(asText.includes('Terminei a refatoracao de parseConfig.'), 'ultima resposta presente');
  assert.ok(asText.includes('[resumo]'), 'bloco de resumo incluido nas mensagens');
});

test('6. nao ultrapassar desnecessariamente o limite de tokens', async () => {
  const window = 1000;
  const m = makeManager({ window, ratio: 0.7 });
  for (let i = 0; i < 50; i++) {
    m.addUserMessage(`mensagem ${i} ${pad(120)}`);
    m.addAssistantMessage(`resposta ${i} ${pad(120)}`);
  }
  const msgs = await m.buildMessages();
  const used = msgs.reduce((sum, mm) => sum + COUNTER.count(mm.content ?? ''), 0);
  assert.ok(used <= window + 200, `tokens usados ${used} nao estouram a janela (${window})`);
  assert.ok(msgs.length > 0);
});

test('persistencia: salvar e recarregar sessao', async () => {
  const storage = new InMemorySessionStorage();
  const m1 = new ContextManager({
    sessionId: 'persist',
    tokenCounter: COUNTER,
    summarizer: new FakeSummarizer(),
    retriever: new KeywordRetriever(),
    storage,
    projectRoot: os.tmpdir(),
    windowTokens: 16000,
    compactRatio: 0.75,
  });
  m1.setObjective('Manter contexto entre sessoes');
  m1.addUserMessage('primeira pergunta');
  m1.addAssistantMessage('primeira resposta');
  await m1.persist();

  const m2 = new ContextManager({
    sessionId: 'persist',
    tokenCounter: COUNTER,
    summarizer: new FakeSummarizer(),
    retriever: new KeywordRetriever(),
    storage,
    projectRoot: os.tmpdir(),
    windowTokens: 16000,
    compactRatio: 0.75,
  });
  await m2.load();
  assert.equal(m2.objective, 'Manter contexto entre sessoes');
  assert.equal(m2.entryCount, m1.entryCount);
});
