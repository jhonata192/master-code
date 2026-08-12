import OpenAI from 'openai';
import { loadConfig, getActiveProvider, activeProviderId } from './config.js';

let client: OpenAI | null = null;
let clientCacheKey = '';

export async function getClient(): Promise<OpenAI> {
  const c = await loadConfig();
  const p = getActiveProvider(c);
  const key = `${activeProviderId(c)}|${p.baseUrl}|${p.apiKey}`;
  if (!client || clientCacheKey !== key) {
    client = new OpenAI({
      baseURL: p.baseUrl,
      apiKey: p.apiKey,
    });
    clientCacheKey = key;
  }
  return client;
}

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

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
    if (!getActiveProvider(c).apiKey) return [];
    const cli = await getClient();
    const res = await cli.models.list();
    return res.data.map((m) => m.id).sort();
  } catch {
    return [];
  }
}

export async function listCodingModels(): Promise<string[]> {
  let fetched: string[] | null = null;
  try {
    const c = await loadConfig();
    if (getActiveProvider(c).apiKey) {
      const cli = await getClient();
      const res = await cli.models.list();
      fetched = res.data.map((m) => m.id);
    }
  } catch {
    fetched = null;
  }

  if (!fetched || fetched.length === 0) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of fetched) {
    const low = m.toLowerCase();
    if (CODING_KEYWORDS.some((k) => low.includes(k))) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}
