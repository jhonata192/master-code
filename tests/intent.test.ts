import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { runTask } from '../src/agent.js';
import type { AgentEvent } from '../src/events/types.js';
import { ContextManager } from '../src/context/manager.js';
import { HeuristicTokenCounter } from '../src/context/tokenCounter.js';
import { InMemorySessionStorage } from '../src/context/storage.js';
import { FakeSummarizer } from '../src/context/summarizer.js';
import { KeywordRetriever } from '../src/context/retriever.js';
import { detectIntent } from '../src/context/intent.js';
import { ThinkFilter, stripThink } from '../src/streaming.js';
import type { AppConfig } from '../src/config.js';

const COUNTER = new HeuristicTokenCounter(4);

function makeManager(opts: { window?: number; ratio?: number; root?: string } = {}): ContextManager {
  return new ContextManager({
    sessionId: 'intent-test',
    tokenCounter: COUNTER,
    summarizer: new FakeSummarizer(),
    retriever: new KeywordRetriever(),
    storage: new InMemorySessionStorage(),
    projectRoot: opts.root ?? os.tmpdir(),
    windowTokens: opts.window ?? 16000,
    compactRatio: opts.ratio ?? 0.75,
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

interface FakeStep {
  kind: 'stream' | 'error' | 'full';
  gen?: AsyncGenerator<any, void, unknown>;
  err?: unknown;
  full?: any;
}

function makeClient(steps: FakeStep[]): { client: any; calls: Array<{ stream: boolean; tools: unknown[] }> } {
  const calls: Array<{ stream: boolean; tools: unknown[] }> = [];
  const create = async (body: any) => {
    calls.push({ stream: body.stream === true, tools: body.tools ?? [] });
    const step = steps.shift();
    if (!step) throw new Error('fake client sem respostas restantes');
    if (step.kind === 'error') throw step.err;
    if (step.kind === 'full') return step.full;
    return step.gen;
  };
  return { client: { chat: { completions: { create } } }, calls };
}

function collect(bus: EventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  bus.onAny((e) => events.push(e));
  return events;
}

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'mc-intent-'));
}

test('1. detectIntent classifica saudacoes como casual', () => {
  for (const q of ['oi', 'ola', 'oi tudo bem', 'olá, tudo bem?', 'bom dia', 'e ai', 'hey']) {
    assert.equal(detectIntent(q).intent, 'casual', q);
  }
});

test('2. detectIntent classifica agradecimentos e despedidas como casual', () => {
  assert.equal(detectIntent('obrigado').intent, 'casual');
  assert.equal(detectIntent('valeu pela ajuda').intent, 'casual');
  assert.equal(detectIntent('tchau').intent, 'casual');
  assert.equal(detectIntent('ate logo').intent, 'casual');
});

test('3. detectIntent classifica perguntas sobre o agente como question', () => {
  assert.equal(detectIntent('quem é você?').intent, 'question');
  assert.equal(detectIntent('o que você pode fazer?').intent, 'question');
  assert.equal(detectIntent('qual é o seu nome?').intent, 'question');
});

test('4. mensagem casual nao executa ferramentas nem cria tarefa/plano', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const fake = makeClient([
    { kind: 'stream', gen: genStream([textChunk('Oi! Posso ajudar com codigo.'), finishChunk('stop')]) },
  ]);
  const ctx = makeManager();
  const result = await runTask('oi tudo bem', {
    bus,
    intent: 'casual',
    deps: { client: fake.client, ctx, config: makeConfig() },
  });
  assert.ok(result.text.length > 0);
  assert.equal(events.filter((e) => e.type === 'tool_call_start').length, 0, 'nenhuma ferramenta');
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 0);
  assert.equal(events.filter((e) => e.type === 'plan').length, 0, 'sem plano');
  assert.equal(events.filter((e) => e.type === 'task_start').length, 0, 'sem inicio de tarefa');
  assert.equal(fake.calls[0].tools.length, 0, 'tools nao enviadas ao modelo');
});

test('5. mensagem casual nao cria taskState no contexto', async () => {
  const ctx = makeManager();
  const fake = makeClient([
    { kind: 'stream', gen: genStream([textChunk('tudo bem'), finishChunk('stop')]) },
  ]);
  await runTask('oi tudo bem', {
    intent: 'casual',
    deps: { client: fake.client, ctx, config: makeConfig() },
  });
  assert.equal(ctx.getTaskState(), null, 'nenhum estado de tarefa criado');
  assert.equal(ctx.objective, null, 'nenhum objetivo contaminado');
});

test('6. mensagem question responde sem ferramentas', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const fake = makeClient([
    { kind: 'stream', gen: genStream([textChunk('Sou o master-code.'), finishChunk('stop')]) },
  ]);
  const result = await runTask('quem é você?', {
    bus,
    intent: 'question',
    deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
  });
  assert.ok(result.text.includes('master-code'));
  assert.equal(events.filter((e) => e.type === 'tool_call_start').length, 0);
  assert.equal(events.filter((e) => e.type === 'plan').length, 0);
  assert.equal(fake.calls[0].tools.length, 0);
});

test('7. lista de arquivos e intencao de tarefa com ferramenta list_dir', async () => {
  const intent = detectIntent('liste os arquivos do projeto');
  assert.notEqual(intent.intent, 'casual');
  const bus = new EventBus();
  const events = collect(bus);
  const dir = tempDir();
  try {
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    const fake = makeClient([
      {
        kind: 'stream',
        gen: genStream([
          toolStartChunk(0, 'c1', 'list_dir'),
          toolArgsChunk(0, JSON.stringify({ path: dir })),
          finishChunk('tool_calls'),
        ]),
      },
      { kind: 'stream', gen: genStream([textChunk('achei os arquivos'), finishChunk('stop')]) },
    ]);
    const result = await runTask('liste os arquivos do projeto', {
      bus,
      deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
    });
    assert.equal(result.text, 'achei os arquivos');
    const starts = events.filter((e) => e.type === 'tool_call_start');
    assert.equal(starts.length, 1);
    assert.equal((starts[0] as any).call.tool, 'list_dir');
    assert.ok(fake.calls[0].tools.length > 0, 'tools enviadas em tarefa');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('8. git status e tarefa com run_command', async () => {
  const intent = detectIntent('git status');
  assert.notEqual(intent.intent, 'casual');
  const bus = new EventBus();
  const events = collect(bus);
  const fake = makeClient([
    {
      kind: 'stream',
      gen: genStream([
        toolStartChunk(0, 'c1', 'run_command'),
        toolArgsChunk(0, JSON.stringify({ command: 'git status' })),
        finishChunk('tool_calls'),
      ]),
    },
    { kind: 'stream', gen: genStream([textChunk('status ok'), finishChunk('stop')]) },
  ]);
  await runTask('git status', {
    bus,
    deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
  });
  const starts = events.filter((e) => e.type === 'tool_call_start');
  assert.equal(starts.length, 1);
  assert.equal((starts[0] as any).call.tool, 'run_command');
});

test('9. projeto vazio: casual nao injeta conhecimento fantasma no contexto', async () => {
  const dir = tempDir();
  try {
    const ctx = makeManager({ root: dir });
    const msgs = await ctx.buildMessages('oi tudo bem');
    const joined = msgs.map((m) => m.content ?? '').join('\n');
    assert.ok(!joined.includes('Objetivo da tarefa:'), 'sem objetivo fantasma');
    assert.ok(!joined.includes('[Estado da tarefa]'), 'sem estado de tarefa fantasma');
    assert.ok(!joined.includes('Estrutura do projeto:'), 'sem estrutura fantasma');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('10. mensagem de tarefa na mesma sessao inclui estado real', async () => {
  const dir = tempDir();
  try {
    const ctx = makeManager({ root: dir });
    ctx.startTask('corrija o bug do login');
    ctx.addUserMessage('corrija o bug do login');
    const msgs = await ctx.buildMessages('corrija o bug do login');
    const joined = msgs.map((m) => m.content ?? '').join('\n');
    assert.ok(joined.includes('Objetivo da tarefa: corrija o bug do login'));
    assert.ok(joined.includes('[Estado da tarefa]'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('11. raciocinio <think> e removido no streaming', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const fake = makeClient([
    {
      kind: 'stream',
      gen: genStream([
        textChunk('Ola '),
        textChunk('<think>vou analisar o codigo primeiro</think>'),
        textChunk('mundo'),
        finishChunk('stop'),
      ]),
    },
  ]);
  const result = await runTask('oi tudo bem', {
    intent: 'casual',
    bus,
    deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
  });
  assert.equal(result.text, 'Ola mundo');
  const full = events.filter((e) => e.type === 'text_delta').map((e) => (e as any).text).join('');
  assert.equal(full, 'Ola mundo');
  assert.ok(!result.text.includes('</think>'));
  assert.ok(!result.text.includes('<think>'));
});

test('12. raciocinio dividido entre chunks e removido', async () => {
  const f = new ThinkFilter();
  const out = f.push('Ola <thi') + f.push('nk>secreto') + f.push('</thin') + f.push('k>mundo') + f.flush();
  assert.equal(out, 'Ola mundo');
});

test('13. ThinkFilter descarta bloco nao fechado', () => {
  const f = new ThinkFilter();
  const out = f.push('texto ') + f.push('<think>nunca fechou') + f.flush();
  assert.equal(out, 'texto ');
});

test('14. stripThink remove blocos no fallback completo', () => {
  assert.equal(stripThink('Oi <think>raciocinio interno</think>fim'), 'Oi fim');
  assert.equal(stripThink('sem bloco'), 'sem bloco');
  assert.equal(stripThink('a <think>aberto'), 'a ');
});

test('15. fallback nao-streaming remove raciocinio', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const fake = makeClient([
    { kind: 'error', err: new Error('streaming nao suportado') },
    {
      kind: 'full',
      full: {
        choices: [{ message: { role: 'assistant', content: 'Oi <think>interno</think>final' } }],
      },
    },
  ]);
  const result = await runTask('oi tudo bem', {
    intent: 'casual',
    bus,
    deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
  });
  assert.equal(result.text, 'Oi final');
  const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as any).text).join('');
  assert.equal(deltas, 'Oi final');
});

test('16. context_update ainda e emitido e tarefa termina ok', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const fake = makeClient([
    { kind: 'stream', gen: genStream([textChunk('ok'), finishChunk('stop')]) },
  ]);
  await runTask('crie um arquivo', {
    bus,
    deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
  });
  assert.ok(events.some((e) => e.type === 'task_end' && e.status === 'ok'));
  assert.ok(events.some((e) => e.type === 'context_update'));
});
