import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { AgentRenderer, parseCliFlags, statusIcon, toolResultSummary } from '../src/render.js';
import type { ToolCall } from '../src/events/types.js';

function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  mock.method(process.stdout, 'write', (s: unknown) => {
    writes.push(String(s));
    return true;
  });
  return { writes, restore: () => mock.restoreAll() };
}

test('1. parseCliFlags separa flags do prompt e aceita caminho', () => {
  const f = parseCliFlags(['--debug', '--quiet', '--debug-json', '/tmp/x.jsonl', 'corrija o bug']);
  assert.equal(f.mode, 'quiet');
  assert.equal(f.debugJsonPath, path.resolve('/tmp/x.jsonl'));
  assert.deepEqual(f.args, ['corrija o bug']);
});

test('2. parseCliFlags gera caminho padrao sem argumento', () => {
  const f = parseCliFlags(['--debug-json', 'explique']);
  assert.ok(f.debugJsonPath);
  assert.ok(f.debugJsonPath!.endsWith('.jsonl'));
  assert.deepEqual(f.args, ['explique']);
  assert.equal(f.mode, 'normal');
});

test('3. renderer modo quiet mostra apenas a resposta final', () => {
  const cap = captureStdout();
  try {
    const bus = new EventBus();
    new AgentRenderer(bus, { mode: 'quiet' });
    bus.emit({ type: 'task_start', task: 't', model: 'm' });
    bus.emit({ type: 'plan', steps: 1, summary: 't' });
    bus.emit({ type: 'text_delta', text: 'resposta ' });
    bus.emit({ type: 'text_delta', text: 'final' });
    bus.emit({ type: 'task_end', status: 'ok', text: 'resposta final', model: 'm', iterations: 1 });
    const joined = cap.writes.join('');
    assert.ok(joined.includes('resposta final'), 'imprime a resposta final');
    assert.ok(!joined.includes('[tool]'), 'nada de ferramentas');
    assert.ok(!joined.includes('[task]'), 'nada de eventos de tarefa');
  } finally {
    cap.restore();
  }
});

test('4. renderer modo normal mostra tool_call_start e tool_result', () => {
  const cap = captureStdout();
  try {
    const bus = new EventBus();
    new AgentRenderer(bus, { mode: 'normal' });
    bus.emit({
      type: 'tool_call_start',
      call: { id: 'c1', tool: 'read_file', args: { path: 'a.ts' }, argsJson: '', reason: 'analisar a.ts', startedAt: 1 },
    });
    bus.emit({
      type: 'tool_result',
      call: {
        id: 'c1',
        tool: 'read_file',
        args: { path: 'a.ts' },
        argsJson: '',
        reason: 'analisar a.ts',
        startedAt: 1,
        finishedAt: 2,
        durationMs: 1,
        status: 'ok',
        result: JSON.stringify({ path: 'a.ts', lines: 3, content: 'x' }),
      },
    });
    const joined = cap.writes.join('');
    assert.ok(joined.includes('[tool] read_file'), 'mostra a chamada');
    assert.ok(joined.includes('3 linhas'), 'mostra resumo do resultado');
    assert.ok(joined.includes('ok') || joined.includes('\u2713'), 'mostra status');
  } finally {
    cap.restore();
  }
});

test('5. renderer modo debug mostra eventos estruturados', () => {
  const cap = captureStdout();
  try {
    const bus = new EventBus();
    new AgentRenderer(bus, { mode: 'debug' });
    bus.emit({
      type: 'tool_call_start',
      call: { id: 'c1', tool: 'read_file', args: { path: 'a.ts' }, argsJson: '', startedAt: 1 },
    });
    bus.emit({ type: 'usage', model: 'm', usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 } });
    const joined = cap.writes.join('');
    assert.ok(joined.includes('tool_call_start'), 'nome do evento no debug');
    assert.ok(joined.includes('read_file'));
    assert.ok(joined.includes('usage'), 'usage visivel no debug');
  } finally {
    cap.restore();
  }
});

test('6. renderer escreve eventos em JSONL quando debugJsonPath definido', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-render-'));
  const p = path.join(dir, 'trace.jsonl');
  try {
    const bus = new EventBus();
    new AgentRenderer(bus, { debugJsonPath: p });
    bus.emit({ type: 'task_start', task: 't', model: 'm' });
    bus.emit({ type: 'text_delta', text: 'x' });
    await new Promise((r) => setTimeout(r, 30));
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const parsed = JSON.parse(lines[0]) as { type: string; ts: number };
    assert.equal(parsed.type, 'task_start');
    assert.ok(typeof parsed.ts === 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('7. renderer mostra warning, retry e erro no modo normal', () => {
  const cap = captureStdout();
  try {
    const bus = new EventBus();
    new AgentRenderer(bus, { mode: 'normal' });
    bus.emit({ type: 'warning', message: 'chamada duplicada' });
    bus.emit({ type: 'retry', tool: 'modelo', attempt: 2, reason: 'rate limit' });
    bus.emit({ type: 'error', message: 'boom' });
    const joined = cap.writes.join('');
    assert.ok(joined.includes('[aviso] chamada duplicada'));
    assert.ok(joined.includes('tentando novamente'));
    assert.ok(joined.includes('[erro] boom'));
  } finally {
    cap.restore();
  }
});

test('8. statusIcon e toolResultSummary formatam estados', () => {
  const call: ToolCall = {
    id: 'c',
    tool: 'run_command',
    args: { command: 'npm test' },
    argsJson: '{}',
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    status: 'error',
    result: JSON.stringify({ exitCode: 1, stdout: '', stderr: 'falhou' }),
  };
  assert.ok(statusIcon('ok').includes('\u2713'));
  assert.ok(statusIcon('error').includes('\u2717'));
  assert.ok(toolResultSummary(call).includes('exit code: 1'));
  const okCall = { ...call, status: 'ok' as const, result: JSON.stringify({ exitCode: 0 }) };
  assert.ok(toolResultSummary(okCall).includes('ok'));
});
