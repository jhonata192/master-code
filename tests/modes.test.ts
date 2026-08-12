import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { EventBus } from '../src/events/bus.js';
import { runTask } from '../src/agent.js';
import type { AgentEvent } from '../src/events/types.js';
import { ContextManager } from '../src/context/manager.js';
import { HeuristicTokenCounter } from '../src/context/tokenCounter.js';
import { InMemorySessionStorage } from '../src/context/storage.js';
import { FakeSummarizer } from '../src/context/summarizer.js';
import { KeywordRetriever } from '../src/context/retriever.js';
import type { AppConfig } from '../src/config.js';
import {
  switchModeForward,
  switchModeReverse,
  authorizeTool,
  toolsForMode,
  parseDefaultMode,
} from '../src/modes.js';
import { tools } from '../src/tools.js';

const COUNTER = new HeuristicTokenCounter(4);

function makeManager(mode: 'build' | 'plan' = 'build'): ContextManager {
  return new ContextManager({
    sessionId: 'modes-test',
    tokenCounter: COUNTER,
    summarizer: new FakeSummarizer(),
    retriever: new KeywordRetriever(),
    storage: new InMemorySessionStorage(),
    projectRoot: os.tmpdir(),
    windowTokens: 16000,
    compactRatio: 0.75,
    mode,
  });
}

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    provider: { baseUrl: 'http://x', apiKey: 'k' },
    model: 'test-model',
    autoModel: false,
    modelPool: [],
    maxIterations: 5,
    contextWindow: 16000,
    update: {
      enabled: false,
      autoCheck: false,
      autoUpdate: false,
      channel: 'stable',
      checkIntervalHours: 24,
      lastUpdateCheck: null,
      lastKnownVersion: null,
      downloadedVersion: null,
      downloadedFileName: null,
      downloadedPath: null,
      downloadedChecksum: null,
    },
    agent: { defaultMode: 'build' },
    ...over,
  };
}

function textChunk(content: string): any {
  return { choices: [{ delta: { content } }] };
}

function toolStartChunk(index: number, id: string, name: string): any {
  return {
    choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] } }],
  };
}

function toolArgsChunk(index: number, args: string): any {
  return { choices: [{ delta: { tool_calls: [{ index, type: 'function', function: { arguments: args } }] } }] };
}

function finishChunk(reason: string): any {
  return { choices: [{ delta: {}, finish_reason: reason }] };
}

function genStream(chunks: any[]): AsyncGenerator<any, void, unknown> {
  async function* g() {
    for (const c of chunks) yield c;
  }
  return g();
}

function makeClient(steps: any[]): { client: any; calls: Array<{ stream: boolean; tools: unknown[] }> } {
  const calls: Array<{ stream: boolean; tools: unknown[] }> = [];
  const create = async (body: any) => {
    calls.push({ stream: body.stream === true, tools: body.tools ?? [] });
    const step = steps.shift();
    if (!step) throw new Error('fake client sem respostas restantes');
    return step;
  };
  return { client: { chat: { completions: { create } } }, calls };
}

function collect(bus: EventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  bus.onAny((e) => events.push(e));
  return events;
}

test('1. switchModeForward alterna BUILD -> PLAN -> BUILD', () => {
  assert.equal(switchModeForward('build'), 'plan');
  assert.equal(switchModeForward('plan'), 'build');
});

test('2. switchModeReverse alterna PLAN -> BUILD -> PLAN', () => {
  assert.equal(switchModeReverse('plan'), 'build');
  assert.equal(switchModeReverse('build'), 'plan');
});

test('3. parseDefaultMode valida apenas build/plan', () => {
  assert.equal(parseDefaultMode('plan'), 'plan');
  assert.equal(parseDefaultMode('build'), 'build');
  assert.equal(parseDefaultMode('x'), 'build');
  assert.equal(parseDefaultMode(undefined), 'build');
});

test('4. authorizeTool permite tudo no modo BUILD', () => {
  assert.equal(authorizeTool('build', 'edit_file').allowed, true);
  assert.equal(authorizeTool('build', 'run_command', { command: 'rm -rf /' }).allowed, true);
});

test('5. authorizeTool bloqueia escrita no modo PLAN', () => {
  for (const t of ['write_file', 'edit_file', 'patch_file', 'delete_file', 'move_file', 'rename_file']) {
    const r = authorizeTool('plan', t, { path: 'x.ts' });
    assert.equal(r.allowed, false, t);
    assert.ok(r.reason, 'tem motivo');
  }
});

test('6. authorizeTool permite leitura e git read no modo PLAN', () => {
  assert.equal(authorizeTool('plan', 'read_file', { path: 'x.ts' }).allowed, true);
  assert.equal(authorizeTool('plan', 'list_dir', {}).allowed, true);
  assert.equal(authorizeTool('plan', 'search_text', { query: 'foo' }).allowed, true);
  assert.equal(authorizeTool('plan', 'run_command', { command: 'git status' }).allowed, true);
  assert.equal(authorizeTool('plan', 'run_command', { command: 'git diff --stat' }).allowed, true);
  assert.equal(authorizeTool('plan', 'run_command', { command: 'git log --oneline' }).allowed, true);
});

test('7. authorizeTool bloqueia comandos nao-git no modo PLAN', () => {
  assert.equal(authorizeTool('plan', 'run_command', { command: 'npm install' }).allowed, false);
  assert.equal(authorizeTool('plan', 'run_command', { command: 'git push origin main' }).allowed, false);
  assert.equal(authorizeTool('plan', 'run_command', { command: 'node server.js' }).allowed, false);
});

test('8. toolsForMode filtra o registro no modo PLAN', () => {
  const names = toolsForMode('plan', tools).map((t) => t.function.name);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('list_dir'));
  assert.ok(names.includes('search_text'));
  assert.ok(names.includes('run_command'));
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('edit_file'));
});

test('9. toolsForMode mantem tudo no modo BUILD', () => {
  assert.equal(toolsForMode('build', tools).length, tools.length);
});

test('10. runTask em PLAN nao envia ferramentas de escrita ao modelo', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const ctx = makeManager('plan');
  const fake = makeClient([genStream([finishChunk('stop')])]);
  await runTask('analise este projeto e diga como adicionar autenticacao', {
    bus,
    deps: { client: fake.client, ctx, config: makeConfig() },
  });
  const sent = fake.calls[0].tools as Array<{ function: { name: string } }>;
  const sentNames = sent.map((t) => t.function.name);
  assert.ok(!sentNames.includes('write_file'), 'nao envia write_file');
  assert.ok(!sentNames.includes('edit_file'), 'nao envia edit_file');
  assert.ok(sentNames.includes('read_file'), 'envia read_file');
});

test('11. runTask em PLAN bloqueia tool de escrita no Tool Gate', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const ctx = makeManager('plan');
  const fake = makeClient([
    genStream([
      toolStartChunk(0, 'call_1', 'edit_file'),
      toolArgsChunk(0, '{"path":"x.ts","old_string":"a","new_string":"b"}'),
      finishChunk('tool_calls'),
    ]),
    genStream([textChunk('Entendido, nao posso editar no modo PLAN.'), finishChunk('stop')]),
  ]);
  const result = await runTask('edite x.ts', {
    bus,
    deps: { client: fake.client, ctx, config: makeConfig() },
  });
  assert.ok(result.text.includes('PLAN') || result.text.length > 0, 'agente responde sobre a restricao');
  const gateEvents = events.filter((e) => e.type === 'tool_gate') as Array<{
    tool: string;
    allowed: boolean;
  }>;
  assert.ok(gateEvents.length >= 1, 'ha evento tool_gate');
  assert.equal(gateEvents[0].tool, 'edit_file');
  assert.equal(gateEvents[0].allowed, false);
  const executedEdits = events.filter(
    (e) => e.type === 'tool_call_start' && (e as any).call?.tool === 'edit_file'
  );
  assert.equal(executedEdits.length, 0, 'a edicao nao e executada');
});

test('12. runTask em BUILD executa tools normalmente', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const ctx = makeManager('build');
  const fake = makeClient([
    genStream([
      toolStartChunk(0, 'call_1', 'read_file'),
      toolArgsChunk(0, '{"path":"' + os.tmpdir().replace(/\\/g, '/') + '/nada.ts"}'),
      finishChunk('tool_calls'),
    ]),
    genStream([textChunk('Ok.'), finishChunk('stop')]),
  ]);
  await runTask('leia um arquivo', {
    bus,
    deps: { client: fake.client, ctx, config: makeConfig() },
  });
  const gates = events.filter((e) => e.type === 'tool_gate') as Array<{ allowed: boolean }>;
  assert.ok(gates.length >= 1);
  assert.equal(gates[0].allowed, true, 'BUILD permite a ferramenta');
});

test('13. saudacao em PLAN continua sem ferramentas (modo != tarefa)', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const ctx = makeManager('plan');
  const fake = makeClient([genStream([textChunk('Oi!'), finishChunk('stop')])]);
  const result = await runTask('oi tudo bem', {
    bus,
    intent: 'casual',
    deps: { client: fake.client, ctx, config: makeConfig() },
  });
  assert.ok(result.text.length > 0);
  assert.equal(fake.calls[0].tools.length, 0, 'sem ferramentas em qualquer modo');
  assert.equal(events.filter((e) => e.type === 'tool_call_start').length, 0);
});

test('14. modo nao muda automaticamente por nova tarefa', async () => {
  const ctx = makeManager('plan');
  const fake = makeClient([genStream([finishChunk('stop')])]);
  await runTask('uma nova tarefa qualquer', {
    deps: { client: fake.client, ctx, config: makeConfig() },
  });
  assert.equal(ctx.mode, 'plan', 'permanece PLAN');
});

test('15. setMode persiste o modo no contexto', async () => {
  const storage = new InMemorySessionStorage();
  const make = (mode: 'build' | 'plan' = 'build'): ContextManager =>
    new ContextManager({
      sessionId: 'modes-test',
      tokenCounter: COUNTER,
      summarizer: new FakeSummarizer(),
      retriever: new KeywordRetriever(),
      storage,
      projectRoot: os.tmpdir(),
      windowTokens: 16000,
      compactRatio: 0.75,
      mode,
    });
  const ctx = make('build');
  ctx.setMode('plan');
  assert.equal(ctx.mode, 'plan');
  await ctx.persist();
  const ctx2 = make('build');
  await ctx2.load();
  assert.equal(ctx2.mode, 'plan', 'modo restaurado ao carregar');
});
