import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { runTask, CancelledError } from '../src/agent.js';
import type { AgentEvent } from '../src/events/types.js';
import { ContextManager } from '../src/context/manager.js';
import { HeuristicTokenCounter } from '../src/context/tokenCounter.js';
import { InMemorySessionStorage } from '../src/context/storage.js';
import { FakeSummarizer } from '../src/context/summarizer.js';
import { KeywordRetriever } from '../src/context/retriever.js';
import { TraceStore } from '../src/events/trace.js';
import { streamCompletion } from '../src/streaming.js';
import { deriveToolReason } from '../src/events/reason.js';
import type { AppConfig } from '../src/config.js';

const COUNTER = new HeuristicTokenCounter(4);

function makeManager(opts: { window?: number; ratio?: number } = {}): ContextManager {
  return new ContextManager({
    sessionId: 'stream-test',
    tokenCounter: COUNTER,
    summarizer: new FakeSummarizer(),
    retriever: new KeywordRetriever(),
    storage: new InMemorySessionStorage(),
    projectRoot: os.tmpdir(),
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

function usageChunk(p: number, c: number, t: number): any {
  return { usage: { prompt_tokens: p, completion_tokens: c, total_tokens: t } };
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

function makeClient(steps: FakeStep[]): {
  client: any;
  calls: Array<{ stream: boolean }>;
} {
  const calls: Array<{ stream: boolean }> = [];
  const create = async (body: any) => {
    calls.push({ stream: body.stream === true });
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
  return mkdtempSync(path.join(os.tmpdir(), 'mc-stream-'));
}

function textOf(e: AgentEvent): string {
  return (e as any).text ?? '';
}

test('1. EventBus on/onAny/off/emit', () => {
  const bus = new EventBus();
  const got: string[] = [];
  const offT = bus.on('text_delta', (e) => got.push('t:' + e.text));
  bus.onAny((e) => got.push('any:' + e.type));
  bus.emit({ type: 'text_delta', text: 'a' });
  offT();
  bus.emit({ type: 'text_delta', text: 'b' });
  assert.deepEqual(got, ['t:a', 'any:text_delta', 'any:text_delta']);
});

test('2. streaming de texto emite text_delta e retorna o texto final', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const fake = makeClient([
    { kind: 'stream', gen: genStream([textChunk('Ola '), textChunk('mundo'), finishChunk('stop'), usageChunk(10, 5, 15)]) },
  ]);
  const result = await runTask('responda ola', {
    bus,
    deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
  });
  assert.equal(result.text, 'Ola mundo');
  const deltas = events.filter((e) => e.type === 'text_delta');
  assert.ok(deltas.length >= 2, 'deltas emitidos em fluxo');
  assert.equal(deltas.map(textOf).join(''), 'Ola mundo');
  assert.ok(events.some((e) => e.type === 'task_start'));
  assert.ok(events.some((e) => e.type === 'plan'));
  assert.ok(events.some((e) => e.type === 'usage'));
  assert.ok(events.some((e) => e.type === 'task_end' && e.status === 'ok'));
});

test('3. tool call com argumentos fragmentados acumula JSON valido', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const dir = tempDir();
  try {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'conteudo X');
    const p = JSON.stringify({ path: file });
    const frags = [p.slice(0, 6), p.slice(6, 14), p.slice(14)];
    const fake = makeClient([
      {
        kind: 'stream',
        gen: genStream([
          toolStartChunk(0, 'call_1', 'read_file'),
          toolArgsChunk(0, frags[0]),
          toolArgsChunk(0, frags[1]),
          toolArgsChunk(0, frags[2]),
          finishChunk('tool_calls'),
        ]),
      },
      { kind: 'stream', gen: genStream([textChunk('li o arquivo'), finishChunk('stop')]) },
    ]);
    const result = await runTask('leia o arquivo', {
      bus,
      deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
    });
    assert.equal(result.text, 'li o arquivo');
    const starts = events.filter((e) => e.type === 'tool_call_start');
    assert.equal(starts.length, 1);
    const call = (starts[0] as any).call;
    assert.equal(call.tool, 'read_file');
    assert.equal(call.args.path, file);
    assert.ok(call.reason.includes('analisar'), 'motivo operacional presente');
    assert.ok(call.reason.includes('etapa'), 'motivo cita a etapa da tarefa');
    const argsEvents = events.filter((e) => e.type === 'tool_call_args');
    assert.ok(argsEvents.length >= 3, 'argumentos emitidos em fragmentos');
    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 1);
    assert.equal((results[0] as any).call.status, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('4. multiplas tool calls nao sobrescrevem argumentos (ids e acumulacao)', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const dir = tempDir();
  try {
    const p1 = path.join(dir, 'a.txt');
    const p2 = path.join(dir, 'b.txt');
    writeFileSync(p1, 'aaa');
    writeFileSync(p2, 'bbb');
    const args0 = JSON.stringify({ path: p1 });
    const args1 = JSON.stringify({ path: dir });
    const fake = makeClient([
      {
        kind: 'stream',
        gen: genStream([
          toolStartChunk(0, 'call_1', 'read_file'),
          toolStartChunk(1, 'call_2', 'list_dir'),
          toolArgsChunk(0, args0.slice(0, 6)),
          toolArgsChunk(1, args1.slice(0, 6)),
          toolArgsChunk(0, args0.slice(6)),
          toolArgsChunk(1, args1.slice(6)),
          finishChunk('tool_calls'),
        ]),
      },
      { kind: 'stream', gen: genStream([textChunk('feito'), finishChunk('stop')]) },
    ]);
    const result = await runTask('t', {
      bus,
      deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
    });
    assert.equal(result.text, 'feito');
    const starts = events.filter((e) => e.type === 'tool_call_start');
    assert.equal(starts.length, 2);
    const ids = (starts as any[]).map((s) => s.call.id);
    assert.equal(new Set(ids).size, 2, 'ids distintos por chamada');
    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 2);
    const c1 = (starts as any[]).find((s) => s.call.tool === 'read_file').call;
    const c2 = (starts as any[]).find((s) => s.call.tool === 'list_dir').call;
    assert.equal(c1.args.path, p1, 'args da chamada 0 intactos');
    assert.equal(c2.args.path, dir, 'args da chamada 1 intactos');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('5. erro de ferramenta emite tool_result com status error (nao fatal)', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const dir = tempDir();
  try {
    const missing = path.join(dir, 'nao-existe.txt');
    const fake = makeClient([
      {
        kind: 'stream',
        gen: genStream([toolStartChunk(0, 'c1', 'read_file'), toolArgsChunk(0, JSON.stringify({ path: missing })), finishChunk('tool_calls')]),
      },
      { kind: 'stream', gen: genStream([textChunk('nao encontrei'), finishChunk('stop')]) },
    ]);
    const result = await runTask('t', {
      bus,
      deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
    });
    assert.equal(result.text, 'nao encontrei');
    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 1);
    assert.equal((results[0] as any).call.status, 'error');
    assert.ok(((results[0] as any).call.result as string).includes('error'));
    assert.ok(events.some((e) => e.type === 'task_end' && e.status === 'ok'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('6. retry visivel em erro transitorio (429)', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const fake = makeClient([
    { kind: 'error', err: { status: 429, message: 'rate limit' } },
    { kind: 'stream', gen: genStream([textChunk('ok apos retry'), finishChunk('stop')]) },
  ]);
  const result = await runTask('t', {
    bus,
    deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
  });
  assert.equal(result.text, 'ok apos retry');
  const retries = events.filter((e) => e.type === 'retry');
  assert.equal(retries.length, 1);
  assert.equal((retries[0] as any).attempt, 2);
});

test('7. cancelamento via AbortSignal lanca CancelledError', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    runTask('t', {
      bus,
      signal: ac.signal,
      deps: { client: makeClient([]).client, ctx: makeManager(), config: makeConfig() },
    }),
    CancelledError
  );
  assert.ok(events.some((e) => e.type === 'task_end' && e.status === 'cancelled'));
});

test('8. abort durante execucao de ferramenta interrompe a tarefa', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const dir = tempDir();
  try {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'x');
    const ac = new AbortController();
    bus.on('tool_call_start', () => ac.abort());
    const fake = makeClient([
      {
        kind: 'stream',
        gen: genStream([toolStartChunk(0, 'c1', 'read_file'), toolArgsChunk(0, JSON.stringify({ path: file })), finishChunk('tool_calls')]),
      },
    ]);
    await assert.rejects(
      runTask('t', {
        bus,
        signal: ac.signal,
        deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
      }),
      CancelledError
    );
    assert.ok(events.some((e) => e.type === 'task_end' && e.status === 'cancelled'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('9. chamada duplicada gera warning e entra no trace', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const trace = new TraceStore();
  trace.attach(bus);
  const dir = tempDir();
  try {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'x');
    const fake = makeClient([
      {
        kind: 'stream',
        gen: genStream([toolStartChunk(0, 'c1', 'read_file'), toolArgsChunk(0, JSON.stringify({ path: file })), finishChunk('tool_calls')]),
      },
      {
        kind: 'stream',
        gen: genStream([toolStartChunk(0, 'c2', 'read_file'), toolArgsChunk(0, JSON.stringify({ path: file })), finishChunk('tool_calls')]),
      },
      { kind: 'stream', gen: genStream([textChunk('fim'), finishChunk('stop')]) },
    ]);
    await runTask('t', {
      bus,
      deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
    });
    const warnings = events.filter((e) => e.type === 'warning' && e.message.includes('duplicada'));
    assert.equal(warnings.length, 1, 'apenas 1 aviso de duplicada');
    assert.ok(trace.summary().duplicateCount >= 1);
    assert.ok(trace.render().includes('Rastro da sessao'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('10. provider sem streaming usa fallback de resposta completa', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const fake = makeClient([
    { kind: 'error', err: new Error('streaming nao suportado') },
    {
      kind: 'full',
      full: {
        choices: [{ message: { role: 'assistant', content: 'resposta completa' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
    },
  ]);
  const result = await runTask('t', {
    bus,
    deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
  });
  assert.equal(result.text, 'resposta completa');
  assert.equal(fake.calls[0].stream, true, 'tentou streaming primeiro');
  assert.equal(fake.calls[1].stream, false, 'caiu para nao-streaming');
  const deltas = events.filter((e) => e.type === 'text_delta');
  assert.equal(deltas.map(textOf).join(''), 'resposta completa');
  assert.ok(events.some((e) => e.type === 'usage'));
});

test('11. fallback processa tool calls da resposta completa', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const dir = tempDir();
  try {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'conteudo');
    const fake = makeClient([
      { kind: 'error', err: new Error('no stream') },
      {
        kind: 'full',
        full: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }],
              },
            },
          ],
        },
      },
      { kind: 'stream', gen: genStream([textChunk('pronto'), finishChunk('stop')]) },
    ]);
    const result = await runTask('t', {
      bus,
      deps: { client: fake.client, ctx: makeManager(), config: makeConfig() },
    });
    assert.equal(result.text, 'pronto');
    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 1);
    assert.equal((results[0] as any).call.tool, 'read_file');
    assert.equal((results[0] as any).call.args.path, file);
    assert.equal((results[0] as any).call.status, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('12. streamCompletion: stream basico com usage', async () => {
  const fake = makeClient([
    { kind: 'stream', gen: genStream([textChunk('ab'), finishChunk('stop'), usageChunk(1, 2, 3)]) },
  ]);
  let text = '';
  let reason = '';
  let usage: any;
  await streamCompletion(
    fake.client as any,
    { model: 'm', messages: [], tools: [] },
    { onText: (t) => (text += t), onFinish: (r) => (reason = r), onUsage: (u) => (usage = u) }
  );
  assert.equal(text, 'ab');
  assert.equal(reason, 'stop');
  assert.deepEqual(usage, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
});

test('13. streamCompletion: retry em 429', async () => {
  const fake = makeClient([
    { kind: 'error', err: { status: 429, message: 'limit' } },
    { kind: 'stream', gen: genStream([textChunk('ok'), finishChunk('stop')]) },
  ]);
  let retries = 0;
  let text = '';
  await streamCompletion(
    fake.client as any,
    { model: 'm', messages: [], tools: [] },
    { onText: (t) => (text += t), onRetry: () => retries++ }
  );
  assert.equal(text, 'ok');
  assert.equal(retries, 1);
});

test('14. streamCompletion: stream_options rejeitado cai para stream simples', async () => {
  const fake = makeClient([
    { kind: 'error', err: { status: 400, message: 'stream_options not supported' } },
    { kind: 'stream', gen: genStream([textChunk('simples'), finishChunk('stop')]) },
  ]);
  let text = '';
  await streamCompletion(fake.client as any, { model: 'm', messages: [], tools: [] }, { onText: (t) => (text += t) });
  assert.equal(text, 'simples');
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].stream, true, 'permanece em streaming sem stream_options');
});

test('15. streamCompletion: erro nao-retryable no inicio faz fallback completo', async () => {
  const fake = makeClient([
    { kind: 'error', err: new Error('streaming nao suportado') },
    { kind: 'full', full: { choices: [{ message: { content: 'full text' } }] } },
  ]);
  let text = '';
  let reason = '';
  await streamCompletion(
    fake.client as any,
    { model: 'm', messages: [], tools: [] },
    { onText: (t) => (text += t), onFinish: (r) => (reason = r) }
  );
  assert.equal(text, 'full text');
  assert.equal(reason, 'stop');
  assert.equal(fake.calls[1].stream, false);
});

test('16. falha persistente do provider produz eventos de erro', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const fake = makeClient([
    { kind: 'error', err: { status: 500 } },
    { kind: 'error', err: { status: 500 } },
    { kind: 'error', err: { status: 500 } },
    { kind: 'error', err: { status: 500 } },
  ]);
  await assert.rejects(
    runTask('t', { bus, deps: { client: fake.client, ctx: makeManager(), config: makeConfig() } })
  );
  assert.ok(events.some((e) => e.type === 'error' && e.fatal));
  assert.ok(events.some((e) => e.type === 'task_end' && e.status === 'error'));
});

test('17. runTask sem bus funciona normalmente', async () => {
  const fake = makeClient([
    { kind: 'stream', gen: genStream([textChunk('sem bus'), finishChunk('stop')]) },
  ]);
  const result = await runTask('t', { deps: { client: fake.client, ctx: makeManager(), config: makeConfig() } });
  assert.equal(result.text, 'sem bus');
});

test('18. integracao com TaskState e ContextManager', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const ctx = makeManager();
  const dir = tempDir();
  try {
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'x');
    const fake = makeClient([
      {
        kind: 'stream',
        gen: genStream([toolStartChunk(0, 'c1', 'read_file'), toolArgsChunk(0, JSON.stringify({ path: file })), finishChunk('tool_calls')]),
      },
      { kind: 'stream', gen: genStream([textChunk('pronto'), finishChunk('stop')]) },
    ]);
    const result = await runTask('corrija o bug do login', {
      bus,
      deps: { client: fake.client, ctx, config: makeConfig() },
    });
    assert.equal(result.text, 'pronto');
    const ts = ctx.getTaskState();
    assert.ok(ts, 'taskState criado');
    assert.equal(ts!.objective, 'corrija o bug do login');
    assert.equal(ts!.kind, 'bugfix');
    assert.ok(ts!.files.includes(file), 'arquivo anotado no taskState');
    assert.ok(ctx.entries.some((e) => e.message.role === 'tool'), 'resultado da ferramenta no contexto');
    assert.ok(events.some((e) => e.type === 'context_update'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('19. compactacao emite eventos start/done', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const ctx = makeManager({ window: 600, ratio: 0.5 });
  const pad = 'x'.repeat(200);
  for (let i = 0; i < 12; i++) {
    ctx.addUserMessage('u' + i + pad);
    ctx.addAssistantMessage('a' + i + pad);
  }
  assert.ok(ctx.wouldCompact, 'contexto acima do limiar');
  const fake = makeClient([
    { kind: 'stream', gen: genStream([textChunk('resposta'), finishChunk('stop')]) },
  ]);
  await runTask('t', { bus, deps: { client: fake.client, ctx, config: makeConfig() } });
  const comp = events.filter((e) => e.type === 'compaction');
  assert.ok(comp.some((e) => e.state === 'start'), 'evento de inicio de compactacao');
  const done = comp.find((e) => e.state === 'done') as any;
  assert.ok(done, 'evento de compactacao concluida');
  assert.ok(done.after < done.before, 'tokens reduzidos apos compactar');
});

test('20. resultado longo e truncado para o contexto', async () => {
  const bus = new EventBus();
  const events = collect(bus);
  const ctx = makeManager();
  const dir = tempDir();
  try {
    const file = path.join(dir, 'big.txt');
    const big = 'linha\n'.repeat(20000);
    writeFileSync(file, big);
    const fake = makeClient([
      {
        kind: 'stream',
        gen: genStream([toolStartChunk(0, 'c1', 'read_file'), toolArgsChunk(0, JSON.stringify({ path: file })), finishChunk('tool_calls')]),
      },
      { kind: 'stream', gen: genStream([textChunk('ok'), finishChunk('stop')]) },
    ]);
    await runTask('t', { bus, deps: { client: fake.client, ctx, config: makeConfig() } });
    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal((results[0] as any).call.resultTruncated, true);
    const toolEntry = ctx.entries.find((e) => e.message.role === 'tool');
    assert.ok(toolEntry, 'entrada da ferramenta no contexto');
    assert.ok((toolEntry!.message.content ?? '').length <= 30015, 'contexto limitado');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('21. TraceStore agrega chamadas, uso e duplicadas', () => {
  const bus = new EventBus();
  const trace = new TraceStore();
  trace.attach(bus);
  bus.emit({
    type: 'tool_call_start',
    call: { id: 'c1', tool: 'read_file', args: { path: 'a.ts' }, argsJson: '', reason: 'x', startedAt: 0 },
  });
  bus.emit({
    type: 'tool_result',
    call: { id: 'c1', tool: 'read_file', args: { path: 'a.ts' }, argsJson: '', startedAt: 0, finishedAt: 10, durationMs: 10, status: 'ok', result: '{}' },
  });
  bus.emit({ type: 'usage', model: 'm', usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 } });
  bus.emit({
    type: 'tool_call_start',
    call: { id: 'c2', tool: 'read_file', args: { path: 'a.ts' }, argsJson: '', reason: 'x', startedAt: 1 },
  });
  bus.emit({
    type: 'tool_result',
    call: { id: 'c2', tool: 'read_file', args: { path: 'a.ts' }, argsJson: '', startedAt: 1, finishedAt: 20, durationMs: 19, status: 'ok', result: '{}' },
  });
  const s = trace.summary();
  assert.equal(s.totalCalls, 2);
  assert.equal(s.totalDurationMs, 29);
  assert.equal(s.usageCount, 1);
  assert.equal(s.usageTotal.totalTokens, 11);
  assert.ok(s.duplicateCount >= 1);
  const rendered = trace.render();
  assert.ok(rendered.includes('Rastro da sessao'));
  assert.ok(rendered.includes('duplicada'));
});

test('22. deriveToolReason usa operacao e etapa atual (sem chain-of-thought)', () => {
  const reason = deriveToolReason('read_file', { path: 'src/a.ts' }, {
    getTaskState: () => ({ pending: ['investigar bug'], nextStep: null }),
  });
  assert.ok(reason.includes('analisar src/a.ts'));
  assert.ok(reason.includes('etapa'));
  assert.ok(reason.length <= 200);
});
