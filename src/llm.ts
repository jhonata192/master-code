import OpenAI from 'openai';
import { loadConfig } from './config.js';

let client: OpenAI | null = null;
let clientCacheKey = '';

export async function getClient(): Promise<OpenAI> {
  const c = await loadConfig();
  const key = `${c.provider.baseUrl}|${c.provider.apiKey}`;
  if (!client || clientCacheKey !== key) {
    client = new OpenAI({
      baseURL: c.provider.baseUrl,
      apiKey: c.provider.apiKey,
    });
    clientCacheKey = key;
  }
  return client;
}

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const FALLBACK_MODELS: string[] = [
  'meta/llama-3.3-70b-instruct',
  'qwen/qwen2.5-coder-32b-instruct',
  'deepseek-ai/deepseek-v3',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'meta/llama-3.1-8b-instruct',
  'google/gemma-2-27b-it',
  'microsoft/phi-3.5-mini-instruct',
  'mistralai/mistral-nemo-12b-instruct',
];

const CODING_MODELS: string[] = [
  'qwen/qwen2.5-coder-32b-instruct',
  'deepseek-ai/deepseek-v3',
  'deepseek-ai/deepseek-r1',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'meta/llama-3.3-70b-instruct',
  'meta/llama-3.1-8b-instruct',
  'microsoft/phi-3.5-mini-instruct',
];

const CODING_KEYWORDS: string[] = [
  'coder',
  'code',
  'codestral',
  'codegemma',
  'devstral',
  'deepseek',
  'nemotron',
];

export async function listModels(): Promise<string[]> {
  try {
    const c = await loadConfig();
    if (!c.provider.apiKey) return FALLBACK_MODELS;
    const cli = await getClient();
    const res = await cli.models.list();
    const ids = res.data.map((m) => m.id).sort();
    if (ids.length > 0) return ids;
    return FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

export async function listCodingModels(): Promise<string[]> {
  let fetched: string[] | null = null;
  try {
    const c = await loadConfig();
    if (c.provider.apiKey) {
      const cli = await getClient();
      const res = await cli.models.list();
      fetched = res.data.map((m) => m.id);
    }
  } catch {
    fetched = null;
  }

  if (!fetched || fetched.length === 0) {
    return [...CODING_MODELS];
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of fetched) {
    const low = m.toLowerCase();
    if (CODING_KEYWORDS.some((k) => low.includes(k))) {
      seen.add(m);
      out.push(m);
    }
  }
  for (const m of CODING_MODELS) {
    if (fetched.includes(m) && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}
