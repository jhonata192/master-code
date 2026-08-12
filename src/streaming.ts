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

/**
 * Penalidades de repeticao para reduzir degeneracao do modelo
 * (loops tipo "tambem tambem tambem..." / "JAMAIS JAMAIS JAMAIS...").
 * Sao aplicadas por padrao e removidas automaticamente caso o provider
 * rejeite o parametro (HTTP 400).
 */
const REPETITION = {
  frequency_penalty: 0.6,
  presence_penalty: 0.5,
} as const;

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * Remove blocos de raciocinio `<think>...</think>` do texto, inclusive
 * quando quebrados entre chunks de streaming. Nao emite nada do conteudo
 * interno do raciocinio.
 */
export class ThinkFilter {
  private buffer = '';
  private inThink = false;

  push(delta: string): string {
    this.buffer += delta;
    let out = '';
    for (;;) {
      if (this.inThink) {
        const closeIdx = this.buffer.indexOf(THINK_CLOSE);
        if (closeIdx === -1) {
          const keepFrom = Math.max(0, this.buffer.length - (THINK_CLOSE.length - 1));
          this.buffer = this.buffer.slice(keepFrom);
          break;
        }
        this.buffer = this.buffer.slice(closeIdx + THINK_CLOSE.length);
        this.inThink = false;
        continue;
      }
      const openIdx = this.buffer.indexOf(THINK_OPEN);
      if (openIdx === -1) {
        const keepFrom = Math.max(0, this.buffer.length - (THINK_OPEN.length - 1));
        out += this.buffer.slice(0, keepFrom);
        this.buffer = this.buffer.slice(keepFrom);
        break;
      }
      out += this.buffer.slice(0, openIdx);
      this.buffer = this.buffer.slice(openIdx + THINK_OPEN.length);
      this.inThink = true;
    }
    return out;
  }

  flush(): string {
    if (this.inThink) {
      this.buffer = '';
      return '';
    }
    const out = this.buffer;
    this.buffer = '';
    return out;
  }
}

export function stripThink(text: string): string {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const openIdx = rest.indexOf(THINK_OPEN);
    if (openIdx === -1) {
      out.push(rest);
      break;
    }
    out.push(rest.slice(0, openIdx));
    const after = rest.slice(openIdx + THINK_OPEN.length);
    const closeIdx = after.indexOf(THINK_CLOSE);
    if (closeIdx === -1) {
      break;
    }
    rest = after.slice(closeIdx + THINK_CLOSE.length);
  }
  return out.join('');
}

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
  const filter = new ThinkFilter();
  let anyChunk = false;
  let useStreamOptions = true;
  let usePenalties = true;

  const buildBody = (
    stream: boolean,
    includeUsage: boolean
  ): {
    model: string;
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    tool_choice: 'auto';
    stream: boolean;
    stream_options?: { include_usage: boolean };
    frequency_penalty?: number;
    presence_penalty?: number;
  } => {
    const body: {
      model: string;
      messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
      tools: OpenAI.Chat.Completions.ChatCompletionTool[];
      tool_choice: 'auto';
      stream: boolean;
      stream_options?: { include_usage: boolean };
      frequency_penalty?: number;
      presence_penalty?: number;
    } = {
      model: params.model,
      messages: params.messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: params.tools,
      tool_choice: 'auto',
      stream,
    };
    if (includeUsage && stream) body.stream_options = { include_usage: true };
    if (usePenalties) {
      body.frequency_penalty = REPETITION.frequency_penalty;
      body.presence_penalty = REPETITION.presence_penalty;
    }
    return body;
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const body = useStreamOptions
        ? (buildBody(true, true) as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming)
        : (buildBody(true, false) as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);
      const stream = await client.chat.completions.create(body, { signal, maxRetries: 0 });
      for await (const chunk of stream) {
        anyChunk = true;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          const text = filter.push(delta.content);
          if (text) cbs.onText?.(text);
        }
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
      const tail = filter.flush();
      if (tail) cbs.onText?.(tail);
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      const e = err as { status?: number };
      if (anyChunk) throw err;
      if (useStreamOptions && e.status === 400) {
        useStreamOptions = false;
        continue;
      }
      if (usePenalties && e.status === 400) {
        usePenalties = false;
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
    buildBody(false, false) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    { signal }
  );  const msg = res.choices?.[0]?.message;
  if (!msg) throw new Error('Resposta vazia da API');
  if (msg.content) {
    const text = stripThink(msg.content);
    if (text) cbs.onText?.(text);
  }
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
