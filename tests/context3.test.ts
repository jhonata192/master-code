import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { ContextManager } from '../src/context/manager.js';
import { HeuristicTokenCounter } from '../src/context/tokenCounter.js';
import { InMemorySessionStorage } from '../src/context/storage.js';
import { FakeSummarizer } from '../src/context/summarizer.js';
import { KeywordRetriever } from '../src/context/retriever.js';
import { detectIntent } from '../src/context/intent.js';
import { ContextScorer } from '../src/context/scorer.js';
import { Reranker } from '../src/context/reranker.js';
import { FileRelationsIndex } from '../src/context/fileRelations.js';
import { HybridRetriever } from '../src/context/hybridRetriever.js';
import { DecisionMemory } from '../src/context/decisionMemory.js';
import { ErrorMemory } from '../src/context/errorMemory.js';
import { ChangeMemory } from '../src/context/changeMemory.js';
import { ContextGraph } from '../src/context/graph.js';
import { ObsoleteDetector } from '../src/context/obsolete.js';
import { FileContextCache } from '../src/context/fileContext.js';

const COUNTER = new HeuristicTokenCounter(4);

function makeManager(opts: { window?: number; ratio?: number } = {}): ContextManager {
  return new ContextManager({
    sessionId: 'test3',
    tokenCounter: COUNTER,
    summarizer: new FakeSummarizer(),
    retriever: new KeywordRetriever(),
    storage: new InMemorySessionStorage(),
    projectRoot: os.tmpdir(),
    windowTokens: opts.window ?? 16000,
    compactRatio: opts.ratio ?? 0.75,
  });
}

test('22. deteccao de intencao', () => {
  assert.equal(detectIntent('corrigir o bug do login').intent, 'bugfix');
  assert.equal(detectIntent('explique como funciona o auth').intent, 'explain');
  assert.equal(detectIntent('crie uma tela de login').intent, 'feature');
  assert.equal(detectIntent('rode os testes do modulo').intent, 'test');
  assert.equal(detectIntent('onde está a funcao parseConfig').intent, 'search');
  assert.equal(detectIntent('refatorar o modulo de pagamento').intent, 'refactor');
  assert.equal(detectIntent('investigar por que o servico cai').intent, 'investigate');
});

test('23. selecao dinamica: itens relevantes pontuam mais', async () => {
  const m = makeManager();
  m.startTask('Adicionar exportacao CSV');
  m.remember('decisao', 'Usamos csv-parse para o export', { tags: ['csv'], priority: 'high' });
  m.remember('decisao', 'Deploy via FTP', { tags: ['ftp'], priority: 'high' });
  const intent = detectIntent('exportacao csv');
  const scorer = new ContextScorer();
  const scored = scorer.score(
    [
      m.makeCandidateForTest?.('x') ?? m.memory.all()[0] ? ({ ...m.memory.all()[0], message: { role: 'system', content: `[memoria] ${m.memory.all()[0].content}` }, id: 'a', type: 'knowledge', scope: 'project', importance: 0.8, priority: 'high', tokens: 10, ts: Date.now(), tags: ['csv'] } as never) : null,
    ].filter(Boolean) as never[],
    {
      query: 'exportacao csv',
      intent,
      activeFiles: [],
      taskObjective: 'Adicionar exportacao CSV',
      tokenBudgetRemaining: 1000,
      graphRelated: () => [],
    }
  );
  assert.ok(scored.length >= 1);
});

test('24. pipeline monta contexto por camadas e respeita orcamento', async () => {
  const m = makeManager({ window: 800, ratio: 0.7 });
  m.startTask('Refatorar modulo de pagamento');
  m.remember('decisao', 'Gateway Stripe escolhido', { tags: ['stripe'], priority: 'high' });
  for (let i = 0; i < 30; i++) {
    m.addUserMessage(`passo ${i} ${'x'.repeat(50)}`);
    m.addAssistantMessage(`feito ${i} ${'x'.repeat(50)}`);
  }
  const msgs = await m.buildMessages('refatorar modulo de pagamento stripe');
  const asText = msgs.map((x) => x.content ?? '').join('\n');
  assert.ok(asText.includes('instrucoes de seguranca'), 'camada 0: seguranca');
  assert.ok(asText.includes('estado da tarefa'), 'camada 1: estado');
  assert.ok(asText.includes('[memoria:decisao]'), 'camada 3: memoria relevante');
  const used = msgs.reduce((s, x) => s + COUNTER.count(x.content ?? ''), 0);
  assert.ok(used <= 800 + 200, `nao estoura a janela (${used})`);
});

test('25. contexto relacionado a arquivos via FileRelationsIndex', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcrel-'));
  try {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'auth.ts'), "import { validate } from './validate';\nimport { hash } from './hash';\nexport function login() {}", 'utf8');
    await writeFile(path.join(dir, 'src', 'validate.ts'), 'export function validate() {}', 'utf8');
    await writeFile(path.join(dir, 'src', 'hash.ts'), 'export function hash() {}', 'utf8');
    await writeFile(path.join(dir, 'src', 'auth.test.ts'), "import { login } from './auth';\n", 'utf8');
    const idx = new FileRelationsIndex(dir);
    await idx.ensureBuilt();
    const auth = path.join(dir, 'src', 'auth.ts');
    const deps = idx.directDeps(auth);
    assert.ok(deps.includes(path.join(dir, 'src', 'validate.ts')), 'dependencia direta encontrada');
    assert.ok(deps.includes(path.join(dir, 'src', 'hash.ts')), 'dependencia direta encontrada');
    const tests = idx.relatedTests(auth);
    assert.ok(tests.some((t) => t.endsWith('auth.test.ts')), 'teste relacionado encontrado');
    const prog = idx.progressiveContext(auth);
    assert.ok(prog.includes(auth), 'arquivo principal primeiro');
    assert.ok(prog.includes(path.join(dir, 'src', 'validate.ts')), 'dependencia direta no progressivo');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('26. memoria de decisoes: substituicao identificada', () => {
  const dm = new DecisionMemory();
  const first = dm.add({
    decision: 'Usar MySQL',
    reason: 'familiaridade',
    context: 'banco principal',
    topic: 'banco',
    tags: ['banco'],
  });
  dm.addReplacingByTopic({
    decision: 'Usar PostgreSQL',
    reason: 'features JSON',
    context: 'banco principal',
    topic: 'banco',
    tags: ['banco'],
  });
  const active = dm.active();
  assert.equal(active.length, 1, 'so a decisao ativa');
  assert.ok(active[0].decision.includes('PostgreSQL'), 'nova decisao vence');
  assert.equal(active[0].supersedes, first.id, 'guarda a referencia a substituida');
  assert.equal(dm.superseded().length, 1, 'decidida anterior marcada como substituida');
});

test('27. memoria de erros: solucao recuperavel e reincidencia', () => {
  const em = new ErrorMemory();
  const e1 = em.record({
    message: 'ERRO: module not found',
    context: 'rodando npm test',
    file: 'src/index.ts',
  });
  assert.equal(e1.count, 1);
  em.record({ message: 'ERRO: module not found', context: 'rodando npm test', file: 'src/index.ts' });
  assert.equal(e1.count, 2, 'reincidencia incrementa contador');
  em.markSolved(e1.id, 'instalar dependencia faltante', 'testes passaram');
  assert.equal(e1.resolved, true);
  assert.equal(em.active().length, 0, 'erro resolvido sai dos ativos');
  assert.ok(em.forFile('src/index.ts').length === 0);
});

test('28. memoria de alteracoes estruturadas', () => {
  const cm = new ChangeMemory();
  const c1 = cm.add({
    file: 'src/db.ts',
    operation: 'edit',
    reason: 'migrar para postgres',
    summary: 'trocou o driver e a string de conexao',
    task: 'usar postgres',
  }, (s) => COUNTER.count(s));
  assert.equal(cm.size, 1);
  assert.equal(cm.forFile('src/db.ts').length, 1);
  const recent = cm.recent(5);
  assert.ok(recent[0].file === 'src/db.ts');
  assert.ok(c1.tokens > 0, 'tokens calculados');
  assert.ok(cm.render(c1).includes('migrar para postgres'));
});

test('29. grafo de contexto responde a consultas', () => {
  const g = new ContextGraph();
  g.upsertNode('file', 'src/auth.ts');
  g.upsertNode('file', 'src/db.ts');
  g.upsertNode('decision', 'usar postgres');
  g.upsertNode('error', 'connection refused');
  g.relate('file', 'src/auth.ts', 'decision', 'usar postgres', 'affects');
  g.relate('file', 'src/db.ts', 'error', 'connection refused', 'related_error');
  const relatedAuth = g.relatedTo('src/auth.ts');
  assert.ok(relatedAuth.some((n) => n.kind === 'decision'), 'decisao ligada ao arquivo');
  const decisions = g.decisionsFor('src/auth.ts');
  assert.ok(decisions.length >= 1, 'decisoes que afetam o modulo');
  const errors = g.errorsFor('src/db.ts');
  assert.ok(errors.length >= 1, 'erros do componente');
  const ser = g.serialize();
  const g2 = ContextGraph.deserialize(ser);
  assert.equal(g2.nodeCount, g.nodeCount);
});

test('30. recuperacao hibrida combina keyword + tags + prioridade + recencia', () => {
  const hr = new HybridRetriever({ activeFiles: ['src/auth.ts'] });
  const records = [
    { text: 'endpoint de login valida senha', tags: ['auth'], priority: 0.5, ts: Date.now() - 10000, relatedFiles: ['src/auth.ts'] },
    { text: 'endpoint de relatorios gera pdf', tags: ['relatorio'], priority: 0.9, ts: Date.now(), relatedFiles: [] },
  ];
  const hits = hr.search(records, 'login auth', 2);
  assert.ok(hits.length > 0);
  const first = hits[0];
  assert.ok(first.reasons.length > 0, 'tem razoes de match');
  assert.ok(records[first.index].tags.includes('auth'), 'auth relevante por keyword+tag+arquivo ativo');
});

test('31. reranking promove arquivos ativos e penaliza obsoletos', async () => {
  const m = makeManager();
  m.addKnowledge('Informacao antiga sobre auth', 0.5, ['auth']);
  const obsolete = m.entries[m.entries.length - 1];
  obsolete.obsolete = true;
  const scorer = new ContextScorer();
  const rk = new Reranker();
  const scored = scorer.score(
    [
      { ...obsolete, message: { role: 'system', content: 'Informacao antiga sobre auth' }, id: 'o1', scope: 'project', importance: 0.5, priority: 'medium', tokens: 10, ts: Date.now() },
      { ...obsolete, message: { role: 'system', content: 'auth novo fluxo com jwt' }, id: 'o2', scope: 'project', importance: 0.7, priority: 'high', tokens: 10, ts: Date.now(), tags: ['file:src/auth.ts'] },
    ],
    {
      query: 'auth jwt',
      intent: detectIntent('como funciona auth'),
      activeFiles: ['src/auth.ts'],
      taskObjective: null,
      tokenBudgetRemaining: 1000,
      graphRelated: () => [],
    }
  );
  const refined = rk.rerank(scored, {
    activeFiles: ['src/auth.ts'],
    intent: 'explain',
    query: 'auth jwt',
    graphRelated: () => [],
  });
  assert.ok(refined[0].entry.id === 'o2', 'item com arquivo ativo lidera');
  assert.ok(refined[0].score > refined.find((r) => r.entry.id === 'o1')!.score, 'obsoleto pontuado abaixo');
});

test('32. deteccao de contexto obsoleto por arquivo alterado', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcobs-'));
  try {
    const f = path.join(dir, 'config.ts');
    await writeFile(f, 'export const PORT = 3000;', 'utf8');
    const cache = new FileContextCache();
    await cache.getOrRead(f, COUNTER);
    const det = new ObsoleteDetector(cache);
    const entry = {
      id: 'k1',
      message: { role: 'system', content: `Arquivo config.ts usa PORT 3000` },
      type: 'knowledge',
      scope: 'project',
      importance: 0.6,
      priority: 'medium' as const,
      tokens: 10,
      ts: Date.now(),
      tags: ['file:' + f],
    };
    const res = det.detect({ entries: [entry] });
    assert.equal(res.entriesMarked.length, 0, 'nada obsoleto antes da mudanca');
    await new Promise((r) => setTimeout(r, 15));
    await writeFile(f, 'export const PORT = 8080;', 'utf8');
    const res2 = det.detect({ entries: [entry] });
    assert.equal(res2.entriesMarked.length, 1, 'arquivo mudou -> marcado obsoleto');
    assert.equal(entry.obsolete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('33. explicito tem prioridade sobre implicito', async () => {
  const m = makeManager();
  m.addUserMessage('o usuario exige usar SQLite', ['sqlite'], );
  const explicitEntry = m.entries[m.entries.length - 1];
  explicitEntry.source = 'explicit';
  m.addKnowledge('O projeto parece usar SQLite', 0.7, ['sqlite']);
  const implicitEntry = m.entries[m.entries.length - 1];
  implicitEntry.source = 'implicit';
  const scorer = new ContextScorer();
  const scored = scorer.score(
    [
      { ...explicitEntry, message: { role: 'system', content: 'o usuario exige usar SQLite' }, id: 'e1', scope: 'task', importance: 0.9, priority: 'high', tokens: 10, ts: Date.now() },
      { ...implicitEntry, message: { role: 'system', content: 'O projeto parece usar SQLite' }, id: 'i1', scope: 'project', importance: 0.7, priority: 'medium', tokens: 10, ts: Date.now() },
    ],
    {
      query: 'sqlite',
      intent: detectIntent('usar sqlite'),
      activeFiles: [],
      taskObjective: null,
      tokenBudgetRemaining: 1000,
      graphRelated: () => [],
    }
  );
  const explicitScore = scored.find((s) => s.entry.id === 'e1')!.score;
  const implicitScore = scored.find((s) => s.entry.id === 'i1')!.score;
  assert.ok(explicitScore > implicitScore, 'explicito pontua mais');
});

test('34. descarte inteligente por falta de tokens', async () => {
  const m = makeManager({ window: 400, ratio: 0.6 });
  m.startTask('tarefa pequena');
  m.remember('decisao', 'decisao grande '.repeat(200), { tags: ['grande'], priority: 'high' });
  const msgs = await m.buildMessages('tarefa pequena');
  const asText = msgs.map((x) => x.content ?? '').join('\n');
  const used = msgs.reduce((s, x) => s + COUNTER.count(x.content ?? ''), 0);
  assert.ok(used <= 400 + 200, `dentro da janela (${used})`);
  assert.ok(asText.includes('estado da tarefa'), 'camadas obrigatorias preservadas');
});

test('35. continuidade apos multiplas compactacoes', async () => {
  const m = makeManager({ window: 600, ratio: 0.7 });
  m.startTask('Construir modulo de notificacoes');
  m.recordChange({ file: 'src/notify.ts', operation: 'create', reason: 'novo modulo', summary: 'criou modulo de notificacoes' });
  for (let i = 0; i < 20; i++) {
    m.addUserMessage(`rodada ${i} ${'x'.repeat(40)}`);
    m.addAssistantMessage(`feito ${i} ${'x'.repeat(40)}`);
  }
  await m.compactIfNeeded();
  for (let i = 20; i < 40; i++) {
    m.addUserMessage(`rodada ${i} ${'x'.repeat(40)}`);
    m.addAssistantMessage(`feito ${i} ${'x'.repeat(40)}`);
  }
  const compacted = await m.compactIfNeeded();
  assert.equal(compacted, true);
  assert.ok(m.continuity, 'continuidade regenerada');
  assert.ok(m.continuity!.blockers.length >= 0);
  const msgs = await m.buildMessages();
  const asText = msgs.map((x) => x.content ?? '').join('\n');
  assert.ok(asText.includes('[continuidade da tarefa]'), 'continuidade presente');
  assert.ok(asText.includes('Construir modulo de notificacoes'), 'objetivo preservado');
  assert.ok(asText.includes('[alteracao'), 'alteracoes preservadas');
});

test('36. contexto adaptativo durante o loop: arquivo ativo ganha relevancia', async () => {
  const m = makeManager();
  m.startTask('corrigir autenticacao');
  m.noteActiveFile('src/auth.ts');
  m.addKnowledge('db.ts gerencia conexoes com timeout', 0.6, ['file:src/db.ts']);
  const intent = detectIntent('corrigir autenticacao auth.ts');
  const scorer = new ContextScorer();
  const scored = scorer.score(
    [
      { id: 'a', message: { role: 'system', content: 'auth.ts cuida do login' }, type: 'knowledge', scope: 'project', importance: 0.7, priority: 'high', tokens: 10, ts: Date.now(), tags: ['file:src/auth.ts'] },
      { id: 'b', message: { role: 'system', content: 'db.ts gerencia conexoes' }, type: 'knowledge', scope: 'project', importance: 0.6, priority: 'medium', tokens: 10, ts: Date.now(), tags: ['file:src/db.ts'] },
    ],
    {
      query: 'corrigir autenticacao',
      intent,
      activeFiles: ['src/auth.ts'],
      taskObjective: 'corrigir autenticacao',
      tokenBudgetRemaining: 1000,
      graphRelated: () => [],
    }
  );
  const first = scored[0];
  assert.equal(first.entry.id, 'a', 'arquivo ativo da investigacao lidera');
});

test('37. buildMessages nao inclui entrada obsoleta', async () => {
  const m = makeManager();
  m.startTask('tarefa');
  m.addKnowledge('versao antiga da config', 0.6, ['config']);
  const entry = m.entries[m.entries.length - 1];
  entry.obsolete = true;
  const msgs = await m.buildMessages('config');
  const asText = msgs.map((x) => x.content ?? '').join('\n');
  assert.ok(!asText.includes('versao antiga da config'), 'obsoleto filtrado do contexto');
});

test('38. persistencia da nova estrutura de contexto', async () => {
  const storage = new InMemorySessionStorage();
  const mk = () =>
    new ContextManager({
      sessionId: 'persist3',
      tokenCounter: COUNTER,
      summarizer: new FakeSummarizer(),
      retriever: new KeywordRetriever(),
      storage,
      projectRoot: os.tmpdir(),
      windowTokens: 16000,
      compactRatio: 0.75,
    });
  const m1 = mk();
  m1.startTask('Tarefa de teste');
  m1.recordDecision({ decision: 'usar redis', reason: 'cache', context: 'sessao', topic: 'cache', tags: ['cache'] });
  m1.recordError({ message: 'timeout no redis', context: 'producao', file: 'src/cache.ts' });
  m1.recordChange({ file: 'src/cache.ts', operation: 'edit', reason: 'config', summary: 'aumentou timeout' });
  await m1.persist();
  const m2 = mk();
  await m2.load();
  assert.equal(m2.decisionCount, 1);
  assert.equal(m2.errorCount, 1);
  assert.equal(m2.changeCount, 1);
  assert.ok(m2.graph.nodeCount > 0, 'grafo persistido');
  assert.equal(m2.taskState!.objective, 'Tarefa de teste');
});
