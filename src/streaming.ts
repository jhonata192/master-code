import type OpenAI from 'openai';
import type { ChatMessage } from './llm.js';

export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onToolStart?: (index: number, id: string | undefined, name: string | undefined) => void;
  onToolArgs?: (index: number, delta: string) => void;
  onFinish?: (reason: string) => void;
  onUsage?: (usage: UsageInfo) => void;
  onRetry?: (attempt: number, error: unknown) => void;
}

export interface StreamParams {
  model: string;
  messages: ChatMessage[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
}

const MAX_ATTEMPTS = 3;

function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string };
  if (e.status && (e.status === 429 || e.status >= 500)) return true;
  if (e.code && /^(ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ECONNREFUSED|ENOTFOUND)$/.test(e.code))
    return true;
  const m = (e.message ?? '').toLowerCase();
  return /(rate limit|timeout|overloaded|temporarily|busy)/i.test(m);
}

export type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Faz uma chamada de completions em modo streaming.
 *
 * - Tenta `stream: true` com `stream_options.include_usage`. Se o provider
 *   rejeitar `stream_options` (HTTP 400), repete em streaming simples.
 * - Se o streaming nao for suportado (erro no inicio, nao-retryable), cai para
 *   a resposta completa (sem streaming) e sintetiza os mesmos chunks.
 * - Erros transitorios (429/5xx/network) sao retentados ate MAX_ATTEMPTS,
 *   sinalizando cada tentativa via `onRetry`.
 * - A interrupcao via `signal` propaga a excecao do SDK (nao e tratada aqui).
 */
export async function streamCompletion(
  client: OpenAI,
  params: StreamParams,
  cbs: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const base = {
    model: params.model,
    messages: params.messages,
    tools: params.tools,
    tool_choice: 'auto' as const,
  };

  let anyChunk = false;
  let useStreamOptions = true;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = useStreamOptions
        ? { ...base, stream: true, stream_options: { include_usage: true } }
        : { ...base, stream: true };
      const stream = await client.chat.completions.create(body, { signal, maxRetries: 0 });
      for await (const chunk of stream) {
        anyChunk = true;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) cbs.onText?.(delta.content);
        for (const tc of delta?.tool_calls ?? []) {
          if (tc.id || tc.function?.name) {
            cbs.onToolStart?.(tc.index, tc.id, tc.function?.name);
          }
          if (tc.function?.arguments) cbs.onToolArgs?.(tc.index, tc.function.arguments);
        }
        if (choice?.finish_reason) cbs.onFinish?.(choice.finish_reason);
        if (chunk.usage) {
          cbs.onUsage?.({
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          });
        }
      }
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      const e = err as { status?: number };
      if (anyChunk) throw err;
      if (useStreamOptions && e.status === 400) {
        useStreamOptions = false;
        continue;
      }
      if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
        cbs.onRetry?.(attempt + 1, err);
        continue;
      }
      break;
    }
  }

  const res = await client.chat.completions.create(
    { ...base, stream: false as const },
    { signal }
  );
  const msg = res.choices?.[0]?.message;
  if (!msg) throw new Error('Resposta vazia da API');
  if (msg.content) cbs.onText?.(msg.content);
  const tcs = msg.tool_calls ?? [];
  tcs.forEach((tc, i) => {
    cbs.onToolStart?.(i, tc.id, tc.function?.name);
    if (tc.function?.arguments) cbs.onToolArgs?.(i, tc.function.arguments);
  });
  cbs.onFinish?.(tcs.length ? 'tool_calls' : 'stop');
  if (res.usage) {
    cbs.onUsage?.({
      promptTokens: res.usage.prompt_tokens,
      completionTokens: res.usage.completion_tokens,
      totalTokens: res.usage.total_tokens,
    });
  }
}
