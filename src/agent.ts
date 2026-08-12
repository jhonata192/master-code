import { getClient, listCodingModels } from './llm.js';
import type { ChatMessage } from './llm.js';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { tools, executeTool } from './tools.js';
import type { ConfirmFn } from './tools.js';
import { getContextManager } from './session.js';
import type { ContextManager } from './context/manager.js';
import type { StoredMessage } from './context/types.js';
import { detectIntent } from './context/intent.js';
import { classifyToolResult } from './context/manager.js';
import type { AgentMode } from './modes.js';
import { authorizeTool, toolsForMode } from './modes.js';
import type OpenAI from 'openai';
import { EventBus } from './events/bus.js';
import type { AgentEvent, ToolCall, ToolStatus } from './events/types.js';
import { deriveToolReason } from './events/reason.js';
import { streamCompletion } from './streaming.js';

export type { AgentEvent } from './events/types.js';
export { EventBus } from './events/bus.js';

export interface RunResult {
  text: string;
  modelUsed: string;
  iterations?: number;
}

export interface RunTaskDeps {
  client?: OpenAI;
  ctx?: ContextManager;
  config?: AppConfig;
}

export interface RunTaskOptions {
  signal?: AbortSignal;
  confirm?: ConfirmFn;
  bus?: EventBus;
  deps?: RunTaskDeps;
  intent?: 'casual' | 'question' | 'task';
  mode?: AgentMode;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelado pelo usuario');
    this.name = 'CancelledError';
  }
}

let rotationIndex = 0;

async function pickModel(): Promise<string> {
  const c = await loadConfig();
  if (!c.autoModel) return c.model;
  let pool = c.modelPool;
  if (pool.length === 0) pool = await listCodingModels();
  if (pool.length === 0) return c.model;
  const model = pool[rotationIndex % pool.length];
  rotationIndex++;
  return model;
}

function toOpenAIMessages(msgs: StoredMessage[]): ChatMessage[] {
  return msgs as unknown as ChatMessage[];
}

function toolStatusOf(name: string, result: string): ToolStatus {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(result) as Record<string, unknown>;
  } catch {
    return 'ok';
  }
  if (j.cancelled) return 'cancelled';
  if (j.error !== undefined && j.error !== null) return 'error';
  if (name === 'run_command' && typeof j.exitCode === 'number' && j.exitCode !== 0)
    return 'error';
  return 'ok';
}

export async function runTask(prompt: string, opts: RunTaskOptions = {}): Promise<RunResult> {
  const { signal, confirm, bus } = opts;
  const emit = (e: AgentEvent): void => bus?.emit(e);

  const config = opts.deps?.config ?? (await loadConfig());
  const client = opts.deps?.client ?? (await getClient());
  const model = opts.deps?.config ? config.model : await pickModel();
  const ctx = opts.deps?.ctx ?? (await getContextManager());

  const detected = detectIntent(prompt).intent;
  const isTaskIntent = detected !== 'casual' && detected !== 'question';
  const intent = opts.intent ?? (isTaskIntent ? 'task' : detected);
  const allowTools = intent === 'task';
  const mode = opts.mode ?? ctx.mode;
  const toolset = allowTools ? toolsForMode(mode, tools) : [];

  if (mode === 'plan') {
    emit({ type: 'agent', message: `[mode] ${mode.toUpperCase()}` });
  }

  if (allowTools) {
    ctx.startTask(prompt);
    ctx.addUserMessage(prompt);
    await ctx.persist();

    emit({ type: 'task_start', task: prompt, model });

    const ts = ctx.getTaskState();
    if (ts && ts.subtasks.length > 0) {
      emit({
        type: 'plan',
        steps: ts.subtasks.length,
        summary: ts.subtasks.slice(0, 3).join(' -> '),
      });
      ts.subtasks.forEach((title, i) =>
        emit({ type: 'task_step', index: i + 1, total: ts.subtasks.length, title })
      );
    } else {
      emit({ type: 'plan', steps: 1, summary: prompt });
    }
  } else {
    ctx.addUserMessage(prompt);
    await ctx.persist();
  }

  let iterations = 0;

  try {
    for (; iterations < config.maxIterations; iterations++) {
      if (signal?.aborted) throw new CancelledError();

      if (ctx.wouldCompact) {
        emit({ type: 'compaction', state: 'start', before: ctx.totalTokens });
      }
      const archiveBefore = ctx.archiveCount;
      const tokensBefore = ctx.totalTokens;
      const messages = toOpenAIMessages(await ctx.buildMessages(prompt));
      if (ctx.archiveCount > archiveBefore) {
        emit({ type: 'compaction', state: 'done', before: tokensBefore, after: ctx.totalTokens });
      }

      let textBuf = '';
      const toolAcc: Array<{ id: string; name: string; args: string }> = [];

      try {
        await streamCompletion(
          client,
          { model, messages, tools: toolset },
          {
            onText: (t) => {
              textBuf += t;
              emit({ type: 'text_delta', text: t });
            },
            onToolStart: (index, id, name) => {
              toolAcc[index] = {
                id: id ?? `call_${index}_${Date.now()}`,
                name: name ?? 'unknown',
                args: '',
              };
            },
            onToolArgs: (index, delta) => {
              if (!toolAcc[index]) {
                toolAcc[index] = { id: `call_${index}_${Date.now()}`, name: 'unknown', args: '' };
              }
              toolAcc[index].args += delta;
              emit({ type: 'tool_call_args', callId: toolAcc[index].id, argsDelta: delta });
            },
            onFinish: () => {},
            onUsage: (usage) => emit({ type: 'usage', model, usage }),
            onRetry: (attempt, err) =>
              emit({ type: 'retry', tool: 'modelo', attempt, reason: String(err).slice(0, 120) }),
          },
          signal
        );
      } catch (err) {
        if (signal?.aborted) throw new CancelledError();
        throw err;
      }

      const toolCalls = toolAcc
        .filter((t) => t.name !== 'unknown' && t.name !== '')
        .map((t) => ({
          id: t.id,
          type: 'function' as const,
          function: { name: t.name, arguments: t.args || '{}' },
        }));

      if (allowTools && toolCalls.length > 0) {
        ctx.addMessage(
          {
            role: 'assistant',
            content: textBuf || null,
            tool_calls: toolCalls as StoredMessage['tool_calls'],
          },
          'message',
          0.7
        );

        const calls: ToolCall[] = toolCalls.map((tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            args = {};
          }
          return {
            id: tc.id,
            tool: tc.function.name,
            args,
            argsJson: tc.function.arguments,
            reason: deriveToolReason(tc.function.name, args, ctx),
            startedAt: Date.now(),
          };
        });

        for (const call of calls) {
          if (signal?.aborted) throw new CancelledError();
          const gate = authorizeTool(mode, call.tool, call.args);
          emit({
            type: 'tool_gate',
            mode: mode.toUpperCase(),
            tool: call.tool,
            allowed: gate.allowed,
            reason: gate.reason,
          });
          if (!gate.allowed) {
            ctx.addToolMessage(
              call.tool,
              `[tool-gate] mode=${mode.toUpperCase()} tool=${call.tool} allowed=false${gate.reason ? ` reason=${gate.reason}` : ''}`,
              ['mode', 'bloqueado'],
              'temporary'
            );
            continue;
          }
          emit({ type: 'tool_call_start', call: { ...call } });
          emit({ type: 'tool_call_end', call: { ...call } });

          const raw = await executeTool(call.tool, call.args, signal, confirm);
          if (signal?.aborted) throw new CancelledError();

          const truncated = raw.length > 30000;
          const result = truncated ? raw.slice(0, 30000) + '\n...(truncado)' : raw;
          call.finishedAt = Date.now();
          call.durationMs = call.finishedAt - call.startedAt;
          call.status = toolStatusOf(call.tool, result);
          call.result = result;
          call.resultTruncated = truncated;
          if (call.status === 'error') {
            call.error = result.slice(0, 200);
          }
          emit({ type: 'tool_result', call: { ...call } });

          const tags: string[] = [];
          const disposition = classifyToolResult(call.tool, result);
          const fileArg = typeof call.args.path === 'string' ? call.args.path : null;
          if (fileArg) {
            tags.push('file:' + fileArg);
            ctx.noteActiveFile(fileArg);
          }
          if (call.tool === 'run_command') tags.push('cmd');

          if (call.tool === 'read_file' && fileArg) {
            ctx.graph.upsertNode('file', fileArg);
            ctx.graph.upsertNode('tool', 'read_file');
            void ctx.fileRelations.ensureFile(fileArg);
          }

          if (call.tool === 'search_text') {
            const fileRefs =
              (result.match(/(?:^|[\r\n])([^\r\n:]+)\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|css|vue):\d+:/g) ??
                []).map((m) => m.trim().replace(/^[\r\n:]/, ''));
            for (const f of fileRefs) {
              ctx.graph.upsertNode('file', f);
            }
            void ctx.fileRelations.ensureBuilt();
          }

          if (call.tool === 'write_file' || call.tool === 'edit_file') {
            if (fileArg) {
              ctx.fileCache.invalidate(fileArg).catch(() => {});
              const operation = call.tool === 'write_file' ? 'create' : 'edit';
              const summary =
                call.tool === 'edit_file'
                  ? `Editou ${fileArg} (old_string -> new_string)`
                  : `Criou/sobrescreveu ${fileArg}`;
              ctx.recordChange({
                file: fileArg,
                operation,
                reason: 'mudanca solicitada pelo agente',
                summary,
                tags: ['file', fileArg],
              });
              ctx.remember('alteracao', `Alterado arquivo ${fileArg}`, {
                tags: ['file', fileArg],
                priority: 'high',
              });
            }
          }

          if (call.tool === 'run_command' && disposition === 'critical') {
            const firstLine =
              result
                .split('\n')
                .find((l) => /error|fail|fatal|exception|não encontrad|nao encontrad/i.test(l)) ??
              result.slice(0, 160);
            ctx.recordError({
              message: firstLine.trim().slice(0, 200),
              context: `Comando: ${typeof call.args.command === 'string' ? call.args.command : ''}`,
              file: fileArg ?? null,
              tags: ['cmd', 'erro'],
            });
          }

          ctx.addToolMessage(call.tool, result, tags, disposition);
        }

        await ctx.persist();
        emit({
          type: 'context_update',
          entries: ctx.entryCount,
          tokens: ctx.totalTokens,
          changes: ctx.changeCount,
        });
        continue;
      }

      const text = textBuf ?? '';
      ctx.addAssistantMessage(text);
      await ctx.persist();
      emit({
        type: 'context_update',
        entries: ctx.entryCount,
        tokens: ctx.totalTokens,
        changes: ctx.changeCount,
      });
      emit({ type: 'task_end', status: 'ok', text, model, iterations: iterations + 1 });
      return { text, modelUsed: model, iterations: iterations + 1 };
    }

    throw new Error(`Limite de ${config.maxIterations} iteracoes atingido.`);
  } catch (err) {
    if (signal?.aborted) {
      emit({ type: 'task_end', status: 'cancelled', model, iterations });
      throw new CancelledError();
    }
    emit({ type: 'error', message: String(err), fatal: true });
    emit({ type: 'task_end', status: 'error', error: String(err), model, iterations });
    throw err;
  }
}
