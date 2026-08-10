import { getClient, listCodingModels } from './llm.js';
import type { ChatMessage } from './llm.js';
import { loadConfig } from './config.js';
import { tools, executeTool } from './tools.js';
import type { ConfirmFn } from './tools.js';
import { getContextManager } from './session.js';
import type { StoredMessage } from './context/types.js';
import { classifyToolResult } from './context/manager.js';

export interface AgentEvent {
  type: 'text' | 'tool';
  content: string;
}

export interface RunResult {
  text: string;
  modelUsed: string;
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

export async function runTask(
  prompt: string,
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
  confirm?: ConfirmFn
): Promise<RunResult> {
  const config = await loadConfig();
  const client = await getClient();
  const model = await pickModel();
  const ctx = await getContextManager();

  ctx.startTask(prompt);
  ctx.addUserMessage(prompt);
  await ctx.persist();

  for (let i = 0; i < config.maxIterations; i++) {
    if (signal?.aborted) throw new CancelledError();

    const messages = toOpenAIMessages(await ctx.buildMessages(prompt));

    let res;
    try {
      res = await client.chat.completions.create(
        {
          model,
          messages,
          tools,
          tool_choice: 'auto',
        },
        { signal }
      );
    } catch (err) {
      if (signal?.aborted) throw new CancelledError();
      throw err;
    }

    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('Resposta vazia da API');

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      ctx.addMessage(
        {
          role: 'assistant',
          content: msg.content ?? null,
          tool_calls: msg.tool_calls as StoredMessage['tool_calls'],
        },
        'message',
        0.7
      );
      for (const call of msg.tool_calls) {
        if (signal?.aborted) throw new CancelledError();
        let result: string;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        onEvent({
          type: 'tool',
          content: `[usando ${call.function.name} ${JSON.stringify(args).slice(0, 200)}]`,
        });
        const raw = await executeTool(call.function.name, args, signal, confirm);
        if (signal?.aborted) throw new CancelledError();
        result = raw.length > 30000 ? raw.slice(0, 30000) + '\n...(truncado)' : raw;
        const tags: string[] = [];
        const disposition = classifyToolResult(call.function.name, result);
        const fileArg = typeof args.path === 'string' ? args.path : null;
        if (fileArg) {
          tags.push('file:' + fileArg);
          ctx.noteActiveFile(fileArg);
        }
        if (call.function.name === 'run_command') tags.push('cmd');

        if (call.function.name === 'read_file' && fileArg) {
          ctx.graph.upsertNode('file', fileArg);
          ctx.graph.upsertNode('tool', 'read_file');
          void ctx.fileRelations.ensureFile(fileArg);
        }

        if (call.function.name === 'search_text') {
          const fileRefs = (result.match(/(?:^|[\r\n])([^\r\n:]+)\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|css|vue):\d+:/g) ?? []).map((m) => m.trim().replace(/^[\r\n:]/, ''));
          for (const f of fileRefs) {
            ctx.graph.upsertNode('file', f);
          }
          void ctx.fileRelations.ensureBuilt();
        }

        if (call.function.name === 'write_file' || call.function.name === 'edit_file') {
          if (fileArg) {
            ctx.fileCache.invalidate(fileArg).catch(() => {});
            const operation = call.function.name === 'write_file' ? 'create' : 'edit';
            const summary =
              call.function.name === 'edit_file'
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

        if (call.function.name === 'run_command' && disposition === 'critical') {
          const firstLine = result.split('\n').find((l) => /error|fail|fatal|exception|não encontrad|nao encontrad/i.test(l)) ?? result.slice(0, 160);
          ctx.recordError({
            message: firstLine.trim().slice(0, 200),
            context: `Comando: ${typeof args.command === 'string' ? args.command : ''}`,
            file: fileArg ?? null,
            tags: ['cmd', 'erro'],
          });
        }

        ctx.addToolMessage(call.function.name, result, tags, disposition);
      }
      await ctx.persist();
      continue;
    }

    const text = msg.content ?? '';
    ctx.addAssistantMessage(text);
    await ctx.persist();
    onEvent({ type: 'text', content: text });
    return { text, modelUsed: model };
  }

  throw new Error(`Limite de ${config.maxIterations} iteracoes atingido.`);
}
